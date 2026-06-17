import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, fmtDateTime } from '../api.js';
import { useApp } from '../App.jsx';
import { isAdmin } from '../permissions.js';

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

export default function WhatsApp() {
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const admin = isAdmin(user.role);
  const [contacts, setContacts] = useState([]);
  const [search, setSearch] = useState('');
  const [activeId, setActiveId] = useState(null);
  const [thread, setThread] = useState(null); // { contact, messages }
  const [reply, setReply] = useState('');
  const [sending, setSending] = useState(false);
  const [status, setStatus] = useState(null);
  const threadEndRef = useRef(null);

  const loadContacts = useCallback(() => {
    const q = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    api.get(`/api/whatsapp/contacts${q}`).then(setContacts).catch(() => {});
  }, [search]);

  const loadStatus = useCallback(() => {
    api.get('/api/whatsapp/status').then(setStatus).catch(() => {});
  }, []);

  const loadThread = useCallback((id) => {
    if (!id) { setThread(null); return; }
    api.get(`/api/whatsapp/contacts/${id}/messages`).then(setThread).catch(() => {});
  }, []);

  useEffect(() => { loadContacts(); loadStatus(); }, [loadContacts, loadStatus]);
  useEffect(() => { loadThread(activeId); }, [activeId, loadThread]);

  // Light poll on the existing ~60s cadence — refresh the open thread + list.
  useEffect(() => {
    const iv = setInterval(() => { loadContacts(); if (activeId) loadThread(activeId); }, 60000);
    const onVis = () => { if (document.visibilityState === 'visible') { loadContacts(); if (activeId) loadThread(activeId); } };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, [activeId, loadContacts, loadThread]);

  useEffect(() => {
    if (threadEndRef.current) threadEndRef.current.scrollIntoView({ block: 'end' });
  }, [thread]);

  const send = async () => {
    const body = reply.trim();
    if (!body || !thread) return;
    setSending(true);
    try {
      await api.post('/api/whatsapp/send-message', { contactId: thread.contact.id, body });
      setReply('');
      loadThread(thread.contact.id);
      loadContacts();
    } catch (err) {
      showToast(err.message, 'error');
    } finally { setSending(false); }
  };

  const createLead = async () => {
    if (!thread) return;
    const c = thread.contact;
    const suggested = c.display_name || fmtPhone(c.phone) || 'WhatsApp lead';
    const name = window.prompt('Create a lead from this chat. Lead name:', suggested);
    if (name === null) return;
    try {
      const res = await api.post(`/api/whatsapp/contacts/${c.id}/create-lead`, { name: name.trim() });
      showToast(res.created ? 'Lead created ✓' : 'Linked to existing lead ✓');
      loadThread(c.id); loadContacts();
      navigate(`/leads/${res.lead_id}`);
    } catch (err) { showToast(err.message, 'error'); }
  };

  const connected = status?.status === 'connected';

  return (
    <>
      <div className="page-title" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h1>💬 WhatsApp inbox</h1>
        <span className={`badge ${connected ? 'won' : 'pending'}`}>
          {connected ? 'connected' : (status?.status || 'disconnected')}
        </span>
        {!connected && (
          <Link to="/settings" className="meta" style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
            Connect in Settings →
          </Link>
        )}
      </div>

      <div className="wa-inbox">
        {/* Conversation list */}
        <aside className="wa-list card">
          <input className="wa-search" placeholder="Search chats / leads / number…"
            value={search} onChange={(e) => setSearch(e.target.value)} />
          <div className="wa-conv-list">
            {contacts.length === 0 && (
              <div className="wa-empty">No conversations yet. Inbound messages appear here.</div>
            )}
            {contacts.map((c) => (
              <button key={c.id} className={`wa-conv ${c.id === activeId ? 'active' : ''}`}
                onClick={() => setActiveId(c.id)}>
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
        <section className="wa-thread card">
          {!thread && <div className="wa-empty" style={{ margin: 'auto' }}>Pick a conversation.</div>}
          {thread && (
            <>
              <div className="wa-thread-head">
                <div>
                  <b>{contactTitle(thread.contact)}</b>
                  <div className="meta" style={{ color: 'var(--ink-soft)', fontSize: 12.5 }}>
                    {fmtPhone(thread.contact.phone || thread.contact.lead_phone)}
                  </div>
                </div>
              </div>
              <div className="wa-messages">
                {thread.messages.map((m) => (
                  <div key={m.id} className={`wa-bubble ${m.direction}`}>
                    <div className="wa-bubble-body">{m.body || `[${m.message_type}]`}</div>
                    <div className="wa-bubble-time">{fmtDateTime(m.sent_at)}</div>
                  </div>
                ))}
                <div ref={threadEndRef} />
              </div>
              {admin && (
                <div className="wa-reply">
                  <textarea rows={2} value={reply} placeholder={connected ? 'Type a reply…' : 'WhatsApp not connected'}
                    disabled={!connected}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send(); }} />
                  <button className="btn" disabled={!connected || sending || !reply.trim()} onClick={send}>
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
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{thread.contact.lead_name}</div>
                  <div className="meta" style={{ color: 'var(--ink-soft)' }}>
                    Stage: <b>{thread.contact.lead_stage || '—'}</b><br />
                    Score: <b>{thread.contact.lead_score ?? '—'}</b>
                  </div>
                  <Link className="btn small secondary" to={`/leads/${thread.contact.lead_id}`}
                    style={{ marginTop: 10, display: 'inline-block' }}>
                    Open lead →
                  </Link>
                </>
              ) : (
                <>
                  <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>
                    This chat isn’t linked to a lead yet.
                  </p>
                  {admin && (
                    <button className="btn small green" onClick={createLead}>+ Create lead from chat</button>
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
