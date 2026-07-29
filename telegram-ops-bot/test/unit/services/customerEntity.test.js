'use strict';

/**
 * CUS-1 Phase A — the customer entity resolver.
 *
 * The core promises: id is the key, names are labels, aliases resolve READS
 * to the canonical customer, and pickers can only ever see clean rows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const ROOT = path.join(__dirname, '../../..');
const customersRepository = require(path.join(ROOT, 'src/repositories/customersRepository'));
const entity = require(path.join(ROOT, 'src/services/customerEntity'));

const ROWS = [
  { rowIndex: 2, customer_id: 'CUST-1', name: 'CJE', phone: '08012345678', status: 'Active', aliases: ['C.J.E', 'CJE STORES'] },
  { rowIndex: 3, customer_id: 'CUST-2', name: 'Ketu madam', phone: '08087654321', status: 'Active', aliases: [] },
  { rowIndex: 4, customer_id: 'CUST-3', name: 'C.J.E', phone: '', status: 'Merged', aliases: [] },
  { rowIndex: 5, customer_id: 'CUST-4', name: 'OKESON STORES', phone: '', status: 'Pending', aliases: [] },
  { rowIndex: 6, customer_id: 'CUST-5', name: 'Old Timer', phone: '', status: 'Inactive', aliases: [] },
];
customersRepository.getAll = async () => ROWS.map((r) => ({ ...r }));

test('resolves by id first, exactly', async () => {
  const c = await entity.resolve({ id: 'CUST-2' });
  assert.equal(c.name, 'Ketu madam');
});

test('resolves a canonical name case-insensitively', async () => {
  const c = await entity.resolve({ name: '  cje ' });
  assert.equal(c.customer_id, 'CUST-1');
});

test('an ALIAS resolves to the canonical customer — merged history finds its owner', async () => {
  const c = await entity.resolve({ name: 'c.j.e' });
  assert.equal(c.customer_id, 'CUST-1', 'the typo spelling lands on the real CJE, not the Merged row');
});

test('activeList hides Merged, Pending AND Inactive — the picker leak is closed', async () => {
  const list = await entity.activeList();
  assert.deepEqual(list.map((c) => c.customer_id).sort(), ['CUST-1', 'CUST-2'],
    'Pending rows used to appear in pickers; they must not');
});

test('search matches aliases too', async () => {
  const hits = await entity.search('stores');
  assert.deepEqual(hits.map((c) => c.customer_id), ['CUST-1'],
    'CJE found via its "CJE STORES" alias; Pending OKESON STORES excluded');
});

test('namesFor returns every spelling history may be filed under', () => {
  assert.deepEqual(entity.namesFor(ROWS[0]), ['CJE', 'C.J.E', 'CJE STORES']);
});

test('assertNameFree refuses names that collide with a name OR an alias', async () => {
  assert.equal((await entity.assertNameFree('cje stores')).ok, false, 'alias collision');
  assert.equal((await entity.assertNameFree('Brand New Buyer')).ok, true);
});

test('labelFor disambiguates duplicate display names with the phone tail', () => {
  const dupes = [
    { customer_id: 'A', name: 'Alhaji Musa', phone: '08011112222' },
    { customer_id: 'B', name: 'Alhaji Musa', phone: '08033334444' },
  ];
  assert.equal(entity.labelFor(dupes[0], dupes), 'Alhaji Musa (…2222)');
  assert.equal(entity.labelFor(ROWS[1], ROWS), 'Ketu madam', 'unique names stay clean');
});

test('mergeInto folds the typo into the canonical and hides it', async () => {
  const writes = [];
  customersRepository.updateRow = async (id, fields) => { writes.push({ id, fields }); return true; };
  const r = await entity.mergeInto('CUST-2', 'CUST-4');
  assert.equal(r.ok, true);
  assert.deepEqual(writes[0], { id: 'CUST-2', fields: { aliases: ['OKESON STORES'] } });
  assert.equal(writes[1].id, 'CUST-4');
  assert.equal(writes[1].fields.status, 'Merged');
  assert.match(writes[1].fields.notes, /Merged into Ketu madam/);
});

test('mergeInto refuses self-merge and re-merge', async () => {
  assert.equal((await entity.mergeInto('CUST-1', 'CUST-1')).reason, 'same_customer');
  assert.equal((await entity.mergeInto('CUST-1', 'CUST-3')).reason, 'already_merged');
});
