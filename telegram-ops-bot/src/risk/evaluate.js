/**
 * Risk evaluation for inventory and financial actions.
 * Sale/supply and ledger-impacting actions ALWAYS require approval:
 *   Employee → Admin approval
 *   Admin → 2nd Admin approval
 * Other write actions: employees need admin approval, admins execute directly.
 */

const settingsRepository = require('../repositories/settingsRepository');
const config = require('../config');
const auth = require('../middlewares/auth');
const logger = require('../utils/logger');

const WRITE_ACTIONS = [
  'sell_than', 'sell_package', 'sell_batch', 'sell_mixed', 'sell',
  'return_than', 'return_package', 'revert_sale_bundle',
  'update_price',
  'add', 'add_stock',
  'record_payment',
  'add_customer',
  'add_contact',
  'transfer_than', 'transfer_package', 'transfer_batch',
  // Bank management — settings writes, admin only in controller
  'add_bank', 'remove_bank',
  // User management — admin only in controller
  'add_user',
  // P2 — Goods Receipt Note (admin executes directly; employee routes
  // through admin approval).
  'receive_goods',
  // P2.5 — Bulk Receive (CSV/XLSX upload). Always dual-admin gated; see
  // ALWAYS_APPROVAL_ACTIONS below.
  'bulk_receive_goods',
  // TG-INT 1.4 — admin/finance sets a manual FX rate. Direct write for
  // admins; employees would need approval (rare — finance role only in
  // practice).
  'set_forex_rate',
  // TG-INT 1.1 — single-recipient WhatsApp send (transactional). Direct
  // for admins; broadcasts to many recipients use the always-approval
  // action below.
  'notify_wholesaler',
  // BR-OPS C1 — branch manager submits a daily office-expense batch
  // (water, fuel, sundries). Single-admin sign-off for V1 (just you).
  // Flip to ALWAYS_APPROVAL_ACTIONS when finance joins the chain.
  'record_office_expense',
  // CNET-1b (owner-locked spec §5-2): staff add a person/relation to the
  // contact network; one non-requester admin approves.
  'add_contact_link',
  // CNET-1b.1 — staff propose phone/whatsapp/address/note corrections on
  // an existing contact; one non-requester admin approves.
  'update_contact_info',
];

// Actions that ALWAYS go through the approval queue, regardless of whether
// the requester is an admin. Admin → 2nd-admin gate; employee → admin gate.
// Returns and full-bundle reverts belong here because they modify approved
// sales (inventory state + customer ledger) and a single admin should never
// be able to roll those back unilaterally.
//
// Warehouse mutations (add/rename) live here because the user explicitly
// asked for dual-admin sign-off on every structural change to warehouses
// (theft history made loose ad-hoc edits costly). The existing approval
// queue + admin-broadcast pipeline enforces approver != requester
// automatically (requireApproval excludes admin requesters from the
// notification list — see telegramController.js requireApproval).
const ALWAYS_APPROVAL_ACTIONS = [
  'sell_than', 'sell_package', 'sell_batch', 'sell_mixed', 'sell',
  'return_than', 'return_package', 'revert_sale_bundle',
  'record_payment', 'update_price', 'supply_request',
  // P2 — dual-admin gate for warehouse structural changes.
  'add_warehouse', 'rename_warehouse',
  // P2.5 — Bulk Receive uploads can land hundreds of rows in one stroke.
  // Always dual-admin to ensure a 2nd pair of eyes on the parsed summary
  // (file_hash + bale count + warehouse) before any Inventory write.
  'bulk_receive_goods',
  // USR-C3 — in-bot user onboarding. Adding someone to the active-users
  // roster grants them access to the bot (sheet-driven auth list), so
  // every add_user goes through dual-admin approval. USR-C3b reserves a
  // tighter SUPER_ADMIN gate for the special case of promoting to admin.
  'add_user',
  // USR-C3b — promoting an existing user to admin grants approval power,
  // including the power to approve add_user. To prevent two colluding
  // admins from minting a third, this action additionally requires the
  // APPROVER to be in SUPER_ADMIN_IDS (env-only, no in-bot path).
  'promote_admin',
  // USR-C4 — flipping status=inactive revokes a user's bot access. Dual-
  // admin to prevent a single hostile admin from locking out a colleague.
  'deactivate_user',
  // TG-INT 1.2 — admin confirms a bank-feed → ledger reconciliation
  // match. Always dual-admin: incorrect matches cascade into wrong
  // customer balances and supplier payment confirmations.
  'confirm_bank_reconciliation',
  // TG-INT 1.1 — outbound WhatsApp broadcast to multiple recipients
  // (e.g. wholesaler price update). Always dual-admin to prevent any
  // single admin from blasting incorrect / unauthorised messages.
  'broadcast_wholesalers',
  // DCAT-1 — design → product-category mapping (Cashmere / Chinos / …).
  // Owner mandated 2-admin sign-off (Jul 2026): the label shows on every
  // sales/stock screen, so a wrong label misleads the whole team.
  'set_design_category',
  // LANDED-COST C1 — finalize a GRN's landed cost (USD cost-per-yard +
  // container charges + FX rate). Sealing wrong numbers cascades into
  // every margin report + sales decision, so always dual-admin.
  'finalize_landed_cost',
  // TV-2 — switch a warehouse's supply-screen display unit (bales ⇄ thans,
  // Settings THAN_VISIBILITY_WAREHOUSES). Admins + managers may request;
  // an admin (≠ an admin requester) must approve before it applies.
  'set_unit_display',
  // DUAL-1 (owner mandate 12-Jul-2026, specs/DUAL-1_TWO_ADMIN_APPROVAL.md):
  // every Inventory write + finance action goes through the queue — admins
  // no longer execute these directly. The legacy transfer_* queue path is
  // gated; the staged Transfer Stock flow (TRF) is not (dispatcher+receiver
  // already review). set_forex_rate has no bot write path yet — listed so
  // the gate exists the day one ships. sale_bundle/give_sample queue
  // unconditionally from their tap flows; listed to keep DUAL ⊆ ALWAYS.
  'add', 'add_stock',
  'transfer_than', 'transfer_package', 'transfer_batch',
  'receive_goods',
  'set_forex_rate',
  'add_bank', 'remove_bank',
  'record_office_expense',
  'sale_bundle', 'give_sample',
  // CNET-1b — single non-requester admin (NOT dual): the network is the
  // commercial customer web, but a link is cheap to reverse (deactivate).
  'add_contact_link',
  'update_contact_info',
  // CNET audit fix (owner instruction 17-Jul-2026, "every addition goes
  // for approval"): the legacy NL add_contact let ADMINS write the
  // phonebook directly with free-text data. Now every add_contact queues
  // like the cn: paths — one non-requester admin reviews.
  'add_contact',
];

/**
 * DUAL-1 — actions that must involve TWO admins before execution:
 * an employee request needs two distinct admin signoffs; an admin request
 * counts the requester as the first admin, so one OTHER admin approves
 * (self-approval is already blocked by the SEC-P1 H1 guard). Signoffs
 * accumulate in the ApprovalQueue row's ActionJSON (`approvals: [...]`),
 * no sheet schema change. Every entry here MUST also be in
 * ALWAYS_APPROVAL_ACTIONS (unit test pins the invariant).
 */
const DUAL_ADMIN_ACTIONS = [
  // Inventory writes.
  // DUAL-1a (owner amendment 14-Jul-2026): the SALE family dropped back to
  // single-admin approval — two-admin latency was blocking live sales
  // (customers waiting on a 2nd admin). Sales stay in
  // ALWAYS_APPROVAL_ACTIONS, so one non-requester admin still signs off.
  // Returns/reverts stay dual (they roll back approved sales).
  'give_sample',
  'return_than', 'return_package', 'revert_sale_bundle',
  'add', 'add_stock',
  'transfer_than', 'transfer_package', 'transfer_batch',
  'receive_goods', 'bulk_receive_goods',
  // Finance
  'record_payment', 'update_price', 'set_forex_rate',
  'add_bank', 'remove_bank',
  'record_office_expense', 'finalize_landed_cost',
  'confirm_bank_reconciliation',
];

/**
 * DUAL-1 — how many distinct admin APPROVAL TAPS a request needs.
 * Pure so tests can pin the matrix; callers supply the admin headcount.
 *
 * @param {object} p
 * @param {string} p.action
 * @param {boolean} p.requesterIsAdmin  requester counts as the 1st admin
 * @param {number} p.adminCount  distinct admins able to approve (i.e.
 *   excluding an admin requester). Degrades the requirement instead of
 *   deadlocking a 1-admin deployment — mirrors the update_price
 *   "Only 1 admin configured — auto-approved" precedent.
 * @returns {number} required approval taps (>= 1)
 */
function requiredAdminApprovals({ action, requesterIsAdmin, adminCount }) {
  if (!DUAL_ADMIN_ACTIONS.includes(action)) return 1;
  if (requesterIsAdmin) return 1;
  const available = Number.isFinite(adminCount) ? adminCount : 2;
  return Math.max(1, Math.min(2, available));
}

/**
 * USR-C3b — actions whose APPROVAL is restricted further: only super-
 * admins (env SUPER_ADMIN_IDS) can tap Approve. Regular admins can still
 * see the request in their queue but the approve handler rejects them.
 */
const SUPER_ADMIN_APPROVAL_ACTIONS = ['promote_admin'];

async function getThresholds() {
  const settings = await settingsRepository.getAll();
  return {
    deductionLimit: Number(settings.RISK_THRESHOLD) || config.risk.defaultDeductionLimit,
    lowStockThreshold: Number(settings.LOW_STOCK_THRESHOLD) || config.risk.defaultLowStockThreshold,
  };
}

/**
 * Evaluate risk for any action.
 * Sale/supply/payment/price actions ALWAYS need approval (even admins → 2nd admin).
 * Other write actions: employee → admin approval; admin → safe.
 */
async function evaluate(params) {
  const { action, userId } = params;

  const isAdm = userId && auth.isAdmin(userId);
  logger.info(`Risk evaluate: action=${action}, userId=${userId}, isAdmin=${isAdm}`);

  if (ALWAYS_APPROVAL_ACTIONS.includes(action)) {
    // DUAL-1: employee requests on dual actions need two admin signoffs;
    // an admin requester counts as the first, so "2nd admin" reads right.
    const isDual = DUAL_ADMIN_ACTIONS.includes(action);
    const who = isAdm ? '2nd admin' : (isDual ? 'two-admin' : 'admin');
    return {
      risk: 'approval_required',
      reason: `All ${formatAction(action)} operations require ${who} approval.`,
    };
  }

  if (isAdm) {
    return { risk: 'safe' };
  }

  if (WRITE_ACTIONS.includes(action)) {
    return {
      risk: 'approval_required',
      reason: `All ${formatAction(action)} operations require admin approval.`,
    };
  }

  return { risk: 'safe' };
}

function formatAction(action) {
  const map = {
    sell_than: 'sale', sell_package: 'sale', sell_batch: 'sale', sell_mixed: 'sale', sell: 'sale',
    return_than: 'return', return_package: 'return', revert_sale_bundle: 'sale revert',
    update_price: 'price update', add: 'stock addition', add_stock: 'stock addition',
    record_payment: 'payment', add_customer: 'customer creation', add_contact: 'contact creation',
    transfer_than: 'transfer', transfer_package: 'transfer', transfer_batch: 'transfer',
    receive_goods: 'goods receipt', add_warehouse: 'warehouse creation', rename_warehouse: 'warehouse rename',
    bulk_receive_goods: 'bulk goods receipt',
    set_forex_rate: 'forex rate update',
    set_design_category: 'design category update',
    notify_wholesaler: 'wholesaler notification',
    broadcast_wholesalers: 'wholesaler broadcast',
    confirm_bank_reconciliation: 'bank reconciliation confirmation',
    finalize_landed_cost: 'landed cost finalization',
    record_office_expense: 'office expense batch',
    add_contact_link: 'contact-network addition',
    update_contact_info: 'contact detail update',
  };
  return map[action] || action.replace(/_/g, ' ');
}

module.exports = {
  evaluate, getThresholds, requiredAdminApprovals,
  WRITE_ACTIONS, ALWAYS_APPROVAL_ACTIONS, SUPER_ADMIN_APPROVAL_ACTIONS,
  DUAL_ADMIN_ACTIONS,
};
