'use strict';

/**
 * USR-C4 regression — the Deactivate/Promote confirm card must not crash on
 * names/departments containing Markdown special characters.
 *
 * Repro of the reported bug: picking a user named "Bola_X" threw
 * `ETELEGRAM: 400 ... can't parse entities` and surfaced as "Lookup failed".
 * Fix = escape user-supplied values + plain-text render fallback. Dual-admin
 * approval semantics are unchanged and not exercised here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const sessionStore = require('../../../src/utils/sessionStore');
const usersRepo = require('../../../src/repositories/usersRepository');
const auth = require('../../../src/middlewares/auth');
const userManageFlow = require('../../../src/flows/userManageFlow');

const ADMIN = '777';
auth.isAdmin = (id) => String(id) === ADMIN;

// A user whose name + department contain Markdown specials that broke parsing.
// NOTE: mirrors the real usersRepository shape — `user_id`, NOT `telegram_id`.
const TRICKY = {
  user_id: '101', name: 'Bola_X *VIP*', role: 'employee', status: 'active',
  departments: ['Sales_North'],
};
usersRepo.getAll = async () => [{ ...TRICKY }];
usersRepo.findByUserId = async (id) => (String(id) === '101' ? { ...TRICKY } : null);

function query(data) {
  return { id: 'cb', from: { id: ADMIN }, data, message: { chat: { id: ADMIN }, message_id: 9 } };
}

test('mdEscape escapes Telegram Markdown specials', () => {
  const { mdEscape } = userManageFlow._internals;
  assert.equal(mdEscape('Bola_X *VIP* [a] `c`'), 'Bola\\_X \\*VIP\\* \\[a\\] \\`c\\`');
  assert.equal(mdEscape(null), '');
});

test('deactivate confirm card escapes a tricky name/department (no raw specials)', async () => {
  sessionStore.clear(ADMIN);
  const bot = createPlainBot();
  await userManageFlow.handleCallback(bot, query('umg:start:deactivate'));
  await userManageFlow.handleCallback(bot, query('umg:pick:101'));
  const out = bot.allText();
  assert.match(out, /Bola\\_X \\\*VIP\\\*/);     // name escaped
  assert.match(out, /Sales\\_North/);            // department escaped
  assert.doesNotMatch(out, /Lookup failed/i);    // bug message must NOT appear
});

test('confirm card shows the real Telegram ID (regression: was "undefined")', async () => {
  sessionStore.clear(ADMIN);
  const bot = createPlainBot();
  await userManageFlow.handleCallback(bot, query('umg:start:deactivate'));
  await userManageFlow.handleCallback(bot, query('umg:pick:101'));
  const out = bot.allText();
  assert.match(out, /Telegram ID:.*101/);        // real id from user_id
  assert.doesNotMatch(out, /undefined/);
});

test('submit payload carries the real Telegram ID (so the executor can find the user)', async () => {
  sessionStore.clear(ADMIN);
  let queued = null;
  const aqr = require('../../../src/repositories/approvalQueueRepository');
  const origAppend = aqr.append;
  aqr.append = async (row) => { queued = row; };
  const origNotify = require('../../../src/events/approvalEvents').notifyAdminsApprovalRequest;
  require('../../../src/events/approvalEvents').notifyAdminsApprovalRequest = async () => {};
  const origAudit = require('../../../src/repositories/auditLogRepository').append;
  require('../../../src/repositories/auditLogRepository').append = async () => {};
  try {
    const bot = createPlainBot();
    await userManageFlow.handleCallback(bot, query('umg:start:deactivate'));
    await userManageFlow.handleCallback(bot, query('umg:pick:101'));
    await userManageFlow.handleCallback(bot, query('umg:submit'));
    assert.ok(queued, 'expected an approval row to be queued');
    assert.equal(queued.actionJSON.action, 'deactivate_user');
    assert.equal(queued.actionJSON.telegram_id, '101');
  } finally {
    aqr.append = origAppend;
    require('../../../src/events/approvalEvents').notifyAdminsApprovalRequest = origNotify;
    require('../../../src/repositories/auditLogRepository').append = origAudit;
  }
});

test('render survives Telegram rejecting Markdown (plain-text fallback)', async () => {
  sessionStore.clear(ADMIN);
  const bot = createStrictMarkdownBot(); // throws on every parse_mode:Markdown send
  // Must not throw, and must NOT fall into the "Lookup failed" error branch.
  await userManageFlow.handleCallback(bot, query('umg:start:deactivate'));
  await userManageFlow.handleCallback(bot, query('umg:pick:101'));
  const out = bot.allText();
  assert.match(out, /Confirm/);                  // confirm card delivered via plain text
  assert.doesNotMatch(out, /Lookup failed/i);
  assert.ok(bot.plainSends > 0, 'expected at least one plain-text fallback send');
});

// ── fakes ──────────────────────────────────────────────────────────────────
function createPlainBot() {
  const calls = [];
  let id = 100;
  return {
    calls,
    async answerCallbackQuery() { return true; },
    async editMessageText(text, opts) { calls.push({ text, opts }); return { message_id: opts.message_id || (id += 1) }; },
    async sendMessage(chatId, text, opts) { calls.push({ text, opts }); return { message_id: (id += 1), chat: { id: chatId }, text }; },
    allText() { return calls.map((c) => c.text || '').join('\n'); },
  };
}

function createStrictMarkdownBot() {
  const calls = []; // only SUCCESSFUL deliveries are recorded
  let id = 200;
  const bot = {
    calls,
    plainSends: 0, // plain-text deliveries (edit or send), i.e. fallbacks
    async answerCallbackQuery() { return true; },
    async editMessageText(text, opts) {
      if (opts && opts.parse_mode === 'Markdown') throw new Error("ETELEGRAM: 400 can't parse entities");
      calls.push({ text, opts });
      bot.plainSends += 1;
      return { message_id: opts.message_id || (id += 1) };
    },
    async sendMessage(chatId, text, opts) {
      if (opts && opts.parse_mode === 'Markdown') throw new Error("ETELEGRAM: 400 can't parse entities");
      calls.push({ text, opts });
      bot.plainSends += 1;
      return { message_id: (id += 1), chat: { id: chatId }, text };
    },
    allText() { return calls.map((c) => c.text || '').join('\n'); },
  };
  return bot;
}
