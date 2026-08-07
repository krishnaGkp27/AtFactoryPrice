'use strict';

/**
 * src/flows/bundleSaleFlow.js — BUNDLE-SALE C1.
 *
 * Kano-style poly-colour bundle / than sale picker.
 *
 *   • Lagos bales: one bale = one shade. Existing sale_bundle flow in
 *     telegramController.js works fine there.
 *   • Kano bales:  one bale carries 6 shades × 25 yd each. Customers
 *     buy a few than from one bale, then a few from the next, mixing
 *     colours within a "design". The Lagos flow can't model this
 *     ergonomically — hence this dedicated flow.
 *
 * Design (per locked plan, "design-first, colour-aggregate, bale-by-
 * bale bundle picker"):
 *
 *   1. pick_warehouse  — single chip if user has 1 home warehouse
 *   2. pick_design     — designs that have ≥1 available than
 *   3. pick_shade      — colour aggregate card: per-shade yards +
 *                         bundle count + chips, plus smart-pack escape
 *                         hatch ("Pack target yardage")
 *   4. pick_bales      — per-bale picker for the chosen shade
 *                         • shows age bucket (fresh/ageing/stale)
 *                         • "Take ALL of this bale" shortcut
 *                         • cart bar at the bottom (sticky counter)
 *   5. cart_review     — collapsible cart: summary lines by default,
 *                         expand → per-bale breakdown; per-line remove
 *   6. confirm         — conflict re-check + Submit
 *   7. submitted       — sealed; admin notified
 *
 * DSP-1 (owner 26-Jul): steps 6-8 (customer / rate / payment) were removed
 * — the admin sets all three at approval. The dispatcher supplies only what
 * physically ships.
 *
 * Reuses the existing `sale_bundle` action so inventoryService applies
 * the cart (sold-mark + ledger DR + transactions row) exactly the same
 * way today's flow does. No changes to approvalEvents or inventoryService.
 *
 * Callback namespace `bs:*`:
 *   bs:cancel
 *   bs:back
 *   bs:wh:<warehouse>
 *   bs:design:<DESIGN>             (uppercased, callback-safe key)
 *   bs:shade:<shadeKey>
 *   bs:all_shades                  (take every remaining than of design)
 *   bs:bale:<baleUid|pkg:..>       (drill into bale-detail than picker)
 *   bs:wholebale:<baleUid|pkg:..>  (toggle whole bale from the bale list)
 *   bs:than:<key>                  (toggle one than)
 *   bs:take_all:<baleUid|pkg:..>   (every available than in bale)
 *   bs:smartpack                   (RETIRED by TRF-15 — answers a notice)
 *   bs:cart                        (jump straight to cart view)
 *   bs:expand:<shadeKey>           (collapse/expand a cart line)
 *   bs:rm_line:<key>
 *   bs:rm_bale:<baleUid>
 *   bs:proceed                     (advance from cart → confirm)
 *   bs:submit
 */

const sessionStore        = require('../utils/sessionStore');
const inventoryRepository = require('../repositories/inventoryRepository');
const customersRepository = require('../repositories/customersRepository');
const shadesRepository    = require('../repositories/shadesRepository');
const designAssetsRepository = require('../repositories/designAssetsRepository');
const transactionsRepository = require('../repositories/transactionsRepository');
const bundleSaleService   = require('../services/bundleSaleService');
const approvalEvents      = require('../events/approvalEvents');
const auth                = require('../middlewares/auth');
const logger              = require('../utils/logger');
const { rememberRequesterCard } = require('../utils/requesterCard');
const { rowsFor }         = require('../utils/flowKit');
const { isNotModified }   = require('../utils/telegramUI');
const {
  buildShadeNameMap, buildShadeLabel, layoutShadeRows, formatShadeRef,
} = require('../utils/shadeButtons');

// This flow sells in individual than(s), so the shade/bale buttons count
// thans rather than the "bale" unit the Supply picker uses.
const THAN_UNIT = { singular: 'than', plural: 'thans' };

/**
 * Stable cart key for one physical than — mirrors bundleSaleService.keyOf
 * so selection state can be reconciled against cart.byKey.
 * @param {{baleUid?:string, packageNo:string|number, thanNo:string|number}} t
 * @returns {string}
 */
function thanKey(t) {
  return `${t.baleUid || `pkg:${t.packageNo}`}|${t.thanNo}`;
}

/**
 * Resolve the bale identifier used as a callback-safe key + cart match.
 * @param {{baleUid?:string, packageNo:string|number}} bale
 * @returns {string}
 */
function baleKeyOf(bale) {
  // STK-E1 — the canonical identity rides the callback (bale.key from the
  // repo buckets / cart rollup); uid/pkg fallbacks keep stale cards alive.
  return bale.key || bale.baleUid || `pkg:${bale.packageNo}`;
}

/**
 * Load the design's catalog shade-name map (number → name), best-effort.
 * Returns an empty Map when the design has no catalog asset.
 * @param {string} design
 * @returns {Promise<Map<string,string>>}
 */
async function loadShadeNameMap(design) {
  try {
    const asset = await designAssetsRepository.findActive(design);
    return buildShadeNameMap(asset);
  } catch (_) {
    return new Map();
  }
}

/* ───────────────────────────────────────────────────────────────────── */
/*  Rendering helpers — single anchored card (UX-C1)                    */
/* ───────────────────────────────────────────────────────────────────── */

async function render(bot, chatId, userId, text, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const opts = { parse_mode: 'Markdown', reply_markup: { inline_keyboard: rows } };
  const mid = session.flowMessageId;
  if (mid) {
    try {
      await bot.editMessageText(text, { chat_id: chatId, message_id: mid, ...opts });
      return;
    } catch (e) {
      if (isNotModified(e)) return; // screen already correct — not a failure
      /* fall through */
    }
  }
  const sent = await bot.sendMessage(chatId, text, opts);
  session.flowMessageId = sent.message_id;
  sessionStore.set(userId, session);
}

const { cancelRow, backRow } = rowsFor('bs');
function cartRow(yards, thans) {
  if (!thans) return null;
  return [{
    text: `🛒 Cart · ${thans} than(s) · ${fmtQty(yards)} yd`,
    callback_data: 'bs:cart',
  }];
}
function fmtQty(n)   { return (Math.round((n || 0) * 100) / 100).toLocaleString('en-NG'); }
function fmtNgn(n)   { return `₦${Math.round(n || 0).toLocaleString('en-NG')}`; }
function escapeMd(s) { return String(s || '').replace(/[*_`\[\]()~>#+\-=|{}.!]/g, (m) => `\\${m}`); }

async function renderError(bot, chatId, userId, errText) {
  const session = sessionStore.get(userId);
  if (!session) { await bot.sendMessage(chatId, `⚠️ ${errText}`); return; }
  await render(bot, chatId, userId, `⚠️ ${errText}`, [backRow(), cancelRow()]);
}

/* ───────────────────────────────────────────────────────────────────── */
/*  Entry                                                                */
/* ───────────────────────────────────────────────────────────────────── */

async function start(bot, chatId, userId, messageId) {
  // Anyone with sell permission can launch — the existing risk gate
  // ensures the sale_bundle action still routes through approval.
  if (!auth.isAdmin(userId) && !auth.isEmployee(userId)) {
    await bot.sendMessage(chatId, '🧵 Bundle sale is available to employees and admins.');
    return;
  }
  sessionStore.set(userId, {
    type: 'bundle_sale_flow',
    // ARRIVAL-BATCH C1 — the flow now opens on a "Select Container" step.
    step: 'pick_container',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    arrivalBatch: '',
    warehouse: '',
    design: '',
    designKey: '',
    shadeKey: '',
    activeBaleUid: '',
    cart: bundleSaleService.emptyCart(),
    customer: '',
    rate: 0,
    paymentMode: '',
    expandedShade: '',
    smartPack: null,
  });
  await renderContainerPicker(bot, chatId, userId);
}

/**
 * ARRIVAL-BATCH C1 — true when a row belongs to the selected container.
 * An empty `arrivalBatch` selection (or none) matches everything; the
 * synthetic UNLABELLED_BATCH key matches rows whose arrival_batch is blank
 * (pre-backfill stock).
 * @param {{arrivalBatch?: string}} r
 * @param {string} arrivalBatch
 */
function rowInBatch(r, arrivalBatch) {
  if (!arrivalBatch) return true;
  const ab = String(arrivalBatch).toUpperCase();
  const rab = (r.arrivalBatch || '').toUpperCase();
  if (ab === String(inventoryRepository.UNLABELLED_BATCH).toUpperCase()) return rab === '';
  return rab === ab;
}

/** Distinct warehouses with available stock in the given arrival batch. */
async function listWarehousesInBatch(arrivalBatch) {
  const all = await inventoryRepository.getAll();
  const set = new Set();
  for (const r of all) {
    if (r.status !== 'available') continue;
    if (!rowInBatch(r, arrivalBatch)) continue;
    if (r.warehouse) set.add(r.warehouse);
  }
  return Array.from(set).sort();
}

/**
 * Step 0 — "Select Container" (arrival batch). Always shown (even for a
 * single container) so the dimension is explicit, mirroring the Supply
 * Request flow.
 */
async function renderContainerPicker(bot, chatId, userId) {
  const containers = await inventoryRepository.getArrivalBatches();
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!containers.length) {
    // Render BEFORE clearing — render() early-returns once the session is gone.
    await render(bot, chatId, userId,
      '🧵 *Bundle Sale*\n\n_No containers with available stock._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId);
    return;
  }
  const rows = [];
  for (let i = 0; i < containers.length; i += 2) {
    const a = containers[i];
    const row = [{ text: `🚢 ${a.label} · ${a.thans} than`, callback_data: `bs:ct:${a.batch}` }];
    const b = containers[i + 1];
    if (b) row.push({ text: `🚢 ${b.label} · ${b.thans} than`, callback_data: `bs:ct:${b.batch}` });
    rows.push(row);
  }
  rows.push(cancelRow());
  rows.push([{ text: '🏠 Back to menu', callback_data: 'act:__back__' }]);
  await render(bot, chatId, userId,
    '🧵 *Bundle Sale — pick container*\n\n🚢 Select container (arrival batch):',
    rows,
  );
}

async function renderWarehousePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  // Scope warehouses to the chosen container (ARRIVAL-BATCH C1).
  const warehouses = await listWarehousesInBatch(session.arrivalBatch);
  if (!warehouses.length) {
    await render(bot, chatId, userId,
      '🧵 *Bundle Sale*\n\n_No warehouses with available stock in this container._',
      [[{ text: '⬅ Back to containers', callback_data: 'bs:back' }], [{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }
  if (warehouses.length === 1) {
    // Only one warehouse in this container — skip the warehouse step.
    session.warehouse = warehouses[0];
    session._multiWarehouse = false;
    session.step = 'pick_design';
    sessionStore.set(userId, session);
    await renderDesignPicker(bot, chatId, userId);
    return;
  }
  session._multiWarehouse = true;
  sessionStore.set(userId, session);
  const rows = warehouses.map((w) => ([{ text: `🏬 ${w}`, callback_data: `bs:wh:${w}` }]));
  rows.push([{ text: '⬅ Back to containers', callback_data: 'bs:back' }]);
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    `🧵 *Bundle Sale — pick warehouse*\n🚢 Container: *${escapeMd(session.arrivalBatch)}*\n\nWhich location are you selling from?`,
    rows,
  );
}

async function renderDesignPicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const all = await inventoryRepository.getAll();
  const w = (session.warehouse || '').toLowerCase();
  const designs = new Map();
  for (const r of all) {
    if (r.status !== 'available') continue;
    if (w && r.warehouse.toLowerCase() !== w) continue;
    if (!rowInBatch(r, session.arrivalBatch)) continue;
    if (!r.design) continue;
    const k = r.design.toUpperCase();
    if (!designs.has(k)) designs.set(k, { design: r.design, designKey: k, thans: 0, yards: 0, shades: new Set() });
    const e = designs.get(k);
    e.thans += 1;
    e.yards += r.yards;
    if (r.shade) e.shades.add(r.shade.toUpperCase());
  }
  const list = Array.from(designs.values()).sort((a, b) => b.yards - a.yards);
  if (!list.length) {
    await render(bot, chatId, userId,
      `🧵 *Bundle Sale — ${escapeMd(session.warehouse || 'all warehouses')}*\n🚢 Container: *${escapeMd(session.arrivalBatch)}*\n\n_No available stock in this container/warehouse._`,
      [backRow(), cancelRow()],
    );
    return;
  }
  const rows = list.slice(0, 12).map((d) => ([{
    text: `🎨 ${d.design} · ${d.shades.size} shade${d.shades.size === 1 ? '' : 's'} · ${fmtQty(d.yards)} yd`,
    callback_data: `bs:design:${d.designKey}`,
  }]));
  if (list.length > 12) {
    rows.push([{ text: `… ${list.length - 12} more designs (refine via search next round)`, callback_data: 'bs:noop' }]);
  }
  rows.push(backRow());
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    `🧵 *Bundle Sale — ${escapeMd(session.warehouse || 'all warehouses')}*\n🚢 Container: *${escapeMd(session.arrivalBatch)}*\n\nPick a design to drill into:`,
    rows,
  );
}

async function renderShadePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const grouped = await inventoryRepository.groupByBaleAndShade(session.design, session.warehouse, { arrivalBatch: session.arrivalBatch });
  session._grouped = grouped; // cached for sub-views
  sessionStore.set(userId, session);
  const nameMap = await loadShadeNameMap(session.design);

  // Subtract whatever is already in the cart from the available count,
  // so the picker is honest about how much is left to take.
  const inCart = new Map();
  for (const l of session.cart.lines) {
    if (!l.design || l.design.toUpperCase() !== session.designKey) continue;
    const k = (l.shade || '').toUpperCase() || '(NO-SHADE)';
    if (!inCart.has(k)) inCart.set(k, { thans: 0, yards: 0 });
    const e = inCart.get(k);
    e.thans += 1;
    e.yards += l.yards;
  }

  // Supply-Details-style shade buttons: "<#> - <name> (<n> thans)", two
  // per row, names sourced from the design catalog. No catalogue photo.
  const buttons = [];
  let totalRemThans = 0;
  let availableShades = 0;
  for (const sh of grouped.shades) {
    const used = inCart.get(sh.shadeKey) || { thans: 0 };
    const remThans = Math.max(0, sh.summary.thanCount - used.thans);
    if (remThans <= 0) continue;
    totalRemThans += remThans;
    availableShades += 1;
    buttons.push({
      text: buildShadeLabel(sh.shadeKey, nameMap, remThans, THAN_UNIT),
      callback_data: `bs:shade:${sh.shadeKey}`,
    });
  }

  const rows = layoutShadeRows(buttons);
  if (totalRemThans > 0) {
    // Bulk shortcut mirroring Supply's "Take ALL shades": queue every
    // remaining than of every shade for this design in one tap.
    rows.push([{
      text: `✅ Take ALL ${availableShades} shade${availableShades === 1 ? '' : 's'} (${totalRemThans} ${totalRemThans === 1 ? THAN_UNIT.singular : THAN_UNIT.plural})`,
      callback_data: 'bs:all_shades',
    }]);
    // TRF-15 (owner rule, 02-Aug) — Smart-Pack removed: the bot never
    // selects physical thans. Every than in a sale is hand-ticked.
  } else {
    rows.push([{ text: '🛒 Review cart', callback_data: 'bs:cart' }]);
  }
  const totals = bundleSaleService.totals(session.cart);
  const cr = cartRow(totals.yards, totals.thans);
  if (cr) rows.push(cr);
  rows.push([{ text: '⬅️ Back to designs', callback_data: 'bs:back' }]);
  rows.push(cancelRow());

  await render(bot, chatId, userId,
    `🧵 *${escapeMd(session.design)}* @ *${escapeMd(session.warehouse || '—')}*\n\n`
    + (totalRemThans > 0
      ? 'Pick a shade to open its bales:'
      : '_All shades for this design are already in your cart._'),
    rows,
  );
}

/**
 * Resolve {shadeBucket, emoji, shadeRef} for the active shade, loading the
 * grouped cache + catalog names on demand. Returns null when the shade is
 * gone (caller renders an error).
 */
async function resolveActiveShade(session) {
  if (!session._grouped) {
    session._grouped = await inventoryRepository.groupByBaleAndShade(session.design, session.warehouse, { arrivalBatch: session.arrivalBatch });
  }
  const shadeBucket = session._grouped.shades.find((s) => s.shadeKey === session.shadeKey);
  if (!shadeBucket) return null;
  const shadesList = await shadesRepository.getAll();
  const emoji = shadesRepository.chipFromList(shadesList, shadeBucket.shade) || '🎨';
  const nameMap = await loadShadeNameMap(session.design);
  const shadeRef = formatShadeRef(shadeBucket.shade, nameMap.get(String(shadeBucket.shadeKey)) || nameMap.get(String(shadeBucket.shade)));
  return { shadeBucket, emoji, shadeRef };
}

/**
 * Bale list — one tappable row per bale (tap = take/untake the whole bale,
 * the leading box reflects selection state) plus a drill-down arrow that
 * opens the bale-detail card to pick individual thans. Mirrors the elegant,
 * uncluttered Supply-Details bale list.
 */
async function renderBalePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const resolved = await resolveActiveShade(session);
  sessionStore.set(userId, session);
  if (!resolved) { await renderError(bot, chatId, userId, 'Shade no longer available.'); return; }
  const { shadeBucket, emoji, shadeRef } = resolved;

  const inCart = new Set(session.cart.lines.map((l) => l._key));
  const rows = [];
  for (const bale of shadeBucket.bales) {
    const total = bale.thans.length;
    const takenCount = bale.thans.filter((t) => inCart.has(thanKey(t))).length;
    // ⬜ none · ◪ partial · ✅ whole bale selected.
    const icon = takenCount === 0 ? '⬜' : (takenCount === total ? '✅' : '◪');
    const age = bundleSaleService.ageBucket(bale.ageDays);
    const countTag = takenCount > 0 ? `${takenCount}/${total}` : `${total}`;
    rows.push([
      {
        text: `${icon} ${age.emoji} ${bale.packageNo} · ${countTag} than`,
        callback_data: `bs:wholebale:${baleKeyOf(bale)}`,
      },
      { text: '➡️', callback_data: `bs:bale:${baleKeyOf(bale)}` },
    ]);
  }

  const totals = bundleSaleService.totals(session.cart);
  const cr = cartRow(totals.yards, totals.thans);
  if (cr) rows.push(cr);
  rows.push([{ text: '🎨 Change shade', callback_data: 'bs:back' }]);
  rows.push(cancelRow());

  const header = `🧵 *${escapeMd(session.design)}*  ${emoji} *${escapeMd(shadeRef || '—')}*  @ ${escapeMd(session.warehouse || '—')}\n\n`
    + 'Tap a *bale number* to take the whole bale, or *➡️* to pick thans inside it.\n'
    + '⬜ none · ◪ some · ✅ whole bale.';
  await render(bot, chatId, userId, header, rows);
}

/**
 * Bale-detail card — full bale info + a checkbox per than (tap to toggle),
 * with whole-bale take/clear shortcuts. Reached via the ➡️ arrow.
 */
async function renderBaleDetail(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const resolved = await resolveActiveShade(session);
  if (!resolved) { await renderError(bot, chatId, userId, 'Shade no longer available.'); return; }
  const { shadeBucket, emoji, shadeRef } = resolved;
  const bale = shadeBucket.bales.find((b) => baleKeyOf(b) === session.activeBaleUid);
  if (!bale) { await renderError(bot, chatId, userId, 'Bale no longer available.'); return; }

  const inCart = new Set(session.cart.lines.map((l) => l._key));
  const total = bale.thans.length;
  const takenCount = bale.thans.filter((t) => inCart.has(thanKey(t))).length;
  const baleYards = bale.thans.reduce((sum, t) => sum + (t.yards || 0), 0);
  const age = bundleSaleService.ageBucket(bale.ageDays);
  const ageBit = bale.ageDays != null ? ` · ${age.emoji} ${bale.ageDays}d (${age.label})` : '';
  const binBit = bale.binLocation ? ` · shelf *${escapeMd(bale.binLocation)}*` : '';

  const rows = [];
  let currentRow = [];
  for (const t of bale.thans) {
    const isTaken = inCart.has(thanKey(t));
    const label = `${isTaken ? '☑️' : '⬜'} #${t.thanNo} · ${fmtQty(t.yards)}y`;
    currentRow.push({ text: label, callback_data: `bs:than:${thanKey(t)}` });
    if (currentRow.length === 3) { rows.push(currentRow); currentRow = []; }
  }
  if (currentRow.length) rows.push(currentRow);

  const actionRow = [];
  if (takenCount < total) actionRow.push({ text: '📦 Take whole bale', callback_data: `bs:take_all:${baleKeyOf(bale)}` });
  if (takenCount > 0) actionRow.push({ text: '🧹 Clear bale', callback_data: `bs:rm_bale:${baleKeyOf(bale)}` });
  if (actionRow.length) rows.push(actionRow);

  const totals = bundleSaleService.totals(session.cart);
  const cr = cartRow(totals.yards, totals.thans);
  if (cr) rows.push(cr);
  rows.push([{ text: '⬅ Back to bales', callback_data: 'bs:back' }]);
  rows.push(cancelRow());

  const header = `📦 *Bale ${escapeMd(bale.packageNo)}*  ·  ${total} than · ${fmtQty(baleYards)} yd\n`
    + `${emoji} *${escapeMd(shadeRef || '—')}* · ${escapeMd(session.design)} @ ${escapeMd(session.warehouse || '—')}${ageBit}${binBit}\n\n`
    + `Selected: *${takenCount}/${total}* than. Tap a than to toggle it.`;
  await render(bot, chatId, userId, header, rows);
}

/* ───────────────────────────────────────────────────────────────────── */
/*  Smart-Pack                                                          */
/* ───────────────────────────────────────────────────────────────────── */

async function renderSmartPackPrompt(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'await_smartpack_target';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `🎯 *Smart-Pack*\n\nType the target yardage and I'll suggest a basket from *${escapeMd(session.design)}*.\n\nExample: \`75\` (yards). I'll favour oldest stock first.`,
    [backRow(), cancelRow()],
  );
}

async function applySmartPack(bot, chatId, userId, target) {
  const session = sessionStore.get(userId);
  if (!session) return;
  if (!session._grouped) {
    session._grouped = await inventoryRepository.groupByBaleAndShade(session.design, session.warehouse, { arrivalBatch: session.arrivalBatch });
  }
  const inCart = new Set(session.cart.lines.map((l) => l._key));
  // Flatten all eligible thans across all shades, excluding ones already in cart.
  const pool = [];
  for (const sh of session._grouped.shades) {
    for (const b of sh.bales) {
      for (const t of b.thans) {
        const k = `${t.baleUid || `pkg:${t.packageNo}`}|${t.thanNo}`;
        if (inCart.has(k)) continue;
        pool.push({ ...t, addedAt: b.addedAt, shade: sh.shade, design: session.design, binLocation: b.binLocation });
      }
    }
  }
  const result = bundleSaleService.smartPackForTarget({ targetYards: target, thans: pool });
  if (!result.picks.length) {
    await renderError(bot, chatId, userId, `No stock available for *${escapeMd(session.design)}* matching that target.`);
    return;
  }
  session.smartPack = { target, picks: result.picks, pickedYards: result.pickedYards, shortBy: result.shortBy, overshoot: result.overshoot };
  session.step = 'preview_smartpack';
  sessionStore.set(userId, session);

  // Group picks by shade for human-readable preview.
  const byShade = new Map();
  for (const p of result.picks) {
    const k = (p.shade || '').toUpperCase() || '(NO-SHADE)';
    if (!byShade.has(k)) byShade.set(k, { shade: p.shade, yards: 0, thans: 0 });
    const e = byShade.get(k);
    e.yards += p.yards;
    e.thans += 1;
  }
  const lines = [];
  const shadesList = await shadesRepository.getAll();
  for (const e of byShade.values()) {
    const emoji = shadesRepository.chipFromList(shadesList, e.shade) || '🎨';
    lines.push(`${emoji} ${escapeMd(e.shade || '—')} — ${fmtQty(e.yards)} yd (${e.thans} than)`);
  }
  let note = `Total: *${fmtQty(result.pickedYards)} yd* across ${result.picks.length} than.`;
  if (result.shortBy > 0) note += `\n_Short by ${fmtQty(result.shortBy)} yd — not enough stock for the full target._`;
  else if (result.overshoot > 0) note += `\n_Overshoots target by ${fmtQty(result.overshoot)} yd (whole-than rounding)._`;

  await render(bot, chatId, userId,
    `🎯 *Smart-Pack preview · target ${fmtQty(target)} yd*\n\n${lines.join('\n')}\n\n${note}\n\nAdd to cart?`,
    [
      [{ text: '✅ Add to cart', callback_data: 'bs:smartpack_apply' }],
      [{ text: '🔁 Try a different target', callback_data: 'bs:smartpack' }],
      backRow(),
      cancelRow(),
    ],
  );
}

async function commitSmartPack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.smartPack) return;
  const added = bundleSaleService.addLines(session.cart, session.smartPack.picks.map((t) => ({
    baleUid: t.baleUid, packageNo: t.packageNo, thanNo: t.thanNo, yards: t.yards,
    design: session.design, shade: t.shade || '', binLocation: t.binLocation || '',
  })));
  session.smartPack = null;
  session.step = 'cart_review';
  sessionStore.set(userId, session);
  logger.info(`bundleSaleFlow.smartpack: user=${userId} added=${added} cart=${session.cart.lines.length}`);
  await renderCart(bot, chatId, userId);
}

/* ───────────────────────────────────────────────────────────────────── */
/*  Cart view (collapsible)                                             */
/* ───────────────────────────────────────────────────────────────────── */

async function renderCart(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const totals = bundleSaleService.totals(session.cart);
  if (!totals.thans) {
    await render(bot, chatId, userId,
      '🛒 *Cart is empty*\n\nGo back and pick a few thans, or use *🎯 Pack target yardage*.',
      [
        [{ text: '🎨 Pick another shade', callback_data: 'bs:back_to_shades' }],
        cancelRow(),
      ],
    );
    return;
  }
  const summary = bundleSaleService.summarise(session.cart);
  const shadesList = await shadesRepository.getAll();
  const expanded = session.expandedShade || '';
  const rows = [];
  let text = `🛒 *Cart · ${totals.thans} than · ${fmtQty(totals.yards)} yd · ${totals.bales} bale(s)*\n\n`;
  for (const s of summary) {
    const emoji = shadesRepository.chipFromList(shadesList, s.shade) || '🎨';
    const header = `${emoji} *${escapeMd(s.shade || '—')}* — ${fmtQty(s.yards)} yd · ${s.thans} than · ${s.bales.length} bale(s)`;
    text += header + '\n';
    if (expanded === s.shadeKey) {
      for (const b of s.bales) {
        text += `   · Bale ${escapeMd(b.packageNo)}${b.binLocation ? ` (${escapeMd(b.binLocation)})` : ''} — ${b.thans.map((t) => `#${t.thanNo}`).join(', ')} = ${fmtQty(b.yards)} yd\n`;
      }
      rows.push([
        { text: `🔼 Collapse ${s.shade || '—'}`, callback_data: `bs:expand:` },
        { text: `🗑 Remove all ${s.shade || '—'}`, callback_data: `bs:rm_shade:${s.shadeKey}` },
      ]);
    } else {
      rows.push([
        { text: `🔽 Expand ${s.shade || '—'}`, callback_data: `bs:expand:${s.shadeKey}` },
      ]);
    }
  }

  rows.push([{ text: '➕ Add more thans', callback_data: 'bs:back_to_shades' }]);
  rows.push([{ text: '✅ Proceed to review', callback_data: 'bs:proceed' }]);
  rows.push(cancelRow());

  await render(bot, chatId, userId, text, rows);
}

/* ───────────────────────────────────────────────────────────────────── */
/*  Customer / rate / payment / confirm                                 */
/* ───────────────────────────────────────────────────────────────────── */





async function handleCustomerSearch(bot, chatId, userId, query) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let hits = [];
  try { hits = await customersRepository.searchByName(query); } catch (_) {}
  const rows = hits.slice(0, 10).map((c, i) => ([{ text: `👤 ${c.name}${c.tier ? ` · ${c.tier}` : ''}`, callback_data: `bs:cust:s:${i}` }]));
  session._searchHits = hits.slice(0, 10);
  sessionStore.set(userId, session);
  if (!hits.length) {
    rows.push([{ text: `➕ Add "${query}" as walk-in`, callback_data: 'bs:cust:walkin_named' }]);
    session._walkinName = query;
    sessionStore.set(userId, session);
  }
  rows.push([{ text: '🔄 Search again', callback_data: 'bs:cust:search' }]);
  rows.push(backRow());
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    `🔎 *Matches for "${escapeMd(query)}"*\n\n${hits.length ? `Pick one:` : `No matches found.`}`,
    rows,
  );
}





async function renderConfirm(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'confirm';
  sessionStore.set(userId, session);

  // Re-check stock LIVE before showing the confirm card; safer than
  // doing it during submit and discovering the conflict only then.
  const reconciled = await bundleSaleService.reconcileWithLive(session.cart);
  if (!reconciled.ok) {
    bundleSaleService.removeLines(session.cart, reconciled.dropped.map((d) => d.line._key));
    const lines = reconciled.dropped.map((d) => `  · Bale ${d.line.packageNo} #${d.line.thanNo} — ${d.reason}`);
    await render(bot, chatId, userId,
      `⚠️ *${reconciled.dropped.length} item(s) became unavailable*\n\nDropped from cart:\n${lines.join('\n')}\n\nReview the cart and decide.`,
      [
        [{ text: '🛒 Open cart', callback_data: 'bs:cart' }],
        cancelRow(),
      ]);
    return;
  }

  const totals = bundleSaleService.totals(session.cart);
  const summary = bundleSaleService.summarise(session.cart);
  const shadesList = await shadesRepository.getAll();
  const lines = summary.map((s) => {
    const emoji = shadesRepository.chipFromList(shadesList, s.shade) || '🎨';
    return `${emoji} ${escapeMd(s.shade || '—')} — ${fmtQty(s.yards)} yd · ${s.thans} than`;
  });
  let text = `🧾 *Confirm Bundle Sale*\n\n`
    + `*${escapeMd(session.design)}* @ *${escapeMd(session.warehouse || '—')}*\n`
    + `${lines.join('\n')}\n\n`
    + `*Total: ${fmtQty(totals.yards)} yd*\n\n`
    + `_Queued for admin approval; cart is locked at submission._\n`
    + `_The admin assigns the customer, rate and payment — you will get the customer name and number back here once approved._`;
  await render(bot, chatId, userId, text, [
    [{ text: '✅ Submit for approval', callback_data: 'bs:submit' }],
    backRow(),
    cancelRow(),
  ]);
}

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'bundle_sale_flow') return;
  const totals = bundleSaleService.totals(session.cart);
  if (!totals.thans) { await renderError(bot, chatId, userId, 'Cart is empty.'); return; }
  // One last reconciliation right before queueing.
  const reconciled = await bundleSaleService.reconcileWithLive(session.cart);
  if (!reconciled.ok) {
    bundleSaleService.removeLines(session.cart, reconciled.dropped.map((d) => d.line._key));
    await renderError(bot, chatId, userId, `${reconciled.dropped.length} item(s) became unavailable. Cart was trimmed — please re-confirm.`);
    return;
  }
  try {
    const todayIso = new Date().toISOString().slice(0, 10);
    // APU-1 sweep (owner 19-Jul): human-readable name on the queue row and
    // in the eventual Transactions ledger row, not a raw Telegram id.
    const sellerLabel = await require('../services/approvalCards').resolveUserLabel(userId, bot);
    const { requestId } = await bundleSaleService.submitForApproval({
      cart: session.cart,
      sale: {
        // DSP-1 — customer, rate and payment are the admin's to set at
        // approval; the dispatcher supplies only what physically ships.
        customer: '',
        salesDate: todayIso,
        salesPerson: sellerLabel,
        paymentMode: '',
        pricePerYard: 0,
        designSummary: session.design,
        warehouse: session.warehouse,
        amountPaid: 0,
      },
      user: { id: userId, userId, username: '' },
      riskReason: 'Bundle sale (Kano poly-colour) requires admin approval.',
    });
    const isAdm = auth.isAdmin(userId);
    const excludeId = isAdm ? userId : undefined;
    const detail =
      `🧵 Bundle sale — ${session.design} @ ${session.warehouse || '—'}\n`
      + `${totals.thans} than · ${fmtQty(totals.yards)} yd`;
    await approvalEvents.notifyAdminsApprovalRequest(
      bot, requestId, sellerLabel, detail,
      'Bundle sale (Kano poly-colour) requires admin approval.', excludeId,
    );
    await render(bot, chatId, userId,
      `⏳ *Submitted for approval*\n\n`
      + `• Request: \`${requestId}\`\n`
      + `• Items: *${totals.thans} than · ${fmtQty(totals.yards)} yd*\n`
      + `• Approver: 2nd admin (you cannot self-approve)\n\n`
      + `_The admin assigns the customer, rate and payment when approving — you will get the customer name and number back here once approved._`,
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]],
    );
    await rememberRequesterCard(requestId, chatId, userId);
    sessionStore.clear(userId);
    logger.info(`bundleSaleFlow.submit: req=${requestId} thans=${totals.thans} yards=${totals.yards} by=${userId}`);
  } catch (e) {
    logger.error('bundleSaleFlow.submit error', e.message);
    await renderError(bot, chatId, userId, e.message || 'Failed to submit.');
  }
}

/* ───────────────────────────────────────────────────────────────────── */
/*  Text input                                                          */
/* ───────────────────────────────────────────────────────────────────── */

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'bundle_sale_flow') return false;
  const chatId = msg.chat.id;
  const raw = (msg.text || '').trim();
  if (raw.startsWith('/')) return false;

  if (session.step === 'await_smartpack_target') {
    const v = parseFloat(raw);
    if (!isFinite(v) || v <= 0 || v > 100000) {
      await renderError(bot, chatId, userId, 'Target yardage must be a positive number ≤ 100,000.');
      return true;
    }
    await applySmartPack(bot, chatId, userId, v);
    return true;
  }

  if (session.step === 'await_customer_search') {
    if (raw.length < 2) { await renderError(bot, chatId, userId, 'Type at least 2 characters to search.'); return true; }
    await handleCustomerSearch(bot, chatId, userId, raw);
    return true;
  }

  return false;
}

/* ───────────────────────────────────────────────────────────────────── */
/*  Callback dispatcher                                                 */
/* ───────────────────────────────────────────────────────────────────── */

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('bs:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'bundle_sale_flow') return false;

  try { await bot.answerCallbackQuery(query.id); } catch (_) {}

  if (data === 'bs:noop') return true;

  if (data === 'bs:cancel') {
    // Render BEFORE clearing — render() early-returns once the session is gone.
    await render(bot, chatId, userId, '❌ Cancelled.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    sessionStore.clear(userId);
    return true;
  }

  if (data === 'bs:back') {
    await stepBack(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:ct:')) {
    session.arrivalBatch = data.slice('bs:ct:'.length);
    session.step = 'pick_warehouse';
    // Reset any downstream selection captured before re-picking a container.
    session.warehouse = '';
    session.designKey = '';
    session.design = '';
    session.shadeKey = '';
    session._grouped = null;
    sessionStore.set(userId, session);
    await renderWarehousePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:wh:')) {
    session.warehouse = data.slice('bs:wh:'.length);
    session.step = 'pick_design';
    sessionStore.set(userId, session);
    await renderDesignPicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:design:')) {
    const dk = data.slice('bs:design:'.length);
    const all = await inventoryRepository.getAll();
    const w = (session.warehouse || '').toLowerCase();
    const match = all.find((r) => r.status === 'available' && r.design.toUpperCase() === dk && (!w || r.warehouse.toLowerCase() === w));
    session.designKey = dk;
    session.design = match ? match.design : dk;
    session.step = 'pick_shade';
    sessionStore.set(userId, session);
    await renderShadePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:shade:')) {
    session.shadeKey = data.slice('bs:shade:'.length);
    session.step = 'pick_bales';
    sessionStore.set(userId, session);
    await renderBalePicker(bot, chatId, userId);
    return true;
  }

  if (data === 'bs:all_shades') {
    if (!session._grouped) {
      session._grouped = await inventoryRepository.groupByBaleAndShade(session.design, session.warehouse, { arrivalBatch: session.arrivalBatch });
    }
    const inCart = new Set(session.cart.lines.map((l) => l._key));
    const lines = [];
    for (const sh of session._grouped.shades) {
      for (const b of sh.bales) {
        for (const t of b.thans) {
          if (inCart.has(thanKey(t))) continue;
          lines.push({
            baleUid: t.baleUid, packageNo: t.packageNo, thanNo: t.thanNo,
            yards: t.yards, design: session.design, shade: sh.shade, binLocation: b.binLocation,
          });
        }
      }
    }
    const added = bundleSaleService.addLines(session.cart, lines);
    session.step = 'cart_review';
    sessionStore.set(userId, session);
    logger.info(`bundleSaleFlow.all_shades: user=${userId} added=${added} cart=${session.cart.lines.length}`);
    await renderCart(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:bale:')) {
    session.shadeKey = session.shadeKey || '';
    session.activeBaleUid = data.slice('bs:bale:'.length);
    session.step = 'bale_detail';
    sessionStore.set(userId, session);
    await renderBaleDetail(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:wholebale:')) {
    const baleKey = data.slice('bs:wholebale:'.length);
    const bucket = session._grouped?.shades.find((s) => s.shadeKey === session.shadeKey);
    const bale = bucket && bucket.bales.find((b) => baleKeyOf(b) === baleKey);
    if (bale) {
      const inCart = new Set(session.cart.lines.map((l) => l._key));
      const allTaken = bale.thans.every((t) => inCart.has(thanKey(t)));
      if (allTaken) {
        // Toggle off: untake the whole bale.
        bundleSaleService.removeLines(session.cart, bale.thans.map((t) => thanKey(t)));
      } else {
        bundleSaleService.addLines(session.cart, bale.thans.map((t) => ({
          baleUid: t.baleUid, packageNo: t.packageNo, thanNo: t.thanNo,
          yards: t.yards, design: session.design, shade: bucket.shade, binLocation: bale.binLocation,
        })));
      }
      sessionStore.set(userId, session);
    }
    await renderBalePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:than:')) {
    const k = data.slice('bs:than:'.length);
    // Toggle: if already in cart, remove it; else find row in cached
    // _grouped and add.
    if (session.cart.byKey.has(k)) {
      bundleSaleService.removeLines(session.cart, [k]);
    } else {
      const bucket = session._grouped?.shades.find((s) => s.shadeKey === session.shadeKey);
      const than = bucket && (() => {
        for (const b of bucket.bales) {
          for (const t of b.thans) {
            if (`${t.baleUid || `pkg:${t.packageNo}`}|${t.thanNo}` === k) return { than: t, bale: b };
          }
        }
        return null;
      })();
      if (than) {
        bundleSaleService.addLines(session.cart, [{
          baleUid: than.than.baleUid, packageNo: than.than.packageNo, thanNo: than.than.thanNo,
          yards: than.than.yards, design: session.design, shade: bucket.shade,
          binLocation: than.bale.binLocation,
        }]);
      }
    }
    sessionStore.set(userId, session);
    if (session.step === 'bale_detail') await renderBaleDetail(bot, chatId, userId);
    else await renderBalePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:take_all:')) {
    const baleKey = data.slice('bs:take_all:'.length);
    const bucket = session._grouped?.shades.find((s) => s.shadeKey === session.shadeKey);
    if (bucket) {
      const bale = bucket.bales.find((b) => baleKeyOf(b) === baleKey);
      if (bale) {
        const lines = bale.thans.map((t) => ({
          baleUid: t.baleUid, packageNo: t.packageNo, thanNo: t.thanNo,
          yards: t.yards, design: session.design, shade: bucket.shade, binLocation: bale.binLocation,
        }));
        bundleSaleService.addLines(session.cart, lines);
        sessionStore.set(userId, session);
      }
    }
    if (session.step === 'bale_detail') await renderBaleDetail(bot, chatId, userId);
    else await renderBalePicker(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:rm_bale:')) {
    const baleKey = data.slice('bs:rm_bale:'.length);
    // STK-E1 — clear by the canonical line identity, so a LEGACY bale
    // (per-than uids) clears whole instead of dropping one than. Stale
    // cards carrying the old payload shapes still route correctly.
    if (baleKey.startsWith('pkg:') && baleKey.includes('|')) {
      bundleSaleService.removeLines(session.cart,
        session.cart.lines.filter((l) => bundleSaleService.lineBaleKey(l) === baleKey).map((l) => l._key));
    } else if (baleKey.startsWith('pkg:')) {
      const pkg = baleKey.slice(4); // pre-STK-E1 card: bare packageNo
      bundleSaleService.removeLines(session.cart,
        session.cart.lines.filter((l) => l.packageNo === pkg).map((l) => l._key));
    } else {
      bundleSaleService.removeBale(session.cart, baleKey);
    }
    sessionStore.set(userId, session);
    if (session.step === 'bale_detail') await renderBaleDetail(bot, chatId, userId);
    else if (session.step === 'pick_bales') await renderBalePicker(bot, chatId, userId);
    else await renderCart(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:rm_shade:')) {
    const shadeKey = data.slice('bs:rm_shade:'.length);
    bundleSaleService.removeLines(session.cart,
      session.cart.lines.filter((l) => (l.shade || '').toUpperCase() === shadeKey).map((l) => l._key));
    sessionStore.set(userId, session);
    await renderCart(bot, chatId, userId);
    return true;
  }

  if (data === 'bs:cart' || data === 'bs:back_to_shades') {
    if (data === 'bs:cart') session.step = 'cart_review';
    else { session.step = 'pick_shade'; session.shadeKey = ''; }
    sessionStore.set(userId, session);
    if (session.step === 'pick_shade') await renderShadePicker(bot, chatId, userId);
    else await renderCart(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('bs:expand:')) {
    const key = data.slice('bs:expand:'.length);
    session.expandedShade = (session.expandedShade === key) ? '' : key;
    sessionStore.set(userId, session);
    await renderCart(bot, chatId, userId);
    return true;
  }

  if (data === 'bs:smartpack' || data === 'bs:smartpack_apply') {
    // TRF-15 (owner rule, 02-Aug) — the bot never selects physical thans.
    // Old cards may still carry the button; answer instead of acting.
    await bot.answerCallbackQuery(query.id, {
      text: 'Smart-Pack is off — the bot no longer picks thans. Tick each than yourself.',
      show_alert: true,
    }).catch(() => {});
    return true;
  }

  // DSP-1 — cart goes straight to confirm; customer, rate and payment
  // are assigned by the admin at approval.
  if (data === 'bs:proceed') { await renderConfirm(bot, chatId, userId); return true; }

  if (data === 'bs:submit') { await submit(bot, chatId, userId); return true; }

  return false;
}

async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  switch (session.step) {
    case 'pick_warehouse':
      // ARRIVAL-BATCH C1 — back to the Select Container step.
      session.step = 'pick_container';
      session.arrivalBatch = '';
      session.warehouse = '';
      sessionStore.set(userId, session);
      await renderContainerPicker(bot, chatId, userId);
      break;
    case 'pick_design':
      // When the warehouse step was auto-skipped (single warehouse in the
      // container) there is nothing to go back to there — return to the
      // container picker instead.
      if (session._multiWarehouse) {
        session.step = 'pick_warehouse';
        session.warehouse = '';
        sessionStore.set(userId, session);
        await renderWarehousePicker(bot, chatId, userId);
      } else {
        session.step = 'pick_container';
        session.arrivalBatch = '';
        session.warehouse = '';
        sessionStore.set(userId, session);
        await renderContainerPicker(bot, chatId, userId);
      }
      break;
    case 'pick_shade':
      session.step = 'pick_design';
      session.designKey = '';
      session.design = '';
      sessionStore.set(userId, session);
      await renderDesignPicker(bot, chatId, userId);
      break;
    case 'pick_bales':
      session.step = 'pick_shade';
      session.shadeKey = '';
      sessionStore.set(userId, session);
      await renderShadePicker(bot, chatId, userId);
      break;
    case 'bale_detail':
      session.step = 'pick_bales';
      session.activeBaleUid = '';
      sessionStore.set(userId, session);
      await renderBalePicker(bot, chatId, userId);
      break;
    case 'await_smartpack_target':
    case 'preview_smartpack':
      session.step = 'pick_shade';
      session.smartPack = null;
      sessionStore.set(userId, session);
      await renderShadePicker(bot, chatId, userId);
      break;
    case 'cart_review':
      session.step = 'pick_shade';
      sessionStore.set(userId, session);
      await renderShadePicker(bot, chatId, userId);
      break;
    // DSP-1 — confirm now sits directly above the cart: the customer, rate
    // and payment levels moved to the admin's approval chain.
    case 'confirm':
      session.step = 'cart_review';
      sessionStore.set(userId, session);
      await renderCart(bot, chatId, userId);
      break;
    default:
      await render(bot, chatId, userId, '❌ Cancelled.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
      sessionStore.clear(userId);
  }
}

module.exports = {
  start,
  handleCallback,
  handleText,
  _internals: {
    renderContainerPicker, renderWarehousePicker, renderDesignPicker, renderShadePicker,
    renderBalePicker, renderBaleDetail, renderCart, renderConfirm, submit,
    applySmartPack, commitSmartPack, stepBack, thanKey, baleKeyOf,
    rowInBatch, listWarehousesInBatch,
  },
};
