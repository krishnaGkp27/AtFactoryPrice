'use strict';

/**
 * inventoryHeaderRepair — INV-HDR1, a one-off guarded cleanup
 * (owner-approved 03-Aug-2026).
 *
 * WHY: commit 480d46e briefly extended the Inventory sheet with two movement
 * columns (X `prev_state`, Y `state_since`). The owner then ruled against
 * ANY new Inventory columns and the code was reverted in cffa58a — but a
 * deploy that ran in the window between the two could have written the two
 * HEADER cells. Nothing reads or writes them now, so they are cosmetic
 * orphans; the owner asked for them gone.
 *
 * WHAT IT DOES — deliberately narrow. It clears X1:Y1 only when ALL hold:
 *   - X1 and Y1 read exactly 'prev_state' and 'state_since' (any other
 *     content means a human or a future feature owns those columns — hands
 *     off);
 *   - the Inventory header is exactly 25 wide (A..Y), i.e. nothing was
 *     added after them that would shift on a rewrite;
 *   - EVERY cell below row 1 in both columns is empty, checked over the
 *     whole sheet. One non-empty cell anywhere means real data lives there
 *     and the repair refuses.
 *
 * It only ever clears two header cells — it never deletes a column, never
 * shifts data, never touches a data row.
 *
 * Idempotent: once the headers are blank the fingerprint no longer matches
 * and later boots do nothing, so it is safe to leave wired.
 */

const sheets = require('../repositories/sheetsClient');
const auditLogRepository = require('../repositories/auditLogRepository');
const inventoryRepository = require('../repositories/inventoryRepository');
const config = require('../config');
const logger = require('../utils/logger');

const SHEET = 'Inventory';
const ORPHANS = ['prev_state', 'state_since'];
const EXPECTED_WIDTH = 25; // A..Y — the two orphans are the last columns

/**
 * The values Google Sheets DISPLAYS for a broken cell. `#ERROR!` is Google's
 * "formula parse error" specifically — a cell holding a formula it cannot
 * even parse. The bot cannot produce one (see repairBrokenHeaders), so any
 * of these in the header row came from outside the bot.
 */
const SHEET_ERRORS = ['#error!', '#ref!', '#name?', '#value!', '#n/a',
  '#div/0!', '#num!', '#null!'];

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }
function isBroken(v) { const n = norm(v); return n === '' || SHEET_ERRORS.includes(n); }

/**
 * Clear the orphan headers when it is provably safe.
 * @param {object} [bot] Telegram bot, for the admin notice
 * @returns {Promise<{cleared:boolean, reason:string, dataCells?:number}>}
 */
async function repair(bot) {
  let header;
  try {
    const rows = await sheets.readRange(SHEET, 'A1:Z1');
    header = (rows && rows[0]) || [];
  } catch (e) {
    return { cleared: false, reason: `header read failed: ${e.message}` };
  }

  // X = index 23, Y = index 24.
  if (norm(header[23]) !== ORPHANS[0] || norm(header[24]) !== ORPHANS[1]) {
    return { cleared: false, reason: 'no orphan headers present — nothing to do' };
  }
  if (header.length !== EXPECTED_WIDTH) {
    return {
      cleared: false,
      reason: `header is ${header.length} wide, expected ${EXPECTED_WIDTH} — something was added after the orphans; refusing to touch it`,
    };
  }

  // The guard that matters: no data may live under either column.
  let dataCells = 0;
  try {
    const rows = await sheets.readRange(SHEET, 'X2:Y');
    for (const r of rows || []) {
      for (const cell of r || []) {
        if (String(cell == null ? '' : cell).trim() !== '') dataCells += 1;
      }
    }
  } catch (e) {
    return { cleared: false, reason: `could not verify the columns are empty: ${e.message}` };
  }
  if (dataCells) {
    logger.warn(`inventoryHeaderRepair: ${dataCells} non-empty cell(s) under X/Y — refusing to clear the headers`);
    return { cleared: false, reason: 'the columns hold data — refusing', dataCells };
  }

  try {
    await sheets.updateRange(SHEET, 'X1:Y1', [['', '']]);
  } catch (e) {
    return { cleared: false, reason: `clear failed: ${e.message}` };
  }
  try {
    await auditLogRepository.append('inventory.header_repaired',
      { sheet: SHEET, cleared: ORPHANS, range: 'X1:Y1' }, 'system');
  } catch (_) { /* audit is best-effort */ }
  logger.info('inventoryHeaderRepair: cleared orphan headers X1/Y1 (prev_state, state_since)');

  if (bot) {
    const text = '🧹 *Inventory header cleaned*\n\n'
      + 'The two orphan headers `prev_state` and `state_since` (X1, Y1) have been '
      + 'cleared. Both columns were verified empty first — no data row was touched.';
    for (const adminId of config.access.adminIds) {
      try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); } catch (_) { /* best-effort */ }
    }
  }
  return { cleared: true, reason: 'orphan headers cleared' };
}

/**
 * INV-HDR2 — restore a header cell that has gone BROKEN (owner, 03-Aug-2026,
 * after `#ERROR!` appeared in Inventory A1 where `PackageNo` belongs).
 *
 * WHY THE BOT IS NOT THE AUTHOR: `#ERROR!` is Google's formula-parse error,
 * so that cell holds a formula. Nothing here writes one. The three code paths
 * that touch Inventory row 1 (schemaMapper's column extensions,
 * inventoryRepository.ensureHeader, and repair() above) all write hardcoded
 * header strings, and every write in sheetsClient runs through the SEC-FI1
 * sanitizer, which apostrophe-escapes any value starting with = + - @ before
 * it reaches the API. A formula in the header therefore arrived from the
 * Sheets UI or an Apps Script — but the bot never NOTICED, because
 * ensureHeader only rewrites a header that is too SHORT, never one whose
 * cells are wrong. That silence is the bug this fixes.
 *
 * WHAT IT REPAIRS — only a cell that is provably broken:
 *   - the cell reads empty or is one of the Sheets error literals; AND
 *   - EVERY other cell in A1:W1 matches the canonical header exactly.
 *
 * That second condition is the important one. A cell holding some other real
 * word is a rename or a column the bot doesn't know about — CLAUDE.md rule 4
 * says hands off — so one unexpected name anywhere makes the whole repair
 * stand down rather than "restore" a header someone chose on purpose.
 *
 * It writes only the broken cells, one at a time. It never reorders, never
 * widens, never touches a data row.
 *
 * @param {object} [bot] Telegram bot, for the admin notice
 * @returns {Promise<{fixed:string[], reason:string}>} column letters restored
 */
async function repairBrokenHeaders(bot) {
  const HEADERS = inventoryRepository.HEADERS;
  let header;
  try {
    const rows = await sheets.readRange(SHEET, `A1:${colLetter(HEADERS.length)}1`);
    header = (rows && rows[0]) || [];
  } catch (e) {
    return { fixed: [], reason: `header read failed: ${e.message}` };
  }
  // A broken LAST cell is trimmed off the read, so pad before comparing.
  while (header.length < HEADERS.length) header.push('');

  const broken = [];
  for (let i = 0; i < HEADERS.length; i++) {
    if (norm(header[i]) === norm(HEADERS[i])) continue;
    if (isBroken(header[i])) { broken.push(i); continue; }
    // Something real and unexpected — stand down entirely.
    return {
      fixed: [],
      reason: `${colLetter(i + 1)}1 reads "${String(header[i]).slice(0, 40)}" where `
        + `"${HEADERS[i]}" is expected — that is a rename, not damage; refusing to touch the header`,
    };
  }
  if (!broken.length) return { fixed: [], reason: 'header is intact' };

  const fixed = [];
  for (const i of broken) {
    const cell = `${colLetter(i + 1)}1`;
    try {
      await sheets.updateRange(SHEET, `${cell}:${cell}`, [[HEADERS[i]]]);
      fixed.push(cell);
    } catch (e) {
      logger.warn(`inventoryHeaderRepair: could not restore ${cell}: ${e.message}`);
    }
  }
  if (!fixed.length) return { fixed: [], reason: 'every restore write failed' };

  const detail = broken.map((i) => `${colLetter(i + 1)}1 "${String(header[i]).trim() || '(blank)'}" → "${HEADERS[i]}"`);
  try {
    await auditLogRepository.append('inventory.header_restored',
      { sheet: SHEET, cells: fixed, detail }, 'system');
  } catch (_) { /* audit is best-effort */ }
  logger.warn(`inventoryHeaderRepair: restored broken header cell(s): ${detail.join('; ')}`);

  if (bot) {
    const text = '🩹 *Inventory header restored*\n\n'
      + detail.map((d) => `• ${d}`).join('\n')
      + '\n\nA header cell was holding a broken formula or was blank, so the '
      + 'canonical name has been put back. No data row was touched.\n\n'
      + '_The bot cannot write a formula into a cell — every write is escaped — '
      + 'so this came from an edit made in the sheet itself or by an Apps Script. '
      + 'If it returns, that edit is still running._';
    for (const adminId of config.access.adminIds) {
      try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); } catch (_) { /* best-effort */ }
    }
  }
  return { fixed, reason: 'broken header cell(s) restored' };
}

/** 1 → 'A', 24 → 'X'. */
function colLetter(n) {
  let s = '';
  let x = n;
  while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - m) / 26); }
  return s;
}

/** Run both Inventory header repairs. Neither throws. */
async function repairAll(bot) {
  const orphans = await repair(bot).catch((e) => ({ cleared: false, reason: e.message }));
  const brokenCells = await repairBrokenHeaders(bot).catch((e) => ({ fixed: [], reason: e.message }));
  return { orphans, brokenCells };
}

module.exports = {
  repair,
  repairBrokenHeaders,
  repairAll,
  _internals: { ORPHANS, EXPECTED_WIDTH, SHEET_ERRORS, colLetter },
};
