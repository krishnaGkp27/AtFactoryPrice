'use strict';

/**
 * supplyLedgerService — SLG-1, the per-customer SUPPLY LEDGER (owner format,
 * 06/07-Aug-2026, hand-drawn: Date | Particular | Debit | Credit | Balance,
 * "like excel sheet", black background).
 *
 * Owner-locked decisions:
 *   - GOODS ONLY. Not one naira anywhere. The Debit / Credit / Balance
 *     columns are RESERVED — the finance portal fills them later — and each
 *     entry is followed by a blank row where an in-between payment will sit.
 *   - Source of truth per BUSINESS_RULES §12: supplies (debit side) come
 *     from the Inventory sheet's sold rows; returns (credit side) come from
 *     the BaleMovements log, whose return transitions exist ONLY via the
 *     approved return executors — an unapproved return cannot appear here.
 *     An admin's `/revert_packages` correction logs `kind:'correction'`
 *     instead (RET-2): it erases the mis-entered sale from BOTH sides rather
 *     than showing the customer a return they never made.
 *   - Everything is derived AT READ TIME. There is no stored ledger copy to
 *     drift: a return or correction that lands in Inventory/BaleMovements
 *     is in the ledger on the next render, and in every other surface that
 *     reads the same sheets ("it must lift it back ... at all other places").
 *
 * Deliberate REUSE (owner: "check if something is already built around it"):
 *   - day grouping and bale identity ride the same getSoldRows + normDay +
 *     baleGroupKey used by Customer Supplies (soldBalesFlow) and the Supply
 *     Details drills, so the ledger can never disagree with them;
 *   - the day DETAIL a ledger row opens IS the SBL-2 compact supply card;
 *   - web tokens are signed by shareLinkService's own signer (one secret,
 *     one 404-on-tamper contract) with a distinct `k:'SL'` payload so a
 *     design-share token can never open a ledger page and vice versa.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const baleMovementsRepository = require('../repositories/baleMovementsRepository');
const { normDay } = require('../utils/dates');
const shareLinkService = require('./shareLinkService');
const unitDisplayService = require('./unitDisplayService');
const { fmtQty } = require('../utils/format');

const norm = (v) => String(v == null ? '' : v).trim().toLowerCase();

/**
 * BUSINESS_RULES §6c in the owner's ledger phrasing. The TV-8 engine is the
 * ONLY thing allowed to decide bales-vs-thans ("hardcoded ${n}B / ${n}t is a
 * bug"), so the label comes from unitDisplayService and this only spells its
 * tokens out: "26B" → "26 Bales", "4B + 21t" → "4 Bales + 21 thans". Without
 * it a customer who took 21 of a 25-than bale would read "1 Bale" here and
 * "21t" on Customer Supplies — the cross-surface disagreement the owner
 * ordered us to prevent.
 */
/**
 * One bale identity for BOTH ledger sides — STK-E1: the canonical key
 * from baleIdentity. The old local version left design/number raw-cased
 * while the movement writers uppercased, so a case mismatch could break
 * the debit dedupe and double-count a supply (SEN-1b review, divergence
 * class 2). One definition now, everywhere.
 */
function bmKey(design, packageNo, container) {
  return require('./baleIdentity').baleKeyOf(design, packageNo, container);
}

function inWords(label) {
  return String(label || '')
    .replace(/(\d+)B/g, (_, n) => `${n} Bale${n === '1' ? '' : 's'}`)
    .replace(/(\d+)t/g, (_, n) => `${n} than${n === '1' ? '' : 's'}`);
}

/** Every spelling that files under this customer (canonical + aliases). */
async function namesFor(customerName) {
  try {
    const ent = require('./customerEntity');
    const c = await ent.resolve({ name: customerName });
    if (c) return ent.namesFor(c).map(norm);
  } catch (_) { /* single spelling still scopes */ }
  return [norm(customerName)];
}

/**
 * The ledger rows, chronological. Supplies from Inventory sold rows;
 * returns from APPROVED return transitions in the movement log.
 * @returns {Promise<{entries:Array<{day, kind:'supply'|'return', bales:number, thans:number, yards:number, label:string}>, net:{bales:number, yards:number}}>}
 */
async function buildLedger(customerName) {
  const wants = new Set(await namesFor(customerName));

  // TV-8 (§6c) — the labeller needs every Inventory row for the whole/loose
  // roster and the than-visibility warehouse set.
  let all = [];
  try { all = await inventoryRepository.getAll(); } catch (_) { all = []; }
  let label = null;
  let roster = new Map();
  try {
    label = await unitDisplayService.createQtyLabeller(all);
    roster = unitDisplayService.buildBaleRoster(all);
  } catch (_) { label = null; }

  let moves = [];
  try { moves = await baleMovementsRepository.getAll(); } catch (_) { moves = []; }
  const mine = moves.filter((m) => wants.has(norm(m.ref)));

  /* ── DEBIT SIDE ────────────────────────────────────────────────────────
   * A ledger must not lose an entry when the goods later come back. The
   * Inventory sold rows are CURRENT STATE: an approved return flips them to
   * `available` and clears SoldTo, so the original supply DISAPPEARS from
   * them — while its return still shows on the credit side. Reading only
   * Inventory therefore subtracted a return twice and could drive the net
   * negative (adversarial review, 07-Aug-2026).
   *
   * So the debit side is the union of two views of the same event:
   *   - Inventory sold rows — the full history, including everything that
   *     predates the movement log (BMV-1, 03-Aug-2026);
   *   - `sale` rows in the movement log whose bale is NOT currently sold to
   *     this customer — i.e. supplies that were later returned, which
   *     Inventory can no longer show.
   * Deduped per (day, bale), so a bale still sold is never counted twice.
   */
  const sold = (await inventoryRepository.getSoldRows())
    .filter((r) => wants.has(norm(r.soldTo)));
  const soldKeys = new Set(sold.map((r) => `${normDay(r.soldDate)}|${bmKey(r.design, r.packageNo, r.arrivalBatch)}`));

  /* A CORRECTION is not a return. `/revert_packages` un-does a MIS-ENTERED
   * sale: no goods came back and no approval was taken, so it may neither
   * credit the ledger (the credit side already takes `return` only) NOR
   * leave the erased sale standing as a debit. Walk each bale's own chain:
   * a `sale` opens a supply, the next `return` closes it (debit stays, the
   * credit shows it came back), a `correction` erases it outright. */
  const correctedSales = new Set();
  const chains = new Map();
  for (const m of mine) {
    if (m.kind !== 'sale' && m.kind !== 'return' && m.kind !== 'correction') continue;
    const k = bmKey(m.design, m.baleNo, m.container);
    if (!chains.has(k)) chains.set(k, []);
    chains.get(k).push(m);
  }
  for (const [k, rows] of chains) {
    rows.sort((a, b) => String(normDay(a.movedOn || a.timestamp)).localeCompare(String(normDay(b.movedOn || b.timestamp)))
      || String(a.timestamp || '').localeCompare(String(b.timestamp || ''))
      || (a.rowIndex || 0) - (b.rowIndex || 0));
    let openDay = null;
    for (const m of rows) {
      if (m.kind === 'sale') { openDay = normDay(m.movedOn || m.timestamp); continue; }
      if (m.kind === 'correction' && openDay) correctedSales.add(`${openDay}|${k}`);
      openDay = null;
    }
  }

  const byDay = new Map();
  const dayOf = (d) => {
    if (!byDay.has(d)) byDay.set(d, { pkgs: new Set(), thans: 0, yards: 0, rows: [], extra: 0 });
    return byDay.get(d);
  };
  for (const r of sold) {
    const e = dayOf(normDay(r.soldDate));
    e.pkgs.add(bmKey(r.design, r.packageNo, r.arrivalBatch));
    e.thans += 1;
    e.yards += Number(r.yards) || 0;
    e.rows.push(r);
  }
  for (const m of mine) {
    if (m.kind !== 'sale') continue;
    const day = normDay(m.movedOn || m.timestamp);
    const key = bmKey(m.design, m.baleNo, m.container);
    if (soldKeys.has(`${day}|${key}`)) continue; // still sold — Inventory has it
    if (correctedSales.has(`${day}|${key}`)) continue; // the sale was erased
    const e = dayOf(day);
    if (e.pkgs.has(key)) continue;
    e.pkgs.add(key);
    e.thans += Number(m.thans) || 0;
    e.extra += Number(m.thans) || 0; // returned since: no Inventory row to label
  }

  /* ── CREDIT SIDE — approved returns only ─────────────────────────────── */
  const retByDay = new Map();
  for (const m of mine) {
    if (m.kind !== 'return') continue;
    const day = normDay(m.movedOn || m.timestamp);
    if (!retByDay.has(day)) retByDay.set(day, { pkgs: new Set(), thans: 0, wholeBales: 0, looseThans: 0 });
    const e = retByDay.get(day);
    e.pkgs.add(bmKey(m.design, m.baleNo, m.container));
    const moved = Number(m.thans) || 0;
    // Same whole/loose test the TV-8 engine applies: a bale counts as a
    // BALE only when every than of it came back.
    const total = roster.get(bmKey(m.design, m.baleNo, m.container));
    if (total && moved >= total) e.wholeBales += 1; else e.looseThans += moved;
    e.thans += moved;
  }

  const entries = [];
  for (const [day, e] of byDay) {
    // The label engine only understands Inventory rows; a supply whose rows
    // have since returned contributes thans we count explicitly.
    let qty = label && e.rows.length ? inWords(label(e.rows)) : '';
    if (e.extra) {
      const part = `${e.extra} than${e.extra === 1 ? '' : 's'} (returned since)`;
      qty = qty ? `${qty} + ${part}` : part;
    }
    if (!qty) qty = `${e.pkgs.size} Bale${e.pkgs.size === 1 ? '' : 's'}`;
    entries.push({
      day, kind: 'supply', bales: e.pkgs.size, thans: e.thans, yards: e.yards, qty,
      label: e.yards ? `${qty} (${fmtQty(e.yards)} yards)` : qty,
    });
  }
  for (const [day, e] of retByDay) {
    const parts = [];
    if (e.wholeBales) parts.push(`${e.wholeBales}B`);
    if (e.looseThans) parts.push(`${e.looseThans}t`);
    const qty = inWords(parts.join(' + ')) || `${e.thans} thans`;
    entries.push({
      day, kind: 'return', bales: e.pkgs.size, thans: e.thans, yards: 0, qty,
      label: `Return — ${qty}`,
    });
  }
  entries.sort((a, b) => String(a.day).localeCompare(String(b.day)) || (a.kind === 'supply' ? -1 : 1));

  /* ── NET — counted in THANS ───────────────────────────────────────────
   * Bale counts cannot be summed across days: one bale supplied in two
   * parts on two days would count twice, and the supply/return sides key
   * bales differently. Thans are atomic and additive, so the footer figure
   * is stated in thans and never contradicts the rows above it.
   */
  const netThans = entries.reduce((n, e) => n + (e.kind === 'supply' ? e.thans : -e.thans), 0);
  const heldBales = new Set(sold.map((r) => bmKey(r.design, r.packageNo, r.arrivalBatch)));
  const net = { thans: netThans, bales: heldBales.size, yards: sold.reduce((n, r) => n + (Number(r.yards) || 0), 0) };
  return { entries, net };
}

/**
 * One day's supplied goods, grouped design → shade → printed numbers — the
 * same grammar as the SBL-2 card, computed from the same sold rows.
 */
async function dayDetail(customerName, dayIso) {
  const wants = new Set(await namesFor(customerName));
  const rows = (await inventoryRepository.getSoldRows())
    .filter((r) => wants.has(norm(r.soldTo)) && normDay(r.soldDate) === String(dayIso));
  const designs = new Map();
  const seen = new Set();
  for (const r of rows) {
    if (!designs.has(r.design)) designs.set(r.design, new Map());
    const shades = designs.get(r.design);
    const sk = String(r.shade || '—');
    if (!shades.has(sk)) shades.set(sk, { bales: [], thans: 0, yards: 0 });
    const e = shades.get(sk);
    e.thans += 1;
    e.yards += Number(r.yards) || 0;
    const k = bmKey(r.design, r.packageNo, r.arrivalBatch);
    if (!seen.has(k)) { seen.add(k); e.bales.push(String(r.packageNo)); }
  }
  let cat = () => '';
  try {
    const dc = require('../repositories/designCategoriesRepository');
    cat = (d) => dc.categoryOfSync(d) || '';
  } catch (_) { /* bare headings */ }
  return [...designs.entries()].map(([design, shades]) => ({
    design,
    category: cat(design),
    shades: [...shades.entries()].map(([shade, e]) => ({ shade, ...e })),
  }));
}

/* ── web tokens — shareLinkService's signer, ledger-only payload ───────── */

// shareLinkService's sign() truncates the HMAC to 16 url-safe chars.
const TOKEN_RE = /^[A-Za-z0-9_-]{10,600}\.[A-Za-z0-9_-]{10,100}$/;

function mintLedgerToken(customerName, mintedBy) {
  const { sign } = shareLinkService._internals;
  const payload = {
    k: 'SL',
    n: String(customerName || '').trim(),
    m: String(mintedBy || ''),
    t: Math.floor(Date.now() / 1000),
  };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${b64}.${sign(b64)}`;
}

/** Null on any tamper or a non-ledger token — callers 404 with no hints. */
function verifyLedgerToken(token) {
  const t = String(token || '').trim();
  if (!TOKEN_RE.test(t)) return null;
  const { sign } = shareLinkService._internals;
  const [b64, sig] = t.split('.');
  const expect = sign(b64);
  const crypto = require('crypto');
  if (sig.length !== expect.length
    || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  let p;
  try { p = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')); } catch { return null; }
  if (!p || p.k !== 'SL' || !p.n) return null;
  return { customerName: String(p.n), mintedBy: String(p.m || ''), mintedAt: Number(p.t) || 0 };
}

module.exports = {
  buildLedger, dayDetail, mintLedgerToken, verifyLedgerToken, namesFor,
  _internals: { namesFor, bmKey, inWords, TOKEN_RE },
};
