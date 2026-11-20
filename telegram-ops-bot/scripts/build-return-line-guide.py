#!/usr/bin/env python3
"""RET-7 — how to type a return, and the test sheet for Abdul: a short guide
built from the bot's REAL cards.

Writes (A4 portrait, 4 pages):
    docs/RET-7_RETURN_LINE_ABDUL.html + docs/RET-7_RETURN_LINE_ABDUL.pdf

Rebuild (from telegram-ops-bot/, after any wording change in the bot):
    python3 scripts/build-return-line-guide.py

How it works
  1. It runs scripts/ret7-capture/capture.js once with node, working directory
     telegram-ops-bot. The run drives the bot's real code offline (fake
     Telegram, fake Sheets, a fixed clock on 20-Nov-2026, a fixed request id)
     and prints every message, edit and pop-up the bot sent, as JSON.
  2. Every card the guide shows is picked from that JSON by its step key. A
     pick that matches no card, or more than one, STOPS the build.
  3. Checks that stop the build: every card shown comes from the capture;
     every button named in the guide exists on a captured card; every “…”
     quote in the guide's own words is found on a captured card; the three
     old lines of 20-Nov give the identical one-way card, open no card and
     never reach the AI; a submitted return changes no stock and a cancelled
     one raises no request; the PDF exists, has at most 4 pages, and no page
     is blank.
  4. The Telegram look is the PAY-6 guide's: this script imports
     scripts/build-pay6-card-guides.py and reuses its renderer (bubbles,
     Markdown, button rows), its quote and button checks and its printer,
     without changing that file. The page is laid out portrait.

The test sheet (page 4) has printed tick boxes and writing lines. It is NOT a
fillable PDF form: Chromium does not write form fields, and no PDF library is
installed here to add them.

Options
    --json FILE      read the capture's JSON from FILE instead of running it
    --save-json FILE also save the capture's JSON there
    --out-dir DIR    write the HTML and PDF to DIR instead of docs/
    --no-pdf         write the HTML only

Standard library only (plus Chromium to print, and pdfinfo / pdftotext for
the page checks).
"""
import argparse
import html
import importlib.util
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

BOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = BOT / "docs"
DATE = "20-Nov-2026"
NAME = "RET-7_RETURN_LINE_ABDUL"
SEG = "R"
MAX_PAGES = 4

# ── the PAY-6 builder, imported (never modified) ─────────────────────────
sys.dont_write_bytecode = True  # importing the PAY-6 builder leaves no __pycache__ in the repo
_spec = importlib.util.spec_from_file_location("pay6guide", BOT / "scripts" / "build-pay6-card-guides.py")
G = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(G)
die = G.die
b, ty = G.b, G.ty


# ══════════════════════════════════════════════════════════════════════════
# 1. The capture
# ══════════════════════════════════════════════════════════════════════════
def run_capture(json_file=None, save_file=None):
    if json_file:
        return json.loads(pathlib.Path(json_file).read_text(encoding="utf-8"))
    print("capture: node scripts/ret7-capture/capture.js", file=sys.stderr)
    with tempfile.TemporaryFile(mode="w+b") as out:
        p = subprocess.run(["node", "scripts/ret7-capture/capture.js"], cwd=str(BOT),
                           stdout=out, stderr=subprocess.PIPE, env=dict(os.environ))
        out.seek(0)
        raw = out.read().decode("utf-8")
    if p.returncode != 0:
        sys.stderr.write(p.stderr.decode("utf-8", "replace")[-4000:])
        die(f"the capture exited {p.returncode}")
    try:
        doc = json.loads(raw)
    except ValueError as e:
        die(f"the capture did not print one JSON document ({e})")
    if save_file:
        pathlib.Path(save_file).write_text(raw, encoding="utf-8")
    return doc


def normalise(doc):
    lst = doc.get("cards")
    if not isinstance(lst, list):
        die("no card list in the capture's JSON")
    return [{
        "seg": SEG, "i": i,
        "step": f"{c.get('stepKey')} | {c.get('step') or ''}",
        "actor": c.get("actor") or "",
        "recipient": c.get("recipient") or "",
        "kind": c.get("kind") or "",
        "text": c.get("text") or "",
        "parse_mode": c.get("parse_mode") or "",
        "buttons": c.get("buttons") or [],
        "alert": c.get("alert") is True,
        "keyboard_only": bool(c.get("keyboard_only")),
    } for i, c in enumerate(lst)]


SHOWN = []  # every card the guide draws (checked: each came from the capture)


def S(key, kind=None, to="Abdul", text=None):
    """Exactly one captured card of step `key` (on Abdul's phone by default)."""
    c = G.S(SEG, step=f"{key} |", to=to, kind=kind, text=text)
    SHOWN.append(c)
    return c


def end(label):
    """A button that ends a sentence: the chip and its full stop stay together."""
    return f'<span class="nw">{b(label)}.</span>'


def card(c, cls=""):
    return f'<div class="shot {cls}">{G.bubble(c)}</div>'


# ══════════════════════════════════════════════════════════════════════════
# 2. The pages
# ══════════════════════════════════════════════════════════════════════════
PROSE = []  # the guide's own words, for the quote check


def P(s):
    PROSE.append(s)
    return s


def page1(doc):
    fmt = S("old_1", kind="message")
    lines = fmt["text"].split("\n")
    one_line = lines[2]
    if not one_line.startswith("Return "):
        die(f"the one-way card's third line is not the one line: {one_line!r}")
    bullets = [x[2:] for x in lines if x.startswith("• ")]
    if len(bullets) != 5:
        die(f"the one-way card should carry five rules, it carries {len(bullets)}")
    rules = []
    for x in bullets:
        if ": " in x:
            what, ex = x.split(": ", 1)
            rules.append(f'<tr><td class="rex"><span class="mono">{html.escape(ex)}</span></td><td>{html.escape(what)}</td></tr>')
        else:
            ex = "Return" if x.startswith("the word Return") else ("," if "comma" in x else "")
            rules.append(f'<tr><td class="rex"><span class="mono">{html.escape(ex)}</span></td><td>{html.escape(x)}</td></tr>')
    numbers_only = next((x for x in lines if x.startswith("Numbers only")), None)
    record = next((x for x in lines if x.startswith("The bot takes")), None)
    if not numbers_only or not record:
        die("the one-way card lost its 'Numbers only' or 'The bot takes' line")
    old = doc.get("old_lines") or []
    olds = "".join(f'<li><span class="struck">{html.escape(x)}</span> <span class="no">✗</span></li>' for x in old)
    return f"""
<section class="pg">
 <div class="brand">black_panther bot · for Abdul · {DATE}</div>
 <h1>How to type a return</h1>
 <div class="sub">{P("From today the bot takes a return in ONE way only. Type the word Return, then the numbers. Nothing else.")}</div>
 <div class="bigbox"><div class="bigl">Type this:</div><div class="big">{html.escape(one_line)}</div>
  <div class="bign">Use your own bale numbers. This line returns thans 1, 2 and 3 of bale 631, and all of bale 614.</div></div>
 <div class="two">
  <div class="box rulesbox"><div class="btitle">The five rules</div>
   <table class="rtab">{"".join(rules)}</table>
   <div class="numonly">{html.escape(numbers_only)}</div>
  </div>
  <div class="box recbox"><div class="btitle">Who is the customer? Which store?</div>
   <p class="rec">{P(f"“{html.escape(record)}”")}</p>
   <p>{P("You do not type the customer. You do not type the store. The return card shows them to you. Check them there.")}</p>
   <p class="small">{P("Capital letters and extra spaces do not matter. A new line between bales also works.")}</p>
  </div>
 </div>
 <div class="dont">
  <div class="dtext"><div class="btitle red">Do not type</div>
   <p>{P("Words around the numbers. These are your lines from 20-Nov. The bot does not read them now:")}</p>
   <ul class="olds">{olds}</ul>
   <p>{P("No <b>to Idumota</b>. No <b>package</b>. No customer name.")}</p>
   <p>{P("For each of them the bot sends this card, and nothing else happens. Type the line again, the one way.")}</p>
  </div>
  <div class="dcard">{card(fmt)}</div>
 </div>
</section>"""


def page2():
    steps = [
        (S("one_line"), f"Type {ty('Return 631/1+2+3+4+5, 614/1')}. The return card opens. Check the customer and every bale line. "
                        f"Then tap {end('✅ Continue — date, condition, photo')}"),
        (S("one_go"), f"Tap the day the goods came back. Here {end('📅 Today (20-Nov-2026)')}"),
        (S("one_date", kind="edit"), f"Tap how the goods look. Here {end('✅ Good — back to stock')}"),
        (S("one_cond", kind="edit"), f"Send one photo of the goods, or tap {end('⏭ Skip photo')}"),
        (S("one_photo", kind="edit"), f"The confirm card. Check it. For a real return tap {end('✅ Submit for approval')}"),
        (S("one_submit", kind="edit", text="submitted"),
         "Your receipt: “Waiting for two admins to sign.” The stock changes only after two admins approve."),
    ]
    cells = []
    for k, (c, cap) in enumerate(steps):
        cells.append(f'<div class="cell"><div class="cap"><span class="num">{k + 1}</span><span>{P(cap)}</span></div>{card(c)}</div>')
    return f"""
<section class="pg">
 <h2>What you will see</h2>
 <div class="sub2">{P("One return, from the line to the receipt. In this example the customer Soldier Madam bought bale 631 (thans 1 to 5) and bale 614 (than 1) from IDUMOTA.")}</div>
 <div class="cols3">{"".join(f'<div class="colm">{cells[i]}{cells[i + 1]}</div>' for i in (0, 2, 4))}</div>
</section>"""


def page3():
    ex = [
        ("A whole bale", S("whole"),
         f"Type {ty('Return 614')}. The bot loads every sold than of bale 614. To take one out, tap {b('🔎 Open 614')}."),
        ("A mistake in the line", S("wrong"),
         f"Type {ty('Return 631-635')}. The bot cannot read “-635” and says so: “❓ Could not read: -635”. "
         f"Bale 631 is still loaded. Tap {b('❌ Cancel')} and type the line again, with a comma: "
         f"{ty('Return 631, 632, 633, 634, 635')}."),
        ("Add a bale on the open card", S("add_ok"),
         f"The card is open. Type only the numbers: {ty('614/1')}. The card says “➕ Added 1 bale.”"),
        ("Words on the open card", S("add_bad"),
         f"Type {ty('700 to Idumota')}. The card says “Nothing was added.” Type numbers only."),
    ]
    cells = []
    for title, c, cap in ex:
        cells.append(f'<div class="cell"><div class="extitle">{html.escape(title)}</div>'
                     f'<div class="cap plain">{P(cap)}</div>{card(c)}</div>')
    cx = S("cx_cancel", kind="edit")
    return f"""
<section class="pg">
 <h2>More examples</h2>
 <div class="grid2">{"".join(cells)}</div>
 <div class="cxrow"><div class="cxt"><div class="btitle">{P(f"Stop at any time: tap {b('❌ Cancel')}")}</div>
  <p>{P("Nothing is sent to the admins. The stock does not change.")}</p></div>{card(cx, "cxcard")}</div>
</section>"""


# No · Type or tap this exactly · You should see. “…” quotes are checked.
def test_rows():
    blank = '<span class="blank"></span>'
    return [
        (f"Type {ty('Return 631/1+2+3+4+5,614/1 to Idumota')}",
         "The card “↩️ Return — type it one way only”. No return card opens."),
        (f"Type {ty('Return package 631/1+2+3+4+5,614/1 to Idumota')}", "The same card as in row 1."),
        (f"Type {ty('Return package from soldier madam 631/1+2+3+4+5,614/1 to Idumota')}", "The same card as in row 1."),
        (f"Type {ty('Return 631-635')}. Then tap {b('❌ Cancel')}.",
         "A return card with the line “❓ Could not read: -635”. After Cancel: “nothing was queued”."),
        (f"Use a bale you sold. Type {ty('Return')} and the bale number only. Then tap {b('❌ Cancel')}."
         f'<div class="used">Bale I used: {blank}</div>',
         "The return card with every sold than of that bale, the customer's name, and “📦 Loaded with every sold than”."),
        (f"Use bales you sold. Type {ty('Return')}, one bale with thans, a comma, a whole bale. "
         f"Like {ty('Return 631/1+2, 614')}."
         f'<div class="used">Line I typed: {blank}</div>',
         "The return card. The customer and the store are the ones from the sale. Each than you typed is one line."),
        (f"On that open card, type the number of ONE MORE bale you sold, numbers only."
         f'<div class="used">Bale: {blank}</div>',
         "“➕ Added 1 bale.” The new bale is on the card."),
        (f"On the open card, type {ty('700 to Idumota')}", "“❓ Numbers only here” and “Nothing was added.”"),
        (f"Tap {b('✅ Continue — date, condition, photo')} → <span class='chip'>📅 Today (…)</span> "
         f"→ {b('✅ Good — back to stock')} → {b('⏭ Skip photo')}",
         "The card “Confirm return” with the button ✅ Submit for approval. DO NOT TAP IT."),
        (f"Tap {b('❌ Cancel')}", "“❌ Return cancelled — nothing was queued.”"),
    ]


def page4():
    rows = []
    for k, (do, see) in enumerate(test_rows()):
        P(do)
        P(see)
        rows.append(f'<tr><td class="tn">{k + 1}</td><td class="td">{do}</td><td class="ts">{see}</td>'
                    f'<td class="tyn"><div><span class="tb"></span> Yes</div><div><span class="tb"></span> No</div></td>'
                    f'<td class="tw"><span class="wl"></span></td></tr>')
    warn = P(f"Do NOT tap {b('✅ Submit for approval')} in this test. A submitted return goes to the admins, "
             "and when they approve it the stock and the customer's account change. "
             f"Stop at the confirm card and tap {b('❌ Cancel')}.")
    return f"""
<section class="pg">
 <h2>Test it on the bot</h2>
 <div class="sub2">{P("Type each line in the bot, exactly as written. Do the rows in this order. Tick Yes if the bot shows it, No if not. Write what you saw.")}</div>
 <div class="warn">⚠️ {warn}</div>
 <table class="tt">
  <tr><th>No</th><th>Type or tap this</th><th>You should see</th><th>Did you see it?</th><th>What I saw</th></tr>
  {"".join(rows)}
 </table>
 <div class="endrow"><div class="sign">
  <div>Name: <span class="sigl"></span></div><div>Date: <span class="sigl"></span></div>
 </div>
 <div class="sendto">📷 {P("Send a photo of this page to Krishna.")}</div></div>
</section>"""


# ══════════════════════════════════════════════════════════════════════════
# 3. Checks
# ══════════════════════════════════════════════════════════════════════════
def check_capture(doc):
    cards = G.CARDS[SEG]
    old = doc.get("old_lines") or []
    if len(old) != 3:
        die("the capture should carry Abdul's three old lines")
    got = [G.S(SEG, step=f"old_{i} |", to="Abdul", kind="message") for i in (1, 2, 3)]
    if any(g["text"] != got[0]["text"] or g["buttons"] != got[0]["buttons"] for g in got):
        die("Abdul's three old lines did not give the identical one-way card")
    for k in ("old_1", "old_2", "old_3"):
        if len([c for c in cards if c["step"].startswith(f"{k} |")]) != 1:
            die(f"{k}: the bot sent more than the one-way card")
    facts = doc.get("facts") or {}
    for o in facts.get("old") or []:
        if o.get("ai_asked") or o.get("card_opened"):
            die(f"an old line reached the AI or opened a card: {o}")
    if facts.get("ai_asked_total") != 0:
        die("the AI was asked about a typed line")
    one = facts.get("one") or {}
    if one.get("requests") != 1 or one.get("action") != "return_bundle" or one.get("status") != "pending":
        die(f"the submitted return did not raise one pending return_bundle request: {one}")
    if not one.get("stock_unchanged_by_submit"):
        die("the guide says the stock changes only after approval — the capture's stock changed at submit")
    cx = facts.get("cancel") or {}
    if cx.get("new_requests") != 0 or cx.get("session_left"):
        die(f"❌ Cancel raised a request or left the card open: {cx}")
    if (facts.get("add") or {}).get("bales_after") != ["631", "614"]:
        die("on the open card, 614/1 should be added and '700 to Idumota' refused")
    if "❓ Could not read" not in G.S(SEG, step="wrong |", to="Abdul")["text"]:
        die("the wrong line's card lost its ❓ Could not read line")


def check_shown():
    ids = {id(c) for c in G.CARDS[SEG]}
    for c in SHOWN:
        if id(c) not in ids:
            die("a card in the guide does not come from the capture")


def check_pdf(pdf):
    if not pdf.exists() or pdf.stat().st_size < 10000:
        die(f"{pdf} was not produced")
    for tool in ("pdfinfo", "pdftotext"):
        if not shutil.which(tool):
            die(f"{tool} is needed for the page checks (apt install poppler-utils)")
    info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    m = re.search(r"^Pages:\s+(\d+)", info, re.M)
    if not m:
        die("pdfinfo could not read the page count")
    pages = int(m.group(1))
    if pages > MAX_PAGES:
        die(f"the guide has {pages} pages — at most {MAX_PAGES}")
    blank = []
    for n in range(1, pages + 1):
        t = subprocess.run(["pdftotext", "-f", str(n), "-l", str(n), "-layout", str(pdf), "-"],
                           capture_output=True, text=True).stdout
        body = re.sub(r"black_panther bot · How to type a return.*?page \d+", "", t)
        if len(re.sub(r"\s+", "", body)) < 40:
            blank.append(n)
    if blank:
        die(f"blank page(s) in the PDF: {blank}")
    print(f"checked {pdf.name}: {pages} pages, none blank")
    return pages


# ══════════════════════════════════════════════════════════════════════════
# 4. Style (the PAY-6 card look, laid out portrait, larger type for a phone)
# ══════════════════════════════════════════════════════════════════════════
EXTRA_CSS = """
@page { size: A4 portrait; margin: 10mm 11mm 13mm; }
body { font-size:11pt; line-height:1.4; }
.pg { page-break-after: always; }
.pg:last-child { page-break-after: auto; }
h1 { font-size:28pt; margin:1mm 0 1mm; }
h2 { font-size:21pt; color:#0e2a47; margin:0 0 1.4mm; letter-spacing:-.3px; }
.sub { font-size:12.4pt; color:#22303f; margin-bottom:3mm; }
.sub2 { font-size:11pt; color:#3d4b59; margin-bottom:3mm; }
.mono { font-family:"DejaVu Sans Mono",monospace; }
.bigbox { border:3px solid #1f6fb2; background:#f1f7fd; border-radius:4mm; padding:3mm 5mm 3.4mm; margin-bottom:4mm; }
.bigl { font-size:11pt; font-weight:800; color:#1f6fb2; text-transform:uppercase; letter-spacing:1px; }
.big { font-family:"DejaVu Sans Mono",monospace; font-weight:700; font-size:31pt; color:#0e2a47; line-height:1.25; margin:1mm 0 1.4mm; }
.bign { font-size:10.4pt; color:#3d4b59; }
.two { display:flex; gap:4mm; margin-bottom:4mm; }
.two .box { padding:3mm 4mm; }
.rulesbox { flex:1.25; } .recbox { flex:1; }
.btitle { font-size:12.4pt; }
.btitle.red { color:#a3232a; }
.rtab { border-collapse:collapse; width:100%; font-size:11pt; }
.rtab td { padding:1.2mm 1.6mm; border-bottom:1px solid #dde4ea; vertical-align:top; }
.rtab .rex { width:34mm; font-weight:700; color:#0e2a47; font-size:12pt; }
.numonly { margin-top:2.4mm; font-weight:800; color:#a3232a; font-size:11pt; }
.rec { font-size:12pt; font-weight:700; color:#0e2a47; }
.box p { margin:0 0 2mm; }
.small { font-size:9.6pt; }
.dont { display:flex; gap:4mm; border:2.4px solid #a3232a; background:#fff6f6; border-radius:4mm; padding:3mm 4mm; align-items:flex-start; }
.dtext { flex:1; } .dtext p { margin:0 0 2mm; }
.dcard { width:76mm; flex:none; }
.olds { list-style:none; padding:0; margin:0 0 2.4mm; }
.olds li { font-family:"DejaVu Sans Mono",monospace; font-size:9.6pt; margin-bottom:1.6mm; background:#fff; border:1px solid #e4c3c3; border-radius:1.4mm; padding:1mm 2mm; }
.struck { text-decoration:line-through; text-decoration-color:#c0392b; text-decoration-thickness:2px; color:#5d3a3a; }
.no { color:#c0392b; font-weight:900; font-family:"DejaVu Sans",sans-serif; }

.shot .tg { padding:1.6mm; }
.shot .txt { font-size:7.6pt; line-height:1.3; }
.shot .kbtn { font-size:7.1pt; padding:1mm .8mm; }
.shot .bubble { padding:1.8mm 2.2mm 1.6mm; }
.cols3 { display:flex; gap:4mm; align-items:flex-start; }
.colm { flex:1; min-width:0; display:flex; flex-direction:column; gap:4mm; }
.grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:4mm 6mm; align-items:start; }
.cell { break-inside:avoid; }
.cap { display:flex; gap:2mm; align-items:flex-start; font-size:9.6pt; line-height:1.3; margin-bottom:1.4mm; }
.cap.plain { display:block; min-height:0; }
.cap .chip, .cap .typed { white-space:normal; }
.cap .typed { display:inline; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
.nw { white-space:nowrap; }
.num { flex:none; display:inline-block; width:7mm; height:7mm; line-height:6.4mm; text-align:center; border-radius:3.5mm;
       background:#1f6fb2; color:#fff; font-weight:900; font-size:10.4pt; }
.extitle { font-weight:800; font-size:12pt; color:#0e2a47; margin-bottom:1mm; }
.grid2 .shot .txt { font-size:7.4pt; line-height:1.25; }
.grid2 .cap.plain { font-size:9.4pt; }
.grid2 { gap:3mm 6mm; }
.cxrow { display:flex; gap:5mm; align-items:center; margin-top:2.4mm; border:1.6px solid #1d6fa5; background:#f3f8fd; border-radius:3mm; padding:1.6mm 3mm; break-inside:avoid; }
.cxt { flex:1; } .cxt p { margin:0; }
.cxcard { width:72mm; flex:none; }
.cxt .btitle { margin-bottom:1mm; }

.warn { border:2.6px solid #a3232a; background:#fff1f1; border-radius:3mm; padding:2mm 3.4mm; font-size:10.6pt; font-weight:700; color:#5a1015; margin-bottom:2.4mm; }
.tt { width:100%; border-collapse:collapse; font-size:9.2pt; line-height:1.25; }
.tt th { background:#0e2a47; color:#fff; text-align:left; padding:1.4mm 2mm; font-size:9pt; }
.tt td { border-bottom:1.2px solid #b9c5d0; padding:1.3mm 1.6mm; vertical-align:top; }
.tt tr { break-inside:avoid; }
.tt .tn { width:7mm; font-weight:900; font-size:12pt; color:#0e2a47; }
.tt .td { width:62mm; } .tt .ts { width:50mm; color:#22303f; }
.tt .typed { white-space:normal; overflow-wrap:anywhere; }
.tt .tyn { width:19mm; font-size:9.6pt; white-space:nowrap; } .tt .tyn div { margin-bottom:1.2mm; }
.tb { display:inline-block; width:4.4mm; height:4.4mm; border:1.6px solid #0e2a47; border-radius:.8mm; vertical-align:-1mm; margin-right:1mm; background:#fff; }
.tt .tw { width:auto; }
.wl { display:block; border-bottom:1px solid #7d8b99; height:8mm; }
.used { margin-top:1.6mm; font-weight:700; color:#0e2a47; }
.blank { display:inline-block; width:34mm; border-bottom:1.4px solid #0e2a47; height:4mm; vertical-align:-1mm; }
.endrow { display:flex; gap:6mm; align-items:center; margin-top:2.4mm; break-inside:avoid; }
.sign { display:flex; flex-direction:column; gap:3mm; font-size:11pt; font-weight:700; flex:none; }
.sigl { display:inline-block; width:62mm; border-bottom:1.4px solid #0e2a47; height:5mm; vertical-align:-1mm; }
.sendto { flex:1; font-size:12.4pt; font-weight:800; color:#1e8449; border:2.4px solid #1e8449; border-radius:3mm; padding:2.4mm 4mm; background:#f2fbf5; }
"""

FOOT = f"black_panther bot · How to type a return · for Abdul · {DATE} · page "


def page(body):
    css = G.CSS.replace("@@FOOT@@", FOOT.replace('"', '\\"')).replace("size: A4 landscape;", "size: A4 portrait;") + EXTRA_CSS
    return (f"<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>"
            f"<title>How to type a return</title><style>{css}</style></head><body>{body}</body></html>")


def fixed_pdf_dates(pdf):
    """Chromium stamps the print time into CreationDate / ModDate. Overwrite the
    digits with the guide's date (same length), so a rebuild with no change
    leaves the PDF byte for byte the same."""
    raw = pdf.read_bytes()
    out = re.sub(rb"(/(?:CreationDate|ModDate) ?\(D:)\d{14}", rb"\g<1>20261120000000", raw)
    if out != raw:
        pdf.write_bytes(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json")
    ap.add_argument("--save-json")
    ap.add_argument("--out-dir", help="write the HTML and PDF here instead of docs/")
    ap.add_argument("--no-pdf", action="store_true")
    args = ap.parse_args()
    out_dir = pathlib.Path(args.out_dir) if args.out_dir else DOCS
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = run_capture(args.json, args.save_json)
    G.CARDS[SEG] = normalise(doc)
    G.NAMES[:] = ["Abdul", "Krishna", "Musa"]
    for c in G.CARDS[SEG]:
        for row in c["buttons"]:
            G.ALL_BUTTONS.update(row)

    check_capture(doc)
    body = [page1(doc), page2(), page3(), page4()]
    check_shown()
    G.PROSE[:] = PROSE
    G.check_buttons()
    G.check_quotes()

    hp = out_dir / f"{NAME}.html"
    hp.write_text(page("".join(body)), encoding="utf-8")
    print("wrote", hp)
    if not args.no_pdf:
        pdf = out_dir / f"{NAME}.pdf"
        G.print_pdf(hp, pdf)
        fixed_pdf_dates(pdf)
        check_pdf(pdf)


if __name__ == "__main__":
    main()
