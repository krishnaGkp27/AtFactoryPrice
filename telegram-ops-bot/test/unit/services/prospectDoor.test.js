'use strict';

/**
 * PRS-1 — the pure half of the 🆕 Add Prospect door: who is offered the
 * tile, what counts as a business card, what a prospect must carry, and
 * which request row holds the card for a customer.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const prospectDoor = require('../../../src/services/prospectDoor');
const inbox = require('../../../src/flows/approvalsInboxFlow');

test('maySee: a marketer, a salesman, and active Sales / Marketing staff — nobody else', () => {
  assert.equal(prospectDoor.maySee({ role: 'marketer' }), true);
  assert.equal(prospectDoor.maySee({ role: 'Salesman', status: 'Active' }), true);
  assert.equal(prospectDoor.maySee({ role: 'employee', department: 'Sales' }), true);
  assert.equal(prospectDoor.maySee({ role: 'employee', departments: ['Dispatch', 'marketing'] }), true);
  assert.equal(prospectDoor.maySee({ role: 'employee', department: 'Dispatch' }), false);
  assert.equal(prospectDoor.maySee({ role: 'marketer', status: 'inactive' }), false, 'a removed person is offered nothing');
  assert.equal(prospectDoor.maySee(null), false);
});

test('cardFromMessage: the largest photo size, or an image sent as a File; nothing else', () => {
  assert.deepEqual(prospectDoor.cardFromMessage({ photo: [{ file_id: 's' }, { file_id: 'm' }, { file_id: 'L' }] }), { fileId: 'L', kind: 'photo' });
  assert.deepEqual(prospectDoor.cardFromMessage({ document: { file_id: 'D', mime_type: 'image/png' } }), { fileId: 'D', kind: 'document' });
  assert.equal(prospectDoor.cardFromMessage({ document: { file_id: 'P', mime_type: 'application/pdf' } }), null);
  assert.equal(prospectDoor.cardFromMessage({ text: 'hello' }), null);
  assert.equal(prospectDoor.cardFromMessage({ photo: [] }), null);
  assert.equal(prospectDoor.cardFromMessage(null), null);
});

test('hasFollowUp: a phone number OR a business card', () => {
  assert.equal(prospectDoor.hasFollowUp({ phone: '0806' }), true);
  assert.equal(prospectDoor.hasFollowUp({ phone: '', card: { fileId: 'F', kind: 'photo' } }), true);
  assert.equal(prospectDoor.hasFollowUp({ phone: '  ', card: null }), false);
  assert.equal(prospectDoor.hasFollowUp({}), false);
});

test('requestFields: only a prospect adds anything, and the card only when one was sent', () => {
  assert.deepEqual(prospectDoor.requestFields({ name: 'X' }), {}, 'the full form adds nothing');
  assert.deepEqual(prospectDoor.requestFields({ prospect: true, card: null }), { prospect: true });
  assert.deepEqual(prospectDoor.requestFields({ prospect: true, card: { fileId: 'F', kind: 'document' } }),
    { prospect: true, card_file_id: 'F', card_file_type: 'document' });
  assert.deepEqual(prospectDoor.requestFields({ prospect: true, card: { fileId: 'F', kind: 'photo' } }),
    { prospect: true, card_file_id: 'F', card_file_type: 'photo' });
});

test('approvedRequestFor: the newest APPROVED add_contact for the name, whatever the letter case', () => {
  const row = (id, name, status, at, extra = {}) => ({ requestId: id, user: '4242', status, createdAt: at, actionJSON: { action: 'add_contact', name, ...extra } });
  const rows = [
    row('a', 'Amib International', 'approved', '2026-11-01T10:00:00Z'),
    row('b', 'AMIB international ', 'Approved', '2026-11-05T10:00:00Z', { card_file_id: 'F2' }),
    row('c', 'Amib International', 'rejected', '2026-11-09T10:00:00Z', { card_file_id: 'F3' }),
    row('d', 'Someone Else', 'approved', '2026-11-10T10:00:00Z', { card_file_id: 'F4' }),
    { requestId: 'e', status: 'approved', createdAt: '2026-11-11T10:00:00Z', actionJSON: { action: 'sale_bundle', name: 'Amib International' } },
  ];
  assert.equal(prospectDoor.approvedRequestFor(rows, 'amib international').requestId, 'b');
  assert.deepEqual(prospectDoor.cardOfRow(prospectDoor.approvedRequestFor(rows, 'Amib International')), { fileId: 'F2', kind: 'photo' });
  assert.equal(prospectDoor.approvedRequestFor(rows, 'Nobody'), null);
  assert.equal(prospectDoor.approvedRequestFor(rows, ''), null);
  assert.equal(prospectDoor.cardOfRow(rows[0]), null, 'a request with no card');
});

test('the inbox offers the business card as the request\'s one attachment', () => {
  const { docPeek } = inbox._internals;
  assert.deepEqual(docPeek({ action: 'add_contact', card_file_id: 'F', card_file_type: 'photo' }), { fileId: 'F', label: '📇 Business card', asPhoto: true });
  assert.deepEqual(docPeek({ action: 'add_contact', card_file_id: 'F', card_file_type: 'document' }), { fileId: 'F', label: '📇 Business card', asPhoto: false });
  assert.equal(docPeek({ action: 'add_contact', name: 'X' }), null);
});
