# Feature KPI Matrix

**Owner's standing KPI dashboard** — requested 12-Jul-2026. Check regularly; update on every feature ship/change.

## How to read the three KPIs

| KPI | Definition | Scale |
|---|---|---|
| **Testing** | ✅ = automated tests (unit and/or characterization) AND verified live on Telegram · 🟡 = automated tests exist but live verification pending, or only partial coverage · ❌ = no automated coverage | evidence cited per row |
| **Growth %** | How much of the feature's owner-approved scope has shipped and is usable in production today. 100% = fully built, wired, tested, live. NOT usage analytics (we don't collect per-feature usage yet — see "Next KPI upgrades"). | 0–100% |
| **UI/UX tap score** | How tap-first the feature is: ⭐⭐⭐⭐⭐ = fully guided taps, minimal steps, no typing · ⭐ = typing-heavy or many steps. Step counts are from code reading, not user timing. | 1–5 ⭐ |

**Update discipline:** when a feature ships or changes, update its row in the same commit. Rows are grouped by hub the way the bot's menu is.

---

## Sales & Money

| Feature (codes) | Testing | Growth % | Tap score | Notes |
|---|---|---|---|---|
| NLP sales — typed sale/return commands (TG-1..7) | 🟡 char. tests via controllerHarness; live-proven daily | 95% | ⭐⭐ | Typing + confirm tap; power-user path. Enrichment (rate/payment) is tap-guided. |
| Bundle Sale — poly-colour design-first picker (BS-C1, TAP-1) | ✅ `bundleSale.allCustomers.test.js`; live in Kano | 90% | ⭐⭐⭐⭐⭐ | Fully tappable incl. all-customers browse (TAP-1, Jul-2026). Residual: pagination polish. |
| Record payment + customer ledger (ledger sheets, balance cache) | 🟡 `slashCommands.ledger.test.js`; live-proven | 90% | ⭐⭐⭐ | Amount still typed (inherent); rest is taps. |
| Price update + layered price visibility (PRICE-VIS-C1) | 🟡 unit-level only | 80% | ⭐⭐⭐ | Phase 1 foundation shipped; later visibility layers pending. |
| Landed cost — USD cost + charges + FX (LANDED-COST C1) | 🟡 smoke checks; live use | 85% | ⭐⭐⭐ | Numbers typed by nature; finalize is dual-admin gated. |
| Payouts / incentives queue (finance) | 🟡 taskStateMachine unit tests | 85% | ⭐⭐⭐⭐ | One-tap "Mark paid". |
| Office expenses + daily branch ops (BR-OPS C1) | 🟡 smoke S28; live | 80% | ⭐⭐⭐⭐ | Batch submit = 1 approval; now two-admin (DUAL-1). |
| Bank management (add/remove bank) | 🟡 covered via approval-queue tests | 90% | ⭐⭐⭐⭐ | Queue-gated since DUAL-1. |

## Inventory In (receiving)

| Feature (codes) | Testing | Growth % | Tap score | Notes |
|---|---|---|---|---|
| Goods Receipt Note — single GRN intake (P2) | 🟡 flow evaluated + live-proven | 90% | ⭐⭐⭐⭐ | |
| Bulk Receive — CSV/XLSX upload (P2.5, C1–C5) | ✅ `csvParser`, `bulkRowValidator` units + live (Abdul playbook) | 95% | ⭐⭐⭐⭐ | File upload + tap-review; template docs shipped. |
| Strict Add Stock — conflict-scanned upload (ADD-STOCK) | 🟡 rides bulk-receive rails | 85% | ⭐⭐⭐⭐ | Funnels into P2.5 queue with pre-scan. |
| Photo Receive — OCR packing slips (P5, C1–C5) | 🟡 S15 smoke suite; **stub OCR only** | 60% | ⭐⭐⭐⭐⭐ | Per-row ✅/✏/❌ review UI done; real OCR provider (OpenAI Vision) not enabled. |
| Procurement Plan — low-stock → PO drafts (P4) | 🟡 basic coverage | 75% | ⭐⭐⭐ | |
| PG-1 Postgres inventory mirror + parity | ✅ `inventoryMirrorService.test.js` + smoke S45 | 70% | n/a (backend) | Railway wiring fresh (Jul-2026); parity monitoring young. |

## Inventory Out / Movement

| Feature (codes) | Testing | Growth % | Tap score | Notes |
|---|---|---|---|---|
| Multi-stage Supply Request (srf_*, dispatch→admin→warehouse) | ✅ 4 supplyFlow char. tests; live daily | 95% | ⭐⭐⭐⭐ | The flagship flow. |
| Staged Transfers — dispatcher/receiver queue (TRF-1..7) | 🟡 `transferService` + 3 char. tests; **TRF-5 live test PENDING (owner)** | 85% | ⭐⭐⭐⭐⭐ | Bale-number search + checkbox picks (TRF-7). Legacy instant transfers retired. |
| Samples — give sample + follow-up status (sm*) | 🟡 queue-path coverage | 85% | ⭐⭐⭐⭐ | Two-admin gated since DUAL-1. |
| Warehouse mgmt — add/rename/audit (P2, WH-AUDIT) | 🟡 covered via approval tests | 90% | ⭐⭐⭐⭐ | Dual-admin since theft-history mandate. |
| Display units — bales⇄thans per warehouse (TV-1/2) | ✅ 2 unit suites + char. test | 95% | ⭐⭐⭐⭐⭐ | Settings-driven, in-bot toggle behind approval. |

## Approvals & Security

| Feature (codes) | Testing | Growth % | Tap score | Notes |
|---|---|---|---|---|
| Approval queue + admin broadcast cards | ✅ selfApproval/soleAdmin/dualApproval units | 95% | ⭐⭐⭐⭐⭐ | One-tap approve/reject cards. |
| **DUAL-1 two-admin approval (inventory+finance)** | 🟡 11 unit tests + smoke S46; **live test pending (shipped 12-Jul)** | 90% | ⭐⭐⭐⭐ | Second admin = one extra tap by design. |
| Security hardening (SEC-P1/P2: webhook secret, callback ownership, API key, CORS) | ✅ pinned by tests | 80% | n/a | **Webhook enforcement still DORMANT** — owner task open (set secret → set-webhook → REQUIRE_WEBHOOK_SECRET=1). |
| User mgmt — add/promote/deactivate/roles (USR-C1..C4) | ✅ 4 unit suites + authz char. tests | 90% | ⭐⭐⭐⭐ | promote_admin super-admin-gated. |
| Onboarding — pending users + employee script | ✅ `pendingUserService.test.js` | 85% | ⭐⭐⭐⭐ | |

## Catalog & Marketing

| Feature (codes) | Testing | Growth % | Tap score | Notes |
|---|---|---|---|---|
| Design photos — upload/browse/search/stats (DES-ASSET) | 🟡 approval-path coverage | 85% | ⭐⭐⭐⭐ | file_id caching makes repeat views instant. |
| Design categories (DCAT-1) | ✅ char. test drives full dual-admin flow | 95% | ⭐⭐⭐⭐ | |
| Marketer roles + My Products (MKT-1) | ✅ `fieldRoles` unit + char. tests | 90% | ⭐⭐⭐⭐ | |
| Physical catalog — supply/loan/return/tracker (MG-1) | 🟡 `marketerAllocations.test.js` | 80% | ⭐⭐⭐⭐ | |
| Marketer allocations (S44) | ✅ smoke S44 + char. test | 90% | ⭐⭐⭐⭐ | |

## People & Reporting

| Feature (codes) | Testing | Growth % | Tap score | Notes |
|---|---|---|---|---|
| Negotiated task workflow — propose/accept/incentives (TG-7.5) | ✅ `taskStateMachine` engine fully unit-tested | 90% | ⭐⭐⭐⭐ | Calendar picker, payout queue. |
| Manager visibility + admin feeds (T1–T3) | ✅ `adminFeed.test.js` | 90% | ⭐⭐⭐⭐ | |
| Attendance — mark/admin/report (ATD) | 🟡 flow coverage thin | 75% | ⭐⭐⭐⭐⭐ | One-tap daily mark. |
| Org hierarchy + climbing approvals (TG-7.5 A) | ✅ `deptGraph.test.js` + `npm run check-org` | 90% | n/a | |
| Reports — sales/stock/valuation/sold-bales/supply details | 🟡 `soldBalesFlow` char. coverage partial | 85% | ⭐⭐⭐⭐ | Tap-driven report pickers. |
| AI free-form data questions (queryEngine Tier-2) | ❌ manual only (needs OpenAI live) | 70% | ⭐⭐ | Typed questions by nature. |

## Platform (invisible but load-bearing)

| Feature (codes) | Testing | Growth % | Tap score | Notes |
|---|---|---|---|---|
| TG-INT adapter layer (forex/monitoring/shipment/banking/WhatsApp) | 🟡 selector + stub tests | 40% | n/a | Scaffolds shipped; **all real providers still stubs** except manual forex. |
| Backups — sheet backup + snapshots + Drive archive (BKP-1a/b/c) | 🟡 `sheetBackup.test.js` | 30% | n/a | ⚠️ Bot-side job DISABLED by owner (10-Jul); Apps Script install (Emin, Task 1) pending → **no daily backups running**. |
| Session janitor + stale-flow tombstones (SJ-1/2) | ✅ `sessionJanitor.test.js` | 95% | n/a | |
| Menu hubs + activity registry (act: nav) | ✅ nav char. tests | 95% | ⭐⭐⭐⭐⭐ | Single source of menu truth. |
| Test infrastructure — 445 tests + 555 smoke + CI (TG-27) | ✅ it tests itself | 85% | n/a | Characterization gate for TG-8 controller split still building. |

---

## Standing risks the matrix should keep visible

1. **No daily backups are running** (BKP row) — highest data-risk item.
2. **Webhook enforcement dormant** (SEC row) — one env-var away from closing.
3. **TRF-5 and DUAL-1 live tests pending** — both shipped with green suites but await owner's phone test.
4. **Photo Receive is stub-OCR** — the UI is ready but reads nothing real yet.

## Next KPI upgrades (when owner wants them)

- **True usage growth:** the AuditLog sheet already records every action with user + timestamp. A monthly script (`scripts/`) could compute per-feature action counts and rewrite the Growth column from real data instead of scope-maturity estimates.
- **Step-count timing:** log `flow_started`/`flow_completed` timestamps per session type to measure real taps-to-done.
