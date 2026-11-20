'use strict';

/**
 * RET-8 review 2 (R2-5) — sessionStore.onReplaced: a live session replaced
 * by a DIFFERENT flow's set() is reported to the listeners; the same flow
 * re-saving itself, a first set and an expired session are not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const store = require(path.join(__dirname, '../../../src/utils/sessionStore'));

test('onReplaced fires only when another flow takes a live session', () => {
  const seen = [];
  store.onReplaced((uid, prev, next) => { if (String(uid).startsWith('rpl-')) seen.push([uid, prev.type, prev.step, next.type]); });
  store.set('rpl-1', { type: 'a_flow', step: 's1' });
  assert.deepEqual(seen, [], 'a first set replaces nothing');
  store.set('rpl-1', { type: 'a_flow', step: 's1', more: 1 });
  assert.deepEqual(seen, [], 'the same flow and step re-saving itself');
  store.set('rpl-1', { type: 'b_flow', step: 'x' });
  assert.deepEqual(seen, [['rpl-1', 'a_flow', 's1', 'b_flow']]);
  store.set('rpl-2', { type: 'a_flow', step: 's1', ttlMs: 1 });
  const until = Date.now() + 5; while (Date.now() < until) { /* let it expire */ }
  store.set('rpl-2', { type: 'b_flow' });
  assert.equal(seen.length, 1, 'an expired session is the janitor\'s, not a replacement');
  store.onReplaced(() => { throw new Error('a listener that throws'); });
  assert.doesNotThrow(() => store.set('rpl-1', { type: 'c_flow' }));
  assert.equal(store.get('rpl-1').type, 'c_flow');
  store.clear('rpl-1'); store.clear('rpl-2');
});
