'use strict';

/**
 * TRF-9 — view the attached dispatch/receipt file from a transfer card.
 * transferService.findTransfer is stubbed; bot is the recording fake.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const transferService = require('../../../src/services/transferService');
const transferFlow = require('../../../src/flows/transferFlow');

const { docRows, receiverCard } = transferFlow._internals;

const REQ = 'TR-20260724-002';

function rowWith(aj) {
  return {
    requestId: REQ, user: '10', status: 'pending',
    actionJSON: {
      action: 'transfer_stock', from: 'Lagos', to: 'Kano office',
      dispatcher: '11', receiver: '12', lines: [], bales: ['6261'],
      stage: 'in_transit', ...aj,
    },
  };
}

function query(data, fromId) {
  return { id: 'q1', data, from: { id: fromId }, message: { chat: { id: 500 }, message_id: 42 } };
}

const ephemeralDocs = require('../../../src/services/ephemeralDocs');

const origFind = transferService.findTransfer;
function stubFind(row) { transferService.findTransfer = async () => row; }
test.afterEach(() => {
  transferService.findTransfer = origFind;
  ephemeralDocs._internals._resetForTests();
});

test('docRows: buttons appear only for attached docs', () => {
  assert.deepEqual(docRows(REQ, {}), [], 'no docs — no buttons');
  const rows = docRows(REQ, {
    dispatchDoc: { fileId: 'F1' },
    receiveDoc: { url: 'https://drive/x' },
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0][0].callback_data, `trf:vd:d:${REQ}`);
  assert.equal(rows[1][0].callback_data, `trf:vd:r:${REQ}`);
});

test('receiverCard carries the dispatch-doc button when the file exists', () => {
  const withDoc = receiverCard(REQ, { from: 'Lagos', to: 'Kano office', lines: [], bales: [], dispatchDoc: { fileId: 'F1' } });
  const flat = withDoc.kb.inline_keyboard.flat();
  assert.ok(flat.some((b) => b.callback_data === `trf:vd:d:${REQ}`), 'doc button present');
  const without = receiverCard(REQ, { from: 'Lagos', to: 'Kano office', lines: [], bales: [] });
  assert.ok(!without.kb.inline_keyboard.flat().some((b) => (b.callback_data || '').startsWith('trf:vd:')), 'no button without doc');
});

test('trf:vd:d sends the PDF by file_id with the short ref caption', async () => {
  stubFind(rowWith({ dispatchDoc: { fileId: 'FILE-PDF', mime: 'application/pdf', url: 'https://drive/d' } }));
  const bot = createFakeBot();
  const handled = await transferFlow.handleCallback(bot, query(`trf:vd:d:${REQ}`, 12)); // receiver
  assert.equal(handled, true);
  const sends = bot.callsTo('sendDocument');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].args.doc, 'FILE-PDF');
  assert.match(sends[0].args.opts.caption, /Dispatch doc — 24Jul·02/);
  assert.equal(bot.callsTo('sendPhoto').length, 0);
});

test('image mime goes through sendPhoto first', async () => {
  stubFind(rowWith({ dispatchDoc: { fileId: 'FILE-IMG', mime: 'image/jpeg' } }));
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:vd:d:${REQ}`, 11)); // dispatcher
  assert.equal(bot.callsTo('sendPhoto').length, 1);
  assert.equal(bot.callsTo('sendDocument').length, 0);
});

test('legacy doc without mime: document send fails -> photo fallback', async () => {
  stubFind(rowWith({ dispatchDoc: { fileId: 'FILE-OLD' } }));
  const bot = createFakeBot();
  bot.sendDocument = async () => { throw new Error('ETELEGRAM: 400 wrong file identifier'); };
  await transferFlow.handleCallback(bot, query(`trf:vd:d:${REQ}`, 10)); // requester
  assert.equal(bot.callsTo('sendPhoto').length, 1, 'fell back to photo');
});

test('stale file_id on both sends falls back to the Drive link', async () => {
  stubFind(rowWith({ receiveDoc: { fileId: 'GONE', url: 'https://drive/r' } }));
  const bot = createFakeBot();
  const boom = async () => { throw new Error('ETELEGRAM: 400 wrong file identifier'); };
  bot.sendDocument = boom; bot.sendPhoto = boom;
  await transferFlow.handleCallback(bot, query(`trf:vd:r:${REQ}`, 777)); // admin
  const msgs = bot.callsTo('sendMessage');
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].args.text, /Receipt doc — 24Jul·02\n🔗 https:\/\/drive\/r/);
});

/* ── TRF-11 — bale-number chip on every card that has bales ───────────── */

test('TRF-11: short bale lists ride the chip label; long lists become a count', () => {
  const { balesChipRow } = transferFlow._internals;
  const short = balesChipRow(REQ, { bales: ['6261', '6275', '6250'] });
  assert.equal(short[0][0].text, '📦 6261 · 6275 · 6250');
  assert.equal(short[0][0].callback_data, `trf:bn:${REQ}`);
  const many = balesChipRow(REQ, { bales: Array.from({ length: 12 }, (_, i) => `77${100 + i}`) });
  assert.equal(many[0][0].text, '📦 12 bales — view all');
  assert.deepEqual(balesChipRow(REQ, {}), [], 'no bales (requested stage) — no chip');
});

test('TRF-11: settled card and receiver card both carry the chip', async () => {
  stubFind({ ...rowWith({ bales: ['6261', '6275'] }), status: 'approved' });
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:card:${REQ}`, 777));
  const kb = bot.callsTo('editMessageText')[0].args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.callback_data === `trf:bn:${REQ}`), 'settled card chip');
  const rc = transferFlow._internals.receiverCard(REQ, { from: 'A', to: 'B', lines: [], bales: ['6261'] });
  assert.ok(rc.kb.inline_keyboard.flat().some((b) => b.callback_data === `trf:bn:${REQ}`), 'receiver card chip');
});

test('TRF-11: tap shows the full list as a popup, nothing lands in chat', async () => {
  stubFind(rowWith({ bales: ['6261', '6275', '6250'] }));
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:bn:${REQ}`, 12));
  const ack = bot.callsTo('answerCallbackQuery').find((c) => c.args.opts && c.args.opts.show_alert);
  assert.ok(ack, 'popup used');
  assert.match(ack.args.opts.text, /3 bale\(s\):\n6261, 6275, 6250/);
  assert.equal(bot.callsTo('sendMessage').length, 0, 'no chat message for short lists');
});

test('TRF-11: oversized lists fall back to an ephemeral tracked message', async () => {
  const bales = Array.from({ length: 40 }, (_, i) => `77${1000 + i}`);
  stubFind(rowWith({ bales }));
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:bn:${REQ}`, 12));
  const msg = bot.callsTo('sendMessage')[0];
  assert.ok(msg, 'sent as a message');
  assert.match(msg.args.text, /40 bale\(s\)/);
  // Tracked as ephemeral: the next transfer tap sweeps it.
  const origOpen = transferService.getOpenTransfers;
  transferService.getOpenTransfers = async () => [];
  try {
    await transferFlow.handleCallback(bot, query('trf:list', 12));
    assert.equal(bot.callsTo('deleteMessage').length, 1, 'swept on navigation');
  } finally {
    transferService.getOpenTransfers = origOpen;
  }
});

test('TRF-11: requested stage (no bales yet) answers with an explanatory popup', async () => {
  stubFind(rowWith({ bales: [], stage: 'requested' }));
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:bn:${REQ}`, 12));
  const ack = bot.callsTo('answerCallbackQuery').find((c) => c.args.opts && c.args.opts.show_alert);
  assert.match(ack.args.opts.text, /No bales logged yet/);
});

/* ── TRF-10 — Back to the list the card replaced ──────────────────────── */

test('TRF-10: card opened from the inbox carries ⬅ Back to the chip list', async () => {
  stubFind({ ...rowWith({ bales: ['B1'] }), status: 'approved' });
  const bot = createFakeBot();
  await transferFlow.showActionCard(bot, query('abx:trf:0', 777), REQ, { backCb: 'abx:cat:transfers' });
  const kb = bot.callsTo('editMessageText')[0].args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(kb.some((b) => b.text === '⬅ Back' && b.callback_data === 'abx:cat:transfers'), 'Back re-renders the inbox list');
  assert.ok(kb.some((b) => b.callback_data === 'trf:list'), 'Transfers shortcut kept');
});

test('TRF-10: card opened elsewhere (My Tasks / DM) has no Back button', async () => {
  stubFind({ ...rowWith({ bales: ['B1'] }), status: 'approved' });
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:card:${REQ}`, 777));
  const kb = bot.callsTo('editMessageText')[0].args.opts.reply_markup.inline_keyboard.flat();
  assert.ok(!kb.some((b) => b.text === '⬅ Back'), 'no Back without a list to return to');
});

/* ── TRF-9b — doc views are ephemeral ─────────────────────────────────── */

test('TRF-9b: fetching the doc again REPLACES the earlier copy', async () => {
  stubFind(rowWith({ dispatchDoc: { fileId: 'FILE-PDF', mime: 'application/pdf' } }));
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:vd:d:${REQ}`, 12));
  const sentIds = () => bot.calls.filter((c) => c.method === 'sendDocument').length;
  assert.equal(sentIds(), 1);
  await transferFlow.handleCallback(bot, query(`trf:vd:d:${REQ}`, 12));
  assert.equal(sentIds(), 2, 'second view sent');
  const deleted = bot.callsTo('deleteMessage').map((c) => c.args.messageId);
  assert.equal(deleted.length, 1, `first view deleted before the second lands, got: ${deleted}`);
});

test('TRF-9b: any other transfer tap sweeps the delivered doc view', async () => {
  stubFind(rowWith({ dispatchDoc: { fileId: 'FILE-PDF', mime: 'application/pdf' } }));
  const origOpen = transferService.getOpenTransfers;
  transferService.getOpenTransfers = async () => [];
  try {
    const bot = createFakeBot();
    await transferFlow.handleCallback(bot, query(`trf:vd:d:${REQ}`, 12));
    assert.equal(bot.callsTo('deleteMessage').length, 0, 'doc view alive while nothing else tapped');
    await transferFlow.handleCallback(bot, query('trf:list', 12));
    assert.equal(bot.callsTo('deleteMessage').length, 1, 'navigation swept the doc view');
  } finally {
    transferService.getOpenTransfers = origOpen;
  }
});

test('outsiders are refused with a toast and get nothing', async () => {
  stubFind(rowWith({ dispatchDoc: { fileId: 'F1' } }));
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:vd:d:${REQ}`, 999));
  const ack = bot.callsTo('answerCallbackQuery')[0];
  assert.match(ack.args.opts.text, /for the people on the transfer/);
  assert.equal(bot.callsTo('sendDocument').length + bot.callsTo('sendPhoto').length + bot.callsTo('sendMessage').length, 0);
});

test('no document attached -> explanatory toast, no send', async () => {
  stubFind(rowWith({}));
  const bot = createFakeBot();
  await transferFlow.handleCallback(bot, query(`trf:vd:d:${REQ}`, 12));
  const ack = bot.callsTo('answerCallbackQuery')[0];
  assert.match(ack.args.opts.text, /No dispatch document/);
  assert.equal(bot.callsTo('sendMessage').length, 0);
});
