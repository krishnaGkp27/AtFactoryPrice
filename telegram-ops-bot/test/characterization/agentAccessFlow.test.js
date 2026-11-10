'use strict';

/**
 * AGT-1 — 🤖 Agent Data Access through the REAL controller: the Reporting
 * tile opens the card for an admin, an employee is refused in one line, the
 * `agk:` prefix is routed, the key is shown once in its own message, and
 * the report file is sent as a document.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';
process.env.BASE_URL = 'https://ops.example.test';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const postgresPool = require(path.join(SRC, 'db/postgresPool'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));
const agentKeyService = require(path.join(SRC, 'services/agentKeyService'));

// The harness removes DATABASE_URL (no test may reach a real database), so
// the pool is switched on by hand and every query answered from memory.
postgresPool.isEnabled = () => true;
let keys = [];
postgresPool.query = async (text, params = []) => {
  if (/^UPDATE agent_keys SET revoked_at/.test(text)) {
    const live = keys.filter((k) => !k.revoked);
    live.forEach((k) => { k.revoked = true; });
    return { rows: [], rowCount: live.length };
  }
  if (/^INSERT INTO agent_keys/.test(text)) { keys.push({ id: keys.length + 1, hash: params[0], name: params[2], revoked: false }); return { rows: [] }; }
  if (/^SELECT id FROM agent_keys/.test(text)) { const k = keys.find((x) => x.hash === params[0] && !x.revoked); return { rows: k ? [{ id: k.id }] : [] }; }
  if (/FROM agent_keys WHERE revoked_at IS NULL/.test(text)) {
    const k = keys.filter((x) => !x.revoked).pop();
    return { rows: k ? [{ created_by: '777', created_name: k.name, created_at: '2026-11-10T09:00:00Z', last_used_at: null, uses: 0 }] : [] };
  }
  return { rows: [] };
};

function cq(uid, data) {
  return { id: `cq-${data}`, data, from: { id: uid }, message: { chat: { id: 500 }, message_id: 77 } };
}
function texts(bot) {
  return bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText').map((x) => String(x.args.text || ''));
}
function lastKb(bot) {
  const c = bot.calls.filter((x) => x.args && x.args.opts && x.args.opts.reply_markup);
  const kb = c.length ? c[c.length - 1].args.opts.reply_markup.inline_keyboard : [];
  return kb.flat().map((b) => `${b.text}|${b.callback_data}`);
}

test.beforeEach(() => { keys = []; });

test('registry: 🤖 Agent Data Access sits in the Reporting hub', () => {
  const a = activityRegistry.getActivity('agent_access');
  assert.ok(a);
  assert.equal(a.label, 'Agent Data Access');
  assert.equal(a.hub, 'reporting');
  assert.equal(activityRegistry.getByCallback('act:agent_access').code, 'agent_access');
});

test('an admin opens the card: no key yet, Create key and the report file are offered', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('777', 'act:agent_access'));
  const t = texts(bot).pop();
  assert.match(t, /🤖 \*Agent Data Access\*/);
  assert.match(t, /Read-only: it can change nothing\./);
  assert.match(t, /🔑 Key: none yet/);
  assert.deepEqual(lastKb(bot), ['🔑 Create key|agk:new', '📤 Send me the report file|agk:file', '🏠 Back to menu|act:__back__']);
});

test('an employee is refused in one line and offered nothing', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('4242', 'act:agent_access'));
  assert.ok(texts(bot).some((t) => /Agent Data Access is admin-only\./.test(t)));
  await controller.handleCallbackQuery(bot, cq('4242', 'agk:new'));
  assert.equal(keys.length, 0);
});

test('🔑 Create key: the key is shown once in its own message with host, header and a delete button; the card then offers Replace / Switch off', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('777', 'agk:new'));
  const keyMsg = texts(bot).find((t) => /Agent data key/.test(t));
  assert.ok(keyMsg);
  const m = /`(agk_[A-Za-z0-9_-]+)`/.exec(keyMsg);
  assert.ok(m, 'the key is printed as tap-to-copy code');
  assert.match(keyMsg, /Never into the chat\./);
  assert.match(keyMsg, /Host: `ops\.example\.test`/);
  assert.match(keyMsg, /Header: `X-Agent-Key`/);
  assert.equal(await agentKeyService.verify(m[1]), true);
  const card = texts(bot).pop();
  assert.match(card, /🔑 Key: live since 10-Nov-2026/);
  assert.match(card, /Not used yet/);
  assert.deepEqual(lastKb(bot), ['♻️ Replace key|agk:new', '🚫 Switch off|agk:off', '📤 Send me the report file|agk:file', '🏠 Back to menu|act:__back__']);
});

test('🚫 Switch off asks first, then the key stops verifying', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('777', 'agk:new'));
  const key = /`(agk_[A-Za-z0-9_-]+)`/.exec(texts(bot).find((t) => /Agent data key/.test(t)))[1];
  await controller.handleCallbackQuery(bot, cq('777', 'agk:off'));
  assert.match(texts(bot).pop(), /Switch off agent access\?/);
  assert.equal(await agentKeyService.verify(key), true, 'asking is not doing');
  await controller.handleCallbackQuery(bot, cq('777', 'agk:offyes'));
  assert.equal(await agentKeyService.verify(key), false);
  assert.match(texts(bot).pop(), /Switched off\. No key is live\./);
});

test('📤 the report file arrives as a JSON document', async () => {
  const bot = createFakeBot();
  await controller.handleCallbackQuery(bot, cq('777', 'agk:file'));
  const doc = bot.calls.find((x) => x.method === 'sendDocument');
  assert.ok(doc, 'a document was sent');
  const parsed = JSON.parse(Buffer.from(doc.args.doc || doc.args.document || doc.args.file).toString('utf8'));
  assert.equal(parsed.days, 30);
  assert.ok(parsed.usage && parsed.people && parsed.flows && parsed.typed && parsed.errors);
});
