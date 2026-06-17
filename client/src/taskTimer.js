// The single GLOBAL task timer. Exactly ONE task can be timed at a time across
// the whole app; its state lives under one localStorage key so the TaskDetail
// card and the floating CurrentWorkWidget stay in sync (and survive reloads).
//
// Value shape: { taskId: number, title?: string, startIso: string } | null.
// A 'crm:timer' window event fires on every change so any mounted listener can
// re-read without prop-drilling.
import { api } from './api.js';

export const TIMER_KEY = 'crm_active_task_timer';

export function getActiveTimer() {
  try {
    const raw = localStorage.getItem(TIMER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function emit() { window.dispatchEvent(new Event('crm:timer')); }

// Start timing a task. If this same task is ALREADY running, it's a no-op
// (return the in-flight startIso) so a duplicated event or a second tab can't
// silently discard the accrued segment by overwriting startIso. If a DIFFERENT
// task is running, STOP it first (single global timer) so its elapsed time is
// recorded server-side.
export async function startTimer(taskId, title) {
  const active = getActiveTimer();
  if (active && active.taskId === taskId) return active.startIso;
  if (active) await stopTimer();
  const startIso = new Date().toISOString();
  localStorage.setItem(TIMER_KEY, JSON.stringify({ taskId, title: title || '', startIso }));
  emit();
  try { await api.post(`/api/tasks/${taskId}/timer/start`, {}); } catch { /* server best-effort */ }
  return startIso;
}

// Stop the active timer (if any) and persist the elapsed seconds server-side.
// Returns the recorded duration in seconds (0 if nothing was running).
export async function stopTimer() {
  const active = getActiveTimer();
  localStorage.removeItem(TIMER_KEY);
  emit();
  if (!active) return 0;
  try {
    const res = await api.post(`/api/tasks/${active.taskId}/timer/stop`, { start_iso: active.startIso });
    return res?.duration || 0;
  } catch { return 0; }
}

// Seconds elapsed on the currently-running timer (0 if none).
export function elapsedSeconds(active = getActiveTimer()) {
  if (!active) return 0;
  return Math.max(0, Math.floor((Date.now() - Date.parse(active.startIso)) / 1000));
}

// h:m(:s) pretty-printer for a seconds count.
export function fmtDuration(totalSec, withSeconds = false) {
  const s = Math.max(0, Math.floor(totalSec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (withSeconds) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
