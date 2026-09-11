'use strict';

/**
 * SRF-SP (owner, 11-Sep-2026) — the one salesperson chip set (§9b: the
 * seller is picked, the submitter offered first):
 *   row 1  🙋 Me · <name>   only when the submitter is an admin or in Sales
 *   row 2  👤 Customer direct — always, stored as exactly 'Customer direct'
 *   then   the Sales list without the submitter, capped at 6 + See All
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const chips = require('../../../src/services/salespersonChips');

const u = (user_id, name, departments = [], status = 'active') => ({ user_id: String(user_id), name, departments, department: departments[0] || '', status });

const SALES = [u(4242, 'Musa', ['Sales']), u(5555, 'Aisha', ['Sales']), u(6666, 'Yusuf', ['Sales', 'Dispatch'])];
const DISPATCH = u(4343, 'Bello', ['Dispatch']);
const INACTIVE = u(7777, 'Gone', ['Sales'], 'inactive');
const OWNER = u(777, 'Owner', []); // admin by id, no department

const flat = (rows) => rows.flat();
const values = (rows) => flat(rows).map((b) => b.callback_data);
const texts = (rows) => flat(rows).map((b) => b.text);

test('admin submitter with a Users row: Me · <name> first, Customer direct second, Sales list after', () => {
  const rows = chips.buildSalespersonRows({ submitterId: '777', users: [OWNER, ...SALES, DISPATCH, INACTIVE], adminIds: ['777'] });
  assert.deepEqual(rows[0], [{ text: '🙋 Me · Owner', callback_data: 'srf_sp:Owner' }]);
  assert.deepEqual(rows[1], [{ text: '👤 Customer direct', callback_data: 'srf_sp:Customer direct' }]);
  assert.deepEqual(values(rows).slice(2), ['srf_sp:Musa', 'srf_sp:Aisha', 'srf_sp:Yusuf'], 'Sales list follows, two per row');
  assert.equal(rows.length, 4, 'Me · Customer direct · Musa+Aisha · Yusuf');
  assert.ok(!values(rows).includes('srf_sp:Bello'), 'Dispatch-only user is not a seller');
  assert.ok(!values(rows).includes('srf_sp:Gone'), 'inactive Sales row is hidden');
});

test('admin submitter WITHOUT a Users row: Me · <id> (the label today\'s list would have shown)', () => {
  const rows = chips.buildSalespersonRows({ submitterId: 778, users: SALES, adminIds: ['777', '778'] });
  assert.deepEqual(rows[0], [{ text: '🙋 Me · 778', callback_data: 'srf_sp:778' }]);
  assert.equal(rows[1][0].callback_data, 'srf_sp:Customer direct');
});

test('Sales-department submitter: Me first, and never repeated in the list', () => {
  const rows = chips.buildSalespersonRows({ submitterId: '4242', users: [OWNER, ...SALES, DISPATCH], adminIds: ['777'] });
  assert.deepEqual(rows[0], [{ text: '🙋 Me · Musa', callback_data: 'srf_sp:Musa' }]);
  assert.equal(rows[1][0].callback_data, 'srf_sp:Customer direct');
  const list = values(rows).slice(2);
  assert.equal(list.filter((v) => v === 'srf_sp:Musa').length, 0, 'the submitter is on row 1 only');
  assert.deepEqual(list, ['srf_sp:Owner', 'srf_sp:Aisha', 'srf_sp:Yusuf'], 'admins stay in the list as today');
});

test('a submitter in another department: no Me chip; Customer direct is the first row', () => {
  const rows = chips.buildSalespersonRows({ submitterId: '4343', users: [OWNER, ...SALES, DISPATCH], adminIds: ['777'] });
  assert.deepEqual(rows[0], [{ text: '👤 Customer direct', callback_data: 'srf_sp:Customer direct' }]);
  assert.ok(!texts(rows).some((t) => t.startsWith('🙋 Me')), 'no Me chip');
  assert.ok(!values(rows).includes('srf_sp:Bello'), 'not in the list either');
});

test('a submitter whose only Sales row is inactive gets no Me chip', () => {
  const rows = chips.buildSalespersonRows({ submitterId: '7777', users: [INACTIVE, ...SALES], adminIds: [] });
  assert.equal(rows[0][0].callback_data, 'srf_sp:Customer direct');
});

test('Customer direct is always offered — even with no Sales users at all', () => {
  const rows = chips.buildSalespersonRows({ submitterId: '4343', users: [DISPATCH], adminIds: [] });
  assert.deepEqual(rows, [[{ text: '👤 Customer direct', callback_data: 'srf_sp:Customer direct' }]]);
  assert.equal(chips.CUSTOMER_DIRECT, 'Customer direct', 'the stored value is exactly this');
});

test('See All: more than 6 others → 6 shown + See All (n) counting the list, not the submitter', () => {
  const many = Array.from({ length: 8 }, (_, i) => u(9000 + i, `S${i}`, ['Sales']));
  const rows = chips.buildSalespersonRows({ submitterId: '4242', users: [u(4242, 'Musa', ['Sales']), ...many], adminIds: [] });
  const list = values(rows).slice(2);
  assert.deepEqual(list.slice(0, 6), ['srf_sp:S0', 'srf_sp:S1', 'srf_sp:S2', 'srf_sp:S3', 'srf_sp:S4', 'srf_sp:S5']);
  assert.deepEqual(rows[rows.length - 1], [{ text: '📋 See All (8)', callback_data: 'srf_sp:__more__' }]);
  assert.equal(chips.SEE_ALL, '__more__');
});

test('See All: exactly 6 others → no See All row; showAll lifts the cap', () => {
  const six = Array.from({ length: 6 }, (_, i) => u(9000 + i, `S${i}`, ['Sales']));
  const capped = chips.buildSalespersonRows({ submitterId: '4242', users: [u(4242, 'Musa', ['Sales']), ...six], adminIds: [] });
  assert.ok(!values(capped).includes('srf_sp:__more__'));
  const eight = [...six, u(9006, 'S6', ['Sales']), u(9007, 'S7', ['Sales'])];
  const all = chips.buildSalespersonRows({ submitterId: '4242', users: [u(4242, 'Musa', ['Sales']), ...eight], adminIds: [], showAll: true });
  assert.equal(values(all).slice(2).length, 8, 'every other seller shown');
  assert.ok(!values(all).includes('srf_sp:__more__'));
});

test('callbackPrefix is honoured on every chip; admin ids may be numbers or a Set', () => {
  const rows = chips.buildSalespersonRows({ submitterId: 777, users: [OWNER, SALES[0]], adminIds: new Set([777]), callbackPrefix: 'sb:sp:' });
  assert.deepEqual(values(rows), ['sb:sp:Owner', 'sb:sp:Customer direct', 'sb:sp:Musa']);
});

test('a re-onboarded submitter (inactive + active rows): the ACTIVE row names the Me chip', () => {
  const rows = chips.buildSalespersonRows({
    submitterId: '4242', users: [u(4242, 'Old Musa', ['Sales'], 'inactive'), u(4242, 'Musa', ['Sales'])], adminIds: [],
  });
  assert.equal(rows[0][0].text, '🙋 Me · Musa');
  assert.ok(!values(rows).includes('srf_sp:Old Musa'), 'neither row of theirs is in the list');
});

test('every payload stays inside Telegram\'s 64-byte cap for ordinary names', () => {
  const rows = chips.buildSalespersonRows({ submitterId: '777', users: [OWNER, ...SALES], adminIds: ['777'] });
  for (const v of values(rows)) assert.ok(Buffer.byteLength(v, 'utf8') <= 64, v);
  assert.equal(chips.HEADER, '🧑 Who sold it?');
});

test('empty inputs do not throw: no users, no admins → just Customer direct', () => {
  assert.deepEqual(chips.buildSalespersonRows({ submitterId: '1' }), [[{ text: '👤 Customer direct', callback_data: 'srf_sp:Customer direct' }]]);
  assert.deepEqual(chips.buildSalespersonRows(), [[{ text: '👤 Customer direct', callback_data: 'srf_sp:Customer direct' }]]);
});
