'use strict';

/**
 * PAY-1 — a registration whose request never reached the approval queue
 * no longer blocks its account number. Walked through the REAL controller,
 * the real approval gate and the real PaymentAccounts / ApprovalQueue
 * repositories on the in-memory sheet.
 *
 * The gate writes the door's own record first (the PaymentAccounts row, as
 * `pending`) and the queue row second. When the queue write was then
 * refused (Google's write quota, the network), the person saw
 * "Could not submit", the pending row stayed behind under a request id no
 * admin could ever approve or reject, and every retry was refused as
 * "Already registered … awaiting approval".
 *
 * Pinned:
 *  - queue write refused → that row reads `inactive` (the status cell
 *    alone; the row is kept), and the same number registers again straight
 *    away as a NEW request, which two admins approve exactly as before;
 *  - a request that DID reach the queue keeps its row, whatever failed
 *    afterwards (a lost reply to the queue write; the admin notice);
 *  - the cleanup is best-effort: a queue that cannot be read, or a status
 *    write that is refused, is logged and the person still gets the same
 *    "Could not submit" card;
 *  - a successful raise is untouched.
 */

process.env.ADMIN_IDS = '777,888';
process.env.EMPLOYEE_IDS = '7430648262';
delete process.env.FINANCE_IDS;

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../helpers/fakeBot');
const { createFakeSheets } = require('../helpers/fakeSheets');
const { installFakeSheets, installFakeIntent, loadController, SRC } = require('../helpers/controllerHarness');
const { cb } = require('../helpers/charFixture');

const fake = createFakeSheets({});
installFakeSheets(fake);
installFakeIntent(() => ({ action: 'unknown', confidence: 0 }));
const controller = loadController();

const sessionStore = require(path.join(SRC, 'utils/sessionStore'));
const sheetsClient = require(path.join(SRC, 'repositories/sheetsClient'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));
const approvalEvents = require(path.join(SRC, 'events/approvalEvents'));
const paymentService = require(path.join(SRC, 'services/paymentService'));
const logger = require(path.join(SRC, 'utils/logger'));

const ABDUL = '7430648262';
const AJEET = '777';
const JOHN = '888';
const NUMBER = '0123456789';
const NAMES = { [ABDUL]: 'Abdul', [AJEET]: 'Ajeet', [JOHN]: 'John' };
const USERS = [
  { user_id: ABDUL, name: 'Abdul', departments: ['Sales'], department: 'Sales', status: 'active' },
];

usersRepository.getAll = async () => USERS;
usersRepository.findByUserId = async (id) => USERS.find((u) => u.user_id === String(id)) || null;
// The double-tap window keeps its default (20 s): the retry below is raised
// within it on purpose — a raise that failed is not a first tap to merge into.
settingsRepository.getAll = async () => ({ BANK_LIST: 'GTBank,Zenith,Access' });
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
auditLogRepository.append = async () => {};

const H = (name) => accountsRepo.HEADERS.indexOf(name);
const STATUS = H('status');
const REQUEST = H('approval_request_id');
const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];
const QUOTA = "Quota exceeded for quota metric 'Write requests' and limit 'Write requests per minute per user'";

/** Both sheets back to their header row — the repositories write it only once. */
function reset() {
  fake._store.set(accountsRepo.SHEET, [[...accountsRepo.HEADERS]]);
  fake._store.set('ApprovalQueue', [[...QUEUE_HEADERS]]);
  accountsRepo.invalidateCache();
  [ABDUL, AJEET, JOHN].forEach((id) => sessionStore.clear(id));
}

const msg = (uid, text) => ({ chat: { id: uid }, from: { id: uid, first_name: 'X' }, text });
const accountRows = () => fake._store.get(accountsRepo.SHEET).slice(1);
const queueRows = () => fake._store.get('ApprovalQueue').slice(1);
const lastTo = (bot, id) => {
  const t = bot.calls.filter((c) => (c.method === 'sendMessage' && String(c.args.chatId) === String(id))
    || (c.method === 'editMessageText' && String(c.args.opts && c.args.opts.chat_id) === String(id)));
  return t.length ? String(t[t.length - 1].args.text) : '';
};
const sentTo = (bot, id) => bot.calls.filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id));

/** Abdul walks 🏦 Register account for NUMBER at GTBank, up to and including Submit. */
async function register(bot) {
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:reg', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, NUMBER));
  await controller.handleMessage(bot, msg(ABDUL, NUMBER));
  await controller.handleCallbackQuery(bot, cb('pay:bank:0', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
}

/** Run `fn` while every write of a new ApprovalQueue row behaves as `behave` says. */
async function withQueueAppend(behave, fn) {
  const orig = sheetsClient.appendRows;
  sheetsClient.appendRows = async (sheet, rows) => (sheet === 'ApprovalQueue' ? behave(() => orig(sheet, rows)) : orig(sheet, rows));
  try { return await fn(); } finally { sheetsClient.appendRows = orig; }
}

/** Run `fn` with the logger's error / warn lines captured. */
async function withLog(fn) {
  const lines = { error: [], warn: [] };
  const origError = logger.error; const origWarn = logger.warn;
  logger.error = (m) => { lines.error.push(String(m)); };
  logger.warn = (m) => { lines.warn.push(String(m)); };
  try { await fn(lines); } finally { logger.error = origError; logger.warn = origWarn; }
  return lines;
}

test('queue write refused → the row goes inactive, the same number registers again as a new request and approves as before', async () => {
  reset();
  const bot = createFakeBot();

  const log = await withLog(() => withQueueAppend(async () => { throw new Error(QUOTA); }, () => register(bot)));

  // What the person sees is what it was.
  assert.match(lastTo(bot, ABDUL), /^⚠️ Could not submit: Quota exceeded/);
  assert.equal(queueRows().length, 0, 'the request never reached the queue');
  assert.equal(sentTo(bot, AJEET).length + sentTo(bot, JOHN).length, 0, 'no admin was sent a card');

  // The row the gate had already written is released — the status cell alone.
  assert.equal(accountRows().length, 1, 'the row is kept as the record');
  const row = accountRows()[0];
  const firstRequest = row[REQUEST];
  assert.ok(firstRequest, 'it still names the request that failed');
  assert.equal(row[STATUS], 'inactive');
  assert.deepEqual(
    [row[H('owner_name')], row[H('owner_type')], row[H('owner_telegram_id')], row[H('account_number')], row[H('bank')],
      row[H('registered_by')], row[H('approved_by')], row[H('notes')]],
    // (the number is written as TEXT — the repository's leading apostrophe)
    ['Abdul', 'employee', ABDUL, `'${NUMBER}`, 'GTBank', ABDUL, '', ''], 'no other cell changed');
  assert.ok(row[H('account_id')] && row[H('created_at')]);
  assert.ok(log.warn.some((w) => w.includes(firstRequest) && /never reached the approval queue/.test(w) && /inactive/.test(w)),
    'the release is logged');

  // The same number, the same bank, straight away.
  await register(bot);
  assert.match(lastTo(bot, ABDUL), /Sent for approval/);
  assert.doesNotMatch(lastTo(bot, ABDUL), /Already registered/);
  assert.equal(accountRows().length, 2);
  assert.equal(accountRows()[1][STATUS], 'pending');
  const secondRequest = accountRows()[1][REQUEST];
  assert.notEqual(secondRequest, firstRequest, 'a new request, not the failed one revived');
  assert.equal(queueRows().length, 1);
  assert.equal(queueRows()[0][0], secondRequest);
  assert.equal(queueRows()[0][4], 'pending');
  assert.ok(sentTo(bot, AJEET).length > 0, 'the admins get the card of the request that went through');

  // Two admins sign it — the approve path is what it was.
  await controller.handleCallbackQuery(bot, cb(`approve:${secondRequest}`, AJEET));
  assert.equal(accountRows()[1][STATUS], 'pending', 'one signature is not enough');
  await controller.handleCallbackQuery(bot, cb(`approve:${secondRequest}`, JOHN));
  assert.equal(accountRows()[1][STATUS], 'active');
  assert.equal(accountRows()[0][STATUS], 'inactive', 'the released row stays released');
});

test('Submit tapped again in the SAME session (a confirm card still on screen) is a new request with its own row', async () => {
  reset();
  const bot = createFakeBot();
  await withLog(() => withQueueAppend(async () => { throw new Error(QUOTA); }, () => register(bot)));
  assert.equal(accountRows()[0][STATUS], 'inactive');
  const firstRequest = accountRows()[0][REQUEST];
  assert.equal(sessionStore.get(ABDUL).step, 'reg_confirm', 'the wizard is still open');

  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
  assert.match(lastTo(bot, ABDUL), /Sent for approval/);
  assert.equal(accountRows().length, 2);
  assert.equal(accountRows()[1][STATUS], 'pending');
  assert.notEqual(accountRows()[1][REQUEST], firstRequest, 'never two rows under one request id');
  assert.equal(queueRows().length, 1);
  assert.equal(queueRows()[0][0], accountRows()[1][REQUEST]);
  assert.equal(accountRows()[0][STATUS], 'inactive');
});

test('a successful raise is untouched: the row stays pending and a second try is refused as before', async () => {
  reset();
  const bot = createFakeBot();
  await register(bot);
  assert.match(lastTo(bot, ABDUL), /Sent for approval/);
  assert.equal(accountRows().length, 1);
  assert.equal(accountRows()[0][STATUS], 'pending');
  assert.equal(queueRows().length, 1);

  await register(bot);
  assert.match(lastTo(bot, ABDUL), /Already registered/);
  assert.match(lastTo(bot, ABDUL), /GTBank 0123456789 is already awaiting approval for \*Abdul\*/);
  assert.equal(accountRows().length, 1);
  assert.equal(accountRows()[0][STATUS], 'pending');
});

test('the queue row DID land although its write reported a failure: the row is kept — it really is awaiting approval', async () => {
  reset();
  const bot = createFakeBot();
  await withLog(() => withQueueAppend(async (write) => { await write(); throw new Error('socket hang up'); }, () => register(bot)));

  assert.match(lastTo(bot, ABDUL), /^⚠️ Could not submit: socket hang up/);
  assert.equal(queueRows().length, 1, 'the request is on the queue');
  assert.equal(accountRows().length, 1);
  assert.equal(accountRows()[0][STATUS], 'pending', 'so its account row is not released');
  assert.equal(queueRows()[0][0], accountRows()[0][REQUEST]);

  await register(bot);
  assert.match(lastTo(bot, ABDUL), /already awaiting approval/);
  assert.equal(accountRows().length, 1);
});

test('a failure AFTER the request was queued (the admin notice) releases nothing', async () => {
  reset();
  const bot = createFakeBot();
  const origNotify = approvalEvents.notifyAdminsApprovalRequest;
  approvalEvents.notifyAdminsApprovalRequest = async () => { throw new Error('telegram is down'); };
  try {
    await withLog(() => register(bot));
  } finally { approvalEvents.notifyAdminsApprovalRequest = origNotify; }

  assert.match(lastTo(bot, ABDUL), /^⚠️ Could not submit: telegram is down/);
  assert.equal(queueRows().length, 1);
  assert.equal(queueRows()[0][4], 'pending');
  assert.equal(accountRows()[0][STATUS], 'pending', 'the request is open in the 🛂 inbox — its row stays');
});

test('best-effort: a refused status write, or a queue that cannot be read, is logged and costs the person nothing more', async () => {
  // 1 — the release write itself is refused.
  reset();
  let bot = createFakeBot();
  const origSet = accountsRepo.setStatus;
  accountsRepo.setStatus = async () => { throw new Error(QUOTA); };
  let log;
  try {
    log = await withLog(() => withQueueAppend(async () => { throw new Error(QUOTA); }, () => register(bot)));
  } finally { accountsRepo.setStatus = origSet; }
  assert.match(lastTo(bot, ABDUL), /^⚠️ Could not submit: Quota exceeded/);
  assert.equal(accountRows()[0][STATUS], 'pending', 'nothing could be written');
  assert.ok(log.error.some((e) => /register_payment_account raise cleanup FAILED/.test(e) && e.includes(accountRows()[0][REQUEST])
    && /still reads pending/.test(e)), 'the log says which row still blocks the number');

  // 2 — the queue cannot be read: never assumed absent, nothing released.
  reset();
  bot = createFakeBot();
  const origRead = sheetsClient.readRange;
  let failing = false;
  sheetsClient.readRange = async (sheet, range) => {
    if (failing && sheet === 'ApprovalQueue') throw new Error('Read quota exceeded');
    return origRead(sheet, range);
  };
  try {
    log = await withLog(() => withQueueAppend(async () => { failing = true; throw new Error(QUOTA); }, () => register(bot)));
  } finally { sheetsClient.readRange = origRead; }
  assert.match(lastTo(bot, ABDUL), /^⚠️ Could not submit: Quota exceeded/);
  assert.equal(accountRows()[0][STATUS], 'pending');
  assert.ok(log.error.some((e) => /register_payment_account raise cleanup FAILED/.test(e) && /Read quota exceeded/.test(e)));
});

test('releaseUnqueuedAccount: only this request\'s own pending row, only when the request is not on the queue; never throws', async () => {
  reset();
  const queueRepo = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  const mk = (requestId, status) => accountsRepo.append({
    owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: ABDUL,
    account_number: NUMBER, bank: 'GTBank', status, registered_by: ABDUL, approval_request_id: requestId,
  });
  const orphan = await mk('REQ-ORPHAN', 'pending');
  const queued = await mk('REQ-QUEUED', 'pending');
  const live = await mk('REQ-LIVE', 'active');
  await queueRepo.append({ requestId: 'REQ-QUEUED', user: ABDUL, status: 'pending', actionJSON: { action: 'register_payment_account' } });
  const statusOf = (id) => fake._store.get(accountsRepo.SHEET).find((r) => r[0] === id)[STATUS];

  await withLog(async () => {
    assert.equal(await paymentService.releaseUnqueuedAccount(''), null);
    assert.equal(await paymentService.releaseUnqueuedAccount('REQ-NOPE'), null);
    assert.equal(await paymentService.releaseUnqueuedAccount('REQ-QUEUED'), null, 'on the queue → kept');
    assert.equal(await paymentService.releaseUnqueuedAccount('REQ-LIVE'), null, 'an active account is never touched');
    assert.equal(statusOf(orphan.account_id), 'pending');
    assert.equal(statusOf(queued.account_id), 'pending');
    assert.equal(statusOf(live.account_id), 'active');

    const released = await paymentService.releaseUnqueuedAccount('REQ-ORPHAN');
    assert.equal(released.account_id, orphan.account_id);
    assert.equal(released.status, 'inactive');
    assert.equal(statusOf(orphan.account_id), 'inactive');
    assert.equal(statusOf(queued.account_id), 'pending', 'no other row moved');
    assert.equal(statusOf(live.account_id), 'active');
    assert.equal(await paymentService.releaseUnqueuedAccount('REQ-ORPHAN'), null, 'once');
  });
});
