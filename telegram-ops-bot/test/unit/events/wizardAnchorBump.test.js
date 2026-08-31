'use strict';

/**
 * ANCH-1 — the confirm-sale wizard card follows the keyboard.
 *
 * Pins: a card that is still the newest message edits in place (zero churn);
 * a card buried under newer bot sends is deleted and re-sent at the bottom;
 * a failed delete strips the old card's keyboard instead; the admin's own
 * typed reply counts as burial even though the send watermark cannot see it.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '555';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');

const approvalEvents = require('../../../src/events/approvalEvents');
const menuAnchor = require('../../../src/services/menuAnchor');
const settingsRepository = require('../../../src/repositories/settingsRepository');
const approvalQueueRepository = require('../../../src/repositories/approvalQueueRepository');

const { pendingEnrichment, wizKey, lastTouchedWizard, renderWizard } = approvalEvents._internals;

settingsRepository.getAll = async () => ({ BANK_LIST: 'ZENITH BANK,GTBank' });
approvalQueueRepository.updateActionJSON = async () => true; // APC-1 draft persistence
approvalQueueRepository.updateStatus = async () => true;

const CHAT = 42;

function freshState(over = {}) {
  const item = {
    requestId: 'REQ1', user: '555',
    actionJSON: { action: 'sale_bundle', customer: 'Chima', yardsByDesign: { 44200: 150 }, items: [] },
  };
  return {
    requestId: 'REQ1', adminId: '777', step: 'rate', item, requestingUser: '555',
    designs: ['44200'], unit: 'yard', lastPaidRate: 1500, startedAt: Date.now(),
    anchorChatId: CHAT, anchorMessageId: 500,
    ...over,
  };
}

function callsOf(bot, method) { return bot.calls.filter((c) => c.method === method); }

test.beforeEach(() => {
  menuAnchor._resetForTests();
  pendingEnrichment.clear();
  lastTouchedWizard.clear();
});

test('newest card edits in place — no delete, anchor unchanged', async () => {
  const bot = createFakeBot();
  const state = freshState();
  menuAnchor.noteMessage(CHAT, 500); // the card IS the newest message

  await renderWizard(bot, CHAT, state, 'step text', []);

  assert.equal(callsOf(bot, 'deleteMessage').length, 0);
  assert.equal(callsOf(bot, 'sendMessage').length, 0);
  assert.equal(callsOf(bot, 'editMessageText').length, 1);
  assert.equal(callsOf(bot, 'editMessageText')[0].args.opts.message_id, 500);
  assert.equal(state.anchorMessageId, 500, 'anchor stays put');
});

test('buried card is deleted and re-sent at the bottom; anchor follows', async () => {
  const bot = createFakeBot();
  const state = freshState();
  menuAnchor.noteMessage(CHAT, 600); // something newer landed below the card

  await renderWizard(bot, CHAT, state, 'step text', []);

  const dels = callsOf(bot, 'deleteMessage');
  assert.equal(dels.length, 1, 'old card deleted');
  assert.equal(String(dels[0].args.messageId), '500');
  const sends = callsOf(bot, 'sendMessage');
  assert.equal(sends.length, 1, 'card re-sent at the bottom');
  assert.equal(sends[0].args.text, 'step text');
  assert.ok(state.anchorMessageId > 600, 'anchor moved to the fresh message');
  assert.equal(menuAnchor.latestMessageId(CHAT), state.anchorMessageId,
    'watermark records the new card, so the NEXT render edits in place');

  // Second render with nothing newer: back to zero-churn edit-in-place.
  bot.calls.length = 0;
  await renderWizard(bot, CHAT, state, 'step text 2', []);
  assert.equal(callsOf(bot, 'deleteMessage').length, 0);
  assert.equal(callsOf(bot, 'editMessageText').length, 1);
});

test('delete refused (>48h card) — keyboard stripped so no dead chips stay live', async () => {
  const bot = createFakeBot();
  bot.deleteMessage = async () => { throw new Error('message can\'t be deleted'); };
  const state = freshState();
  menuAnchor.noteMessage(CHAT, 600);

  await renderWizard(bot, CHAT, state, 'step text', []);

  const strips = callsOf(bot, 'editMessageReplyMarkup');
  assert.equal(strips.length, 1, 'old card keyboard stripped');
  assert.equal(strips[0].args.opts.message_id, 500);
  assert.deepEqual(strips[0].args.replyMarkup, { inline_keyboard: [] });
  assert.equal(callsOf(bot, 'sendMessage').length, 1, 'fresh card still sent');
  assert.notEqual(state.anchorMessageId, 500);
});

test('typed reply bumps the card below the admin\'s own message (watermark blind spot)', async () => {
  const bot = createFakeBot();
  const state = freshState();
  pendingEnrichment.set(wizKey('777', 'REQ1'), state);
  lastTouchedWizard.set('777', { requestId: 'REQ1', at: Date.now() });
  // Watermark says the card is newest — only the admin's typed reply buried it.
  menuAnchor.noteMessage(CHAT, 500);

  const handled = await approvalEvents.handleEnrichmentMessage(bot, CHAT, '777', '1500');

  assert.equal(handled, true);
  assert.equal(state.step, 'payment', 'rate applied, wizard advanced');
  assert.equal(state.ratePerUnitByDesign['44200'], 1500);
  assert.equal(callsOf(bot, 'deleteMessage').length, 1, 'buried card removed');
  const sends = callsOf(bot, 'sendMessage');
  assert.equal(sends.length, 1, 'next step rides at the bottom');
  assert.match(sends[0].args.text, /Step 3 — Payment mode/);
  assert.equal(state.bumpNext, false, 'flag consumed — no double bump');
});

test('chip tap on a buried card moves it before showing the next step', async () => {
  const bot = createFakeBot();
  const state = freshState();
  pendingEnrichment.set(wizKey('777', 'REQ1'), state);
  menuAnchor.noteMessage(CHAT, 600); // e.g. the Sales-pending list card arrived

  await approvalEvents.handleEnrichmentCallback(bot, {
    id: 'q', data: 'enr:q:REQ1:rate:v', from: { id: 777 },
    message: { chat: { id: CHAT }, message_id: 500 },
  });

  assert.equal(state.step, 'payment');
  assert.equal(callsOf(bot, 'deleteMessage').length, 1, 'buried card removed');
  const sends = callsOf(bot, 'sendMessage');
  assert.equal(sends.length, 1);
  assert.match(sends[0].args.text, /Step 3 — Payment mode/);
});
