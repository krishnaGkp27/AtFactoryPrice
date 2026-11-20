'use strict';

/**
 * returnRate — RET-8 (owner, 20-Nov-2026): a return whose sale record
 * carries no rate.
 *
 * An approved return credits the buyer at the rate each than was charged —
 * the rate on the sold Inventory row. Some sold rows carry none. Before
 * RET-8 such a return was approved anyway, the stock came back and NO
 * credit reached the ledger. Now the admin who approves first types the
 * missing rate (or says, on purpose, that nothing is credited), the fills
 * are frozen on the request's own actionJSON, every signature names the
 * fills it was given for, and the executor credits the gap at the fill.
 *
 * This module is the pure half: what a gap is, what a fill is, the
 * canonical print every signature carries, the credit a fill makes. The
 * screens live in `flows/returnRateStep.js`; the seam that calls them sits
 * in `approvalEvents.handleApprovalCallback`.
 *
 *   gap  = one (buyer, design) pair on the request with at least one than
 *          whose stored rate is not above zero
 *   fill = { key, customer, customerId, design, thans, yards, rate } or
 *          { …, noCredit: true }; saved as `actionJSON.rateFill` with
 *          `actionJSON.rateFillBy = { id, name, at }`
 *
 * A fill never replaces a recorded rate: a than with its own rate is
 * credited at it, always.
 */

const crypto = require('crypto');

const RETURN_ACTIONS = ['return_bundle', 'return_thans'];

const up = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** The buyer key the return cards use (approvalCards.buyerKey). */
const buyerKey = (it) => String((it && it.customerId) || '').trim()
  || up((it && (it.customer || it.soldTo)) || '');

const gapKey = (buyer, design) => `${buyer}|${up(design)}`;

function isReturn(aj) {
  return !!aj && RETURN_ACTIONS.includes(aj.action);
}

/**
 * Every returned than of the request as { customer, customerId, design,
 * yards, rate, thans }. `return_bundle` carries one item per than;
 * `return_thans` carries `thanRates` since RET-8 (one bale, one buyer). A
 * `return_thans` row raised before RET-8 carries only the set's average:
 * above zero it is read as rated (the executor re-prices from the live rows
 * anyway), zero means every than of it has no rate.
 */
function thansOf(aj) {
  const a = aj || {};
  if (a.action === 'return_bundle') {
    return (Array.isArray(a.items) ? a.items : []).map((it) => ({
      customer: String(it.customer || it.soldTo || ''),
      customerId: String(it.customerId || ''),
      design: String(it.design || ''),
      yards: Number(it.yards) || 0,
      rate: Number(it.pricePerYard) || 0,
      thans: 1,
    }));
  }
  if (a.action === 'return_thans') {
    const base = { customer: String(a.customer || ''), customerId: String(a.customerId || ''), design: String(a.design || '') };
    if (Array.isArray(a.thanRates) && a.thanRates.length) {
      return a.thanRates.map((t) => ({ ...base, yards: Number(t.yards) || 0, rate: Number(t.rate) || 0, thans: 1 }));
    }
    const count = Array.isArray(a.thanNos) ? a.thanNos.length : 0;
    if (!count) return [];
    return [{ ...base, yards: Number(a.yards) || 0, rate: Number(a.pricePerYard) || 0, thans: count }];
  }
  return [];
}

/** The gaps of a request, in the cards' order (buyer A–Z, then design). */
function gapsOf(aj) {
  if (!isReturn(aj)) return [];
  const map = new Map();
  for (const t of thansOf(aj)) {
    if (t.rate > 0) continue;
    const key = gapKey(buyerKey(t), t.design);
    if (!map.has(key)) {
      map.set(key, { key, customer: t.customer, customerId: t.customerId, design: t.design, thans: 0, yards: 0 });
    }
    const g = map.get(key);
    g.thans += t.thans;
    g.yards += t.yards;
  }
  return [...map.values()].sort((a, b) => String(a.customer).localeCompare(String(b.customer))
    || String(a.design).localeCompare(String(b.design), 'en', { numeric: true }));
}

/** The fills saved on the request (frozen), or []. */
function fillsOf(aj) {
  return Array.isArray(aj && aj.rateFill) ? aj.rateFill.filter((f) => f && f.key) : [];
}

/** The fill saved for one gap key, or null. */
function fillFor(aj, key) {
  return fillsOf(aj).find((f) => f.key === key) || null;
}

/** A usable fill rate (above zero, not "no credit"), or 0. */
function fillRate(fill) {
  if (!fill || fill.noCredit) return 0;
  const n = Number(fill.rate);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The fill entries to save for a set of answers, one per gap in order.
 * @param {Array<object>} gaps gapsOf(aj)
 * @param {Array<{rate?:number, noCredit?:boolean}>} answers one per gap
 * @returns {Array<object>|null} null when an answer is missing or unusable
 */
function buildFills(gaps, answers) {
  if (!Array.isArray(gaps) || !gaps.length || !Array.isArray(answers) || answers.length !== gaps.length) return null;
  const out = [];
  for (let i = 0; i < gaps.length; i += 1) {
    const g = gaps[i];
    const a = answers[i] || {};
    const base = { key: g.key, customer: g.customer, customerId: g.customerId, design: g.design, thans: g.thans, yards: g.yards };
    if (a.noCredit) out.push({ ...base, noCredit: true });
    else if (Number(a.rate) > 0) out.push({ ...base, rate: Number(a.rate) });
    else return null;
  }
  return out;
}

/**
 * The short canonical print of a set of fills — what a signature is given
 * for. Order-free (sorted by gap key); a rate is kept to 4 decimals.
 */
function printOf(fills) {
  return (Array.isArray(fills) ? fills : [])
    .map((f) => `${f.key}=${f.noCredit ? 'none' : String(Math.round(Number(f.rate) * 10000) / 10000)}`)
    .sort()
    .join(';');
}

/** A 10-character fingerprint of a print, small enough for a button. */
function hashOf(print) {
  return crypto.createHash('sha1').update(String(print || '')).digest('hex').slice(0, 10);
}

/** Do the saved fills answer exactly the request's gaps? */
function fillsMatchGaps(aj, fills) {
  const gaps = gapsOf(aj).map((g) => g.key).sort();
  const keys = (fills || []).map((f) => f.key).sort();
  return gaps.length > 0 && gaps.length === keys.length && gaps.every((k, i) => k === keys[i]);
}

/**
 * RET-8 §3 — every signature on a return with fills must carry the print
 * the row now has. '' when they agree (or the row has no fills), else why
 * not. Fail-closed: a signature with no print on a row with fills is a
 * disagreement (it may have been given on a card that showed no credit).
 */
function signedPrintProblem(aj) {
  const fills = fillsOf(aj);
  if (!fills.length) return '';
  const print = printOf(fills);
  const trail = require('./approvalProgress').trailOf(aj);
  for (const s of trail) {
    const who = (s && (s.name || s.id)) || 'an admin';
    if (!s || !s.ratePrint) return `the approval of ${who} names no rate`;
    if (s.ratePrint !== print) return `${who} approved a different rate`;
  }
  return '';
}

/**
 * The credit each buyer gets from this return with the fills applied:
 * [{ key, customer, customerId, rated, filled, total, gaps:[{gap, fill}] }]
 * `rated` = thans with their own rate, `filled` = gap thans at their fill.
 * @param {object} aj the request
 * @param {Array<object>} [fills] fills to apply (default: the saved ones)
 */
function creditByBuyer(aj, fills) {
  const use = Array.isArray(fills) ? fills : fillsOf(aj);
  const byKey = new Map(use.map((f) => [f.key, f]));
  const buyers = new Map();
  const touch = (t) => {
    const k = buyerKey(t);
    if (!buyers.has(k)) buyers.set(k, { key: k, customer: t.customer, customerId: t.customerId, rated: 0, filled: 0, total: 0, gaps: [] });
    return buyers.get(k);
  };
  for (const t of thansOf(aj)) {
    const b = touch(t);
    if (t.rate > 0) b.rated += t.yards * t.rate;
  }
  for (const g of gapsOf(aj)) {
    const b = touch(g);
    const f = byKey.get(g.key) || null;
    b.filled += g.yards * fillRate(f);
    b.gaps.push({ gap: g, fill: f });
  }
  const out = [...buyers.values()];
  for (const b of out) {
    b.rated = Math.round(b.rated);
    b.filled = Math.round(b.filled);
    b.total = b.rated + b.filled;
  }
  return out.sort((a, b) => String(a.customer).localeCompare(String(b.customer)));
}

/**
 * The executor's half: the rows it flipped, with a than that has no rate of
 * its own priced at the fill for its buyer and design. A recorded rate is
 * never replaced. Returns the priced rows and the fills that were used.
 * @param {object} aj the request
 * @param {Array<object>} rows flipped Inventory rows (pricePerYard, design, yards)
 * @param {{customer?:string, customerId?:string, design?:string}} buyer the request's buyer
 *   (and design, as the request recorded it) for these rows
 */
function priceRows(aj, rows, buyer) {
  const used = new Map();
  const bk = buyerKey(buyer || {});
  const priced = (rows || []).map((r) => {
    if (Number(r && r.pricePerYard) > 0) return r;
    const f = fillFor(aj, gapKey(bk, (buyer && buyer.design) || (r && r.design)));
    const rate = fillRate(f);
    if (f) used.set(f.key, f);
    return rate > 0 ? { ...r, pricePerYard: rate } : r;
  });
  return { rows: priced, used: [...used.values()] };
}

/** What the next tap on a pending return does about its rate. */
function stepState(aj) {
  const gaps = gapsOf(aj);
  if (!gaps.length) return 'none';
  if (fillsOf(aj).length) return 'filled';
  const signed = Array.isArray(aj && aj.approvals) ? aj.approvals.length : 0;
  return signed ? 'legacy' : 'ask';
}

module.exports = {
  RETURN_ACTIONS,
  isReturn,
  thansOf,
  gapsOf,
  fillsOf,
  fillFor,
  fillRate,
  buildFills,
  printOf,
  hashOf,
  fillsMatchGaps,
  signedPrintProblem,
  creditByBuyer,
  priceRows,
  stepState,
  buyerKey,
  gapKey,
};
