'use strict';

/**
 * SRCH-1 — inline inventory search: index building, ranking, entity cards,
 * allow-list gating.
 */

process.env.ADMIN_IDS = '777';
process.env.EMPLOYEE_IDS = '4242';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const svc = require(path.join(SRC, 'services/searchService'));

const ROWS = [
  { packageNo: 'P58', design: '77019', shade: '3', warehouse: 'IDUMOTA', status: 'available', yards: 60, arrivalBatch: 'Jul26', designCategory: 'Chinos' },
  { packageNo: 'P58', design: '77019', shade: '3', warehouse: 'IDUMOTA', status: 'available', yards: 60, arrivalBatch: 'Jul26', designCategory: '' },
  { packageNo: 'P9', design: '44200', shade: '1', warehouse: 'Kano office', status: 'sold', yards: 55, soldTo: 'CJE', soldDate: '2026-07-10', arrivalBatch: 'Jul26', designCategory: 'Cashmere' },
  { packageNo: 'P77', design: '9037', shade: '8', warehouse: 'IDUMOTA', status: 'available', yards: 58, arrivalBatch: 'Jun26', designCategory: '' },
];

test('index groups thans into bales, designs, containers, categories', () => {
  const idx = svc.buildIndex(ROWS);
  const p58 = idx.bales.find((b) => b.packageNo === 'P58');
  assert.equal(p58.thansAvail, 2);
  assert.equal(p58.yardsAvail, 120);
  const d = idx.designs.find((x) => x.design === '77019');
  assert.equal(d.balesAvail.size, 1);
  assert.equal(idx.containers.find((c) => c.batch === 'Jul26').designs.size, 1, 'sold rows not counted as available');
  assert.ok(idx.categories.find((c) => c.category === 'Cashmere'));
});

test('numeric-ish query ranks bales first; sold bale card names the buyer', () => {
  const idx = svc.buildIndex(ROWS);
  const res = svc.search(idx, '58');
  assert.ok(res[0].title.startsWith('📦 Bale P58'), 'bale hit first for numeric query');
  const sold = svc.search(idx, 'p9');
  assert.match(sold[0].description, /SOLD to CJE on 2026-07-10/);
  assert.match(sold[0].input_message_content.message_text, /Sold to \*CJE\*/);
});

test('text query finds categories and designs; empty query yields nothing', () => {
  const idx = svc.buildIndex(ROWS);
  const cash = svc.search(idx, 'cashm');
  assert.ok(cash.some((r) => r.title.includes('Cashmere')));
  const des = svc.search(idx, '770');
  assert.ok(des.some((r) => r.title.includes('Design 77019')));
  assert.deepEqual(svc.search(idx, ''), []);
});

test('handleInlineQuery: staff get results, strangers get an empty personal panel', async () => {
  inventoryRepository.getAll = async () => ROWS;
  const answers = [];
  const bot = { answerInlineQuery: async (id, results, opts) => { answers.push({ id, results, opts }); } };
  await svc.handleInlineQuery(bot, { id: 'q1', from: { id: 4242 }, query: '58' });
  assert.ok(answers[0].results.length > 0, 'allow-listed employee gets suggestions');
  assert.deepEqual(answers[0].opts, { cache_time: 0, is_personal: true });
  await svc.handleInlineQuery(bot, { id: 'q2', from: { id: 999999 }, query: '58' });
  assert.equal(answers[1].results.length, 0, 'stranger gets nothing');
});
