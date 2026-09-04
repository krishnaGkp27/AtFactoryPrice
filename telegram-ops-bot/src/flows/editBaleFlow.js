'use strict';

/**
 * editBaleFlow — EDB-1 ✏️ Edit Bale (owner, 02-Sep-2026).
 *
 * The bale card is a picture of the sheet. When the physical bale differs
 * (the 6061 case: a 60-yd than that is really two 30-yd pieces), an admin
 * corrects the CARD in place until it matches the goods, and that becomes
 * ONE dual-admin approval. On approval the bot performs the matching
 * Update / Create on the Inventory sheet (services/baleEditService).
 *
 *   type the bale number → (pick the physical bale if the number lives in
 *   two stores / containers) → the card: header chips (design · shade ·
 *   indent), one chip per than, ➕ Add a than, 📎 Label photo, ✅ Send →
 *   two admins approve → the sheet changes.
 *
 * Tap-first: yards are the one genuine number — chips offer the lengths
 * already in the bale; a typed number is the fallback, validated. Status,
 * customer, price and warehouse are not editable here (other doors).
 *
 * Callback namespace `edb:`:
 *   edb:g:<i>          pick physical bale i (same number, two stores/containers)
 *   edb:t:<row>        open than on sheet row <row>       edb:y:<row>:<yd>  set its yards
 *   edb:yo:<row>       type a number for it               edb:yk:<row>      keep the original
 *   edb:add            add a than → chips                 edb:ay:<yd> / edb:ao   pick / type
 *   edb:ar:<i>         drop pending new than i
 *   edb:f:<field>      edit design|shade|indent           edb:fs:<n>        pick a shade tab
 *   edb:fk             keep the current header value
 *   edb:photo          attach the label photo             edb:send          submit
 *   edb:card           back to the card                   edb:back / edb:cancel / edb:noop
 */

const sessionStore = require('../utils/sessionStore');
const { makeRenderer, rowsFor, guardSession, chunk, mdEscape } = require('../utils/flowKit');
const inventoryRepository = require('../repositories/inventoryRepository');
const baleEdit = require('../services/baleEditService');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');
const { fmtQty } = require('../utils/format');
const fmtDate = require('../utils/formatDate');

const SESSION_TYPE = 'edit_bale_flow';
const ACTION = 'edit_bale';
const TTL_MS = 30 * 60 * 1000;
const MAX_CHIPS = 8;

const render = makeRenderer({});
const { cancelRow, menuRow } = rowsFor('edb');
const upper = (v) => String(v == null ? '' : v).trim().toUpperCase();

async function photoRequired() {
  try {
    const s = await require('../repositories/settingsRepository').getAll();
    const v = s.EDIT_BALE_PHOTO_REQUIRED;
    return v === undefined || v === null || v === '' ? true : Number(v) !== 0;
  } catch (_) { return true; }
}

/* ── entry ───────────────────────────────────────────────────────────── */

async function start(bot, chatId, userId, messageId = null) {
  if (!auth.isAdmin(String(userId))) {
    await require('../utils/telegramUI').editOrSend(bot, chatId, messageId, '✏️ Edit Bale is admin-only.',
      { reply_markup: { inline_keyboard: [menuRow()] } });
    return;
  }
  const old = sessionStore.get(userId);
  sessionStore.set(userId, {
    type: SESSION_TYPE, step: 'bale', ttlMs: TTL_MS,
    flowMessageId: messageId || (old && old.flowMessageId) || null,
  });
  await render(bot, chatId, userId,
    '✏️ *Edit Bale*\n\nType the bale number to correct — as printed on the label, e.g. *6061*.\n\n_You can change the design, shade, indent, the yards of each than, and add a than. Status, customer, price and warehouse have their own doors._',
    [cancelRow()]);
}

/* ── resolve the typed number ────────────────────────────────────────── */

async function resolveBale(bot, chatId, userId, raw) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const num = String(raw || '').trim().replace(/\s+/g, '').slice(0, 24);
  if (!num) { await start(bot, chatId, userId); return; }
  let rows = [];
  try { rows = (await inventoryRepository.getAll()).filter((r) => upper(r.packageNo) === upper(num)); } catch (e) {
    logger.warn(`editBaleFlow.resolve: ${e.message}`);
  }
  if (!rows.length) {
    await render(bot, chatId, userId,
      `✏️ *Edit Bale*\n\nNo bale *${mdEscape(num)}* on the sheet. Check the number on the label and type it again.`,
      [cancelRow()]);
    return;
  }
  const groups = [...baleEdit.groupPhysical(rows).values()];
  if (groups.length === 1) { await loadBale(bot, chatId, userId, groups[0]); return; }
  // Same printed number in two stores / containers — the operator says which (rule 6).
  session.step = 'group';
  session._groups = groups.map((g) => g.map((r) => r.rowIndex));
  sessionStore.set(userId, session);
  const chips = groups.map((g, i) => {
    const f = g[0];
    return [{ text: `${f.warehouse || '?'} · ${f.design || '?'}${f.arrivalBatch ? ` · 📦 ${f.arrivalBatch}` : ''} · ${g.length} than(s)`, callback_data: `edb:g:${i}` }];
  });
  await render(bot, chatId, userId,
    `✏️ *Edit Bale ${mdEscape(num)}*\n\nThis number lives in more than one place. Which physical bale is on the label in front of you?`,
    [...chips, cancelRow()]);
}

async function loadBale(bot, chatId, userId, rows) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const snap = baleEdit.snapshotOf(rows);
  const first = rows[0];
  session.step = 'card';
  session.packageNo = snap[0].packageNo;
  session.warehouse = snap[0].warehouse;
  session.arrivalBatch = snap[0].arrivalBatch;
  session.baleKey = require('../services/baleIdentity').baleKey(first);
  session.pricePerYard = Number(first.pricePerYard) || 0;
  session.rows = snap;
  session.edits = { header: {}, yards: {}, add: [] };
  session.photoFileId = '';
  session.photoKind = '';
  sessionStore.set(userId, session);
  await showCard(bot, chatId, userId);
}

/* ── the card ────────────────────────────────────────────────────────── */

function headerNow(session) {
  const h = session.edits.header || {};
  const f = session.rows[0] || {};
  return { design: h.design || f.design, shade: h.shade || f.shade, indent: h.indent || f.indent };
}

async function showCard(bot, chatId, userId, note = '') {
  const session = sessionStore.get(userId);
  if (!session || !session.rows) return;
  session.step = 'card';
  sessionStore.set(userId, session);
  const plan = baleEdit.buildPlan(session.rows, session.edits);
  const h = headerNow(session);
  const hdr = session.rows[0];
  const changed = plan.changeCount > 0;

  let text = `✏️ *Edit Bale ${mdEscape(session.packageNo)}* · ${mdEscape(h.design || '—')}${h.shade ? ` · #${mdEscape(h.shade)}` : ''} · ${mdEscape(session.warehouse || '—')}\n`;
  text += `Indent: ${mdEscape(h.indent || '—')}${session.arrivalBatch ? ` · 📦 ${mdEscape(session.arrivalBatch)}` : ''}\n`;
  text += `${plan.before.thans} thans · ${fmtQty(plan.before.yards)} yd`;
  if (changed && (plan.after.thans !== plan.before.thans || plan.after.yards !== plan.before.yards)) {
    text += `  →  *${plan.after.thans} thans · ${fmtQty(plan.after.yards)} yd*`;
  }
  for (const f of Object.keys(plan.header)) text += `\n${f}: ${mdEscape(hdr[f] || '—')} → *${mdEscape(plan.header[f])}*`;
  text += '\n';
  for (const r of session.rows) {
    const yc = plan.yardChanges.find((c) => c.rowIndex === r.rowIndex);
    const yd = yc ? `${yc.from} → *${yc.to}* yd` : `${r.yards} yd`;
    const st = r.status === 'sold' ? `🔴 sold → ${mdEscape(r.soldTo || '?')}${r.soldDate ? ` (${fmtDate(r.soldDate)})` : ''}`
      : r.status === 'in_transit' ? '🚚 in transit' : '🟢';
    text += `\n#${r.thanNo} · ${yd} · ${st}`;
  }
  for (const a of plan.adds) text += `\n🆕 #${a.thanNo} · *${a.yards}* yd · 🟢 new`;
  text += `\n\n📎 Label photo: ${session.photoFileId ? '✅ attached' : '❗ needed'}`;
  if (plan.soldYardsChanged) text += '\n⚠️ A sold than changes yards — the customer was billed for the old figure. Reconcile later; not part of this edit.';
  text += `\n_${plan.changeCount} change(s) pending_`;
  if (note) text += `\n${note}`;

  const rows = [];
  rows.push([
    { text: `🧵 ${h.design || 'Design'}`, callback_data: 'edb:f:design' },
    { text: `🎨 #${h.shade || '?'}`, callback_data: 'edb:f:shade' },
    { text: `🧾 ${h.indent || 'Indent'}`, callback_data: 'edb:f:indent' },
  ]);
  const thanChips = session.rows.map((r) => {
    const yc = plan.yardChanges.find((c) => c.rowIndex === r.rowIndex);
    return { text: `#${r.thanNo} · ${yc ? yc.to : r.yards} yd${yc ? ' ✎' : ''}`, callback_data: `edb:t:${r.rowIndex}` };
  });
  rows.push(...chunk(thanChips, 2));
  plan.adds.forEach((a, i) => rows.push([{ text: `🆕 #${a.thanNo} · ${a.yards} yd  ✖ drop`, callback_data: `edb:ar:${i}` }]));
  rows.push([{ text: '➕ Add a than', callback_data: 'edb:add' }]);
  rows.push([{ text: session.photoFileId ? '📎 Replace label photo' : '📎 Label photo', callback_data: 'edb:photo' }]);
  if (changed) rows.push([{ text: `✅ Send for approval (${plan.changeCount})`, callback_data: 'edb:send' }]);
  rows.push([{ text: '⬅ Another bale', callback_data: 'edb:back' }], cancelRow());
  await render(bot, chatId, userId, text, rows);
}

/* ── yards ───────────────────────────────────────────────────────────── */

function yardChips(session) {
  const seen = new Set();
  for (const r of session.rows) seen.add(r.yards);
  for (const v of Object.values(session.edits.yards || {})) { const n = baleEdit.parseYards(v); if (n) seen.add(n); }
  for (const a of session.edits.add || []) { const n = baleEdit.parseYards(a.yards); if (n) seen.add(n); }
  return [...seen].filter((n) => n > 0).sort((a, b) => a - b).slice(0, MAX_CHIPS);
}

async function openThan(bot, chatId, userId, rowIndex) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const r = (session.rows || []).find((x) => String(x.rowIndex) === String(rowIndex));
  if (!r) { await showCard(bot, chatId, userId); return; }
  if (r.status === 'in_transit') { await showCard(bot, chatId, userId, '🚚 That than is in transit — it can be edited once it is received.'); return; }
  session.step = 'yards';
  session._row = r.rowIndex;
  sessionStore.set(userId, session);
  const cur = session.edits.yards[r.rowIndex];
  const chips = yardChips(session).map((y) => ({ text: `${y} yd`, callback_data: `edb:y:${r.rowIndex}:${y}` }));
  const rows = chunk(chips, 4);
  rows.push([{ text: '✏️ Other number', callback_data: `edb:yo:${r.rowIndex}` }]);
  if (cur != null) rows.push([{ text: `↩ Keep the original (${r.yards} yd)`, callback_data: `edb:yk:${r.rowIndex}` }]);
  rows.push([{ text: '⬅ Back to card', callback_data: 'edb:card' }]);
  await render(bot, chatId, userId,
    `✏️ *Bale ${mdEscape(session.packageNo)} · than #${r.thanNo}* — now *${r.yards} yd*${r.status === 'sold' ? ` (sold → ${mdEscape(r.soldTo || '?')})` : ''}\n\nWhat does the label / the piece say?`,
    rows);
}

async function openAdd(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  session.step = 'add';
  sessionStore.set(userId, session);
  const chips = yardChips(session).map((y) => ({ text: `${y} yd`, callback_data: `edb:ay:${y}` }));
  const rows = chunk(chips, 4);
  rows.push([{ text: '✏️ Other number', callback_data: 'edb:ao' }]);
  rows.push([{ text: '⬅ Back to card', callback_data: 'edb:card' }]);
  await render(bot, chatId, userId,
    `✏️ *Bale ${mdEscape(session.packageNo)}* — add a than\n\nHow many yards is the extra piece? It becomes the next than number, available.`,
    rows);
}

/* ── header fields ───────────────────────────────────────────────────── */

const FIELD_LABEL = { design: 'design number', shade: 'shade (colour) number', indent: 'indent' };

async function openField(bot, chatId, userId, field) {
  const session = sessionStore.get(userId);
  if (!session || !baleEdit.EDITABLE_HEADER.includes(field)) return;
  session.step = 'field';
  session._field = field;
  sessionStore.set(userId, session);
  const h = headerNow(session);
  const rows = [];
  if (field === 'shade') {
    try {
      const asset = await require('../repositories/designAssetsRepository').findActive(h.design, session.arrivalBatch);
      const tabs = ((asset && asset.shades) || []).slice(0, MAX_CHIPS);
      if (tabs.length) rows.push(...chunk(tabs.map((s) => ({ text: `${s.number}${s.name ? ` - ${s.name}` : ''}`, callback_data: `edb:fs:${s.number}` })), 2));
    } catch (_) { /* typed only */ }
  }
  if (session.edits.header[field]) rows.push([{ text: `↩ Keep ${session.rows[0][field] || '—'}`, callback_data: 'edb:fk' }]);
  rows.push([{ text: '⬅ Back to card', callback_data: 'edb:card' }]);
  await render(bot, chatId, userId,
    `✏️ *Bale ${mdEscape(session.packageNo)}* — ${FIELD_LABEL[field]}\nNow: *${mdEscape(h[field] || '—')}*\n\n${field === 'shade' && rows.length > 2 ? 'Tap the tab number from the shade book, or type it.' : 'Type it exactly as printed on the label.'}`,
    rows);
}

/* ── text intake ─────────────────────────────────────────────────────── */

async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const chatId = msg.chat.id;
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE) return false;
  const text = String(msg.text || '').trim();
  if (!text) return false;
  if (session.step === 'bale') { await resolveBale(bot, chatId, userId, text); return true; }
  if (session.step === 'yards_typed' || session.step === 'add_typed') {
    const n = baleEdit.parseYards(text);
    if (n == null) {
      await bot.sendMessage(chatId, `⚠️ Enter the yards as a number between 1 and ${baleEdit.MAX_YARDS} (one decimal at most), e.g. 30 or 27.5.`);
      return true;
    }
    if (session.step === 'yards_typed') session.edits.yards[session._row] = n;
    else session.edits.add.push({ yards: n });
    sessionStore.set(userId, session);
    await showCard(bot, chatId, userId);
    return true;
  }
  if (session.step === 'field') {
    const v = text.replace(/[\r\n]+/g, ' ').slice(0, 24);
    session.edits.header[session._field] = v;
    sessionStore.set(userId, session);
    await showCard(bot, chatId, userId);
    return true;
  }
  return false;
}

/* ── photo intake ────────────────────────────────────────────────────── */

async function handleFile(bot, chatId, userId, msg) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== SESSION_TYPE || session.step !== 'photo') return false;
  let fileId = ''; let kind = '';
  if (msg.document) {
    if (!/^image\//i.test(String(msg.document.mime_type || ''))) { await bot.sendMessage(chatId, '⚠️ Send a picture of the label (photo or image file).'); return true; }
    fileId = msg.document.file_id; kind = 'document';
  } else if (Array.isArray(msg.photo) && msg.photo.length) {
    fileId = msg.photo[msg.photo.length - 1].file_id; kind = 'photo';
  } else return false;
  session.photoFileId = fileId;
  session.photoKind = kind;
  sessionStore.set(userId, session);
  await showCard(bot, chatId, userId, '📎 Label photo attached.');
  return true;
}

/* ── submit ──────────────────────────────────────────────────────────── */

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || !session.rows) return;
  if (session._submitting) return;
  const plan = baleEdit.buildPlan(session.rows, session.edits);
  if (!plan.changeCount) { await showCard(bot, chatId, userId, 'Nothing changed yet.'); return; }
  if (!session.photoFileId && await photoRequired()) {
    await showCard(bot, chatId, userId, '❗ Attach the label photo first — the picture is the evidence the two approving admins sign against.');
    return;
  }
  const approvalQueueRepository = require('../repositories/approvalQueueRepository');
  const pending = await approvalQueueRepository.getAllPending();
  const dup = pending.find((p) => p.actionJSON && p.actionJSON.action === ACTION
    && upper(p.actionJSON.packageNo) === upper(session.packageNo) && upper(p.actionJSON.warehouse) === upper(session.warehouse));
  if (dup) {
    await showCard(bot, chatId, userId, `⚠️ An edit of bale ${mdEscape(session.packageNo)} is already awaiting approval (${mdEscape(require('../services/approvalCards').shortRequestRef(dup.requestId))}).`);
    return;
  }
  session._submitting = true;
  sessionStore.set(userId, session);
  await render(bot, chatId, userId, '⏳ Sending for approval…', []);

  const h = headerNow(session);
  const aj = {
    action: ACTION,
    packageNo: session.packageNo, warehouse: session.warehouse, arrivalBatch: session.arrivalBatch || '',
    baleKey: session.baleKey, design: h.design, shade: h.shade, indent: h.indent,
    snapshot: session.rows, edits: session.edits,
    label_file_id: session.photoFileId || '', label_file_kind: session.photoKind || '',
    summary: { before: plan.before, after: plan.after, changeCount: plan.changeCount, soldYardsChanged: plan.soldYardsChanged },
    requestedBy: String(userId),
  };
  const risk = await require('../risk/evaluate').evaluate({ action: ACTION, userId: String(userId) });
  const requestId = require('../utils/idGenerator').requestId();
  try {
    await approvalQueueRepository.append({
      requestId, user: String(userId), actionJSON: aj,
      riskReason: risk.reason || 'dual_admin_required', status: 'pending',
    });
    try {
      await require('../repositories/auditLogRepository').append('approval_queued',
        { requestId, action: ACTION, packageNo: session.packageNo, changes: baleEdit.describePlan(plan) }, String(userId));
    } catch (_) { /* best effort */ }
    const approvalCards = require('../services/approvalCards');
    const summary = `✏️ Edit bale ${session.packageNo} · ${h.design || '?'} · ${session.warehouse || '?'} — ${plan.changeCount} change(s): ${baleEdit.describePlan(plan).join('; ')}`;
    const opts = session.photoKind === 'photo' && session.photoFileId
      ? { previewPhoto: session.photoFileId, previewCaption: `📎 Label of bale ${session.packageNo} — the evidence for this edit` }
      : {};
    await require('../events/approvalEvents').notifyAdminsApprovalRequest(bot, requestId,
      await approvalCards.resolveUserLabel(userId, bot), summary,
      risk.reason || 'dual_admin_required', String(userId), opts);
    await render(bot, chatId, userId,
      `⏳ *Submitted for approval*\n\nBale *${mdEscape(session.packageNo)}* · ${mdEscape(h.design || '')} · ${mdEscape(session.warehouse || '')}\n${baleEdit.describePlan(plan).map((l) => `• ${mdEscape(l)}`).join('\n')}\nRequest: \`${requestId}\`\n\nA second admin must approve — you cannot approve your own. The sheet changes the moment they do.`,
      [menuRow()]);
    sessionStore.clear(userId);
  } catch (e) {
    logger.error(`editBaleFlow.submit failed: ${e.message}`);
    const s = sessionStore.get(userId);
    if (s) { s._submitting = false; sessionStore.set(userId, s); }
    await showCard(bot, chatId, userId, `⚠️ Could not send: ${mdEscape(e.message)} — tap ✅ Send again.`);
  }
}

/* ── dispatcher ──────────────────────────────────────────────────────── */

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('edb:')) return false;
  const rest = data.slice(4);
  if (rest === 'noop') { try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ } return true; }
  const g = await guardSession(bot, query, SESSION_TYPE, { expiredText: '⏳ The Edit Bale session expired — open ✏️ Edit Bale again.' });
  if (!g) return true;
  const { session, chatId, userId } = g;

  if (rest === 'cancel') {
    sessionStore.clear(userId);
    await require('../utils/telegramUI').editOrSend(bot, chatId, session.flowMessageId, '❌ Edit Bale cancelled. Nothing was changed.',
      { reply_markup: { inline_keyboard: [menuRow()] } });
    return true;
  }
  if (rest === 'back') { await start(bot, chatId, userId, session.flowMessageId); return true; }
  if (rest === 'card') { await showCard(bot, chatId, userId); return true; }
  if (rest.startsWith('g:')) {
    const idx = parseInt(rest.slice(2), 10);
    const rowIdx = (session._groups || [])[idx];
    if (!rowIdx) return true;
    const all = await inventoryRepository.getAll();
    const rows = all.filter((r) => rowIdx.includes(r.rowIndex));
    if (rows.length) await loadBale(bot, chatId, userId, rows);
    return true;
  }
  if (rest.startsWith('t:')) { await openThan(bot, chatId, userId, parseInt(rest.slice(2), 10)); return true; }
  if (rest.startsWith('y:')) {
    const [ri, yd] = rest.slice(2).split(':');
    const n = baleEdit.parseYards(yd);
    if (n != null) session.edits.yards[ri] = n;
    sessionStore.set(userId, session);
    await showCard(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('yk:')) { delete session.edits.yards[rest.slice(3)]; sessionStore.set(userId, session); await showCard(bot, chatId, userId); return true; }
  if (rest.startsWith('yo:')) {
    session.step = 'yards_typed'; session._row = parseInt(rest.slice(3), 10); sessionStore.set(userId, session);
    await render(bot, chatId, userId, `✏️ Type the yards for than #${(session.rows.find((r) => r.rowIndex === session._row) || {}).thanNo || '?'} (a number, e.g. 30):`, [[{ text: '⬅ Back to card', callback_data: 'edb:card' }]]);
    return true;
  }
  if (rest === 'add') { await openAdd(bot, chatId, userId); return true; }
  if (rest.startsWith('ay:')) {
    const n = baleEdit.parseYards(rest.slice(3));
    if (n != null) session.edits.add.push({ yards: n });
    sessionStore.set(userId, session);
    await showCard(bot, chatId, userId);
    return true;
  }
  if (rest === 'ao') {
    session.step = 'add_typed'; sessionStore.set(userId, session);
    await render(bot, chatId, userId, '✏️ Type the yards of the extra piece (a number, e.g. 30):', [[{ text: '⬅ Back to card', callback_data: 'edb:card' }]]);
    return true;
  }
  if (rest.startsWith('ar:')) {
    const i = parseInt(rest.slice(3), 10);
    if (Number.isInteger(i)) session.edits.add.splice(i, 1);
    sessionStore.set(userId, session);
    await showCard(bot, chatId, userId);
    return true;
  }
  if (rest.startsWith('f:')) { await openField(bot, chatId, userId, rest.slice(2)); return true; }
  if (rest.startsWith('fs:')) {
    if (session._field === 'shade') session.edits.header.shade = rest.slice(3);
    sessionStore.set(userId, session);
    await showCard(bot, chatId, userId);
    return true;
  }
  if (rest === 'fk') {
    if (session._field) delete session.edits.header[session._field];
    sessionStore.set(userId, session);
    await showCard(bot, chatId, userId);
    return true;
  }
  if (rest === 'photo') {
    session.step = 'photo'; sessionStore.set(userId, session);
    await render(bot, chatId, userId, `📎 Send a picture of the label of bale *${mdEscape(session.packageNo)}* — a photo is fine here (it is evidence, not a catalogue picture).`,
      [[{ text: '⬅ Back to card', callback_data: 'edb:card' }]]);
    return true;
  }
  if (rest === 'send') { await submit(bot, chatId, userId); return true; }
  return true;
}

module.exports = { SESSION_TYPE, ACTION, start, handleCallback, handleText, handleFile, _internals: { yardChips } };
