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
| 1 (for owner) | Turn ON webhook enforcement (set `TELEGRAM_WEBHOOK_SECRET` → `npm run set-webhook` → `REQUIRE_WEBHOOK_SECRET=1`). Fix is shipped but DORMANT. | **Owner** | `telegram-ops-bot/specs/SEC-P1-P2_PICKUP.md` |
| 1 (for Emin) | Backup fix + Drive-quota / photo-archive diagnosis (BKP-1) | **Emin** | `telegram-ops-bot/specs/BKP-1_EMIN_CHECKLIST.md` |
| 1 (for owner) | TRF-5 manual live test — transfer queue + single-flow retirement (commit `28d9121f`) | **Owner** | `telegram-ops-bot/specs/TRF-5_TEST_STEPS.md` |
| 2 (agent) | Resume security remediation H6 + P3–P7 (audit fix plan) | **fresh session** | `telegram-ops-bot/docs/CODE_AUDIT_2026-07-07.md` |

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

1. **Default scope: `telegram-ops-bot/` only.** Any file outside requires explicit user instruction.
2. **Never modify** `src/controllers/telegramController.js` for refactors — parked for TG-8.
   Surgical additions (a dispatch block, an `act:` case, a small feature edit) are allowed
   only when the user explicitly requested that feature; confirm before touching.
3. **Never change approval semantics** (`WRITE_ACTIONS`, `ALWAYS_APPROVAL_ACTIONS` in `src/risk/evaluate.js`) without explicit instruction. Adding a NEW action code still requires the user's sign-off.
4. **Never alter Google Sheets column order or rename existing columns.** New columns go to the end of the range only. New sheets are registered in `src/services/schemaMapper.js`.
5. **Never commit secrets** — no `.env`, no raw API keys, no credentials JSON.
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
- Supply request: `srf_*` · legacy inline flows: `up*` (price), `tp*`/`tt*` (transfers), `rt*` (return), `sm*` (sample), `ac*` (add customer)
- Flow modules: `gr:` `br:` `addstock:` `pr:` `wh:` `wai:` `bs:` `udf:` `sbl:` `lcost:` `bops:` `ofex:` `usr:` `umg:` `rol:` `atd:` `atd_rpt:` `atd_adm:` `tsk:` `nf:` `swv:` `pp:` `pu:` `cms:` `oq/oc/od*` (orders) `rc*` (receipts)
- Catalog: `csf:` `clf:` `crf:` `mkr:` `ctr:` `dab:` `das:` `dat:` `dap:` `dam:` `dav:`
- Approvals: `approve:` `reject:` `srf_acc/ack/dec/assign:` `smc:` `confirm_sale:` `cancel_sale:`
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
`Marketers`, `UserPrefs`, `LedgerTransactions`, `LedgerBalanceCache`,
`Transfers`, `GoodsReceipts`, `PendingUsers`.

## Settings-sheet toggles (owner-editable, no deploy)

| Key | Default | Meaning |
|-----|---------|---------|
| `RISK_THRESHOLD` / `LOW_STOCK_THRESHOLD` | 300 / 100 | risk engine thresholds |
| `THAN_VISIBILITY_WAREHOUSES` | `Kano office` | CSV of warehouses listing stock in thans (TV-1); togglable in-bot via 📐 Display Units behind admin approval (TV-2) |
| `FLOW_CLEANUP_MINUTES` / `_HEAVY` | 30 / 60 | stale-flow tombstone grace (SJ-1) |
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
