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
const { baleGroupKey } = require('../utils/inventoryPickers');
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

  const sold = (await inventoryRepository.getSoldRows())
    .filter((r) => wants.has(norm(r.soldTo)));
  // TV-8 (§6c) — the labeller needs every Inventory row for the whole/loose
  // roster and the than-visibility warehouse set.
  let all = [];
  try { all = await inventoryRepository.getAll(); } catch (_) { all = sold; }
  let label = null;
  let roster = new Map();
  try {
    label = await unitDisplayService.createQtyLabeller(all);
    roster = unitDisplayService.buildBaleRoster(all);
  } catch (_) { label = null; }

  const byDay = new Map();
  for (const r of sold) {
    const day = normDay(r.soldDate);
    if (!byDay.has(day)) byDay.set(day, { pkgs: new Set(), thans: 0, yards: 0, rows: [] });
    const e = byDay.get(day);
    e.pkgs.add(baleGroupKey(r));
    e.thans += 1;
    e.yards += Number(r.yards) || 0;
    e.rows.push(r);
  }

  // Credit side — the movement log's `return` transitions carry the customer
  // the goods came back FROM (ref = soldTo at flip time). These rows are
  // written ONLY by the approved return executors: approval is structural.
  let moves = [];
  try { moves = await baleMovementsRepository.getAll(); } catch (_) { moves = []; }
  const retByDay = new Map();
  for (const m of moves) {
    if (m.kind !== 'return' || !wants.has(norm(m.ref))) continue;
    const day = normDay(m.movedOn || m.timestamp);
    if (!retByDay.has(day)) retByDay.set(day, { pkgs: new Set(), thans: 0, yards: 0, wholeBales: 0, looseThans: 0 });
    const e = retByDay.get(day);
    e.pkgs.add(`${m.design}|${m.baleNo}|${m.container}`);
    const moved = Number(m.thans) || 0;
    // Same whole/loose test the TV-8 engine applies: a bale counts as a
    // BALE only when every than of it came back.
    const total = roster.get(`pkg:${m.design}|${m.baleNo}|${String(m.container || '').toUpperCase()}`);
    if (total && moved >= total) e.wholeBales += 1; else e.looseThans += moved;
    e.thans += moved;
  }

  const entries = [];
  for (const [day, e] of byDay) {
    const qty = label ? inWords(label(e.rows)) : `${e.pkgs.size} Bale${e.pkgs.size === 1 ? '' : 's'}`;
    entries.push({
      day, kind: 'supply', bales: e.pkgs.size, thans: e.thans, yards: e.yards, qty,
      label: `${qty} (${fmtQty(e.yards)} yards)`,
    });
  }
  for (const [day, e] of retByDay) {
    const parts = [];
    if (e.wholeBales) parts.push(`${e.wholeBales}B`);
    if (e.looseThans) parts.push(`${e.looseThans}t`);
    const qty = inWords(parts.join(' + ')) || `${e.thans} thans`;
    entries.push({
      day, kind: 'return', bales: e.wholeBales, thans: e.thans, yards: 0, qty,
      label: `Return — ${qty}`,
    });
  }
  entries.sort((a, b) => String(a.day).localeCompare(String(b.day)) || (a.kind === 'supply' ? -1 : 1));

  const net = {
    bales: entries.reduce((s, e) => s + (e.kind === 'supply' ? e.bales : -e.bales), 0),
    thans: entries.reduce((s, e) => s + (e.kind === 'supply' ? e.thans : -e.thans), 0),
    yards: entries.reduce((s, e) => s + (e.kind === 'supply' ? e.yards : 0), 0),
  };
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
    const k = baleGroupKey(r);
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
  buildLedger, dayDetail, mintLedgerToken, verifyLedgerToken,
  _internals: { namesFor, TOKEN_RE },
};
