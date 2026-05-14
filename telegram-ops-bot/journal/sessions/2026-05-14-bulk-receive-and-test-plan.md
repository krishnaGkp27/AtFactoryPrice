# 2026-05-14 — Bulk Receive + manual-test playbook for Abdul

Same day as the P1-P4 inbound supply loop. After shipping the four
foundational commits, the user shifted to the operational question:
*how do we actually test this with someone other than me, and what
should I be watching for during approval?*

The user's verbatim ask:

> I have one person abdul who can test for me. Can you provide minimum
> steps for manual testing and me as admin see the structure (during
> approval) and ask you the changes. Once all the feature releases and
> migration of data is done. I will provide admin the toggle matrix of
> all feature control and also approval delegation in between the team
> member. I (me:admin) will be moderator on top level with deep
> understanding of each level microscopically along with superadmin I
> will be giving same access and power.

Two distinct asks compressed into one paragraph:

1. **Right now:** a runnable test plan for Abdul plus a way for the
   user to *see* the approval structure during testing so they can
   request changes inline.
2. **Long-term:** a feature toggle matrix admin UI + approval
   delegation, both deferred until the data migration settles. The user
   self-described as a moderator/superadmin peer model — multiple
   `adminIds` in `config.access` already supports that today; the
   delegation UI is the new build.

## What this session shipped

Mid-session the user pivoted from "talk about testing" to "let's also
build the actual data migration path Abdul will use." That's the
Bulk Receive Goods (P2.5) feature — Abdul uploads a CSV/XLSX of
incoming bales, the bot parses it, queues a dual-admin approval card,
and on approval appends the rows to Inventory.

Locked design decisions (user asked 5 questions, answered them in one
batch):

| # | Question | Decision |
|---|---|---|
| 1 | Merge mode | **Pure append.** Existing rows are never mutated. Same PackageNo can coexist (different bale_uid + addedAt). |
| 2 | File formats | **CSV + XLSX** in v1. `xlsx` npm package added. |
| 3 | Warehouse mismatch | **Reject the whole file** with a clear list of bad rows + allowed warehouses. |
| 4 | PO linkage | **Optional.** Entry step lets the operator pin an open PO; receipts then flow through `applyReceived` + `recomputeStatus`. |
| 5 | Original file storage | **Local archive** at `data/uploads/{fileHash}.{ext}`. |

The user's exact framing on what NOT to disturb: *"Make sure that Bale
number you consider is the primary key to address and path and detail
attribute shall not be disturbed."* We read this as the strongest
possible append-only contract, and locked it in a smoke assertion
(S14c.8) that instruments `sheetsClient.updateRange` and
`sheetsClient.batchUpdateRanges` and asserts 0 calls on Inventory
after a bulk receive. Machine-enforced spec.

## Code shape

Four commits, shipped sequentially so any could be reverted
independently:

1. **C1** — pure parsers + validator + smoke harness. Zero coupling to
   Telegram or Sheets. CSV is dependency-free; XLSX wraps SheetJS.
2. **C2** — `GoodsReceipts.source` + `file_hash` columns for
   idempotency. Lazy migration extends existing deployments on next
   boot; legacy 12-column rows parse cleanly with `source='manual'`.
3. **C3** — the actual Telegram flow + risk policy + service handler.
   `bulk_receive_goods` joined `ALWAYS_APPROVAL_ACTIONS` so even an
   admin requester gets dual-admin gated.
4. **C4** — controller wire-up (`act:bulk_receive_goods` →
   `bulkReceiveFlow.start`, `br:*` callback dispatch, document upload
   handler when a bulk session is active, `/bulkformat` slash command),
   plus `docs/csv-import-template.md` for Abdul to reference.

## The npm gotcha

`npm install xlsx` failed with `UNABLE_TO_VERIFY_LEAF_SIGNATURE` —
corporate TLS cert chain on the user's network was rejecting the
npmjs.org leaf cert. `NODE_TLS_REJECT_UNAUTHORIZED=0` was insufficient;
`npm install xlsx --strict-ssl=false` worked. Documented here so the
next install (or another machine) knows the workaround. `xlsxParser`
itself is defensive — `isAvailable()` returns false when the package
isn't loaded and parseXlsx returns a structured error, so the smoke
harness can soft-skip until install completes.

## Manual test playbook (5 rounds × ~15 min total)

Sent to the user inline before code-write started. Repeated here so it
survives chat compaction.

### Round 0 — pre-flight (admin alone)
- Restart bot. Confirm `schemaMapper` logs:
  - `extended Inventory with 3 P1 columns`
  - `creating sheet "GoodsReceipts"` (or `extended GoodsReceipts with 2
    P2.5 columns` on a pre-P2.5 deployment)
  - `creating sheet "ProcurementOrders"` / `ProcurementOrderLines`
- `/setlowstock 5` → expect `✅ Low-stock threshold set to *5* bales.`
- Admin Settings → Notifications → verify 🏭 Inventory group has 6
  toggles, all green by default.

### Round 1 — Abdul submits a manual GRN (P2, employee path)
Abdul (non-admin): Stock → 📥 Receive Goods → walk through 6 steps with
3–5 bales. Submit. Admin gets approval card; tap ✅. Verify:
- `GoodsReceipts` has a new row with `source = manual`, `file_hash = ''`
- `Inventory` has N new rows, each with `bale_uid`, `addedAt`, `grn_id`
- `Stock_Ledger` has N `received` rows
- `Transactions` has the audit row

### Round 2 — Admin runs Quick Add Customer (P3, admin path)
Admin: Customers → Add Customer → ⚡ Quick Add → `Test Wholesaler,
+234-803-555-7777, Kano`. Confirm Customers sheet has the row.

### Round 3 — Admin walks the Procurement Plan (P4)
Admin: Admin Settings → 📋 Procurement Plan. New PO → walk through.
Then 📥 Receive (PO-…) → GRN flow opens with `po_id` pinned. Receive a
small qty. PO advances to `partially_received`. Receive the rest →
`received`.

### Round 4 — **The new feature.** Bulk Receive E2E (P2.5)
Promote Abdul to admin temporarily (`.env ADMIN_IDS += abdul_id`,
restart bot).

Abdul:
- `/bulkformat` → bot returns CSV template
- Open Excel → paste template → fill 50 rows for warehouse Kano,
  supplier SupplierA, single design or mixed designs
- Save as `bulk-test-2026-05-14.csv`
- Stock → 📤 Bulk Receive (CSV/XLSX) → Skip PO → upload the CSV
- Preview card shows totals → tap ✅ Submit for approval
- He sees `⏳ Submitted for 2nd admin approval. Request: req-…`

Admin (the user):
- Approval card arrives
- Tap ✅ Approve
- Service handler runs: 50 bales appended, 1 GRN row written with
  `source = bulk_csv` + 16-hex `file_hash`

Verify:
- `GoodsReceipts.source` column = `bulk_csv`
- `GoodsReceipts.file_hash` column = 16-hex string
- `Inventory` has 50 new rows below the previous tail
- *None* of the pre-existing rows changed positions or contents (run
  the assertion in your head: the row numbers above the 50 new ones
  should be identical to before)
- `data/uploads/<file_hash>.csv` exists on the bot's filesystem

Then test idempotency: have Abdul re-upload the *same* file → expect
`⚠️ This file was already imported as GRN-…`.

After this round, demote Abdul (`.env ADMIN_IDS -= abdul_id`, restart).

### Round 5 — Notifications opt-in regression (T2)
Admin: Notifications → flip `Goods received at a warehouse` OFF. Have
Abdul (back to employee status) submit a tiny GRN. Approve. You should
see the approval card but NOT the `📥 Goods received` broadcast. Flip
it back ON.

## Vision confirmation (the long-term ask)

The user spelled out their org model explicitly:

- **Admin (themselves)** = top-level moderator with microscopic visibility into every layer
- **Superadmin(s)** = peer-level, same access and power, configured via `config.access.adminIds[]`
- **Feature toggle matrix** = next build, after the data migration completes — admin-controlled grid of which activities are on/off per user/department/warehouse
- **Approval delegation** = also next build — admin grants a manager the right to approve up to threshold X for action type Y

Both deferred until P1–P4 + P2.5 are field-tested. Filed in ROADMAP §8
(open questions) so they don't get lost.

## What I'd do differently next time

- **Detect npm cert issues earlier.** I spent 90 seconds waiting for
  the first install to time out before realising it was a TLS chain
  issue. Next time, `npm config get strict-ssl` upfront.
- **Pre-write the test playbook before features.** I drafted the test
  playbook *after* C1-C4 were locked in. For a feature gated by
  business-rule approvals, the test playbook is half the value of the
  feature. Move it earlier.
- **Make the append-only contract a first-class fixture.** S14c.8
  instruments sheetsClient to assert "no mutating writes on Inventory."
  That should be the *first* test written for any append-only feature,
  not the eighth. It's the test that locks the spec.
- **Ask the domain question before locking the schema.** Biggest miss
  of the day: I shipped C1-C4 assuming "1 row = 1 bale." The user
  corrected me in their next message — actually 1 row = 1 *than*, and
  one bale carries N thans. I had to ship C5 the same day to add the
  `ThanNo` column and per-bale uniformity checks. The remedy is
  cheap (one focused validator question about row-to-physical-object
  mapping) and would have saved a round-trip. Building schema-first
  for any line-of-business feature: *always* ask "what is one row?".

## Addendum (C5) — schema correction

> User: "As of now single rows in inventory consists of one than (part
> of one bale number). FYI, one bale consists of one or more thans for
> the material we are dealing with right now."

**What changed in C5:**
- Validator: `ThanNo` is now a 5th required column (positive integer
  1–999). `NetMtrs` and `NetWeight` added as optional numeric columns.
  Two new file-level invariants: (PackageNo, ThanNo) unique within a
  file, and per-bale Design + Shade uniformity.
- Flow preview now shows "1 bale · 5 thans · 249 yards" with optional
  net m / net kg lines when those columns are populated.
- Service handler: each row writes its own ThanNo + NetMtrs + NetWeight
  to the Inventory column-F/N/O slots (the columns were already there
  from the legacy schema; we just stopped hard-coding `thanNo: 1`).
- PO linkage: `qty_bales` against the PO now counts *distinct
  PackageNos*, not row count. A bale of 5 thans applies 1 against a
  PO's bale quota, not 5.
- Sample CSVs at `docs/samples/bulk-receive-sample-single-bale.csv`
  (1 bale, 5 thans) and `bulk-receive-sample-multi-bale.csv`
  (3 bales, 10 thans) — Abdul can copy either and edit.
- Smoke harness: +4 checks (S14a.17–.20), now at 153 green.

The lesson is in "What I'd do differently next time" above — schema
shape questions belong in the very first clarifier round, not after
the code is pushed.
