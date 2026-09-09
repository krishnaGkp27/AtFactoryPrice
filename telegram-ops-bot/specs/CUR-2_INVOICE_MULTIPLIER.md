# CUR-2 — Invoice rate multiplier: release A SHIPPED 09-Sep-2026 (Settings-fulfilled path), release B pending owner go

**Status (09-Sep-2026).** The owner approved the drawings and closed Q1–Q6
and D7 "as recommended", adding the integrity ruling now in
`docs/BUSINESS_RULES.md` §17: *the sheet's internal calculation happens
WITHOUT the multiplier; the base figures and the factor are recorded and
stored separately.* **Release A — §9 steps 0–3 — is shipped:** `Invoices`
column W `rate_multiplier`, the `INVOICE_RATE_MULTIPLIER` knob (Settings cell,
env boot default), the document rendered bare in both states from
`docFigures(invoice)` = stored base lines × stored factor, the staff caption
with its `Customer copy × <m>` line, rules 8–18 as tests. **Release B — §9
step 4 (the wizard's Step 5 in `approvalEvents.js`, `INVOICE_MULTIPLIER_ASK`)
and step 5 (the §17 closing sentence, which the owner approves verbatim) —
waits for the owner's live check (`specs/CUR-1_CURRENCY_DISPLAY.md` §11) and
his go.** Until then the multiplier has ONE door — the Settings cell — and
`resolveRateMultiplier` already reads the enrichment key `rateMultiplier`
when present, so release B plugs in without touching the freeze rule.

Release-A deviations from the text below, recorded so the record stays
honest: `config.invoiceRateMultiplier` is `null` (not `1`) when the env is
blank or invalid — `1` and blank both mean none downstream, so nothing
changes; `settingsRepository.DEFAULTS.INVOICE_RATE_MULTIPLIER` is the env
value or `''`; the 2-dp rate helper is `money.saleRate(n, { fraction: 2 })`
from `src/utils/money.js`, not a `fmtRate2` in `format.js`; the sale date on
the web copy's payment row landed with step 3 as drawn. The drawings and
rules below are otherwise what shipped.

The original proposal text follows. It draws the cards and the invoice
exactly as they print, so the owner could say "go" (or amend) before a line
of code changed. It closes the layout gate that `docs/BUSINESS_RULES.md` §17
and `specs/CUR-1_CURRENCY_DISPLAY.md` §10 left open. Every code reference
below was re-read on 08-Sep against `origin/main`.

Owner, 08-Sep-2026, after the CUR-1 research (his words, verbatim):

> "Make a two-variable currency. If I want to give the invoice to the customer
> directly, I will put the second multiplier on the rate which I provided, and
> that will fill the remaining fields dependent on it, using that multiplier
> with the rate (but without currency symbol). Freeze the label per invoice
> later with a new column. I am not working on the landed cost but I will make
> changes in those fields also as per the first value of currency, without the
> second variable and without currency symbol."

> "Show me the card and how it will look with an example if there is no
> multiplier or variable. It doesn't get converted into the local currency
> (Nigeria). In all the places where the second variable is fulfilled or
> supplied during approval, it will show the value in local currency but
> without the currency symbol."

Everything in CUR-1 R1–R18 and D1–D6 was closed **"as recommended"**; the two
quotes above are the amendments. What they mean in one breath: rates are
ENTERED and BOOKED in variable 1 and stay there everywhere; the customer's
copy of the invoice — and only that document — may be refilled from
`rate × multiplier`, printed bare; with no multiplier the document prints the
entered figures, bare and unconverted. No currency symbol or unit label
appears on the sales side at all (R12b/R13/R14).

---

> **Amended 09-Sep-2026 (owner, after release A):** the factor is INTERNAL.
> It is shown only on the Step 5 card while being entered, stored in column
> W and the AuditLog payload, and never printed anywhere else: not on the
> document, not on the caption, not on the approved reply or the requester's
> card, not on the sealed wizard card. Every "Customer copy × 1,250" line
> drawn in §3b (sealed card), §4b (caption) and §5 below is WITHDRAWN.

## 1 · The two variables

| | Variable 1 — the accounting unit | Variable 2 — the customer-copy multiplier |
|---|---|---|
| **Name** | `CURRENCY` | `INVOICE_RATE_MULTIPLIER` |
| **Where set** | Railway env only (`src/config/index.js:91`, read once at boot) | Three doors, in override order: (a) **wizard Step 5** for THAT sale (approving admin) → (b) **Settings cell** `INVOICE_RATE_MULTIPLIER` (global, live in ≤30 s, no deploy) → (c) **env** `INVOICE_RATE_MULTIPLIER` as the boot default of the Settings value (`DEFAULTS.INVOICE_RATE_MULTIPLIER = config.invoiceRateMultiplier`, §7) |
| **Default** | `NGN` | `1` (in `settingsRepository.DEFAULTS`) |
| **What blank means** | `NGN` (D6) — `config.currency` and `format.js DEFAULT_CURRENCY` both collapse blank to `NGN` | **no multiplier.** Note `settingsRepository.getAll()` turns a blank cell into `Number('') = 0` (`settingsRepository.js:200`), so the reader treats `0`, blank, `NaN` and `1` all as "none" — the document prints unconverted |
| **What it changes** | Only *text* that names the unit: ledger narrations (`accountingService.js:32,71`), the `NGN ` prefix of `format.js fmtMoney` (expense side), incentive rows. Never a number | Every money figure on the **invoice document** — PDF and web copy at `/i/<token>` — and the number frozen in the new Invoices column. The Telegram caption is a staff message, not the document: it keeps the booked figures and adds one `Customer copy × <m>` line (§4b, §5) |
| **What it never changes** | Any number anywhere; the multiplier | The entered rate, the Inventory price cell, the Transactions row, the ledger, the customer statement (SLED-1), the approval cards, the wizard chips, landed cost (R8) |

Variable 1 is deliberately **not** printed on the sales side (R12b): the
invoice with no multiplier prints `3.20/yd`, not `NGN 3.20/yd`. "/yd" names
the divisor; nothing names the unit.

One customer-facing consequence has to be said in one line (doubt D7, §10):
the SAME customer who holds the multiplied invoice (`DEBIT BALANCE
1,180,000`) can open the EXT-1 OTP ledger (`extLedgerService.js:397-398`,
`outstanding: running` from `accountingService.getCustomerLedger` — a §15b
website money view) and read outstanding `944`, variable 1. As recommended,
the invoice is the ONLY local-currency paper and the self-serve ledger stays
in variable 1 — a per-customer ledger cannot be multiplied because each
invoice may freeze a different factor. Step 3 does not ship before the owner
rules D7.

---

## 2 · The one worked example (used in every drawing below)

Sale approved 07-Sep-2026 · customer **Soldier Madam** · Design **77019** ·
Shades 1, 3 · **4 bales + 8 thans · 420 yds** · Kano office · salesperson
Abdul · invoice **INV-2026-0064**.

| Fact | Value | Unit |
|---|---|---|
| Rate ENTERED at Step 2 | `3.20` per yard | variable 1 |
| Amount paid at Step 4 | `400`, "Paid to GTBank" | variable 1 |
| Multiplier at Step 5 (or Settings) | `1,250` | — |

The arithmetic, stated once (D5: rate to 2 dp; line amounts, subtotal, total,
payments and balance are integers, `Math.round`, half-up as today):

```
BOOKED (variable 1, what the ledger / Transactions / statement hold)
  line amount   = round(420 × 3.20)            = 1,344
  subtotal      = total                        = 1,344
  paid          =                                 400
  debit balance = 1,344 − 400                  =   944        → PART-PAID

DOCUMENT with multiplier 1,250 (local currency, bare)
  local rate    = 3.20 × 1,250                 = 4,000.00 /yd
  line amount   = round(420 × 4,000.00)        = 1,680,000
  total         = Σ document line amounts      = 1,680,000
  payment row   = round(400 × 1,250)           =   500,000
  debit balance = 1,680,000 − 500,000          = 1,180,000   → PART-PAID

DOCUMENT with NO multiplier
  every figure = the BOOKED figure, bare, unconverted (3.20 / 1,344 / 400 / 944)
```

Rule for the document's own sums: the document total is the sum of the
document's line amounts and the document balance is `document total −
document payments`, so the printed column always adds up even when
`round(yards × rate × m)` and `round(yards × rate) × m` differ by a unit
(they cannot in this example; they can when the entered rate has more than
two decimals).

---

## 3 · The sale approval wizard

Runs in `src/events/approvalEvents.js` on ONE anchored card per request
(`pendingEnrichment` Map keyed `${adminId}|${requestId}`). Step 1 (customer)
is skipped when the request already names a buyer, as here. Steps 2–4 are
drawn **as they print today**, including the words this spec removes: the
`(Naira per yard)` / `(Naira)` in the Step 2 and Step 4 PROMPTS
(`approvalEvents.js:654`, `:699`, `:882`) and the `₦` on the last-paid chip
and the Paid-in-full chip. Nothing in CUR-1 removes them — R13 covers
rendered card money and R18 (ruled before the amendment) keeps input prompts
untouched. After the amendment the entered rate is variable 1 and explicitly
NOT the local currency, so "Naira" in this wizard is factually wrong: §9
step 4 rewrites the two prompt strings and strips the two chip symbols in
the same ask-first edit (rule 7), and §9 step 5 records R18 as superseded
for the sale wizard. `[bracket rows]` are inline keyboards.

### 3a · Today (steps 2–4, this example)

```
── Step 2 — Rate ──
📋 *Confirm sale — R-REQ1*

Customer: *Soldier Madam*
📒 Outstanding: ₦0
Design(s): 77019
Unit: yard (Naira per yard)

*Step 2 — Rate:* tap below, or reply with rate per yard.
• Single design: e.g. `1500`
• Multiple: e.g. `44200:1500, 44201:1200`
✍️ _A typed reply goes to the request you touched last._
[₦3.2/yd — last paid by Soldier Madam]
[✏️ Type a custom rate]
[✎ Change customer (Soldier Madam)]

  (admin types 3.20 → ratePerUnitByDesign = { "77019": 3.2 }, persisted to ActionJSON.enrichDraft)

── Step 3 — Payment mode ──
📋 *Confirm sale — R-REQ1*
👤 Soldier Madam

*Step 3 — Payment mode:* tap below, or reply with one of:
• Cash
• Credit
• Paid to [Bank]
• Not yet paid
✍️ _A typed reply goes to the request you touched last._
[💵 Cash] [🕐 Not yet paid]
[🏦 ZENITH BANK] [🏦 GTBank]
[✏️ Type payment mode]
[🏦 Manage accounts]

  (admin taps 🏦 GTBank → paymentMode = 'Paid to GTBank', persisted)

── Step 4 — Amount paid ──
📋 *Confirm sale — R-REQ1*
👤 Soldier Madam · Paid to GTBank

*Step 4 — Amount paid:* tap below, or reply with the amount received (Naira), e.g. 50000
✍️ _A typed reply goes to the request you touched last._
[✅ Paid in full — ₦1,344]
[✏️ Type the amount]

  (admin taps ✏️ Type the amount, types 400 → finishTyped(400) → card sealed "⏳ Applying…")
```

Today `finish()` (chip route, `approvalEvents.js:756`) and `finishTyped()`
(typed route, `:985`) build `{ unit, ratePerUnitByDesign, paymentMode,
amountPaid }` and hand it to `executeApprovedAction`. The 'Not yet paid' chip
(`:855-858`) and a typed `Credit` / `Not yet paid` (`:1009`) call the same finish
with `amountPaid 0`, skipping Step 4.

### 3b · With the new OPTIONAL step (drawn exactly)

The step is inserted **inside** `finish()` and `finishTyped()`, before the
enrichment object is built — so it reaches every route: Paid-in-full chip,
typed amount, and both amount-0 shortcuts. `state.step = 'multiplier'`;
`state.amountPaid` is held in state meanwhile. The step is asked only while
the Settings knob `INVOICE_MULTIPLIER_ASK` is `1` (its default, in
`settingsRepository.DEFAULTS`, shipped in step 4 itself — CLAUDE.md rule 4,
every tunable in Settings from the start; DUAL-1a made sales single-admin
because approval latency was blocking live sales, so the extra tap must be
switchable from a cell, not a deploy). At `0` the wizard finishes exactly as
today and the Settings-fulfilled path applies (§7 freeze rule, key absent).

```
── Step 5 — Customer-copy multiplier ──
📋 *Confirm sale — R-REQ1*
👤 Soldier Madam · Paid to GTBank · 400

*Step 5 — Customer-copy multiplier:* tap below, or reply with the number the entered rate is multiplied by on the customer's invoice.
_No multiplier = the invoice prints the rate exactly as entered (3.20/yd)._
✍️ _A typed reply goes to the request you touched last._
[No multiplier] [Settings: 1,250]
[✏️ Type a number]

  (admin taps Settings: 1,250 → toast "× 1,250")

── Card sealed (keyboard removed) ──
📋 *Confirm sale — R-REQ1*
👤 Soldier Madam · Paid to GTBank · 400 · × 1,250
⏳ Applying…
```

Rules of the step, numbered:

1. **Chips.** `[No multiplier]` always; `[Settings: <n>]` only when the
   effective Settings value is a number > 0 and ≠ 1 (blank / 0 / 1 = no chip);
   `[✏️ Type a number]` always. Chips are built with
   `wizCb(state, 'mult:none' | 'mult:def' | 'mult:custom')` (`:505-506`), so
   the wire payload Telegram carries is `enr:q:<requestId>:mult:none` etc.
   (APC-1 — the 64-byte check and the test fixtures are written against that
   form); the handler matches the unwrapped `enr:mult:…` after the `:718-721`
   strip. Existing `enr:` namespace — no new prefix.
2. **Accepted typed range.** A positive finite number, commas ignored,
   decimals allowed: `/^\d[\d,]*(\.\d+)?$/` after trimming, then
   `0 < m ≤ 1,000,000`. Anything else is refused in place:
   `Please enter a positive number for the multiplier, e.g. 1250 — or tap No multiplier.`
   and the card stays on Step 5.
3. **"No multiplier" means variable 1, and it is written down.** Tapping
   `[No multiplier]` writes `rateMultiplier: 1` — the key is PRESENT with the
   value "none" — so the invoice prints the entered figures bare and
   unconverted even when the Settings cell holds `1,250`. An absent key would
   fall through to Settings under the freeze rule (§7), so "absent" cannot
   mean "none"; the per-sale answer wins because it is explicit (see Q4).
4. **Enrichment key** `rateMultiplier` (number; **present whenever Step 5
   ran** — `1` from `[No multiplier]`, the Settings number from
   `[Settings: <n>]`, the typed number otherwise; **absent only when Step 5
   never ran** — `INVOICE_MULTIPLIER_ASK=0`, or rows from before this ships)
   appended to the object at `approvalEvents.js:763-768` and `:990-995`. It
   rides unchanged to `inventoryService.js:1820` (persisted on the queue row
   as `ActionJSON.enrichment.rateMultiplier`) and `:1825`
   (`invoiceService.createForSale`). There is no separate "wizard ran" flag
   anywhere; the presence of the key IS that flag.
5. **Resume — no draft key.** Step 5's answer runs `finish()` at once, so a
   persisted draft multiplier could only exist if the executor threw after
   the persist, and it would never be read back: `persistEnrichDraft`
   (`:565-568`) stays rate + paymentMode and the resume chain (`:596-606`)
   is untouched. Because `amountPaid` is not in the draft, a redeploy between
   the Step 4 answer and the Step 5 answer re-asks Step 4 and then Step 5 —
   the same rule the wizard follows today for the last unanswered step. The
   durable records are `ActionJSON.enrichment.rateMultiplier` and Invoices
   column W.
6. **No unit anywhere on this card** (R13): the header line prints `400`, the
   chip prints `1,250`, nothing prints a symbol.
7. **This is an `approvalEvents.js` edit — an ask-first file** (CLAUDE.md
   "must ask before doing"). The owner's go on this spec is the go for
   exactly these touch points in that file, and nothing else in it:
   (i) a new `sendMultiplierStep` renderer and its three chips; (ii) the
   `enr:mult:none|def|custom` chip handler in the callback dispatch;
   (iii) the typed handler for `state.step === 'multiplier'` (range check,
   refusal in place); (iv) `finish` / `finishTyped` (`:756-770`, `:985-997`)
   — insert the step, append `rateMultiplier` to the enrichment literal;
   (v) the approved-reply line after `:1099` and the `updateRequesterCard`
   headline at `:1112-1113` (§5); (vi) the two prompt strings at `:654`
   and `:699` / `:882` reworded to name no unit, and the `₦` stripped from
   the Step 2 last-paid chip and the Step 4 Paid-in-full chip (§3 intro).

---

## 4 · The invoice document, both states

Rendered by `invoiceService.renderPdf` (A5 portrait 419.53 × 595.28 pt,
margin 0, side margin 28; DejaVu Sans / Bold only) and the web copy at
`GET /i/<token>` (`invoiceWebController.renderHtml`). Today's render was
traced through the real `doc.text()` calls; the drawings below keep every
line, every position and the INV-1 structure, and change ONLY the money
strings (one of which is wrong today, not merely labelled — rule 8: the PDF
truncates a non-integer rate). Sites where a `₦` prints today (all removed):
status strip (×4 across the three states — PAID 1, PART-PAID 2, UNPAID 1),
`COST ₦` / `PAYMENTS ₦` column headers, `@ ₦…/yd`, DEBIT BALANCE, and the
three `₦` in the caption (`invoiceService.js:230-233, 242-243, 260, 289, 306`);
on the web copy the single `fmtMoney` helper (`invoiceWebController.js:38-40`).

### 4a · NO multiplier — every figure is the entered variable-1 value, bare

PDF text order (A5, positions as today; `|` marks a right-aligned column):

```
[header band 0..96, ink #20242a]
SOLDIER MADAM — ACCOUNT                                      ← bold 15, "— ACCOUNT" gold
INVOICE            SALE DATE          WAREHOUSE               ← 6.5 #8f97a3 at y 58
INV-2026-0064      2026-09-07         Kano office             ← bold 9 white at y 68
[status strip 96..120, cream #f7ead0]
              PART-PAID · 400 received of 1,344               ← bold 9 #7d5f1d, centred
                                                                (UNPAID → "UNPAID · 1,344 due"; PAID → "PAID · 1,344 settled")
DESCRIPTION                            COST|    PAYMENTS|     ← 6.5 muted, y 140 (headers lose their ₦)
──────────────────────────────────────────────────────────    ← 1.4 pt ink rule, y 151
Design 77019                          1,344|                  ← bold 9.5 / 9.5 ink, y 159
Shades 1, 3 · 4 bales + 8 thans · 420 yds @ 3.20/yd           ← 7.5 muted, width 205.53 (pdfkit wraps as today)
──────────────────────────────────────────────────────────    ← 0.5 pt #ece8dd rule
Total                                 1,344|                  ← 8.5 muted / 9.5 ink
2026-09-07 paid to GTBank account                   400|      ← 8.5 red / bold 9.5 red (row omitted when paid = 0)
══════════════════════════════════════════════════════════    ← 1 pt ink rule
DEBIT BALANCE                           944|                  ← bold 12 ink, amount right in the 140 pt box
                                                                (PAID → "0" — label still DEBIT BALANCE, as today)

  Secured with WhatsApp code · Live copy & PDF at the link shared with you   ← 6.5 #a49d8e, y 565.28
```

Telegram caption on the PDF (`INV-2026-0064.pdf`, sent to the approving
admin's chat and the requester, `approvalEvents.js:1128`):

```
🧾 INV-2026-0064 — Soldier Madam
Total 1,344 · Paid 400 · Balance 944
🔗 Live copy: <BASE_URL>/i/<token>
Forward this PDF (or the link) to the customer on WhatsApp.
```

Web copy (`/i/<token>`, 560 px sheet; only the money cells change):

```
SOLDIER MADAM — ACCOUNT
Invoice INV-2026-0064   Date 07-Sep-2026   Salesperson Abdul        [PART-PAID]

DESCRIPTION                                     | QTY     | RATE     | COST
Design 77019 · Shades 1, 3 · 4 bales + 8 thans  | 420 yds | 3.20/yd  | 1,344
Payment received 07-Sep-2026 — GTBank (Paid to GTBank) |  |          | − 400     (red, bold; date added in step 3 — today's web row is undated)

                                   Total cost ............ 1,344
                                   Payments .............. − 400      (red)
                                   ───────────────────────────────
                                   DEBIT BALANCE ......... 944        (bold, red because > 0)

[⬇ Download PDF copy]
This is a private statement link — do not forward it.
```

### 4b · Multiplier 1,250 — every figure × 1,250, bare, including the red payment row and DEBIT BALANCE

PDF text order:

```
[header band 0..96, ink #20242a]
SOLDIER MADAM — ACCOUNT
INVOICE            SALE DATE          WAREHOUSE
INV-2026-0064      2026-09-07         Kano office
[status strip 96..120, cream #f7ead0]
          PART-PAID · 500,000 received of 1,680,000
DESCRIPTION                            COST|    PAYMENTS|
──────────────────────────────────────────────────────────
Design 77019                      1,680,000|
Shades 1, 3 · 4 bales + 8 thans · 420 yds @ 4,000.00/yd
──────────────────────────────────────────────────────────
Total                             1,680,000|
2026-09-07 paid to GTBank account               500,000|      ← booked 400 × 1,250 (D2: same factor)
══════════════════════════════════════════════════════════
DEBIT BALANCE                     1,180,000|

  Secured with WhatsApp code · Live copy & PDF at the link shared with you
```

Telegram caption — the caption is a STAFF message (approving admin +
requester, "Forward this PDF…"), never the paper the customer holds. It lands
in the admin chat directly after `📒 Soldier Madam — Outstanding as of today:
944` (`approvalEvents.js:1119`, then `:1128`), so it prints the BOOKED figures
the ledger posts (the RET-3 card discipline: a number on a card is the number
the ledger moves by) and names the multiplier in one extra line:

```
🧾 INV-2026-0064 — Soldier Madam
Total 1,344 · Paid 400 · Balance 944
Customer copy × 1,250
🔗 Live copy: <BASE_URL>/i/<token>
Forward this PDF (or the link) to the customer on WhatsApp.
```

(With no multiplier the `Customer copy` line is absent and the caption is
§4a's.) If the owner instead rules that the caption is part of the document,
that is recorded in §5 as an explicit exception to the card discipline so the
next session does not "fix" it.

Web copy:

```
SOLDIER MADAM — ACCOUNT
Invoice INV-2026-0064   Date 07-Sep-2026   Salesperson Abdul        [PART-PAID]

DESCRIPTION                                     | QTY     | RATE         | COST
Design 77019 · Shades 1, 3 · 4 bales + 8 thans  | 420 yds | 4,000.00/yd  | 1,680,000
Payment received 07-Sep-2026 — GTBank (Paid to GTBank) |  |              | − 500,000

                                   Total cost ............ 1,680,000
                                   Payments .............. − 500,000
                                   ───────────────────────────────
                                   DEBIT BALANCE ......... 1,180,000

[⬇ Download PDF copy]
This is a private statement link — do not forward it.
```

What stays exactly as INV-1 locked it, in both states, **on the PDF**: the
`<CUSTOMER> — ACCOUNT` header with no business identity; the three-column
Description / Cost / Payments structure (decision 9 — only the `₦` inside the
header words goes, per R12b); the red, dated payment row naming the receiving
account (`invoiceService.js:292`); the `DEBIT BALANCE` wording; the packaging
words with yards alongside; the status strip. The page is the same frozen
snapshot it is today; nothing on it is read from the ledger.

The web copy has drifted from INV-1 before this spec: its payment row
(`invoiceWebController.js:71-76`) carries no date, and its table is
four-column Description / Qty / Rate / Cost (`:113`), not decision 9's
Description / Cost / Payments. Step 3 adds the sale date to the web payment
row (free while `fmtMoney` there is being replaced — the drawings above show
it); the column structure is an **INV-2 item**, not this spec's.

Number rules on the document (D5, R10):

8. **Rate** prints with exactly 2 dp — `3.20`, `4,000.00`. **Today the PDF
   prints a 3.2 rate as `₦3/yd`** — `invoiceService.js:27` aliases `fmtQty`
   (maxFraction default 0, `format.js:59-61`) as `fmtMoney` and `:260`
   formats the rate with it, so `(3.2).toLocaleString('en-NG',
   {maximumFractionDigits: 0})` → `3`: an integer truncation on the customer
   copy for ANY non-integer rate, a live defect. Only the web copy
   (`invoiceWebController.js:38-40`, maxFraction 2) prints `3.2`, and no
   helper pads to two places. The build adds `fmtRate2`
   (`minimumFractionDigits: 2, maximumFractionDigits: 2`, `en-NG`) beside
   `fmtQty` — or in the CUR-1 `money.js` if that lands first — and it
   replaces BOTH sites; the step-3 gate traces a non-integer entered rate.
9. **Amounts, totals, payments, balance** print as integers (`fmtQty`,
   maxFraction 0), on the web copy too — today's `maxFraction: 2` there is the
   R10 outlier and goes.
10. **No symbol, no unit label, no "× 1,250" note anywhere on the document.**
    The customer sees local-currency figures and nothing else (owner: "show
    the value in local currency but without the currency symbol").

---

## 5 · The admin's approved reply and the requester's card — variable 1, bare

Neither the approval request card (`approvalCards.buildSaleCard`, prints no
rate or value at all) nor the post-approve messages are touched by the
multiplier. They stay in variable 1. One line names the multiplier when one
was supplied; it is absent otherwise.

Admin, after "⏳ Applying…" (plain sends, `approvalEvents.js:1099-1119`; the
`NGN ` prefix on the outstanding line is CUR-1 R12b's sweep, shown bare here):

```
✅ Request R-REQ1 approved. Sale and ledger updated.
🧾 Customer copy × 1,250

📒 Soldier Madam — Outstanding as of today: 944
```

Requester's card, edited in place (`updateRequesterCard`, `:150-180`):

```
✅ *Approved — ready to dispatch*
🧾 Customer copy × 1,250

👤 Customer: *Soldier Madam*
📞 <phone>
Ref: R-REQ1
[🏠 Menu]
```

With no multiplier both messages print exactly as today, minus the unit
prefix. The invoice caption that follows the outstanding line (`:1128`)
obeys the same discipline — booked figures plus the `Customer copy × 1,250`
line (§4b); no exception to the RET-3 card rule is recorded here.

---

## 6 · What the multiplier never touches (D1) — say it with the file

| Surface | File | Stays in |
|---|---|---|
| Inventory price cell (`pricePerYard`) | `inventoryRepository.updatePrice` via `inventoryService.js:425-449, 1510-1513` | variable 1 — `3.2` |
| Transactions row (`pricePerYard 3.2`, `amountPaid 400`, `paymentMode`) | `transactionsRepository.append`, `inventoryService.js:1557-1566` | variable 1 |
| Ledger: Customer Receivable DR `1,344`, payment CR `400`; narrations say `NGN 400` | `accountingService.recordSale` / `recordPaymentReceived` (`:22-40, 62-78`; `crmService.recordPayment` `:48` is the wrapper that calls it) | variable 1, narration keeps the code (R7) |
| Customer statement (SLED-1), `📒 Outstanding` lines, and the customer's own EXT-1 OTP ledger (`extLedgerService.js:397-398`) | `accountingService.getCustomerLedger` | variable 1, bare — **customer-facing**: it disagrees with the multiplied invoice by the factor; see §1 and D7 |
| CRM payment | `crmService.recordPayment` | variable 1 |
| Approval cards (sale, return, payment) and wizard chips | `approvalCards.js`, `approvalEvents.js` | variable 1, bare after CUR-1's sweep |
| Landed cost | `landedCostService.js` | untouched (R8) — variable 1 only when it is worked on |
| `balance_after_issue` (Invoices col N) | `invoiceService.js:157-163` snapshot | variable 1 — it is a ledger fact, never multiplied |

The ledger and the Invoices row therefore never disagree: both hold the
booked `1,344 / 400 / 944`; the document is the only place `1,680,000`
exists, and it is reproducible from `lines_json × rate_multiplier`.

---

## 7 · Where each fact lands

| Fact | Lands in | Shape | Notes |
|---|---|---|---|
| Multiplier chosen for THIS sale | `ActionJSON.enrichment.rateMultiplier` on the ApprovalQueue row | number; **present = Step 5 ran** (`1` = none); **absent = Step 5 never ran** (knob off, or an old row) | free: `inventoryService.js:1820` already persists the whole enrichment object |
| Multiplier mid-wizard (resume) | — none | — | §3b rule 5: the answer runs `finish()` at once; `persistEnrichDraft` is unchanged |
| Multiplier USED at issue (D3 freeze) | **Invoices column W `rate_multiplier`** — new trailing column, position 23, after `created_at` (the last `HEADERS` entry) | number, **blank = no multiplier** (never `1`) | `invoicesRepository.js` HEADERS `:20-26`, `fromRow` r[22] → `rateMultiplier` (blank → null, the `balance_after_issue` pattern), `toRow`, ranges `A1:V1` / `A2:V` → `W` (`:62, :70`); duplicate header list `schemaMapper.js:151-158` moves in step. Existing rows read blank → unconverted. Rule 4 respected: trailing column, nothing renamed |
| Global default | Settings cell `INVOICE_RATE_MULTIPLIER` | number; sheet blank/0/1 = none | `settingsRepository.DEFAULTS` (`:14`) gains `INVOICE_RATE_MULTIPLIER: config.invoiceRateMultiplier` — stated once, below; new row in the CLAUDE.md toggles table |
| Boot default of the Settings value | env `INVOICE_RATE_MULTIPLIER` → `config.invoiceRateMultiplier` → `DEFAULTS.INVOICE_RATE_MULTIPLIER` | `parseFloat(...) \|\| 1` in `config/index.js` beside `currency` (`:91`) | `DEFAULTS` is a static literal and `settingsRepository` requires only `sheetsClient`, `asyncMutex`, `logger` today (`:7-9`) — the env is consulted ONLY because step 2 adds `require('../config')` there and sets the default from it (no cycle: `config/index.js` requires only `fs`/`path`, never settings). `getAll()` spreads `{ ...DEFAULTS }` then sheet rows, so a sheet cell overrides the env |
| Ask-or-skip knob | Settings cell `INVOICE_MULTIPLIER_ASK` | `1` (default, `DEFAULTS`) = ask Step 5 on every sale approval; `0` = skip it, Settings-fulfilled path | ships in step 4 with the step; CLAUDE.md toggles table row beside `INVOICE_RATE_MULTIPLIER` |
| Audit | `approval_approved` payload (`inventoryService.js:1834`) gains `rateMultiplier` when one was supplied at approval | one extra key on the existing event, no new event type | the Invoices column is the durable record; this is the who-chose-it trail |
| Rendering | `invoiceService.renderPdf`, `invoiceWebController.renderHtml`; `deliver` (caption) reads the booked `total` / `amountPaidAtIssue` as today and appends the `Customer copy × <m>` line when `rateMultiplier` is present and ≠ 1 | read `invoice.rateMultiplier`; `null` → factor 1, unconverted | one helper `docFigures(invoice)` returns `{ rate2dp, lineAmounts, total, paid, balance }` — printed numbers only — so PDF and web cannot disagree. `status` (PAID / PART-PAID / UNPAID) is NOT in it: it stays computed from the booked `total` and `amount_paid_at_issue` exactly as `invoiceService.js:211-213` does today (rule 17) |

**Freeze rule (D3).** The multiplier is resolved ONCE, at issue, inside
`createForSale`, by the PRESENCE of the enrichment key: **key present** (Step
5 ran) → use it — a value that is `1`, non-positive, non-finite or above
1,000,000 means none, and **Settings is never consulted**; **key absent**
(Step 5 never ran: `INVOICE_MULTIPLIER_ASK=0`, the Settings-fulfilled path,
old rows) → the Settings value if > 0 and ≠ 1, else none. The two meanings
cannot share the absent key — that is why `[No multiplier]` writes `1` (§3b
rule 3). It is written to column W with the row. Every later render — Telegram delivery, `/i/<token>`, `/i/<token>.pdf`,
any re-download — is `stored lines × stored multiplier`. **A later change to
the Settings cell never touches an issued invoice.**

---

## 8 · Edge cases, as rules

11. **Multiplier ≤ 0, non-numeric, or > 1,000,000** → refused at the wizard
    (rule 2); `createForSale` mirrors the SAME full range check
    (`Number.isFinite(m) && m > 0 && m ≤ 1,000,000`, else treat as none —
    and, the key being present, still never fall to Settings) so a
    hand-edited ActionJSON can print neither zeros nor an absurd figure: the
    executor and the wizard refuse identical inputs.
12. **Multiplier present but rate unresolved** (INV-2's "rate not recorded":
    `buildLines` returns `rate 0`, `amount 0`) → no money is derived from the
    rate and the state is named: strip reads `RATE NOT RECORDED`, the COST
    cell, Total and DEBIT BALANCE print `—`, the description omits `@ …/yd`.
    The one fact the document still has — the payment — prints in the
    document's unit: the red row and the web row show `500,000` (booked 400 ×
    the frozen 1,250; `400` when none), so the document stays single-unit
    (D2: everything on it, same factor) and never mixes a variable-1 figure
    with a local-currency freeze. The caption, a staff message (§4b), reads
    `Total — · Paid 400 · Balance —` in booked figures plus `Customer copy ×
    1,250`. Column W is still frozen so a later correction renders
    consistently. Today this state prints `PAID · ₦0 settled` — the hole
    INV-2 flagged.
13. **Re-download of an old invoice** (column W blank) → variable 1, bare,
    unconverted. The Settings cell is never consulted at render time.
14. **Several designs at different rates** → ONE multiplier for the whole
    invoice; each line prints `its rate × m` to 2 dp and `round(yards × rate × m)`;
    total = Σ document lines. Rate is per design already; the multiplier is per
    document.
15. **Settings cell set, admin taps `No multiplier`** → unconverted, because
    the tap writes `rateMultiplier: 1` (key present) and the freeze rule then
    never reads Settings; the wizard answer is the per-sale truth (Q4).
16. **Sale with `amountPaid 0`** ('Not yet paid' / Credit) → Step 5 still
    asked while `INVOICE_MULTIPLIER_ASK` is `1`; the red payment row is
    omitted as today; strip `UNPAID · 1,680,000 due`; DEBIT BALANCE
    `1,680,000`.
17. **Multiplier < 1** (variable 1 is the larger unit) → allowed; rates print
    to 2 dp as usual. Document amounts CAN round to `0` (booked balance `1` ×
    `0.0004`), so the strip status is never derived from the document's
    multiplied figures: **PAID / PART-PAID / UNPAID is computed from the
    BOOKED `total` and `amount_paid_at_issue` exactly as today**
    (`invoiceService.js:211-213`); `docFigures` supplies printed numbers only.
    A customer whose ledger still shows a debt never reads `PAID · settled`.
18. **`fmtRate2` and grouping** stay `en-NG` (`1,250`, `4,000.00`) — the
    grouping style is not a currency label.

---

## 9 · Build steps — smallest shippable, one commit each

Each step is green on `npm test`, `npm run smoke` (`$0`) and `npm run lint`
(0 errors) before the next starts. Step 0 is docs only and goes first
because R1 was ruled "before the design lands". Steps 1–3 ship the
**Settings-fulfilled** path (usable with no wizard change; step 3 waits on
D7); step 4 adds the **supplied-during-approval** door.

| # | Commit | Files | Gate | Ask-first? |
|---|---|---|---|---|
| 0 ✅ A | `docs: INV-2 rule 3 + INV-1 decision 9 + mockups follow CUR-1 R1` | `specs/INV-2_INVOICE_DESIGN_PROMPT.md` rule 3 (`:50` "all money is **₦ per yard**" → "money is bare; the customer copy may be rate × multiplier, 2 dp rate, integer amounts"), `specs/INV-1_CUSTOMER_INVOICES.md` decision 9 (`:26` `Description \| Cost ₦ \| Payments ₦` → `Description \| Cost \| Payments`, with a supersession note), the three `specs/inv1-mockups/*.html` (19 `₦` literals stripped) | none (docs) — the brief being finalised then matches what step 3 renders | no |
| 1 ✅ A | `INV: Invoices column W rate_multiplier (blank = none)` | `invoicesRepository.js` (HEADERS, fromRow, toRow, A1:W1 / A2:W), `schemaMapper.js:151-158` | new unit test: round-trip a row with and without the column; existing invoice tests untouched; smoke repo-parse check | **Schema change** — owner signed off D3 on 08-Sep; this spec's go re-confirms it |
| 2 ✅ A | `CUR-2: INVOICE_RATE_MULTIPLIER knob (Settings + env boot default)` | `config/index.js` (`invoiceRateMultiplier: parseFloat(process.env.INVOICE_RATE_MULTIPLIER) \|\| 1` beside `currency` `:91`); `settingsRepository.js` **gains `require('../config')`** and sets `DEFAULTS.INVOICE_RATE_MULTIPLIER = config.invoiceRateMultiplier` (no cycle — config requires no repository); repo-root `CLAUDE.md` toggles table | unit test: sheet blank / 0 / 1 / '1250' / 'abc' → effective none / none / none / 1250 / none; env set / env blank / sheet-overrides-env; and the resolver's two entry shapes — key absent → Settings, key present `1` → none even with Settings 1,250 | no — root file, but covered by the feature recipe's toggles-table convention ("anything tunable goes in the Settings sheet … CLAUDE.md toggles table") |
| 3 ✅ A | `CUR-2: invoice document renders bare; × multiplier when frozen` | `invoiceService.js` (createForSale stamps W from the presence-based freeze rule with the full range guard, rule 11; `docFigures` numbers only, status from booked as at `:211-213`; `fmtRate2` at `:260`; NGN const removed; strip ×4, headers, description, DEBIT BALANCE; `deliver` caption = booked figures + `Customer copy × <m>` line), `invoiceWebController.js` (`fmtMoney` → bare integers, rate 2 dp via `fmtRate2`; sale date on the payment row), `format.js` (`fmtRate2`) | text()-call tracer tests for §4a and §4b verbatim (both states, PDF + HTML + caption); a **non-integer entered rate** (`3.2` → `3.20/yd` on the PDF, never `3`); key present `1` with Settings 1,250 → unconverted; key absent with Settings 1,250 → converted; rule-12 state with the payment row `500,000`; multiplier < 1 rounding a balance to 0 still `PART-PAID`; old row with blank W | no (not a parked file) — **but does not ship before the owner rules D7** |
| 4 ⏳ B | `CUR-2: Step 5 customer-copy multiplier in the sale wizard` | `approvalEvents.js` — exactly the six touch points of §3b rule 7 (sendMultiplierStep + chips; `enr:mult:*` handler; typed `multiplier` handler; `finish`/`finishTyped`; approved line + `updateRequesterCard` line; the two prompt strings and two chip `₦`s) — `persistEnrichDraft` and the resume chain are NOT touched; `settingsRepository.DEFAULTS` `INVOICE_MULTIPLIER_ASK: 1` + CLAUDE.md toggles row; `inventoryService.js:1834` audit key | extend `approvalEvents.enrichmentChips.test.js`: chip route (`enr:q:<rid>:mult:def` wire form, ≤ 64 bytes), typed route, 'Not yet paid' route, `[No multiplier]` → enrichment carries `rateMultiplier: 1`, refused input keeps the card on Step 5, Settings chip hidden when blank, `INVOICE_MULTIPLIER_ASK=0` skips the step and the enrichment carries no key, redeploy between Step 4 and Step 5 re-asks Step 4; `renderWizard` anchored edit (`session.flowMessageId` / the wizard's anchor message id) unchanged — Step 5 edits the same card, never sends a new one; prompts print no unit | **Yes — `approvalEvents.js`** |
| 5 ⏳ B | `docs: CUR-2 shipped — §17 closed, R18 superseded for the sale wizard` | `docs/BUSINESS_RULES.md` §17 — the locked sentence is the owner's to reword (R16 precedent), so this step inserts ONLY the closing sentence the owner approves verbatim; proposed for his yes/no, not a session's wording: *"Shipped <date>: the multiplier is frozen per invoice in Invoices column W; the sale wizard's prompts name no unit — R18 is superseded for the sale wizard because the amendment made 'Naira' factually wrong there; the customer's OTP ledger stays in variable 1 (D7)."* — plus this spec's status line. (INV-2 / INV-1 / mockups moved to step 0.) | none (docs) | no — the §17 sentence itself is approved verbatim by the owner |

**Release split (09-Sep-2026).** ✅ A = shipped in release A (steps 0–3 —
D7 was ruled (a) as recommended, so step 3 shipped); ⏳ B = release B, after
the owner's live check and go. The step-5 sentence for §17 is already
recorded in `docs/BUSINESS_RULES.md` §17 marked **PENDING OWNER APPROVAL**;
release B replaces the marker with the owner's yes.

Not in this spec: the CUR-1 mechanical sweep that strips `₦` from the
`📒 Outstanding` line and the other ≈210 sale-side sites — that is CUR-1's
own commit series, ordered after step 3 so the invoice is bare first. The
wizard's own prompt words and chip symbols (steps 2 and 4) are the one
exception, carried here in step 4 (§3 intro, rule 7).

---

## 10 · Questions for the owner (only where the ruling leaves a gap)

> **Closed 09-Sep-2026 — owner: "as recommended"** on Q1–Q6 and D7 (Q2 was
> withdrawn). Q1: always 2 dp. Q3: ask Step 5 on every approval, knob
> `INVOICE_MULTIPLIER_ASK` ships with it (release B). Q4: `No multiplier`
> wins over the Settings cell. Q5: recompute each line from the rate. Q6:
> `RATE NOT RECORDED` shipped in step 3. D7: (a) — the OTP ledger stays in
> variable 1; the invoice is the only local-currency paper.

Each has a recommended answer; "as recommended" closes them all.

- **Q1** — A whole-number local rate: print `4,000.00/yd` (D5 literally) or `4,000/yd`? **Recommended: always 2 dp** — one uniform rate column; the entered rate is the one that carries decimals.
- ~~**Q2**~~ — withdrawn. The caption never prints the multiplied figures: it is a staff message and keeps the booked `Total 1,344 · Paid 400 · Balance 944` plus one `Customer copy × 1,250` line (§4b, §5), so there is nothing to startle staff and nothing to ask.
- **Q3** — Ask Step 5 on every sale approval, even when the Settings cell is blank? **Recommended: yes** — it is one tap (`No multiplier`) — and the `INVOICE_MULTIPLIER_ASK` knob ships WITH the step (default `1`, `settingsRepository.DEFAULTS`, step 4), so switching it off is a Settings cell edited by you, not a deploy.
- **Q4** — When the Settings cell holds 1,250 and the admin taps `No multiplier`, the invoice goes out unconverted. **Recommended: yes** — the per-sale answer wins because the tap writes `rateMultiplier: 1` on the row and the freeze rule reads Settings only when the key is absent (§7); the Settings cell pre-fills the chip and nothing else.
- **Q5** — Document arithmetic: recompute each line as `round(yards × rate × m)` and derive total and balance from the document's own lines (§2 rule), rather than multiplying the booked integers? **Recommended: recompute** — it is the owner's "refilled from the rate", and the column always adds up.
- **Q6** — Rule 12 changes what a rate-less invoice prints (`RATE NOT RECORDED` instead of `PAID · 0 settled`). That is INV-2's fix arriving early. **Recommended: ship it in step 3** — it is three lines and the current print is wrong on its face.
- **D7** — the customer's own ledger. The customer who holds the multiplied invoice (`DEBIT BALANCE 1,180,000`) can open the EXT-1 OTP ledger / SLED-1 statement (`extLedgerService.js:397-398`, a §15b website money view) and read outstanding `944`: on the customer's side the two documents disagree by the factor. D1 "as recommended" fixed the document scope but you were never shown this. Two ways out: **(a)** accept that the OTP ledger stays in variable 1 and the invoice is the only local-currency paper — said in §1 in one line; or **(b)** gate EXT-1 off for customers whose invoices carry a multiplier until the finance portal can render per-invoice frozen factors. **Recommended: (a)** — a per-customer ledger cannot be multiplied, because each invoice may freeze a different factor. **Step 3 does not ship before you rule.**
