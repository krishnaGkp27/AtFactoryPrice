'use strict';

/**
 * typedRouter — TXT-1 (owner, 01-Nov-2026): "make all sheet read and write
 * prohibited through AI model API. It would either get through [the script
 * lines] or get message to open chips."
 *
 * A typed sentence never reaches OpenAI for the sheet. The controller tries
 * the three local script lines first (sell — SELL-T3, return — RET-5,
 * transfer — TRF-23); everything else lands here:
 *
 *   AI_TEXT_PARSER = 0  (default)  the chips card — OpenAI is never called
 *   AI_TEXT_PARSER = reads         the AI may answer a QUESTION about the
 *                                  sheet; an action that would change it is
 *                                  refused with the chips card
 *   AI_TEXT_PARSER = 1             the old behaviour (the AI drives both)
 *
 * The knob is a Settings cell, live within the 30-second settings cache, no
 * deploy — the owner's way back if staff struggle in the first week.
 *
 * "Read" is an explicit list: anything the AI names that is not on it is
 * treated as a write and refused in `reads` mode, so a new action code can
 * never slip through by omission.
 */

const settingsRepository = require('../repositories/settingsRepository');

/** Every intent-parser action that only READS the sheet. */
const READ_ACTIONS = Object.freeze([
  'check', 'list_packages', 'package_detail', 'analyze',
  'report_stock', 'report_valuation', 'report_sales', 'report_customers', 'report_warehouses',
  'report_fast_moving', 'report_dead_stock', 'report_indents', 'report_low_stock', 'report_aging',
  'report_supply_by_design', 'report_sold', 'report_last_transactions',
  'ask_data',
  'check_customer', 'check_balance', 'show_ledger', 'trial_balance', 'list_banks',
  'my_tasks', 'list_contacts', 'search_contact',
  'sample_status', 'customer_history', 'customer_ranking', 'customer_pattern', 'show_customer_notes',
  'inventory_details', 'sales_report_interactive', 'supply_details', 'my_orders',
]);

const MODES = Object.freeze(['0', 'reads', '1']);

let _forced = null;

/**
 * The live mode: '0' | 'reads' | '1'. Anything unreadable in the cell is '0'
 * (off) — the safe side of the owner's rule.
 * @returns {Promise<'0'|'reads'|'1'>}
 */
async function mode() {
  if (_forced != null) return _forced;
  let v;
  try { v = (await settingsRepository.getAll()).AI_TEXT_PARSER; } catch (_) { v = undefined; }
  return parseMode(v);
}

/** @param {*} v the raw Settings value @returns {'0'|'reads'|'1'} */
function parseMode(v) {
  const s = String(v == null ? '0' : v).trim().toLowerCase();
  if (s === '1' || s === 'on' || s === 'all' || s === 'true') return '1';
  if (s === 'reads' || s === 'read' || s === 'readonly' || s === 'read-only') return 'reads';
  return '0';
}

/** True when the AI-named action only reads the sheet. */
function isRead(action) {
  return READ_ACTIONS.includes(String(action || ''));
}

/** The chips card: what the bot does read, and the one way to everything else. */
function chipsCardText({ blockedWrite = null } = {}) {
  const lines = [];
  if (blockedWrite) lines.push('✋ Typed words never change the sheet.', '');
  lines.push(
    '👋 I work with the chips, not sentences.',
    '',
    'Three lines I do read:',
    '  • Sell 1100/1, 1091/1 kano',
    '  • Return 771, 779, 6189/5',
    '  • Transfer 832, 1186, 786 to kano',
    '',
    'Tap 🏠 Menu for everything else.',
  );
  return lines.join('\n');
}

/**
 * Send the chips card. Plain text (no Markdown — the sample lines carry `/`
 * and `,`), one 🏠 Menu button: `act:__back__` turns this very message into
 * the menu (session-free navigation, NAV-1).
 * @param {object} bot @param {number|string} chatId
 * @param {{blockedWrite?: string|null}} [opts]
 */
async function sendChipsCard(bot, chatId, opts = {}) {
  await bot.sendMessage(chatId, chipsCardText(opts), {
    reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] },
  });
}

/**
 * Test seam — pin the mode without a Settings read. The controller harness
 * forces '1' when a fake intent parser is installed (those tests exercise
 * the AI path on purpose); pass null to read Settings again.
 * @param {'0'|'reads'|'1'|null} m
 */
function forceMode(m) {
  _forced = m == null ? null : parseMode(m);
}

module.exports = { mode, parseMode, isRead, chipsCardText, sendChipsCard, forceMode, READ_ACTIONS, MODES };
