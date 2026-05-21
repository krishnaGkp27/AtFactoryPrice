# Vision — Textile Trading Bot

> **Status:** captured 2026-05-21 from owner verbal brief. NOT a commitment list — this is the discussion document.
> **Audience:** owner (John) + bot maintainer. Reread on next planning session.
> **North star:** the bot evolves from "internal ops tool" → "two-sided textile trading platform" where employees AND registered wholesale customers transact directly through Telegram, with finance, HR, warehouse and document workflows around it.

---

## §0 · How to use this document

1. Each numbered item below is a **work cluster**, not a single commit. A cluster typically breaks into 3–8 commits.
2. Items are NOT in build order — see [§3 Suggested Build Order](#3--suggested-build-order) for that.
3. Every cluster lists: **What**, **Why**, **Open questions**, **Depends on**, **Overlaps with**, **Effort** (S = ≤1 day, M = ≤1 week, L = ≤1 month, XL = multi-month).
4. Overlaps matter — many of the 11 items share substrate. Pick the substrate-builder first, then the dependent items get cheaper.

---

## §1 · The 11 work clusters

### 1.1 — Marketer daily price + sale-request handshake

**Owner's words (paraphrased):**
> Marketer sees current price-of-the-day. Customer asks for an estimate. Marketer asks admin to confirm price. Customer confirms quantity (in yards). Marketer raises a Sale Request to admin. Admin approves → sale lands in books.

**What:**
- New marketer-facing screen: "💰 Today's Prices" — list of designs in stock with admin-set NGN selling rate.
- Marketer flow: pick design → enter customer + yards → bot issues a price-quote request to admin → admin replies with the day's rate (or override) → marketer confirms with the customer → "Submit Sale Request" → enters the existing dual-admin `sell` approval queue.

**Why:** today the marketer has no way to surface a price-check to admin without leaving the bot. This closes the loop end-to-end.

**Open questions:**
- Is "price of the day" one rate per design across all customers, or tiered by customer category (`Wholesale / Retail / VIP`)?
- Is the rate **set daily by admin** (a "Set today's prices" admin action), or **derived** from `Inventory.PricePerYard` (latest goods receipt sets the rate)?
- Should the price-quote ASK be free-form text from marketer → admin, or structured (design + customer + yards → admin clicks "set rate")?
- Does this replace the existing `supply_request` flow or supplement it?

**Depends on:** existing `sell` flow (already shipped), `Customers` sheet (shipped).
**Overlaps with:** 1.2 (customer direct negotiation — same "price quote" substrate), 1.11 (form completion — sale-request form).
**Effort:** **M** — 4–6 commits. Most plumbing exists; need quote-state sheet + 3 new flows + 1 new policy entry (`request_price_quote`).

---

### 1.2 — Customer / wholesaler direct negotiation flow

**Owner's words:**
> When customer-facing rolls out: wholesaler negotiates price with me on bot → confirms → supply happens after payment confirmed by finance department (likely through bot too).

**What:**
- Wholesalers are onboarded as `Users` with role `customer`. They get a slim bot menu: 📦 Catalog, 🤝 Negotiate, 💳 My Orders, 📞 Talk to my account manager.
- Negotiation flow: customer picks design → bot shows admin's current "wholesale floor" rate → customer counters → admin sees the offer → admin accepts / counters / rejects → on accept, the order moves to "awaiting payment".
- Payment flow: customer uploads bank transfer receipt → finance role (existing `financeIds`) confirms via the future bank-reconciliation feature (TG-INT-A4 banking is the engine) → order is released for supply.
- Marketer is by-passed in this flow (this is direct B2B); admin sees both the marketer-mediated channel and the customer-direct channel side-by-side.

**Why:** removes the marketer-as-intermediary friction for established wholesale relationships. Lets the bot scale to 50–100 wholesalers without proportionally scaling marketer head-count.

**Open questions:**
- Identity: how does a wholesaler get added to the bot? Self-serve "/start" + dual-admin approval (reuse USR-C2 captured strangers), or admin-initiated only?
- Negotiation limits — can the wholesaler bid below an admin-set floor? If yes, does it auto-route as "approval_required"?
- Default payment terms — net-zero (pay first, ship after) for V1, or credit-line later?
- Anonymity — does the wholesaler ever see who the marketer was on the other side, or is the marketer abstracted as "the company"?
- Does the wholesaler see live stock, or curated catalogue?

**Depends on:** 1.1 (shared price-quote substrate), TG-INT-A1 banking adapter (already shipped), forex landed-cost (the just-discussed feature), customer onboarding (existing `add_customer` + USR-C3).
**Overlaps with:** 1.1 heavily, 1.4 (finance payment confirm), 1.9 (customer-side data discipline).
**Effort:** **L** — 8–12 commits, multiple flows + new sheet `NegotiationThreads` + bank-feed reconciler UI.

> ⚠ This is the biggest behaviour shift for the bot — moving from "internal-only" to "two-sided platform". Recommend doing 1.1 first to validate the price-quote primitive on internal users before exposing it externally.

---

### 1.3 — Warehouse audit (continuous, error-free)

**Owner's words:**
> Continuous + human-error-free management.

**What:**
- **Cycle counts:** bot prompts a designated warehouse-keeper daily to recount a small rotating subset of bales (5–10/day across all warehouses) and submit a count. Discrepancy vs. system → admin notified.
- **Movement audit:** every transfer / sale / return already lands in `Stock_Ledger`. Add a per-warehouse "reconciliation" view that checks `inflow − outflow = current_stock` and flags drift.
- **Spot-check photo:** when a bale is "audited", warehouse-keeper uploads a photo (uses existing FILE-C1 pipeline).
- **Aging audit:** bales > N days in warehouse get auto-flagged in admin's daily digest (already partially shipped via "dead stock" report).

**Why:** theft and miscount are the most common loss-makers in textile warehousing. A passive ledger is necessary but not sufficient — you need an active "is this bale still physically present?" loop.

**Open questions:**
- How many bales per day per warehouse can your keeper realistically count? (sizes the rotation).
- Who is the keeper per warehouse? — extends the `Users` schema, ties into 1.6 (key management).
- What's the action when a discrepancy is found? Auto-write-off, admin-review-required, or freeze-warehouse-until-resolved?
- Audit scope: just bales, or also Marketers' catalogues (already tracked in `CatalogLedger`)?

**Depends on:** existing `Inventory`, `Stock_Ledger`, FILE-C1 photo upload.
**Overlaps with:** 1.6 (key handling — same trust substrate), 1.4 (financial audit feeds off the same ledger).
**Effort:** **M** — 5–7 commits.

---

### 1.4 — Financial auditing & reporting

**Owner's words:**
> Financial auditing and reporting.

**What (already partially planned — see ROADMAP §4.8 PA-1..PA-5 + FIN-C0..C6):**
- FIN-C0: read-only ledger discovery (proves the existing `Ledger_Entries` + `Stock_Ledger` are reconcilable).
- FIN-C1: `FinancialSnapshot_*` materialized views for fast reports.
- FIN-C2: Accounts Payable plumbing (supplier balances).
- FIN-C3..C6: aggregators, cron, in-bot KPIs, docs.
- **Plus from this brief:** landed-cost feature (USD + charges) feeds the cost-of-goods-sold calculation; bank-reconciliation flow (TG-INT-A1 banking engine) feeds the receivables aging.

**Why:** owner needs daily / weekly / monthly P&L without leaving Telegram, plus an audit trail that survives a real accountant's review.

**Open questions:**
- Reporting period — calendar month, Indian fiscal year (Apr–Mar), or Nigerian fiscal year (Jan–Dec)?
- Multi-currency reporting — show everything in NGN only, or dual NGN/USD?
- Do you want PDF export of monthly P&L (delivered to admin's Telegram), or sheet-only?
- Tax treatment — GST/VAT — applicable in your jurisdictions? If yes we need a `tax_breakdown` column.

**Depends on:** landed-cost (this week's USD feature), bank-reconciliation (TG-INT-A1 banking).
**Overlaps with:** 1.3 (warehouse audit shares the ledger), 1.5 (HR payroll lands in same P&L).
**Effort:** **L** — already broken into ~12 commits (FIN-C0..C6 + PA-1..PA-5).

---

### 1.5 — HR system (payroll + attendance + alerts)

**Owner's words:**
> Automated payroll, attendance monitoring and alert (both employee and manager).

**What:**
- **Attendance** — ✅ already shipped (ATT-C1 employee mark + ATT-C2-LITE admin hub + ATT-RPT-1 report). Outstanding: ATT-C3 scheduler (morning reminder, mid-day escalation, end-of-day cutoff auto-mark, daily 8 AM admin digest) — currently parked.
- **Payroll** — NEW: monthly salary calc → (base salary) + (incentives earned from `Incentives` sheet) − (deductions from leave / absence). Admin approves the payroll run; bot generates the payslip PDF and the bank-payment instructions list.
- **Alerts** — employees: "you forgot to mark attendance today"; managers: "Abdul missed 3 days this week".

**Why:** ATT shipped without alerts means employees still forget. Payroll done in spreadsheets means hours wasted every month and is prone to error.

**Open questions:**
- Salary structure: flat monthly, hourly with timesheet, or commission-based for marketers?
- Leave types — sick, paid, unpaid, public holiday — how many categories?
- Who authorises a payroll run? Single admin or dual-admin? (Recommend dual.)
- Payslip delivery — PDF to employee's Telegram + Google Drive archive, or sheet-link only?
- Tax / pension / NHF deductions — do we model them or pass through?

**Depends on:** ATT-C3 scheduler (parked, ready to resume), Incentives sheet (shipped), banking adapter (shipped).
**Overlaps with:** 1.4 (payroll is a major P&L line), 1.10 (employee task → incentive → payroll).
**Effort:** **L** — 8–10 commits.

---

### 1.6 — Key management / handling system (warehouse + office)

**Owner's words:**
> Key role management, and key handling system for warehouse/office supply without loophole for theft.

**What:**
- Each warehouse / office has N physical keys, each registered in a new `Keys` sheet (`key_id, location, key_holder_user_id, issued_at, returned_at, status`).
- Issue / return flow: admin issues key X to user Y → user Y confirms receipt with photo of key (FILE-C1) → on return, user Y / admin marks returned + photo.
- Daily "who has which keys" status visible to admin.
- Any unaccounted key at end-of-day → red alert.
- Locks change → keys deprecated → audit trail.

**Why:** physical security is the underbelly of textile theft prevention. Lots of cases of "the night-watchman had the key" disappearing into he-said-she-said. A digital audit trail makes finger-pointing concrete.

**Open questions:**
- How many keys / locations are you currently managing? (sizes the priority — if 5 keys, this is low priority; if 30+, high.)
- Are office and warehouse keys treated identically, or different policies?
- Is there a key-loss escalation policy (e.g. lock-change auto-triggered after N days unaccounted)?

**Depends on:** Users (shipped), FILE-C1 photo upload (shipped).
**Overlaps with:** 1.3 (warehouse audit — keys are part of "trust the warehouse" substrate).
**Effort:** **S–M** — 3–4 commits. Genuinely small if the rules are simple.

---

### 1.7 — Multi-type shipment + sample tracking

**Owner's words:**
> Different types of shipment samples with different sizes and their tracking (In house, office or customer).

**What:**
- Samples already partially tracked via `CatalogLedger` (Marketers carry catalogues). Extend to general "samples sent out" tracking — to customers, to offices, in-house transfers.
- Sample types: small swatch, fat-quarter, half-than, full-than. Different shipping methods (courier, hand-carry, registered post).
- Each sample gets a `sample_id` + tracking number (when courier) → uses TG-INT-A1 shipment adapter (already shipped, DHL + stub).
- Return / "sample returned" / "sample converted to sale" lifecycle.

**Why:** today samples vanish into Excel. The bot should make "where did sample #SMP-001 go?" a 2-tap query.

**Open questions:**
- Are samples deducted from main Inventory or held in a separate "Sample Stock" pool?
- Cost accounting — sample value is written off as marketing expense, or capitalised until returned/sold?
- For "in-house" transfers (warehouse → office for display), is that already covered by existing `transfer_than`?

**Depends on:** TG-INT-A1 shipment adapter (✅ shipped), `Inventory` (shipped), `CatalogLedger` (shipped).
**Overlaps with:** 1.3 (warehouse audit must account for samples out), 1.4 (sample write-offs are an expense line).
**Effort:** **M** — 5–6 commits. Adapter is ready, just needs a UI flow.

---

### 1.8 — Contract & document repository (searchable via bot)

**Owner's words:**
> Different format of contracts papers with client for order collection which shall be accessible to admin via bot. (All different kinds of office files accessible through bot). Searchable through search keyword.

**What:**
- Admin uploads a contract PDF / image / DOCX to the bot, tags it (`customer_id`, `contract_type`, `order_id`, `signed_date`, `expiry_date`, `keywords`).
- Bot stores file in Google Drive (FILE-C1 already does this for receipts), creates a row in a new `Documents` sheet.
- "🔍 Search Documents" admin action — type keyword → bot returns top 5 matches (filename, tags, snippet from OCR text, Drive link).
- Search index: V1 = naive substring over filename + tags. V2 = if the file is a PDF or image, run OCR (existing P5 stub-or-real OCR pipeline) → store extracted text in a column → full-text search the column.

**Why:** finding "the 2024 contract with Blue Skies Textiles" today means digging through email or a desktop folder. A keyword-searchable bot index turns minutes into seconds.

**Open questions:**
- Document scope: just contracts, or also invoices / packing-slips / receipts / waybills?
- Access tier: admin-only, or finance-can-see-invoices etc.?
- Retention policy: keep forever, or auto-archive after N years?
- Do you want **version history** (re-uploading replaces but keeps history) or **single-current** (re-upload overwrites)?

**Depends on:** FILE-C1 (shipped), P5 OCR pipeline (stub shipped, real provider follow-up).
**Overlaps with:** 1.9 (customer data — contracts attach to customers), 1.4 (financial — invoices feed into AR/AP).
**Effort:** **M** — 4–6 commits if no OCR; 7–9 with OCR full-text.

---

### 1.9 — Customer data collection & planning

**Owner's words:**
> Proper customer / Data collection and planning.

**What:**
- Standardised customer-onboarding form (already partially in place via `add_customer`): name, phone, address, GSTIN/TIN, category (Wholesale / Retail / Sample-only), credit limit, payment terms, preferred contact channel, account manager.
- "Customer health score" — automated: ages of outstanding invoices, frequency of orders, dispute count, NPS-style follow-up survey.
- Segmentation reports: top-10 customers by value, by volume, by margin, by recency.
- Birthday / festival auto-greetings (low priority but high goodwill).

**Why:** the data lives in `Customers` already; what's missing is the **discipline + reporting**.

**Open questions:**
- What customer attributes are you currently capturing inconsistently? (Likely answer: GSTIN, payment terms, preferred contact.)
- Do you want a "customer 360" view — one card showing balance + last order + open disputes + last contact — accessible from any flow?
- Privacy boundary: which fields are marketer-visible, which are admin-only? (Today marketers can see customer phone in supply flows — is that fine?)

**Depends on:** existing `Customers`, `CustomerFollowups`, `CustomerNotes`.
**Overlaps with:** 1.1, 1.2 (price-quote and direct-negotiation both write to customer records), 1.8 (contracts attach to customers).
**Effort:** **M** — 4–6 commits. Mostly form-completion + report views.

---

### 1.10 — Task management + close tracking (deepen the existing system)

**Owner's words:**
> Most important is task management for employee and closely tracking.

**What (already substantially shipped — TG-7.5 Phase C):**
- Assignment + negotiation + incentives ✅
- Append-only audit (`TaskEvents`) ✅
- State machine ✅
- Per-user incentives ✅

**Outstanding from owner's brief ("closely tracking"):**
- Live admin dashboard — "right now, who's working on what, for how long, blocked or progressing?"
- Gantt-style historical view per employee for the last 7 / 30 days.
- Auto-detect "stuck": task in `in_progress` for > N hours past `proposed_deadline` → admin escalation.
- Task templates (already planned in §5.2 of ROADMAP) — reusable task definitions so admin doesn't re-type.

**Why:** the engine exists; what's missing is the **observability** layer.

**Open questions:**
- Live dashboard delivery — Telegram-only (text-mode), or web-page (would need a new UI, big jump in effort)?
- "Stuck" threshold — admin-configurable per task track, or one global value?
- Do you want to see your own tasks AND your team's tasks in one view, or separate "my work" vs "my team"?

**Depends on:** TG-7.5 Phase C (shipped).
**Overlaps with:** 1.5 (payroll consumes incentives from tasks), 1.4 (task-completion stats feed into employee productivity reports).
**Effort:** **M** — 5–7 commits.

---

### 1.11 — Form completion & data migration

**Owner's words:**
> Update all pending details in bot with complete data migration, like all forms filled.

**What:**
- Audit every existing form-driven flow (`add_customer`, `add_user`, `add_warehouse`, `bulk_receive_goods`, `assign_task`, …) for fields that are currently OPTIONAL but should become MANDATORY (or vice versa) given everything we've learned.
- Data migration: walk existing sheets, identify rows with blank required-now fields, surface them in admin "📋 Data Hygiene" view → admin fills retroactively.
- Add validation: "phone must be 11 digits, starting with 080/081/090/091" etc.

**Why:** the bot is only as good as the data inside it. Half-filled customer records, blank `address`, missing `gstin` → reports lie.

**Open questions:**
- Which forms are currently most-skipped — i.e. where's the worst data hygiene right now? (recommend a 1-hour audit before scoping.)
- What's the "you-must-fill-this-now" vs "fill-when-convenient" line per field?
- Migration of LEGACY data outside the bot (older Excel / Tally export)? Or is the bot the system-of-record now?

**Depends on:** every existing form-driven flow.
**Overlaps with:** ALL the other 10 items (every cluster has form-data dependencies).
**Effort:** **M** — ongoing chore, ~6–10 commits as features stabilise.

---

## §2 · Overlap map

Where work overlaps — building the shared substrate FIRST makes downstream cheaper.

```
                                     ┌──────────────────────────────┐
                                     │  USD landed cost (just-disc) │ ← discussed tonight
                                     └────────────┬─────────────────┘
                                                  │ unlocks
                       ┌──────────────────────────┼──────────────┐
                       ▼                          ▼              ▼
              1.4 Financial audit     1.2 Wholesaler direct   1.7 Sample tracking (cost)
                       ▲                          ▲
                       │                          │ shares "price-quote thread" with
                       │                          │
            1.5 HR/Payroll              1.1 Marketer day-price
            (payroll lands in P&L)               ▲
                       ▲                          │
                       │                  shares "customer record"
                       │                          │
                       └──────────────┐           │
                                      │           │
                              1.9 Customer data ◀┘
                                      ▲
                                      │ attaches contracts
                                      │
                              1.8 Document repository

                       ┌──────────────────────────┐
                       │ 1.3 Warehouse audit  ◀───┼─── shares "ledger trust"
                       │ 1.6 Key handling     ◀───┘
                       └──────────────────────────┘

                       1.10 Task tracking ──→ 1.5 payroll (incentives)
                       1.11 Form / data migration ──→ EVERYTHING
```

Substrate items (build first, get leverage):

1. **USD landed cost** — unlocks accurate margins for 1.4, real wholesale floor for 1.2.
2. **Price-quote thread primitive** (from 1.1) — reused by 1.2.
3. **Form-completion audit** (from 1.11) — every subsequent feature depends on clean data.

---

## §3 · Suggested build order

Given dependencies + your stated priorities:

| Phase | Cluster | Why this order |
|---|---|---|
| **Phase A** *(this week)* | USD landed cost (just-discussed) | Substrate for 1.2 and 1.4. Owner already asked. |
| **Phase A** | 1.11 — Form-completion audit (lightweight first pass) | Cheap; every later phase benefits. ~2 days. |
| **Phase B** *(next 2 weeks)* | 1.1 — Marketer day-price + sale request | Validates the price-quote primitive on internal users; needed before 1.2. |
| **Phase B** | ATT-C3 scheduler (resume parked work) | Already 80% done; finish before HR payroll. |
| **Phase C** *(month 1)* | 1.4 — Financial audit (FIN-C0 + landed-cost wiring) | Concrete P&L unlocks management decisions for everything else. |
| **Phase C** | 1.10 — Task close-tracking (live dashboard) | Observability for the workforce, low effort given engine exists. |
| **Phase D** *(month 2)* | 1.5 — HR Payroll | Eats the largest accounting headache once you have FIN. |
| **Phase D** | 1.3 — Warehouse audit (cycle counts) | Closes the theft loop now that you have inventory accuracy. |
| **Phase E** *(month 2–3)* | 1.7 — Sample tracking (use shipment adapter) | Uses the already-shipped shipment adapter. |
| **Phase E** | 1.9 — Customer data discipline | Required before opening to wholesalers (1.2). |
| **Phase F** *(month 3+)* | 1.2 — Wholesaler direct negotiation | The biggest behaviour change. Wait for substrate (price quote + customer data + bank reconciliation) to settle. |
| **Phase G** *(month 4+)* | 1.6 — Key management | Important but small audience; do after the high-impact items. |
| **Phase G** | 1.8 — Document repository | Independent; can be parallelised whenever. |

---

## §4 · Cross-cutting concerns to watch

These aren't separate clusters but recurring themes:

| Concern | Where it bites | Mitigation |
|---|---|---|
| **Approval bottleneck on admin** | Every dual-admin action competes for the same one or two people. | Promote one trusted deputy via existing `promote_admin`; route low-risk approvals to deputy. |
| **Data migration cost** | Existing sheets have legacy holes; new features assume clean fields. | 1.11 in Phase A absorbs this; never let a feature land without a data-hygiene check. |
| **Customer-facing surface = different RBAC** | Today's `auth.isAdmin / isEmployee` doesn't model "customer". | Add `role: 'customer'` to Users; update `controller.requireAuth` to allow customer routes when feature flag enabled. |
| **WhatsApp inbound (deferred)** | Wholesalers will want to reply to bot messages on WhatsApp, not switch to Telegram. | TG-INT messaging Wave B (`INBOUND_DEFERRED.md`) — schedule before 1.2 goes live. |
| **FX rate drift** | Manual-rate provider means an admin must remember to update daily. | Once 1.2 goes live with customers paying in NGN settled against USD-cost stock, the daily-rate update reminder becomes mission-critical. Add to ATT-C3 scheduler. |
| **Privacy / money separation** | ROADMAP §1.4 already enforces (Tasks ≠ Incentives). New customer-facing flows must obey the same discipline. | Review every new flow against §1.4 before merging. |

---

## §5 · What's already in flight (don't double-count)

These are TOUCHING the same surfaces — do not implement separately, EXTEND them:

- `ATT-C3` scheduler — parked, owns alerts for 1.5.
- `FIN-C0..C6` — owns most of 1.4.
- `PA-1..PA-5` — owns Accounts-Payable for 1.4.
- `Task Templates` (commits 5a, 5b, 6) — owns reusable-task slice of 1.10.
- `Adaptive UI` (commit 7) — owns "admin sees what they need" slice of 1.10.
- `TG-INT-A1` ✅ — owns adapter substrate for 1.2 (banking), 1.7 (shipment), 1.5 (messaging alerts), 1.4 (forex).

---

## §6 · Open questions log (for next session)

Compiled from every cluster above — bring concrete answers:

1. **Pricing model:** one rate per design, or tiered by customer category? (gates 1.1, 1.2)
2. **Wholesaler onboarding:** self-serve or admin-initiated? (gates 1.2)
3. **Payment terms:** prepay-only V1, or credit-line from day 1? (gates 1.2)
4. **Reporting period:** calendar / Indian-fiscal / Nigerian-fiscal? (gates 1.4)
5. **Salary structure:** flat / hourly / commission? (gates 1.5)
6. **Key count:** how many physical keys are we tracking? (gates priority of 1.6)
7. **Sample accounting:** expensed or capitalised? (gates 1.7)
8. **Document scope:** contracts only or all office files? (gates 1.8)
9. **System of record:** is the bot now the truth, or do legacy spreadsheets still rule? (gates 1.11)
10. **USD landed-cost spec:** see the 7 questions in tonight's chat — these unblock Phase A.

---

## §7 · Not in scope (yet)

Listed so we don't accidentally drift into them:

- Public web storefront (Telegram-only for now).
- Mobile app (native) — Telegram IS the app.
- Real-time multi-currency hedging — manual rates by design.
- AI-driven price recommendations (the existing OpenAI integration is for parsing, not pricing).
- Multi-tenancy (one company per deployment).

---

*This document is a draft for discussion. Update it after each planning session — every cluster's "Open questions" should shrink over time as decisions get made.*
