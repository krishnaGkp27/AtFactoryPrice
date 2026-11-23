# WA-1 — the customer's screen on WhatsApp

**Status: PLAN for sign-off, 23-Nov-2026. Nothing is built.**

Owner, 19-Nov-2026: "I would like to migrate to WhatsApp to show them more
trust and credibility." 23-Nov-2026: "I want to migrate my customer interface
to WhatsApp … release the feature as we have in the Telegram now." Then:
"Start documenting the list of items which you need for meta … provide a
script for Claude Code to do this work for me once I log in … for the
remaining things … asking me only that … No implementation, just the planning
before final sign off."

The Meta set-up script is `docs/COWORK_WA1_META_SETUP.md`.

## 1. What is released

The customer's screen that exists on Telegram today, on WhatsApp: the designs
allocated to them, the pictures, the shades, and "request this shade". The
request goes through Dispatch and admin approval exactly as now.

| Stays on Telegram | Moves to WhatsApp |
|---|---|
| Staff, approvals, Dispatch, every admin screen | The customer's My Collection |
| The customer's Telegram screen, until WhatsApp is proven | |

Not in this release: the supply notice, My Supplies, the infographic,
reminders. They come after, on both channels.

## 2. The integration

Meta's WhatsApp Cloud API, connected directly to the bot. No provider in
between, and no unofficial library (ruled out in August: it risks a ban).

| Piece | State today |
|---|---|
| Sending a template message through Meta | Built in August, asleep |
| Receiving a customer's message | Not built. This is the main work. |
| Recognising the customer | Not built for WhatsApp |

## 3. Stages and time

| Stage | What | Time | Waits on |
|---|---|---|---|
| 0 | Meta set-up, Part A of the script | 1 to 2 hours of the owner's | The owner's login |
| 1 | Receive and send, recognise the customer, consent and STOP, tap logging | 2 to 3 days | Stage 0 |
| 2 | My Collection on WhatsApp | 2 days | Stage 1 |
| 3 | Pilot with one customer | 3 to 5 days of real use | A working number |
| 4 | Release to every customer | 1 day | The owner's go, Meta's verification |

Meta's business verification is the slow part. A partner's guide says up to 14
business days. Posts on Meta's forum this month report 30 days and more.

Offline tests cover the logic. Receiving messages and sending pictures can
only be proven on the live platform, so the pilot will bring fixes.

## 4. What the customer sees

Every step is a new message. WhatsApp cannot redraw a card in place.

**1. The customer writes anything.**

```
Hello Amib International.
Messages here are from AtFactoryPrice about your supplies.
Reply STOP at any time to end them.

[My Collection]
```

The second and third lines appear on the first contact only.

**2. My Collection.** A list of ten rows: nine designs and "More designs".

```
Your collection · 14 designs
Supplied to you / allocated to you, in bales.

[Choose a design]
   202/201 (28B / 48B)
   9006 (12B / 20B)
   …
   More designs
```

**3. A design.** The catalogue picture, then a list of its shades.

```
[picture]  202/201

202/201 · choose a shade
[Choose a shade]
   Shade 3 (2B / 4B)      Navy Blue
   Shade 5 (1B / 2B)      Black
   Take ALL
   Back to designs
```

**4. A shade.** The garment picture with three buttons.

```
[picture]  202/201 · 3 - Navy Blue (2B / 4B)

[Request this shade]  [Full picture]  [Back]
```

**5. After the request.**

```
Request sent. Your admin will confirm supply.

[My Collection]
```

**6. The decision.** In plain customer wording, with no admin name and no
store name (Business Rules section 16):

```
Your request for 202/201 · 3 - Navy Blue is confirmed. We will supply it shortly.
```

To try at build: Meta's picture-card row (2 to 10 cards, each a picture and a
button) for steps 2 and 3. Meta's page does not say whether it can be sent as
an ordinary reply, so the plan above does not depend on it.

## 5. What cannot be the same

Confirmed on Meta's pages, 23-Nov-2026.

| On Telegram today | On WhatsApp |
|---|---|
| One card that redraws in place | Every step is a new message |
| Up to 24 design chips on one card | A list of 10 rows |
| Shade chips directly under the picture | The picture, then a separate list. A list carries no picture. A picture carries at most 3 buttons. |
| Long chip labels | 24 characters a row, 20 a button, 72 on the second line |
| Pop-up notes | Ordinary messages |
| The bot removes its old cards | Old messages stay. Old buttons are checked again when tapped. |
| Catalogue pages as one album | Pictures one at a time |
| Free, unlimited messages | Free replies only within 24 hours of the customer's last message. After that, a paid, pre-approved message. |

Only on WhatsApp: the bot may write first to a customer who agreed, the
customer is recognised by phone number, and the business has a profile with
its name, logo and address.

## 6. How a customer is recognised

1. The customer writes to the number. A bill, a QR code or a staff message
   carries the link `wa.me/<number>?text=Hi`.
2. The bot looks the phone number up on the Customers sheet.
3. Admins get a card in Telegram: `WhatsApp +234 806 256 2752 wrote "Hi" ·
   matches Amib International by phone` with `Link to Amib International` ·
   `Another customer` · `Ignore`.
4. One tap links the account. From then on the customer is recognised.

A customer who hides their number behind a WhatsApp username arrives with
Meta's business-scoped id and no number. The bot stores that id and asks for
the number with Meta's "share your contact" button.

## 7. Storage

**One sheet change, for sign-off.** The identity register (the PendingUsers
sheet) gains two last columns. No existing column moves.

| Column | Name | Holds |
|---|---|---|
| P | `whatsapp_number` | The WhatsApp phone number of the account |
| Q | `whatsapp_user_id` | Meta's business-scoped id of the account |

A WhatsApp account is its own row. A customer with both a Telegram account and
a WhatsApp account has two rows linked to the same customer id. This follows
the ruling of 14-Aug-2026: identity in one sheet, a new column for a new
attribute.

**In the Railway database** (logs and event trails never go to a sheet):

| Table | Holds |
|---|---|
| `wa_messages` | Each message received and sent: time, direction, kind, Meta's id, delivery status. No message text beyond the button tapped. |
| `wa_consent_events` | First contact, STOP, START, with the time |
| `usage_events` (exists) | Every customer tap, role `customer`, channel `whatsapp` |

## 8. Code

| New | Role |
|---|---|
| `src/controllers/whatsappController.js` | The webhook: Meta's handshake, the signature check, one message in |
| `src/services/whatsapp/` | Sender (text, picture, buttons, list, file, template), identity, consent |
| `src/flows/customerCollectionWa.js` | The six screens of section 4 |
| `src/services/customerCollection.js` | What a customer may see, shared by Telegram and WhatsApp |
| `server.js` | Two routes, and the raw body kept for the signature check |
| Migration 006 | The two tables |

**Ask-first files this plan touches, for sign-off:**

| File | Change |
|---|---|
| `src/events/approvalEvents.js` | The notice to the requester goes through one small router, so a WhatsApp customer gets the decision on WhatsApp in customer wording. A Telegram customer gets the same customer wording, which closes the gap found on 20-Nov (the admin's name and the store name on a rejection). |
| `src/controllers/telegramController.js` | One block: the admins' link card for a WhatsApp account (`wal:` taps) |
| `src/services/schemaMapper.js` | The two header cells |

No new action code. A customer's request is the existing `supply_request`.

## 9. Switches and keys

Settings sheet:

| Key | Default | Meaning |
|---|---|---|
| `WHATSAPP_CUSTOMER_ENABLED` | 0 | 1 = the bot answers customers on WhatsApp |
| `WHATSAPP_PILOT_NUMBERS` | blank | While set, only these numbers are answered. Blank with the switch on = every linked customer. |

Railway variables (values typed by the owner, never in chat):

| Variable | What |
|---|---|
| `WHATSAPP_META_ACCESS_TOKEN` | The permanent token (name exists in the code) |
| `WHATSAPP_META_PHONE_NUMBER_ID` | The number's id (name exists in the code) |
| `WHATSAPP_META_WABA_ID` | The WhatsApp Business Account id |
| `WHATSAPP_META_APP_SECRET` | Proves a message really came from Meta |
| `WHATSAPP_META_VERIFY_TOKEN` | A word chosen by the owner, typed in Meta and in Railway |

`WHATSAPP_PROVIDER` stays unset until the build ships, so nothing wakes early.

## 10. Decided by the agent. Say if different.

| # | Decision | Why |
|---|---|---|
| D1 | A new number used only by the bot | The simplest and cheapest. Keeping the current number in the app as well needs a paid provider. |
| D2 | An admin confirms the link once per customer | A wrong match would show one customer another's collection |
| D3 | The consent sentence of section 4, step 1 | Short, and STOP is the word Meta expects |
| D4 | Display name `AtFactoryPrice` | The name on the website. Meta reviews it. |
| D5 | The customer's Telegram screen stays until the owner retires it | Nothing is lost during the pilot |
| D6 | The decision message uses customer wording on both channels | Section 16: no admin name, no store name |
| D7 | The bot serves a privacy page at `ops.atfactoryprice.live/privacy` | Meta asks for one, and the website has none today |
| D8 | Outside the 24-hour window a decision goes as a utility template | The only way Meta allows |

Message templates to submit, drafted for the owner's approval:

| Name | Kind | Text |
|---|---|---|
| `supply_request_confirmed` | Utility | Hello {{1}}, your request for {{2}} is confirmed. We will supply it shortly. |
| `supply_request_declined` | Utility | Hello {{1}}, we could not confirm your request for {{2}}. Please contact us for details. |

## 11. Needed from the owner

| # | Item | Needed for | State |
|---|---|---|---|
| 1 | The legal company name, exactly as on the registration certificate | Meta's verification | **Ask** |
| 2 | The Facebook account that will own the business, with two-factor on | The login | **Ask** |
| 3 | The website address to give Meta | Verification | **Ask** |
| 4 | The registered address and business phone, as on the documents | Verification | **Ask** |
| 5 | Registration certificate, tax certificate, a bill or bank statement | Verification, uploaded by the owner | In the owner's Drive (see below) |
| 6 | A new SIM for the bot | Part B of the script | Later |
| 7 | The test customer's name and WhatsApp number | The pilot | Later |
| 8 | Sign-off on section 7 (two columns) and section 8 (three files) | The build | **Ask** |

The list to forward to whoever holds the papers is `docs/WA-1_DOCUMENTS_NEEDED.pdf`
(source `docs/WA-1_DOCUMENTS_NEEDED.html`, printed to PDF with the pre-installed browser).

**The company documents (owner, 23-Nov-2026).** "I will be uploading the all
necessary documents related to the company, which will be stored in Drive …
you can fetch it as and when needed, asking me the permission, since those
are the sensitive documents." The rule for every session:

- Ask the owner in chat before each read, and name the file. No search of his
  Drive without that.
- Read only what the task needs (the legal name, the address, the phone, a
  registration number). Say what was taken.
- Never copy a document, or a picture of one, into the repository, a commit,
  a spec, a test or any outside service. The connector is used to read only.
- Meta's upload is the owner's own click. No agent uploads a company
  document anywhere.

With the documents readable, items 1 and 4 of the table need no typing from
the owner: the agent reads them off the certificate, with his permission.

Found while preparing this: the website's contact page shows no phone number
and there is no privacy page. Meta's reviewers compare the website with what
is typed into the business details. D7 covers the privacy page. The name,
address and phone on the website are the website workstream, which is outside
the bot's folder.

## 12. Not verified

- Whether Meta's picture-card row can be sent as an ordinary reply.
- Whether a Nigerian number can keep the WhatsApp app and the API together.
  Not needed under D1.
- Where exactly the app secret, the webhook fields and the payment method sit
  on Meta's screens today. The script tells Claude to stop when a screen
  differs.
- Meta's own page of accepted documents needs a login. The list comes from a
  Meta partner's guide and names no Nigerian document.

## 13. Sources

Meta: [list messages](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-list-messages),
[reply buttons](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages),
[picture-card rows](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-media-carousel-messages),
[message types](https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages),
[pricing](https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing),
[business-scoped ids](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-scoped-user-ids/),
[phone numbers](https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/phone-numbers),
[get started](https://developers.facebook.com/documentation/business-messaging/whatsapp/get-started).
Verification steps: [360dialog's guide](https://docs.360dialog.com/docs/resources/meta-business-verification/standard-business-verification).
