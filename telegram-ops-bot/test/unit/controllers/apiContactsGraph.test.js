'use strict';

/**
 * CNET-1c — /api/contacts/graph gating + payload shape.
 */

process.env.BOT_API_KEY = 'test-key-123';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const contactGraph = require(path.join(SRC, 'services/contactGraphService'));
const designCategoriesRepo = require(path.join(SRC, 'repositories/designCategoriesRepository'));
const contactLinksRepository = require(path.join(SRC, 'repositories/contactLinksRepository'));
const apiController = require(path.join(SRC, 'controllers/apiController'));

contactGraph.loadGraph = async () => ({
  nodes: new Map([
    ['CON-1', { contact_id: 'CON-1', name: 'CJE', type: 'customer', whatsapp: '', notes: '', customer_id: 'CUST-9' }],
    ['CON-2', { contact_id: 'CON-2', name: 'Musa', type: 'worker', whatsapp: '', notes: 'receives goods', customer_id: '' }],
  ]),
});
contactGraph.livePhoneOf = async (n) => (n.contact_id === 'CON-1' ? '+2348031234567' : '');
contactGraph.buyersOfCategory = async (cat) => (cat === 'Cashmere' ? [{ name: 'CJE', lastDate: '2026-07-10', designs: ['44200'], warehouses: ['Kano office'] }] : []);
designCategoriesRepo.listCategories = async () => ['Cashmere', 'Chinos'];
contactLinksRepository.getActive = async () => [{ from_contact_id: 'CON-2', to_contact_id: 'CON-1', relation: 'subordinate_of' }];

function call(headers = {}) {
  const out = { code: 200, body: null };
  const req = { headers, query: {} };
  const res = {
    status(c) { out.code = c; return res; },
    json(b) { out.body = b; return res; },
  };
  return apiController.getContactsGraph(req, res).then(() => out);
}

test('wrong/missing key → 403; valid key → full graph payload', async () => {
  const denied = await call({});
  assert.equal(denied.code, 403);
  const ok = await call({ 'x-api-key': 'test-key-123' });
  assert.equal(ok.code, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.nodes.length, 2);
  assert.equal(ok.body.nodes.find((n) => n.id === 'CON-1').phone, '+2348031234567', 'live phone resolved');
  assert.deepEqual(ok.body.edges, [{ from: 'CON-2', to: 'CON-1', relation: 'subordinate_of' }]);
  assert.deepEqual(Object.keys(ok.body.categories), ['Cashmere'], 'empty categories omitted');
});
