// The single GLOBAL task timer. Exactly ONE task can be timed at a time across
// the whole app; its state lives under one localStorage key so the TaskDetail
// card and the floating CurrentWorkWidget stay in sync (and survive reloads).
//
// Keys are namespaced by user id (CLIENT-19) so a shared office PC / handed-
// over phone never shows the previous user's timer. The `storage` event is
// bridged to 'crm:timer' so two tabs of the same user agree on the one timer.
//
// Value shape: { taskId: number, title?: string, startIso: string } | null.
// A 'crm:timer' window event fires on every change so any mounted listener can
// re-read without prop-drilling.
import { api } from './api.js';

export const TIMER_KEY_BASE = 'crm_active_task_timer';
export const DISMISS_KEY_BASE = 'crm_cw_dismissed_at';

let currentUserId = null;
export function setTimerUser(userId) {
  currentUserId = userId == null ? null : String(userId);
  emit();
}
export const timerKey = (uid = currentUserId) => (uid ? `${TIMER_KEY_BASE}:${uid}` : TIMER_KEY_BASE);
export const dismissKey = (uid = currentUserId) => (uid ? `${DISMISS_KEY_BASE}:${uid}` : DISMISS_KEY_BASE);

export function getActiveTimer() {
  try {
    const raw = localStorage.getItem(timerKey());
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

function emit() { if (typeof window !== 'undefined') window.dispatchEvent(new Event('crm:timer')); }

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key && e.key.startsWith(TIMER_KEY_BASE)) emit();
  });
}

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
  try { localStorage.setItem(timerKey(), JSON.stringify({ taskId, title: title || '', startIso })); } catch { /* private mode */ }
  emit();
  try { await api.post(`/api/tasks/${taskId}/timer/start`, {}); } catch { /* server best-effort */ }
  return startIso;
}

// Stop the active timer (if any) and persist the elapsed seconds server-side.
// Returns the recorded duration in seconds (0 if nothing was running). The
// local state is cleared only AFTER the server accepted the stop (or refused
// it for good), so a network blip doesn't silently lose the elapsed time.
export async function stopTimer() {
  const active = getActiveTimer();
  if (!active) return 0;
  try {
    const res = await api.post(`/api/tasks/${active.taskId}/timer/stop`, { start_iso: active.startIso });
    clearTimer();
    return res?.duration || 0;
  } catch (err) {
    // 4xx = the server will never accept it (task gone / not ours) → drop it.
    // Network / 5xx → keep the local timer so a retry can still record it.
    if (err && err.status >= 400 && err.status < 500) clearTimer();
    return 0;
  }
}

function clearTimer() {
  try { localStorage.removeItem(timerKey()); } catch { /* ignore */ }
  emit();
}

// Explicit logout: forget everything this user left in localStorage.
export function clearUserState(userId = currentUserId) {
  try {
    localStorage.removeItem(timerKey(userId));
    localStorage.removeItem(dismissKey(userId));
  } catch { /* ignore */ }
  emit();
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
