// Setup wizard logic (moved out of setup.html so the page can carry a strict
// CSP — DESK-16). Talks to the main process only through window.calltrack
// (preload.cjs); every value shown here is set via textContent.
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const attached = params.get('attached') === '1';
  const previous = params.get('previous') || '';

  function fail(msg) { $('err').textContent = msg; $('err').style.display = msg ? 'block' : 'none'; }
  if (params.get('error')) fail(params.get('error'));
  if (attached) $('attachedInfo').style.display = 'block';
  if (previous) {
    $('previousInfo').textContent = `Previously connected to ${previous}. Pick "Connect" and enter the address again to keep using it, or make this the main computer (you will be asked to confirm).`;
    $('previousInfo').style.display = 'block';
    $('serverUrl').value = previous.replace(/^https?:\/\//, '');
  }
  if (attached) { $('restoreBtn').disabled = true; $('restoreBtn').title = 'Not available while the background service owns the data'; }

  let mode = null;
  function pick(m) {
    mode = m;
    $('pickHost').classList.toggle('on', m === 'host');
    $('pickJoin').classList.toggle('on', m === 'join');
    $('hostPanel').style.display = m === 'host' ? 'block' : 'none';
    $('joinPanel').style.display = m === 'join' ? 'block' : 'none';
    if (m === 'join') $('serverUrl').focus();
  }
  $('pickHost').onclick = () => pick('host');
  $('pickJoin').onclick = () => pick('join');
  if (previous) pick('join');

  $('goHost').onclick = async () => {
    fail('');
    $('goHost').disabled = true;
    try {
      const res = await window.calltrack.choose({ mode: 'host', openAtLogin: $('openAtLogin').checked });
      if (!res.ok) { if (res.error) fail(res.error); $('goHost').disabled = false; }
    } catch (err) {
      fail(`Setup failed: ${err && err.message}`);
      $('goHost').disabled = false;
    }
  };

  $('goJoin').onclick = async () => {
    fail('');
    if (!$('serverUrl').value.trim()) return fail('Enter the main computer\'s address first.');
    $('goJoin').disabled = true;
    $('goJoin').textContent = 'Checking…';
    try {
      const res = await window.calltrack.choose({ mode: 'join', serverUrl: $('serverUrl').value });
      if (!res.ok) {
        if (res.error) fail(res.error);
        $('goJoin').disabled = false;
        $('goJoin').textContent = 'Connect';
      }
    } catch (err) {
      fail(`Could not connect: ${err && err.message}`);
      $('goJoin').disabled = false;
      $('goJoin').textContent = 'Connect';
    }
    return undefined;
  };
  $('serverUrl').onkeydown = (e) => { if (e.key === 'Enter') $('goJoin').click(); };

  $('restoreBtn').onclick = async () => {
    if (attached) return;
    fail('');
    $('restoreBtn').disabled = true;
    $('restoreBtn').textContent = 'Checking the backup…';
    try {
      const res = await window.calltrack.restore();
      if (res.ok) {
        const users = res.users ? ` (${res.users} team members)` : '';
        $('restoreOk').textContent = `✓ Restored from ${res.file}${users} — your data will be there when the app starts. ${res.note || ''}`;
        $('restoreOk').style.display = 'block';
      } else if (res.error) fail(res.error);
    } catch (err) {
      fail(`Restore failed: ${err && err.message}`);
    }
    $('restoreBtn').disabled = false;
    $('restoreBtn').textContent = '↩︎ I have a backup file — restore my data';
  };
})();
