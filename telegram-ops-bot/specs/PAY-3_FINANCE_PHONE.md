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

## 2 · What it will say

### 2a · The card, when someone ELSE signed first

```
Payment request: ₦6,000
Payee: Abdul (employee)
Account: 7048940378 · OPAY
Reason: Total tp

Requested by Abdul · 13-Sep-2026, 11:39 · 1d ago · R-4F72

⚠️ 1 of 2 approvals — signed by Musa.
   A different admin must give the second.

        [ ✅ Approve ]   [ ❌ Reject ]
        [ ⬅ Back to list ]  [ ❌ Close ]
```

The date is added; the relative age stays beside it, because "1d ago" is
what tells you it is going stale. The signer is named.

### 2b · The same card, when YOU signed first

```
Requested by Abdul · 13-Sep-2026, 11:39 · 1d ago · R-4F72

⚠️ 1 of 2 approvals — you signed this one.
   It is waiting for a DIFFERENT admin. Nothing for you to do here.

        [ ⬅ Back to list ]  [ ❌ Close ]
```

The ✅ Approve chip is **not offered**, because the existing guard would
refuse the tap anyway. This changes no rule: it stops offering a button
that cannot work. ❌ Reject stays — rejecting your own pending request is
already allowed and is sometimes the point.

### 2c · The alert that brings you here

```
🔔 R-4F72 · payment · ₦6,000 → Abdul
Signed by Musa — 1 of 2. Your approval is the second.
Open 🛂 Approvals → 💳 Payments.
```

Short ref, the money, the payee, the signer, and where to go. No UUID
reaches a screen (the house rule already; this path missed it).

### 2d · The list chips

```
🟢 13 Sept · ₦6,000 → Abdul · Total tp
🟠 10 Sept · ₦25,000 → Muhammad · Fuel
🔴 23 Aug · register account · Abdul
```

Amount and payee on the row, so seven pending payments can be read without
opening seven cards. `register payment account` rows keep their wording:
they move no money and must not look like they do.

---

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

| Change | File | Size |
|---|---|---|
| Date on the approval card footer | `approvalsInboxFlow` | 1 line |
| Name the first signer; drop ✅ for the signer themselves | `approvalsInboxFlow` | ~12 lines |
| Short ref + amount + signer on the second-approval alert | `approvalEvents` (**ask-first**) | ~6 lines |
| Amount → payee on payment chips | `approvalsInboxFlow` | ~8 lines |

No schema change, no new sheet or column, no change to how many signatures
anything needs. Roughly 27 lines plus tests.

The first, second and fourth are inside the inbox flow and need only a go.
The third touches `approvalEvents.js` and needs the owner's explicit go.
