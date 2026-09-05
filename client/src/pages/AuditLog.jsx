// Owner-only audit trail (QA-13): GET /api/audit?limit=&offset= paginated,
// newest first. Reachable from Settings and the More sheet / sidebar.
import React, { useState } from 'react';
import { api, fmtDateTime } from '../api.js';
import { useRequest } from '../hooks.js';
import { ErrorState, LoadingState } from '../components.jsx';

const PAGE = 50;

function Details({ value }) {
  if (value == null) return null;
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  if (text.length > 240) text = `${text.slice(0, 240)}…`;
  return <div className="audit-details">{text}</div>;
}

export default function AuditLog() {
  const [offset, setOffset] = useState(0);
  const { data, error, loading, reload } = useRequest(
    ({ signal }) => api.get(`/api/audit?limit=${PAGE}&offset=${offset}`, { signal }), [offset],
  );
  const total = data ? data.total : 0;
  const page = Math.floor(offset / PAGE) + 1;
  const pages = Math.max(1, Math.ceil(total / PAGE));

  return (
    <>
      <div className="page-title">
        <h1>Audit log</h1>
        {data && <span style={{ color: 'var(--ink-soft)', fontSize: 13 }}>{total} entries</span>}
      </div>
      {error && !data && <ErrorState error={error} onRetry={reload} />}
      {loading && !data && <LoadingState />}
      {data && (
        <div className="card">
          {error && <ErrorState error={error} onRetry={reload} compact />}
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>When</th><th>Who</th><th>Action</th><th>Entity</th><th>Details</th><th>IP</th></tr></thead>
              <tbody>
                {data.logs.length === 0 && <tr><td colSpan={6} className="empty">Nothing recorded yet.</td></tr>}
                {data.logs.map((row) => (
                  <tr key={row.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(row.created_at)}</td>
                    <td>{row.user_name || row.user_email || (row.user_id ? `#${row.user_id}` : '—')}</td>
                    <td><b>{row.action}</b></td>
                    <td>{row.entity_type ? `${row.entity_type}${row.entity_id != null ? ` #${row.entity_id}` : ''}` : '—'}</td>
                    <td><Details value={row.details} /></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{row.ip || ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {pages > 1 && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14, alignItems: 'center' }}>
              <button type="button" className="btn small secondary" disabled={offset === 0 || loading}
                onClick={() => setOffset(Math.max(0, offset - PAGE))}>← Newer</button>
              <span style={{ fontSize: 13, color: 'var(--ink-soft)' }}>Page {page} of {pages}</span>
              <button type="button" className="btn small secondary" disabled={offset + PAGE >= total || loading}
                onClick={() => setOffset(offset + PAGE)}>Older →</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
