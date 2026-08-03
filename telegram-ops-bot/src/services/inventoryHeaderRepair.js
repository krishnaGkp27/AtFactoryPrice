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
const config = require('../config');
const logger = require('../utils/logger');

const SHEET = 'Inventory';
const ORPHANS = ['prev_state', 'state_since'];
const EXPECTED_WIDTH = 25; // A..Y — the two orphans are the last columns

function norm(v) { return String(v == null ? '' : v).trim().toLowerCase(); }

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

module.exports = { repair, _internals: { ORPHANS, EXPECTED_WIDTH } };
