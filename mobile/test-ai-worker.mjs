// Manual AI pipeline verification (needs whisper-cli + ollama installed).
// Seeds a lead + recording, runs the REAL worker, checks transcript +
// suggestions, accepts them, asserts the lead/follow-up/task changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ai-test-'));
process.env.CRM_DATA_DIR = path.join(TMP, 'data');
process.env.CRM_BACKUP_DIR = path.join(TMP, 'backups');
process.env.CRM_RECORDINGS_DIR = path.join(TMP, 'recordings');
process.env.WHISPER_MODEL = path.join(os.homedir(), '.calltrack-build/whisper-models/ggml-large-v3-turbo-q5_0.bin');

const audioSrc = process.argv[2] || '/tmp/clear-call.m4a';
fs.mkdirSync(path.join(TMP, 'recordings', '2026-06'), { recursive: true });
const relPath = '2026-06/test.m4a';
fs.copyFileSync(audioSrc, path.join(TMP, 'recordings', relPath));

const db = (await import('../server/db.js')).default;
const { setSetting, getSetting } = await import('../server/db.js');
const { ensureBootstrapped } = await import('../server/bootstrap.js');
const { runAiQueueOnce } = await import('../server/lib/ai.js');
ensureBootstrapped();
setSetting('ai_enabled', true);
setSetting('company_name', 'Lapaas');

const now = new Date().toISOString();
const deviceId = db.prepare(
  `INSERT INTO device_tokens (user_id, device_name, token_hash, paired_at) VALUES (1, 'Test', 'hash', ?)`
).run(now).lastInsertRowid;
// Lead + a mobile call + recording row pending AI.
const leadId = db.prepare(
  `INSERT INTO leads (name, phone, source, assigned_to, stage, created_at, updated_at)
   VALUES ('Rahul Test', '9876500011', 'demo', 1, 'contacted', ?, ?)`
).run(now, now).lastInsertRowid;
const callId = db.prepare(
  `INSERT INTO calls (lead_id, user_id, call_type, disposition, called_at, source, auto_logged, duration_seconds)
   VALUES (?, 1, 'sales', 'connected', ?, 'mobile', 1, 30)`
).run(leadId, now).lastInsertRowid;
const recId = db.prepare(
  `INSERT INTO recordings (user_id, device_id, call_id, file_path, sha256, original_filename, size_bytes, match_status, ai_status, created_at)
   VALUES (1, ?, ?, ?, 'testsha', 'test.m4a', 1000, 'matched', 'pending', ?)`
).run(deviceId, callId, relPath, now).lastInsertRowid;

console.log('Running AI worker on the recording…');
const t0 = Date.now();
await runAiQueueOnce();
console.log(`worker finished in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

const rec = db.prepare('SELECT ai_status, transcript, summary, ai_json FROM recordings WHERE id = ?').get(recId);
console.log('\nai_status:', rec.ai_status);
console.log('transcript:', (rec.transcript || '').slice(0, 120) + '…');
console.log('summary:', rec.summary);

const sugg = db.prepare('SELECT id, kind, field, value, label FROM ai_suggestions WHERE recording_id = ?').all(recId);
console.log('\nSUGGESTIONS:');
sugg.forEach((s) => console.log(`  [${s.kind}] ${s.label}`));

// Accept each suggestion via the same logic the route uses.
const { default: aiRouter } = await import('../server/routes/ai.js');
// Simulate accept by calling the DB ops directly (route needs req/res). Apply manually:
const lead0 = db.prepare('SELECT * FROM leads WHERE id = ?').get(leadId);
for (const s of sugg) {
  if (s.kind === 'field' && s.field === 'city') {
    db.prepare('UPDATE leads SET city = ? WHERE id = ?').run(s.value, leadId);
  } else if (s.kind === 'follow_up') {
    const [y, m, d] = s.field.split('-').map(Number);
    const dueAt = new Date(Date.UTC(y, m - 1, d, 11, 0) - 330 * 60000).toISOString();
    db.prepare(`INSERT INTO follow_ups (lead_id, assigned_to, due_at, reason, status, created_at) VALUES (?, 1, ?, ?, 'pending', ?)`)
      .run(leadId, dueAt, s.value, now);
  } else if (s.kind === 'task') {
    db.prepare(`INSERT INTO tasks (title, lead_id, assigned_to, due_date, source, created_by, created_at) VALUES (?, ?, 1, ?, 'ai', 1, ?)`)
      .run(s.value, leadId, s.field, now);
  }
}

const lead = db.prepare('SELECT city FROM leads WHERE id = ?').get(leadId);
const fu = db.prepare("SELECT due_at, reason FROM follow_ups WHERE lead_id = ? AND status = 'pending'").get(leadId);
const task = db.prepare('SELECT title, due_date FROM tasks WHERE lead_id = ?').get(leadId);

console.log('\nAFTER ACCEPTING:');
console.log('  lead.city:', lead.city);
console.log('  follow-up:', fu ? `${fu.reason} @ ${fu.due_at}` : 'none');
console.log('  task:', task ? `${task.title} (due ${task.due_date})` : 'none');

const pass = rec.ai_status === 'done' && rec.transcript && rec.summary
  && sugg.length >= 2 && lead.city && (fu || task);
console.log('\n' + (pass ? 'AI PIPELINE PASS' : 'AI PIPELINE FAIL'));
fs.rmSync(TMP, { recursive: true, force: true });
process.exit(pass ? 0 : 1);
