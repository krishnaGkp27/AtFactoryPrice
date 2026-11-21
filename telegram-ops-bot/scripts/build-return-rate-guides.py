#!/usr/bin/env python3
"""RET-8 — the two test sheets for "a return whose sale has no rate", built
from the bot's REAL cards.

Writes (A4 portrait, at most 4 pages each):
    docs/RET-8_TEST_ABDUL.html  + docs/RET-8_TEST_ABDUL.pdf    (Abdul, the employee)
    docs/RET-8_TEST_ADMINS.html + docs/RET-8_TEST_ADMINS.pdf   (Krishna and Musa)

Rebuild (from telegram-ops-bot/, after any wording change in the bot):
    python3 scripts/build-return-rate-guides.py

How it works
  1. It runs scripts/ret8-capture/capture.js once with node, working
     directory telegram-ops-bot. The run drives the bot's real code offline
     (fake Telegram, fake Sheets, a fixed clock on 21-Nov-2026, fixed request
     ids) through nine scenes (A to I, listed in the capture's header) and
     prints every message, edit and pop-up the bot sent, as JSON.
  2. Every card a sheet shows is picked from that JSON by its step key. A
     pick that matches no card, or more than one, STOPS the build.
  3. Checks that stop the build:
       - every card shown comes from the capture; Abdul's sheet shows only
         cards that reached Abdul's phone;
       - every button named in a sheet is on a captured card (Abdul's: on a
         card he received);
       - every “…” quote in a sheet's own words is found on a captured card
         (Abdul's: on a card he received);
       - Abdul's sheet never shows a rate: its HTML holds no "/yd", no
         "1,450" and no "1450";
       - no sheet uses the code's words (gap, fill, seam, signoff, print,
         hash, executor, actionJSON, legacy, flow, session, callback,
         stepState);
       - the facts of the run: nothing is sent by a look-only card, the first
         ✅ Approve and the typed rate sign nothing, only the confirm chip
         signs, the second admin's chip completes the return, the credit is
         6 thans × 30 yd × 1,450 = 261,000, the stock is back, the no-credit
         return credits nothing, the AI is never asked;
       - each PDF exists, has at most 4 pages, and no page is blank.
  4. The Telegram look is the PAY-6 guide's: this script imports
     scripts/build-pay6-card-guides.py and reuses its renderer (bubbles,
     Markdown, button rows, pop-ups) and its printer, without changing that
     file. The pages are laid out portrait, as the RET-7 guide's.

The test sheets have printed tick boxes and writing lines. They are NOT
fillable PDF forms (Chromium does not write form fields). Each sheet says so:
on paper, or one message per row to Krishna.

Options
    --json FILE      read the capture's JSON from FILE instead of running it
    --save-json FILE also save the capture's JSON there
    --out-dir DIR    write the HTML and PDF files to DIR instead of docs/
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
DATE = "21-Nov-2026"
SEG = "R"
MAX_PAGES = 4
REBUILD = "rebuild: python3 scripts/build-return-rate-guides.py"

# ── the PAY-6 builder, imported (never modified) ─────────────────────────
sys.dont_write_bytecode = True  # importing the PAY-6 builder leaves no __pycache__ in the repo
_spec = importlib.util.spec_from_file_location("pay6guide", BOT / "scripts" / "build-pay6-card-guides.py")
G = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(G)
die = G.die
ty = G.ty


# ══════════════════════════════════════════════════════════════════════════
# 1. The capture
# ══════════════════════════════════════════════════════════════════════════
def run_capture(json_file=None, save_file=None):
    if json_file:
        return json.loads(pathlib.Path(json_file).read_text(encoding="utf-8"))
    print("capture: node scripts/ret8-capture/capture.js", file=sys.stderr)
    with tempfile.TemporaryFile(mode="w+b") as out:
        p = subprocess.run(["node", "scripts/ret8-capture/capture.js"], cwd=str(BOT),
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


# ══════════════════════════════════════════════════════════════════════════
# 2. One sheet's bookkeeping: the cards it shows, its words, its buttons
# ══════════════════════════════════════════════════════════════════════════
class Sheet:
    def __init__(self, name, title, short, only_to=None):
        self.name, self.title, self.short, self.only_to = name, title, short, only_to
        self.shown, self.prose, self.buttons = [], [], []

    def S(self, key, kind=None, to=None, text=None):
        """Exactly one captured card of step `key`."""
        c = G.S(SEG, step=f"{key} |", to=to, kind=kind, text=text)
        self.shown.append(c)
        return c

    def P(self, s):
        self.prose.append(s)
        return s

    def b(self, label):
        """A button named in the sheet's words (checked against the capture)."""
        self.buttons.append(label)
        return f'<span class="chip">{html.escape(label)}</span>'

    def end(self, label):
        """A button that ends a sentence: never a lone full stop on its own line."""
        return f'<span class="nw">{self.b(label)}</span>'


def card(c, marks=(), cls=""):
    """The card as the phone shows it; each text in `marks` is highlighted
    (it must be on the card, or the build stops)."""
    h = G.bubble(c)
    for m in marks:
        e = html.escape(m)
        if e not in h:
            die(f"the card {c['step'][:40]!r} has no text {m!r} to mark")
        h = h.replace(e, f'<span class="hl">{e}</span>', 1)
    return f'<div class="shot {cls}">{h}</div>'


def popup(c):
    return f'<div class="pop"><div class="poplbl">pop-up</div>{G.popup_html(c)}</div>'


def tick_cells(lines=3):
    return ('<td class="tyn"><div><span class="tb"></span> Yes</div><div><span class="tb"></span> No</div></td>'
            '<td class="tw">' + '<span class="wl"></span>' * lines + '</td>')


def test_table(sh, rows, start=1):
    out = []
    for k, (do, see) in enumerate(rows, start=start):
        sh.P(do)
        sh.P(see)
        out.append(f'<tr><td class="tn">{k}</td><td class="td">{do}</td><td class="ts">{see}</td>{tick_cells()}</tr>')
    return ('<table class="tt"><tr><th>No</th><th>Do this</th><th>You must see</th><th>Seen?</th><th>What I saw</th></tr>'
            + "".join(out) + "</table>")


def blank(w="34mm"):
    return f'<span class="blank" style="width:{w}"></span>'


# ══════════════════════════════════════════════════════════════════════════
# 3. Abdul's sheet
# ══════════════════════════════════════════════════════════════════════════
def abdul_pages(sh):
    S, P, b, end = sh.S, sh.P, sh.b, sh.end
    A = "Abdul"
    whole = S("a_line", to=A)
    one = S("b_line", to=A)
    confirm = S("c_photo", kind="edit", to=A)
    done = S("e_confirm", to=A, text="2 of 2")

    p1 = f"""
<section class="pg">
 <div class="brand">black_panther bot · for Abdul · {DATE}</div>
 <h1>Returns — what is new, and how to test it</h1>
 <div class="sub">{P("You type a return the same way as before: the word Return, then the numbers. Three things on the cards are new.")}</div>
 <div class="news">
  <div class="new"><div class="nhead"><span class="nnum">1</span><span>{P("A full bale is ONE line")}</span></div>
   <div class="ntext">{P(f"All five thans of bale 631 come back. The card shows one line: “631 · 5 thans · 150 yd”. Before, it showed five lines.")}</div>
   {card(whole, ["631 · 5 thans · 150 yd"])}
   <div class="ntext small">{P(f"Only some thans of a bale come back? Each than is still its own line. Here: {ty('Return 614/1')} gives “614/1 · 30 yd”.")}</div>
  </div>
  <div class="new"><div class="nhead"><span class="nnum">2</span><span>{P("The day the goods were sold")}</span></div>
   <div class="ntext">{P("The customer line now ends with the day of the sale: “· sold 02-Nov-2026”. Check that it is the right customer and the right day.")}</div>
   {card(one, ["· sold 02-Nov-2026", "614/1 · 30 yd"])}
  </div>
 </div>
 <div class="new wide3"><div class="nhead"><span class="nnum">3</span><span>{P("Goods with no rate on the sale")}</span></div>
  <div class="row3">
   <div class="ntext">{P("Sometimes the sale was saved with no rate. Before, such a return gave the customer NO credit.")}
    <p>{P("Now your confirm card says “⚠️ Thans without a rate: the approving admin is asked for the rate.” You do nothing more. Submit as always.")}</p>
    <p>{P("The first admin types the rate. The second admin checks it. When both approve, your last card shows the credit: “↩️ Credited solder madam 261,000”.")}</p>
    <p class="note">{P("You never see the rate the admin typed. You see only the credit.")}</p></div>
   <div class="c3">{card(confirm, ["⚠️ Thans without a rate: the approving admin is asked for the rate."])}</div>
   <div class="c3">{card(done, ["↩️ Credited solder madam 261,000 (6 thans, 180 yd)."])}</div>
  </div>
 </div>
</section>"""

    steps = [
        (S("c_line", to=A), f"Type {ty('Return 631/1+2+3+4+5, 614/1')}. The card opens. Check the customer, the day, every line. Tap {end('✅ Continue — date, condition, photo')}"),
        (S("c_photo", kind="edit", to=A, text="Confirm return"),
         f"Tap the day, how the goods look, a photo or {b('⏭ Skip photo')}. The confirm card has the new line. Tap {end('✅ Submit for approval')}"),
        (S("c_submit", kind="edit", to=A, text="submitted"), "Your receipt: “⏳ Waiting for two admins to sign.” Nothing in stock changes yet."),
        (S("d_confirm", to=A), "The first admin approved (1 of 2). You get “🔏 Approval 1 of 2”. No rate on it."),
        (done, "The second admin approved. You get “✅ Approved · 2 of 2” with the credit. The thans are in stock again."),
        (S("f_k_confirm", to=A), "Or: the admins chose no credit. Then the card says “No credit to solder madam — chosen at approval”. That is their choice. Nothing to do."),
    ]
    cells = []
    for k, (c, cap) in enumerate(steps):
        cells.append(f'<div class="cell"><div class="cap"><span class="num">{k + 1}</span><span>{P(cap)}</span></div>{card(c)}</div>')
    # the confirm card is shown on page 1 already: here it is the same card, so the walk reads in one line
    p2 = f"""
<section class="pg">
 <h2>The whole return, card by card</h2>
 <div class="sub2">{P("In this example solder madam bought all of bale 631 (5 thans) and than 1 of bale 614 on 02-Nov-2026. The sale has no rate.")}</div>
 <div class="cols3">{"".join(f'<div class="colm">{cells[i]}{cells[i + 1]}</div>' for i in (0, 2, 4))}</div>
 <div class="cxrow"><div class="cxt">{P(f"<b>Stop at any time before Submit:</b> tap {b('❌ Cancel')}. The card says “❌ Return cancelled — nothing was queued.” Nothing goes to the admins.")}</div></div>
</section>"""

    part1 = [
        (f"Is a return card still open in your chat? Tap its {b('❌ Cancel')}. No card open: go to row 2.",
         "“❌ Return cancelled — nothing was queued.” Or nothing, if no card was open."),
        (f"Pick a bale you sold, where ALL its thans went to one customer. Type {ty('Return')} and the bale number: like {ty('Return 631')}."
         f'<div class="used">Line I typed: {blank("40mm")}</div>',
         "The bale is ONE line, like “631 · 5 thans · 150 yd”. Not one line per than."),
        ("Look at the customer line on the same card.",
         "It ends with the day of the sale, like “· sold 02-Nov-2026”. The right customer, the right day."),
        (f"Tap {b('❌ Cancel')}", "“❌ Return cancelled — nothing was queued.”"),
        (f"Type {ty('Return')} and ONE than of a bale you sold: like {ty('Return 614/1')}. Then tap {b('❌ Cancel')}."
         f'<div class="used">Line I typed: {blank("40mm")}</div>',
         "The than is its own line, like “614/1 · 30 yd”, and the customer line ends “· sold …”."),
        (f"Type {ty('Return')} and the row 6 bale Krishna wrote above (sold WITH a rate). Tap {b('✅ Continue — date, condition, photo')} → the day → {b('✅ Good — back to stock')} → {b('⏭ Skip photo')} "
         f"→ {b('❌ Cancel')}"
         f'<div class="used">Bale: {blank("30mm")}</div>',
         "The confirm card shows “💰 Credits:” with an amount, and NO line “Thans without a rate”. Do NOT tap Submit."),
    ]
    part2 = [
        (f"Goods really came back. Type the return line, as always.<div class='used'>Line I typed: {blank('40mm')}</div>",
         "The card shows each full bale as one line, and “· sold …” with the day of the sale."),
        (f"Tap {b('✅ Continue — date, condition, photo')}. Pick the day and the condition. Send a photo.",
         "The confirm card. For goods with no rate on the sale it says “⚠️ Thans without a rate: the approving admin is asked for the rate.”"),
        (f"Tap {b('✅ Submit for approval')}", "“↩️ Return — submitted” and “⏳ Waiting for two admins to sign.”"),
        ("Wait for the first admin.", "A new card: “🔏 Approval 1 of 2” and “⏳ Waiting on 1 more admin”. No rate on it."),
        ("Wait for the second admin.",
         "“✅ Approved · 2 of 2” and “↩️ Credited …” with the customer and an amount. Or “No credit to … — chosen at approval”. No rate on it."),
        (f"Tap {b('📨 My Requests')} (in 📋 Tasks & Planning), then {b('✅ Approved · 1')} (your number may be bigger).",
         "“Return goods” is on the list with “✅ 21-Nov …” and the two admins' names (your own day)."),
        ("Type the bale number only, like 631.", "The bale card. The thans that came back show 🟢 and “available”."),
    ]
    p34 = f"""
<section class="pg">
 <h2>Test it on the bot</h2>
 <div class="rules">
  <div class="rl"><b>⚠️ Part 2 moves real stock and the customer's real balance. Do it only with goods that really came back. Never send a made-up return to test.</b></div>
  <div class="rl">{P("Krishna tells you which bale numbers to use: one bale sold WITH a rate for row 6, and the goods for Part 2. You cannot see which sales have no rate. Krishna may ask you to do Part 2 twice.")}
   <div class="used">Row 6 bale (sold with a rate): {blank("40mm")}</div>
   <div class="used">Part 2 bales: {blank("46mm")} · second time: {blank("40mm")}</div></div>
  <div class="rl small">{P("On paper: tick Yes or No on each row and write what you saw. No printer? Send Krishna one message per row: row number, Yes or No, what you saw. Like: 4 No — two lines for bale 631.")}</div>
 </div>
 <div class="parth">PART 1 — look only. Nothing is sent. Safe on any day.</div>
 {test_table(sh, part1, start=1)}
 <div class="after1">{P("Part 1 done? Send Krishna the results of rows 1 to 6 before you start Part 2.")}</div>
</section>
<section class="pg">
 <h2>Test it on the bot — Part 2</h2>
 <div class="rules"><div class="rl"><b>⚠️ Only with goods that really came back, on the bale numbers Krishna gave you. Never send a made-up return to test.</b></div></div>
 <div class="parth p2h">PART 2 — only with goods that really came back</div>
 {test_table(sh, part2, start=len(part1) + 1)}
 <div class="endrow"><div class="sign">
  <div>Name: <span class="sigl"></span></div><div>Date: <span class="sigl"></span></div>
 </div>
 <div class="sendto">📷 {P("Send Krishna a photo of these pages, or one message per row.")}
  <div class="noprint">{P("You cannot type into this page on the phone. Write on paper, or send messages.")}</div></div></div>
</section>"""
    return [p1, p2, p34]


# ══════════════════════════════════════════════════════════════════════════
# 4. The admins' sheet
# ══════════════════════════════════════════════════════════════════════════
def admin_pages(sh, refs):
    S, P, b, end = sh.S, sh.P, sh.b, sh.end
    ref = refs["main"]
    msg = S("c_submit", to="Musa", kind="message")
    price = S("i_price", to="Musa", kind="message")
    rules = [
        P("A rate that is already on the sale is always used. The rate you type is used only for the thans that have none."),
        P("Once saved, the rate cannot be changed. To change it: ❌ Reject, and Abdul raises the return again."),
        P("No credit happens only when an admin taps “⏭ No credit for these”. Never by itself."),
        P("The employee never sees the rate. He sees the credit amount."),
        P("You cannot type the rate on your own return. A second admin must."),
        P("A return that already had one approval before 20-Nov-2026 finishes the old way: no credit for thans with no rate."),
        P("The rate card stays open 30 minutes, time to look the rate up. After that, tap ✏️ Type the rate again."),
        P("Each approval is given for the rate on the check card. If the rate changed in between, nothing is approved."),
    ]
    p1 = f"""
<section class="pg">
 <div class="brand">black_panther bot · for Krishna and Musa · {DATE}</div>
 <h1>Returns with no rate — what changed for you</h1>
 <div class="five">
  <div class="fl"><span class="nnum">1</span><span>{P(f"Every approval message now starts with one line: the request and its short number, like “🔔 Approval required · {ref}” (after one admin signed, a “🔏 1 of 2 — signed by …” line comes first). Then “From: Abdul”, then the card. The long reference and the line about the buttons are gone.")}</span></div>
  <div class="fl"><span class="nnum">2</span><span>{P("On a return, a bale whose thans ALL come back is one line: “631 · 5 thans · 150 yd”. The customer line says the day of the sale: “· sold 02-Nov-2026”.")}</span></div>
  <div class="fl"><span class="nnum">3</span><span>{P("If the sale has no rate, the card says so: “⚠️ No rate on the sale record: … The admin who approves first is asked for it.”")}</span></div>
  <div class="fl"><span class="nnum">4</span><span>{P(f"The FIRST admin to tap {b('✅ Approve')} types the rate (or taps “last paid”, or “⏭ No credit for these”). Only “✅ Approve with this credit” gives the approval.")}</span></div>
  <div class="fl"><span class="nnum">5</span><span>{P("The SECOND admin sees the credit and who typed the rate, checks it, and approves. The credit posts with the return. The employee sees the credit, never the rate.")}</span></div>
 </div>
 <div class="two">
  <div class="half"><div class="lbl">{P("The return as it reaches both of you")}</div>{card(msg, [ref, "631 · 5 thans · 150 yd", "· sold 02-Nov-2026", "⚠️ No rate on the sale record: solder madam · 44200 · 6 thans. The admin who approves first is asked for it."])}</div>
  <div class="half"><div class="lbl">{P("Every other request starts the same way. Here: a price change Krishna typed, on Musa's phone.")}</div>
   {card(price, [refs["price"]])}
   <div class="box2">{P(f"The short number ({ref}) is the request. Abdul's cards, 📨 My Requests and 🛂 Approvals show the same number.")}</div></div>
 </div>
 <h2 class="mt">The rules, in plain words</h2>
 <ul class="rlist">{"".join(f"<li>{x}</li>" for x in rules)}</ul>
</section>"""

    pop1 = S("d_approve", kind="popup", to="Musa")
    need = S("d_approve", kind="message", to="Musa")
    zero = S("d_zero", to="Musa")
    check1 = S("d_rate", to="Musa")
    rec1 = S("d_confirm", kind="message", to="Musa")
    rec2 = S("d_confirm", kind="edit", to="Musa")
    again = S("d_confirm", to="Krishna")
    pop2 = S("e_approve", kind="popup", to="Krishna")
    check2 = S("e_approve", kind="message", to="Krishna")
    reply = S("e_confirm", kind="message", to="Krishna")

    p2 = f"""
<section class="pg">
 <h2>The first admin (here Musa)</h2>
 <div class="g3">
  <div class="cell"><div class="cap"><span class="num">1</span><span>{P(f"Tap {b('✅ Approve')}. Nothing is approved yet. A pop-up, and the rate card arrives as a reply.")}</span></div>
   {popup(pop1)}{card(need)}</div>
  <div class="cell"><div class="cap"><span class="num">2</span><span>{P(f"Type the rate per yard. 1450, 1,450 and 3.20 are taken. 0, a minus number or {ty('rate 1450')} are refused. A word with no number (or {ty('cancel')}) closes the step: tap {b('✏️ Type the rate')} to open it again.")}</span></div>
   {card(zero, ["⚠️ That is not a rate. Type a number above zero, for example 1450."])}</div>
  <div class="cell"><div class="cap"><span class="num">3</span><span>{P(f"The check card: the credit, and the balance before and after. Tap {end('✅ Approve with this credit')}")}</span></div>
   {card(check1, ["1,450/yd → credit 261,000", "Outstanding 500,000 → 239,000"])}</div>
 </div>
 <table class="btab">
  <tr><td>{b('1,450/yd — last paid by solder madam')}</td><td>{P("The rate this customer last paid for this design. Not shown when there is none.")}</td></tr>
  <tr><td>{b('⏭ No credit for these')}</td><td>{P("You choose, on purpose, that no credit is given for these thans.")}</td></tr>
  <tr><td>{b('✏️ Type the rate')}</td><td>{P("Opens the rate card again (also after the bot restarted).")}</td></tr>
  <tr><td>{b('✖ Not now')} · {b('✏️ Change rate')}</td><td>{P("Not now: nothing approved, the request waits. Change rate: back to the rate card.")}</td></tr>
 </table>
 <div class="g2">
  <div class="cell"><div class="cap"><span class="num">4</span><span>{P("Your two lines after the tap. You gave approval 1 of 2.")}</span></div>
   {card(rec1)}{card(rec2)}</div>
  <div class="cell"><div class="cap"><span class="num">5</span><span>{P("The other admin gets the full card again: the credit and “entered by Musa”.")}</span></div>
   {card(again, ["🔏 1 of 2 — signed by Musa. Yours is the second approval.", "44200 at 1,450/yd — entered by Musa"])}</div>
 </div>
</section>"""

    p3 = f"""
<section class="pg">
 <h2>The second admin (here Krishna)</h2>
 <div class="g2 first">
  <div class="cell"><div class="cap"><span class="num">6</span><span>{P(f"Tap {b('✅ Approve')} on the new card or the old one. Nothing is approved yet: the check card comes first. Tap {end('✅ Approve · credit 261,000')}")}</span></div>
   {popup(pop2)}{card(check2, ["Musa typed this rate. Check it before you approve."])}</div>
  <div class="cell"><div class="cap"><span class="num">7</span><span>{P("Your reply names the credit and the rate. The stock is back. Abdul gets the credit, not the rate.")}</span></div>
   {card(reply, ["↩️ Credited solder madam 261,000 (6 thans, 180 yd).", "✏️ solder madam · 44200 at 1,450/yd, entered by Musa"])}</div>
 </div>"""

    nc_check = S("f_nocredit", kind="edit", to="Musa")
    nc_again = S("f_confirm", to="Krishna")
    nc_check2 = S("f_k_approve", kind="message", to="Krishna")
    nc_reply = S("f_k_confirm", kind="message", to="Krishna")
    p3 += f"""
 <h2 class="mt">When the first admin chooses no credit</h2>
 <div class="sub2">{P("The same return, a second time. Musa taps “⏭ No credit for these”. The statement does not move, and nobody is asked to post anything by hand.")}</div>
 <div class="g4">
  <div class="cell"><div class="cap"><span class="num">1</span><span>{P(f"Musa's check card says “no credit”. He still taps {b('✅ Approve with this credit')} — the button keeps that name. His reply says he entered the rate; he did not.")}</span></div>{card(nc_check, ["no credit"])}</div>
  <div class="cell"><div class="cap"><span class="num">2</span><span>{P("Krishna's card names who chose it.")}</span></div>{card(nc_again, ["⚠️ solder madam · 44200 · 6 thans: no credit — chosen by Musa"])}</div>
  <div class="cell"><div class="cap"><span class="num">3</span><span>{P(f"Krishna's check card and chip {b('✅ Approve · no credit')}")}</span></div>{card(nc_check2, ["Musa chose no credit for these. Check it before you approve."])}</div>
  <div class="cell"><div class="cap"><span class="num">4</span><span>{P("Krishna's reply. Abdul is told “No credit to solder madam — chosen at approval”.")}</span></div>{card(nc_reply, ["↩️ No credit to solder madam — chosen at approval (6 thans, 180 yd)."])}</div>
 </div>
</section>"""

    rows = [
        ("Musa", "Open the return Abdul sent.",
         "It starts “🔔 Approval required · R-…” then “From: Abdul”. No long reference. It says “⚠️ No rate on the sale record: … The admin who approves first is asked for it.”"),
        ("Musa", f"Tap {b('✅ Approve')}", "Pop-up “Type the rate first.” and the card “· rate needed”. Nothing approved yet."),
        ("Musa", "Type 0", "“⚠️ That is not a rate. Type a number above zero, for example 1450.”"),
        ("Musa", f"Type the real rate, like 1450. Then tap {b('✅ Approve with this credit')}",
         "First the check card: “→ credit …” and “Outstanding … → …”. After the tap: “your approval is recorded (1 of 2)”."),
        ("Krishna", "Look at the new card.", "“🔏 1 of 2 — signed by Musa”, the credit, and “— entered by Musa”."),
        ("Krishna", f"Tap {b('✅ Approve')}, then the chip “✅ Approve · credit …”",
         "First “Musa typed this rate. Check it before you approve.” After the chip: “↩️ Credited …” and “entered by Musa”."),
        ("Abdul", "Abdul shows you his phone.", "“✅ Approved · 2 of 2” with “↩️ Credited …”. No rate on it."),
        ("Krishna", "Open the customer's statement (📒, or type Ledger and the name).",
         "The credit is there ONCE, for the amount on the check card. The thans are available again in Inventory."),
        ("both", f"Once more with the second real return. Musa taps “⏭ No credit for these”, then {b('✅ Approve with this credit')}",
         "Krishna's chip reads “✅ Approve · no credit”. The statement does not move. Nobody is told to post by hand."),
        ("any", f"Raise a small price change. Look at its message only. Then the other admin taps {b('❌ Reject')}: it is only a test. Do NOT approve it.",
         "Its message also starts “🔔 Approval required · R-…”, with no line about the buttons. After ❌ Reject the price is unchanged."),
    ]
    trs = []
    for k, (whom, do, see) in enumerate(rows, start=1):
        P(do)
        P(see)
        trs.append(f'<tr><td class="tn">{k}</td><td class="tp">{html.escape(whom)}</td><td class="td">{do}</td><td class="ts">{see}</td>{tick_cells(2)}</tr>')
    p4 = f"""
<section class="pg">
 <h2>Test it — two admin phones and Abdul</h2>
 <div class="rules">
  <div class="rl"><b>{P("Find goods whose sale has no rate: Inventory column J empty or 0, status sold. Find TWO such returns: one for rows 1 to 8, one for row 9. Give Abdul the bale numbers.")}</b></div>
  <div class="rl">{P("Also give Abdul ONE bale sold WITH a rate (column J filled), for his row 6. He only looks at it; nothing is sent.")}
   {P("Best: a whole bale and one than of another bale, sold to the same customer. Use only goods that really came back: approving moves real stock and the real balance.")}</div>
  <div class="rl">Row 6 bale (with a rate): {blank("28mm")} · Return 1: {blank("28mm")} · Return 2: {blank("28mm")}</div>
 </div>
 <table class="tt adm">
  <tr><th>No</th><th>Who</th><th>Do this</th><th>You must see</th><th>Seen?</th><th>What I saw</th></tr>
  {"".join(trs)}
 </table>
 <div class="endrow"><div class="sign">
  <div>Name: <span class="sigl"></span></div><div>Date: <span class="sigl"></span></div>
 </div>
 <div class="sendto">{P("You cannot type into this page: tick on paper, or note row number, Yes or No, what you saw.")}</div></div>
</section>"""
    return [p1, p2, p3, p4]


# ══════════════════════════════════════════════════════════════════════════
# 5. Checks
# ══════════════════════════════════════════════════════════════════════════
CODE_WORDS = ["gap", "gaps", "fill", "fills", "seam", "signoff", "signoffs", "print", "prints", "hash", "executor",
              "actionJSON", "legacy", "flow", "flows", "session", "sessions", "callback", "callbacks", "stepState"]


def check_facts(doc):
    f = doc.get("facts") or {}
    refs = f.get("refs") or {}
    if not refs.get("main") or refs.get("main") == "R-C677" or refs.get("nocredit") == "R-C677":
        die(f"the capture's request references are missing or R-C677 (the owner's real one): {refs}")
    if (f.get("a") or {}).get("new_requests") != 0 or (f.get("b") or {}).get("new_requests") != 0 or (f.get("g") or {}).get("new_requests") != 0:
        die("a look-only card raised a request")
    c = f.get("c") or {}
    if c.get("action") != "return_bundle" or c.get("status") != "pending" or not c.get("stock_unchanged_by_submit"):
        die(f"Abdul's submit did not raise one pending return with no stock change: {c}")
    d = f.get("d") or {}
    if d.get("signed_at_first_tap") != 0 or d.get("signed_after_typing") != 0 or d.get("signed_after_confirm") != 1 or d.get("rate_saved") != [1450]:
        die(f"the first admin's approval is not given only by the confirm chip: {d}")
    e = f.get("e") or {}
    if e.get("signed_before_chip") != 1 or e.get("status") != "approved":
        die(f"the second admin's ✅ Approve signed before the chip, or did not complete: {e}")
    cr = e.get("credits") or []
    if len(cr) != 1 or round(cr[0]["yards"] * cr[0]["rate"]) != 261000:
        die(f"the credit is not 261,000 once: {cr}")
    if "631/1:available" not in (e.get("inventory_after") or "") or "614/1:available" not in e.get("inventory_after"):
        die("the returned thans are not available after approval")
    nf = f.get("f") or {}
    if nf.get("status") != "approved" or nf.get("rate_saved") != ["no credit"] or any(x["yards"] * x["rate"] > 0 for x in nf.get("credits") or []):
        die(f"the no-credit return credited something: {nf}")
    if (f.get("i") or {}).get("action") != "update_price":
        die("scene I did not raise a price change")
    if f.get("ai_asked_total") != 0:
        die("the AI was asked about a typed line")


def check_sheet(sh, html_text):
    ids = {id(c) for c in G.CARDS[SEG]}
    for c in sh.shown:
        if id(c) not in ids:
            die(f"{sh.name}: a card does not come from the capture")
        if sh.only_to and sh.only_to not in c["recipient"]:
            die(f"{sh.name}: shows a card that went to {c['recipient']}, not to {sh.only_to}")
    pool = [c for c in G.CARDS[SEG] if not sh.only_to or sh.only_to in c["recipient"]]
    have = {x for c in pool for row in c["buttons"] for x in row}
    missing = sorted({x for x in sh.buttons if x not in have})
    if missing:
        die(f"{sh.name}: names a button no captured card{' of ' + sh.only_to if sh.only_to else ''} carries: {missing}")
    corpus = []
    for c in pool:
        corpus += [G.plain(c), c["text"]] + [x for row in c["buttons"] for x in row]
    blob = "\n".join(corpus)
    flat = re.sub(r"\s+", " ", blob)
    bad = []
    for chunk in sh.prose:
        t = html.unescape(re.sub(r"<[^>]+>", "", chunk))
        for q in re.findall(r"“([^”]{2,240})”", t):
            pieces = [x.strip() for x in re.split(r"…|\.\.\.", q) if x.strip()]
            if not all(x in blob or re.sub(r"\s+", " ", x) in flat for x in pieces):
                bad.append(q)
    if bad:
        die(f"{sh.name}: quotes words no captured card{' of ' + sh.only_to if sh.only_to else ''} carries: "
            + ", ".join(repr(x) for x in sorted(set(bad))))
    words = html.unescape(re.sub(r"<[^>]+>", " ", " ".join(sh.prose)))
    used = sorted({w for w in CODE_WORDS if re.search(rf"\b{w}\b", words, re.I)})
    if used:
        die(f"{sh.name}: uses the code's words {used}")
    if sh.only_to == "Abdul":
        for bad_rate in ("/yd", "1,450", "1450"):
            if bad_rate in html_text:
                die(f"{sh.name}: Abdul's sheet shows a rate ({bad_rate!r}) — he must never see one")


def check_pdf(pdf, foot_re):
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
        die(f"{pdf.name} has {pages} pages — at most {MAX_PAGES}")
    blank_pages = []
    for n in range(1, pages + 1):
        t = subprocess.run(["pdftotext", "-f", str(n), "-l", str(n), "-layout", str(pdf), "-"],
                           capture_output=True, text=True).stdout
        body = re.sub(foot_re, "", t, flags=re.S)
        if len(re.sub(r"\s+", "", body)) < 40:
            blank_pages.append(n)
    if blank_pages:
        die(f"blank page(s) in {pdf.name}: {blank_pages}")
    print(f"checked {pdf.name}: {pages} pages, none blank")
    return pages


# ══════════════════════════════════════════════════════════════════════════
# 6. Style (the PAY-6 card look, laid out portrait — as the RET-7 guide)
# ══════════════════════════════════════════════════════════════════════════
EXTRA_CSS = """
@page { size: A4 portrait; margin: 10mm 11mm 13mm; }
body { font-size:10.4pt; line-height:1.38; }
.pg { page-break-after: always; }
.pg:last-child { page-break-after: auto; }
h1 { font-size:20pt; margin:1mm 0 1.4mm; }
h2 { font-size:17pt; color:#0e2a47; margin:0 0 1.6mm; letter-spacing:-.3px; }
h2.mt { margin-top:3.4mm; }
.sub { font-size:11.6pt; color:#22303f; margin-bottom:3mm; }
.sub2 { font-size:10.4pt; color:#3d4b59; margin-bottom:2.6mm; }
.small { font-size:9.2pt; }
.nw { white-space:nowrap; }
.hl { background:#f6d860; color:#1b1405; border-radius:.8mm; padding:0 .4mm; }
.hl b { color:#1b1405; }
.shot .tg { padding:1.6mm; }
.shot .txt { font-size:7.4pt; line-height:1.28; }
.shot .kbtn { font-size:6.9pt; padding:.9mm .8mm; }
.shot .bubble { padding:1.8mm 2.2mm 1.6mm; }
.cap .chip, .cap .typed, .ntext .typed, .td .typed { white-space:normal; }
.typed { display:inline; box-decoration-break:clone; -webkit-box-decoration-break:clone; }
.fl .chip { white-space:nowrap; }
.after1 { margin-top:3mm; font-weight:800; color:#1e8449; font-size:10.4pt; }
.g2.first { margin-top:0; }

/* page 1 of Abdul */
.news { display:flex; gap:5mm; margin-bottom:4mm; }
.new { flex:1; border:1.6px solid #1f6fb2; background:#f5f9fd; border-radius:3mm; padding:2.6mm 3mm; break-inside:avoid; }
.nhead { display:flex; align-items:center; gap:2.4mm; font-weight:800; font-size:12.4pt; color:#0e2a47; margin-bottom:1.6mm; }
.nnum { flex:none; display:inline-block; width:7mm; height:7mm; line-height:6.6mm; text-align:center; border-radius:3.5mm;
        background:#1f6fb2; color:#fff; font-weight:900; font-size:10.4pt; margin-right:1.6mm; }
.ntext { font-size:10pt; margin-bottom:2mm; } .ntext p { margin:1.6mm 0 0; }
.ntext.small { font-size:9pt; margin-top:2mm; margin-bottom:0; }
.note { font-weight:800; color:#a3232a; }
.row3 { display:flex; gap:4mm; align-items:flex-start; }
.row3 .ntext { flex:1; } .row3 .c3 { flex:1.05; min-width:0; }

/* the walk */
.cols3 { display:flex; gap:4mm; align-items:flex-start; }
.colm { flex:1; min-width:0; display:flex; flex-direction:column; gap:4mm; }
.cell { break-inside:avoid; min-width:0; }
.cap { display:flex; gap:2mm; align-items:flex-start; font-size:9.3pt; line-height:1.3; margin-bottom:1.4mm; }
.num { flex:none; display:inline-block; width:6.6mm; height:6.6mm; line-height:6.2mm; text-align:center; border-radius:3.3mm;
       background:#1f6fb2; color:#fff; font-weight:900; font-size:10pt; }
.cols3 .shot .txt { font-size:7.6pt; }
.cxrow { margin-top:3mm; border:1.6px solid #1d6fa5; background:#f3f8fd; border-radius:3mm; padding:1.8mm 3mm; break-inside:avoid; }

/* test sheets */
.rules { border:2.6px solid #a3232a; background:#fff4f4; border-radius:3mm; padding:2mm 3.4mm; margin-bottom:2.4mm; font-size:10pt; color:#3a0f12; }
.rules .rl { margin-bottom:1.4mm; } .rules .rl:last-child { margin-bottom:0; }
.parth { background:#1e8449; color:#fff; font-weight:800; font-size:10.6pt; border-radius:2mm 2mm 0 0; padding:1.2mm 3mm; margin-top:1mm; break-after:avoid; }
.parth.p2h { background:#a3232a; margin-top:3mm; }
.tt { width:100%; border-collapse:collapse; font-size:8.9pt; line-height:1.25; }
.tt th { background:#0e2a47; color:#fff; text-align:left; padding:1.2mm 1.6mm; font-size:8.6pt; }
.tt td { border-bottom:1.2px solid #b9c5d0; padding:1.1mm 1.4mm; vertical-align:top; }
.tt tr { break-inside:avoid; }
.tt .tn { width:7mm; font-weight:900; font-size:11.4pt; color:#0e2a47; }
.tt .tp { width:15mm; font-weight:800; color:#0e2a47; }
.tt .td { width:55mm; } .tt .ts { width:52mm; color:#22303f; }
.tt.adm .td { width:50mm; } .tt.adm .ts { width:50mm; }
.tt .tyn { width:15mm; font-size:9pt; white-space:nowrap; } .tt .tyn div { margin-bottom:.8mm; }
.tb { display:inline-block; width:4.2mm; height:4.2mm; border:1.6px solid #0e2a47; border-radius:.8mm; vertical-align:-1mm; margin-right:1mm; background:#fff; }
.tt .tw { width:auto; }
.wl { display:block; border-bottom:1px solid #7d8b99; height:6.8mm; }
.used { margin-top:1.4mm; font-weight:700; color:#0e2a47; }
.blank { display:inline-block; border-bottom:1.4px solid #0e2a47; height:4mm; vertical-align:-1mm; }
.endrow { display:flex; gap:5mm; align-items:center; margin-top:2.4mm; break-inside:avoid; }
.sign { display:flex; flex-direction:column; gap:2mm; font-size:10.6pt; font-weight:700; flex:none; }
.sigl { display:inline-block; width:50mm; border-bottom:1.4px solid #0e2a47; height:5mm; vertical-align:-1mm; }
.sendto { flex:1; font-size:10.4pt; font-weight:800; color:#1e8449; border:2.4px solid #1e8449; border-radius:3mm; padding:1.6mm 3mm; background:#f2fbf5; }
.noprint { font-size:9.4pt; font-weight:600; color:#14532d; margin-top:1mm; }

/* the admins' pages */
.five { border:1.6px solid #1f6fb2; background:#f5f9fd; border-radius:3mm; padding:2.4mm 3.4mm; margin-bottom:3.4mm; }
.fl { display:flex; align-items:flex-start; font-size:10pt; margin-bottom:1.6mm; } .fl:last-child { margin-bottom:0; }
.two { display:flex; gap:5mm; align-items:flex-start; }
.half { flex:1; min-width:0; }
.lbl { font-weight:800; color:#0e2a47; font-size:10.2pt; margin-bottom:1.4mm; }
.box2 { margin-top:3mm; border:1px solid #dde4ea; background:#fbfcfd; border-radius:2.4mm; padding:2.4mm 3mm; font-size:9.6pt; }
.half .shot .txt { font-size:7.9pt; }
.g3 { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:3.4mm; align-items:start; }
.g2 { display:grid; grid-template-columns: 1fr 1fr; gap:3.4mm 5mm; align-items:start; margin-top:2.4mm; }
.g4 { display:grid; grid-template-columns: 1fr 1fr; gap:3mm 5mm; align-items:start; }
.g3 .shot .txt, .g2 .shot .txt, .g4 .shot .txt { font-size:7.1pt; line-height:1.25; }
.g2 .shot + .shot { margin-top:1.6mm; }
.pop { margin-bottom:1.2mm; }
.poplbl { font-size:6.8pt; color:#7d8b99; text-transform:uppercase; letter-spacing:.6px; margin-bottom:.4mm; }
.btab { width:100%; border-collapse:collapse; margin-top:2.4mm; font-size:9pt; }
.btab td { border-bottom:1px solid #dde4ea; padding:1mm 1.6mm; vertical-align:top; }
.btab td:first-child { width:72mm; }
.rlist { margin:0 0 1mm; padding-left:5mm; font-size:10.4pt; } .rlist li { margin-bottom:1.6mm; }
"""


def page(title, foot, body):
    css = G.CSS.replace("@@FOOT@@", foot.replace('"', '\\"')).replace("size: A4 landscape;", "size: A4 portrait;") + EXTRA_CSS
    return (f"<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' content='width=device-width, initial-scale=1'>"
            f"<title>{html.escape(title)}</title><style>{css}</style></head><body>{body}</body></html>")


def fixed_pdf_dates(pdf):
    """Chromium stamps the print time into CreationDate / ModDate. Overwrite the
    digits with the sheets' date (same length), so a rebuild with no change
    leaves the PDF byte for byte the same."""
    raw = pdf.read_bytes()
    out = re.sub(rb"(/(?:CreationDate|ModDate) ?\(D:)\d{14}", rb"\g<1>20261121000000", raw)
    if out != raw:
        pdf.write_bytes(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json")
    ap.add_argument("--save-json")
    ap.add_argument("--out-dir", help="write the HTML and PDF files here instead of docs/")
    ap.add_argument("--no-pdf", action="store_true")
    args = ap.parse_args()
    out_dir = pathlib.Path(args.out_dir) if args.out_dir else DOCS
    out_dir.mkdir(parents=True, exist_ok=True)

    doc = run_capture(args.json, args.save_json)
    G.CARDS[SEG] = normalise(doc)
    G.NAMES[:] = ["Abdul", "Krishna", "Musa"]
    check_facts(doc)
    refs = doc["facts"]["refs"]

    abdul = Sheet("RET-8_TEST_ABDUL", "Returns — test sheet for Abdul", "RET-8 test sheet · Abdul", only_to="Abdul")
    admins = Sheet("RET-8_TEST_ADMINS", "Returns with no rate — test sheet for the admins", "RET-8 test sheet · admins")
    builds = [(abdul, abdul_pages(abdul)), (admins, admin_pages(admins, refs))]

    for sh, pages in builds:
        foot = f"black_panther bot · {sh.short} · built {DATE} · {REBUILD} · page "
        text = page(sh.title, foot, "".join(pages))
        check_sheet(sh, text)
        hp = out_dir / f"{sh.name}.html"
        hp.write_text(text, encoding="utf-8")
        print("wrote", hp)
        if not args.no_pdf:
            pdf = out_dir / f"{sh.name}.pdf"
            G.print_pdf(hp, pdf)
            fixed_pdf_dates(pdf)
            check_pdf(pdf, r"black_panther bot · .*?page \d+")


if __name__ == "__main__":
    main()
