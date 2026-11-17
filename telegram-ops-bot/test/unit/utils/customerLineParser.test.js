'use strict';

/**
 * CUS-4 — the typed customer line, parsed locally. The phone number is the
 * signal: with one, name / phone / town are read from separate lines or
 * comma parts, with or without `Customer` in front; without one, nothing is
 * ever taken for a person.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCustomerLine } = require('../../../src/utils/customerLineParser');

const pick = (r) => (r ? { name: r.name, phone: r.phone, address: r.address, form: r.form } : null);

test('the owner\'s screenshot: three bare lines are a customer', () => {
  assert.deepEqual(pick(parseCustomerLine('Amib international\n0806 256 2752\nKano')),
    { name: 'Amib international', phone: '0806 256 2752', address: 'Kano', form: 'bare' });
});

test('bare: commas instead of lines, two parts, any order of phone and town, a longer address', () => {
  assert.deepEqual(pick(parseCustomerLine('Amib international, 0806 256 2752, Kano')),
    { name: 'Amib international', phone: '0806 256 2752', address: 'Kano', form: 'bare' });
  assert.deepEqual(pick(parseCustomerLine('Mariam Salisu\n+234-803-555-7777')),
    { name: 'Mariam Salisu', phone: '+234-803-555-7777', address: '', form: 'bare' });
  assert.deepEqual(pick(parseCustomerLine('Wang Tex\nKantin Kwari, Kano\n08031234567')),
    { name: 'Wang Tex', phone: '08031234567', address: 'Kantin Kwari, Kano', form: 'bare' });
  assert.deepEqual(pick(parseCustomerLine('08031234567\nAlhaji Bello\nIdumota')),
    { name: 'Alhaji Bello', phone: '08031234567', address: 'Idumota', form: 'bare' }, 'the phone may come first');
});

test('worded: Customer / Add customer / New customer, with commas, lines or neither', () => {
  const want = { name: 'Amib international', phone: '0806 256 2752', address: 'Kano', form: 'worded' };
  for (const line of [
    'Customer Amib international, 0806 256 2752, Kano',
    'customer: Amib international, 0806 256 2752, Kano',
    'Add customer Amib international, 0806 256 2752, Kano',
    'New customer\nAmib international\n0806 256 2752\nKano',
    'Please add a new customer Amib international, 0806 256 2752, Kano',
    'Customer Amib international 0806 256 2752 Kano',
  ]) assert.deepEqual(pick(parseCustomerLine(line)), want, line);
  assert.deepEqual(pick(parseCustomerLine('Customer Musa 08031234567')),
    { name: 'Musa', phone: '08031234567', address: '', form: 'worded' });
});

test('labels are read and dropped; a second number is kept, never lost', () => {
  assert.deepEqual(pick(parseCustomerLine('Name: Amib international\nPhone: 0806 256 2752\nAddress: Kano')),
    { name: 'Amib international', phone: '0806 256 2752', address: 'Kano', form: 'bare' });
  const two = parseCustomerLine('Amib international\n0806 256 2752\n0703 111 2222\nKano');
  assert.equal(two.phone, '0806 256 2752');
  assert.deepEqual(two.otherPhones, ['0703 111 2222']);
  assert.equal(two.address, 'Kano');
});

test('no phone number, no customer: lookups, script lines and sentences are left alone', () => {
  for (const line of [
    'Customer Abba',                       // opens Abba's details, as before
    'Add customer Mariam Salisu',          // the Add Contact button, as before
    'Amib international\nKano',            // no phone
    'Sell 1111, 1112 to Abba',
    'Return 771, 779, 6189/5',
    'Transfer 832, 1186, 786 to kano',
    'Stock 9006 black',
    'Price 9006 black 1500',
    '1112',
    'What\'s in Lagos?',
    'hello',
    '',
    '/start',
  ]) assert.equal(parseCustomerLine(line), null, line);
});

test('one undivided sentence is never a person, whatever number it carries', () => {
  assert.equal(parseCustomerLine('call me on 08062562752'), null);
  assert.equal(parseCustomerLine('Amib international 0806 256 2752 Kano'), null, 'bare needs lines or commas; the worded form reads this');
  assert.equal(parseCustomerLine('08062562752'), null, 'a number alone has no name');
});

test('what is refused: a name with no letter, a short or long "phone", too many parts, a very long part', () => {
  assert.equal(parseCustomerLine('1111, 08062562752'), null, 'a bale number is not a name');
  assert.equal(parseCustomerLine('Amib, 12345'), null, 'five digits are not a phone');
  assert.equal(parseCustomerLine('Amib, 1234567890123456789'), null, 'nineteen digits are not a phone');
  assert.equal(parseCustomerLine('Phone: Kano\nAmib'), null, 'labelled a phone, but it is not one');
  assert.equal(parseCustomerLine('a, b, c, d, e, f, 08062562752'), null, 'seven parts');
  assert.equal(parseCustomerLine(`${'x'.repeat(90)}\n08062562752`), null);
});

test('the name and the address cannot break the card: Markdown characters are dropped, spaces tidied', () => {
  const r = parseCustomerLine('Amib_international *Ltd*\n0806  256   2752\n[Kano] `office`');
  assert.equal(r.name, 'Amib international Ltd');
  assert.equal(r.phone, '0806 256 2752');
  assert.equal(r.address, 'Kano office');
});
