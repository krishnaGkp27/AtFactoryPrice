# AtFactoryPrice — Claude Code context

## Repo layout

```
telegram-ops-bot/   ← Node.js Telegram bot (main active codebase)
inventory-system/   ← Python FastAPI (not yet in git; do NOT touch)
functions/          ← Firebase Cloud Functions (separate workstream)
*.html / css/ / js/ ← Website frontend (web redesign workstream, separate branch)
mobile/             ← Flutter app (separate workstream)
```

## ⚠️ Pending human tasks — check status BEFORE new feature work

Two tracks are open (owners assigned by the owner on 07-Jul-2026). At session start,
ask for their status instead of starting new features; help execute them if asked.

| Priority | Task | Owner | Steps doc |
|---|---|---|---|
| ~~0~~ ✅ | CON-1 one person-door SHIPPED 16-Aug-2026 — tile is ➕ Add Contact, TYPE asked first, everything queues `add_contact` with chips, plain Approve honours the requested type, Quick Add + the retired executor both stitch CRM row **and** node. Owner: add one person of each kind and confirm a Customer approved with no chip appears in the customer list AND the network. | **shipped** | `telegram-ops-bot/specs/CON-1_SINGLE_PERSON_DOOR.md` |
| **0a — NEXT UP (owner 27-Aug)** | LNK-2 one-tap reports: (owner, 2 min) @BotFather `/setdomain` → `ops.atfactoryprice.live` — kills the "Open Link?" popup; LNK-1 shipped `ec273167` with auto-fallback to plain url buttons until the domain is set, so nothing breaks meanwhile. (agent) add `WEB_SESSION_HOURS` Settings knob (default 12) so home-screen bookmarks of `/ops` `/allocations` `/gantt` stay signed in for days — owner picks the number in one cell, no deploy; longer session = longer exposure on a lost phone, owner's call. | **Owner + fresh session** | /setdomain steps given in chat 27-Aug; fallback in `telegramController` `web_dashboard` case |
| **0 — OWNER STEP** | PAY-1 SHIPPED 14-Aug-2026. Owner: add `Finance` to the Office phone's `department` cell in the Users sheet (sole member) — until then payment cards go to ALL admins with a warning instead of to the one finance hand. Then register the first accounts (each employee their own; an admin for contractors), dual-approve, and run one small live payment end to end. | **Owner** | `telegram-ops-bot/specs/PAY-1_PAYMENT_REQUESTS.md` §After shipping |
| 0b | EXP-1 attach→parse→confirm component (APC-1 Phase E): photo/Excel in → OCR'd figures as confirm chips → file archived as evidence; lands in the expense flow first, then the approval wizards. EXP-1 core SHIPPED 08-Aug-2026 (`d03423e`+`ed009a1`): daily record, running balance, 20:00 finance report + reminder. Owner: seed the float by recording current cash-in-hand once via ➕ Cash received. | **Owner + agent** | `telegram-ops-bot/specs/EXP-1_OFFICE_EXPENSES.md` |
| ~~0b~~ ✅ | APC-1 approval concurrency — Phases A–D SHIPPED 08-Aug-2026 (per-request sale wizards, reason-prompt queue, transfer pick/gate guards, id-carrying inbox decisions). Phase E (attach→parse→confirm component) rides with EXP-1. | **shipped** | `telegram-ops-bot/specs/APC-1_APPROVAL_CONCURRENCY.md` |
| **0c — RUN FIRST** | Sheet-audit follow-through: owner runs `scripts/repair-contacts-staircase.js` (dry-run → `--commit`; until then 4 Contacts rows are invisible to the bot) and `scripts/format-date-columns.js --commit`; seeds `Locations` sheet (activates VRF-2 store bill-check skip); uploads 9037's 2 catalogue photos (tests CAT-P1 album); tests IDR-2 triage with a fresh account. Full state-at-pause + open rulings (AuditLog col D rename, Contacts writer elegance): see steps doc. | **Owner + agent** | `telegram-ops-bot/docs/SHEET_AUDIT_2026-08-14.md` §State at pause |
| 1 (for owner) | Turn ON webhook enforcement (set `TELEGRAM_WEBHOOK_SECRET` → `npm run set-webhook` → `REQUIRE_WEBHOOK_SECRET=1`). Fix is shipped but DORMANT. | **Owner** | `telegram-ops-bot/specs/SEC-P1-P2_PICKUP.md` |
| **1 — SUPERSEDED, owner go needed** | BKP-1 → **offsite backup job** (owner's idea 01-Sep, extended): one scheduled job, two attachments — the workbook as `.xlsx` built in-process (no Drive, no quota — the Drive *copy* that killed BKP-1 is what is avoided) plus a Postgres dump — delivered over Telegram first (zero new credentials, 50 MB cap), email as a deliberate second hop. ⚠️ **No automated backup runs today at all** (`SHEET_BACKUP_ENABLED` 0, Apps Script never installed). Owner: also confirm Railway PG snapshots are ON. Must ship BEFORE AuditLog leaves the workbook. | **Owner go → agent** | `telegram-ops-bot/docs/SHEET_STORAGE_SPLIT.md` §Order of work |
| **0 — OWNER STEP** | SHT-1 SHIPPED 01-Sep-2026: four dead sheets retired in code (Stock_Ledger, UserPrefs, ShipmentEvents, BankFeed — bootstrap no longer recreates them). **Owner: delete those four tabs from the workbook.** Then storage split continues: backup job (row above) → AuditLog → Postgres → TaskEvents/LedgerBalanceCache/WhatsAppOutbound → Attendance → ApprovalQueue last (bill-evidence check). APR-1 (Approver column H) SHIPPED 01-Sep as the prerequisite. | **Owner, then agent** | `telegram-ops-bot/docs/SHEET_STORAGE_SPLIT.md` |
| **0 — OWNER STEPS** | ISC-1 Inventory sheet cleanup — Phases 1, 2a–2d, 3a–3b SHIPPED 09-Sep-2026 (analysis 08-Sep from the 04-Sep PDF). Owner, in this order, each script dry-run first then `--commit`: (0) `scripts/format-date-columns.js --commit` (pending since 14-Aug); (1) `scripts/audit-inventory-sheet.js --out /tmp/isc1` (read-only census); (2) `scripts/repair-inventory-sold-dates.js` (105 text sale dates); (3) in-bot 🔀 Merge Customers for R1/R2, then `scripts/canonicalise-sold-to.js`; (4) `scripts/repair-shade-spellings.js --design 75142`; (5) `scripts/backfill-legacy-uids.js` — **do not sort the sheet before this** (2,853 rows are keyed by row position until then; approve or re-raise any pending Edit Bale on a Mar26 bale around the run); (6) bale 6497 SAMPLE by hand; (7) 64 oversize thans through ✏️ Edit Bale (`docs/ISC-1_ROW_LISTS_2026-09-04.md`). Sentinel C9–C11 DM admins nightly until (2) and (5) run. Open rulings: R3 Ketu, R6 suffix designs, R7 ₦0 sales (deferred), R10, R11; 3c category seeding needs your list. | **Owner** | `telegram-ops-bot/specs/ISC-1_INVENTORY_SHEET_CLEANUP.md` §7 |
| **0 — OWNER LIVE CHECK** | PAY-2 SHIPPED 09-Sep-2026: every payment request asks a typed reason (3–120 chars, after the amount) shown on the confirm, approval and finance cards and in 📋 My requests; the finance card goes to the Railway `FINANCE_IDS` ids first (else the Users Finance row, else all admins + warning) and names BOTH approvers (`✅ Approved: A ‖ B`) and the requester by name; ✔ Mark Done asks for a proof screenshot (or skip) then tells the requester AND both signers "💸 Paid …" (proof as caption) and wipes every finance-card copy's buttons; ✖ Decline and an admin ✖ Reject do the same and flip the row; 🛂 inbox has a 💳 Payments category with the bill as a 📄 chip and a resolved record line (Paid by / With finance to pay / Declined by / Rejected by); the finance seat sees 💳 Waiting for me to pay; an approved-unpaid payment re-sends the finance card after `PAYMENT_FINANCE_REMINDER_HOURS`. **Storage ruling honoured: the reason, the event trail and the future reason-code index live in Railway Postgres (`payment_reasons`, `payment_events`, `payment_reason_codes`, migration 002); the PaymentRequests sheet gained no column.** Owner: run the live check in the spec §5 (one request with reason + bill → two approvals → finance card on the Railway id → Mark Done with screenshot → Paid notices to three people → inbox record), then one decline and one reject; confirm the sheet has no new column. Two flags: the Paid notice is sent after the proof step (abandoning the prompt leaves the row done but the notice unsent — say if you want it before); `FINANCE_IDS` is read from the env directly. Phase 2 (chips) and phase 3 (reason codes) wait for your word. | **Owner** | `telegram-ops-bot/specs/PAY-2_PAYMENT_REASON.md` §5 |
| **0 — OWNER LIVE CHECK** | CUR-2 invoice rate multiplier — **releases A + B SHIPPED 09-Sep-2026**: Settings `INVOICE_RATE_MULTIPLIER` (env of the same name = boot default; blank / 0 / 1 = none) pre-fills the wizard's **Step 5** chips (`No multiplier` · `Settings: 1,250` · type a number; `INVOICE_MULTIPLIER_ASK` = 0 skips the step); the factor is frozen in the new trailing `Invoices.rate_multiplier` column W at issue; the document (PDF + `/i/<token>`) is rendered from stored BASE lines × stored factor (rate 2 dp, integer amounts, payment row and DEBIT BALANCE at the same factor, status from the base figures, no symbol or unit); the sheet row, ledger and Transactions never hold a multiplied figure (§17). **The factor is INTERNAL (owner 09-Sep): shown only on the Step 5 card while entering it — never on the document, the caption, the approved reply, the requester's card or the sealed card.** **Owner: approve one small sale → Step 5: tap `Settings: 1,250` → open the invoice link and the PDF (converted, no symbol, no factor) → compare with the base figures on the approval reply and the statement → approve a second sale with `No multiplier` (unconverted) → blank the Settings cell and confirm the first invoice does not change.** Owed: the §17 closing sentence you approve verbatim (marked PENDING in BUSINESS_RULES). | **Owner** | `telegram-ops-bot/specs/CUR-2_INVOICE_MULTIPLIER.md` §3b, §4, §7 |
| **0 — OWNER LIVE CHECK** | CUR-1 currency display — **releases A + B SHIPPED 09-Sep-2026** (build steps 1–9): `src/utils/money.js` (`expense` → `₦12,345` · `sale` → `12,345` · `saleRate` → `1,450/yd` · `code()`), side A pinned (task incentives store the literal `NGN`), the invoice bare in both states, every side-B flow, service, card, wizard and controller surface swept; the `format.js` shims deleted (`fmtMoney` survives only for the daybook and trial balance, R5a); S-CUR smoke lint in **fail** mode — no naira can return to the sales side. **Owner: live check = the CUR-2 row above plus side A (one expense, the 20:00 report, one PAY-1 request, one incentive — every figure still `₦`) and side B (Stock Value, Check Stock `Selling: 1,500/yd`, catalogue `· 1,500/yd`, Return goods card, `/balance`, the "📒 Outstanding" line under an approved sale, buyer rate chips — all bare).** | **Owner** | `telegram-ops-bot/specs/CUR-1_CURRENCY_DISPLAY.md` §11, §8 |
| **0 — OWNER RULING** | DDC-1 Daily Details Card — PROPOSAL only (05-Sep-2026): sales cash/goods per city, expense chips with drill-down, outstanding per city. Reuses EXP-1 day report + digest chip pattern; Sales per city is new read-time code over LOC-1; Outstanding per city is barred by §15b until you rule. Owner: seed the `Locations` sheet, set `Users.branch` to Kano/Lagos for every expense filer, answer rulings R1–R15 in the spec (each has a recommended answer). | **Owner** | `telegram-ops-bot/specs/DDC-1_DAILY_DETAILS_CARD.md` §8 |
| **0 — OWNER STEP** | RET-3 SHIPPED 02-Sep-2026: an approved return now credits the buyer at the booked rate (was ₦0 on every return since returns went behind approval). Owner: run `node scripts/list-uncredited-returns.js` (read-only) and rule on the backfill of past returns. **RET-4 SHIPPED 04-Sep-2026**: ↩️ Return goods (customer → bale → tick thans → date → condition → photo → confirm) raises ONE dual-admin `return_thans` request. Owner: run one live return end to end — check both admins get the card AND the photo, one signature is not enough, and the statement moves by the amount the card promised. Then rule on the 3 open questions in the spec (container on the request; 8 movement rows for 8 thans; the typed `/return` door still raising the old dateless request). | **Owner** | `telegram-ops-bot/specs/RET-3_RETURN_CREDIT.md` Part B |
| **0 — OWNER TEST** | DML-1 Design Movement Ledger SHIPPED 31-Aug-2026 at `/movement` (+ 📗 Movement in the nav strip). Owner: open one clean design and one with a known audit discrepancy on LIVE data; check the hints point the right way. Rulings recorded in BUSINESS_RULES §6b/§6c and the spec. Follow-up needing owner go: a return is dated the day it was APPROVED (the return flow asks no date). | **Owner** | `telegram-ops-bot/specs/DML-1_BUILD_SPEC.md` |
| **0 — OWNER TEST** | SHP-1 shade photos SHIPPED 02-Sep-2026 (Telegram). **Before Abdul starts:** add `shade_photos` to his department's `allowed_activities` in the Departments sheet (the tile is invisible until then); hand him `docs/SHP-1_SHADE_PHOTOS_GUIDE.pdf` (11 pages, every card verbatim; regenerate with `scripts/build-shade-photos-guide.py`). Owner: Designs → 🎨 **Shade Photos** → 202/201 → send each shade's garment picture **as a File** (📎 → File — a Telegram "photo" is compressed before the bot sees it) → ✅ Use it → ✅ Done → second admin approves → Orders → 202/201 → tap a shade: the swatch page morphs into the garment photo in place; 🔍 Full-quality picture delivers the stored bytes as a document. Two rulings owed: **D5** — a linked marketer's shade tap now SHOWS the photo and ✅ raises (BUSINESS_RULES §16 carries it as PENDING; knob 0 = one-tap); and a one-line `approvalEvents` guard so approving a shade batch stops also sending the swatch PAGE captioned "photo activated" (that file needs your go). Then decide the website half (§7 of the spec: customers see native resolution + shade-view reports there). | **Owner** | `telegram-ops-bot/specs/SHP-1_SHADE_PHOTOS.md` §7 |
| **0 — OWNER TEST** | EDB-1 ✏️ Edit Bale SHIPPED 02-Sep-2026: the bale card edited in place (design · shade · indent · yards per than · add a than), label photo required, one dual-admin `edit_bale` approval, executor re-checks the live rows then updates cells / appends thans on Inventory. Owner: run the 6061 correction through it (60 → 30, add a 30) — printable 7-page live-test script for two admins at `docs/EDB-1_TEST_SCRIPT.pdf` (regenerate with `scripts/build-edit-bale-test-script.py`); spec has the same steps. Deferred by ruling: removing a than (shape undecided), the ₦105,000 Qaribullah credit (financial reconciliation later). | **Owner** | `telegram-ops-bot/specs/EDB-1_EDIT_BALE.md` |
| 1 (for owner) | TRF-5 manual live test — transfer queue + single-flow retirement (commit `28d9121f`) | **Owner** | `telegram-ops-bot/specs/TRF-5_TEST_STEPS.md` |
| **0 — OWNER STEP** | MNU-1 SHIPPED DARK 17-Aug-2026. Owner: run `npm run set-webhook` once (registers /menu + Menu button + descriptions), then set Settings `MENU_ANCHOR_ENABLED=1` and run the 9 acceptance checks (navigation-only taps). Rollback = same cell to 0, live in ≤30s, no deploy. | **Owner** | `telegram-ops-bot/specs/MNU-1_MENU_ANCHOR.md` §Acceptance |
| 2 (agent) | Resume security remediation H6 + P3–P7 (audit fix plan) | **fresh session** | `telegram-ops-bot/docs/CODE_AUDIT_2026-07-07.md` |
| 2b (agent) | MNU-1 reach: staleness inside `flowKit.makeRenderer` (26 flows) + `telegramUI.editOrSendAnchored`; migrate the 13 hand-rolled flow renderers. Menus are done; these are wizard cards. | **later** | `telegram-ops-bot/specs/MNU-1_MENU_ANCHOR.md` §Scope |
| 2c (agent) | Audit Wave 2: verb-first labels + view/do split (W-1), one exit vocabulary (W-2), confirmation on destructive actions (W-3), opaque theme colours (D-7). **D-4 (identical approval rows) is the owner's stated top danger — do it first.** | **later** | `BLACK2.MD` Part 3 |
| 3 (agent, owner-paused 17-Aug) | RMV-1 finish: the ➖ Remove Contact tile (engine shipped `5dfca04`, no Telegram door yet; controller edit needs owner go) + attendance `getAudience` status normalisation + Phase C reach items | **paused** | `telegram-ops-bot/specs/RMV-1_PERSON_REMOVAL.md` §Open when resumed |

Known follow-up waiting on Emin's Task-4 finding: if photo archives to Drive are failing
(service-account quota), build the OAuth-as-user upload fix for `driveBackup`.
Remove each row (and this section when empty) once signed off.

## Session start ritual (do this BEFORE any work)

Multiple tools (Claude Code, Cursor, humans) push to this repo in parallel.

1. `git fetch origin main` (retry with backoff on network failure).
2. Fast-forward your working branch onto `origin/main` (`git merge --ff-only origin/main`;
   stash/reapply uncommitted work if needed). Never build on stale code.
3. Run `npm test` + `npm run smoke` to confirm the baseline is green before changing anything.
   If the baseline is red on clean main, diagnose/report it BEFORE building on top —
   do not assume it's yours, do not ignore it (date-dependent tests have happened).

## Scope rules (enforced for every session)

0. **Check `telegram-ops-bot/docs/BUSINESS_RULES.md` before designing any
   feature or idea.** It is the register of the owner's locked business
   rules (bale-number identity, no bot-side stock selection, image →
   operator → approval chain, warehouse pinning, …). A proposal that
   contradicts a rule there is raised with the owner, never built around.
   New owner rulings get added to that file in the same change.

1. **Default scope: `telegram-ops-bot/` only.** Any file outside requires explicit user instruction.
2. **Never modify** `src/controllers/telegramController.js` for refactors — parked for TG-8.
   Surgical additions (a dispatch block, an `act:` case, a small feature edit) are allowed
   only when the user explicitly requested that feature; confirm before touching.
3. **Never change approval semantics** (`WRITE_ACTIONS`, `ALWAYS_APPROVAL_ACTIONS` in `src/risk/evaluate.js`) without explicit instruction. Adding a NEW action code still requires the user's sign-off.
4. **Never alter Google Sheets column order or rename existing columns.** New columns go to the end of the range only. New sheets are registered in `src/services/schemaMapper.js`.
5. **Never commit secrets** — no `.env`, no raw API keys, no credentials JSON.
5b. **Storage layering (owner rule, 16-Jul-2026):** Google Sheets hold RAW
   tabular business records only (masters, ledgers, edges, invoices) — no new
   log/telemetry/state sheets. Logging, event trails, and operational state
   belong in the Railway Postgres DB (PG-1; owner is expanding its config).
   Derived facts are computed at read time, never persisted to a sheet.
6. **All test/script files run with zero real credentials** — mock Telegram, Sheets, OpenAI.
7. **One task = one commit.** Do not bundle unrelated changes.

## Deploy rule (how work reaches Telegram for testing)

- Work on the designated session branch; commit there first.
- When the owner asks to test: verify `origin/main` is an ancestor of HEAD
  (`git merge-base --is-ancestor origin/main HEAD`), then fast-forward push:
  `git push origin HEAD:main`. **Never force-push, never merge-commit, never rebase
  shared history.** If main diverged, stop and re-sync instead.
- The bot redeploys from `main`; a new `Settings`/schema default takes effect on restart.

## Feature recipe (the standard shape of a new bot feature)

1. **Spec first** for anything non-trivial: a short doc in `telegram-ops-bot/specs/`
   with the owner's locked decisions.
2. **Flow module** in `src/flows/<name>Flow.js`: own `SESSION_TYPE` (`*_flow` naming),
   own short callback namespace (see registry below), `start()` + `handleCallback()`
   exports, anchored-message render via `session.flowMessageId`.
3. **Wire-up**: one entry in `src/services/activityRegistry.js` (tile + hub), one
   `act:` case + one 4-line prefix dispatch block in the controller (surgical, ask first).
4. **Anything tunable goes in the Settings sheet** with an in-code default in
   `settingsRepository.DEFAULTS` (see toggles table below) — never hardcode business knobs.
5. **Write approvals** ride the existing pipeline: queue via `approvalQueueRepository`,
   notify via `approvalEvents.notifyAdminsApprovalRequest` (exclude admin requesters),
   execute via a new branch in `inventoryService.executeApprovedAction`, gate via
   `ALWAYS_APPROVAL_ACTIONS` (sign-off required). Tap-flow-only actions do NOT go in the
   intentParser enum (S4 lints enum → policy, not the reverse).
6. **Tests before push**: unit tests for pure logic + a characterization test driving the
   real controller via `test/helpers/controllerHarness` (fake sheets/bot/intent).
   `npm test`, `npm run smoke` green and `npm run lint` at **0 errors** — always.

## Callback-prefix registry

Every inline keyboard callback is routed by prefix in `handleCallbackQuery`. Before
choosing a new namespace, `grep "startsWith('" src/controllers/telegramController.js`.
Major namespaces already taken:

- Menus: `act:` (tiles; `act:__hub__:<id>`, `act:__back__` are session-free navigation)
- Supply request: `srf_*` · legacy inline flows: `up*` (price), `tp*`/`tt*` (transfers), `rt*` (RETIRED return tap picker — dead since RET-4; `rtx*` is the still-live TYPED return preview), `sm*` (sample), `ac*` (CON-1 add-person one door:
  `actype:` kind · `accat:`/`accred:`/`acpt:` customer sub-categories ·
  `acskip:`/`acb:`/`acconf:`/`accanc:`/`acquick:`)
- Flow modules: `gr:` `br:` `addstock:` `pr:` `wh:` `wai:` `edb:` (EDB-1 Edit Bale) `bs:` `udf:` `sbl:` `lcost:` `bops:` `ofex:` `usr:` `umg:` `rol:` `atd:` `atd_rpt:` `atd_adm:` `tsk:` `nf:` `swv:` `pp:` `pay:` (PAY-1 payments; `pay:done|dec` are
  session-free; PAY-2 adds `pay:proof:skip` · `pay:start:wait` · `pay:wait:<i>`) `pu:` (pending-user triage — IDR-2 adds
  `pu:cust|net|link|linkcancel`) `cms:` `shr:` (share links) `rn:` (RET-4 ↩️ Return goods —
  `rn:cust|csearch|bale|t|tall|tnext|dd|dm|dq|noop|c|pskip|back|cancel|submit`)
  `oq/oc/od*` (orders) `rc*` (receipts)
- Catalog: `csf:` `clf:` `crf:` `mkr:` `ctr:` `dab:` `das:` `dat:` `dap:` (incl.
  `dap:page:add|replace` — CAT-P1 add-a-page vs replace) `dam:` `dav:` `shp:`
  (SHP-1 shade photos upload door; `srf_shpfull` + `myp:sc|sf|sb` are the
  shade-photo chips on the Orders / My Collection cards)
- Approvals: `approve:` `reject:` `ctg:` (contact triage) `srf_acc/ack/dec/assign:` `smc:` `confirm_sale:` `cancel_sale:`
- Reports: `cks:` `lpk:` `svr:` `inv:` `sr:`/`srg:` `mdo:`

Telegram caps `callback_data` at 64 bytes — keep payloads short (indexes into
session arrays, `cbSafe()` from `src/utils/telegramUI.js`).

## Key source files

| File | Role |
|------|------|
| `server.js` | Entry point — Express + webhook + schedulers (reminders, session janitor) |
| `src/config/index.js` | All env-var config |
| `src/controllers/telegramController.js` | 11 k-LOC god controller (split pending TG-8) |
| `src/flows/*.js` | One self-contained module per guided flow (23+; the pattern to follow) |
| `src/events/approvalEvents.js` | Approval routing, multi-stage supply |
| `src/risk/evaluate.js` | Action → approval gate |
| `src/ai/intentParser.js` | NLP; defines the `action` enum (S4 smoke lint) |
| `src/services/inventoryService.js` | `executeApprovedAction` — approved-action executors |
| `src/services/activityRegistry.js` | Menu hubs + tiles (single source of menu truth) |
| `src/services/schemaMapper.js` | Startup sheet bootstrap (register new sheets here) |
| `src/services/unitDisplayService.js` | TV-1/2 bales⇄thans display modes (Settings-driven) |
| `src/services/locationService.js` + `src/repositories/locationsRepository.js` | LOC-1 place register: which city a warehouse/store sits in, and which kind it is |
| `src/services/sessionJanitor.js` | SJ-1/2 stale-flow tombstoning |
| `src/services/transferService.js` + `src/repositories/transfersRepository.js` | TRF-1 staged warehouse transfers (foundation; UI pending) |
| `src/repositories/*.js` | One file per Google Sheet |
| `src/utils/sessionStore.js` | Per-user flow state (in-memory, TTL, expiry hooks) |
| `src/utils/menuNav.js`, `telegramUI.js`, `shadeButtons.js` | Shared nav footers / send helpers / shade labels — reuse, don't reinvent |
| `scripts/check-org-graph.js` | Offline org-graph assertions (`npm run check-org`) |
| `scripts/smoke.js` | Full offline smoke harness (`npm run smoke`) |
| `specs/*.md` | Feature specs with owner-locked decisions |

## Sheets the bot uses

`Inventory`, `Transactions`, `Customers`, `Users`, `Departments`, `Orders`,
`Samples`, `ApprovalQueue`, `Tasks`, `Contacts`, `ProductTypes`, `Settings`,
`Receipts`, `AuditLog`, `DesignAssets`, `CatalogStock`, `CatalogLedger`,
`Marketers`, `MarketerAllocations`, `LedgerTransactions`,
`PaymentAccounts`, `PaymentRequests`,
`LedgerBalanceCache`, `Transfers`, `GoodsReceipts`, `PendingUsers`, `Locations`,
`DesignShadeAssets` (SHP-1 — one garment photo per design+shade tab[+container];
originals untouched in Drive, stamped copy at native resolution, two Telegram
file_id caches: photo form + full-quality document form).

**Retired 31-Aug-2026 (SHT-1) — do not re-add:** `Stock_Ledger`, `UserPrefs`,
`ShipmentEvents`, `BankFeed`. Each had no live reader; two had no writer either.
They are absent from `schemaMapper` so the bootstrap cannot recreate the tabs.
The storage split that produced this (which sheets move to Railway Postgres and
which stay) is recorded in `telegram-ops-bot/docs/SHEET_STORAGE_SPLIT.md`.

Inventory column W = `design_category` (Cashmere / Chinos / Gaberdine /
Senator / TR / …), stamped per DESIGN by the dual-admin Set Design Category
flow (DCAT-1) — owner chose an Inventory column over a separate mapping sheet.

Invoices column W = `rate_multiplier` (CUR-2, 09-Sep-2026) — the one trailing
column after `created_at`: the customer-copy factor frozen at issue, blank =
none (never `1`). Every other Invoices cell (`lines_json`, `subtotal`,
`total`, `amount_paid_at_issue`, `balance_after_issue`) stays a BASE figure in
variable 1; the document is rendered as stored base × stored factor (owner's
integrity ruling, BUSINESS_RULES §17). `invoicesRepository.ensureHeader`
widens a live 22-column sheet by that one header cell and touches no data
row.

**Railway Postgres tables (not sheets):** `stock_events` (STK shadow), the
web/ext/usage/share tables, and since PAY-2 (09-Sep-2026) `payment_reasons`,
`payment_events`, `payment_reason_codes` — the payment reason, the payment
lifecycle trail and the reason-code index. Owner ruling: logging never goes
to a Google Sheet; new tables go through `src/db/migrations.js` MIGRATIONS[].

## Settings-sheet toggles (owner-editable, no deploy)

| Key | Default | Meaning |
|-----|---------|---------|
| `RISK_THRESHOLD` / `LOW_STOCK_THRESHOLD` | 300 / 100 | risk engine thresholds |
| `THAN_VISIBILITY_WAREHOUSES` | `Kano office` | CSV of warehouses listing stock in thans (TV-1); togglable in-bot via 📐 Display Units behind admin approval (TV-2) |
| `FLOW_CLEANUP_MINUTES` / `_HEAVY` | 30 / 60 | stale-flow tombstone grace (SJ-1) |
| `SALE_CALENDAR_MAX_DAYS_BACK` | 180 | how far back the sale-date calendars reach (BKD-1; Sell Bale + Kano than sale) |
| `PAYMENT_THRESHOLD_NGN` | 50000 | PAY-1 large-payment badge line (badges, never gates) |
| `FLOW_CLEANUP_HEAVY_TYPES` | CSV | session types counted as heavy |
| `SHADE_PHOTOS_ENABLED` | 1 | SHP-1 — 0 = shade taps behave exactly as before (no photo morph, no 🔍 chip); the 🎨 upload door stays |
| `EDIT_BALE_PHOTO_REQUIRED` | 1 | EDB-1 — 0 = a bale edit may be sent for approval without the label photo |
| `INVOICE_RATE_MULTIPLIER` | blank (env `INVOICE_RATE_MULTIPLIER` seeds it) | CUR-2 — the factor the CUSTOMER COPY of a sale invoice multiplies the entered rate by (`1250`: entered `3.20/yd` → `4,000.00/yd` on the PDF / web copy). Blank / 0 / 1 = none — the document prints the entered figures unconverted. Read ONCE at issue and frozen in `Invoices.rate_multiplier`; a later change never touches an issued invoice. The sheet's own figures, the ledger and Transactions are never multiplied (§17). the wizard's Step 5 (`INVOICE_MULTIPLIER_ASK`) can override it per sale |
| `INVOICE_MULTIPLIER_ASK` | 1 | CUR-2 — 1 = the sale approval wizard asks Step 5 (customer-copy multiplier: No multiplier · Settings value · type); 0 = the step is skipped and the Settings cell alone decides |
| `PAYMENT_FINANCE_REMINDER_HOURS` | 4 | PAY-2 — hours after approval (or the last finance card / reminder) before an approved-but-unpaid payment re-sends its finance card to the finance seat; 0 = off |

New defaults live in `settingsRepository.DEFAULTS`; a sheet row of the same key overrides.

## Testing conventions

- `npm test` — full node:test suite (unit + characterization). Always green before push.
- `npm run smoke` — full offline harness (intent enum vs policy lint + repo parse checks + org graph). Always `$0`. Avoid date-dependent assertions (weekday/working-day fixtures must be day-aware).
- `npm run lint` — ESLint; **0 errors** required (warnings tolerated).
- Characterization tests drive the REAL controller via `test/helpers/controllerHarness`
  (fake sheets via `fakeSheets`, recording bot via `fakeBot`, stubbed intent). Pin behavior
  BEFORE modifying anything in the parked controller.
- Real API integration tests are manual only — never automated against production sheets.

## What Claude Code may start without asking

- Add/extend scripts under `telegram-ops-bot/scripts/`.
- Add JSDoc to existing functions.
- Add `npm` scripts in `telegram-ops-bot/package.json`.
- Create new files under `src/org/` (org hierarchy module).
- Create new flow modules under `src/flows/` (+ their tests) for a feature the user
  explicitly requested in this session.

## What Claude Code must ask before doing

- Any change to `src/controllers/telegramController.js`.
- Any change to `src/risk/evaluate.js`.
- Any change to `src/events/approvalEvents.js`.
- Any schema change (new column, new sheet, row mutation).
- Any commit to a branch other than the current working branch (fast-forwarding `main`
  per the Deploy rule is pre-authorized once tests are green and the owner asked to test).
- Anything outside `telegram-ops-bot/`.
