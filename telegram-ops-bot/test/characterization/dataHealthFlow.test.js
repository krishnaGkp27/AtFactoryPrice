'use strict';

/**
 * SEN-1 — 🩺 Data Health flow: admin-only, runs the sentinel on tap,
 * summary card with per-check drill, read-only end to end.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '888';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');

installFakeSheets(createFakeSheets({}));
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const consistencySentinel = require(path.join(SRC, 'services/consistencySentinel'));
const flow = require(path.join(SRC, 'flows/dataHealthFlow'));

const ADMIN = '777';
const EMPLOYEE = '888';

consistencySentinel.runAll = async () => ({
  totalFindings: 107,
  checks: [
    { id: 'C1', title: 'Sold rows have sale movements', findings: [] },
    { id: 'C4', title: 'One Current flag per bale', findings: ['Bale 869 (9060-A · Jul26) has 2 Current rows (should be exactly 1)', 'Bale 843 (9060-A · Jul26) has NO Current row (crash between flag-clear and append?)'] },
    // Aggregated (ISC-1 C9): two lines, but the true count is 105 rows.
    { id: 'C9', title: 'Every sale carries a readable date', count: 105, findings: ['105 sold row(s) carry a SoldDate the bot cannot read', 'row 4012 · 9060-A/869 #1 · "cashmere 12-February-2026"'] },
  ],
});

function lastMsg(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText').pop();
  const opts = (c && c.args.opts) || {};
  return { text: (c && c.args.text) || '', kb: (opts.reply_markup && opts.reply_markup.inline_keyboard) || [] };
}

const cb = (data, uid) => ({ data, id: 'q1', from: { id: uid }, message: { message_id: 7, chat: { id: uid } } });

test('admin-only', async () => {
  const bot = createFakeBot();
  await flow.start(bot, EMPLOYEE, EMPLOYEE, null);
  assert.match(lastMsg(bot).text, /admin-only/);
  sessionStore.clear(EMPLOYEE);
});

test('summary card: ticks for clean checks, drill buttons for failing ones', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  const { text, kb } = lastMsg(bot);
  assert.match(text, /107 issue\(s\)/);
  assert.match(text, /✅ C1/);
  assert.match(text, /⚠️ C4 .*— 2/);
  assert.match(text, /⚠️ C9 .*— 105/, 'an aggregated check shows its row count, not its line count');
  const flat = kb.flat();
  assert.ok(!flat.some((b) => b.callback_data === 'snt:c:0'), 'clean check gets no drill button');
  assert.ok(flat.some((b) => b.callback_data === 'snt:c:1'), 'failing check is tappable');
  assert.ok(flat.some((b) => b.callback_data === 'snt:c:2' && /C9 — 105 finding\(s\)/.test(b.text)), 'drill button carries the row count');
  assert.ok(flat.some((b) => b.callback_data === 'snt:run'), 're-run offered');
  sessionStore.clear(ADMIN);
});

test('drilling a check lists every finding and comes back', async () => {
  const bot = createFakeBot();
  await flow.start(bot, ADMIN, ADMIN, null);
  await flow.handleCallback(bot, cb('snt:c:1', ADMIN));
  const { text } = lastMsg(bot);
  assert.match(text, /C4 — One Current flag per bale/);
  assert.match(text, /Bale 869/);
  assert.match(text, /Bale 843/);
  await flow.handleCallback(bot, cb('snt:back', ADMIN));
  assert.equal(sessionStore.get(ADMIN).step, 'summary');
  // The aggregated check's page heads with its row count over its two lines.
  await flow.handleCallback(bot, cb('snt:c:2', ADMIN));
  const c9 = lastMsg(bot).text;
  assert.match(c9, /C9 — Every sale carries a readable date/);
  assert.match(c9, /105 finding\(s\)/);
  assert.match(c9, /cashmere 12\\-February\\-2026|cashmere 12-February-2026/);
  await flow.handleCallback(bot, cb('snt:back', ADMIN));
  sessionStore.clear(ADMIN);
});
