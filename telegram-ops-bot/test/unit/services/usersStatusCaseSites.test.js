'use strict';

/**
 * FIX-SETTINGS2 — the Users sheet `status` (and, in the attendance audience,
 * `role`) compared trimmed and lower-cased everywhere, as auth does.
 *
 * auth.refresh normalises, so a Users row whose status cell reads `Active`
 * can use the bot. Outside attendance and Sales Access the cell was still
 * compared letter for letter, so that same person:
 *   - got no stage-1 Dispatch card (usersRepository.findByDepartment);
 *   - was not the finance seat (paymentService.financeHead);
 *   - was missing from the "Who sold it?" chips, the task-assignee lists,
 *     the transfer people pickers, Change Role, Promote / Deactivate;
 *   - could be onboarded a second time, and could not be promoted.
 * An `Inactive` row stays out everywhere; a blank cell stays active.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const { createFakeBot } = require(path.join(__dirname, '..', '..', 'helpers', 'fakeBot'));
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const sessionStore = require(path.join(SRC, 'utils/sessionStore'));

const ADMIN = '777';

/* ── stubs restored after every test ── */
const undo = [];
function stub(obj, name, fn) {
  const had = Object.prototype.hasOwnProperty.call(obj, name);
  const orig = obj[name];
  obj[name] = fn;
  undo.push(() => { if (had) obj[name] = orig; else delete obj[name]; });
}
test.afterEach(() => {
  while (undo.length) undo.pop()();
  usersRepository.invalidateCache();
  sessionStore.clear(ADMIN);
});

const user = (user_id, name, status, departments = [], extra = {}) => ({
  user_id: String(user_id), name, role: 'employee', status,
  departments, department: departments[0] || '', warehouses: [], ...extra,
});

/** Users rows as the sheet returns them (A..L). */
const sheetRow = (id, name, status, dept, role = 'employee', whs = '') =>
  [id, name, role, 'Lagos', 'branch_only', status, '', dept, whs, '', '', ''];

function seedUsersSheet(rows) {
  stub(sheets, 'readRange', async (sheet) => (sheet === 'Users' ? rows.map((r) => [...r]) : []));
  usersRepository.invalidateCache();
}

const q = (data, uid = ADMIN) => ({ id: 'q', data, from: { id: uid }, message: { chat: { id: uid }, message_id: 12 } });
function lastScreen(bot) {
  const c = bot.calls.filter((x) => ['sendMessage', 'editMessageText', 'editMessageCaption', 'sendPhoto'].includes(x.method));
  return c[c.length - 1];
}
const lastText = (bot) => { const c = lastScreen(bot); return String((c && (c.args.text || c.args.caption)) || ''); };
function lastCallbacks(bot) {
  const c = lastScreen(bot);
  const kb = c && c.args.opts && c.args.opts.reply_markup;
  return kb && kb.inline_keyboard ? kb.inline_keyboard.flat().map((b) => b.callback_data) : [];
}

/* ── the repository ─────────────────────────────────────────────────── */

test('findByDepartment: a Dispatch person whose status reads `Active` is returned; `Inactive` is not', async () => {
  seedUsersSheet([
    sheetRow('4343', 'Musa', 'Active', 'Dispatch'),
    sheetRow('4444', 'Bello', ' ACTIVE ', 'Sales,Dispatch'),
    sheetRow('4545', 'Old hand', 'Inactive', 'Dispatch'),
    sheetRow('4646', 'Blank', '', 'Dispatch'),
    sheetRow('4747', 'Ajeet', 'active', 'Sales'),
    sheetRow('4848', 'Left', 'inactive', 'Dispatch'),
  ]);
  const got = await usersRepository.findByDepartment('Dispatch');
  assert.deepEqual(got.map((u) => u.user_id), ['4343', '4444', '4646']);
  assert.deepEqual((await usersRepository.findByDepartment('dispatch')).map((u) => u.user_id), ['4343', '4444', '4646']);
});

test('findByUserId: with two rows for one id the ACTIVE one wins, however the cell spells it', async () => {
  seedUsersSheet([
    sheetRow('5000', 'Live row', 'Active', 'Sales'),
    sheetRow('5000', 'Stale row', 'inactive', 'Sales'),
    sheetRow('6000', 'Gone 1', 'Inactive', 'Sales'),
    sheetRow('6000', 'Gone 2', 'inactive', 'Sales'),
  ]);
  assert.equal((await usersRepository.findByUserId('5000')).name, 'Live row', 'it used to return the stale last row');
  assert.equal((await usersRepository.findByUserId('6000')).name, 'Gone 2', 'no active row: still the most recent one');
  assert.equal(await usersRepository.findByUserId('9999'), null);
});

/* ── services ───────────────────────────────────────────────────────── */

test('financeHead: the one Finance person is the seat when their status reads `Active`', async () => {
  const paymentService = require(path.join(SRC, 'services/paymentService'));
  stub(usersRepository, 'getAll', async () => [
    user('9001', 'Office phone', 'Active', ['Finance']),
    user('9002', 'Old cashier', 'Inactive', ['Finance']),
    user('9003', 'Ajeet', 'active', ['Sales']),
  ]);
  const head = await paymentService.financeHead();
  assert.deepEqual(head, { ok: true, telegramId: '9001', name: 'Office phone', reason: '', members: 1 });
});

test('"Who sold it?" chips: an `Active` Sales person is offered, and Me uses the active row', () => {
  const chips = require(path.join(SRC, 'services/salespersonChips'));
  const users = [
    user('4242', 'Old Abdul', 'inactive', ['Sales']),
    user('4242', 'Abdul', 'Active', ['Sales']),
    user('5555', 'Aisha', ' ACTIVE ', ['Sales']),
    user('6666', 'Yusuf', 'active', ['Sales']),
    user('7777', 'Gone', 'Inactive', ['Sales']),
  ];
  const rows = chips.buildSalespersonRows({ submitterId: '4242', users, adminIds: [ADMIN] });
  assert.deepEqual(rows.flat().map((b) => b.callback_data),
    ['srf_sp:Abdul', 'srf_sp:Customer direct', 'srf_sp:Aisha', 'srf_sp:Yusuf']);
  assert.equal(rows[0][0].text, '🙋 Me · Abdul');
});

test('task assignees (deptGraph.listAssignableUsers): `Active` people are assignable, `Inactive` are not', () => {
  const deptGraph = require(path.join(SRC, 'org/deptGraph'));
  const all = [
    user('1', 'Abdul', 'Active', ['Sales']), user('2', 'Musa', ' ACTIVE ', ['Dispatch']),
    user('3', 'Fatima', 'active', ['Sales']), user('4', 'Blank', '', ['Sales']),
    user('5', 'Gone', 'Inactive', ['Sales']), user('6', 'Left', 'inactive', ['Sales']),
  ];
  const { graph } = deptGraph.validateForest([]);
  const got = deptGraph.listAssignableUsers(user(ADMIN, 'Boss', 'active'), all, graph, { isAdmin: true });
  assert.deepEqual(got.map((u) => u.user_id), ['1', '2', '3', '4']);
});

test('transfer people picker: an `Active` person attached to the store is a candidate', async () => {
  const transferFlow = require(path.join(SRC, 'flows/transferFlow'));
  stub(usersRepository, 'getAll', async () => [
    user('1', 'Musa', 'Active', ['Dispatch'], { warehouses: ['IDUMOTA'] }),
    user('2', 'Bello', 'active', ['Dispatch'], { warehouses: ['IDUMOTA'] }),
    user('3', 'Gone', 'Inactive', ['Dispatch'], { warehouses: ['IDUMOTA'] }),
    user('4', 'Kano man', 'Active', ['Dispatch'], { warehouses: ['Kano office'] }),
  ]);
  const { candidatesFor } = transferFlow._internals;
  assert.deepEqual((await candidatesFor('IDUMOTA')).map((u) => u.user_id), ['1', '2']);
  // No one attached → every active employee / manager, the `Active` ones included.
  assert.deepEqual((await candidatesFor('Ketu')).map((u) => u.user_id), ['1', '2', '4']);
});

test('display units: a manager whose status reads `Active` may raise the request', async () => {
  const unitDisplayFlow = require(path.join(SRC, 'flows/unitDisplayFlow'));
  const rows = {
    8001: user('8001', 'Kabir', 'Active', ['Sales'], { role: 'Manager' }),
    8002: user('8002', 'Gone', 'Inactive', ['Sales'], { role: 'manager' }),
    8003: user('8003', 'Staff', 'Active', ['Sales'], { role: 'employee' }),
  };
  stub(usersRepository, 'findByUserId', async (id) => rows[id] || null);
  const { canRequest } = unitDisplayFlow._internals;
  assert.equal(await canRequest('8001'), true);
  assert.equal(await canRequest('8002'), false, 'an inactive manager still may not');
  assert.equal(await canRequest('8003'), false, 'an employee still may not');
});

/* ── onboarding and role doors ──────────────────────────────────────── */

test('Add Employee: someone already on the Users sheet as `Active` is not offered again, and their id is refused', async () => {
  const userAddFlow = require(path.join(SRC, 'flows/userAddFlow'));
  const pendingUsersRepo = require(path.join(SRC, 'repositories/pendingUsersRepository'));
  const live = user('12345678', 'Abdul', 'Active', ['Sales']);
  stub(pendingUsersRepo, 'getAll', async () => [
    { telegram_id: '12345678', first_name: 'Abdul', status: 'pending', arrived_at: '2026-11-01T08:00:00Z' },
    { telegram_id: '87654321', first_name: 'New', status: 'pending', arrived_at: '2026-11-02T08:00:00Z' },
  ]);
  stub(pendingUsersRepo, 'findByTelegramId', async (id) => ({ telegram_id: String(id), first_name: 'Abdul', status: 'pending' }));
  stub(usersRepository, 'getAll', async () => [live]);
  stub(usersRepository, 'findByUserId', async (id) => (String(id) === live.user_id ? live : null));

  const pend = await userAddFlow._internals.loadPendingCandidates();
  assert.deepEqual(pend.map((p) => p.telegram_id), ['87654321'], 'the live `Active` user is not a pending candidate');

  // Typed id of the live user.
  sessionStore.set(ADMIN, { type: 'user_add_flow', step: 'telegram_id', flowMessageId: 12, data: {} });
  const bot = createFakeBot();
  assert.equal(await userAddFlow.handleText(bot, { from: { id: ADMIN }, chat: { id: ADMIN }, text: '12345678' }), true);
  assert.match(lastText(bot), /Telegram ID `12345678` is already an active user \(\*Abdul\*\)/);
  assert.equal(sessionStore.get(ADMIN).step, 'telegram_id', 'the flow does not move on');

  // The same person tapped from a stale pending list.
  const bot2 = createFakeBot();
  await userAddFlow.handleCallback(bot2, q('usr:pu:12345678'));
  assert.match(lastText(bot2), /`12345678` is already an active user \(\*Abdul\*\)/);
});

test('the add_user and promote_admin executors read `Active` as active', async () => {
  const inventoryService = require(path.join(SRC, 'services/inventoryService'));
  const approvalQueueRepository = require(path.join(SRC, 'repositories/approvalQueueRepository'));
  const departmentsRepository = require(path.join(SRC, 'repositories/departmentsRepository'));
  const pendingUserService = require(path.join(SRC, 'services/pendingUserService'));
  const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
  const auth = require(path.join(SRC, 'middlewares/auth'));
  const live = user('12345678', 'Live', 'Active', ['Sales']);
  const writes = [];
  let aj = { action: 'add_user', telegram_id: '12345678', name: 'Field Person', department: 'Sales', role: 'marketer', warehouses: ['Lagos'] };
  stub(approvalQueueRepository, 'getAllPending', async () => [{ requestId: 'R1', user: 'admin1', actionJSON: aj }]);
  stub(approvalQueueRepository, 'updateStatus', async () => {});
  stub(usersRepository, 'findByUserId', async () => live);
  stub(usersRepository, 'append', async (row) => { writes.push(['append', row]); });
  stub(usersRepository, 'reactivate', async (id) => { writes.push(['reactivate', id]); return true; });
  stub(usersRepository, 'updateRole', async (id, role) => { writes.push(['updateRole', id, role]); return true; });
  stub(departmentsRepository, 'findByName', async () => ({ dept_name: 'Sales' }));
  stub(departmentsRepository, 'append', async () => {});
  stub(pendingUserService, 'markOnboarded', async () => {});
  stub(auditLogRepository, 'append', async () => {});
  stub(auth, 'invalidate', async () => {});

  const added = await inventoryService.executeApprovedAction('R1', 'admin2', {});
  assert.equal(added.ok, false);
  assert.match(added.message, /Telegram ID 12345678 is already an active user \(Live\)/);
  assert.deepEqual(writes, [], 'the live row is neither overwritten nor duplicated');

  aj = { action: 'promote_admin', telegram_id: '12345678' };
  const promoted = await inventoryService.executeApprovedAction('R1', 'admin2', {});
  assert.equal(promoted.ok, true, 'it used to answer "is not an active user"');
  assert.deepEqual(writes, [['updateRole', '12345678', 'admin']]);
});

test('Change Role and Promote / Deactivate list an `Active` person; picking them is not "no longer active"', async () => {
  const roleEditFlow = require(path.join(SRC, 'flows/roleEditFlow'));
  const userManageFlow = require(path.join(SRC, 'flows/userManageFlow'));
  const people = [
    user('101', 'Aisha', 'Active', ['Sales']),
    user('102', 'Bola', ' ACTIVE ', ['Sales']),
    user('103', 'Gone', 'Inactive', ['Sales']),
  ];
  stub(usersRepository, 'getAll', async () => people.map((u) => ({ ...u })));
  stub(usersRepository, 'findByUserId', async (id) => people.find((u) => u.user_id === String(id)) || null);

  const bot = createFakeBot();
  await roleEditFlow.handleCallback(bot, q('rol:start'));
  const cbs = lastCallbacks(bot);
  assert.ok(cbs.includes('rol:pick:101') && cbs.includes('rol:pick:102'), 'both are listed');
  assert.ok(!cbs.includes('rol:pick:103'), 'the inactive row is not');
  await roleEditFlow.handleCallback(bot, q('rol:pick:101'));
  assert.ok(lastCallbacks(bot).includes('rol:set:101|manager'), 'the role buttons are shown');
  // Applying the role re-reads the row: `Active` must not read as "no longer active".
  const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
  const auth = require(path.join(SRC, 'middlewares/auth'));
  const roleWrites = [];
  stub(usersRepository, 'updateRole', async (id, role) => { roleWrites.push([String(id), role]); return true; });
  stub(auditLogRepository, 'append', async () => {});
  stub(auth, 'invalidate', () => {});
  await roleEditFlow.handleCallback(bot, q('rol:set:101|manager'));
  assert.doesNotMatch(lastText(bot), /no longer active/);
  assert.match(lastText(bot), /^✅ \*Role updated\*\n\n\*Aisha\* \(`101`\)\nemployee → \*manager\*/);
  assert.deepEqual(roleWrites, [['101', 'manager']]);
  sessionStore.clear(ADMIN);

  for (const which of ['promote', 'deactivate']) {
    const b = createFakeBot();
    await userManageFlow.handleCallback(b, q(`umg:start:${which}`));
    const list = lastCallbacks(b);
    assert.ok(list.includes('umg:pick:101') && list.includes('umg:pick:102'), `${which}: both are listed`);
    assert.ok(!list.includes('umg:pick:103'), `${which}: the inactive row is not`);
    sessionStore.clear(ADMIN);
  }
});

test('Snap Task: when the department tree cannot be read, the admin fallback still lists `Active` people', async () => {
  const snapTaskFlow = require(path.join(SRC, 'flows/snapTaskFlow'));
  const departmentsRepository = require(path.join(SRC, 'repositories/departmentsRepository'));
  const people = [
    user(ADMIN, 'Boss', 'active'), user('1', 'Abdul', 'Active', ['Sales']),
    user('2', 'Musa', 'active', ['Dispatch']), user('3', 'Gone', 'Inactive', ['Sales']),
  ];
  stub(usersRepository, 'getAll', async () => people);
  stub(usersRepository, 'findByUserId', async (id) => people.find((u) => u.user_id === String(id)) || null);
  stub(departmentsRepository, 'getAll', async () => { throw new Error('Departments unreadable'); });
  sessionStore.set(ADMIN, { type: snapTaskFlow.SESSION_TYPE, step: 'readback', note: { title: 'Count bale 771', lowConfidence: false } });
  await snapTaskFlow.handleCallback(createFakeBot(), q('ptk:use'));
  assert.deepEqual((sessionStore.get(ADMIN)._people || []).map((p) => p.id), ['1', '2']);
});

/* ── item 5: the attendance audience excludes admins whatever the case ── */

test('attendance audience: a sheet admin whose role reads `Admin` is excluded, like `admin`', async () => {
  const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
  const attendanceService = require(path.join(SRC, 'services/attendanceService'));
  stub(settingsRepository, 'getAll', async () => ({}));
  stub(usersRepository, 'getAll', async () => [
    user('4242', 'Abdul', 'active', ['Sales']),
    user('8801', 'Sheet admin', 'active', ['Management'], { role: 'Admin' }),
    user('8802', 'Shouting admin', 'Active', ['Management'], { role: 'ADMIN' }),
    user('8803', 'Lower admin', 'active', ['Management'], { role: 'admin' }),
    user(ADMIN, 'Railway admin', 'active', ['Management']),
    user('8804', 'Manager', 'active', ['Sales'], { role: 'Manager' }),
  ]);
  const audience = await attendanceService.getAudience();
  assert.deepEqual(audience.map((a) => a.user_id), ['4242', '8804'], 'admins do not clock in; a manager does');
  assert.equal(await attendanceService.isRequired('8801'), false);
});
