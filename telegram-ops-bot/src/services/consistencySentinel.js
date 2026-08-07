'use strict';

/**
 * consistencySentinel — SEN-1 (owner-approved plan, specs/DATA-INTEGRITY_PLAN.md §2).
 *
 * READ-ONLY cross-sheet invariant checker. The 07-Aug audit found that
 * every existing repair was written reactively AFTER a corruption was
 * noticed, and that nothing at runtime ever cross-reads the sheets. This
 * service asks the seven questions nothing asked, on a schedule and on
 * demand — and only ever REPORTS. It never fixes, never writes a sheet
 * row (AuditLog run-summary aside), so a Sentinel bug can annoy but
 * never corrupt.
 *
 * The seven checks:
 *   C1 every sold Inventory row (from the BMV-1 cutoff) has a `sale`
 *      movement row — a swallowed movement append is otherwise invisible;
 *   C2 every `return` movement traces to an APPROVED return/revert in the
 *      ApprovalQueue near its date (corrections excluded) — enforces at
 *      runtime what the Supply Ledger's credit side only trusts;
 *   C3 in_transit rows ↔ open transfers, both directions, by bale_uid —
 *      the stranded-on-the-road detector;
 *   C4 exactly one Current flag per bale in BaleMovements — the 0-flag /
 *      2-flag crash modes its own docblock predicts;
 *   C5 every soldTo resolves to a real customer (canonical or alias) — a
 *      phantom customer is caught at fork time, not invoice time;
 *   C6 duplicate LIVE printed numbers per warehouse — reuses
 *      baleAuditReport's own computeDuplicates (one implementation);
 *   C7 requestId uniqueness across ALL approval families — the
 *      restart-counter collision class beyond TR-* ids.
 *
 * A CHECKER MUST NOT ACCUSE LEGITIMATE STATES (SEN-1b adversarial
 * review, 07-Aug-2026 — 17 confirmed findings fixed before deploy):
 *   - a failed sheet read ABORTS the sweep instead of masquerading as an
 *     empty sheet (which made every sold row look movement-less);
 *   - rows/movements written within the GRACE window are skipped — the
 *     writers are multi-call (flip sheet → append movement → resolve
 *     queue row), so a sweep landing mid-write saw perfectly healthy
 *     operations as drift;
 *   - C1 tolerates container backfill (a sale movement frozen with a
 *     blank container still matches after arrival_batch is stamped);
 *   - cutoff comparisons only trust REAL ISO days — normDay returns raw
 *     junk unparsed, which sorted "TBD" after the cutoff;
 *   - the queue is read ONCE (getAllWithRowIndex), so a row resolving
 *     between two reads cannot appear as its own duplicate;
 *   - reports ship via sendLong (the 4096-char cap silently ate the
 *     report on exactly the worst nights).
 *
 * Findings go to admin DMs + one AuditLog summary row. Silent when clean.
 * Settings: SENTINEL_ENABLED (0 disables), SENTINEL_HOUR (Lagos hour of
 * the daily run).
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const baleMovementsRepository = require('../repositories/baleMovementsRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const settingsRepository = require('../repositories/settingsRepository');
const auditLogRepository = require('../repositories/auditLogRepository');
const { normDay } = require('../utils/dates');
const fmtDate = require('../utils/formatDate');
const config = require('../config');
const logger = require('../utils/logger');

/** BMV-1 went live 03-Aug-2026 — movement-backed checks start there. */
const BMV_CUTOFF = '2026-08-03';
const TZ = 'Africa/Lagos';
/** Writes are multi-call; anything this fresh may still be mid-flight. */
const GRACE_MS = 5 * 60 * 1000;
/** C2 — an approved return executes within this many days of resolution. */
const RETURN_WINDOW_DAYS = 2;

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** One physical bale — design | printed number | container (§1/§5). */
function baleKey(design, pkg, container) {
  return `${upper(design)}|${upper(pkg)}|${upper(container)}`;
}

/** A REAL ISO calendar day — normDay hands back raw junk unparsed. */
function isIsoDay(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s || ''))) return false;
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  return m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** Was this timestamp written inside the in-flight grace window? */
function isRecent(ts, now) {
  const ms = Date.parse(String(ts || ''));
  return isFinite(ms) && (now - ms) < GRACE_MS;
}

/* ───────────────────────────── the checks ───────────────────────────── */

/** C1 — sold rows without a matching `sale` movement (post-cutoff). */
function checkSoldHaveSaleMovements({ inventory, movements, now }) {
  const exact = new Set();
  const blankContainer = new Set(); // design|pkg of sales logged pre-backfill
  const anyContainer = new Set();
  for (const m of movements) {
    if (m.kind !== 'sale') continue;
    exact.add(baleKey(m.design, m.baleNo, m.container));
    anyContainer.add(`${upper(m.design)}|${upper(m.baleNo)}`);
    if (!upper(m.container)) blankContainer.add(`${upper(m.design)}|${upper(m.baleNo)}`);
  }
  const findings = [];
  const seen = new Set();
  for (const r of inventory) {
    if (r.status !== 'sold') continue;
    const day = normDay(r.soldDate);
    // Only REAL post-cutoff days are in scope: junk/legacy dates predate
    // the movement log and must not be accused of a swallowed append.
    if (!isIsoDay(day) || day < BMV_CUTOFF) continue;
    if (isRecent(r.updatedAt, now)) continue; // movement append may be in flight
    const k = baleKey(r.design, r.packageNo, r.arrivalBatch);
    if (seen.has(k)) continue;
    seen.add(k);
    if (exact.has(k)) continue;
    const dp = `${upper(r.design)}|${upper(r.packageNo)}`;
    // Container drift (§1b divergence 8): the movement's container is
    // frozen at sale time; a later arrival_batch backfill must not turn a
    // logged sale into an accusation — and vice versa.
    if (blankContainer.has(dp)) continue;
    if (!upper(r.arrivalBatch) && anyContainer.has(dp)) continue;
    findings.push(`Bale ${r.packageNo} (${r.design}) sold ${fmtDate.short(day)} to ${r.soldTo || '—'} — no sale movement logged`);
  }
  return findings;
}

/** C2 — `return` movements with no approved return/revert near their date. */
function checkReturnsAreApproved({ movements, resolved, now }) {
  // pkg → resolution days ('' = unknown day, matches any date).
  const approvedOn = new Map();
  const note = (pkg, day) => {
    const k = upper(pkg);
    if (!k) return;
    if (!approvedOn.has(k)) approvedOn.set(k, new Set());
    approvedOn.get(k).add(day);
  };
  for (const q of resolved) {
    if (String(q.status || '').toLowerCase() !== 'approved') continue;
    const aj = q.actionJSON || {};
    const day = isIsoDay(normDay(q.resolvedAt)) ? normDay(q.resolvedAt) : '';
    if (aj.action === 'return_than' || aj.action === 'return_package') {
      note(aj.packageNo, day);
    } else if (aj.action === 'revert_sale_bundle') {
      if (Array.isArray(aj.items)) for (const it of aj.items) note(it.packageNo, day);
      // The revert executes against the ORIGINAL sale_bundle's items too.
      if (aj.saleRefId) {
        const orig = resolved.find((o) => String(o.requestId) === String(aj.saleRefId));
        const oj = (orig && orig.actionJSON) || {};
        if (Array.isArray(oj.items)) for (const it of oj.items) note(it.packageNo, day);
      }
    }
  }
  const near = (a, b) => {
    if (!a || !b) return true; // unknown day — stay lenient, never accuse
    const diff = Math.abs(Date.parse(a) - Date.parse(b));
    return diff <= RETURN_WINDOW_DAYS * 86400000;
  };
  const findings = [];
  for (const m of movements) {
    if (m.kind !== 'return') continue;
    const day = normDay(m.movedOn || m.timestamp);
    if (isIsoDay(day) && day < BMV_CUTOFF) continue;
    if (isRecent(m.timestamp, now)) continue; // queue row flip may lag the movement
    const days = approvedOn.get(upper(m.baleNo));
    if (days && [...days].some((d) => near(d, isIsoDay(day) ? day : ''))) continue;
    findings.push(`Return of Bale ${m.baleNo} (${m.design}, ${m.ref || 'no customer'}, ${fmtDate.short(day) || '?'}) — no approved return found in the queue`);
  }
  return findings;
}

/** C3 — in_transit rows ↔ open transfers, both directions, by bale_uid. */
function checkInTransit({ inventory, pending, now }) {
  const findings = [];
  const openTransfers = pending.filter((q) => {
    const aj = q.actionJSON || {};
    return aj.action === 'transfer_stock' && aj.stage === 'in_transit';
  });
  const claimedUids = new Set();
  let uidlessTransfers = 0;
  for (const q of openTransfers) {
    const aj = q.actionJSON || {};
    if (Array.isArray(aj.baleUids) && aj.baleUids.length) {
      aj.baleUids.forEach((u) => claimedUids.add(String(u)));
    } else {
      uidlessTransfers += 1;
    }
  }
  const transitRows = inventory.filter((r) => r.status === 'in_transit');
  const transitUids = new Set(transitRows.map((r) => String(r.baleUid)));
  const recentUids = new Set(inventory.filter((r) => isRecent(r.updatedAt, now)).map((r) => String(r.baleUid)));
  // Direction A: a row on the road that no open transfer claims. A row
  // flipped moments ago may belong to a dispatch still stamping its queue
  // row — the grace window covers that.
  const orphaned = new Map();
  for (const r of transitRows) {
    if (claimedUids.has(String(r.baleUid))) continue;
    if (isRecent(r.updatedAt, now)) continue;
    const k = `${r.packageNo}|${r.design}`;
    if (!orphaned.has(k)) orphaned.set(k, r);
  }
  for (const r of orphaned.values()) {
    findings.push(uidlessTransfers
      ? `Bale ${r.packageNo} (${r.design}) is in_transit → ${r.warehouse} but unverifiable (${uidlessTransfers} open transfer(s) predate uid tracking)`
      : `Bale ${r.packageNo} (${r.design}) is in_transit → ${r.warehouse} with NO open transfer claiming it`);
  }
  // Direction B: a transfer that claims uids no longer on the road —
  // unless those rows changed within the grace window (a receipt landing).
  for (const q of openTransfers) {
    const aj = q.actionJSON || {};
    if (!Array.isArray(aj.baleUids) || !aj.baleUids.length) continue;
    const missing = aj.baleUids.filter((u) => !transitUids.has(String(u)));
    if (missing.length && !missing.some((u) => recentUids.has(String(u)))) {
      findings.push(`Transfer ${q.requestId} (${aj.from || '?'} → ${aj.to || '?'}) claims ${missing.length} bale(s) that are not in_transit any more`);
    }
  }
  return findings;
}

/** C4 — exactly one Current=YES movement row per bale. */
function checkCurrentFlags({ movements, now }) {
  const byBale = new Map();
  for (const m of movements) {
    const k = baleKey(m.design, m.baleNo, m.container);
    if (!byBale.has(k)) byBale.set(k, { label: `${m.baleNo} (${m.design}${m.container ? ` · ${m.container}` : ''})`, current: 0, newest: '' });
    const b = byBale.get(k);
    if (m.current) b.current += 1;
    if (String(m.timestamp || '') > b.newest) b.newest = String(m.timestamp || '');
  }
  const findings = [];
  for (const b of byBale.values()) {
    if (b.current === 1) continue;
    // append clears flags BEFORE appending (by design) — a sweep landing
    // inside that window sees 0 flags on a healthy bale. Grace covers it.
    if (isRecent(b.newest, now)) continue;
    findings.push(b.current === 0
      ? `Bale ${b.label} has NO Current row (crash between flag-clear and append?)`
      : `Bale ${b.label} has ${b.current} Current rows (should be exactly 1)`);
  }
  return findings;
}

/** C5 — sold rows whose soldTo resolves to no customer entity. */
async function checkSoldToResolves({ inventory }) {
  const customerEntity = require('./customerEntity');
  const byName = new Map();
  for (const r of inventory) {
    if (r.status !== 'sold' || !String(r.soldTo || '').trim()) continue;
    const k = String(r.soldTo).trim();
    byName.set(k, (byName.get(k) || 0) + 1);
  }
  const findings = [];
  for (const [name, rows] of byName) {
    let ent;
    // A resolver ERROR is not a phantom customer — skip, never accuse.
    try { ent = await customerEntity.resolve({ name }); } catch (_) { continue; }
    if (!ent) findings.push(`"${name}" on ${rows} sold row(s) matches no customer (canonical or alias)`);
  }
  return findings;
}

/** C6 — duplicate LIVE printed numbers per warehouse (baleAuditReport's own engine). */
async function checkDuplicateLiveNumbers({ inventory }) {
  const { computeDuplicates } = require('./baleAuditReport')._internals;
  const { offenders } = await computeDuplicates(inventory);
  return offenders.map((o) =>
    `Number ${o.packageNo} @ ${o.warehouse} is TWO live bales: ${o.variants.map((v) => `${v.design} (recd ${v.dateReceived || '?'})`).join(' vs ')}`);
}

/** C7 — requestId uniqueness across every approval family (one read). */
function checkRequestIdUniqueness({ queueRows }) {
  const seen = new Map();
  for (const q of queueRows) {
    const id = String(q.requestId || '').trim();
    if (!id) continue;
    seen.set(id, (seen.get(id) || 0) + 1);
  }
  const findings = [];
  for (const [id, n] of seen) {
    if (n > 1) findings.push(`requestId ${id} appears on ${n} queue rows`);
  }
  return findings;
}

/* ───────────────────────────── orchestration ───────────────────────────── */

let _inflight = null;

/**
 * Run all seven checks against ONE snapshot of each sheet.
 *
 * A failed read THROWS — it must never masquerade as an empty sheet,
 * because "sheet empty" is indistinguishable from "everything is drift".
 * Concurrent calls (a double-tapped 🔁) share one in-flight run instead
 * of stacking cache-bypassing reads toward the Sheets quota.
 *
 * @returns {Promise<{checks: Array<{id, title, findings: string[]}>, totalFindings: number}>}
 */
async function runAll() {
  if (_inflight) return _inflight;
  _inflight = (async () => {
    const [inventory, movements, queueRows] = await Promise.all([
      inventoryRepository.getAll(true),
      baleMovementsRepository.getAllStrict(),
      approvalQueueRepository.getAllWithRowIndex(),
    ]);
    const now = Date.now();
    const pending = queueRows.filter((q) => String(q.status || '').toLowerCase() === 'pending');
    const resolved = queueRows.filter((q) => String(q.status || '').toLowerCase() !== 'pending');
    const ctx = { inventory, movements, pending, resolved, queueRows, now };
    const checks = [
      { id: 'C1', title: 'Sold rows have sale movements', findings: checkSoldHaveSaleMovements(ctx) },
      { id: 'C2', title: 'Returns are approved returns', findings: checkReturnsAreApproved(ctx) },
      { id: 'C3', title: 'In-transit matches open transfers', findings: checkInTransit(ctx) },
      { id: 'C4', title: 'One Current flag per bale', findings: checkCurrentFlags(ctx) },
      { id: 'C5', title: 'Every buyer is a real customer', findings: await checkSoldToResolves(ctx) },
      { id: 'C6', title: 'One live bale per printed number per store', findings: await checkDuplicateLiveNumbers(ctx) },
      { id: 'C7', title: 'Request ids are unique', findings: checkRequestIdUniqueness(ctx) },
    ];
    return { checks, totalFindings: checks.reduce((n, c) => n + c.findings.length, 0) };
  })();
  try {
    return await _inflight;
  } finally {
    _inflight = null;
  }
}

/** Per-check line cap in the DM report; the 🩺 tile shows everything. */
const DM_LINES_PER_CHECK = 8;

function buildReport(result) {
  let text = `🩺 Data Health — ${result.totalFindings ? `${result.totalFindings} issue(s) found` : 'all clean'}\n`;
  for (const c of result.checks) {
    if (!c.findings.length) { text += `\n✅ ${c.id} ${c.title}`; continue; }
    text += `\n⚠️ ${c.id} ${c.title} — ${c.findings.length}:`;
    for (const f of c.findings.slice(0, DM_LINES_PER_CHECK)) text += `\n   • ${f}`;
    if (c.findings.length > DM_LINES_PER_CHECK) {
      text += `\n   …and ${c.findings.length - DM_LINES_PER_CHECK} more — open 🩺 Data Health`;
    }
  }
  return text;
}

/**
 * One scheduled/on-demand pass: run, DM admins on drift, audit-log the
 * summary. Silent (no DM) when clean; a FAILED run reports nothing rather
 * than fabricating drift. Never throws.
 * @returns {Promise<{ok: boolean, totalFindings?: number, skipped?: string}>}
 */
async function sweep(bot) {
  try {
    const settings = await settingsRepository.getAll().catch(() => ({}));
    if (String(settings.SENTINEL_ENABLED ?? '1') === '0') return { ok: true, skipped: 'disabled' };
    const result = await runAll();
    try {
      await auditLogRepository.append('sentinel_run',
        Object.fromEntries(result.checks.map((c) => [c.id, c.findings.length])), 'system');
    } catch (_) { /* the run matters more than its log row */ }
    if (result.totalFindings && bot) {
      const { sendLong } = require('../utils/telegramUI');
      const report = buildReport(result);
      for (const adminId of config.access.adminIds) {
        try { await sendLong(bot, adminId, report); } catch (e) {
          logger.warn(`sentinel: report to ${adminId} failed: ${e.message}`);
        }
      }
    }
    logger.info(`sentinel: ${result.totalFindings} finding(s) across 7 checks`);
    return { ok: true, totalFindings: result.totalFindings };
  } catch (e) {
    logger.warn(`sentinel: sweep failed (no report sent): ${e.message}`);
    return { ok: false };
  }
}

/** Lagos calendar day + hour, for the daily trigger. */
function lagosNow() {
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hour12: false }).format(now));
  return { day, hour };
}

let _lastRunDay = '';

/**
 * Minute-scale tick with CATCH-UP semantics (the house scheduler pattern —
 * morningDigest/sheetBackup): fires on the first tick AT or AFTER the
 * sentinel hour, so a redeploy during the hour delays the run by minutes
 * instead of silently losing the night. The _lastRunDay latch keeps it to
 * once per Lagos day.
 */
function startScheduler(bot) {
  const tick = async () => {
    try {
      const settings = await settingsRepository.getAll().catch(() => ({}));
      const hour = Number(settings.SENTINEL_HOUR ?? settingsRepository.DEFAULTS.SENTINEL_HOUR);
      const now = lagosNow();
      if (now.hour < hour || _lastRunDay === now.day) return;
      _lastRunDay = now.day;
      await sweep(bot);
    } catch (e) {
      logger.warn(`sentinel: tick failed: ${e.message}`);
    }
  };
  setInterval(tick, 5 * 60 * 1000);
  logger.info('consistencySentinel: daily scheduler armed (5-min catch-up tick)');
}

module.exports = {
  runAll, sweep, buildReport, startScheduler,
  _internals: {
    checkSoldHaveSaleMovements, checkReturnsAreApproved, checkInTransit,
    checkCurrentFlags, checkSoldToResolves, checkDuplicateLiveNumbers,
    checkRequestIdUniqueness, baleKey, isIsoDay, isRecent,
    BMV_CUTOFF, DM_LINES_PER_CHECK, GRACE_MS,
  },
};
