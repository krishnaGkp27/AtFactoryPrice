#!/usr/bin/env python3
"""EDB-1 — build the printable live-test script (docs/EDB-1_TEST_SCRIPT.pdf).

Every card body/button string is copied VERBATIM from the shipped code
(src/flows/editBaleFlow.js, services/baleEditService.js, events/approvalEvents.js,
services/inventoryService.js @ 79fea1ed), with Markdown resolved the way
Telegram renders it. Worked case: bale 6061 · 9043-A · shade 6 · Kano office.

Usage:
    python3 scripts/build-edit-bale-test-script.py
    chromium --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
      --print-to-pdf=docs/EDB-1_TEST_SCRIPT.pdf docs/EDB-1_TEST_SCRIPT.html
(any Chromium; this container has one at /opt/pw-browsers/chromium)
"""
import html, pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "docs" / "EDB-1_TEST_SCRIPT.html"

# ── telegram card renderer ───────────────────────────────────────────────
def md(t):
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

def card(body, buttons=(), kind="text", photo=None, caption=None, time="11:07"):
    p = ['<div class="tg"><div class="bubble">']
    if kind == "photo":
        p.append(f'<div class="pic">{photo or ""}</div>')
    text = (caption or body) if kind == "photo" else body
    if text:
        p.append(f'<div class="txt">{md(text)}</div>')
    p.append(f'<div class="time">{time}</div></div>')
    for row in buttons:
        p.append('<div class="krow">')
        for b in row:
            p.append(f'<div class="kbtn">{html.escape(b)}</div>')
        p.append("</div>")
    p.append("</div>")
    return "".join(p)

def testblock(n, who, title, do, must, card_html="", note=None, warn=None, tick=True):
    t = [f'<div class="test"><div class="thead"><span class="tnum">TEST {n}</span>'
         f'<span class="twho">{who}</span><span class="ttitle">{html.escape(title)}</span></div>',
         '<div class="tbody"><div class="tleft">',
         '<div class="lab do">WHAT YOU DO</div><div class="txtblk">' + do + '</div>',
         '<div class="lab see">WHAT YOU MUST SEE</div><div class="txtblk">' + must + '</div>']
    if note: t.append(f'<div class="tnote">{note}</div>')
    if warn: t.append(f'<div class="twarn">{warn}</div>')
    if tick:
        t.append('<div class="verdict"><span class="box pass">☐ PASS</span>'
                 '<span class="box fail">☐ FAIL</span>'
                 '<span class="notes">Notes / what you saw instead: ______________________________</span></div>')
    if card_html:
        t.append('</div><div class="tright">' + card_html + '</div></div></div>')
    else:
        t.append('</div></div></div>')
    return "".join(t)

# ── the real cards ───────────────────────────────────────────────────────
C_ENTRY = ("✏️ *Edit Bale*\n\nType the bale number to correct — as printed on the label, e.g. *6061*."
           "\n\n_You can change the design, shade, indent, the yards of each than, and add a than. "
           "Status, customer, price and warehouse have their own doors._")
B_ENTRY = [["❌ Cancel"]]

CARD_HEAD = "✏️ *Edit Bale 6061* · 9043-A · #6 · Kano office\nIndent: ST/1321\n"
THANS = ("\n#1 · {t1} · 🔴 sold → Qaribullah (18-Aug-2026)"
         "\n#2 · 30 yd · 🔴 sold → Ahmad (Mai Glass) (27-Feb-2026)"
         "\n#3 · 25 yd · 🟢"
         "\n#4 · 24 yd · 🟢"
         "\n#5 · 27 yd · 🔴 sold → Qaribullah (06-Aug-2026)")

C_CARD0 = CARD_HEAD + "5 thans · 166 yd\n" + THANS.format(t1="60 yd") + "\n\n📎 Label photo: ❗ needed\n_0 change(s) pending_"
B_CARD0 = [["🧵 9043-A", "🎨 #6", "🧾 ST/1321"], ["#1 · 60 yd", "#2 · 30 yd"], ["#3 · 25 yd", "#4 · 24 yd"],
           ["#5 · 27 yd"], ["➕ Add a than"], ["📎 Label photo"], ["⬅ Another bale"], ["❌ Cancel"]]

C_THAN1 = "✏️ *Bale 6061 · than #1* — now *60 yd* (sold → Qaribullah)\n\nWhat does the label / the piece say?"
B_THAN1 = [["24 yd", "25 yd", "27 yd", "30 yd"], ["60 yd"], ["✏️ Other number"], ["⬅ Back to card"]]

C_CARD1 = (CARD_HEAD + "5 thans · 166 yd  →  *5 thans · 136 yd*\n" + THANS.format(t1="60 → *30* yd")
           + "\n\n📎 Label photo: ❗ needed"
           + "\n⚠️ A sold than changes yards — the customer was billed for the old figure. Reconcile later; not part of this edit."
           + "\n_1 change(s) pending_")
B_CARD1 = [["🧵 9043-A", "🎨 #6", "🧾 ST/1321"], ["#1 · 30 yd ✎", "#2 · 30 yd"], ["#3 · 25 yd", "#4 · 24 yd"],
           ["#5 · 27 yd"], ["➕ Add a than"], ["📎 Label photo"], ["✅ Send for approval (1)"], ["⬅ Another bale"], ["❌ Cancel"]]

C_ADD = "✏️ *Bale 6061* — add a than\n\nHow many yards is the extra piece? It becomes the next than number, available."
B_ADD = [["24 yd", "25 yd", "27 yd", "30 yd"], ["60 yd"], ["✏️ Other number"], ["⬅ Back to card"]]

C_CARD2 = (CARD_HEAD + "5 thans · 166 yd  →  *6 thans · 166 yd*\n" + THANS.format(t1="60 → *30* yd")
           + "\n🆕 #6 · *30* yd · 🟢 new"
           + "\n\n📎 Label photo: ✅ attached"
           + "\n⚠️ A sold than changes yards — the customer was billed for the old figure. Reconcile later; not part of this edit."
           + "\n_2 change(s) pending_")
B_CARD2 = [["🧵 9043-A", "🎨 #6", "🧾 ST/1321"], ["#1 · 30 yd ✎", "#2 · 30 yd"], ["#3 · 25 yd", "#4 · 24 yd"],
           ["#5 · 27 yd"], ["🆕 #6 · 30 yd  ✖ drop"], ["➕ Add a than"], ["📎 Replace label photo"],
           ["✅ Send for approval (2)"], ["⬅ Another bale"], ["❌ Cancel"]]

C_NOPHOTO = C_CARD2.replace("📎 Label photo: ✅ attached", "📎 Label photo: ❗ needed").replace(
    "_2 change(s) pending_",
    "_2 change(s) pending_\n❗ Attach the label photo first — the picture is the evidence the two approving admins sign against.")

C_PHOTOASK = "📎 Send a picture of the label of bale *6061* — a photo is fine here (it is evidence, not a catalogue picture)."
B_PHOTOASK = [["⬅ Back to card"]]

C_SENT = ("⏳ *Submitted for approval*\n\nBale *6061* · 9043-A · Kano office"
          "\n• #1: 60 → 30 yd (sold → Qaribullah)"
          "\n• + #6: 30 yd (new, available)"
          "\nRequest: `4f2c8a91-7d3e-4b62-9a08-1c5e7f0d3b44`"
          "\n\nA second admin must approve — you cannot approve your own. The sheet changes the moment they do.")
B_SENT = [["🏠 Back to menu"]]

C_ADMIN = ("🔔 *Approval required*\n\nRef: `4f2c8a91-7d3e-4b62-9a08-1c5e7f0d3b44`\nFrom: Muhammad\n\n"
           "✏️ Edit bale 6061 · 9043-A · Kano office — 2 change(s): #1: 60 → 30 yd (sold → Qaribullah); + #6: 30 yd (new, available)"
           "\n\n_All edit bale operations require 2nd admin approval._\n\nUse buttons below to approve or reject.")
B_ADMIN = [["✅ Approve", "❌ Reject"]]
C_ADMIN_PHOTO = "📎 Label of bale 6061 — the evidence for this edit"

C_APPROVED = ("✅ Request 4f2c8a91-7d3e-4b62-9a08-1c5e7f0d3b44 approved by Muhammad. Changes applied."
              "\n✅ Bale 6061 corrected — 1 row(s) updated, 1 than(s) added. Now 6 thans · 166 yd on the sheet."
              "\n⚠️ A sold than changed yards — the customer was billed for the old figure; reconcile it in finance.")

C_DETAIL = ("📦 Bale 6061\nDesign: 9043-A | Shade: 6\nIndent: ST/1321 | Warehouse: Kano office\nPrice: NGN 3,500/yard\n\n"
            "Thans (3/6 available):\n"
            "🔴 Than 1: 30 yds → Qaribullah (18-Aug-2026)\n"
            "🔴 Than 2: 30 yds → Ahmad (Mai Glass) (27-Feb-2026)\n"
            "🔴 Than 5: 27 yds → Qaribullah (06-Aug-2026)\n"
            "🟢 Than 3: 25 yds\n🟢 Than 4: 24 yds\n🟢 Than 6: 30 yds\n\n"
            "Available: 3 thans, 79 yds | Sold: 3 thans, 87 yds")

C_CANCEL = "❌ Edit Bale cancelled. Nothing was changed."
B_CANCEL = [["🏠 Back to menu"]]

PIC_LABEL = ('<div class="mocklabel"><span>photo of the bale label</span>'
             '<div class="lbl">BALE NO. 6061<br>DESIGN NO. 9043-A<br>COLOUR NO. 6<br>NO. OF PCS. 6<br>TOTAL 166</div></div>')

# ── pages ────────────────────────────────────────────────────────────────
P = []

P.append(f"""
<section class="page cover">
  <div class="brand">AtFactoryPrice · Live test script</div>
  <h1>✏️ Edit Bale</h1>
  <div class="sub">Correcting a bale on the card when the goods and the sheet disagree</div>
  <div class="meta">Feature <b>EDB-1</b> &nbsp;·&nbsp; Test case: bale <b>6061</b> &nbsp;·&nbsp; About 10 minutes &nbsp;·&nbsp; 02-Sep-2026</div>

  <div class="who">
    <div class="wbox"><div class="wt">You need TWO people</div>
      <p><b>Tester A — the editor.</b> An <b>admin</b> phone. Makes the correction and sends it.</p>
      <p><b>Tester B — the approver.</b> A <b>different admin</b> phone. Approves it.</p>
      <p class="small">One person cannot do both: the bot blocks approving your own request. That block is Test 6.</p></div>
    <div class="wbox"><div class="wt">Have ready</div>
      <ul>
        <li>Both phones logged in to <b>Black Panther_Bot</b></li>
        <li>A <b>photo of the label</b> of bale 6061 (the sack marking)</li>
        <li>The bale physically in front of you, or its label photo</li>
        <li>This sheet and a pen</li>
      </ul></div>
  </div>

  <div class="danger">
    <div class="dt">⚠️ THIS TEST CHANGES THE REAL SHEET</div>
    <div class="db">Test only on bale <b>6061</b>, the bale the owner has already checked. It is genuinely wrong:
    the label says <b>6 pieces</b>, the sheet has <b>5</b>, because than 1 was recorded as one 60-yard piece
    when it is really two 30-yard pieces.<br>
    <b>Do not edit any other bale</b> during this test, even to "try it". Nothing is written until Tester B approves.</div>
  </div>

  <div class="what">
    <div class="wt2">What this feature is for</div>
    <p>When the physical bale does not match the sheet, an admin fixes the <b>card</b> until it matches the goods,
    and two admins sign it. The bot then changes the Inventory sheet itself.</p>
    <div class="cando">
      <div class="can"><b>✅ You CAN change here</b><br>design · shade · indent · the yards of each than · add a than</div>
      <div class="cant"><b>⛔ You CANNOT change here</b><br>who bought it · sale date · price · status · warehouse<br>
      <span class="small">Those have their own doors. Removing a than is not built yet.</span></div>
    </div>
  </div>

  <div class="report">📋 Mark <b>PASS</b> or <b>FAIL</b> on every test as you go, write what you saw when it fails,
  and send the pages back to the owner. A FAIL is useful information — do not fix it yourself, do not repeat the test.</div>
</section>""")

# TEST 1 + 2
P.append(f"""
<section class="page tests">
  <div class="ph">Run the tests in order &nbsp;·&nbsp; tick PASS or FAIL on each</div>
  {testblock(1, "Tester A (admin)", "Open ✏️ Edit Bale and find the bale",
    "Say <b>Hi</b> to the bot → <b>📦 Inventory</b> → <b>✏️ Edit Bale</b>.<br>Then type: <b>6061</b>",
    "The bot asks for a bale number, then opens the card for 6061. The bale header and every than must match the sheet you know.",
    card(C_ENTRY, B_ENTRY),
    note="If the design has photos for more than one container, or the number exists in two stores, the bot first asks which physical bale — pick <b>Kano office</b>.")}
  {testblock(2, "Tester A", "Read the card — it must be the truth from the sheet",
    "Compare the card with the bale in front of you and with the Inventory sheet.",
    "<b>5 thans · 166 yd</b>. Than #1 is <b>60 yd, sold to Qaribullah</b>. Thans #3 and #4 are green (available). "
    "The label photo line says <b>❗ needed</b>. There is <b>no</b> ✅ Send button yet — nothing has changed.",
    card(C_CARD0, B_CARD0))}
  {testblock(3, "Tester A", "Correct than #1: 60 yards → 30 yards",
    "Tap <b>#1 · 60 yd</b>. The bot offers the lengths already in this bale.<br>Tap <b>30 yd</b>.",
    "The card returns showing <b>#1 · 60 → 30 yd</b>, the total line becomes <b>5 thans · 166 yd → 5 thans · 136 yd</b>, "
    "a ⚠️ line appears about the sold than, and <b>✅ Send for approval (1)</b> now exists.",
    card(C_THAN1, B_THAN1) + card(C_CARD1, B_CARD1),
    note="The chips are this bale's own lengths (24 · 25 · 27 · 30 · 60). <b>✏️ Other number</b> is there for a length the bale does not already have.")}
  {testblock(4, "Tester A", "Add the missing piece: a new 30-yard than",
    "Tap <b>➕ Add a than</b> → tap <b>30 yd</b>.",
    "A new line <b>🆕 #6 · 30 yd · 🟢 new</b> appears and the total goes back to <b>6 thans · 166 yd</b> — matching the label. "
    "The button now reads <b>✅ Send for approval (2)</b>.",
    card(C_ADD, B_ADD),
    note="166 yards is what the label says. If your total does not come back to the label figure, something is wrong — mark FAIL and stop.")}
  {testblock(5, "Tester A", "The bot must refuse to send without the label photo",
    "First tap <b>✅ Send for approval (2)</b> <u>without</u> attaching a photo.<br>"
    "Then tap <b>📎 Label photo</b> and send the picture of the label.<br>Then tap <b>✅ Send for approval (2)</b> again.",
    "The first tap is <b>refused</b> with the ❗ line. After the photo, the card says <b>📎 Label photo: ✅ attached</b>, "
    "and sending gives you <b>⏳ Submitted for approval</b> listing both changes.",
    card(C_NOPHOTO) + card(C_PHOTOASK, B_PHOTOASK) + card(C_SENT, B_SENT),
    warn="If the bot lets you send with <b>no photo</b>, that is a <b>FAIL</b> — write it down.")}
  {testblock(6, "Tester A", "You must NOT be able to approve your own edit",
    "Tester A: find the approval card in your own chat (if you got one) and tap <b>✅ Approve</b>.",
    "A grey pop-up says you <b>cannot approve your own request</b>. The request stays waiting.",
    card("🔒 You cannot approve your own request — a second admin must review it.", [["OK"]]),
    note="Normally Tester A is not even sent the card — the bot asks the OTHER admins. If Tester A never receives it, that is correct: mark PASS and move on.")}
  {testblock(7, "Tester B (second admin)", "Approve, and check the card says what will happen",
    "On <b>Tester B's</b> phone: read the label photo and the approval card, then tap <b>✅ Approve</b>.",
    "The card names the bale and lists <b>both</b> changes before you approve. After approving, the reply says the bale was corrected "
    "and gives the new totals.",
    card(C_ADMIN_PHOTO, kind="photo", photo=PIC_LABEL) + card(C_ADMIN, B_ADMIN) + card(C_APPROVED),
    warn="Read the card before tapping. If it does not match what Tester A did, tap <b>❌ Reject</b> and mark FAIL.")}
  {testblock(8, "Both", "The bot and the sheet now agree with the bale",
    "Tester A: in the bot, ask for <b>Details of Bale 6061</b>.<br>Owner/Tester B: open the <b>Inventory</b> sheet and find bale 6061.",
    "The bot shows <b>3/6 available · 79 yds</b>. In the sheet: than 1 now reads <b>30</b> and is still sold to Qaribullah; "
    "a <b>new row for than 6</b> (30 yards, available) sits at the <b>bottom</b> of the sheet with the same design, shade, "
    "indent, warehouse and container as its bale-mates.",
    card(C_DETAIL),
    warn="The new row must be at the BOTTOM of the sheet, never inserted in the middle. If it is in the middle, mark FAIL immediately.")}
  {testblock(9, "Tester A", "Cancel must change nothing",
    "Open <b>✏️ Edit Bale</b> again → type <b>6061</b> → tap any than and change its yards → then tap <b>❌ Cancel</b>.<br>"
    "Open the bale again and look.",
    "The bot says it was cancelled and nothing was changed. Re-opening 6061 shows the bale exactly as Test 8 left it — "
    "<b>6 thans · 166 yd</b>, with your cancelled change gone.",
    card(C_CANCEL, B_CANCEL),
    warn="Nothing is ever written until a SECOND admin approves. If a cancelled change appears in the sheet, that is a serious FAIL.")}
  {testblock(10, "Tester A", "The things you must NOT be able to change here",
    "On the card for 6061, look for any way to change: <b>who bought a than</b>, the <b>sale date</b>, the <b>price</b>, "
    "the <b>status</b> (sold/available), or the <b>warehouse</b>.",
    "There is <b>no button</b> for any of them. The only editable things are the three header chips "
    "(design · shade · indent), the than chips (yards), and ➕ Add a than.",
    "",
    note="A sold than can have its YARDS corrected — that is intended (that is exactly the 6061 case). What must not be touched is who bought it, when, and for how much.",
    tick=True)}
</section>""")

ROWS = "".join(f"<tr><td class=n>{i}</td><td>{t}</td><td class=v>☐&nbsp;PASS &nbsp;&nbsp; ☐&nbsp;FAIL</td><td></td></tr>" for i, t in [
    (1, "Open ✏️ Edit Bale, find bale 6061"),
    (2, "The card matches the sheet (5 thans · 166 yd)"),
    (3, "Than #1 corrected 60 → 30 yd"),
    (4, "New 30-yard than added, total back to 166"),
    (5, "Refused without the label photo; sent with it"),
    (6, "Cannot approve your own edit"),
    (7, "Second admin sees both changes and approves"),
    (8, "Bot shows 3/6 · 79 yds; new row at the BOTTOM of the sheet"),
    (9, "Cancel changed nothing"),
    (10, "No way to change buyer / date / price / status / warehouse"),
])
P.append(f"""
<section class="page">
  <div class="ph">Report — send this page back to the owner</div>
  <table class="rep">
    <thead><tr><th>#</th><th>Test</th><th>Result</th><th>Notes (what you saw instead)</th></tr></thead>
    <tbody>{ROWS}</tbody>
  </table>

  <div class="sign">
    <div class="sbox">Tester A (editor) — name: ____________________ &nbsp; phone: ____________ &nbsp; date: __________</div>
    <div class="sbox">Tester B (approver) — name: ____________________ &nbsp; phone: ____________ &nbsp; date: __________</div>
  </div>

  <div class="known">
    <div class="kt">Known and expected — do NOT report these as faults</div>
    <ul>
      <li><b>No money is corrected.</b> Qaribullah was billed for 60 yards and received 30. The bot says so on the card and after approval,
      but it does not credit him. The owner is handling money separately.</li>
      <li><b>You cannot remove a than.</b> If a bale has a row too many, report it to the owner — that door is not built yet.</li>
      <li><b>A than that is in transit cannot be edited</b> until it is received.</li>
      <li>If someone sells or moves a than <b>between</b> Tester A sending and Tester B approving, the approval is <b>refused</b>
      with a message saying the bale changed. That is correct behaviour — redo the edit on the fresh card.</li>
    </ul>
  </div>
  <div class="foot">Questions during the test: stop and ask the owner. Do not repeat a failed test or try to fix data by hand.</div>
</section>""")

CSS = """
@page { size: A4; margin: 11mm 10mm; }
* { box-sizing: border-box; }
body { margin:0; font-family:"DejaVu Sans","Segoe UI",Arial,sans-serif; color:#16202a; font-size:10.6pt; line-height:1.4; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
h1 { font-size:31pt; margin:2mm 0 1mm; letter-spacing:-.5px; }
.brand { font-size:8.2pt; letter-spacing:2.4px; text-transform:uppercase; color:#7d8b99; font-weight:700; }
.sub { font-size:12.4pt; color:#3d4b59; }
.meta { font-size:9.2pt; color:#4a5866; padding:1.6mm 0; border-top:1px solid #e2e8ee; border-bottom:1px solid #e2e8ee; margin:2.4mm 0 4mm; }
.ph { font-size:12.4pt; font-weight:700; color:#0e2a47; border-bottom:2.4px solid #0e2a47; padding-bottom:1.2mm; margin-bottom:3.6mm; }
.small { font-size:8.8pt; color:#5d6b79; }

.who { display:flex; gap:5mm; margin-bottom:4mm; }
.wbox { flex:1; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 3.6mm; background:#fbfcfd; }
.wt, .wt2 { font-weight:700; color:#0e2a47; margin-bottom:1.6mm; }
.wbox p { margin:0 0 1.4mm; }
.wbox ul { margin:0; padding-left:5mm; } .wbox li { margin-bottom:.8mm; }

.danger { border:2.4px solid #a3232a; background:#fff6f6; border-radius:3mm; padding:3.4mm 4mm; margin-bottom:4mm; }
.dt { font-weight:800; color:#8c1f24; letter-spacing:.6px; margin-bottom:1.4mm; }
.db { font-size:10pt; color:#40282a; }

.what { border:1px solid #dde4ea; border-radius:3mm; padding:3mm 3.6mm; background:#f4f7fa; margin-bottom:4mm; }
.what p { margin:0 0 2mm; }
.cando { display:flex; gap:4mm; }
.can, .cant { flex:1; border-radius:2mm; padding:2.4mm 3mm; font-size:9.4pt; }
.can { background:#e5f4ec; border:1px solid #8ecfae; }
.cant { background:#fdeeee; border:1px solid #e2a3a6; }
.report { border:1px dashed #93a3b2; border-radius:2.4mm; padding:2.8mm 3.4mm; font-size:9.8pt; background:#fff; }

/* test blocks */
.test { border:1px solid #dde4ea; border-radius:3mm; margin-bottom:3.4mm; page-break-inside:avoid; overflow:hidden; }
.thead { background:#0e2a47; color:#fff; padding:2mm 3mm; display:flex; align-items:center; gap:3mm; }
.tnum { font-weight:800; font-size:9.4pt; letter-spacing:1px; background:#1d6fa5; padding:.8mm 2.4mm; border-radius:1.4mm; }
.twho { font-size:8.8pt; background:#ffffff22; padding:.8mm 2.2mm; border-radius:1.4mm; }
.ttitle { font-weight:700; font-size:11pt; }
.tbody { display:flex; gap:3.4mm; padding:2.4mm 3mm; }
.tleft { flex:1.15; } .tright { flex:1; }
.lab { font-size:8pt; font-weight:800; letter-spacing:1.2px; margin-bottom:1mm; }
.lab.do { color:#1d6fa5; } .lab.see { color:#1c6b45; margin-top:2.6mm; }
.txtblk { font-size:9.6pt; }
.tnote { margin-top:2.4mm; font-size:9pt; background:#eef6ff; border-left:3px solid #1d6fa5; padding:1.6mm 2.4mm; }
.twarn { margin-top:2.4mm; font-size:9pt; background:#fff4f4; border-left:3px solid #a3232a; padding:1.6mm 2.4mm; }
.verdict { margin-top:2.4mm; padding-top:1.6mm; border-top:1px dashed #cfdae4; font-size:9.6pt; }
.box { font-weight:800; margin-right:5mm; }
.box.pass { color:#1c6b45; } .box.fail { color:#8c1f24; }
.notes { color:#7d8b99; font-size:8.8pt; }

/* telegram */
.tg { background:#0e1621; border-radius:2.4mm; padding:1.8mm; margin-bottom:1.8mm; }
.bubble { background:#182533; border-radius:2mm; padding:1.6mm 2mm .8mm; }
.txt { color:#e9eef3; font-size:7.9pt; line-height:1.33; word-wrap:break-word; }
.txt b { color:#fff; } .dim, .txt i { color:#8fa3b5; font-style:italic; }
.txt code { background:#0e1621; border-radius:1mm; padding:0 .8mm; font-family:"DejaVu Sans Mono",monospace; font-size:7.6pt; color:#a9c7e4; }
.time { text-align:right; color:#6d8298; font-size:6.6pt; margin-top:.6mm; }
.krow { display:flex; gap:.8mm; margin-top:.7mm; }
.kbtn { flex:1; background:#22303f; color:#e9eef3; text-align:center; font-size:7.3pt; padding:1mm .6mm; border-radius:1.2mm; }
.pic { height:22mm; border-radius:1.6mm; margin-bottom:1.4mm; overflow:hidden; }
.mocklabel { height:100%; background:linear-gradient(160deg,#9aa86a,#7d8b52); position:relative; display:flex; align-items:center; justify-content:center; }
.mocklabel .lbl { color:#1a2a6b; font-weight:800; font-size:6.6pt; line-height:1.5; background:rgba(255,255,255,.55); padding:1.4mm 2.4mm; border-radius:1mm; }
.mocklabel span { position:absolute; bottom:0; left:0; right:0; background:rgba(8,14,22,.8); color:#c9d6e2; font-size:7pt; text-align:center; padding:.8mm 0; }

/* report */
.rep { width:100%; border-collapse:collapse; font-size:9.8pt; }
.rep th { background:#0e2a47; color:#fff; text-align:left; padding:2mm 2.4mm; font-size:8.8pt; }
.rep td { border-bottom:1px solid #dde4ea; padding:2mm 2.4mm; }
.rep .n { width:8mm; font-weight:700; color:#1d6fa5; }
.rep .v { width:30mm; font-weight:700; white-space:nowrap; }
.rep td:last-child { width:56mm; }
.sign { margin-top:4mm; }
.sbox { border:1px solid #dde4ea; border-radius:2mm; padding:2.4mm 3.4mm; margin-bottom:2mm; font-size:9.6pt; background:#fbfcfd; }
.known { margin-top:4mm; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 3.6mm; background:#f4f7fa; }
.kt { font-weight:700; color:#0e2a47; margin-bottom:1.6mm; }
.known ul { margin:0; padding-left:5mm; font-size:9.2pt; } .known li { margin-bottom:1.2mm; }
.foot { margin-top:4mm; font-size:8.6pt; color:#7d8b99; border-top:1px solid #e2e8ee; padding-top:1.6mm; }
"""

OUT.write_text(f"<!doctype html><html><head><meta charset='utf-8'><title>EDB-1 — Edit Bale test script</title><style>{CSS}</style></head><body>{''.join(P)}</body></html>", encoding="utf-8")
print("wrote", OUT)
