'use strict';

/**
 * RMV-1 Phase A (owner, 16-Aug-2026) — "inactive" means one thing.
 *
 * The removal impact analysis found four hide-rules in force that disagreed
 * with each other, which is what made a "removal" cosmetic: whichever word
 * was written, some surfaces hid the person and the ones that mattered did
 * not. The owner's ruling was to reuse the word that already exists rather
 * than invent one, and to make every reader agree on it.
 *
 * Pinned here:
 *  - the two customer hide-lists agree that 'inactive' is hidden;
 *  - name lookup stops matching a removed customer, which is what closes
 *    the sale-target, outstanding-balance and node-resurrection paths;
 *  - the readings are case- and whitespace-insensitive, because the cells
 *    are hand-edited ('Inactive' must not read as live);
 *  - a BLANK status still means active — the shipped behaviour that rows
 *    in the sheet rely on;
 *  - a removed person's phone stops blocking re-registration;
 *  - history-derived customer chips drop removed names, while the history
 *    itself is never rewritten (§12).
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const customerEntity = require('../../../src/services/customerEntity');
const customersRepository = require('../../../src/repositories/customersRepository');
const contactsRepository = require('../../../src/repositories/contactsRepository');

/* ── the vocabulary itself ── */

const sheets = require('../../../src/repositories/sheetsClient');

/**
 * Both repos cache behind `sheetsClient.readRange`, and their own lookups
 * call their module-local getAll — so the honest seam for a repo test is
 * readRange itself. Columns follow each repo's documented order.
 */
function withCustomerRows(rows, fn) {
  const realRead = sheets.readRange;
  // Customers A:M — A id, B name, ... J status, M aliases
  sheets.readRange = async (sheet) => {
    if (sheet !== customersRepository.SHEET) return [];
    return rows.map((c) => {
      const r = new Array(13).fill('');
      r[0] = c.customer_id; r[1] = c.name; r[9] = c.status;
      r[12] = (c.aliases || []).join(',');
      return r;
    });
  };
  customersRepository.invalidateCache();
  return Promise.resolve(fn()).finally(() => {
    sheets.readRange = realRead;
    customersRepository.invalidateCache();
  });
}

test('both customer hide-lists hide "inactive" — they used to disagree', async () => {
  const hidden = customerEntity._internals.HIDDEN_STATUSES;
  assert.ok(hidden.has('inactive'), 'customerEntity hides inactive');

  // customersRepository keeps its husk set private, so pin the BEHAVIOUR it
  // drives rather than the constant: merged and rejected stay husks (CUS-2)
  // and inactive joins them (the gap RMV-1 closed).
  await withCustomerRows([
    { customer_id: 'C1', name: 'Merged One', status: 'Merged' },
    { customer_id: 'C2', name: 'Rejected One', status: 'Rejected' },
    { customer_id: 'C3', name: 'Removed One', status: 'inactive' },
    { customer_id: 'C4', name: 'Live One', status: 'Active' },
  ], async () => {
    assert.equal(await customersRepository.findByName('Merged One'), null, 'CUS-2 husk untouched');
    assert.equal(await customersRepository.findByName('Rejected One'), null, 'CUS-2 husk untouched');
    assert.equal(await customersRepository.findByName('Removed One'), null, 'inactive is a husk now');
    assert.ok(await customersRepository.findByName('Live One'), 'a live customer still resolves');
  });
});

test('the contact reading of "gone" is case- and whitespace-insensitive, and blank means live', () => {
  const { isInactive } = contactsRepository;
  assert.equal(isInactive({ status: 'inactive' }), true);
  assert.equal(isInactive({ status: 'Inactive' }), true, 'a hand edit must not read as live');
  assert.equal(isInactive({ status: '  INACTIVE ' }), true);
  assert.equal(isInactive({ status: 'active' }), false);
  assert.equal(isInactive({ status: '' }), false, 'blank is live — shipped behaviour');
  assert.equal(isInactive({}), false);
  assert.equal(isInactive(null), false);
});

/* ── what the vocabulary now closes ── */

test('a removed customer stops resolving by name — the sale-target and money paths close with it', async () => {
  await withCustomerRows([
    { customer_id: 'AFP-C-1', name: 'Live Buyer', status: 'Active' },
    { customer_id: 'AFP-C-2', name: 'Gone Buyer', status: 'inactive' },
    { customer_id: 'AFP-C-3', name: 'Shouty Gone', status: 'Inactive' },
  ], async () => {
    assert.ok(await customersRepository.findByName('Live Buyer'), 'a live customer still resolves');
    assert.equal(await customersRepository.findByName('Gone Buyer'), null,
      'a removed customer no longer matches by name');
    assert.equal(await customersRepository.findByName('Shouty Gone'), null,
      'and a capitalised status does not slip through');

    const hits = await customersRepository.searchByName('buyer');
    assert.deepEqual(hits.map((c) => c.name), ['Live Buyer'],
      'pickers fed by searchByName stop offering the removed customer');
  });
});

test('a removed person’s phone stops blocking that number for everyone else', async () => {
  const realRead = sheets.readRange;
  // Contacts A:L — A id, B name, C phone, H whatsapp, J status
  const rows = [
    ['CON-1', 'Gone Person', '+2348012345678', 'other', '', '', '', '', '', 'inactive', '', ''],
    ['CON-2', 'Live Person', '+2348099999999', 'other', '', '', '', '', '', 'active', '', ''],
  ];
  sheets.readRange = async (sheet) => (sheet === contactsRepository.SHEET ? rows : []);
  contactsRepository.invalidateCache();
  try {
    assert.equal(await contactsRepository.findByPhone('+2348012345678'), null,
      'the removed node no longer claims the number — the SIM can be re-registered');
    const live = await contactsRepository.findByPhone('+2348099999999');
    assert.equal(live && live.name, 'Live Person', 'a live duplicate is still caught');
  } finally {
    sheets.readRange = realRead;
    contactsRepository.invalidateCache();
  }
});

test('history-derived customer chips drop removed names, without touching history', async () => {
  const transactionsRepository = require('../../../src/repositories/transactionsRepository');
  const sheets = require('../../../src/repositories/sheetsClient');

  const realRead = sheets.readRange;
  const realEnsure = transactionsRepository.ensureHeader;
  const realCustGetAll = customersRepository.getAll;

  const invRows = [];
  // design at index 3, status index 7, soldTo index 11
  const row = (design, soldTo) => { const r = new Array(16).fill(''); r[3] = design; r[7] = 'sold'; r[11] = soldTo; return r; };
  invRows.push(row('9037', 'Live Buyer'), row('9037', 'Gone Buyer'));

  sheets.readRange = async (sheet) => (sheet === 'Inventory' ? invRows : []);
  transactionsRepository.ensureHeader = async () => {};
  customersRepository.getAll = async () => ([
    { customer_id: 'AFP-C-1', name: 'Live Buyer', status: 'Active', aliases: [] },
    { customer_id: 'AFP-C-2', name: 'Gone Buyer', status: 'inactive', aliases: [] },
  ]);

  try {
    const names = await transactionsRepository.getCustomersByDesign('9037');
    assert.deepEqual(names, ['Live Buyer'],
      'the removed buyer is no longer one tap from a fresh sale');
    // The source rows are untouched — §12 forbids rewriting sold history.
    assert.equal(invRows.length, 2, 'both history rows still exist');
    assert.equal(invRows[1][11], 'Gone Buyer', 'the sold row still names who actually bought it');
  } finally {
    sheets.readRange = realRead;
    transactionsRepository.ensureHeader = realEnsure;
    customersRepository.getAll = realCustGetAll;
  }
});

test('an unreadable customer register degrades to the old behaviour, never to an empty picker', async () => {
  const transactionsRepository = require('../../../src/repositories/transactionsRepository');
  const sheets = require('../../../src/repositories/sheetsClient');

  const realRead = sheets.readRange;
  const realEnsure = transactionsRepository.ensureHeader;
  const realCustGetAll = customersRepository.getAll;

  const r = new Array(16).fill(''); r[3] = '9037'; r[7] = 'sold'; r[11] = 'Some Buyer';
  sheets.readRange = async (sheet) => (sheet === 'Inventory' ? [r] : []);
  transactionsRepository.ensureHeader = async () => {};
  customersRepository.getAll = async () => { throw new Error('Sheets down'); };

  try {
    const names = await transactionsRepository.getCustomersByDesign('9037');
    assert.deepEqual(names, ['Some Buyer'],
      'a failed read must not silently empty the picker (INV-HDR2 rule)');
  } finally {
    sheets.readRange = realRead;
    transactionsRepository.ensureHeader = realEnsure;
    customersRepository.getAll = realCustGetAll;
  }
});
