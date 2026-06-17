// Daily coaching report card — aggregates a single agent's call performance for
// one IST day, plus a 7-day rating trend, a current analysis streak, and the
// agent's hot leads. DB-only and PURE in the sense that it never touches the
// network/clock beyond the `dateIst` you pass — so it is fully unit-testable on
// seeded recordings/calls rows.
//
// Signal source: each call's AI analysis lives on its linked recording's
// ai_json (an LLM blob with {rating:{clarity,engagement,conversion,overall},
// intent, sentiment, strengths[], improvements[]}). We attribute a call to the
// AGENT who made it (calls.user_id), join recordings→calls, and aggregate over
// the recordings that have been analyzed (ai_json present).

import { istDayBounds, istRangeBounds, addDays } from './istTime.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function num1to10(v) {
  const n = Number(v);
  return Number.isFinite(n) ? clamp(n, 0, 10) : null;
}

// Letter grade from an average /10 overall rating.
export function gradeFor(avg) {
  if (avg == null) return 'N/A';
  if (avg >= 9) return 'A+';
  if (avg >= 8) return 'A';
  if (avg >= 7) return 'B';
  if (avg >= 6) return 'C';
  if (avg >= 5) return 'D';
  return 'F';
}

// Pull this agent's analyzed calls (recording ai_json) within a UTC window.
// Returns parsed analyses with the call's disposition for engagement/positive%.
function analyzedCalls(db, userId, startUtc, endUtc) {
  const rows = db.prepare(
    `SELECT c.disposition, c.called_at, r.ai_json
       FROM recordings r
       JOIN calls c ON c.id = r.call_id
      WHERE c.user_id = ? AND r.ai_json IS NOT NULL
        AND c.source != 'whatsapp'
        AND c.called_at >= ? AND c.called_at < ?`
  ).all(userId, startUtc, endUtc);
  return rows.map((row) => ({ disposition: row.disposition, ai: safeJson(row.ai_json) }))
    .filter((r) => r.ai && typeof r.ai === 'object');
}

// Average of a rating axis across analyses, rounded to 1 dp. null when none.
function avgAxis(analyses, axis) {
  const vals = [];
  for (const { ai } of analyses) {
    const v = num1to10(ai.rating && ai.rating[axis]);
    if (v != null) vals.push(v);
  }
  if (!vals.length) return null;
  return Math.round((vals.reduce((s, v) => s + v, 0) / vals.length) * 10) / 10;
}

// Tally short coaching strings (strengths / improvements) into a ranked list.
function tally(analyses, key) {
  const counts = new Map();
  for (const { ai } of analyses) {
    const list = Array.isArray(ai[key]) ? ai[key] : [];
    for (const item of list) {
      const s = typeof item === 'string' ? item.trim() : '';
      if (s) counts.set(s, (counts.get(s) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([text, count]) => ({ text, count }));
}

// 7-day overall-rating trend ending on dateIst (oldest → newest). Each entry is
// { date, avg, calls } so the client can draw a sparkline.
function ratingTrend(db, userId, dateIst) {
  const trend = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = addDays(dateIst, -i);
    const { startUtc, endUtc } = istDayBounds(d);
    const analyses = analyzedCalls(db, userId, startUtc, endUtc);
    trend.push({ date: d, avg: avgAxis(analyses, 'overall'), calls: analyses.length });
  }
  return trend;
}

// Consecutive IST days (ending at dateIst) with >=1 analyzed call. Walks back
// until a gap; capped at 365 so a misconfigured date can't loop unbounded.
function currentStreak(db, userId, dateIst) {
  let streak = 0;
  for (let i = 0; i < 365; i += 1) {
    const d = addDays(dateIst, -i);
    const { startUtc, endUtc } = istDayBounds(d);
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM recordings r JOIN calls c ON c.id = r.call_id
        WHERE c.user_id = ? AND r.ai_json IS NOT NULL AND c.source != 'whatsapp'
          AND c.called_at >= ? AND c.called_at < ?`
    ).get(userId, startUtc, endUtc).n;
    if (n > 0) streak += 1;
    else break;
  }
  return streak;
}

// Main entry point. Returns the full report-card payload for one agent + day.
export function getDailyCoaching(db, userId, dateIst) {
  const { startUtc, endUtc } = istDayBounds(dateIst);
  const analyses = analyzedCalls(db, userId, startUtc, endUtc);

  // callsToday = ALL phone calls the agent logged that day (not just analyzed
  // ones). WhatsApp mirror rows (source='whatsapp') are messaging activity, not
  // dials, so they're excluded to match dashboard/reports calling stats.
  const callsToday = db.prepare(
    "SELECT COUNT(*) AS n FROM calls WHERE user_id = ? AND source != 'whatsapp' AND called_at >= ? AND called_at < ?"
  ).get(userId, startUtc, endUtc).n;

  const connected = db.prepare(
    "SELECT COUNT(*) AS n FROM calls WHERE user_id = ? AND disposition = 'connected' AND source != 'whatsapp' AND called_at >= ? AND called_at < ?"
  ).get(userId, startUtc, endUtc).n;

  const avgRating = avgAxis(analyses, 'overall');
  const engagement = avgAxis(analyses, 'engagement');
  const conversion = avgAxis(analyses, 'conversion');
  const clarity = avgAxis(analyses, 'clarity');

  // positive% over analyzed calls with a sentiment.
  const withSentiment = analyses.filter(({ ai }) => typeof ai.sentiment === 'string');
  const positives = withSentiment.filter(({ ai }) => ai.sentiment === 'positive').length;
  const positivePct = withSentiment.length
    ? Math.round((positives / withSentiment.length) * 100)
    : null;

  // This agent's hot leads: their assigned leads flagged Hot or scoring >= 80.
  const hotLeads = db.prepare(
    `SELECT id, name, phone, ai_intent, ai_score, score
       FROM leads
      WHERE assigned_to = ? AND deleted_at IS NULL
        AND (ai_intent = 'Hot' OR ai_score >= 80 OR score >= 80)
      ORDER BY COALESCE(ai_score, score, 0) DESC
      LIMIT 10`
  ).all(userId);

  return {
    user_id: userId,
    date: dateIst,
    callsToday,
    connected,
    analyzedCalls: analyses.length,
    avgRating,
    engagement,
    conversion,
    clarity,
    conversionRate: callsToday ? Math.round((connected / callsToday) * 100) : null,
    positivePct,
    ratingTrend: ratingTrend(db, userId, dateIst),
    currentStreak: currentStreak(db, userId, dateIst),
    hotLeads,
    topStrengths: tally(analyses, 'strengths'),
    topFocusAreas: tally(analyses, 'improvements'),
    grade: gradeFor(avgRating),
  };
}
