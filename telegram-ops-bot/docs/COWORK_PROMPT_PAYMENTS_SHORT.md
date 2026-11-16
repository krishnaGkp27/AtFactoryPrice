# Cowork prompt — admin seat, `black_panther` bot, Payments (short)

Paste everything below the line into Claude Cowork. The long version, with every expected
line, is `docs/COWORK_ADMIN_SEAT_PAYMENTS.md`.

---

You are working ONE admin's Telegram account in Telegram Web, in the chat with the bot
`black_panther` (it was called AtFactoryPrice before). You test its Payments. This is the
live bot with the company's real records. Abdul, the office manager, does his steps on his
own phone. Krishna, the owner, supervises you and answers your questions.

## Rules

1. Work only in the `black_panther` chat. Show Krishna the chat title first and wait for "yes".
2. Do only the numbered steps below. Do not explore.
3. Before every tap on `✅ Approve`, quote the card to Krishna and wait for "yes". If the
   request's card in `🛂 Approvals` says `⚠️ 1 of 2 approvals already given`, your tap would
   be the LAST approval: say so before you ask.
4. If the bot asks `💳 Pay from which account?`, ask Krishna which button to tap. Never
   choose by yourself.
5. Never tap `✔ Mark Done`. Never tap `✖ Decline`, `⧉ Send anyway` or
   `⧉ Reject as duplicate` unless Krishna tells you to.
6. Never type a line that starts with `Price`, `Sell`, `Return`, `Transfer`, `Receive`,
   `Delivered`, `Done`, `Order` or `Task`.
7. If anything differs from "Expect", stop, take a screenshot and tell Krishna.

## How to work

- Type `menu` to open the menu.
- A pop-up is the small note Telegram shows after a tap. A white box with OK must be closed.
- Names, dates, amounts and reference numbers will differ. Everything else should match.
- When a step says "wait", look at the bottom of the chat every 15 seconds for up to 3 minutes.

## Steps

| # | Do | Expect |
| --- | --- | --- |
| 1 | Type `menu`. Open `💰 Finance` → `💳 Payments`. Then tap `🏠 Back to menu`. | `💳 Payments` and a line `Finance: [name] pays and marks done.` Write down that name. |
| 2 | Wait for Abdul's account registration. Read the number and bank to Krishna. On "yes", tap `✅ Approve`. | Card `🔔 Approval required` with `Register payment account: [Abdul] (employee)` and `Account: [number] · [bank]`. After the tap: pop-up `🔏 Approval 1 of 2 recorded.` |
| 3 | Wait for Abdul's payment request. Quote it to Krishna. On "yes", tap `✅ Approve`. | Exactly ONE card: `Payment request: ₦…`, `Payee: [Abdul] (employee)`, `Account: …`, `Reason: …`. After the tap: pop-up `🔏 Approval 1 of 2 recorded.` |
| 4 | When Krishna says Abdul asked for the same payment again, look at the chat and at `🛂 Approvals` → `💳 Payments`. | No second card. One line only for that payment. |
| 5 | Only for a request whose reason reads `TEST do not pay`, and only when Krishna says so: open it in `🛂 Approvals` → `💳 Payments` and tap `❌ Reject`. | `❌ Request … rejected.` |
| 6 | Only when Krishna says the other admin has already approved: tap `✅ Approve` on that payment. Ask Krishna which account. Tap it. | Pop-up `Choose the account to pay from.` and a new card `💳 Pay from which account?` with one `🏦` button per account and `✖ Not now`. After the account tap: `✅ Request … approved by … Changes applied.` and `… now with finance to pay. Paying from [account].` |
| 7 | Wait for the customer payment Abdul records. Ask Krishna: real or test? Real: on "yes" tap `✅ Approve`. Test: tap `❌ Reject`. | One card `Record Payment Request` with `Customer: …`, `Amount: …`, `Method: Bank — [bank]`, `Outstanding today: …`, `After this payment: …`. Approve gives `🔏 Approval 1 of 2 recorded.` Reject gives `❌ Request … rejected.` |
| 8 | Open `🛂 Approvals` → `✅❌ Decided` → tap one request → `❌ Close`. | The request's card, then `Already approved by …` or `Already rejected by … — no action needed.` No Approve or Reject button. |

## Report

After each step give: the step number, what was expected, what you saw, Pass or Fail, and
the screenshot. At the end give: steps passed, steps failed, and the three most important
differences.
