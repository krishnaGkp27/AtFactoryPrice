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

### Two readers, kept apart

| Line | Reader | Behaviour |
|---|---|---|
| the PURE list — numbers, commas, `/`, `+`, `-`, `x` and nothing else | `parseThanList`'s own code | exactly as RET-5 read it (checked against the pre-RET-6 reader on 150,000 lists: no difference) |
| a line with words | `thanListParser.parseReturnWords` | a token scanner written for returns |

Sell lines are untouched (150,000 lines compared: identical).

### What the scanner reads

Every token is one of three things:

| Token | Becomes |
|---|---|
| `631/1` · `631/1+2+3` · `631/1-3` · `771 x3` | an item |
| a bare number of two to six digits, no leading zero | an item (a whole bale) |
| `than 2 from bale 5801` · `bale 631 than 3` | `5801/2` · `631/3` |
| any other number — a count (`10 thans`, `12 days`), a phone number, `24hrs`, `10:30`, `x3`, `design 9043`, a single digit | **reported** under `❓ Could not read`, never loaded, never dropped |
| a date (`18/11/2026`, `18 Nov`, `18 Nov 2026`) | set aside — the date step asks. A bale is never taken for a year (`18 Nov 6189` keeps bale 6189) |
| a word | filler (`package`, `bale`, `pls`, `abeg` …) is dropped; the rest are the buyer or the store |

In a return the small words mean the opposite of a sale: **`from` names the
buyer** the goods come back from, **`to` / `at` / `in` / `@` the store**. A
word with neither in front (`Return 631/1 idumota`,
`Return soldier madam 631/1 …`) is kept as it is.

**When the line is claimed** (`looksLikeReturnList`): its FIRST number is an
item, and the line is about the numbers — nothing but filler in front of
them, or `from <buyer>`, or a short name followed by an item written with
`/` or `x`. Not claimed (the Return hint answers): `Return 5 bales of 9006`,
`Return 2 thans 631`, `Return from Abba 08012345678`, `Return policy 2026`,
`Return the goods`. A line with words longer than 1,500 characters is not
read.

### The sale record still decides (R3 stands)

The typed buyer and store are never used. They are shown beside the record
whenever they are not exactly the record's own name:

| Typed against the record | Card |
|---|---|
| the same words, any case or order (`to idumota` · `IDUMOTA`) | nothing — the header names the store, the groups name the buyer |
| some words agree (`to kano` · `Kano office`; `to Lagos` · `Lagos Island`; `from Musa` · `Musa Ibrahim`) | `ℹ️ You wrote "to kano". The store on the sale record: 810 → Kano office.` |
| no word agrees | `⚠️ You wrote "to Lagos". Returned goods go back to the store they were sold from: 631 → IDUMOTA.` · `⚠️ You wrote "from Abba". The sale record names another buyer: 631 → Soldier Madam. The credit goes to the buyer on the sale record.` |
| a word with no `to` / `from` that is neither the store nor the buyer | `⚠️ You wrote "urgent". The store and the buyer come from the sale record: 631 → IDUMOTA · Soldier Madam.` |

The bot does not guess which store or customer a short or misspelt name
"means": whole words only (`ali` is not `Alimat Bello`), accents folded,
any script. Each typed line is checked against the bales it names (a bale
already on the card included). At most six lines are kept, a long typed
name is clipped to 40 characters, and a seventh line says how many more.

The lines show on the review card and the confirm card, ride the request as
`actionJSON.typedNotes` (the executor does not read it; the duplicate
detector ignores it) and print on the admin's card as
`⚠️ The requester wrote …` — so goods that physically went to another store
get a transfer after the return is approved.

The old line `ℹ️ I ignored "<name>" — the buyer comes from the sale record.`
is gone.

### How it got here

The first cut went live straight after its own tests passed. Two adversarial
reviews the same hour found that patching the sale's reader for returns had
left gaps — a bale typed after the words was dropped without a word, a
count in front of a bale was read as the bale, one pattern froze on
thousands of spaces, and the plain list had gained items out of leftovers
(`Return 631-635`). The word-reading was then rebuilt as the scanner above,
beside an untouched plain-list reader, and the name check was reduced to
"silent only on the record's own name".

**Left as is.** `Return 50000 to Abba` opens the card with `50000 — not
found` (a five-digit number can be a bale). A numeric date without a year
(`18/11`) is the item syntax and is read as bale 18, than 11. A registered
alias of the buyer gets the `ℹ️` / `⚠️` line (the name typed is not the
record's). The SELL line still drops a number typed after its words
(`Sell 1100/1 to Abba 1091/1`) — it was not touched here.

**Not built.** Changing where returned goods go (R3) or who is credited from
the typed words. If Abdul often receives returns at a store other than the
one that sold the goods, that is an owner ruling: either the return may name
the receiving store, or the bot offers a transfer right after approval.

**Tests.** `test/characterization/typedReturnWords.test.js` (the three lines
through the real controller; every card line; the admin card),
`test/unit/utils/thanListParser.test.js` (the RET-6 blocks).
