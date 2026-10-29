'use strict';

/**
 * AUD-D1 — the audit delta card: net in thans, three views on one chip.
 * The owner's four Kano lines (illustrative sizes), a sealed-only Lagos line,
 * an ambiguous opened bale (a range, never a guess), a legacy row without
 * sizes, the chip cycle, the sizes round trip through the note cell, the
 * tap (admin gate, in-place redraw, rebuild from StockTakes after a restart).
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const views = require(path.join(SRC, 'services/auditDeltaViews'));
const stockTakesRepository = require(path.join(SRC, 'repositories/stockTakesRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));

const KANO = {
  warehouse: 'Kano office', auditorId: '888', auditorLabel: 'Muhammad', day: '2026-10-28',
  matched: 1, unknown: 0, locked: 0,
  deltas: [
    { design: '9006', status: 'recount', bookB: 3, bookT: 4, cntB: 0, cntT: 19, sizes: [6, 5, 5] },
    { design: '9032', status: 'recount', bookB: 0, bookT: 1, cntB: 0, cntT: 0, sizes: [] },
    { design: '9043-A', status: 'recount', bookB: 1, bookT: 32, cntB: 0, cntT: 38, sizes: [5] },
    { design: '9043-B', status: 'flagged', bookB: 8, bookT: 29, cntB: 7, cntT: 30, sizes: [5, 5, 5, 5, 5, 5, 5, 5] },
  ],
};
const LAGOS = { design: '44200', status: 'recount', bookB: 12, bookT: 0, cntB: 11, cntT: 0, sizes: Array(12).fill(5) };

test('analyse: the owner\'s four lines — net in thans from the book\'s own bale sizes', () => {
  const a = views.analyse(KANO.deltas[0]);
  assert.deepEqual([a.opened, a.openedSizes.min, a.openedSizes.max], [3, 16, 16]);
  assert.deepEqual(a.bookTotal, { min: 20, max: 20 });
  assert.deepEqual(a.cntTotal, { min: 19, max: 19 });
  assert.deepEqual(a.net, { min: -1, max: -1 });
  assert.deepEqual(views.analyse(KANO.deltas[1]).net, { min: -1, max: -1 });
  assert.deepEqual(views.analyse(KANO.deltas[2]).net, { min: 1, max: 1 });
  const b = views.analyse(KANO.deltas[3]);
  assert.deepEqual([b.opened, b.net.min], [1, -4]);
  const l = views.analyse(LAGOS);
  assert.ok(l.sealedOnly);
  assert.deepEqual([l.balesNet, l.net.min], [-1, -5]);
});

test('ambiguous opened bale → a range, never a guess; a legacy row without sizes keeps the raw deltas', () => {
  const a = views.analyse({ bookB: 2, bookT: 0, cntB: 1, cntT: 5, sizes: [6, 5] });
  assert.deepEqual(a.net, { min: -1, max: 0 });
  const t = views.buildCard('t', { ...KANO, deltas: [{ design: 'X', status: 'recount', bookB: 2, bookT: 0, cntB: 1, cntT: 5, sizes: [6, 5] }] });
  assert.match(t, /X · 📉 0–1t short\n {3}book 11t → counted 10–11t\n {3}1 bale opened \(of 6, 5 on the book\) · 5t found · recount asked/);
  const legacy = views.buildCard('t', { ...KANO, deltas: [{ design: 'Y', status: 'recount', bookB: 8, bookT: 29, cntB: 7, cntT: 30, sizes: null }] });
  assert.match(legacy, /Y · ↓1B, ↑1t · bale sizes not on record\n {3}book 8B \+ 29t → counted 7B \+ 30t\n {3}1 bale opened · 1t found · recount asked/);
  assert.match(legacy, /Store: 1 without bale sizes/);
});

test('thans view — the locked layout', () => {
  const t = views.buildCard('t', KANO);
  assert.match(t, /^📊 Audit delta — Kano office · counted by Muhammad · 28-Oct-2026\nCounted vs book · in thans \(a sealed bale = its than count on the book\)\n/);
  assert.match(t, /9006 · 📉 1t short\n {3}book 20t → counted 19t\n {3}3 bales opened \(6\+5\+5 = 16t\) · 15t found · recount asked/);
  assert.match(t, /9032 · 📉 1t short\n {3}book 1t → counted 0t · recount asked/);
  assert.match(t, /9043-A · 📈 1t over\n {3}book 37t → counted 38t\n {3}1 bale opened \(5t\) · 6t found · recount asked/);
  assert.match(t, /9043-B · 📉 4t short\n {3}book 69t → counted 65t\n {3}1 bale opened \(5t\) · 1t found 🚩 flagged/);
  assert.match(t, /Store: 📉 6t short · 📈 1t over · net 📉 5t/);
  assert.match(t, /✅ 1 matched the book exactly$/);
  assert.ok(!/bundle|bd\b|\d\.\dB/.test(t), 'no bundles, no fractions of a bale');
  const lagos = views.buildCard('t', { ...KANO, deltas: [LAGOS] });
  assert.match(lagos, /44200 · 📉 5t short\n {3}book 60t → counted 55t\n {3}1 bale missing \(5t\) · recount asked/);
});

test('bales view — each design in the form its record has; both view adds the than totals', () => {
  const b = views.buildCard('b', { ...KANO, deltas: [...KANO.deltas, LAGOS] });
  assert.match(b, /Counted vs book · sealed bales \+ loose thans, as counted/);
  assert.match(b, /9006 · 📉 1t short\n {3}book 3B \+ 4t → counted 0B \+ 19t\n {3}3 bales opened \(6\+5\+5 = 16t\) · 15t found · recount asked/);
  assert.match(b, /9032 · 📉 1t short\n {3}book 1t → counted 0t · recount asked/);
  assert.match(b, /9043-B · 📉 4t short\n {3}book 8B \+ 29t → counted 7B \+ 30t\n {3}1 bale opened \(5t\) · 1t found 🚩 flagged/);
  assert.match(b, /44200 · 📉 1B short\n {3}book 12B → counted 11B · recount asked/);
  assert.match(b, /Store: 📉 6t short · 📈 1t over · net 📉 5t · 📉 1B short/);
  const x = views.buildCard('x', { ...KANO, deltas: [KANO.deltas[0], LAGOS] });
  assert.match(x, /9006 · 📉 1t short\n {3}book 3B \+ 4t \(20t\) → counted 0B \+ 19t \(19t\)/);
  assert.match(x, /44200 · 📉 1B short \(5t\)\n {3}book 12B \(60t\) → counted 11B \(55t\) · recount asked/);
  assert.match(views.buildCard('t', { ...KANO, deltas: [] }), /No increases, no decreases\./);
});

test('the chip cycles thans → bales → both → thans and names the view it switches to; the key round-trips', () => {
  const key = views.keyFor(KANO);
  assert.equal(key, '20261028:888:Kano office');
  assert.deepEqual(views.parseKey(key), { day: '2026-10-28', auditorId: '888', warehouse: 'Kano office' });
  assert.deepEqual(views.keyboard('t', key), { inline_keyboard: [[{ text: '🔁 Show in bales', callback_data: `wai:dv:b:${key}` }]] });
  assert.equal(views.keyboard('b', key).inline_keyboard[0][0].text, '🔁 Show both');
  assert.equal(views.keyboard('x', key).inline_keyboard[0][0].callback_data, `wai:dv:t:${key}`);
  assert.ok(`wai:dv:b:${views.keyFor({ day: '2026-10-28', auditorId: '7863545956', warehouse: 'A very long warehouse name indeed' })}`.length <= 64);
});

test('sizes ride the note cell and come back', () => {
  assert.equal(views.noteWithSizes('attempt 1', [6, 5, 5]), 'attempt 1 · sizes 6+5+5');
  assert.equal(views.noteWithSizes('attempt 2', []), 'attempt 2');
  assert.deepEqual(views.sizesFromNote('attempt 1 · sizes 6+5+5'), [6, 5, 5]);
  assert.equal(views.sizesFromNote('attempt 1'), null);
});

test('the tap: admins only; redraws in place with the next view; rebuilt from StockTakes after a restart', async () => {
  views._resetForTests();
  const key = views.remember(KANO);
  const calls = [];
  const bot = {
    async editMessageText(text, opts) { calls.push({ text, opts }); return {}; },
    async answerCallbackQuery(id, opts) { calls.push({ toast: (opts && opts.text) || '' }); return true; },
  };
  const q = (data, from = '777') => ({ id: 'q', data, from: { id: from }, message: { chat: { id: from }, message_id: 9 } });
  await views.handleViewTap(bot, q(`wai:dv:b:${key}`, '999'));
  assert.ok(calls.some((c) => /Admins only/.test(c.toast || '')));
  assert.ok(!calls.some((c) => c.text), 'nothing redrawn for a non-admin');
  await views.handleViewTap(bot, q(`wai:dv:b:${key}`));
  const e = calls.find((c) => c.text);
  assert.match(e.text, /sealed bales \+ loose thans, as counted/);
  assert.equal(e.opts.message_id, 9);
  assert.equal(e.opts.reply_markup.inline_keyboard[0][0].text, '🔁 Show both');

  // Restart: memory gone — the card is rebuilt from the audit's rows.
  views._resetForTests();
  stockTakesRepository.rowsForDay = async (wh, day) => (wh === 'Kano office' && day === '2026-10-28' ? [
    { design: '9006', result: 'mismatch', auditor: '888', audited_at: '2026-10-28T13:00:00.000Z', sheet_bales: 3, sheet_bundles: 4, counted_bales: 0, counted_bundles: 19, note: 'attempt 1 · sizes 6+5+5', warehouse: 'Kano office' },
    { design: '9006', result: 'flagged', auditor: '888', audited_at: '2026-10-28T13:20:00.000Z', sheet_bales: 3, sheet_bundles: 4, counted_bales: 0, counted_bundles: 19, note: 'attempt 2 · sizes 6+5+5', warehouse: 'Kano office' },
    { design: '9037', result: 'reconciled', auditor: '888', audited_at: '2026-10-28T13:00:00.000Z', sheet_bales: 1, sheet_bundles: 0, counted_bales: 1, counted_bundles: 0, note: 'blind match', warehouse: 'Kano office' },
    { design: '9099', result: 'mismatch', auditor: '555', audited_at: '2026-10-28T13:00:00.000Z', sheet_bales: 1, sheet_bundles: 0, counted_bales: 0, counted_bundles: 0, note: 'attempt 1 · sizes 5', warehouse: 'Kano office' },
  ] : []);
  approvalCards.resolveUserLabel = async () => 'Muhammad';
  calls.length = 0;
  await views.handleViewTap(bot, q(`wai:dv:t:${key}`));
  const r = calls.find((c) => c.text);
  assert.match(r.text, /counted by Muhammad/);
  assert.match(r.text, /9006 · 📉 1t short\n {3}book 20t → counted 19t\n {3}3 bales opened \(6\+5\+5 = 16t\) · 15t found 🚩 flagged/, 'latest row per design wins');
  assert.ok(!/9099/.test(r.text), 'another auditor\'s rows stay out');
  assert.match(r.text, /✅ 1 matched the book exactly/);
  calls.length = 0;
  await views.handleViewTap(bot, q('wai:dv:t:20260101:888:Nowhere'));
  assert.ok(calls.some((c) => /no longer on record/.test(c.toast || '')));
});
