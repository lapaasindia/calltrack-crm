import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDateTime } from '../api.js';
import { useApp } from '../ctx.js';
import { useDebouncedValue, usePolling, useRequest, useSubmit } from '../hooks.js';
import { isAdmin } from '../permissions.js';
import { ErrorState } from '../components.jsx';

// Indian phone formatting: 9876543210 → +91 98765 43210. Falls back to raw.
function fmtPhone(phone) {
  if (!phone) return '';
  const d = String(phone).replace(/\D/g, '');
  if (d.length === 10) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
  return phone;
}

function contactTitle(c) {
  return c.lead_name || c.display_name || fmtPhone(c.phone) || c.wa_jid;
}

const WINDOW = 50; // messages rendered initially; "Show earlier" reveals more

export default function WhatsApp() {
  const { user, showToast, askPrompt } = useApp();
  const navigate = useNavigate();
  const admin = isAdmin(user.role);
  const [search, setSearch] = useState('');
  const dSearch = useDebouncedValue(search, 300);
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState(null); // { contact, messages }
  const [threadError, setThreadError] = useState(null);
  const [visible, setVisible] = useState(WINDOW);
  const [reply, setReply] = useState('');
  const [status, setStatus] = useState(null);
  const threadEndRef = useRef(null);
  const lastCountRef = useRef(0);

  const { data: contacts, error, reload: loadContacts } = useRequest(({ signal }) => {
    const q = dSearch.trim() ? `?search=${encodeURIComponent(dSearch.trim())}` : '';
    return api.get(`/api/whatsapp/contacts${q}`, { signal });
  }, [dSearch]);

  const loadStatus = useCallback(() => {
    api.get('/api/whatsapp/status').then(setStatus).catch(() => {});
  }, []);

  const loadThread = useCallback((id) => {
    if (!id) { setThread(null); return; }
    api.get(`/api/whatsapp/contacts/${id}/messages`)
      .then((t) => { setThread(t); setThreadError(null); })
      .catch((e) => setThreadError(e));
  }, []);

  // Opening the inbox (and reading a thread) moves the per-user "seen"
  // watermark that drives the nav badge (CLIENT-9).
  useEffect(() => { window.dispatchEvent(new Event('crm:wa-seen')); }, [thread]);
  useEffect(() => { loadStatus(); }, [loadStatus]);
  useEffect(() => { setVisible(WINDOW); lastCountRef.current = 0; loadThread(activeId); }, [activeId, loadThread]);

  // Light poll on the existing ~60s cadence — refresh the open thread + list,
  // only while the tab is visible.
  usePolling(() => { loadContacts(); if (activeId) loadThread(activeId); }, 60000, [activeId, loadContacts, loadThread]);

  useEffect(() => {
    const n = thread ? thread.messages.length : 0;
    if (n !== lastCountRef.current && threadEndRef.current) threadEndRef.current.scrollIntoView({ block: 'end' });
    lastCountRef.current = n;
  }, [thread]);

  const [send, sending] = useSubmit(async () => {
    const body = reply.trim();
    if (!body || !thread) return;
    try {
      await api.post('/api/whatsapp/send-message', { contactId: thread.contact.id, body });
      setReply('');
      loadThread(thread.contact.id);
      loadContacts();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  const [createLead, creating] = useSubmit(async () => {
    if (!thread) return;
    const c = thread.contact;
    const suggested = c.display_name || fmtPhone(c.phone) || 'WhatsApp lead';
    const name = await askPrompt({
      title: 'Create a lead from this chat', label: 'Lead name', defaultValue: suggested, required: true, submitLabel: 'Create lead',
    });
    if (name === null) return;
    try {
      const res = await api.post(`/api/whatsapp/contacts/${c.id}/create-lead`, { name: name.trim() });
      showToast(res.created ? 'Lead created ✓' : 'Linked to existing lead ✓');
      loadThread(c.id); loadContacts();
      navigate(`/leads/${res.lead_id}`);
    } catch (err) { showToast(err.message, 'error'); }
  });

  const connected = status && status.status === 'connected';
  const messages = thread ? thread.messages : [];
  const shown = messages.length > visible ? messages.slice(messages.length - visible) : messages;

  return (
    <>
      <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1>💬 WhatsApp inbox</h1>
        <span className={`badge ${connected ? 'won' : 'pending'}`}>
          {connected ? 'connected' : ((status && status.status) || 'disconnected')}
        </span>
        {!connected && (
          <Link to="/settings" className="meta" style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
            Connect in Settings →
          </Link>
        )}
      </div>

      {error && !contacts && <ErrorState error={error} onRetry={loadContacts} compact />}

      <div className="wa-inbox">
        {/* Conversation list */}
        <aside className="wa-list card">
          <input className="wa-search" type="search" placeholder="Search chats / leads / number…" aria-label="Search chats"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="wa-conv-list">
            {contacts && contacts.length === 0 && (
              <div className="wa-empty">No conversations yet. Inbound messages appear here.</div>
            )}
            {(contacts || []).map((c) => (
              <button key={c.id} type="button" className={`wa-conv ${c.id === activeId ? 'active' : ''}`}
                aria-current={c.id === activeId ? 'true' : undefined} onClick={() => setActiveId(c.id)}>
                <div className="wa-conv-top">
                  <span className="wa-conv-name">{contactTitle(c)}</span>
                  <span className="wa-conv-time">{c.last_message_at ? fmtDateTime(c.last_message_at) : ''}</span>
                </div>
                <div className="wa-conv-last">
                  {c.last_direction === 'outgoing' ? '↩ ' : ''}{c.last_body || '—'}
                </div>
                {c.lead_id
                  ? <span className="badge new" style={{ fontSize: 10 }}>{c.lead_name || 'lead'}</span>
                  : <span className="badge pending" style={{ fontSize: 10 }}>not a lead</span>}
              </button>
            ))}
          </div>
        </aside>

        {/* Thread */}
        <section className="wa-thread card" aria-label="Conversation">
          {!thread && !threadError && <div className="wa-empty" style={{ margin: 'auto' }}>Pick a conversation.</div>}
          {threadError && !thread && <ErrorState error={threadError} onRetry={() => loadThread(activeId)} compact />}
          {thread && (
            <>
              <div className="wa-thread-head">
                <div>
                  <b>{contactTitle(thread.contact)}</b>
                  <div className="meta" style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>
                    {fmtPhone(thread.contact.phone || thread.contact.lead_phone)}
                  </div>
                </div>
                <span style={{ fontSize: 12, color: 'var(--ink-faint)' }}>{messages.length} messages</span>
              </div>
              <div className="wa-messages">
                {messages.length > shown.length && (
                  <button type="button" className="btn small secondary wa-earlier" onClick={() => setVisible((v) => v + WINDOW)}>
                    Show earlier messages ({messages.length - shown.length} more)
                  </button>
                )}
                {shown.map((m) => (
                  <div key={m.id} className={`wa-bubble ${m.direction}`}>
                    <div className="wa-bubble-body">{m.body || `[${m.message_type}]`}</div>
                    <div className="wa-bubble-time">{fmtDateTime(m.sent_at)}</div>
                  </div>
                ))}
                <div ref={threadEndRef} />
              </div>
              {admin && (
                <div className="wa-reply">
                  <textarea rows={2} value={reply} aria-label="Reply" placeholder={connected ? 'Type a reply…' : 'WhatsApp not connected'}
                    disabled={!connected}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} />
                  <button type="button" className="btn" disabled={!connected || sending || !reply.trim()} onClick={send}>
                    {sending ? 'Sending…' : 'Send'}
                  </button>
                </div>
              )}
            </>
          )}
        </section>

        {/* Lead panel */}
        <aside className="wa-lead card">
          {!thread && <div className="wa-empty">Lead details show here.</div>}
          {thread && (
            <>
              <div className="section-label">Lead</div>
              {thread.contact.lead_id ? (
                <>
                  <div style={{ fontWeight: 700, fontSize: 16, overflowWrap: 'anywhere' }}>{thread.contact.lead_name}</div>
                  <div className="meta" style={{ color: 'var(--ink-soft)' }}>
                    Stage: <b>{thread.contact.lead_stage || '—'}</b><br />
                    Score: <b>{thread.contact.lead_score ?? '—'}</b>
                  </div>
                  <Link className="btn small secondary" to={`/leads/${thread.contact.lead_id}`}
                    style={{ marginTop: 10, display: 'inline-flex' }}>
                    Open lead →
                  </Link>
                </>
              ) : (
                <>
                  <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    This chat isn't linked to a lead yet.
                  </p>
                  {admin && (
                    <button type="button" className="btn small green" disabled={creating} onClick={createLead}>+ Create lead from chat</button>
                  )}
                </>
              )}
            </>
          )}
        </aside>
      </div>
    </>
  );
}
