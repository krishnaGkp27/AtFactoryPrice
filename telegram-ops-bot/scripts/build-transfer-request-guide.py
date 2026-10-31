#!/usr/bin/env python3
"""TRF — build the office worker's step-by-step guide to raising a transfer
request with bale numbers (docs/TRF_TRANSFER_REQUEST_GUIDE.pdf).

Usage (regenerate after any wording change in the flow):
    python3 scripts/build-transfer-request-guide.py
    chromium --headless --disable-gpu --no-sandbox --no-pdf-header-footer \
      --print-to-pdf=docs/TRF_TRANSFER_REQUEST_GUIDE.pdf docs/TRF_TRANSFER_REQUEST_GUIDE.html

Every card body / button below is copied from the shipped code
(src/flows/transferFlow.js as of 31-Oct-2026 — TRF-8b typed preload, TRF-14
pinned numbers, TRF-19 waiting lines, TRF-20 one load, TRF-21/22 receipt),
with Telegram Markdown resolved the way the phone shows it.
Worked example: 3 bales of 9006 · Shade 3 from Lagos to Kano office,
bale numbers 869, 843 and 874; Abdul dispatches, Musa receives.
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
C_TYPED = card("Transfer 869, 843, 874 to Kano office", me=True, time="10:41") + '<div class="also">also: <code>Move bales 869 843 874 to Kano</code> · <code>Transfer package 5801 to Kano</code> · <code>Transfer packages 5801, 5802, 5803 to Kano</code></div>'
C_CONFIRM = card("🚚 *Confirm transfer* — 3 bale(s)\n\n  🧵 9006 · Shade 3 · ×3 bls (869, 843, 874)\n\n*Lagos* → *Kano office*\nDispatcher: *Abdul*\nReceiver: *Musa*\n\n_This sends an ORDER — Abdul logs the actual bales when dispatching; nothing is locked until then._", [["✅ Send"], NAV])
C_W1 = card("🚚 *Transfer Stock*\n\nFrom which warehouse?", [["📦 Lagos", "📦 IDUMOTA"], ["📦 Kano office"], ["❌ Cancel"], ["🏠 Back to menu"]])
C_W2 = card("🚚 *Transfer from Lagos*\n\nPick a design:", [["9006 · Cashmere (12 bls)", "44200 (39 bls)"], ["202/201 (6 bls)", "9043-B (8 bls)"], NAV]) + card("🚚 *9006* — pick a shade:", [["3 (7 bls)", "5 (5 bls)"], NAV], time="10:43")
C_W3 = card("🚚 *9006 · 3*\n7 bale(s) available in Lagos.\n\nHow many bales to transfer?", [["1", "2", "5"], ["All 7"], NAV])
C_W4 = card("🚚 *Lagos* → to which warehouse?", [["🏭 Kano office", "🏭 IDUMOTA"], NAV])
C_SENT = card("✅ *Transfer 31Oct·01 sent*\n*Lagos* → *Kano office* · 3 bale(s)\n  🧵 9006 · Shade 3 · ×3 bls (869, 843, 874)\n\n⏳ Waiting for *Abdul* to dispatch.", [["🏠 Back to menu"]])
C_DISP = card("🚚 *Transfer 31Oct·01 — please dispatch*\n*Lagos* → *Kano office* · 3 bale(s)\n  🧵 9006 · Shade 3 · ×3 bls (869, 843, 874)\nReceiver: Musa\n\n_Accepting logs the actual bales you send. A load photo/PDF is required to complete the dispatch._", [["✅ Accept & dispatch", "❌ Decline"]])
C_LIST = card("📋 *Transfers*\n\n31Oct·01 · 🔴 LAG▸KAN · 3B\n⏳ Waiting on Abdul to dispatch · raised by you · 2h waiting\n\n18Sep·02 · 🟡 LAG▸KAN · 6/10B\n🚚 Waiting on Musa to confirm the rest · 6 of 10 received", [["31Oct·01 · 🔴 LAG▸KAN · 3B"], ["18Sep·02 · 🟡 LAG▸KAN · 6/10B"], ["🏠 Menu"]])
C_TWIN = card("⚠️ *This load is already open — `31Oct·01`*\n*Lagos* → *Kano office* · 3 bale(s)\n  🧵 9006 · Shade 3 · ×3 bls\n⏳ Waiting on Abdul to dispatch · raised by Krishna · 2h waiting\n\n_Sending again would create a second order for the same load. Open the existing one instead._", [["📋 Open 31Oct·01"], ["⬅ Back", "❌ Cancel"]])
P = []

# ── page 1: cover + the map ─────────────────────────────────────────────
P.append(f"""
<div class="page">
<div class="brand">AtFactoryPrice · Black Panther bot · office guide</div>
<h1>🚚 Raising a transfer request</h1>
<div class="sub">Move bales from one store to another — with the bale numbers you want sent.</div>
<div class="for">For office staff · every active user may raise one · the dispatcher at the source logs what actually leaves, the receiver confirms what arrives · an admin approves each stage</div>

<div class="golden">
  <div class="gtitle">THE ONE RULE</div>
  <div class="gbody">You order by bale NUMBER. The bot never picks bales for you.</div>
  <div class="gwhy">Your numbers ride the request as <b>📌 Ordered</b> guidance. The dispatcher ticks the bales that physically leave; if one of yours is gone, the card says so and a person chooses the replacement — never the bot (business rule §2).</div>
</div>

<div class="two">
  <div class="box"><div class="btitle">Three ways to raise it</div>
    <p><b>A · Type the bale numbers</b> — one line in the chat. Fastest when you have the numbers.</p>
    <p><b>B · Tap through</b> — 🔁 Move Stock → 🚚 Transfer Stock. Store → design → shade → how many → where to.</p>
    <p><b>C · Say it in words</b> — "Transfer package 5801 to Kano". The bot reads it and lands you on the same screens as A.</p>
  </div>
  <div class="box"><div class="btitle">Before you start</div>
    <ul>
      <li>Have the printed bale numbers from the packing list.</li>
      <li>All bales of one request must sit in ONE store. Two stores = two requests.</li>
      <li>Know the destination store's name as the bot spells it (Kano office, IDUMOTA, Lagos).</li>
      <li>One request per load: if the same load is already open, the bot shows it instead of making a twin.</li>
    </ul>
  </div>
</div>

<div class="map"><div class="mtitle">What happens after you tap ✅ Send</div>
  <div class="mrow">
    <div class="mstep"><b>🔴</b>Requested<br>you</div><div class="marr">→</div>
    <div class="mstep"><b>🚚</b>Dispatch<br>Abdul ticks bales + load photo</div><div class="marr">→</div>
    <div class="mstep"><b>🛂</b>Admin review<br>approves the package</div><div class="marr">→</div>
    <div class="mstep"><b>🟡</b>In transit<br>on the road</div><div class="marr">→</div>
    <div class="mstep"><b>📦</b>Receipt<br>Musa reports + photo</div><div class="marr">→</div>
    <div class="mstep last"><b>🟢</b>Received<br>admin confirms</div>
  </div>
  <div class="small" style="margin-top:2mm">Track it any time: 🔁 Move Stock → 📋 Transfers. Legend: {html.escape('🔴 requested · 🛂 parked for approval · 🟡 in transit · 🟢 received · ⧉ sent as a duplicate · B bales · T loose thans · 6/10B = received so far')}</div>
</div>
</div>
""")

# ── page 2: method A — typed numbers ────────────────────────────────────
TYPED_REVIEW = ("🚚 *Transfer Stock — preloaded 3 of 3 typed bale(s)*\nFrom *Lagos*\n\n"
                "  🧵 9006 · Shade 3 · ×3 bls (869, 843, 874)\n📦 Bales: 869, 843, 874\n"
                "\n📍 Destination: *Kano office* (from your message)")
C_REVIEW = card(TYPED_REVIEW, [["➡ Continue"], NAV, ["🏠 Back to menu"]])
P.append(f"""
<div class="page">
<div class="ph">Method A — type the bale numbers (fastest)</div>
<p class="lead">One message. Numbers separated by commas or spaces, then <b>to</b> and the destination store. Up to 50 numbers. The bot finds every bale on the shelf, groups them by design and shade, and pins your numbers to the order.</p>
{step(1, "Type the line",
      "Any of these work. The word <b>Transfer</b> (or Move / Send) at the front tells the bot what you mean; the numbers are the bales; everything after the last <b>to</b> is the destination.",
      C_TYPED,
      tip="You do not type the source. The bot reads where the bales sit. If they sit in two stores it loads the first store's bales and lists the others as <i>in IDUMOTA, not Lagos — start a separate transfer</i>.")}
{step(2, "Check the preload card",
      "The bot shows what it loaded, grouped by design and shade, with your numbers pinned. A bale it could not load is listed with the reason (already sold, in transit, in another store, not on record) — it is never swapped for a neighbour.",
      C_REVIEW,
      tip="When the destination in your message matched a store, the button reads <b>➡ Continue</b>. Otherwise it reads <b>➡ Pick destination</b> and the next screen asks where to.")}
{step(3, "Confirm and send",
      "The dispatcher at the source and the receiver at the destination are picked for you when each store has one person; a chip list appears when a store has several.",
      C_CONFIRM,
      warn="Nothing moves on Send. Stock stays sellable at the source until the dispatcher logs the load. Your numbers are an order, not a lock.")}
</div>
""")

# ── page 3: method B — the wizard ────────────────────────────────────────
P.append(f"""
<div class="page flow">
<div class="ph">Method B — tap through the wizard</div>
<p class="lead">Use it when you know the design and shade but not the bale numbers. Five taps. The dispatcher chooses the physical bales when dispatching.</p>
{path("🏠 Menu", "🔁 Move Stock", "🚚 Transfer Stock")}
{step(1, "From which warehouse?",
      "Only stores holding stock are offered.",
      C_W1)}
{step(2, "Pick a design, then a shade",
      "Each chip carries the count on that shelf. The category shows after the design when one is set.",
      C_W2)}
{step(3, "How many bales?",
      "Chips 1 · 2 · 5 · 10 up to what is available, plus <b>All</b>.",
      C_W3)}
{step(4, "To which warehouse?",
      "Then the people are resolved (auto-picked when a store has one), and the same ✅ Send confirm card as Method A appears — without pinned numbers, because none were typed.",
      C_W4,
      tip="Prefer Method A when you hold the packing list: typed numbers are pinned and shown to the dispatcher as <b>📌 Ordered: 869, 843, 874</b>; the wizard cannot pin numbers.")}
</div>
""")

# ── page 4: after send + the guards ───────────────────────────────────────
P.append(f"""
<div class="page flow">
<div class="ph">After ✅ Send — what you see, what the others see</div>
{step(1, "Your receipt",
      "The confirm card becomes the receipt, with the reference you quote from now on (date · number of the day).",
      C_SENT)}
{step(2, "The dispatcher's card (Abdul)",
      "He taps Accept, ticks the bales that physically leave — your numbers shown as 📌 Ordered — then must attach the load photo or PDF. Without the file nothing moves.",
      C_DISP)}
{step(3, "Where is it? 📋 Transfers",
      "🔁 Move Stock → 📋 Transfers lists every open transfer as one row: date·number, the dot, the route, the quantity, who holds it and for how long. Tap a row to open its card.",
      C_LIST,
      tip="If a transfer waits on its holder for more than 3 days every admin is told too; the holder's own card is re-sent every reminder round.")}
{step(4, "The twin guard",
      "If the same load (same route, same designs, shades and quantities) is already open, Send does not create a second one. You get the existing reference instead; only an admin may <b>Send anyway</b>, and that copy is marked ⧉.",
      C_TWIN,
      warn="Tapping Send twice on a slow network sends ONE request: the bot recognises its own repeat and shows <i>was already sent</i>.")}
<div class="box" style="margin-top:4mm"><div class="btitle">Quick answers</div>
  <ul>
    <li><b>A bale I typed is not on the card</b> — read its reason line: sold, in transit, in another store, or not on record. Fix the number or start a separate transfer for the other store.</li>
    <li><b>The dispatcher sent different bales</b> — allowed. Physical truth wins; the confirm screen told him in words which ordered number he replaced.</li>
    <li><b>Only some bales arrived</b> — the receiver ticks the ones that came (📦 Only some arrived); the rest stay on the road and the row reads 6/10B until the last bale.</li>
    <li><b>I want to cancel</b> — there is no cancel after Send. The dispatcher taps ❌ Decline, which returns the bales to the source.</li>
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
h1 { font-size:32pt; margin:2mm 0 1mm; letter-spacing:-.5px; }
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
