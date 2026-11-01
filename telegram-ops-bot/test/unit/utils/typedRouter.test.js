'use strict';

/**
 * TXT-1 (owner, 01-Nov-2026) — the typed-text router: the AI is off for the
 * sheet by default, `reads` lets it answer questions only, `1` is the old
 * behaviour. Pure logic: the Settings read is stubbed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const settingsRepository = require('../../../src/repositories/settingsRepository');
const typedRouter = require('../../../src/utils/typedRouter');

test('parseMode: anything unreadable is OFF — the safe side of the rule', () => {
  for (const v of [undefined, null, '', 0, '0', 'off', 'no', 'maybe', 2]) assert.equal(typedRouter.parseMode(v), '0', String(v));
  for (const v of [1, '1', 'on', 'ALL', 'true']) assert.equal(typedRouter.parseMode(v), '1', String(v));
  for (const v of ['reads', 'Read', 'readonly', 'read-only']) assert.equal(typedRouter.parseMode(v), 'reads', String(v));
});

test('mode(): read from the Settings cell; a failed read is OFF', async () => {
  const orig = settingsRepository.getAll;
  try {
    settingsRepository.getAll = async () => ({ AI_TEXT_PARSER: 'reads' });
    assert.equal(await typedRouter.mode(), 'reads');
    settingsRepository.getAll = async () => ({});
    assert.equal(await typedRouter.mode(), '0');
    settingsRepository.getAll = async () => { throw new Error('sheet down'); };
    assert.equal(await typedRouter.mode(), '0');
    typedRouter.forceMode('1');
    assert.equal(await typedRouter.mode(), '1');
  } finally {
    settingsRepository.getAll = orig;
    typedRouter.forceMode(null);
  }
});

test('isRead: reads are an explicit list; every write — and anything new — is not', () => {
  for (const a of ['check', 'list_packages', 'report_sales', 'show_ledger', 'ask_data', 'customer_history', 'my_orders']) assert.equal(typedRouter.isRead(a), true, a);
  for (const a of ['sell_package', 'sell_mixed', 'return_package', 'transfer_batch', 'update_price', 'record_payment',
    'add_customer', 'add_contact', 'add_bank', 'add_user', 'give_sample', 'add_followup', 'add_customer_note',
    'mark_order_delivered', 'revert_last_transaction', 'create_order', 'supply_request', 'add', 'something_new', '', undefined]) {
    assert.equal(typedRouter.isRead(a), false, String(a));
  }
});

test('the chips card names the three script lines and nothing technical', () => {
  const t = typedRouter.chipsCardText();
  assert.match(t, /I work with the chips/);
  assert.match(t, /Sell 1100\/1, 1091\/1 kano/);
  assert.match(t, /Return 771, 779, 6189\/5/);
  assert.match(t, /Transfer 832, 1186, 786 to kano/);
  assert.doesNotMatch(t, /✋/);
  const b = typedRouter.chipsCardText({ blockedWrite: 'sell_package' });
  assert.match(b, /^✋ Typed words never change the sheet\./);
});
