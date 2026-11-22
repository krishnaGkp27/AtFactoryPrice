# TRF-24 — ✖ Cancel a waiting receipt, from the first card

Shipped 22-Nov-2026.

Owner, 22-Nov-2026, on the admins' card `📥 Receipt 1 to confirm` (19Nov·03,
IDUMOTA → Kano office, 5 bales): "I can see that there is only an option to
confirm the receipt, but there is no option to cancel. Since the recipient
has to log all the bales which he has received over the period of time
instantly, like this, or, if he is logging at the end of the day, he must
raise a single request card having all the bales which he has received …
Please add this cancel button so that he can raise a single one instead of
multiple."

## 1. What was there

The way out existed, but one level down and under another name. The first
card offered `🛂 Confirm Receipt 1` only. Tapping it opened a second card,
and only there sat `↩️ Send back`, which then asked for a typed reason. An
admin looking at the first card saw a single choice.

## 2. Now

**The first card** (the message to the admins, the hourly re-send, the
transfer opened from 📋 Transfers, 🛂 Approvals or My Tasks):

```
[🛂 Confirm Receipt 1]
[✖ Cancel Receipt 1]
[📦 5 bales — view all]
[📄 Dispatch doc]
[📎 Receipt 1]
```

**✖ Cancel Receipt 1** opens the reasons. Nothing is cancelled yet.

```
✖ Cancel receipt 1 of 19Nov·03
Nothing moves. Muhammad gets the card back and reports again.

Why? Tap a reason, or reply with your own in one line (3–120 characters).

[📦 Report all bales in one receipt]
[🔢 The bales do not match]
[📎 Document missing or unclear]
[⬅ Back to the transfer]
```

One tap on a reason cancels the receipt. A typed line does the same.

| Who | Gets |
|---|---|
| The admin who cancelled | `📥 Receipt 1 of 19Nov·03 — cancelled by you` · `Reason: Report all the bales you have received in one receipt.` · `Nothing changed. Muhammad has the card back to report again.` |
| The receiver | `✖ Receipt 1 of 19Nov·03 cancelled by Krishna` · `Reason: …` · `Nothing moved. Report again from this card.` + his card with `✅ Received` and `📦 Only some arrived — tick them` |
| The other admins | `… receipt 1 cancelled ✖ by Krishna` |

The reason then stays on the receiver's own card until he reports again:
`✖ Receipt 1 was cancelled — Report all the bales you have received in one
receipt.` So the instruction is in front of him where he acts, not only in a
message that scrolls away.

Nothing moves on the Inventory sheet. The transfer stays open. The cancelled
receipt keeps its number and its document (`📎 Receipt 1`), and reads on the
admins' card as `✖ cancelled by Krishna — <reason>`. His next report is
Receipt 2.

## 3. The rule this serves

Locked in BUSINESS_RULES §8: a receiver reports each delivery when it
arrives, or everything received together in ONE receipt at the end of the
day. The first reason chip is that rule, so an admin enforces it in two taps
and the receiver is told exactly what to do.

## 4. Decided

| # | Decision | Why |
|---|---|---|
| D1 | The word is **Cancel**, on every card and message. The drill-down's `↩️ Send back` is now `✖ Cancel receipt`. | The owner's word. "Send back" also read as sending the goods back, which is `⚠️ Reject`. |
| D2 | A reason is always given, by chip or typed | The receiver must know what to do differently |
| D3 | Any admin except the one who reported the receipt | As Confirm (two people on every receipt) |
| D4 | The record is unchanged: status `sent_back`, `sentBackBy`, `reason` on the transfer's own row; audit and event `receipt_sent_back` | No data to migrate; only the words on screen changed |
| D5 | The reasons are three fixed lines in code | Say the word for a Settings cell |

## 5. A fault found and fixed on the way

The typed "why?" step stayed armed for 30 minutes after the admin left the
prompt with ⬅ Back. Any line he typed in that time was taken as the reason
and the receipt was sent back. Verified on the code before this change: a
line "remember to call the driver tomorrow" cancelled receipt 1.

Now the typed step belongs to the prompt on screen. A tap that redraws that
message (⬅ Back, any card button) ends it. A tap on another message, for
example opening the document, leaves it armed, because the prompt is still
on screen. A reason chip on an old prompt is re-checked at the tap and never
ends some other flow the admin has opened since.

## 6. Code

`src/flows/transferFlow.js`: `RECEIPT_CANCEL_REASONS`, `receiptReviewCard`
(the second button), `askSendBackReason` (the reasons), `handleCancelReason`
(`trf:rcnr:<id>:<n>:<k>`, session-free, admin re-checked at the tap),
`completeSendBack` (the words; ends only its own step), `receiverCard` (the
note; `opts.noCancelNote` for the cancellation message itself),
`reportsBlock`, `handleCallback` (the typed step ends with its prompt).

No controller change, no service change, no sheet change, no Settings key,
no action code.

Tests: `test/characterization/transferReceiptGate.test.js` (4 new, 2
updated).

## 7. Not built: ideas for the same rule

| # | Idea | What it does |
|---|---|---|
| R1 | The receiver's own `↩️ Take back Receipt n` | He withdraws a receipt no admin has decided, and reports once. No admin needed for his own mistake. |
| R2 | `➕ Add bales to Receipt n` while it waits | More bales arrive: the waiting receipt grows. One card per transfer by construction. |
| R3 | The rule on his screen | One line on the tick screen and on "receipt reported": report each delivery as it arrives, or everything together in one receipt. |
| R4 | A flag for the admin | `⚠️ 2nd receipt today on this transfer` on the card when the same receiver reports the same transfer twice in a day. |

One card for bales of several transfers is not offered: each transfer has
its own dispatch document and its own bales.

## 8. Live check

1. A receiver reports part of a load with a photo.
2. On an admin phone the card shows `🛂 Confirm Receipt 1` and, under it,
   `✖ Cancel Receipt 1`.
3. Tap Cancel, then `📦 Report all bales in one receipt`.
4. The receiver gets the reason and his card back. Nothing changed on the
   Inventory sheet.
5. The receiver opens the transfer from My Tasks: the reason is on the card.
6. He taps `✅ Received` and sends one photo: Receipt 2, every bale.
