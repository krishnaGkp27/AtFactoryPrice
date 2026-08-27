'use strict';

/**
 * MKR-3 — marketer photos are OPTIONAL (owner, 27-Aug-2026).
 *
 * The flow used to hard-require a person photo and a catalog photo — in
 * the field the marketer is often registered before anyone has a picture.
 * Drives the REAL flow with a fake bot: name → skip phone → skip area →
 * skip person photo → skip catalog photo → review says skipped → submit
 * queues a normal register_marketer approval with empty photo columns.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

process.env.ADMIN_IDS = '777,888';

const { installFakeSheets, SRC } = require('../helpers/controllerHarness');
const { createFakeSheets } = require('../helpers/fakeSheets');
installFakeSheets(createFakeSheets({}));

// Patch BEFORE requiring the controller — it destructures this import.
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
approvalEvents.notifyAdminsApprovalRequest = async () => {};

const catalogFlows = require(path.join(SRC, 'controllers/catalogFlowController'));
const marketersRepo = require(path.join(SRC, 'repositories/marketersRepository'));
const approvalQueueRepo = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepo = require(path.join(SRC, 'repositories/auditLogRepository'));
const usersRepo = require(path.join(SRC, 'repositories/usersRepository'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

let QUEUED = [];
marketersRepo.append = async (d) => ({ ...d, marketer_id: 'MKR-9' });
approvalQueueRepo.append = async (r) => { QUEUED.push(r); return r; };
auditLogRepo.append = async () => {};
usersRepo.findByUserId = async (id) => ({ user_id: String(id), name: `U${id}` });

const ADMIN = '777';
function fakeBot() {
  const sent = [];
  return {
    sent,
    answerCallbackQuery: async () => true,
    sendMessage: async (chatId, text, opts) => { sent.push({ chatId, text, opts }); return { message_id: sent.length + 100 }; },
    editMessageText: async (text, opts) => { sent.push({ chatId: opts.chat_id, text, opts }); return { message_id: opts.message_id }; },
    sendPhoto: async () => { throw new Error('no photo should ever be sent on the skip path'); },
    deleteMessage: async () => true,
    last() { return sent[sent.length - 1]; },
  };
}
const cbq = (data) => ({ id: 'q1', data, from: { id: ADMIN }, message: { chat: { id: ADMIN }, message_id: 55 } });

test('the whole registration works with ZERO photos', async () => {
  QUEUED = [];
  sessionStore.clear(ADMIN);
  const bot = fakeBot();

  await catalogFlows.startRegisterMarketerFlow(bot, ADMIN, ADMIN, 55);
  await catalogFlows.handleCatalogFlowTextStep(bot, ADMIN, ADMIN, 'Goku Son');
  await catalogFlows.handleCatalogFlowCallback(bot, cbq('mkr:skip_phone'));
  await catalogFlows.handleCatalogFlowCallback(bot, cbq('mkr:skip_area'));

  const personStep = bot.last();
  assert.match(personStep.text, /photo of the marketer \(or Skip\)/, 'the photo step offers Skip');
  assert.ok(JSON.stringify(personStep.opts.reply_markup).includes('mkr:skip_person'));

  await catalogFlows.handleCatalogFlowCallback(bot, cbq('mkr:skip_person'));
  const catalogStep = bot.last();
  assert.match(catalogStep.text, /Person photo: —/, 'the skipped photo shows as absent, not ✅');

  await catalogFlows.handleCatalogFlowCallback(bot, cbq('mkr:skip_catalog'));
  const review = bot.last();
  assert.match(review.text, /Person photo: — \(skipped\)/);
  assert.match(review.text, /Catalog photo: — \(skipped\)/);
  assert.ok(JSON.stringify(review.opts.reply_markup).includes('Add Person photo'),
    'review offers Add, not Retake, when nothing was taken');

  await catalogFlows.handleCatalogFlowCallback(bot, cbq('mkr:submit'));
  assert.equal(QUEUED.length, 1, 'the approval queues exactly once');
  const aj = QUEUED[0].actionJSON;
  assert.equal(aj.action, 'register_marketer');
  assert.equal(aj.name, 'Goku Son');
  assert.equal(aj.personPhotoFileId, '', 'no phantom photo id');
  assert.equal(aj.catalogPhotoFileId, '', 'no phantom photo id');
  assert.match(bot.last().text, /Submitted/i, 'the requester sees the normal confirmation');
});

test('Skip after a Back CLEARS a photo already taken — review never lies', async () => {
  QUEUED = [];
  sessionStore.clear(ADMIN);
  const bot = fakeBot();

  await catalogFlows.startRegisterMarketerFlow(bot, ADMIN, ADMIN, 55);
  await catalogFlows.handleCatalogFlowTextStep(bot, ADMIN, ADMIN, 'Vegeta');
  await catalogFlows.handleCatalogFlowCallback(bot, cbq('mkr:skip_phone'));
  await catalogFlows.handleCatalogFlowCallback(bot, cbq('mkr:skip_area'));
  // They send a person photo…
  const s = sessionStore.get(ADMIN);
  s.personPhotoFileId = 'FILE123';
  s.step = 'person_photo';
  sessionStore.set(ADMIN, s);
  // …then Skip on that same step: the stored photo must go too.
  await catalogFlows.handleCatalogFlowCallback(bot, cbq('mkr:skip_person'));
  assert.equal(sessionStore.get(ADMIN).personPhotoFileId, '', 'skip clears the stale photo');
});
