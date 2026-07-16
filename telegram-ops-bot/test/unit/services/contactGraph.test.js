'use strict';

/**
 * CNET-1a — phone normalization, graph traversal (cycles, multi-parent,
 * depth cap), and the derived category→buyers join.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const SRC = path.join(__dirname, '../../../src');
const phone = require(path.join(SRC, 'utils/phone'));
const contactsRepository = require(path.join(SRC, 'repositories/contactsRepository'));
const contactLinksRepository = require(path.join(SRC, 'repositories/contactLinksRepository'));
const customersRepository = require(path.join(SRC, 'repositories/customersRepository'));
const inventoryRepository = require(path.join(SRC, 'repositories/inventoryRepository'));
const graph = require(path.join(SRC, 'services/contactGraphService'));

test('phone: Nigerian and international shapes normalize; garbage rejected', () => {
  assert.equal(phone.normalizePhone('0803 456 7890').e164, '+2348034567890');
  assert.equal(phone.normalizePhone('803-456-7890').e164, '+2348034567890');
  assert.equal(phone.normalizePhone('2348034567890').e164, '+2348034567890');
  assert.equal(phone.normalizePhone('+91 98765 43210').e164, '+919876543210');
  const unknown = phone.normalizePhone('456789012');
  assert.equal(unknown.ok, true);
  assert.equal(unknown.e164, null, 'ambiguous origin stays non-E.164');
  assert.equal(phone.normalizePhone('12345').ok, false, 'too short');
  assert.equal(phone.normalizePhone('call me').ok, false, 'letters rejected');
  assert.ok(phone.samePhone('08034567890', '+2348034567890'), 'historic formats match on last 10');
});

function node(id, name, extra = {}) {
  return { contact_id: id, name, phone: '', whatsapp: '', status: 'active', customer_id: '', ...extra };
}
function edge(from, to) {
  return { link_id: `L-${from}-${to}`, from_contact_id: from, to_contact_id: to, relation: 'subordinate_of', status: 'active' };
}

test('graph: multi-parent, recursion, cycle tolerance, depth cap', async () => {
  contactsRepository.getAll = async () => [
    node('A', 'Alabi'), node('B', 'Bello'), node('M', 'Musa'), node('K', 'Kabir'), node('Z', 'Zed'),
  ];
  // Musa serves BOTH Alabi and Bello; Kabir under Musa; Z↔A cycle in dirty data.
  contactLinksRepository.getActive = async () => [
    edge('M', 'A'), edge('M', 'B'), edge('K', 'M'), edge('Z', 'A'), edge('A', 'Z'),
  ];
  const g = await graph.loadGraph();
  assert.deepEqual(graph.subordinatesOf(g, 'A').map((n) => n.contact_id).sort(), ['M', 'Z']);
  assert.deepEqual(graph.superiorsOf(g, 'M').map((n) => n.contact_id).sort(), ['A', 'B'], 'multi-parent');
  const tree = graph.treeOf(g, 'A');
  const ids = tree.map((t) => t.node.contact_id);
  assert.ok(ids.includes('K'), 'recurses to depth 2');
  assert.equal(ids.filter((i) => i === 'A').length, 0, 'cycle back to root never revisits');
  assert.equal(tree.find((t) => t.node.contact_id === 'K').depth, 2);
  const shallow = graph.treeOf(g, 'A', 1);
  assert.ok(!shallow.map((t) => t.node.contact_id).includes('K'), 'depth cap respected');
});

test('buyersOfCategory: single-snapshot join, recency-first, category from first non-empty row', async () => {
  inventoryRepository.getAll = async () => [
    { design: '44200', designCategory: 'Cashmere', status: 'sold', soldTo: 'CJE', soldDate: '2026-07-01' },
    { design: '44200', designCategory: '', status: 'sold', soldTo: 'Alabi Johnson', soldDate: '2026-07-10' },
    { design: '44201', designCategory: 'Cashmere', status: 'sold', soldTo: 'CJE', soldDate: '2026-06-20' },
    { design: '77019', designCategory: 'Chinos', status: 'sold', soldTo: 'OKSON', soldDate: '2026-07-12' },
    { design: '44200', designCategory: '', status: 'available', soldTo: '', soldDate: '' },
  ];
  const buyers = await graph.buyersOfCategory('Cashmere');
  assert.deepEqual(buyers.map((b) => b.name), ['Alabi Johnson', 'CJE'], 'recency first');
  assert.deepEqual(buyers[1].designs.sort(), ['44200', '44201']);
  assert.ok(!buyers.some((b) => b.name === 'OKSON'), 'other categories excluded');
});

test('ensureNodeForCustomer: backlinks CRM row once, reuses thereafter', async () => {
  const appended = [];
  customersRepository.findByName = async (n) => (n === 'CJE' ? { customer_id: 'CUST-1', name: 'CJE', phone: '08031112222', address: 'Kano' } : null);
  contactsRepository.findByCustomerId = async () => null;
  contactsRepository.append = async (c) => { appended.push(c); return { ...c, contact_id: 'CON-X' }; };
  const n1 = await graph.ensureNodeForCustomer('CJE', 'admin');
  assert.equal(n1.customer_id, 'CUST-1');
  assert.equal(appended.length, 1, 'shadow node created');
  contactsRepository.findByCustomerId = async () => ({ contact_id: 'CON-X', customer_id: 'CUST-1', name: 'CJE' });
  const n2 = await graph.ensureNodeForCustomer('CJE', 'admin');
  assert.equal(n2.contact_id, 'CON-X');
  assert.equal(appended.length, 1, 'no duplicate node on second call');
});
