'use strict';

/**
 * src/flows/landedCostFlow.js — LANDED-COST C1.
 *
 * Admin-only flow to finalize the landed cost of a Goods Receipt (GRN).
 * Reaches the dual-admin-gated `finalize_landed_cost` action.
 *
 * Owner brief (2026-05-21): admin defines USD cost-per-yard for the
 * goods, lists the fixed import charges (clearance, clearing agent,
 * logistics, etc.), bot allocates charges across yardage, locks the
 * FX rate at receipt, and shows the NGN landed cost per yard for
 * 2nd-admin sanity check before sealing the numbers.
 *
 * Steps (single anchored card, UX-C1 standard — Back + Cancel at every
 * step, errors re-render the card with retry/cancel keyboard):
 *
 *   1. pick_grn           — paginated list of provisional GRNs
 *   2. confirm_grn        — preview chosen GRN, "Start"
 *   3. await_usd_per_yard — admin types USD cost-per-yard
 *   4. await_charges      — pick type from catalogue → enter amount → repeat
 *                            (renders running total + table)
 *   5. confirm_fx         — bot resolves USD→NGN from ForexRates (manual
 *                            provider). If no rate is on file the card
 *                            explains how to set one and stops.
 *   6. preview            — full breakdown + Submit / Back / Cancel
 *   7. submitted          — request goes into approval queue; admin
 *                            sees confirmation with request ID.
 *
 * Session shape (type: 'landed_cost_flow'):
 *   {
 *     step,
 *     flowMessageId, startedAt,
 *     grnId, grn,
 *     usdPerYard,
 *     charges: [{type_id, type_name, amount_usd}],
 *     pendingChargeTypeId, pendingChargeTypeName,  // mid-step state
 *     fxRate, fxSource, fxDate,
 *   }
 *
 * Callback namespace `lcost:*`:
 *   lcost:cancel
 *   lcost:back              (step-aware: returns to previous step)
 *   lcost:pick_grn:<id>
 *   lcost:start             (proceed past confirm_grn)
 *   lcost:pick_type:<id>
 *   lcost:add_more          (after entering a charge, add another)
 *   lcost:done_charges      (finalise the charges list)
 *   lcost:retry_fx
 *   lcost:submit
 */

const sessionStore               = require('../utils/sessionStore');
const { makeRenderer, rowsFor } = require('../utils/flowKit');
const goodsReceiptsRepository    = require('../repositories/goodsReceiptsRepository');
const landedCostTypesRepository  = require('../repositories/landedCostTypesRepository');
const landedCostService          = require('../services/landedCostService');
const approvalEvents             = require('../events/approvalEvents');
const auth                       = require('../middlewares/auth');
const logger                     = require('../utils/logger');

const MAX_CHARGE_AMOUNT = 10_000_000; // $10M sanity ceiling per single charge

// ---------------------------------------------------------------------------
// Rendering helpers (single anchored card; UX-C1)
// ---------------------------------------------------------------------------

// Anchored edit-else-send renderer — shared flowKit implementation.
const render = makeRenderer({ requireSession: true });

const { cancelRow, backRow } = rowsFor('lcost');

async function renderError(bot, chatId, userId, errorText) {
  const session = sessionStore.get(userId);
  if (!session) {
    await bot.sendMessage(chatId, `⚠️ ${errorText}`);
    return;
  }
  await render(bot, chatId, userId, `⚠️ ${errorText}`, [
    backRow(),
    cancelRow(),
  ]);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function start(bot, chatId, userId, messageId) {
  if (!auth.isAdmin(userId)) {
    await bot.sendMessage(chatId, '💵 Finalize Landed Cost is admin-only.');
    return;
  }
  sessionStore.set(userId, {
    type: 'landed_cost_flow',
    step: 'pick_grn',
    flowMessageId: messageId || null,
    startedAt: new Date().toISOString(),
    grnId: '',
    usdPerYard: 0,
    charges: [],
    fxRate: 0,
  });
  await renderGrnPicker(bot, chatId, userId);
}

async function renderGrnPicker(bot, chatId, userId) {
  const provisional = await landedCostService.listProvisional();
  if (!provisional.length) {
    sessionStore.clear(userId);
    await render(bot, chatId, userId,
      '💵 *Finalize Landed Cost*\n\n_No provisional GRNs found — every receipt is already finalized._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return;
  }
  const rows = provisional.slice(0, 10).map((g) => ([{
    text: `📦 ${g.grn_id} · ${g.warehouse || '—'} · ${g.total_bales}b/${g.total_yards}y`,
    callback_data: `lcost:pick_grn:${g.grn_id}`,
  }]));
  if (provisional.length > 10) {
    rows.push([{ text: `… ${provisional.length - 10} more (refine via Receive Goods view)`, callback_data: 'lcost:noop' }]);
  }
  rows.push(cancelRow());
  await render(bot, chatId, userId,
    `💵 *Finalize Landed Cost*\n\n*${provisional.length}* GRN(s) awaiting cost finalisation. Pick one:`,
    rows,
  );
}

// ---------------------------------------------------------------------------
// Step transitions
// ---------------------------------------------------------------------------

async function pickGrn(bot, chatId, userId, grnId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'landed_cost_flow') return;
  const grn = await goodsReceiptsRepository.getById(grnId);
  if (!grn) { await renderError(bot, chatId, userId, `GRN ${grnId} not found.`); return; }
  if (grn.lc_status === 'finalized') {
    await renderError(bot, chatId, userId, `GRN \`${grnId}\` is already finalized.`);
    return;
  }
  if (grn.lc_status === 'pending_approval') {
    await renderError(bot, chatId, userId, `GRN \`${grnId}\` already has a pending finalize request (\`${grn.lc_request_id}\`).`);
    return;
  }
  session.grnId = grnId;
  session.grn = grn;
  session.step = 'await_usd_per_yard';
  sessionStore.set(userId, session);

  await render(bot, chatId, userId,
    `📦 *GRN \`${grn.grn_id}\`*\n`
    + `• Warehouse: *${grn.warehouse || '—'}*\n`
    + `• Supplier:  ${grn.supplier || '—'}\n`
    + `• Bales / Yards: ${grn.total_bales} / ${grn.total_yards}\n`
    + `• Received: ${grn.received_at?.slice(0, 10) || '—'}\n\n`
    + 'Step 1 of 3 — *USD cost per yard*\n\n'
    + 'Reply with the per-yard USD cost paid to the supplier.\nExample: `2.45`\n\n'
    + '_The total USD value will be `usd_per_yard × yards` plus the charges you enter next._',
    [backRow(), cancelRow()],
  );
}

// Text handler — applies in steps await_usd_per_yard and await_charge_amount.
async function handleText(bot, msg) {
  const userId = String(msg.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'landed_cost_flow') return false;
  const chatId = msg.chat.id;
  const raw = (msg.text || '').trim();
  if (raw.startsWith('/')) return false; // let commands pass through

  if (session.step === 'await_usd_per_yard') {
    const v = parseFloat(raw);
    if (!isFinite(v) || v <= 0 || v > 10000) {
      await renderError(bot, chatId, userId, 'USD cost per yard must be a positive number ≤ 10,000.');
      return true;
    }
    session.usdPerYard = +v.toFixed(6);
    session.step = 'await_charges';
    sessionStore.set(userId, session);
    await renderChargeTypePicker(bot, chatId, userId);
    return true;
  }

  if (session.step === 'await_charge_amount') {
    const v = parseFloat(raw);
    if (!isFinite(v) || v <= 0 || v > MAX_CHARGE_AMOUNT) {
      await renderError(bot, chatId, userId, `Charge amount must be a positive USD figure ≤ ${MAX_CHARGE_AMOUNT.toLocaleString()}.`);
      return true;
    }
    session.charges = session.charges || [];
    session.charges.push({
      type_id: session.pendingChargeTypeId,
      type_name: session.pendingChargeTypeName,
      amount_usd: +v.toFixed(4),
    });
    session.pendingChargeTypeId = '';
    session.pendingChargeTypeName = '';
    session.step = 'await_charges';
    sessionStore.set(userId, session);
    await renderChargeTypePicker(bot, chatId, userId);
    return true;
  }

  return false;
}

async function renderChargeTypePicker(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  const types = await landedCostTypesRepository.getActive();
  const used = new Set((session.charges || []).map((c) => c.type_id));
  const rows = [];
  for (const t of types) {
    const tag = used.has(t.type_id) ? ' ✓' : '';
    rows.push([{ text: `${t.type_name}${tag}`, callback_data: `lcost:pick_type:${t.type_id}` }]);
  }
  if (session.charges && session.charges.length) {
    rows.push([{ text: '✅ Done — preview', callback_data: 'lcost:done_charges' }]);
  }
  rows.push(backRow());
  rows.push(cancelRow());

  const total = (session.charges || []).reduce((s, c) => s + c.amount_usd, 0);
  let text = `📦 *GRN \`${session.grnId}\`*\n`
    + `• USD / yard: *$${landedCostService._internals.fmt(session.usdPerYard)}*\n\n`
    + 'Step 2 of 3 — *Container charges*\n\n';
  if (session.charges && session.charges.length) {
    text += 'Entered so far:\n';
    for (const c of session.charges) {
      text += `  • ${landedCostService._internals.escapeMd(c.type_name)}: $${landedCostService._internals.fmt(c.amount_usd)}\n`;
    }
    text += `  *Total charges: $${landedCostService._internals.fmt(total)}*\n\n`;
  }
  text += 'Pick a charge type to add (re-tap a type with ✓ to add a 2nd entry):\nTap *✅ Done* when finished — at least 1 charge is recommended but not required.';
  await render(bot, chatId, userId, text, rows);
}

async function pickChargeType(bot, chatId, userId, typeId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'landed_cost_flow') return;
  const t = await landedCostTypesRepository.getById(typeId);
  if (!t) { await renderError(bot, chatId, userId, 'Charge type not found.'); return; }
  session.pendingChargeTypeId = t.type_id;
  session.pendingChargeTypeName = t.type_name;
  session.step = 'await_charge_amount';
  sessionStore.set(userId, session);
  await render(bot, chatId, userId,
    `Step 2 of 3 — *${t.type_name}*\n\n`
    + `Reply with the *USD amount* for this charge.\nExample: \`1500\` (no dollar sign needed).`,
    [backRow(), cancelRow()],
  );
}

async function doneCharges(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'landed_cost_flow') return;
  // Resolve FX rate.
  const fx = await landedCostService.resolveFxRate({ baseDate: (session.grn.received_at || '').slice(0, 10) });
  if (!fx.rate) {
    // No manual rate on file → tell admin how to fix it and stop.
    session.step = 'fx_missing';
    sessionStore.set(userId, session);
    await render(bot, chatId, userId,
      `⚠️ *No FX rate on file*\n\n`
      + `The manual ForexRates sheet has no USD→NGN rate on or before \`${fx.date}\`.\n\n`
      + '*To fix:*  open the `ForexRates` Google Sheet and add a row\n'
      + '`<date> | USD | NGN | <rate> | admin | <your TG id> | <ISO time> | <notes>`\n\n'
      + 'Then tap *🔁 Retry FX lookup* below.',
      [
        [{ text: '🔁 Retry FX lookup', callback_data: 'lcost:retry_fx' }],
        backRow(),
        cancelRow(),
      ],
    );
    return;
  }
  session.fxRate = fx.rate;
  session.fxSource = fx.source;
  session.fxDate = fx.date;
  session.step = 'preview';
  sessionStore.set(userId, session);
  await renderPreview(bot, chatId, userId);
}

async function renderPreview(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'landed_cost_flow') return;
  let allocation;
  try {
    allocation = landedCostService.computeAllocation({
      totalYards: session.grn.total_yards,
      usdPerYard: session.usdPerYard,
      charges: session.charges || [],
      fxRate: session.fxRate,
    });
  } catch (e) {
    await renderError(bot, chatId, userId, e.message);
    return;
  }
  const text = landedCostService.buildPreviewText({
    grn: session.grn,
    usdPerYard: session.usdPerYard,
    charges: session.charges || [],
    allocation,
  });
  await render(bot, chatId, userId, text + `\n\n_FX source: ${session.fxSource} (${session.fxDate})_`, [
    [{ text: '✅ Submit for approval', callback_data: 'lcost:submit' }],
    backRow(),
    cancelRow(),
  ]);
}

async function submit(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'landed_cost_flow') return;
  try {
    const { requestId, allocation } = await landedCostService.submitForApproval({
      grnId: session.grnId,
      userId,
      usdPerYard: session.usdPerYard,
      charges: session.charges || [],
      fxRate: session.fxRate,
    });

    const isAdm = auth.isAdmin(userId);
    const excludeId = isAdm ? userId : undefined;
    // APU-1: the 2nd admin previously saw only GRN id + ₦/yd — now the full
    // costing they are sealing: USD/yd, per-charge lines, FX, total yards.
    const fmt = landedCostService._internals.fmt;
    const chargeLines = (session.charges || []).map((c) => `  • ${c.type_name || 'charge'}: $${fmt(c.amount_usd)}`).join('\n');
    const card = `💵 Finalize Landed Cost Request\nGRN: ${session.grnId}`
      + `\nUSD cost/yard: $${fmt(session.usdPerYard)}`
      + `\nFX rate: ₦${fmt(session.fxRate)}/$`
      + (chargeLines ? `\nCharges:\n${chargeLines}` : '\nCharges: none')
      + `\nTotal yards: ${fmt(allocation.totalYards)}`
      + `\nNGN landed/yard (sealed on approval): ₦${fmt(allocation.ngnLandedPerYard)}`;
    await approvalEvents.notifyAdminsApprovalRequest(bot, requestId,
      await require('../services/approvalCards').resolveUserLabel(userId), card,
      'All landed cost finalization operations require 2nd admin approval.', excludeId);

    await render(bot, chatId, userId,
      '⏳ *Submitted for approval*\n\n'
      + `• GRN: \`${session.grnId}\`\n`
      + `• Request: \`${requestId}\`\n`
      + `• NGN / yard (preview): *₦${landedCostService._internals.fmt(allocation.ngnLandedPerYard)}*\n`
      + '• Approver: 2nd admin (you cannot self-approve)\n\n'
      + '_Once approved the numbers are sealed onto the GRN row. Sales / margin reports will read them automatically._',
      [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]],
    );
    sessionStore.clear(userId);
    logger.info(`landedCostFlow.submit: grn=${session.grnId} request=${requestId} by=${userId} ngn/yd=${allocation.ngnLandedPerYard}`);
  } catch (e) {
    await renderError(bot, chatId, userId, e.message || 'Failed to submit.');
  }
}

// ---------------------------------------------------------------------------
// Callback dispatcher
// ---------------------------------------------------------------------------

async function handleCallback(bot, query) {
  const data = query.data || '';
  if (!data.startsWith('lcost:')) return false;
  const chatId = query.message?.chat?.id;
  const userId = String(query.from.id);
  const session = sessionStore.get(userId);
  if (!session || session.type !== 'landed_cost_flow') return false;

  try { await bot.answerCallbackQuery(query.id); } catch (_) { /* ignore */ }

  if (data === 'lcost:cancel') {
    sessionStore.clear(userId);
    await render(bot, chatId, userId, '❌ Cancelled.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
    return true;
  }
  if (data === 'lcost:noop') return true;

  if (data === 'lcost:back') {
    await stepBack(bot, chatId, userId);
    return true;
  }

  if (data.startsWith('lcost:pick_grn:')) {
    const grnId = data.slice('lcost:pick_grn:'.length);
    await pickGrn(bot, chatId, userId, grnId);
    return true;
  }

  if (data.startsWith('lcost:pick_type:')) {
    const typeId = data.slice('lcost:pick_type:'.length);
    await pickChargeType(bot, chatId, userId, typeId);
    return true;
  }

  if (data === 'lcost:done_charges') {
    await doneCharges(bot, chatId, userId);
    return true;
  }

  if (data === 'lcost:retry_fx') {
    session.step = 'await_charges';
    sessionStore.set(userId, session);
    await doneCharges(bot, chatId, userId);
    return true;
  }

  if (data === 'lcost:submit') {
    await submit(bot, chatId, userId);
    return true;
  }

  return false;
}

async function stepBack(bot, chatId, userId) {
  const session = sessionStore.get(userId);
  if (!session) return;
  switch (session.step) {
    case 'await_usd_per_yard':
    case 'fx_missing':
      session.step = 'pick_grn';
      session.grnId = '';
      session.grn = null;
      session.usdPerYard = 0;
      sessionStore.set(userId, session);
      await renderGrnPicker(bot, chatId, userId);
      break;
    case 'await_charges':
      session.step = 'await_usd_per_yard';
      session.charges = [];
      sessionStore.set(userId, session);
      await render(bot, chatId, userId,
        `📦 *GRN \`${session.grnId}\`*\n\nStep 1 of 3 — *USD cost per yard*\n\nReply with the per-yard USD cost.`,
        [backRow(), cancelRow()]);
      break;
    case 'await_charge_amount':
      session.step = 'await_charges';
      session.pendingChargeTypeId = '';
      session.pendingChargeTypeName = '';
      sessionStore.set(userId, session);
      await renderChargeTypePicker(bot, chatId, userId);
      break;
    case 'preview':
      session.step = 'await_charges';
      sessionStore.set(userId, session);
      await renderChargeTypePicker(bot, chatId, userId);
      break;
    default:
      sessionStore.clear(userId);
      await render(bot, chatId, userId, '❌ Cancelled.', [[{ text: '🏠 Menu', callback_data: 'act:__back__' }]]);
  }
}

module.exports = {
  start,
  handleCallback,
  handleText,
  // exposed for smoke
  _internals: { renderChargeTypePicker, renderPreview, submit, doneCharges, pickChargeType, pickGrn, stepBack },
};
