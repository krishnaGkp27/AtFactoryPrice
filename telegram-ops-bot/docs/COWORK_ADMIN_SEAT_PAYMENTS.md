# Admin-seat test script for Claude Cowork — the `black_panther` bot, Payments

Paste everything below the line into Claude Cowork. Cowork then works the ADMIN side of
the payment tests in Telegram Web while Abdul works his side from his own phone. Krishna
(the owner) supervises and answers Cowork's questions.

Abdul's side of each sprint (P1, P2a, P2b, P3, P4, P5) is in the Claude doc "Release test
sprints — Abdul (Lagos office)", Part 1 (Payments). His PDF (`docs/PAY-6_CARDS_ABDUL.pdf`)
shows the same cards with a worked example (₦25,000, "Transport to Idumota"); in the live
test he types the test figures instead, so both seats expect the same thing:

| Sprint | Abdul types | Abdul's PDF steps |
| --- | --- | --- |
| P1 | his real account number and bank | 1–4 |
| P2a / P2b | `1000`, reason `TEST do not pay` (asked twice in P2a) | 5–9, 14 |
| P3 | `1100` + `💼 Salary`, then `1500` + `💵 Salary advance`, both for NEXT month | 15–16 |
| P4 | a customer's payment, real or test (the owner says which) | 17–19 |
| P5 | nothing — the admin alone | — |

Every quoted bot text below was checked on 11-Nov-2026 against the cards the bot's own
code produces (`scripts/pay6-capture/`, the same cards as `docs/PAY-6_CARDS_OWNER.pdf`).

---

## 1. Your job

You are operating ONE admin's Telegram account in Telegram Web. Before sprint A0, ask the
owner two names and write them down: the admin whose account you are working, and the
other admin. "The other admin" in the sprints below means that second person. You test one thing:
the **Payments** part of the company's Telegram bot, **`black_panther`** (it was called
AtFactoryPrice before). You do the steps marked for the admin. Abdul, the Lagos office
manager, does his steps from his phone at the same time. After each sprint you report
what you saw.

This is the live bot and the company's real records. Follow the rules in section 2
exactly. When a step and a rule disagree, the rule wins.

## 2. Rules

1. **One chat only.** Work only in the chat with the bot `black_panther`. Before you start,
   show the owner the chat's title and wait for "yes". Never open, read or write in any
   other chat, group or channel.
2. **Only numbered steps.** Do not explore. Do not tap a button or type a line that a step
   does not name.
3. **Ask before you approve.** Before any tap on `✅ Approve`, stop, quote the card to the
   owner and wait for "yes". There is no exception, not even for a test payment. Before
   approving a payment whose reason reads `TEST do not pay`, also open it in
   `🛂 Approvals` → `💳 Payments` and check its card does NOT carry
   `⚠️ 1 of 2 approvals already given — a different admin must give the second.` If it
   does, your tap would be the LAST approval and the test money would go to finance to be
   paid: do not tap, tell the owner.
4. **Ask before you choose a paying account.** When the bot asks
   `💳 Pay from which account?`, stop and ask the owner which chip to tap. Never choose
   by yourself. If an `✅ Approve` tap on a TEST payment ever brings that question, or any
   message other than the pop-up `🔏 Approval 1 of 2 recorded.`, stop and tell the owner.
   If it ever produces `✅ Request … approved` or `now with finance to pay` on a TEST
   payment, tell the owner AT ONCE so finance can `✖ Decline` it.
5. **Never pay.** Never tap `✔ Mark Done`. That button belongs to the finance person.
   Never tap `✖ Decline`, `⧉ Send anyway` or `⧉ Reject as duplicate` either, unless a
   step names it and the owner said yes.
6. **Never type these.** Do not type any line that starts with `Price`, `Sell`, `Return`,
   `Transfer`, `Receive`, `Delivered`, `Done`, `Order` or `Task`. They act on stock,
   prices, orders or tasks.
7. **Stop on surprise.** If the bot shows something the step does not describe (an error,
   a different card, a button that should not be there), stop. Take a screenshot, write
   down what you saw, and ask the owner.
8. **Keep it here.** Share screenshots and results only in this conversation.

## 3. How to work in Telegram Web

- Open the menu by typing `menu` and sending it. (`/menu` and the blue Menu button also
  open it.)
- A **card** is a message from the bot, often with buttons under it. A **pop-up** is the
  small grey note Telegram shows for a moment after a tap. Some pop-ups are a white box
  with an `OK` button instead; read it, then tap `OK`. Read both kinds.
- **Waiting for Abdul.** When a step says "wait for the card", look at the bottom of the
  chat every 15 seconds for up to 3 minutes. If nothing arrives, tell the owner and wait
  for instructions.
- **Matching.** Words in `code style` are what the bot should show. Names, dates, amounts
  and reference numbers will differ; everything else should match. A missing line, an
  extra line or a different button is a difference.
- **Leaving a screen.** Use the `❌ Close`, `⬅ Back` or `🏠 Menu` button the step names.

## 4. The sprints

Do them in order. Start each sprint only when the owner says Abdul is ready.

### A0. Look around (you alone, nothing is changed)

| Step | Do | Expect |
| --- | --- | --- |
| 1 | Type `menu`. | The admin menu with tiles. Note whether `🛂 Approvals` is on the first screen or under `📋 More Options`. |
| 2 | Open `💰 Finance` → `💳 Payments`. | `💳 Payments`, a line about registered accounts, and `Finance: [name] pays and marks done.` Write down that name. Note whether a button `💳 Waiting for me to pay ([number])` is there. |
| 3 | Tap `🏠 Back to menu`. Open `🛂 Approvals`. | `🛂 Approvals — N pending` and `Newest first inside each group.`, with one button per group. Write down the groups and counts. If nothing is waiting it reads `🛂 Approvals` and `✅ Queue is clear — nothing waiting.` instead, with no `❌ Close` button: tap `🏠 Menu` and skip step 4. |
| 4 | Tap `❌ Close`. | The screen becomes `🛂 Closed.` with a `🏠 Menu` button. |

Report: the finance person's name, whether you (the admin) have `💳 Waiting for me to pay`,
and the approval groups.

### A1. Abdul registers his bank account (his sprint P1)

| Step | Do | Expect |
| --- | --- | --- |
| 1 | Wait for the card `🔔 Approval required`. | `Register payment account: [Abdul] (employee)`, `Account: [number] · [bank]`, `Linked Telegram: [Abdul] · [id] ✓ registered employee`, `Once approved, payments can be raised against this account.`, the line `All register payment account operations require two-admin approval.`, and the buttons `✅ Approve` and `❌ Reject`. |
| 2 | Quote the account number and bank to the owner. Wait for "yes". | The owner confirms the number with Abdul. |
| 3 | Tap `✅ Approve`. | Pop-up `🔏 Approval 1 of 2 recorded.` The card loses its buttons. A new message: `🔏 Request [id]: your approval is recorded (1 of 2). Waiting for a second admin.` |
| 4 | Open `🛂 Approvals` → the group `💳 Payments — … ⚠️` → the line `… · register payment account · [Abdul]`. | The card shows the holder, the account number and the bank, then `Requested by [Abdul] · today · R-…`, and ends `⚠️ 1 of 2 approvals already given — a different admin must give the second.` |
| 5 | Tap `❌ Close`. Do not approve or reject here. | The screen becomes `🛂 Closed.` |

### A2. Abdul asks for a payment (his sprint P2a)

| Step | Do | Expect |
| --- | --- | --- |
| 1 | Wait for the card `🔔 Approval required`. | Exactly **one** new card: `Payment request: ₦1,000`, `Payee: [Abdul] (employee)`, `Account: [number] · [bank]`, `Reason: TEST do not pay`, and `Bill: attached` if he sent one, then `All request payment operations require two-admin approval.` The bill follows as its own picture, captioned `📎 Bill for payment request [id]`. There is no line `⚠️ Possible duplicate`. |
| 2 | Open `🛂 Approvals` → `💳 Payments` → the line `… · request payment · [Abdul]`. | Only one such line for this request (the line itself shows the date and the name, not the amount). The card shows the same facts and `Requested by [Abdul] · today · R-…`. |
| 3 | Tap `📄 Bill` if the button is there, then `❌ Close`. Do not decide yet. | The bill picture appears under the card, captioned `📄 Bill — R-…`. |
| 4 | When the owner says Abdul has asked a second time, look at the chat and at `🛂 Approvals` → `💳 Payments` again. | No second card and no second line for ₦1,000. |

### A3. Reminder, first approval, then close the test (his sprint P2b)

| Step | Do | Expect |
| --- | --- | --- |
| 1 | Wait for a new copy of the payment card. | The same card, headed `🔔 [Abdul] asks for a decision · waiting … · reminder 1`, with `✅ Approve` and `❌ Reject`. The bill picture follows it again. |
| 2 | Do the rule 3 check (the card must NOT carry `⚠️ 1 of 2 approvals already given …`). Quote the card to the owner, wait for "yes", then tap `✅ Approve` on it. | Pop-up `🔏 Approval 1 of 2 recorded.` and the message `🔏 Request [id]: your approval is recorded (1 of 2). Waiting for a second admin.` Anything else: stop (rule 4). |
| 3 | Open `🛂 Approvals` → `💳 Payments` → the request. Tap `✅ Approve` again. | The card says `⚠️ 1 of 2 approvals already given — a different admin must give the second.` The tap is refused with a white pop-up `🔏 You already gave the first approval — a different admin must give the second.` (tap `OK`), then `🛂 💳 Payments — 1 still pending.` with `⬅ Back to list` and `🏠 Menu`. |
| 4 | Tap `⬅ Back to list`, open the request again, tap `❌ Reject`. | Pop-up `Rejecting...`, then `❌ Request … rejected.` and `🛂 💳 Payments — N still pending.` |
| 5 | Tap `⬅ Back to categories` if it is offered, then `❌ Close` or `🏠 Menu`. | If the group is now empty it shows `✅ Nothing left here.` with `⬅ Categories` and `❌ Close`. |

### A4. Salary tests (his sprint P3)

| Step | Do | Expect |
| --- | --- | --- |
| 1 | When the owner says Abdul has finished, open `🛂 Approvals` → `💳 Payments`. | Exactly two requests from Abdul: `Payment request: ₦1,100 … Reason: Salary · [next month]` and `Payment request: ₦1,500 … Reason: Salary advance · [next month]`. |
| 2 | Open each one and tap `❌ Reject`. | Each answers `❌ Request … rejected.` |
| 3 | Tap `🏠 Menu`. | The menu. |

If you see a salary request for the **current** month, or any other amount, do not reject
it. Tell the owner.

### A5. A customer's payment is recorded (his sprint P4)

| Step | Do | Expect |
| --- | --- | --- |
| 1 | Wait for a new card in the chat. | Exactly one card `Record Payment Request` with `Customer: …`, `Amount: …`, `Method: Bank — [bank]`, `Date: …`, `Outstanding today: …`, `After this payment: …`, and the line `All payment operations require two-admin approval.` |
| 2 | Ask the owner: is this a real payment or a test? | Real: wait for "yes", then tap `✅ Approve` → pop-up `🔏 Approval 1 of 2 recorded.` Test: tap `❌ Reject` → `❌ Request … rejected.` |

### A6. The record of decisions (his sprint P5, you alone)

| Step | Do | Expect |
| --- | --- | --- |
| 1 | Open `🛂 Approvals` → the last group `✅❌ Decided — …`. | Today's rejected tests at the top, newest first, such as `❌ [date] · request payment · [Abdul]`. A line says `Record only — nothing here can be approved or undone. Tap one to see who decided it.` |
| 2 | Tap one. | The request's card, then `❌ Already rejected by [your name] · [date] — no action needed.` and `❌ Rejected by [your name]`. No Approve or Reject button: only `📄 Bill` (when there is a bill), `⬅ Back to list` and `❌ Close`. |
| 3 | Tap `⬅ Back to list`, then `❌ Close`. | The screen becomes `🛂 Closed.` |

Do not open `⧉ Possible duplicates` unless the owner asks.

### A7. The last approval and the paying account (only when the owner starts it)

This sprint runs only when **you** give the last approval: the other admin has already
signed, or the other admin raised the payment himself.

| Step | Do | Expect |
| --- | --- | --- |
| 1 | Find the payment card the owner names. Quote it. Wait for "yes". | The card as in A2. In `🛂 Approvals` it reads `⚠️ 1 of 2 approvals already given …` when another admin signed first. |
| 2 | Tap `✅ Approve`. | Pop-up `Choose the account to pay from.` A **new** message: `💳 Pay from which account?`, the amount and the payee's account, the reason, the line `You are giving the last approval. Finance will be told to pay from the account you tap.`, one `🏦` button per company account, and `✖ Not now`. The approval card still has its buttons. Nothing is approved yet. |
| 3 | Ask the owner which account. If the owner says "not now", tap `✖ Not now`. | After `✖ Not now`: `Nothing was approved. The request still waits for its last approval.` Stop here. |
| 4 | Tap the account the owner named. | Pop-up `Approving...`. The approval goes through: `✅ Request … approved by [admin] + [you]. Changes applied.` and `✅ Payment of ₦… to [payee] approved by … — now with finance to pay. Paying from [account].` If you approved from `🛂 Approvals`, the inbox then says `🛂 💳 Payments — N still pending.` |
| 5 | Open `🛂 Approvals` → `✅❌ Decided` → that payment. | `Pay from: [account]` on the card, then `✅ Already approved by … · [date] — no action needed.` and `🏦 With finance to pay · from [account]`. |

If the company has only one paying account, there is no question: step 2 goes straight to
step 4's result, which names that account. Report which happened.

### A8. Four eyes (only if section A0 showed `💳 Waiting for me to pay` for you)

| Step | Do | Expect |
| --- | --- | --- |
| 1 | After a payment you approved is fully approved, look for your copy of the finance card. | It has only `✖ Decline`. There is **no** `✔ Mark Done`. A line reads `🔒 You approved this one, so you cannot pay it — a different hand must release the money.` |
| 2 | Open `💳 Payments` → `💳 Waiting for me to pay`. | That payment's line starts with `🔒`. |

If `✔ Mark Done` is on your copy, do not tap it. Record Fail and tell the owner at once.

## 5. Your report

After each sprint, give the owner a table:

| Sprint | Step | Expected | What you saw | Pass / Fail |
| --- | --- | --- | --- | --- |

Then one line each for: anything that differed, any pop-up you could not read in time,
and the screenshots you took. At the end, a single summary: sprints passed, sprints
failed, and the three most important differences.
