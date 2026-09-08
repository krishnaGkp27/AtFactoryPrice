# VRF-4 — the bill check names the bales it flags

**Status: locked with the owner 08-Sep-2026; building.** Spec first, then
built to it exactly.

## The owner's ruling (08-Sep-2026, with screenshot)

The card read:

```
🔬 Bill check: 14 confirmed · 2 differ · 1 missing · 1 extra ⚠️
```

> "I can see this card in the approval sale with the details mentioned in
> numbers but I cannot precisely see the exact bill number where I need to
> find the ambiguity. Can you make a way, either through chips or on the
> card, to mention the bill number exactly that I need to go through after
> the verification?"

Decision: **both** — the flagged bale numbers ride the card itself, and an
inbox chip replays the full verdict on demand. One-word reason on the
card; full reason text behind the chip. Minimise taps, spend nothing.

## Why the card could not say

VRF-1 builds a per-bale verdict when the OCR finishes (`⚠️ Bale 4412 —
qty: bill ~150 yds, request 120 yds`, `❌ Bale 4421 — NOT found on the
bill`, `➕ On the bill but NOT in the request: 4430`) and sends it as its
own message, unlinked to the card. What it persisted on the queue row was
the four **counts** only. So every later view of the card — the 🛂 inbox,
a reminder, the pending list — could render counts and nothing else, and
the message with the numbers had scrolled away days before.

## What ships

### Layer 1 — the card names the flagged bales

`saleDocVerifyService` now persists, beside the counts, exactly what the
verdict message prints and nothing more: the confirmed numbers, and for
every flagged row its number plus the checker's own reason strings.

```
docVerify: {
  ok, differs, missing, extra, thanUnchecked, at,   // VRF-1/3, unchanged
  okNos:      ['4401', …],                           // plain confirmed
  okNoted:    [{ no, notes: [...] }],                // confirmed with a note
  differRows: [{ no, diffs: [...], notes: [...] }],
  missingNos: ['4421'],
  extraRows:  [{ no, design, shade }],
  truncated:  false,                                 // any list hit its cap
}
```

`approvalCards.docVerifyLine` renders the flagged rows under the summary,
one line per kind, confirmed bales staying a count because they need no
eye:

```
🔬 Bill check: 14 confirmed · 2 differ · 1 missing · 1 extra ⚠️
  ⚠️ 4412 (qty) · 4419 (shade)
  ❌ 4421 not on bill
  ➕ 4430 on bill, not in request
```

- The bracket is the reason **kind** the checker already names — `design`,
  `shade`, `pcs`, `qty` — deduplicated per bale. A number matched by
  details reads `847 (bill reads 2522)`, because there the bill row the
  approver must find carries the OTHER number.
- Each line shows at most 8 numbers, then `+N more`.
- A row checked before VRF-4 has counts and no rows: it renders exactly as
  before. Nothing old breaks.
- The single-bale sale card (`sell_package`, the Lagos Sell Bale door)
  never appended the 🔬 line at all, though its bill was checked and the
  counts persisted. It now carries the same line in the same place.

### Layer 2 — 🔬 Bill check chip in the inbox

On the inbox item card, beside **📄 Sales bill**, when the row carries
VRF-4 detail. Tapping it sends the full verdict — every flagged bale with
its complete reason text — rebuilt from the persisted record by the SAME
`buildVerdictMessage` that wrote the original, so the two can never
disagree. The header uses the APX-4 short ref (`R-1B57`), never the raw
UUID. The message is an ephemeral peek under the SAB-1 contract: swept on
the next inbox tap, and by the minutely TTL backstop.

The chip is not offered for a pre-VRF-4 row: it could only repeat the
card's own line, and a chip that says nothing new teaches the thumb to
skip it.

## Cost and surface

- **No second OCR read.** Everything comes from the read VRF-1 already
  paid for.
- **No new sheet, no new column.** The rows live inside the existing
  `actionJSON` cell on the ApprovalQueue row, a few hundred bytes for a
  typical sale. Lists cap at 200 entries and reason strings at 160 chars;
  a cap sets `truncated`, and the replay says so rather than passing a
  shortened list off as the whole.
- **No controller edit, no new callback namespace.** `abx:chk:` rides the
  inbox flow's existing `abx:` prefix and is routed inside the flow module.
- **No approval semantics touched.** The check stays advisory; approve and
  reject are unchanged.
- **The live follow-up message still goes out** exactly as before at OCR
  time. VRF-4 adds surfaces; it removes none.

## Deliberately left out

- Editing the original DM approval card in place once the OCR finishes.
  That needs the approval-events router to remember each admin's card
  message id — a parked-file change the owner did not ask for. The inbox
  card, reminders and the pending list all carry the numbers; the DM card
  is followed by the verdict message as today.

## Tests

- `test/unit/services/saleBundleCard.test.js` — card lines for differ,
  missing, extra; the `bill reads` form; the 8-per-line cap; a counts-only
  record renders the summary alone; `sell_package` card carries the line.
- `test/characterization/saleDocVerify.test.js` — the persisted record's
  rows; replay parity: `verdictMessageFromRecord` reproduces the body of
  the live verdict line for line; truncation flag and notice.
- `test/characterization/approvalsInboxFlow.test.js` — numbers on the
  inbox card; chip offered with detail, absent without; tap sends the
  verdict; the peek is swept on the next tap.

## Manual checks once live

See the test-steps PDF handed over with the ship: a bale sale with a bill
that disagrees on one bale; the card lists the number; the chip replays
the full reason; the next tap sweeps the replay; an old pending sale still
opens and reads as before.
