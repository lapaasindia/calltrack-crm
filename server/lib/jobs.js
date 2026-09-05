// Registry of in-flight background jobs (backup, cloud backup, AI worker,
// nightly maintenance) so graceful shutdown can wait for them instead of
// killing a half-written backup file mid-copy (audit SCALE-8). Once draining
// has begun new jobs are refused, so a scheduler tick that fires during
// shutdown can't start work the process is about to abandon.
let seq = 0;
let draining = false;
const active = new Map(); // id -> { name, started, promise }

export function isShuttingDown() {
  return draining;
}

// Run fn() as a tracked job. Returns fn's result; rejects with fn's error.
export async function runJob(name, fn) {
  if (draining) {
    const err = new Error(`Server is shutting down — ${name} not started`);
    err.code = 'SHUTTING_DOWN';
    throw err;
  }
  const id = ++seq;
  const promise = (async () => fn())();
  active.set(id, { name, started: Date.now(), promise });
  try {
    return await promise;
  } finally {
    active.delete(id);
  }
}

export function activeJobs() {
  const now = Date.now();
  return [...active.values()].map(({ name, started }) => ({ name, running_ms: now - started }));
}

// Stop accepting new jobs and wait (up to timeoutMs) for the running ones.
// Resolves true when everything finished, false on timeout.
export async function drainJobs(timeoutMs = 8000) {
  draining = true;
  const pending = [...active.values()].map((j) => j.promise.catch(() => {}));
  if (!pending.length) return true;
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
  const done = Promise.all(pending).then(() => true);
  const result = await Promise.race([done, timeout]);
  clearTimeout(timer);
  return result;
}

// Test hook.
export function _resetJobsForTests() {
  draining = false;
  active.clear();
}
