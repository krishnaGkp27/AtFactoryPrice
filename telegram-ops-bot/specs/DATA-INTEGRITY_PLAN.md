# Data-Integrity Programme — SEN-1 · STK-E1 · STK-PG

**Status:** approved by owner 07-Aug-2026 ("document these activities…
let us start our job with the next discussion"). Work starts next session.
**Build order (locked):** SEN-1 first, then STK-E1, then the STK-PG
decision — the Sentinel guards the data while the consolidation surgery
happens, and consolidation then removes the Sentinel's false-alarm noise.

**Question this answers:** the owner asked (07-Aug) whether to integrate an
external inventory engine to stop data inconsistency. Decision: **no
third-party engine** — the owner's locked rules (printed bale number as the
only key, recycled numbers, thans-in-bales, no bot-side selection, the
image → operator → dual-admin chain, Telegram-first) don't map onto one;
instead harden what exists, in the three stages below.

---

## 1 · Why — the 07-Aug-2026 code audit (four-reader sweep)

Every recent stock bug (TRF-14 wrong bales, 12e cross-warehouse flips,
RET-2 corrections-as-returns, SLG-1 double-subtraction) is one instance of
three structural facts:

### 1a · 19 doors mutate stock state

All funnel through 7 writers in `inventoryRepository`
(`markThanSold`, `markPackageSold`, `markThanAvailable`,
`markPackageAvailable`, `transitionBales`, `appendThans`, `appendBale`)
— **plus one raw write outside the repository**: the `rename_warehouse`
executor (`inventoryService.js` ≈1069) rewrites column I via
`sheetsClient.batchUpdateRanges` directly, no movement rows, no cache
invalidation path.

| # | Door | Transition | Gate |
|---|------|-----------|------|
| 1–3 | executors `sell_than` / `sell_package` / `sale_bundle` (4 requester flows feed the bundle) | available→sold | approval + enrichment |
| 4–5 | executors `return_than` / `return_package` | sold→available | dual-admin |
| 6 | executor `revert_sale_bundle` | sold→available | dual-admin (logs kind `return` — deliberate: it books the financial return) |
| 7 | executor `rename_warehouse` | col I rewrite | dual-admin, **bypasses repository** |
| 8–9 | executors `receive_goods` / `bulk_receive_goods` (3 requester flows) | row birth | dual-admin |
| 10 | `/revert_packages` slash command | sold→available | admin text cmd, **no approval** (by design, RET-2 correction) |
| 11–14 | transfer doors `trf:acc` dispatch / `trf:adok` TRF-18 approve / `trf:rcv` receive / `trf:rej`+`trf:dec` reject | available↔in_transit | party-chain + photo, not the approve: pipeline |
| 15 | `sns:tok` SNAP-4 PDF batch | available→in_transit | admin, creates AND dispatches in one tap |
| 16 | `transferRepair` boot pass | one-off swap | none at fire time (owner pre-approved; idempotent fingerprint) |
| 17 | `scripts/import-inventory.js` CLI | row birth | **none — outside every gate, no collision check, no bale_uid** |
| 18 | LATENT: `executeSale` direct branch (controller ≈6913) + `sellPackage`/`sellThan` fallthrough | available→sold | ungated the moment a sell action leaves `ALWAYS_APPROVAL_ACTIONS` |
| 19 | DEAD: exported `addStock` / `sellBatch` | births / sales | no caller today; bypass gates if ever called |

### 1b · 19 definitions of "what is a bale", 11 live divergences

Five families: design|number (no container) · design|number|container with
inconsistent case/trim · baleUid-first (bundle-sale) · warehouse|number
(no design) · outliers (design|dateReceived audit signature,
design|timestamp Transactions proxy). The divergences that bite:

1. **Container axis:** `baleGroupKey` (Customer Supplies, Supply Details,
   reconcile card, stock browse) omits the container; the movement log,
   Supply Ledger and TV-8 roster include it. A recycled printed number is
   ONE bale on one surface, TWO on the other.
2. **Case:** `supplyLedgerService.bmKey` is raw-cased; the movement
   writers uppercase. A case mismatch breaks the ledger's debit dedupe →
   double-counted supply.
3. **Trim:** `baleMovementLog.record`'s grouping key doesn't trim
   design/number but `baleMovementsRepository.baleKey` does → possible
   duplicate `Current` flags.
4. **Preference inversion:** bundle-sale keys baleUid-first; legacy rows
   carry per-THAN synthetic uids → every than of an old bale counts as
   its own "bale" in the picker/cart (the "223 bales" failure, still live
   there).
5. **Design axis missing:** `warehouse|packageNo` keys (sellBale/snap/
   transfer typed preloads, Business Glance, PG mirror metric) merge
   different-design bales sharing a number.
6. **Number-alone, cross-warehouse:** legacy tp*/tt* tap flows and
   unscoped `findByPackage` collapse warehouses.
7. **Missing-number fallback:** unnumbered rows = 1 bale in Supply
   Details, 0 in stock buckets, one merged row in the movement log.
8. **Container source drift:** ledger keys the sold side by the row's
   CURRENT arrivalBatch but the movement side by the container stamped at
   write time → backfilled containers break dedupe.
9. **Audit signature mismatch:** `baleAuditReport` uses design|dateReceived,
   roster uses design|number|container → misses/false-positives.
10. **Roster case sensitivity:** raw-cased roster keys can split one bale
    → whole-bale reads as loose thans.
11. **Transactions proxy:** sales browser counts design|timestamp → two
    same-design bales in one write = one.

### 1c · Nothing cross-checks the sheets at runtime

The existing toolkit (queueRepair, transferRepair, inventoryHeaderRepair,
customerIdRepair, baleAuditReport, smoke lints, PG mirror parity) is all
either **reactive one-offs for already-observed corruption** or test-time.
Verified gaps — no checker exists for ANY of these:

- sold Inventory rows ↔ `sale` movement rows (a swallowed movement append
  is never detected);
- `return` movements ↔ an approved ApprovalQueue row (the ledger *trusts*
  kind==='return' unchecked);
- `in_transit` rows ↔ an open transfer (stranded-in-transit class has no
  detector — transferRepair is proof it exists);
- exactly one `Current` flag per bale (0-flag and 2-flag crash modes are
  documented in the repo's own comments; `currentRows()` has zero callers);
- `soldTo` → Customers resolution (misspelt customer silently forks);
- Inventory flip ↔ Transactions row pairing;
- requestId uniqueness outside TR-* ids;
- LedgerBalanceCache staleness;
- PG mirror parity is aggregate-only and inert without `DATABASE_URL`.

### 1d · Postgres readiness (for Stage 3)

Railway PG live since 22-Jul; 10 tables; disciplined best-effort layer.
Verdict: could host a transactional stock-event ledger with **three code
prerequisites**: (1) a `withTransaction` helper on `postgresPool` (today
only single-statement `query()`); (2) a fail-closed write path (every
current consumer silently no-ops without PG — wrong posture for a source
of truth; only `usageMeterService.reserve()` fails closed today);
(3) a minimal versioned-migration mechanism (boot-DDL `CREATE IF NOT
EXISTS` can't evolve existing tables).

---

## 2 · SEN-1 — Consistency Sentinel (build FIRST)

**Read-only** cross-sheet checker: `src/services/consistencySentinel.js`.
Never auto-fixes; every finding names exact rows/bales and the suggested
repair path.

| # | Check | Catches |
|---|-------|---------|
| C1 | every sold Inventory row (BMV-1 cutoff 03-Aug-2026 onward) has a matching `sale` movement row | swallowed movement appends |
| C2 | every `return` movement traces to an APPROVED return/revert ApprovalQueue row; `correction` excluded | unapproved credits reaching the Supply Ledger (enforces at runtime what SLG-1 only trusts) |
| C3 | `in_transit` rows ↔ open transfers, both directions, by bale_uid | stranded bales / phantom transfers |
| C4 | exactly one `Current=YES` per bale key in BaleMovements | the 0-flag / 2-flag crash modes |
| C5 | every Inventory `soldTo` resolves via customerEntity (canonical + aliases) | phantom-customer forks, at fork time not invoice time |
| C6 | duplicate LIVE printed numbers per warehouse | folds boot-time `baleAuditReport` into the same report |
| C7 | requestId uniqueness across ALL approval families | restart-counter collisions beyond TR-* |

**Delivery:** nightly scheduled run + **🩺 Data Health** admin tile
(flow module `snt:` namespace, activityRegistry entry, one `act:` case +
dispatch block — controller addition pre-approved by this plan). Silent
when clean; drift → admin DM. Settings keys `SENTINEL_ENABLED` (default 1)
and `SENTINEL_HOUR` in `settingsRepository.DEFAULTS`. Findings: DM +
AuditLog append — **no new sheets** (storage rule 5b). Offline tests per
check (clean + drifted fixtures), full gate, adversarial review before
deploy.

## 3 · STK-E1 — one identity, one door

1. **`src/services/baleIdentity.js`** — canonical bale key
   `design | printedNo | container`, trimmed + uppercased, plus thanKey
   and a documented legacy fallback for unnumbered rows. All 19 call
   sites migrate. Expected on-screen changes (correct, not regressions):
   recycled numbers show as two bales where they truly are two; the
   bundle-sale legacy per-than inflation disappears.
2. **`src/services/stockEngine.js`** — every H/I mutation goes through
   one function requiring `{event, authority}` (event ∈ sale · return ·
   correction · dispatch · receive · reject · intake; authority = approval
   requestId or admin-correction userId). Writes Inventory + BaleMovements
   as one operation; refuses unnamed events. Repository writers become
   internal.
3. **Close the loose doors:** delete dead `addStock`/`sellBatch`; remove
   the latent `executeSale` direct branch and goodsReceiptFlow
   self-execute path (surgical controller/flow deletions — called out to
   the owner in the 07-Aug approval); route `rename_warehouse` through
   the repository; `scripts/import-inventory.js` → **owner to choose:**
   add the intake collision gate + bale_uid stamping, or retire it in
   favour of bulk-receive.
4. Characterization tests pin current counts BEFORE key migration; one
   unit test per divergence in §1b. Full gate + adversarial review.

**Untouched:** approval semantics (`WRITE_ACTIONS` /
`ALWAYS_APPROVAL_ACTIONS`), sheet columns/order, Settings knobs.

## 4 · STK-PG — Stage 3 (owner ruling PENDING — do not start)

Transactional stock-event ledger in the existing Railway Postgres; the
Inventory sheet becomes a human-readable mirror. **Flips BUSINESS_RULES
§12 and the 16-Jul storage-layering rule (sheet = source of truth), so it
needs an explicit owner ruling**, taken only after SEN-1 + STK-E1 have
run clean for a while. Prerequisites in §1d. Not spec'd further until the
ruling.

---

## 5 · Open items for the owner

- [ ] STK-E1: `import-inventory.js` — gate it or retire it?
- [ ] STK-PG: go / no-go after SEN-1 + STK-E1 have run clean.

*Audit provenance: 07-Aug-2026 four-agent parallel sweep (doors /
identity / checks / postgres) over the full codebase; condensed here so a
fresh session can execute without re-auditing.*
