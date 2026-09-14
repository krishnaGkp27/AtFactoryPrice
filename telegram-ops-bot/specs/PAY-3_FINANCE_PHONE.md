# PAY-3 — the finance phone: dates, signers, and the two jobs on one handset

**Status:** PROPOSAL. Nothing built. Owner asked for the exact output first.

**Origin (owner, 14-Sep-2026),** sending the approval card as it looks on the
office phone:

> "When I open it, it doesn't show me the date when it was requested. It
> shows me the approval but this is also the same phone where the employer
> is getting a request for making payment. Let me know how it will come in
> the section menu on this phone."

The request used throughout is the owner's real one: **₦6,000 to Abdul,
OPAY 7048940378, reason "Total tp", raised 13-Sep-2026, ref R-4F72**, one
signature already given.

---

## 1 · What the card says today

```
Payment request: ₦6,000
Payee: Abdul (employee)
Account: 7048940378 · OPAY
Reason: Total tp

Requested by Abdul · 1d ago · R-4F72

⚠️ 1 of 2 approvals already given — a different admin must give the second.
```

Three faults, all visible in that screenshot:

| # | Fault | Why it bites on THIS phone |
|---|---|---|
| **F1** | **No date.** `1d ago` is a relative age. A payment is a financial record; "when was it asked for" is not answerable from the card. | The finance card sent AFTER approval already prints `13-Sep-2026, 11:39`. The approval card, seen FIRST, prints less than the card that follows it. |
| **F2** | **The one-signature note names nobody.** | This phone is also an admin. If the existing signature is its OWN, tapping ✅ is refused by the self-approval guard — but nothing on the card says so until after the tap. The person who most needs the signer's name is the one about to give the second signature. |
| **F3** | **The "needs a SECOND" alert prints a raw UUID** — `4f72be16-982c-4241-b5d6-165b8db23cc6` — while the card two messages below calls the same thing `R-4F72`, and the alert names no signer, no amount and no payee. | Two references for one request, neither cross-referable by eye. |

A fourth, from the list screen: the chips read `13 Sept · request payment ·
Abdul`. For money going out, the **amount** is what an approver scans for,
and it is the one fact missing.

---

## 2 · What it will say — SHORTER, not longer

**Owner, 14-Sep-2026: "I don't want to make this approval too long."**
Right. The fix adds the date and the signer while REMOVING lines. Nothing
below is an addition; every one of them is a cut.

### 2a · The card, when someone ELSE signed first

```
Payment request: ₦6,000
Abdul (employee) · 7048940378 OPAY
Reason: Total tp

Abdul · 13 Sep 11:39 · 1d · R-4F72
⚠️ 1 of 2 · signed by Musa

        [ ✅ Approve ]   [ ❌ Reject ]
```

Three cuts, each one carrying MORE fact in FEWER characters:

| Cut | From | To |
|---|---|---|
| **C1** payee + account merge | two lines | one |
| **C2** the footer | `Requested by Abdul · 1d ago · R-4F72` (36 chars, no date) | `Abdul · 13 Sep 11:39 · 1d · R-4F72` (34 chars, with the date) |
| **C3** the signature note | `⚠️ 1 of 2 approvals already given — a different admin must give the second.` (74 chars, wraps to three lines on a phone) | `⚠️ 1 of 2 · signed by Musa` (one line) |

C3 drops the sentence "a different admin must give the second" on purpose.
`1 of 2` already says a second is needed, and the person reading it IS the
different admin.

**On his phone: about ten rendered lines today, six after.**

### 2b · The same card, when YOU signed first

```
Payment request: ₦6,000
Abdul (employee) · 7048940378 OPAY
Reason: Total tp

Abdul · 13 Sep 11:39 · 1d · R-4F72
⚠️ 1 of 2 · you signed

        [ ⬅ Back to list ]   [ ❌ Close ]
```

No ✅ Approve chip, because the existing guard would refuse that tap. The
MISSING BUTTON is the message — no sentence needed, and no rule changes.
❌ Reject stays: rejecting your own pending request is already allowed.

### 2c · The DM version of the same card — the longest one, and the fattest

This is where the raw UUID comes from. Today:

```
🔔 Approval required

Ref: 4f72be16-982c-4241-b5d6-165b8db23cc6
From: Abdul

Payment request: ₦6,000
Payee: Abdul (employee)
Account: 7048940378 · OPAY
Reason: Total tp

Sent for approval

Use buttons below to approve or reject.
```

Two of those lines carry nothing. `Sent for approval` is the filler
`shortReason` returns when the risk reason is boilerplate, and
`Use buttons below to approve or reject` describes the two buttons
directly beneath it. `Ref:` prints the raw id while every other screen
calls the same request R-4F72. Proposed:

```
🔔 Approval required · payment · R-4F72

Payment request: ₦6,000
Abdul (employee) · 7048940378 OPAY
Reason: Total tp

Abdul · 13 Sep 11:39 · 1d
⚠️ 1 of 2 · signed by Musa
```

**Twelve rendered lines today, seven after** — and the UUID is gone.

### 2d · The second-signature alert

```
🔔 R-4F72 · payment · ₦6,000 → Abdul
Signed by Musa — 1 of 2. Yours is the second.
```

Two lines, replacing two lines. Today's version is the same length and
says only that "a request" needs a second approval.

### 2e · The list chips

```
🟢 13 Sept · ₦6,000 → Abdul · Total tp
🔴 23 Aug · register account · Abdul
```

Same length as today's `13 Sept · request payment · Abdul`; the words
`request payment` are replaced by the amount and the payee, which is what
an approver is actually scanning for. Account registrations keep their
wording: they move no money and must not look like they do.

### What this touches beyond payments

The footer (C2) and the signature note (C3) are **shared by every category
in the inbox** — one line of code each, rendered on sales, transfers,
contacts, returns and the rest. So every approval card in the bot gets the
date and gets shorter, in one vocabulary. That is the intent, not a
side-effect; if the owner wants payments only, say so and it becomes a
per-action branch instead.

## 3 · The two jobs on one phone

This handset is **both an approving admin and the finance seat**. They are
different jobs and they live in different places. Nothing changes here —
this is the answer to "how will it come in the section menu":

| Menu | What it holds | When a payment appears |
|---|---|---|
| **🛂 Approvals → 💳 Payments** | The approval job. Requests still collecting signatures. | From the moment it is raised until the second signature lands. Then it leaves. |
| **💰 Finance → 💳 Payments → 💳 Waiting for me to pay** | The finance job. Approved, not yet paid. | From the second signature until ✔ Mark Done. |

So on this phone: **approve in 🛂, pay in 💳.** A request is never in both
at once, and the finance queue never shows something that still needs a
signature. The ✅❌ Decided group (DEC-1) holds it after it is decided.

The full-screen card in `💳 Waiting for me to pay` is unchanged and already
carries the date, the approvers and the reason.

---

## 4 · The ruling this raises

**R1 — may the admin who signs also be the one who pays?**

Today, yes. `paymentService.canExecute` checks only that the tapper is the
finance seat; nothing stops an admin from giving the second signature and
then paying it from the same handset a minute later. Two signatures were
required, but on this phone one pair of hands can supply the second and
then release the money.

Options:

- **(a) Leave it.** One office phone, a small team, and the first signature
  still has to come from someone else. *Recommended while the team is four
  people.*
- **(b) Bar the payer from signing.** The finance seat can pay but cannot
  give either approval. Clean separation, but with one finance phone it
  removes a signer from a small pool and can stall payments.
- **(c) Bar only the SECOND signature.** The finance seat may give the
  first signature, never the one that releases the money.

This is a business rule, not a screen. It needs the owner's word, and if it
changes it touches `approvalEvents.js` — an ask-first file.

---

## 5 · Scope

| Change | File | Size | Net effect on length |
|---|---|---|---|
| C1 merge payee + account | `paymentCards.buildApprovalSummary` | 2 lines | −1 line |
| C2 footer carries the date | `approvalsInboxFlow` (all categories) | 1 line | −2 chars |
| C3 signature note names the signer, loses the sentence | `approvalsInboxFlow` (all categories) | ~12 lines | −2 rendered lines |
| No ✅ chip for your own signature | `approvalsInboxFlow` | ~4 lines | −0 |
| DM card: short ref, drop the two dead lines | `approvalEvents` (**ask-first**) | ~6 lines | −5 rendered lines |
| Alert: ref + amount + payee + signer | `approvalEvents` (**ask-first**) | ~6 lines | 0 |
| Amount → payee on payment chips | `approvalsInboxFlow` | ~8 lines | 0 |

No schema change, no new sheet or column, no change to how many signatures
anything needs. Roughly 27 lines plus tests.

The first, second and fourth are inside the inbox flow and need only a go.
The third touches `approvalEvents.js` and needs the owner's explicit go.
