import React, { useEffect, useMemo, useState } from 'react';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { useApp } from '../App.jsx';

const FIELDS = [
  ['name', 'Name *'], ['phone', 'Phone *'], ['alt_phone', 'Alt phone'],
  ['email', 'Email'], ['city', 'City'], ['source', 'Source'], ['notes', 'Notes'],
];

// Header-name patterns for auto-mapping. Meta Lead Ads and Google Forms
// presets are just smarter pattern sets over the same machinery.
const AUTO_PATTERNS = {
  name: [/full[_ ]?name/i, /^name$/i, /your[_ ]?name/i, /candidate/i, /नाम/],
  phone: [/phone/i, /mobile/i, /contact[_ ]?n/i, /whatsapp/i, /फ़?ोन/, /मोबाइल/],
  email: [/e-?mail/i],
  city: [/city/i, /location/i, /शहर/],
  source: [/source/i, /campaign[_ ]?name/i],
  notes: [/message/i, /comments?/i, /remarks?/i],
};

function detectPreset(headers) {
  const h = headers.map((x) => x.toLowerCase());
  if (h.some((x) => x === 'created_time') && h.some((x) => x.includes('campaign') || x.startsWith('ad_'))) {
    return 'meta';
  }
  if (h.some((x) => x === 'timestamp')) return 'google_form';
  return null;
}

function autoMap(headers) {
  const map = {};
  for (const [field] of FIELDS) {
    const patterns = AUTO_PATTERNS[field] || [];
    const hit = headers.find((h) => patterns.some((p) => p.test(h)));
    if (hit && !Object.values(map).includes(hit)) map[field] = hit;
  }
  return map;
}

// Strip BOM (else it glues to the first header and breaks mapping) and decode.
async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    const buf = await file.arrayBuffer();
    const wb = XLSX.read(buf, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    // raw:false → formatted text (preserves long phone numbers as displayed)
    const rows = XLSX.utils.sheet_to_json(sheet, { raw: false, defval: '' });
    return { headers: rows.length ? Object.keys(rows[0]) : [], rows };
  }
  let buf = new Uint8Array(await file.arrayBuffer());
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) buf = buf.slice(3);
  let text;
  let encodingWarning = false;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = new TextDecoder('windows-1252').decode(buf);
    encodingWarning = true;
  }
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true });
  return { headers: parsed.meta.fields || [], rows: parsed.data, encodingWarning };
}

export default function ImportPage() {
  const { showToast } = useApp();
  const [step, setStep] = useState(1);
  const [file, setFile] = useState(null);
  const [parsed, setParsed] = useState(null);
  const [mapping, setMapping] = useState({});
  const [preset, setPreset] = useState(null);
  const [defaultSource, setDefaultSource] = useState('import');
  const [assignMode, setAssignMode] = useState('none');
  const [assignTo, setAssignTo] = useState('');
  const [users, setUsers] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [batches, setBatches] = useState([]);

  useEffect(() => {
    api.get('/api/users').then((u) => setUsers(u.filter((x) => x.is_active && x.role === 'caller'))).catch(() => {});
    api.get('/api/imports').then(setBatches).catch(() => {});
  }, []);

  const onFile = async (f) => {
    if (!f) return;
    setFile(f);
    setBusy(true);
    try {
      const p = await parseFile(f);
      if (!p.rows.length) { showToast('File has no rows', 'error'); setBusy(false); return; }
      setParsed(p);
      const detected = detectPreset(p.headers);
      setPreset(detected);
      setMapping(autoMap(p.headers));
      setDefaultSource(detected === 'meta' ? 'meta_ads' : detected === 'google_form' ? 'google_form' : 'import');
      setStep(2);
    } catch (err) {
      showToast(`Could not read file: ${err.message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const mappedRows = useMemo(() => {
    if (!parsed) return [];
    return parsed.rows.map((row) => {
      const out = {};
      for (const [field] of FIELDS) {
        if (mapping[field]) out[field] = row[mapping[field]];
      }
      // Keep unmapped columns (campaign names etc.) — they're shown on the lead later.
      const extra = {};
      for (const h of parsed.headers) {
        if (!Object.values(mapping).includes(h) && row[h] !== '' && row[h] != null) extra[h] = row[h];
      }
      if (Object.keys(extra).length) out.extra = extra;
      return out;
    });
  }, [parsed, mapping]);

  const doImport = async () => {
    setBusy(true);
    try {
      const res = await api.post('/api/imports', {
        filename: file.name,
        preset,
        default_source: defaultSource,
        rows: mappedRows,
        assigned_to: assignMode === 'one' ? Number(assignTo) : undefined,
        round_robin: assignMode === 'rr' || undefined,
      });
      setResult(res);
      setStep(3);
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setBusy(false);
    }
  };

  const mergeNote = async (dup) => {
    try {
      await api.post('/api/imports/merge-note', {
        lead_id: dup.existing_id,
        note: `Re-enquired via ${file.name} (${dup.name})`,
      });
      showToast('Note added to existing lead ✓');
    } catch (err) { showToast(err.message, 'error'); }
  };

  const reset = () => { setStep(1); setFile(null); setParsed(null); setResult(null); };

  return (
    <>
      <div className="page-title"><h1>Import leads</h1></div>

      {step === 1 && (
        <>
          <div className="card">
            <h2>Upload a file</h2>
            <p style={{ color: 'var(--ink-soft)', marginTop: 0 }}>
              CSV or Excel (.xlsx) — exports from <b>Meta Lead Ads</b>, <b>Google Forms</b>, or any
              spreadsheet with names and phone numbers. For Hindi names, prefer .xlsx — Excel-saved
              CSVs often destroy them.
            </p>
            <input type="file" accept=".csv,.xlsx,.xls" disabled={busy}
              onChange={(e) => onFile(e.target.files[0])} />
          </div>
          {batches.length > 0 && (
            <div className="card">
              <h2>Past imports</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>File</th><th className="num">Rows</th><th className="num">Imported</th><th className="num">Duplicates</th><th className="num">Invalid</th><th>By</th></tr></thead>
                  <tbody>
                    {batches.map((b) => (
                      <tr key={b.id}>
                        <td>{b.filename}</td>
                        <td className="num">{b.total_rows}</td>
                        <td className="num" style={{ color: 'var(--green)' }}>{b.imported_count}</td>
                        <td className="num">{b.duplicate_count}</td>
                        <td className="num" style={{ color: b.invalid_count ? 'var(--red)' : undefined }}>{b.invalid_count}</td>
                        <td>{b.imported_by_name}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}

      {step === 2 && parsed && (
        <>
          <div className="card">
            <h2>
              Map columns — {file.name} ({parsed.rows.length} rows)
              {preset && <span className="badge new" style={{ marginLeft: 8 }}>
                {preset === 'meta' ? 'Meta Lead Ads detected' : 'Google Forms detected'}</span>}
            </h2>
            {parsed.encodingWarning && (
              <p className="err">⚠️ This CSV isn't UTF-8 — Hindi/special characters may look wrong below.
                If they do, re-export as .xlsx or "CSV UTF-8".</p>
            )}
            <div className="form-grid">
              {FIELDS.map(([field, label]) => (
                <div className="field" key={field}>
                  <label>{label}</label>
                  <select value={mapping[field] || ''}
                    onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}>
                    <option value="">— not in file —</option>
                    {parsed.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                  </select>
                </div>
              ))}
            </div>
            <div className="form-grid">
              <div className="field">
                <label>Source tag for these leads</label>
                <input value={defaultSource} onChange={(e) => setDefaultSource(e.target.value)} />
              </div>
              <div className="field">
                <label>Assign to</label>
                <select value={assignMode} onChange={(e) => setAssignMode(e.target.value)}>
                  <option value="none">Leave unassigned</option>
                  <option value="rr">Distribute equally among callers</option>
                  <option value="one">One caller</option>
                </select>
                {assignMode === 'one' && (
                  <select style={{ marginTop: 6 }} value={assignTo} onChange={(e) => setAssignTo(e.target.value)}>
                    <option value="">Pick caller…</option>
                    {users.map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}
                  </select>
                )}
              </div>
            </div>
          </div>

          <div className="card">
            <h2>Preview (first 10 rows — check names & phones look right)</h2>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>#</th><th>Name</th><th>Phone</th><th>City</th><th>Email</th></tr></thead>
                <tbody>
                  {mappedRows.slice(0, 10).map((r, i) => (
                    <tr key={i}>
                      <td>{i + 1}</td><td>{r.name}</td>
                      <td style={{ fontVariantNumeric: 'tabular-nums' }}>
                        {String(r.phone ?? '')}
                        {/e\+/i.test(String(r.phone)) && <span className="badge overdue" style={{ marginLeft: 6 }}>Excel-mangled</span>}
                      </td>
                      <td>{r.city}</td><td>{r.email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="modal-actions" style={{ maxWidth: 420 }}>
              <button className="btn secondary" onClick={reset}>← Different file</button>
              <button className="btn" disabled={busy || !mapping.name || !mapping.phone || (assignMode === 'one' && !assignTo)}
                onClick={doImport}>
                {busy ? 'Importing…' : `Import ${mappedRows.length} leads`}
              </button>
            </div>
            {(!mapping.name || !mapping.phone) && (
              <p className="err">Map the Name and Phone columns to continue.</p>
            )}
          </div>
        </>
      )}

      {step === 3 && result && (
        <>
          <div className="stat-grid">
            <div className="stat"><div className="label">Imported</div>
              <div className="value" style={{ color: 'var(--green)' }}>{result.imported}</div></div>
            <div className="stat"><div className="label">Duplicates</div>
              <div className="value" style={{ color: 'var(--amber)' }}>{result.duplicates.length}</div></div>
            <div className="stat"><div className="label">Invalid</div>
              <div className="value" style={{ color: result.invalid.length ? 'var(--red)' : undefined }}>{result.invalid.length}</div></div>
          </div>

          {result.duplicates.length > 0 && (
            <div className="card">
              <h2>Duplicates (skipped — nothing was silently dropped)</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Matches</th><th></th></tr></thead>
                  <tbody>
                    {result.duplicates.map((d, i) => (
                      <tr key={i}>
                        <td>{d.row}</td><td>{d.name}</td><td>{d.phone}</td>
                        <td>
                          {d.kind === 'in_file'
                            ? `Row ${d.first_row} of this file`
                            : <Link to={`/leads/${d.existing_id}`}>{d.existing_name}</Link>}
                        </td>
                        <td>{d.kind === 'in_db' && (
                          <button className="btn small secondary" onClick={() => mergeNote(d)}>Add note to existing</button>
                        )}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {result.invalid.length > 0 && (
            <div className="card">
              <h2>Invalid rows (fix in the file and re-import just these)</h2>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Row</th><th>Name</th><th>Phone</th><th>Problem</th></tr></thead>
                  <tbody>
                    {result.invalid.map((d, i) => (
                      <tr key={i}>
                        <td>{d.row}</td><td>{d.name}</td><td>{String(d.phone)}</td>
                        <td>{{
                          empty: 'No phone number', wrong_length: 'Not 10 digits',
                          bad_prefix: 'Not a mobile number', excel_mangled: 'Digits destroyed by Excel (E+ format)',
                          missing_name: 'No name', invalid: 'Unreadable',
                        }[d.reason] || d.reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn" onClick={reset}>Import another file</button>
            <Link className="btn secondary" to="/leads">View leads →</Link>
          </div>
        </>
      )}
    </>
  );
}
