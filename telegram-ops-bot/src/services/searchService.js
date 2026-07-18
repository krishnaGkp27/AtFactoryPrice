'use strict';

/**
 * SRCH-1 — as-you-type inventory search via Telegram INLINE MODE
 * (specs/SRCH-1_INLINE_INVENTORY_SEARCH.md, owner-locked 17-Jul-2026).
 *
 * Staff type `@<bot> 58…` in any chat with the bot; Telegram fires an
 * inline_query PER KEYSTROKE and we answer with live-filtered suggestions
 * over four entity kinds: bales (package numbers), designs, containers
 * (arrival batches), and DCAT-1 categories. Tapping a suggestion posts a
 * compact read-only stock card. Sold bales are included (finding where a
 * bale went is half the use) with status + buyer. NO money values —
 * quantities only (CV-1 keeps values admin-gated elsewhere).
 *
 * SECURITY: inline queries arrive from ANY Telegram user who mentions the
 * bot. Hard gate on the staff allow-list; strangers get an empty panel.
 * Results are personal and uncached. Zero extra Sheets reads: everything
 * derives from the 5s inventory snapshot.
 */

const inventoryRepository = require('../repositories/inventoryRepository');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const MAX_RESULTS = 20;

function norm(v) { return String(v ?? '').trim(); }
function low(v) { return norm(v).toLowerCase(); }

/** Build the four searchable entity indexes from one inventory snapshot. */
function buildIndex(rows) {
  const bales = new Map();      // warehouse|packageNo → bale
  const designs = new Map();    // DESIGN → agg
  const containers = new Map(); // BATCH → agg
  const categories = new Map(); // category(lower) → agg

  for (const r of rows) {
    const pkg = norm(r.packageNo);
    const design = norm(r.design);
    if (!pkg && !design) continue;
    const wh = norm(r.warehouse);
    const available = r.status === 'available';
    const sold = r.status === 'sold';

    if (pkg) {
      const bk = `${wh}|${pkg}`;
      if (!bales.has(bk)) {
        bales.set(bk, { packageNo: pkg, design, shade: norm(r.shade), warehouse: wh, thansAvail: 0, thansSold: 0, yardsAvail: 0, soldTo: '', soldDate: '' });
      }
      const b = bales.get(bk);
      if (available) { b.thansAvail += 1; b.yardsAvail += Number(r.yards) || 0; }
      if (sold) {
        b.thansSold += 1;
        if (norm(r.soldTo)) { b.soldTo = norm(r.soldTo); b.soldDate = norm(r.soldDate).slice(0, 10); }
      }
    }
    if (design) {
      const dk = design.toUpperCase();
      if (!designs.has(dk)) designs.set(dk, { design, balesAvail: new Set(), yardsAvail: 0, warehouses: new Set(), category: '' });
      const d = designs.get(dk);
      if (available) {
        d.balesAvail.add(`${wh}|${pkg}`);
        d.yardsAvail += Number(r.yards) || 0;
        if (wh) d.warehouses.add(wh);
      }
      if (!d.category && norm(r.designCategory)) d.category = norm(r.designCategory);
    }
    const batch = norm(r.arrivalBatch);
    if (batch) {
      if (!containers.has(batch)) containers.set(batch, { batch, bales: new Set(), designs: new Set() });
      const c = containers.get(batch);
      if (available) { c.bales.add(`${wh}|${pkg}`); c.designs.add(design.toUpperCase()); }
    }
  }
  for (const d of designs.values()) {
    if (!d.category) continue;
    const ck = d.category.toLowerCase();
    if (!categories.has(ck)) categories.set(ck, { category: d.category, designs: new Set(), bales: 0 });
    const c = categories.get(ck);
    c.designs.add(d.design.toUpperCase());
    c.bales += d.balesAvail.size;
  }
  return { bales: [...bales.values()], designs: [...designs.values()], containers: [...containers.values()], categories: [...categories.values()] };
}

/** exact=3, prefix=2, substring=1, none=0 */
function matchRank(value, q) {
  const v = low(value);
  if (!v || !q) return 0;
  if (v === q) return 3;
  if (v.startsWith(q)) return 2;
  if (v.includes(q)) return 1;
  return 0;
}

function baleResult(b, i) {
  const status = b.thansAvail > 0
    ? `available (${b.thansAvail} thans, ${Math.round(b.yardsAvail)} yds)`
    : (b.thansSold > 0 ? `SOLD${b.soldTo ? ` to ${b.soldTo}` : ''}${b.soldDate ? ` on ${b.soldDate}` : ''}` : 'no stock');
  return {
    type: 'article', id: `b${i}`,
    title: `📦 Bale ${b.packageNo} — ${b.design}${b.shade ? ` · shade ${b.shade}` : ''}`,
    description: `${b.warehouse || 'unknown warehouse'} · ${status}`,
    input_message_content: {
      message_text: `📦 *Bale ${b.packageNo}*\n🧵 Design ${b.design}${b.shade ? ` · shade ${b.shade}` : ''}\n🏭 ${b.warehouse || '—'}\n${b.thansAvail > 0 ? `✅ Available: ${b.thansAvail} thans · ${Math.round(b.yardsAvail)} yds` : (b.thansSold > 0 ? `🔴 Sold${b.soldTo ? ` to *${b.soldTo}*` : ''}${b.soldDate ? ` on ${b.soldDate}` : ''}` : '⚪ No stock recorded')}`,
      parse_mode: 'Markdown',
    },
  };
}

function designResult(d, i) {
  const whs = [...d.warehouses];
  return {
    type: 'article', id: `d${i}`,
    title: `🧵 Design ${d.design} — ${d.balesAvail.size} bales available`,
    description: `${Math.round(d.yardsAvail)} yds across ${whs.length || 0} warehouse(s)${d.category ? ` · ${d.category}` : ''}`,
    input_message_content: {
      message_text: `🧵 *Design ${d.design}*${d.category ? ` _(${d.category})_` : ''}\n✅ ${d.balesAvail.size} bales · ${Math.round(d.yardsAvail)} yds available\n🏭 ${whs.join(', ') || '—'}`,
      parse_mode: 'Markdown',
    },
  };
}

function containerResult(c, i) {
  return {
    type: 'article', id: `c${i}`,
    title: `🚢 Container ${c.batch}`,
    description: `${c.bales.size} bales available · ${c.designs.size} designs`,
    input_message_content: {
      message_text: `🚢 *Container ${c.batch}*\n✅ ${c.bales.size} bales available across ${c.designs.size} design(s)`,
      parse_mode: 'Markdown',
    },
  };
}

function categoryResult(c, i) {
  return {
    type: 'article', id: `g${i}`,
    title: `🧣 ${c.category}`,
    description: `${c.designs.size} designs · ${c.bales} bales available`,
    input_message_content: {
      message_text: `🧣 *${c.category}*\n${c.designs.size} design(s) · ${c.bales} bales available`,
      parse_mode: 'Markdown',
    },
  };
}

/** Pure search over the index — exported for tests. */
function search(index, rawQuery) {
  const q = low(rawQuery);
  if (!q) return [];
  const numericish = /^[\dp\-\/]+$/i.test(q);

  const scored = [];
  index.bales.forEach((b, i) => {
    const rank = matchRank(b.packageNo, q);
    if (rank) scored.push({ rank, kindPri: numericish ? 4 : 2, result: baleResult(b, i) });
  });
  index.designs.forEach((d, i) => {
    const rank = matchRank(d.design, q);
    if (rank) scored.push({ rank, kindPri: numericish ? 3 : 3, result: designResult(d, i) });
  });
  index.containers.forEach((c, i) => {
    const rank = matchRank(c.batch, q);
    if (rank) scored.push({ rank, kindPri: 2, result: containerResult(c, i) });
  });
  index.categories.forEach((c, i) => {
    const rank = matchRank(c.category, q);
    if (rank) scored.push({ rank, kindPri: numericish ? 1 : 4, result: categoryResult(c, i) });
  });

  return scored
    .sort((a, b) => b.rank - a.rank || b.kindPri - a.kindPri)
    .slice(0, MAX_RESULTS)
    .map((s) => s.result);
}

/** Entry from the webhook. Never throws. */
async function handleInlineQuery(bot, inlineQuery) {
  try {
    const userId = String((inlineQuery.from || {}).id || '');
    const opts = { cache_time: 0, is_personal: true };
    if (!auth.isAllowed(userId)) {
      await bot.answerInlineQuery(inlineQuery.id, [], opts);
      return;
    }
    const rows = await inventoryRepository.getAll();
    const results = search(buildIndex(rows), inlineQuery.query || '');
    await bot.answerInlineQuery(inlineQuery.id, results, opts);
  } catch (e) {
    logger.warn(`inline search failed: ${e.message}`);
    try { await bot.answerInlineQuery(inlineQuery.id, [], { cache_time: 0, is_personal: true }); } catch (_) { /* best effort */ }
  }
}

module.exports = { handleInlineQuery, search, buildIndex, MAX_RESULTS };
