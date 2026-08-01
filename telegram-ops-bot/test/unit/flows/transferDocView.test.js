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

const origFind = transferService.findTransfer;
function stubFind(row) { transferService.findTransfer = async () => row; }
test.afterEach(() => { transferService.findTransfer = origFind; });

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
