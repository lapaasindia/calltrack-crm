// Google Drive v3 + OAuth 2.0 — implemented directly against the REST/token
// endpoints with the global fetch + node:fs (NO googleapis, NO new deps).
//
// Auth model: a "Desktop" OAuth client + the loopback redirect Google blesses
// for installed apps. Scope is drive.file ONLY (least privilege — the app can
// see only the files it created, never the rest of the user's Drive).
//
// All functions are pure with respect to our DB: callers pass tokens in and get
// data out, so cloudBackup.js can inject a fake "drive client" in tests and we
// never hit the network in the test suite.
//
// Uploads and downloads STREAM to/from disk (audit SCALE-4): the old
// readFileSync + Buffer.concat held 2–3× the file size in RAM per upload.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
// Overridable so a unit test can point uploads at a local http server.
const driveApi = () => process.env.CRM_DRIVE_API_BASE || 'https://www.googleapis.com/drive/v3';
const driveUpload = () => process.env.CRM_DRIVE_UPLOAD_BASE || 'https://www.googleapis.com/upload/drive/v3';

// Build the consent URL the user opens in their browser. access_type=offline +
// prompt=consent guarantees we get a refresh token (Google only returns it on
// the first consent unless prompt=consent forces it again).
export function buildAuthUrl({ clientId, redirectUri, state }) {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  });
  if (state) params.set('state', state);
  return `${AUTH_ENDPOINT}?${params.toString()}`;
}

async function tokenRequest(body) {
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Google token error ${res.status}: ${data.error_description || data.error || 'unknown'}`);
  }
  return data;
}

// Exchange the one-time authorization code for tokens. Returns
// { access_token, refresh_token, expires_in, ... }.
export function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  return tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });
}

// Trade a stored refresh token for a fresh access token (refresh tokens are
// long-lived; access tokens expire in ~1h). Returns { access_token, expires_in }.
export function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  return tokenRequest({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}

async function driveJson(accessToken, url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${accessToken}`, ...(init.headers || {}) },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`Drive API ${res.status}: ${data?.error?.message || text || 'unknown'}`);
  }
  return data;
}

// Find-or-create a top-level folder (in My Drive root) by name, scoped to files
// the app created (drive.file). Returns the folder id.
export async function ensureFolder(accessToken, name, parentId = 'root') {
  const q = [
    `name = '${name.replace(/'/g, "\\'")}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    'trashed = false',
    `'${parentId}' in parents`,
  ].join(' and ');
  const url = `${driveApi()}/files?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive`;
  const found = await driveJson(accessToken, url);
  if (found.files && found.files.length) return found.files[0].id;

  const created = await driveJson(accessToken, `${driveApi()}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    }),
  });
  return created.id;
}

// Multipart upload of a local file into a Drive folder, STREAMED from disk
// with an exact Content-Length (Google's multipart endpoint wants one — we
// know it: metadata part + file size + closing boundary), via node:http(s)
// so nothing is buffered. Returns the Drive file object { id, name, size }.
export async function uploadFile(accessToken, { folderId, name, srcAbs }) {
  const { size } = await fsp.stat(srcAbs);
  const boundary = `ctbkp${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const metadata = JSON.stringify({ name, parents: folderId ? [folderId] : undefined });
  const pre = Buffer.from(
    `--${boundary}\r\n`
    + 'Content-Type: application/json; charset=UTF-8\r\n\r\n'
    + `${metadata}\r\n`
    + `--${boundary}\r\n`
    + 'Content-Type: application/octet-stream\r\n\r\n',
    'utf8',
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const total = pre.length + size + post.length;

  const url = new URL(`${driveUpload()}/files?uploadType=multipart&fields=id,name,size`);
  const transport = url.protocol === 'http:' ? http : https;
  const body = Readable.from((async function* gen() {
    yield pre;
    for await (const chunk of fs.createReadStream(srcAbs)) yield chunk;
    yield post;
  }()));

  const { status, text } = await new Promise((resolve, reject) => {
    const req = transport.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
        'Content-Length': String(total),
      },
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: buf }));
      res.on('error', reject);
    });
    req.on('error', reject);
    pipeline(body, req).catch(reject);
  });
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
  if (status < 200 || status >= 300) {
    throw new Error(`Drive API ${status}: ${data?.error?.message || text || 'unknown'}`);
  }
  return data;
}

// List files within a folder (for retention). Returns [{id, name, createdTime}].
export async function listFiles(accessToken, { folderId, namePrefix } = {}) {
  const clauses = ['trashed = false'];
  if (folderId) clauses.push(`'${folderId}' in parents`);
  if (namePrefix) clauses.push(`name contains '${namePrefix.replace(/'/g, "\\'")}'`);
  const q = clauses.join(' and ');
  const url = `${driveApi()}/files?q=${encodeURIComponent(q)}`
    + '&fields=files(id,name,createdTime,size)&orderBy=name&pageSize=1000&spaces=drive';
  const data = await driveJson(accessToken, url);
  return data.files || [];
}

export async function deleteFile(accessToken, fileId) {
  const res = await fetch(`${driveApi()}/files/${fileId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  // 204 = deleted; 404 = already gone (treat as success so retention is idempotent).
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`Drive delete ${res.status}: ${text}`);
  }
  return true;
}

// Download a Drive file's bytes to a local path (used by the restore script),
// streamed straight to disk.
export async function downloadFile(accessToken, fileId, destAbs) {
  const res = await fetch(`${driveApi()}/files/${fileId}?alt=media`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Drive download ${res.status}: ${text}`);
  }
  fs.mkdirSync(path.dirname(destAbs), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(destAbs));
  return (await fsp.stat(destAbs)).size;
}
