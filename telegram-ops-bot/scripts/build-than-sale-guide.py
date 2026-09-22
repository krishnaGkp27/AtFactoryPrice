#!/usr/bin/env python3
"""SELL-1 — build the operator guide for selling thans from a store (docs/SELL-1_THAN_SALE_GUIDE.pdf).

Usage (regenerate after any wording change in the flow):
    python3 scripts/build-than-sale-guide.py
    chromium --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
      --print-to-pdf=docs/SELL-1_THAN_SALE_GUIDE.pdf docs/SELL-1_THAN_SALE_GUIDE.html

Every card body/button string is copied from the shipped code (src/flows/bundleSaleFlow.js and
src/events/approvalEvents.js on main @ e1da057c, 22-Sep-2026); numbers are a worked example.
"""
import html, pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "docs" / "SELL-1_THAN_SALE_GUIDE.html"

# ── card renderer ────────────────────────────────────────────────────────
def md(t):
    """Telegram Markdown -> HTML, the way the phone shows it."""
    t = html.escape(t)
    out, i, n = [], 0, len(t)
    while i < n:
        c = t[i]
        if c == "*":
            j = t.find("*", i + 1)
            if j > i:
                out.append(f"<b>{t[i+1:j]}</b>"); i = j + 1; continue
        if c == "_":
            j = t.find("_", i + 1)
            if j > i:
                out.append(f"<i class=dim>{t[i+1:j]}</i>"); i = j + 1; continue
        if c == "`":
            j = t.find("`", i + 1)
            if j > i:
                out.append(f"<code>{t[i+1:j]}</code>"); i = j + 1; continue
        out.append(c); i += 1
    return "".join(out).replace("\n", "<br>")

def card(body, buttons=(), kind="text", photo=None, caption=None, time="01:31", note=None):
    """One Telegram message bubble. kind: text | photo | document."""
    p = []
    p.append('<div class="tg">')
    p.append('<div class="bubble">')
    if kind == "photo":
        p.append(f'<div class="pic">{photo or ""}</div>')
    if kind == "document":
        p.append(f'<div class="doc"><span class="dicon">📄</span><span class="dname">{html.escape(photo or "")}</span></div>')
    text = (caption or body) if kind in ("photo", "document") else body
    if text:
        p.append(f'<div class="txt">{md(text)}</div>')
    p.append(f'<div class="time">{time}</div>')
    p.append("</div>")
    for row in buttons:
        p.append('<div class="krow">')
        for b in row:
            p.append(f'<div class="kbtn">{html.escape(b)}</div>')
        p.append("</div>")
    p.append("</div>")
    if note:
        p.append(f'<div class="cardnote">{note}</div>')
    return "".join(p)

def step(n, title, lead, right, tip=None, warn=None):
    t = [f'<div class="step"><div class="sleft">',
         f'<div class="snum">{n}</div><div class="stitle">{title}</div>',
         f'<div class="slead">{lead}</div>']
    if tip:
        t.append(f'<div class="tip">{tip}</div>')
    if warn:
        t.append(f'<div class="warn">{warn}</div>')
    t.append('</div><div class="sright">' + right + '</div></div>')
    return "".join(t)


# ── the real strings (bundleSaleFlow.js + approvalEvents.js, main @ e1da057c) ──
# Worked example: container Mar26, store IDUMOTA, design 202/201, seller Abdul,
# admin Krishna, buyer ABBA. Quantities are illustrative; wording is verbatim.
PLUR = "thans"

S_CONT = "🧵 *Bundle Sale — pick container*\n\n🚢 Select container (arrival batch):"
B_CONT = [["🚢 Mar26 · 412 than", "🚢 Jun26 · 96 than"], ["❌ Cancel"], ["🏠 Back to menu"]]

S_WH = "🧵 *Bundle Sale — pick warehouse*\n🚢 Container: *Mar26*\n\nWhich location are you selling from?"
B_WH = [["🏬 IDUMOTA"], ["🏬 Kano office"], ["⬅ Back to containers"], ["❌ Cancel"]]

S_DESIGN = "🧵 *Bundle Sale — IDUMOTA*\n🚢 Container: *Mar26*\n\nPick a design to drill into:"
B_DESIGN = [["🎨 202/201 · 5 shades · 1,380 yd"], ["🎨 9037 · 3 shades · 640 yd"], ["🎨 77019 · 2 shades · 410 yd"], ["⬅ Back"], ["❌ Cancel"]]

S_SHADE = "🧵 *202/201* @ *IDUMOTA*\n\nPick a shade to open its bales:"
B_SHADE = [["1 - White (24 " + PLUR + ")", "2 - Dark Brown (18 " + PLUR + ")"],
           ["3 - Navy Blue (12 " + PLUR + ")", "4 - Royal Blue (11 " + PLUR + ")"],
           ["5 - Taupe Grey (18 " + PLUR + ")"],
           ["✅ Take ALL 5 shades (83 " + PLUR + ")"], ["⬅️ Back to designs"], ["❌ Cancel"]]

S_BALES = "🧵 *202/201*  🟢 *1 - White*  @ IDUMOTA\n\nTap a *bale number* to take the whole bale, or *➡️* to pick thans inside it.\n⬜ none · ◪ some · ✅ whole bale."
B_BALES = [["⬜ 🟢 5804 · 6 than", "➡️"], ["⬜ 🟢 5805 · 6 than", "➡️"], ["⬜ 🟡 5611 · 6 than", "➡️"], ["⬜ 🔴 5402 · 6 than", "➡️"],
           ["🎨 Change shade"], ["❌ Cancel"]]

S_DETAIL = "📦 *Bale 5804*  ·  6 than · 150 yd\n🟢 *1 - White* · 202/201 @ IDUMOTA · 🟢 12d (fresh)\n\nSelected: *0/6* than. Tap a than to toggle it."
B_DETAIL = [["⬜ #1 · 25y", "⬜ #2 · 25y", "⬜ #3 · 25y"], ["⬜ #4 · 25y", "⬜ #5 · 25y", "⬜ #6 · 25y"],
            ["📦 Take whole bale"], ["⬅ Back to bales"], ["❌ Cancel"]]
S_DETAIL_3 = "📦 *Bale 5804*  ·  6 than · 150 yd\n🟢 *1 - White* · 202/201 @ IDUMOTA · 🟢 12d (fresh)\n\nSelected: *3/6* than. Tap a than to toggle it."
B_DETAIL_3 = [["☑️ #1 · 25y", "☑️ #2 · 25y", "☑️ #3 · 25y"], ["⬜ #4 · 25y", "⬜ #5 · 25y", "⬜ #6 · 25y"],
              ["📦 Take whole bale", "🧹 Clear bale"], ["🛒 Cart · 3 than(s) · 75 yd"], ["⬅ Back to bales"], ["❌ Cancel"]]

S_BALES_2 = S_BALES
B_BALES_2 = [["◪ 🟢 5804 · 3/6 than", "➡️"], ["⬜ 🟢 5805 · 6 than", "➡️"], ["⬜ 🟡 5611 · 6 than", "➡️"], ["⬜ 🔴 5402 · 6 than", "➡️"],
             ["🛒 Cart · 3 than(s) · 75 yd"], ["🎨 Change shade"], ["❌ Cancel"]]

S_CART = "🛒 *Cart · 5 than · 125 yd · 2 bale(s)*\n\n🟢 *1 - White* — 75 yd · 3 than · 1 bale(s)\n🔵 *3 - Navy Blue* — 50 yd · 2 than · 1 bale(s)\n"
B_CART = [["🔽 Expand 1 - White"], ["🔽 Expand 3 - Navy Blue"], ["➕ Add more thans"], ["✅ Continue — seller, date, bill"], ["❌ Cancel"]]
S_CART_X = "🛒 *Cart · 5 than · 125 yd · 2 bale(s)*\n\n🟢 *1 - White* — 75 yd · 3 than · 1 bale(s)\n   · Bale 5804 — #1, #2, #3 = 75 yd\n🔵 *3 - Navy Blue* — 50 yd · 2 than · 1 bale(s)\n"
B_CART_X = [["🔼 Collapse 1 - White", "🗑 Remove all 1 - White"], ["🔽 Expand 3 - Navy Blue"], ["… same buttons as above"]]

S_SELLER = "🧑 *Who sold this?*\n\nPick the salesperson — it is stamped on the sales record."
B_SELLER = [["🧑 Abdul", "🧑 Musa"], ["🧑 Muhammad"], ["⬅ Back"], ["❌ Cancel"]]

S_DATE = "📅 *When was it sold?*\n\nTap the sale date.\n_Beyond yesterday is flagged BACKDATED to the approver._"
B_DATE = [["📅 Today (22-Sep-2026)"], ["Yesterday (21-Sep-2026)"], ["20-Sep-2026", "19-Sep-2026"], ["18-Sep-2026", "17-Sep-2026"],
          ["📆 Older date — calendar"], ["⬅ Back"], ["❌ Cancel"]]

S_CONFIRM = ("🧾 *Confirm sale*\n\n*202/201* @ *IDUMOTA*\n🟢 1 - White — 75 yd · 3 than\n🔵 3 - Navy Blue — 50 yd · 2 than\n\n"
             "*Total: 5 than · 125 yd*\n\n🧑 Abdul\n📅 22-Sep-2026\n\n_Next: the sales bill, then it goes for approval._\n"
             "_Customer, rate and payment are set at approval — you get the customer name back here once approved._")
B_CONFIRM = [["📎 Attach bill & submit"], ["🧑 Change seller", "📅 Change date"], ["⬅ Back"], ["❌ Cancel"]]
S_CONFIRM_BD = ("🧾 *Confirm sale*\n\n*202/201* @ *IDUMOTA*\n🟢 1 - White — 75 yd · 3 than\n🔵 3 - Navy Blue — 50 yd · 2 than\n\n"
                "*Total: 5 than · 125 yd*\n\n🧑 Abdul\n📅 18-Sep-2026\n\n⚠️ *BACKDATED — 4 days back.* The approver sees this flag and it is stamped on the record.\n\n"
                "_Next: the sales bill, then it goes for approval._\n_Customer, rate and payment are set at approval — you get the customer name back here once approved._")

S_BILL = "📎 *Send the sales bill*\n\nPhoto or PDF of the bill for this sale — it is required before the request goes for approval.\n\n_Nothing is submitted until the bill arrives._"
B_BILL = [["⬅ Back"], ["❌ Cancel"]]
S_BILL_BAD = "⚠️ Please send a *photo* or *PDF* of the sales bill."

S_SUBMITTING = "⏳ *Submitting for approval…*"
S_SUBMITTED = ("⏳ *Submitted for approval*\n\n• Request: `4f72be16-982c-4241-b5d6-165b8db23cc6`\n• Items: *5 than · 125 yd*\n• Approver: 2nd admin (you cannot self-approve)\n\n"
               "_The admin assigns the customer, rate and payment when approving — you will get the customer name and number back here once approved._")
B_SUBMITTED = [["🏠 Menu"]]

# admin side
S_ADMIN_DM = ("🔔 *Approval required*\n\nRef: `4f72be16-982c-4241-b5d6-165b8db23cc6`\nFrom: Abdul\n\n🧾 Sale · IDUMOTA\n🧑 Abdul · 📅 22-Sep-2026\n\n"
              "🧵 202/201\n  • 1 - White · 5804 #1, #2, #3 · 75 yd\n  • 3 - Navy Blue · 5611 #2, #4 · 50 yd\n\nΣ 5t · 125 yd\n📎 Sales bill\n\n_Sent for approval_\n\nUse buttons below to approve or reject.")
B_ADMIN_DM = [["✅ Approve", "❌ Reject"]]
C_ADMIN_BILL = "📎 Sales bill for request 4f72be16-982c-4241-b5d6-165b8db23cc6"

WIZ = "📋 *Confirm sale — R-4F72*"
TYPED = "\n✍️ _A typed reply goes to the request you touched last._"
S_STEP1 = WIZ + "\nDesign(s): 202/201 · 2 item(s) · From: IDUMOTA\n\n*Step 1 — Who is buying 202/201?* Tap below, or reply with a name to search.\n_Buyers of this design first, with the rate they last paid for it._" + TYPED
B_STEP1 = [["👤 ABBA — 1,450/yd"], ["👤 CJE — 1,400/yd"], ["👤 Ketu madam", "👤 Musa Bello"], ["📋 All customers"]]
S_STEP2 = WIZ + "\n\nCustomer: *ABBA*\n📒 Outstanding: 7,353,610\nDesign(s): 202/201\nUnit: yard\n\n*Step 2 — Rate:* tap below, or reply with rate per yard.\n• Single design: e.g. `1500`\n• Multiple: e.g. `44200:1500, 44201:1200`" + TYPED
B_STEP2 = [["1,450/yd — last paid by ABBA"], ["✏️ Type a custom rate"], ["✎ Change customer (ABBA)"]]
S_STEP2_NONE = WIZ + "\n\nCustomer: *ABBA*\n📒 Outstanding: 7,353,610\nDesign(s): 202/201\nUnit: yard\n\n*Step 2 — Rate:* tap below, or reply with rate per yard.\n• Single design: e.g. `1500`\n• Multiple: e.g. `44200:1500, 44201:1200`\nNo earlier sale of 202/201 to ABBA found." + TYPED
B_STEP2_NONE = [["✏️ Type a custom rate"], ["✎ Change customer (ABBA)"]]
S_STEP3 = WIZ + "\n👤 ABBA\n\n*Step 3 — Payment mode:* tap below, or reply with one of:\n• Cash\n• Paid to [Bank]\n• Not yet paid" + TYPED
B_STEP3 = [["💵 Cash", "🕐 Not yet paid"], ["🏦 ZENITH BANK", "🏦 GTBank"]]
S_STEP4 = WIZ + "\n👤 ABBA · Cash\n\n*Step 4 — Amount paid:* tap below, or reply with the amount received, e.g. 50000" + TYPED
B_STEP4 = [["✅ Paid in full — 181,250"], ["✏️ Type the amount"]]
S_STEP5 = WIZ + "\n👤 ABBA · Cash · 181,250\n\n*Step 5 — Customer-copy multiplier:* tap below, or reply with the number the entered rate is multiplied by on the customer's invoice.\n_No multiplier = the invoice prints the rate exactly as entered._" + TYPED
B_STEP5 = [["No multiplier", "Settings: 1,250"], ["✏️ Type a number"]]

S_ADMIN_OK = "✅ Request R-4F72 approved. Sale and ledger updated.\n📎 View Sales Bill"
S_ADMIN_OUT = "📒 *ABBA* — Outstanding as of today: 7,534,860"
C_INVOICE = "INV-2026-0912 · ABBA · 22-Sep-2026.pdf"
S_SELLER_OK = "✅ *Approved — ready to dispatch*\n\n👤 Customer: *ABBA*\n📞 08031234567\nRef: R-4F72"
B_SELLER_OK = [["🏠 Menu"]]

TROUBLE_SELLER = [
 ("🛒 *Cart is empty*\n\nGo back and pick a few thans, or use *🎯 Pack target yardage*.", "You tapped Continue with nothing ticked.", "Tap 🎨 Pick another shade and tick the thans."),
 ("⚠️ *1 item(s) became unavailable*\n\nDropped from cart:\n  · Bale 5804 #2 — sold\n\nReview the cart and decide.", "Someone sold that than while you were picking. The bot re-checks live stock before the confirm card.", "Tap 🛒 Open cart, check what is left, continue."),
 ("⚠️ 25-Sep-2026 is in the FUTURE — future sales are not allowed.", "You tapped a date after today.", "Tap today or the real day of the sale."),
 ("⚠️ 2026-02-01 is more than 180 days back — ask an admin if this is a genuine old sale.", "The calendar reaches 180 days back (a Settings cell). Older sales need an admin.", "Tell the admin; do not force it."),
 ("⚠️ Please send a *photo* or *PDF* of the sales bill.", "You sent text, a sticker or a voice note.", "Send the bill as a photo or a PDF file."),
 ("✅ *Already submitted.*\nRequest: `…`\n\n⏳ Waiting for admin approval.", "You tapped submit twice (or the app retried). One request exists, not two.", "Nothing. Wait for the admin."),
 ("⚠️ Bale 5611 has no available than in IDUMOTA.", "That bale is sold out here (or sits in another store).", "Pick another bale, or check the store."),
 ("❌ Cancelled.", "You tapped ❌ Cancel. Nothing was written anywhere.", "Start again from 🧵 Sell Bundles / Than."),
]
TROUBLE_ADMIN = [
 ("🔒 You cannot approve your own request — a second admin must review it.", "You raised this sale yourself. Another admin must approve it.", "Ask the other admin to open 🛂 Approvals → 💰 Sales."),
 ("Request … is already approved — no change made.", "The other admin got there first (or you tapped an old card).", "Nothing to do."),
 ("⚠️ Request R-4F72 approved, but applied only 1 of 2 Bales. Ledger updated for what was applied.", "One bale in the request was sold or moved before you approved. The rest went through.", "Check with the seller; the skipped item is listed under the card."),
 ("✅ Mark as done (no re-run)", "Every than in this request is already sold (the stock check found nothing left to apply). The button replaces ✅ Approve.", "Tap it to close the request without selling anything twice."),
 ("ℹ️ *Abba Textiles* is filed under *ABBA* — the invoice and ledger will read ABBA.", "The name you typed is an alias. The record uses the official name.", "Nothing. Continue to Step 2."),
 ("Please enter a positive number for the multiplier, e.g. 1250 — or tap No multiplier.", "Step 5 was answered with a word or a zero.", "Type a number, or tap No multiplier."),
]

def trows(items):
    return "".join(f'<tr><td class="msg">{md(m)}</td><td>{w}</td><td class="do">{d}</td></tr>' for m, w, d in items)


P = []
P.append(f"""
<section class="page cover">
  <div class="kicker">AtFactoryPrice · Telegram bot · operator guide</div>
  <h1>🧵 Selling thans from a store</h1>
  <p class="sub">The whole path, card by card, from the first tap to the invoice — first the seller, then the admin who approves.</p>
  <div class="who">
    <div><b>Who</b><br>Any active employee or admin picks the thans and sends the sale. A <b>different</b> admin approves it.</div>
    <div><b>Where</b><br>🛒 Sales &amp; Marketing → 📝 Orders → <b>🧵 Sell Bundles / Than</b></div>
    <div><b>The rule</b><br>Nothing moves until an admin approves. The sales bill is always required. Customer, rate and payment are the <b>admin's</b> to set — the seller only says what physically left.</div>
  </div>
  <div class="notebox"><b>Worked example on every page:</b> container Mar26 · store IDUMOTA · design 202/201 · seller Abdul · admin Krishna · buyer ABBA. The words on the cards are the bot's exact words; the numbers are examples.</div>
  <div class="foot">Guide version 22-Sep-2026 · built from the code on main. Regenerate with <code>python3 scripts/build-than-sale-guide.py</code>.</div>
</section>

<section class="page">
  <div class="ph">Part 1 · The seller &nbsp;·&nbsp; steps 1–3 — where and what</div>
  {step(1, "Open the door and pick the container",
        "Tap <b>🧵 Sell Bundles / Than</b>. The bot asks which container (arrival batch) the goods came in; the number is how many thans it still has. One container → this card is skipped.",
        card(S_CONT, B_CONT))}
  {step(2, "Pick the store",
        "Only asked when that container sits in more than one store. One store → skipped.",
        card(S_WH, B_WH))}
  {step(3, "Pick the design",
        "Designs are listed largest stock first, with how many shades and yards are available here. Twelve show at a time.",
        card(S_DESIGN, B_DESIGN),
        tip="⬅ Back always goes one screen up. ❌ Cancel drops everything — nothing has been written.")}
</section>

<section class="page">
  <div class="ph">Part 1 · The seller &nbsp;·&nbsp; steps 4–5 — the shade and the bale</div>
  {step(4, "Pick a shade",
        "Each button is a shade with the thans still free to take — what is already in your cart is subtracted. <b>✅ Take ALL</b> puts every remaining than of every shade in the cart in one tap.",
        card(S_SHADE, B_SHADE),
        warn="The bot never picks thans for you. Every than in a sale is ticked by a person (owner rule, TRF-15).")}
  {step(5, "Pick the bale",
        "One row per bale. Tap the <b>bale number</b> to take the whole bale; tap <b>➡️</b> to open it and tick individual thans. The dot is the bale's age: 🟢 fresh · 🟡 ageing · 🔴 stale — sell the old ones first.",
        card(S_BALES, B_BALES))}
</section>

<section class="page">
  <div class="ph">Part 1 · The seller &nbsp;·&nbsp; step 6 — ticking thans inside a bale</div>
  {step(6, "Tick the thans",
        "Each chip is one than with its yards. Tap to tick, tap again to untick. <b>📦 Take whole bale</b> ticks all of them; <b>🧹 Clear bale</b> unticks. The <b>🛒 Cart</b> bar keeps the running total and opens the cart from anywhere.",
        card(S_DETAIL, B_DETAIL) + card(S_DETAIL_3, B_DETAIL_3),
        tip="Back on the bale list the row now shows ◪ 5804 · 3/6 than — some taken. ✅ means the whole bale.")}
</section>

<section class="page">
  <div class="ph">Part 1 · The seller &nbsp;·&nbsp; between bales, and step 7 — the cart</div>
  <div class="afterbox"><div class="atext"><p><b>Then:</b> ⬅ Back to bales → tick more bales of this shade, or 🎨 Change shade → another colour of the same design, or ⬅️ Back to designs → another design. Everything you ticked stays in the cart while you move around.</p></div><div class="acard">{card(S_BALES_2, B_BALES_2)}</div></div>
  {step(7, "Review the cart",
        "One line per shade. <b>🔽 Expand</b> shows the bales and than numbers behind a line; <b>🗑 Remove all</b> takes that shade out. <b>➕ Add more thans</b> goes back to the shades.",
        card(S_CART, B_CART) + card(S_CART_X, B_CART_X))}
</section>

<section class="page">
  <div class="ph">Part 1 · The seller &nbsp;·&nbsp; steps 8–9 — who sold it, when</div>
  {step(8, "Who sold it",
        "Tap the salesperson. It is stamped on the sales record and the approver sees it.",
        card(S_SELLER, B_SELLER))}
  {step(9, "When it was sold",
        "Today and yesterday are one tap. Anything before yesterday is <b>BACKDATED</b>: allowed, but flagged to the approver and stamped on the record.",
        card(S_DATE, B_DATE))}
</section>

<section class="page">
  <div class="ph">Part 1 · The seller &nbsp;·&nbsp; steps 10–11 — confirm and bill</div>
  {step(10, "Read the confirm card",
        "Goods, total, seller and date on one card. <b>🧑 Change seller</b> and <b>📅 Change date</b> edit in place. When it is right, tap <b>📎 Attach bill &amp; submit</b>.",
        card(S_CONFIRM, B_CONFIRM),
        warn="A backdated sale carries a red line on this card — the same line the approver sees.")}
  {step(11, "Send the sales bill",
        "A photo or a PDF of the bill. This is the moment of submission: the request is created the instant the file lands — no second tap. Text, stickers or voice notes are refused.",
        card(S_BILL, B_BILL) + card(S_BILL_BAD))}
</section>

<section class="page">
  <div class="ph">Part 1 · The seller &nbsp;·&nbsp; step 12 — sent</div>
  {step(12, "Sent",
        "Your card seals into a receipt with the request number. Every admin except you receives the card and the bill. You will get the customer's name and phone number back on this same card once it is approved.",
        card(S_SUBMITTING) + card(S_SUBMITTED, B_SUBMITTED))}
</section>

<section class="page">
  <div class="ph">Part 2 · The admin &nbsp;·&nbsp; the card, and Step 1 — who is buying</div>
  {step(13, "The approval card arrives",
        "By DM the moment the seller sends it, with the bill right after; also under <b>🛂 Approvals → 💰 Sales</b> for as long as it waits, and re-sent hourly by the reminder if it is left. Tap <b>✅ Approve</b> to open the five-step wizard. If the seller was an admin, the bot skipped them and the guard refuses their tap.",
        card(S_ADMIN_DM, B_ADMIN_DM) + card("", kind="photo", photo='<div class="mockgarment"><span>the sales bill photo</span></div>', caption=C_ADMIN_BILL))}
  {step(14, "Step 1 — who is buying",
        "Buyers of this design come first, each with the rate they last paid. <b>📋 All customers</b> lists everyone; or type a name to search. A new buyer is added through ➕ Add Contact first — never typed here.",
        card(S_STEP1, B_STEP1))}
</section>

<section class="page">
  <div class="ph">Part 2 · The admin &nbsp;·&nbsp; Step 2 — the rate</div>
  {step(15, "Step 2 — the rate",
        "The first chip is the rate this buyer last paid for this design, taken from their last approved sale. One tap books it. Or tap <b>✏️ Type a custom rate</b> and reply with a number; for several designs reply with pairs, <code>44200:1500, 44201:1200</code>. <b>✎ Change customer</b> goes back to Step 1.",
        card(S_STEP2, B_STEP2),
        tip="📒 Outstanding is the buyer's balance before this sale — the credit exposure you are adding to.")}
  <div class="afterbox"><div class="atext"><p><b>No history?</b> The card says so instead of silently dropping the chip. Type the rate.</p></div><div class="acard">{card(S_STEP2_NONE, B_STEP2_NONE)}</div></div>
</section>

<section class="page">
  <div class="ph">Part 2 · The admin &nbsp;·&nbsp; Steps 3–5 — payment, amount, multiplier</div>
  {step(16, "Step 3 — payment mode",
        "Cash, a registered bank, or <b>🕐 Not yet paid</b> (credit). Banks come from the Settings sheet.",
        card(S_STEP3, B_STEP3))}
  {step(17, "Step 4 — amount paid",
        "<b>✅ Paid in full</b> is yards × rate, computed for you. Part payment: <b>✏️ Type the amount</b>. Not yet paid skips this step.",
        card(S_STEP4, B_STEP4))}
  {step(18, "Step 5 — customer-copy multiplier",
        "Internal only. The customer's invoice prints the rate × this number; the sheet, the ledger and every internal figure stay at the rate you entered. <b>No multiplier</b> prints the rate as typed. The factor never appears on the invoice, the caption or any card after this one.",
        card(S_STEP5, B_STEP5))}
</section>

<section class="page">
  <div class="ph">Part 2 · The admin &nbsp;·&nbsp; approved — what both sides see</div>
  <div class="compare">
    <div class="col good"><div class="chead">The admin's chat</div>
      {card(S_ADMIN_OK)}{card(S_ADMIN_OUT)}{card("", kind="document", photo=C_INVOICE, caption="🧾 Invoice INV-2026-0912 · ABBA")}
      <div class="cnote">Stock is marked sold, the ledger takes the sale, the invoice is issued and its PDF lands here and with the seller. The outstanding line is the balance <b>after</b> this sale.</div></div>
    <div class="col good"><div class="chead">The seller's chat</div>
      {card(S_SELLER_OK, B_SELLER_OK)}{card("", kind="document", photo=C_INVOICE, caption="🧾 Invoice INV-2026-0912 · ABBA")}
      <div class="cnote">The receipt from step 12 is edited in place: the buyer's name and phone number appear on it, so the goods can be dispatched.</div></div>
  </div>
  <div class="warnwide"><b>Rejected instead?</b> The seller's chat gets “❌ Your request R-4F72 has been rejected by admin.” Nothing was written. The request stays on record under 🛂 Approvals → ✅❌ Decided, naming who rejected it.</div>
</section>

<section class="page">
  <div class="ph">If something goes wrong &nbsp;·&nbsp; the seller's side</div>
  <p class="lead">Nothing here can move stock. The worst case is a request that has to be raised again.</p>
  <table class="tbl"><thead><tr><th>The bot says</th><th>What it means</th><th>What you do</th></tr></thead><tbody>{trows(TROUBLE_SELLER)}</tbody></table>
</section>

<section class="page">
  <div class="ph">If something goes wrong &nbsp;·&nbsp; the admin's side</div>
  <table class="tbl"><thead><tr><th>The bot says</th><th>What it means</th><th>What you do</th></tr></thead><tbody>{trows(TROUBLE_ADMIN)}</tbody></table>
  <div class="notebox"><b>Several requests at once?</b> Each sale has its own wizard. Buttons always act on their own card; a <i>typed</i> reply goes to the request you touched last — the card says so in its last line.</div>
</section>

<section class="page">
  <div class="ph">Quick card &nbsp;·&nbsp; cut this out and keep it by the phone</div>
  <div class="qr">
    <div class="qrtitle">✂ 🧵 Selling thans — the whole job on one card</div>
    <div class="qgold">Tick the thans → 🧑 who sold → 📅 when → 📎 send the bill. That is the sale sent.</div>
    <div class="qrgrid">
      <div class="qbox"><b>Menu path</b><br>🛒 Sales &amp; Marketing → 📝 Orders → 🧵 Sell Bundles / Than</div>
      <div class="qbox"><b>Pick</b><br>container → store → design → shade → bale → thans</div>
      <div class="qbox"><b>Bale row</b><br>tap the number = whole bale<br>➡️ = pick thans inside</div>
      <div class="qbox"><b>Marks</b><br>⬜ none · ◪ some · ✅ whole<br>🟢 fresh · 🟡 ageing · 🔴 stale</div>
      <div class="qbox"><b>🛒 Cart bar</b><br>running total; tap it any time</div>
      <div class="qbox"><b>Date</b><br>today / yesterday one tap<br>older = BACKDATED, flagged</div>
      <div class="qbox"><b>The bill</b><br>photo or PDF — sending it IS the submit</div>
      <div class="qbox"><b>Not yours to set</b><br>customer · rate · payment<br>(the admin, at approval)</div>
      <div class="qbox"><b>After approval</b><br>your receipt shows the buyer's name and number → dispatch</div>
    </div>
    <div class="qfoot">Admins: 🛂 Approvals → 💰 Sales → ✅ Approve → five steps: buyer · rate · payment · amount · multiplier. You cannot approve your own sale.</div>
  </div>
  <div class="foot">AtFactoryPrice · 🧵 Sell Bundles / Than · guide version 22-Sep-2026</div>
</section>
""")

CSS = """
@page { size: A4; margin: 10mm 11mm; }
* { box-sizing: border-box; }
body { margin:0; font-family:"DejaVu Sans","Segoe UI",Arial,sans-serif; color:#16202a; font-size:11.2pt; line-height:1.42; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
h1 { font-size:34pt; margin:2mm 0 1mm; letter-spacing:-.5px; }
.brand { font-size:8.4pt; letter-spacing:2.4px; text-transform:uppercase; color:#7d8b99; font-weight:700; }
.sub { font-size:13pt; color:#3d4b59; margin-bottom:2mm; }
.for { font-size:9.4pt; color:#4a5866; padding:1.6mm 0 0; border-top:1px solid #e2e8ee; }
.ph { font-size:12.6pt; font-weight:700; color:#0e2a47; border-bottom:2.4px solid #0e2a47; padding-bottom:1.4mm; margin-bottom:3.4mm; }
.lead { margin:0 0 3mm; color:#31404e; }
.small { font-size:8.8pt; color:#5d6b79; }

/* golden rule */
.golden { margin:6mm 0; border:2.4px solid #b8860b; background:#fffaf0; border-radius:4mm; padding:4mm 5mm; }
.gtitle { font-size:9pt; letter-spacing:2.4px; font-weight:800; color:#8a6508; }
.gbody { font-size:17pt; font-weight:700; margin:1.4mm 0 2mm; color:#1d1502; }
.gsteps { display:inline-block; margin-top:1.6mm; font-size:13pt; background:#fff; border:1px solid #e0cf9a; border-radius:2mm; padding:1.4mm 3mm; }
.gwhy { font-size:9.6pt; color:#4a4231; }

.two { display:flex; gap:5mm; margin:6mm 0; }
.box { flex:1; border:1px solid #dde4ea; border-radius:3mm; padding:3.4mm 4mm; background:#fbfcfd; }
.btitle { font-weight:700; color:#0e2a47; margin-bottom:1.6mm; }
.box p { margin:0 0 1.8mm; }
.box ul { margin:0 0 1.6mm; padding-left:5mm; }
.box li { margin-bottom:.8mm; }

.map { margin-top:5mm; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 4mm; background:#f4f7fa; }
.mtitle { font-weight:700; color:#0e2a47; margin-bottom:2mm; }
.mrow { display:flex; align-items:center; gap:1.4mm; }
.mstep { flex:1; text-align:center; background:#fff; border:1px solid #cfdae4; border-radius:2mm; padding:2mm .8mm; font-size:8.6pt; }
.mstep b { display:block; font-size:12pt; color:#1d6fa5; }
.mstep.last { background:#e5f4ec; border-color:#8ecfae; }
.marr { color:#93a3b2; font-size:11pt; }

/* steps */
.step { display:flex; gap:6mm; margin-bottom:6.5mm; page-break-inside:avoid; }
.sleft { flex:1.08; }
.sright { flex:1; }
.snum { display:inline-block; width:9mm; height:9mm; line-height:9mm; text-align:center; border-radius:50%;
        background:#0e2a47; color:#fff; font-weight:800; font-size:13pt; }
.stitle { display:inline-block; font-size:14pt; font-weight:700; margin-left:2.4mm; vertical-align:middle; color:#0e2a47; }
.slead { margin-top:2.2mm; color:#31404e; }
.path { margin:2.4mm 0; display:flex; flex-wrap:wrap; gap:1.4mm; align-items:center; }
.path span { background:#eef3f8; border:1px solid #d3dde7; border-radius:1.6mm; padding:1mm 2.2mm; font-size:9.4pt; font-weight:600; color:#123; }
.tip { margin-top:2.8mm; font-size:10pt; background:#eef6ff; border-left:3px solid #1d6fa5; padding:1.8mm 2.6mm; border-radius:0 2mm 2mm 0; }
.warn { margin-top:2.8mm; font-size:10pt; background:#fff4f4; border-left:3px solid #a3232a; padding:1.8mm 2.6mm; border-radius:0 2mm 2mm 0; }

/* telegram card */
.tg { background:#0e1621; border-radius:3mm; padding:2.6mm; max-width:82mm; }
.bubble { background:#182533; border-radius:2.4mm; padding:2.2mm 2.6mm 1.2mm; position:relative; }
.txt { color:#e9eef3; font-size:9.4pt; line-height:1.4; word-wrap:break-word; }
.txt b { color:#fff; }
.dim, .txt i { color:#8fa3b5; font-style:italic; }
.txt code { background:#0e1621; border-radius:1mm; padding:0 .8mm; font-family:"DejaVu Sans Mono",monospace; font-size:8.2pt; color:#a9c7e4; }
.time { text-align:right; color:#6d8298; font-size:7pt; margin-top:.8mm; }
.krow { display:flex; gap:1.2mm; margin-top:1mm; }
.kbtn { flex:1; background:#22303f; color:#e9eef3; text-align:center; font-size:8.9pt; padding:1.5mm 1mm; border-radius:1.6mm; }
.pic { height:34mm; border-radius:1.8mm; margin-bottom:1.6mm; overflow:hidden; }
.doc { display:flex; align-items:center; gap:2mm; background:#0e1621; border-radius:1.8mm; padding:1.8mm 2mm; margin-bottom:1.4mm; }
.dicon { font-size:13pt; }
.dname { color:#a9c7e4; font-size:8.2pt; }
.mockswatch, .mockgarment { height:100%; display:flex; align-items:center; justify-content:center; position:relative;
  color:#fff; font-size:8pt; text-align:center; }
.mockswatch { background:linear-gradient(100deg,#f4f2ee 0 18%,#3b2f26 18% 34%,#fbfbfb 34% 50%,#22304a 50% 66%,#1e5fd0 66% 82%,#4a4a45 82% 100%); color:#0e1621; font-weight:700; }
.mockswatch span { background:rgba(255,255,255,.9); border-radius:1.4mm; padding:1.2mm 2.4mm; font-size:8.4pt; }
.tabs { position:absolute; top:1mm; left:0; right:0; display:flex; justify-content:space-around; color:#d4af5f; font-size:8pt; }
.mockgarment { background:radial-gradient(circle at 50% 32%, #23324a 0%, #16202e 62%); }
.pic:has(.mockgarment) { height:26mm; }
.mockgarment::before { content:""; position:absolute; left:50%; top:10%; width:24mm; height:18mm; transform:translateX(-50%);
  background:repeating-linear-gradient(90deg,#fff 0 1.6mm,#e9e2ea 1.6mm 1.75mm); border-radius:2mm 2mm 1mm 1mm; }
.mockgarment span { position:absolute; left:0; right:0; bottom:0; z-index:4; color:#c9d6e2; font-size:7.4pt; background:rgba(8,14,22,.82); padding:1mm 0; }
.stamp { position:absolute; top:1.2mm; right:1.6mm; background:rgba(255,255,255,.9); color:#111; font-weight:800; font-size:7pt; padding:.4mm 1mm; border-radius:.8mm; z-index:3; }
.cardnote { font-size:8.6pt; color:#5d6b79; margin-top:1.6mm; }

/* compare */
.compare { display:flex; gap:7mm; }
.col { flex:1; }
.chead { font-weight:800; font-size:11pt; padding:1.8mm 2.6mm; border-radius:2mm 2mm 0 0; margin-bottom:2.4mm; }
.good .chead { background:#e5f4ec; color:#1c6b45; border:1px solid #8ecfae; }
.bad .chead { background:#fdeeee; color:#8c1f24; border:1px solid #e2a3a6; }
.chead.plain { background:#eef3f8; color:#0e2a47; border:1px solid #d3dde7; }
.cnote { font-size:9.8pt; color:#41505e; margin-top:2.4mm; }

.afterbox { display:flex; gap:6mm; margin-top:5mm; border-top:1px solid #e2e8ee; padding-top:4mm; }
.ph + .afterbox { margin-top:0; border-top:0; padding-top:0; margin-bottom:5mm; }
.atext { flex:1.25; }
.acard { flex:1; }
.atext p { margin:0 0 2mm; }

.grid3 { display:flex; gap:5mm; }
.grid3 > div { flex:1; }
.gtitle2 { font-weight:700; color:#0e2a47; margin-bottom:2.2mm; font-size:10.4pt; }
.warnwide { margin-top:5mm; background:#fff4f4; border:1.6px solid #d79a9d; border-left:5px solid #a3232a; border-radius:2.4mm; padding:3mm 3.6mm; font-size:10pt; }
.notebox { margin-top:6mm; background:#f4f7fa; border:1px solid #dde4ea; border-radius:2.4mm; padding:2.8mm 3.4mm; font-size:9.6pt; }

/* table */
.tbl { width:100%; border-collapse:collapse; font-size:9.8pt; }
.tbl th { text-align:left; background:#0e2a47; color:#fff; padding:2mm 2.4mm; font-size:8.6pt; letter-spacing:.4px; }
.tbl td { border-bottom:1px solid #e2e8ee; padding:2.2mm 2.4mm; vertical-align:top; }
.tbl .msg { width:41%; background:#182533; color:#e9eef3; border-radius:1.4mm; font-size:9pt; }
.tbl .msg b { color:#fff; }
.tbl .do { width:27%; font-weight:600; color:#1c6b45; }

.qr { margin-top:4mm; border:2.6px dashed #7d8b99; border-radius:4mm; padding:6mm 7mm; }
.qrtitle { font-weight:800; color:#0e2a47; margin-bottom:3.4mm; font-size:14pt; }
.qrgrid { display:flex; flex-wrap:wrap; gap:4mm; }
.qbox { flex:1 1 29%; background:#f4f7fa; border:1px solid #dde4ea; border-radius:2.4mm; padding:3.4mm 4mm; font-size:10.4pt; line-height:1.5; }
.qgold { background:#fffaf0; border:2px solid #b8860b; border-radius:2.4mm; padding:3.4mm 4mm; font-size:13pt; text-align:center; margin-bottom:4.5mm; }
.qfoot { margin-top:5mm; font-size:9.6pt; color:#4a5866; border-top:1px solid #dde4ea; padding-top:3mm; }
.foot { margin-top:4mm; font-size:8.4pt; color:#7d8b99; border-top:1px solid #e2e8ee; padding-top:1.8mm; }
"""

OUT.write_text(f"<!doctype html><html><head><meta charset='utf-8'><title>Selling thans — operator guide</title><style>{CSS}</style></head><body>{''.join(P)}</body></html>", encoding="utf-8")
print("wrote", OUT)
