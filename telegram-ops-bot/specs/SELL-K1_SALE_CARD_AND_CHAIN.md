# SELL-K1 + CARD-3 + SLP-1 — the Kano sale chain, the approval card, the seller

**Status: SHIPPED 10-Aug-2026.** Owner-confirmed in the same session.

Three findings from one owner review of a live Kano than sale.

## The owner's words

> "I cannot see the details properly with the approval card after they send
> it to me while he is trying to sell them."

> "Can you check the card when he is selling in bales from Lagos? Are all
> the parameters available there? Is he selecting the date? Please make sure
> these things are consistent over all the places."

> "Yes, date salesperson and bill on the same than sale card. Yes sales bill
> is always required. Make it mandatory everywhere in the business rules.
> There is still some redundancy in the card where I can see the repetition
> of words like 'shade', 'bale', 'than'."

> "No need to make any changes in Lagos. Make changes for kano it seems to
> be better. / Are you logging the salesperson also when the sales are
> logged? / No need to write big reason stating everything explicitly like
> required admin approval, just write Sending from approval. Since it will
> be approved not always by admin. / leave supply requests optional for now"

## What the audit found

Lagos's Sell Bale (`sellBaleFlow`) has asked for all three facts since July:
a salesperson chip, the SELL-T2 date calendar with the backdated rule, and a
mandatory bill before submit. **Kano's than sale asked for none of them.**

| | Lagos Sell Bale | Kano than sale (before) |
|---|---|---|
| Salesperson | chips from Users | assumed = submitter |
| Sale date | chips + 90-day calendar, backdated flag | assumed = today |
| Sales bill | mandatory before submit | never asked |
| Admin card | full item list + totals | two lines: design, than count |

So the owner was not imagining the thin card: the Kano DM genuinely carried
`🧵 Bundle sale — 77014 @ Kano office / 5 than · 150 yd` and nothing else.

## SELL-K1 — the Kano chain (no Lagos changes)

`cart → 🧑 salesperson → 📅 date → 🧾 confirm → 📎 bill → queue`

- **Salesperson** — chips from the Users sheet, the submitter offered first.
  Re-tappable from the confirm card (`bs:spx`) without losing the date.
- **Date** — `dateCalendar` with prefix `bs`: the SAME quick chips, month
  grid, 90-day floor, no-future rule and "beyond yesterday = BACKDATED"
  flag Lagos uses. One shared module, so the two cannot drift again.
- **Bill** — `bs:fin` arms `await_doc`; the controller routes the photo/PDF
  to `bundleSaleFlow.handleFile`, which stores the file id and submits in
  one motion. **A submit with no bill re-arms the prompt — it never queues.**
- The bill rides the queue row as `sale_doc_file_id` / `sale_doc_type`, so
  the reminder sweep, the approvals inbox, the supply-ledger doc list and
  the OCR bill-check all find it where every other sale keeps it.
- `backdated` / `daysBack` land on the row and on the admin card.

Lagos is untouched, per the ruling.

## CARD-3 — the approval card

The old card wrote "Bale", "Than" and "thans" once per LINE. A five-than
Kano sale said "Bale" five times before the approver reached a number.
CARD-3 says each noun **once**, in a key line at the foot, and writes the
goods in the grammar Abdul already types (`bale/than`, `#shade`):

```
🔔 Approval required

Ref: 8b27…
From: Abdul

🧾 Sale · Kano office
👤 set at approval
🧑 Abdul · 📅 09-Aug-2026
📎 Sales bill

🧵 77014 · Cashmere — 3 than · 90 yd
  #11 → 1100/1 · 1091/2
  #14 → 1082/1
🧵 77020 — 2 than · 60 yd
  #03 → 1122/1 · 1113/1

Σ 5 than · 150 yd · 5 bale
(bale/than · #shade)

Sent for approval
```

Rules that shape it:

- **Nothing is dropped.** Design, category, shade, bale, than, yards,
  warehouse, salesperson, date, payment, doc and every no-stock warning are
  still there — only the words around them are gone.
- **Facts get promoted to the header when they are shared.** One store
  ships → the store is named once in the headline; a mixed request keeps it
  per token (`1100/1 @IDUMOTA`) so no bale is mis-attributed.
- **A whole bale reads `1100 ×3`; a named than reads `1100/1`.**
- **Warnings stay in full sentences.** An exception is the one thing that
  must never be terse. `⚠️` marks the token, and the sentence below the
  total says how many and what to do. The APF-1 "🚨 NOTHING in this request
  is available" line is unchanged.
- **§2 is preserved.** A number living under two designs still heads its
  own "not resolved" group — never folded under someone else's design. A
  number with no live rows heads a separate `⚠️ no available stock` group:
  different fact, different heading.
- Totals count **distinct printed numbers**: five thans out of three bales
  is `3 bale`, never `5 bale`.

### The reason line

Owner: *"just write sent for approval — it will not always be approved by
an admin."* `approvalCards.shortReason()` drops any sentence matching
"requires (admin) approval" and keeps the rest. So:

| Queued riskReason | Card reads |
|---|---|
| `All sale operations require admin approval.` | `Sent for approval` |
| `Bale transfer requires admin approval` | `Sent for approval` |
| `Backdated sale (4 days in past). All sale operations require admin approval.` | `Backdated sale (4 days in past).` |

One helper, applied in `notifyAdminsApprovalRequest`, so every one of the
~20 call sites is covered without touching them.

## SLP-1 — the salesperson was being dropped

Answering the owner's direct question. Transactions column M is
`SalesPerson` and has existed since APU-1. Three of the four sale executors
wrote it; **two dropped it**:

| Executor | Before | After |
|---|---|---|
| `sale_bundle` (Lagos Sell Bale, Kano, Snap PDF) | ✅ written | ✅ |
| `sell_package` (Snap Sale, single bale) | ❌ **blank** | ✅ |
| `sell_than` (approved typed sale) | ❌ **blank** | ✅ |

Snap Sale put the seller's name on the queue row and the executor threw it
away, so a single-bale sale reached the ledger with no seller and sales
could not be read per person. One line per branch, `aj.salesPerson || ''` —
a legacy row with no name still writes blank, never `undefined`.

## Business rule added

`docs/BUSINESS_RULES.md` §9b — "Every sale carries seller, date and bill —
no assumptions." Bill mandatory on every SALE door; **supply requests stay
optional** (owner ruling, same day).

## Tests

- `test/characterization/sellKanoSaleChain.test.js` — the chain cannot be
  skipped, no bill → no queue, the picked seller and tapped date reach the
  row, backdating is flagged, a future date is refused, re-picking the
  seller keeps the date, and `shortReason` strips only boilerplate.
- `test/unit/services/inventoryService.salesPerson.test.js` — both
  executors write the seller; a legacy row stays blank.
- `test/unit/services/saleBundleCard.test.js`,
  `test/characterization/saleDocVerify.test.js` — CARD-3 layout, including
  a count assertion that each of the three nouns appears once.

## Not done (owner ruling)

- No changes to the Lagos Sell Bale flow.
- Supply requests keep an optional bill.
- The Lagos sale DM still builds its own card text in the controller
  (`telegramController` ~6860). It already carries every parameter; unifying
  it onto `buildSaleCard` is a controller edit inside the parked TG-8 file
  and was left for the owner to call.
