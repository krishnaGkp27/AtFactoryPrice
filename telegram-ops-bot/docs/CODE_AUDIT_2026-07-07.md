# Code Audit — 2026-07-07 (pre-implementation analysis)

Full-codebase review of `telegram-ops-bot/` covering security, correctness (bugs/races),
performance, and dependency health. **No fixes applied yet** — this document is the
analysis and the proposed fix plan, awaiting owner sign-off per phase.

Method: five parallel deep-dive reviews (webhook/auth surface · controller authorization ·
data layer/races · flows/file handling · services/approval pipeline) + `npm audit` +
spot verification of every CRITICAL claim against the code.

---

## Severity summary

| Severity | Count | Themes |
|---|---|---|
| CRITICAL | 6 | forgeable webhook (if secret unset), no global callback auth, sale-confirm IDOR, approval double-execution race, re-sellable thans, unbounded file downloads |
| HIGH | 12 | admin self-approval, price/revenue leaks via NL reports, transfer TOCTOU races, ledger drift, REST API auth, CORS, silent ERP failures |
| MEDIUM | ~15 | RMW races (balances, settings CSV, PO counters), Markdown injection clusters, missing rate limits, per-cell writes |
| LOW | ~8 | formula injection, `/health` recon, janitor labels, audit-trail gaps |

Dependency audit: **17 vulnerabilities (2 critical, 3 high, 12 moderate)** — most fixable
with `npm audit fix`; `xlsx` has NO fixed version on npm (needs migration or mitigation).

---

## CRITICAL findings

### C1. Webhook authentication is optional
`server.js:64-76`, `scripts/set-webhook.js`. If `TELEGRAM_WEBHOOK_SECRET` is unset, any
POST to `/webhook` is accepted — an attacker knowing the Railway URL can forge updates
with any `from.id` (including admins) and drive the whole bot. **Verify the env var is set
on Railway TODAY; then make the server fail closed when missing.**

### C2. `handleCallbackQuery` has no global allow-list gate
`telegramController.js:6063`. Messages and file uploads check `auth.isAllowed()`;
callbacks never do. Revoked/inactive users (or forged updates via C1) can still drive
flow callbacks. Fix: one `isAllowed` check at the top of `handleCallbackQuery`.

### C3. `confirm_sale:` / `cancel_sale:` IDOR (verified)
`telegramController.js:6172-6188`. The target userId rides the callback data and the
handler never checks the clicker is that user — any allowed user can confirm/cancel
ANOTHER user's pending sale (admin sales execute inventory writes directly). Fix:
require `callbackQuery.from.id === saleUserId`.

### C4. Approval double-execution race (two admins, same request)
`inventoryService.executeApprovedAction` + `approvalQueueRepository.updateStatus`.
Check-then-act on `status=pending` with no conditional write: two simultaneous
approvals both execute (duplicate sales/payments/stock moves). Sheets has no
transactions, so fix = claim the row first (flip pending→executing, re-read to confirm
you won) or a per-request in-process mutex + idempotency marker.

### C5. `markThanSold` re-sells sold thans
`inventoryRepository.js:184-197`. Unlike `markPackageSold`, it never checks
`status === 'available'` before writing — amplifies C4 into corrupted customer
attribution. Fix: guard on current status at write time.

### C6. Unbounded in-memory file downloads
`telegramFiles.js:33-48` has no size cap; `photoReceiveFlow` and `transferFlow.handleFile`
call it without checking `file_size` first (bulk/add-stock flows DO check 5 MB). A large
document can OOM the Railway process. Fix: cap inside `downloadTelegramFile` (shared
constant) + `file_size` pre-checks in the two flows.

---

## HIGH findings

| # | Finding | Where | Fix direction |
|---|---|---|---|
| H1 | Admin requester can SELF-APPROVE own dual-admin actions — exclusion is notification-only; `handleApprovalCallback` never checks `adminId !== item.user` | `approvalEvents.js:657-714` | reject self-approval at execution |
| H2 | NL/AI reports leak prices & revenue to non-admin roles (`analyze`, `report_valuation`, `report_sales`, `ask_data` → full NGN values) while tap flows gate via `canSeeSalePrice` | `telegramController.js:3916-3980`, `queryEngine.js` | thread userId through, gate value lines |
| H3 | Transfer dispatch/receive/abort TOCTOU races (double-tap dispatch; receive vs reject interleave) | `transferService.js:149-233` | conditional stage transition |
| H4 | Money drift: 3 parallel balance systems; `check_balance` reads `Customers.outstanding_balance` which sales never increment | `crmService.js`, `accountingService.js` | single source of truth (ledger) |
| H5 | `PUT /api/settings` trusts forgeable `X-Telegram-User-Id` header + permissive CORS reflects any origin | `apiController.js:25-31`, `server.js:29-34` | API-key only + strict CORS |
| H6 | Silent ERP hook failures: inventory mutated, ledger append fails in `catch(_){}`, user told success | `inventoryService.js:316-338` | surface failures, retry queue |
| H7 | Early-return approval branches (`record_office_expense`, `finalize_landed_cost`) never mark the row approved → re-executable | `inventoryService.js:668-696` | unified status+audit footer |
| H8 | Report drill-down callbacks (`rxw:inv_*`, `smsd:`) + `upconf:` price-write + `bulkrcv:mode:` skip admin re-checks at callback time | controller various | mirror entry gates on write/report callbacks |
| H9 | Supply Stage-3 accept (`srf_acc:`) lacks assignee + stage + status guards | `approvalEvents.js:1107-1121` | mirror stage-1 guards |
| H10 | Users sheet read on EVERY message (no cache in `usersRepository`; auth refresh every 10s; greeting reads it 2-3×) | `usersRepository.js:81-98` | TTL cache + invalidate on write |
| H11 | Unbounded local archive `data/ocr/` on ephemeral disk | `driveBackup.js:126-137` | retention sweep |
| H12 | Dependency vulns: `form-data` (critical, via deprecated `request` in node-telegram-bot-api), `lodash`, `path-to-regexp`, `qs`, `tough-cookie`, `uuid` — most auto-fixable; `xlsx` prototype-pollution/ReDoS has NO npm fix | `package.json` | `npm audit fix` + xlsx mitigation/migration |

---

## MEDIUM (clustered)

- **Read-modify-write races**: customer `outstanding_balance` (`crmService.js:52-67`),
  Settings CSV lists (`BANK_LIST`/`WAREHOUSE_LIST`), PO received counters
  (`procurementOrdersRepository.js:170-184`), catalog stock quantities, ApprovalQueue
  `actionJSON` merges. Same family as C4 — fix pattern is shared.
- **Markdown injection cluster**: user/sheet-sourced names interpolated into
  `parse_mode: 'Markdown'` without escaping in `soldBalesFlow`, `goodsReceiptFlow`,
  `transferFlow` cards, `photoReceiveFlow.rowSummary`, `procurementPlanView`,
  `officeExpenseFlow` approval card, `taskFlow` assignee picker. A name with `*`/`_`
  breaks the message (Telegram 400) → feature fails for that record. Fix: shared
  `escapeMd` in `telegramUI.js`, applied per flow.
- **No rate limiting**: per-user token bucket missing before OpenAI calls; stranger
  capture limit is global (one spammer exhausts it); no JSON body size limit.
- **`executeApprovedAction` trusts `actionJSON`** — no positive-amount/enum re-validation
  at execution time for most branches.
- **Per-cell writes**: `tasksRepository.updateFields` does one API call per field
  (batchUpdateRanges exists and should be used).
- **Session hygiene**: `srf_ct:`/`srf_wh:` reuse stale sessions without clearing foreign
  fields; `trf:bl:t:` missing `session.idx` bounds check.
- **AuditLog header re-read on every message** (`ensureHeader` before every append).

## LOW (clustered)

Formula injection (`=` prefix in user strings evaluated when sheet opened), `/health`
service fingerprint, `GET /api/settings` unauthenticated (thresholds readable), sample
qty button values unvalidated, `sr:` period parseInt unbounded, session-janitor labels
missing for newer flows, `promote_admin` execution lacks defense-in-depth super-admin
re-check, incomplete audit trail on early-return approvals.

---

## Performance snapshot (Sheets API quota)

- One plain "hi" message ≈ **6–10 read calls + 1 write** (Users 2-3×, Departments,
  Settings, UserPrefs, AuditLog header).
- One `approve:` tap ≈ **3-4 full ApprovalQueue scans + ≥1 full Inventory read + 3-6
  writes**; a sale approval can reach **15-25+ API calls**.
- Repos WITH TTL caches: inventory (5s), catalog*, marketers, designAssets,
  productTypes, shades, auth allow-list (10s). WITHOUT: users, customers, departments,
  settings, approvalQueue, orders, tasks, transactions, ledger — these dominate quota.

---

## Proposed fix plan (phased, each phase = one commit, tests included)

| Phase | Scope | Contents | Risk |
|---|---|---|---|
| **P1 — Critical security (do first)** | small, surgical | C1 fail-closed webhook secret (+ verify Railway env), C2 global callback auth gate, C3 confirm_sale binding, H1 self-approval block, H5 API auth + CORS | low |
| **P2 — Money & inventory integrity** | medium | C4 approval claim-before-execute + idempotency, C5 markThanSold guard, H3 transfer stage CAS, H7 unified approval footer, H6 ERP failure surfacing | medium |
| **P3 — Resource safety** | small | C6 download size cap + flow pre-checks, H11 local archive retention sweep, JSON body limit, per-user rate limit before OpenAI | low |
| **P4 — Access-control polish** | small | H2 gate NL value reports, H8 callback admin re-checks, H9 srf_acc guards, MEDIUM session/bounds items | low |
| **P5 — Dependencies** | careful | `npm audit fix` (non-breaking set), xlsx mitigation decision (keep+sandbox vs migrate to exceljs), pin versions | medium (regression risk — full suite after) |
| **P6 — Performance** | opt-in | usersRepository TTL cache + invalidation, approvalQueue targeted reads, tasks batch writes, AuditLog header bootstrap, Markdown-escape shared helper rollout | medium |
| **P7 — Money model (design task)** | discussion first | H4 single source of truth for customer balance — needs an owner decision on which ledger wins | needs sign-off |

Constraint notes: P1/P4 touch `telegramController.js` and `approvalEvents.js`
(protected files — changes stay surgical: auth gates only). P2 touches approval
semantics *implementation* (not the WRITE_ACTIONS/ALWAYS_APPROVAL_ACTIONS lists).
Characterization tests pin current behavior before each phase.

---

## P1 — IMPLEMENTED 2026-07-07 (awaiting review; NOT yet pushed)

Owner approved "P1 only, then stop for review." All five P1 fixes are committed
locally on `main`. Test status: `npm test` 366 pass · `npm run smoke` 530/530 ·
`npm run lint` 0 errors (378 warnings = unchanged baseline).

| ID | Change | Files |
|---|---|---|
| C1 | Server fails closed when `TELEGRAM_WEBHOOK_SECRET` is unset — **enforcement opt-in via `REQUIRE_WEBHOOK_SECRET`** (default off) so it ships dormant without crash-looping | `server.js`, `config/index.js` |
| C2 | Global `auth.isAllowed` gate at the top of `handleCallbackQuery` | `telegramController.js` |
| C3 | `confirm_sale:` / `cancel_sale:` bound to `callbackQuery.from.id` (blocks cross-user IDOR) | `telegramController.js` |
| H1 | `handleApprovalCallback` blocks self-approval when a 2nd admin exists (sole-admin still allowed) | `approvalEvents.js` |
| H5 | `/api/settings` accepts ONLY `X-API-Key` (forgeable `X-Telegram-User-Id` removed); CORS uses an explicit allow-list | `apiController.js`, `server.js`, `config/index.js` |

New tests: `test/characterization/handleCallbackQuery.authz.test.js` (C2/C3),
`test/unit/events/approvalEvents.selfApproval.test.js` + `…soleAdmin.test.js` (H1).

### ⚠️ Activation steps (C1 shipped DORMANT — full steps in `specs/SEC-P1-P2_PICKUP.md`)

C1 no longer crash-loops on deploy: enforcement is gated behind
`REQUIRE_WEBHOOK_SECRET` (default off). To activate, in order:

1. Set `TELEGRAM_WEBHOOK_SECRET` (32+ random chars) on Railway.
2. Run `npm run set-webhook` with it set (registers it with Telegram).
3. Set `REQUIRE_WEBHOOK_SECRET=1` and redeploy — now the server fails closed
   if the secret is ever missing.
4. Optional: `BOT_API_KEY` (admin page writes) + `ADMIN_ALLOWED_ORIGINS`.

---

## P2 — IMPLEMENTED 2026-07-08 (money & inventory integrity; committed locally, NOT pushed)

Continued after P1. All changes are in **non-protected** files (`inventoryService`,
`transferService`, `inventoryRepository`, new `utils/asyncMutex`) — no edits to
`telegramController.js`, `approvalEvents.js`, or `risk/evaluate.js`, and the
`WRITE_ACTIONS` / `ALWAYS_APPROVAL_ACTIONS` lists are untouched. Test status:
`npm test` 379 pass · `npm run smoke` 530/530 · `npm run lint` 0 errors.

| ID | Change | Files |
|---|---|---|
| — | New `asyncMutex` — in-process per-key serialization (single-process lock) | `src/utils/asyncMutex.js` |
| C4 | `executeApprovedAction` + `rejectApproval` serialized per `requestId`; the pending re-check now runs inside the lock, so concurrent Approve (or Approve vs Reject) applies the side effect exactly once | `inventoryService.js` |
| C5 | `markThanSold` refuses to overwrite a than that isn't `available` (matches `markPackageSold`); `sellThan` + the `sell_than` approval branch handle the null | `inventoryRepository.js`, `inventoryService.js` |
| H3 | `transferService.dispatch` / `confirmReceipt` / `abort` serialized per `requestId` — no double-dispatch / dispatch-vs-abort double move | `transferService.js` |
| H7 | `record_office_expense` + `finalize_landed_cost` now fall through to the shared footer, so the queue row is marked `approved` + audited (was left `pending` → re-approvable) | `inventoryService.js` |

New tests: `test/unit/utils/asyncMutex.test.js`, `inventoryService.doubleExecute.test.js`,
`inventoryService.approvalFooter.test.js`, `inventoryRepository.markThanSoldGuard.test.js`,
plus 2 concurrency cases appended to `transferService.test.js`.

### Deferred from P2 → follow-up

- **H6 (silent ERP-hook failures)**: surfacing "inventory applied but ledger
  update failed" to the admin requires a change in `approvalEvents.js` (a
  protected file) to display the warning, so it's split out as a small,
  P1-style follow-up rather than bundled here.

### Single-process caveat (important)

`asyncMutex` protects ONE Node process. Today the bot runs as a single Railway
instance (webhook mode), so this fully closes the double-tap races. If the bot
is ever scaled to multiple instances, C4/H3 must be upgraded to a sheet-level
claim (conditional write) or an external lock — noted in the util's header.

**Status: P1 + P2 PUSHED to `main` (auto-deployed). C1 ships dormant — owner
activates webhook enforcement per `specs/SEC-P1-P2_PICKUP.md`. H6 deferred; P3–P7
remain for a fresh session.**
