// Phase 2A — lead scoring + AI intelligence + hybrid Sarvam transcription.
// Pure units (calculateLeadScore, scoreLabel, deriveLeadAiFields, Sarvam
// parse/merge) run with NO DB/network/ffmpeg/Ollama. The transcribe-cloud
// endpoint gating runs against a real server on a throwaway DB, with injected
// fakes so no binary or API is ever touched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-scoring-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');

// ---------- pure: calculateLeadScore / scoreLabel ----------
const { calculateLeadScore, scoreLabel } = await import('../lib/scoring.js');

const NOW = '2026-06-16T06:00:00.000Z';
const at = (daysAgo) => new Date(Date.parse(NOW) - daysAgo * 86400000).toISOString();

test('scoreLabel boundaries: Hot>=80, Warm>=50, Cold<50', () => {
  assert.equal(scoreLabel(80).label, 'Hot');
  assert.equal(scoreLabel(100).label, 'Hot');
  assert.equal(scoreLabel(79).label, 'Warm');
  assert.equal(scoreLabel(50).label, 'Warm');
  assert.equal(scoreLabel(49).label, 'Cold');
  assert.equal(scoreLabel(0).label, 'Cold');
});

test('Hot lead: referral + interested + multiple recent connects', () => {
  const lead = { source: 'referral', stage: 'interested', extra_json: JSON.stringify({ budget_rupees: 120000 }) };
  const calls = [
    { disposition: 'connected', called_at: at(0) },
    { disposition: 'connected', called_at: at(1) },
    { disposition: 'connected', called_at: at(2) },
  ];
  const { score, factors } = calculateLeadScore(lead, calls, NOW);
  assert.ok(score >= 80, `expected Hot, got ${score}`);
  assert.equal(scoreLabel(score).label, 'Hot');
  assert.equal(factors.connected_calls, 3);
  assert.equal(factors.budget, 15);
});

test('Cold lead: imported, never contacted', () => {
  const lead = { source: 'import', stage: 'new' };
  const { score, factors } = calculateLeadScore(lead, [], NOW);
  assert.ok(score < 50, `expected Cold, got ${score}`);
  assert.equal(factors.recency, 0); // no calls → neutral
  assert.equal(factors.days_since_last_call, null);
});

test('recency decay: same lead/calls score lower the older the last call', () => {
  const lead = { source: 'website', stage: 'contacted' };
  const recent = calculateLeadScore(lead, [{ disposition: 'connected', called_at: at(0) }], NOW).score;
  const week = calculateLeadScore(lead, [{ disposition: 'connected', called_at: at(7) }], NOW).score;
  const stale = calculateLeadScore(lead, [{ disposition: 'connected', called_at: at(45) }], NOW).score;
  assert.ok(recent > week, `recent ${recent} should beat week ${week}`);
  assert.ok(week > stale, `week ${week} should beat stale ${stale}`);
});

test('missing/garbage extra_json is tolerated (no throw, no budget credit)', () => {
  const a = calculateLeadScore({ source: 'manual', stage: 'new', extra_json: '{not json' }, [], NOW);
  assert.equal(a.factors.budget, 0);
  const b = calculateLeadScore({ source: 'manual', stage: 'new', extra_json: null }, [], NOW);
  assert.equal(b.factors.budget, 0);
  const c = calculateLeadScore({ source: 'manual', stage: 'new' }, undefined, NOW);
  assert.ok(c.score >= 0 && c.score <= 100);
});

test('score is always clamped to 0..100', () => {
  const lead = { source: 'referral', stage: 'won', extra_json: JSON.stringify({ budget: 999999 }) };
  const calls = Array.from({ length: 20 }, (_, i) => ({ disposition: 'connected', called_at: at(0) }));
  const { score } = calculateLeadScore(lead, calls, NOW);
  assert.ok(score <= 100 && score >= 0);
});

// ---------- pure: deriveLeadAiFields ----------
const { deriveLeadAiFields } = await import('../lib/ai.js');

test('deriveLeadAiFields maps a full analysis correctly', () => {
  const analysis = {
    intent: 'Hot', sentiment: 'positive',
    rating: { clarity: 8, engagement: 9, conversion: 7, overall: 8 },
    strengths: ['good rapport', 'clear pitch', 'handled objection', 'extra ignored'],
    improvements: ['ask for the close'],
    coaching: 'Ask for the sale earlier.',
    status_reason: 'Strong buying signals throughout.',
  };
  const d = deriveLeadAiFields(analysis, NOW);
  assert.equal(d.ai_intent, 'Hot');
  assert.equal(d.ai_sentiment, 'positive');
  assert.equal(d.ai_analyzed_at, NOW);
  assert.equal(d.ai_status_reason, 'Strong buying signals throughout.');
  // ai_score blends Hot base (90) with overall 8 → between the two.
  assert.ok(d.ai_score >= 80 && d.ai_score <= 92, `ai_score ${d.ai_score}`);
  assert.equal(d.strengths.length, 3, 'strengths capped at 3');
  const rating = JSON.parse(d.ai_rating);
  assert.equal(rating.engagement, 9);
});

test('deriveLeadAiFields tolerates partial/garbage analysis', () => {
  assert.deepEqual(deriveLeadAiFields(null, NOW).ai_intent, null);
  const d = deriveLeadAiFields({ intent: 'wizard', sentiment: 'happy', rating: 'nope' }, NOW);
  assert.equal(d.ai_intent, null, 'unknown intent dropped');
  assert.equal(d.ai_sentiment, null, 'unknown sentiment dropped');
  assert.equal(d.ai_rating, null, 'no valid rating');
  assert.equal(d.ai_score, null, 'no signal → null score');
});

test('deriveLeadAiFields: rating-only still yields a score', () => {
  const d = deriveLeadAiFields({ rating: { overall: 6 } }, NOW);
  assert.equal(d.ai_intent, null);
  assert.equal(d.ai_score, 60);
});

// ---------- pure: Sarvam parse/merge ----------
const { parseSarvamResponse, mergeChunkResults } = await import('../lib/sarvam.js');

test('parseSarvamResponse pulls transcript/translation/language', () => {
  const p = parseSarvamResponse({
    transcript: 'Hello, how can I help?',
    original_transcript: 'नमस्ते, कैसे मदद करूं?',
    language_code: 'hi-IN',
  });
  assert.equal(p.translation, 'Hello, how can I help?');
  assert.equal(p.transcript, 'नमस्ते, कैसे मदद करूं?');
  assert.equal(p.language, 'hi-IN');
});

test('parseSarvamResponse falls back to translation when no original given', () => {
  const p = parseSarvamResponse({ transcript: 'just english' });
  assert.equal(p.transcript, 'just english');
  assert.equal(p.translation, 'just english');
  assert.equal(p.language, null);
});

test('mergeChunkResults stitches chunks in order, keeps first language', () => {
  const merged = mergeChunkResults([
    { transcript: 'भाग एक', translation: 'part one', language: 'hi-IN' },
    { transcript: 'भाग दो', translation: 'part two', language: null },
  ]);
  assert.equal(merged.transcript, 'भाग एक भाग दो');
  assert.equal(merged.translation, 'part one part two');
  assert.equal(merged.language, 'hi-IN');
  assert.equal(merged.provider, 'sarvam');
});

// ---------- endpoint: transcribe-cloud gating (real server, injected fakes) ----------
let baseUrl;
let server;
let db;
let adminCookie;
let recordingId;

const api = async (pathname, { method = 'GET', body, cookie } = {}) => {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(`${baseUrl}${pathname}`, {
    method, headers, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
};

before(async () => {
  // Build an app with the recordings router wired to fakes (no ffmpeg/network/Ollama).
  const express = (await import('express')).default;
  const { createApp } = await import('../app.js');
  const { ensureBootstrapped } = await import('../bootstrap.js');
  ensureBootstrapped();
  db = (await import('../db.js')).default;

  // Seed a device (recordings.device_id has a NOT NULL FK), lead, connected
  // call, and a recording row pointing at a real temp file.
  const now = new Date().toISOString();
  const devInfo = db.prepare(
    `INSERT INTO device_tokens (user_id, device_name, token_hash, paired_at)
     VALUES (1, 'Test Device', 'hash-cloud-test', ?)`
  ).run(now);
  const deviceId = devInfo.lastInsertRowid;
  const leadInfo = db.prepare(
    `INSERT INTO leads (name, phone, phone_raw, source, assigned_to, created_at, updated_at)
     VALUES ('Cloud Lead', '9876500001', '9876500001', 'manual', 1, ?, ?)`
  ).run(now, now);
  const callInfo = db.prepare(
    `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at)
     VALUES (?, 1, 'sales', 'connected', ?)`
  ).run(leadInfo.lastInsertRowid, now);
  const recDir = path.join(process.env.CRM_DATA_DIR, 'recordings', '2026-06');
  fs.mkdirSync(recDir, { recursive: true });
  fs.writeFileSync(path.join(recDir, 'cloudtest.m4a'), Buffer.from('fake-audio'));
  const recInfo = db.prepare(
    `INSERT INTO recordings (user_id, device_id, call_id, file_path, sha256, original_filename,
                             size_bytes, match_status, created_at)
     VALUES (1, ?, ?, '2026-06/cloudtest.m4a', 'sha-cloud-1', 'cloudtest.m4a', 10, 'matched', ?)`
  ).run(deviceId, callInfo.lastInsertRowid, now);
  recordingId = recInfo.lastInsertRowid;

  const app = createApp();
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  });
  adminCookie = login.headers.get('set-cookie').split(';')[0];
});

after(() => {
  server?.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

test('transcribe-cloud: 400 when cloud AI is disabled', async () => {
  const { setSetting } = await import('../db.js');
  setSetting('ai_cloud_enabled', false);
  setSetting('sarvam_api_key', 'sk-test');
  const res = await api(`/api/recordings/${recordingId}/transcribe-cloud`, {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /disabled/i);
});

test('transcribe-cloud: 400 when no Sarvam key, even if enabled', async () => {
  const { setSetting } = await import('../db.js');
  setSetting('ai_cloud_enabled', true);
  setSetting('sarvam_api_key', '');
  const res = await api(`/api/recordings/${recordingId}/transcribe-cloud`, {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /key/i);
});

test('transcribe-cloud: 404 for an unknown recording', async () => {
  const { setSetting } = await import('../db.js');
  setSetting('ai_cloud_enabled', true);
  setSetting('sarvam_api_key', 'sk-test');
  const res = await api('/api/recordings/999999/transcribe-cloud', {
    method: 'POST', cookie: adminCookie,
  });
  assert.equal(res.status, 404);
});

// ---------- recordingsRouter with injected fakes: happy path persists + derives ----------
test('recordingsRouter (fakes): persists transcript/translation/provider and derives lead AI', async () => {
  const { setSetting } = await import('../db.js');
  setSetting('ai_cloud_enabled', true);
  setSetting('sarvam_api_key', 'sk-test');

  const express = (await import('express')).default;
  const session = (await import('express-session')).default;
  const { recordingsRouter } = await import('../routes/ai.js');
  const { requireAuth } = await import('../middleware/auth.js');

  // Fakes: no ffmpeg/network/Ollama.
  const fakeTranscribe = async () => ({
    transcript: 'मूल हिंदी', translation: 'original hindi', language: 'hi-IN', provider: 'sarvam',
  });
  const fakeAnalyze = async (recId) => {
    const { applyLeadAiFields } = await import('../lib/ai.js');
    const analysis = {
      intent: 'Warm', sentiment: 'positive',
      rating: { clarity: 7, engagement: 7, conversion: 6, overall: 7 },
      strengths: ['polite'], improvements: ['follow up'], coaching: 'Send the brochure.',
      summary: 'Lead is interested, wants a callback.',
    };
    const rec = db.prepare('SELECT call_id FROM recordings WHERE id = ?').get(recId);
    const leadId = db.prepare('SELECT lead_id FROM calls WHERE id = ?').get(rec.call_id).lead_id;
    db.prepare("UPDATE recordings SET ai_json = ?, summary = ? WHERE id = ?")
      .run(JSON.stringify(analysis), analysis.summary, recId);
    applyLeadAiFields(leadId, analysis);
    return analysis;
  };

  const app = express();
  app.use(express.json());
  // Minimal session so requireAuth can read the same admin cookie.
  app.use(session({ store: new (await import('../lib/sessionStore.js')).SqliteSessionStore(),
    secret: fs.readFileSync(path.join(process.env.CRM_DATA_DIR, 'secret.key'), 'utf8'),
    resave: false, saveUninitialized: false, name: 'crm.sid', cookie: { secure: false } }));
  app.use('/api', requireAuth);
  app.use('/api/recordings', recordingsRouter({ transcribeFn: fakeTranscribe, analyzeFn: fakeAnalyze }));

  const srv = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  const res = await fetch(`${url}/api/recordings/${recordingId}/transcribe-cloud`, {
    method: 'POST', headers: { Cookie: adminCookie },
  });
  const data = await res.json();
  srv.close();

  assert.equal(res.status, 200);
  assert.equal(data.provider, 'sarvam');
  assert.equal(data.translation, 'original hindi');
  assert.equal(data.analysis.intent, 'Warm');

  // Recording row got the cloud transcript + provider.
  const rec = db.prepare('SELECT * FROM recordings WHERE id = ?').get(recordingId);
  assert.equal(rec.provider, 'sarvam');
  assert.equal(rec.transcript, 'मूल हिंदी');
  assert.equal(rec.translation, 'original hindi');

  // Lead got the derived AI fields.
  const lead = db.prepare(
    'SELECT l.* FROM leads l JOIN calls c ON c.lead_id = l.id JOIN recordings r ON r.call_id = c.id WHERE r.id = ?'
  ).get(recordingId);
  assert.equal(lead.ai_intent, 'Warm');
  assert.ok(lead.ai_score > 0);
});
