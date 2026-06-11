// ALL IST day-boundary math lives here. IST = UTC+05:30, no DST.
// Instants are stored as UTC ISO strings; business dates as IST 'YYYY-MM-DD'.
// Server clock timezone must never matter — never use date('now') in SQL
// for business logic; pass UTC bounds computed here as range parameters.

export const IST_OFFSET_MS = 330 * 60 * 1000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertDateStr(d) {
  if (!DATE_RE.test(d)) throw new Error(`Expected YYYY-MM-DD, got: ${d}`);
}

// IST calendar date of an instant (Date or UTC ISO string).
export function istDateOf(instant) {
  const t = instant instanceof Date ? instant.getTime() : Date.parse(instant);
  if (Number.isNaN(t)) throw new Error(`Invalid instant: ${instant}`);
  return new Date(t + IST_OFFSET_MS).toISOString().slice(0, 10);
}

export function todayIst(now = new Date()) {
  return istDateOf(now);
}

// UTC half-open interval [startUtc, endUtc) covering the IST calendar day.
export function istDayBounds(dateStr) {
  assertDateStr(dateStr);
  const startMs = Date.parse(`${dateStr}T00:00:00.000Z`) - IST_OFFSET_MS;
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(startMs + 24 * 60 * 60 * 1000).toISOString(),
  };
}

export function addDays(dateStr, n) {
  assertDateStr(dateStr);
  const d = new Date(Date.parse(`${dateStr}T00:00:00.000Z`) + n * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

// IST week containing dateStr, Monday-start: returns [monday, sunday] date strings.
export function istWeekRange(dateStr) {
  assertDateStr(dateStr);
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  const monday = addDays(dateStr, -dow);
  return [monday, addDays(monday, 6)];
}

export function istMonthRange(dateStr) {
  assertDateStr(dateStr);
  const first = `${dateStr.slice(0, 7)}-01`;
  const [y, m] = [Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7))];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return [first, `${dateStr.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`];
}

// UTC bounds spanning an inclusive IST date range.
export function istRangeBounds(fromDate, toDate) {
  const { startUtc } = istDayBounds(fromDate);
  const { endUtc } = istDayBounds(toDate);
  return { startUtc, endUtc };
}

// SQL expression converting a UTC *_at column to its IST date, for GROUP BY
// (never for WHERE — pass precomputed bounds there so indexes are used).
export const SQL_IST_DATE = (col) => `date(${col}, '+330 minutes')`;

export function nowUtc() {
  return new Date().toISOString();
}
