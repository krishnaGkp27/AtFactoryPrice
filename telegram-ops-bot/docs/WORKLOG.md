# Worklog — running session summaries

Newest first. One entry per working session; each entry lists what shipped
(commits on `main`), decisions taken, and what was left pending with owners.

---

## 2026-07-08 (late) — PG-1 Postgres inventory mirror (Sheets still read path)

Owner said **go PG-1**. Shipped mirror-only — no read-path change yet (PG-2).

- **`pg` client** + `src/db/postgresPool.js` (lazy pool; no-op when `DATABASE_URL` unset).
- **Schema** `inventory_rows` (one row per sheet row / than, PK = `sheet_row_index`) +
  `mirror_meta` in `src/db/inventorySchema.js`.
- **`inventoryMirrorService`**: boot + 5-min sync when `INVENTORY_MIRROR_ENABLED=1`;
  full upsert + stale-row prune; parity (row count, available bales, designs,
  available-thans per warehouse).
- **Scripts:** `npm run pg:sync` / `pg:parity` → `scripts/pg-inventory-sync.js`.
- **Railway setup:** `specs/PG-1_RAILWAY_SETUP.md` (add Postgres plugin, reference
  `DATABASE_URL`, set `INVENTORY_MIRROR_ENABLED=1`).
- Smoke S45 + smoke S30 fix (reset `capabilities` cache in pricing gate test).
- Tests: 414 pass · smoke 550 ok · 0 lint errors.
- **Owner step:** provision Postgres on Railway (MCP blocked auto-create); wire vars
  per spec; confirm boot log `inventoryMirror: synced N rows, parity=OK`.

---

## 2026-07-08 (night) — future-ready chunk 1: CAP-1 + H6 + P3-lite

Owner greenlit the architecture roadmap (capability layer → integrity fixes →
Postgres as source of truth → controller split). Three chunks shipped, one
commit each:

- **CAP-1 (`feat(access)`)** — `src/access/capabilities.js`: single role →
  capability table (`can(user, CAP.SEE_SALE_PRICE)`), admin wildcard via
  auth.isAdmin, unknown roles fall back to employee grants.
  `pricingService.canSeeSalePrice/canSeeBasePrice` and
  `fieldRoles.canSeePrice` now delegate (behavior-identical, tested). Rule
  going forward: NEW gates use `can()`; the ~85 inline admin checks migrate
  opportunistically when their file is touched.
- **H6 (`fix(integrity)`)** — money-path ERP hook failures no longer vanish:
  `erpEventBus.emitAsync` now PROPAGATES handler errors (bus.emit stays
  fire-and-forget), `executeApprovedAction` collects them as `erpFailures`
  (+ `erp_hook_failed` AuditLog rows), and approvalEvents shows the admin a
  loud "🛑 BOOKS NOT UPDATED" tail instead of a clean ✅ when stock moved but
  the ledger write failed.
- **P3-lite (`fix(safety)`)** — `src/utils/rateLimiter.js` sliding-window
  limiter; intentParser degrades to the regex fallback beyond 20 OpenAI
  parses/user/minute (no billing on spam). `telegramFiles.downloadTelegramFile`
  caps downloads at 20 MB (Telegram's own getFile ceiling).
- Tests: 411 pass (13 new) · lint 0 errors.
- **Next (PG-1, needs owner go):** provision Railway Postgres, mirror
  Inventory, parity-check, then flip hot reads. P3 leftovers: ocr retention
  sweep, JSON body limit. P4–P6 open.

---

## 2026-07-08 (evening) — SRF-CAT: category step inside Supply Request

- **New step between container and warehouse** (owner spec, confirmed twice:
  container FIRST, then categories): after picking a container the user gets
  tappable category chips — only categories with AVAILABLE stock in that
  container within the user's warehouse scope, with container-scoped bale
  counts (`🧣 Cashmere (58 bls)`). Source = Inventory column W via
  `designCategoriesRepository` (no new storage).
- **Others** chip (last) groups designs with no category yet, so no stock is
  unreachable; sentinel `__others__` in `srf_cg:` callback data.
- **Auto-skip:** a single-category container skips the screen (category still
  stamped on the session, so headers show it) — flow feels unchanged when
  there is no real choice.
- **Downstream filter:** `getSupplyWarehouses` + `getAdjustedAvailability`
  take a `category` arg; warehouse picker, design list, shade list and
  Select-All all respect it. Headers show `Container · Category`.
- **Back nav:** category screen → containers; warehouse/design screens →
  categories when the step was shown (else containers, as before).
  `srf_back:category` clears the pick; picking a new container clears it too.
- Scope: Supply Request only (Bundle Sale untouched, per plan).
- Tests: `test/characterization/supplyFlow.categoryStep.test.js` (6 cases:
  chips + counts + order, downstream filtering, Others, auto-skip,
  multi-warehouse filter, back nav). Full suite 398 pass · smoke 546 ok ·
  0 lint errors.
- **Pending owner test:** container → category chips → warehouse → designs on
  production data (small).

---

## 2026-07-08 (later) — DCAT-1 design categories + MKT-2 marketer allocations

### DCAT-1 — product categories on top of design numbers (everyone sees them)

- **Storage (owner decision): NO new sheet** — new `design_category` column
  appended at the END of Inventory (column W, after `arrival_batch`). The
  dual-admin flow stamps every row of the design; readers take the first
  non-empty cell per design so later-received unstamped bales still inherit
  the label on screens.
- **Assignment flow (shortest, 4 taps):** Designs hub → 🏷️ Set Design
  Category (admin-only) → design chip → category chip (Cashmere / Chinos /
  Gaberdine / Senator / TR + any label already in use) → Submit →
  `set_design_category` ∈ `ALWAYS_APPROVAL_ACTIONS` → 2nd admin approves
  (self-approval already blocked) → Inventory stamped, labels live at once.
- **Display rollout:** supply/transfer carts, supply approval summaries
  (`approvalEvents` — 3 one-line bracket fixes), transfer cards + wizard
  chips (`transferFlow`), Check Stock header + design-picker chips, bale
  detail, sold-bales lines. `getMaterialInfo()` is no longer hardcoded
  (was: everything → "Senator", 44200 → "Cashmere"); unmapped designs render
  as the bare number, no more fake labels.

### MKT-2 — marketer My Products v2 (exclusive to role=marketer)

- **First screen = tappable category chips** (🧣 Cashmere, 🧵 Senator, …)
  built ONLY from designs an admin allocated to that marketer; tap → designs
  with allocated bale qty + live "available now" reference. No price.
  Uncategorized designs group under "Others". No allocations → "ask your
  admin" empty state. Salesman/employee paths unchanged.
- **Admin control:** Marketers hub → 🧑‍💼 Allocate to Marketer (admin-only):
  marketer → design (category-labelled chips) → qty chips (0 = remove) →
  Save. Direct write (no approval queue — owner wants fast test cycles),
  audit-logged, marketer gets a DM on every change.
- **Storage:** ONE new sheet `MarketerAllocations` (marketer_id ×  design →
  allocated_qty) — a many-to-many fact that can't ride Inventory or Users;
  owner's "minimize sheets" rule honoured everywhere else.

Tests: 396 pass (11 new characterization: dual-admin category path,
allocation flow, marketer catalog, salesman-unchanged; fieldRoles pin
updated to the allocation-scoped view). Smoke 546/546 (S43 + S44 added).
Lint: 0 errors. fakeSheets updateRange now honours the start CELL (column
offsets like `W3` no longer clobber whole rows).

**Owner testing path:** onboard a Telegram ID with role=marketer → 🧑‍💼
Allocate to Marketer (e.g. 44200 ×10) → their 📦 My Products shows the
category chip → tap → allocated qty. Categories: 🏷️ Set Design Category +
2nd-admin approve; label then shows bot-wide.

---

## 2026-07-08 — TRF-6: mandatory transfer photos + card UX (live-test feedback)

First live run (TR-20260708-001, 12 bales Lagos → Kano office, cart path)
completed end-to-end but surfaced 3 owner complaints. All fixed as TRF-6:

1. **Photo/PDF is now a MANDATORY GATE** on both dispatch and receive.
   Tapping 🚚 Dispatch (after bale review) or ✅ Received arms the gate;
   **nothing moves and nobody is notified until the file arrives** (then:
   apply → attach → notify → forward). No Skip button anywhere; legacy Skip
   buttons alert "photos are now required". Receiver gate has ↩ Not now;
   dispatcher gate has ◀ Back to bales. Drive archiving stays best-effort —
   the Telegram file itself is always forwarded.
2. **Grouped line cards** — all transfer cards (dispatcher/receiver DMs, sent
   receipt, detail expansion, decline/reject) now render 🧵 design headers
   with ` • Shade N ×qty` rows instead of the unreadable "+"-joined one-liner.
   Admin short cards stay one-liners.
3. **Photo prompt is always the LAST message** — sent fresh at the bottom of
   the chat (tapped card gets sealed), so there's no Attach/Skip toggling and
   no drift up the history.
4. Stale-card guard: acc/rcv taps on cards that no longer match the live
   stage answer "Transfer is <state> — nothing to do here".
5. Bale picker no-show explained: picker only opens when a line has MORE
   candidates than requested; exact-match stock auto-fills FIFO — the review
   screen now says "auto-filled … nothing to choose".

Tests: 381 pass (23 transfer-specific, gate semantics re-pinned), smoke
530/530, lint 0 errors. `specs/TRF-5_TEST_STEPS.md` updated for the re-run
(cast: Neha dispatches Leg 1, Tessa receives; reversed on Leg 2).

**Note:** TR-20260708-001 moved 12×80045 bales to Kano office for real — the
re-test Leg 2 (reverse transfer) brings them home.

---

## 2026-07-07 — TRF-5 transfer queue · single transfer flow · daily backups (BKP-1)

### Shipped (all on `main`, auto-deployed via Railway)

| Commit | What |
|---|---|
| `28d9121f` | **feat TRF-5** — transfers now surface at the top of the assignee's 📋 My Tasks ("🚚 Transfers waiting on you") with a session-free one-tap action-card re-send (`trf:card:<id>`); legacy instant transfers retired: Transfer Package / Transfer Than tiles hidden, typed transfer commands redirect into Transfer Stock. |
| `fb457bc9` | **docs** — TRF-5 manual live-test checklist (`specs/TRF-5_TEST_STEPS.md`). |
| `23244735` | **feat BKP-1** — bot-side daily sheet snapshot scheduler (Settings-tunable: `SHEET_BACKUP_ENABLED` / `SHEET_BACKUP_HOUR_UTC` / `SHEET_BACKUP_RETENTION_DAYS`), admin DM on failure; plus `no-cond-assign` lint fixes in `transferFlow`. |
| `c3d045cb` | **fix BKP-1** — service accounts get no personal Drive storage, so bot-side copies fail ("storage quota exceeded"). Shipped the reliable path: `scripts/apps-script-daily-backup.gs` (runs as the sheet owner) + `scripts/drive-quota.js` diagnostic. |
| `e1213408` | **docs** — `specs/BKP-1_EMIN_CHECKLIST.md` + two-track pending-tasks table in `CLAUDE.md`. |

### Decisions locked

- **Transfer Stock is the ONLY transfer path.** The approval executor now refuses stale
  legacy `transfer_package` / `transfer_than` / `transfer_batch` rows outright.
- **Backups run as a real Google account** (Apps Script), not the service account.
  The bot-side scheduler stays in the code, disabled via Settings, in case the org
  later moves to Workspace + Shared Drives.
- Kano receiver onboarding (e.g. Muhammad `8616305685`) = one Users-sheet row:
  `F=active`, `I=Kano office`, `C=employee`. Picker appears automatically at 2+ users.

### Pending (owners assigned — see CLAUDE.md pending table)

- **Emin**: `specs/BKP-1_EMIN_CHECKLIST.md` — install Apps Script backup, add
  `SHEET_BACKUP_ENABLED=0` Settings row, run `scripts/drive-quota.js`, audit photo links.
- **Owner**: `specs/TRF-5_TEST_STEPS.md` — manual end-to-end transfer test (3 Telegram IDs).
- **Agent follow-up** (blocked on Emin's Task 4): if Drive photo archiving is confirmed
  broken, build OAuth-as-user uploads for `driveBackup`.
- **Data cleanup**: reject any still-pending legacy `transfer_*` rows in ApprovalQueue.

### Follow-up same session — full codebase audit + P1 security fixes

- **Audit**: `docs/CODE_AUDIT_2026-07-07.md` — 6 CRITICAL / 12 HIGH / ~15 MED / ~8 LOW
  across security, races, and performance, plus a 7-phase fix plan. Pushed.
- **P1 (critical security) implemented, committed locally, NOT pushed** pending
  owner review + env prerequisites: C1 webhook fail-closed in prod, C2 global
  callback auth gate, C3 sale-confirm IDOR fix, H1 admin self-approval block,
  H5 settings-API key-only auth + CORS allow-list. See the audit doc's "P1 —
  IMPLEMENTED" section for the deploy-order prerequisites (set
  `TELEGRAM_WEBHOOK_SECRET` + re-run `set-webhook` FIRST, or prod won't boot).

### Follow-up same session — P2 (money & inventory integrity)

- **P2 implemented, committed locally, NOT pushed**: C4 approval
  double-execution guard (per-request `asyncMutex` + in-lock pending re-check on
  `executeApprovedAction`/`rejectApproval`), C5 `markThanSold` available-guard,
  H3 transfer dispatch/receive/abort serialization, H7 office-expense +
  landed-cost now mark the queue row approved. All in non-protected files.
  Deferred: H6 (ERP-failure surfacing — needs an `approvalEvents` tweak).

### Pushed to `main` (C1 made deploy-safe)

- Made C1 webhook enforcement **opt-in** via `REQUIRE_WEBHOOK_SECRET` (default
  off) so P1+P2 could ship without a Railway secret dependency. Pushed P1, P2,
  and the C1-opt-in commit to `main` (auto-deploy).
- Owner pickup task: activate webhook enforcement +
  optional `BOT_API_KEY` — steps in `specs/SEC-P1-P2_PICKUP.md`.
- Not done (fresh session): H6 (ERP-failure surfacing), P3–P7. See audit doc.

### Test status at close

`npm test` 379 pass · `npm run smoke` 530/530 · `npm run lint` 0 errors (378 pre-existing warnings).
