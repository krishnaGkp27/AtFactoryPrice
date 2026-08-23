'use strict';

/**
 * PTK-1 — Snap Task internals: the read-back card's confidence posture
 * (low confidence hides ✅ and forces an edit) and the caption builder's
 * truncation under Telegram's 1024-char caption cap.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _internals } = require('../../../src/flows/snapTaskFlow');
const { buildReadbackCaption, readbackRows } = _internals;

const sess = (over = {}) => ({
  note: {
    title: 'Buy this pen',
    details: 'Buy this pen for me from anywhere. Let me know the price and submit approval.',
    dueDateISO: null, confidence: 0.92, lowConfidence: false,
    ...over,
  },
});

test('confident read: ✅ leads, verbatim details and the question render', () => {
  const rows = readbackRows(sess());
  assert.equal(rows[0][0].text, '✅ Use as written');
  const cap = buildReadbackCaption(sess());
  assert.match(cap, /Buy this pen for me from anywhere/);
  assert.match(cap, /Use this as the task\?/);
});

test('low-confidence read: ✅ is HIDDEN and the warning renders instead', () => {
  const s = sess({ lowConfidence: true });
  const rows = readbackRows(s);
  assert.ok(!rows.flat().some((b) => b.callback_data === 'ptk:use'), 'no Use chip on a shaky read');
  assert.match(buildReadbackCaption(s), /Low-confidence read/);
});

test('a note date renders on the card', () => {
  assert.match(buildReadbackCaption(sess({ dueDateISO: '2026-08-29' })), /Mentions: 2026-08-29/);
});

test('long details truncate for display and the caption stays under 1024', () => {
  // 700 > the 600 display cap: the renderer must stay safe even if
  // upstream clamps ever loosen — belt and braces, tested.
  const cap = buildReadbackCaption(sess({ details: 'D'.repeat(700), title: 'T'.repeat(100) }));
  assert.ok(cap.includes('…'), 'display truncation marker present');
  assert.ok(cap.length <= 1024, `caption ${cap.length} must fit Telegram's 1024 cap`);
});

test('every chip payload fits the 64-byte callback limit', () => {
  for (const b of readbackRows(sess()).flat()) {
    assert.ok(Buffer.byteLength(b.callback_data, 'utf8') <= 64, b.callback_data);
  }
});
