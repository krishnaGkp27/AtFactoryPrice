'use strict';

/**
 * CUR-2 — the invoice document in both states (specs/CUR-2_INVOICE_MULTIPLIER.md
 * §2, §4a, §4b, §5, §7, §8) and the owner's 09-Sep-2026 integrity ruling:
 * the multiplier is REFLECTED on the customer copy, the sheet holds only the
 * BOOKED (variable-1) figures plus the factor in its own column, and the two
 * are handled separately with integrity.
 *
 * The real invoicesRepository writes to a fake Invoices sheet (so the row
 * the sheet holds is the row pinned), the real settingsRepository reads a
 * fake Settings sheet (so "flip the cell after issue" is a real flip), and
 * every printed string is taken from the same code path the PDF / web copy
 * draw through (renderText / renderHtml).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { createFakeSheets } = require('../../helpers/fakeSheets');
const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');

const fake = createFakeSheets({
  Invoices: [],
  Settings: [['key', 'value', 'notes']],
});
installFakeSheets(fake);

const invoicesRepository = require(path.join(SRC, 'repositories/invoicesRepository'));
const settingsRepository = require(path.join(SRC, 'repositories/settingsRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const accountingService = require(path.join(SRC, 'services/accountingService'));
const invoiceService = require(path.join(SRC, 'services/invoiceService'));
const { renderHtml } = require(path.join(SRC, 'controllers/invoiceWebController'))._internals;
const config = require(path.join(SRC, 'config'));

customersRepository.getAll = async () => [
  { customer_id: 'CUST-20260901-004', name: 'Soldier Madam', status: 'Active', aliases: [] },
];
accountingService.getCustomerLedger = async () => ({ outstandingAsOfToday: 944 });

const YEAR = new Date().getFullYear();
const { renderText } = invoiceService._internals;

/** Point the Settings cell at `value` (undefined = no row) and drop the cache. */
function setMultiplierCell(value) {
  const rows = [['key', 'value', 'notes']];
  if (value !== undefined) rows.push(['INVOICE_RATE_MULTIPLIER', value, '']);
  fake._store.set('Settings', rows);
  settingsRepository.invalidateCache();
}
function resetInvoices() {
  fake._store.set('Invoices', []);
  invoicesRepository._resetHeaderGuard();
}
const sheetRows = () => fake._store.get('Invoices');
const W = invoicesRepository.HEADERS.indexOf('rate_multiplier');

/** The §2 worked example: 420 yds @ 3.20, paid 400 to GTBank. */
const SALE = {
  requestId: 'R-REQ1',
  actionJSON: {
    action: 'sale_bundle', customer: 'Soldier Madam', salesDate: '2026-09-07',
    warehouse: 'Kano office', salesPerson: 'Abdul',
    items: [
      ...[1, 3, 1, 3].map((s, i) => ({ type: 'package', design: '77019', shade: s, yards: 60, packageNo: `B${i}` })),
      ...Array.from({ length: 8 }, (_, i) => ({ type: 'than', design: '77019', shade: i % 2 ? 3 : 1, yards: 22.5, thans: 1, packageNo: `T${i}` })),
    ],
  },
};
const ENRICH = { ratePerUnitByDesign: { 77019: 3.2 }, paymentMode: 'Paid to GTBank', amountPaid: 400 };

async function issue(enrichment, settingsCell) {
  resetInvoices();
  setMultiplierCell(settingsCell);
  return invoiceService.createForSale({ item: SALE, enrichment, approvedBy: '777' });
}

// ---------------------------------------------------------------------------
// §4a — NO multiplier: every figure is the entered variable-1 value, bare
// ---------------------------------------------------------------------------
test('§4a PDF text: no multiplier → booked figures, bare, rate as entered (3.20/yd)', async () => {
  const inv = await issue(ENRICH, undefined);
  assert.equal(inv.rateMultiplier, null, 'no factor frozen');
  const txt = renderText(inv);
  assert.deepEqual(txt.slice(8), [
    'PART-PAID · 400 received of 1,344',
    'DESCRIPTION', 'COST', 'PAYMENTS',
    'Design 77019', '1,344',
    'Shades 1, 3 · 4 bales + 8 thans · 420 yds @ 3.20/yd',
    'Total', '1,344',
    '2026-09-07 paid to GTBank account', '400',
    'DEBIT BALANCE', '944',
    'Secured with WhatsApp code · Live copy & PDF at the link shared with you',
  ]);
  assert.equal(txt[0], 'SOLDIER MADAM ');
  assert.equal(txt[1], '— ACCOUNT');
  assert.ok(!txt.join('\n').includes('₦'), 'no symbol anywhere on the paper');
  assert.ok(!/NGN|Naira|×/.test(txt.join('\n')), 'no unit word, no factor note (rule 10)');
});

test('§4a web copy: bare integers (R10), dated payment row, DEBIT BALANCE', async () => {
  const inv = await issue(ENRICH, undefined);
  const html = renderHtml(inv);
  assert.match(html, /<th class="num">Rate<\/th><th class="num">Cost<\/th>/, 'headers bare');
  assert.match(html, /Design 77019 · Shades 1, 3 · 4 bales \+ 8 thans<\/td>\s*<td class="num">420 yds<\/td>\s*<td class="num">3\.20\/yd<\/td>\s*<td class="num">1,344<\/td>/);
  assert.match(html, /Payment received 07-Sep-2026 — GTBank \(Paid to GTBank\)<\/td>\s*<td class="num"><\/td><td class="num"><\/td>\s*<td class="num">− 400<\/td>/);
  assert.match(html, /<span>Total cost<\/span><span>1,344<\/span>/);
  assert.match(html, /<span>Payments<\/span><span>− 400<\/span>/);
  assert.match(html, /DEBIT BALANCE<\/span>\s*<span>944<\/span>/);
  assert.match(html, />PART-PAID</);
  assert.ok(!html.includes('₦'), 'no symbol on the web copy');
});

test('§4a caption: booked figures, no Customer copy line', async () => {
  const inv = await issue(ENRICH, undefined);
  const prevBase = config.baseUrl;
  config.baseUrl = 'https://ops.example.test';
  try {
    assert.equal(invoiceService.caption(inv),
      `🧾 INV-${YEAR}-0001 — Soldier Madam\nTotal 1,344 · Paid 400 · Balance 944\n🔗 Live copy: https://ops.example.test/i/${inv.token}\nForward this PDF (or the link) to the customer on WhatsApp.`);
  } finally { config.baseUrl = prevBase; }
});

// ---------------------------------------------------------------------------
// §4b — multiplier 1,250: every figure × 1,250, bare, including the red
// payment row and DEBIT BALANCE
// ---------------------------------------------------------------------------
test('§4b PDF text: Settings 1,250 (key absent) → every figure converted, 2 dp rate', async () => {
  const inv = await issue(ENRICH, '1250');
  assert.equal(inv.rateMultiplier, 1250, 'the Settings factor is frozen on the record');
  const txt = renderText(inv);
  assert.deepEqual(txt.slice(8, 21), [
    'PART-PAID · 500,000 received of 1,680,000',
    'DESCRIPTION', 'COST', 'PAYMENTS',
    'Design 77019', '1,680,000',
    'Shades 1, 3 · 4 bales + 8 thans · 420 yds @ 4,000.00/yd',
    'Total', '1,680,000',
    '2026-09-07 paid to GTBank account', '500,000',
    'DEBIT BALANCE', '1,180,000',
  ]);
  assert.ok(!/₦|NGN|×|1,250/.test(txt.join('\n')), 'no symbol, no unit, no "× 1,250" on the document (rule 10)');
});

test('§4b web copy: converted cells, dated payment row × 1,250', async () => {
  const inv = await issue(ENRICH, '1250');
  const html = renderHtml(inv);
  assert.match(html, /<td class="num">4,000\.00\/yd<\/td>\s*<td class="num">1,680,000<\/td>/);
  assert.match(html, /Payment received 07-Sep-2026 — GTBank \(Paid to GTBank\)<\/td>[\s\S]*?<td class="num">− 500,000<\/td>/);
  assert.match(html, /<span>Total cost<\/span><span>1,680,000<\/span>/);
  assert.match(html, /<span>Payments<\/span><span>− 500,000<\/span>/);
  assert.match(html, /DEBIT BALANCE<\/span>\s*<span>1,180,000<\/span>/);
  assert.match(html, />PART-PAID</);
  assert.ok(!/₦|1,250/.test(html), 'no symbol, no factor note');
});

test('§4b caption is a STAFF message: booked figures and NO factor (owner ruling 09-Sep)', async () => {
  const inv = await issue(ENRICH, '1250');
  const prevBase = config.baseUrl;
  config.baseUrl = '';
  try {
    assert.equal(invoiceService.caption(inv),
      `🧾 INV-${YEAR}-0001 — Soldier Madam\nTotal 1,344 · Paid 400 · Balance 944\nForward this PDF (or the link) to the customer on WhatsApp.`);
  assert.ok(!/×|Customer copy|1,250/.test(invoiceService.caption(inv)), 'the factor never reaches the caption');
  } finally { config.baseUrl = prevBase; }
});

test('factorText names the frozen factor at its own precision — ENTRY card only, never the caption', () => {
  const prevBase = config.baseUrl;
  config.baseUrl = '';
  try {
    const { factorText } = invoiceService;
    // Rule 17 allows a factor below 1; a sub-0.005 factor must not read "0.00".
    assert.equal(factorText(0.0004), '0.0004');
    assert.equal(factorText(0.5), '0.5');
    assert.equal(factorText(1.5), '1.5');
    // A 3-dp factor is named exactly, not rounded to "1,250.13".
    assert.equal(factorText(1250.125), '1,250.125');
    assert.equal(factorText(1250), '1,250');
    // Owner ruling 09-Sep-2026: the factor is internal — the caption never names it.
    const base = { invoiceNo: 'INV-2026-0091', customerName: 'ABBA', saleDate: '2026-09-09', lines: [{ design: '202', yards: 10, rate: 100.1, amount: 1001 }], total: 1001, amountPaidAtIssue: 1000 };
    for (const m of [0.0004, 0.5, 1250.125, 1250]) {
      const cap = invoiceService.caption({ ...base, rateMultiplier: m });
      assert.ok(!/×|Customer copy|0\.0004|1,250/.test(cap), `caption must not name the factor ${m}: ${cap}`);
      assert.equal(invoiceService.docFigures({ ...base, rateMultiplier: m }).multiplier, m, 'column W still drives the document');
    }
  } finally { config.baseUrl = prevBase; }
});

test('deliver sends the PDF with that caption to each chat once', async () => {
  const inv = await issue(ENRICH, '1250');
  const sent = [];
  const bot = { sendDocument: async (chatId, buf, opts, file) => { sent.push({ chatId, opts, file, isPdf: buf.subarray(0, 5).toString() === '%PDF-' }); } };
  await invoiceService.deliver(bot, inv, ['11', '22', '11', null]);
  assert.equal(sent.length, 2, 'deduplicated recipients');
  assert.ok(sent.every((s) => s.isPdf));
  assert.equal(sent[0].file.filename, `INV-${YEAR}-0001.pdf`);
  assert.match(sent[0].opts.caption, /Total 1,344 · Paid 400 · Balance 944\nForward/);
  assert.ok(!/×|Customer copy/.test(sent[0].opts.caption), 'no factor on the delivered caption');
});

// ---------------------------------------------------------------------------
// The integrity arrangement (owner, 09-Sep-2026)
// ---------------------------------------------------------------------------
test('integrity: the sheet row holds only BASE figures; the factor sits alone in W', async () => {
  await issue(ENRICH, '1250');
  const rows = sheetRows();
  assert.equal(rows[0][W], 'rate_multiplier', 'header widened to W');
  const row = rows[1];
  assert.equal(row[W], 1250, 'W = the multiplier in force at issue');
  assert.equal(row[8], 1344, 'subtotal booked');
  assert.equal(row[11], 1344, 'total booked');
  assert.equal(row[12], 400, 'amount_paid_at_issue booked');
  assert.equal(row[13], 944, 'balance_after_issue is a ledger fact, never multiplied');
  const lines = JSON.parse(row[7]);
  assert.equal(lines[0].rate, 3.2, 'lines_json rate as entered');
  assert.equal(lines[0].amount, 1344, 'lines_json amount booked');
  const multiplied = ['1680000', '500000', '1180000', '4000'];
  row.forEach((cell, i) => {
    if (i === W) return;
    for (const m of multiplied) assert.ok(!String(cell).includes(m), `column ${i} carries a multiplied figure ${m}`);
  });
});

test('integrity: base figures reproduce the ledger / Transactions numbers', async () => {
  const inv = await issue(ENRICH, '1250');
  // What recordSale posts (Customer Receivable DR total, payment CR paid)
  // and what the Transactions row carries (pricePerYard, amountPaid).
  assert.equal(inv.total, Math.round(420 * 3.2));
  assert.equal(inv.amountPaidAtIssue, 400);
  assert.equal(inv.lines[0].rate, ENRICH.ratePerUnitByDesign[77019]);
  assert.equal(inv.total - inv.amountPaidAtIssue, 944, 'the outstanding the statement shows');
  // The document's 1,680,000 exists nowhere on the record.
  assert.ok(!JSON.stringify({ ...inv, rateMultiplier: undefined }).includes('1680000'));
});

test('integrity: flipping the Settings cell AFTER issue never changes a re-render', async () => {
  const inv = await issue(ENRICH, '1250');
  const before = { pdf: renderText(inv), html: renderHtml(inv), cap: invoiceService.caption(inv) };

  setMultiplierCell('2000');
  assert.equal((await settingsRepository.getAll()).INVOICE_RATE_MULTIPLIER, 2000, 'the cell really flipped');
  const reread = await invoicesRepository.getByToken(inv.token);
  assert.equal(reread.rateMultiplier, 1250, 'the row keeps the frozen factor');
  assert.deepEqual(renderText(reread), before.pdf);
  assert.equal(renderHtml(reread), before.html);
  assert.equal(invoiceService.caption(reread), before.cap);

  setMultiplierCell(undefined);
  const again = await invoicesRepository.getByToken(inv.token);
  assert.deepEqual(renderText(again), before.pdf, 'blanking the cell does not unconvert an issued invoice');
  assert.equal(renderText(again)[8], 'PART-PAID · 500,000 received of 1,680,000');
});

test('a NEW invoice after the flip takes the new cell — the freeze is per invoice', async () => {
  const first = await issue(ENRICH, '1250');
  setMultiplierCell('2000');
  const second = await invoiceService.createForSale({ item: { ...SALE, requestId: 'R-REQ2' }, enrichment: ENRICH, approvedBy: '777' });
  assert.equal(first.rateMultiplier, 1250);
  assert.equal(second.rateMultiplier, 2000);
  assert.equal(renderText(second)[8], 'PART-PAID · 800,000 received of 2,688,000');
});

// ---------------------------------------------------------------------------
// §7 freeze rule — presence of the enrichment key
// ---------------------------------------------------------------------------
test('key PRESENT as 1 ("No multiplier") with Settings 1,250 → unconverted, W blank', async () => {
  const inv = await issue({ ...ENRICH, rateMultiplier: 1 }, '1250');
  assert.equal(inv.rateMultiplier, null);
  assert.equal(sheetRows()[1][W], '', 'blank on the sheet, never 1');
  assert.equal(renderText(inv)[8], 'PART-PAID · 400 received of 1,344');
});

test('key PRESENT with a value wins over Settings and never falls through', async () => {
  const inv = await issue({ ...ENRICH, rateMultiplier: 800 }, '1250');
  assert.equal(inv.rateMultiplier, 800);
  assert.equal(renderText(inv)[8], 'PART-PAID · 320,000 received of 1,075,200');
  assert.equal(renderText(inv)[14], 'Shades 1, 3 · 4 bales + 8 thans · 420 yds @ 2,560.00/yd');
});

test('key PRESENT but out of range (rule 11) → none, and Settings is still not consulted', async () => {
  for (const bad of [0, -5, 'abc', NaN, Infinity, 1_000_001, null]) {
    const inv = await issue({ ...ENRICH, rateMultiplier: bad }, '1250');
    assert.equal(inv.rateMultiplier, null, `${String(bad)} means none`);
    assert.equal(renderText(inv)[8], 'PART-PAID · 400 received of 1,344', `${String(bad)} prints unconverted`);
  }
});

test('key ABSENT: Settings blank / 0 / 1 / abc → none; 1250 → 1250; 0.5 → 0.5', async () => {
  for (const [cell, want] of [[undefined, null], ['', null], ['0', null], ['1', null], ['abc', null], ['1250', 1250], ['0.5', 0.5]]) {
    const inv = await issue(ENRICH, cell);
    assert.equal(inv.rateMultiplier, want, `Settings ${JSON.stringify(cell)}`);
  }
});

test('a Settings cell displayed as "1,250" (FORMATTED_VALUE grouping) still freezes 1250', async () => {
  // getAll() keeps '1,250' as a string (Number('1,250') is NaN); the one range
  // check ignores the grouping comma, as the wizard does for a typed factor
  // (§3b rule 2), so a display format can never issue an unconverted copy.
  const inv = await issue(ENRICH, '1,250');
  assert.equal(inv.rateMultiplier, 1250);
  assert.equal(sheetRows()[1][W], 1250, 'column W freezes the number, not the display text');
  const txt = renderText(inv);
  assert.equal(txt[8], 'PART-PAID · 500,000 received of 1,680,000');
  // …and reads back converted from the sheet.
  invoicesRepository._resetHeaderGuard();
  const reread = (await invoicesRepository.getAll())[0];
  assert.equal(reread.rateMultiplier, 1250);
});

test('a Settings cell that is not a usable factor issues unconverted AND logs a warning', async () => {
  const logger = require(path.join(SRC, 'utils/logger'));
  const warned = [];
  const orig = logger.warn;
  logger.warn = (msg) => { warned.push(String(msg)); };
  try {
    const inv = await issue(ENRICH, 'abc');
    assert.equal(inv.rateMultiplier, null);
    assert.ok(warned.some((m) => /INVOICE_RATE_MULTIPLIER cell "abc" is not a usable factor/.test(m)), warned.join(' | '));
    // Blank / 0 / 1 are legitimate "none" spellings — no warning.
    for (const quiet of [undefined, '', '0', '1']) {
      warned.length = 0;
      await issue(ENRICH, quiet);
      assert.equal(warned.filter((m) => /INVOICE_RATE_MULTIPLIER/.test(m)).length, 0, `Settings ${JSON.stringify(quiet)} must not warn`);
    }
  } finally { logger.warn = orig; }
});

test('a Settings read failure means none — never a failed sale', async () => {
  resetInvoices();
  const orig = settingsRepository.getAll;
  settingsRepository.getAll = async () => { throw new Error('sheets down'); };
  try {
    const inv = await invoiceService.createForSale({ item: SALE, enrichment: ENRICH, approvedBy: '777' });
    assert.equal(inv.rateMultiplier, null);
    assert.equal(sheetRows().length, 2, 'row still persisted');
  } finally { settingsRepository.getAll = orig; }
});

// ---------------------------------------------------------------------------
// §8 edge cases
// ---------------------------------------------------------------------------
test('rule 12: rate unresolved → RATE NOT RECORDED, dashes, payment still in the document unit', async () => {
  const inv = await issue({ paymentMode: 'Paid to GTBank', amountPaid: 400 }, '1250');
  assert.equal(inv.total, 0);
  assert.equal(inv.rateMultiplier, 1250, 'W still frozen so a later correction renders consistently');
  const txt = renderText(inv);
  assert.equal(txt[8], 'RATE NOT RECORDED');
  assert.equal(txt[13], '—', 'COST cell');
  assert.equal(txt[14], 'Shades 1, 3 · 4 bales + 8 thans · 420 yds', 'description omits @ …/yd');
  assert.equal(txt[16], '—', 'Total');
  assert.equal(txt[18], '500,000', 'the payment prints × the frozen factor (D2)');
  assert.equal(txt[20], '—', 'DEBIT BALANCE');
  assert.ok(!txt.join('\n').includes('PAID ·'), 'no PAID claim on a rate-less invoice');
  const html = renderHtml(inv);
  assert.match(html, />RATE NOT RECORDED</);
  assert.match(html, /<td class="num"><\/td>\s*<td class="num">—<\/td>/, 'blank rate, dashed cost');
  assert.match(html, /− 500,000/);
  assert.match(html, /DEBIT BALANCE<\/span>\s*<span>—<\/span>/);
  assert.match(invoiceService.caption(inv), /Total — · Paid 400 · Balance —\nForward/);

  // Same state, no multiplier: the payment prints booked.
  const plain = await issue({ paymentMode: 'Cash', amountPaid: 400 }, undefined);
  const t2 = renderText(plain);
  assert.equal(t2[8], 'RATE NOT RECORDED');
  assert.equal(t2[18], '400');
  assert.match(invoiceService.caption(plain), /Total — · Paid 400 · Balance —\nForward/);
});

test('rule 13: an old row with a blank W renders variable 1, bare, whatever Settings says', async () => {
  setMultiplierCell('1250');
  const old = {
    invoiceNo: 'INV-2026-0003', token: 'tok_oldoldoldoldoldoldoldold', customerName: 'Okeson',
    saleDate: '2026-07-18', warehouse: 'IDUMOTA',
    lines: [{ design: '77016', yards: 60, qty: 1, shades: ['5'], rate: 1500, amount: 90000 }],
    subtotal: 90000, total: 90000, amountPaidAtIssue: 50000, paymentMode: 'Transfer', bank: 'Penta',
  };
  const txt = renderText(old);
  assert.equal(txt[8], 'PART-PAID · 50,000 received of 90,000');
  assert.equal(txt[14], 'Shades 5 · 1 item · 60 yds @ 1,500/yd', 'an integer entered rate prints as entered');
  assert.equal(txt[20], '40,000');
  assert.match(renderHtml(old), /<td class="num">1,500\/yd<\/td>\s*<td class="num">90,000<\/td>/);
});

test('rule 14: several designs at different rates → one factor, each line recomputed, total = Σ lines', () => {
  const inv = {
    invoiceNo: 'INV-2026-0090', customerName: 'ABBA', saleDate: '2026-09-09',
    lines: [
      { design: '202', yards: 500, rate: 3.2, amount: 1600 },
      { design: '201', yards: 25, rate: 3.333, amount: 83 },
    ],
    total: 1683, amountPaidAtIssue: 0, rateMultiplier: 1250,
  };
  const fig = invoiceService.docFigures(inv);
  assert.equal(fig.lines[0].docRateText, '4,000.00/yd');
  assert.equal(fig.lines[1].docRateText, '4,166.25/yd');
  assert.equal(fig.lines[0].docAmount, 2_000_000);
  assert.equal(fig.lines[1].docAmount, Math.round(25 * 3.333 * 1250), 'round(yards × rate × m), not booked × m');
  assert.equal(fig.total, fig.lines[0].docAmount + fig.lines[1].docAmount, 'the column adds up');
  assert.equal(fig.status, 'UNPAID');
  assert.equal(fig.stripText, `UNPAID · ${fig.totalText} due`);
});

test('rule 16: amountPaid 0 → no payment row, UNPAID strip in the document unit', async () => {
  const inv = await issue({ ...ENRICH, paymentMode: 'Not yet paid', amountPaid: 0 }, '1250');
  const txt = renderText(inv);
  assert.equal(txt[8], 'UNPAID · 1,680,000 due');
  assert.ok(!txt.some((s) => /paid to|paid \(/.test(s)), 'no red payment row');
  assert.equal(txt[txt.indexOf('DEBIT BALANCE') + 1], '1,680,000');
  assert.ok(!renderHtml(inv).includes('Payment received'));
});

test('rule 17: a factor < 1 that rounds the balance to 0 still says PART-PAID (status from BOOKED)', () => {
  const inv = {
    invoiceNo: 'INV-2026-0091', customerName: 'ABBA', saleDate: '2026-09-09',
    lines: [{ design: '202', yards: 10, rate: 100.1, amount: 1001 }],
    total: 1001, amountPaidAtIssue: 1000, bank: 'GTBank', rateMultiplier: 0.0004,
  };
  const fig = invoiceService.docFigures(inv);
  assert.equal(fig.total, 0);
  assert.equal(fig.paid, 0);
  assert.equal(fig.balance, 0);
  assert.equal(fig.status, 'PART-PAID', 'a customer whose ledger shows a debt never reads PAID');
  assert.equal(fig.stripText, 'PART-PAID · 0 received of 0');
  assert.equal(fig.lines[0].docRateText, '0.04/yd');
  const html = renderHtml(inv);
  assert.match(html, />PART-PAID</);
  assert.match(html, /DEBIT BALANCE<\/span>\s*<span>0<\/span>/, 'the label follows the booked debt');
});

test('rule 8: a non-integer entered rate is never truncated on the paper', () => {
  const txt = renderText({ invoiceNo: 'X', customerName: 'A', saleDate: '2026-09-09', lines: [{ design: '1', yards: 10, rate: 3.2, amount: 32 }], total: 32, amountPaidAtIssue: 32 });
  assert.ok(txt.includes('10 yds @ 3.20/yd'), txt.join(' | '));
  assert.ok(!txt.includes('10 yds @ 3/yd'));
  assert.equal(txt[8], 'PAID · 32 settled');
});

// The figures on the paper are pinned by the renderText tests above (pdfkit
// subsets the font, so the byte stream is not greppable); this only proves
// the converted invoice still yields a real, non-trivial PDF buffer.
test('renderPdf of a converted invoice yields a non-trivial PDF buffer', async () => {
  const inv = await issue(ENRICH, '1250');
  const pdf = await invoiceService.renderPdf(inv);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 2000);
});
