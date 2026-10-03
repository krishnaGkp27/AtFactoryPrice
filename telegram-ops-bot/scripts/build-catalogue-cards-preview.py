#!/usr/bin/env python3
"""CAT-T1 — render the proposed catalogue-tracker cards as Telegram bubbles (docs/CAT-T1_CARDS_PREVIEW.pdf). Print with headless Chromium as the other guide builders do."""
import html, pathlib, sys
OUT = pathlib.Path(__file__).resolve().parents[1] / 'docs' / 'CAT-T1_CARDS_PREVIEW.html'

def md(t):
    t = html.escape(t); out, i, n = [], 0, len(t)
    while i < n:
        c = t[i]
        if c in '*_`':
            j = t.find(c, i + 1)
            if j > i:
                tag = {'*': 'b', '_': 'i', '`': 'code'}[c]
                out.append(f'<{tag}>{t[i+1:j]}</{tag}>'); i = j + 1; continue
        out.append(c); i += 1
    return ''.join(out).replace('\n', '<br>')

def card(title, body, buttons=(), note=''):
    p = [f'<div class="slot"><div class="ttl">{html.escape(title)}</div><div class="tg"><div class="bubble"><div class="txt">{md(body)}</div><div class="time">11:07</div></div>']
    for row in buttons:
        p.append('<div class="krow">' + ''.join(f'<div class="kbtn">{html.escape(b)}</div>' for b in row) + '</div>')
    p.append('</div>')
    if note: p.append(f'<div class="note">{note}</div>')
    p.append('</div>')
    return ''.join(p)

C = []
C.append(card('1 · The design step you use today — one new chip row on top',
 "🎨 *Stock by shade — Lagos*\nPick the design (available · sold bales):",
 [["📘📗 Catalogues — Lagos · 📘 48/60 · 📗 112/150"], ["🧵 9006 (12 · 5)", "🧵 9032 (7 · 9)"], ["🧵 9037-D (4 · 2)", "🧵 77019 (0 · 11)"], ["◀ Prev", "1/3", "Next ▶"], ["⬅ Warehouses", "❌ Close"]],
 'The same chip sits on 📦 Supply Details → container → design list. Figures are in office / received for the whole warehouse. Everything else on this screen is unchanged.'))
C.append(card('2 · Catalogues at this warehouse (tap the chip)',
 "📘📗 *Catalogues — Lagos* · 🚢 Mar26\nReceived 📘 60 · 📗 150 — in office 📘 48 · 📗 112 — out 📘 12 · 📗 38\n\nPick the design (📘 in office/received · 📗 in office/received):",
 [["🧵 9006 · 📘 9/12 · 📗 22/30", "🧵 9032 · 📘 12/12 · 📗 30/40"], ["🧵 9037-D · 📘 3/6 · 📗 10/20", "🧵 77019 · 📘 8/10 · 📗 20/30"], ["📥 Received", "➕ Give out"], ["👤 By customer", "🧑‍💼 By marketer", "🆕 By prospect"], ["⬅ Designs", "❌ Close"]],
 '📥 Received and ➕ Give out appear only for the storekeeper of this warehouse, the office manager and admins (Users sheet column I + the manages relation).'))
C.append(card('3 · One design — where every catalogue is right now',
 "📘📗 *9006 — Lagos* · 🚢 Mar26\nReceived 📘 12 · 📗 30\nIn office 📘 9 · 📗 22\nOut 📘 3 · 📗 8\n\n👤 *Customers* — 📘 1 · 📗 2\n • ABBA — 📘 1 (Shade 3) · since 12-Sep-2026\n • Ayubal Ansari — 📗 2 · since 01-Oct-2026\n🧑‍💼 *Marketers* — 📘 2 · 📗 2\n • Musa (Kano) — 📘 2 · 📗 2 (Shade 3) · 13d out\n🆕 *Prospects* — 📗 4\n • Hajiya Bilki · 0803 123 4567 — 📗 4 (Shade 5) · since 28-Sep-2026",
 [["👤 ABBA", "👤 Ayubal Ansari"], ["🧑‍💼 Musa", "🆕 Hajiya Bilki"], ["➕ Give out", "↩ Returned"], ["⬅ Catalogues", "❌ Close"]],
 'Computed live: received (Inventory column X) minus active hand-outs (CatalogLedger). A shade in brackets only when the hand-out named one; "Shade —" never printed.'))
C.append(card('4 · One holder (tap a name)',
 "👤 *ABBA* — catalogues held · Lagos\n📞 0802 555 1234\n\n • 9006 📘 1 (Shade 3) · since 12-Sep-2026 · given by Abdul · ✅ Krishna\n • 9032 📗 2 · since 20-Sep-2026 · given by Abdul · ✅ Krishna\n\n*Total: 📘 1 · 📗 2*",
 [["↩ Mark returned"], ["⬅ 9006", "❌ Close"]],
 'Same card for a marketer (adds area + days out) and a prospect (name + phone typed at hand-out). ↩ Mark returned ticks the lines that came back.'))
C.append(card('5 · ➕ Give out — the entry (storekeeper or office manager)',
 "➕ *Give out — 9006 · Lagos*\n📗 Small · ×2 · Shade 3\n\nWho takes it?",
 [["👤 Customer", "🧑‍💼 Marketer"], ["🆕 Prospect (type name + phone)"], ["⬅ Back", "❌ Cancel"]],
 'Steps: size → quantity → shade (the design\'s shades + Whole design) → recipient. Customer and marketer are picked from the existing lists; a prospect is typed: name, then phone.'))
C.append(card('6 · Confirm, then the office manager approves',
 "🛂 *Catalogue hand-out — Lagos*\n🧵 9006 · 📗 Small ×2 · Shade 3\n🆕 Prospect: *Hajiya Bilki* · 0803 123 4567\n🙋 Logged by Abdul · 03-Oct-2026\n\nIn office after approval: 📗 20 of 30",
 [["✅ Approve", "❌ Reject"]],
 'Goes to the manager of that office (else admins). On ✅ the ledger row is written and the in-office figure drops at once. Your ruling decides whether customer hand-outs skip this step.'))
C.append(card('7 · 📥 Received — catalogues arriving with a container',
 "📥 *Catalogues received — Lagos* · 🚢 Jul26\n🧵 9006\n\nHow many *📘 Big*?",
 [["5", "10", "20", "50"], ["✏️ Type a number"], ["⬅ Back", "❌ Cancel"]],
 'Then 📗 Small, then confirm. Writes the raw count into Inventory column X on the design\'s first row of that container at that warehouse. Your spreadsheet seeds this column once.'))
C.append(card('8 · Reject / mismatch — what the manager sees when stock is short',
 "⚠️ *Cannot give out — 9006 📘 Big ×4 · Lagos*\nIn office: 📘 3 (received 12 · out 9)\n\nReduce the quantity, or mark a return first.",
 [["✏️ Change quantity", "↩ Returned"], ["⬅ Back"]],
 'The office figure is the guard. Nothing goes negative, nothing is debited twice.'))

CSS = """
@page { size: A4; margin: 7mm 8mm; } * { box-sizing:border-box; }
body { margin:0; font-family:"DejaVu Sans","Segoe UI",Arial,sans-serif; color:#16202a; font-size:9pt; }
h1 { font-size:16pt; margin:0 0 1mm; } .sub { color:#4a5866; font-size:8.6pt; margin-bottom:3mm; }
.grid { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:3mm; }
.slot { break-inside:avoid; } .ttl { font-weight:700; color:#0e2a47; font-size:8.6pt; margin-bottom:1mm; }
.tg { background:#0e1621; border-radius:2.4mm; padding:1.8mm; } .bubble { background:#182533; border-radius:2mm; padding:1.6mm 2mm .8mm; }
.txt { color:#e9eef3; font-size:7.1pt; line-height:1.3; white-space:pre-wrap; word-wrap:break-word; } .txt b { color:#fff; } .txt i { color:#8fa3b5; }
.txt code { background:#0e1621; border-radius:1mm; padding:0 .8mm; font-family:"DejaVu Sans Mono",monospace; font-size:7pt; color:#a9c7e4; }
.time { text-align:right; color:#6d8298; font-size:6.4pt; margin-top:.6mm; }
.krow { display:flex; gap:.8mm; margin-top:.7mm; } .kbtn { flex:1; background:#22303f; color:#e9eef3; text-align:center; font-size:6.8pt; padding:.8mm .6mm; border-radius:1.2mm; }
.note { font-size:7.3pt; color:#3d4b59; margin-top:1.2mm; border-left:2px solid #1d6fa5; padding-left:1.8mm; }
.foot { margin-top:2.4mm; font-size:7.4pt; color:#4a5866; border-top:1px solid #e2e8ee; padding-top:1.6mm; }
"""
OUT.write_text(f"""<!doctype html><html><head><meta charset='utf-8'><title>CAT-T1 — Catalogue tracker cards</title><style>{CSS}</style></head><body>
<h1>📘📗 Catalogue tracker inside Supply Details — the cards (proposal, 03-Oct-2026)</h1>
<div class="sub">Where you already are: 📊 Reporting → 📦 Supply Details → 🎨 Stock by shade → warehouse → <b>design list</b> (or container → design list). One chip is added there; everything below it is new. Example figures only. Nothing is built yet.</div>
<div class="grid">{''.join(C)}</div>
<div class="foot"><b>Storage:</b> Inventory gains ONE trailing column X <code>catalogues_received</code> (raw <code>B12 S30</code> on the design's first row per container per warehouse); hand-outs stay in the existing CatalogLedger sheet, which gains one trailing <code>Shade</code> column and a third recipient type <code>prospect</code> (name + phone). Every figure on cards 1–4 is computed when the card is drawn. <b>Access:</b> the storekeeper of a warehouse (Users column I) logs 📥 Received and ➕ Give out for that warehouse; the office manager approves; the office is the reporting point for all its warehouses. <b>Rulings needed:</b> (1) customer hand-outs — approve or immediate? (2) a catalogue = one design, or one shade? (3) who is "the manager of the office" in the Users sheet — the <code>manages</code> relation, or a department?</div>
</body></html>""", encoding='utf-8')
print('wrote', OUT)
