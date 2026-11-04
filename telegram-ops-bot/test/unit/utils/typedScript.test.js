'use strict';
// TXT-3 — the whole script: first word = verb, body read deterministically,
// a known verb with a bad body gets its line, an unknown first word nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { localIntent, hintCardText, chipsCardText, SYNTAX } = require('../../../src/utils/typedRouter');

const act = (line) => { const r = localIntent(line); return r && r.action; };

test('reads: stock, bale, balance, ledger, customer, reports, lists', () => {
  assert.deepEqual(localIntent('Stock 9006 black'), { action: 'check', design: '9006', shade: 'black', confidence: 1, clarification: null, local: true });
  assert.deepEqual(localIntent('stock 9006'), { action: 'check', design: '9006', confidence: 1, clarification: null, local: true });
  assert.deepEqual(localIntent('Stock at Lagos'), { action: 'check', warehouse: 'Lagos', confidence: 1, clarification: null, local: true });
  assert.deepEqual(localIntent('Check 44200 BLACK in Kano office'), { action: 'check', design: '44200', shade: 'BLACK', warehouse: 'Kano office', confidence: 1, clarification: null, local: true });
  assert.equal(act('Stock'), 'check', 'all stock');
  assert.equal(act('Stock black'), '__hint__', 'a shade with no design');
  assert.deepEqual(localIntent('Bale 1112').packageNo, '1112');
  assert.equal(act('bale'), '__hint__');
  assert.deepEqual(localIntent('Balance Abba'), { action: 'check_balance', customer: 'Abba', confidence: 1, clarification: null, local: true });
  assert.equal(localIntent('Ledger Alhaji Musa').customer, 'Alhaji Musa');
  assert.equal(act('balance'), '__hint__');
  assert.equal(localIntent('Customer Abba').action, 'check_customer');
  assert.equal(localIntent('customer').action, '__tile__');
  assert.equal(act('Report sales'), 'report_sold');
  assert.equal(act('report stock'), 'report_supply_by_design');
  assert.equal(act('Report last'), 'report_last_transactions');
  assert.equal(localIntent('Report').callback, 'act:__hub__:reporting');
  assert.equal(act('Tasks'), 'my_tasks');
  assert.equal(act('orders'), 'my_orders');
  assert.equal(act('Contacts'), 'list_contacts');
  assert.equal(act('Banks'), 'list_banks');
});

test('writes open their doors, never the sheet: price, receive, order, task, done, delivered', () => {
  assert.deepEqual(localIntent('Price 9006 black 1500'), { action: 'update_price', design: '9006', shade: 'black', price: 1500, confidence: 1, clarification: null, local: true });
  assert.deepEqual(localIntent('price 9006 1,500'), { action: 'update_price', design: '9006', shade: null, price: 1500, confidence: 1, clarification: null, local: true });
  assert.equal(act('Price 9006'), '__hint__', 'no rate');
  assert.equal(act('Price 9006 black abc'), '__hint__');
  assert.equal(act('Receive'), 'add');
  assert.equal(act('add stock'), 'add');
  assert.equal(localIntent('Add contact').callback, 'act:add_customer');
  assert.equal(localIntent('Add employee').callback, 'act:add_user');
  assert.equal(act('Add'), '__hint__');
  assert.equal(act('Order'), 'create_order');
  assert.equal(act('Task'), 'assign_task');
  assert.equal(act('Done'), 'mark_task_done');
  assert.deepEqual(localIntent('Delivered ORD-20260221-001').orderId, 'ORD-20260221-001');
  assert.equal(act('Delivered'), '__hint__');
  assert.equal(localIntent('Contact').callback, 'act:add_customer');
  assert.equal(localIntent('User').callback, 'act:add_user');
});

test('the three script verbs without numbers get their line; payment points at the tap door; help and menu', () => {
  for (const line of ['Sell', 'sell package to Ibrahim', 'sold out?', 'Return', 'Transfer to kano', 'Move goods']) {
    const r = localIntent(line);
    assert.equal(r.action, '__hint__', line);
    assert.ok(r.syntax && SYNTAX[r.verb] === r.syntax, line);
  }
  const pay = localIntent('Payment Abba 250000 cash');
  assert.equal(pay.action, '__hint__');
  assert.match(pay.note, /tap, never by a typed line/);
  assert.equal(localIntent('help').action, '__help__');
  assert.equal(localIntent('/help').action, '__help__');
  assert.equal(localIntent('Please help').action, '__help__');
  assert.equal(localIntent('menu').callback, 'act:__back__');
});

test('an unknown first word is nobody\'s: the chips card stays the only answer', () => {
  for (const line of ['What\'s in Lagos?', 'hello', 'Record payment 50000 from Ibrahim', 'Update price of 9006 to 1500', '', '   ']) {
    assert.equal(localIntent(line), null, line);
  }
  assert.equal(localIntent('x'.repeat(161)), null, 'too long is nobody\'s');
});

test('hint and chips cards', () => {
  assert.equal(hintCardText(localIntent('Transfer')), '✍️ Transfer needs its line:\n  Transfer 832, 1186, 786 to kano\n\nBale numbers, then the store it goes to.');
  const card = chipsCardText();
  for (const s of ['Stock 9006 black · Stock at Lagos', 'Balance Abba · Ledger Abba (admins)', 'Price 9006 black 1500 (admins)', 'Receive · Order · Task · Delivered ORD-…', 'Help — this card']) assert.ok(card.includes(s), s);
});
