# Approval-pipeline uniformity audit — 18-Jul-2026 (APU-1)

Trigger: owner saw the Snap Sale approval card ("sale (snap) — bale 896 77016 to
OKESON") and noticed it shows far less than the classic sale approval card.
Owner directive: *every* approval must ride one channel with the same stages,
and the detail level of the earlier (classic) card must remain intact.

Method: 10-agent parallel audit (9 mappers over every `approvalQueueRepository.append`
/ `notifyAdminsApprovalRequest` site + machinery reader, 1 completeness critic
hunting off-pipeline surfaces). 35 queue sites + 2 off-queue approval pipelines
+ machinery catalogued. Key claims re-verified by hand before this write-up.

## The canonical channel (what "single channel" means today)

1. **Queue** — `approvalQueueRepository.append({requestId, user, actionJSON, riskReason, status:'pending'})` + AuditLog `approval_queued`.
2. **Notify** — `approvalEvents.notifyAdminsApprovalRequest(bot, id, userLabel, actionSummary, riskReason, excludeUserId, opts)` → per env-admin card `🔔 Approval required / Request ID / User / Action / Reason` + `[✅ Approve|❌ Reject]`; optional `opts.previewPhoto`.
3. **Decide** — `approve:`/`reject:` → env-ADMIN_IDS gate → SEC-P1 H1 self-approval guard → super-admin gate (promote_admin) → DUAL-1 second-signature gate (DUAL_ADMIN_ACTIONS).
4. **Enrich** — ST-1 for `SALE_ACTIONS = ['sell_than','sell_package','sale_bundle']`: admin enters rate/payment/amount at approval; `sale_doc_file_id` archived to Drive.
5. **Execute** — `inventoryService.executeApprovedAction` branch per action; INVOICED_ACTIONS mint an invoice.

**Gold-standard card** (classic Sell Bale, controller ~6140-6220): Customer +
Phone + Address, Salesperson, Payment, canonical Date, per-bale item lines
(design, shade, thans, yards, warehouse), totals, backdated banner, `📎 Sales
bill attached` + the bill itself sendPhoto'd to every non-excluded admin.

## Snap Sale specifically (the owner's screenshot)

Channel and stages are INTACT: same queue, same buttons, same H1 guard, and —
verified — `sell_package` IS in SALE_ACTIONS, so the admin gets the full ST-1
rate/payment prompt at approval and the label photo IS Drive-archived. What
regressed is only what the approving admin *sees before deciding*:

- Card is a one-liner: no thans/yards (it sells the WHOLE bale), no warehouse,
  no salesperson, no customer phone, no date line, no totals.
- The label photo — which is the attached sale document — is **never forwarded
  to admins** (no `opts.previewPhoto`, no sendPhoto loop, no "📎 attached" marker).
- notify is try/catch-warn: a notify failure leaves a queued request with zero
  admin cards while the seller is told "Submitted".

## Findings by severity

### A. Broken / integrity (fix requires owner sign-off — approval semantics)

1. **Dead action `new_customer_registration`** — queued by 3 flows (order flow
   ~2827, receipt flow ~3009, sample flow ~893) but no executor and the
   new-customer special cases in approvalEvents match only `new_customer`.
   Approve → "⚠️ Approved but execution failed: Unknown action type."; customer
   stuck `Pending`, queue row stays `pending` (re-tappable forever), paused flow
   never resumes; reject skips flow-reset + orphans the eager Customers row.
   (Working variant `new_customer` is queued by supply_req_flow + catalog flow.)
2. **`srf_acc:`/`srf_ack:` flips ANY pending row to approved** — verified:
   `handleSupplyAccept` does `updateStatus(requestId,'approved')` with no auth
   check, no row-existence/stage/action validation. Any authorized bot user
   forging `srf_acc:<id>` marks any pending request approved (without executing).
3. **Receipts approval is a parallel pipeline** (`rcapr:`/`rcrej:`, controller
   ~7992-8107): no ApprovalQueue row, no requestId, **zero AuditLog writes**, no
   H1 self-approval guard, rejected→approved flip possible from a stale card,
   invisible to approvalReminder and pending lists. (It DOES forward the receipt
   doc to admins and resolves display names — better than most queue sites.)
4. **approvalReminder sweep has no action filter** — re-broadcasts
   `transfer_stock` rows with standard buttons: Approve dead-ends ("Unknown
   action type"), Reject marks rejected WITHOUT transferService cleanup,
   stranding in-transit bales; also re-broadcasts mid-stage supply rows whose
   lifecycle buttons are elsewhere. Reminder cards also lose ALL detail
   (summarize() knows only action/design/container/warehouse) and pass
   excludeUserId=null.
5. **`update_price` orphan row** — queue row appended BEFORE the solo-admin
   auto-approve check; the auto-approve path executes directly and leaves the
   pending row forever (re-approvable stale row). Solo-admin check counts env
   admins only.
6. **Eager sheet writes before approval** — Customers rows (3 new-customer
   sites + catalog ~658), Marketers row (catalog ~167), BranchOpsLog expense
   rows: written `Pending` before any decision; rejection cleanup missing in
   several paths.
7. **`rename_warehouse`** — in ALWAYS_APPROVAL_ACTIONS with a live executor but
   NO site queues it (dead approval surface, inverse of finding 1).

### B. Detail poverty (the owner's complaint, systemic)

Cards showing materially less than their queued actionJSON carries:

| Site | What the approver can't see |
|---|---|
| snapSaleFlow (sell_package) | quantity/warehouse/salesperson/date + the label photo |
| return_than / return_package | sale reversal with NO yards/design/warehouse/customer/sale date |
| record_payment | outstanding balance, date, no receipt attachment |
| add_user | warehouses[] + manages[] access scope — the most consequential fields |
| bulk_receive_goods (both flows) | per-design breakdown, supplier, file_hash, source doc (dual-admin container upload approved from one line) |
| finalize_landed_cost | USD/yd, per-charge lines, FX rate/source, total yards (all snapshotted "expressly for the approval card" but never rendered) |
| add_contact_link / update_contact_info | phone/notes/old_value being overwritten |
| catalog_return | which catalogs (count only) |
| userManageFlow (deactivate/promote) | target's current role/department/status |
| remove_bank | balance held, linked transactions |
| goods receipts (receive_goods) | supplier/PO id, per-bale lines |
| approvalReminder + morningDigest | everything above, again |

### C. Consistency drift

- **Wording vs actual gate**: cards claim "dual-admin"/"2nd admin" where the
  action is NOT in DUAL_ADMIN_ACTIONS (bundle sale, design_asset_upload,
  add_user, set_design_category, add_warehouse — the last contradicts the
  owner's recorded theft-history mandate in evaluate.js) and understate the
  gate where it IS dual (transfers, returns, give_sample, record_office_expense).
- **riskReason mismatch**: card string ≠ queue-row string at ≥6 sites (audit
  trail and card disagree); many sites hardcode reasons instead of calling
  riskEvaluate.
- **userLabel**: ~10 flow-module sites send the raw numeric Telegram id where
  the classic pipeline resolves a display name.
- **Markdown**: flow summaries embedding `*bold*` render as literal `*` after
  MarkdownV2 escaping (add_user, userManage, unitDisplay).
- **excludeUserId**: only 2 sites apply the admin-requester exclude correctly;
  most pass nothing (requester gets their own live card; H1 blocks the tap) or
  pass it unconditionally.
- **Admin pool**: cards/taps/doc-forwards iterate env ADMIN_IDS while
  H1/DUAL/pu: gates count sheet-cache admins too — a sheet-only 2nd admin can
  deadlock DUAL actions and never receives cards.
- **Off-pipeline buttons**: `rcapr:/rcrej:` (receipts), `pu:onboard/ignore`
  (pending users), `approve_task:` (no reject path at all), `trf:*` (transfer
  lifecycle — intentionally custom), catalog_supply/loan approvals hardcoded
  outside the risk engine.
- **IDs**: two sites mint requestIds via crypto.randomUUID() instead of the
  standard generator.

## Owner decisions needed before remediation

See `specs/APU-1_APPROVAL_UNIFORMITY.md` for the phased plan + decision menu.
Per CLAUDE.md rules, no change to approval semantics, evaluate.js,
approvalEvents.js, or the controller proceeds without explicit owner sign-off.
