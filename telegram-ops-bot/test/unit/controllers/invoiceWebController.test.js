'use strict';

/**
 * INV-1b — public invoice web view: token gate, statement HTML rules
 * (customer-account header, NO business identity, red payments with bank,
 * DEBIT BALANCE), PDF route headers, and clean 404s.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const invoicesRepository = require(path.join(SRC, 'repositories/invoicesRepository'));
const controller = require(path.join(SRC, 'controllers/invoiceWebController'));

const INV = {
  invoiceNo: 'INV-2026-0042',
  token: 'tok_abcdefghijklmnopqrstuvwx',
  customerName: 'Okeson',
  issueDate: '2026-07-19',
  saleDate: '2026-07-18',
  salesperson: 'Yarima',
  lines: [
    { design: '77016', yards: 60, qty: 1, shades: ['5'], rate: 1500, amount: 90000 },
    { design: '9032', yards: 30, qty: null, shades: null, rate: 1400, amount: 42000 },
  ],
  subtotal: 132000, total: 132000,
  amountPaidAtIssue: 50000,
  paymentMode: 'Transfer', bank: 'Penta',
};

invoicesRepository.getByToken = async (t) => (t === INV.token ? INV : null);

function fakeRes() {
  const res = {
    statusCode: 200, headers: {}, body: null, _type: '',
    status(c) { this.statusCode = c; return this; },
    type(t) { this._type = t; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    send(b) { this.body = b; return this; },
  };
  return res;
}

test('valid token renders the statement; owner content rules hold', async () => {
  const res = fakeRes();
  await controller.viewInvoice({ params: { token: INV.token } }, res);
  assert.equal(res.statusCode, 200);
  const html = res.body;
  assert.match(html, /OKESON.*— ACCOUNT/s, 'customer-account header');
  assert.ok(!/atfactoryprice/i.test(html.replace(/\/i\/tok_[^"]*/g, '')), 'no business name anywhere');
  assert.match(html, /Design 77016 · Shade 5 · 1 bale/, 'line description');
  assert.match(html, /60 yds/);
  assert.match(html, /Payment received — Penta \(Transfer\)/, 'payment shows receiving account');
  assert.match(html, /DEBIT BALANCE/, 'unpaid remainder labelled DEBIT BALANCE');
  assert.match(html, /₦82,000/, 'balance = 132000 - 50000');
  assert.match(html, /PART-PAID/);
  assert.match(html, new RegExp(`/i/${INV.token}\\.pdf`), 'PDF download link');
  assert.match(html, /noindex/, 'kept out of search engines');
});

test('unknown or malformed tokens → plain 404, no hints', async () => {
  for (const bad of ['tok_zzzzzzzzzzzzzzzzzzzzzzzz', 'short', '../../etc/passwd', '']) {
    const res = fakeRes();
    await controller.viewInvoice({ params: { token: bad } }, res);
    assert.equal(res.statusCode, 404, `404 for ${JSON.stringify(bad)}`);
    assert.equal(res.body, 'Not found');
  }
});

test('.pdf route streams a real PDF with the invoice number as filename', async () => {
  const res = fakeRes();
  await controller.viewInvoicePdf({ params: { token: INV.token } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['Content-Type'], 'application/pdf');
  assert.match(res.headers['Content-Disposition'], /INV-2026-0042\.pdf/);
  assert.ok(Buffer.isBuffer(res.body) && res.body.slice(0, 5).toString() === '%PDF-', 'valid PDF magic bytes');
});

test('fully paid invoice shows PAID and no DEBIT label', async () => {
  const paid = { ...INV, token: 'tok_paidpaidpaidpaidpaidpaid', amountPaidAtIssue: 132000 };
  invoicesRepository.getByToken = async (t) => (t === paid.token ? paid : (t === INV.token ? INV : null));
  const res = fakeRes();
  await controller.viewInvoice({ params: { token: paid.token } }, res);
  assert.match(res.body, />PAID</);
  assert.ok(!/DEBIT BALANCE/.test(res.body));
});
