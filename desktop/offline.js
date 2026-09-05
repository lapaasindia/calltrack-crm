// Offline / service-starting screen. No IPC, no preload: the main process
// polls /api/health itself and reloads the app when it answers; the two
// buttons are calltrack:// links that main.js turns into actions.
(() => {
  const p = new URLSearchParams(location.search);
  const $ = (id) => document.getElementById(id);
  const mode = p.get('mode') || 'offline';
  $('url').textContent = p.get('url') || '';
  if (mode === 'service') {
    $('title').textContent = 'CallTrack service is starting…';
    $('text').textContent = 'This computer runs the CallTrack background service. The app will open as soon as the service answers (usually a few seconds after login).';
  }
  if (p.get('reason')) $('reason').textContent = p.get('reason');
  if (p.get('version')) $('version').textContent = `CallTrack CRM v${p.get('version')}${p.get('log') ? ` · log: ${p.get('log')}` : ''}`;
})();
