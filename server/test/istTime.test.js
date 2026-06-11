import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  istDateOf, istDayBounds, addDays, istWeekRange, istMonthRange, istRangeBounds,
} from '../lib/istTime.js';

test('istDateOf: 23:50 IST and 00:10 IST land on different days', () => {
  // 2026-06-11 23:50 IST = 2026-06-11 18:20 UTC
  assert.equal(istDateOf('2026-06-11T18:20:00.000Z'), '2026-06-11');
  // 2026-06-12 00:10 IST = 2026-06-11 18:40 UTC
  assert.equal(istDateOf('2026-06-11T18:40:00.000Z'), '2026-06-12');
});

test('istDayBounds covers exactly the IST day in UTC', () => {
  const { startUtc, endUtc } = istDayBounds('2026-06-11');
  assert.equal(startUtc, '2026-06-10T18:30:00.000Z');
  assert.equal(endUtc, '2026-06-11T18:30:00.000Z');
});

test('boundary instants classify correctly against bounds', () => {
  const { startUtc, endUtc } = istDayBounds('2026-06-11');
  const justBefore = '2026-06-10T18:29:59.999Z';
  const atStart = '2026-06-10T18:30:00.000Z';
  const justBeforeEnd = '2026-06-11T18:29:59.999Z';
  const atEnd = '2026-06-11T18:30:00.000Z';
  assert.ok(justBefore < startUtc);
  assert.ok(atStart >= startUtc && atStart < endUtc);
  assert.ok(justBeforeEnd >= startUtc && justBeforeEnd < endUtc);
  assert.ok(atEnd >= endUtc);
});

test('addDays crosses month and year boundaries', () => {
  assert.equal(addDays('2026-01-31', 1), '2026-02-01');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  assert.equal(addDays('2024-03-01', -1), '2024-02-29'); // leap year
});

test('istWeekRange is Monday-start', () => {
  // 2026-06-11 is a Thursday
  assert.deepEqual(istWeekRange('2026-06-11'), ['2026-06-08', '2026-06-14']);
  // A Monday maps to itself
  assert.deepEqual(istWeekRange('2026-06-08'), ['2026-06-08', '2026-06-14']);
  // A Sunday belongs to the week starting the previous Monday
  assert.deepEqual(istWeekRange('2026-06-14'), ['2026-06-08', '2026-06-14']);
});

test('istMonthRange handles month lengths and leap February', () => {
  assert.deepEqual(istMonthRange('2026-06-11'), ['2026-06-01', '2026-06-30']);
  assert.deepEqual(istMonthRange('2026-02-10'), ['2026-02-01', '2026-02-28']);
  assert.deepEqual(istMonthRange('2024-02-10'), ['2024-02-01', '2024-02-29']);
});

test('istRangeBounds spans inclusive date range', () => {
  const { startUtc, endUtc } = istRangeBounds('2026-06-01', '2026-06-30');
  assert.equal(startUtc, '2026-05-31T18:30:00.000Z');
  assert.equal(endUtc, '2026-06-30T18:30:00.000Z');
});

test('rejects malformed date strings', () => {
  assert.throws(() => istDayBounds('11-06-2026'));
  assert.throws(() => istDayBounds('2026/06/11'));
});
