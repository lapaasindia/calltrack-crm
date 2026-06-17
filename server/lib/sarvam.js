// Hybrid cloud transcription via Sarvam Saaras (Hindi/Hinglish STT + English
// translation). OPT-IN per recording: this is the ONE place audio leaves the
// office, gated by the ai_cloud_enabled setting + a configured key.
//
// Design for testability: the network client (httpFetch) is INJECTABLE and the
// pure parse/merge logic (parseSarvamResponse / mergeChunkResults) is exported
// separately, so the merge can be unit-tested with NO ffmpeg and NO network.
// The audio chunking (ffmpeg) only runs on the live path.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const execFileP = promisify(execFile);

const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const FFPROBE_BIN = process.env.FFPROBE_BIN || 'ffprobe';
// Saaras has a per-request audio length cap; chunk well under it.
const CHUNK_SECONDS = 25;
const SARVAM_URL = process.env.SARVAM_URL || 'https://api.sarvam.ai/speech-to-text-translate';

// PURE: pull transcript/translation/language out of one Saaras JSON response.
// Saaras' translate endpoint returns the English "transcript"; some responses
// also carry the original-language text. Tolerant of field-name variations.
export function parseSarvamResponse(data) {
  const d = data && typeof data === 'object' ? data : {};
  const translation = (d.transcript ?? d.translation ?? d.translated_transcript ?? '') || '';
  // Original-language transcript when the API returns it; else fall back to the
  // translated text so we always have *something* to show/analyze.
  const transcript = (d.original_transcript ?? d.source_transcript ?? d.diarized_transcript ?? translation) || '';
  const language = d.language_code ?? d.language ?? d.detected_language ?? null;
  return {
    transcript: String(transcript).trim(),
    translation: String(translation).trim(),
    language: language ? String(language) : null,
  };
}

// PURE: stitch per-chunk parse results (in order) back into one recording-level
// result. Joins text with spaces; language = the first chunk that reported one.
export function mergeChunkResults(parsed) {
  const list = Array.isArray(parsed) ? parsed : [];
  const join = (k) => list.map((p) => (p && p[k]) || '').filter(Boolean).join(' ').trim();
  const language = list.map((p) => p && p.language).find(Boolean) || null;
  return {
    transcript: join('transcript'),
    translation: join('translation'),
    language,
    provider: 'sarvam',
  };
}

// Split a (possibly long) audio file into <=CHUNK_SECONDS WAV chunks. Returns
// absolute paths in order. Caller cleans them up. Live-path only (uses ffmpeg).
async function chunkToWav(fileAbs) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarvam-'));
  // Segment directly to 16kHz mono WAV — same audio conventions as ai.js.
  const pattern = path.join(tmpDir, 'chunk-%04d.wav');
  await execFileP(FFMPEG_BIN, [
    '-y', '-i', fileAbs,
    '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
    '-f', 'segment', '-segment_time', String(CHUNK_SECONDS),
    pattern,
  ], { timeout: 300000 });
  return fs.readdirSync(tmpDir)
    .filter((f) => f.endsWith('.wav'))
    .sort()
    .map((f) => path.join(tmpDir, f));
}

// POST one WAV chunk to Saaras. httpFetch injectable; returns the parsed result.
async function transcribeChunk(chunkAbs, apiKey, httpFetch) {
  const form = new FormData();
  const bytes = fs.readFileSync(chunkAbs);
  form.append('file', new Blob([bytes], { type: 'audio/wav' }), path.basename(chunkAbs));
  form.append('model', 'saaras:v2.5');
  const res = await httpFetch(SARVAM_URL, {
    method: 'POST',
    headers: { 'api-subscription-key': apiKey },
    body: form,
  });
  if (!res.ok) throw new Error(`Sarvam ${res.status}`);
  const data = await res.json();
  return parseSarvamResponse(data);
}

// Live entry point: chunk the file, transcribe each chunk via Saaras, merge.
// Returns {transcript, translation, language, provider:'sarvam'}.
// httpFetch is injectable (default global fetch) so tests never hit the network.
export async function transcribeWithSarvam(fileAbs, { apiKey, httpFetch = fetch } = {}) {
  if (!apiKey) throw new Error('Sarvam API key not configured');
  if (!fs.existsSync(fileAbs)) throw new Error('Recording file not found');

  const chunks = await chunkToWav(fileAbs);
  const chunkDir = chunks.length ? path.dirname(chunks[0]) : null;
  try {
    const parsed = [];
    for (const c of chunks) {
      // Sequential: keeps memory flat and respects per-key rate limits.
      parsed.push(await transcribeChunk(c, apiKey, httpFetch)); // eslint-disable-line no-await-in-loop
    }
    return mergeChunkResults(parsed);
  } finally {
    if (chunkDir) fs.rmSync(chunkDir, { recursive: true, force: true });
  }
}
