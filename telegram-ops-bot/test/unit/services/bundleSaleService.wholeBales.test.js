'use strict';
/**
 * SELL-T3e — the bundle door knows which bales are still WHOLE at submit:
 * every available than that was loaded (recorded when the bale was taken
 * whole) is still in the cart. The list rides the sale_bundle payload.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const svc = require(path.join(__dirname, '../../../src/services/bundleSaleService'));

const line = (pkg, t) => ({ baleUid: `U-${pkg}-${t}`, packageNo: pkg, thanNo: t, yards: 30, design: '77014', shade: '11' });

test('wholeBalesInCart: whole while every loaded than is there; a dropped than un-wholes it; never-whole bales are not listed', () => {
  const cart = svc.emptyCart();
  svc.addLines(cart, [line('1100', 1), line('1100', 2), line('1100', 3), line('1091', 1), line('1091', 2), line('1082', 1)]);
  const sizes = { 1100: 3, 1091: 2 }; // 1082/1 was typed as a than, never taken whole
  assert.deepEqual(svc.wholeBalesInCart(cart, sizes), ['1100', '1091']);
  svc.removeLines(cart, [cart.lines.find((l) => l.packageNo === '1100' && l.thanNo === 2)._key]);
  assert.deepEqual(svc.wholeBalesInCart(cart, sizes), ['1091']);
  svc.addLines(cart, [line('1100', 2)]);
  assert.deepEqual(svc.wholeBalesInCart(cart, sizes), ['1100', '1091'], 'taking the than back re-wholes the bale');
  assert.deepEqual(svc.wholeBalesInCart(cart, undefined), []);
  assert.deepEqual(svc.wholeBalesInCart(svc.emptyCart(), sizes), []);
});

test('buildApprovalPayload carries wholeBales only when there are some', () => {
  const cart = svc.emptyCart();
  svc.addLines(cart, [line('1100', 1), line('1100', 2)]);
  const user = { id: '4242' };
  const withWhole = svc.buildApprovalPayload(cart, { customer: '', salesDate: '2026-11-03', wholeBales: ['1100'] }, user);
  assert.deepEqual(withWhole.wholeBales, ['1100']);
  assert.equal(withWhole.items.length, 2, 'the thans still ride the request for the executor');
  const without = svc.buildApprovalPayload(cart, { customer: '', salesDate: '2026-11-03', wholeBales: [] }, user);
  assert.ok(!('wholeBales' in without));
});
