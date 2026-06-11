import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, telLink, waLink } from '../lib/phone.js';

test('plain 10-digit number', () => {
  assert.deepEqual(normalizePhone('9876543210'), { ok: true, phone: '9876543210' });
});

test('formatted with +91, spaces, dashes', () => {
  assert.deepEqual(normalizePhone('+91 98765-43210'), { ok: true, phone: '9876543210' });
  assert.deepEqual(normalizePhone('91 9876543210'), { ok: true, phone: '9876543210' });
  assert.deepEqual(normalizePhone('(+91) 98765 43210'), { ok: true, phone: '9876543210' });
});

test('leading zero trunk prefix', () => {
  assert.deepEqual(normalizePhone('09876543210'), { ok: true, phone: '9876543210' });
});

test('0 + 91 prefix combined', () => {
  assert.deepEqual(normalizePhone('0919876543210'), { ok: true, phone: '9876543210' });
});

test('Meta Lead Ads p: prefix', () => {
  assert.deepEqual(normalizePhone('p:+919876543210'), { ok: true, phone: '9876543210' });
});

test('numeric input (XLSX raw cell)', () => {
  assert.deepEqual(normalizePhone(9876543210), { ok: true, phone: '9876543210' });
  assert.deepEqual(normalizePhone(919876543210), { ok: true, phone: '9876543210' });
});

test('scientific notation with full precision recovers', () => {
  assert.deepEqual(normalizePhone('9.87654321E+09'), { ok: true, phone: '9876543210' });
});

test('scientific notation with lost precision is rejected', () => {
  const r = normalizePhone('9.87655E+09');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'excel_mangled');
});

test('landline / bad mobile prefix rejected', () => {
  assert.equal(normalizePhone('1234567890').ok, false);
  assert.equal(normalizePhone('5876543210').ok, false);
});

test('wrong lengths rejected', () => {
  assert.equal(normalizePhone('98765').ok, false);
  assert.equal(normalizePhone('98765432101').ok, false); // 11 digits, no leading 0
});

test('empty and junk rejected', () => {
  assert.equal(normalizePhone('').ok, false);
  assert.equal(normalizePhone(null).ok, false);
  assert.equal(normalizePhone(undefined).ok, false);
  assert.equal(normalizePhone('N/A').ok, false);
});

test('tel link format', () => {
  assert.equal(telLink('9876543210'), 'tel:+919876543210');
});

test('wa.me link: 91 without plus, encoded Hindi text with newline', () => {
  const link = waLink('9876543210', 'नमस्ते Rahul!\nPayment due: ₹1,50,000');
  assert.ok(link.startsWith('https://wa.me/919876543210?text='));
  assert.ok(!link.includes('+91'));
  assert.ok(link.includes('%0A'));
  const text = decodeURIComponent(link.split('?text=')[1]);
  assert.equal(text, 'नमस्ते Rahul!\nPayment due: ₹1,50,000');
});
