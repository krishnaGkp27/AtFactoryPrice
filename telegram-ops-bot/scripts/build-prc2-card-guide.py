#!/usr/bin/env python3
"""PRC-2 — "Payment Received: ask an admin", screen by screen and phone by
phone: a test guide built from the bot's REAL cards.

Writes (A4 landscape):
    docs/PRC-2_CARDS.html + docs/PRC-2_CARDS.pdf

Rebuild (from telegram-ops-bot/, after any wording change in the bot):
    python3 scripts/build-prc2-card-guide.py

How it works
  1. It runs scripts/prc2-capture/capture.js once per scene (A, B, C, D) with
     node, working directory telegram-ops-bot. Each run drives the bot's real
     code offline (fake Telegram, fake Sheets, a fixed clock on 16-Nov-2026,
     fixed request ids) and prints every message, edit and pop-up the bot sent,
     to each phone, as JSON.
  2. The storyboard below picks each card it shows by its scene and the step
     key the capture gave it (and, where one step sent several, by phone, kind
     or text). A pick that matches no card, or more than one, STOPS the build.
  3. Checks that stop the build: every card shown comes from a capture; every
     button named in a "Do:" line exists on a captured card; every “…” quote in
     the guide's own words (captions, intros, the at-a-glance strip, the
     checklist) is found on a captured card; no card on Abdul's phone carries
     "Outstanding" or a balance figure; the PDF exists and no page is blank.
  4. The look and the Telegram renderer are the PAY-6 guide's: this script
     imports scripts/build-pay6-card-guides.py and reuses its renderer, step
     layout and style without changing that file.

Options
    --json-dir DIR   read A.json … D.json from DIR instead of running the captures
    --save-json DIR  also save the captures' JSON there
    --no-pdf         write the HTML only

Standard library only (plus Chromium to print, and pdfinfo / pdftotext for
the blank-page check).
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
DATE = "16-Nov-2026"
SCENES = ["A", "B", "C", "D"]
NAME = "PRC-2_CARDS"

# ── the PAY-6 builder, imported (never modified) ─────────────────────────
sys.dont_write_bytecode = True  # importing the PAY-6 builder leaves no __pycache__ in the repo
_spec = importlib.util.spec_from_file_location("pay6guide", BOT / "scripts" / "build-pay6-card-guides.py")
G = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(G)

# The cast of this guide. A person's colour never changes (same as PAY-6).
G.PEOPLE["Abdul"]["role"] = "Lagos office manager · employee · records the payment"
G.PEOPLE["Musa"]["role"] = "admin · the admin Abdul asks first"
G.PEOPLE["Krishna"]["role"] = "owner · admin · gives the other approval"
G.NAMES[:] = ["Abdul", "Musa", "Krishna"]
die = G.die
b, ty, badge = G.b, G.ty, G.badge
Card, Pop, Gone, Step, Part = G.Card, G.Pop, G.Gone, G.Step, G.Part


def phone_label(names, you=None, kind=""):
    """A clear coloured label: whose phone this card is on."""
    pills = "".join(
        f'<span class="phonepill" style="background:{G.PEOPLE[n]["color"]}">📱 {html.escape(G.PEOPLE[n]["pos"])} phone</span>'
        for n in names)
    extra = f'<span class="pkind">{html.escape(kind)}</span>' if kind else ""
    return f'<div class="onphone">{pills}{extra}</div>'


G.phone_label = phone_label  # render_items looks it up in the module


# ══════════════════════════════════════════════════════════════════════════
# 1. The captures
# ══════════════════════════════════════════════════════════════════════════
def run_captures(json_dir=None, save_dir=None):
    data = {}
    for sc in SCENES:
        if json_dir:
            data[sc] = json.loads((pathlib.Path(json_dir) / f"{sc}.json").read_text(encoding="utf-8"))
            continue
        print(f"capture: node scripts/prc2-capture/capture.js --scene {sc}", file=sys.stderr)
        with tempfile.TemporaryFile(mode="w+b") as out:
            p = subprocess.run(["node", "scripts/prc2-capture/capture.js", "--scene", sc], cwd=str(BOT),
                               stdout=out, stderr=subprocess.PIPE, env=dict(os.environ))
            out.seek(0)
            raw = out.read().decode("utf-8")
        if p.returncode != 0:
            sys.stderr.write(p.stderr.decode("utf-8", "replace")[-4000:])
            die(f"capture of scene {sc} exited {p.returncode}")
        try:
            data[sc] = json.loads(raw)
        except ValueError as e:
            die(f"capture of scene {sc} did not print one JSON document ({e})")
        if save_dir:
            pathlib.Path(save_dir).mkdir(parents=True, exist_ok=True)
            (pathlib.Path(save_dir) / f"{sc}.json").write_text(raw, encoding="utf-8")
    return data


def normalise(data):
    """Each scene's visible cards in the PAY-6 builder's shape. The step label
    starts with the capture's step key, so a pick can name the step exactly."""
    out = {}
    for sc, doc in data.items():
        lst = doc.get("cards")
        if not isinstance(lst, list):
            die(f"scene {sc}: no card list in its JSON")
        out[sc] = [{
            "seg": sc, "i": i,
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
    return out


def S(sc, key, to=None, kind=None, text=None):
    """Exactly one captured card of scene `sc`, step key `key`."""
    return G.S(sc, step=f"{key} |", to=to, kind=kind, text=text)


# ══════════════════════════════════════════════════════════════════════════
# 2. The storyboard
# ══════════════════════════════════════════════════════════════════════════
def parts():
    p1 = Part("Part 1", "Abdul knows the amount and asks Musa",
              "ABBA owes 120,000. She pays 50,000 into Zenith. Abdul records it and asks <b>Musa</b> first. "
              "Musa approves, then Krishna approves. Only then does ABBA's balance move.", [
        Step("Abdul", f"Type {ty('menu')}. Tap {b('💰 Finance')}. Tap {b('💵 Payment Received')}.",
             [Card(S("A", "a_menu")), Card(S("A", "a_fin")), Card(S("A", "a_open"))],
             "The same message changes after each tap."),
        Step("Abdul", f"Tap {b('👤 ABBA')}. Type {ty('50000')}. Tap {b('🏦 Zenith')}.",
             [Card(S("A", "a_pick")), Card(S("A", "a_amount")), Card(S("A", "a_bank"), new=True)],
             "The last screen is new: “Who should approve it?”. It lists the admins, never Abdul himself."),
        Step("Abdul", f"Tap {b('🛂 Musa')}. Check the card. Tap {b('✅ Submit for approval')}.",
             [Card(S("A", "a_ask"), new=True), Card(S("A", "a_submit", to="Abdul"), new=True),
              Card(S("A", "a_submit", to="Musa"), new=True, wide=True)],
             "The card says “Ask: Musa”. The receipt says “Sent to Musa for approval”; no balance is shown to Abdul. "
             "The approval card arrives on <b>Musa's phone only</b> — Krishna's phone gets no message. "
             "“Outstanding today” and “After this payment” are for admins only."),
        Step("Krishna", f"{b('📋 More Options (9)')} → {b('🛂 Approvals')} → "
                        f"{b('💵 Finance — 1 ⚠️ 🟢today')} → the row.",
             [Card(S("A", "a_inbox")), Card(S("A", "a_cat")), Card(S("A", "a_item"), new=True)],
             "Krishna can see it and decide it. Only the card says “🙋 Asked: Musa”, not the list row."),
        Step("Musa", f"Tap {b('✅ Approve')} on his card.",
             [Pop(S("A", "a_mok", kind="popup")), Card(S("A", "a_mok", to="Musa", kind="message")),
              Card(S("A", "a_mok", to="Abdul")), Card(S("A", "a_mok", to="Krishna"), new=True, wide=True)],
             "Approval 1 of 2. Musa's card loses its buttons. Abdul is told. Krishna now gets the FULL card: "
             "“Yours is the second approval.”"),
        Step("Krishna", f"Tap {b('✅ Approve')} on the card he received. To check the balance yourself, "
                        f"type {ty('Balance ABBA')}.",
             [Pop(S("A", "a_kok", kind="popup")),
              Card(S("A", "a_kok", to="Krishna", text="Changes applied")),
              Card(S("A", "a_kok", to="Krishna", text="Outstanding as of today")),
              Card(S("A", "a_kok", to="Abdul", kind="message")),
              Card(S("A", "a_bal0"), edit_note="Balance ABBA, before Abdul's request", check=False),
              Card(S("A", "a_bal1"), edit_note="Balance ABBA, after the two approvals", check=False)],
             "Approval 2 of 2: recorded. ABBA's balance moves from 120,000 to 70,000 — admins only. "
             "Abdul's card has no balance."),
    ])

    p2 = Part("Part 2", "Abdul does not know the amount",
              "Same payment, but Abdul does not know how much ABBA paid. Musa types the amount when he approves. "
              "Krishna checks Musa's figure before he approves.", [
        Step("Abdul", f"Open {b('💵 Payment Received')}, tap {b('👤 ABBA')}, then tap {b('⏭ Amount not known')}. "
                      f"Tap {b('🏦 Zenith')}.",
             [Card(S("B", "b_bank"), new=True)],
             "The bank list is the same as in Part 1 (step 2). From now on the amount line reads "
             "“Amount: to be entered by the admin”."),
        Step("Abdul", f"Tap {b('🛂 Musa')}. Check. Tap {b('✅ Submit for approval')}.",
             [Card(S("B", "b_ask"), new=True), Card(S("B", "b_submit", to="Abdul"), new=True)],
             "The card adds one sentence: “The admin enters the amount.”"),
        Step("Musa", f"The card arrives (“Amount: not entered”). Tap {b('✅ Approve')}.",
             [Card(S("B", "b_submit", to="Musa"), new=True, edit_note="the card that arrives"),
              Pop(S("B", "b_mok", kind="popup")), Card(S("B", "b_mok", to="Musa", kind="message"), new=True)],
             "Nothing is approved yet. The bot asks Musa to type the amount, as a reply under the card."),
        Step("Musa", f"Type {ty('abc')} (a wrong value, on purpose). Then type {ty('50000')}.",
             [Card(S("B", "b_bad"), new=True), Card(S("B", "b_amt"), new=True)],
             "A wrong value: “That is not an amount.” A good one: the same message becomes the check card."),
        Step("Musa", f"Tap {b('✅ Approve with 50,000')}.",
             [Pop(S("B", "b_ay", kind="popup")), Card(S("B", "b_ay", to="Musa", kind="edit", text="You entered"), new=True),
              Card(S("B", "b_ay", to="Musa", kind="message")),
              Card(S("B", "b_ay", to="Abdul"), new=True), Card(S("B", "b_ay", to="Krishna"), new=True, wide=True)],
             "Abdul reads “Amount entered by Musa: 50,000”. Krishna's card reads “50,000 · entered by Musa”."),
        Step("Krishna", f"Tap {b('✅ Approve')} on that card.",
             [Pop(S("B", "b_kok", kind="popup")), Card(S("B", "b_kok", to="Krishna", kind="message"), new=True)],
             "Nothing is recorded yet. Krishna must check the amount another admin typed."),
        Step("Krishna", f"Tap {b('✅ Approve 50,000')}.",
             [Pop(S("B", "b_kok2", kind="popup")), Card(S("B", "b_kok2", to="Krishna", kind="edit", text="is recorded"), new=True),
              Card(S("B", "b_kok2", to="Krishna", text="Changes applied")),
              Card(S("B", "b_kok2", to="Abdul"))],
             "Recorded. Abdul's last card keeps the line “Amount entered by Musa”."),
    ])

    p3 = Part("Part 3", "Musa does not answer",
              "Abdul asks Musa (as in Part 1), and Musa does not answer. Here Abdul submits at 10:00. "
              "The bot re-sends waiting cards by itself; in this test it does so every 6 hours "
              "(the Settings default, APPROVAL_REMINDER_HOURS = 6).", [
        Step("Abdul", f"Record 50,000 from ABBA, tap {b('🛂 Musa')}, tap {b('✅ Submit for approval')} at 10:00.",
             [Card(S("C", "c_submit", to="Abdul"))], "Same as Part 1, steps 1–3."),
        Step("Bot", "Nothing to tap. At 11:00 the bot sends its first reminder.",
             [Card(S("C", "c_rem1", to="Musa"), new=True, wide=True)],
             "Musa only. Krishna gets nothing yet.", who_label="Bot · 11:00"),
        Step("Abdul", f"At 11:10 tap {b('🔔 Remind approvers')} on the receipt.",
             [Pop(S("C", "c_nudge", kind="popup")), Card(S("C", "c_nudge", to="Abdul", kind="message")),
              Card(S("C", "c_nudge", to="Musa"), wide=True)],
             "Still Musa only: the 4 hours are not over. “You can remind again in 24h.”"),
        Step("Bot", "Nothing to tap. After 4 hours (Settings <code>ASKED_ADMIN_WIDEN_HOURS</code>) the request is open to every "
                    "admin. The next reminder round, at 17:00, goes to Krishna too.",
             [Card(S("C", "c_hour17", to="Krishna"), new=True, wide=True,
                   also=[S("C", "c_hour17", to="Musa")])],
             "No reminder came between 12:00 and 16:00: the bot's timer runs every hour, but sends again only "
             "after 6 hours. So the wider reminder came 7 hours after the request, not 4.",
             who_label="Bot · 17:00"),
        Step("Krishna", f"Open {b('🛂 Approvals')} → {b('💵 Finance — 1 ⚠️ 🟢today')} → the row.",
             [Card(S("C", "c_item"), new=True)],
             "The card says Musa has not answered and any admin may approve."),
        Step("Krishna", f"Tap {b('✅ Approve')} — without waiting for Musa.",
             [Pop(S("C", "c_kok", kind="popup")), Card(S("C", "c_kok", to="Krishna", text="still pending")),
              Card(S("C", "c_kok", to="Abdul")), Card(S("C", "c_kok", to="Musa"))],
             "Krishna's is the first approval. Musa gets one line: he already has the card, and his is now the second approval."),
    ])

    p4 = Part("Note", "👥 Any admin — as before",
              "If Abdul taps 👥 Any admin, nothing new happens: both admins get the ordinary card at once.", [
        Step("Abdul", f"Tap {b('👥 Any admin')} instead of a name, then {b('✅ Submit for approval')}.",
             [Card(S("D", "d_ask")), Card(S("D", "d_submit", to="Abdul")),
              Card(S("D", "d_submit", to="Krishna"), wide=True, also=[S("D", "d_submit", to="Musa")])],
             "No “Ask:” line, no “🙋” line. The receipt says “Sent for approval”."),
    ])
    return [p1, p2, p3, p4]


# ══════════════════════════════════════════════════════════════════════════
# 3. Cover, at-a-glance strip, checklist
# ══════════════════════════════════════════════════════════════════════════
def cover():
    cast = "".join(f'<div class="castrow">{badge(n)}<span>{html.escape(G.PEOPLE[n]["role"])}</span></div>'
                   for n in G.NAMES)
    return f"""
<section class="cover">
 <div class="brand">black_panther bot (formerly AtFactoryPrice) · test guide · {DATE}</div>
 <h1>Payment Received — ask an admin</h1>
 <div class="sub">Every screen, chip and card of this change, phone by phone, taken from the bot's own code word for word.
 Test it on your phones and tick each step.</div>
 <div class="three">
  <div class="box"><div class="btitle">What is new</div>
   <p>1. After “How was it paid?”, a new screen: <b>“Who should approve it?”</b> Abdul taps one admin, or 👥 Any admin.</p>
   <p>2. Only the admin he picks gets the card first. The other admins still find it in 🛂 Approvals.</p>
   <p>3. If Abdul does not know the amount, he taps <b>⏭ Amount not known</b>. The first admin types it; the second admin checks it.</p>
   <p>4. If the admin does not answer for 4 hours, the reminders go to every admin.</p></div>
  <div class="box"><div class="btitle">Who is who</div>{cast}
   <p class="small">Customer <b>ABBA</b> owes 120,000. She pays <b>50,000</b> into Zenith. Two admin approvals are
   needed before her balance moves — this does not change.</p></div>
  <div class="box before"><div class="btitle">Before you test</div>
   <ul>
    <li>Abdul's department must have the tile <b>payment_received</b> (Departments sheet, allowed_activities).</li>
    <li>There must be <b>two admins besides the person who records the payment</b>. With only one, the bot skips
    the “Who should approve it?” screen.</li>
    <li>The bank (here Zenith) must be listed in <b>🏦 Manage Banks</b>.</li>
   </ul></div>
 </div>
 {G.legend_html()}
</section>"""


# (the person who acts, what they do, {phone: what arrives}, now waiting on)
LANE = [
    ("Abdul", "Records 50,000 from ABBA · taps 🛂 Musa · submits", {"Musa": "the card: “Abdul asks YOU to approve this.”"}, "Musa"),
    ("Krishna", "Opens 🛂 Approvals (optional)", {"Krishna": "the card with “🙋 Asked: Musa”"}, "Musa (or Krishna)"),
    ("Musa", "Taps ✅ Approve — 1 of 2", {"Abdul": "“Approval 1 of 2”", "Krishna": "full card: “Yours is the second approval.”"}, "Krishna"),
    ("Krishna", "Taps ✅ Approve — 2 of 2", {"Abdul": "“Approved · 2 of 2”", "Krishna": "“Outstanding as of today: 70,000”"}, "nobody — recorded"),
]


def glance():
    names = G.NAMES
    head = ['<div class="lh lstep">No</div>']
    for n in names:
        head.append(f'<div class="lh">{badge(n)}<div class="lrole">{html.escape(G.PEOPLE[n]["role"])}</div></div>')
    head.append('<div class="lh lwait">Now waiting on</div>')
    rows = []
    for k, (actor, does, recv, wait) in enumerate(LANE):
        rows.append(f'<div class="lc lstep"><b>{k + 1}</b></div>')
        for n in names:
            c = G.PEOPLE[n]["color"]
            parts_ = []
            if n == actor:
                parts_.append(f'<div class="ldo" style="background:{c}">{html.escape(does)}</div>')
            if n in recv:
                parts_.append(f'<div class="lget" style="border-color:{c}">gets {html.escape(recv[n])}</div>')
            rows.append(f'<div class="lc"><div class="lline" style="border-color:{c}"></div>'
                        f'<div class="lstack">{"".join(parts_)}</div></div>')
        rows.append(f'<div class="lc lwait">⏳ {html.escape(wait)}</div>')
    return (f'<section class="lanepage"><div class="lanebox"><div class="ltitle">Part 1 at a glance — who does what, in order</div>'
            f'<div class="lane prc">{"".join(head)}{"".join(rows)}</div>'
            '<div class="lfoot">Read down: each row is one moment. A filled box is the person who acts; an outlined box is '
            'what arrives on that phone. Krishna\'s phone gets nothing in row 1.</div></div>'
            + whatelse() + '</section>')


def whatelse():
    return """
<div class="three glance2">
 <div class="box"><div class="btitle">Part 2 — amount not known</div><p>Abdul taps ⏭ Amount not known. Musa taps ✅ Approve,
 types the amount, taps “✅ Approve with 50,000”. Krishna taps ✅ Approve, checks the figure, taps “✅ Approve 50,000”.</p></div>
 <div class="box"><div class="btitle">Part 3 — Musa does not answer</div><p>The first reminder goes to Musa only.
 After 4 hours the next reminder also goes to Krishna, and Krishna approves without waiting for Musa.</p></div>
 <div class="box"><div class="btitle">Note — 👥 Any admin</div><p>Both admins get the ordinary card at once, as before this change.</p></div>
</div>"""


# No · Who · Do this · You should see. “…” quotes are checked against the captures.
KEYS = ["a1", "a2", "a3", "a5", "a6", "a7", "b1", "b2", "b3", "b4", "b5", "b6", "b7",
        "c1", "c2", "c3", "c4", "c5", "c6", "d1"]
CHECKS = [
    ("a1–a2", "Abdul", "💰 Finance → 💵 Payment Received → 👤 ABBA → type 50000 → 🏦 Zenith",
     "New screen “Who should approve it?” with 🛂 Krishna, 🛂 Musa, 👥 Any admin — never Abdul."),
    ("a3", "Abdul", "Tap 🛂 Musa", "“Ask: Musa” and “Musa is asked first.”"),
    ("a3", "Abdul", "Tap ✅ Submit for approval", "“Sent to Musa for approval”. No balance on Abdul's phone."),
    ("a3", "Musa", "Nothing — wait", "Card with “Abdul asks YOU to approve this.” Krishna's phone: no message."),
    ("a5", "Krishna", "🛂 Approvals → 💵 Finance → the row", "The card shows “🙋 Asked: Musa” with ✅ Approve."),
    ("a6", "Musa", "Tap ✅ Approve", "Abdul: “Approval 1 of 2”. Krishna: “1 of 2 — signed by Musa. Yours is the second approval.”"),
    ("a7", "Krishna", "Tap ✅ Approve", "Abdul: “Approved · 2 of 2”. Krishna: “Outstanding as of today: 70,000”."),
    ("b1", "Abdul", "Same door → ⏭ Amount not known → 🏦 Zenith", "“Amount: to be entered by the admin”."),
    ("b2", "Abdul", "🛂 Musa → ✅ Submit for approval", "“The admin enters the amount.” on the card; “Sent to Musa for approval”."),
    ("b3", "Musa", "Tap ✅ Approve on the card", "Card says “Amount: not entered”. Pop-up “Type the amount first.” and the amount question."),
    ("b4", "Musa", "Type abc, then 50000", "“That is not an amount.” then the check card with “✅ Approve with 50,000”."),
    ("b5", "Musa", "Tap ✅ Approve with 50,000", "“You entered 50,000 and gave approval 1 of 2.” Abdul: “Amount entered by Musa: 50,000”."),
    ("b6–b7", "Krishna", "Tap ✅ Approve, then ✅ Approve 50,000", "Pop-up “Check the amount first.”, then “50,000 from ABBA is recorded.”"),
    ("c2", "Musa", "Do not answer; wait for the first reminder", "Musa only: “Abdul asked YOU to approve this”. Krishna: nothing."),
    ("c3", "Abdul", "Tap 🔔 Remind approvers", "“Reminder sent to Musa.” and “You can remind again in 24h.”"),
    ("c4", "Krishna", "Wait: the next reminder round after 4 hours (17:00 here)", "“no answer for 7h. Any admin may approve.” (the hours can differ)"),
    ("c6", "Krishna", "🛂 Approvals → the row → ✅ Approve", "Musa gets one line: “has its first admin approval and needs a SECOND”."),
    ("d1", "Abdul", "Tap 👥 Any admin → ✅ Submit for approval", "Both admins get the card at once; no “Asked” line. “Sent for approval”."),
]


def step_no(ref, nums):
    return "–".join(str(nums[r]) for r in ref.split("–"))


def checklist(nums):
    rows = []
    for k, (ref, who, do, see) in enumerate(CHECKS):
        step = step_no(ref, nums)
        rows.append(f'<tr><td class="cn">{k + 1}</td><td class="cs">{html.escape(step)}</td><td>{badge(who)}</td>'
                    f'<td>{html.escape(do)}</td><td>{html.escape(see)}</td><td class="cb">☐</td></tr>')
    return f"""
<section class="part"><div class="pband"><span class="pkey">✓</span><span class="ptitle">Test checklist</span></div>
<div class="pintro">One line per check. “Step” is the step number in this guide. Tick the box when the phone shows it.</div>
<table class="cklist"><tr><th>No</th><th>Step</th><th>Who</th><th>Do this</th><th>You should see</th><th>OK</th></tr>
{"".join(rows)}</table>
<div class="golden"><div class="gbody">If a step does not match: send Krishna a screenshot and the step number.</div>
<div class="gwhy">Send the whole card, with its buttons. A different word, a missing line, a different button, or a message on the
wrong phone all count. Do not tap anything else on that card until Krishna answers.</div></div>
</section>"""


# ══════════════════════════════════════════════════════════════════════════
# 4. Checks
# ══════════════════════════════════════════════════════════════════════════
BALANCE_FIGURES = ("120,000", "70,000", "120000", "70000")


def check_abdul_phone(data, prts):
    """No card on Abdul's phone — shown in the guide or captured at all — carries
    "Outstanding" or a balance figure."""
    bad = []
    for sc, lst in G.CARDS.items():
        for c in lst:
            if "Abdul" not in c["recipient"]:
                continue
            t = c["text"] + " " + " ".join(x for r in c["buttons"] for x in r)
            if "Outstanding" in t or any(f in t for f in BALANCE_FIGURES) or re.search(r"[Bb]alance\s*:?\s*[\d,]{3,}", t):
                bad.append(f"scene {sc} #{c['i']} {c['step'][:60]!r}")
    if bad:
        die("a card on Abdul's phone shows a balance: " + "; ".join(bad))
    for p in prts:
        for st in p.steps:
            for it in st.items:
                if isinstance(it, Gone):
                    continue
                if "Abdul" in G.phones_of(it.card) and "Outstanding" in it.card["text"]:
                    die(f"the guide shows Abdul a balance: step {st.num}")


def check_facts(data):
    """The claims the prose makes about who received what, from the capture's own facts."""
    fa = data["A"]["facts"]
    if fa.get("krishna_messages_at_submit") != 0 or fa.get("musa_messages_at_submit") != 1:
        die("scene A: the guide says only Musa gets the card at submit — the capture disagrees")
    if fa.get("ledger_balance_before") != 120000 or (fa.get("after_krishna") or {}).get("ledger_balance") != 70000:
        die("scene A: ABBA's balance did not move 120,000 → 70,000")
    fc = data["C"]["facts"]
    if fc.get("reminder_1") != {"musa": 1, "krishna": 0, "abdul": 0}:
        die("scene C: the first reminder did not go to Musa only")
    if fc.get("nudge") != {"musa": 1, "krishna": 0}:
        die("scene C: 🔔 Remind approvers did not go to Musa only")
    hourly = fc.get("hourly_timer") or []
    quiet = [h for h in hourly if h["at"] != "17:00"]
    if any(h["musa"] or h["krishna"] for h in quiet) or not any(h["at"] == "17:00" and h["krishna"] == 1 for h in hourly):
        die("scene C: the guide says no reminder between 12:00 and 16:00 and one to Krishna at 17:00 — the capture disagrees")
    if data["D"]["facts"].get("asked_admin_on_row") is not None:
        die("scene D: 👥 Any admin recorded an asked admin")


def check_pdf(pdf):
    if not pdf.exists() or pdf.stat().st_size < 10000:
        die(f"{pdf} was not produced")
    for tool in ("pdfinfo", "pdftotext"):
        if not shutil.which(tool):
            die(f"{tool} is needed for the blank-page check (apt install poppler-utils)")
    info = subprocess.run(["pdfinfo", str(pdf)], capture_output=True, text=True).stdout
    m = re.search(r"^Pages:\s+(\d+)", info, re.M)
    if not m:
        die("pdfinfo could not read the page count")
    pages = int(m.group(1))
    blank = []
    for n in range(1, pages + 1):
        t = subprocess.run(["pdftotext", "-f", str(n), "-l", str(n), "-layout", str(pdf), "-"],
                           capture_output=True, text=True).stdout
        body = re.sub(r"black_panther bot \(formerly AtFactoryPrice\).*?page \d+", "", t)
        if len(re.sub(r"\s+", "", body)) < 40:
            blank.append(n)
    if blank:
        die(f"blank page(s) in the PDF: {blank}")
    print(f"checked {pdf.name}: {pages} pages, none blank")
    return pages


# ══════════════════════════════════════════════════════════════════════════
# 5. Style additions (on top of the PAY-6 style)
# ══════════════════════════════════════════════════════════════════════════
EXTRA_CSS = """
.phonepill { display:inline-block; color:#fff; font-weight:800; font-size:7.6pt; border-radius:1.4mm; padding:.3mm 1.8mm; margin:0 1mm .4mm 0; }
.sl code { overflow-wrap:anywhere; word-break:break-all; }
.pkind { font-size:7pt; color:#5d6b79; font-weight:700; }
.onphone { margin-bottom:1mm; }
.before { border:2px solid #b8860b; background:#fffaf0; }
.before ul { margin:0; padding-left:4.5mm; } .before li { margin-bottom:1.6mm; }
.lane.prc { grid-template-columns: 11mm repeat(3, 1fr) 40mm; }
.lstack { position:relative; width:100%; display:flex; flex-direction:column; gap:1.4mm; }
.lane.prc .lc { min-height:20mm; }
.glance2 { margin-top:5mm; }
.cklist { width:100%; border-collapse:collapse; font-size:7.8pt; margin-top:1mm; }
.cklist th { background:#0e2a47; color:#fff; text-align:left; padding:1.2mm 2mm; font-size:8pt; }
.cklist td { border-bottom:1px solid #d5dde5; padding:.45mm 2mm; vertical-align:top; }
.cklist .cn { font-weight:800; color:#0e2a47; width:8mm; } .cklist .cs { width:13mm; color:#3d4b59; }
.cklist .cb { font-size:13pt; color:#1c6b45; width:9mm; text-align:center; }
.cklist .badge { font-size:8pt; }
.golden { margin-top:2mm; padding:1.8mm 4mm; } .cklist .cb { font-size:11pt; } .gbody { font-size:11.4pt; }
.col { width:47mm; } .col.wide { width:62mm; }
.flow .txt { font-size:6.9pt; line-height:1.2; }
.flow .kbtn { font-size:6.8pt; padding:.75mm .8mm; }
.flow .bubble { padding:1.6mm 2mm 1.4mm; }
.flow .tg { padding:1.6mm; }
.flow .krow { margin-top:.8mm; }
.flow .sl { width:50mm; }
.flow .then { margin:1mm 0 .6mm; }
.flow .pintro { margin:1.6mm 0 2mm; }
.flow .part { margin-top:3mm; }
"""

FOOT = f"black_panther bot (formerly AtFactoryPrice) · Payment Received — ask an admin · {DATE} · page "


def page(body):
    css = G.CSS.replace("@@FOOT@@", FOOT.replace('"', '\\"')) + EXTRA_CSS
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>Payment Received — ask an admin</title>"
            f"<style>{css}</style></head><body>{body}</body></html>")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json-dir")
    ap.add_argument("--save-json")
    ap.add_argument("--no-pdf", action="store_true")
    args = ap.parse_args()

    data = run_captures(args.json_dir, args.save_json)
    G.CARDS.update(normalise(data))
    for lst in G.CARDS.values():
        for c in lst:
            for row in c["buttons"]:
                G.ALL_BUTTONS.update(row)

    prts = parts()
    G.number_steps(prts)
    G.collect_prose(prts)
    G.PROSE.append(cover())
    G.PROSE.append(whatelse())
    G.PROSE.extend(x for row in LANE for x in [row[1], row[3], *row[2].values()])
    G.PROSE.extend(x for row in CHECKS for x in row[1:])
    G.check_buttons()
    G.check_quotes()
    check_abdul_phone(data, prts)
    check_facts(data)
    steps = [st for p in prts for st in p.steps]
    if len(steps) != len(KEYS):
        die(f"the storyboard has {len(steps)} steps but KEYS names {len(KEYS)}")
    nums = {k: st.num for k, st in zip(KEYS, steps)}
    for ref, *_ in CHECKS:
        for r in ref.split("–"):
            if r not in nums:
                die(f"the checklist names step {r!r}, which the guide does not have")

    body = [cover(), glance(),
            '<section class="flow">' + "".join(G.render_part(p) for p in prts) + "</section>",
            checklist(nums)]
    doc = page("".join(body))
    hp = DOCS / f"{NAME}.html"
    hp.write_text(doc, encoding="utf-8")
    print("wrote", hp)
    if not args.no_pdf:
        pdf = DOCS / f"{NAME}.pdf"
        G.print_pdf(hp, pdf)
        check_pdf(pdf)


if __name__ == "__main__":
    main()
