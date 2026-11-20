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

## RET-6 (20-Nov-2026) — the words around the numbers

**Why.** Abdul typed a return three ways and got the chips card each time:

```
Return 631/1+2+3+4+5,614/1 to Idumota
Return package 631/1+2+3+4+5,614/1 to Idumota
Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota
```

The return line took only a bare list of numbers. `package`, `from soldier
madam` and `to Idumota` each sent the line to the sentence path, which is
switched off (TXT-1). Owner: *"Fix it immediately."*

**What the line reads now** (`thanListParser.splitReturnLine`, still parsed
locally, no AI):

| Typed | Read as |
|---|---|
| `Return 631/1+2+3+4+5, 614/1` | the list, as before |
| `package` · `bale` · `pkg` · `no` in front of the numbers | nothing — set aside |
| `from Soldier Madam` (before or after the numbers) | the buyer the goods come back from |
| `to Idumota` · `at` · `in` · `@` | the store they come back to |
| `than 2 from bale 5801` · `bale 631 than 3` | `5801/2` · `631/3` |
| a bare word after the numbers (`… idumota`) | the store when it names one on the list, else the buyer when it names one |
| a date (`18 Nov`) | set aside — the date step asks |

Not claimed (they get the Return hint line): a count (`Return 5 bales of
9006`), a line with no number list (`Return the goods`).

**The sale record still decides (R3 stands).** The typed buyer and store are
CHECKED, never used:

- they agree with the sale record → nothing is printed (the header already
  names the store, the groups name the buyer);
- the store differs →
  `⚠️ You wrote "to Lagos". Returned goods go back to the store they were sold from: 631 → IDUMOTA.`
- the buyer differs →
  `⚠️ You wrote "from Abba". The sale record names another buyer: 631 → Soldier Madam. The credit goes to the buyer on the sale record.`
- a word that names neither →
  `ℹ️ I did not use "urgent". The buyer and the store come from the sale record.`

The two `⚠️` lines show on the review card and the confirm card, ride the
request as `actionJSON.typedNotes` (the executor does not read it; the
duplicate detector ignores it) and print on the admin's card as
`⚠️ The requester wrote …` — so goods that physically went to another store
get a transfer after the return is approved.

The old line `ℹ️ I ignored "<name>" — the buyer comes from the sale record.`
is gone: a name is now checked, and silent when it is right.

**Not built.** Changing where returned goods go (R3) or who is credited from
the typed words. If Abdul often receives returns at a store other than the
one that sold the goods, that is an owner ruling: either the return may name
the receiving store, or the bot offers a transfer right after approval.

**Tests.** `test/characterization/typedReturnWords.test.js` (the three lines
through the real controller; both differences; the admin card),
`test/unit/utils/thanListParser.test.js` (RET-6 block).

