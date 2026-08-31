'use strict';

/**
 * designMovementService — DML-1, the per-design movement ledger.
 *
 * One question, top to bottom: opening balance → every movement → book
 * balance → what the audit counted → the unexplained gap → what might
 * explain it. READ-ONLY: nothing here writes, and no money is read.
 *
 * Everything derives at read time (storage rule 5b) from sheets that already
 * exist — Inventory, GoodsReceipts, BaleMovements, StockTakes, ApprovalQueue.
 * No new sheet, no new column.
 *
 * ── The four things this file had to decide, and why ────────────────────
 *
 * 1. THE GAP IS MEASURED AT THE COUNT, NOT AT RANGE-END.
 *    A StockTakes row stores BOTH sides of its own comparison: the book at
 *    the audit instant (sheet_bales/sheet_bundles/sheet_yards) and what the
 *    auditor counted (counted_bales/counted_bundles). Comparing the count
 *    against the book as it is NOW would silently fold every sale since the
 *    audit into the "gap" and blame the auditor for goods that legitimately
 *    left afterwards. So the gap is always sheet_* vs counted_* — one
 *    instant, two figures, stored side by side. `movements_since_count`
 *    tells the page how far the book has travelled since.
 *
 * 2. THE GAP CANNOT ALWAYS BE STATED IN YARDS, SO SOMETIMES IT ISN'T.
 *    StockTakes has sheet_yards but NO counted_yards, and the count is
 *    blind — it records two integers (full bales, loose thans) and never
 *    which bales they were (warehouseAuditFlow.js:7-9, :457-462). Per-bale
 *    yardage genuinely varies, so no average recovers the missing yards;
 *    an estimate's error routinely exceeds the gap it claims to measure.
 *    Therefore: gap_yards is EXACT (0) for a reconciled row, and null for
 *    mismatch/flagged — where `gap_packaging` carries the exact, honest
 *    delta in bales and thans instead. The locked rule "settle the gap in
 *    yards" is kept by refusing to invent a yard figure, never by faking one.
 *
 * 3. BALANCES ARE REPLAYED BACKWARD FROM TODAY'S SHELF.
 *    Inventory is current state, mutated in place, so a historical shelf
 *    cannot be read — it has to be reconstructed. Today's available rows
 *    are exact, and every movement names its own bales, so we walk the list
 *    newest → oldest, inverting each movement, and record the shelf after
 *    each one. That makes `closing.book` equal the last running balance BY
 *    CONSTRUCTION, and puts any residual imprecision in the opening figure,
 *    where it is labelled rather than hidden.
 *
 * 4. PACKAGING IS ROSTER-ONLY (`packaging_basis: 'roster'`).
 *    Each line speaks the item's own packaging: a movement that took a
 *    bale's whole roster counts in bales, anything less counts in thans.
 *    We deliberately do NOT consult THAN_VISIBILITY_WAREHOUSES, so this
 *    page never prints both units for the same goods and never re-labels
 *    history when that Settings cell changes. Rendering goes through
 *    unitDisplayService.formatCounts — the shared §6c grammar engine —
 *    never a hand-rolled `${n}B`.
 *
 * 5. THE GAP IS A PAIR, AND A PAIR DOES NOT SUBTRACT.
 *    Opening a sealed bale turns 1B into N loose thans, so a square shelf can
 *    read {bales:+1, thans:-N}. `gapOf` therefore publishes a DIRECTION —
 *    none / short / over / unreconciled — and a label signed per unit, and
 *    treats the audit's own `reconciled` verdict as final (the flow already
 *    proved the re-label with `openedBaleEquivalence`). Candidates are hunted
 *    only for a shortage or an unreconciled pair, never for a surplus.
 *
 * Known data limits, surfaced in `notes` rather than papered over:
 *   • a return is dated the Lagos day it was APPROVED (the return flow asks
 *     for no date), so its row is the recorded date, not the day the cloth
 *     came back;
 *   • BaleMovements carries a than count but no yardage, so returns and
 *     transfers take their yards from the bale's own rows — exact when the
 *     movement covers the whole roster, the bale's mean than when it does not
 *     (which thans moved is never recorded), and unknown when the bale has no
 *     rows on file at all;
 *   • an approved return CLEARS soldTo/soldDate, erasing that sale from
 *     Inventory, so sales are merged with the append-only BaleMovements
 *     `sale` rows (larger than-count per bale wins) — otherwise the return's
 *     IN leg would arrive with no OUT leg and drag every earlier balance
 *     below reality;
 *   • a than sold, returned and sold again shows only its LATEST sale in
 *     Inventory; the earlier one survives in the movement log.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const goodsReceiptsRepository = require('../repositories/goodsReceiptsRepository');
const baleMovementsRepository = require('../repositories/baleMovementsRepository');
const stockTakesRepository = require('../repositories/stockTakesRepository');
const approvalQueueRepository = require('../repositories/approvalQueueRepository');
const { formatCounts } = require('./unitDisplayService');
const { baleKeyOf } = require('./baleIdentity');
const { normDay, todayInLagos } = require('../utils/dates');
const logger = require('../utils/logger');

const RANGE_PRESETS = ['since_audit', 'this_month', '30_days', 'all_time'];
const DEFAULT_PRESET = 'since_audit';
const DAY_MS = 24 * 60 * 60 * 1000;

const str = (v) => String(v == null ? '' : v).trim();
const upper = (v) => str(v).toUpperCase();
const lower = (v) => str(v).toLowerCase();
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** "available @ Kano office" → { status:'available', warehouse:'Kano office' } */
function parseState(label) {
  const s = str(label);
  const at = s.indexOf('@');
  if (at < 0) return { status: lower(s), warehouse: '' };
  return { status: lower(s.slice(0, at)), warehouse: str(s.slice(at + 1)) };
}

/** ISO day N days before `day` (both 'YYYY-MM-DD'). */
function dayMinus(day, n) {
  const t = Date.parse(`${day}T00:00:00Z`);
  if (!Number.isFinite(t)) return day;
  return new Date(t - n * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Packaging of a shelf state, judged against each bale's own roster:
 * a bale with every than present is one B, otherwise its thans are loose.
 * @param {Map<string, number>} shelf baleKey → thans present
 * @param {Map<string, number>} roster baleKey → thans the bale holds in full
 */
function packagingOf(shelf, roster) {
  let bales = 0; let thans = 0;
  for (const [key, count] of shelf) {
    if (count <= 0) continue;
    const total = roster.get(key) || count;
    if (count >= total) bales += 1; else thans += count;
  }
  return { bales, thans };
}

/**
 * The gap on one stock take, as the audit itself recorded it.
 *
 * The two sides are packaging PAIRS, and a pair does not subtract
 * component-wise: opening a sealed bale turns 1B into N loose thans, so a
 * perfectly square shelf reads {bales:+1, thans:-N}. Three consequences are
 * encoded here, each of which the page used to get wrong:
 *   • a row the audit itself judged `reconciled` has NO gap — the flow already
 *     proved the packaging re-label with `openedBaleEquivalence`;
 *   • a mixed-sign pair is `unreconciled` (packaging changed AND it did not
 *     balance), never a shortage of the sum of its absolutes;
 *   • the label carries a sign PER COMPONENT, built from formatCounts so the
 *     §6c grammar still comes from the one engine.
 * `direction` is what decides red vs green and whether candidates are hunted.
 */
function gapOf(take) {
  const reconciled = lower(take.result) === 'reconciled';
  const bales = num(take.sheet_bales) - num(take.counted_bales);
  const thans = num(take.sheet_bundles) - num(take.counted_bundles);
  if (reconciled || (bales === 0 && thans === 0)) {
    return { bales: 0, thans: 0, direction: 'none', label: null, yards: reconciled ? 0 : null };
  }
  let direction;
  if (bales >= 0 && thans >= 0) direction = 'short';
  else if (bales <= 0 && thans <= 0) direction = 'over';
  else direction = 'unreconciled';
  // A positive delta means the book held MORE than was counted, i.e. the
  // shelf is short — so it prints with a minus.
  const parts = [];
  if (bales) parts.push((bales > 0 ? '−' : '+') + formatCounts({ bales: Math.abs(bales), thans: 0 }));
  if (thans) parts.push((thans > 0 ? '−' : '+') + formatCounts({ bales: 0, thans: Math.abs(thans) }));
  return { bales, thans, direction, label: parts.join(' ') || null, yards: null };
}

/** A payload quantity block: numbers for arithmetic, one §6c label for the page. */
function qtyBlock({ bales, thans, yards, yardsExact = true, empty = '0' }) {
  return {
    bales, thans,
    yards: yards == null ? null : Math.round(yards * 100) / 100,
    yards_exact: yardsExact,
    label: formatCounts({ bales, thans, empty }),
  };
}

/** Resolve the requested range into { from, to, preset }. `to` is always today. */
function resolveRange(preset, today, lastAuditDay) {
  const p = RANGE_PRESETS.includes(str(preset)) ? str(preset) : DEFAULT_PRESET;
  const to = today;
  let from;
  if (p === 'this_month') from = `${today.slice(0, 7)}-01`;
  else if (p === '30_days') from = dayMinus(today, 30);
  else if (p === 'all_time') from = '';
  else from = lastAuditDay || '';   // since_audit; no audit on file → all time
  return { from, to, preset: p };
}

/**
 * The tappable lists the scope bar is built from — the page carries no
 * free-text input, so every warehouse and design it can reach comes from here.
 * @param {{warehouse?:string}} [q]
 * @returns {Promise<{warehouses:string[], designs:Array<{code:string, category:string}>}>}
 */
async function pickers(q) {
  const warehouse = lower(str(q && q.warehouse));
  const inv = await inventoryRepository.getAll();
  const warehouses = [...new Set((inv || [])
    .map((r) => str(r.warehouse)).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const seen = new Map();
  for (const r of (inv || [])) {
    if (warehouse && lower(r.warehouse) !== warehouse) continue;
    const code = str(r.design);
    if (!code) continue;
    if (!seen.has(upper(code))) seen.set(upper(code), { code, category: str(r.designCategory) });
    else if (!seen.get(upper(code)).category && str(r.designCategory)) {
      seen.get(upper(code)).category = str(r.designCategory);
    }
  }
  const designs = [...seen.values()].sort((a, b) => a.code.localeCompare(b.code));
  return { warehouses, designs };
}

/**
 * Build the ledger.
 * @param {{design:string, warehouse:string, range?:string, today?:string}} q
 * @returns {Promise<object>} the DML-1 payload
 */
async function build(q) {
  const design = str(q && q.design);
  const warehouse = str(q && q.warehouse);
  const today = str(q && q.today) || todayInLagos();
  if (!design || !warehouse) {
    const err = new Error('design and warehouse are required');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  const D = upper(design);
  const W = lower(warehouse);
  const notes = [];

  const [inv, grns, moves, takes] = await Promise.all([
    inventoryRepository.getAll(),
    goodsReceiptsRepository.getAll().catch(() => []),
    baleMovementsRepository.getAll().catch(() => []),
    stockTakesRepository.getAll().catch(() => []),
  ]);

  const designRows = (inv || []).filter((r) => upper(r.design) === D);
  const hereRows = designRows.filter((r) => lower(r.warehouse) === W);

  // A bale's ROSTER is a property of the bale, not of where its thans sit
  // today (rule 6c: judged against the bale's full than roster, all
  // statuses). Counting only the rows still in this warehouse would call a
  // 5-of-20 sale a whole bale the moment the other 15 were transferred out,
  // and would price a dispatched bale at nothing — so the roster and the
  // yardage are read from every row of the design, wherever it sits now.
  // Only `shelfNow` below stays warehouse-scoped: that is a question about
  // this shelf.
  const roster = new Map();
  const baleMeta = new Map();
  const baleYards = new Map();
  for (const r of designRows) {
    const k = baleKeyOf(r.design, r.packageNo, r.arrivalBatch);
    roster.set(k, (roster.get(k) || 0) + 1);
    if (!baleMeta.has(k)) {
      baleMeta.set(k, { bale_no: str(r.packageNo), container: str(r.arrivalBatch), shade: str(r.shade) });
    }
    const e = baleYards.get(k) || { yards: 0, rows: 0 };
    e.yards += num(r.yards); e.rows += 1;
    baleYards.set(k, e);
  }
  /**
   * Yards for a movement that names a than count but no yardage — every
   * BaleMovements row is one. Exact when the count covers the bale's whole
   * roster (the sum IS the bale); a mean otherwise, because WHICH thans
   * moved is not recorded; unknown when the bale has no rows on file at all.
   */
  const yardsForThans = (key, thans) => {
    const e = baleYards.get(key);
    if (!e || !e.rows) return { yards: 0, exact: false, unknown: true };
    if (thans >= e.rows) return { yards: e.yards, exact: true, unknown: false };
    return { yards: (e.yards / e.rows) * thans, exact: false, unknown: false };
  };

  const category = str((designRows.find((r) => str(r.designCategory)) || {}).designCategory);

  // ── the movement list ────────────────────────────────────────────────
  const movements = [];

  // IN · goods receipts. The GRN header spans every design in the container
  // (and its total_bales counts THANS on a manual receipt), so the per-design
  // quantity is summed from the Inventory rows that carry the grn_id instead.
  const grnById = new Map((grns || []).map((g) => [str(g.grn_id), g]));
  const byGrn = new Map();
  for (const r of designRows) {
    const gid = str(r.grnId);
    if (!gid) continue;
    const grn = grnById.get(gid);
    // The GRN header names the RECEIVING warehouse; an Inventory row's
    // warehouse is rewritten by any later transfer, so the header is the
    // only truthful "where did this land".
    if (!grn || lower(grn.warehouse) !== W) continue;
    if (!byGrn.has(gid)) byGrn.set(gid, []);
    byGrn.get(gid).push(r);
  }
  for (const [gid, rows] of byGrn) {
    const grn = grnById.get(gid);
    const days = rows.map((r) => normDay(r.dateReceived)).filter(Boolean).sort();
    const date = days[0] || normDay(grn.received_at) || '';
    movements.push({
      id: `grn:${gid}`,
      date,
      sortAt: str(grn.received_at) || date,
      family: 'in',
      type: 'receipt',
      counterparty: str(grn.supplier) || '—',
      ref: gid,
      rows,
      yardsExact: true,
    });
  }

  // OUT · sales, customer named. One movement per (day, customer) — the only
  // grouping key that exists, and the one Customer Supplies already uses:
  // an Inventory row carries no sale reference id.
  //
  // Inventory carries the exact yardage, so it leads. But an approved RETURN
  // clears soldTo and soldDate on the row (RET-2), which erases the original
  // sale from Inventory altogether — leaving the return's IN leg with no OUT
  // leg, goods appearing from nowhere and every earlier balance dragged below
  // reality. BaleMovements keeps that sale forever (append-only, kind
  // 'sale'), so the two sources are merged per bale and the LARGER than count
  // wins: a returned sale still shows its OUT leg, and a sale still on file
  // is never counted twice.
  const soldHere = hereRows.filter((r) => r.status === 'sold' && str(r.soldTo) && str(r.soldDate));
  const saleGroups = new Map();
  const groupFor = (day, customer) => {
    const k = `${day}|${lower(customer)}`;
    if (!saleGroups.has(k)) saleGroups.set(k, { key: k, day, customer: str(customer) || '—', byBale: new Map() });
    return saleGroups.get(k);
  };
  for (const r of soldHere) {
    const day = normDay(r.soldDate);
    if (!day) continue;
    const g = groupFor(day, r.soldTo);
    const key = baleKeyOf(r.design, r.packageNo, r.arrivalBatch);
    const e = g.byBale.get(key) || {
      key, thans: 0, yards: 0, shades: new Set(), exact: true, unknown: false,
      meta: baleMeta.get(key) || { bale_no: str(r.packageNo), container: str(r.arrivalBatch), shade: str(r.shade) },
    };
    e.thans += 1; e.yards += num(r.yards);
    if (str(r.shade)) e.shades.add(str(r.shade));
    g.byBale.set(key, e);
  }
  for (const m of (moves || [])) {
    if (upper(m.design) !== D || lower(m.kind) !== 'sale') continue;
    const fromS = parseState(m.fromState);
    if (!(fromS.status === 'available' && lower(fromS.warehouse) === W)) continue;
    const day = normDay(m.movedOn);
    if (!day) continue;
    const key = baleKeyOf(m.design, m.baleNo, m.container);
    const thans = num(m.thans) || 1;
    const g = groupFor(day, m.ref);
    const have = g.byBale.get(key);
    if (have && have.thans >= thans) continue;   // Inventory already has it, exactly
    const y = yardsForThans(key, thans);
    g.byBale.set(key, {
      key, thans, yards: y.yards, exact: y.exact, unknown: y.unknown,
      shades: new Set(str(m.shade) ? [str(m.shade)] : []),
      meta: baleMeta.get(key) || { bale_no: str(m.baleNo), container: str(m.container), shade: str(m.shade) },
    });
  }
  for (const g of saleGroups.values()) {
    const foot = [...g.byBale.values()];
    movements.push({
      id: `sale:${g.key}`,
      date: g.day,
      sortAt: g.day,
      family: 'out',
      type: 'sale',
      counterparty: g.customer,
      ref: '',
      synthetic: foot,
      yardsExact: foot.every((f) => f.exact !== false),
      yardsUnknown: foot.some((f) => f.unknown),
    });
  }

  // IN/OUT · returns and transfers, from the append-only BaleMovements log.
  // Sales and intake are deliberately NOT taken from here: Inventory carries
  // their exact yardage, and taking them twice would double the ledger.
  const MOVE_KINDS = new Set(['return', 'correction', 'dispatch', 'receive', 'reject', 'transfer']);
  for (const m of (moves || [])) {
    if (upper(m.design) !== D) continue;
    if (!MOVE_KINDS.has(lower(m.kind))) continue;
    const to = parseState(m.toState);
    const from = parseState(m.fromState);
    const landsHere = to.status === 'available' && lower(to.warehouse) === W;
    const leavesHere = from.status === 'available' && lower(from.warehouse) === W;
    if (!landsHere && !leavesHere) continue;
    const key = baleKeyOf(m.design, m.baleNo, m.container);
    const thans = num(m.thans) || 1;
    const y = yardsForThans(key, thans);
    const kind = lower(m.kind);
    const type = kind === 'return' || kind === 'correction' ? kind
      : (landsHere ? 'transfer_in' : 'transfer_out');
    movements.push({
      id: `bm:${m.rowIndex}`,
      date: normDay(m.movedOn) || '',
      sortAt: str(m.timestamp) || normDay(m.movedOn) || '',
      family: landsHere ? 'in' : 'out',
      type,
      counterparty: str(m.ref) || (landsHere ? str(from.warehouse) : str(to.warehouse)) || '—',
      ref: '',
      synthetic: [{ key, thans, yards: y.yards, meta: baleMeta.get(key)
        || { bale_no: str(m.baleNo), container: str(m.container), shade: str(m.shade) } }],
      yardsExact: y.exact,
      yardsUnknown: y.unknown,
      loggedAt: str(m.timestamp),
    });
  }

  // CHECKPOINT · stock takes. Both sides of the comparison live on the row.
  const takesHere = (takes || []).filter((t) => lower(t.warehouse) === W && upper(t.design) === D);
  for (const t of takesHere) {
    const day = normDay(t.audited_at) || '';
    const counted = t.counted_bales === null && t.counted_bundles === null
      ? null
      : { bales: num(t.counted_bales), thans: num(t.counted_bundles) };
    movements.push({
      id: `stk:${t.stocktake_id}`,
      date: day,
      sortAt: str(t.audited_at) || day,
      family: 'checkpoint',
      type: 'audit',
      counterparty: str(t.auditor),
      ref: str(t.stocktake_id),
      take: t,
      counted,
      yardsExact: true,
    });
  }

  movements.sort((a, b) => (a.sortAt < b.sortAt ? -1 : a.sortAt > b.sortAt ? 1 : 0));

  // ── range ────────────────────────────────────────────────────────────
  const lastAudit = takesHere
    .map((t) => normDay(t.audited_at))
    .filter(Boolean)
    .sort()
    .pop() || '';
  const range = resolveRange(q && q.range, today, lastAudit);
  const inRange = movements.filter((m) => (!range.from || m.date >= range.from) && (!range.to || m.date <= range.to));

  // ── shelf now, then replay backward ──────────────────────────────────
  const shelfNow = new Map();
  let yardsNow = 0;
  for (const r of hereRows) {
    if (r.status !== 'available') continue;   // the audit's own book rule
    const k = baleKeyOf(r.design, r.packageNo, r.arrivalBatch);
    shelfNow.set(k, (shelfNow.get(k) || 0) + 1);
    yardsNow += num(r.yards);
  }
  const bookNow = { ...packagingOf(shelfNow, roster), yards: yardsNow };

  // Each movement's own footprint: which bales, how many thans, what yards.
  // Computed for EVERY movement, because the hint scan looks outside the
  // displayed range.
  for (const m of movements) {
    if (m.family === 'checkpoint') { m.foot = []; m.thans = 0; m.yards = 0; continue; }
    if (m.synthetic) {
      m.foot = m.synthetic;
      m.thans = m.synthetic.reduce((s, x) => s + x.thans, 0);
      m.yards = m.synthetic.reduce((s, x) => s + x.yards, 0);
      continue;
    }
    const byBale = new Map();
    for (const r of m.rows) {
      const k = baleKeyOf(r.design, r.packageNo, r.arrivalBatch);
      const e = byBale.get(k) || { key: k, thans: 0, yards: 0, meta: baleMeta.get(k)
        || { bale_no: str(r.packageNo), container: str(r.arrivalBatch), shade: str(r.shade) }, shades: new Set() };
      e.thans += 1; e.yards += num(r.yards);
      if (str(r.shade)) e.shades.add(str(r.shade));
      byBale.set(k, e);
    }
    m.foot = [...byBale.values()];
    m.thans = m.foot.reduce((s, x) => s + x.thans, 0);
    m.yards = m.foot.reduce((s, x) => s + x.yards, 0);
  }

  // Walk newest → oldest, inverting each movement to recover the shelf as it
  // stood after every row. `running` is therefore exact at the newest end and
  // carries any estimate backwards into `opening`, where it is labelled.
  const shelf = new Map(shelfNow);
  let yards = yardsNow;
  let anyEstimate = false;
  let anyUnknown = false;
  for (let i = inRange.length - 1; i >= 0; i -= 1) {
    const m = inRange[i];
    m.after = { ...packagingOf(shelf, roster), yards };
    if (m.family === 'checkpoint') continue;
    const sign = m.family === 'in' ? -1 : 1;   // inverted: undo the movement
    for (const f of m.foot) {
      shelf.set(f.key, (shelf.get(f.key) || 0) + sign * f.thans);
      if (shelf.get(f.key) <= 0) shelf.delete(f.key);
    }
    yards += sign * m.yards;
    if (!m.yardsExact) anyEstimate = true;
    if (m.yardsUnknown) anyUnknown = true;
  }
  const openingPack = packagingOf(shelf, roster);
  // A negative opening is arithmetically impossible on a real shelf: it means
  // a movement in this window carried yardage we could not recover. Publish
  // null and say so, rather than printing a figure the owner cannot act on.
  const openingYards = yards < -0.5 ? null : Math.max(0, yards);
  if (openingYards === null) {
    notes.push('The opening yardage cannot be reconstructed for this window: a movement in it carries '
      + 'no yardage on file. The packaging counts and every later balance are still exact.');
  }
  const opening = {
    ...qtyBlock({ bales: openingPack.bales, thans: openingPack.thans, yards: openingYards, yardsExact: !anyEstimate, empty: '0' }),
    at: range.from || (inRange.length ? inRange[0].date : range.to),
    // Only a window that genuinely opens on the design's first receipt shows
    // "first goods receipt"; everything else is a balance carried in.
    source: (inRange.length && inRange[0].family === 'in' && inRange[0].type === 'receipt'
      && openingPack.bales === 0 && openingPack.thans === 0) ? 'first_grn' : 'carried',
  };

  // ── closing: book now, the last real count, and the gap at that count ──
  const counts = takesHere
    .filter((t) => t.counted_bales !== null || t.counted_bundles !== null)
    .filter((t) => (!range.from || (normDay(t.audited_at) || '') >= range.from))
    .sort((a, b) => (str(a.audited_at) < str(b.audited_at) ? -1 : 1));
  const lastCount = counts.length ? counts[counts.length - 1] : null;

  let count = null; let gap = null; let movementsSinceCount = 0;
  if (lastCount) {
    const reconciled = lower(lastCount.result) === 'reconciled';
    gap = gapOf(lastCount);
    count = {
      ...qtyBlock({
        bales: num(lastCount.counted_bales),
        thans: num(lastCount.counted_bundles),
        // A reconciled row is the same goods in the same or re-labelled
        // packaging, so its yards ARE the book's. Nothing else has a yardage.
        yards: reconciled ? num(lastCount.sheet_yards) : null,
        yardsExact: reconciled,
        empty: '0',
      }),
      auditor: str(lastCount.auditor),
      at: normDay(lastCount.audited_at) || '',
      result: str(lastCount.result) || 'reconciled',
      book_at_count: qtyBlock({
        bales: num(lastCount.sheet_bales),
        thans: num(lastCount.sheet_bundles),
        yards: num(lastCount.sheet_yards),
        empty: '0',
      }),
    };
    if (gap.yards === null && gap.direction !== 'none') {
      notes.push('The gap is stated in packaging, not yards: a blind count records how many '
        + 'bales and loose thans were seen, never which ones, and per-bale yardage varies — so no '
        + 'yard figure can be derived without inventing one.');
    }
    const countDay = normDay(lastCount.audited_at) || '';
    movementsSinceCount = inRange.filter((m) => m.family !== 'checkpoint' && m.date > countDay).length;
  }

  const closing = {
    book: qtyBlock({ bales: bookNow.bales, thans: bookNow.thans, yards: bookNow.yards, empty: '0' }),
    count,
    // `direction` is the field to branch on: 'none' | 'short' | 'over' |
    // 'unreconciled'. gap_yards is a number only when it is exactly knowable.
    gap_yards: gap ? gap.yards : null,
    gap_packaging: gap ? { bales: gap.bales, thans: gap.thans } : null,
    gap_direction: gap ? gap.direction : null,
    gap_label: gap ? gap.label : null,
    movements_since_count: movementsSinceCount,
  };
  if (movementsSinceCount > 0) {
    notes.push(`The book has moved ${movementsSinceCount} time(s) since the count, so the book balance `
      + 'above is today\'s shelf, while the gap is measured at the moment of the count.');
  }
  if (anyEstimate && !anyUnknown) {
    notes.push('Some yard figures come from a bale\'s own mean than, because transfer and return '
      + 'records store a than count but no yardage and never say WHICH thans moved. The packaging '
      + 'counts are exact.');
  }
  if (anyUnknown) {
    notes.push('One or more movements name a bale with no rows left on file, so their yardage could '
      + 'not be recovered at all. Their packaging is exact; treat the yard column as incomplete.');
  }

  // Candidates are hunted only when goods are actually missing. A surplus
  // is not a shortage, and a reconciled re-label is not a discrepancy at all.
  const hints = (lastCount && gap && (gap.direction === 'short' || gap.direction === 'unreconciled'))
    ? await buildHints({ take: lastCount, D, W, movements, countDay: normDay(lastCount.audited_at) || '',
      baleYards, roster, notes, inv })
    : [];

  const whList = [...new Set((inv || []).map((r) => str(r.warehouse)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));
  const dgSeen = new Map();
  for (const r of (inv || [])) {
    if (lower(r.warehouse) !== W) continue;
    const code = str(r.design);
    if (code && !dgSeen.has(upper(code))) dgSeen.set(upper(code), { code, category: str(r.designCategory) });
  }

  return {
    design: { code: design, category },
    warehouse,
    range,
    packaging_basis: 'roster',
    pickers: {
      warehouses: whList,
      designs: [...dgSeen.values()].sort((a, b) => a.code.localeCompare(b.code)),
    },
    opening,
    movements: inRange.map((m) => renderMovement(m, roster)),
    closing,
    hints,
    notes,
  };
}

/**
 * Shape one movement for the page.
 * @param {object} m the internal movement
 * @param {Map<string, number>} roster baleKey → thans the bale holds in full
 */
function renderMovement(m, roster) {
  const out = {
    id: m.id,
    date: m.date,
    family: m.family,
    type: m.type,
    counterparty: m.counterparty,
    ref: m.ref || '',
  };
  if (m.family === 'checkpoint') {
    const t = m.take;
    const reconciled = lower(t.result) === 'reconciled';
    const g = m.counted ? gapOf(t) : null;
    out.qty = null;
    out.checkpoint = {
      result: str(t.result) || 'reconciled',
      auditor: str(t.auditor),
      // A flag-clear carries no count of its own; saying "counted by" would
      // dress an unresolved mismatch up as a fresh clean count.
      counted: !!m.counted,
      book: qtyBlock({ bales: num(t.sheet_bales), thans: num(t.sheet_bundles), yards: num(t.sheet_yards), empty: '0' }),
      count: m.counted
        ? qtyBlock({ bales: m.counted.bales, thans: m.counted.thans, yards: reconciled ? num(t.sheet_yards) : null, yardsExact: reconciled, empty: '0' })
        : null,
      gap_yards: g ? g.yards : null,
      gap_packaging: g ? { bales: g.bales, thans: g.thans } : null,
      gap_direction: g ? g.direction : null,
      gap_label: g ? g.label : null,
      note: str(t.note),
    };
  } else {
    const wholes = m.foot.filter((f) => f.thans > 0);
    out.qty = qtyBlock({
      bales: 0, thans: 0, yards: m.yards, yardsExact: m.yardsExact, empty: '0',
    });
    // Packaging of the movement itself: a bale whose whole roster moved is
    // one B; a partial take is loose thans. Judged per bale, never mixed.
    let bales = 0; let thans = 0;
    const wholeBales = []; const loose = [];
    for (const f of wholes) {
      // Whole means the movement took EVERY than of that bale's roster; with
      // no roster on file the bale is judged by what moved, which is the only
      // non-guessing answer available.
      const rosterTotal = (roster && roster.get(f.key)) || f.thans;
      if (f.thans >= rosterTotal) {
        bales += 1;
        wholeBales.push({ bale_no: f.meta.bale_no, thans: f.thans, yards: Math.round(f.yards * 100) / 100 });
      } else {
        thans += f.thans;
        loose.push({ count: f.thans, yards: Math.round(f.yards * 100) / 100, from_bale: f.meta.bale_no });
      }
    }
    out.qty.bales = bales; out.qty.thans = thans;
    out.qty.label = formatCounts({ bales, thans, empty: '0' });
    out.detail = {
      whole_bales: wholeBales,
      loose,
      shades: [...new Set(m.foot.flatMap((f) => (f.shades ? [...f.shades] : (f.meta.shade ? [f.meta.shade] : []))))],
    };
  }
  out.running = qtyBlock({ bales: m.after.bales, thans: m.after.thans, yards: m.after.yards, empty: '0' });
  return out;
}

/**
 * Candidate explanations for a shortage, and ONLY the arithmetically valid ones.
 *
 * A positive gap means the shelf holds LESS than the book said at the count.
 * A candidate therefore qualifies only if it removed goods PHYSICALLY without
 * the book having deducted them by the time the auditor counted:
 *   • a sale still queued for approval — goods handed over, book untouched;
 *   • an OUT movement whose business day is on or before the count but which
 *     was written to the sheet after it — the audit's book never saw it.
 * A transfer already deducted by a ledger row can NEVER qualify: the book
 * excluded it, so it cannot explain the book EXCEEDING the count. Listing it
 * would double-count the same bale — the exact error this page exists to catch.
 */
async function buildHints({ take, D, W, movements, countDay, baleYards, roster, notes, inv }) {
  const countedAt = str(take.audited_at);
  const hints = [];

  // Resolve a queued item to a design + warehouse. A sale door may omit
  // either (the thin package items carry only a bale number), so the bale is
  // looked up in Inventory. An item that still cannot be pinned is DROPPED:
  // absence of evidence is not a match, and offering it would be the padding
  // this function exists to refuse.
  const byPkg = new Map();
  for (const r of (inv || [])) {
    const k = `${lower(r.warehouse)}|${upper(r.packageNo)}`;
    if (!byPkg.has(k)) byPkg.set(k, r);
  }
  const resolveItem = (it, aj) => {
    const wh = str(it.warehouse || aj.warehouse);
    let dg = str(it.design || aj.design);
    if (!dg && Array.isArray(Object.keys(aj.yardsByDesign || {})) && Object.keys(aj.yardsByDesign || {}).length === 1) {
      dg = Object.keys(aj.yardsByDesign)[0];
    }
    if ((!dg || !wh) && str(it.packageNo)) {
      const hit = byPkg.get(`${lower(wh || W)}|${upper(it.packageNo)}`);
      if (hit) { dg = dg || str(hit.design); }
    }
    if (!dg || !wh) return null;
    return { design: upper(dg), warehouse: lower(wh) };
  };

  // 1. Sales still sitting in the approval queue — goods handed over, the
  //    book not yet deducted. Only those queued at or before the count can
  //    explain a gap measured AT the count; anything later left afterwards
  //    and belongs to `movements_since_count`, not to this list.
  try {
    const pending = await approvalQueueRepository.getAllPending();
    for (const p of (pending || [])) {
      const aj = p.actionJSON || {};
      const action = str(aj.action);
      if (!['sale_bundle', 'sell_package', 'sell_than', 'sell_batch'].includes(action)) continue;
      const queuedDay = normDay(aj.salesDate) || normDay(p.createdAt) || '';
      if (!queuedDay || (countDay && queuedDay > countDay)) continue;
      const items = action === 'sale_bundle'
        ? (Array.isArray(aj.items) ? aj.items : [])
        : [{ packageNo: aj.packageNo, warehouse: aj.warehouse, design: aj.design, yards: aj.yards, thans: aj.thans }];
      const mine = items.filter((it) => {
        const r = resolveItem(it, aj);
        return r && r.design === D && r.warehouse === W;
      });
      if (!mine.length) continue;
      let yards = 0; let exact = true;
      for (const it of mine) {
        if (num(it.yards) > 0) { yards += num(it.yards); continue; }
        const key = baleKeyOf(D, it.packageNo, it.arrivalBatch);
        const e = baleYards.get(key);
        const thans = num(it.thans) || 1;
        if (!e || !e.rows) { exact = false; continue; }
        if (thans >= e.rows) { yards += e.yards; continue; }
        yards += (e.yards / e.rows) * thans; exact = false;
      }
      hints.push({
        yards: yards > 0 ? Math.round(yards * 100) / 100 : null,
        yards_exact: exact && yards > 0,
        title: 'Goods gone, approval still pending',
        detail: `${str(aj.customer) || 'A buyer'} · ${mine.length} item(s) queued ${queuedDay} — `
          + 'the book has not deducted them yet',
        ref: str(p.requestId),
      });
    }
  } catch (e) {
    logger?.warn?.(`designMovement: pending-sale hints unavailable (${e.message})`);
  }

  // 2. OUT movements whose business day is on or before the count but which
  //    reached the sheet AFTER it — the audit's book never saw them. Scanned
  //    over EVERY movement, not just the displayed range: the count instant
  //    already bounds it, and a narrow range would otherwise let the page
  //    claim nothing was logged late when something was.
  for (const m of movements) {
    if (m.family !== 'out') continue;
    if (!m.loggedAt || !countedAt) continue;
    if (!(m.date && countDay && m.date <= countDay && m.loggedAt > countedAt)) continue;
    hints.push({
      yards: m.yards > 0 ? Math.round(m.yards * 100) / 100 : null,
      yards_exact: !!m.yardsExact,
      title: 'Logged after the count',
      detail: `${m.type === 'sale' ? 'Sale' : 'Transfer'} → ${m.counterparty} · dated ${m.date}, `
        + `written ${normDay(m.loggedAt)} — after the auditor counted`,
      ref: m.id,
    });
  }

  if (!hints.length) {
    notes.push('No candidate explains this shortage: nothing was queued for approval before the count '
      + 'and nothing was logged after it. The gap stands unexplained — recount before adjusting anything.');
  }
  return hints;
}

module.exports = {
  build,
  pickers,
  RANGE_PRESETS,
  _internals: { parseState, packagingOf, resolveRange, dayMinus, buildHints, renderMovement },
};
