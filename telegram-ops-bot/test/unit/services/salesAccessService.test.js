'use strict';

/**
 * SSA-1 — salesAccessService: the one answer to "which places' sales may
 * this person see?" Admins: all. Others: the ticked places on their Users
 * row (column L). Nothing ticked = nothing (owner ruling 24-Sep-2026).
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242,5151';

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const svc = require(path.join(SRC, 'services/salesAccessService'));
const usersRepository = require(path.join(SRC, 'repositories/usersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const activityRegistry = require(path.join(SRC, 'services/activityRegistry'));

const USERS = {
  4242: { user_id: '4242', name: 'Abdul', status: 'active', store_sales_places: ['Kano office'] },
  5151: { user_id: '5151', name: 'Musa', status: 'active', store_sales_places: [] },
};
usersRepository.findByUserId = async (id) => USERS[id] || null;

function row(wh) { return { warehouse: wh, packageNo: '1', soldTo: 'X', soldDate: '2026-08-19' }; }

test('scopeOfUser: admin unscoped; a grant folds case and de-duplicates; blank = nothing', () => {
  assert.deepEqual(svc.scopeOfUser(null, true), { admin: true, keys: new Set(), places: [] });
  const s = svc.scopeOfUser({ store_sales_places: ['Kano office', ' KANO OFFICE ', 'Ketu', ''] }, false);
  assert.equal(s.admin, false);
  assert.deepEqual([...s.keys], ['KANO OFFICE', 'KETU']);
  assert.deepEqual(s.places, ['Kano office', 'Ketu']);
  assert.equal(svc.scopeOfUser({ store_sales_places: [] }, false).keys.size, 0);
  assert.equal(svc.scopeOfUser(null, false).keys.size, 0);
});

test('scopeFor: env admin → all; granted employee → their places; ungranted → nothing; a failing read → nothing', async () => {
  assert.equal((await svc.scopeFor('777')).admin, true);
  const abdul = await svc.scopeFor('4242');
  assert.equal(abdul.admin, false);
  assert.deepEqual([...abdul.keys], ['KANO OFFICE']);
  assert.equal((await svc.scopeFor('5151')).keys.size, 0);
  const saved = usersRepository.findByUserId;
  usersRepository.findByUserId = async () => { throw new Error('sheet down'); };
  try {
    const s = await svc.scopeFor('4242');
    assert.equal(s.admin, false);
    assert.equal(s.keys.size, 0, 'a failed read never widens to every place');
  } finally { usersRepository.findByUserId = saved; }
});

test('filterRows / rowInScope: identity for admins; case-folded place match otherwise', () => {
  const rows = [row('IDUMOTA'), row('kano office'), row(''), row('Ketu')];
  const admin = svc.scopeOfUser(null, true);
  assert.equal(svc.filterRows(rows, admin), rows);
  const kano = svc.scopeOfUser({ store_sales_places: ['Kano office'] }, false);
  assert.deepEqual(svc.filterRows(rows, kano).map((r) => r.warehouse), ['kano office']);
  assert.equal(svc.rowInScope(row(''), kano), false, 'a blank warehouse cell is never inside a grant');
});

test('adjustMenu: a grant adds both doors, no grant removes both even when a department CSV lists them; admins untouched', () => {
  const sbl = activityRegistry.getActivity('sold_bales_lookup');
  const sfs = activityRegistry.getActivity('store_sales');
  const other = activityRegistry.getActivity('my_orders');

  const granted = svc.adjustMenu(USERS[4242], false, [other], activityRegistry);
  assert.deepEqual(granted.map((a) => a.code), ['my_orders', 'store_sales', 'sold_bales_lookup']);
  // idempotent
  assert.equal(svc.adjustMenu(USERS[4242], false, granted, activityRegistry).length, 3);

  const none = svc.adjustMenu(USERS[5151], false, [sbl, other, sfs], activityRegistry);
  assert.deepEqual(none.map((a) => a.code), ['my_orders']);

  const admin = svc.adjustMenu(null, true, [other], activityRegistry);
  assert.deepEqual(admin.map((a) => a.code), ['my_orders']);
});

test('grant: writes column L, logs, DMs the person only when the grant changed', async () => {
  const writes = []; const audits = []; const dms = [];
  usersRepository.updateStoreSalesPlaces = async (id, places) => { writes.push([id, places]); return true; };
  auditLogRepository.append = async (type, payload, by) => { audits.push([type, payload, by]); };
  const bot = { sendMessage: async (id, text) => { dms.push([id, text]); } };

  let r = await svc.grant({ bot, adminId: '777', user: USERS[5151], places: ['Kano office', 'ketu'] });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.deepEqual(writes, [['5151', ['Kano office', 'ketu']]]);
  assert.equal(audits[0][0], 'sales_access_updated');
  assert.deepEqual(audits[0][1], { user_id: '5151', name: 'Musa', places: ['Kano office', 'ketu'], before: [] });
  assert.equal(audits[0][2], '777');
  assert.deepEqual(dms, [['5151', '🏬 You can now see the sales of Kano office, ketu.\nOpen 📊 Reporting → 🏬 Store Sales or 📒 Customer Supplies.']]);

  // Same places in another case: no change, no DM, still written (harmless).
  r = await svc.grant({ bot, adminId: '777', user: USERS[4242], places: ['KANO OFFICE'] });
  assert.deepEqual(r, { ok: true, changed: false });
  assert.equal(dms.length, 1);

  // Revoke.
  r = await svc.grant({ bot, adminId: '777', user: USERS[4242], places: [] });
  assert.deepEqual(r, { ok: true, changed: true });
  assert.deepEqual(dms[1], ['4242', '🏬 Your access to store sales has been removed.']);

  // A DM failure never fails the grant.
  const bot2 = { sendMessage: async () => { throw new Error('blocked'); } };
  r = await svc.grant({ bot: bot2, adminId: '777', user: USERS[5151], places: ['Ketu'] });
  assert.deepEqual(r, { ok: true, changed: true });

  // No Users row → not ok, nothing logged.
  usersRepository.updateStoreSalesPlaces = async () => false;
  const n = audits.length;
  r = await svc.grant({ bot, adminId: '777', user: { user_id: '9', name: 'Ghost', store_sales_places: [] }, places: ['Ketu'] });
  assert.deepEqual(r, { ok: false, changed: false });
  assert.equal(audits.length, n);
});
