# TRF-20 · One transfer: one door, one identity, one row, and the move to Postgres

**Status: SPEC — awaiting the owner's go (22-Sep-2026). No code.**
Evidence: the owner's workbook export of 20-Sep (ApprovalQueue 532 rows,
AuditLog 6,700 rows) and the 14-screen `TRF_SURFACES` PDF of 21-Sep.
Owner's words (19/20-Sep): "multiple requests for the same design and
quantity … can cause big real-life challenges for the operation team … fix the
structure and architecture … migrate this onto PostgreSQL on Railway."

## 1 · What the data and the screens showed

- 67 transfer rows ever; 32 of them sit in 12 groups of identical route,
  lines and requester. Of the 16 open rows today, 8 are ghosts: twins of a
  transfer that was later completed (10Aug-001/007/008, 12Aug-003,
  07Jul-001, 18Sep-001/002) plus the 21-Sep test transfer.
- The three identical `🔴 LAG▸KAN ·10B` rows are the SAME ten bales of
  9031-D raised three times on 18-Sep by two people, 12 minutes and then
  two hours apart. Not a bot double-tap: a person saw nothing move and sent
  it again. Stuck transfers are excluded from the hourly re-send, so nothing
  ever nags anyone about them; five rows have waited since 10-Aug.
- No reference has ever collided and no pair is seconds apart, but both
  vectors exist in code: `TR-<day>-<n>` is computed by scanning the sheet at
  send time, the queue write is the blind `append`, and the audit line after
  it is unguarded, so a failure there re-arms Send on a transfer that exists.
- Two doors still write transfers: the staged flow (`transfer_stock`, 51
  rows) and the hidden single-bale / single-than / batch doors (16 rows,
  last used July). The controller keeps `tp*` / `tt*` handlers and executor
  branches for them.
- Three surfaces disagree about the same rows. The 📋 Transfers list prints
  `18Sep·02 · ⏳ awaiting dispatch · Abdul` and a text block WITH the design;
  the 🛂 inbox prints `🔴 LAG▸KAN ·10B` with no design, date or holder; My
  Tasks lists the five `admin_review` rows as `🚚 Dispatch — TR-20260810-…`
  "waiting for you to dispatch", which they are not.
- The workbook still carries the four tabs retired on 1-Sep, a "Copy of
  ApprovalQueue", a dead "Transfers" tab and four scratch tabs; 515 of 532
  user ids export as decimals. Sheets has no types.

## 2 · Decisions assumed (owner: confirm or change, one line each)

| # | Question | Assumed answer |
|---|---|---|
| D1 | Identical open transfer at Send | **Refused**, with the existing reference, holder and age on the card and an "Open it" button. Admins get a second button "Send anyway". |
| D2 | The hidden single-bale / single-than / batch doors | **Deleted.** Old rows stay readable. |
| D3 | 📋 Transfers list and the 🛂 inbox Transfers group | **One list.** The inbox chip opens the same list. |
| D4 | What a row carries | `18Sep·02 · 🔴 LAG▸KAN · 10B · 9031-D · Abdul · 2d` — reference, dot, route, bales, lead design (`+2` for more lines), holder, days waiting. Amends the 01-Aug "no words" ruling. |
| D5 | Stale transfers | Join the hourly re-send to the holder; after `TRANSFER_STALE_DAYS` (Settings, default 3) admins are nagged too. |
| D6 | Ghosts already in the sheet | Declined by a script, listed by reference in §5, owner runs it. |
| D7 | Postgres | Transfers are the pilot table; the sheet becomes a mirror. Backup first. |

## 3 · Design

**A · One door.** `transferFlow` is the only way to raise a transfer. The
`tp*` / `tt*` callback blocks, the two hidden tiles, the `transfer_than` /
`transfer_package` / `transfer_batch` executor branches and their intent
codes go. `TRANSFER_ACTIONS` keeps the legacy values for READING old rows.

**B · One identity that cannot repeat.** The confirm card mints an
idempotency key (UUID) into the session when it is drawn; Send carries it.
The queue write becomes `appendOnce` keyed by it, so a retry after any
failure lands on the same row. The human reference `TR-<day>-<n>` stays,
allocated inside the same exclusive section as the write. On Postgres the
same guarantee is a unique index, not a mutex.

**C · Duplicate guard at Send (D1).** Before writing: any open transfer
with the same from, to and multiset of (design, shade, qty) blocks the send
and shows `⚠️ Identical transfer 18Sep·02 is waiting on Abdul · 2d`. No
second row is written unless an admin taps "Send anyway", which stamps
`duplicateOf` on the new row so both surfaces say so.

**D · One row grammar (D3, D4).** One `transferRow(t, names)` in
`transferService` feeds the list, the inbox, My Tasks and the DM cards'
first line. My Tasks stops calling an `admin_review` row a dispatch task:
it lists what waits on *you*, in the seat you hold.

**E · Nothing sits silently (D5).** `approvalReminder` includes
`transfer_stock`: the holder gets the card again hourly, admins after
`TRANSFER_STALE_DAYS`. A transfer can no longer wait six weeks unseen.

**F · The pilot table (D7).**

```sql
-- migration 003_transfers
CREATE TABLE transfers (
  id              BIGSERIAL PRIMARY KEY,
  ref             TEXT NOT NULL UNIQUE,            -- TR-20260918-002
  idem_key        UUID NOT NULL UNIQUE,            -- minted at confirm
  from_wh         TEXT NOT NULL, to_wh TEXT NOT NULL,
  lines           JSONB NOT NULL,                  -- [{design,shade,qty,bales[]}]
  lines_hash      TEXT NOT NULL,                   -- canonical multiset hash
  stage           TEXT NOT NULL CHECK (stage IN ('requested','admin_review','in_transit')),
  status          TEXT NOT NULL CHECK (status IN ('pending','received','declined','reverted')),
  requested_by    TEXT NOT NULL, dispatcher TEXT NOT NULL, receiver TEXT NOT NULL,
  duplicate_of    TEXT REFERENCES transfers(ref),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at      TIMESTAMPTZ, decided_by TEXT
);
CREATE UNIQUE INDEX transfers_one_open_per_load
  ON transfers (from_wh, to_wh, lines_hash) WHERE status = 'pending' AND duplicate_of IS NULL;
CREATE TABLE transfer_events (
  id BIGSERIAL PRIMARY KEY, ref TEXT NOT NULL REFERENCES transfers(ref),
  at TIMESTAMPTZ NOT NULL DEFAULT now(), event TEXT NOT NULL, actor TEXT, detail JSONB
);
```

`status` says what happened; `stage` says where it sits. Today's sheet
overloads `approved` to mean received and `rejected` to mean declined OR
reverted; the table says each thing once.

A `transfersRepository` (Postgres) implements the seven calls the transfer
code makes today (`append`, `getByRequestId`, `updateActionJSON`,
`updateStatus`, `getAllPending`, `getResolved`, `getAllWithRowIndex`), so
`transferService`, `transferFlow` and the inbox do not change for the swap.

**G · The move, without a stop day.**
1. Backup: the offsite job ships (`docs/SHEET_STORAGE_SPLIT.md`) and Railway
   snapshots are confirmed on. Not negotiable.
2. Shadow: every transfer write goes to Postgres as well, fail-open, the
   `stockEventsRepository` posture. `scripts/transfers-parity.js` compares
   both stores daily and prints the differences.
3. Seed: the 67 historical rows load once, ghosts already declined.
4. Flip reads: Settings `TRANSFERS_READ_FROM_PG=1`. Rollback is the cell.
5. Stop the sheet write; the dead "Transfers" tab becomes the nightly
   read-only mirror of the table. ApprovalQueue stops receiving transfers.

## 4 · Order of work (one commit each, each shipped alone)

1. `scripts/list-ghost-transfers.js` (read-only) and
   `scripts/decline-ghost-transfers.js --commit` (owner runs).
2. B + C on the sheet-backed store: immediate relief, no schema change.
3. D: one row grammar, one list, My Tasks corrected.
4. E: the nag and `TRANSFER_STALE_DAYS`.
5. A: the dead doors removed.
6. F + G2: migration 003, the Postgres repository, the shadow write, parity.
7. G3–G4: seed and read flip.
8. G5: mirror job and the sheet write stopped.

## 5 · Ghosts to decline (D6)

`TR-20260707-001`, `TR-20260810-001`, `TR-20260810-007`, `TR-20260810-008`,
`TR-20260812-003`, `TR-20260918-001`, `TR-20260918-002`, and the 21-Sep
test `TR-20260921-001` (raised by the Cowork capture; never dispatched, so
no bale moved). `TR-20260810-005` and `TR-20260810-009` are not twins: six
weeks stale at admin review, the owner decides.

## 6 · Out of scope here

The other 50 sheets. This spec moves ONE table and proves the pattern; the
storage-split doc keeps the order for the rest.
