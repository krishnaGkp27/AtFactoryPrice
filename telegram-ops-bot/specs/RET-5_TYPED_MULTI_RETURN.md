# RET-5 — The typed multi-bale return (`Return 771, 779, 6189/5`)

**Status:** SHIPPED 20-Oct-2026 (owner's Go the same day). Owner live check in §6.
**Owner's words (20-Oct-2026):** *"Seems like a sale/sell script. For example, sell bale
number / the than inside, separated by commas. I need the script for returning it. Once
submitted, it opens up the card to select the than corresponding to the customer … it will
add it all together whichever bale is selected, after all selections, it will show the final
card for approval. Then it goes to admin."* Then: *"No need to write customer name — it
will show up when the employee selects the bale number and than from it, as like in sell.
Don't make it bound to return from single customer only."*

## 1. Rulings (chat, 20-Oct-2026 — all five as recommended, "Go")

| # | Ruling |
|---|---|
| R1 | ONE request per typed line — new action code `return_bundle` (the twin of `sale_bundle`), dual-admin like every return. |
| R2 | One date, one condition, one photo per line. Goods in a different state go as a second line. |
| R3 | Bales sold from different stores may share a line; each goes back to the store it was sold from (TRF-INT4). The header names every store. |
| R4 | The old typed line ("Return than 2 from Bale 5801" / "Return Bale 5801") opens this same review card. RET-1's preview (`startTypedReturnPreview`, `rtx:*`) is retired — it raised a request with no date, condition or photo. |
| R5 | The ↩️ Return goods tile (RET-4, `returnFlow`) stays for someone without the numbers in hand. |
| — | The customer is never typed and never a boundary: every than carries the buyer the sale record names; one line may return several customers' goods, each credited separately. A name typed after the numbers is ignored and said so. |

## 2. The line

`Return 771, 779, 6189/5, 6210/1+2, 700 x3` — the sell line's grammar (`thanListParser`):
a comma starts a new bale; a bare number is the whole bale (every than of it still sold,
whoever bought them); `6189/5` one than; `6210/1+2` several thans of one bale; `700 x3`
opens the bale with its chips UNTICKED (SELL-T3 §2). Only the pure number list is parsed
locally (`looksLikeReturnList`); a worded line goes to the AI intent, whose `return_than` /
`return_package` now redirect into the same card (R4).

## 3. Screens

1. **Review** — `↩️ Return · 🏭 Lagos + Kano office` · `📦 2B + 1t · 330 yd · 2 customers`,
   then the goods block grouped by buyer → design → shade heading with its catalogue colour
   → one serial-numbered line per whole bale (`771 · 150 yd`) or per than (`6189/5 · 30 yd`);
   `📦 Loaded with every sold than: 771, 779 — tap 🔎 Open to drop one.`; `⚠️ Not loaded (n)`
   with a reason per token (not found · nothing sold, N thans in stock · still on the road ·
   than n is not sold / does not exist · sold from two places or containers · already on the
   list); `💰 Credits: Kafaya 375,000 · ABBA 37,500 (at the rates charged)`. Chips: `🔎 Open
   <bale>` per bale · `✅ Continue — date, condition, photo` · `➕ Add more` · `❌ Cancel`.
2. **🔎 Open** — `↩️ Return · Bale 771 · 9060-A · 01 - Black`, `#6 is in stock — not part of
   this return.`, every chip ticked and naming its buyer (`☑ #4 · 30y · ABBA`), `⬜ Untick all`
   / `✅ Tick all n`, `⬅ Back to list`.
3. **Date · condition · photo** — the RET-4 cards verbatim (quick day chips + calendar up to
   `SALE_CALENDAR_MAX_DAYS_BACK`; Good / Damaged / Cut / Other + typed note; one photo or
   skip), one of each for the line.
4. **Confirm** — `↩️ Confirm return · 🏭 …`, the facts line, the goods block, `Σ 2B + 1t ·
   330 yd`, the credit line, `Queues dual-admin approval.`, `✅ Submit for approval`.
5. **Submitted** — `📦 2B + 1t · 330 yd · ABBA, Kafaya · ⏳ Waiting for two admins to sign ·
   Request R-…` (an admin's own submit counts as signature 1).
6. **Admin card** (DM to every admin, 🛂 Approvals → ↩️ Returns & reversals, the hourly
   reminder; the photo follows) — the same goods block, `💰 Kafaya 375,000 · outstanding
   1,462,500 → 1,087,500` per buyer, `🔏 Dual-admin return — n signed so far.`
7. **Result** — `↩️ Credited ABBA 37,500 (1 than, 30 yd) · Kafaya 375,000 (10 thans, 300 yd).`
   and `⚠️ Skipped: 779/3 (now sold to ABBA) — nothing flipped, nothing credited for them.`

A whole-bale LINE means the whole bale: every sold than ticked AND nothing of it on the shelf.
A bale with a than still in stock, or split between two buyers, prints per than.

## 4. Build

| Piece | Where |
|---|---|
| Parser | `src/utils/thanListParser.js` — `looksLikeReturnList`, the verb stripped in `parseThanList` |
| Flow | `src/flows/returnBundleFlow.js` (`return_bundle_flow`, `rb:`) — `loadLine` (pure), `resolveBuyers`, `buildActionJSON`, the cards, `startWithLine`, `handleText` (➕ Add more, the note, a typed date), `handlePhoto` |
| Goods block | `approvalCards.returnBundleLines(aj, esc)` — ONE builder for the review, confirm and admin cards; `buildReturnBundleCard(aj)`; `buildCardFromActionJSON` dispatch |
| Gate | `src/risk/evaluate.js` — `return_bundle` in WRITE / ALWAYS_APPROVAL / DUAL_ADMIN, label `return`; not in the intent enum |
| Inbox | `approvalsInboxFlow` — `return_bundle` under ↩️ Returns & reversals (dual badge) |
| Executor | `inventoryService.executeApprovedAction` `return_bundle` — one live read, every than re-checked (sold, same buyer by name or id, one container), flipped through `stockEngine.returnThan` (sold-from store, the returned-on date), then ONE Transactions row + ONE ledger credit PER BUYER (`txnId RB-<request>-<n>`), the credit note in the card's buyer order, AuditLog `return_bundle` |
| Controller | the local `Return …` door after the sell line; `return_than` / `return_package` intents redirect; photo + text hooks; `rb:` dispatch; RET-1's preview and `rtx:*` deleted |
| Request row | `actionJSON = { action, items[{packageNo, thanNo, baleUid, warehouse, design, shade, arrivalBatch, yards, pricePerYard, soldTo, customer, customerId}], wholeBales[], groups[{customer, customerId, thans, yards, amount, noRateThans, qty}], stores[], qty, thans, yards, returnedOn, condition, conditionNote, return_photo_file_id, return_photo_type }` |

Tests: `test/unit/utils/thanListParser.test.js` (the return verb), `test/unit/flows/returnBundleLoad.test.js`
(load reasons, grouping, whole-bale rule, the lines and the card), `test/characterization/returnBundleFlow.test.js`
(line → review → open/untick → date → condition → photo → confirm → one request → two admins
→ flips + a credit per buyer; R4; ➕ Add more), `typedReturnPreview.test.js` re-pinned to the fold-in.

## 5. Not done (say the word)

- Batching: the executor still flips one than per write (as `return_thans`); a 30-than line is
  30 writes behind the QTA-1 governor. Batching returns is on the QTA-1 §8e list.
- A condition per bale on one line (R2 chose one per line).
- Removing `buildReturnCard` and the `return_than` / `return_package` executors: legacy rows
  may still sit in the queue, so they stay.

## 6. Owner live check

1. Type `Return <a sold bale>, <another sold bale>/<than>` where the two bales went to
   different customers. Expect one card, two 👤 groups, a `🔎 Open` chip per bale, the
   credits line naming both.
2. `🔎 Open` the whole bale, untick one than, `⬅ Back to list` — the tally and credit drop.
3. `✅ Continue` → Today → Good → ⏭ Skip photo → the confirm card → Submit. Both admins get
   one card with both groups; the inbox lists it under ↩️ Returns & reversals.
4. Two admins approve. Expect: the thans available again in the store each was sold from,
   the unticked than still sold, ONE Transactions row per buyer, each statement credited by
   the amount its group showed, the reply `↩️ Credited A … · B …`.
5. Type `Return than 2 from Bale <n>` the old way — the same review card opens.

## RET-7 (20-Nov-2026) — one way to type a return

**Why.** Abdul typed a return three ways and got the generic chips card each
time:

```
Return 631/1+2+3+4+5,614/1 to Idumota
Return package 631/1+2+3+4+5,614/1 to Idumota
Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota
```

The first answer (RET-6, the same morning) taught the line to read the words
around the numbers — `package`, the buyer, the store. Three adversarial
checks in two hours showed where that leads: every wording a person can add
is a new way for a count, a phone number, a date or a design number to be
read as a bale. Owner, the same day:

> "I want to close all other door of this script … a single window should be
> there for all this process so that they should not go and make any mistake
> for my employees."

RET-6 was taken out again. **There is one line.**

### The one line

```
Return 631/1+2+3, 614
```

| Typed | Means |
|---|---|
| `Return` | the word, then a space |
| `614` | the whole bale — every than of it that is sold |
| `631/1` | than 1 of bale 631 |
| `631/1+2+3` | thans 1, 2 and 3 of bale 631 |
| `,` | between bales (a space or a new line also works) |

Numbers only: no customer name, no store, no `package`, no sentence. The
buyer and the store come from the sale record (R3), as before. Capitals,
extra spaces and line breaks do not matter. (`631/1-3` for a range and
`771 x3` for "three thans, I tick which" still work; they are not taught.)

This is the RET-5 reader, unchanged — compared with the reader of 19-Nov on
200,000 lists and 200,000 sell lines: the same items every time. One
addition: what it cannot place in the line (`Return 631-635` leaves `-635`)
is now listed under `❓ Could not read` on the card; before, it was dropped
without a word.

### Every other message that opens with Return

`Return …`, `Returns …`, `Returned …`, `Returning …` followed by anything
that is not the one line — a name, a store, `package`, a sentence, nothing
at all — gets this card, in every AI mode, and nothing else happens:

```
↩️ Return — type it one way only

Return 631/1+2+3, 614

• the word Return, then the bale numbers
• one than: 631/1
• several thans of one bale: 631/1+2+3
• a whole bale: 614
• a comma between bales

Numbers only. No customer name, no store, no other word.
The bot takes the buyer and the store from the sale record.
[🏠 Menu]
```

The bot does not pick numbers out of the words, does not ask the AI, and
does not send the generic chips card. The old worded lines that opened with
the word (`Return than 2 from Bale 5801`, `Return Bale 5801` — R4) get this
card too. A sentence that does not open with Return and that the AI reads
as a return (only when `AI_TEXT_PARSER` is `1`) still opens the review card,
as R4 says.

### On the open return card

The same rule (the list, 🔎 Open and ➕ Add more steps). A line typed while
the card is open is added when it is numbers only — `614/1`, or the whole
line `Return 614/1`. A line that opens with a number or with Return but
carries words (`700 to Idumota`, `Return 700 to Idumota`) is refused and
said — `❓ Numbers only here, like 631/1+2+3, 614. Nothing was added.` A
line that opens with any other word (`Sell 614/1`, `Stock 9006 black`,
`Transfer 700 to Lagos`) is not the card's and goes to its own door.

**One return at a time.** Once the return is past its list (date,
condition, photo, confirm), a new Return line used to replace it without a
word. It is refused now: `↩️ You have a return open. Finish it, or tap
❌ Cancel on it. Then type the new line.` A condition note that begins with
the word is still taken as the note.

### Small things that are not wording

- A full stop at the very end of the one line (phone keyboards add one).
- What stands in front of the word: `/return …`, `please return …`,
  `pls` / `kindly`, an emoji. These get the one-way card like any other
  wording — they do not slip past to the AI or the chips card.
- A line in the one format whose only piece cannot be read
  (`Return 631/5-3`) gets the one-way card with `❓ Could not read: 631/5-3`
  above it.
- A line read only in part (`Return 631-635`) opens the card with
  `⚠️ Part of your line was not read. Check the list before you continue.`
  at the top, and the piece under `❓ Could not read`.

### Code

- `thanListParser.isReturnLine` — does the message open with the verb;
  `looksLikeReturnList` — is it the one line (unchanged).
- `telegramController` — the return door: the one line opens the card (as
  before); any other Return message → `returnBundleFlow.sendFormatCard`
  (four lines added, owner's request).
- `returnBundleFlow.sendFormatCard` / `formatCardText`; `handleText` applies
  the rule on the open card.

### Not changed

The ↩️ Return goods tile (R5) is still in the menu for someone without the
bale numbers. Say the word and it is closed too, so that the typed line is
the only door.

**Tests.** `test/characterization/typedReturnOneWay.test.js` (the one line;
Abdul's three lines and seven other wordings in all three AI modes; what
cannot be placed is reported; the open card), `typedReturnPreview.test.js`
(the R4 redirect, with sentences that do not open with Return).

**Guide for Abdul.** `docs/RET-7_RETURN_LINE_ABDUL.pdf`.
