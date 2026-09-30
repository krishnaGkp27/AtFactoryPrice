# TRF-21 · A transfer received in more than one delivery

**Status: SHIPPED 30-Sep-2026 (owner: "go with the defaults", after "Please
fast-forward the process").**

Owner's words (30-Sep-2026): "Right now, transfer of goods is made in a
batch, in which bales of different designs are clubbed together, and the
same batch goes to the receiver. The receiver needs to receive the goods in
the same order, in the same batch. The problem here is that the goods
received by the receiver do not come in the same batch. They come in some
quantity, and then the remaining ones come. Can you make changes at the
receiver so that, whichever goods he receives by that time, they can be
updated instantly? This is without making him wait for the remaining goods
of the same batch to get approved and ready for supply."

## 1 · What changes for the receiver

The receiver card keeps `✅ Received` (everything still on the road, as
before) and `⚠️ Reject`. When more than one bale is still on the road it
gains one more door:

> `📦 Only some arrived — tick them`

which opens an arrival list as its own message under the card (the card
keeps its buttons; a picker that times out is tombstoned without it) —
one chip per outstanding bale (`⬜ P1`, `⬜ P2`, …, 24 per page), grouped in
the text by design and shade so the labels can be checked. **Every chip starts
unticked** (BUSINESS_RULES §2: the bot never pre-ticks physical stock —
see §4 below on why this differs from the proposal). The receiver ticks the
bales physically in front of them, taps `✅ Confirm n of m arrived`, sends
the receipt photo (mandatory, as for every receipt — §3 of the rules), and:

- the ticked bales flip `in_transit → available` at the destination at
  once — sellable immediately; the picker message goes, the photo prompt
  becomes the delivery's seal, and the receiver's card is redrawn in place
  with the live state (`✅ 1 of 3 received · 🚚 2 still on the road`) and
  its buttons, ready for the next delivery;
- the rest stay `in_transit` (in neither warehouse's stock, §5), the
  transfer stays open in My Tasks, on the 📋 list and in the 🛂 inbox;
- the dispatcher, the requester and every admin are told what landed and
  what is still on the road;
- the hourly holder reminder keeps going to the receiver for the rest;
- each later delivery is another `✅ Received` (the whole rest) or another
  tick list, with its own photo. The last bale closes the transfer exactly
  as one big receipt always did (`approved` = received in full).

Ticking every outstanding bale is the ordinary receipt, byte for byte: no
delivery record is written and the Transactions row logs the whole load.

A load that carries the same printed number twice (one number in two
containers is two bales) shows no tick door — a number-keyed list cannot
tell them apart — and says so on the card; it is received in one go.

## 2 · Defaults the owner accepted (30-Sep-2026)

| # | Question | Default |
|---|---|---|
| D1 | How the receiver says what arrived | A tick list of the dispatched bale numbers, grouped by design and shade; confirm + photo per delivery. |
| D2 | Bookkeeping per delivery | **One Transactions row per delivery** — the bales confirmed that day, the delivery's own designs. A single all-at-once receipt keeps today's one row. |
| D3 | A bale that never arrives | `⚠️ Reject` after a partial delivery returns **only the bales still on the road** to the source store's records; the bales already received stay live at the destination. No "lost in transit" state. |

Not changed: dispatch (still one load, one photo, TRF-18 admin gate), the
row identity, the sheet layout, Postgres.

## 3 · Where the record lives

No column, no sheet, no migration. The transfer's own ApprovalQueue row
(`actionJSON`) gains, only once a delivery is partial:

- `receivedBales[]` — printed numbers confirmed so far;
- `receivedUids[]` — the Inventory rows those confirmations covered;
- `receipts[]` — one entry per delivery: `{at, on, by, bales[], rows, doc?}`
  (`doc` = that delivery's receipt photo: the delivery number rides the
  photo gate into `attachDoc`, which stamps exactly that entry, so the
  next delivery's photo overwriting `receiveDoc` loses nothing; a post-hoc
  attach names no delivery and touches `receiveDoc` alone);
- `lastReceivedAt` — the clock the waiting line restarts from.

Column E stays `pending` and `stage` stays `in_transit` until the last bale.
On the closing delivery the status flip is written BEFORE the bookkeeping
patch; and a row whose record already says every bale arrived but is still
open (a write failed between the two, or the process died) is closed by
the next ✅ Received without flipping or booking anything again
(`transfer.received {recovered: true}`).
Postgres mirror: `transfer_events` gets `partly_received` (detail: delivery
number, bales, remaining); `transfers.stage/status` are unchanged until the
close, so `scripts/transfers-parity.js` needs nothing. AuditLog:
`transfer.partly_received` per delivery, `transfer.received` at the close
(with the delivery count when there was more than one).

Sentinel C3 treats a received uid as no longer claimed by the open transfer
in both directions.

## 4 · Deviation from the proposal — pre-ticked chips

The understanding message proposed "all ticked to start with; the receiver
unticks the bales that have not arrived". BUSINESS_RULES §2 (owner, 02-Aug:
"Don't put any order of selection from your own side at any place … No
random selections") forbids pre-ticked chips anywhere. The build therefore
keeps `✅ Received` as the one-tap whole-load confirmation (unchanged) and
makes the tick list start empty — the receiver ticks what is in front of
them. A one-bale remainder shows no tick door at all (one option is
navigation, §2). **Owner: say the word if the pre-ticked version is what
you want, and §2 gets the exception recorded.**

## 5 · Surfaces, one vocabulary

| Surface | Between deliveries |
|---|---|
| Receiver card | `✅ *6 of 10 received* · 🚚 4 still on the road (P7, P8, P9, P10)`; received numbers carry ✅ in the line brackets; prompt reads `✅ Received confirms the remaining 4` |
| Waiting line (card · 📋 list · detail) | `🚚 *With Abdul to confirm the rest* · 6 of 10 received · left 18-Sep-2026 · 1d waiting` (clock from the last delivery) |
| Row (🛂 inbox · 📋 list · My Tasks button) | `18Sep·02 · 🟡 LAG▸KAN · 6/10B` (legend: `6/10B = received so far`) |
| My Tasks line | `🚚 6 of 10 received — confirm the rest as it arrives` |
| State label | `partly received 📦 (6 of 10)` |
| Admin / requester DM | `🚚 *18Sep·02* partly received 📦 (6 of 10) — 10 bale(s) · Lagos → Kano office` + waiting line; the dispatcher's copy adds `📦 This delivery: P1, P2` |
| Photo forward caption | `📸 Receipt photo — TR-… — delivery 2: P7, P8` |
| Reject confirm | `The records will return 4 bale(s) to *Lagos* … The 6 bale(s) already received stay at *Kano office*.` |
| Rejected after a partial delivery | row `❌ LAG▸KAN · 6/10B`; waiting line `❌ *Closed by Musa* · 4 bale(s) back at Lagos · 6 kept at Kano office`; detail `✅ 6 received at Kano office · ↩ 4 returned to Lagos`; Postgres `transfers.status` stays `reverted` (no migration) with the split in `transfer_events.detail` |
| Detail card | one `📦 Delivery n: 2 bale(s) · date · name · 📸 url` line per delivery |

## 6 · Callbacks

`trf:rcvp:<id>` (session-free door, same guards as `trf:rcv:`) ·
`trf:rp:t:<i>` tick · `trf:rp:pg:<n>` page · `trf:rp:go` confirm →
photo gate · `trf:rp:nn:<id>` drop the ticks and restore the card. Session
step `receive_pick` joins the busy guard (APC-1) and the anchor guard.

## 6b · Hardened the same day (adversarial review, 28 findings, 12 acted on)

The picker moved to its own message (the receiver's card kept its buttons,
and no longer dies with a timed-out picker); a partial delivery redraws the
card in place instead of leaving two dead seals; the closing delivery
writes the status before the record and a stranded "all received but still
open" row self-heals on the next ✅ Received; a subset resolves its rows
from a FRESH sheet read; a load with a repeated printed number gets no tick
door; the receipt photo is stamped on its own delivery by number; reject
after a partial delivery never sends home a bale the record calls received
even when its rows could not be matched; a stale picker copy's ↩ Not now
cannot wipe the live picker's ticks; a dispatcher who also raised the
transfer hears about a delivery once; rejected-after-partial rows keep
their fraction and say what went home and what stayed; Drive links on the
detail card are link entities (an `_` in a file id no longer blanks the
card); §6c records the `6/10B` token.

## 7 · Live check (owner)

1. Dispatch a transfer of three bales Lagos → Kano office (admin dispatch,
   or Abdul + your ✅).
2. On the receiver's phone: tap `📦 Only some arrived — tick them`, tick
   ONE bale, `✅ Confirm 1 of 3 arrived`, send a photo. Expect: that bale
   `available` at Kano office in the Inventory sheet within seconds, the
   other two still `in_transit`, the ApprovalQueue row still `pending`, one
   Transactions row with qty 1, your DM saying `partly received 📦 (1 of 3)`.
3. Open 📋 Transfers: the row reads `… 🟡 LAG▸KAN · 1/3B`; tap it: the card
   shows `1 of 3 received · 2 still on the road` and the received number
   with ✅.
4. Tap `✅ Received`, send a photo: the row flips to `approved`, the seal
   says `(in 2 deliveries)`, a second Transactions row with qty 2.
5. Repeat 1–2 and then tap `⚠️ Reject`: confirm text names 2 bales going
   back and 1 staying; after Yes, the 2 are `available` at Lagos and the
   received one is still at Kano office.

## 8 · Not built (say the word)

- Dispatch in several loads (the mirror problem on the sending side).
- A `lost in transit` state distinct from reject.
- Per-delivery arrival DATE (each delivery is stamped the day it is
  confirmed, Lagos time, in `receipts[].on` and in BaleMovements; the
  dispatch date stays the Transactions SalesDate).
- The `TRANSFER_STALE_DAYS` admin escalation still counts from the raise
  date; only the holder's waiting line re-clocks from the last delivery.
- 📋 census scripts (`list-ghost-transfers.js`) print the full logged
  count, not the received figure.
