# CUS-4 — the typed customer line

Shipped 17-Nov-2026.

## 1. The owner's words

On a screenshot of an employee typing three lines and getting the chips
card:

> "My office employees aren't able to add customer by direct typing. Can you
> propose an immediate fix."

After the proposal: **"Go with all your recommendations."**

## 2. What was wrong

There was no typed line for a customer. The only way in was 👥 CRM →
➕ Add Contact: about ten screens for a customer (kind, name, phone, address,
category, credit limit, payment terms, notes, store, confirm). The one-line
⚡ Quick Add inside that door is admin-only and writes with no approval.

## 3. What the bot reads now

Read locally, with no AI, in every `AI_TEXT_PARSER` mode.

| Shape | Example |
|---|---|
| Bare lines | `Amib international` / `0806 256 2752` / `Kano` |
| Bare, commas | `Amib international, 0806 256 2752, Kano` |
| Worded | `Customer Amib international, 0806 256 2752, Kano` |
| Worded, no commas | `Customer Amib international 0806 256 2752 Kano` |

Also `Add customer …`, `New customer …`, and labels (`Name:`, `Phone:`,
`Address:`), which are read and dropped.

**The phone number is the signal.** Seven to fifteen digits, with the usual
`+`, spaces, dashes, dots and brackets. A message with no phone number is
never a customer line:

- `Customer Abba` still opens Abba's details.
- `Add customer Mariam` still answers with the Add Contact button, and now
  shows the typed line as well.
- One undivided sentence (`call me on 0806…`) is never read as a person. The
  bare form needs separate lines or commas.

Parts: the first part that is not a phone is the name. The first phone is
the phone. Everything else is the address. A second phone number is kept as
a note (`Other phone: …`), never dropped. Two to six parts, each at most 80
characters. Markdown characters are removed from the name and address so
they cannot break the card.

## 4. What it opens

The ➕ Add Contact door's own confirm card, filled in:

```
➕ Add contact
✓ Type: 🛒 Customer
✓ Name: Amib international
✓ Phone: 0806 256 2752
✓ Address: Kano
✓ Store: Kano office (provisional)

Confirm and submit for admin approval?
[✅ Submit for Approval] [❌ Cancel]
[✏️ Change details]
```

It is a shortcut INTO the one door (BUSINESS_RULES §12b), not a second one:
the same session, the same Submit, the same `add_contact` request, the same
admin card with its 🛒 Customer · 📒 Contact · 🕸 Network · ❌ Reject chips.

The owner's four rulings:

| Question | Ruling |
|---|---|
| Bare three lines with no word in front | Read |
| Category, credit limit, payment terms | The door's defaults: Retail · 0 · COD. `✏️ Change details` walks the full form from the name |
| Who may type it | Every employee and admin. A linked customer or marketer never reaches typed lines |
| The town | Goes to Address. The store follows the door's rule (CRM-R1): a one-store employee's store is stamped; an admin or multi-store employee picks, or places later |

## 5. What still stands in front of it

This amends §9's "no free-typed customer names" (29-Jul-2026), which was
written during the typo cleanup. Everything that rule protected is kept:

- **The freeze.** Settings `CUSTOMER_CREATION_ENABLED = 0` pauses the typed
  line too.
- **The duplicate check.** A name that matches an existing customer's name
  or alias opens nothing and says who it already is.
- **A person confirms.** The line saves nothing. The employee sees the card
  and taps Submit.
- **An admin approves**, and can re-route the kind with the chips.

## 6. Switch

Settings `TYPED_CUSTOMER_LINE` (default 1). `0` = the line is not read, as
before 17-Nov-2026. No deploy.

## 7. Not done

- Other kinds (worker, agent, supplier) have no typed line. The line is for
  customers.
- The typed place does not choose the store. Say the word if a typed `Kano`
  should pre-pick the Kano store for admins.
- Category, credit limit and terms cannot be typed on the line.

## 8. Live check

1. From an employee's phone send the three lines of §3. The card of §4
   appears with that employee's store.
2. Tap ✅ Submit for Approval. An admin gets the usual Add contact card.
   Approve it. The customer is in the customer list and the network.
3. Send the same three lines again. The bot answers that the name is already
   on the customer list and opens nothing.
4. Send `Customer Abba` (a real customer, no phone). Their details open.
5. From an admin's phone send the three lines. The store question comes
   first, then the confirm card.
