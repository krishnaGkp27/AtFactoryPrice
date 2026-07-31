# Open items — living register

Everything currently open, in the order it is worth closing. Owner asked
(30-Jul-2026) for one list to work down chapter by chapter.

**How to use this:** tick a row when it is signed off and delete it. When a
section empties, delete the section. If a row needs more than a line of
context it gets a spec in `specs/` and this file just links to it.

Last reviewed: **30-Jul-2026**

---

## 🔴 P1 — blocking, or costing something every day

| # | Item | Owner | Where |
|---|---|---|---|
| 1 | **No daily sheet backups are running at all.** The bot-side job was disabled 10-Jul at the owner's request (`SHEET_BACKUP_ENABLED` default 0) pending the Apps Script install. Nothing has been backed up since. | **Emin** | `specs/BKP-1_EMIN_CHECKLIST.md` |
| 2 | **Nine flows dead-end on a stale card.** Any card idle >5 min (`DEFAULT_TTL_MS`) or touched after a restart. **Receive Goods fails silently** — it pre-acks the tap so Telegram drops the error and the button simply does nothing. Others show "Unknown action." Fix needs owner sign-off: one ~4-line branch in the callback dispatcher, or the same guard copied into nine flow files. | Owner decides → agent | see "Stale cards" below |
| 3 | **Webhook enforcement is still dormant.** The fix shipped long ago and has never been switched on: set `TELEGRAM_WEBHOOK_SECRET` → `npm run set-webhook` → `REQUIRE_WEBHOOK_SECRET=1`. | **Owner** | `specs/SEC-P1-P2_PICKUP.md` |

### Stale cards — detail for item 2

Sessions are an in-memory `Map` (`src/utils/sessionStore.js:20`) with no
persistence and no rehydration, so a restart wipes every open flow while its
card stays on screen looking usable. Confirmed empirically by driving the real
controller with an empty session store.

Affected: `gr:` Receive Goods (silent) · `bs:` Bundle Sale · `bops:` Daily
Branch Ops · `lcost:` Landed Cost · `ofex:` Office Expense · `pr:` Photo
Receive · `sbl:` Sold Bales · `wh:` Add Warehouse · `rol:` Role Edit.

Ten other flows already recover gracefully (Sales Browser, Set Design Category,
Merge Customers, Snap Sale, User Manage, Warehouse Audit …), so these nine are
stragglers against established prior art, not a design choice. The dashboard
side already got this treatment — `src/db/extSchema.js` notes the in-memory v1
"logged everyone out on every deploy".

---

## 🟠 P2 — ready, waiting on the owner

| # | Item | Owner |
|---|---|---|
| 4 | **Run the onboarding stock audit.** Start with CHINOS STR (24 bale designs, bales only, loads in one tap). | Owner · `specs/AUD-X2_ONBOARDING_AUDIT.md` |
| 5 | **Approval single-card wizard.** Full proposal delivered; blocked on two decisions: (a) does the final receipt keep the full card or collapse to a one-liner, (b) how far back should Back reach — as far as reject? | Owner |
| 6 | **TRF-5 live test** — transfer queue + single-flow retirement (commit `28d9121f`). | Owner · `specs/TRF-5_TEST_STEPS.md` |
| 7 | **Analytics is dark.** `ANALYTICS_ENABLED=1` + `DATABASE_URL` on Railway. Until then the usage / dead-code tracking the owner commissioned records nothing, and `npm run census --usage` has no data to join. `DATABASE_URL` alone also unlocks SHR-1 share counting (item 7b). | Owner · `specs/ANL-1_USAGE_ANALYTICS.md` |
| 7b | **SHR-1 share links — 3 owner steps to go fully live.** Shipped 30-Jul: 📤 Share on the catalog card mints tracked `/d/<token>` links (bot-served page works from day one). To land them on the domain + start counting: (a) set `botApiBase` in `js/site-config.js` and deploy Firebase hosting, (b) add Settings row `SHARE_PAGE_BASE_URL = https://atfactoryprice.com`, (c) `DATABASE_URL` on Railway (same env work as item 7 — events don't record without it). | Owner · `specs/SHR-1_SHARE_TRACKING.md` |

---

## 🟡 P3 — queued agent work

| # | Item | Where |
|---|---|---|
| 8 | **Security remediation H6 + P3–P7.** Not started. | `docs/CODE_AUDIT_2026-07-07.md` |
| 9 | **CUS-1 follow-up (Phase C2)** — stamp `customer_id` on Samples / Orders / Receipts. Columns already signed off; the sessions already carry `customerId`. | `specs/CUS-1_CUSTOMER_ENTITY.md` |
| 10 | **VRF-1 tuning.** Waiting on one concrete bill + request pair that still mismatches after VRF-1b. | — |
| 11 | **Catalogue integration.** Interest Log + Sample Showings tap flows, one-tap catalogue share via Telegram `file_id`, receiving-flow tie-in. Ideas presented, not commissioned. | — |
| 12 | **APX-5 leftovers — reply-below sweep.** The 31-Jul in-place audit fixed the transfer surface; still replying below the tapped card instead of editing (ranked by send-count): addStockFlow (27 sends/1 edit), warehouseAuditFlow (14/3), photoReceiveFlow (9/2), attendanceAdminFlow (6/1), goodsReceiptFlow, bulkReceiveFlow, userAddFlow, attendanceFlow (~5 each). Some sends are legitimate (photo cards, TRF-6-style prompts, DM notifications) — each flow needs the same edit-vs-toast triage before converting. | agent, next polish passes |
| 12b | **CUS-2 leftovers (display-layer alias blindness).** The 31-Jul integrity audit fixed all 14 confirmed money-path leaks; still open, low-risk: report family groups by raw `soldTo` spelling (customer report/timeline/ranking/pattern, top-buyer chips, cold-customer alert), notes/followups READS are exact-name, and the parallel `Ledger_Customers` registry (`/addledgercustomer`, balanceService) is un-reconciled with the CUS-1 entity. All display-only or admin-command surfaces — no writes leak. | agent, next cleanup pass |

---

## ⚪ Watch list — known, deliberately not acted on

- **Inventory header rewrite at boot.** `schemaMapper.initialize()` re-checks the
  Inventory **header row** every start and rewrites it when a column name is
  missing or spelled differently (`src/services/schemaMapper.js:472-508`). Header
  row only — no data row is touched — but it is the one place a deploy can write
  to Inventory. Left alone deliberately during the stock audit; worth revisiting
  before the reconciliation phase.
- **`setStatusReverted`** matches on an exact timestamp; could break if Sheets
  coerces full ISO timestamps the way it coerced dates (the DATE-N1 class).
- **"Office" shows up as an employee** in the attendance not-reported list.
- **Partial bales** are written `256+6` (whole bales + loose bundles), never
  `256.6` — the count parser rejects decimals. Tell whoever counts.
- **`1,2…..9`** appears as a design for Ladies Gown (pieces) in the onboarding
  data — free text in the workbook's design column. Harmless; it will show on a
  pieces count sheet.
