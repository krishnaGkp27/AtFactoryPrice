# RET-8 — the return's missing rate, and a shorter approval card (CARD-8, CARD-9)

Shipped 20-Nov-2026. Three changes, one owner decision. Builds on RET-3
(credit at the booked rate), RET-5 / RET-7 (the typed return line) and the
PRC-2 amount step (`specs/PRC-2_ASK_AN_ADMIN.md`), whose guards it copies.

## 1. Owner's words

On 20-Nov-2026 the owner sent a screenshot of a return approval card:

```
🔔 Approval required

Ref:
c677c134-c1c2-4c3b-a889-789fd73a15bf
From: Abdul

↩️ Return · IDUMOTA · 1B + 1t · 180 yd
📅 14-Nov-2026 · ✅ Good · 📎 Photo attached

👤 solder madam · 1B + 1t · 180 yd
44200
 Shade BLACK
  1. 631/1 · 30 yd
  2. 631/2 · 30 yd
  3. 631/3 · 30 yd
  4. 631/4 · 30 yd
  5. 631/5 · 30 yd
  6. 614/1 · 30 yd

⚠️ solder madam: no rate on record — the stock comes back, but NO credit will post.
…
All return operations require two-admin approval.

Use buttons below to approve or reject.
```

He asked: *"Explain all in brief, And any other optimization?"* Four changes
were proposed. He answered: *"Go with all your recommendations."*

| # | What was wrong | Change |
|---|---|---|
| 1 | The header says `1B` for bale 631, the list prints its five thans one by one | **CARD-8** — a full bale is ONE line |
| 2 | Nothing says when the goods were sold | **CARD-8** — the buyer line says `· sold 02-Nov-2026` |
| 3 | A long raw reference, two lines that say nothing | **CARD-9** — `· R-C677` on the header line, two lines dropped, on every request type |
| 4 | No rate on the sale record → the return is approved with NO credit; the only remedy is posting it by hand | **RET-8** — the admin who approves first types the rate, and the credit posts with the return |

## 2. Rulings (owner, 20-Nov-2026)

- **R1** A return whose sale record has no rate: the admin who approves enters
  the rate, and the credit posts with the return.
- **R2** An entered rate never replaces a rate that is on the sale record.
- **R3** "No credit" happens only when an admin chooses it on purpose
  (`⏭ No credit for these`), never by default.

Recorded in `docs/BUSINESS_RULES.md` (§6d, the RET-3 / RET-8 bullet, and the
rulings table, 20-Nov-2026).

## 3. CARD-8 — the return card

### 3a. A full bale is one line

A bale is **whole** on a return when every than of that bale is on the return,
for one buyer — however it was typed: `Return 631`, `Return 631/1+2+3+4+5`, or
ticked than by than on the card. The bale's true size is read from the
Inventory rows, never from what was typed. The rule is the one that counts a
`B` in the header (the house labeller), so the header and the list can never
disagree.

A whole bale prints one line: bale · thans · yards. A bale that is not whole
keeps one line per than.

Before:

```
👤 solder madam · 1B + 1t · 180 yd
44200
 Shade BLACK
  1. 631/1 · 30 yd
  2. 631/2 · 30 yd
  3. 631/3 · 30 yd
  4. 631/4 · 30 yd
  5. 631/5 · 30 yd
  6. 614/1 · 30 yd
```

After:

```
👤 solder madam · 1B + 1t · 180 yd · sold 02-Nov-2026
44200
 Shade BLACK
  1. 631 · 5 thans · 150 yd
  2. 614/1 · 30 yd
```

- One than left in a bale and it comes back: `9300 · 1 than · 30 yd`.
- A bale whose thans went to TWO buyers is never whole: each buyer's thans
  print one per line, and the header counts them as thans (`5t`, not `1B`).
- Unticking a than on the card after a whole-bale load un-wholes the bale.
- A store that lists stock in thans (Kano office, Settings
  `THAN_VISIBILITY_WAREHOUSES`) counts thans in the header, so its list prints
  thans too (`771/1 · 60 yd`) — the two now agree.
- Serial numbers count the lines printed, not the thans.

The same lines are on the admin's message, the 🛂 inbox, the hourly reminder,
and the requester's review and confirm cards.

### 3b. When the goods were sold

The buyer line ends with the day the goods were sold, from the sale record:

- one day: `👤 solder madam · 1B + 1t · 180 yd · sold 02-Nov-2026`
- several days: `· sold 02-Nov-2026 to 09-Nov-2026` (earliest to latest)
- day not known: nothing is printed.

### 3c. Requests already waiting

Requests raised from 20-Nov-2026 carry these facts on the request itself. A
return raised BEFORE it and still waiting gets them from the stock sheet when
the card is drawn (one read; if the read fails, the card prints as before). A
DECIDED request (✅❌ Decided in 🛂 Approvals, the ↩️ Revert card) prints only
what was stored — it never reads live stock.

## 4. CARD-9 — the approval message, every request type

Before:

```
🔔 Approval required

Ref:
c677c134-c1c2-4c3b-a889-789fd73a15bf
From: Abdul

<the request's card>

All return operations require two-admin approval.

Use buttons below to approve or reject.
```

After:

```
🔔 Approval required · R-C677
From: Abdul

<the request's card>
```

- The reference is the short form on the header line (`R-C677`). A transfer
  shows its own short form (`24Jul·03`). The buttons still carry the full
  reference; nothing reads it back from the text.
- `Use buttons below to approve or reject.` is gone.
- The reason line under the card prints only when it says something about THIS
  request (a backdated sale, `Contact detail changes are reviewed by an
  admin.`, and so on). `Sent for approval` and `… requires admin approval.`
  no longer print.
- **On a return only**, `All return operations require two-admin approval.`
  no longer prints: the return card already says
  `🔏 Dual-admin return — 0 signed so far.` On every other card (payments,
  office expenses, goods receipts, …) the two-admin sentence still prints, as
  before.
- `⚠️ Possible duplicate` names the other requests by short reference
  (`R-9A1B`), not by the first 8 characters of the raw id.
- The add-contact card's header reads the same: `🔔 Approval required · R-XXXX`.
- The two lines after a first signature print the short reference:
  `🔏 Request R-C677: your approval is recorded (1 of 2). Waiting for a second admin.`
  and `🔔 Request R-C677 (Return goods) has its first admin approval and needs a SECOND. …`
- When Telegram refuses the formatted message, the plain copy it falls back to
  reads the same, including the note above the card and the duplicate line.

## 5. RET-8 — the rate step

### 5a. What is a gap

A **gap** is one buyer and one design on the return with at least one than
whose sale record has no rate (empty or 0). It works on both return doors:
the typed line (`Return 631/1+2+3+4+5, 614/1`, many bales, many buyers) and
the ↩️ Return goods tile (one bale).

### 5b. The cards before anyone approves

The requester's confirm card (typed line):

```
💰 Credits: solder madam — no rate on record (at the rates charged)
⚠️ Thans without a rate: the approving admin is asked for the rate.
```

(The ↩️ Return goods tile: `⚠️ No rate on record for these thans: the
approving admin is asked for the rate.`)

The admins' message:

```
🔔 Approval required · R-1ACB
From: Abdul

↩️ Return · IDUMOTA · 1B + 1t · 180 yd
📅 20-Nov-2026 · ✅ Good

👤 solder madam · 1B + 1t · 180 yd · sold 02-Nov-2026
44200
 Shade 01
  1. 631 · 5 thans · 150 yd
  2. 614/1 · 30 yd

⚠️ No rate on the sale record: solder madam · 44200 · 6 thans. The admin who approves first is asked for it.
🔏 Dual-admin return — 0 signed so far.
⚠️ Reverses completed sales — verify the goods physically came back.
[✅ Approve] [❌ Reject]
```

### 5c. The first admin is asked

Musa taps ✅ Approve. Nothing is signed. A pop-up says `Type the rate first.`
and the step opens as a reply to the card:

```
↩️ Return R-1ACB · rate needed

solder madam · 44200
6 thans · 180 yd have no rate on the sale record.

Type the rate per yard this customer was charged, for example 1450.
Nothing is approved until you confirm.
[1,450/yd — last paid by solder madam]
[⏭ No credit for these]
[✏️ Type the rate] [✖ Not now]
```

- With two or more gaps the header reads `· rate needed · 1 of 2`, one prompt
  per gap.
- `1,450/yd — last paid by …` is the rate this customer last paid for this
  design (the same lookup as the sale wizard's Step 2). It is left out when
  there is none.
- `⏭ No credit for these` — the admin says on purpose that nothing is
  credited for this gap.
- `✏️ Type the rate` re-opens the step (also after a restart).
- `✖ Not now` — `Nothing was approved. The request still waits.`

What he may type:

| Typed | Answer |
|---|---|
| `1450` or `3.20` | taken |
| `0`, a minus number, words with a digit (`rate 1450`, `at 1450`, `price 1450`) | `⚠️ That is not a rate. Type a number above zero, for example 1450.` — the step stays |
| `1450.555` | `⚠️ A rate has at most two decimals, for example 3.20. Type it again.` |
| `cancel` / `stop` / `not now` / `exit` | `Rate step for return R-1ACB closed — nothing was approved. The request still waits.` |
| a line with no digit, or another typed line (`Return 6189/5`, `Sell …`, `Stock 9006`, a customer line) | the step closes the same way and the line goes to its own door |

A number typed while the step is open goes to the step, never to the bale
card reader. If another screen takes his chat while the step is open (the
inbox's ⬅ Back, a tile), the step message is rewritten
`Rate step for return R-1ACB closed — nothing was approved. The request still
waits.` with `✏️ Type the rate` to open it again.

### 5d. The check card

After the last gap is answered:

```
↩️ Return R-1ACB · check the credit

solder madam · 44200 · 6 thans · 180 yd
1,450/yd → credit 261,000
Outstanding 500,000 → 239,000

Your approval is the first of two. A second admin checks the rate.
[✅ Approve with this credit]
[✏️ Change rate] [✖ Not now]
```

- One block per gap. A gap answered "no credit" reads `no credit`.
- When the buyer also has thans on this return that DO carry a rate, the
  block adds `Credit for solder madam on this return: 117,000` — the figure
  that will post.
- `Outstanding … → …` is that buyer's balance before and after; it is left
  out when the ledger cannot be read.
- When his approval finishes the return, the last line reads
  `Your approval completes the return.`

Only `✅ Approve with this credit` writes anything. The rates are saved on the
request in one write, read back, an AuditLog line `return_rate_entered` is
written, and the same tap is his approval:

```
🔏 Request R-1ACB: your approval is recorded (1 of 2). Waiting for a second admin.
✅ You entered the rate and gave approval 1 of 2. A second admin checks it.
```

Nothing is approved, and he is told why, when: the save is refused
(`⚠️ Could not save the rate — nothing was approved. Tap again in a minute.`),
the request was decided meanwhile, another admin entered the rate first
(`Krishna already entered the rate for this return. Open the card to approve
or reject it.`), or what was saved reads back different. Once saved, the rate
is frozen: to change it, ❌ Reject and raise the return again.

### 5e. The other admins

Every other admin gets the full card again, now showing the credit:

```
🔏 1 of 2 — signed by Musa. Yours is the second approval.

🔔 Approval required · R-1ACB
From: Abdul

↩️ Return · IDUMOTA · 1B + 1t · 180 yd
📅 20-Nov-2026 · ✅ Good

👤 solder madam · 1B + 1t · 180 yd · sold 02-Nov-2026
44200
 Shade 01
  1. 631 · 5 thans · 150 yd
  2. 614/1 · 30 yd

💰 solder madam 261,000 · outstanding 500,000 → 239,000
   44200 at 1,450/yd — entered by Musa
🔏 Dual-admin return — 1 signed so far.
⚠️ Reverses completed sales — verify the goods physically came back.
```

(A gap answered "no credit" reads
`⚠️ solder madam · 44200 · 6 thans: no credit — chosen by Musa`.)

Krishna taps ✅ Approve — on this card or on his old one. Nothing is signed
yet (`Check the rate first.`); he gets the check card:

```
↩️ Return R-1ACB · check the credit

solder madam · 44200 · 6 thans · 180 yd
1,450/yd → credit 261,000
Outstanding 500,000 → 239,000

Musa typed this rate. Check it before you approve.
Your approval completes the return.
[✅ Approve · credit 261,000]
[✖ Not now]
```

(When Musa chose no credit: `Musa chose no credit for these. Check it before
you approve.` and `[✅ Approve · no credit]`.) Only that chip signs, and it
carries the rate it shows: if the rate changed in between, nothing is signed.

### 5f. When it completes

Krishna's reply:

```
✅ Request … approved by Musa + Krishna. Changes applied.
↩️ Credited solder madam 261,000 (6 thans, 180 yd).
✏️ solder madam · 44200 at 1,450/yd, entered by Musa
```

Abdul's card:

```
✅ Approved · 2 of 2
Return goods
✅ Musa · 20-Nov 22:00
✅ Krishna · 20-Nov 22:00
↩️ Credited solder madam 261,000 (6 thans, 180 yd).
Ref R-1ACB
```

The employee sees the credit, never the rate (the `✏️ … entered by` line goes
to admins only). With no credit chosen, the line reads
`↩️ No credit to solder madam — chosen at approval (6 thans, 180 yd).` — no
books alarm, nothing to post by hand.

### 5g. The rules

- **Who is asked:** the admin who taps ✅ Approve FIRST on a waiting return
  that has a gap, no signature and no rate entered. Only Railway `ADMIN_IDS`
  admins. The requester cannot enter the rate on their own return while
  another admin exists (`🔒 You cannot enter the rate on your own request — a
  second admin must.`); a sole admin may, or nothing they raise could clear.
- **What is saved:** on the request itself (no sheet, no column): one entry
  per gap — buyer, design, thans, yards, and the rate or "no credit" — and
  who entered it, when. AuditLog `return_rate_entered`.
- **Every signature names the rate it was given for.** Before the return
  completes, every signature must name the rate on the request now; if not,
  nothing is recorded: `⚠️ The approvals on this return were given for a
  different rate — nothing was recorded. Reject it and raise it again.`
- **A recorded rate always wins (R2).** A than that has its own rate on the
  sale record is credited at it; the entered rate fills only the thans that
  have none. One Transactions row and one ledger credit per buyer, as before.
- **When the credit booked is not the one approved** (a than's sale row
  gained a rate in between, or a than was skipped), the admins' reply says so
  by name: `⚠️ solder madam: credited 109,500, not the 117,000 the approvals
  were given for — 9300/1 now carries its own rate on the sale record
  (1,200/yd), and a recorded rate is always used.` The decided record then
  reads `💰 solder madam 109,500 credited (approved for 117,000)`; a buyer
  whose credit did not post reads `0 credited` or `credit not posted — the
  ledger entry failed`.
- **No credit on purpose (R3):** only through `⏭ No credit for these`. It is
  named on every card after it (`no credit — chosen by Musa`).
- **Requests signed before 20-Nov-2026:** a return that already has a
  signature and no entered rate finishes as before — no credit for the gap —
  and its card keeps the old sentence `⚠️ solder madam: no rate on record —
  the stock comes back, but NO credit will post.`
- **A return with no gap** never sees the step.
- The step stays open 30 minutes (an admin looks the rate up).
- Rates are kept to two decimals; a credit with kobo prints them
  (`30,199.80`) so the figure signed is the figure posted.

## 6. Where it lives

- `src/services/returnRate.js` — the pure logic: gaps, fills, the print each
  signature carries, the credit per buyer, the drift note.
- `src/flows/returnRateStep.js` — the step's screens and taps, behind the
  typed-return flow (`rb:rv` · `rb:rn` · `rb:re` · `rb:rc` · `rb:rx` · `rb:ry` ·
  `rb:rk`; typed step `admin_rate`).
- `src/utils/rateInput.js` — the rate parser shared with the sale wizard.
- `src/events/approvalEvents.js` — the seam under the per-request lock, the
  print on each signature, the check before the completing approval, the
  CARD-9 frame.
- `src/services/approvalCards.js` — CARD-8 lines and the rate lines on the
  return cards; `reasonFact`.
- `src/services/inventoryService.js` — the two return executors.

## 7. Live check (two admin phones + Abdul)

Find goods whose sale record has no rate (Inventory column J `PricePerYard`
empty or 0, status `sold`), for example a whole bale and one than of another
bale sold to the same customer.

1. **Abdul** types `Return 631/1+2+3+4+5, 614/1` (your own numbers). On the
   card check: the whole bale is ONE line (`631 · 5 thans · 150 yd`), the
   buyer line ends `· sold <day>`. Continue → date → condition → photo →
   the confirm card says `⚠️ Thans without a rate: the approving admin is
   asked for the rate.` → ✅ Submit for approval.
2. **Musa's phone**: the message starts `🔔 Approval required · R-XXXX`,
   no long reference, no `Use buttons below`, no `All return operations …`
   line; it says `⚠️ No rate on the sale record: … The admin who approves
   first is asked for it.`
3. **Musa** taps ✅ Approve → `rate needed`. Type `0` → `That is not a rate`.
   Type the real rate (e.g. `1450`) → the check card shows the credit and the
   outstanding before and after. Tap `✅ Approve with this credit`.
4. **Krishna's phone**: the full card arrives again with
   `🔏 1 of 2 — signed by Musa`, the credit and `entered by Musa`. Tap
   ✅ Approve → the check card `Musa typed this rate.` → tap
   `✅ Approve · credit …`.
5. Krishna's reply names the credit and the rate; **Abdul** gets
   `✅ Approved · 2 of 2` with the credit and no rate.
6. Open the customer's statement (📒 / `Ledger <name>`): the credit is there,
   once, for the amount on the check card. The Inventory rows are back to
   `available`.
7. Once more with `⏭ No credit for these`: the second admin's chip reads
   `✅ Approve · no credit`, the statement does not move, and nobody is told
   to post anything by hand.
8. Any other request (a payment, a supply request): its message also starts
   `🔔 Approval required · R-XXXX`, with no `Use buttons below`.

## 8. Not done

- The two older single-than / single-bale return doors (`return_than`,
  `return_package`) do not get the rate step; the typed line and the
  ↩️ Return goods tile do.
- A ↩️ Return goods request raised before 20-Nov-2026 and still waiting
  carries only its average rate: if some thans had a rate and some did not,
  it is not seen as a gap and finishes as before (no credit for the unrated
  thans).
- If the admin had their own typed return open when they tapped ✅ Approve,
  that draft is closed to open the rate step (the step says so).
- Screens that still print the raw request reference, left for a later pass:
  the requester's `Request: <id>` on the submitted return, the
  `✅ Request <id> approved …` reply, `⚠️ Your request (<id>) was approved
  but could not be completed`, `❌ Request <id> rejected.`, the bill and
  preview captions, the dispatch-decline note, and a few error lines.
- Reason lines that still print and may be filler — your word:
  `Admin approval required`, `2nd admin approval required…`,
  `All <x> operations require 2nd admin approval.` (an admin's own request),
  and the reminder's `Pending approval`.
- PAY-3 C1–C3 (the shorter payment card itself) still wait for your word;
  CARD-9 shipped only the message around every card.
- On a decided record, a buyer with no gap still prints the amount signed,
  even if that buyer's ledger credit failed (the reply's failure list says
  so).
- Guides: the PRC-2 and RET-7 guides were rebuilt from the new cards. The
  PAY-6 guides could not be rebuilt (their capture stops at the
  Payment Received "Who should approve it?" step added on 16-Nov). Older
  static guides still quote the old frame: the Edit Bale test script, the
  Shade Photos guide, the PAY-2 guides, the than-sale guide.
