'use strict';

/**
 * SBL-2 — compact supply card + sale doc + in-place OCR reconciliation
 * (owner-approved layout, 02-Aug-2026).
 *
 *   customer → date → 🧾 supply card (design → "Shade X ×N (bales)") →
 *   🔎 full detail behind a chip. 📄 delivers the day's sale doc(s) as
 *   ephemeral views; 🧮 OCRs them and re-renders the SAME card with 🟢 in
 *   front of digit-exact matches — unmatched bales listed as the
 *   narrowing shortlist, doc-only numbers listed separately, and NOTHING
 *   written anywhere (read-only, per BUSINESS_RULES §2/§3).
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');

const SRC = path.join(__dirname, '..', '..', 'src');
const flow = require(path.join(SRC, 'flows/soldBalesFlow'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const designAssetsRepository = require(path.join(SRC, 'repositories/designAssetsRepository'));
const telegramFiles = require(path.join(SRC, 'utils/telegramFiles'));
const vision = require(path.join(SRC, 'services/vision'));
const ephemeralDocs = require(path.join(SRC, 'services/ephemeralDocs'));

designAssetsRepository.findActive = async () => null;

function soldRow(pkg, design, shade, thanNo, opts = {}) {
  return {
    packageNo: String(pkg), design, shade: String(shade), thanNo,
    yards: opts.yards ?? 30, pricePerYard: opts.price ?? 0,
    status: 'sold', soldTo: opts.customer ?? 'OKESON',
    soldDate: opts.date ?? '2026-07-22', warehouse: opts.wh ?? 'Kano office',
    baleUid: `U-${pkg}`,
  };
}

/** 3 bales sold to OKESON on 22 Jul: 1057+1062 (77008/5,3), 846 (77014/3). */
function seed({ docs = [{ fileId: 'DOC1', action: 'sale_bundle' }] } = {}) {
  const rows = [
    soldRow('1057', '77008', '5', 1), soldRow('1057', '77008', '5', 2),
    soldRow('1062', '77008', '3', 1),
    soldRow('846', '77014', '3', 1),
    // Noise: another customer + another day must never leak in.
    soldRow('999', '9060-A', '', 1, { customer: 'OTHER' }),
    soldRow('555', '77008', '5', 1, { date: '2026-07-20' }),
  ];
  inventoryRepository.getSoldRows = async () => JSON.parse(JSON.stringify(rows));
  approvalQueueRepository.getResolved = async () => docs.map((d, i) => ({
    requestId: `RQ-${i}`, status: 'approved',
    actionJSON: {
      action: d.action, customer: 'OKESON', salesDate: '2026-07-22',
      sale_doc_file_id: d.fileId,
    },
  }));
}

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}
function lastKbTexts(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup);
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}
const q = (data, userId) => ({
  id: 'q1', data, from: { id: userId },
  message: { chat: { id: userId }, message_id: 55 },
});

/** Drive customer → date → supply card; returns the bot. */
async function openSupplyCard(userId = '777') {
  sessionStore.clear(userId);
  ephemeralDocs._internals._resetForTests();
  const bot = createFakeBot();
  await flow.start(bot, userId, userId, null);
  await flow.handleCallback(bot, q('sbl:c:0', userId)); // OKESON (most recent)
  await flow.handleCallback(bot, q('sbl:d:0', userId)); // 22 Jul
  return bot;
}

test('date pick lands on the compact supply card in transfer-card grammar', async () => {
  seed();
  const bot = await openSupplyCard();
  const text = lastText(bot);
  assert.match(text, /OKESON/);
  assert.match(text, /3 bale\(s\) supplied/);
  assert.match(text, /🧵 \*77008\*/);
  assert.match(text, / • Shade 5 ×1 \(1057\)/);
  assert.match(text, / • Shade 3 ×1 \(1062\)/);
  assert.match(text, /🧵 \*77014\*/);
  assert.ok(!/yd|₦|#1/.test(text), 'no thans/yards/money on the compact card');
  assert.ok(!/999|555/.test(text), 'other customers/days never leak in');
  const kb = lastKbTexts(bot);
  assert.ok(kb.some((b) => b === '📄 Sale doc|sbl:doc'), 'doc chip present');
  assert.ok(kb.some((b) => b === '🧮 Reconcile sale doc|sbl:rec'), 'reconcile chip present');
  assert.ok(kb.some((b) => b.includes('sbl:full')), 'full-details chip present');
});

test('no sale doc on file → 📄 and 🧮 chips are absent', async () => {
  seed({ docs: [] });
  const bot = await openSupplyCard();
  const kb = lastKbTexts(bot);
  assert.ok(!kb.some((b) => b.includes('sbl:doc')), 'no doc chip');
  assert.ok(!kb.some((b) => b.includes('sbl:rec')), 'no reconcile chip');
  assert.ok(kb.some((b) => b.includes('sbl:full')), 'full details still offered');
});

test('🧮 reconcile marks 🟢 dots IN PLACE and lists the shortfall', async () => {
  seed();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), mimeType: 'application/pdf' });
  const origExtract = vision.extractBales;
  vision.extractBales = async () => ({
    ok: true,
    bales: [{ packageNo: '1057' }, { packageNo: '1062' }, { packageNo: '899' }],
  });
  try {
    const bot = await openSupplyCard();
    const edits = bot.callsTo('editMessageText').length + bot.callsTo('sendMessage').length;
    await flow.handleCallback(bot, q('sbl:rec', '777'));
    const text = lastText(bot);
    assert.match(text, /📑 Doc check: \*2\/3\* matched/);
    assert.match(text, / • Shade 5 ×1 \(🟢1057\)/);
    assert.match(text, / • Shade 3 ×1 \(🟢1062\)/);
    assert.match(text, / • Shade 3 ×1 \(846\)/, '846 stays undotted');
    assert.match(text, /⚠️ Not in doc: 846/);
    assert.match(text, /Doc-only numbers: 899/);
    // In place: card edits only — the reconcile added no NEW chat card.
    assert.equal(bot.callsTo('sendMessage').length + bot.callsTo('editMessageText').length,
      edits + 2, 'exactly the ⏳ frame + the result frame, same anchor');
    const kb = lastKbTexts(bot);
    assert.ok(kb.some((b) => b === '🔁 Re-check sale doc|sbl:rec'), 'chip flips to re-check');
  } finally { vision.extractBales = origExtract; }
});

test('unreadable doc → error line on the card, no dots, chip stays 🧮', async () => {
  seed();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('x'), mimeType: 'application/pdf' });
  const origExtract = vision.extractBales;
  vision.extractBales = async () => ({ ok: false, bales: [], error: 'ocr_daily_cap' });
  try {
    const bot = await openSupplyCard();
    await flow.handleCallback(bot, q('sbl:rec', '777'));
    const text = lastText(bot);
    assert.match(text, /⚠️ _Doc check failed: ocr_daily_cap_/);
    assert.ok(!text.includes('🟢'), 'no dots on failure');
    assert.ok(lastKbTexts(bot).some((b) => b === '🧮 Reconcile sale doc|sbl:rec'));
  } finally { vision.extractBales = origExtract; }
});

test('🔎 full details opens the deep view; back returns to the card, dots intact', async () => {
  seed();
  telegramFiles.downloadTelegramFile = async () => ({ buffer: Buffer.from('pdf'), mimeType: 'application/pdf' });
  const origExtract = vision.extractBales;
  vision.extractBales = async () => ({ ok: true, bales: [{ packageNo: '1057' }] });
  try {
    const bot = await openSupplyCard();
    await flow.handleCallback(bot, q('sbl:rec', '777'));
    await flow.handleCallback(bot, q('sbl:full', '777'));
    const detail = lastText(bot);
    assert.match(detail, /Bale 1057/);
    assert.match(detail, /than/i, 'deep view carries than detail');
    await flow.handleCallback(bot, q('sbl:back', '777'));
    const back = lastText(bot);
    assert.match(back, /\(🟢1057\)/, 'dots survive the round trip');
  } finally { vision.extractBales = origExtract; }
});

test('📄 delivers the doc as an ephemeral view, swept on the next tap', async () => {
  seed();
  const bot = await openSupplyCard();
  await flow.handleCallback(bot, q('sbl:doc', '777'));
  assert.equal(bot.callsTo('sendDocument').length, 1, 'sale_bundle doc sent as document');
  // Any next sbl tap sweeps the delivered copy (TRF-9b behaviour).
  await flow.handleCallback(bot, q('sbl:noop', '777'));
  assert.ok(bot.callsTo('deleteMessage').length >= 1, 'doc view swept');
});
