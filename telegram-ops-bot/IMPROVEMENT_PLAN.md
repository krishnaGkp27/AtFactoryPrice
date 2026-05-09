# Telegram Ops Bot — Improvement Plan

> **Status:** Proposed. **No code changes have been made.** This plan is the
> single source of truth for the desktop Cursor session that will implement
> the improvements locally. Each task is self-contained: file paths, current
> state, target state, acceptance criteria, risk, and rollback are spelled
> out so the desktop session does not have to re-explore the codebase.

---

## 0. Scope and ground rules

- **In scope:** everything under `telegram-ops-bot/`.
- **Out of scope:** the rest of the repository (web HTML, `functions/`, `mobile/`, `js/`, `sw.js`, `firestore.rules`, `firestore.indexes.json`). Do **not** touch those files while executing this plan.
- **Business behaviour must not change.** The bot's user-visible flows (Telegram menus, NL commands, approval semantics, sheet schemas) must remain identical. Only internal structure, performance, security, and stability change.
- **Sheet schema is sacred.** Do not rename columns or sheets. Do not add/remove columns without an explicit follow-up plan.
- **Approval semantics are sacred.** Employee → admin and admin → 2nd-admin gates stay as they are (`src/risk/evaluate.js`).
- **One PR per phase, please.** Land Phase 1 fully before starting Phase 2. This isolates regressions.

## 1. How to use this plan in desktop Cursor

1. Pull this branch (`cursor/telegram-bot-improvement-plan-fdb6`).
2. Read **§3 Glossary** before touching code — it tells you what each module is for so you don't have to grep.
3. Pick the **lowest-numbered TG-### task** that is still `Open`.
4. Implement only that task. Run the **acceptance test** for it. Commit with the task ID in the subject (e.g. `TG-1: fix sessionStore require path`).
5. Tick the task off in this file (change `Status: Open` → `Status: Done` in your commit) so the next pass knows what is left.
6. **Do not batch tasks** unless the plan explicitly says they share a commit (e.g. TG-2a/2b).
7. Push and open a separate PR per phase, against `main`, draft.

## 2. Risk-tier summary

| Tier | Tasks | When to land |
|------|-------|--------------|
| Phase 1 — Critical / High (correctness + security) | TG-1 … TG-7 | Land first. These either crash the bot or expose it to abuse. |
| Phase 2 — Architecture cleanup (no behaviour change) | TG-8 … TG-15 | After Phase 1 is in production for at least one full business cycle. |
| Phase 3 — Performance | TG-16 … TG-21 | After Phase 2; relies on the cache abstraction introduced there. |
| Phase 4 — Scalability / future | TG-22 … TG-26 | Strategic. Each task here should be re-discussed with the user before starting. |

## 3. Glossary of modules in `telegram-ops-bot/src/`

| Path | Role |
|------|------|
| `server.js` | Express app + webhook entry + 4 polling reminder jobs (`setInterval`). |
| `src/config/index.js` | Reads env vars; exposes telegram, openai, sheets, access, risk, drive, currency. |
| `src/middlewares/auth.js` | Pure env-var allow-list (`adminIds`, `employeeIds`). |
| `src/middlewares/roleCheck.js` | Sheet-backed role lookup with env-var fallback. |
| `src/middlewares/validate.js` | Tiny placeholder. |
| `src/repositories/sheetsClient.js` | Thin Sheets API wrapper with retry/backoff. **Only this file talks to googleapis.** |
| `src/repositories/*Repository.js` | One module per sheet. They each parse rows and expose CRUD-like helpers. |
| `src/repositories/driveClient.js` | Google Drive uploads (sample/receipt photos, design assets). |
| `src/services/inventoryService.js` | Sale / return / transfer / price-update business logic with risk gating. |
| `src/services/queryEngine.js` | Tier 1 predefined reports + Tier 2 free-form OpenAI analyst. |
| `src/services/accountingService.js` | Ledger entries (sale = single-entry, payment = double-entry). |
| `src/services/stockLedgerService.js` | Stock-side ledger mirror of inventory moves. |
| `src/services/auditService.js` | Append-only audit log writes. |
| `src/services/crmService.js` | Customer create/find. |
| `src/services/balanceService.js` | Cached customer balance lookups (already has its own cache). |
| `src/services/salesFlowService.js` | Multi-step sale flow state machine. |
| `src/services/designAssetsService.js` | Design photo overlay + storage in Drive. |
| `src/services/schemaMapper.js` | Sheet bootstrap (header creation, ID columns). |
| `src/services/activityRegistry.js` | Names/labels for activity types. |
| `src/services/transactionService.js` | Cross-cutting transaction helper. |
| `src/services/ledgerService.js` | Higher-level ledger reads. |
| `src/controllers/telegramController.js` | **9,730 LOC god controller.** Routes every message and callback. |
| `src/controllers/catalogFlowController.js` | 1,768 LOC. Five physical-catalog flows. |
| `src/controllers/apiController.js` | `/api/settings` GET/PUT for the admin web page. |
| `src/events/erpEventBus.js` | EventEmitter bridge from inventory ops to ERP services. |
| `src/events/approvalEvents.js` | 1,146 LOC. Approval workflow notifications + multi-stage supply request. |
| `src/risk/evaluate.js` | Defines which actions ALWAYS need approval. |
| `src/ai/intentParser.js` | OpenAI intent extraction. 35 KB system prompt. |
| `src/ai/colorDetector.js` | Image colour analysis for shade detection. |
| `src/ai/analytics.js` | Aggregations (stockByDesign, customerAnalysis, fastMoving, etc.). |
| `src/commands/ledgerCommands.js` | Ledger-specific Telegram command handlers. |
| `src/utils/sessionStore.js` | In-memory per-user flow state + 30-min orphan hint. |
| `src/utils/idempotency.js` | **Dead, broken** (Date.now() in key, never required). |
| `src/utils/idGenerator.js` | UUID-ish IDs for entries. |
| `src/utils/dates.js`, `formatDate.js` | Date helpers (Lagos TZ). |
| `src/utils/telegramFiles.js` | Download Telegram file uploads. |
| `src/utils/imageOverlay.js` | `sharp`-based image composition. |
| `src/utils/shadeButtons.js` | Build shade selection keyboards. |
| `src/utils/stockCalculator.js` | Pure math for stock totals. |
| `src/utils/logger.js` | `console.log` wrapper with level prefix. |

---

# Phase 1 — Critical / High

These items either crash the bot or open it to misuse. Land them first, in order.

---

## TG-1 — Fix `sessionStore` `require` path crash in `approvalEvents.js`

- **Severity:** Critical (runtime crash).
- **Status:** Open.

### Current state

`src/events/approvalEvents.js` lines **895** and **989** do:

```js
const sessionStore = require('../services/sessionStore');
```

The file lives at `src/utils/sessionStore.js`. There is **no** file at
`src/services/sessionStore.js`. This crashes whenever
`handleNewCustomerApproval` runs the resume-session branch — i.e. whenever
an admin approves or rejects a newly-registered customer while the
requester had a paused `supply_req_flow`, `sample_flow`, `order_flow`, or
`receipt_flow`.

### Target state

Both `require` calls should point to `'../utils/sessionStore'`.

Better still: hoist the import to the top of the file (the rest of the
repo uses top-of-file requires) so the broken path can't reappear.

### Files

- `src/events/approvalEvents.js`

### Acceptance criteria

1. `node -e "require('./src/events/approvalEvents.js')"` from
   `telegram-ops-bot/` exits 0.
2. Manual test (or unit test if added later): trigger a customer
   registration that needs approval while inside a `supply_request` flow,
   approve it, confirm the requester receives the
   `"Continuing your supply request… Select salesperson:"` follow-up
   instead of the bot silently dying.
3. Commit message: `TG-1: fix sessionStore require path in approvalEvents`.

### Risk / rollback

- Risk: none. Path correction.
- Rollback: revert single commit.

---

## TG-2 — Validate the Telegram webhook secret

- **Severity:** High (security).
- **Status:** Open.

### Current state

`src/config/index.js` exposes `config.telegram.webhookSecret` from
`TELEGRAM_WEBHOOK_SECRET`, but `server.js` never validates it.
Anyone who knows or guesses the public webhook URL can POST fake
updates impersonating Telegram. With the bot's auth model
(env-var ID allow-list), the attacker would still need a valid
admin/employee Telegram ID inside `update.message.from.id`, but the
allow-list is a soft control — webhook spoofing should still be
hard-rejected.

### Target state

`server.js` `/webhook` handler:

1. If `config.telegram.webhookSecret` is set, require the request to
   carry header `X-Telegram-Bot-Api-Secret-Token` equal to it. Otherwise
   respond 401 immediately and **do not** call into the controllers.
2. If `webhookSecret` is empty, log a warning at startup
   (`logger.warn('TELEGRAM_WEBHOOK_SECRET not set — webhook is unauthenticated')`).
3. Update `scripts/set-webhook.js` to pass `secret_token` to
   `setWebhook` when the env var is set. (`node-telegram-bot-api`
   accepts `secret_token` in the options object.)

### Files

- `telegram-ops-bot/server.js`
- `telegram-ops-bot/scripts/set-webhook.js`
- `telegram-ops-bot/.env.example` (already lists `TELEGRAM_WEBHOOK_SECRET`? if not, add it with a comment)
- `telegram-ops-bot/SETUP.md` (mention the new requirement)

### Acceptance criteria

1. With `TELEGRAM_WEBHOOK_SECRET=foo` set, a `curl -XPOST /webhook`
   without the header returns 401.
2. With the header set correctly, the request is accepted and processed.
3. `npm run set-webhook` registers the secret with Telegram.
4. With `TELEGRAM_WEBHOOK_SECRET` unset, behaviour is unchanged
   except for a startup warning.

### Risk / rollback

- Risk: misconfigured secret in production = silent webhook outage.
  Mitigate by deploying with the env var blank first, confirming the
  warning, then setting the var and re-running `set-webhook`.
- Rollback: clear `TELEGRAM_WEBHOOK_SECRET` and re-run `set-webhook`.

---

## TG-3 — Lock down `/api/settings` CORS and add request audit

- **Severity:** High (security).
- **Status:** Open.

### Current state

`server.js` lines 26–32 set
`Access-Control-Allow-Origin: <origin>|*` for **every** endpoint and
allows `GET, PUT, OPTIONS`. The `PUT /api/settings` endpoint
(`src/controllers/apiController.js`) is gated only by `BOT_API_KEY`
(`X-API-Key` header). There is no audit log of who changed what, no
rate limit, and no origin allow-list.

### Target state

1. Replace the wildcard CORS with an allow-list driven by env var
   `ALLOWED_ORIGINS` (comma-separated). Default = empty = no CORS
   headers (same-origin only).
2. On every successful `PUT /api/settings`, append a row to a new
   `BotAuditLog` sheet (or reuse `auditLogRepository.append`) with
   `{actor: 'api', ip, key, oldValue, newValue, ts}`.
3. Reject `PUT` if `BOT_API_KEY` is empty in env (don't run with an
   empty key allowing anonymous writes).
4. Add a tiny in-process rate limit: max 10 PUTs / minute / IP.

### Files

- `telegram-ops-bot/server.js`
- `telegram-ops-bot/src/controllers/apiController.js`
- `telegram-ops-bot/src/repositories/auditLogRepository.js` (only if a new helper is added)

### Acceptance criteria

1. Cross-origin browser request from a non-allow-listed origin fails
   the CORS preflight.
2. PUT without `X-API-Key` returns 401.
3. PUT with the key results in an audit log row.
4. PUT 11 times in 60 s from one IP returns 429 on the 11th.

### Risk / rollback

- Risk: admin web page may stop working until its origin is added.
  Mitigate by setting `ALLOWED_ORIGINS` first.
- Rollback: revert and the wildcard returns.

---

## TG-4 — Delete or fix `src/utils/idempotency.js` (it is broken AND unused)

- **Severity:** High (technical debt that looks like a safety net but isn't).
- **Status:** Open.

### Current state

`src/utils/idempotency.js`:

- `makeKey(...)` includes `Date.now()` in the produced key, so two
  identical calls produced 1 ms apart never collide. It cannot deduplicate
  anything.
- No file in `src/` `require`s it.

### Target state — choose ONE

**Option A (recommended for now):** delete the file. We have nothing
that depends on it and the current name is misleading.

**Option B:** fix it: drop `Date.now()` from the key, set
`TTL_MS = 5 * 60 * 1000`, and wire it into the entry points that need
deduplication: webhook handler in `server.js`, every "always require
approval" path in `inventoryService.js` (around `sellThan`,
`sellPackage`, `recordPayment`, etc.). Add a unit-style smoke test.

### Files

- `telegram-ops-bot/src/utils/idempotency.js`
- (Option B only) `telegram-ops-bot/server.js`, `src/services/inventoryService.js`

### Acceptance criteria

- Option A: file removed, `grep -r idempotency telegram-ops-bot/src` is empty, bot still starts.
- Option B: a second identical sale request (`sellThan` with same
  packageNo+thanNo+customer) within 5 minutes is rejected with
  `{status:'duplicate'}` and not written to sheets.

### Risk / rollback

- Option A risk: none. Option B risk: a too-aggressive key shape may
  block legitimate retries — start with debug logging only for one
  release.

---

## TG-5 — Webhook handler hardening

- **Severity:** High.
- **Status:** Open.

### Current state

`server.js` `/webhook` returns `200` immediately and processes in the
background. Errors are logged via `logger.error`. There is no:

- correlation/request ID propagation
- DLQ / retry queue when the controller throws
- payload size limit (`express.json()` default = 100 KB — fine, but
  document it)

### Target state

1. Generate a request ID per webhook update (e.g. `crypto.randomUUID()`).
2. Pass it as the first argument or `meta` field into
   `telegramController.handleMessage` /
   `handleCallbackQuery` / `handleFileMessage`. The controllers don't
   need to use it yet — it just rides along on log lines.
3. On controller error, additionally write a row to a new sheet
   `WebhookErrors` with `{requestId, type, fromId, error.message,
   error.stack.split('\n')[0..3], ts}` so we can replay/triage.
4. Add `app.use(express.json({ limit: '512kb' }))` to make the limit
   explicit.

### Files

- `telegram-ops-bot/server.js`
- `telegram-ops-bot/src/controllers/telegramController.js` (signatures only — propagate `meta`)
- (new) `telegram-ops-bot/src/repositories/webhookErrorsRepository.js`
- `telegram-ops-bot/src/utils/logger.js` (optional — to support `withRequestId`)

### Acceptance criteria

1. Each webhook log line in `tail -f` includes the same `requestId`.
2. Forcing a controller throw writes one row to `WebhookErrors` sheet.
3. A 600 KB payload is rejected with 413 instead of being parsed.

### Risk / rollback

- Risk: signature changes for `handleMessage`/`handleCallbackQuery`/
  `handleFileMessage` ripple. Keep `meta` an optional second argument
  with a default of `{}` to make the change non-breaking inside the
  controller body.
- Rollback: drop the meta argument; the existing logger lines remain.

---

## TG-6 — Reject silently-default `productType` in inventory rows

- **Severity:** High (data quality).
- **Status:** Open.

### Current state

`src/repositories/inventoryRepository.js` `parseRow` line 45:

```js
productType: str(r[16]) || 'fabric',
```

Every row that is missing the `ProductType` column silently becomes
`'fabric'`. This is fine for legacy rows but means new bugs in the
appender are invisible.

### Target state

1. Keep the `'fabric'` fallback for read paths (legacy rows).
2. In `appendThans` (line 140) **assert** that every row has a
   non-empty `productType`; throw `Error('appendThans: productType required')`
   otherwise. Callers in `inventoryService.js` already pass it for new
   imports — verify and adjust.
3. Add an `import` log line counting how many existing rows still
   default to `'fabric'` (for visibility, no migration yet).

### Files

- `telegram-ops-bot/src/repositories/inventoryRepository.js`
- `telegram-ops-bot/src/services/inventoryService.js` (verify callers)
- `telegram-ops-bot/scripts/import-inventory.js` (verify defaults)

### Acceptance criteria

1. `appendThans([{ /* no productType */ }])` throws.
2. All existing tests / scripts still pass.
3. Log shows the legacy-row count once at startup (or on first `getAll`).

### Risk / rollback

- Risk: an existing caller may have been relying on the silent default.
  Mitigate by adding the assertion as a `console.warn` first, watching
  one production day, then upgrading to `throw`. (Land the warn now,
  the throw in a follow-up — note the staged plan in the commit.)
- Rollback: revert assertion.

---

## TG-7 — Document and tighten `risk/evaluate.js` action coverage

- **Severity:** High (auth correctness).
- **Status:** Open.

### Current state

`src/risk/evaluate.js`:

- `WRITE_ACTIONS` and `ALWAYS_APPROVAL_ACTIONS` are hand-maintained
  string arrays.
- New actions added in `intentParser.js`'s SYSTEM prompt (e.g. `give_sample`,
  `mark_order_delivered`, `add_followup`, `upload_receipt`,
  `supply_request`, etc.) do not all appear in either list — they fall
  through to `risk: 'safe'` for admins and `WRITE_ACTIONS` for
  employees only if the string matches.
- The default branch returns `risk: 'safe'`. That is the wrong default
  for any new write-style action.

### Target state

1. Convert `WRITE_ACTIONS` and `ALWAYS_APPROVAL_ACTIONS` into a single
   typed table: `ACTION_POLICY = { sell_than: 'always_approve',
   add_customer: 'employee_needs_approval', check: 'safe', ... }`.
2. Add an explicit entry for **every** action listed in
   `intentParser.js` `SYSTEM` prompt's `"action"` enum. Anything missing
   defaults to `'employee_needs_approval'` (fail closed) and emits a
   warn log so we can fix the table.
3. Keep the existing `formatAction()` map.
4. Add a unit smoke (just a Node script under
   `telegram-ops-bot/scripts/check-action-policy.js`) that compares
   the policy table keys to the enum in `intentParser.js`. Run it from
   `npm test` (add a `test` script that just runs this for now).

### Files

- `telegram-ops-bot/src/risk/evaluate.js`
- `telegram-ops-bot/src/ai/intentParser.js` (read-only — the source of truth for actions)
- (new) `telegram-ops-bot/scripts/check-action-policy.js`
- `telegram-ops-bot/package.json` (add `"test": "node scripts/check-action-policy.js"`)

### Acceptance criteria

1. `npm test` passes.
2. Adding a new action to `intentParser.js` without updating
   `ACTION_POLICY` causes `npm test` to fail.
3. Risk default for unknown action is `'employee_needs_approval'` for
   employees and `'safe'` for admins (preserves existing admin
   convenience but fails closed for employees).

### Risk / rollback

- Risk: tightening the default may cause a known-but-unmapped action
  to start needing approval unexpectedly. Mitigate by listing every
  enum entry explicitly during this task.
- Rollback: revert the policy table file.

---

# Phase 2 — Architecture cleanup

These tasks must NOT change behaviour. Run the bot in staging and walk
through the top 10 flows before merging each.

---

## TG-8 — Split `telegramController.js` by domain

- **Severity:** Medium (maintainability).
- **Status:** Open.

### Current state

`src/controllers/telegramController.js` = **9,730 LOC, 165 top-level
functions**. Single fault domain.

### Target state

Create folder `src/controllers/handlers/` with one file per domain.
Recommended split:

| New file | Domain |
|----------|--------|
| `handlers/inventory.js` | `sell_*`, `return_*`, `transfer_*`, `update_price`, `add_stock` |
| `handlers/sales.js` | sales flow (`salesFlowService` interactions) |
| `handlers/orders.js` | `create_order`, `my_orders`, `mark_order_delivered`, reminders |
| `handlers/customers.js` | `add_customer`, `check_customer`, `record_payment`, `check_balance`, `customer_history`, `customer_pattern`, `customer_ranking`, `add_followup`, `add_customer_note`, `show_customer_notes` |
| `handlers/reports.js` | every report builder (`buildDesignWiseReport`, `buildCustomerWiseReport`, `buildWarehouseWiseReport`, etc.) |
| `handlers/samples.js` | `give_sample`, `return_sample`, `update_sample`, `sample_status`, sample picker exports |
| `handlers/tasks.js` | `assign_task`, `my_tasks`, `mark_task_done` |
| `handlers/contacts.js` | `add_contact`, `list_contacts`, `search_contact` |
| `handlers/admin.js` | `manage_users`, `manage_departments`, `add_user`, `add_bank`, etc. |
| `handlers/ledger.js` | wraps existing `commands/ledgerCommands.js` |
| `handlers/receipts.js` | upload-receipt flow |
| `handlers/views.js` | shared rendering helpers (`fmtMoney`, `fmtMoneyShort`, `renderTopNWithRest`, `buildReportLegend`, `editOrSend`, `editOrSendAnchored`, `sendLong`) |

Then `src/controllers/telegramController.js` becomes a thin **router**:

```js
async function handleMessage(bot, msg, meta = {}) {
  const action = await intentParser.parse(msg.text);
  const handler = ROUTES[action.action] || handlers.fallback;
  return handler(bot, msg, action, meta);
}
```

Keep the existing public exports (`handleMessage`, `handleCallbackQuery`,
`handleFileMessage`, `showSampleQuantityPicker`, `showSampleCustomerPicker`)
re-exported from the new router so call-sites in `server.js`,
`approvalEvents.js`, etc. don't need to change.

### Files

- `src/controllers/telegramController.js` (becomes thin router)
- `src/controllers/handlers/*.js` (new)
- `src/controllers/views/*.js` (new) — only if the handler files share
  enough render code to warrant it

### Acceptance criteria

1. `node server.js` starts without errors.
2. Every existing flow listed in `TESTING.md` is exercised manually
   on staging and produces identical Telegram output.
3. Top-level export shape is unchanged: callers still
   `require('./src/controllers/telegramController')`.
4. No file in `src/controllers/` exceeds 1,500 LOC.

### Risk / rollback

- Risk: high. This is the single biggest churn in the plan.
- Mitigation: do it in stacked PRs, one domain per PR, each landing
  behind a feature flag (`USE_NEW_HANDLER_<domain>=1`) that selects
  between the old function and the new module. After two days of
  stable production, remove the old code path.

---

## TG-9 — Split `approvalEvents.js`

- **Severity:** Medium.
- **Status:** Open. Depends on **TG-1**.

### Current state

`src/events/approvalEvents.js` = 1,146 LOC mixing notification, multi-stage
supply request, customer approval, and free-text reason capture.

### Target state

Split into:

- `src/events/approvalNotifier.js` — `notifyAdminsApprovalRequest`, `notifyEmployee`, `resolveRequest`.
- `src/events/customerApproval.js` — `handleNewCustomerApproval` and the resume-session blocks (now using a clean `sessionStore` import).
- `src/events/saleApproval.js` — `enrichSale*` paths + price/payment capture.
- `src/events/supplyRequestApproval.js` — multi-stage supply request.

Keep the existing `module.exports` of `approvalEvents.js` as a barrel
re-export for compatibility.

### Files

- `src/events/approvalEvents.js` → barrel re-export
- `src/events/approvalNotifier.js` (new)
- `src/events/customerApproval.js` (new)
- `src/events/saleApproval.js` (new)
- `src/events/supplyRequestApproval.js` (new)

### Acceptance criteria

1. All approval flows listed in `TESTING.md` still work.
2. No file in `src/events/` exceeds 600 LOC.
3. `pendingEnrichment` and `pendingReason` Maps remain process-local
   for now (replaced in TG-22).

### Risk / rollback

- Risk: in-memory state shared between the split files can be
  miscaptured. Mitigation: hoist both Maps into a tiny
  `src/events/approvalState.js` and import from there in every split
  file.

---

## TG-10 — Centralize repeated helpers (`fmtMoney`, `fmtQty`, `genId`, `editOrSend`)

- **Severity:** Medium.
- **Status:** Open.

### Current state

- `fmtMoney` / `fmtQty` defined in `telegramController.js` (lines 114–119), `queryEngine.js` (lines 15–16), and `accountingService.js` (line 11 only uses `CURRENCY`).
- `genId` defined in `telegramController.js` (line 56) and
  `inventoryService.js` (line 16).
- `editOrSend` defined in `telegramController.js` (line 540) and
  `catalogFlowController.js` (line 26).

### Target state

- `src/utils/format.js` exports `fmtQty`, `fmtMoney`, `fmtMoneyShort`, `CURRENCY`, `CURRENCY_SYMBOL`.
- `src/utils/idGenerator.js` already exists — extend with a `requestId()` export and use everywhere instead of local `genId()`.
- `src/utils/telegramUI.js` exports `editOrSend`, `editOrSendAnchored`, `sendLong`, `safeDelete`, `cbSafe`.

Update the duplicated definitions to import from the new modules.

### Files

- `src/utils/format.js` (new)
- `src/utils/idGenerator.js`
- `src/utils/telegramUI.js` (new)
- `src/controllers/telegramController.js` (and any handler files from TG-8)
- `src/controllers/catalogFlowController.js`
- `src/services/queryEngine.js`
- `src/services/inventoryService.js`

### Acceptance criteria

1. Each helper is defined exactly once in `src/utils/`.
2. No behavioural change. Spot-check one report and one catalog flow
   visually.

### Risk / rollback

- Low. Mechanical edit.

---

## TG-11 — Standardize repository caching

- **Severity:** Medium.
- **Status:** Open.

### Current state

Only `src/repositories/inventoryRepository.js` has a 5-second `_allCache`.
`balanceService.js` has its own. Every other repo (`usersRepository`,
`customersRepository`, `departmentsRepository`, `productTypesRepository`,
`settingsRepository`, `marketersRepository`, `chartOfAccountsRepository`,
`contactsRepository`, etc.) does a full sheet read on every call.

### Target state

1. Add `src/repositories/_cachedReader.js` exporting a factory:
   `createCachedReader({ sheet, range, parse, ttlMs })` returns
   `{ getAll, invalidate }`.
2. Convert the following repos to use it (TTL 30 s for slowly-changing
   data, 5 s for hot tables):
   - `usersRepository` (30 s)
   - `customersRepository` (15 s)
   - `departmentsRepository` (60 s)
   - `productTypesRepository` (60 s)
   - `settingsRepository` (30 s)
   - `chartOfAccountsRepository` (60 s)
   - `marketersRepository` (15 s)
   - `contactsRepository` (30 s)
3. Every write helper in those repos must call `invalidate()` after
   the write succeeds.
4. `inventoryRepository` keeps its own bespoke cache (it already
   matches the pattern); optionally refactor it to use the factory.

### Files

- `src/repositories/_cachedReader.js` (new)
- All repos listed above.

### Acceptance criteria

1. After the change, with 100 messages-per-minute simulated load,
   sheets API calls drop by an order of magnitude (measure via
   `console.count`).
2. No staleness regression on any flow that mutates → reads-back
   immediately (e.g. add customer → next message picks them up).

### Risk / rollback

- Risk: a repo that mutates and forgets to invalidate would serve
  stale reads. Mitigate with an explicit `invalidate()` test list in
  the PR description.
- Rollback: change `ttlMs` to `0` in `_cachedReader` to disable.

---

## TG-12 — Replace `console.log` with structured logger

- **Severity:** Medium.
- **Status:** Open.

### Current state

`src/utils/logger.js` is a `console.log` wrapper. Production logs are
unstructured and hard to grep with severity filters.

### Target state

1. Adopt `pino` (small, fast, JSON output).
2. Keep the existing `logger.info / warn / error / debug` shape so no
   call site needs to change.
3. Add a `logger.child({ requestId })` helper used by the new webhook
   request-ID flow from **TG-5**.
4. In dev mode (`NODE_ENV !== 'production'`), pipe through `pino-pretty`.

### Files

- `telegram-ops-bot/package.json` (add `pino`, dev-only `pino-pretty`)
- `telegram-ops-bot/src/utils/logger.js`

### Acceptance criteria

1. Production log lines are valid single-line JSON with
   `level`, `time`, `msg`, optional `requestId`.
2. Dev output is human-readable.
3. Existing call sites compile without changes.

### Risk / rollback

- Low. Drop-in.

---

## TG-13 — Replace 4 reminder loops in `server.js` with a generic scheduler

- **Severity:** Medium.
- **Status:** Open.

### Current state

`server.js` has four near-identical functions
(`checkOrderReminders`, `checkSampleFollowups`,
`checkCustomerFollowups`, `checkColdCustomerAlerts`) all run inside one
`setInterval(..., 60 * 60 * 1000)`. Each fetches pending rows,
iterates, sends, marks done, logs.

### Target state

1. New `src/scheduler/index.js` exposes:
   ```js
   register({ name, intervalMs, runOnStart, fn })
   start(bot)
   ```
2. Each reminder becomes its own file under `src/scheduler/jobs/`:
   - `orderReminders.js`
   - `sampleFollowups.js`
   - `customerFollowups.js`
   - `coldCustomerAlerts.js`
3. `server.js` calls `scheduler.start(bot)` and is no longer the
   owner of `setInterval`.
4. Each job catches its own errors and logs with job name.
5. Add a process-wide `lastColdAlertDay`-style state lifted into
   `src/scheduler/state.js` so the same single-instance assumption is
   visible (and ready to swap to Redis in TG-22).

### Files

- `telegram-ops-bot/server.js`
- `telegram-ops-bot/src/scheduler/index.js` (new)
- `telegram-ops-bot/src/scheduler/jobs/*.js` (new)
- `telegram-ops-bot/src/scheduler/state.js` (new)

### Acceptance criteria

1. Boot logs show one line per job registered.
2. A simulated `markReminderSent` integration test (or manual run)
   shows each job firing exactly once at boot when `runOnStart=true`.
3. `server.js` LOC drops by roughly 100 lines.

### Risk / rollback

- Low. Mechanical refactor.

---

## TG-14 — Make `src/utils/sessionStore.js` the only source of truth for in-flow state

- **Severity:** Medium.
- **Status:** Open. Pairs with **TG-9**.

### Current state

In addition to `sessionStore`, there are two ad-hoc Maps in
`approvalEvents.js`:

- `pendingEnrichment` — admin entering price/payment for a sale.
- `pendingReason` — dispatch entering free-text rejection reason.

These are functionally session state but bypass the orphan-hint and
TTL hygiene of `sessionStore`.

### Target state

1. Add typed flow types in `sessionStore`:
   `'admin_enrich_sale'`, `'dispatch_reject_reason'`.
2. Replace `pendingEnrichment.set/get/delete` with
   `sessionStore.set/get/clear` keyed by admin ID.
3. Replace `pendingReason.set/get/delete` similarly, keyed by user ID.
4. Use a 30-minute TTL for both (long enough for someone to step away).

### Files

- `src/utils/sessionStore.js` (no API change needed)
- `src/events/approvalEvents.js` (or whichever split file owns these in TG-9)

### Acceptance criteria

1. The two `new Map()` declarations are gone.
2. Admin enrichment and dispatch rejection still work end-to-end.
3. After the TTL elapses, the orphan-hint is shown if the user replies
   late.

### Risk / rollback

- Low. Same shape, different store.

---

## TG-15 — Extract a true repository-base module (optional polish)

- **Severity:** Low / Medium.
- **Status:** Open.

### Current state

Every repo file repeats: header check, parse row helper, `getAll`
with optional cache, `findBy*` thin filter on top of `getAll`, and
write helper that re-reads via `findRowIndex`.

### Target state

A small `src/repositories/_baseRepository.js` exposing a factory:

```js
makeRepository({
  sheet,
  headers,
  parse,         // (row, rowIndex) => obj
  serialize,     // (obj) => row
  cache: { ttlMs },
})
```

returning `{ getAll, findOne(predicate), append, update(rowIndex, patch), invalidate, ensureHeader }`.

Migrate **simple** repos first (`contactsRepository`,
`departmentsRepository`, `chartOfAccountsRepository`,
`marketersRepository`). Leave repos with bespoke logic
(`inventoryRepository`, `designAssetsRepository`) alone for now.

### Files

- `src/repositories/_baseRepository.js` (new)
- 4–6 simple repos under `src/repositories/`.

### Acceptance criteria

1. Migrated repos have ~30–40% fewer lines.
2. No behavioural change.

### Risk / rollback

- Low. Easy to revert per-repo.

---

# Phase 3 — Performance

---

## TG-16 — Cache OpenAI intent parses for repeated phrases

- **Severity:** Medium.
- **Status:** Open.

### Current state

Every unparsed text message that doesn't match a callback hits OpenAI
through `intentParser.parse`. Common phrases like
`"my orders"`, `"sample status"`, `"top customers"` are paid-for every
time.

### Target state

1. `src/ai/intentParser.js` keeps an LRU cache (size 500) keyed by
   the lowercased + whitespace-collapsed message text.
2. Cache TTL 1 hour (config knob `INTENT_CACHE_TTL_MS`).
3. Skip the cache when the message text contains digits (so "Sell
   than 5 from 5801 to X" never collides) — only cache messages where
   `/^[a-z\s'-]+$/` matches.
4. Add a `--clear-intent-cache` startup flag for emergencies.

### Files

- `src/ai/intentParser.js`

### Acceptance criteria

1. `top customers` typed twice in 5 seconds hits OpenAI once.
2. `Sell than 5 from 5801 to X` and `Sell than 6 from 5801 to X` both
   hit OpenAI.

### Risk / rollback

- Risk: a wording variant for the same intent isn't cached — fine.
- Rollback: set TTL to 0.

---

## TG-17 — Tighten Sheets API usage in hot paths

- **Severity:** Medium.
- **Status:** Open. Depends on TG-11.

### Current state

`approvalQueueRepository.getByRequestId` (`src/repositories/approvalQueueRepository.js`) reads `A2:G` of the entire sheet for one row. Same for `updateActionJSON`, `updateStatus`. Hot path during approval flows.

### Target state

1. Add an in-memory secondary index `requestId → rowIndex` warmed at
   first read (and refreshed after every `append`).
2. Add `findRowIndexByRequestId(requestId)` that uses the index.
3. `updateStatus` and `updateActionJSON` use the index for the
   read-then-write step.

### Files

- `src/repositories/approvalQueueRepository.js`

### Acceptance criteria

1. Profiled approval action does 1 sheet write instead of 1 read + 1 write.
2. Approve/reject still works for stale request IDs (fallback to full
   scan if index miss).

### Risk / rollback

- Low. Index is rebuildable from a `getAllPending`.

---

## TG-18 — Reuse a single Drive file upload pipeline

- **Severity:** Low.
- **Status:** Open.

### Current state

`driveClient.js` is shared, but `designAssetsService.js` and
`telegramFiles.js` each have their own download → upload chain. With
`sharp` involved (image overlays), there is unnecessary disk I/O.

### Target state

1. `src/utils/imagePipeline.js` exposes `processAndUpload({ telegramFileId, overlay, folder })` that:
   - downloads to a Buffer,
   - applies optional `sharp` overlay,
   - streams straight to Drive (no temp file).
2. `designAssetsService.js` and any caller in `telegramController.js` (catalog photos) use it.

### Files

- `src/utils/imagePipeline.js` (new)
- `src/services/designAssetsService.js`
- `src/utils/imageOverlay.js` (might collapse into the new file)

### Acceptance criteria

1. Catalog photo upload still produces the same overlay output.
2. No temp files left on disk after processing.

### Risk / rollback

- Medium. Image quality regressions are user-visible; eyeball test
  with a known design.

---

## TG-19 — Add a `npm run smoke` end-to-end script

- **Severity:** Medium.
- **Status:** Open.

### Current state

`TESTING.md` exists with manual checklists. No automation.

### Target state

A Node script `telegram-ops-bot/scripts/smoke.js` that:

1. Starts the bot pointing at a test sheet (env override).
2. Calls `intentParser.parse` for ~30 representative phrases and
   asserts the action returned.
3. Exercises `riskEvaluate.evaluate` for every action key.
4. Calls `inventoryRepository.getAll` once, asserts it returns an
   array.
5. Exits non-zero on any assertion failure.

It does **not** need a real Telegram or live sheet — mock them.

### Files

- `telegram-ops-bot/scripts/smoke.js` (new)
- `telegram-ops-bot/package.json` (`"smoke": "node scripts/smoke.js"`)

### Acceptance criteria

1. `npm run smoke` exits 0 on a clean checkout.
2. Breaking `risk/evaluate.js` makes it exit non-zero.

### Risk / rollback

- None.

---

## TG-20 — Document and bound the `sharp` cold start

- **Severity:** Low.
- **Status:** Open.

### Current state

`package.json` ships `sharp@^0.34.5`. On serverless platforms (Cloud
Run, Lambda) the native binary inflates cold-start. On a long-lived VM
(the bot's likely deployment) this is fine, but it's undocumented.

### Target state

Add a section to `SETUP.md`:

> **Native dependencies:** `sharp` ships platform-specific binaries.
> Use `npm install --include=optional` on the deployment host. If you
> deploy via Docker, build on the same architecture as the runtime
> (Linux x64 for Railway/Render).

### Files

- `telegram-ops-bot/SETUP.md`

### Acceptance criteria

- Reviewer reads the new section and nods.

### Risk / rollback

- None.

---

## TG-21 — Remove `bot` polling option entirely

- **Severity:** Low.
- **Status:** Open.

### Current state

`server.js` line 20 instantiates with `{ polling: false }`. If
someone later flips this, the bot would do *both* polling and
webhook, double-processing. Webhook is the only mode we use.

### Target state

1. Remove `polling: false` and rely on the default
   (`node-telegram-bot-api` does not poll unless told to).
2. Add a comment: `// Webhook-only. Do not enable polling.`

### Files

- `telegram-ops-bot/server.js`

### Acceptance criteria

- Bot boots, receives a webhook, processes a message.

### Risk / rollback

- None.

---

# Phase 4 — Scalability / future (discuss before starting)

These tasks change the bot's deployment shape. Bring back to the user
before starting any of them.

---

## TG-22 — Move `sessionStore`, `idempotency` (if kept), and approval state behind a `Store` interface backed by Redis

- **Severity:** High when we go multi-instance.
- **Status:** Discuss first.

### Why

Today the bot cannot be horizontally scaled. Every Map-backed piece
of state (`sessions`, `lastSessions`, `pendingEnrichment`,
`pendingReason`, scheduler `state`) lives in process memory and is
lost on restart.

### What

1. Add `src/stores/index.js` with a `Store` interface
   (`get`, `set`, `del`, `incr`, `expire`, `setNx`).
2. Provide two impls: `memoryStore.js` (default) and `redisStore.js`
   (`ioredis`).
3. Migrate `sessionStore`, scheduler state, and approval Maps to use
   the interface.
4. Pick impl via `STORE=redis` env var.

### Files

Many. Plan a separate dedicated PR.

---

## TG-23 — Migrate the bot's primary-key data from Sheets to Firestore

- **Severity:** Strategic.
- **Status:** Discuss first.

### Why

Sheets-as-DB hits API quota ceilings around the low thousands of rows
and chronic write volume. Firestore is already in the project (the
web app uses it) and has indexes, transactions, and unlimited reads.

### What

Phase A: dual-write Users, Customers, Departments, Settings,
ProductTypes from the bot to Firestore. Reads still come from Sheets.

Phase B: switch reads to Firestore. Sheets becomes an export/sync
target.

This is multi-week. Bring back when we're ready.

---

## TG-24 — Move webhook processing onto a queue (Cloud Tasks or BullMQ)

- **Severity:** Medium.
- **Status:** Discuss first.

### Why

Today errors disappear silently (TG-5 partly addresses this). Slow
controllers (multi-step OpenAI calls) can exceed Telegram's
preferred response time. A queue gives retries with backoff and DLQ.

### What

1. Webhook handler enqueues `{requestId, type, payload}` and returns 200.
2. A worker pulls the queue and executes controllers.

---

## TG-25 — Containerize and add CI

- **Severity:** Medium.
- **Status:** Discuss first.

### Why

Reproducible deploys, predictable `sharp` builds.

### What

`Dockerfile`, `.dockerignore`, GitHub Actions workflow that runs
`npm test`, `npm run smoke`, lint.

---

## TG-26 — Linting and formatting

- **Severity:** Low.
- **Status:** Discuss first.

### What

Adopt ESLint + Prettier with a config that matches the existing
2-space, single-quote, trailing-comma style. Wire into `npm run lint`.
Do **not** mass-format existing files in the same PR — format on
touch only.

---

# Validation & deployment gates

For every Phase 1 / Phase 2 task:

1. `npm test` (the new check from TG-7) must pass.
2. `npm run smoke` (the new harness from TG-19) must pass once it lands.
3. Manual smoke of the matching `TESTING.md` section.
4. Deploy to staging environment first; observe for one business day
   before promoting.
5. Watch `WebhookErrors` sheet (TG-5) for new entries during the
   observation window.

# Definition of "Done" for the whole plan

- Phase 1 fully implemented and live.
- Phase 2 fully implemented and live.
- Phase 3 implemented; performance baseline measured before/after.
- Phase 4 — explicit user decision per task.
- This document updated to reflect the final state, with each task
  marked `Status: Done` and a one-line link to the PR that landed it.

---

*This plan was authored by an architectural review pass on the repository
at branch `cursor/telegram-bot-improvement-plan-fdb6`. It is intended
to be edited by future passes as scope evolves. Treat it as a living
document.*
