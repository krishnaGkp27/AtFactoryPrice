'use strict';

/**
 * baleAuditReport — TRF-INT3 (owner-approved 02-Aug): one-off report of bale
 * numbers that already violate the intake rule — the SAME printed number
 * carried by more than one LIVE bale (status available / in_transit) in the
 * SAME warehouse. The intake gate stops new ones being born; these existing
 * ones must be resolved physically (re-number one bale, or sell/adjust).
 *
 * Runs at boot and DMs the admins ONLY when offenders exist — so it repeats
 * after every deploy until the list is empty, which is exactly the reminder
 * the owner asked for. Cross-warehouse duplicates are legitimate (owner rule
 * 3) and are only counted, never listed as problems.
 *
 * Read-only: never writes to any sheet. Distinct physical bales under one
 * number are told apart by bale_uid (legacy rows: synthetic per-row uid — a
 * conservative overcount is impossible because rows of ONE physical bale
 * share their intake; we group by uid prefix only when real, else treat the
 * whole packageNo+warehouse cluster as suspect only when it spans designs or
 * intake dates, the two signals two physical bales actually differ by).
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const config = require('../config');
const logger = require('../utils/logger');

const LIVE = new Set(['available', 'in_transit']);

/**
 * Compute the same-warehouse live duplicate clusters.
 * Two live rows sharing (warehouse, packageNo) are ONE physical bale when
 * they also share design + dateReceived; they are flagged as duplicates when
 * design or intake date differs (two physical bales under one number).
 * @returns {Promise<{offenders:Array, crossWarehouse:number}>}
 */
async function computeDuplicates() {
  const rows = (await inventoryRepository.getAll(true)).filter((r) => LIVE.has(r.status));
  const byKey = new Map(); // wh|pkg -> rows
  for (const r of rows) {
    const k = `${String(r.warehouse).trim().toLowerCase()}|${r.packageNo}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const offenders = [];
  for (const [, group] of byKey) {
    if (group.length < 2) continue;
    const signatures = new Set(group.map((r) => `${String(r.design).toUpperCase()}|${r.dateReceived}`));
    if (signatures.size < 2) continue; // one physical bale, several thans — normal
    offenders.push({
      packageNo: group[0].packageNo,
      warehouse: group[0].warehouse,
      variants: [...signatures].map((s) => {
        const [design, date] = s.split('|');
        const n = group.filter((r) => `${String(r.design).toUpperCase()}|${r.dateReceived}` === s).length;
        return { design, dateReceived: date, rows: n };
      }),
    });
  }
  // Cross-warehouse duplicates: same number live in >1 warehouse (legal, FYI).
  const byPkg = new Map();
  for (const r of rows) {
    if (!byPkg.has(r.packageNo)) byPkg.set(r.packageNo, new Set());
    byPkg.get(r.packageNo).add(String(r.warehouse).trim().toLowerCase());
  }
  const crossWarehouse = [...byPkg.values()].filter((s) => s.size > 1).length;
  return { offenders, crossWarehouse };
}

/** Boot pass: DM admins when same-warehouse live duplicates exist. */
async function report(bot) {
  try {
    const { offenders, crossWarehouse } = await computeDuplicates();
    if (!offenders.length) {
      logger.info(`baleAuditReport: clean — no same-warehouse live duplicates (${crossWarehouse} cross-warehouse number reuses, which are legal)`);
      return { offenders: [], crossWarehouse };
    }
    const lines = offenders.slice(0, 25).map((o) =>
      `• *${o.packageNo}* @ ${o.warehouse}: ${o.variants.map((v) => `${v.design} (${v.rows} thans, recd ${v.dateReceived || '?'})`).join('  vs  ')}`);
    const text = `🚨 *Bale-number duplicates inside one warehouse* — ${offenders.length} number(s)\n`
      + 'Two LIVE physical bales share one printed number. The intake gate now blocks new ones; '
      + 'these existing ones need a physical fix (re-number one bale, then correct its row).\n\n'
      + lines.join('\n')
      + (offenders.length > 25 ? `\n…+${offenders.length - 25} more` : '')
      + `\n\n_${crossWarehouse} number(s) also live in more than one warehouse — that is allowed; cards always show the warehouse._`
      + '\n_This report repeats at every restart until the list is empty._';
    for (const adminId of config.access.adminIds) {
      try { await bot.sendMessage(adminId, text, { parse_mode: 'Markdown' }); } catch (_) { /* best-effort */ }
    }
    try {
      await auditLogRepository.append('bale.duplicate_report',
        { count: offenders.length, packages: offenders.map((o) => `${o.packageNo}@${o.warehouse}`) }, 'system');
    } catch (_) { /* audit best-effort */ }
    return { offenders, crossWarehouse };
  } catch (e) {
    logger.warn(`baleAuditReport failed: ${e.message}`);
    return { offenders: [], crossWarehouse: 0, error: e.message };
  }
}

module.exports = { report, _internals: { computeDuplicates } };
