#!/usr/bin/env python3
"""TRF-21 — build the printable guide + live-test script for receiving a
transfer in parts (docs/TRF-21_PARTIAL_RECEIPT_GUIDE.pdf).

Every card body and button string below was captured VERBATIM by driving the
real controller through a three-bale transfer received in two deliveries and
a second one rejected after a partial delivery (test harness, code at commit
c1e3ffcd), with Markdown resolved the way Telegram renders it. Worked case:
Lagos → Kano office · 9006 · shade 3 · bales 5801, 5802, 5803 · Abdul receives.

Usage:
    python3 scripts/build-transfer-receipt-guide.py
    chromium --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
      --print-to-pdf=docs/TRF-21_PARTIAL_RECEIPT_GUIDE.pdf docs/TRF-21_PARTIAL_RECEIPT_GUIDE.html
(any Chromium; this container has one at /opt/pw-browsers/chromium-1194/chrome-linux/chrome)
"""
import html, pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "docs" / "TRF-21_PARTIAL_RECEIPT_GUIDE.html"

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

def card(body, buttons=(), kind="text", photo=None, caption=None, time="11:07", who=None):
    p = ['<div class="tg">']
    if who:
        p.append(f'<div class="tgwho">{html.escape(who)}</div>')
    p.append('<div class="bubble">')
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

def mockphoto(label):
    return f'<div class="mocklabel"><div class="lbl">{html.escape(label)}</div><span>your photo</span></div>'

def testblock(n, who, title, do, must, card_html="", note=None, warn=None, tick=True):
    """One test. A single card sits beside the text; two or more cards go in a
    row BELOW it (the text then runs in two columns) so a test never spills
    over a page because of its screenshots."""
    cards = [c for c in card_html.split('<div class="tg">') if c.strip()] if card_html else []
    cards = ['<div class="tg">' + c for c in cards]
    head = (f'<div class="test"><div class="thead"><span class="tnum">TEST {n}</span>'
            f'<span class="twho">{html.escape(who)}</span><span class="ttitle">{html.escape(title)}</span></div>')
    do_html = '<div class="lab do">WHAT YOU DO</div><div class="txtblk">' + do + '</div>'
    see_html = '<div class="lab see">WHAT YOU MUST SEE</div><div class="txtblk">' + must + '</div>'
    extra = (f'<div class="tnote">{note}</div>' if note else '') + (f'<div class="twarn">{warn}</div>' if warn else '')
    verdict = ('<div class="verdict"><span class="box pass">☐ PASS</span><span class="box fail">☐ FAIL</span>'
               '<span class="notes">Notes / what you saw instead: ______________________________</span></div>') if tick else ''
    if len(cards) <= 1:
        right = f'<div class="tright">{cards[0]}</div>' if cards else ''
        return head + f'<div class="tbody"><div class="tleft">{do_html}{see_html}{extra}{verdict}</div>{right}</div></div>'
    row = '<div class="cardrow">' + ''.join(cards) + '</div>'
    return (head + f'<div class="tbody col"><div class="cols"><div class="c">{do_html}</div><div class="c see2">{see_html}</div></div>'
            + extra + row + verdict + '</div></div>')

# ── the real cards (captured from the running flow) ─────────────────────
REF = "01Oct·01"       # the short reference of the example transfer — yours will differ
TRID = "TR-20261001-001"

C_CONFIRM = ("🚚 *Confirm transfer* — 3 bale(s)\n\n  🧵 9006 · Shade 3 · ×3 bls\n\n*Lagos* → *Kano office*\n"
             "Dispatcher: *Musa*\nReceiver: *Abdul*\n\n"
             "_This sends an ORDER — Musa logs the actual bales when dispatching; nothing is locked until then._")
B_CONFIRM = [["✅ Send"], ["⬅ Back", "❌ Cancel"]]

C_DISP = (f"🚚 *Transfer {REF} — please dispatch*\n⏳ *With Musa to dispatch* · raised by Krishna · today\n"
          "*Lagos* → *Kano office* · 3 bale(s)\n🧵 *9006*\n • Shade 3 ×3\nReceiver: Abdul\n\n"
          "_Accepting logs the actual bales you send. A load photo/PDF is required to complete the dispatch._")
B_DISP = [["✅ Accept & dispatch", "❌ Decline"]]

C_PICK = (f"🚚 *{TRID}* — line 1 of 1\n9006 · Shade 3 — pick 3 bale(s)   _(3 in stock)_\nSelected: *3/3*")
B_PICK = [["✅ 5801", "✅ 5802", "✅ 5803"], ["✅ Review"], ["↩ Not now"], ["❌ Decline"]]

C_REVIEW = (f"🚚 *{TRID}* — dispatch 3 bale(s)?\n • 9006/3: 5801, 5802, 5803\n\n*Lagos* → *Kano office*\n"
            "📅 Left the store: *01-Oct-2026* (today)\n📸 _A load photo/PDF is required next._")
B_REVIEW = [["🚚 Dispatch"], ["📅 Change date"], ["◀ Back", "❌ Decline"]]

C_LOADPHOTO = (f"📸 *Photo required — {REF}*\nSend a photo or PDF of the load now to complete the dispatch.\n"
               "_Nothing moves until it arrives._")
B_LOADPHOTO = [["◀ Back to review", "❌ Decline"]]

C_PARKED = (f"🛂 *{REF} — sent for admin approval*\n*Lagos* → *Kano office* · 3 bale(s)\n"
            "3 bale(s) logged · nothing moves until an admin approves.\n📸 *Dispatch photo attached*")
B_PARKED = [["🏠 Menu"]]

C_ADMIN = (f"🛂 *Transfer {REF} — awaiting your approval*\n📅 Left the store: 01-Oct-2026\n🙋 Logged by Musa\n\n"
           f"📦 *{REF}* — 3 bales\n_Lagos → Kano office_\n\n🧵 *9006*\n • Shade 3 ×3B (5801, 5802, 5803)\n")
B_ADMIN = [["✅ Approve dispatch", "↩️ Send back"], ["📄 Dispatch doc"], ["🧮 Reconcile dispatch doc"]]

C_RCARD = (f"📦 *Transfer {REF} incoming*\n🚚 *With Abdul to confirm arrival* · left 01-Oct-2026 · today\n"
           "*Lagos* → *Kano office* · 3 bale(s)\n📅 Left Lagos: *01-Oct-2026*\n🧵 *9006*\n • Shade 3 ×3 (5801, 5802, 5803)\n\n"
           "Confirm when the goods arrive and match — a photo/PDF of the received goods is required:")
B_RCARD = [["✅ Received", "⚠️ Reject"], ["📦 Only some arrived — tick them"], ["📦 3 bales — view all"], ["📄 Dispatch doc"]]

C_PICKER0 = (f"📦 *{REF} — which bales are here now?*\n*Lagos* → *Kano office* · 3 still on the road\n"
             " • 9006 · Shade 3: 5801, 5802, 5803\n\n"
             "Tick only the bales physically in front of you — the rest stay in transit for the next delivery.\nTicked: *0/3*")
B_PICKER0 = [["⬜ 5801", "⬜ 5802", "⬜ 5803"], ["↩ Not now"]]

C_PICKER1 = C_PICKER0.replace("Ticked: *0/3*", "Ticked: *1/3*")
B_PICKER1 = [["✅ 5801", "⬜ 5802", "⬜ 5803"], ["✅ Confirm 1 of 3 arrived"], ["↩ Not now"]]

C_PICKSEAL = f"📦 *{REF}* — 1 bale(s) ticked ✔ · receipt pending 📸"
C_RPHOTO1 = (f"📸 *Photo required — {REF}*\nSend a photo or PDF of the 1 bale(s) received now (5801).\n"
             "_They go live at *Kano office* when it arrives; the other 2 stay on the road._")
B_RPHOTO = [["↩ Not now"]]

C_SEAL1 = (f"📦 *{REF} — 1 of 3 received* — 5801 now live at *Kano office*; 2 still on the road.\n"
           "_Your transfer card is updated — use it for the next delivery._\n📸 *Receipt photo attached*")
B_SEAL = [["🏠 Menu"]]

C_RCARD1 = (f"📦 *Transfer {REF} incoming*\n🚚 *With Abdul to confirm the rest* · 1 of 3 received · left 01-Oct-2026 · today\n"
            "*Lagos* → *Kano office* · 3 bale(s)\n📅 Left Lagos: *01-Oct-2026*\n🧵 *9006*\n • Shade 3 ×3 (5801 ✅, 5802, 5803)\n"
            "✅ *1 of 3 received* · 🚚 2 still on the road (5802, 5803)\n\n"
            "✅ Received confirms the remaining 2 — a photo/PDF of the goods is required:")
B_RCARD1 = [["✅ Received", "⚠️ Reject"], ["📦 Only some arrived — tick them"], ["📦 3 bales — view all"],
            ["📄 Dispatch doc"], ["📄 Receipt doc"], ["📋 Transfers", "🏠 Menu"]]

C_ADMIN_D1 = (f"🚚 *{REF}* partly received 📦 (1 of 3) — 3 bale(s) · Lagos → Kano office\n"
              "🚚 *With Abdul to confirm the rest* · 1 of 3 received · left 01-Oct-2026 · today")
C_DISP_D1 = C_ADMIN_D1 + "\n📦 This delivery: 5801"
B_VIEW = [["🔍 View details"]]
C_CAP1 = f"📸 Receipt photo — {TRID} — delivery 1: 5801"

C_LIST1 = (f"🚚 *Open transfers*\n\n`{REF}` 3 bale(s) · 9006 · Lagos → Kano office — 📦 1 of 3 received\n"
           "   _waiting on Abdul · today_")
B_LIST1 = [[f"{REF} · 🟡 LAG▸KAN · 1/3B"], ["🏠 Back to menu"]]

C_TASKS1 = (f"🚚 *Transfers waiting on you*\n   `{REF}` 3 bale(s) · Lagos → Kano office\n"
            "     🚚 1 of 3 received — confirm the rest as it arrives")
B_TASKS1 = [[f"📦 Receive · {REF} · LAG▸KAN · 1/3B"]]

C_DETAIL1 = (f"🚚 *{TRID}* — partly received 📦 (1 of 3)\n"
             "🚚 *With Abdul to confirm the rest* · 1 of 3 received · left 01-Oct-2026 · today\n"
             "*Lagos* → *Kano office* · 3 bale(s)\n📅 Left Lagos: *01-Oct-2026*\nDispatcher: Musa · Receiver: Abdul\n\n"
             "🧵 *9006*\n • Shade 3 ×3 (5801 ✅, 5802, 5803)\n✅ *1 of 3 received* · 🚚 2 still on the road (5802, 5803)\n"
             "📦 Delivery 1: 1 bale(s) · 01-Oct-2026 · Abdul")
B_DETAIL = [["📦 3 bales — view all"], ["📄 Dispatch doc"], ["📄 Receipt doc"], ["◀ Less"]]

C_RSEAL2 = f"📦 *{REF}* — receipt pending 📸"
C_RPHOTO2 = (f"📸 *Photo required — {REF}*\nSend a photo or PDF of the remaining 2 bale(s) now to confirm receipt.\n"
             "_Stock goes live at *Kano office* when it arrives._")

C_SEAL2 = (f"✅ *{REF} received* — bales are now live at *Kano office* (in 2 deliveries).\n"
           "*Lagos* → *Kano office* · 3 bale(s)\n🧵 *9006*\n • Shade 3 ×3 (5801 ✅, 5802 ✅, 5803 ✅)\n📸 *Receipt photo attached*")

C_ADMIN_D2 = (f"🚚 *{REF}* received ✅ (all 3, in 2 deliveries) — 3 bale(s) · Lagos → Kano office\n"
              "✅ *Received by Abdul* · 01-Oct-2026")
C_DISP_D2 = C_ADMIN_D2 + "\n📦 This delivery: 5802, 5803"
C_CAP2 = f"📸 Receipt photo — {TRID} — delivery 2: 5802, 5803"

C_LIST_EMPTY = "🚚 *Open transfers*\n\n_None — everything is settled._"
B_LIST_EMPTY = [["🏠 Back to menu"]]

C_DETAIL2 = (f"🚚 *{TRID}* — received ✅\n✅ *Received by Abdul* · 01-Oct-2026\n"
             "*Lagos* → *Kano office* · 3 bale(s)\n📅 Left Lagos: *01-Oct-2026*\nDispatcher: Musa · Receiver: Abdul\n\n"
             "🧵 *9006*\n • Shade 3 ×3 (5801 ✅, 5802 ✅, 5803 ✅)\n"
             "📦 Delivery 1: 1 bale(s) · 01-Oct-2026 · Abdul\n📦 Delivery 2: 2 bale(s) · 01-Oct-2026 · Abdul")

# second transfer — rejected after a partial delivery
REF2 = "01Oct·02"
TRID2 = "TR-20261001-002"
C_REJQ = (f"⚠️ *Reject {REF2}?*\nThe records will return 2 bale(s) to *Lagos* — only do this if the goods are NOT being "
          "accepted at Kano office. The 1 bale(s) already received stay at *Kano office*.")
B_REJQ = [["⚠️ Yes — reject the transfer"], ["↩ Back"]]

C_REJDONE = (f"❌ *{REF2} rejected* — 2 bale(s) reverted to *Lagos*. 1 bale(s) received earlier stay at *Kano office*.\n"
             "*Lagos* → *Kano office* · 3 bale(s)\n🧵 *9006*\n • Shade 3 ×3 (5801 ✅, 5802, 5803)")
C_ADMIN_REJ = (f"🚚 *{REF2}* rejected ❌ — 3 bale(s) · Lagos → Kano office\n"
               "❌ *Closed* · 2 bale(s) back at Lagos · 1 kept at Kano office · 01-Oct-2026")
C_DETAIL_REJ = (f"🚚 *{TRID2}* — closed ❌\n❌ *Closed* · 2 bale(s) back at Lagos · 1 kept at Kano office · 01-Oct-2026\n"
                "*Lagos* → *Kano office* · 3 bale(s)\n📅 Left Lagos: *01-Oct-2026*\nDispatcher: Musa · Receiver: Abdul\n\n"
                "🧵 *9006*\n • Shade 3 ×3 (5801 ✅, 5802, 5803)\n"
                "✅ *1 received* at Kano office · ↩ 2 returned to Lagos (5802, 5803)\n"
                "📦 Delivery 1: 1 bale(s) · 01-Oct-2026 · Abdul")

C_STALE = f"🚚 That card belongs to an earlier step — it was replaced. Use the current {REF} card."
C_STRANGER = "This card is for the assigned person only."

# ── pages ────────────────────────────────────────────────────────────────
P = []

P.append(f"""
<section class="page cover">
  <div class="brand">AtFactoryPrice · Telegram ops bot · TRF-21</div>
  <h1>Receiving a transfer in parts</h1>
  <div class="sub">How some or all bales of one batch transfer are confirmed as they arrive — the method, and a live test for Abdul to run.</div>
  <div class="meta">Built 01-Oct-2026 from the code live on <b>main</b> (commit c1e3ffcd) · Owner's words, 30-Sep-2026: <i>"whichever goods he receives by that time,
  they can be updated instantly … without making him wait for the remaining goods"</i> · Every card on these pages is copied word for word from the bot.</div>

  <div class="who">
    <div class="wbox">
      <div class="wt">👤 Who does what</div>
      <p><b>Requester</b> — anyone active raises the transfer (an ORDER: nothing is locked). Abdul may raise it himself.</p>
      <p><b>Dispatcher</b> — the person at the <b>sending</b> store. Ticks the bales loaded, sends the load photo.</p>
      <p><b>Owner (admin)</b> — approves a dispatch logged by a non-admin. An admin's own dispatch needs no approval.</p>
      <p><b>Receiver — Abdul</b> — the person at the <b>receiving</b> store. This test is his.</p>
    </div>
    <div class="wbox">
      <div class="wt">📍 The example on these pages</div>
      <p>Lagos → Kano office · design <b>9006</b> · shade <b>3</b> · bales <b>5801, 5802, 5803</b> · Musa dispatches · Abdul receives · reference <b>{REF}</b>.</p>
      <p>Use any real route where <b>Abdul is at the receiving end</b>. Your bale numbers, dates and reference will differ; the <b>wording</b> of every card must not.</p>
      <p>Needs: Abdul's phone, the sending store's phone, the owner's phone, the Inventory and ApprovalQueue sheets open on a computer.</p>
    </div>
  </div>

  <div class="danger">
    <div class="dt">⛔ THREE RULES — READ BEFORE THE FIRST TAP</div>
    <div class="db"><b>1.</b> Tick only a bale that is physically in front of you. The bot never ticks for you; a bale you cannot see stays on the road.<br>
    <b>2.</b> Every delivery needs its own photo of the goods received. Nothing changes until the photo lands — there is no skip.<br>
    <b>3.</b> <b>⚠️ Reject</b> sends the bales still on the road back to the sending store's records. Tap it only when goods are <b>not</b> being accepted — never to "close" a transfer.</div>
  </div>

  <div class="what">
    <div class="wt2">🧭 How it works in one minute</div>
    <p>A transfer leaves one store as <b>one load</b> (one dispatch, one photo). It may <b>arrive in several deliveries</b>. The receiver's card now has three doors:</p>
    <div class="cando">
      <div class="can"><b>✅ Received</b><br>Everything still on the road has arrived. One photo. The transfer closes.</div>
      <div class="can"><b>📦 Only some arrived — tick them</b><br>Tick the bales here now, one photo. They go live at once; the rest stay in transit and the card waits for the next delivery.</div>
      <div class="cant"><b>⚠️ Reject</b><br>The goods are not accepted. Only the bales still on the road go back to the sending store; bales already received stay.</div>
    </div>
    <p style="margin-top:2mm">Each delivery writes <b>one Transactions row</b> and one <b>receive</b> line per bale in BaleMovements. The transfer stays open (<b>pending</b>) until the last bale; the row then flips to <b>approved</b> exactly as before.</p>
  </div>

  <div class="report">📋 Mark <b>PASS</b> or <b>FAIL</b> on every test as you go, write what you saw when it fails, and send a photo of the filled pages to the owner.
  Tests 1–4 set the load up; 5–12 are the receipt; 13–16 repeat it with a reject; 17–19 are quick guard checks.</div>
</section>""")

P.append(f"""
<section class="page">
  <div class="ph">The method — what the receiver sees between deliveries</div>
  <table class="grid">
    <thead><tr><th>Where</th><th>Before any delivery</th><th>After 1 of 3 arrived</th></tr></thead>
    <tbody>
      <tr><td class="k">The receiver's card</td><td>Confirm when the goods arrive and match…</td>
          <td>• Shade 3 ×3 (5801 ✅, 5802, 5803)<br>✅ 1 of 3 received · 🚚 2 still on the road (5802, 5803)<br>✅ Received confirms the remaining 2</td></tr>
      <tr><td class="k">The waiting line (card · 📋 list · details)</td><td>🚚 With Abdul to confirm arrival · left 01-Oct-2026 · today</td>
          <td>🚚 With Abdul to confirm the rest · 1 of 3 received · left 01-Oct-2026 · today <span class="small">(the clock restarts at the last delivery)</span></td></tr>
      <tr><td class="k">The row (🛂 inbox · 📋 list · My Tasks button)</td><td>{REF} · 🟡 LAG▸KAN · 3B</td><td>{REF} · 🟡 LAG▸KAN · <b>1/3B</b> <span class="small">(received / logged)</span></td></tr>
      <tr><td class="k">My Tasks line</td><td>🚚 in transit — confirm receipt</td><td>🚚 1 of 3 received — confirm the rest as it arrives</td></tr>
      <tr><td class="k">Admins and the requester</td><td>— (told at dispatch)</td><td>🚚 {REF} partly received 📦 (1 of 3) … + the receipt photo</td></tr>
      <tr><td class="k">The dispatcher</td><td>—</td><td>the same line + 📦 This delivery: 5801 + the photo</td></tr>
      <tr><td class="k">ApprovalQueue sheet, column E</td><td>pending</td><td><b>pending</b> (still open) — becomes <b>approved</b> only when the last bale is confirmed</td></tr>
      <tr><td class="k">Inventory sheet, the bale's rows (H status · I warehouse)</td><td>in_transit · Kano office</td><td>5801: <b>available · Kano office</b> · 5802, 5803: in_transit · Kano office</td></tr>
      <tr><td class="k">Transactions sheet</td><td>—</td><td>one row, action transfer_stock, qty <b>1</b>; the next delivery adds its own row (qty 2)</td></tr>
      <tr><td class="k">BaleMovements sheet</td><td>dispatch lines</td><td>one <b>receive</b> line for 5801, MovedOn = the delivery day</td></tr>
    </tbody>
  </table>

  <div class="two">
    <div class="half">
      <div class="wt2">🧾 What the record keeps</div>
      <p class="p">Nothing new on any sheet. The transfer's own ApprovalQueue row remembers the bales confirmed so far, which Inventory rows they were, and one entry per delivery (when, who, which bales, that delivery's photo). A single all-at-once ✅ Received writes no delivery record — it is the old receipt, unchanged.</p>
      <div class="wt2">🔁 The next delivery</div>
      <p class="p">Open the same card (My Tasks → 🚚 Transfers waiting on you, or 📋 Transfers → tap the row). <b>✅ Received</b> now means "the remaining N". <b>📦 Only some arrived</b> lists only what is still on the road; a bale confirmed earlier is never offered twice. When only ONE bale is left, the tick door disappears — ✅ Received is the only way, which is correct.</p>
    </div>
    <div class="half">
      <div class="wt2">🛑 Things that are deliberately refused</div>
      <ul class="ul">
        <li>A photo cannot be skipped. ↩ Not now on the photo prompt stands the delivery down; nothing changes.</li>
        <li>An old copy of the picker (an earlier message) cannot tick into the current one — the bot says the card was replaced.</li>
        <li>Only the receiver (or an admin acting for them) can tap the card. Anyone else: "This action is for the assigned person only."</li>
        <li>A load that carries the <b>same bale number twice</b> (one number in two containers) shows no tick door — it is received in one go.</li>
        <li>Mark-as-done, re-raising the remainder as a new transfer, or editing the sheet by hand are NOT part of this method. If something looks wrong, stop and report.</li>
      </ul>
    </div>
  </div>
  <div class="foot">Spec: telegram-ops-bot/specs/TRF-21_PARTIAL_RECEIPT.md · Rules: docs/BUSINESS_RULES.md §8 (TRF-21 bullet), §2, §3, §5, §6c.</div>
</section>""")

# ── Part A — set the load up ─────────────────────────────────────────────
P.append(f"""
<section class="page tests">
  <div class="ph">Part A — put a three-bale load on the road (requester → dispatcher → owner)</div>
  <div class="small" style="margin-bottom:3mm">Skip to Part B if a real transfer of <b>at least three bales</b> is already in transit to Abdul's store. Otherwise, do these four once.
  Cards shown are the requester's and dispatcher's; Abdul only watches until TEST 4.</div>

  {testblock(1, "Requester (anyone, e.g. the owner)", "Raise a transfer of 3 bales to Abdul's store",
    "Menu → 🚚 <b>Transfer Stock</b> → pick the sending store → the design → the shade → <b>All 3</b> (or 3) → the receiving store. "
    "The bot picks the dispatcher and receiver from the Users sheet; on the confirm card tap <b>✅ Send</b>.",
    "The confirm card names the dispatcher and <b>Receiver: Abdul</b>. After Send, the requester's card reads <b>✅ Transfer … sent</b> and the dispatcher's phone receives "
    "<b>🚚 Transfer … — please dispatch</b> with <b>✅ Accept &amp; dispatch</b> / <b>❌ Decline</b>.",
    card(C_CONFIRM, B_CONFIRM, who="Requester's screen") + card(C_DISP, B_DISP, who="Dispatcher's phone"),
    note="If the receiver named is not Abdul, stop: fix Abdul's warehouse in the Users sheet (column I) and raise it again.")}

  {testblock(2, "Dispatcher (sending store)", "Accept, tick the three bales loaded, send the load photo",
    "Tap <b>✅ Accept &amp; dispatch</b>. Tick the three bale numbers that are physically loaded (the bot pre-ticks nothing) → <b>✅ Review</b> → "
    "check the list and the date → <b>🚚 Dispatch</b> → send a photo of the loaded bales.",
    "The picker counts <b>Selected: 3/3</b>; the review lists the three numbers; the photo prompt says <b>Nothing moves until it arrives</b>. "
    "After the photo: a non-admin dispatcher sees <b>🛂 … sent for admin approval</b> (nothing has moved yet); an admin dispatcher sees <b>🚚 … dispatched — bales logged</b> and Part A is done.",
    card(C_PICK, B_PICK, who="Dispatcher") + card(C_REVIEW, B_REVIEW, who="Dispatcher") + card(C_LOADPHOTO, B_LOADPHOTO, who="Dispatcher"),
    warn="Write the three bale numbers here — every later test refers to them: _______ · _______ · _______")}
""")

P.append(f"""
  {testblock(3, "Owner (admin)", "Approve the parked dispatch",
    "On the owner's phone open the card <b>🛂 Transfer … — awaiting your approval</b> (the dispatch photo arrives with it). Check the three numbers against the photo, then tap <b>✅ Approve dispatch</b>.",
    "The owner's card becomes <b>🚚 … — approved by you, dispatched</b>. The dispatcher gets <b>✅ … approved — the goods are now in transit to Kano office</b>. "
    "In the Inventory sheet the three bales now read status <b>in_transit</b>, warehouse <b>Kano office</b> (the receiving store).",
    card(C_PARKED, B_PARKED, who="Dispatcher, after the photo") + card(C_ADMIN, B_ADMIN, who="Owner's phone"),
    note="Only needed when the dispatcher is not an admin (TRF-18). If the owner dispatched in TEST 2, skip this.")}

  {testblock(4, "Abdul (receiver)", "The incoming card arrives — and it has a new door",
    "Do nothing yet. Look at the card that lands on your phone the moment the dispatch is approved, and at the dispatch photo that follows it.",
    "Exactly these buttons, in this order: <b>✅ Received</b> · <b>⚠️ Reject</b> on one row, then <b>📦 Only some arrived — tick them</b>, then <b>📦 3 bales — view all</b>, then <b>📄 Dispatch doc</b>. "
    "The text lists the three numbers after <b>Shade 3 ×3</b> and ends <b>a photo/PDF of the received goods is required</b>.",
    card(C_RCARD, B_RCARD, who="Abdul's phone"),
    warn="If the <b>📦 Only some arrived</b> button is missing, the bot on the server is older than this guide — stop and tell the owner.")}
""")

# ── Part B — delivery 1 ──────────────────────────────────────────────────
P.append(f"""
  <div class="ph">Part B — the first delivery: ONE bale arrives, two are still on the truck</div>

  {testblock(5, "Abdul", "Open the arrival list",
    "Tap <b>📦 Only some arrived — tick them</b> on the incoming card.",
    "A NEW message appears under the card (the card itself keeps its buttons). It lists the three numbers under their design and shade, every chip is <b>⬜ unticked</b>, "
    "it reads <b>Ticked: 0/3</b>, and there is <b>no Confirm button yet</b> — only <b>↩ Not now</b>.",
    card(C_PICKER0, B_PICKER0, who="Abdul — the picker"),
    note="Unticked on purpose (business rule 2: the bot never selects physical stock). You tick what is in front of you.")}

  {testblock(6, "Abdul", "Tick the one bale that arrived, confirm",
    "Tap the chip of the bale physically in front of you (in the example, <b>5801</b>). Then tap <b>✅ Confirm 1 of 3 arrived</b>.",
    "After the tick the chip reads <b>✅ 5801</b>, the text <b>Ticked: 1/3</b>, and a <b>✅ Confirm 1 of 3 arrived</b> button appears. After Confirm the picker seals to "
    "<b>… 1 bale(s) ticked ✔ · receipt pending 📸</b> and a fresh prompt asks for a photo of <b>the 1 bale(s) received now (5801)</b>, saying <b>the other 2 stay on the road</b>.",
    card(C_PICKER1, B_PICKER1, who="Abdul — after one tick") + card(C_PICKSEAL, (), who="Abdul — the picker, sealed") + card(C_RPHOTO1, B_RPHOTO, who="Abdul — photo prompt"),
    warn="Check the Inventory sheet NOW: all three bales must still be <b>in_transit</b>. Nothing moves before the photo.")}
""")

P.append(f"""
  {testblock(7, "Abdul", "Send the photo — the one bale goes live, the transfer stays open",
    "Take a photo of the bale that arrived and send it in the chat.",
    "Three things, within seconds: (1) the photo prompt becomes <b>📦 … — 1 of 3 received — 5801 now live at Kano office; 2 still on the road</b> + <b>📸 Receipt photo attached</b>; "
    "(2) the sealed picker message <b>disappears</b>; (3) your incoming card is <b>redrawn in place</b> — it now shows <b>5801 ✅</b> in the list, the line "
    "<b>✅ 1 of 3 received · 🚚 2 still on the road (5802, 5803)</b>, the waiting line <b>With Abdul to confirm the rest · 1 of 3 received</b>, and ALL its buttons plus a new <b>📄 Receipt doc</b>.",
    card(C_SEAL1, B_SEAL, who="Abdul — the prompt, sealed") + card(C_RCARD1, B_RCARD1, who="Abdul — the card, redrawn"),
    warn="Sheet check: 5801 → status <b>available</b>, warehouse <b>Kano office</b>. 5802 and 5803 → still <b>in_transit</b>. ApprovalQueue column E for this transfer → still <b>pending</b>. "
         "Transactions → one new row, qty <b>1</b>.")}

  {testblock(8, "Owner + dispatcher", "Everyone else hears about the delivery",
    "Look at the owner's phone and the dispatcher's phone.",
    "Owner: <b>🚚 … partly received 📦 (1 of 3)</b> with the waiting line, plus the receipt photo captioned <b>… — delivery 1: 5801</b>. "
    "Dispatcher: the same card with one more line, <b>📦 This delivery: 5801</b>, plus the photo. Abdul himself gets no extra message (his card is the record).",
    card(C_ADMIN_D1, B_VIEW, who="Owner's phone") + card(C_DISP_D1, B_VIEW, who="Dispatcher's phone") + card("", (), kind="photo", photo=mockphoto("bale 5801 on the floor"), caption=C_CAP1, who="Both"),
    note="If the dispatcher also raised the transfer, they get this once, not twice.")}
""")

P.append(f"""
  {testblock(9, "Abdul", "The lists agree: 📋 Transfers and My Tasks",
    "Tap <b>📋 Transfers</b> on your card (or Menu → 📋 Transfers). Then open <b>My Tasks</b>.",
    "📋 Transfers: the row reads <b>… — 📦 1 of 3 received</b>, <b>waiting on Abdul</b>, and its button ends <b>· 🟡 LAG▸KAN · 1/3B</b>. "
    "My Tasks → 🚚 Transfers waiting on you: <b>🚚 1 of 3 received — confirm the rest as it arrives</b>, button <b>📦 Receive · … · 1/3B</b>. Tapping either opens the same redrawn card as TEST 7.",
    card(C_LIST1, B_LIST1, who="📋 Transfers") + card(C_TASKS1, B_TASKS1, who="My Tasks (section)"),
    note="The owner's 🛂 Approvals → 🚚 Transfers chip shows the same <b>1/3B</b> row; 🔍 View details lists <b>📦 Delivery 1: 1 bale(s) · date · Abdul</b>.")}

  <div class="ph" style="margin-top:4mm">Part C — the second delivery: the remaining two bales arrive</div>

  {testblock(10, "Abdul", "✅ Received now means “the rest”",
    "Open the card (My Tasks or 📋 Transfers) and tap <b>✅ Received</b>.",
    "The card seals to <b>📦 … — receipt pending 📸</b> and the prompt asks for a photo of <b>the remaining 2 bale(s)</b>.",
    card(C_RSEAL2, (), who="Abdul — the card, sealed") + card(C_RPHOTO2, B_RPHOTO, who="Abdul — photo prompt"),
    note="Two bales left, so the tick door was still offered on the card; with ONE bale left it would not be (a single option is navigation, not selection). Both routes are fine here.")}
""")

P.append(f"""
  {testblock(11, "Abdul", "Send the photo — the transfer closes “in 2 deliveries”",
    "Photograph the two bales and send it.",
    "The prompt becomes <b>✅ … received — bales are now live at Kano office (in 2 deliveries)</b> with all three numbers ticked <b>5801 ✅, 5802 ✅, 5803 ✅</b>. "
    "Owner and dispatcher get <b>received ✅ (all 3, in 2 deliveries)</b> + <b>✅ Received by Abdul</b>; the dispatcher's adds <b>📦 This delivery: 5802, 5803</b>; the photo caption reads <b>delivery 2: 5802, 5803</b>.",
    card(C_SEAL2, B_SEAL, who="Abdul") + card(C_DISP_D2, B_VIEW, who="Dispatcher's phone"),
    warn="Sheet check: all three bales <b>available · Kano office</b>. ApprovalQueue column E → <b>approved</b>, G has today's time, H names the admin who released the dispatch. "
         "Transactions → a second row, qty <b>2</b> (two rows in total for this transfer). BaleMovements → a <b>receive</b> line per bale, dated each bale's own delivery day.")}

  {testblock(12, "Abdul + owner", "Closed everywhere; the record keeps both deliveries",
    "Abdul: open 📋 Transfers. Owner: on any card of this transfer tap <b>🔍 View details</b>.",
    "📋 Transfers: <b>None — everything is settled</b> (or the row is gone). View details: <b>received ✅</b>, <b>✅ Received by Abdul · date</b>, and two lines "
    "<b>📦 Delivery 1: 1 bale(s) · … · Abdul</b> and <b>📦 Delivery 2: 2 bale(s) · … · Abdul</b>. 📄 Receipt doc opens the LAST photo; 🛂 Approvals → ✅❌ Decided lists it as received.",
    card(C_LIST_EMPTY, B_LIST_EMPTY, who="📋 Transfers") + card(C_DETAIL2, B_DETAIL, who="Owner — View details"))}
""")

# ── Part D — reject after a partial delivery ────────────────────────────
P.append(f"""
  <div class="ph">Part D — a second transfer: one bale arrives, then the rest is refused</div>
  <div class="small" style="margin-bottom:3mm">Repeat Part A for a NEW three-bale load (reference in the example: <b>{REF2}</b>) and TESTS 5–7 for one bale. Then:</div>

  {testblock(13, "Abdul", "⚠️ Reject — the card tells you exactly what will move",
    "On the redrawn card (one bale ✅, two on the road) tap <b>⚠️ Reject</b>. Read the confirm screen. Do NOT tap Yes yet.",
    "<b>The records will return 2 bale(s) to Lagos</b> … <b>The 1 bale(s) already received stay at Kano office.</b> Two buttons: <b>⚠️ Yes — reject the transfer</b> and <b>↩ Back</b>. "
    "Tap <b>↩ Back</b> once: the card returns unchanged, with all its buttons.",
    card(C_REJQ, B_REJQ, who="Abdul"),
    warn="Reject is for goods that are NOT being accepted at your store. In this test the two bales are a stand-in for goods that never came.")}

  {testblock(14, "Abdul", "Confirm the reject",
    "Tap <b>⚠️ Reject</b> again, then <b>⚠️ Yes — reject the transfer</b>.",
    "<b>❌ … rejected — 2 bale(s) reverted to Lagos. 1 bale(s) received earlier stay at Kano office.</b> The list still shows <b>5801 ✅</b>. "
    "Owner: <b>🚚 … rejected ❌</b> with <b>❌ Closed · 2 bale(s) back at Lagos · 1 kept at Kano office · date</b>.",
    card(C_REJDONE, B_SEAL, who="Abdul") + card(C_ADMIN_REJ, B_VIEW, who="Owner's phone"),
    warn="Sheet check: 5801 stays <b>available · Kano office</b>; 5802 and 5803 → <b>available · Lagos</b>. ApprovalQueue column E → <b>rejected</b>, H names Abdul.")}
""")

P.append(f"""
  {testblock(15, "Owner", "The closed record says what stayed and what went home",
    "Tap <b>🔍 View details</b> on the rejected card. Then open 🛂 Approvals → 🚚 Transfers (or ✅❌ Decided).",
    "<b>closed ❌</b> · <b>❌ Closed · 2 bale(s) back at Lagos · 1 kept at Kano office</b> · the line <b>✅ 1 received at Kano office · ↩ 2 returned to Lagos (5802, 5803)</b> · <b>📦 Delivery 1</b>. "
    "Nowhere does it say “still on the road”. The row in the inbox reads <b>… · ❌ LAG▸KAN · 1/3B</b> — the split survives the close.",
    card(C_DETAIL_REJ, B_DETAIL, who="Owner — View details"))}

  {testblock(16, "Abdul", "Nothing is left waiting on you",
    "Open 📋 Transfers and My Tasks.",
    "📋 Transfers: <b>None — everything is settled</b> (or that row is gone). My Tasks: no 🚚 Transfers waiting on you entry for it. No reminder card for it arrives later.",
    card(C_LIST_EMPTY, B_LIST_EMPTY, who="📋 Transfers"))}

  <div class="ph" style="margin-top:4mm">Part E — quick guard checks (any live load, 2 minutes)</div>

  {testblock(17, "Abdul", "↩ Not now on the picker drops the ticks and nothing moves",
    "Open <b>📦 Only some arrived</b>, tick one bale, then tap <b>↩ Not now</b>.",
    "The picker message disappears; the card is redrawn where it stands with all its buttons; the sheet is unchanged. Open the picker again: every chip is <b>⬜</b> again (the tick was not kept).",
    "", note="Also try ↩ Not now on the PHOTO prompt after a Confirm: the prompt and the sealed picker disappear, your card is back with its buttons, nothing is received.")}
""")

P.append(f"""
  {testblock(18, "Abdul", "An old picker copy cannot tick into the live one",
    "Open the picker from the card. Without closing it, open the SAME transfer from 📋 Transfers and tap <b>📦 Only some arrived</b> again (a second picker appears). "
    "Now tap a chip on the FIRST (older) picker.",
    "The bot answers <b>🚚 That card belongs to an earlier step — it was replaced. Use the current … card.</b> and the older chip does nothing. "
    "Ticks on the newer picker count; ↩ Not now on the older one leaves the newer one's ticks alone.",
    card(C_STALE, (), who="Abdul"))}

  {testblock(19, "Anyone who is NOT Abdul and not an admin", "The card is Abdul's alone",
    "From another employee's phone (not the dispatcher's, not the requester's), open 📋 Transfers and tap the transfer's row.",
    "A pop-up: <b>This card is for the assigned person only.</b> The card does not open, so none of its buttons can be tapped; nothing changes. "
    "(The owner, as admin, CAN open it and act in Abdul's seat — the card then says <b>👤 You are acting for Abdul — this is their card</b>.)",
    card(C_STRANGER, (), who="Other phone — pop-up"),
    note="If an old copy of the card is somehow in that person's chat and they tap a button on it, the answer is <b>This action is for the assigned person only.</b> — same result.")}

  {testblock(20, "Abdul (optional)", "Ticking EVERY bale is the ordinary receipt",
    "On a fresh load, open <b>📦 Only some arrived</b>, tick ALL the bales, Confirm, send the photo.",
    "The seal reads <b>✅ … received — bales are now live at Kano office.</b> with no “in N deliveries”; View details shows no 📦 Delivery lines; Transactions has ONE row for the whole load. "
    "Exactly what ✅ Received would have done.",
    "")}
</section>""")

# ── report page ──────────────────────────────────────────────────────────
ROWS = [
 ("1", "Raise a 3-bale transfer to Abdul's store"), ("2", "Dispatcher ticks 3 bales, load photo"),
 ("3", "Owner approves the parked dispatch"), ("4", "Incoming card has the 📦 Only some arrived door"),
 ("5", "Picker opens as a new message, all ⬜, no Confirm"), ("6", "One tick → Confirm → photo prompt; sheet unchanged"),
 ("7", "Photo → 1 live, 2 in transit, row pending, card redrawn"), ("8", "Owner + dispatcher told, photo + delivery line"),
 ("9", "📋 Transfers and My Tasks read 1/3B"), ("10", "✅ Received asks for the remaining 2"),
 ("11", "Photo → closed in 2 deliveries; approved; 2 txn rows"), ("12", "Record keeps Delivery 1 and Delivery 2"),
 ("13", "Reject confirm: 2 back / 1 stays; Back returns card"), ("14", "Reject: 2 bales back at Lagos, 1 stays; row rejected"),
 ("15", "Closed record: 1 received · 2 returned; row ❌ 1/3B"), ("16", "Nothing waiting on Abdul"),
 ("17", "Not now drops ticks, moves nothing"), ("18", "Old picker copy is refused"), ("19", "Other phone is refused"),
 ("20", "All ticked = ordinary receipt (optional)"),
]
trs = "".join(f'<tr><td class="n">{n}</td><td>{html.escape(t)}</td><td class="v">☐ PASS &nbsp; ☐ FAIL</td><td></td></tr>' for n, t in ROWS)
P.append(f"""
<section class="page">
  <div class="ph">Report — fill in and send to the owner</div>
  <table class="rep">
    <thead><tr><th>#</th><th>Test</th><th>Result</th><th>Notes (what you saw instead)</th></tr></thead>
    <tbody>{trs}</tbody>
  </table>
  <div class="sign">
    <div class="sbox">Bale numbers used — load 1: __________ · __________ · __________ &nbsp;&nbsp; load 2: __________ · __________ · __________</div>
    <div class="sbox">References (as printed on the cards, e.g. {REF}): load 1 __________ &nbsp; load 2 __________ &nbsp;&nbsp; Date: ____________</div>
    <div class="sbox">Receiver (Abdul) signature: ______________________ &nbsp;&nbsp; Dispatcher: ______________________ &nbsp;&nbsp; Owner: ______________________</div>
  </div>

  <div class="known">
    <div class="kt">Known and expected — do NOT report these as faults</div>
    <ul>
      <li><b>The tick list starts empty.</b> The owner's first idea was "all ticked, untick the missing"; business rule 2 forbids pre-ticked chips, so you tick what arrived. The owner can change this rule.</li>
      <li><b>With one bale left there is no tick door</b> — ✅ Received is the only button, and it receives that one bale.</li>
      <li><b>A transfer with the same bale number twice</b> shows no tick door and says so on the card; it is received in one go.</li>
      <li><b>The hourly reminder keeps coming</b> for a partly received transfer until the last bale is confirmed or it is rejected. That is intended.</li>
      <li><b>The Transactions date</b> on each delivery's row is the day the load LEFT the store (the dispatch date); the delivery day is on the BaleMovements line and in View details.</li>
      <li><b>Dispatch is still one load.</b> A dispatcher cannot send a transfer in parts — only the receipt is split.</li>
    </ul>
  </div>
  <div class="foot">Questions during the test: stop and ask the owner. Do not repeat a failed test, do not use Mark-as-done, and never fix the sheet by hand to make a test pass.</div>
</section>""")

CSS = """
@page { size: A4; margin: 11mm 10mm; }
* { box-sizing: border-box; }
body { margin:0; font-family:"DejaVu Sans","Segoe UI",Arial,sans-serif; color:#16202a; font-size:10.4pt; line-height:1.4; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
h1 { font-size:30pt; margin:2mm 0 1mm; letter-spacing:-.5px; }
.brand { font-size:8.2pt; letter-spacing:2.4px; text-transform:uppercase; color:#7d8b99; font-weight:700; }
.sub { font-size:12.2pt; color:#3d4b59; }
.meta { font-size:9pt; color:#4a5866; padding:1.6mm 0; border-top:1px solid #e2e8ee; border-bottom:1px solid #e2e8ee; margin:2.4mm 0 3.6mm; }
.ph { font-size:12.4pt; font-weight:700; color:#0e2a47; border-bottom:2.4px solid #0e2a47; padding-bottom:1.2mm; margin-bottom:3.2mm; page-break-after:avoid; }
.ph + .small { page-break-after:avoid; }
.small { font-size:8.8pt; color:#5d6b79; }

.who { display:flex; gap:5mm; margin-bottom:3.4mm; }
.wbox { flex:1; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 3.6mm; background:#fbfcfd; }
.wt, .wt2 { font-weight:700; color:#0e2a47; margin-bottom:1.6mm; }
.wbox p { margin:0 0 1.4mm; font-size:9.6pt; }

.danger { border:2.4px solid #a3232a; background:#fff6f6; border-radius:3mm; padding:3.2mm 4mm; margin-bottom:3.4mm; }
.dt { font-weight:800; color:#8c1f24; letter-spacing:.6px; margin-bottom:1.4mm; }
.db { font-size:9.8pt; color:#40282a; }

.what { border:1px solid #dde4ea; border-radius:3mm; padding:3mm 3.6mm; background:#f4f7fa; margin-bottom:3.4mm; }
.what p { margin:0 0 2mm; font-size:9.8pt; }
.cando { display:flex; gap:3.4mm; }
.can, .cant { flex:1; border-radius:2mm; padding:2.4mm 3mm; font-size:9.2pt; }
.can { background:#e5f4ec; border:1px solid #8ecfae; }
.cant { background:#fdeeee; border:1px solid #e2a3a6; }
.report { border:1px dashed #93a3b2; border-radius:2.4mm; padding:2.8mm 3.4mm; font-size:9.6pt; background:#fff; }

.grid { width:100%; border-collapse:collapse; font-size:8.6pt; margin-bottom:3.4mm; }
.grid th { background:#0e2a47; color:#fff; text-align:left; padding:1.8mm 2.4mm; font-size:8.6pt; }
.grid td { border-bottom:1px solid #dde4ea; padding:1.4mm 2.2mm; vertical-align:top; }
.grid td.k { width:42mm; font-weight:700; color:#0e2a47; }
.two { display:flex; gap:5mm; }
.half { flex:1; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 3.6mm; background:#fbfcfd; }
.p { margin:0 0 2mm; font-size:9pt; }
.ul { margin:0; padding-left:5mm; font-size:8.8pt; } .ul li { margin-bottom:1mm; }

/* test blocks */
.test { border:1px solid #dde4ea; border-radius:3mm; margin-bottom:2.6mm; page-break-inside:avoid; overflow:hidden; }
.thead { background:#0e2a47; color:#fff; padding:2mm 3mm; display:flex; align-items:center; gap:3mm; }
.tnum { font-weight:800; font-size:9.4pt; letter-spacing:1px; background:#1d6fa5; padding:.8mm 2.4mm; border-radius:1.4mm; white-space:nowrap; }
.twho { font-size:8.6pt; background:#ffffff22; padding:.8mm 2.2mm; border-radius:1.4mm; white-space:nowrap; }
.ttitle { font-weight:700; font-size:10.6pt; }
.tbody { display:flex; gap:3.4mm; padding:2mm 3mm; }
.tbody.col { display:block; }
.cols { display:flex; gap:4mm; } .cols .c { flex:1; } .cols .see2 .lab.see { margin-top:0; }
.cardrow { display:flex; gap:2mm; margin-top:2mm; align-items:flex-start; } .cardrow .tg { flex:1; margin-bottom:0; }
.tleft { flex:1.15; } .tright { flex:1; }
.lab { font-size:8pt; font-weight:800; letter-spacing:1.2px; margin-bottom:1mm; }
.lab.do { color:#1d6fa5; } .lab.see { color:#1c6b45; margin-top:2.6mm; }
.txtblk { font-size:9pt; }
.tnote { margin-top:2mm; font-size:8.6pt; background:#eef6ff; border-left:3px solid #1d6fa5; padding:1.6mm 2.4mm; }
.twarn { margin-top:2mm; font-size:8.6pt; background:#fff4f4; border-left:3px solid #a3232a; padding:1.6mm 2.4mm; }
.verdict { margin-top:2mm; padding-top:1.2mm; border-top:1px dashed #cfdae4; font-size:9.4pt; }
.box { font-weight:800; margin-right:5mm; }
.box.pass { color:#1c6b45; } .box.fail { color:#8c1f24; }
.notes { color:#7d8b99; font-size:8.6pt; }

/* telegram */
.tg { background:#0e1621; border-radius:2.4mm; padding:1.8mm; margin-bottom:1.8mm; }
.tgwho { color:#8fa3b5; font-size:6.8pt; letter-spacing:.6px; text-transform:uppercase; margin:0 0 1mm .4mm; }
.bubble { background:#182533; border-radius:2mm; padding:1.6mm 2mm .8mm; }
.txt { color:#e9eef3; font-size:7.3pt; line-height:1.3; word-wrap:break-word; white-space:pre-wrap; }
.txt b { color:#fff; } .dim, .txt i { color:#8fa3b5; font-style:italic; }
.txt code { background:#0e1621; border-radius:1mm; padding:0 .8mm; font-family:"DejaVu Sans Mono",monospace; font-size:7.4pt; color:#a9c7e4; }
.time { text-align:right; color:#6d8298; font-size:6.6pt; margin-top:.6mm; }
.krow { display:flex; gap:.8mm; margin-top:.7mm; }
.kbtn { flex:1; background:#22303f; color:#e9eef3; text-align:center; font-size:6.8pt; padding:.8mm .6mm; border-radius:1.2mm; }
.pic { height:18mm; border-radius:1.6mm; margin-bottom:1.4mm; overflow:hidden; }
.mocklabel { height:100%; background:linear-gradient(160deg,#8a9a6a,#6d7b52); position:relative; display:flex; align-items:center; justify-content:center; }
.mocklabel .lbl { color:#1a2a3b; font-weight:800; font-size:6.6pt; line-height:1.5; background:rgba(255,255,255,.55); padding:1.2mm 2.2mm; border-radius:1mm; }
.mocklabel span { position:absolute; bottom:0; left:0; right:0; background:rgba(8,14,22,.8); color:#c9d6e2; font-size:6.8pt; text-align:center; padding:.6mm 0; }

/* report */
.rep { width:100%; border-collapse:collapse; font-size:9pt; }
.rep th { background:#0e2a47; color:#fff; text-align:left; padding:1.8mm 2.4mm; font-size:8.6pt; }
.rep td { border-bottom:1px solid #dde4ea; padding:1.1mm 2.2mm; }
.rep .n { width:8mm; font-weight:700; color:#1d6fa5; }
.rep .v { width:30mm; font-weight:700; white-space:nowrap; }
.rep td:last-child { width:56mm; }
.sign { margin-top:3.4mm; }
.sbox { border:1px solid #dde4ea; border-radius:2mm; padding:2.2mm 3.4mm; margin-bottom:1.8mm; font-size:9.2pt; background:#fbfcfd; }
.known { margin-top:3.4mm; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 3.6mm; background:#f4f7fa; }
.kt { font-weight:700; color:#0e2a47; margin-bottom:1.6mm; }
.known ul { margin:0; padding-left:5mm; font-size:8.6pt; } .known li { margin-bottom:.9mm; }
.foot { margin-top:3.4mm; font-size:8.4pt; color:#7d8b99; border-top:1px solid #e2e8ee; padding-top:1.6mm; }
"""

OUT.write_text(f"<!doctype html><html><head><meta charset='utf-8'><title>TRF-21 — Receiving a transfer in parts</title><style>{CSS}</style></head><body>{''.join(P)}</body></html>", encoding="utf-8")
print("wrote", OUT)
