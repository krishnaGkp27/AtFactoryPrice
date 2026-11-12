#!/usr/bin/env node
'use strict';

/**
 * PAYMENT JOURNEY — segment "setup": the two screens that show the finance
 * phone is set up (the owner's set-up page of the PAY-6 guides).
 *
 *   node scripts/pay6-capture/setup.js > setup.json   (from telegram-ops-bot/)
 *   (BOT_ROOT = the bot folder; default the folder two levels above this script)
 *
 * Runs finance.js's extra scenario `setup_check` in a child process with the
 * set-up the owner is asked to make — Railway FINANCE_IDS = the finance phone
 * (7001), the finance phone's Users row in department Finance, not an admin —
 * and prints ONE JSON document on stdout in the shape of finance.json:
 * Krishna (admin) opens 💳 Payments, then the finance phone opens 💳 Payments.
 * Same fakes, clock and worked example as finance.js; nothing is written.
 */

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.BOT_ROOT || path.resolve(__dirname, '..', '..');
const FINANCE_JS = path.join(__dirname, 'finance.js');

const env = {
  PATH: process.env.PATH || '', HOME: process.env.HOME || '', TZ: 'UTC',
  ADMIN_IDS: '9001,9002', EMPLOYEE_IDS: '5001,7001', FINANCE_IDS: '7001',
  BOT_ROOT: ROOT,
};
const res = spawnSync(process.execPath, [FINANCE_JS, '--scenario', 'setup_check'], {
  cwd: ROOT, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
});
if (res.status !== 0) {
  process.stderr.write(res.stderr || '');
  process.stderr.write(`\nScenario setup_check failed (exit ${res.status}).\n`);
  process.exit(1);
}
const doc = JSON.parse(res.stdout);
const seen = doc.cards.filter((c) => !(c.kind === 'popup' && !c.text)
  && !/^TRANSIENT/.test(c.notes || '') && c.kind !== 'delete');
const out = {
  segment: 'setup',
  env: { FINANCE_IDS: '7001', ADMIN_IDS: '9001,9002' },
  cast: { Abdul: '5001', Krishna: '9001', Musa: '9002', Finance: '7001' },
  cards: seen.map((c, i) => ({
    n: i + 1, scenario: 'setup_check', step: c.step, actor: c.actor, recipient: c.recipient, kind: c.kind,
    text: c.text, parse_mode: c.parse_mode || '', buttons: c.buttons || [], callbacks: c.callbacks || [],
    notes: c.notes || '',
  })),
};
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
