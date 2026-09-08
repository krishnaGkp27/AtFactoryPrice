'use strict';

/**
 * ISC-1 Phase 1a — readRangeUnformatted.
 *
 * A formatted read hands back what a cell DISPLAYS, so a real date cell and
 * a text cell holding the same characters are indistinguishable. The audit
 * needs the cell TYPE, which only valueRenderOption 'UNFORMATTED_VALUE'
 * exposes (a date cell → serial number, a text cell → string). This pins
 * that the new reader asks for it, that readRange still does NOT (the bot
 * parses the formatted text), and that both hand back [] for an empty range.
 *
 * googleapis is stubbed at the module boundary before sheetsClient loads —
 * no credentials, no network. node:test runs this file in its own process,
 * so the stub cannot leak into another test.
 */

process.env.GOOGLE_CREDENTIALS_JSON = JSON.stringify({ client_email: 'audit@test', private_key: 'not-a-key' });
process.env.GOOGLE_SHEET_ID = 'sheet-under-test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { google } = require('googleapis');

const calls = [];
let nextValues = [];
google.auth.GoogleAuth = class FakeGoogleAuth { async getClient() { return {}; } };
google.sheets = () => ({
  spreadsheets: {
    values: {
      get: async (params) => { calls.push(params); return { data: { values: nextValues } }; },
    },
  },
});

const sheetsClient = require('../../../src/repositories/sheetsClient');

test('readRangeUnformatted asks for UNFORMATTED_VALUE and returns the raw cells', async () => {
  nextValues = [[46000, 'madam oshodi', 'cashmere 12-February-2026'], [46050, 'CJE', 46180]];
  const rows = await sheetsClient.readRangeUnformatted('Inventory', 'K2:M');
  assert.deepEqual(rows, nextValues);
  const call = calls[calls.length - 1];
  assert.equal(call.valueRenderOption, 'UNFORMATTED_VALUE');
  assert.equal(call.range, 'Inventory!K2:M');
  assert.equal(call.spreadsheetId, 'sheet-under-test');
  // A date cell is a NUMBER, a text cell a STRING — the whole point.
  assert.equal(typeof rows[0][0], 'number');
  assert.equal(typeof rows[0][2], 'string');
});

test('readRange is unchanged: no valueRenderOption, so the bot keeps parsing formatted text', async () => {
  nextValues = [['2026-02-24', 'madam oshodi', 'cashmere 12-February-2026']];
  const rows = await sheetsClient.readRange('Inventory', 'K2:M');
  assert.deepEqual(rows, nextValues);
  const call = calls[calls.length - 1];
  assert.equal(call.valueRenderOption, undefined);
  assert.equal(call.range, 'Inventory!K2:M');
});

test('an empty range reads back as [] from both readers', async () => {
  nextValues = undefined;
  assert.deepEqual(await sheetsClient.readRangeUnformatted('Inventory', 'K2:M'), []);
  assert.deepEqual(await sheetsClient.readRange('Inventory', 'K2:M'), []);
});
