// Local AI pipeline — runs entirely on the office Mac, nothing leaves it.
// recording audio → ffmpeg (16kHz mono wav) → whisper.cpp transcript →
// Ollama qwen2.5 extraction → ai_suggestions (reviewed, never auto-applied).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import db, { getSetting } from '../db.js';
import { nowUtc, todayIst, addDays } from './istTime.js';
import { RECORDINGS_BASE } from '../routes/sync.js';

const execFileP = promisify(execFile);

// Configurable so a different box / model path works without code changes.
const WHISPER_BIN = process.env.WHISPER_BIN || 'whisper-cli';
const WHISPER_MODEL = process.env.WHISPER_MODEL
  || path.join(os.homedir(), '.calltrack-build', 'whisper-models', 'ggml-large-v3-turbo-q5_0.bin');
const FFMPEG_BIN = process.env.FFMPEG_BIN || 'ffmpeg';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5:7b';

export function aiEnabled() {
  return getSetting('ai_enabled', false) === true && fs.existsSync(WHISPER_MODEL);
}

export function aiStatus() {
  return {
    enabled: getSetting('ai_enabled', false) === true,
    model_present: fs.existsSync(WHISPER_MODEL),
    whisper_model: path.basename(WHISPER_MODEL),
    ollama_model: OLLAMA_MODEL,
  };
}

async function toWav(srcAbs) {
  const wav = path.join(os.tmpdir(), `ct-${path.basename(srcAbs)}.wav`);
  await execFileP(FFMPEG_BIN, ['-y', '-i', srcAbs, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav],
    { timeout: 120000 });
  return wav;
}

async function transcribe(wavPath, language) {
  // whisper.cpp writes <out>.txt; -nt removes timestamps from the text.
  const outBase = wavPath.replace(/\.wav$/, '');
  await execFileP(WHISPER_BIN, [
    '-m', WHISPER_MODEL, '-f', wavPath, '-l', language || 'auto',
    '-otxt', '-of', outBase, '-nt', '-np',
  ], { timeout: 600000, maxBuffer: 16 * 1024 * 1024 });
  const txtPath = `${outBase}.txt`;
  const text = fs.existsSync(txtPath) ? fs.readFileSync(txtPath, 'utf8').trim() : '';
  fs.rmSync(txtPath, { force: true });
  return text;
}

const EXTRACT_PROMPT = (transcript, leadName, company) => `You are a CRM assistant for an Indian sales/calling team at ${company}. A call with the lead "${leadName}" was transcribed (Hindi/English mix). Read it and extract structured data.

TRANSCRIPT:
"""${transcript.slice(0, 6000)}"""

Reply with ONLY a JSON object (no markdown), with these keys:
- "summary": one or two sentences, in English, on what happened.
- "sentiment": one of "positive","neutral","negative".
- "outcome": one of "interested","not_interested","callback","payment_promised","wrong_number","other".
- "city": the customer's city if clearly stated, else null.
- "interest": product/program/service they asked about, else null.
- "follow_up": if they asked to be contacted again at a specific time, an object {"when":"YYYY-MM-DD","reason":"..."} (resolve relative dates against today ${todayIst()} IST), else null.
- "task": if the caller must do something concrete (send brochure, share link, etc.), a short imperative string, else null.

JSON:`;

async function extract(transcript, leadName, company) {
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt: EXTRACT_PROMPT(transcript, leadName, company),
      stream: false,
      format: 'json',
      options: { temperature: 0.1 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.response);
}

// Turn extracted JSON into reviewable suggestions for a lead.
function makeSuggestions(recordingId, leadId, lead, ai) {
  const mk = db.prepare(
    `INSERT INTO ai_suggestions (recording_id, lead_id, kind, field, value, label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const now = nowUtc();
  if (ai.city && !lead.city) {
    mk.run(recordingId, leadId, 'field', 'city', ai.city, `Set city to "${ai.city}"`, now);
  }
  if (ai.interest) {
    const note = `Interested in: ${ai.interest}`;
    mk.run(recordingId, leadId, 'field', 'notes', note, `Add note — ${note}`, now);
  }
  // Convention for follow_up/task: field = IST date (YYYY-MM-DD), value = text.
  if (ai.follow_up?.when && /^\d{4}-\d{2}-\d{2}$/.test(ai.follow_up.when)) {
    const reason = ai.follow_up.reason || 'Follow-up (from call)';
    mk.run(recordingId, leadId, 'follow_up', ai.follow_up.when, reason,
      `Schedule follow-up on ${ai.follow_up.when} — ${reason}`, now);
  }
  if (ai.task) {
    const due = addDays(todayIst(), 1);
    mk.run(recordingId, leadId, 'task', due, ai.task, `Add task — ${ai.task}`, now);
  }
}

// Process one recording end to end. Returns true if it did work.
export async function processRecording(rec) {
  const language = getSetting('ai_language', 'auto');
  const company = getSetting('company_name', 'our company');
  const srcAbs = path.join(RECORDINGS_BASE, rec.file_path);
  if (!fs.existsSync(srcAbs)) {
    db.prepare("UPDATE recordings SET ai_status = 'skipped' WHERE id = ?").run(rec.id);
    return true;
  }

  db.prepare("UPDATE recordings SET ai_status = 'processing' WHERE id = ?").run(rec.id);
  let wav;
  try {
    wav = await toWav(srcAbs);
    const transcript = await transcribe(wav, language);
    if (!transcript) {
      db.prepare("UPDATE recordings SET ai_status = 'done', transcript = '' WHERE id = ?").run(rec.id);
      return true;
    }

    // Which lead does this recording belong to?
    const leadId = rec.call_id
      ? db.prepare('SELECT lead_id FROM calls WHERE id = ?').get(rec.call_id)?.lead_id
      : null;
    const lead = leadId ? db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId) : null;

    let ai = null;
    try {
      ai = await extract(transcript, lead?.name || 'the customer', company);
    } catch (e) {
      // Transcript still saved even if extraction fails.
      console.error('[ai] extraction failed:', e.message);
    }

    db.transaction(() => {
      db.prepare(
        "UPDATE recordings SET ai_status = 'done', transcript = ?, summary = ?, ai_json = ? WHERE id = ?"
      ).run(transcript, ai?.summary || null, ai ? JSON.stringify(ai) : null, rec.id);
      if (ai && lead) makeSuggestions(rec.id, lead.id, lead, ai);
    })();
    return true;
  } catch (e) {
    console.error('[ai] failed on recording', rec.id, e.message);
    db.prepare("UPDATE recordings SET ai_status = 'failed' WHERE id = ?").run(rec.id);
    return true;
  } finally {
    if (wav) fs.rmSync(wav, { force: true });
  }
}

let running = false;
export async function runAiQueueOnce() {
  if (running || !aiEnabled()) return;
  running = true;
  try {
    let rec;
    while ((rec = db.prepare(
      "SELECT * FROM recordings WHERE ai_status = 'pending' ORDER BY created_at LIMIT 1"
    ).get())) {
      await processRecording(rec);
    }
  } finally {
    running = false;
  }
}

// Poll the queue. Cheap when idle (one indexed SELECT).
export function startAiWorker() {
  const tick = () => runAiQueueOnce().catch((e) => console.error('[ai] worker:', e.message));
  setTimeout(tick, 8000).unref();
  setInterval(tick, 30000).unref();
}
