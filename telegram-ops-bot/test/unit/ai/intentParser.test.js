'use strict';

/**
 * TRF-23 (owner's Go, 31-Oct-2026) — the OFFLINE fallback of the intent
 * parser. With no OPENAI_API_KEY (as here) `parse()` never leaves the
 * process, so these pin what a typed sentence becomes when the provider is
 * unreachable: a transfer sentence with a number lands on the Transfer
 * Stock door (the controller re-reads the raw text and shows the preload
 * card, which waits for a tap); everything else still asks for more.
 */

process.env.OPENAI_API_KEY = '';

const test = require('node:test');
const assert = require('node:assert/strict');

const intentParser = require('../../../src/ai/intentParser');

test('offline: a transfer sentence with a number is routed, not bounced', async () => {
  const out = await intentParser.parse('Can you transfer 5801 to kano');
  assert.equal(out.action, 'transfer_batch');
  assert.equal(out.clarification, null, 'no clarification — the preload card is the question');
});

test('offline: "move" counts as the transfer verb too', async () => {
  const out = await intentParser.parse('pls move bales 832 and 1186 to Kano office');
  assert.equal(out.action, 'transfer_batch');
  assert.equal(out.clarification, null);
});

test('offline: a transfer sentence WITHOUT a number still asks for more', async () => {
  const out = await intentParser.parse('Transfer stock');
  assert.equal(out.action, 'check');
  assert.match(out.clarification, /Please provide more details/);
});

test('offline: the other fallback verbs are unchanged', async () => {
  assert.equal((await intentParser.parse('sell package 5801 to Ibrahim')).action, 'sell_package');
  assert.equal((await intentParser.parse('add stock')).action, 'add');
  assert.equal((await intentParser.parse('what is in lagos')).action, 'check');
});
