'use strict';

/**
 * src/flows/stockByShadeFlow.js — SDS-1 🎨 Stock by shade.
 *
 * Owner request (07-Aug-2026, layout confirmed before build): tap a shade
 * and see the printed bale numbers split by status — the hand-drawn card:
 *
 *   📦 9006 — Lagos
 *   Shade 11 - White
 *   ✅ Available — 8 Bales   (the numbers)
 *   💰 Sold — 5 Bales        (number — date — customer, oldest first)
 *   🚚 In transit — 1 Bale   (number → destination, separate bucket)
 *
 * No screen showed both sides before (survey 07-Aug): pickers list
 * available only, Supply Details lists sold only per customer+day.
 *
 * ACCESS — admins + the Dispatch department (there is no durable
 * "dispatcher" role; the Users-sheet department is the durable thing the
 * bot already keys dispatch notifications on). The entry button in the
 * Supply Details view menu renders only for eligible users; the flow
 * re-checks on every tap because stale cards outlive menus.
 *
 * SDS-3 (owner's handwritten note, 08-Aug-2026, layout confirmed): for
 * than-selling warehouses (TV-1 Settings list) the design AND shade chips
 * read `received B · left t / received t` — e.g. `9043-B (20B · 34t/120t)`
 * — sorted most-thans-remaining first; the sold figure lives inside the
 * card. received = rows on this store's books today (available + sold),
 * same semantics as the Supply Details opening figure; a bale transferred
 * onward counts at the receiving store. Yards stay off the chips (part of
 * the confirmed layout). Bale-selling warehouses keep `available · sold`.
 *
 * RULES BAKED IN:
 *  - in_transit is its own bucket, never merged (owner ruling, 04-Aug) —
 *    and it is design+shade wide, not warehouse-filtered, because an
 *    in-transit row's Warehouse column holds the DESTINATION;
 *  - part-taken bales show on both sides with §6c/TV-8 labels from
 *    unitDisplayService (never hardcoded B/t);
 *  - a printed number re-used across containers never merges (§6b) —
 *    multi-container cards group Available per container and tag lines;
 *  - block-header counts are bales-only (owner's stock-position
 *    exception to §6c);
 *  - sold rows missing date/customer still render with '—': this is a
 *    reconciliation surface, a gap must be visible, not hidden.
 *
 * Callback namespace `sds:*`:
 *   sds:start      entry from the Supply Details view menu (session-free)
 *   sds:w:<i>      pick warehouse (index into session._whs)
 *   sds:pg:<n>     design list page
 *   sds:d:<i>      pick design   (index into session._designs)
 *   sds:s:<i>      pick shade    (index into session._shades)
 *   sds:designs    jump from the card back to the design list
 *   sds:back       step back one level
 *   sds:close      end the flow
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const usersRepository = require('../repositories/usersRepository');
const unitDisplayService = require('../services/unitDisplayService');
const { buildShadeNameMap, buildShadeLabel } = require('../utils/shadeButtons');
const auth = require('../middlewares/auth');
const fmtDate = require('../utils/formatDate');
const logger = require('../utils/logger');

const SESSION_TYPE = 'stock_by_shade_flow';
const { backRow, menuRow } = rowsFor('sds');
const render = makeRenderer();

const DESIGNS_PER_PAGE = 8;
const SOLD_LINES_CAP = 40;

const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

/** Admins + active members of the Dispatch department. */
async function canUse(userId) {
  if (auth.isAdmin(userId)) return true;
  try {
    return (await usersRepository.findByDepartment('Dispatch'))
      .some((u) => String(u.user_id) === String(userId));
  } catch (e) {
    logger.warn(`stockByShade: Dispatch lookup failed: ${e.message}`);
    return false;
  }
}

/** ISO day for mixed sheet date formats (same convention as sdd/sdg/sbl). */
function normDay(sRaw) {
  const raw = String(sRaw || '').trim();
  if (!raw) return '';
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const dmy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) return `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
  const ms = Date.parse(raw);
  if (isFinite(ms)) return new Date(ms).toISOString().slice(0, 10);
  return raw;
}

/** One physical bale — STK-E1: the canonical identity. */
function baleKey(r) {
  return require('../services/baleIdentity').baleKey(r);
}

/** Distinct physical bales in a row set. */
function baleCount(rows) {
  return new Set(rows.map(baleKey)).size;
}

/** Numeric-aware sort for printed bale numbers. */
function byBaleNo(a, b) {
  const na = parseInt(a, 10);
  const nb = parseInt(b, 10);
  if (isFinite(na) && isFinite(nb) && na !== nb) return na - nb;
  return String(a).localeCompare(String(b));
}

function balesWord(n) {
  return `${n} Bale${n === 1 ? '' : 's'}`;
}

/* ───────────────────────────── entry ───────────────────────────── */

async function start(bot, chatId, userId, messageId = null) {
  if (!(await canUse(userId))) {
    try {
      await bot.sendMessage(chatId, '🎨 Stock by shade is for admins and the Dispatch team.');
    } catch (_) { /* ignore */ }
    return;
  }
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'pick_warehouse',
    flowMessageId: messageId || null, page: 0,
  });
  await renderWarehouses(bot, chatId, userId);
}

/* ─────────────────────── level 1: warehouse ─────────────────────── */

async function renderWarehouses(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  let all = [];
  try { all = await inventoryRepository.getAll(); } catch (e) {
    logger.warn(`stockByShade: inventory read failed: ${e.message}`);
  }
  // Stores that hold or held stock; an in-transit row's warehouse is the
  // DESTINATION, so it must not mint a picker entry by itself.
  const seen = new Map();
  for (const r of all) {
    if (r.status !== 'available' && r.status !== 'sold') continue;
    const k = upper(r.warehouse);
    if (k && !seen.has(k)) seen.set(k, String(r.warehouse).trim());
  }
  const whs = [...seen.values()].sort((a, b) => a.localeCompare(b));
  session._whs = whs;
  session.step = 'pick_warehouse';
  sessionStore.set(userId, session);
  if (!whs.length) {
    await render(bot, chatId, userId, '🎨 *Stock by shade*\n\n_No stock on record yet._', [menuRow()]);
    return;
  }
  const rows = [];
  for (let i = 0; i < whs.length; i += 2) {
    const row = [{ text: `🏭 ${whs[i]}`, callback_data: `sds:w:${i}` }];
    if (whs[i + 1]) row.push({ text: `🏭 ${whs[i + 1]}`, callback_data: `sds:w:${i + 1}` });
    rows.push(row);
  }
  rows.push(menuRow());
  await render(bot, chatId, userId, '🎨 *Stock by shade*\nPick the warehouse:', rows);
}

/* ─────────────────────── level 2: design ─────────────────────── */

async function renderDesigns(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.warehouse) return;
  let all = [];
  try { all = await inventoryRepository.getAll(); } catch (e) {
    logger.warn(`stockByShade: inventory read failed: ${e.message}`);
  }
  // SDS-3 (owner note, 08-Aug-2026) — than-selling stores (TV-1 Settings
  // list) read "received B · left t / received t"; bale stores keep
  // "available · sold". received = the rows on THIS store's books today
  // (available + sold) — a bale transferred onward belongs to the other
  // store's figures, same as the Supply Details opening count.
  const thanMode = await unitDisplayService.isThanVisibilityWarehouse(session.warehouse);
  const wh = upper(session.warehouse);
  const byDesign = new Map();
  for (const r of all) {
    if (upper(r.warehouse) !== wh) continue;
    if (r.status !== 'available' && r.status !== 'sold') continue;
    const k = upper(r.design);
    if (!k) continue;
    if (!byDesign.has(k)) byDesign.set(k, { design: String(r.design).trim(), avail: [], sold: [] });
    byDesign.get(k)[r.status === 'available' ? 'avail' : 'sold'].push(r);
  }
  const designs = [...byDesign.values()]
    .map((d) => ({
      design: d.design, avail: baleCount(d.avail), sold: baleCount(d.sold),
      received: baleCount([...d.avail, ...d.sold]),
      remT: d.avail.length, recT: d.avail.length + d.sold.length,
    }))
    .sort(thanMode
      // Most sellable first: what can still go out the door today.
      ? (a, b) => b.remT - a.remT || b.recT - a.recT || a.design.localeCompare(b.design)
      : (a, b) => b.avail - a.avail || b.sold - a.sold || a.design.localeCompare(b.design));
  session._designs = designs;
  session.step = 'pick_design';
  sessionStore.set(userId, session);
  if (!designs.length) {
    await render(bot, chatId, userId,
      `🎨 *Stock by shade — ${session.warehouse}*\n\n_No stock recorded in this warehouse._`,
      [backRow('⬅ Warehouses'), menuRow()]);
    return;
  }
  const chipQty = (d) => (thanMode
    ? unitDisplayService.formatReceivedRemaining({ receivedBales: d.received, remainingThans: d.remT, receivedThans: d.recT })
    : `${d.avail}B · ${d.sold} sold`);
  const pages = Math.max(1, Math.ceil(designs.length / DESIGNS_PER_PAGE));
  const page = Math.min(Math.max(0, session.page || 0), pages - 1);
  const slice = designs.slice(page * DESIGNS_PER_PAGE, (page + 1) * DESIGNS_PER_PAGE);
  const rows = slice.map((d, j) => [{
    text: `🧵 ${d.design} (${chipQty(d)})`,
    callback_data: `sds:d:${page * DESIGNS_PER_PAGE + j}`,
  }]);
  if (pages > 1) {
    const nav = [];
    if (page > 0) nav.push({ text: '◀ Prev', callback_data: `sds:pg:${page - 1}` });
    nav.push({ text: `${page + 1}/${pages}`, callback_data: 'sds:noop' });
    if (page < pages - 1) nav.push({ text: 'Next ▶', callback_data: `sds:pg:${page + 1}` });
    rows.push(nav);
  }
  rows.push(backRow('⬅ Warehouses'));
  rows.push(menuRow());
  await render(bot, chatId, userId,
    `🎨 *Stock by shade — ${session.warehouse}*\nPick the design (${thanMode ? 'received B · left t / received t' : 'available · sold bales'}):`, rows);
}

/* ─────────────────────── level 3: shade ─────────────────────── */

/** The card's row sets for the session's warehouse+design (+shade). */
function sliceRows(all, session, shade) {
  const wh = upper(session.warehouse);
  const dg = upper(session.design);
  // Blank shades ride the picker as '—'; match them back to the blank rows.
  const want = upper(shade) === '—' ? '' : upper(shade);
  const inShade = (r) => shade === undefined || upper(r.shade) === want;
  return {
    avail: all.filter((r) => r.status === 'available' && upper(r.warehouse) === wh
      && upper(r.design) === dg && inShade(r)),
    sold: all.filter((r) => r.status === 'sold' && upper(r.warehouse) === wh
      && upper(r.design) === dg && inShade(r)),
    // Design+shade wide on purpose: the row's warehouse is the DESTINATION,
    // so a bale on the road out of THIS store would otherwise vanish here.
    transit: all.filter((r) => r.status === 'in_transit'
      && upper(r.design) === dg && inShade(r)),
  };
}

async function renderShades(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.design) return;
  let all = [];
  try { all = await inventoryRepository.getAll(); } catch (e) {
    logger.warn(`stockByShade: inventory read failed: ${e.message}`);
  }
  const { avail, sold, transit } = sliceRows(all, session);
  const shadeMap = new Map();
  const bucketOf = (r, bucket) => {
    const k = upper(r.shade) || '—';
    if (!shadeMap.has(k)) shadeMap.set(k, { shade: String(r.shade).trim() || '—', avail: [], sold: [], transit: [] });
    shadeMap.get(k)[bucket].push(r);
  };
  avail.forEach((r) => bucketOf(r, 'avail'));
  sold.forEach((r) => bucketOf(r, 'sold'));
  transit.forEach((r) => bucketOf(r, 'transit'));

  let nameMap = new Map();
  try {
    const designAssetsRepo = require('../repositories/designAssetsRepository');
    nameMap = buildShadeNameMap(await designAssetsRepo.findActive(session.design));
  } catch (_) { /* numbers-only labels */ }

  // SDS-3 — same chip grammar as the design list: than-selling stores read
  // received B · left t / received t; bale stores keep available · sold.
  const thanMode = await unitDisplayService.isThanVisibilityWarehouse(session.warehouse);
  const shades = [...shadeMap.values()]
    .map((s) => ({
      shade: s.shade,
      avail: baleCount(s.avail), sold: baleCount(s.sold), transit: baleCount(s.transit),
      received: baleCount([...s.avail, ...s.sold]),
      remT: s.avail.length, recT: s.avail.length + s.sold.length,
    }))
    .sort(thanMode
      ? (a, b) => b.remT - a.remT || b.recT - a.recT || String(a.shade).localeCompare(String(b.shade))
      : (a, b) => b.avail - a.avail || b.sold - a.sold || String(a.shade).localeCompare(String(b.shade)));
  session._shades = shades.map((s) => s.shade);
  session.step = 'pick_shade';
  sessionStore.set(userId, session);
  if (!shades.length) {
    await render(bot, chatId, userId,
      `📦 *${session.design} — ${session.warehouse}*\n\n_No rows for this design here._`,
      [backRow('⬅ Designs'), menuRow()]);
    return;
  }
  const rows = shades.map((s, i) => {
    const parts = [thanMode
      ? unitDisplayService.formatReceivedRemaining({ receivedBales: s.received, remainingThans: s.remT, receivedThans: s.recT })
      : `${s.avail}B · ${s.sold} sold`];
    if (s.transit) parts.push(`${s.transit}🚚`);
    return [{ text: buildShadeLabel(s.shade, nameMap, parts.join(' · ')), callback_data: `sds:s:${i}` }];
  });
  rows.push(backRow('⬅ Designs'));
  rows.push(menuRow());
  await render(bot, chatId, userId,
    `📦 *${session.design} — ${session.warehouse}*\nPick the shade (${thanMode ? 'received B · left t / received t' : 'available · sold'}):`, rows);
}

/* ─────────────────────── level 4: the card ─────────────────────── */

async function renderCard(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.shade === undefined || session.shade === null) return;
  let all = [];
  try { all = await inventoryRepository.getAll(); } catch (e) {
    logger.warn(`stockByShade: inventory read failed: ${e.message}`);
  }
  // §6c — quantities come from the TV-8 engine, never hardcoded.
  let label = null;
  try { label = await unitDisplayService.createQtyLabeller(all); } catch (_) { label = null; }
  const qty = (rows) => (label ? label(rows) : `${rows.length}t`);

  const { avail, sold, transit } = sliceRows(all, session, session.shade);

  let nameMap = new Map();
  try {
    const designAssetsRepo = require('../repositories/designAssetsRepository');
    nameMap = buildShadeNameMap(await designAssetsRepo.findActive(session.design));
  } catch (_) { /* numbers-only */ }
  const shadeHead = buildShadeLabel(session.shade, nameMap);

  // §6b — a printed number re-used across containers never merges; when the
  // card spans containers, every number carries its container.
  const containers = new Set([...avail, ...sold, ...transit].map((r) => upper(r.arrivalBatch)));
  const multiContainer = containers.size > 1;
  const ctag = (r) => (multiContainer ? ` · ${String(r.arrivalBatch).trim() || '(unlabelled)'}` : '');

  const groupBy = (rows, keyFn) => {
    const m = new Map();
    for (const r of rows) {
      const k = keyFn(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };

  let body = `📦 *${session.design} — ${session.warehouse}*\nShade *${shadeHead}*\n`;

  /* ✅ Available */
  const availBales = groupBy(avail, baleKey);
  body += `\n✅ *Available — ${balesWord(availBales.size)}*\n`;
  if (availBales.size) {
    const entries = [...availBales.entries()].sort((a, b) => byBaleNo(a[1][0].packageNo, b[1][0].packageNo));
    if (multiContainer) {
      // Group the comma list per container so re-used numbers read apart.
      const perCt = groupBy(entries.map(([, rows]) => rows), (rows) => String(rows[0].arrivalBatch).trim() || '(unlabelled)');
      body += [...perCt.entries()]
        .map(([ct, groups]) => `${ct}: ${groups.map((rows) => availLabel(rows, qty)).join(', ')}`)
        .join('\n');
      body += '\n';
    } else {
      body += `${entries.map(([, rows]) => availLabel(rows, qty)).join(', ')}\n`;
    }
  } else {
    body += '_none_\n';
  }

  /* 💰 Sold — SDS-2 (owner-confirmed layout, 08-Aug-2026): grouped by
   * date + customer so ten same-day sales to one buyer read as ONE
   * delivery event with its numbers together, not ten identical lines.
   *   26-Jul-26 — OKSON (10B)
   *   484, 499, 530, …
   * Oldest date first (AUD-ORD1); within a date, groups appear in
   * bale-number order. Part-sold bales keep their than tag inside the
   * list (9830 (3t)); multi-container cards keep the container tag on
   * each number; a row missing its date/customer groups under — / —,
   * visible, never hidden. */
  const soldGroups = groupBy(sold, (r) => `${baleKey(r)}|${normDay(r.soldDate)}|${upper(r.soldTo)}`);
  body += `\n💰 *Sold — ${balesWord(new Set(sold.map(baleKey)).size)}*\n`;
  if (soldGroups.size) {
    const baleEntries = [...soldGroups.values()]
      .sort((a, b) => String(normDay(a[0].soldDate)).localeCompare(String(normDay(b[0].soldDate)))
        || byBaleNo(a[0].packageNo, b[0].packageNo));
    const events = new Map(); // day|CUSTOMER → { day, customer, tokens } in day+number order
    let counted = 0;
    let dropped = 0;
    for (const rows of baleEntries) {
      const r = rows[0];
      if (counted >= SOLD_LINES_CAP) { dropped += 1; continue; }
      counted += 1;
      const day = normDay(r.soldDate);
      const customer = String(r.soldTo).trim() || '—';
      const k = `${day}|${upper(customer)}`;
      if (!events.has(k)) events.set(k, { day, customer, tokens: [] });
      const l = qty(rows);
      const part = l === '1B' ? '' : ` (${l})`;
      const tag = multiContainer ? ` ·${String(r.arrivalBatch).trim() || '(unlabelled)'}` : '';
      events.get(k).tokens.push(`${String(r.packageNo).trim()}${part}${tag}`);
    }
    body += [...events.values()]
      .map((e) => `${e.day ? fmtDate.short(e.day) : '—'} — ${e.customer} (${e.tokens.length}B)\n${e.tokens.join(', ')}`)
      .join('\n\n');
    if (dropped) body += `\n_…and ${dropped} more bale${dropped === 1 ? '' : 's'}_`;
    body += '\n';
  } else {
    body += '_none_\n';
  }

  /* 🚚 In transit — separate bucket, only when something is on the road. */
  const transitBales = groupBy(transit, baleKey);
  if (transitBales.size) {
    body += `\n🚚 *In transit — ${balesWord(transitBales.size)}*\n`;
    body += [...transitBales.values()]
      .sort((a, b) => byBaleNo(a[0].packageNo, b[0].packageNo))
      // The row's warehouse column holds the DESTINATION while in transit.
      .map((rows) => `${String(rows[0].packageNo).trim()} → ${String(rows[0].warehouse).trim() || '?'}${ctag(rows[0])}`)
      .join('\n');
    body += '\n';
  }

  session.step = 'view_card';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId, body.trimEnd(), [
    [{ text: '⬅ Shades', callback_data: 'sds:back' }, { text: '⬅ Designs', callback_data: 'sds:designs' }],
    menuRow(),
  ]);
}

/** One Available entry: plain number when the whole bale sits here, else
 *  the TV-8 remainder label — `9830 (2t left)`. */
function availLabel(rows, qty) {
  const l = qty(rows);
  const no = String(rows[0].packageNo).trim();
  return l === '1B' ? no : `${no} (${l} left)`;
}

/* ──────────────────────────── callbacks ─────────────────────────── */

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('sds:')) return false;
  const userId = String(query.from.id);
  const chatId = query.message.chat.id;
  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }
  if (data === 'sds:noop') return true;
  if (!(await canUse(userId))) {
    try {
      await bot.sendMessage(chatId, '🎨 Stock by shade is for admins and the Dispatch team.');
    } catch (_) { /* ignore */ }
    return true;
  }

  if (data === 'sds:start') {
    await start(bot, chatId, userId, query.message.message_id);
    return true;
  }

  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) {
    // Stale card from an expired session — restart at the warehouse picker.
    await start(bot, chatId, userId, query.message.message_id);
    return true;
  }
  session.flowMessageId = query.message.message_id;
  sessionStore.set(userId, session);

  if (data === 'sds:close') {
    sessionStore.clear(userId);
    try {
      await bot.editMessageText('🎨 Closed.', {
        chat_id: chatId, message_id: query.message.message_id,
        reply_markup: { inline_keyboard: [menuRow()] },
      });
    } catch (_) { /* ignore */ }
    return true;
  }

  if (data === 'sds:back') {
    if (session.step === 'view_card') { await renderShades(bot, chatId, userId); return true; }
    if (session.step === 'pick_shade') { session.page = 0; sessionStore.set(userId, session); await renderDesigns(bot, chatId, userId); return true; }
    await renderWarehouses(bot, chatId, userId);
    return true;
  }
  if (data === 'sds:designs') {
    session.page = 0;
    sessionStore.set(userId, session);
    await renderDesigns(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('sds:w:')) {
    const wh = (session._whs || [])[parseInt(data.slice(6), 10)];
    if (!wh) { await renderWarehouses(bot, chatId, userId); return true; }
    session.warehouse = wh;
    session.page = 0;
    sessionStore.set(userId, session);
    await renderDesigns(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('sds:pg:')) {
    session.page = parseInt(data.slice(7), 10) || 0;
    sessionStore.set(userId, session);
    await renderDesigns(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('sds:d:')) {
    const d = (session._designs || [])[parseInt(data.slice(6), 10)];
    if (!d) { await renderDesigns(bot, chatId, userId); return true; }
    session.design = d.design;
    sessionStore.set(userId, session);
    await renderShades(bot, chatId, userId);
    return true;
  }
  if (data.startsWith('sds:s:')) {
    const shade = (session._shades || [])[parseInt(data.slice(6), 10)];
    if (shade === undefined) { await renderShades(bot, chatId, userId); return true; }
    session.shade = shade;
    sessionStore.set(userId, session);
    await renderCard(bot, chatId, userId);
    return true;
  }
  logger.warn(`stockByShadeFlow: unhandled callback ${data}`);
  return true;
}

module.exports = {
  start, handleCallback, canUse, SESSION_TYPE,
  _internals: { renderWarehouses, renderDesigns, renderShades, renderCard, sliceRows, normDay, baleKey },
};
