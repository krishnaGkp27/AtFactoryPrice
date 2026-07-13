# PL-1 — Direct packing-list upload (owner-locked 13-Jul-2026)

Owner: "I will just upload sheet2 (packing list) and you need to check for
collision and than structure by your own and give short summary about new
packages which are going to get added. Once I approve it goes to 2nd admin
for approval post which it gets added in main inventory sheet with label
given."

## Flow

1. Add Stock (strict) → pick warehouse → send the supplier packing-list
   **.xlsx as-is** (no converter step).
2. Bot auto-detects the packing-list layout (any sheet whose header row is
   `S. | Carton | BALE …` with `THAN 1..7` yardage columns). Non-matching
   xlsx/csv files fall through to the normal strict table path unchanged.
3. Transform (same rules as scripts/convert-packing-list.js, now shared via
   `src/services/packingListImportService.js`):
   - 1 bale row → N than rows (PackageNo = Carton No.)
   - trust yardage CELLS over the "No of THAN" declaration (corrections
     counted + shown); skip bales with no yardage cells (listed)
   - exclude ZSHIPMENT / NOT FOR SALE rows
   - carry Indent + CS No (BULK-INDENT) + Shade; supplier from letterhead
   - reconcile: sum(than yards) == bale Net Yards per row
4. Validate via bulkRowValidator (maxRows raised to 6000 for this mode) +
   strict R1/R2 scan. **Any same-warehouse collision blocks the whole
   file** (owner default); cross-warehouse duplicates stay notes.
5. Preview = short summary: bales / thans / yards / designs / corrections /
   collision result → required Container label step → Submit.
6. Submit queues ONE `bulk_receive_goods` approval for the whole container.
   Requester's submit = 1st admin; 2nd admin approves (DUAL-1); executor
   appends to the main Inventory sheet with label + bale_uid per row.

## Big-container storage (>400 than rows)

ApprovalQueue ActionJSON lives in one sheet cell (~50k char cap) — a whole
container (3k+ rows) cannot ride in it. When rows > 400 the flow stages the
normalized rows as JSON under `data/uploads/pl-<sha256>.json` and the
actionJSON carries `balesStagedPath` + `stagedSha256` + counts instead of
`bales`. The executor re-reads the staged file, verifies the hash, and
proceeds. If the file is missing (bot redeployed between submit and
approval) the approval fails CLOSED with "re-upload the packing list" —
nothing partial is written.

## Out of scope

- Other suppliers' layouts (unrecognized → clear message, CSV path remains).
- Prices (land 0; owner sets via Update Price — prior decision).
- Multi-warehouse packing lists (single warehouse per upload, as today).
