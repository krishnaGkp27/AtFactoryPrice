# Code size, modularity and efficiency — measured analysis (01-Oct-2026)

Owner's ask: "analyzing the codebase, making it more modular, and reducing the
code length if transformation can bring length reduction or efficiency
maximization … bring me the report", together with "how much, in percentages,
the PDF can be made shorter". Analysis only — nothing was changed. Every
number below was measured on `main` at `6041a51c` with `wc -l` and `grep`.

# Part 1 · The TRF-21 guide PDF — how much shorter it can be

Analysis only; nothing was changed. Measured from the built HTML of
`docs/TRF-21_PARTIAL_RECEIPT_GUIDE.pdf` (commit `6041a51c`).

## What it is today

| Part | Words | Cards | Tests | Pages (approx.) |
|---|---|---|---|---|
| Cover | 514 | 0 | 0 | 1 |
| Method page | 517 | 0 | 0 | 1 |
| A · put the load on the road | 972 | 8 | 4 | 2 |
| B · first delivery (one bale) | 1,187 | 11 | 5 | 3 |
| C · second delivery (the rest) | 587 | 6 | 3 | 1.5 |
| D · reject after a partial delivery | 668 | 5 | 4 | 2 |
| E · guard checks | 493 | 2 | 4 | 1.5 |
| Report + known-and-expected | 501 | 0 | 0 | 1 |
| **Total** | **5,439** | **32** | **20** | **13** |

Only 1,009 of the 5,439 words are the bot's own card text; 4,430 are my prose
around them. That prose is where the length is.

## The crisp version (what a short-and-crisp cut would look like)

Keep every verbatim card that a tester must compare against, every sheet check,
and the three rules. Cut everything that explains, repeats or sets up.

| Part | Now → after | Words | Cards | Tests | What goes |
|---|---|---|---|---|---|
| Cover + Method | 2 pages → 1 | 1,031 → ~450 (−56%) | 0 | 0 | the who-does-what prose becomes a three-line role strip; "what the record keeps", "the next delivery" and "deliberately refused" collapse to four bullets under Known and expected |
| A · the load | 4 tests → 1 precondition | 972 → ~180 (−81%) | 8 → 1 | 4 → 1 | the requester's, dispatcher's and owner's cards (dispatch is already covered by the TRF-5 and TRF-18 test scripts); only the incoming card stays |
| B · first delivery | 5 tests → 2 | 1,187 → ~420 (−65%) | 11 → 3 | 5 → 2 | TESTS 5–7 become one test (open → tick → confirm → photo → four things to see); TESTS 8–9 become one (who else hears; the two list rows) |
| C · second delivery | 3 tests → 1 | 587 → ~220 (−63%) | 6 → 2 | 3 → 1 | the sealed-card and prompt cards; the empty-list card |
| D · reject | 4 tests → 1 (+1 line) | 668 → ~230 (−66%) | 5 → 2 | 4 → 1 | the second detail card and the two "nothing waiting" checks fold into the sheet line |
| E · guards | 4 tests → 1 checklist | 493 → ~150 (−70%) | 2 → 0 | 4 → 1 | no cards; four one-line checks with one PASS/FAIL each |
| Report | 20 rows → 8 | 501 → ~300 (−40%) | 0 | 0 | known-and-expected trimmed to four bullets |
| **Total** | **13 → ~6 pages** | **5,439 → ~1,950** | **32 → 10** | **20 → 8** | |

### The percentages

| Measure | Now | Crisp | Change |
|---|---|---|---|
| Pages | 13 | ~6 | **−54%** |
| Words | 5,439 | ~1,950 | **−64%** |
| Verbatim cards | 32 | 10 | **−69%** |
| Tests (PASS/FAIL lines) | 20 | 8 (+4 checklist lines) | **−60%** |
| Sheet checks | 6 | 6 | 0% — none dropped |
| Rules on the cover | 3 | 3 | 0% |

### One test, before and after

Now, TESTS 5 + 6 + 7 together: about 330 words of prose and six cards.

After, one test of about 60 words and two cards:

> **TEST 2 · Abdul · Receive ONE bale.** Do: tap 📦 Only some arrived → tick the
> bale in front of you → ✅ Confirm 1 of 3 arrived → send its photo.
> See: the picker is gone; your card is redrawn: `5801 ✅` in the list,
> `✅ 1 of 3 received · 🚚 2 still on the road`, all buttons intact.
> Sheet: 5801 available · Kano office; 5802, 5803 in_transit; queue row
> still pending; one Transactions row, qty 1.

## What the cut costs

- **Diagnosis.** A FAIL on a merged test can mean one of four things; the
  tester must write which line failed. Twenty tests tell you where it broke;
  eight tell you that it broke.
- **The dispatch side is no longer verified by this document.** If the owner
  wants Abdul to check the dispatcher's and admin cards too, Part A has to stay
  (that alone is 2 of the 7 pages saved).
- **Fewer verbatim cards means fewer wording regressions caught.** The 22
  cards dropped are the ones that duplicate a card already shown or belong to
  another role.

## Recommendation

Keep both. The 13-page document is the reference (every card, every role);
a 6-page field sheet is what Abdul carries on the floor. Both come from the
same builder script and the same card constants, so the short one is a
`--short` switch, not a second document to maintain. Effort to build it:
small (the card strings already exist; it is the prose that is rewritten).

# Part 2 · The codebase — where it can be shorter, more modular, faster

## Headline

| | Lines now | True deletions | Lines moved (split, not deleted) |
|---|---|---|---|
| `src/` (265 files) | 98,682 | **≈ 9,000–12,000 (9–12%)** | ≈ 12,000–14,000 |
| `scripts/` | 12,652 | 0 (archive ≈ 2,500 one-off scripts) | ≈ 2,500 |
| `test/` | 51,082 | ≈ 2,000–3,000 (4–6%) | — |

The honest reading: **length drops by about a tenth; modularity is the real
gain.** Two files hold a quarter of the application (the controller 13,372
lines, the approval events 2,997) and are where every change gets expensive.
Splitting them moves far more code than it deletes.

## Summary by area

| Area | Lines now | After | Shorter | Efficiency gain | Effort | Risk |
|---|---|---|---|---|---|---|
| Controller `telegramController.js` | 13,372 | ≈ 2,500 in the file (≈ 1,500–2,000 deleted, ≈ 9,500 moved to flow modules) | file −81% · codebase −1.5% | every change to a tap handler stops touching a 13k-line file | L | medium |
| Flows (53 files) | 34,896 | ≈ 31,000 | −10% | shared pickers (date, customer, bale, photo gate) | M | low |
| Executors + approval events | 5,284 | ≈ 4,500 (≈ 700 deleted, ≈ 2,000 moved into `src/executors/`) | −13% | one footer, one place per action | L | medium (ask-first files) |
| Repositories (54 files) | 9,415 | ≈ 7,500 | −20% | one cache, one header check, one parser | M | low (columns unchanged) |
| Helper duplication | ≈ 250 | ≈ 50 | small in lines | one date format, one normaliser everywhere | S | low |
| Sheets reads per tap | — | — | — | 2–4 Inventory reads per tap → 1 | M | low |
| Dead and retired code | ≈ 600 | 0 | −0.6% | — | S | low |
| One-off scripts | 12,652 | ≈ 10,100 active | — (moved to `scripts/archive/`) | smaller tree, same tools | S | none |
| Tests (307 files) | 51,082 | ≈ 48,500 | −5% | one fixture per repository stub | M | low |

## 1 · The controller (biggest file, most moved)

Measured: 13,372 lines, 190 functions; `handleCallbackQueryInner` alone is
3,889 lines and `handleMessage` 1,482; 151 prefix-dispatch blocks and 163
`case` labels; only 19 of the blocks are one-line hand-offs to a flow module,
the rest carry logic inline. A whole wizard lives here — the single-bale sale
(`showDesignsForWarehouse` 181, `showShadesForDesign` 257, `showQuantityPicker`
199, `executeSale` 166) plus `handleDesignAssetCallback` (310) and
`handleFileMessage` (223).

Change: (a) a routing table — one object literal mapping a prefix to a module
— replaces the 151 `startsWith` blocks (≈ 600 lines → ≈ 60); (b) the
single-bale sale wizard moves to `src/flows/baleSaleFlow.js`, the design-asset
handler to `src/flows/designAssetFlow.js`, the file router to
`src/flows/fileRouter.js`; (c) the text parser branches of `handleMessage`
move behind the intent table. What stays: webhook entry, auth fence, menu
anchor, the routing table.

Saves: ≈ 1,500–2,000 lines deleted (routing boilerplate, duplicated
guards); ≈ 9,500 moved. Risk: medium — it is the parked TG-8 split and needs
your go. Safety net already exists: 89 test files drive the real controller
through `test/helpers/controllerHarness`, pinning behaviour, not internals.

## 2 · Flows

Measured: 53 files, 34,896 lines; 47 already render through `flowKit`; 50 of
53 require repositories directly (skipping the service layer); 17 files in
`src/` exceed 1,000 lines, nine of them flows (`taskFlow` 3,332,
`transferFlow` 3,056, `bundleSaleFlow` 1,784, `warehouseAuditFlow` 1,754 …).
The same wizard furniture is rebuilt per flow: `stepBack` ×8, `showConfirm`
×7, `menuRow` ×8, `renderError` ×10, date calendars, customer pickers, bale
tick lists, photo gates.

Change: four shared pickers in `src/utils/pickers/` (date, customer, bale,
photo gate) with the flow passing its namespace and labels; migrate the six
hand-rolled flows onto `flowKit`. Saves ≈ 3,000–4,000 lines (10%). Keeps:
every flow's own callback namespace (registry in CLAUDE.md) and session type.

## 3 · Executors and approval events

Measured: `executeApprovedActionInner` holds ≈ 49 action branches
(`sale_bundle` 279 lines, `bulk_receive_goods` 201, `return_thans` 142,
`request_payment` 96, `add_user` 82, `receive_goods` 80 …) sharing one footer
(status flip + audit + transaction); `approvalEvents.js` (2,997) carries 17
inline post-approval hooks (welcome DM, design photo, finance card, outstanding
line …); 171 `require()` calls sit inside function bodies in `src/services`
(the usual sign of circular dependencies being dodged); 6 services/events
require flows or controllers upward.

Change: `src/executors/<action>.js`, one per action family, each exporting
`execute(item, enrichment, ctx)` and an optional `afterApprove(bot, …)`; the
executor loop becomes a registry lookup plus the shared footer; approval
events keep routing, the two-admin gate and notifications only. Saves ≈ 700
lines deleted (duplicated footer, duplicated hook scaffolding); ≈ 2,000
moved. Risk: medium — `approvalEvents.js` and `risk/evaluate.js` are
ask-first files and approval semantics must not change.

## 4 · Repositories

Measured: 54 files, 9,415 lines; 23 repositories are ≤ 120 lines (1,868
lines together) and 10 implement the identical trio `getAll` / `append` /
`parseRow`; `ensureHeader` ×19 and `invalidateCache` ×19 are copies.

Change: `src/repositories/base.js` — a factory taking the sheet name and the
header list, giving cached `getAll(fresh)`, `append`, `appendMany`,
`ensureHeader`, `invalidateCache`, header-driven `parseRow`/`toRow`. The 23
small repositories become ≈ 40 lines each; the big three (`inventory`,
`approvalQueue`, `transactions`) keep their custom logic on top of the base.
Saves ≈ 1,500–2,000 lines (16–21%). Hard rule kept: column order and names
never change — the factory reads the header, it does not write one.

## 5 · Helper duplication (small in lines, large in consistency)

Measured: 31 files define their own `fmtDate`; 18 local copies of
`upper` / `norm` / `low`; `str` ×37, `num` ×20, `normDay` ×7, `truncate` ×6
defined as functions in several files. Canonical versions exist in
`src/utils/dates.js` and `src/utils/flowKit.js` for some of them.

Change: one `src/utils/text.js` (`str`, `num`, `upper`, `norm`, `truncate`,
`mdEscape`) and the existing `dates.js`; replace local copies with one import
line. Saves ≈ 200 lines; the gain is that a date or a name is formatted one way
everywhere (three TRM-1-class Markdown bugs this quarter came from local
copies).

## 6 · Efficiency against Google Sheets

Measured: `inventoryRepository.getAll` has 118 call sites (14 of them
`fresh=true`), the read cache lives 5 seconds; `settingsRepository.getAll` 53
sites, `usersRepository.getAll` 27. One tap in the supply-request shade picker
reaches Inventory two to four times through different services inside the same
five seconds; a card render often reads Users twice (name map, then auth).
Writes: no row-by-row append loop is left in `src/services` (QTA-1 batched
sales; transfers and returns already flip through one `batchUpdateRanges`).

Change: a per-webhook-turn memo (`ctx.reads`) that hands every service the
same Inventory, Users and Settings snapshot for the duration of one tap,
bypassed by `fresh=true`. Saves 1–3 Sheets reads per tap (reads are also
quota-governed, 300/min), no schema change. The 171 lazy requires cost nothing
at runtime; they are a modularity symptom, not a speed one.

## 7 · Dead and retired code

Measured: five retired tap families (`tp*`, `tt*`, `rt*`) are still routed in
the controller to a refusal message; 8 `RETIRED` markers and 54 files with
`legacy` markers — most are live readers of old rows (`TRANSFER_ACTIONS`,
pre-uid transfers, pre-storage dispatch lines) and must stay.

Change: delete the five dead routes and their refusal copy, and the executor
branches that exist only to refuse; keep every reader of old data.
Saves ≈ 300–600 lines.

## 8 · Scripts

Measured: 12,652 lines; `smoke.js` is 8,514 of them (the offline gate — keep);
seven guide builders ≈ 3,000 (documents — keep); ≈ 2,500 lines are one-off
repair or backfill scripts, several still PENDING for you to run (ISC-1 steps
0–5, `repair-contacts-staircase`, `format-date-columns`).

Change: after each pending script has been run, move it to `scripts/archive/`
with its run date in the name. Nothing deleted, the active tree shrinks by a
fifth of the folder.

## 9 · Tests

Measured: 307 files; 74 stub `inventoryRepository.getAll` by hand, 45 stub
`approvalQueueRepository.getByRequestId`, 40 stub `usersRepository.getAll`,
12 re-implement `transitionBales`; 128 use the shared fake bot and 89 drive
the real controller (behaviour-pinned — the right kind).

Change: `test/helpers/stubs.js` with `stubInventory(rows)`,
`stubQueue(rows)`, `stubUsers(users)` and the transfer fixture. Saves
≈ 2,000–3,000 lines and makes the source refactors above cheaper, because
one fixture changes instead of 74 files.

## Order of work (one commit each, safest first, tests green at every step)

1. Helper canonicalisation (§5) — gate: `npm test`, `npm run smoke`, lint 0.
2. Shared test stubs (§9) — gate: same count of tests passing.
3. Repository base factory, migrate the 23 small repositories (§4) — gate:
   smoke's repository parse checks.
4. Controller routing table, then the single-bale sale wizard out (§1) —
   gate: the 89 characterization suites; **your go needed (TG-8)**.
5. Executor registry, three branches first (`sale_bundle`, `return_thans`,
   `bulk_receive_goods`) (§3) — gate: the executor suites; **your go needed
   (ask-first files)**.
6. Per-turn read memo (§6) — gate: QTA-1 governor tests.
7. Shared pickers for flows (§2) — one flow per commit.
8. Dead routes out, scripts archived (§7, §8) — after the pending scripts ran.

Steps 1–3 and 6–8 need no ruling from you. Steps 4 and 5 do.

## What the numbers do not say

- **Comments are 22.8% of `src/` (22,491 lines).** A large share records your
  rulings, dates and incident reasons in place; the register
  (`BUSINESS_RULES.md`) points at them. Cutting comments would shorten the
  tree by a fifth and lose the why. Not recommended beyond stale ones.
- **Moved is not deleted.** The controller split and the executor registry
  are the two biggest changes and they shorten the codebase by under 3%.
  Their value is that a change to one tap or one action touches one small
  file.
- **The tests are the safety net, not the fat.** 51k lines of tests is what
  lets any of the above ship without breaking a live warehouse flow.
- **Efficiency is already mostly won.** QTA-1 batched the writes that
  mattered; what is left is repeated reads inside one tap and the quota
  headroom they cost.
