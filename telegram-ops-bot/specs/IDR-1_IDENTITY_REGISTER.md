# IDR-1 / IDR-2 — the Telegram identity register + pending-user triage

**Status: SHIPPED 14-Aug-2026.** Owner-confirmed layout, then "go".

> "I want to test the functionality where a new Telegram user pings the
> bot and how I am going to register him as an existing customer, or an
> existing member in the network, or a new network member."

## What was actually there

A stranger's first contact was already captured: PendingUsers gets a row
for every unknown account, and the admin feed gets a card. But the card
had **one door and it led to Add Employee**, and none of the business's
people-sheets carried a Telegram id:

| Destination | Was it possible? |
|---|---|
| employee | yes — the only path |
| existing customer | **no** — Customers has no telegram_id column |
| existing/new network member | **no** — Contacts has none either |

So the honest answer to the owner's question was: you cannot. You would
tap Ignore, add the person separately through the ordinary flows, and
their Telegram identity was thrown away in the process — nothing
downstream (invoice delivery, catalogue shares, notifications) could ever
reach that person's chat.

## The register — one sheet, columns not blobs

The owner's ruling: *"I want user identity to be placed in one sheet…
only thing expandable should be attribute of the column or new column in
case of new attribute set, like in tabular form."*

`PendingUsers` already holds a row for every account that has ever
messaged the bot, so it **becomes** the register. Five plain end-columns,
one attribute each, no JSON:

| J | K | L | M | N |
|---|---|---|---|---|
| link_type | link_id | link_name | linked_by | linked_at |

`link_type` is `employee` \| `customer` \| `contact` (empty = not yet
placed). `link_id` is the id in that domain — the Users id, the
`customer_id`, the `contact_id`. `link_name` is stored so a row reads
without a cross-lookup; `linked_at` is Lagos wall-clock.

**Customers, Contacts and Marketers are untouched.** A Telegram id is an
attribute of the ACCOUNT, not of a customer record — putting it on three
sheets would be three places to drift. And because Contacts already binds
to Customers through its own `customer_id`, linking a customer gives the
network side for free.

`services/identityService.js` is the only door in or out.

## The triage card

```
🆕 Unknown user messaged the bot

👤 Mr femi · @femi_lagos
🆔 8968542393
🕓 13-Aug-2026, 13:09
💬 I want 5 bales of 9037, black

Who are they? Employee opens Add Employee; the other two
record them and remember this Telegram account for them.

[ 👔 Onboard as employee ]
[ 🤝 Link to existing customer ]
[ 🕸 Add to network ]
[ 🚫 Ignore ]
```

- **The quote is the triage signal.** "/start" tells you nothing; "I want
  5 bales of 9037" tells you at a glance whether this is a customer, a
  marketer, or noise — which is exactly the decision the chips ask for.
  A bare greeting is not quoted (it would be noise on every card).
- **The message is shown, never stored.** The register holds identity; a
  chat message is neither identity nor a business record (storage rule 5b).
- **Customer / network pickers list SOLID records only** — real CUS-1
  customers, real active Contacts nodes, never a free-text box (owner
  rule: "no recommendation, no guessing, only solid customers"). Likely
  name matches sort to the top, but every record stays reachable, because
  a guess must never hide the right answer.
- **Onboard as employee is unchanged** — the dual-admin Add Employee flow.

## Every stranger is now captured

Owner ruling. Previously only `/start` and greetings were captured;
anyone whose first message was a real request got a curt "You are not
authorized" and **vanished without a trace** — the exact person the
business most wants to know about. Now every first contact is captured
and shown, with the same polite reply and the same 10-per-hour global cap
against spam.

## Ignore stays a label

Owner ruling: left as-is. An ignored account that messages again still
re-notifies (rate-limited), so nothing is ever silently missed. The card
wording no longer promises a mute it does not perform.

## The reverse lookup, and why it is careful

`identityService.telegramIdFor(type, {id, name})` is what will let a
future invoice or catalogue reach a customer on Telegram. It matches on
**id**; when an id is supplied and does not match, it returns nothing
rather than falling back to the name, and an **ambiguous name resolves to
nothing** — two customers can share a display name, and sending one
person's document to another is worse than not sending it.

## Files

`repositories/pendingUsersRepository.js` (J–N columns, `setLink`) ·
`services/identityService.js` (new — the one door) ·
`services/schemaMapper.js` (register the widened header; SHEET-FIX-1's
width heal adds the columns to the live sheet on the next boot) ·
`services/pendingUserService.js` (four-chip card, quoted first message) ·
`controllers/telegramController.js` (`pu:cust` / `pu:net` / `pu:link` /
`pu:linkcancel`, the link picker, the widened stranger gate).

## Tests

`test/unit/services/identityRegister.test.js` — link writes only the link
columns, employee vs customer status, the reverse lookup, the refusals
(wrong id, ambiguous name), and quiet failure on a sheet outage.
`test/characterization/pendingUserTriage.test.js` — the REAL controller:
capture-and-quote, no quote for a greeting, all four chips, solid-records
picker with likeliest first, the link write and its in-place
confirmation, the expired-picker refusal, and cancel leaving no session.
Two older pins were reversed with their reasons recorded (the curt
rejection in `handleMessage.authgate`, the card heading in
`lagosTimeSurfaces`).
