# STS-1 — "Where is it pending, and with whom?"

**Status:** audit + proposal. TRF-19 / TRF-19b / DEC-1 / DEC-1b shipped
14-Sep-2026 as the first two answers. The rest waits on the owner's word.

**Origin (owner, 14-Sep-2026),** holding a "please dispatch" transfer card
he had opened from the approvals inbox:

> "I am not able to see the exact status of this transfer. Where is it
> pending? Under whose approval or acceptance? Can you find a way of
> managing this? Also check any other activities later but for this now."

The transfer half is built. This document is the "other activities" half:
every multi-stage workflow in the bot, scored on whether **any** screen
answers *where is request X, and whose move is it now*.

---

## 1 · What shipped already (14-Sep-2026)

| Code | What it does |
|---|---|
| **TRF-19 / 19b** | One line on every transfer card and list row: `⏳ With Musa to dispatch · raised by Krishna · 3d waiting`. Stage-specific clocks, Markdown-escaped names, the stand-in note for an admin holding someone else's card, a tappable 📋 Transfers list. |
| **DEC-1 / 1b** | `✅❌ Decided` group in the 🛂 inbox — approved and rejected rows, newest decision first, naming the decider from ApprovalQueue column H. Survives a clear queue. Window = Settings `APPROVALS_DECIDED_DAYS`. |

The wording `With <name>` is the house vocabulary: it follows PAY-2's
shipped `🏦 With finance to pay`, and it does not read as an accusation
when the holder is the person reading the card.

---

## 2 · The scoring axis

Each workflow scores 0–3: (a) does **any** persistent surface exist after
the push message scrolls away, (b) does it name the **stage**, (c) does it
name the **actor** it waits on. Weighted by how irreversible the action is.

| Rank | Workflow | Score | The gap |
|---|---|---|---|
| — | **Tasks** | 3/3 | **The gold standard.** Every state names the actor on both sides. Nothing to fix; this is the shape to copy. |
| **1** | **Returns** (`return_thans`, RET-4) | 0/3 | Dual-admin, moves customer ledger money, and has **no** persistent status surface at all. One message at submit; once it scrolls away nothing says the return exists, what stage it is at, or which admin still owes a signature. |
| **2** | **Goods receipts** (`receive_goods`, `bulk_receive_goods`) | 0/3 | Same blindness. A stuck GRN means bales are physically in the warehouse and absent from Inventory, with no screen saying a receipt is waiting or on whom. |
| **3** | **Supply requests** | 3/3 on its own tile, 1/3 where the buttons are | 🚚 Pending Supply is genuinely good. But the DM approval card and the 🛂 inbox card print **no stage**, so the admin decides blind on the one surface that carries Approve. |
| **3b** | Supply approve path | — | Because the card hides the stage, an admin can tap Approve on a request that is not at `admin_review`. The approve path has an action guard but no **stage** guard; the dispatch-side path has one. |
| **4** | **Every dual-admin action** (7 categories) | — | The one-signature note is hardcoded: `1 of 2 approvals already given — a different admin must give the second`. It never names the first signer, so an admin cannot tell whether the signature waiting is his own. |
| **4b** | The inbox chip itself | — | Carries age + action + **requester**, never the holder and never the signature count. |
| **5** | **Edit Bale** (EDB-1) | 0/3 | Dual-admin and it rewrites live Inventory cells. The only thing that knows an edit is pending is a duplicate-guard read inside the flow. |
| **6** | **Payments** (PAY-2) | ~2.5/3 | Best-covered non-task family. Residual gap: the two OPEN stages name no person, and the record line only exists once the row leaves `pending`. |
| **7** | **Customer orders** | — | Pending Supply lists them with a stage word and the salesperson's name, but never phrases the salesperson as the **holder**, so "Pending acceptance" reads as if it waits on an admin. |
| **8** | Shade photos · office expenses · snap sale · bundle sale | — | All end at a one-shot "waiting for an admin" push. Ranked lower: sales at least reappear as chips in the inbox 💰 Sales group, and expenses in the 20:00 report. |
| **9** | **The /ops web dashboard** | — | No stage and no signer names; approvals list is action + requester + age. It also hardcodes `requesterIsAdmin: false`, so it can report "2 required" for a request that needs 1. |
| **10** | **Business Glance** | — | The admin's morning card reduces the whole queue to a count and an oldest-age. |
| — | Pending Users · Procurement POs · Marketer allocations | — | **No gap.** Single-stage with their own queue, waiting on an external supplier, or a direct admin write with no approval. |

### The structural finding

There is **no generic "my raised requests" door**. Payments is the only
workflow where the person who raised something can look it up later;
every other family relies on the push message surviving in the chat.
Correspondingly, every actor-scoped queue answers *what is waiting on ME*,
never *where is request X*.

---

## 3 · Proposed work, cheapest first

Each line is one change. **R** = a ruling the owner owes before it is built.

| # | Change | Where | Size |
|---|---|---|---|
| 1 | Name the first signer on the dual note (`already signed by Abdul — a different admin must give the second`) | `approvalsInboxFlow` dual note | 5 lines |
| 2 | Append the signature count `1/2` to dual-admin inbox chips | `approvalsInboxFlow` chip | 3 lines |
| 3 | Print stage + holder inside the supply-request card so the inbox matches Pending Supply | `approvalCards.buildSupplyRequestCard` | ~10 lines |
| 4 | Phrase the order holder as the salesperson: `⏳ waiting on <name> to accept` | `salesWorkflowView` | 2 lines |
| 5 | Show the payment status line on PENDING rows too, not only resolved | `approvalsInboxFlow.paymentStatusLine` | 3 lines |
| 6 | **R1** — one shared `📋 My requests` over ApprovalQueue by `user`, covering returns, goods receipts, edit bale and every other family at once | new small flow, modelled on `paymentFlow.showMine` | ~120 lines |
| 7 | **R2** — a stage guard on the supply approve path, mirroring the dispatch side | `approvalEvents` (**ask-first file**) | ~6 lines |
| 8 | **R3** — carry stage and signer names into the /ops approvals API, and fix its hardcoded `requesterIsAdmin: false` | `apiController` | ~20 lines |

### Rulings owed

- **R1 — the shared "📋 My requests" door.** *Recommended: yes, build it.*
  It is one flow that closes ranks 1, 2 and 5 together, and it is the only
  thing that gives a non-admin any way to ask "what happened to what I
  asked for". Question for the owner: should an **admin's** copy list
  everything, or only their own raised requests?
- **R2 — the supply stage guard.** *Recommended: yes.* It prevents an
  approval landing on a request that has not reached the admin stage.
  Touches `approvalEvents.js`, which needs the owner's explicit go.
- **R3 — the web dashboard.** *Recommended: later.* The Telegram surfaces
  are where the work actually happens; the web view is oversight only.

---

## 4 · What this audit does NOT propose

- No new sheet, no new column, no Postgres table. Every line above is read
  at render time from data the ApprovalQueue row already carries
  (`user`, `status`, `createdAt`, `resolvedAt`, `approver`, and the stage
  and actor ids inside `actionJSON`).
- No change to approval semantics. Nothing here adds, removes or relaxes a
  signature requirement; R2 is a guard that makes an existing rule harder
  to bypass, not a new rule.
