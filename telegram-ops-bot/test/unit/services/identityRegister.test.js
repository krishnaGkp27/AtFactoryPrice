'use strict';

/**
 * IDR-1 — the Telegram identity register (owner ruling, 14-Aug-2026).
 *
 * "I want user identity to be placed in one sheet… only thing expandable
 * should be attribute of the column or new column in case of new attribute
 * set, like in tabular form."
 *
 * PendingUsers already holds a row for every account that ever messaged
 * the bot, so it became the register; five plain end-columns say what each
 * account IS. Customers/Contacts/Marketers keep no telegram_id — one place
 * cannot drift from itself.
 *
 * Pinned:
 *  - linking writes ONLY the link columns + status, never disturbing the
 *    arrival record the person was captured with;
 *  - an employee stays 'onboarded' (they are staff and can use the bot);
 *    a customer or contact becomes 'linked' — known, but not staff;
 *  - the reverse lookup (the whole point: reaching a CUSTOMER on Telegram)
 *    matches on id, and refuses to guess when a name is ambiguous or an
 *    id was supplied but did not match;
 *  - an unknown account, a bad type and a sheet outage all fail quietly.
 */

const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { installFakeSheets, SRC } = require('../../helpers/controllerHarness');
const { createFakeSheets } = require('../../helpers/fakeSheets');

installFakeSheets(createFakeSheets({}));
const repo = require(path.join(SRC, 'repositories/pendingUsersRepository'));
const sheets = require(path.join(SRC, 'repositories/sheetsClient'));
const identity = require(path.join(SRC, 'services/identityService'));

/** A register row: A–I arrival, J–N link. */
function row(o) {
  return [
    o.telegram_id, o.username || '', o.first_name || '', o.last_name || '',
    o.arrived_at || '2026-08-01T10:00:00.000Z', o.status || 'pending', '', '', '',
    o.link_type || '', o.link_id || '', o.link_name || '', o.linked_by || '', o.linked_at || '',
  ];
}

function stub(rows) {
  const writes = [];
  sheets.readRange = async (name, range) => {
    if (name !== 'PendingUsers') return [];
    return /^A1/.test(range) ? [repo.HEADERS] : rows;
  };
  sheets.updateRange = async (name, range, values) => { writes.push({ range, values }); };
  return writes;
}

test('IDR-1: linking a customer writes ONLY the link columns and the status', async () => {
  const writes = stub([row({ telegram_id: '8968542393', first_name: 'Mr', last_name: 'femi' })]);
  const res = await identity.link('8968542393',
    { type: 'customer', id: 'CUST-20260813-DF49AA89', name: 'Mr femi' }, '7863545956');
  assert.equal(res.ok, true);

  const ranges = writes.map((w) => w.range);
  assert.deepEqual(ranges, ['F2', 'J2:N2'],
    'status and the link block — the arrival record (A–E) is never rewritten');
  const link = writes[1].values[0];
  assert.equal(link[0], 'customer');
  assert.equal(link[1], 'CUST-20260813-DF49AA89');
  assert.equal(link[2], 'Mr femi', 'the name is stored so the row reads without a cross-lookup');
  assert.equal(link[3], '7863545956');
  assert.match(link[4], /^\d{2}-\w{3}-\d{4}/, `linked_at is human-readable, got: ${link[4]}`);
  assert.equal(writes[0].values[0][0], 'linked', 'a customer is known, but not staff');
});

test('IDR-1: an employee link keeps the onboarded status', async () => {
  const writes = stub([row({ telegram_id: '7430648262', first_name: 'Abdul' })]);
  await identity.link('7430648262', { type: 'employee', id: '7430648262', name: 'Abdul' }, '777');
  assert.equal(writes[0].values[0][0], 'onboarded',
    'staff are in the Users sheet and can use the bot — that is what onboarded means');
});

test('IDR-1: the reverse lookup finds a customer\'s chat — the reason the register exists', async () => {
  stub([
    row({ telegram_id: '111', link_type: 'customer', link_id: 'CUST-A', link_name: 'Mr femi' }),
    row({ telegram_id: '222', link_type: 'contact', link_id: 'CON-B', link_name: 'Solomon' }),
    row({ telegram_id: '333' }),
  ]);
  assert.equal(await identity.telegramIdFor('customer', { id: 'CUST-A' }), '111');
  assert.equal(await identity.telegramIdFor('contact', { id: 'CON-B' }), '222');
  assert.equal(await identity.telegramIdFor('customer', { id: 'CON-B' }), '',
    'a contact id must not resolve through the customer domain');
});

test('IDR-1: a supplied id that does not match NEVER falls back to the name', async () => {
  stub([row({ telegram_id: '111', link_type: 'customer', link_id: 'CUST-A', link_name: 'Mr femi' })]);
  const hit = await identity.telegramIdFor('customer', { id: 'CUST-WRONG', name: 'Mr femi' });
  assert.equal(hit, '',
    'two customers can share a display name — only the id is identity, so a miss is a miss');
});

test('IDR-1: an ambiguous name resolves to nothing, never to one of two chats', async () => {
  stub([
    row({ telegram_id: '111', link_type: 'customer', link_name: 'Mr femi' }),
    row({ telegram_id: '222', link_type: 'customer', link_name: 'Mr Femi' }),
  ]);
  assert.equal(await identity.telegramIdFor('customer', { name: 'Mr femi' }), '',
    'sending a customer document to the wrong person is worse than not sending it');
});

test('IDR-1: a name-only lookup works when exactly one account carries it', async () => {
  stub([
    row({ telegram_id: '111', link_type: 'customer', link_name: 'Mr femi' }),
    row({ telegram_id: '222', link_type: 'customer', link_name: 'Solomon' }),
  ]);
  assert.equal(await identity.telegramIdFor('customer', { name: 'MR FEMI' }), '111',
    'case-insensitive, but exact');
});

test('IDR-1: whoIs reports an unlinked account as unlinked, not as missing', async () => {
  stub([row({ telegram_id: '333', first_name: 'Dika' })]);
  const who = await identity.whoIs('333');
  assert.equal(who.link_type, '', 'the account is known — it just has not been placed yet');
  assert.equal(who.name, 'Dika');
  assert.equal(who.status, 'pending');
  assert.equal(await identity.whoIs('999'), null, 'an account that never messaged is null');
});

test('IDR-1: bad input and a sheet outage fail quietly, never throwing at a caller', async () => {
  stub([row({ telegram_id: '111' })]);
  assert.equal((await identity.link('', { type: 'customer' }, 'x')).ok, false);
  // MYP-1 §16 — 'marketer' became a REAL link domain (owner 23-Aug-2026);
  // a genuinely unknown domain is still refused.
  assert.equal((await identity.link('111', { type: 'alien' }, 'x')).ok, false, 'unknown domain refused');
  assert.equal((await identity.link('111', { type: 'marketer', id: 'MK-1', name: 'M' }, 'x')).ok, true, 'marketer links like a customer');
  assert.equal((await identity.link('404', { type: 'customer' }, 'x')).ok, false, 'no row for that account');

  sheets.readRange = async () => { throw new Error('sheet unreachable'); };
  assert.equal(await identity.telegramIdFor('customer', { id: 'CUST-A' }), '');
  assert.equal(await identity.whoIs('111'), null);
  assert.deepEqual(await identity.listLinked('customer'), []);
});
