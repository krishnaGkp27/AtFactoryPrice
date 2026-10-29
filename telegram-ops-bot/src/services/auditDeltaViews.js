'use strict';

/**
 * auditDeltaViews — AUD-D1 (owner, 28/29-Oct-2026; layout locked).
 *
 * "I can see the details of the audit count and the book, but I cannot
 * understand how much it has increased or decreased." … "Than is a lower
 * unit, which will give us a guarantee in a reconciliation. In bales, it may
 * cause confusion unless the store has supplied only in bales."
 *
 * The admins' audit delta card (AUD-F1) in three views on ONE chip, cycling
 * thans → bales → both → thans:
 *
 *   thans  every design in thans; a sealed bale = its OWN than count on the
 *          book (never a flat figure, never a fraction of a bale)
 *   bales  each design in the form its record has: sealed on both sides →
 *          bales only; mixed → `8B + 29t → 7B + 30t`; all open → thans
 *   both   the bales view with the than total beside each side
 *
 * The than is the unit of truth: a bale figure stands alone only when both
 * sides are sealed bales. An opened bale is EXPLAINED (`3 bales opened
 * (6+5+5 = 16t) · 15t found`); when the opened bales' sizes differ and it
 * cannot be known which were opened, the net is a RANGE, never a guess.
 *
 * Data: the batch is remembered in memory for the chip; after a restart it
 * is rebuilt from the audit's StockTakes rows, the sealed bales' sizes as of
 * the audit riding the mismatch row's free-text `note` (`attempt 1 · sizes
 * 6+5+5`). A row without sizes shows the raw deltas (no than net).
 * Vocabulary per BUSINESS_RULES §6b: `t`, never "bundles".
 */

const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const fmtDate = require('../utils/formatDate');
const { formatCounts } = require('./unitDisplayService');

const VIEWS = ['t', 'b', 'x'];
const NEXT = { t: 'b', b: 'x', x: 't' };
const CHIP = { t: '🔁 Show in bales', b: '🔁 Show both', x: '🔁 Show in thans' };
const SUB = {
  t: 'Counted vs book · in thans (a sealed bale = its than count on the book)',
  b: 'Counted vs book · sealed bales + loose thans, as counted',
  x: 'Counted vs book · as counted, with than totals',
};
const KEEP_MS = 48 * 60 * 60 * 1000;
const _batches = new Map(); // key → batch

/* ── sizes on the StockTakes note cell ─────────────────────────────── */

/** `attempt 1` → `attempt 1 · sizes 6+5+5` (nothing added when there are no sealed bales). */
function noteWithSizes(note, sizes) {
  const s = (sizes || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  return s.length ? `${note} · sizes ${s.join('+')}` : note;
}
/** The sizes written by noteWithSizes, or null when the row carries none. */
function sizesFromNote(note) {
  const m = String(note || '').match(/sizes ((?:\d+)(?:\+\d+)*)/);
  return m ? m[1].split('+').map(Number) : null;
}

/* ── arithmetic ─────────────────────────────────────────────────────── */

const sum = (a) => a.reduce((x, y) => x + y, 0);
const pick = (sizes, k, largest) => {
  const s = sizes.slice().sort((a, b) => (largest ? b - a : a - b));
  return sum(s.slice(0, Math.max(0, Math.min(k, s.length))));
};

/**
 * One design's reconciliation, in every figure the views need. Pure.
 * @param {{bookB:number, bookT:number, cntB:number, cntT:number, sizes?:number[]|null}} d
 */
function analyse(d) {
  const bookB = Number(d.bookB) || 0; const bookT = Number(d.bookT) || 0;
  const cntB = Number(d.cntB) || 0; const cntT = Number(d.cntT) || 0;
  const sizes = Array.isArray(d.sizes) && d.sizes.length ? d.sizes.map(Number).filter((n) => n > 0) : null;
  const sealedOnly = bookT === 0 && cntT === 0;
  const looseOnly = bookB === 0 && cntB === 0;
  const opened = Math.max(0, bookB - cntB);     // sealed bales no longer sealed
  const extra = Math.max(0, cntB - bookB);      // sealed bales the book does not have
  const out = {
    bookB, bookT, cntB, cntT, sizes, sealedOnly, looseOnly, mixed: !sealedOnly && !looseOnly,
    opened, extra, balesNet: cntB - bookB, looseFound: cntT - bookT,
    known: !!sizes && sizes.length >= bookB,
    bookTotal: null, cntTotal: null, net: null,   // {min,max} in thans, when known
    openedSizes: null,                             // {min,max}
  };
  if (out.known) {
    const total = sum(sizes);
    const minO = pick(sizes, opened, false);
    const maxO = pick(sizes, opened, true);
    out.openedSizes = { min: minO, max: maxO };
    out.bookTotal = { min: total + bookT, max: total + bookT };
    // extra sealed bales have no size on the book — they stay in bales.
    out.cntTotal = { min: total - maxO + cntT, max: total - minO + cntT };
    out.net = { min: cntT - bookT - maxO, max: cntT - bookT - minO };
  } else if (opened === 0 && extra === 0) {
    out.net = { min: cntT - bookT, max: cntT - bookT };
  }
  return out;
}

function rangeLabel(r, unit) {
  if (!r) return '';
  const lo = Math.min(r.min, r.max); const hi = Math.max(r.min, r.max);
  if (lo === hi) {
    if (lo === 0) return `= 0${unit}`;
    return `${lo < 0 ? '📉' : '📈'} ${Math.abs(lo)}${unit} ${lo < 0 ? 'short' : 'over'}`;
  }
  if (hi <= 0) return `📉 ${Math.abs(hi)}–${Math.abs(lo)}${unit} short`;
  if (lo >= 0) return `📈 ${lo}–${hi}${unit} over`;
  return `${lo}…+${hi}${unit}`;
}
const totalLabel = (r) => (r ? (r.min === r.max ? `${r.min}t` : `${Math.min(r.min, r.max)}–${Math.max(r.min, r.max)}t`) : '?t');
const balesLabel = (n) => (n === 0 ? '= 0B' : `${n < 0 ? '📉' : '📈'} ${Math.abs(n)}B ${n < 0 ? 'short' : 'over'}`);

/** The header figure for one design in one view. */
function netLabel(a, view) {
  if (a.sealedOnly) {
    if (view === 't' && a.known && a.extra === 0) return rangeLabel(a.net, 't');
    const b = balesLabel(a.balesNet);
    if (view === 'x' && a.known && a.extra === 0 && a.net) {
      const lo = Math.abs(Math.min(a.net.min, a.net.max));
      const hi = Math.abs(Math.max(a.net.min, a.net.max));
      return `${b} (${lo === hi ? `${lo}t` : `${Math.min(lo, hi)}–${Math.max(lo, hi)}t`})`;
    }
    return b;
  }
  if (a.net) {
    const t = rangeLabel(a.net, 't');
    return a.extra ? `${t} · +${a.extra}B not on the book` : t;
  }
  // sizes unknown and bales changed: the raw deltas, honestly labelled
  const parts = [];
  if (a.balesNet) parts.push(`${a.balesNet > 0 ? '↑' : '↓'}${Math.abs(a.balesNet)}B`);
  if (a.looseFound) parts.push(`${a.looseFound > 0 ? '↑' : '↓'}${Math.abs(a.looseFound)}t`);
  return `${parts.join(', ') || '= 0'} · bale sizes not on record`;
}

/** The `book … → counted …` line for one design in one view. */
function figuresLine(a, view) {
  // A mixed design prints BOTH parts on both sides, zero included
  // (`0B + 19t`): that is how an opened bale shows itself.
  const natural = (b, t) => (a.mixed ? `${b}B + ${t}t` : formatCounts({ bales: b, thans: t, empty: '0t' }));
  const bk = natural(a.bookB, a.bookT);
  const ct = natural(a.cntB, a.cntT);
  if (view === 't') {
    if (a.known) {
      const extra = a.extra ? ` + ${a.extra}B` : '';
      return `book ${totalLabel(a.bookTotal)} → counted ${totalLabel(a.cntTotal)}${extra}`;
    }
    return `book ${bk} → counted ${ct}`;
  }
  if (view === 'x' && a.known) {
    const extra = a.extra ? ` + ${a.extra}B` : '';
    return `book ${bk} (${totalLabel(a.bookTotal)}) → counted ${ct} (${totalLabel(a.cntTotal)}${extra})`;
  }
  return `book ${bk} → counted ${ct}`;
}

/** `3 bales opened (6+5+5 = 16t) · 15t found`, or '' when no bale was opened. */
function openedLine(a) {
  if (!a.opened) return '';
  // No loose than on either side: the bale did not come back as pieces —
  // it is missing, not opened.
  const verb = a.sealedOnly ? 'missing' : 'opened';
  const n = `${a.opened} bale${a.opened === 1 ? '' : 's'} ${verb}`;
  const found = a.sealedOnly ? '' : ` · ${a.looseFound}t found`;
  if (!a.known) return `${n}${found}`;
  const s = a.sizes.slice().sort((x, y) => y - x);
  if (a.openedSizes.min === a.openedSizes.max) {
    if (a.opened === 1) return `${n} (${a.openedSizes.max}t)${found}`;
    const shown = a.opened === a.sizes.length ? s : s.slice(0, a.opened);
    return `${n} (${shown.join('+')} = ${a.openedSizes.max}t)${found}`;
  }
  return `${n} (of ${s.join(', ')} on the book)${found}`;
}

/* ── the card ───────────────────────────────────────────────────────── */

function tagOf(status) { return status === 'flagged' ? ' 🚩 flagged' : ' · recount asked'; }

/**
 * Build the card for one view.
 * @param {'t'|'b'|'x'} view
 * @param {{warehouse:string, auditorLabel:string, day:string, deltas:Array, matched:number, unknown:number, locked:number}} batch
 */
function buildCard(view, batch) {
  const v = VIEWS.includes(view) ? view : 't';
  let text = `📊 Audit delta — ${batch.warehouse} · counted by ${batch.auditorLabel}${batch.day ? ` · ${fmtDate(batch.day)}` : ''}\n${SUB[v]}\n`;
  const deltas = batch.deltas || [];
  const tally = { short: 0, over: 0, bShort: 0, bOver: 0, rangeLo: 0, rangeHi: 0, unknown: 0 };
  if (!deltas.length) text += '\nNo increases, no decreases.\n';
  for (const d of deltas) {
    const a = analyse(d);
    const tag = tagOf(d.status);
    text += `\n${d.design} · ${netLabel(a, v)}\n`;
    const lines = [figuresLine(a, v)];
    const op = v === 't' || !a.sealedOnly ? openedLine(a) : '';
    if (op) lines.push(op);
    lines[lines.length - 1] += tag;
    text += lines.map((l) => `   ${l}`).join('\n') + '\n';
    // the store line
    if (a.sealedOnly && !(v === 't' && a.known && a.extra === 0)) {
      if (a.balesNet < 0) tally.bShort += -a.balesNet; else if (a.balesNet > 0) tally.bOver += a.balesNet;
    } else if (a.net) {
      const lo = Math.min(a.net.min, a.net.max); const hi = Math.max(a.net.min, a.net.max);
      if (lo === hi) { if (lo < 0) tally.short += -lo; else if (lo > 0) tally.over += lo; }
      else { tally.rangeLo += lo; tally.rangeHi += hi; }
      if (a.extra) tally.bOver += a.extra;
    } else tally.unknown += 1;
  }
  if (deltas.length) {
    const parts = [];
    if (tally.short) parts.push(`📉 ${tally.short}t short`);
    if (tally.over) parts.push(`📈 ${tally.over}t over`);
    const net = tally.over - tally.short;
    if (tally.short && tally.over) parts.push(`net ${net < 0 ? '📉' : '📈'} ${Math.abs(net)}t`);
    if (tally.rangeLo || tally.rangeHi) parts.push(`±${rangeLabel({ min: tally.rangeLo, max: tally.rangeHi }, 't').replace(/^(?:📉|📈) /u, '')} uncertain`);
    if (tally.bShort) parts.push(`📉 ${tally.bShort}B short`);
    if (tally.bOver) parts.push(`📈 ${tally.bOver}B over`);
    if (tally.unknown) parts.push(`${tally.unknown} without bale sizes`);
    if (parts.length) text += `\nStore: ${parts.join(' · ')}\n`;
  }
  text += `\n✅ ${batch.matched || 0} matched the book exactly`;
  if (batch.unknown) text += ` · 🆕 ${batch.unknown} new design${batch.unknown === 1 ? '' : 's'}`;
  if (batch.locked) text += ` · 🔒 ${batch.locked} locked`;
  return text;
}

/** The one chip, naming the view it switches to. */
function keyboard(view, key) {
  const v = VIEWS.includes(view) ? view : 't';
  return { inline_keyboard: [[{ text: CHIP[v], callback_data: `wai:dv:${NEXT[v]}:${key}` }]] };
}

/* ── the batch: remembered, and rebuilt from the sheet after a restart ── */

function lagosDay(now = new Date(), tz = 'Africa/Lagos') {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(now); } catch (_) { return now.toISOString().slice(0, 10); }
}
/** `20261028:7863545956:Kano office` — fits the 64-byte callback with the view prefix. */
function keyFor({ day, auditorId, warehouse }) {
  return `${String(day).replace(/-/g, '').slice(0, 8)}:${String(auditorId)}:${String(warehouse).slice(0, 28)}`;
}
function parseKey(key) {
  const m = String(key || '').match(/^(\d{8}):(\d+):(.+)$/);
  if (!m) return null;
  return { day: `${m[1].slice(0, 4)}-${m[1].slice(4, 6)}-${m[1].slice(6, 8)}`, auditorId: m[2], warehouse: m[3] };
}

function remember(batch) {
  const key = keyFor(batch);
  _batches.set(key, { ...batch, key, at: Date.now() });
  for (const [k, b] of _batches) if (Date.now() - b.at > KEEP_MS) _batches.delete(k);
  return key;
}
function recall(key) { return _batches.get(key) || null; }

/**
 * After a restart: the audit's StockTakes rows (that store, that day, that
 * auditor), latest row per design. Mismatch / flagged rows become deltas
 * (sizes from the note), reconciled rows count as matched, new_design rows
 * as unknown. Never throws; null when nothing is on record.
 */
async function rebuild(key, bot) {
  const k = parseKey(key);
  if (!k) return null;
  try {
    const repo = require('../repositories/stockTakesRepository');
    const rows = (await repo.rowsForDay(k.warehouse, k.day)).filter((r) => String(r.auditor) === k.auditorId);
    if (!rows.length) return null;
    const latest = new Map();
    for (const r of rows) {
      const id = String(r.design).toUpperCase();
      const prev = latest.get(id);
      if (!prev || String(r.audited_at) > String(prev.audited_at)) latest.set(id, r);
    }
    const deltas = []; let matched = 0; let unknown = 0;
    for (const r of latest.values()) {
      if (r.result === 'mismatch' || r.result === 'flagged') {
        deltas.push({
          design: r.design, status: r.result === 'flagged' ? 'flagged' : 'recount',
          bookB: r.sheet_bales, bookT: r.sheet_bundles, cntB: r.counted_bales || 0, cntT: r.counted_bundles || 0,
          sizes: sizesFromNote(r.note),
        });
      } else if (r.result === 'reconciled') matched += 1;
      else if (r.result === 'new_design') unknown += 1;
    }
    let auditorLabel = k.auditorId;
    try { auditorLabel = await require('./approvalCards').resolveUserLabel(k.auditorId, bot); } catch (_) { /* id */ }
    const warehouse = rows[0].warehouse || k.warehouse;
    const batch = { warehouse, auditorId: k.auditorId, auditorLabel, day: k.day, deltas, matched, unknown, locked: 0 };
    remember(batch);
    return { ...batch, key };
  } catch (e) {
    logger.warn(`auditDeltaViews.rebuild failed: ${e.message}`);
    return null;
  }
}

/**
 * The chip tap: `wai:dv:<view>:<key>`. Admins only; session-free; redraws
 * the card in place. Never throws.
 */
async function handleViewTap(bot, query) {
  const data = String((query && query.data) || '');
  const toast = (text, alert) => bot.answerCallbackQuery(query.id, { text, show_alert: !!alert }).catch(() => {});
  try {
    const m = data.match(/^wai:dv:([tbx]):(.+)$/);
    if (!m) { await toast('Unknown tap'); return true; }
    const userId = String(query.from && query.from.id);
    if (!auth.isAdmin(userId)) { await toast('Admins only.', true); return true; }
    const [, view, key] = m;
    const batch = recall(key) || await rebuild(key, bot);
    if (!batch) { await toast('That audit is no longer on record.', true); return true; }
    const msg = query.message || {};
    try {
      await bot.editMessageText(buildCard(view, batch), {
        chat_id: msg.chat && msg.chat.id, message_id: msg.message_id, reply_markup: keyboard(view, key),
      });
    } catch (e) {
      if (!/not modified/i.test(String(e.message))) logger.warn(`auditDeltaViews: redraw failed: ${e.message}`);
    }
    await toast('');
    return true;
  } catch (e) {
    logger.warn(`auditDeltaViews.handleViewTap failed: ${e.message}`);
    await toast('Could not switch the view right now.');
    return true;
  }
}

/** Test hook. */
function _resetForTests() { _batches.clear(); }

module.exports = {
  buildCard, keyboard, analyse, noteWithSizes, sizesFromNote, keyFor, parseKey, lagosDay,
  remember, recall, rebuild, handleViewTap, VIEWS, NEXT, CHIP, _resetForTests,
};
