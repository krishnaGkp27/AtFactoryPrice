'use strict';

/**
 * baleEditService — EDB-1 (owner, 02-Sep-2026): the bale card, edited in
 * place, dual-admin approved, applied as CRUD on the Inventory sheet.
 *
 * "The small quantum of change that could happen would be a bale's details
 *  having a difference of physical attributes from the sheet." — the sheet
 * stays the single source of truth; an admin corrects the CARD until it
 * matches the goods on the floor, two admins sign, the bot writes the rows.
 *
 * What is editable here — the physical attributes a label carries:
 *   design · shade · indent (the bale header, stamped on every row)
 *   yards of each than · adding a than (the pieces)
 * What is NOT — status, customer, sale date, price (sales / returns /
 * financial reconciliation), warehouse (a transfer), removing a than
 * (deferred: a deleted row shifts every row beneath it, and a 'removed'
 * status would leak into every "all statuses" reader — the owner rules on
 * the shape; until then a bale with too many rows is reported, not edited).
 *
 * Identity (BUSINESS_RULES §1/§1b): than numbers are never renumbered; a
 * new piece takes the next free number and a generated uid; every other
 * intake field is copied from its bale-mates so the row is indistinguishable
 * from one the owner typed.
 *
 * Concurrency (APC-1): the proposal carries a SNAPSHOT of the rows it saw;
 * the executor re-reads the bale and refuses if any of them moved (sold,
 * transferred, edited) in between.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const { baleKey } = require('./baleIdentity');
const idGenerator = require('../utils/idGenerator');
const logger = require('../utils/logger');

const EDITABLE_HEADER = ['design', 'shade', 'indent'];
const MAX_YARDS = 2000;
const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();
const str = (v) => String(v == null ? '' : v).trim();

/** The rows of ONE physical bale, in than order, reduced to what the edit needs. */
function snapshotOf(rows) {
  return [...(rows || [])]
    .sort((a, b) => (Number(a.thanNo) || 0) - (Number(b.thanNo) || 0))
    .map((r) => ({
      rowIndex: r.rowIndex, packageNo: str(r.packageNo), thanNo: Number(r.thanNo) || 0,
      yards: Number(r.yards) || 0, status: str(r.status).toLowerCase() || 'available',
      soldTo: str(r.soldTo), soldDate: str(r.soldDate), baleUid: str(r.baleUid),
      design: str(r.design), shade: str(r.shade), indent: str(r.indent),
      warehouse: str(r.warehouse), arrivalBatch: str(r.arrivalBatch),
    }));
}

/** Group a printed number's rows into physical bales: warehouse + design|number|container. */
function groupPhysical(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = `${upper(r.warehouse)}||${baleKey(r)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return groups;
}

/** A yards figure the sheet will accept: a positive number, at most one decimal, ≤ MAX_YARDS. */
function parseYards(v) {
  const n = Number(String(v == null ? '' : v).trim().replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0 || n > MAX_YARDS) return null;
  return Math.round(n * 10) / 10;
}

/**
 * The plan from a snapshot + edits. PURE — the card, the approval card and
 * the executor all read the same plan, so they can never disagree.
 * @param {Array<object>} snapshot  snapshotOf(rows)
 * @param {{header?:object, yards?:object, add?:Array<{yards:number}>}} edits
 */
function buildPlan(snapshot, edits = {}) {
  const snap = Array.isArray(snapshot) ? snapshot : [];
  const first = snap[0] || {};
  const header = {};
  for (const f of EDITABLE_HEADER) {
    const v = edits.header && edits.header[f];
    if (v == null || str(v) === '') continue;
    if (upper(v) !== upper(first[f])) header[f] = str(v);
  }
  const yardChanges = [];
  for (const [ri, raw] of Object.entries(edits.yards || {})) {
    const row = snap.find((r) => String(r.rowIndex) === String(ri));
    if (!row) continue;
    const to = parseYards(raw);
    if (to == null || to === row.yards) continue;
    yardChanges.push({ rowIndex: row.rowIndex, thanNo: row.thanNo, from: row.yards, to, status: row.status, soldTo: row.soldTo, soldDate: row.soldDate });
  }
  const maxThan = snap.reduce((m, r) => Math.max(m, r.thanNo), 0);
  const adds = (edits.add || []).map((a) => parseYards(a && a.yards)).filter((y) => y != null)
    .map((yards, i) => ({ thanNo: maxThan + 1 + i, yards }));
  const beforeYards = snap.reduce((s, r) => s + r.yards, 0);
  const afterYards = beforeYards
    - yardChanges.reduce((s, c) => s + c.from, 0) + yardChanges.reduce((s, c) => s + c.to, 0)
    + adds.reduce((s, a) => s + a.yards, 0);
  const round = (n) => Math.round(n * 10) / 10;
  return {
    header, yardChanges, adds,
    before: { thans: snap.length, yards: round(beforeYards) },
    after: { thans: snap.length + adds.length, yards: round(afterYards) },
    soldYardsChanged: yardChanges.some((c) => c.status === 'sold'),
    changeCount: Object.keys(header).length + yardChanges.length + adds.length,
  };
}

/** One-line-per-change description, plain text (no Markdown). */
function describePlan(plan) {
  const lines = [];
  for (const [f, v] of Object.entries(plan.header || {})) lines.push(`${f}: → ${v}`);
  for (const c of plan.yardChanges || []) lines.push(`#${c.thanNo}: ${c.from} → ${c.to} yd${c.status === 'sold' ? ` (sold → ${c.soldTo})` : ''}`);
  for (const a of plan.adds || []) lines.push(`+ #${a.thanNo}: ${a.yards} yd (new, available)`);
  return lines;
}

/** Live rows of the physical bale the proposal described. */
async function liveRowsFor(aj) {
  const all = await inventoryRepository.getAll(true);
  return all.filter((r) => upper(r.packageNo) === upper(aj.packageNo)
    && upper(r.warehouse) === upper(aj.warehouse)
    && baleKey(r) === aj.baleKey);
}

/**
 * Nothing moved since the edit was proposed? Same rows, same numbers, same
 * status, same uids — else the approval must be redone on fresh rows.
 */
async function verifySnapshot(aj) {
  const live = snapshotOf(await liveRowsFor(aj));
  const snap = Array.isArray(aj.snapshot) ? aj.snapshot : [];
  if (live.length !== snap.length) return { ok: false, reason: `it had ${snap.length} thans, now ${live.length}`, live };
  for (const s of snap) {
    const l = live.find((r) => String(r.rowIndex) === String(s.rowIndex));
    if (!l) return { ok: false, reason: `than ${s.thanNo} is no longer on row ${s.rowIndex}`, live };
    if (l.thanNo !== s.thanNo || l.yards !== s.yards || l.status !== s.status || upper(l.packageNo) !== upper(s.packageNo)
      || (s.baleUid && l.baleUid !== s.baleUid)) {
      return { ok: false, reason: `than ${s.thanNo} changed (${s.status} ${s.yards} yd → ${l.status} ${l.yards} yd)`, live };
    }
  }
  return { ok: true, live };
}

/**
 * Executor (inventoryService, action edit_bale, dual-admin): apply the plan
 * to the sheet — cell updates on the existing rows, appended rows for new
 * thans. Returns {ok, message?, plan, updated, appended}.
 */
async function apply(aj, approvedBy) {
  const v = await verifySnapshot(aj);
  if (!v.ok) {
    return { ok: false, message: `Bale ${aj.packageNo} changed since this edit was proposed — ${v.reason}. Open ✏️ Edit Bale again and re-check it against the label.` };
  }
  const plan = buildPlan(aj.snapshot, aj.edits);
  if (!plan.changeCount) return { ok: false, message: 'Nothing to change.' };
  const now = new Date().toISOString();
  const liveRows = await liveRowsFor(aj);
  const byIndex = new Map(liveRows.map((r) => [String(r.rowIndex), r]));

  const updates = [];
  for (const r of liveRows) {
    const cells = {};
    if (plan.header.design) cells.design = plan.header.design;
    if (plan.header.shade) cells.shade = plan.header.shade;
    if (plan.header.indent) cells.indent = plan.header.indent;
    const yc = plan.yardChanges.find((c) => String(c.rowIndex) === String(r.rowIndex));
    if (yc) cells.yards = yc.to;
    if (Object.keys(cells).length) { cells.updatedAt = now; updates.push({ rowIndex: r.rowIndex, cells }); }
  }
  const tpl = byIndex.get(String((aj.snapshot[0] || {}).rowIndex)) || liveRows[0];
  const appends = plan.adds.map((a) => ({
    packageNo: tpl.packageNo, indent: plan.header.indent || tpl.indent, csNo: tpl.csNo,
    design: plan.header.design || tpl.design, shade: plan.header.shade || tpl.shade,
    thanNo: a.thanNo, yards: a.yards, status: 'available',
    warehouse: tpl.warehouse, pricePerYard: tpl.pricePerYard, dateReceived: tpl.dateReceived,
    soldTo: '', soldDate: '', netMtrs: '', netWeight: '', updatedAt: now,
    productType: tpl.productType || 'fabric',
    baleUid: idGenerator.baleUid(tpl.packageNo), addedAt: now,
    grnId: tpl.grnId || '', binLocation: tpl.binLocation || '', arrivalBatch: tpl.arrivalBatch || '',
    designCategory: tpl.designCategory || '',
  }));
  await inventoryRepository.applyBaleEdit({ updates, appends });
  try {
    await require('../repositories/auditLogRepository').append('edit_bale', {
      packageNo: aj.packageNo, warehouse: aj.warehouse, changes: describePlan(plan),
      label_file_id: aj.label_file_id || '', requestedBy: aj.requestedBy || '',
    }, approvedBy);
  } catch (e) { logger.warn(`baleEditService.apply: audit append failed — ${e.message}`); }
  logger.info(`edit_bale: ${aj.packageNo} @ ${aj.warehouse} — ${updates.length} row(s) updated, ${appends.length} appended, by ${approvedBy}`);
  return { ok: true, plan, updated: updates.length, appended: appends.length };
}

module.exports = {
  EDITABLE_HEADER, MAX_YARDS,
  snapshotOf, groupPhysical, parseYards, buildPlan, describePlan, verifySnapshot, apply,
};
