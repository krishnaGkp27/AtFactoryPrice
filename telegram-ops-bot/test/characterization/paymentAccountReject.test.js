'use strict';

/**
 * PAY-1 — a rejected account registration no longer blocks its number,
 * walked through the REAL controller, the real approval path and the real
 * PaymentAccounts / ApprovalQueue repositories on the in-memory sheet.
 *
 * Before: 🏦 Register account wrote the PaymentAccounts row as `pending`;
 * an admin's Reject closed the request and left that row as it was, so the
 * same number + bank was refused as "Already registered … awaiting
 * approval" until the status cell was rewritten on the sheet by hand.
 *
 * Pinned, for each of the three doors a registration can be rejected from
 * (❌ Reject on the admin's card, the 🛂 inbox, ⧉ Reject as duplicate —
 * all three end in the same reject path):
 *  - the request's own row reads `inactive`, every other cell as raised,
 *    the row still on the sheet;
 *  - the same person can register the same number again straight away;
 *  - while a registration is still WAITING the number is refused exactly
 *    as before;
 *  - two approvals of the new request make the account payable, as before;
 *  - the other open request's row for the same number is never touched.
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
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const accountsRepo = require(path.join(SRC, 'repositories/paymentAccountsRepository'));
const queueRepo = require(path.join(SRC, 'repositories/approvalQueueRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const approvalCards = require(path.join(SRC, 'services/approvalCards'));

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
settingsRepository.getAll = async () => ({ BANK_LIST: 'GTBank,Zenith,Access' });
approvalCards.resolveUserLabel = async (id) => NAMES[String(id)] || String(id);
auditLogRepository.append = async () => {};

const STATUS = accountsRepo.HEADERS.indexOf('status');
const REQUEST = accountsRepo.HEADERS.indexOf('approval_request_id');
const QUEUE_HEADERS = ['RequestID', 'User', 'ActionJSON', 'RiskReason', 'Status', 'CreatedAt', 'ResolvedAt', 'Approver'];

/** Both sheets back to their header row — the repositories write it only once. */
function reset() {
  fake._store.set(accountsRepo.SHEET, [[...accountsRepo.HEADERS]]);
  fake._store.set('ApprovalQueue', [[...QUEUE_HEADERS]]);
  accountsRepo.invalidateCache();
  [ABDUL, AJEET, JOHN].forEach((id) => sessionStore.clear(id));
}

const msg = (uid, text) => ({ chat: { id: uid }, from: { id: uid, first_name: 'X' }, text });
/** The account rows as they sit on the sheet (header dropped). */
const accountRows = () => fake._store.get(accountsRepo.SHEET).slice(1);
const queueRows = () => fake._store.get('ApprovalQueue').slice(1);
/** The last card drawn in one person's chat. */
const lastTo = (bot, id) => {
  const t = bot.calls.filter((c) => (c.method === 'sendMessage' && String(c.args.chatId) === String(id))
    || (c.method === 'editMessageText' && String(c.args.opts && c.args.opts.chat_id) === String(id)));
  return t.length ? String(t[t.length - 1].args.text) : '';
};
const textsTo = (bot, id) => bot.calls
  .filter((c) => c.method === 'sendMessage' && String(c.args.chatId) === String(id))
  .map((c) => String(c.args.text));

/** Abdul walks 🏦 Register account for NUMBER at GTBank, up to and including Submit. */
async function register(bot) {
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:reg', ABDUL));
  await controller.handleMessage(bot, msg(ABDUL, NUMBER));
  await controller.handleMessage(bot, msg(ABDUL, NUMBER));
  await controller.handleCallbackQuery(bot, cb('pay:bank:0', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:submit', ABDUL));
}

test('❌ Reject on the card: the row goes inactive and the same number registers again, then approves as before', async () => {
  reset();
  const bot = createFakeBot();

  await register(bot);
  assert.match(lastTo(bot, ABDUL), /Sent for approval/);
  assert.equal(accountRows().length, 1);
  assert.equal(accountRows()[0][STATUS], 'pending');
  const firstRequest = accountRows()[0][REQUEST];
  assert.equal(queueRows().length, 1);
  assert.equal(queueRows()[0][0], firstRequest);
  const asRaised = [...accountRows()[0]];

  // While the first one waits, the number is refused — unchanged.
  await register(bot);
  assert.match(lastTo(bot, ABDUL), /Already registered/);
  assert.match(lastTo(bot, ABDUL), /GTBank 0123456789 is already awaiting approval for \*Abdul\*/);
  assert.match(lastTo(bot, ABDUL), /Nothing was submitted/);
  assert.equal(accountRows().length, 1, 'no second row while the first is open');
  assert.equal(queueRows().length, 1);

  // An admin rejects it from the card in his chat.
  await controller.handleCallbackQuery(bot, cb(`reject:${firstRequest}`, JOHN));
  assert.ok(textsTo(bot, JOHN).includes(`❌ Request ${firstRequest} rejected.`), 'the admin is told, as before');
  assert.ok(textsTo(bot, ABDUL).some((t) => /^❌ Rejected by John/.test(t) && /Payee account · Abdul · GTBank 0123456789/.test(t)),
    'the requester is told who rejected it, as before');
  assert.equal(queueRows()[0][4], 'rejected');

  const expected = [...asRaised];
  expected[STATUS] = 'inactive';
  assert.deepEqual([...accountRows()[0]], expected, 'the status cell alone changed; the row is kept');

  // The same number, the same bank, straight away.
  await register(bot);
  assert.match(lastTo(bot, ABDUL), /Sent for approval/);
  assert.doesNotMatch(lastTo(bot, ABDUL), /Already registered/);
  assert.equal(accountRows().length, 2);
  assert.equal(accountRows()[1][STATUS], 'pending');
  const secondRequest = accountRows()[1][REQUEST];
  assert.notEqual(secondRequest, firstRequest, 'a new request, not the rejected one revived');
  assert.equal(queueRows().length, 2);
  assert.equal(queueRows()[1][4], 'pending');

  // Two admins sign the new one — the approve path is what it was.
  await controller.handleCallbackQuery(bot, cb(`approve:${secondRequest}`, AJEET));
  assert.equal(accountRows()[1][STATUS], 'pending', 'one signature is not enough');
  await controller.handleCallbackQuery(bot, cb(`approve:${secondRequest}`, JOHN));
  assert.equal(accountRows()[1][STATUS], 'active');
  assert.equal(queueRows()[1][4], 'approved');
  assert.equal(accountRows()[0][STATUS], 'inactive', 'the rejected row is still the rejected row');

  // And the account can now be paid into.
  await controller.handleCallbackQuery(bot, cb('act:payments', ABDUL));
  await controller.handleCallbackQuery(bot, cb('pay:start:req', ABDUL));
  assert.match(lastTo(bot, ABDUL), /Pay into which account/);
});

test('rejected from the 🛂 inbox: the same release', async () => {
  reset();
  const bot = createFakeBot();
  await register(bot);
  const requestId = accountRows()[0][REQUEST];

  await controller.handleCallbackQuery(bot, cb(`abx:no:${requestId}`, AJEET));
  assert.equal(queueRows()[0][4], 'rejected');
  assert.equal(accountRows()[0][STATUS], 'inactive');

  await register(bot);
  assert.match(lastTo(bot, ABDUL), /Sent for approval/);
  assert.equal(accountRows().length, 2);
});

test('⧉ Reject as duplicate: the duplicate\'s row is released, the open twin\'s row is not touched', async () => {
  reset();
  const bot = createFakeBot();
  await register(bot);
  const keep = accountRows()[0][REQUEST];
  // A second open request for the same number + bank (the door refuses
  // one today; two taps racing the sheet, or rows from before the clash
  // check, are how a pair like this exists).
  await accountsRepo.append({
    owner_name: 'Abdul', owner_type: 'employee', owner_telegram_id: ABDUL,
    account_number: NUMBER, bank: 'GTBank', status: 'pending',
    registered_by: ABDUL, approval_request_id: 'REQ-TWIN',
  });
  await queueRepo.append({
    requestId: 'REQ-TWIN', user: ABDUL, status: 'pending', riskReason: 'dual_admin_required',
    actionJSON: {
      action: 'register_payment_account', owner_name: 'Abdul', owner_type: 'employee',
      account_number: NUMBER, bank: 'GTBank', owner_telegram_id: ABDUL,
    },
  });
  const keptRow = [...accountRows()[0]];

  await controller.handleCallbackQuery(bot, cb('apg:dup:REQ-TWIN', JOHN));
  assert.equal(queueRows()[1][4], 'rejected');
  assert.equal(accountRows()[1][STATUS], 'inactive', 'the duplicate lets go');
  assert.deepEqual([...accountRows()[0]], keptRow, 'the request that is still open keeps its row as raised');
  assert.equal(queueRows()[0][0], keep);
  assert.equal(queueRows()[0][4], 'pending');

  // The number is still held — by the request that is still open.
  await register(bot);
  assert.match(lastTo(bot, ABDUL), /Already registered/);
  assert.match(lastTo(bot, ABDUL), /awaiting approval/);
  assert.equal(accountRows().length, 2);
});
