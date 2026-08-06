'use strict';

/**
 * CUS-ID1 — the guarded one-off that un-shares the four collided customer
 * ids (owner-commissioned 06-Aug-2026, from their sheet export).
 *
 * The stakes: this rewrites identity keys under money history. So most of
 * these tests are about what the repair REFUSES to do — a sheet that no
 * longer matches the export triple is hands-off, and a ledger narration
 * naming nobody in the group is never guessed onto a customer.
 */

process.env.ADMIN_IDS = '777';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '..', '..', '..', 'src');
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const auditLogRepository = require(path.join(SRC, 'repositories/auditLogRepository'));
const repairSvc = require(path.join(SRC, 'services/customerIdRepair'));

function cust(rowIndex, id, name, createdAt) {
  return { rowIndex, customer_id: id, name, created_at: createdAt, status: 'Active' };
}

/** Every colliding row exactly as the owner's export shows them. */
const EXPORT_REST = [
  cust(3, 'CUST-20260301-001', 'testcustomer', '2026-03-01T11:12:08.625Z'),
  cust(5, 'CUST-20260301-001', 'Alhaji Karimullah', '2026-03-01T15:14:08.876Z'),
  cust(6, 'CUST-20260301-001', 'Alhaji Ahmad', '2026-03-01T22:18:12.150Z'),
  cust(8, 'CUST-20260302-002', 'mama kafaya', '2026-03-02T12:13:05.318Z'),
  cust(13, 'CUST-20260302-002', 'keyus', '2026-03-02T20:27:26.211Z'),
  cust(20, 'CUST-20260312-001', 'soldier madam', '2026-03-12T15:09:59.019Z'),
  cust(22, 'CUST-20260312-001', 'testC', '2026-03-12T18:27:30.532Z'),
  cust(23, 'CUST-20260312-001', 'testD', '2026-03-12T18:45:04.772Z'),
  cust(24, 'CUST-20260312-001', 'custE', '2026-03-12T18:56:45.438Z'),
];
const EXPORT_302 = [
  cust(7, 'CUST-20260302-001', 'Christ', '2026-03-02T12:10:22.759Z'),
  cust(12, 'CUST-20260302-001', 'oshodi madam', '2026-03-02T20:08:15.561Z'),
  cust(14, 'CUST-20260302-001', 'madam oshodi cashmere', '2026-03-02T20:54:44.646Z'),
  cust(15, 'CUST-20260302-001', 'CJE', '2026-03-02T21:36:18.685Z'),
  cust(16, 'CUST-20260302-001', 'Karimullah', '2026-03-02T23:07:31.676Z'),
];

function harness({ customers, ledgerRows = [], invoiceRows = [] }) {
  const writes = [];
  customersRepository.getAll = async () => customers;
  sheets.readRange = async (sheet) => (sheet === 'Ledger_Entries' ? ledgerRows : invoiceRows);
  sheets.updateRange = async (sheet, range, values) => { writes.push({ sheet, range, value: values[0][0] }); };
  auditLogRepository.append = async () => {};
  return writes;
}

test('re-keys exactly the exported rows — keeper untouched, ids deterministic', async () => {
  const writes = harness({ customers: [...EXPORT_302, ...EXPORT_REST] });
  const res = await repairSvc._internals.rekeyCustomers();
  assert.equal(res.skipped.length, 0);
  const byRange = new Map(writes.map((w) => [w.range, w.value]));
  assert.equal(byRange.get('A12'), 'CUST-20260302-R01', 'oshodi madam');
  assert.equal(byRange.get('A14'), 'CUST-20260302-R02', 'madam oshodi cashmere');
  assert.equal(byRange.get('A15'), 'CUST-20260302-R03', 'CJE');
  assert.equal(byRange.get('A16'), 'CUST-20260302-R04', 'Karimullah');
  assert.ok(!byRange.has('A7'), 'Christ (the oldest row) keeps the original id');
});

test('REFUSES a row whose name or created_at no longer matches the export', async () => {
  const drifted = EXPORT_302.map((c) => ({ ...c }));
  drifted[3].created_at = '2026-03-02T21:36:18.999Z'; // CJE edited since the export
  const writes = harness({ customers: [...drifted, ...EXPORT_REST] });
  const res = await repairSvc._internals.rekeyCustomers();
  assert.ok(res.skipped.some((s) => s.startsWith('CJE:')), 'CJE skipped and reported');
  assert.ok(!writes.some((w) => w.range === 'A15'), 'the drifted row was not touched');
  assert.ok(writes.some((w) => w.range === 'A12'), 'the still-matching rows proceed');
});

test('is idempotent — a second run writes nothing', async () => {
  const after = [
    EXPORT_302[0],
    cust(12, 'CUST-20260302-R01', 'oshodi madam', '2026-03-02T20:08:15.561Z'),
    cust(14, 'CUST-20260302-R02', 'madam oshodi cashmere', '2026-03-02T20:54:44.646Z'),
    cust(15, 'CUST-20260302-R03', 'CJE', '2026-03-02T21:36:18.685Z'),
    cust(16, 'CUST-20260302-R04', 'Karimullah', '2026-03-02T23:07:31.676Z'),
  ];
  const restDone = EXPORT_REST.map((c) => {
    const map = {
      'Alhaji Karimullah': 'CUST-20260301-R01', 'Alhaji Ahmad': 'CUST-20260301-R02',
      keyus: 'CUST-20260302-R05', testC: 'CUST-20260312-R01',
      testD: 'CUST-20260312-R02', custE: 'CUST-20260312-R03',
    };
    return map[c.name] ? { ...c, customer_id: map[c.name] } : c;
  });
  const writes = harness({ customers: [...after, ...restDone] });
  const res = await repairSvc._internals.rekeyCustomers();
  assert.equal(writes.length, 0);
  assert.equal(res.rekeyed.length, 0);
  assert.equal(res.skipped.length, 0, 'done rows are silent, not warnings');
});

test('ledger entries re-file by narration name; the keeper’s stay put; strangers are never guessed', async () => {
  // K (index 10) is the stamped customer_id; H (index 7) the narration.
  const L = (narr, k) => ['e', 't', 'd', '1100', 'Customer Receivable', '100', '', narr, 'u', 'ts', k];
  const writes = harness({
    customers: [...EXPORT_302, ...EXPORT_REST],
    ledgerRows: [
      L('Sale: 4 thans 9037 to CJE | cash', 'CUST-20260302-001'),          // row 2 → R03
      L('Sale: 2 thans 9060 to Christ | bank', 'CUST-20260302-001'),        // row 3 → keeper, untouched
      L('Payment received from Karimullah: bank', 'CUST-20260302-001'),     // row 4 → R04
      L('Sale: 1 than 9043 to Alhaja oshodi | cash', 'CUST-20260302-001'),  // row 5 → NOT in group → untouched
      L('Opening balance adjustment', 'CUST-20260302-001'),                 // row 6 → unparseable → untouched
      L('Sale: 4 thans 9037 to CJE | cash', 'CUST-20260406-001'),           // row 7 → different id → untouched
    ],
  });
  const res = await repairSvc._internals.restampLedger();
  const ledgerWrites = writes.filter((w) => w.sheet === 'Ledger_Entries');
  assert.deepEqual(ledgerWrites.map((w) => [w.range, w.value]),
    [['K2', 'CUST-20260302-R03'], ['K4', 'CUST-20260302-R04']]);
  assert.equal(res.restamped, 2);
  assert.equal(res.unattributed.length, 2, 'the stranger and the memo are reported, not guessed');
});

test('invoices re-stamp by their own customer_name column', async () => {
  const writes = harness({
    customers: [...EXPORT_302, ...EXPORT_REST],
    invoiceRows: [
      ['INV-2026-0016', 'tok', 'req', 'CUST-20260302-001', 'CJE'],
      ['INV-2026-0002', 'tok', 'req', 'CUST-20260302-001', 'Christ'],
      ['INV-2026-0003', 'tok', 'req', 'CUST-20260724-001', 'Papa'],
    ],
  });
  const res = await repairSvc._internals.restampInvoices();
  const w = writes.filter((x) => x.sheet === 'Invoices');
  assert.deepEqual(w.map((x) => [x.range, x.value]), [['D2', 'CUST-20260302-R03']]);
  assert.equal(res.restamped, 1);
});

test('the new customer ids can never collide across restarts', () => {
  const idGen = require(path.join(SRC, 'utils/idGenerator'));
  const seen = new Set();
  for (let i = 0; i < 500; i += 1) seen.add(idGen.customer());
  assert.equal(seen.size, 500, 'random suffix — restart cannot re-mint an id');
  assert.match(idGen.customer(), /^CUST-\d{8}-[A-Z0-9]{4}$/);
});
