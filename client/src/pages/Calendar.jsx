// Phase 4B — Calendar. A CUSTOM grid (no calendar/chart lib): week (default),
// month, and day views over an hour grid, with prev/next/Today nav.
//
// Three overlay kinds: scheduled TASKS (blue) from /api/tasks (board_status not
// Done/Drop, both scheduled_*_at set), TIME BLOCKS (amber) from
// /api/time-blocks, and MEETINGS (green) from /api/meetings (not Cancelled).
// Non-admins are scoped to their own by the server.
//
// Click an empty slot → quick-add a Task or a Time Block (prefilled to that
// hour). Click an item → open it (task detail / edit the block / meeting detail).
// Reloads on window focus. All IST date math via api.js helpers; instants are UTC.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate, todayIstDate, IST_OFFSET_MS } from '../api.js';
import { useApp } from '../App.jsx';
import { isAdmin } from '../permissions.js';
import { Modal, TimeBlockDialog } from '../components.jsx';

const HOURS = Array.from({ length: 24 }, (_, h) => h); // 0..23
const DAY_START_HOUR = 6; // scroll the grid to a sensible working start
const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---- IST <-> instant helpers (no hand-rolled tz beyond the shared offset) ----

// IST 'YYYY-MM-DD' of a UTC instant.
function istDateOf(iso) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date(iso));
}
// IST hour (0..23, fractional) of a UTC instant — for vertical placement.
function istHourFloat(iso) {
  const shifted = new Date(Date.parse(iso) + IST_OFFSET_MS);
  return shifted.getUTCHours() + shifted.getUTCMinutes() / 60;
}
// Build a UTC ISO instant from an IST date + IST hour.
function istToUtcIso(dateStr, hour, minute = 0) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour, minute) - IST_OFFSET_MS).toISOString();
}
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}
// Monday-start week containing dateStr → 7 IST date strings.
function weekDays(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const base = new Date(Date.UTC(y, m - 1, d));
  const dow = (base.getUTCDay() + 6) % 7; // Mon=0
  const monday = addDaysStr(dateStr, -dow);
  return Array.from({ length: 7 }, (_, i) => addDaysStr(monday, i));
}
// Month grid (full weeks, Monday-start) covering dateStr's month.
function monthGridDays(dateStr) {
  const first = `${dateStr.slice(0, 7)}-01`;
  const [y, m] = [Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7))];
  const start = weekDays(first)[0];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const last = `${dateStr.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
  const end = weekDays(last)[6];
  const days = [];
  for (let dd = start; dd <= end; dd = addDaysStr(dd, 1)) days.push(dd);
  return days;
}
function hourLabel(h) {
  const ampm = h < 12 ? 'am' : 'pm';
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}${ampm}`;
}

// Color per overlay kind: task=blue, time_block=amber, meeting=green.
const EVENT_COLORS = {
  task: { bg: 'var(--blue-soft)', fg: 'var(--blue)' },
  time_block: { bg: 'var(--amber-soft)', fg: 'var(--amber)' },
  meeting: { bg: 'var(--green-soft)', fg: 'var(--green)' },
};
function eventColor(kind) { return EVENT_COLORS[kind] || EVENT_COLORS.task; }
function eventSub(ev) {
  if (ev.kind === 'task') return 'Task';
  if (ev.kind === 'meeting') return 'Meeting';
  return ev.block_type;
}

// One positioned event chip inside a day column.
function EventChip({ ev, onClick }) {
  const top = istHourFloat(ev.start_at);
  const end = istHourFloat(ev.end_at);
  // A window crossing midnight (rare) is clamped to the day's end for display.
  const height = Math.max(0.5, (end > top ? end : 24) - top);
  const c = eventColor(ev.kind);
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick(ev); }}
      title={ev.title}
      style={{
        position: 'absolute', left: 3, right: 3,
        top: `${top * 48}px`, height: `${height * 48 - 3}px`,
        background: c.bg,
        border: `1px solid ${c.fg}`,
        borderLeft: `3px solid ${c.fg}`,
        color: c.fg,
        borderRadius: 6, padding: '2px 5px', fontSize: 11, textAlign: 'left',
        overflow: 'hidden', cursor: 'pointer', zIndex: 2,
      }}>
      <b style={{ display: 'block', whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden' }}>
        {ev.title}
      </b>
      <span style={{ opacity: 0.85 }}>{eventSub(ev)}</span>
    </button>
  );
}

export default function Calendar() {
  const { user, showToast } = useApp();
  const navigate = useNavigate();
  const admin = isAdmin(user.role);
  const [view, setView] = useState('week'); // 'day' | 'week' | 'month'
  const [anchor, setAnchor] = useState(todayIstDate()); // IST date string in view
  const [tasks, setTasks] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [meetings, setMeetings] = useState([]);
  const [quickAdd, setQuickAdd] = useState(null); // {date,hour}
  const [blockDialog, setBlockDialog] = useState(null); // {block?|prefill}

  const days = useMemo(() => {
    if (view === 'day') return [anchor];
    if (view === 'month') return monthGridDays(anchor);
    return weekDays(anchor);
  }, [view, anchor]);

  const range = useMemo(() => ({ from: days[0], to: days[days.length - 1] }), [days]);

  const load = useCallback(() => {
    const q = `?status=all`;
    api.get(`/api/tasks${q}`)
      .then((rows) => setTasks(rows.filter((t) => t.scheduled_start_at && t.scheduled_end_at
        && t.board_status !== 'Done' && t.board_status !== 'Drop')))
      .catch((e) => showToast(e.message, 'error'));
    api.get(`/api/time-blocks?from=${range.from}&to=${range.to}`)
      .then(setBlocks)
      .catch((e) => showToast(e.message, 'error'));
    api.get('/api/meetings')
      .then((rows) => setMeetings(rows.filter((m) => m.status !== 'Cancelled')))
      .catch((e) => showToast(e.message, 'error'));
  }, [range.from, range.to, showToast]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // Index events by IST day.
  const eventsByDay = useMemo(() => {
    const map = {};
    const push = (day, ev) => { (map[day] = map[day] || []).push(ev); };
    for (const t of tasks) {
      push(istDateOf(t.scheduled_start_at), {
        kind: 'task', id: t.id, title: t.title,
        start_at: t.scheduled_start_at, end_at: t.scheduled_end_at,
      });
    }
    for (const b of blocks) push(b.block_date, { kind: 'time_block', ...b });
    for (const m of meetings) {
      push(istDateOf(m.start_at), {
        kind: 'meeting', id: m.id, title: m.title,
        start_at: m.start_at, end_at: m.end_at, status: m.status,
      });
    }
    return map;
  }, [tasks, blocks, meetings]);

  const step = (dir) => {
    if (view === 'day') setAnchor((d) => addDaysStr(d, dir));
    else if (view === 'week') setAnchor((d) => addDaysStr(d, dir * 7));
    else {
      const [y, m] = [Number(anchor.slice(0, 4)), Number(anchor.slice(5, 7))];
      const next = new Date(Date.UTC(y, m - 1 + dir, 1));
      setAnchor(next.toISOString().slice(0, 10));
    }
  };

  const openEvent = (ev) => {
    if (ev.kind === 'task') navigate(`/work/${ev.id}`);
    else if (ev.kind === 'meeting') navigate(`/meetings/${ev.id}`);
    else setBlockDialog({ block: ev });
  };

  const onSlotClick = (date, hour) => setQuickAdd({ date, hour });

  const title = view === 'month'
    ? new Date(`${anchor}T00:00:00Z`).toLocaleDateString('en-IN', { timeZone: 'UTC', month: 'long', year: 'numeric' })
    : view === 'day' ? fmtDate(anchor)
      : `${fmtDate(days[0])} – ${fmtDate(days[6])}`;

  return (
    <>
      <div className="page-title">
        <h1>Calendar</h1>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="seg">
            {['day', 'week', 'month'].map((v) => (
              <button key={v} type="button" className={view === v ? 'on' : ''}
                onClick={() => setView(v)}>{v[0].toUpperCase() + v.slice(1)}</button>
            ))}
          </div>
          <button className="btn small secondary" onClick={() => step(-1)} title="Previous">‹</button>
          <button className="btn small secondary" onClick={() => setAnchor(todayIstDate())}>Today</button>
          <button className="btn small secondary" onClick={() => step(1)} title="Next">›</button>
        </div>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
          <b style={{ fontSize: 15 }}>{title}</b>
          <div style={{ display: 'flex', gap: 12, fontSize: 12, color: 'var(--ink-soft)' }}>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'var(--blue)', marginRight: 4 }} />Tasks</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'var(--amber)', marginRight: 4 }} />Time blocks</span>
            <span><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: 'var(--green)', marginRight: 4 }} />Meetings</span>
          </div>
        </div>

        {view === 'month' ? (
          <MonthGrid days={days} anchor={anchor} eventsByDay={eventsByDay}
            today={todayIstDate()} onDayClick={(d) => { setAnchor(d); setView('day'); }}
            onEvent={openEvent} />
        ) : (
          <HourGrid days={days} eventsByDay={eventsByDay} today={todayIstDate()}
            onSlot={onSlotClick} onEvent={openEvent} />
        )}
      </div>

      {quickAdd && (
        <QuickAddDialog slot={quickAdd}
          onClose={() => setQuickAdd(null)}
          onPickBlock={(prefill) => { setQuickAdd(null); setBlockDialog({ prefill }); }}
          onSaved={() => { setQuickAdd(null); load(); }} />
      )}
      {blockDialog && (
        <TimeBlockDialog
          admin={admin}
          block={blockDialog.block}
          prefill={blockDialog.prefill}
          onClose={() => setBlockDialog(null)}
          onSaved={() => { setBlockDialog(null); load(); }} />
      )}
    </>
  );
}

// ---- the hour grid (day + week) ----
function HourGrid({ days, eventsByDay, today, onSlot, onEvent }) {
  // Scroll the (vertically-scrollable) grid to the working start once on mount.
  const scrollRef = React.useRef(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = DAY_START_HOUR * 48;
  }, []);
  return (
    <div ref={scrollRef} style={{ overflow: 'auto', maxHeight: '70vh' }}>
      <div style={{
        display: 'grid',
        gridTemplateColumns: `54px repeat(${days.length}, minmax(110px, 1fr))`,
        minWidth: days.length > 1 ? 760 : 320,
      }}>
        <div />
        {days.map((d) => (
          <div key={d} style={{
            textAlign: 'center', padding: '6px 0', fontSize: 12, fontWeight: 700,
            color: d === today ? 'var(--brand)' : 'var(--ink)',
            borderBottom: '2px solid var(--line)',
          }}>
            {DOW[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]} {Number(d.slice(8))}
          </div>
        ))}

        <div>
          {HOURS.map((h) => (
            <div key={h} style={{ height: 48, fontSize: 10.5, color: 'var(--ink-faint)', textAlign: 'right', paddingRight: 6, transform: 'translateY(-6px)' }}>
              {hourLabel(h)}
            </div>
          ))}
        </div>

        {days.map((d) => (
          <div key={d} style={{ position: 'relative', borderLeft: '1px solid var(--line)' }}>
            {HOURS.map((h) => (
              <div key={h}
                onClick={() => onSlot(d, h)}
                style={{ height: 48, borderBottom: '1px solid var(--line)', cursor: 'pointer' }} />
            ))}
            {(eventsByDay[d] || []).map((ev) => (
              <EventChip key={`${ev.kind}-${ev.id}`} ev={ev} onClick={onEvent} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- the month grid ----
function MonthGrid({ days, anchor, eventsByDay, today, onDayClick, onEvent }) {
  const month = anchor.slice(0, 7);
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, background: 'var(--line)', border: '1px solid var(--line)' }}>
      {DOW.map((d) => (
        <div key={d} style={{ background: 'var(--surface)', textAlign: 'center', padding: '6px 0', fontSize: 11, fontWeight: 700, color: 'var(--ink-soft)' }}>{d}</div>
      ))}
      {days.map((d) => {
        const inMonth = d.slice(0, 7) === month;
        const evs = eventsByDay[d] || [];
        return (
          <div key={d} onClick={() => onDayClick(d)}
            style={{
              background: 'var(--surface)', minHeight: 88, padding: 5, cursor: 'pointer',
              opacity: inMonth ? 1 : 0.45,
            }}>
            <div style={{
              fontSize: 12, fontWeight: 700, marginBottom: 3,
              color: d === today ? 'var(--brand)' : 'var(--ink)',
            }}>{Number(d.slice(8))}</div>
            {evs.slice(0, 3).map((ev) => {
              const c = eventColor(ev.kind);
              return (
                <button key={`${ev.kind}-${ev.id}`}
                  onClick={(e) => { e.stopPropagation(); onEvent(ev); }}
                  title={ev.title}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left', marginBottom: 2,
                    fontSize: 10.5, padding: '1px 4px', borderRadius: 4, border: 'none',
                    background: c.bg, color: c.fg,
                    whiteSpace: 'nowrap', textOverflow: 'ellipsis', overflow: 'hidden', cursor: 'pointer',
                  }}>{ev.title}</button>
              );
            })}
            {evs.length > 3 && <div style={{ fontSize: 10, color: 'var(--ink-faint)' }}>+{evs.length - 3} more</div>}
          </div>
        );
      })}
    </div>
  );
}

// ---- quick-add chooser (empty-slot click) ----
function QuickAddDialog({ slot, onClose, onPickBlock, onSaved }) {
  const { showToast } = useApp();
  const [mode, setMode] = useState(null); // null | 'task'
  const [title, setTitle] = useState('');
  const startIso = istToUtcIso(slot.date, slot.hour);
  const endIso = istToUtcIso(slot.date, slot.hour + 1);

  const addTask = async () => {
    if (!title.trim()) return;
    try {
      const created = await api.post('/api/tasks', { title: title.trim(), due_date: slot.date });
      await api.patch(`/api/tasks/${created.id}`, {
        scheduled_start_at: startIso, scheduled_end_at: endIso,
      });
      showToast('Task scheduled ✓');
      onSaved();
    } catch (err) { showToast(err.message, 'error'); }
  };

  return (
    <Modal title={`Add at ${fmtDate(slot.date)}, ${hourLabel(slot.hour)}`} onClose={onClose}>
      {!mode && (
        <div className="row-list">
          <button className="lead-row" style={{ width: '100%', textAlign: 'left' }} onClick={() => setMode('task')}>
            <div className="info"><div className="name">📋 Task</div><div className="meta">A scheduled to-do (blue)</div></div>
          </button>
          <button className="lead-row" style={{ width: '100%', textAlign: 'left' }}
            onClick={() => onPickBlock({ start_at: startIso, end_at: endIso, block_date: slot.date })}>
            <div className="info"><div className="name">🟧 Time block</div><div className="meta">Reserve focus time (amber)</div></div>
          </button>
        </div>
      )}
      {mode === 'task' && (
        <>
          <div className="field">
            <label>Task title</label>
            <input value={title} autoFocus onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && addTask()} placeholder="What needs doing?" />
          </div>
          <div className="modal-actions">
            <button className="btn secondary" onClick={onClose}>Cancel</button>
            <button className="btn" disabled={!title.trim()} onClick={addTask}>Schedule task</button>
          </div>
        </>
      )}
    </Modal>
  );
}
