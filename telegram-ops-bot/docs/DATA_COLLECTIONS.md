# Employee Data Collections — full catalogue (audited 14-Jul-2026)

Every point where the Telegram bot collects data from our own employees:
what is captured, how (tap chips / typed text / photo / auto), where it lands,
and the approval gate. Friction notes are the refinement backlog for the
tap-first UX vision. Generated from a full code audit (all src/flows/ modules,
controller inline flows, approvalEvents capture points, intent-parser typed surface).

**Method legend:** 🟢 tap = buttons/chips only · ⌨️ type = free text · 🟡 mixed = chips with typed fallback · 📷/📎 = photo/document · ⚙️ auto = filled by the bot

## Contents

- **Selling & customers** — Sell Bale, Bundle Sale, Supply Request Cart, Sale Approval Enrichment, Return Than / Return Bale, Give Sample, Add Customer, Create Supply Order
- **Stock inbound & procurement** — Receive Goods, Bulk Receive Goods, Add Stock, Photo Receive Goods, New Procurement Order
- **Stock movement & warehouses** — Transfer Stock, Legacy Transfer Bale/Than flows, Warehouse Audit, Add Warehouse, Warehouse Display Units, Allocate to Marketer
- **Money, receipts & branch operations** — Upload Payment Receipt, Office Expense, Open Branch, Finalize Landed Cost, Incentive Payouts — Mark Paid
- **People, roles & attendance** — Mark Attendance, Attendance Admin hub, Add Employee, Promote to Admin, Deactivate User, Change Role, Notification Preferences
- **Tasks & incentives** — Assign Task, Propose Timeline, Timeline Negotiation — Accept / Counter / Renegotiate / Decline / Cancel, Set Incentive, Mark Done & Sign-off, Manager Controls — Re-prioritize & Drop
- **Catalogue, pricing & typed-command surface** — Set Design Category, Update Price, Add Contact via NL, Customer Follow-up & Notes via NL, Typed natural-language command surface


## Selling & customers

### Sell Bale (ST-1) + Sales Bill handoff

**What:** Records the sale of one or more whole bales to a customer, with a mandatory sales-bill document, flipping inventory to sold and booking revenue after admin approval.
**Who:** Any authorized employee or admin; typed sale commands force-redirect here (owner mandate 14-Jul)
**Entry:** Tile '💰 Sell Bale' (act:sell_bale, Orders hub); namespace sb:, handoff to sale_flow awaitingDocument; session sell_bale_flow
**Lands in:** ApprovalQueue (actionJSON incl. sale_doc_file_id) → on approval: Inventory sold-mark, Transactions row(s), CRM payment + ledger when amountPaid > 0, AuditLog; bill Drive-uploaded as sale_bill_<customer>_<requestId>
**Approval:** Single-admin non-requester (DUAL-1a dropped sale family from dual-admin); backdated sales force approval with banner; self-approval blocked

| Field | Input | Notes |
|---|---|---|
| Container (arrival batch) | 🟢 tap | Chips from getArrivalBatches(), max 12 shown |
| Warehouse | 🟢 tap | Chips scoped to chosen container |
| Design | 🟢 tap | Chips sorted by bale count; catalogue photo auto-sent once per design (CAT-C1) |
| Bales (multi-select cart) | 🟢 tap | One chip per bale (thans + yards); cart builds across designs; hard cap 12 chips with dead '…N more' noop |
| Customer | 🟡 mixed | Recent-buyer chips (last 200 txns), A-Z paginated browse, or typed substring search over EXISTING customers only |
| Salesperson | 🟢 tap | Chips of active Users (up to 24) |
| Payment mode | 🟢 tap | Cash / Credit / Settings BANK_LIST banks / 'Not yet paid' |
| Sale date | 🟢 tap | Today/yesterday + 5 chips (7 days back max); backdates flagged BACKDATED; future blocked |
| Sales bill | 📷 photo | Photo OR PDF, mandatory (sale_flow refuses text until file arrives); stored as sale_doc_file_id; Drive-uploaded at approval, link posted in admin chat only, never persisted to a sheet |
| Rate / final payment / amount paid | 🟡 mixed | NOT captured from seller — supplied by approving admin via ST-1 Part B enrichment |

**Refine:** Payment mode captured TWICE (seller chip then admin enrichment re-asks); no rate captured from seller so admin must know the negotiated price independently; bale list caps at 12 with dead noop button (no pagination); date chips only 7 days back; substring-only customer search; Drive bill link never persisted to any sheet; cancel card can leave live buttons if editMessageReplyMarkup fails

### Bundle Sale (BUNDLE-SALE C1)

**What:** Records a Kano-style poly-colour bundle/than sale — thans picked across bales and shades of one design at a single per-yard rate.
**Who:** Employees and admins (isAdmin || isEmployee gate); built for Kano branch staff
**Entry:** Tile '🧵 Sell Bundles / Than' (act:bundle_sale, Orders hub); namespace bs:; session bundle_sale_flow
**Lands in:** ApprovalQueue (sale_bundle actionJSON with enrichment baked in) + AuditLog → on approval: Inventory sold-mark, LedgerTransactions debit, Transactions row
**Approval:** Single-admin non-requester (in ALWAYS_APPROVAL_ACTIONS, not dual after DUAL-1a); stock re-reconciled at confirm AND submit

| Field | Input | Notes |
|---|---|---|
| Container | 🟢 tap | Always shown even for one container |
| Warehouse | 🟡 mixed | Chips; auto-skipped when container has exactly one warehouse |
| Design | 🟢 tap | Top 12 by yards; overflow is a dead '…more' noop row |
| Shade | 🟢 tap | Catalog-named chips with remaining-than counts; 'Take ALL shades' bulk chip |
| Thans / bales (cart) | 🟡 mixed | Whole-bale toggle, per-than checkboxes, 'Take whole bale'; or typed Smart-Pack target yardage (>0, ≤100,000; oldest first) |
| Customer | 🟡 mixed | Recent-buyers-of-design chips, paginated browse, typed search (min 2 chars), or 'Walk-in (no record)' |
| Rate per yard (NGN) | 🟡 mixed | Typed or one-tap chips (last rate to customer / last any / 30-day median); >0, ≤5,000,000; below-landed-cost triggers 'accept loss' confirm |
| Payment mode | 🟢 tap | Hardcoded Cash / Bank Transfer / Pending — not Settings BANK_LIST |
| Sale date | ⚙️ auto | Always today — no backdating path |
| Salesperson | ⚙️ auto | Raw Telegram user id, not a name |
| Amount paid | ⚙️ auto | yards×rate when Cash, else 0 — no partial payment |

**Refine:** Stale UI copy still says 'dual-admin gate'; no sales-bill photo step (evidence bar inconsistent with Sell Bale); salesperson stored as bare Telegram id joins poorly against Users; single rate for the whole mixed cart; hardcoded payment modes never capture the receiving bank; 'Walk-in' placeholder breaks ledger/CRM traceability; no date choice

### Supply Request Cart (srf) + optional bill + dispatch reject/decline reasons

**What:** Employee builds a multi-line cart of bales to supply to a customer from an arrival container, optionally attaches payment proof, and submits into the 3-stage dispatch pipeline; dispatch-side rejections capture a typed reason.
**Who:** Any allowed employee with assigned warehouse(s); marketers pinned to their MG-1 warehouses; admins see all containers plus a ₦-value block (ADMIN/FINANCE ids only); reject/decline reasons typed by Dispatch-dept members
**Entry:** Tile act:supply_request or typed 'Supply request'; inline in telegramController.js (startSupplyRequestFlow ~line 5063; session supply_req_flow); srf_* namespace; reasons via pendingReason Map (approvalEvents.js)
**Lands in:** ApprovalQueue (full cart in ActionJSON, stage dispatch_review) + AuditLog; new customers → Customers (status Pending); supply_request executor is intimation-only — fulfilment driven in approvalEvents (srf_assign/acc/dec); reasons written into actionJSON + DM'd to requester
**Approval:** Multi-stage: Stage-1 Dispatch feasibility → Stage-2 admin approval (admin requester needs 2nd admin) → Stage-3 warehouse-boy accept; embedded new-customer registration is a separate pausing approval; a single Dispatch reject kills the request (fail-closed)

| Field | Input | Notes |
|---|---|---|
| Container (arrival batch) | 🟢 tap | srf_ct tiles scoped to user's warehouses; ₦ value for admins/finance |
| Design category filter (optional) | 🟢 tap | srf_cg from Inventory col W |
| Warehouse | 🟢 tap | Only warehouses with available stock in the batch, within scope |
| Design | 🟢 tap | Paginated 2-col grid |
| Shade | 🟢 tap | Photo+buttons when catalog asset exists; 'all shades' chip; single-shade auto-skip |
| Quantity (bales) | 🟡 mixed | Presets 1–10 + All, or Custom typed integer validated against available count |
| Cart add/remove lines | 🟢 tap | srf_cart/srf_rm; admin-only 🚚 Transfer handoff to transferFlow |
| Customer | 🟡 mixed | Top-buyers-of-cart-designs first, then all actives; ➕ Add New switches to typed steps; no typed search filter |
| New customer name + phone | ⌨️ type | Name deduped via findByName (silent reuse); phone unvalidated; row appended status=Pending then flow PAUSES for admin approval |
| Salesperson | 🟢 tap | Sales dept + admins, first 6 then See All |
| Payment mode | 🟢 tap | Settings BANK_LIST + cash/credit via salesFlow.getPaymentOptions |
| Supply date | 🟢 tap | Today/Tomorrow/Mon/Fri + full calendar |
| Payment receipt / bill document | 📎 file | OPTIONAL photo/PDF (Skip allowed); file_id rides actionJSON only — never Drive-archived, never written to a sheet column |
| Final confirm | 🟢 tap | Builds actionJSON {action:'supply_request', cart, customer, salesperson, paymentMode, salesDate, doc ids} |
| Dispatch reject / decline reason | ⌨️ type | Free text after smc:r / srf_dec tap; silently truncated to 200 chars; in-memory pendingReason Map |

**Refine:** New-customer approval pause vs 30/60-min session janitor can lose the whole cart; phone unvalidated; names ride raw in callback_data (64-byte cap, slice(0,50) mismatch risk); no typed customer search though sellBaleFlow has the pattern; custom quantity typed though remaining count is known (steppers); bill never Drive-archived; no canned reason chips and in-memory reason state dies on restart

### Sale Approval Enrichment (enr:)

**What:** Approving admin supplies commercial terms (rate, payment mode, amount paid) at approval time for sell_than/sell_package/sale_bundle requests.
**Who:** Approving admin only (pendingEnrichment Map keyed by adminId)
**Entry:** ✅ Approve tap on a sale card → startApprovalEnrichment (approvalEvents.js); typed replies + enr: chips
**Lands in:** enrichment{} into inventoryService.executeApprovedAction → Transactions (pricePerYard, paymentMode, amountPaid) + Ledger postings; then sale bill Drive upload
**Approval:** This IS the approval step — enrichment gates execution

| Field | Input | Notes |
|---|---|---|
| Rate per yard | 🟡 mixed | Chip: customer's last-paid rate (from last 400 Transactions) or typed; multi-design 'design:rate, design:rate' pairs |
| Payment mode | 🟡 mixed | Chips Cash / Not yet paid / per-bank (BANK_LIST) or typed custom; non-paid modes zero the amount |
| Amount paid | 🟡 mixed | 'Paid in full' computed chip (rate×yards) or typed Naira |

**Refine:** In-memory Map — restart mid-enrichment orphans the approval (admin must re-tap); malformed 'design:rate' pairs silently dropped; no plausibility bound on rate/amount (15000 vs 1500 typo posts to ledger); no confirmation echo on typed rate; duplicates the payment-mode the seller already picked in Sell Bale

### Return Than / Return Bale (rt*)

**What:** Undoes the sale of a single than (or, typed-only, a whole bale) — marks it available again.
**Who:** Any allowed employee or admin (approval gate is the control)
**Entry:** Tile act:return_than (session return_than_flow) or typed 'Return than 2 from Bale 5801' / 'Return Bale 5803' (intents return_than/return_package, queue immediately)
**Lands in:** ApprovalQueue + AuditLog; on approval Inventory sold→available + Transactions row + ERP return event
**Approval:** Dual-admin (rolls back approved sales); requester excluded from approval broadcast

| Field | Input | Notes |
|---|---|---|
| Bale (package) | 🟢 tap | Bales with sold thans, capped at 30, lexicographic sort, no pagination/search |
| Than | 🟢 tap | Shows yards + buyer per sold than |
| Confirm | 🟢 tap | Queues {action:'return_than', packageNo, thanNo} |
| Typed one-liner (alt path) | ⌨️ type | packageNo/thanNo from intent; NO confirm preview; whole-bale return exists ONLY typed |

**Refine:** 30-bale cap with no search; whole-bale return has no tap flow at all (typo-prone typed-only); typed path shows no summary of what will be reverted before queueing

### Give Sample (sm* button flow + legacy smp* text path)

**What:** Records handing fabric sample pieces to a customer with a follow-up reminder date.
**Who:** Any allowed employee or admin (field roles excluded from typed entry; tile per Departments CSV)
**Entry:** Tile act:give_sample → startSampleFlowButton (session sample_flow, breadcrumb message), or typed 'Give sample of 44200 to CJE' which drops into the legacy smp* text path
**Lands in:** ApprovalQueue + AuditLog; on approval Samples row (with_customer) + branch-ops roll-up pointer; follow-up reminders read followup_date
**Approval:** Dual-admin for employees (ALWAYS_APPROVAL + DUAL_ADMIN); admin requester needs one other admin. BUT typed 'Sample SMP-x returned/lost/converted' writes Samples status DIRECTLY with no approval

| Field | Input | Notes |
|---|---|---|
| Design | 🟢 tap | 12 visible + See All; catalog photo preview |
| Shade | 🟢 tap | Catalog shade names + available-bale counts |
| Customer | 🟡 mixed | ⭐ top buyers of that design, See More, or ➕ new → typed name + phone (Pending + approval pause) |
| Quantity (pieces) | 🟡 mixed | Presets 1/2/3/5 + Custom typed; legacy path always types |
| Sample type | 🟢 tap | Hardcoded Type A/B/C — no legend anywhere |
| Follow-up date | 🟡 mixed | +3/7/14d presets + calendar; legacy path types DD-MM-YYYY |
| Confirm | 🟢 tap |  |

**Refine:** Sample types A/B/C meaningless in-UI; no stock check; NL trigger lands in legacy typed path (manual date parsing) instead of the calendar flow — two divergent UX paths; sample status updates bypass the dual-admin issue gate entirely

### Add Customer (ac* + admin Quick Add + typed NL)

**What:** Registers a new customer with CRM profile (phone, address, category, credit limit, payment terms, notes).
**Who:** Any allowed employee (full form); admins get ⚡ Quick Add one-liner (direct write); typed NL path also exists
**Entry:** Tile act:add_customer → startAddCustomerFlow (session add_customer_flow, anchored breadcrumb), typed 'Add customer …' (intent add_customer), or acquick
**Lands in:** ApprovalQueue → Customers via crmService.addCustomer + branch-ops pointer; Quick Add and admin typed path write Customers directly
**Approval:** Button flow always queues (even admins); typed NL: employee queued, admin direct; Quick Add: none — three inconsistent gates for one business event

| Field | Input | Notes |
|---|---|---|
| Full name | ⌨️ type | Min 2 chars; no live dedupe (only at execution in crmService) |
| Phone | 🟡 mixed | Typed or Skip; no format validation |
| Address | 🟡 mixed | Typed or Skip |
| Category | 🟢 tap | Wholesale / Retail / Distributor / Wholesaler — two near-duplicates |
| Credit limit | 🟡 mixed | Presets ₦0–500k or Custom typed |
| Payment terms | 🟡 mixed | Presets or typed custom |
| Notes | 🟡 mixed | Typed or Skip |
| Confirm | 🟢 tap |  |
| Quick Add one-liner (admin) | ⌨️ type | 'Name, Phone, [Address]' → direct write, defaults Standard/₦0/COD, no approval |

**Refine:** Three inconsistent approval gates; 'Wholesale' vs 'Wholesaler' duplicate categories; Quick Add stamps category='Standard' which isn't in CUSTOMER_CATEGORIES; fragile regex extraction on typed path; no duplicate warning until after submission

### Create Supply Order (od/oc/oq/os/op/odt + oacc/odel)

**What:** Admin proposes a future supply order assigned to a salesperson who must accept and later mark it delivered.
**Who:** Creation: admins only; acceptance/delivery: the assigned salesperson only
**Entry:** Typed 'Create order' (admin-gated) or tile act:create_order → startOrderFlow (session order_flow; fresh message per step, no anchored edit)
**Lands in:** Orders sheet (status pending_accept; accepted_at/delivered_at on updates); admin feed; assignee DM with Accept button
**Approval:** None — direct write on oconf, unique among inventory-touching flows; control is assignee acceptance + T3 admin lens

| Field | Input | Notes |
|---|---|---|
| Design | 🟢 tap | Grid capped ~90 designs, no search |
| Customer | 🟡 mixed | Past buyers of that design (fallback all actives), capped 20 rows; ➕ New → typed name + phone (approval pause) |
| Quantity (bales) | 🟡 mixed | Presets 1/2/5/10 + Custom typed — NO stock check |
| Salesperson (assignee) | 🟢 tap | Sales-dept picker |
| Payment status | 🟢 tap | PAID / UNPAID binary — no amount |
| Scheduled date | 🟡 mixed | Today/Mon/Fri + calendar; legacy typed parser retained |
| Confirm | 🟢 tap | Writes Orders row directly |
| Order acceptance / mark delivered | 🟡 mixed | oacc tap (assignee-only); odel tap or typed 'Mark order ORD-xxx delivered' |

**Refine:** No approval queue and no stock validation (order for 10 bales of a sold-out design accepted silently); PAID/UNPAID without an amount can't reconcile against receipts; design/customer caps without search; fresh-message-per-step chat noise with stale keyboards; duplicated customer-picker code


## Stock inbound & procurement

### Receive Goods (GRN)

**What:** Records physical receipt of new bales at a warehouse, appending one Inventory row per than plus a GRN header.
**Who:** All employees (inventory staff); admins execute directly, others route to admin approval
**Entry:** Tile 'Receive Goods' (Stock > Add Stock hub, act:receive_goods); namespace gr:*; text steps for typed values
**Lands in:** Inventory (one row per than) + GoodsReceipts header via executeApprovedAction; ApprovalQueue row always written (admin path riskReason=admin_direct); AuditLog
**Approval:** Single-admin for employees; admins execute immediately via self-created approval row; embedded 'New warehouse' escalates to dual-admin via warehouseFlow

| Field | Input | Notes |
|---|---|---|
| Warehouse | 🟢 tap | Chips from Inventory + Settings WAREHOUSE_LIST; 'New warehouse' delegates to canonical warehouseFlow (drops the GRN session) |
| Supplier | 🟡 mixed | Contacts chip (type=supplier, first 12), 'No supplier', or typed new name (≤80 chars) appended to Contacts IMMEDIATELY — no approval, no dedup |
| Design | 🟡 mixed | Max 12 existing chips or free-typed new (no cap, no dedup) |
| Bale type (mono/multi-colour) | 🟢 tap | Lagos mono vs Kano multi-shade fork |
| Shade(s) | 🟡 mixed | Mono: chip / 'No shade' / typed new (unvalidated). Multi: toggle checkboxes + typed new; Done requires ≥1 |
| Yards per than (multi path) | 🟡 mixed | Chips 20/25/30/40/50 or typed positive number |
| Bale numbers | ⌨️ type | CSV/range list e.g. '5801-5805, 5812'; parseBaleList validates/dedups/caps ranges at 1000 — does NOT check against existing Inventory |
| Yards per bale (mono path) | 🟡 mixed | Chips 40/45/50/55/60 or typed; applied uniformly; silent 50 fallback on parse failure |
| Date received / product type / PO link | ⚙️ auto | Today; hardcoded 'fabric'; po_id rides along from Procurement Plan handoff |

**Refine:** Zero duplicate check of typed bale numbers against Inventory (unlike Add Stock's R1/R2 scan); confirm card promises a per-bale yard editor that doesn't exist; instant no-dedup supplier writes accumulate typo suppliers; 12-chip design cap pushes users to type case/space variants of existing designs; silent yards default on failed parse

### Bulk Receive Goods (CSV/XLSX)

**What:** Bulk-imports a delivery of incoming bales/thans from a spreadsheet as one goods receipt, tagged with a container/arrival-batch label.
**Who:** All employees (Abdul, inventory manager, primary); dual-admin at submit
**Entry:** Tile 'Add Stock (CSV)' (Stock > Add Stock hub, act:bulk_receive_goods → Strict/Lenient sub-menu); namespace br:*; /bulkformat sends template
**Lands in:** Inventory (row per than, fresh bale_uid) + GoodsReceipts header (file_hash, source_url) on approval; ApprovalQueue (payload staged to disk above 400 rows); AuditLog
**Approval:** Dual-admin (requester ≠ approver enforced even for admins)

| Field | Input | Notes |
|---|---|---|
| PO link | 🟢 tap | Chip per open PO (max 8) or Skip |
| Stock file | 📎 file | .csv/.xlsx, max 5 MB / 500 rows; required cols PackageNo, ThanNo, Design, Yards, Warehouse (+optional Shade/Supplier/NetMtrs/NetWeight/Notes/Color); validated + SHA-hash deduped against prior GRNs |
| Container / arrival batch | 🟡 mixed | Max 4 existing-batch chips or typed new label (sanitized, ≤24 chars); mandatory |
| Submit confirmation | 🟢 tap |  |
| Date / source / hash / Drive archive | ⚙️ auto | Archived to data/uploads + best-effort Drive |

**Refine:** Warehouse must be typed correctly in every CSV row instead of picked once in-chat (strict flow's pick-then-inject pattern could be unified); container chips cap at 4, no pagination (retyping splits containers); in-memory session — restart between preview and submit loses the upload (documented 13-Jul incident); validation errors capped at 15 lines with no downloadable report

### Add Stock (strict CSV / packing list)

**What:** Admin-only strict bulk receive: pick warehouse first, upload CSV or auto-detected supplier packing-list .xlsx, block on R1/R2 bale/design conflicts, then hand off to the dual-admin bulk pipeline.
**Who:** Admin-only (gated at start and every callback)
**Entry:** 'Add stock' under the Add Stock (CSV) sub-menu or typed 'Add stock'; namespace addstock:* (submit reuses br:submit)
**Lands in:** Inventory + GoodsReceipts on approval; ApprovalQueue; AuditLog gets add_stock outcome entries (conflict_blocked / preview_ready) + _strict marker; Drive archive deliberately skipped in v1
**Approval:** Dual-admin via bulk_receive_goods handoff

| Field | Input | Notes |
|---|---|---|
| Target warehouse | 🟡 mixed | Index chips of merged registry, or 'New warehouse' typed name (≤40 chars) — BYPASSES warehouseFlow's canonicalization, dedup and dual-admin registration |
| Stock file | 📎 file | .csv or packing-list .xlsx auto-converted to than rows (up to 6000); warehouse injected from pick; hash dedup; full validation + R1 (bale exists) / R2 (design exists) blocking conflict scan |
| Submit confirmation | 🟢 tap | Emits br:submit; session mutated to bulk_receive_flow shape |

**Refine:** Submit bounces to the bulk preview card just to pick a container (chips should be on the strict preview); typed 'New warehouse' silently creates an unregistered/unvalidated warehouse, breaking the WH-C1 single-path decision; no Drive archive means weakest forensics on the biggest whole-container uploads

### Photo Receive Goods (OCR)

**What:** OCRs a supplier packing slip photo/PDF into per-than rows the operator reviews row-by-row, then submits through the dual-admin bulk pipeline.
**Who:** Employees (Abdul primary); dual-admin at submit
**Entry:** Tile 'Photo Receive (image/PDF)' (act:photo_receive_goods); namespace pr:*
**Lands in:** Inventory + GoodsReceipts (source='ocr_vision_<provider>', source_url=Drive) on approval; ApprovalQueue (with editedRows audit); AuditLog; file to data/ocr + Drive
**Approval:** Dual-admin (bulk_receive_goods gate) preceded by per-row review gate blocking low-confidence rows

| Field | Input | Notes |
|---|---|---|
| PO link | 🟢 tap | Chip per open PO or Skip |
| Packing slip | 📷 photo | JPG/PNG/WebP/HEIC or PDF; archived local + Drive; OCR extracts rows with per-row confidence |
| Per-row decision (accept/skip/undo, accept-all) | 🟢 tap | Every row must be decided; low-confidence rows MUST be edited or skipped (Accept hidden) |
| Row corrections: PackageNo, ThanNo, Design, Shade, Yards, NetMtrs, NetWeight | 🟡 mixed | Tap field button then type value; coerced/validated per field; edits audit-trailed in editedFields |
| Warehouse | ⚙️ auto | NOT collected — inferred only when exactly one warehouse exists, else blank and submit-time validation fails |
| Supplier | ⚙️ auto | Blank unless OCR extracted it; NOT editable in review UI |
| Date / OCR provider / confidence / raw text / hash / Drive link | ⚙️ auto |  |

**Refine:** BROKEN with ≥2 warehouses: no warehouse picker, rows get warehouse '' and submit always fails after full review — needs a one-tap warehouse step; review card caps at 10 rows with no pagination (rows 11+ undecidable, canSubmit unreachable); editing any field clears the lowConfidence flag even if the suspect field wasn't corrected; supplier/notes not editable though they persist

### New Procurement Order (Procurement Plan)

**What:** Drafts and creates a purchase order (supplier + design/shade/qty lines + expected date) from the Procurement Plan screen.
**Who:** Admins only (not in any department CSV)
**Entry:** Tile '📋 Procurement Plan' (act:procurement_plan) → '➕ New Procurement Order' (pp:new); namespace pp:
**Lands in:** ProcurementOrders + ProcurementOrderLines sheets (typed suppliers also land in Contacts); admin-feed po.created
**Approval:** None — direct write, status jumps straight to SENT (no draft state), unlike every other write flow

| Field | Input | Notes |
|---|---|---|
| Supplier | 🟡 mixed | Chip from first 12 supplier Contacts, or typed name that IMMEDIATELY appends a new Contacts row (2–80 chars, no dedupe) |
| Line: design | 🟡 mixed | Chip (first 12 distinct inventory designs) or free-typed, unvalidated |
| Line: shade | 🟡 mixed | Chip (≤12), typed, or '🚫 No shade' |
| Line: qty bales | 🟡 mixed | Chips 5/10/20/30/50 or typed positive int |
| Expected date | 🟡 mixed | +7/+14/+30 chips, Skip, or typed YYYY-MM-DD (regex-only — 2026-99-99 and past dates pass) |
| qty_yards per line | ⚙️ auto | Hardcoded qty_bales × 50 |
| po_id / status / created_by | ⚙️ auto | Status written directly as SENT |

**Refine:** Zero supplier dedupe ('Chen Textiles' vs 'Chen Textile'); typed designs/shades unchecked against inventory, breaking later PO→GRN matching; 12-chip caps with no pagination/search; format-only date validation; qty_yards silently hardcoded at 50 yds/bale, no unit-price field so POs carry no cost data; no Back button and no line undo — one mis-tap restarts the draft; purchase commitment has no approval gate; module low-stock default (5) disagrees with Settings doc (100)


## Stock movement & warehouses

### Transfer Stock (staged, TRF-5) with dispatch/receive photo gates (TRF-6)

**What:** Records an inter-warehouse stock movement as a three-party chain: admin orders, dispatcher logs the actual bales with a mandatory load photo, receiver confirms arrival with a mandatory receipt photo before stock goes live at the destination.
**Who:** Wizard: admin-only; dispatch/receive legs: warehouse-assigned employees via DM cards (fallback: any active employee/manager)
**Entry:** Tile 'Transfer Stock' (Stock > Move Stock, act:transfer_stock); namespace trf:*; also via supply-cart handoff and My Tasks (trf:card:); gates armed via transfer_flow await_doc sessions routed by handleFileMessage
**Lands in:** ApprovalQueue row IS the transfer record (requested → in_transit → approved); Inventory rows transition available ↔ in_transit and change warehouse; one Transactions row on receipt; AuditLog per stage; dispatchDoc/receiveDoc {url,name,fileId,by,at} in actionJSON (no dedicated sheet column); photos to Drive + Telegram forwards
**Approval:** Dispatch-stage chain: dispatcher accept + load photo, then receiver confirm + receipt photo; decline/reject reverts bales to source; no dual-admin sign-off; admins can act as any party

| Field | Input | Notes |
|---|---|---|
| Source warehouse | 🟢 tap | Warehouses with available stock (needs ≥2) |
| Design | 🟢 tap | Top 30 by bale count, DCAT category labels |
| Shade | 🟢 tap |  |
| Quantity (bales) | 🟢 tap | Chips 1/2/5/10/All-N only — no custom amount |
| Destination warehouse | 🟢 tap | Warehouses with stock + warehouses users are assigned to |
| Dispatcher / Receiver | 🟡 mixed | Auto-picked when warehouse has exactly one assigned user; else picker of max 12 |
| Send order | 🟢 tap |  |
| Dispatcher: actual bale selection | 🟡 mixed | FIFO pre-selected toggles (max 21 visible); typed partial-number search (TRF-7); auto-pick shortcut |
| Dispatch load photo | 📷 photo | MANDATORY gate (jpeg/png/webp/heic/pdf; Skip retired) — nothing moves and nobody is notified until it lands; Drive best-effort + forwarded to receiver/admins/requester; uploader+timestamp auto |
| Receiver: receipt confirmation | 🟢 tap | Received / Reject on DM card; stale-stage taps refused; 'Not now' stands the gate down safely |
| Receipt photo | 📷 photo | MANDATORY gate — stock flips to available at destination only when the photo arrives; same Drive + forwarding |

**Refine:** Quantity is chips-only (3/7/15-bale transfers impossible from the wizard); declines/rejects capture no reason; dispatcher photo gate has no 'Not now' — in-memory session with hand-picked bales can expire and lose the picks; bale picker shows only first 21 and selection state dies on restart; Drive archive is best-effort (BKP-1 quota risk) leaving only a Telegram file_id

### Legacy Transfer Bale/Than flows (tp*/tt*) — retired but live handlers

**What:** Old single-item warehouse transfers via approval queue; superseded by staged Transfer Stock (TRF-5).
**Who:** No current entry point — tiles and typed intents all redirect to Transfer Stock; only a stale pre-redeploy session could still drive them
**Entry:** None (redirect banners); ~190 lines of handlers retained at controller lines 7120–7308 for back-compat
**Lands in:** ApprovalQueue → Inventory warehouse column on approval (legacy path)
**Approval:** Dual-admin (transfer_* in DUAL_ADMIN_ACTIONS)

| Field | Input | Notes |
|---|---|---|
| Bale / Than / destination warehouse | 🟢 tap | Would still queue legacy transfer_package/transfer_than if a stale session fires |

**Refine:** Dead-but-armed code that can still enqueue transfers bypassing the dispatcher/receiver photo controls TRF-5 was built for — delete once TRF-5 sign-off completes (pending owner test per CLAUDE.md)

### Warehouse Audit (session-only stock-take)

**What:** Admin walks the warehouse marking each bale/than present or missing; marks live only in the in-memory session and produce a transient chat reconciliation summary — zero inventory writes.
**Who:** Admin-only, behind config.warehouseAudit.enabled feature flag
**Entry:** Tile 'Warehouse Audit' (Warehouses hub, act:warehouse_audit); namespace wai:*; per-warehouse than/bale mode via Settings AUDIT_MODE.<warehouse>
**Lands in:** None — marks discarded on close/expiry; summary is a transient chat message
**Approval:** None (nothing written)

| Field | Input | Notes |
|---|---|---|
| Warehouse / design / shade / bale drill-down | 🟢 tap | Navigation chips; single-warehouse and single-bale levels auto-skip; design list caps at 30 |
| Bale closed/open verdict (bale mode) | 🟢 tap | 'Closed' bulk-marks all thans present; 'Open' drills into per-than chips |
| Per-than presence mark | 🟢 tap | Chip cycles unmarked → present → missing → unmarked |

**Refine:** Hours of physical stock-take tapping evaporate on session end or bot restart — persist the reconciliation (scope, present/missing counts, per-bale detail, auditor, timestamp) to AuditLog or a StockTakes sheet; missing thans get 'investigate' text with no bridge into a write/approval flow; 30-design cap with no pagination/search

### Add Warehouse (WH-C1)

**What:** Registers a new warehouse name in Settings WAREHOUSE_LIST so it appears in every receive/transfer picker.
**Who:** Admin hub tile, but flow itself un-gated (Receive Goods' 'New warehouse' delegates here for any operator; non-admins can request, never self-approve)
**Entry:** Tile 'Add Warehouse' (Warehouses hub, act:add_warehouse); namespace wh:*
**Lands in:** ApprovalQueue (add_warehouse); on approval Settings WAREHOUSE_LIST updated; AuditLog
**Approval:** Dual-admin (requester excluded)

| Field | Input | Notes |
|---|---|---|
| Warehouse name | ⌨️ type | NFC-normalized, whitespace-collapsed, Title-Cased; regex letters/digits/spaces/hyphens, 1–50 chars; case-insensitive dedup vs merged Inventory + WAREHOUSE_LIST registry — the best-validated typed input in the audit |
| Confirm / submit | 🟢 tap |  |

**Refine:** The flow itself is fine — the problem is addStockFlow's 'New warehouse' text path creating warehouse names WITHOUT this validation or gate; route that branch here as goodsReceiptFlow already does

### Warehouse Display Units (TV-2, bales ⇄ thans)

**What:** Requests flipping how one warehouse's stock counts render (bales vs thans) — an audited edit of THAN_VISIBILITY_WAREHOUSES.
**Who:** Admins and active managers request; approver must be a different admin
**Entry:** Tile '📐 Display Units' (warehouses hub, act:display_units); namespace udf:
**Lands in:** ApprovalQueue + AuditLog; on approval unitDisplayService writes Settings THAN_VISIBILITY_WAREHOUSES (idempotent, cache invalidated)
**Approval:** Single-admin (set_unit_display in ALWAYS_APPROVAL_ACTIONS); duplicate guard per warehouse

| Field | Input | Notes |
|---|---|---|
| Warehouse | 🟢 tap | One-per-row list showing current mode (🧵/📦) |
| Target mode | ⚙️ auto | Always the toggle of current — user confirms '✅ Request switch to X' |

**Refine:** Near-frictionless; no optional reason field for the approver; unpaginated warehouse list will get tall if warehouses grow

### Allocate to Marketer (MKT-2)

**What:** Admin assigns (or removes) a design + bale quantity to a marketer's consignment view, controlling exactly what that marketer sees and sells.
**Who:** Admins only (gated in start() and controller)
**Entry:** Tile '🧑‍💼 Allocate to Marketer' (Marketers hub, act:allocate_marketer); namespace mal:; session mal_flow
**Lands in:** MarketerAllocations sheet (overwrite semantics; qty 0 removes) + AuditLog; marketer auto-DM'd on every change
**Approval:** None — deliberate direct admin write bypassing the queue (fast test cycles; 'easy to gate later')

| Field | Input | Notes |
|---|---|---|
| Marketer | 🟢 tap | Active role=marketer users, annotated with current allocation counts |
| Design | 🟢 tap | All distinct designs, category-labelled, paginated 24/page |
| Quantity (bales) | 🟢 tap | Fixed chips 1/2/3/5/10/20 + 'Remove (0)' — NO typed fallback |
| Confirm | 🟢 tap | Shows current allocation + live stock as reference |

**Refine:** Quantity chips can't express 4/7/15/25 and there's no typed escape hatch — the one flow genuinely missing one; no validation against available stock (can allocate 20 of a design with 3 in stock); overwrite-only semantics silently clobber previous figures; no approval gate on a write that instantly changes a marketer's book — add at least dual-admin past the test phase


## Money, receipts & branch operations

### Upload Payment Receipt (receipt_flow, rc*)

**What:** Employee logs a customer payment by attaching the bank receipt photo/PDF for admin verification and Drive archival.
**Who:** Any allowed employee or admin (typically sales/branch staff)
**Entry:** Tile act:upload_receipt or typed 'Upload receipt' → startReceiptFlow (telegramController.js:2927, session receipt_flow); callbacks rcc:/rcb:/rcconf:/rcapr:/rcrej:
**Lands in:** Receipts sheet cols A-O (receipt_id, customer, amount, bank_account, uploader ids, telegram_file_id, drive ids, status, approver, dates, notes) + BranchOpsLog pointer; on approval the Telegram file is downloaded and re-uploaded to Drive, cols I-L updated
**Approval:** Single admin approve/reject; admin uploader → only OTHER admins get the card. Runs on its own rcapr/rcrej button pipeline, NOT the ApprovalQueue sheet

| Field | Input | Notes |
|---|---|---|
| Customer | 🟢 tap | Top-10-by-volume picker + 'See all' pagination + ➕ Register New |
| New customer name + phone | ⌨️ type | ➕ path only — appends Customers status=Pending, queues new_customer_registration approval, flow pauses then resumes at amount step |
| Amount (NGN) | ⌨️ type | Free-typed, comma-tolerant, >0 only — no upper bound, no cross-check vs customer outstanding balance |
| Bank account | 🟢 tap | Settings BANK_LIST chips + 'Cash' |
| Receipt file | 📷 photo | Photo or PDF, mandatory (text rebuffed at this step) |
| Confirm | 🟢 tap | Appends Receipts row status=pending; uploader id/name auto-stamped |
| Admin approve/reject | 🟢 tap | rcapr/rcrej buttons DM'd to admins with the file re-sent |

**Refine:** Approving a receipt posts NO ledger entry (record_payment is a separate typed action — books vs receipts drift); approval state lives only in admin DMs (lost DM = unrecoverable); synchronous Drive upload at approval hits the BKP-1 quota risk and stale file_ids error with no retry; amount typed with no outstanding-balance chip or sanity check; rejection collects no reason; no duplicate-receipt detection; notes column never populated

### Office Expense (batch, ofex:)

**What:** Batch entry of petty office expenses (water, fuel, sundries) by a branch manager, queued as one approval carrying all items.
**Who:** Branch managers (tile via Departments.allowed_activities; no in-flow role gate)
**Entry:** Tile '💸 Office Expense' (daily hub, act:office_expense) + branch status panel shortcut; namespace ofex:
**Lands in:** BranchOpsLog sheet (eager rows status=pending_approval, flipped on decision) + ApprovalQueue + AuditLog
**Approval:** Single-admin (record_office_expense in WRITE_ACTIONS); admin requester excluded; approval only flips status — typos must be hand-edited on the sheet before approving

| Field | Input | Notes |
|---|---|---|
| Expense title | 🟡 mixed | Adaptive quick-pick chips (seed titles + manager's own time-decayed most-used) or '✏️ Other' free text ≤80 chars |
| Amount (NGN) | 🟡 mixed | Typed, or one-tap '✓ ₦X (last time)' chip when title used before; >0, ≤₦5,000,000 |
| Branch | ⚙️ auto | Resolved from Users.branch / warehouses[0] / manages, fallback 'HQ' |
| Date + manager identity | ⚙️ auto | todayInTz() + Users lookup |

**Refine:** No in-bot edit of a queued item (admin sheet surgery required); free-text titles unnormalized ('Bike fuel' vs 'fuel bike') fragmenting reports — add a category chip (Fuel/Water/Stationery/Other); no receipt-photo attachment despite the Upload Receipt flow existing; undo-last only, no arbitrary item removal from a 15-item batch; no in-batch duplicate warning

### Open Branch (Daily) (bops:)

**What:** Records the branch manager's morning opening routine: camera health check and opening cash count.
**Who:** Branch managers (tile via Departments CSV; branch auto-resolved)
**Entry:** Tile '🌅 Open Branch (Daily)' (daily hub, act:daily_branch_ops); namespace bops:; idempotent re-tap shows day status panel
**Lands in:** BranchOpsLog sheet (daily_open + camera_check + opening_cash rows) + AuditLog (branch_opened)
**Approval:** None — direct write on Confirm (idempotent per branch+date)

| Field | Input | Notes |
|---|---|---|
| Camera working? | 🟢 tap | [✅ Working] / [⚠️ Issue] chips |
| Camera issue note | ⌨️ type | Optional ≤120 chars when Issue picked; skippable |
| Opening cash (NGN) | ⌨️ type | ≥0, ≤₦50,000,000; or [Skip] if already counted |
| Branch / date / manager | ⚙️ auto | resolveBranch + todayInTz + Users lookup |

**Refine:** Camera 'Issue' is text-only — a photo of the dead camera/DVR would be far stronger evidence; opening cash is honor-system with no till photo and no reconciliation vs prior close (closeDay is a V2 stub); Skip vs 0 semantics unexplained; Back from cash step wipes the camera answer; broken-camera reports land silently in the sheet with no admin notification

### Finalize Landed Cost (lcost:)

**What:** Records the final landed cost of a goods receipt: USD cost/yard plus itemised import charges, allocated across yardage and converted at a locked FX rate.
**Who:** Admins only
**Entry:** Tile '💵 Finalize Landed Cost' (finance hub, act:finalize_landed_cost); namespace lcost:
**Lands in:** ApprovalQueue at submit; on approval lc_* columns (lc_usd_per_yard, lc_fx_rate, lc_ngn_per_yard, lc_status=finalized) sealed onto the GoodsReceipts row
**Approval:** Dual-admin (finalize_landed_cost in ALWAYS_APPROVAL_ACTIONS); 2nd admin sanity-checks the NGN/yard preview

| Field | Input | Notes |
|---|---|---|
| GRN | 🟢 tap | Provisional GRNs — only first 10 shown, '…N more' overflow is a noop |
| USD cost per yard | ⌨️ type | >0, ≤10,000, stored to 6 dp |
| Charge type (per charge) | 🟢 tap | From LandedCostTypes catalogue; re-tap ✓ type for a 2nd entry |
| Charge amount USD (per charge) | ⌨️ type | >0, ≤$10,000,000 |
| FX rate USD→NGN | ⚙️ auto | From manual ForexRates sheet, latest on/before GRN receipt date; if absent the flow STOPS and tells the admin to edit the sheet and retry |

**Refine:** Destructive Back wipes ALL entered charges (charges=[]) — one wrong charge means retyping everything; GRN picker caps at 10 with dead noop; missing FX rate forces a manual sheet edit mid-flow (add an audited 'type rate now' step); no last-used amount chips for recurring charges (clearance/agent fees repeat per container); can't edit usdPerYard from review without wiping charges

### Incentive Payouts — Mark Paid (taskFlow, finance)

**What:** Finance records that an earned task incentive was actually disbursed to the employee.
**Who:** Finance only (config.access.financeIds); tile hidden from others, handler re-checks
**Entry:** Planning-hub 'payouts' tile → per-row '✅ Mark paid' (tsk:py:p:<taskId>)
**Lands in:** Incentives sheet (paid_status/paid_amount/paid_at) + TaskEvents 'finance_marked_paid'; doer gets payment-receipt DM; adminFeed 'payout.paid'
**Approval:** Gated upstream — only incentives whose task was already approved (awaiting_payout) are payable

| Field | Input | Notes |
|---|---|---|
| Mark paid | 🟢 tap | One tap per incentive; only awaiting_payout rows payable |
| paid_amount / paid_at | ⚙️ auto | Copied from agreed amount; stamped now |

**Refine:** No payment reference captured (transfer ref / cash voucher / partial vs full) — add an optional typed reference or receipt-photo; one tap with no confirm and irreversible in-bot


## People, roles & attendance

### Mark Attendance (ATT-C1)

**What:** Records that an employee is present today at a specific business location.
**Who:** Only employees on the Settings ATTENDANCE_REQUIRED_USERS list; others get a polite denial
**Entry:** HR-hub tile '📍 Mark Attendance' (act:mark_attendance, injected into greeting menu); namespace atd:*; handled entirely by attendanceFlow.js
**Lands in:** Attendance sheet cols A-I (date, telegram_id, name, status='present', location, logged_at, logged_via, marked_by, reason) + AuditLog 'attendance.marked'
**Approval:** None — single-tap write; corrections require an audited admin override

| Field | Input | Notes |
|---|---|---|
| Location | 🟢 tap | Admin-managed ATTENDANCE_LOCATIONS chips; re-validated server-side; no free text, no GPS, no photo |
| Date / logged_at | ⚙️ auto | Configured timezone; idempotent per (date, telegram_id) — already-logged short-circuits to read-only card |
| Name | ⚙️ auto | Users sheet lookup by Telegram ID |
| logged_via | ⚙️ auto | 'self' vs 'admin' (mark-on-behalf) |

**Refine:** Already fully tappable. Location is honor-system with zero verification (optional Telegram live-location would corroborate — notable asymmetry vs photo-gated transfers); no check-OUT so no working-hours duration; no self-service fix for a wrong location tap (admin round-trip); Back-to-menu asks the user to send /menu manually

### Attendance Admin hub (ATT-C2)

**What:** Admin configures attendance (required users, locations, times, timezone, working days) and marks employees present on their behalf.
**Who:** Admins only (double-checked)
**Entry:** HR-hub tile '🗓 Attendance' (act:attendance_admin); namespace atd_adm:*; free-text steps await_time/await_tz/await_location_new (text-router hook at controller line 3414)
**Lands in:** Settings ATTENDANCE_* keys via attendanceService.setConfigKey; mark-on-behalf → Attendance sheet + AuditLog; ghost cleanup audited
**Approval:** None — admin-direct, immediate (mark-on-behalf audited but not second-approved)

| Field | Input | Notes |
|---|---|---|
| Required users | 🟢 tap | Multi-select toggle over active Users; ghost IDs auto-cleaned; 'Clear all' |
| New location name | ⌨️ type | Trimmed, silently truncated to 40 chars; case-insensitive dupes silently ignored with no feedback |
| Delete location | 🟢 tap | Single 🗑 tap deletes immediately — no confirm, no undo |
| Reminder / report / cutoff times | ⌨️ type | Three HH:MM 24h fields, regex-validated retry loop |
| Timezone | ⌨️ type | IANA string, shape-regex + Intl probe; bad-but-parseable zones silently fall back to UTC |
| Working days | 🟢 tap | Mon–Sun toggles, canonical order |
| Mark-on-behalf: employee + location | 🟢 tap | Picker limited to required users not yet logged today; entry stamped logged_via=admin; backfill time+reason typed |

**Refine:** Three HH:MM typed fields are prime chip candidates (hour grid + :00/:15/:30/:45); timezone should be a chip list of the 5–10 zones the business uses; location delete is one un-confirmed tap that silently strips employees' pickers; silent dedupe gives no 'already exists' feedback

### Add Employee (USR-C3)

**What:** Onboards a new employee into the Users sheet with branch, department, warehouses and role.
**Who:** Admins only
**Entry:** HR-hub tile '➕ Add Employee' (act:add_user); namespace usr:*; 30-min session TTL; typed 'add user' NL prefill also launches it
**Lands in:** ApprovalQueue (add_user) + AuditLog; on 2nd-admin approval Users row appended, department attached, PendingUsers row marked onboarded, auth cache invalidated
**Approval:** Dual-admin — submitter excluded from approver notification, cannot self-approve

| Field | Input | Notes |
|---|---|---|
| telegram_id | 🟡 mixed | Preferred: tap a PendingUsers tile (people who /start-ed, paginated, name + age badge); fallback typed 6–12 digits with live dup-check against ACTIVE users only |
| Name | 🟡 mixed | Prefilled from Telegram profile with one-tap accept chip, else typed 1–80 chars |
| Branch | 🟢 tap | Settings BRANCH_LIST chips; Skip when none configured |
| Department | 🟡 mixed | Existing chip OR '➕ New department' → typed name (created on approval) |
| Warehouses | 🟢 tap | Multi-select, pre-ticked to the branch's mapped warehouses; Clear; zero allowed |
| Role | 🟢 tap | employee / manager / marketer / salesman (admin excluded by design) |
| Manages (managers only) | 🟢 tap | Multi-select of departments headed; may be empty |
| Confirm | 🟢 tap | Full summary with field-role warehouse warning |

**Refine:** Confirm-card 'Back to Step 4' instruction is off-by-one (warehouses are Step 5); marketer/salesman without a warehouse only warned, not blocked (useless view-only account can be dual-approved); dup-check ignores deactivated users so re-adding creates a second Users row instead of offering reactivation

### Promote to Admin (USR-C3b)

**What:** Requests elevation of an existing non-admin user to admin.
**Who:** Admins initiate; super-admins approve
**Entry:** HR-hub tile '👑 Promote to Admin' (umg:start:promote); namespace umg:*
**Lands in:** ApprovalQueue (promote_admin) + AuditLog; on approval Users role→admin
**Approval:** Super-admin only (SUPER_ADMIN_IDS enforced in approvalEvents); submitter excluded

| Field | Input | Notes |
|---|---|---|
| Target user | 🟢 tap | Paginated picker of active non-admins showing name · dept · role |
| Confirm | 🟢 tap | Restates name/ID/role/dept + super-admin requirement |

**Refine:** All-tap, appropriately heavy gate; no justification field — the super-admin sees who and by whom but never why; a short optional note would improve the decision and audit trail

### Deactivate User (USR-C4)

**What:** Requests revocation of an employee's bot access (status→inactive, history preserved).
**Who:** Admins only
**Entry:** HR-hub tile '🛑 Deactivate User' (umg:start:deactivate); namespace umg:*
**Lands in:** ApprovalQueue (deactivate_user) + AuditLog; on approval Users status→inactive
**Approval:** Dual-admin; submitter excluded

| Field | Input | Notes |
|---|---|---|
| Target user | 🟢 tap | Paginated picker of ALL active users — admins included |
| Confirm | 🟢 tap |  |

**Refine:** No reason captured — resignation vs termination vs suspension look identical in queue and audit; a 3-chip reason picker costs one screen. No last-admin guard: two admins could in principle lock out the final admin

### Change Role (MKT-1)

**What:** Switches an existing non-admin user between employee/manager/marketer/salesman.
**Who:** Admins only
**Entry:** Manage Users → rol:start; namespace rol:*
**Lands in:** Users sheet directly (updateRole) + AuditLog 'role_changed'; auth cache invalidated
**Approval:** None — deliberate single-admin direct write

| Field | Input | Notes |
|---|---|---|
| Target user | 🟢 tap | Paginated picker of active non-admins |
| New role | 🟢 tap | 4 chips, current marked; WRITES IMMEDIATELY on tap — no confirm step |

**Refine:** Role applies on the selecting tap itself — a mis-tap instantly rewrites someone's menu and permissions (manager→marketer strips access mid-negotiation); add the standard 2-step confirm. Warns (doesn't block) warehouse-less field roles, with a helpful 'Assign Warehouses' jump chip

### Notification Preferences (T2)

**What:** Each admin opts in/out of Admin Activity Feed event types (task assigned/declined/completed, payouts, etc.).
**Who:** Admins only (every handler re-checks)
**Entry:** Reporting-hub tile '⚙️ Notifications' (act:notifications → nf:open); namespace nf:*
**Lands in:** Users sheet notification_prefs column (setNotificationPref / updateNotificationPrefs)
**Approval:** None — personal preference, immediate

| Field | Input | Notes |
|---|---|---|
| Per-event ON/OFF toggles | 🟢 tap | One pill per catalog event; each tap persists then re-renders |
| Reset to defaults | 🟢 tap | Clears prefs so DEFAULT_POLICY resumes; no confirm (blast radius own prefs only) |

**Refine:** Every toggle does a full Users-sheet read+write+re-render — slow against Sheets on rapid multi-toggling and can race (last-write-wins on the prefs JSON); a batch-apply or optimistic UI would smooth it


## Tasks & incentives

### Assign Task (6-step picker)

**What:** A manager creates and assigns a work task to a subordinate, opening the timeline-negotiation workflow.
**Who:** Managers (Users.manages non-empty, dept-subtree-scoped) or admins (whole company)
**Entry:** Planning-hub tile '➕ Assign Task' (act:assign_task); namespace tsk:*; typed 'assign task' just launches the same flow
**Lands in:** Tasks sheet (via taskStateMachine.create) + TaskEvents 'assigned'; assignee DM; adminFeed broadcast
**Approval:** No gate at creation, but task can't start until negotiation handshake completes (propose → accept → final-ack, max 3 rounds)

| Field | Input | Notes |
|---|---|---|
| Assignee | 🟢 tap | Paginated 2-col picker (8/page) with dept/warehouse subtitles for disambiguation |
| Title | ⌨️ type | 3–100 chars, length-validated with retry |
| Priority | 🟢 tap | critical/high/normal/low, default normal |
| Track | 🟢 tap | Salaried vs Incentivized; incentivized defers ₦ amount to post-proposal |
| Description | ⌨️ type | Optional ≤500 chars, Skip chip |
| Confirm | 🟢 tap | Summary card |

**Refine:** Title/description are inherently free-text, but recurring operational tasks ('stock count', 'load truck') could be title-template chips to cut typing on repeat assignments; everything else already tappable with back/cancel

### Propose Timeline (doer side)

**What:** The assignee commits an effort estimate and completion deadline for a newly assigned task.
**Who:** The task's assignee only (server-side check)
**Entry:** '⏱ Propose timeline' on the task DM card / My Tasks (tsk:prp:); session task_propose_flow
**Lands in:** Tasks sheet (proposed_hours, proposed_deadline, status→awaiting_timeline_ack) + TaskEvents; assigner DM'd proposal card
**Approval:** Assigner Accept (or Counter, ≤3 rounds); incentivized track additionally blocks Accept until amount set

| Field | Input | Notes |
|---|---|---|
| Effort hours | 🟡 mixed | 8 preset chips (1h–1w) or Custom typed; 0 < h ≤ 720, decimals allowed |
| Deadline | 🟢 tap | 5 relative chips (Today…+2 weeks) or inline mini-calendar (past disabled, ≤6 months); never typed |
| Confirm | 🟢 tap |  |

**Refine:** Excellent tap coverage. No cross-validation of hours vs deadline (168h due 'Today' sails through — cheap sanity warning would catch it); Decline is one tap with no reason — a 3-chip reason picker (too busy / not my area / need info) would make the declined feed actionable

### Timeline Negotiation — Accept / Counter / Renegotiate / Decline / Cancel

**What:** Assigner and doer converge on (or abandon) the task deal via a capped back-and-forth.
**Who:** Accept/Counter/Cancel: assigner or admin; Renegotiate/Decline/Final-ack: assignee — enforced by taskStateMachine actor roles
**Entry:** DM card buttons tsk:acc / cnt / rng / dec / cnl / fa
**Lands in:** Tasks sheet status/timestamps + one append-only TaskEvents row per action
**Approval:** The negotiation IS the gate — mutual assent required before the task goes active

| Field | Input | Notes |
|---|---|---|
| Counter note | ⌨️ type | Optional ≤200 chars; 'Send without note' skip |
| Accept / renegotiate / decline / final-ack / cancel | 🟢 tap | Single-tap transitions; 3-round cap engine-enforced |

**Refine:** Renegotiate captures no reason (unlike Counter's optional note) — symmetric treatment would help; Cancel-task is reasonless, one-tap, sits directly under Counter with no confirm — a mis-tap kills the task irreversibly

### Set Incentive (incentivized track)

**What:** The assigner records the ₦ bonus the doer will earn for an incentivized task.
**Who:** Assigner or admin; only while status is awaiting_timeline_ack
**Entry:** '💰 Set incentive' on the proposal card (tsk:six:); session task_incentive_flow
**Lands in:** Incentives sheet (setAmount — money never touches Tasks sheet) + TaskEvents 'assigner_set_incentive'
**Approval:** Sub-gate: Accept-timeline withheld and server-blocked until an amount exists

| Field | Input | Notes |
|---|---|---|
| Amount (₦) | 🟡 mixed | Typed digits (0 ≤ n ≤ 100,000,000) or 'Skip (₦0)' chip which COUNTS AS SET |

**Refine:** Typed amount should be preset chips (₦1k/2k/5k/10k + Custom) — amounts cluster heavily; error text demands whole numbers but the regex accepts decimals which persist; 'Skip → ₦0 counts as set' is a semantic trap locking a ₦0 deal when the assigner meant 'decide later'

### Mark Done & Sign-off (tap + typed NL path)

**What:** The doer declares work finished; the assigner/admin approves completion or sends it back.
**Who:** Mark done: assignee only (tap or typed 'Mark task TASK-… done'); approve/reject: assigner or any admin (Pending Sign-off queue)
**Entry:** '✅ Mark done' (tsk:done:) on task card / My Tasks; typed NL intent mark_task_done (exact TASK id regex-extracted); assigner via DM card or 'Pending Sign-off' tile (tsk:sign:ok|no:) — the NL path's admin card is approve_task:<id> with NO reject option
**Lands in:** Tasks sheet timestamps + TaskEvents; Incentives paid_status on approve; DMs both parties; adminFeed
**Approval:** Assigner/admin sign-off gate — completed only after explicit approve; reject loops back to active (tap path only)

| Field | Input | Notes |
|---|---|---|
| Mark done | 🟡 mixed | One tap → status submitted (legacy tasks fast-forward); or typed exact TASK-YYYYMMDD-NNN id |
| Approve / reject | 🟢 tap | One tap each; approve on incentivized track flips Incentives to awaiting_payout; NL-path card can only approve or ignore |
| submitted_at / completed_at / approved_at | ⚙️ auto |  |

**Refine:** Mark-done carries no evidence — an optional photo (finished bale count, loaded truck) would give the approver something to sign off against, especially on the paying incentivized track; reject is reasonless ('re-check and tap again'); typing an exact TASK id is hostile when the tap path exists; the NL approval card has no reject/bounce option at all

### Manager Controls — Re-prioritize & Drop

**What:** The assigner changes an open task's urgency or removes no-longer-needed work.
**Who:** The task's assigner or an admin, from Team Tasks (managers/admins only)
**Entry:** '🔝 Prio' / '🚫 Drop' per task in Team Tasks (act:team_tasks; tsk:prio_pick/prio_set/drop_ask/drop_go)
**Lands in:** Tasks sheet (priority / status→dropped) + TaskEvents; doer DM; adminFeed
**Approval:** None beyond assigner-or-admin actor check — immediate

| Field | Input | Notes |
|---|---|---|
| New priority | 🟢 tap | 4-chip picker, current ✓; no-op if unchanged; doer DMed (audible only when raised to high/critical) |
| Drop reason | ⌨️ type | Optional ≤200 chars, or 'Confirm drop' with no reason; blocked on submitted tasks |

**Refine:** Well designed (confirm + optional reason). Minor race: tapping Confirm while typing the reason silently loses the draft — drop_go submits with empty reason regardless


## Catalogue, pricing & typed-command surface

### Set Design Category (DCAT-1)

**What:** Maps a fabric design number to a product-category label (Cashmere / Chinos / Gaberdine / Senator / TR / …) stamped on Inventory column W.
**Who:** Admins only (tile gate + in-module check)
**Entry:** Tile '🏷️ Set Design Category' (designs hub, act:set_design_category); namespace dcat:
**Lands in:** ApprovalQueue + AuditLog; on approval Inventory design_category (col W) stamped on every row of the design, read cache force-refreshed
**Approval:** Dual-admin (self-approval blocked; one pending change per design)

| Field | Input | Notes |
|---|---|---|
| Design | 🟢 tap | Paginated chip grid (24/page); chips show current category so unmapped designs are spottable |
| Category | 🟢 tap | 5 defaults ∪ distinct labels already in Inventory; current pre-marked ✓ |
| Confirm | 🟢 tap | From→to summary card |

**Refine:** 100% tap (good) but no '✏️ New category' free-text option — a brand-new label requires a manual sheet edit first, contradicting the module's own header comment; no type-to-search on the design picker (paging 24-chip screens through hundreds of designs); no 'unmapped only' filter — the actual working set for this job

### Update Price (up*)

**What:** Admin re-prices a design (one shade or all) per yard.
**Who:** Admins only (both tap and typed paths)
**Entry:** Tile act:update_price (session update_price_flow), or typed 'Update price of 44200 BLACK to 1500' which skips the pickers entirely
**Lands in:** ApprovalQueue + AuditLog; on approval Inventory price column updated + Transactions audit row
**Approval:** Dual-admin (ALWAYS_APPROVAL + DUAL_ADMIN); requester excluded; single-admin deployments auto-approve typed path

| Field | Input | Notes |
|---|---|---|
| Design | 🟢 tap | Grid capped at ~45 designs, no pagination or search — silently unusable past that |
| Shade | 🟢 tap | Per-shade bale counts + 🎨 All shades; non-blocking warning if no catalog photo (PRICE-VIS-C1) |
| New price/yard | 🟡 mixed | Nudge presets ±₦5/10/20 off current, or Custom typed — no sanity ceiling vs current price |
| Confirm | 🟢 tap |  |
| Typed one-liner (alt path) | ⌨️ type | design/shade/warehouse/price intent-extracted; queued with NO preview; auto-executes when only 1 admin configured |

**Refine:** 45-design cap with no search; ±₦5–20 nudges trivial against ₦1000+ prices (percent nudges fit better); no typo guard (15000 vs 1500 reaches the approver); typed path has no confirmation preview

### Add Contact via NL (+ in-flow supplier quick-adds)

**What:** Adds a phonebook entry (worker/customer/agent/supplier/other) from a single typed message; supplier quick-adds also exist inside goods-receipt and procurement flows.
**Who:** Any employee (routes to approval); admins direct; in-flow supplier quick-adds (goodsReceiptFlow.js:530, procurementPlanView.js:559) are direct writes for anyone in those flows
**Entry:** Typed 'Add contact Ibrahim, worker, phone +234…, address Kano' → intent add_contact
**Lands in:** Contacts sheet A-G via contactsRepository.append; employee submissions execute post-approval
**Approval:** add_contact in WRITE_ACTIONS → employee queues, admin direct; in-flow supplier quick-adds bypass approval entirely (inconsistent)

| Field | Input | Notes |
|---|---|---|
| Name | ⌨️ type | From intent parser slot |
| Type | ⌨️ type | Regex keyword (worker·customer·agent·supplier·other), defaults 'other' |
| Phone | ⌨️ type | Regex or bare +digits; no format validation |
| Address / notes | ⌨️ type | Regex capture stops at the first comma |

**Refine:** Most fragile capture in the bot: commas truncate addresses, no phone validation, no duplicate-name check, and no guided/tappable flow exists at all — obvious candidate for the flow-module recipe

### Customer Follow-up & Notes via NL

**What:** Schedules a dated reminder to chase a customer (payment, order, etc.); sibling add_customer_note appends free-text notes.
**Who:** Follow-ups: ADMIN-only; customer notes: any employee, no approval
**Entry:** Typed 'Follow up with CJE on 28-02-2026 about payment' → intent add_followup; 'add note …' → add_customer_note
**Lands in:** CustomerFollowups sheet A-H (FUP-*, status=pending, reminder_sent) direct append; CustomerNotes likewise (unaudited)
**Approval:** None — direct write (admin-only gate is the only control on follow-ups)

| Field | Input | Notes |
|---|---|---|
| Customer | ⌨️ type | Intent slot; NO existence check against Customers |
| followup_date | ⌨️ type | parseLedgerDate; hard-fails without a date |
| Reason | ⌨️ type | Brittle 'about/for/regarding' regex, defaults 'General follow-up' |

**Refine:** No tappable flow despite every other date+customer capture having chips/calendar; unvalidated customer names can point reminders at nonexistent customers; non-admin employees have no follow-up capture path at all

### Typed natural-language command surface (intentParser)

**What:** Free text mapped by OpenAI (20 parses/user/min, regex fallback) to ~60 enum actions — several trigger direct data writes or launch collection flows.
**Who:** All allowed users EXCEPT field roles (marketer/salesman hard short-circuited to My Products); several actions add admin gates
**Entry:** Any non-greeting free text no active session consumes; every message audit-logged (200-char slice) before parsing
**Lands in:** Varies: ApprovalQueue, Settings (banks), Samples, Tasks, Orders, Contacts, Customers, CustomerNotes, CustomerFollowups, Inventory (/revert_packages); every inbound message → AuditLog
**Approval:** Mixed — the biggest audit finding is inconsistency: typed add_bank/remove_bank and /revert_packages write directly despite sitting in ALWAYS_APPROVAL + DUAL_ADMIN lists; sample status updates and customer notes are unaudited direct writes

| Field | Input | Notes |
|---|---|---|
| sell_* / transfer_* | ⌨️ type | Recognised then REDIRECTED to the tappable Sell Bale / Transfer Stock flows (owner mandate) |
| return_than / return_package | ⌨️ type | Queued straight to dual-admin approval, no confirm preview |
| update_price | ⌨️ type | Admin-only one-liner; auto-executes when only one admin exists |
| add_customer / record_payment / add_contact | ⌨️ type | Regex-scraped fields; employee→approval, admin→direct (record_payment always gated, writes ledger on approval) |
| add_bank / remove_bank | ⌨️ type | Admin-only but writes Settings BANK_LIST DIRECTLY — bypasses the dual-admin gate risk/evaluate.js declares and the tap Bank Manager honours |
| give_sample / return_sample / update_sample | ⌨️ type | Issue drops into legacy typed path; status updates are DIRECT Samples writes, no approval, any employee |
| mark_task_done / mark_order_delivered / add_followup / add_customer_note | ⌨️ type | Typed ids/slots; mix of gated and direct writes |
| /revert_packages, /ledger | ⌨️ type | Slash commands outside the parser; /revert_packages mutates Inventory DIRECTLY, admin-only, no approval |

**Refine:** Policy drift (S4 lint checks enum↔policy membership, not handler behaviour); typed destructive actions have no confirmation preview; literal-value rule preserves customer-name typos with no fuzzy match before queueing; regex fallback silently degrades most actions to 'check' when OpenAI is unavailable; give_sample lands in the legacy typed-date path instead of the calendar flow


## Top 10 automation / refinement opportunities (by impact)

1. Sell Bale (ST-1): capture the negotiated rate from the seller (with a last-paid-rate chip) and pre-fill the admin enrichment step from the seller's in-flow payment-mode pick — today payment mode is entered twice and the rate not at all, on the business's highest-value daily flow.
2. Sell Bale / Bundle Sale / Update Price / Finalize Landed Cost: replace the dead '…N more' noop overflow buttons (12-chip bale list, 12-design grids, 10-GRN picker, 45-design price cap) with pagination plus type-to-filter — stock and GRNs beyond the cap are currently unreachable on small phone screens.
3. Photo Receive Goods (OCR): add a one-tap warehouse picker and paginate the 10-row review card — with two or more registered warehouses the flow is unusable (submit always fails after the operator has reviewed every row) and slips longer than 10 rows can never reach canSubmit.
4. Bundle Sale: source payment-mode chips from Settings BANK_LIST (capturing the actual receiving bank), record the salesperson's name instead of a raw Telegram id, and add the mandatory sales-bill photo step — aligning Kano bundle sales with Sell Bale's evidence and reconciliation bar.
5. Upload Payment Receipt: auto-post the ledger entry when an admin approves a receipt and offer the customer's outstanding-balance as a one-tap amount chip — closing the books-vs-receipts drift and catching fat-fingered typed amounts.
6. Typed NL commands: route add_bank/remove_bank and /revert_packages through the approval queue their own risk table mandates, and add a confirm preview to typed return_than/return_package — the highest-risk policy drift in the audit (direct bank-list and inventory mutations).
7. Transfer Stock: add a typed-custom quantity option next to the 1/2/5/10/All chips (3, 7 or 15-bale transfers are impossible today) and persist dispatcher bale picks plus the photo-gate state to disk so a bot restart or session expiry doesn't force a full re-pick.
8. Receive Goods (GRN): check typed bale numbers against existing Inventory (reusing Add Stock's R1/R2 scan) and show closest-match chips before accepting free-typed new suppliers/designs — stopping duplicate bale numbers and typo-variant master data at the door.
9. Warehouse Audit: persist the reconciliation result (scope, present/missing counts, per-bale detail, auditor, timestamp) to AuditLog or a StockTakes sheet and offer a bridge into the approval pipeline for missing stock — hours of physical stock-take tapping currently evaporate on session end.
10. New Procurement Order: validate typed designs/shades against inventory and fuzzy-dedupe typed suppliers before writing Contacts, add real date validation and an approval gate before status SENT — unvalidated POs currently break downstream PO-to-GRN receive matching and commit purchases with zero oversight.
