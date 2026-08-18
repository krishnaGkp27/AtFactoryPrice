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
| **0 — OWNER STEP** | PAY-1 SHIPPED 14-Aug-2026. Owner: add `Finance` to the Office phone's `department` cell in the Users sheet (sole member) — until then payment cards go to ALL admins with a warning instead of to the one finance hand. Then register the first accounts (each employee their own; an admin for contractors), dual-approve, and run one small live payment end to end. | **Owner** | `telegram-ops-bot/specs/PAY-1_PAYMENT_REQUESTS.md` §After shipping |
| 0b | EXP-1 attach→parse→confirm component (APC-1 Phase E): photo/Excel in → OCR'd figures as confirm chips → file archived as evidence; lands in the expense flow first, then the approval wizards. EXP-1 core SHIPPED 08-Aug-2026 (`d03423e`+`ed009a1`): daily record, running balance, 20:00 finance report + reminder. Owner: seed the float by recording current cash-in-hand once via ➕ Cash received. | **Owner + agent** | `telegram-ops-bot/specs/EXP-1_OFFICE_EXPENSES.md` |
| ~~0b~~ ✅ | APC-1 approval concurrency — Phases A–D SHIPPED 08-Aug-2026 (per-request sale wizards, reason-prompt queue, transfer pick/gate guards, id-carrying inbox decisions). Phase E (attach→parse→confirm component) rides with EXP-1. | **shipped** | `telegram-ops-bot/specs/APC-1_APPROVAL_CONCURRENCY.md` |
| **0c — RUN FIRST** | Sheet-audit follow-through: owner runs `scripts/repair-contacts-staircase.js` (dry-run → `--commit`; until then 4 Contacts rows are invisible to the bot) and `scripts/format-date-columns.js --commit`; seeds `Locations` sheet (activates VRF-2 store bill-check skip); uploads 9037's 2 catalogue photos (tests CAT-P1 album); tests IDR-2 triage with a fresh account. Full state-at-pause + open rulings (AuditLog col D rename, Contacts writer elegance): see steps doc. | **Owner + agent** | `telegram-ops-bot/docs/SHEET_AUDIT_2026-08-14.md` §State at pause |
| 1 (for owner) | Turn ON webhook enforcement (set `TELEGRAM_WEBHOOK_SECRET` → `npm run set-webhook` → `REQUIRE_WEBHOOK_SECRET=1`). Fix is shipped but DORMANT. | **Owner** | `telegram-ops-bot/specs/SEC-P1-P2_PICKUP.md` |
| 1 (for Emin) | Backup fix + Drive-quota / photo-archive diagnosis (BKP-1). ⚠️ Bot-side job DISABLED by owner request 10-Jul-2026 (`SHEET_BACKUP_ENABLED` default 0) — **no daily sheet backups run at all** until checklist Task 1 (Apps Script) is installed. | **Emin** | `telegram-ops-bot/specs/BKP-1_EMIN_CHECKLIST.md` |
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
- Supply request: `srf_*` · legacy inline flows: `up*` (price), `tp*`/`tt*` (transfers), `rt*` (return), `sm*` (sample), `ac*` (CON-1 add-person one door:
  `actype:` kind · `accat:`/`accred:`/`acpt:` customer sub-categories ·
  `acskip:`/`acb:`/`acconf:`/`accanc:`/`acquick:`)
- Flow modules: `gr:` `br:` `addstock:` `pr:` `wh:` `wai:` `bs:` `udf:` `sbl:` `lcost:` `bops:` `ofex:` `usr:` `umg:` `rol:` `atd:` `atd_rpt:` `atd_adm:` `tsk:` `nf:` `swv:` `pp:` `pay:` (PAY-1 payments; `pay:done|dec` are
  session-free) `pu:` (pending-user triage — IDR-2 adds
  `pu:cust|net|link|linkcancel`) `cms:` `shr:` (share links) `oq/oc/od*` (orders) `rc*` (receipts)
- Catalog: `csf:` `clf:` `crf:` `mkr:` `ctr:` `dab:` `das:` `dat:` `dap:` (incl.
  `dap:page:add|replace` — CAT-P1 add-a-page vs replace) `dam:` `dav:`
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
`Marketers`, `MarketerAllocations`, `UserPrefs`, `LedgerTransactions`,
`PaymentAccounts`, `PaymentRequests`,
`LedgerBalanceCache`, `Transfers`, `GoodsReceipts`, `PendingUsers`, `Locations`.

Inventory column W = `design_category` (Cashmere / Chinos / Gaberdine /
Senator / TR / …), stamped per DESIGN by the dual-admin Set Design Category
flow (DCAT-1) — owner chose an Inventory column over a separate mapping sheet.

## Settings-sheet toggles (owner-editable, no deploy)

| Key | Default | Meaning |
|-----|---------|---------|
| `RISK_THRESHOLD` / `LOW_STOCK_THRESHOLD` | 300 / 100 | risk engine thresholds |
| `THAN_VISIBILITY_WAREHOUSES` | `Kano office` | CSV of warehouses listing stock in thans (TV-1); togglable in-bot via 📐 Display Units behind admin approval (TV-2) |
| `FLOW_CLEANUP_MINUTES` / `_HEAVY` | 30 / 60 | stale-flow tombstone grace (SJ-1) |
| `SALE_CALENDAR_MAX_DAYS_BACK` | 180 | how far back the sale-date calendars reach (BKD-1; Sell Bale + Kano than sale) |
| `PAYMENT_THRESHOLD_NGN` | 50000 | PAY-1 large-payment badge line (badges, never gates) |
| `FLOW_CLEANUP_HEAVY_TYPES` | CSV | session types counted as heavy |

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
