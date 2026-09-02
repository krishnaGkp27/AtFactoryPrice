#!/usr/bin/env python3
"""SHP-1 — build the operator's step-by-step Shade Photos guide (docs/SHP-1_SHADE_PHOTOS_GUIDE.pdf).

Usage (regenerate after any wording change in the flow):
    python3 scripts/build-shade-photos-guide.py
    chromium --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
      --print-to-pdf=docs/SHP-1_SHADE_PHOTOS_GUIDE.pdf docs/SHP-1_SHADE_PHOTOS_GUIDE.html
(any Chromium works; this container has one at /opt/pw-browsers/chromium)

Every card body/button string below is copied VERBATIM from the shipped code
(src/flows/shadePhotoFlow.js @ 14914c62 and the services it calls), with the
Markdown resolved the way Telegram renders it (*x* -> bold, _x_ -> dim italic).
Worked example: design 202/201, shades 1 White .. 5 Taupe Grey, store IDUMOTA.
"""
import html, pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "docs" / "SHP-1_SHADE_PHOTOS_GUIDE.html"

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

# ── the real strings ─────────────────────────────────────────────────────
TITLE = "🎨 *Shade Photos*\n\n"   # makeRenderer titlePrefix — on EVERY text card

S_DESIGNS = TITLE + "Pick the design. One garment picture per shade — it shows the moment a shade is selected.\n_(✓ = already has shade photos)_"
B_DESIGNS = [["202/201", "9037", "✓ 77014"], ["77016", "9043-B", "80045"], ["⬅", "1/2", "➡"], ["🏠 Back to menu"]]

S_SHADES = TITLE + "*202/201*\nTap a shade to add its garment picture.\n_(✓ = has a photo · 🆕 = added now, waiting for ✅ Done)_"
B_SHADES = [["1 - White"], ["2 - Dark Brown"], ["3 - Navy Blue"], ["4 - Royal Blue"], ["5 - Taupe Grey"],
            ["📷 Add next missing"], ["⬅ Designs"], ["❌ Cancel"]]

S_PROMPT = TITLE + "*202/201 · shade 1 - White*\n\nSend the garment picture for this shade.\n\n📎 For full quality send it as a *File* (📎 → File), not as a photo — Telegram compresses photos."
B_PROMPT = [["⏭ Skip this shade"], ["⬅ Shades"], ["❌ Cancel"]]

S_PROMPT_NEXT = TITLE + "*202/201 · shade 2 - Dark Brown*\n\nSend the garment picture for this shade.\n\n📎 For full quality send it as a *File* (📎 → File), not as a photo — Telegram compresses photos."
S_PROC = TITLE + "⏳ Processing *202/201 · #1* — stamping at full resolution…"
B_PROC = [["❌ Cancel"]]

C_PREV_OK = "🎨 *202/201 · #1 White*\n📐 4000×6000 · 8.2 MB\n✅ full quality (sent as file)"
C_PREV_BAD = "🎨 *202/201 · #1 White*\n📐 1280×960 · 187 KB\n⚠️ sent as photo — Telegram compressed it. Send as *File* for full quality."
B_PREV = [["✅ Use it", "🔁 Retake"], ["⏭ Skip this shade"]]

C_KEPT = "📎 202/201 · #1 — full-quality copy kept (4000×6000)"
B_FROZEN = [["✅ 1 - White"]]

S_SHADES_2 = TITLE + "*202/201*\nTap a shade to add its garment picture.\n_(✓ = has a photo · 🆕 = added now, waiting for ✅ Done)_"
B_SHADES_2 = [["🆕 1 - White"], ["2 - Dark Brown"], ["3 - Navy Blue"], ["4 - Royal Blue"], ["5 - Taupe Grey"],
              ["📷 Add next missing"], ["✅ Done — send 1 for approval"], ["⬅ Designs"], ["❌ Cancel"]]

S_ALLDONE = TITLE + "*202/201*\nEvery shade has a picture. Tap *✅ Done* to send 5 for approval.\nTap a shade to add its garment picture.\n_(✓ = has a photo · 🆕 = added now, waiting for ✅ Done)_"
B_ALLDONE = [["🆕 1 - White"], ["🆕 2 - Dark Brown"], ["🆕 3 - Navy Blue"], ["🆕 4 - Royal Blue"], ["🆕 5 - Taupe Grey"],
             ["✅ Done — send 5 for approval"], ["⬅ Designs"], ["❌ Cancel"]]

S_SENT = "✅ *Sent for approval*\n\n202/201 — 5 shade photo(s): 1 White, 2 Dark Brown, 3 Navy Blue, 4 Royal Blue, 5 Taupe Grey\nRequest: `a3f19c62-9b42-4c8d-8a11-6e5d2f0c7b93`\n\n⏳ Waiting for an admin. They go live the moment it is approved."
B_SENT = [["🏠 Back to menu"]]

S_APPROVED = "✅ Your request R-A3F1 has been approved by admin. Changes applied."

# admin side
S_ADMIN = "🔔 *Approval required*\n\nRef: `a3f19c62-9b42-4c8d-8a11-6e5d2f0c7b93`\nFrom: Abdul\n\nShade photos: 202/201 — 5 shade(s): 1 White, 2 Dark Brown, 3 Navy Blue, 4 Royal Blue, 5 Taupe Grey\n\n_Shade photos must be approved before they appear to customers, marketers and sales._\n\nUse buttons below to approve or reject."
B_ADMIN = [["✅ Approve", "❌ Reject"]]
C_ADMIN_PREV = "🎨 *202/201* · #1 White — first of 5"

# payoff
C_ORDERS = "📷 *202/201* — *IDUMOTA*"
B_ORDERS = [["1 - White (7B / 13B)"], ["3 - Navy Blue (4B / 9B)"], ["2 - Dark Brown (4B / 9B)"],
            ["5 - Taupe Grey (4B / 9B)"], ["4 - Royal Blue (3B / 8B)"], ["✅ Take ALL 5 shades (22 bales)"], ["⬅️ Back to designs"]]
C_ORDERS_2 = "📦 *202/201* │ Shade: *1 - White* │ 🏭 *IDUMOTA*\n7 bales available\n\nHow many bales to supply?"
B_ORDERS_2 = [["1", "2", "3", "4", "5"], ["6", "All (7)"], ["✏️ Custom Quantity"], ["🔍 Full-quality picture"], ["⬅️ Back to shades"]]

PIC_SWATCH = '<div class="mockswatch"><span>the shade book page</span><div class="tabs"><i>①</i><i>②</i><i>③</i><i>④</i><i>⑤</i></div></div>'
PIC_GARMENT = '<div class="mockgarment"><span>the garment picture you sent</span><div class="stamp">202/201 · #1</div></div>'

# ── troubles ─────────────────────────────────────────────────────────────
TROUBLE = [
 ("⚠️ Send an image file (JPG, PNG or WEBP).",
  "You attached something that is not a picture — a PDF or a Word file.",
  "Send the picture itself: 📎 → File → the picture."),
 ("(the preview's buttons change to 🔁 replaced)",
  "You sent a picture while a preview was still on screen. The bot took it as a REPLACEMENT for that same colour — the first picture is gone.",
  "Only send a picture when the bot asks. Tap ✅ Use it first."),
 ("⚠️ Could not download that picture (…). Telegram lets a bot fetch files up to 20 MB — send it again, or a smaller file.",
  "The network dropped, or the file is bigger than 20 MB (the most the bot can fetch).",
  "Send the same picture again. If it keeps failing, ask for a smaller export."),
 ("⚠️ Could not process that picture: Image is 12000×12000 (144.0 MP) — above the 40 MP limit. Export a smaller copy and send that.",
  "The picture has too many pixels for the bot to open.",
  "Export a smaller copy (about 4000 across is plenty) and send that."),
 ("⏳ One picture at a time — the previous one is still being processed.",
  "A second picture arrived before the first had finished. The bot did NOT keep it.",
  "Wait for the preview, decide on it, then send that picture again."),
 ("ℹ️ That picture is no longer the one being decided — use the buttons on the latest preview.",
  "You scrolled up and tapped an old preview's buttons.",
  "Scroll down to the newest preview and use its buttons."),
 ("⏳ The Shade Photos session expired — open 🎨 Shade Photos again.",
  "Either you did nothing for 30 minutes, or the job is already finished — after ✅ Done and after ❌ Cancel the old cards stop working.",
  "Open 🎨 Shade Photos again. Anything already sent with ✅ Done is safe."),
 ("(the bot replies about receipts, or does nothing)",
  "You sent a picture when the bot was not asking for one.",
  "Open 🎨 Shade Photos, tap the colour first, then send."),
 ("(your design number is not in the list)",
  "That design has no shade-book photo in the bot yet. Shade photos hang on it.",
  "Ask the admin to upload it first: 📷 Upload Product Photo."),
 ("🎨 Shade Photos — 202/201 has no shade tabs recorded. Add the shade names in 🖼️ Manage Product Photos first, then come back.",
  "The design's colour names were never entered.",
  "Ask the admin to add the shade names first."),
 ("⚠️ Could not save the shade photos: … / ⚠️ Could not queue the approval: …",
  "The bot could not reach Google Sheets or Drive when you tapped ✅ Done.",
  "Tap 🔁 Try again. If it keeps failing, tell the admin — nothing was sent."),
]

# ── page assembly ────────────────────────────────────────────────────────
P = []

# PAGE 1 — cover
P.append(f"""
<section class="page cover">
  <div class="brand">AtFactoryPrice · Operator Guide</div>
  <h1>🎨 Shade Photos</h1>
  <div class="sub">How to send the garment picture for every shade</div>
  <div class="for">For: <b>Abdul</b> &nbsp;·&nbsp; Telegram: <b>Black Panther_Bot</b> &nbsp;·&nbsp; About 1 minute per colour</div>

  <div class="golden">
    <div class="gtitle">THE ONE RULE</div>
    <div class="gbody">Send every picture as a <b>FILE</b>, not as a photo.<br>
    <span class="gsteps">📎 &nbsp;→&nbsp; <b>File</b> &nbsp;→&nbsp; pick the picture &nbsp;→&nbsp; Send</span></div>
    <div class="gwhy">If you send it the normal way (as a photo), Telegram makes it small and blurry before the bot ever sees it.
    Whoever is choosing the colour then sees a poor picture. As a <b>File</b>, the picture stays exactly as it was taken.</div>
  </div>

  <div class="two">
    <div class="box">
      <div class="btitle">What you are doing</div>
      <p>Every design has a shade book — the page with the numbered colour tabs.
      For <b>each</b> colour tab you send <b>one picture of the finished garment</b> sewn in that colour.</p>
      <p>After the admin approves, anyone who taps that colour in the bot sees your picture instead of the shade book.</p>
    </div>
    <div class="box">
      <div class="btitle">Before you start</div>
      <ul>
        <li>The <b>design number</b> (example: 202/201)</li>
        <li><b>One picture per colour</b>, already on your phone</li>
        <li>Know which picture is which colour number</li>
      </ul>
      <p class="small"><b>Finish one design in one sitting.</b> The 🆕 pictures are only held in the bot's memory until you tap <b>✅ Done</b> — if you leave it 30 minutes, or tap ❌ Cancel, they are gone and you start that design again.</p>
    </div>
  </div>

  <div class="map">
    <div class="mtitle">The whole job in 7 steps</div>
    <div class="mrow">
      <div class="mstep"><b>1</b> Open the tile</div><div class="marr">→</div>
      <div class="mstep"><b>2</b> Pick design</div><div class="marr">→</div>
      <div class="mstep"><b>3</b> Pick colour</div><div class="marr">→</div>
      <div class="mstep"><b>4</b> Send as File</div><div class="marr">→</div>
      <div class="mstep"><b>5</b> ✅ Use it</div><div class="marr">→</div>
      <div class="mstep"><b>6</b> Repeat</div><div class="marr">→</div>
      <div class="mstep last"><b>7</b> ✅ Done</div>
    </div>
  </div>
  <div class="foot">Every screen in this guide is exactly what the bot shows. Guide version 02-Sep-2026.</div>
</section>""")

# PAGE 2 — steps 1-2
P.append(f"""
<section class="page">
  <div class="ph">Step 1 – 2 &nbsp;·&nbsp; Open the tile and pick the design</div>
  {step(1, "Open 🎨 Shade Photos",
        "Say <b>Hi</b> to the bot. First look for <b>🎨 Shade Photos</b> right on that first screen — if it is the only design job you are allowed, the bot puts it there.<br>Otherwise tap through:"
        "<div class='path'><span>🛒 Sales &amp; Marketing</span><span>→</span><span>🎨 Designs</span><span>→</span><span>🎨 Shade Photos</span></div>",
        card(S_DESIGNS, B_DESIGNS),
        tip="A design with a <b>✓</b> already has some shade pictures — you can still add the missing colours.<br>The list shows <b>24 designs at a time</b>. If yours is not on the screen, use the arrow row underneath (<b>⬅ &nbsp; 1/2 &nbsp; ➡</b>).",
        warn="<b>No 🛒 Sales &amp; Marketing button?</b> Look under <b>📋 More Options</b> — the menu only shows what your department is allowed.<br><b>Still no 🎨 Shade Photos?</b> Tell the admin to add <b>shade_photos</b> to your department. You cannot fix that from the phone.")}
  {step(2, "Tap the design number",
        "Tap the design you are working on — here <b>202/201</b>.<br>The bot goes straight to the colour list.",
        card(S_SHADES, B_SHADES),
        tip="If the design has photos for <b>more than one container</b>, the bot asks which one first. The buttons read <b>📦</b> with the container name. Pick the container you were told. <b>🌐 Generic (all containers)</b> appears only if some photos were filed without a container — if you are unsure, ask the admin rather than guessing.")}
</section>""")

# PAGE 3 — steps 3-4
P.append(f"""
<section class="page">
  <div class="ph">Step 3 – 4 &nbsp;·&nbsp; Pick the colour and send the picture</div>
  {step(3, "Tap a colour",
        "Tap the colour you have a picture for — here <b>1 - White</b>.<br>Or tap <b>📷 Add next missing</b> and the bot chooses the next colour with no picture for you.",
        card(S_PROMPT, B_PROMPT),
        tip="If that colour already has a picture, the card says so — your new one replaces it after approval.")}
  {step(4, "Send it as a FILE",
        "In Telegram: tap <b>📎</b> (paperclip) → <b>File</b> → choose the picture → Send."
        "<div class='path'><span>📎</span><span>→</span><span>File</span><span>→</span><span>picture</span><span>→</span><span>Send</span></div>"
        "The bot shows this while it works. On a big picture or a slow line it can take a minute — <b>wait</b>, do not send it again:",
        card(S_PROC, B_PROC),
        warn="Do <b>not</b> use the Gallery / Photo button. That is the compressed way.<br>Send <b>one picture at a time</b> — and only when the bot asks for one.")}
</section>""")

# PAGE 4 — step 5
P.append(f"""
<section class="page">
  <div class="ph">Step 5 &nbsp;·&nbsp; Check the preview — this is where quality is won or lost</div>
  <p class="lead">The bot sends the picture back with the design and colour number stamped on it.
  <b>Read the third line.</b> It tells you whether the quality was kept.</p>

  <div class="compare">
    <div class="col good">
      <div class="chead">✅ CORRECT — keep it</div>
      {card(C_PREV_OK, B_PREV, kind="photo", photo=PIC_GARMENT)}
      <div class="cnote">The third line says <b>full quality (sent as file)</b>, and the size is big (MB).<br>
      Tap <b>✅ Use it</b>.</div>
    </div>
    <div class="col bad">
      <div class="chead">⚠️ WRONG — send again</div>
      {card(C_PREV_BAD, B_PREV, kind="photo", photo=PIC_GARMENT)}
      <div class="cnote">The third line warns you, and the size is small (KB).<br>
      Tap <b>🔁 Retake</b> and send the same picture again — this time with <b>📎 → File</b>.</div>
    </div>
  </div>

  <div class="warnwide">⛔ <b>Never send the next picture while a preview is still on the screen.</b>
  The bot treats it as a replacement for <i>the same colour</i> — the picture you were looking at is thrown away, and the new one is filed under the old colour.
  Always tap <b>✅ Use it</b> (or <b>🔁 Retake</b>) first, and wait for the bot to ask for the next colour.</div>

</section>

<section class="page">
  <div class="ph">Step 5b &nbsp;·&nbsp; After you tap ✅ Use it — and where the next question appears</div>
  <div class="afterbox">
    <div class="atext">
      <div class="btitle">Three things happen</div>
      <p><b>1.</b> The preview's three buttons collapse into <b>one grey label</b> recording what you did — <b>✅ 1 - White</b> (kept), <b>🔁 replaced</b>, <b>⏭ skipped</b> or <b>⬅ back</b>. It is a label, not a button: tapping it does nothing. Always work on the <i>newest</i> preview.</p>
      <p><b>2.</b> The bot sends the picture back once more as a file. That is the bot <b>keeping the full-quality copy</b> — you do not need to do anything with it. Leave it in the chat.</p>
      <p><b>3. Now scroll UP.</b> The bot does not send a new question — it changes the same <b>🎨 Shade Photos</b> card you have been using all along, and that card is now <b>above</b> your two pictures. It is already asking for the next colour. Do not send anything until you can see it asking.</p>
      <p>That card asks for the next colour that has no picture. Keep going: <b>send → ✅ Use it → scroll up → send</b>.</p>
    </div>
    <div class="acard">{card(C_KEPT, kind="document", photo="202_201_shade_1.jpg")}
    {card(C_PREV_OK, B_FROZEN, kind="photo", photo=PIC_GARMENT)}
    <div class="cardnote">The preview you decided on, now closed: one grey label, not a button.</div></div>
  </div>
  <div class="warnwide">🔎 <b>The question moves up, not down.</b> The bot never sends a new question — it rewrites the one
  <b>🎨 Shade Photos</b> card you started with. Every picture you send pushes that card further up the chat.
  After each <b>✅ Use it</b>, scroll <b>up</b> past your pictures to find it. It is already asking for the next colour.</div>
</section>""")

# PAGE 5 — steps 6-7
P.append(f"""
<section class="page">
  <div class="ph">Step 6 – 7 &nbsp;·&nbsp; Repeat for every colour, then send for approval</div>
  {step(6, "The bot opens the next colour by itself",
        "After <b>✅ Use it</b> the bot does <b>not</b> go back to the list. It asks for the next colour that has no picture — straight away:<br><br>"
        "Send that picture the same way (<b>📎 → File</b>) → <b>✅ Use it</b> → the next colour. Keep going.<br><br>"
        "No picture for a colour today? Tap <b>⏭ Skip this shade</b> and the bot moves on.",
        card(S_PROMPT_NEXT, B_PROMPT),
        tip="The colour list only comes back when <b>every</b> colour has a picture or was skipped — that is when <b>✅ Done</b> appears.")}
  {step(7, "Tap ✅ Done",
        "When the colours you have are all <b>🆕</b>, tap <b>✅ Done — send N for approval</b>.<br>"
        "All of them go to the admin as <b>one</b> request.",
        card(S_ALLDONE, B_ALLDONE),
        warn="Tap <b>✅ Done</b> once. Tapping again cannot send it twice.<br>If a second tap answers <i>“The Shade Photos session expired”</i>, ignore it — your pictures were already sent. Look above for the green <b>✅ Sent for approval</b>.")}
</section>""")

# PAGE 6 — after
P.append(f"""
<section class="page">
  <div class="ph">After you tap Done &nbsp;·&nbsp; What happens next</div>
  <div class="grid3">
    <div>
      <div class="gtitle2">1. You get the confirmation</div>
      {card(S_SENT, B_SENT)}
      <div class="cnote">Your job is finished here. The card above it still says <b>⏳ Sending for approval…</b> and never changes — ignore it; this green one is the real answer.<br><br>If you need to ask about it later, quote the <b>first four letters</b> of the request — the admin knows it as <b>R-A3F1</b>.</div>
    </div>
    <div>
      <div class="gtitle2">2. An admin sees your pictures</div>
      {card(C_ADMIN_PREV, kind="photo", photo=PIC_GARMENT)}
      {card(S_ADMIN, B_ADMIN)}
      <div class="cnote">The admin sees the first picture and the list of colours, then approves. You cannot approve your own.</div>
    </div>
    <div>
      <div class="gtitle2">3. The bot tells you</div>
      {card(S_APPROVED)}
      <div class="cnote">When this arrives, your pictures are <b>live</b> for the people selling: sales and marketers.<br><br>
      If it says <b>❌ rejected</b>, ask the admin what was wrong and send a better picture the same way.</div>
    </div>
  </div>
  <div class="notebox"><b>How long?</b> It is live the moment an admin taps ✅ Approve. If nobody has approved by the end of the day, tell the admin — the request is waiting, nothing is lost.</div>
</section>""")

# PAGE 7 — payoff
P.append(f"""
<section class="page">
  <div class="ph">Why it matters &nbsp;·&nbsp; What your picture does in the shop</div>
  <p class="lead">This is what a salesperson or a marketer sees once your picture is approved.
  <b>The same message changes its picture</b> — your garment appears where the shade book was.</p>
  <div class="compare">
    <div class="col">
      <div class="chead plain">Before the tap — the shade book</div>
      {card(C_ORDERS, B_ORDERS, kind="photo", photo=PIC_SWATCH)}
      <div class="cnote">They tap the colour they want, e.g. <b>1 - White</b>.</div>
    </div>
    <div class="col">
      <div class="chead plain">After the tap — <b>your picture</b></div>
      {card(C_ORDERS_2, B_ORDERS_2, kind="photo", photo=PIC_GARMENT)}
      <div class="cnote">Your garment picture, with the order buttons under it. <b>🔍 Full-quality picture</b> sends it at full size with the design and colour stamped on it — nothing squeezed. That is why step 4 matters.</div>
    </div>
  </div>
  <div class="notebox">A blurry picture here is a lost sale. A sharp one sells the colour. That is the whole reason for <b>📎 → File</b>.</div>
</section>""")

# PAGE 8 — troubles + quick card
def trows(items):
    return "".join(f'<tr><td class="msg">{md(m)}</td><td>{w}</td><td class="do">{d}</td></tr>' for m, w, d in items)

HEAD = '<thead><tr><th>The bot says</th><th>What it means</th><th>What you do</th></tr></thead>'
P.append(f"""
<section class="page">
  <div class="ph">If something goes wrong &nbsp;·&nbsp; 1 of 2 — while you are sending pictures</div>
  <p class="lead">Nothing here can delete or change stock — the worst that happens is a picture is rejected and you send a better one.</p>
  <table class="tbl">{HEAD}<tbody>{trows(TROUBLE[:6])}</tbody></table>
</section>

<section class="page">
  <div class="ph">If something goes wrong &nbsp;·&nbsp; 2 of 2 — before you start, and at the end</div>
  <table class="tbl">{HEAD}<tbody>{trows(TROUBLE[6:])}</tbody></table>
  <div class="notebox"><b>Golden habit:</b> after every picture, read the third line of the preview. If it does not say
  <b>✅ full quality (sent as file)</b>, tap <b>🔁 Retake</b> and send it again with <b>📎 → File</b>. Everything else on this page is rare.</div>
</section>

<section class="page">
  <div class="ph">Quick card &nbsp;·&nbsp; cut this out and keep it by the phone</div>
  <div class="qr">
    <div class="qrtitle">✂ 🎨 Shade Photos — the whole job on one card</div>
    <div class="qgold">Send every picture as a <b>FILE</b>: &nbsp;📎 → <b>File</b> → picture → Send</div>
    <div class="qrgrid">
      <div class="qbox"><b>Menu path</b><br>🛒 Sales &amp; Marketing → 🎨 Designs → 🎨 Shade Photos</div>
      <div class="qbox"><b>Send a picture</b><br>📎 → <b>File</b> → picture → Send</div>
      <div class="qbox"><b>Preview must say</b><br>✅ full quality (sent as file)</div>
      <div class="qbox"><b>Buttons</b><br>✅ Use it = keep · 🔁 Retake = send again<br>⏭ Skip = no picture today</div>
      <div class="qbox"><b>Marks</b><br>✓ = already has a picture<br>🆕 = added now, not sent yet</div>
      <div class="qbox"><b>Last step</b><br>✅ Done — send N for approval<br>(tap once, then wait)</div>
      <div class="qbox"><b>The loop</b><br>tap colour → send File → ✅ Use it<br>→ the bot opens the next colour</div>
      <div class="qbox"><b>Never</b><br>send a picture while a preview<br>is on screen — it replaces it</div>
      <div class="qbox"><b>Finish in one sitting</b><br>🆕 pictures are lost after<br>30 minutes idle or ❌ Cancel</div>
    </div>
    <div class="qfoot">Cannot see the tile? Ask the admin to add <b>shade_photos</b> to your department.
    &nbsp;·&nbsp; Something wrong? See “If something goes wrong” on the page before.</div>
  </div>
  <div class="foot">AtFactoryPrice · 🎨 Shade Photos · guide version 02-Sep-2026</div>
</section>""")

CSS = """
@page { size: A4; margin: 12mm 11mm; }
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

OUT.write_text(f"<!doctype html><html><head><meta charset='utf-8'><title>Shade Photos — Abdul's guide</title><style>{CSS}</style></head><body>{''.join(P)}</body></html>", encoding="utf-8")
print("wrote", OUT)
