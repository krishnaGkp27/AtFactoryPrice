'use strict';

/**
 * PTK-1 — task-note OCR mapping. The reader extracts the INSTRUCTION and
 * the mapper clamps it: title condensed (≤100), details verbatim (≤500),
 * only real ISO dates survive, confidence clamped 0..1, and an empty read
 * is confidence 0 regardless of what the model claimed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { mapParsed, parseJsonLoose } = require('../../../src/services/vision/taskNoteExtraction');

test('the pen sample maps cleanly — details stay verbatim', () => {
  const m = mapParsed({
    title: 'Buy this pen',
    details: 'Buy this pen for me from anywhere. Let me know the price and submit approval.',
    dueDateISO: null, confidence: 0.92,
  });
  assert.equal(m.title, 'Buy this pen');
  assert.match(m.details, /submit approval\.$/);
  assert.equal(m.dueDateISO, null);
  assert.equal(m.confidence, 0.92);
});

test('missing title falls back to the details head; both empty → confidence 0', () => {
  const m = mapParsed({ title: '', details: 'Bring the generator bill to office', confidence: 0.8 });
  assert.equal(m.title, 'Bring the generator bill to office');
  const empty = mapParsed({ title: '', details: '', confidence: 0.9 });
  assert.equal(empty.confidence, 0, 'an empty read can never look confident');
});

test('junk dates are dropped, real ISO dates survive, confidence clamps', () => {
  assert.equal(mapParsed({ title: 'x', details: 'x', dueDateISO: 'Friday', confidence: 2 }).dueDateISO, null);
  const m = mapParsed({ title: 'x', details: 'x', dueDateISO: '2026-08-29', confidence: 2 });
  assert.equal(m.dueDateISO, '2026-08-29');
  assert.equal(m.confidence, 1);
  assert.equal(mapParsed({ title: 'x', details: 'x', confidence: -3 }).confidence, 0);
});

test('overlong fields are clamped to the task limits', () => {
  const m = mapParsed({ title: 'T'.repeat(300), details: 'D'.repeat(900), confidence: 0.9 });
  assert.equal(m.title.length, 100);
  assert.equal(m.details.length, 500);
});

test('parseJsonLoose digs JSON out of chatter', () => {
  const p = parseJsonLoose('Sure! Here is the JSON:\n{"title":"Buy pen","details":"Buy pen","confidence":0.8}\nDone.');
  assert.equal(p.title, 'Buy pen');
  assert.equal(parseJsonLoose('no json here'), null);
});
