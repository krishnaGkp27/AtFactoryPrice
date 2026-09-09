'use strict';

/**
 * CUR-2 — the trailing `rate_multiplier` column (W) on Invoices.
 *
 * Pins the integrity arrangement the owner asked for on 09-Sep-2026: the
 * multiplier is stored SEPARATELY from the booked figures, the booked
 * figures on the sheet are never multiplied, blank = none (never `1`), and
 * a live sheet that already carries the 22 INV-1a columns is widened by
 * exactly one header cell — no data row, no existing header cell touched.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');

const fake = createFakeSheets({ Invoices: [] });
installFakeSheets(fake);
const setRows = (rows) => fake._store.set('Invoices', rows.map((r) => [...r]));
const rowsNow = () => fake._store.get('Invoices');

const repo = require(path.join(SRC, 'repositories/invoicesRepository'));

const OLD_HEADERS = [
  'invoice_no', 'token', 'request_id', 'customer_id', 'customer_name',
  'issue_date', 'sale_date', 'lines_json', 'subtotal', 'vat_rate',
  'vat_amount', 'total', 'amount_paid_at_issue', 'balance_after_issue',
  'payment_mode', 'bank', 'salesperson', 'warehouse', 'status',
  'pdf_drive_id', 'created_by', 'created_at',
];

const BASE_LINES = [
  { design: '202', shade: 'Navy', yards: 500, rate: 3.2, amount: 1600 },
  { design: '201', shade: 'Wine', yards: 25, rate: 3.2, amount: 80 },
];

function record(extra = {}) {
  return {
    invoiceNo: 'INV-2026-0007', token: 'tok7', requestId: 'REQ-7',
    customerId: 'C1', customerName: 'ABBA',
    issueDate: '2026-09-09', saleDate: '2026-09-09',
    lines: BASE_LINES, subtotal: 1680, vatRate: 0, vatAmount: 0, total: 1680,
    amountPaidAtIssue: 400, balanceAfterIssue: 1280,
    paymentMode: 'transfer', bank: 'Zenith', salesperson: 'Emin', warehouse: 'Lagos',
    status: 'issued', pdfDriveId: '', createdBy: 'admin-1', createdAt: '2026-09-09T10:00:00.000Z',
    ...extra,
  };
}

test('HEADERS: rate_multiplier is the LAST column and nothing before it moved', () => {
  assert.equal(repo.HEADERS.length, OLD_HEADERS.length + 1);
  assert.deepEqual(repo.HEADERS.slice(0, OLD_HEADERS.length), OLD_HEADERS, 'rule 4: no rename, no reorder');
  assert.equal(repo.HEADERS[repo.HEADERS.length - 1], 'rate_multiplier');
});

test('ensureHeader widens a 22-column live sheet by ONE cell and touches nothing else', async () => {
  repo._resetHeaderGuard();
  const dataRow = [...OLD_HEADERS.map((_, i) => `v${i}`)];
  setRows([OLD_HEADERS, dataRow]);
  await repo.ensureHeader();
  const head = rowsNow()[0];
  assert.equal(head.length, 23, 'a 22-column sheet must be widened, not judged complete');
  assert.equal(head[22], 'rate_multiplier');
  assert.deepEqual(head.slice(0, 22), OLD_HEADERS, 'existing header cells untouched');
  assert.deepEqual(rowsNow()[1], dataRow, 'data rows untouched');
  assert.equal(rowsNow().length, 2, 'no row appended by the heal');
});

test('ensureHeader writes the full header on an empty sheet and is a no-op on a complete one', async () => {
  repo._resetHeaderGuard();
  setRows([]);
  await repo.ensureHeader();
  assert.deepEqual(rowsNow()[0], repo.HEADERS);

  repo._resetHeaderGuard();
  const before = rowsNow().map((r) => [...r]);
  await repo.ensureHeader();
  assert.deepEqual(rowsNow(), before, 'complete header → nothing written');
});

test('append: the sheet row never carries a multiplied figure; the multiplier sits alone in W', async () => {
  repo._resetHeaderGuard();
  setRows([repo.HEADERS]);
  await repo.append(record({ rateMultiplier: 1250 }));
  const row = rowsNow()[1];
  assert.equal(row.length, 23);
  assert.equal(row[22], 1250, 'W = the multiplier in force at issue');
  // Booked (variable-1) figures — exactly what was entered, never × 1,250.
  assert.deepEqual(JSON.parse(row[7]), BASE_LINES, 'lines_json stays base');
  assert.equal(row[8], 1680, 'subtotal stays base');
  assert.equal(row[11], 1680, 'total stays base');
  assert.equal(row[12], 400, 'amount_paid_at_issue stays base');
  assert.equal(row[13], 1280, 'balance_after_issue stays base');
  const multiplied = [1680 * 1250, 400 * 1250, 1280 * 1250, 3.2 * 1250];
  for (const cell of row.slice(0, 22)) {
    const n = Number(cell);
    if (Number.isFinite(n)) assert.ok(!multiplied.includes(n), `booked cell ${cell} looks multiplied`);
    if (typeof cell === 'string') {
      for (const m of multiplied) assert.ok(!cell.includes(String(m)), `lines_json carries ${m}`);
    }
  }
});

test('append: no multiplier → W is BLANK, never 1', async () => {
  repo._resetHeaderGuard();
  setRows([repo.HEADERS]);
  await repo.append(record());
  await repo.append(record({ invoiceNo: 'INV-2026-0008', token: 'tok8', rateMultiplier: 1 }));
  await repo.append(record({ invoiceNo: 'INV-2026-0009', token: 'tok9', rateMultiplier: null }));
  await repo.append(record({ invoiceNo: 'INV-2026-0010', token: 'tok10', rateMultiplier: 0 }));
  await repo.append(record({ invoiceNo: 'INV-2026-0011', token: 'tok11', rateMultiplier: 'abc' }));
  await repo.append(record({ invoiceNo: 'INV-2026-0012', token: 'tok12', rateMultiplier: 2_000_000 }));
  for (const row of rowsNow().slice(1)) {
    assert.equal(row.length, 23, 'row width is always the full header width');
    assert.equal(row[22], '', `W must be blank for none (got ${JSON.stringify(row[22])})`);
  }
});

test('parse: blank / old 22-cell rows read null; a stored factor reads as a number', async () => {
  const old22 = [
    'INV-2026-0001', 'tokA', 'REQ-1', 'C1', 'ABBA', '2026-08-01', '2026-08-01',
    JSON.stringify(BASE_LINES), '1680', '0', '0', '1680', '400', '1280',
    'transfer', 'Zenith', 'Emin', 'Lagos', 'issued', '', 'admin-1', '2026-08-01T10:00:00.000Z',
  ];
  const blank23 = [...old22.slice(0, 1), 'tokB', ...old22.slice(2), ''];
  const one23 = [...old22.slice(0, 1), 'tokC', ...old22.slice(2), '1'];
  const set23 = [...old22.slice(0, 1), 'tokD', ...old22.slice(2), '1250'];
  const frac23 = [...old22.slice(0, 1), 'tokE', ...old22.slice(2), '0.0004'];
  const junk23 = [...old22.slice(0, 1), 'tokF', ...old22.slice(2), 'x1250'];
  const grouped23 = [...old22.slice(0, 1), 'tokG', ...old22.slice(2), '1,250'];
  setRows([repo.HEADERS, old22, blank23, one23, set23, frac23, junk23, grouped23]);
  const all = await repo.getAll();
  const by = Object.fromEntries(all.map((r) => [r.token, r]));
  assert.equal(by.tokA.rateMultiplier, null, 'legacy 22-cell row → none');
  assert.equal(by.tokB.rateMultiplier, null, 'blank W → none');
  assert.equal(by.tokC.rateMultiplier, null, 'W = 1 → none');
  assert.equal(by.tokD.rateMultiplier, 1250);
  assert.equal(by.tokE.rateMultiplier, 0.0004, 'a factor below 1 is allowed (§8 rule 17)');
  assert.equal(by.tokF.rateMultiplier, null, 'non-numeric → none');
  assert.equal(by.tokG.rateMultiplier, 1250, 'a display-formatted W ("1,250") still reads the frozen factor (D3)');
  // The booked figures come back unconverted whatever W says.
  assert.equal(by.tokD.total, 1680);
  assert.equal(by.tokD.amountPaidAtIssue, 400);
  assert.deepEqual(by.tokD.lines, BASE_LINES);
  assert.equal(by.tokD.rowIndex, 5);
});

test('normaliseRateMultiplier: the one range check (§8 rule 11)', () => {
  const f = repo.normaliseRateMultiplier;
  assert.equal(f(1250), 1250);
  assert.equal(f('1250'), 1250);
  // FORMATTED_VALUE reads hand back a grouped cell; the comma is ignored
  // (the same rule as a typed factor, CUR-2 §3b rule 2).
  assert.equal(f('1,250'), 1250);
  assert.equal(f(' 1,250.5 '), 1250.5);
  assert.equal(f('1,250,000'), null, 'the ≤ 1,000,000 cap still applies after the strip');
  assert.equal(f('₦1,250'), null);
  assert.equal(f('1,250x'), null);
  assert.equal(f(0.0004), 0.0004);
  assert.equal(f(1_000_000), 1_000_000);
  for (const none of ['', null, undefined, 1, '1', 0, -5, NaN, Infinity, 'abc', 1_000_001]) {
    assert.equal(f(none), null, `${String(none)} must mean none`);
  }
});
