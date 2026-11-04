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

/**
 * TXT-2 (owner, 03-Nov-2026: Abdul typed "Bale details of 1111" four times
 * and got "Need more info" — "Yes is asking for bale card"). The words that
 * may surround ONE bale number for the line to mean "show me that bale".
 * Any other word — a verb like sell / transfer, a name, a colour — and the
 * line is not claimed. Deterministic, no AI, in every mode.
 */
const BALE_QUERY_WORDS = new Set([
  'bale', 'bales', 'package', 'packages', 'pkg', 'pkgs',
  'detail', 'details', 'info', 'information', 'status', 'card', 'view',
  'of', 'for', 'on', 'about', 'in', 'is', 'what', 'where',
  'show', 'check', 'see', 'open', 'give', 'get', 'me', 'the', 'a', 'this', 'that',
  'please', 'pls', 'kindly', 'no', 'number', 'num',
]);

/**
 * The local READ lines the bot answers itself. Today: the bale card —
 * `1112` · `Bale 1112` · `Bale details of 1112` · `Details for package 1112`
 * · `show me bale 1112`. Returns an intent the controller's existing
 * `package_detail` branch renders, or null when the line is not claimed.
 * @param {string} raw
 * @returns {{action:'package_detail', packageNo:string, confidence:number, clarification:null, local:true}|null}
 */
function localReadIntent(raw) {
  const t = String(raw || '').trim();
  if (!t || t.length > 80) return null;
  const nums = t.match(/\d+/g) || [];
  if (nums.length !== 1) return null;            // one number, or it is not a bale line
  const n = nums[0];
  if (n.length < 2 || n.length > 7) return null;
  const words = t.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\d+/g, ' ').split(/\s+/).filter(Boolean);
  if (words.some((w) => !BALE_QUERY_WORDS.has(w))) return null;
  return { action: 'package_detail', packageNo: n, confidence: 1, clarification: null, local: true };
}

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

/* ── TXT-3 (owner's final go, 04-Nov-2026) — the WHOLE script ────────────
 *
 * "Let me know exactly how many of them will not go through without this
 * OpenAI API, so that you can code them directly, making a constant script
 * like a syntax without any further failure." The first word is the verb;
 * the body is read deterministically; a recognised verb with a bad body gets
 * ITS line back (never the generic card); an unknown first word gets the
 * chips card. Every intent produced here lands on the controller's existing
 * branch, so every write still opens its approval card — typed words never
 * change the sheet (§20). The owner's 01-Nov ruling stands: no typed payment
 * line — `Payment …` points at the tap door.
 */
const SYNTAX = Object.freeze({
  sell: 'Sell 771, 779, 6189/5 to Abba',
  return: 'Return 771, 779, 6189/5',
  transfer: 'Transfer 832, 1186, 786 to kano',
  bale: 'Bale 1112',
  stock: 'Stock 9006 black · Stock at Lagos',
  balance: 'Balance Abba',
  ledger: 'Ledger Abba',
  price: 'Price 9006 black 1500',
  delivered: 'Delivered ORD-20260221-001',
  receive: 'Receive',
  customer: 'Customer Abba',
});
const VERBS = Object.freeze({
  sell: 'sell', sale: 'sell', sold: 'sell',
  return: 'return', returned: 'return',
  transfer: 'transfer', move: 'transfer', send: 'transfer',
  stock: 'stock', check: 'stock',
  bale: 'bale', package: 'bale', pkg: 'bale',
  balance: 'balance', outstanding: 'balance',
  ledger: 'ledger', statement: 'ledger',
  price: 'price',
  receive: 'receive', restock: 'receive', addstock: 'receive', add: 'add',
  order: 'order', orders: 'orders',
  task: 'task', tasks: 'tasks', done: 'done',
  delivered: 'delivered',
  report: 'report', reports: 'report',
  contact: 'contact', contacts: 'contacts', customer: 'customer', customers: 'contacts',
  user: 'user', employee: 'user',
  bank: 'banks', banks: 'banks',
  menu: 'menu', help: 'help', payment: 'payment', paid: 'payment', pay: 'payment',
});
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'me', 'please', 'pls', 'kindly', 'my', 'all', 'show']);

const intent = (action, fields = {}) => ({ action, ...fields, confidence: 1, clarification: null, local: true });
const hint = (verb, note = '') => ({ action: '__hint__', verb, syntax: SYNTAX[verb] || '', note });
const tile = (label, callback, text) => ({ action: '__tile__', label, callback, text });

/**
 * The script: the first word decides, the body is read deterministically.
 * @param {string} raw
 * @returns {object|null} an intent for the controller's switch, `__hint__`
 *   (a known verb, bad body), `__tile__` (one button to a door), `__help__`,
 *   or null when the first word is not in the script.
 */
function localIntent(raw) {
  let t = String(raw || '').trim().replace(/^\/+/, '').replace(/^(?:please|pls|kindly)\s+/i, '').trim();
  if (!t || t.length > 160) return null;
  const words = t.split(/\s+/);
  const first = words[0].toLowerCase().replace(/[^a-z]/g, '');
  const verb = VERBS[first];
  if (!verb) return null;
  const rest = words.slice(1).join(' ').trim();
  const restWords = rest ? rest.split(/\s+/) : [];
  const restLc = rest.toLowerCase();
  switch (verb) {
    case 'help': return { action: '__help__' };
    case 'menu': return tile('🏠 Menu', 'act:__back__', '🏠 The menu is one tap away.');
    case 'sell': case 'return': case 'transfer':
      // The local doors in front of the router claim every line with numbers;
      // reaching here means there were none.
      return hint(verb, verb === 'transfer' ? 'Bale numbers, then the store it goes to.' : 'Bale numbers, a than as 6189/5.');
    case 'bale': {
      const nums = rest.match(/\d+/g) || [];
      if (nums.length !== 1) return hint('bale', 'One bale number.');
      return intent('package_detail', { packageNo: nums[0] });
    }
    case 'stock': {
      const f = {};
      const at = rest.match(/\b(?:at|in|from)\s+(.+)$/i);
      let body = rest;
      if (at) { f.warehouse = at[1].trim(); body = rest.slice(0, at.index).trim(); }
      const toks = body.split(/\s+/).filter((w) => w && !STOP.has(w.toLowerCase()));
      const di = toks.findIndex((w) => /\d/.test(w));
      if (di >= 0) { f.design = toks[di]; toks.splice(di, 1); }
      if (toks.length) f.shade = toks.join(' ');
      if (f.shade && !f.design) return hint('stock', 'The design number first, then the shade.');
      return intent('check', f);
    }
    case 'balance': return rest ? intent('check_balance', { customer: rest }) : hint('balance', 'The customer\'s name.');
    case 'ledger': return rest ? intent('show_ledger', { customer: rest }) : hint('ledger', 'The customer\'s name.');
    case 'customer': return rest ? intent('check_customer', { customer: rest }) : tile('👥 CRM', 'act:__hub__:crm', '👥 Customers live in CRM.');
    case 'price': {
      const toks = restWords.slice();
      const last = toks.length ? toks[toks.length - 1].replace(/,/g, '') : '';
      const price = /^\d+(?:\.\d+)?$/.test(last) ? Number(last) : NaN;
      if (toks.length < 2 || !Number.isFinite(price) || price <= 0) return hint('price', 'Design, shade (optional), then the new rate.');
      toks.pop();
      return intent('update_price', { design: toks[0], shade: toks.slice(1).join(' ') || null, price });
    }
    case 'receive': return intent('add');
    case 'add': {
      if (/^(stock|bales?|goods|container)\b/i.test(restLc)) return intent('add');
      if (/^(contact|customer|person|marketer|prospect)\b/i.test(restLc)) return tile('➕ Add Contact', 'act:add_customer', '➕ Adding a person is tap-only — Add Contact asks the kind first.');
      if (/^(user|employee|staff)\b/i.test(restLc)) return tile('➕ Add Employee', 'act:add_user', '➕ Adding an employee is tap-only.');
      return hint('receive', 'Receive opens Add Stock; "Add contact" or "Add employee" open their doors.');
    }
    case 'order': return intent('create_order');
    case 'orders': return intent('my_orders');
    case 'task': return intent('assign_task');
    case 'tasks': return intent('my_tasks');
    case 'done': return intent('mark_task_done');
    case 'delivered': {
      const id = restWords[0];
      return id ? intent('mark_order_delivered', { orderId: id }) : hint('delivered', 'The order id from the order card.');
    }
    case 'report': {
      if (/^(sales?|sold)\b/.test(restLc)) return intent('report_sold');
      if (/^(stock|supply|designs?)\b/.test(restLc)) return intent('report_supply_by_design');
      if (/^(last|recent|transactions?)\b/.test(restLc)) return intent('report_last_transactions');
      return tile('📊 Reporting', 'act:__hub__:reporting', '📊 Every report is a tap away.');
    }
    case 'contact': return tile('➕ Add Contact', 'act:add_customer', '➕ Adding a person is tap-only — Add Contact asks the kind first.');
    case 'contacts': return intent('list_contacts');
    case 'user': return tile('➕ Add Employee', 'act:add_user', '➕ Adding an employee is tap-only.');
    case 'banks': return intent('list_banks');
    case 'payment': return hint('payment', 'Payments are recorded by tap, never by a typed line (owner, 01-Nov-2026): 💰 Finance → 💳 Payments.');
    default: return null;
  }
}

/** The one-line answer to a known verb typed with a bad body. */
function hintCardText({ verb, syntax, note } = {}) {
  const name = verb ? verb[0].toUpperCase() + verb.slice(1) : 'That line';
  const lines = [`✍️ ${name}${syntax ? ' needs its line:' : ':'}`];
  if (syntax) lines.push(`  ${syntax}`);
  if (note) lines.push('', note);
  return lines.join('\n');
}

async function sendHintCard(bot, chatId, h) {
  await bot.sendMessage(chatId, hintCardText(h), {
    reply_markup: { inline_keyboard: [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]] },
  });
}

/** The chips card: the whole script, and the one way to everything else. */
function chipsCardText({ blockedWrite = null } = {}) {
  const lines = [];
  if (blockedWrite) lines.push('✋ Typed words never change the sheet.', '');
  lines.push(
    '👋 I work with the chips, not sentences.',
    '',
    'Lines I do read:',
    '  • 1112 or Bale 1112 — the bale card',
    '  • Sell 1111, 1112 to Abba',
    '  • Return 771, 779, 6189/5',
    '  • Transfer 832, 1186, 786 to kano',
    '  • Stock 9006 black · Stock at Lagos',
    '  • Balance Abba · Ledger Abba (admins)',
    '  • Price 9006 black 1500 (admins)',
    '  • Receive · Order · Task · Delivered ORD-…',
    '  • Tasks · Orders · Contacts · Banks · Report sales',
    '  • Help — this card',
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

module.exports = {
  mode, parseMode, isRead, localReadIntent, localIntent, chipsCardText, sendChipsCard, hintCardText, sendHintCard, forceMode,
  READ_ACTIONS, MODES, BALE_QUERY_WORDS, SYNTAX, VERBS,
};
