# DUAL-1 — Two-admin approval for Inventory + Finance actions

Owner decisions locked 12-Jul-2026 (chat with owner):

1. **Rule:** every in-scope action must involve **2 admins** before it executes.
   The requester counts when they are an admin:
   - Employee/manager request → **two distinct admins** must tap Approve.
   - Admin request → **one other admin** must approve (requester is the 1st of
     the 2; the existing SEC-P1 H1 guard already blocks self-approval).
2. **Scope:** ALL Inventory-sheet writes + ALL finance-touching actions
   (list below). "Only actions already gated" was explicitly rejected.
3. **Staged flows stay as-is:** `supply_request` (dispatch manager → admin →
   warehouse chain) and the TRF Transfer Stock staged flow (dispatcher →
   receiver) already involve 2+ people and are NOT double-gated. The legacy
   `transfer_*` approval-queue path (old tp*/tt* cards) DOES get the dual
   gate since it is a single-tap execute.

## In-scope actions (`DUAL_ADMIN_ACTIONS` in `src/risk/evaluate.js`)

Inventory writes:
`sell_than sell_package sell_batch sell_mixed sell sale_bundle give_sample
return_than return_package revert_sale_bundle add add_stock transfer_than
transfer_package transfer_batch receive_goods bulk_receive_goods`

Finance:
`record_payment update_price set_forex_rate add_bank remove_bank
record_office_expense finalize_landed_cost confirm_bank_reconciliation`

Notes:
- `add`/`add_stock` typed intents redirect into Add Stock flow → queue as
  `bulk_receive_goods`; listed for policy completeness.
- `set_forex_rate` has no bot write path today (rates are entered in the
  ForexRates sheet by hand; the manual provider only reads). Listed so the
  gate exists the day a write path ships.
- `sale_bundle` and `give_sample` queue unconditionally from their tap flows;
  they are added to `ALWAYS_APPROVAL_ACTIONS` too so the invariant
  DUAL ⊆ ALWAYS holds and any future evaluate()-routed path stays gated.

## Mechanics

- **No schema change.** Approvals accumulate in the ApprovalQueue row's
  ActionJSON as `approvals: ["<adminId>", ...]` via
  `approvalQueueRepository.updateActionJSON` (same pattern the multi-stage
  supply flow uses for stage transitions).
- `handleApprovalCallback` (approve branch), after the existing
  self-approval + super-admin guards and BEFORE the enrichment/execute
  branches:
  1. Not a dual action → unchanged single-approval behavior.
  2. Approver already in `approvals` → alert "second approval must come from
     a different admin"; card stays live for other admins.
  3. Fewer signoffs than required → record the signoff, audit
     `approval_first_signoff`, clear this admin's card buttons, tell the
     requester "1 of 2 approvals received", ping the remaining admins.
     No execution.
  4. Signoffs complete → existing path (sales → enrichment; everything else
     → `executeApprovedAction`). The final approver id is recorded by the
     executor as before; earlier signoffs live in ActionJSON.
- **Required count** comes from `requiredAdminApprovals()` in evaluate.js:
  requester-is-admin → 1 approver; employee → 2 approvers, degraded to the
  number of distinct admins that exist when fewer than 2 (mirrors the
  update_price "Only 1 admin configured — auto-approved" precedent, so a
  single-admin deployment never deadlocks).
- **Reject stays single-admin** — any one admin can kill a request at any
  stage, including after a first signoff (fail-closed bias).
- Newly ALWAYS-gated actions (`transfer_* receive_goods add add_stock
  set_forex_rate add_bank remove_bank record_office_expense`) mean admins no
  longer execute these directly — the generic `requireApproval` /
  goodsReceiptFlow evaluate branches route them into the queue instead.

## Out of scope

- Catalog marketer stock (`catalog_supply/loan/return`) — separate
  CatalogStock sheets, not the Inventory sheet.
- `supply_request` + staged Transfer Stock (owner decision #3).
- User/warehouse/design-category/unit-display admin actions — keep their
  existing single-other-admin gate.
