'use strict';

/**
 * CUR-1 R8 (as recommended) — landed cost is side B: the sealed NGN rate and
 * the FX rate print BARE with 2 dp (the rate is fractional by construction,
 * landedCostService 4 dp), never `₦`. The USD input lines keep `$` (a
 * foreign cost, not the home unit). The pair leg is named by money.code()
 * as a label, not printed as a unit on a figure.
 *
 * Pins both cards the submit step sends: the 2nd-admin approval card and
 * the requester's "Submitted for approval" card.
 */

process.env.ADMIN_IDS = '777,888';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createFakeBot } = require('../../helpers/fakeBot');
const sessionStore = require('../../../src/utils/sessionStore');
const landedCostService = require('../../../src/services/landedCostService');
const approvalEvents = require('../../../src/events/approvalEvents');
const approvalCards = require('../../../src/services/approvalCards');
const flow = require('../../../src/flows/landedCostFlow');

const USER = '777';

function lastText(bot) {
  const c = bot.calls.filter((x) => x.method === 'sendMessage' || x.method === 'editMessageText');
  return c.length ? String(c[c.length - 1].args.text || '') : '';
}

/** Run submit() with the service + approval fan-out stubbed; returns both cards. */
async function runSubmit({ fxRate = 1520, ngnLandedPerYard = 6080.4567, usdPerYard = 2 } = {}) {
  sessionStore.clear(USER);
  sessionStore.set(USER, {
    type: 'landed_cost_flow', step: 'preview', grnId: 'GRN-7',
    grn: { grn_id: 'GRN-7', total_yards: 1000 },
    usdPerYard, charges: [{ type_name: 'Freight', amount_usd: 1500 }],
    fxRate, fxSource: 'manual', fxDate: '2026-09-01',
    flowMessageId: null, startedAt: Date.now(),
  });
  const origSubmit = landedCostService.submitForApproval;
  const origNotify = approvalEvents.notifyAdminsApprovalRequest;
  const origLabel = approvalCards.resolveUserLabel;
  const adminCards = [];
  landedCostService.submitForApproval = async () => ({
    requestId: 'REQ-LC-1',
    allocation: { totalYards: 1000, usdLandedPerYard: 4, ngnLandedPerYard },
  });
  approvalEvents.notifyAdminsApprovalRequest = async (_bot, _id, _who, card) => { adminCards.push(card); };
  approvalCards.resolveUserLabel = async () => 'Admin 777';
  try {
    const bot = createFakeBot();
    await flow._internals.submit(bot, USER, USER);
    return { adminCard: adminCards[0] || '', submitted: lastText(bot) };
  } finally {
    landedCostService.submitForApproval = origSubmit;
    approvalEvents.notifyAdminsApprovalRequest = origNotify;
    approvalCards.resolveUserLabel = origLabel;
    sessionStore.clear(USER);
  }
}

test('CUR-1 R8: the 2nd-admin card prints FX and the sealed rate bare at 2 dp, USD lines keep $', async () => {
  const { adminCard } = await runSubmit();
  assert.match(adminCard, /FX rate: 1,520\.00\/\$/, `FX rate bare, 2 dp, per $: ${adminCard}`);
  assert.match(adminCard, /NGN landed\/yard \(sealed on approval\): 6,080\.46\/yd/, 'sealed rate 2 dp, bare');
  assert.match(adminCard, /USD cost\/yard: \$2/, '$ stays on the foreign-cost line');
  assert.match(adminCard, /Freight: \$1,500/);
  assert.ok(!/₦/.test(adminCard), 'no ₦ on a side-B card');
});

test('CUR-1 R8: the requester\'s submitted card previews the rate bare at 2 dp', async () => {
  const { submitted } = await runSubmit();
  assert.match(submitted, /NGN \/ yard \(preview\): \*6,080\.46\/yd\*/, `preview line: ${submitted}`);
  assert.ok(!/₦/.test(submitted));
});

test('landed rate is fixed at 2 dp — an integer FX/rate does not collapse to the integer default', async () => {
  const { adminCard, submitted } = await runSubmit({ fxRate: 1500, ngnLandedPerYard: 6000 });
  assert.match(adminCard, /FX rate: 1,500\.00\/\$/);
  assert.match(adminCard, /sealed on approval\): 6,000\.00\/yd/);
  assert.match(submitted, /\*6,000\.00\/yd\*/);
});
