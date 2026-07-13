'use strict';

/**
 * DCAT-G1 — plausibility gate for design_category cells. Column W is
 * owner-editable in the Google Sheet; sheet-side AI assist once pasted a
 * Gemini refusal sentence into cells, which surfaced as a CATEGORY in the
 * supply pickers (live, 13-Jul-2026). Junk labels must be skipped so the
 * affected designs fall back to "Others".
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const repo = require('../../../src/repositories/designCategoriesRepository');
const inventoryRepository = require('../../../src/repositories/inventoryRepository');

test('isPlausibleLabel accepts real labels, rejects sentences and oversize', () => {
  for (const good of ['Cashmere', 'TR', 'Chinos', 'Super Senator 2']) {
    assert.equal(repo.isPlausibleLabel(good), true, good);
  }
  const gemini = 'The necessary data is beyond the provided context. Please use the side panel for help.';
  for (const bad of [gemini, '', '   ', 'What is this?', 'a'.repeat(25), 'two\nlines']) {
    assert.equal(repo.isPlausibleLabel(bad), false, JSON.stringify(bad));
  }
});

test('refresh skips junk cells; design falls back to unmapped (Others)', async () => {
  const gemini = 'The necessary data is beyond the provided context. Please use the side panel for help.';
  inventoryRepository.getAll = async () => [
    { design: '9037', designCategory: gemini },      // junk-only design → unmapped
    { design: '44200', designCategory: gemini },     // junk first…
    { design: '44200', designCategory: 'Cashmere' }, // …valid later cell wins
  ];
  repo.invalidateCache();
  const m = await repo.getMap();
  assert.equal(m.get('9037') || '', '', 'junk-only design must be unmapped');
  assert.equal(m.get('44200'), 'Cashmere', 'valid later cell must win over junk');
});
