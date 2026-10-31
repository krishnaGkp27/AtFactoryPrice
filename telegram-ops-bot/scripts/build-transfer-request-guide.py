#!/usr/bin/env python3
"""TRF — build the office worker's step-by-step guide to raising a transfer
request with bale numbers (docs/TRF_TRANSFER_REQUEST_GUIDE.pdf).

Usage (regenerate after any wording change in the flow):
    python3 scripts/build-transfer-request-guide.py
    chromium --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
      --print-to-pdf=docs/TRF_TRANSFER_REQUEST_GUIDE.pdf docs/TRF_TRANSFER_REQUEST_GUIDE.html

Every card body / button below is copied from the shipped code
(src/flows/transferFlow.js as of 31-Oct-2026 — TRF-8b typed preload, TRF-23
local read of the typed line (no AI), TRF-14
pinned numbers, TRF-19 waiting lines, TRF-20 one load, TRF-21/22 receipt),
with Telegram Markdown resolved the way the phone shows it. The prose is
written for office staff in plain words (owner, 31-Oct-2026: "shorten the
PDF removing unnecessary technical words") — the cards stay verbatim.
Worked example: 3 bales of 9006 · Shade 3 from Lagos to Kano office,
bale numbers 869, 843 and 874; Abdul sends, Musa receives.
"""
import html, pathlib

OUT = pathlib.Path(__file__).resolve().parents[1] / "docs" / "TRF_TRANSFER_REQUEST_GUIDE.html"

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

def card(body, buttons=(), time="10:42", note=None, me=False):
    p = ['<div class="tg">']
    p.append('<div class="bubble me">' if me else '<div class="bubble">')
    p.append(f'<div class="txt">{md(body)}</div>')
    p.append(f'<div class="time">{time}</div></div>')
    for row in buttons:
        p.append('<div class="krow">')
        for b in row:
            p.append(f'<div class="kbtn">{html.escape(b)}</div>')
        p.append('</div>')
    p.append('</div>')
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

def path(*bits):
    return '<div class="path">' + ' <span class="arr">›</span> '.join(f'<span>{html.escape(b)}</span>' for b in bits) + '</div>'

NAV = ["⬅ Back", "❌ Cancel"]
C_TYPED = card("Transfer 869, 843, 874 to Kano office", me=True, time="10:41") + '<div class="also">also fine: <code>Move 869 843 874 to Kano</code> · <code>Transfer package 5801 to Kano</code> · <code>Transfer packages 5801, 5802, 5803 to Kano</code></div>'
C_CONFIRM = card("🚚 *Confirm transfer* — 3 bale(s)\n\n  🧵 9006 · Shade 3 · ×3 bls (869, 843, 874)\n\n*Lagos* → *Kano office*\nDispatcher: *Abdul*\nReceiver: *Musa*\n\n_This sends an ORDER — Abdul logs the actual bales when dispatching; nothing is locked until then._", [["✅ Send"], NAV])
C_W1 = card("🚚 *Transfer Stock*\n\nFrom which warehouse?", [["📦 Lagos", "📦 IDUMOTA"], ["📦 Kano office"], ["❌ Cancel"], ["🏠 Back to menu"]])
C_W2 = card("🚚 *Transfer from Lagos*\n\nPick a design:", [["9006 · Cashmere (12 bls)", "44200 (39 bls)"], ["202/201 (6 bls)", "9043-B (8 bls)"], NAV]) + card("🚚 *9006* — pick a shade:", [["3 (7 bls)", "5 (5 bls)"], NAV], time="10:43")
C_W3 = card("🚚 *9006 · 3*\n7 bale(s) available in Lagos.\n\nHow many bales to transfer?", [["1", "2", "5"], ["All 7"], NAV])
C_W4 = card("🚚 *Lagos* → to which warehouse?", [["🏭 Kano office", "🏭 IDUMOTA"], NAV])
C_SENT = card("✅ *Transfer 31Oct·01 sent*\n*Lagos* → *Kano office* · 3 bale(s)\n  🧵 9006 · Shade 3 · ×3 bls (869, 843, 874)\n\n⏳ Waiting for *Abdul* to dispatch.", [["🏠 Back to menu"]])
C_DISP = card("🚚 *Transfer 31Oct·01 — please dispatch*\n*Lagos* → *Kano office* · 3 bale(s)\n  🧵 9006 · Shade 3 · ×3 bls (869, 843, 874)\nReceiver: Musa\n\n_Accepting logs the actual bales you send. A load photo/PDF is required to complete the dispatch._", [["✅ Accept & dispatch", "❌ Decline"]])
C_LIST = card("📋 *Transfers*\n\n31Oct·01 · 🔴 LAG▸KAN · 3B\n⏳ Waiting on Abdul to dispatch · raised by you · 2h waiting\n\n18Sep·02 · 🟡 LAG▸KAN · 6/10B\n🚚 Waiting on Musa to confirm the rest · 6 of 10 received", [["31Oct·01 · 🔴 LAG▸KAN · 3B"], ["18Sep·02 · 🟡 LAG▸KAN · 6/10B"], ["🏠 Menu"]])
P = []

# ── page 1: cover + the map ─────────────────────────────────────────────
P.append(f"""
<div class="page">
<div class="brand">AtFactoryPrice · Black Panther bot · office guide</div>
<h1>🚚 Sending bales to another store</h1>
<div class="sub">How to raise a transfer request in the bot, with the bale numbers you want sent.</div>
<div class="for">For office staff. Anyone with bot access can raise one. Example used throughout: 3 bales of 9006 · Shade 3 from Lagos to Kano office, numbers 869, 843 and 874. Abdul sends, Musa receives.</div>

<div class="golden">
  <div class="gtitle">THE ONE RULE</div>
  <div class="gbody">You type the bale numbers. The bot never chooses bales for you.</div>
  <div class="gwhy">Your numbers are shown to Abdul as <b>📌 Ordered</b> when he packs the load. If one of your bales is gone, the card tells you, and a person decides what replaces it.</div>
</div>

<div class="two">
  <div class="box"><div class="btitle">Two ways to do it</div>
    <p><b>A · Type one line</b> — <code>Transfer 869, 843, 874 to Kano office</code>. Fastest when you have the numbers. Works even if the bot's AI is down.</p>
    <p><b>B · Tap through</b> — 🔁 Move Stock → 🚚 Transfer Stock → store → design → shade → how many → where to.</p>
  </div>
  <div class="box"><div class="btitle">Before you start</div>
    <ul>
      <li>Have the bale numbers ready.</li>
      <li>All bales of one request must be in the same store. Two stores = two requests.</li>
      <li>Store names as the bot spells them: Lagos, IDUMOTA, Kano office.</li>
    </ul>
  </div>
</div>

<div class="map"><div class="mtitle">What happens after you send</div>
  <div class="mrow">
    <div class="mstep"><b>🔴</b>Sent<br>by you</div><div class="marr">→</div>
    <div class="mstep"><b>🚚</b>Packed<br>Abdul ticks bales + photo</div><div class="marr">→</div>
    <div class="mstep"><b>🛂</b>Admin<br>checks it</div><div class="marr">→</div>
    <div class="mstep"><b>🟡</b>On the road</div><div class="marr">→</div>
    <div class="mstep"><b>📦</b>Arrived<br>Musa reports + photo</div><div class="marr">→</div>
    <div class="mstep last"><b>🟢</b>Done<br>admin confirms</div>
  </div>
</div>

<div class="step" style="margin-top:5mm">
  <div class="sleft"><div class="btitle" style="font-size:12.5pt">Where is it? Any time</div>
    <div class="slead">🔁 Move Stock → 📋 Transfers lists every open transfer: who it is waiting on and for how long. Tap a row to open it.</div>
    <div class="slead">The request number is the date · number of the day, here <b>31Oct·01</b>. Use it when you ask about a transfer.</div>
  </div>
  <div class="sright">{C_LIST}</div>
</div>
</div>
""")

# ── page 2: way A — typed numbers ────────────────────────────────────────
TYPED_REVIEW = ("🚚 *Transfer Stock — preloaded 3 of 3 typed bale(s)*\nFrom *Lagos*\n\n"
                "  🧵 9006 · Shade 3 · ×3 bls (869, 843, 874)\n📦 Bales: 869, 843, 874\n"
                "\n📍 Destination: *Kano office* (from your message)")
C_REVIEW = card(TYPED_REVIEW, [["➡ Continue"], NAV, ["🏠 Back to menu"]])
P.append(f"""
<div class="page">
<div class="ph">Way A — type the bale numbers</div>
<p class="lead">One message: the word <b>Transfer</b>, the bale numbers, then <b>to</b> and the store.</p>
{step(1, "Type the line",
      "<b>Transfer</b> (or <b>Move</b>) must be the first word. Separate the numbers with commas or spaces. The words <i>package</i> / <i>bale</i> are optional. Up to 50 numbers.",
      C_TYPED,
      tip="Do not type the store the bales are in — the bot knows. If some of the numbers sit in another store, the card lists them with <i>start a separate transfer</i>.")}
{step(2, "Check the card",
      "The bot shows what it found, grouped by design and shade. A bale it could not find is listed with the reason: sold, on the road, in another store, or not on record.",
      C_REVIEW,
      tip="If the bot recognised your store name the button says <b>➡ Continue</b>. Otherwise it says <b>➡ Pick destination</b> and asks where to.")}
{step(3, "Send",
      "Abdul (sends) and Musa (receives) are filled in for you when each store has one person; otherwise you pick from a list. Tap <b>✅ Send</b>.",
      C_CONFIRM,
      warn="Nothing moves yet. The bales stay in the store until Abdul packs the load.")}
</div>
""")

# ── page 3: way B — tap through ──────────────────────────────────────────
P.append(f"""
<div class="page flow">
<div class="ph">Way B — tap through</div>
<p class="lead">Use it when you know the design and shade but not the bale numbers. Abdul picks the bales when he packs.</p>
{path("🏠 Menu", "🔁 Move Stock", "🚚 Transfer Stock")}
{step(1, "Which store are the bales in?",
      "Only stores that hold stock are shown.",
      C_W1)}
{step(2, "Pick the design, then the shade",
      "The number in brackets is how many bales are there.",
      C_W2)}
{step(3, "How many bales?",
      "Tap a number, or <b>All</b>.",
      C_W3)}
{step(4, "Which store receives them?",
      "Then the same ✅ Send card as Way A appears.",
      C_W4,
      tip="Way A is better when you have the numbers: Abdul then sees exactly which bales you want.")}
</div>
""")

# ── page 4: after you send ──────────────────────────────────────────────
P.append(f"""
<div class="page flow">
<div class="ph">After you send</div>
{step(1, "Your copy",
      "Your confirm card becomes this receipt, with the request number <b>31Oct·01</b>.",
      C_SENT)}
{step(2, "Abdul's card",
      "He ticks the bales he actually packs — your numbers shown as 📌 Ordered — and attaches a photo of the load. Without the photo nothing moves.",
      C_DISP)}
<div class="box" style="margin-top:4mm"><div class="btitle">Quick answers</div>
  <ul>
    <li><b>A bale is missing from the card</b> — read the reason next to it. Fix the number, or raise a second request for the other store.</li>
    <li><b>Abdul packed different bales</b> — allowed. What he packs is what moves.</li>
    <li><b>Only some bales arrived</b> — Musa ticks the ones that came. The rest stay on the road until they arrive.</li>
    <li><b>I want to cancel</b> — there is no cancel button after Send. Ask Abdul to tap ❌ Decline.</li>
    <li><b>The bot says "This load is already open"</b> — the same request already exists. Open that one instead of sending again.</li>
    <li><b>The bot says "Need more info"</b> — your line did not start with Transfer / Move, or had no number. Retype it: <b>Transfer 832, 1186, 786 to kano</b>.</li>
  </ul>
</div>
</div>
""")

CSS = """
@page { size: A4; margin: 10mm 11mm; }
* { box-sizing: border-box; }
body { margin:0; font-family:"DejaVu Sans","Segoe UI",Arial,sans-serif; color:#16202a; font-size:10.6pt; line-height:1.38; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
.page.flow { page-break-after: auto; }
h1 { font-size:26pt; margin:2mm 0 1mm; letter-spacing:-.5px; }
.brand { font-size:8.4pt; letter-spacing:2.4px; text-transform:uppercase; color:#7d8b99; font-weight:700; }
.sub { font-size:13pt; color:#3d4b59; margin-bottom:2mm; }
.for { font-size:9.4pt; color:#4a5866; padding:1.6mm 0 0; border-top:1px solid #e2e8ee; }
.ph { margin-top:4mm; font-size:12.6pt; font-weight:700; color:#0e2a47; border-bottom:2.4px solid #0e2a47; padding-bottom:1.4mm; margin-bottom:3.4mm; }
.lead { margin:0 0 3mm; color:#31404e; }
.small { font-size:8.8pt; color:#5d6b79; }
.also { font-size:8.6pt; color:#4a5866; margin-top:1.6mm; }
.also code { background:#eef3f8; border-radius:1mm; padding:0 1mm; font-family:"DejaVu Sans Mono",monospace; font-size:8pt; }
.golden { margin:5mm 0; border:2.4px solid #b8860b; background:#fffaf0; border-radius:4mm; padding:4mm 5mm; }
.gtitle { font-size:9pt; letter-spacing:2.4px; font-weight:800; color:#8a6508; }
.gbody { font-size:16pt; font-weight:700; margin:1.4mm 0 2mm; color:#1d1502; }
.gwhy { font-size:9.6pt; color:#4a4231; }
.two { display:flex; gap:5mm; margin:5mm 0; }
.box { flex:1; border:1px solid #dde4ea; border-radius:3mm; padding:3.4mm 4mm; background:#fbfcfd; }
.btitle { font-weight:700; color:#0e2a47; margin-bottom:1.6mm; }
.box p { margin:0 0 1.8mm; }
.box ul { margin:0 0 1.6mm; padding-left:5mm; }
.box li { margin-bottom:.8mm; }
.map { margin-top:4mm; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 4mm; background:#f4f7fa; }
.mtitle { font-weight:700; color:#0e2a47; margin-bottom:2mm; }
.mrow { display:flex; align-items:center; gap:1.4mm; }
.mstep { flex:1; text-align:center; background:#fff; border:1px solid #cfdae4; border-radius:2mm; padding:2mm .8mm; font-size:8.4pt; }
.mstep b { display:block; font-size:12pt; color:#1d6fa5; }
.mstep.last { background:#e5f4ec; border-color:#8ecfae; }
.marr { color:#93a3b2; font-size:11pt; }
.step { display:flex; gap:5mm; margin-bottom:3.6mm; page-break-inside:avoid; }
.sleft { flex:1.08; }
.sright { flex:1; }
.snum { display:inline-block; width:9mm; height:9mm; line-height:9mm; text-align:center; border-radius:50%; background:#0e2a47; color:#fff; font-weight:800; font-size:13pt; }
.stitle { display:inline-block; font-size:12.5pt; font-weight:700; margin-left:2.4mm; vertical-align:middle; color:#0e2a47; }
.slead { margin-top:2.2mm; color:#31404e; }
.path { margin:2.4mm 0 4mm; display:flex; flex-wrap:wrap; gap:1.4mm; align-items:center; }
.path span { background:#eef3f8; border:1px solid #d3dde7; border-radius:1.6mm; padding:1mm 2.2mm; font-size:9.4pt; font-weight:600; color:#123; }
.path .arr { background:none; border:none; color:#93a3b2; padding:0; }
.tip { margin-top:2.8mm; font-size:10pt; background:#eef6ff; border-left:3px solid #1d6fa5; padding:1.8mm 2.6mm; border-radius:0 2mm 2mm 0; }
.warn { margin-top:2.8mm; font-size:10pt; background:#fff4f4; border-left:3px solid #a3232a; padding:1.8mm 2.6mm; border-radius:0 2mm 2mm 0; }
.tg { background:#0e1621; border-radius:3mm; padding:2.2mm; max-width:80mm; margin-bottom:1.6mm; }
.bubble { background:#182533; border-radius:2.4mm; padding:2.2mm 2.6mm 1.2mm; position:relative; }
.bubble.me { background:#2b5278; }
.txt { color:#e9eef3; font-size:9pt; line-height:1.4; word-wrap:break-word; white-space:normal; }
.txt b { color:#fff; }
.dim, .txt i { color:#8fa3b5; font-style:italic; }
.txt code { background:#0e1621; border-radius:1mm; padding:0 .8mm; font-family:"DejaVu Sans Mono",monospace; font-size:8.2pt; color:#a9c7e4; }
.time { text-align:right; color:#6d8298; font-size:7pt; margin-top:.8mm; }
.krow { display:flex; gap:1.2mm; margin-top:1mm; }
.kbtn { flex:1; background:#22303f; color:#e9eef3; text-align:center; font-size:8.6pt; padding:1.2mm 1mm; border-radius:1.6mm; }
.cardnote { font-size:8.4pt; color:#5d6b79; margin:1mm 0 2mm; }
"""
OUT.write_text(f"<!doctype html><html><head><meta charset='utf-8'><title>Raising a transfer request — office guide</title><style>{CSS}</style></head><body>{''.join(P)}</body></html>", encoding="utf-8")
print("wrote", OUT)
