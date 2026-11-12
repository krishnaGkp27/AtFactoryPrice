#!/usr/bin/env python3
"""PAY-6 — the payment journey, card by card: two staff guides built from the
bot's REAL cards.

Writes (A4 landscape):
    docs/PAY-6_CARDS_OWNER.html + .pdf   the owner's copy — every card on every phone,
                                         the finance-phone set-up, the paying accounts
    docs/PAY-6_CARDS_ABDUL.html + .pdf   Abdul's copy — only what HE taps and sees

Rebuild (from telegram-ops-bot/, after any wording change in the bot):
    python3 scripts/build-pay6-card-guides.py

How it works
  1. It runs the five capture scripts in scripts/pay6-capture/ (register, request,
     finance, received, setup) with node, working directory telegram-ops-bot. Each
     drives the bot's real code offline (fake Telegram, fake Sheets, a fixed clock)
     and prints every message the bot sends as JSON: the text exactly as sent, with
     its Markdown symbols, and the buttons as rows.
  2. The storyboard below says which cards appear, in what order, with what
     plain-words caption. Each entry picks ONE card by its segment and an exact part
     of its step label (`step=`, `=` in front = the whole label) and/or of its text
     (`text=`). An entry that matches no card, or more than one, STOPS the build
     with an error — a wording change in the bot can never leave a stale guide.
     Every button named in a "Do:" line is checked against the captured buttons too,
     and every “…” quote in the guide's own words (captions, intros, info boxes, the
     swim-lane) must be found in a captured card — so a quote can never go stale.
  3. The cards are drawn the way the phone shows them (*bold*, _dim italic_,
     `mono`; MarkdownV2 backslashes removed) and both PDFs are printed with
     headless Chromium.

Options
    --json-dir DIR   read <segment>.json from DIR instead of running the captures
    --save-json DIR  also save the captures' JSON there
    --no-pdf         write the HTML only

Standard library only.
"""
import argparse
import glob
import html
import json
import os
import pathlib
import re
import shutil
import subprocess
import tempfile
import sys

BOT = pathlib.Path(__file__).resolve().parents[1]
DOCS = BOT / "docs"
DATE = "11-Nov-2026"
SEGMENTS = ["register", "request", "finance", "received", "setup"]
FOOT = "black_panther bot (formerly AtFactoryPrice) · Payments, card by card · {copy} · " + DATE + " · page "

# The cast — a person's colour never changes.
PEOPLE = {
    "Abdul": {"color": "#1f6fb2", "role": "Lagos office manager · employee", "pos": "Abdul's"},
    "Krishna": {"color": "#1e8449", "role": "owner · admin 1 · gives the first approval", "pos": "Krishna's"},
    "Musa": {"color": "#7b3fa8", "role": "admin 2 · gives the last approval", "pos": "Musa's"},
    "Finance": {"color": "#d9730d", "role": "the finance phone · the person who pays", "pos": "the finance"},
    "Bot": {"color": "#5b6b7b", "role": "", "pos": "the bot's"},
}
NAMES = ["Abdul", "Krishna", "Musa", "Finance"]


class StoryboardError(SystemExit):
    pass


def die(msg):
    raise StoryboardError("\nSTORYBOARD ERROR: " + msg + "\n")


# ══════════════════════════════════════════════════════════════════════════
# 1. The captures
# ══════════════════════════════════════════════════════════════════════════
def run_captures(json_dir=None, save_dir=None):
    data = {}
    for seg in SEGMENTS:
        if json_dir:
            data[seg] = json.loads((pathlib.Path(json_dir) / f"{seg}.json").read_text(encoding="utf-8"))
            continue
        script = BOT / "scripts" / "pay6-capture" / f"{seg}.js"
        print(f"capture: node scripts/pay6-capture/{seg}.js", file=sys.stderr)
        # stdout goes to a FILE, not a pipe: a script that ends with
        # process.exit() right after a large write to a pipe can be cut short.
        with tempfile.TemporaryFile(mode="w+b") as out:
            p = subprocess.run(["node", str(script.relative_to(BOT))], cwd=str(BOT), stdout=out,
                               stderr=subprocess.PIPE, env=dict(os.environ))
            out.seek(0)
            raw = out.read().decode("utf-8")
        if p.returncode != 0:
            sys.stderr.write(p.stderr.decode("utf-8", "replace")[-4000:])
            die(f"capture script {seg}.js exited {p.returncode}")
        try:
            data[seg] = json.loads(raw)
        except ValueError as e:
            die(f"capture script {seg}.js did not print one JSON document ({e})")
        if save_dir:
            pathlib.Path(save_dir).mkdir(parents=True, exist_ok=True)
            (pathlib.Path(save_dir) / f"{seg}.json").write_text(raw, encoding="utf-8")
    return data


def normalise(data):
    """Every segment's cards as one flat shape."""
    cards = {}
    for seg, doc in data.items():
        lst = doc.get("structured_cards") if seg == "register" else doc.get("cards")
        if not isinstance(lst, list):
            die(f"segment {seg}: no card list in its JSON")
        out = []
        for i, c in enumerate(lst):
            notes = c.get("notes") or ""
            out.append({
                "seg": seg, "i": i,
                "step": c.get("step") or "",
                "actor": c.get("actor") or "",
                "recipient": c.get("recipient") or "",
                "kind": c.get("kind") or "",
                "text": c.get("text") or "",
                "parse_mode": c.get("parse_mode") or "",
                "buttons": c.get("buttons") or [],
                # A pop-up the person must close with OK (Telegram show_alert),
                # as the capture records it: the `alert` field, or its note.
                "alert": c.get("alert") is True or "Pop-up ALERT" in notes or "show_alert = true" in notes,
            })
        cards[seg] = out
    return cards


CARDS = {}
ALL_BUTTONS = set()


def S(seg, step=None, text=None, to=None, kind=None):
    """Pick exactly one captured card. Fails loudly on none or several."""
    if seg not in CARDS:
        die(f"unknown segment {seg!r}")
    hits = []
    for c in CARDS[seg]:
        if step is not None:
            if step.startswith("="):
                if c["step"] != step[1:]:
                    continue
            elif step not in c["step"]:
                continue
        if text is not None and text not in c["text"]:
            continue
        if to is not None and to not in c["recipient"]:
            continue
        if kind is not None and c["kind"] != kind:
            continue
        hits.append(c)
    what = f"segment={seg} step={step!r} text={text!r} to={to!r} kind={kind!r}"
    if not hits:
        die(f"no card matches {what}. The bot's wording or the capture changed — update the storyboard.")
    if len(hits) > 1:
        lst = "\n".join(f"   #{h['i']} [{h['kind']} → {h['recipient']}] {h['step'][:90]} | {h['text'][:60]!r}" for h in hits)
        die(f"{len(hits)} cards match {what} — make the selector unique:\n{lst}")
    return hits[0]


def phones_of(card):
    return [n for n in NAMES if n in card["recipient"]]


# ══════════════════════════════════════════════════════════════════════════
# 2. The Telegram renderer (look copied from scripts/build-pay2-guides.py)
# ══════════════════════════════════════════════════════════════════════════
def render_md(t, mode):
    """Telegram Markdown / MarkdownV2 -> HTML, the way the phone shows it.
    *bold*, _dim italic_, `mono`. MarkdownV2 backslash escapes are removed
    (the phone never shows them); legacy Markdown only escapes _ * ` [."""
    if mode not in ("Markdown", "MarkdownV2"):
        return html.escape(t)
    v2 = mode == "MarkdownV2"

    def escapable(ch):
        return (not ch.isalnum() and not ch.isspace()) if v2 else ch in "_*`["

    def find_close(s, i, ch):
        while i < len(s):
            if s[i] == "\\" and i + 1 < len(s) and escapable(s[i + 1]):
                i += 2
                continue
            if s[i] == ch:
                return i
            i += 1
        return -1

    def parse(s):
        out, i = [], 0
        while i < len(s):
            ch = s[i]
            if ch == "\\" and i + 1 < len(s) and escapable(s[i + 1]):
                out.append(html.escape(s[i + 1]))
                i += 2
                continue
            if ch == "`":
                j = s.find("`", i + 1)
                if j > i:
                    inner = s[i + 1:j]
                    if v2:
                        inner = re.sub(r"\\(.)", r"\1", inner)
                    out.append(f"<code>{html.escape(inner)}</code>")
                    i = j + 1
                    continue
            if ch in "*_":
                j = find_close(s, i + 1, ch)
                if j > i:
                    tag = "b" if ch == "*" else "i"
                    out.append(f"<{tag}>{parse(s[i + 1:j])}</{tag}>")
                    i = j + 1
                    continue
            out.append(html.escape(ch))
            i += 1
        return "".join(out)

    return parse(t)


def plain(card):
    """The card's text as the phone shows it, without formatting (for lists)."""
    h = render_md(card["text"], card["parse_mode"])
    return html.unescape(re.sub(r"<[^>]+>", "", h))


PIC_BILL = '<div class="mockbill"><span>the bill photo</span></div>'
PIC_SHOT = '<div class="mockshot"><span>the bank-transfer screenshot</span></div>'


def bubble(card, new=False, pic=None):
    """One Telegram message as the phone shows it: bubble + button rows."""
    p = ['<div class="tg">']
    if new:
        p.append('<div class="newrib">NEW</div>')
    p.append('<div class="bubble">')
    if card["kind"] == "photo":
        if pic is None:
            pic = "shot" if "Proof" in card["text"] else "bill"
        p.append(f'<div class="pic">{PIC_SHOT if pic == "shot" else PIC_BILL}</div>')
    if card["kind"] == "document":
        p.append('<div class="doc"><span class="dicon">📄</span><span class="dname">transfer-receipt.pdf</span></div>')
    if card["text"]:
        p.append(f'<div class="txt">{render_md(card["text"], card["parse_mode"])}</div>')
    p.append("</div>")
    for row in card["buttons"]:
        p.append('<div class="krow">' + "".join(f'<div class="kbtn">{html.escape(b)}</div>' for b in row) + "</div>")
    p.append("</div>")
    return "".join(p)


def popup_html(card):
    t = html.escape(card["text"])
    if card["alert"]:
        return f'<div class="alertbox"><div class="atext">{t}</div><div class="aok">OK</div></div>'
    return f'<div class="toast">{t}</div>'


# ══════════════════════════════════════════════════════════════════════════
# 3. Storyboard vocabulary
# ══════════════════════════════════════════════════════════════════════════
USED_BUTTONS = []


def b(label, check=True):
    """A button named in a Do: line. Checked against the captured buttons."""
    if check:
        USED_BUTTONS.append(label)
    return f'<span class="chip">{html.escape(label)}</span>'


def ty(text):
    return f'<span class="typed">{html.escape(text)}</span>'


def badge(name, label=None):
    c = PEOPLE[name]["color"]
    return f'<span class="badge" style="background:{c}">{html.escape(label or name)}</span>'


class Card:
    def __init__(self, sel, new=False, also=(), pic=None, edit_note=None, wide=False, check=True):
        self.card = sel
        self.check = check  # False: a variant (a wrong entry, an "or"), left off the checklist
        self.new = new
        self.also = list(also)
        self.pic = pic
        self.edit_note = edit_note
        self.wide = wide
        for a in self.also:
            if a["text"] != sel["text"] or a["buttons"] != sel["buttons"] or a["kind"] != sel["kind"]:
                die(f"'also' card differs from its first copy: {a['step'][:80]!r}")

    def phones(self):
        out = []
        for c in [self.card] + self.also:
            for n in phones_of(c):
                if n not in out:
                    out.append(n)
        return out


class Pop:
    def __init__(self, sel):
        if sel["kind"] != "popup":
            die(f"Pop() given a {sel['kind']}: {sel['step'][:80]!r}")
        self.card = sel

    def phones(self):
        return phones_of(self.card)


class Gone:
    """The buttons are taken off a message (a plain-words note, no card)."""
    def __init__(self, text):
        self.text = text


class Step:
    def __init__(self, who, do, items, caption="", note=None, check=True, who_label=None, alt=0):
        self.who = who
        self.alt = alt  # >0: another way to do the previous `alt` steps (drawn with "or, instead of …")
        self.do = do
        self.items = items
        self.caption = caption
        self.note = note
        self.check = check
        self.who_label = who_label
        self.num = None


class Part:
    def __init__(self, key, title, intro, steps, check=True, extra_html=""):
        self.key = key
        self.title = title
        self.intro = intro
        self.steps = steps
        self.check = check
        self.extra_html = extra_html


def phone_label(names, you=None, kind=""):
    if you and you in names:
        s = "On your phone"
    elif names == ["Finance"]:
        s = "On the finance phone"
    elif len(names) == 1:
        s = f"On {PEOPLE[names[0]]['pos']} phone"
    else:
        pos = [PEOPLE[n]["pos"] for n in names]
        s = "On " + ", ".join(pos[:-1]) + " and " + pos[-1] + " phones"
        if len(names) > 1:
            s += " (one copy each)"
    dots = "".join(f'<span class="dot" style="background:{PEOPLE[n]["color"]}"></span>' for n in names)
    return f'<div class="onphone">{dots}{html.escape(s)}{"" if not kind else " · " + html.escape(kind)}</div>'


def render_items(items, you=None):
    cols = []
    pending = []
    for it in items:
        if isinstance(it, Pop):
            pending.append(it)
            continue
        if isinstance(it, Gone):
            cols.append(f'<div class="col"><div class="gonebox">{it.text}</div></div>')
            continue
        col = ['<div class="col' + (" wide" if it.wide else "") + '">']
        names = it.phones()
        kind = ""
        if it.card["kind"] == "edit":
            kind = it.edit_note or "the same message changes to"
        elif it.card["kind"] == "photo":
            kind = "a picture with this text under it"
        elif it.card["kind"] == "document":
            kind = "a file with this text under it"
        if it.edit_note and it.card["kind"] != "edit":
            kind = (kind + " · " if kind else "") + it.edit_note
        col.append(phone_label(names, you, kind))
        for p in pending:
            if set(phones_of(p.card)) <= set(names):
                col.append('<div class="poplbl">pop-up after the tap</div>' + popup_html(p.card))
            else:  # not this phone's pop-up: it stands on its own, before this card
                cols.append('<div class="col">' + phone_label(phones_of(p.card), you, "pop-up only")
                            + popup_html(p.card) + "</div>")
        pending = []
        col.append(bubble(it.card, it.new, it.pic))
        col.append("</div>")
        cols.append("".join(col))
    for p in pending:  # a pop-up with no card after it
        cols.append('<div class="col">' + phone_label(phones_of(p.card), you, "pop-up only")
                    + popup_html(p.card) + "</div>")
    return '<div class="cards">' + "".join(cols) + "</div>"


def render_step(st, you=None, then=False):
    who = st.who
    lbl = st.who_label or (("You" if you == who else who) if who in PEOPLE else who)
    left = [f'<div class="snum" style="border-color:{PEOPLE[who]["color"]};color:{PEOPLE[who]["color"]}">{st.num}</div>',
            f'<div class="whorow">{badge(who, lbl)}</div>',
            f'<div class="do"><b>Do:</b> {st.do}</div>']
    if st.caption:
        left.append(f'<div class="cap">{st.caption}</div>')
    if st.note:
        left.append(f'<div class="snote">{st.note}</div>')
    left.append('<div class="tick">☐ matches</div>')
    if st.alt:
        marker = f'<div class="then alt"><span>▼ or, instead of steps {st.num - st.alt}–{st.num - 1}:</span></div>'
    else:
        marker = '<div class="then"><span>▼ then</span></div>' if then else ""
    return ((f'<div class="stepwrap">' + marker)
            + f'<div class="step"><div class="sl" style="border-left-color:{PEOPLE[who]["color"]}">{"".join(left)}</div>'
            f'<div class="sr">{render_items(st.items, you)}</div></div></div>')


def render_textstep(st, you=None):
    """A step with nothing on a phone (a set-up task): a compact box."""
    c = PEOPLE[st.who]["color"]
    lbl = st.who_label or st.who
    return (f'<div class="tstep" style="border-top-color:{c}"><div class="tshead">'
            f'<div class="snum" style="border-color:{c};color:{c}">{st.num}</div>{badge(st.who, lbl)}</div>'
            f'<div class="do"><b>Do:</b> {st.do}</div>'
            + (f'<div class="cap">{st.caption}</div>' if st.caption else "")
            + '<div class="tick">☐ done</div></div>')


def render_part(part, you=None):
    head = (f'<div class="pband"><span class="pkey">{part.key}</span>'
            f'<span class="ptitle">{part.title}</span></div>'
            + (f'<div class="pintro">{part.intro}</div>' if part.intro else ""))
    blocks = []
    k = 0
    while k < len(part.steps):
        st = part.steps[k]
        if not st.items:  # a run of text-only steps sits side by side
            run = []
            while k < len(part.steps) and not part.steps[k].items:
                run.append(render_textstep(part.steps[k], you))
                k += 1
            blocks.append('<div class="tsteps">' + "".join(run) + "</div>")
            continue
        blocks.append(render_step(st, you, then=bool(blocks)))
        k += 1
    h = ['<div class="part">']
    # The part's heading never stands alone at the foot of a page.
    h.append(f'<div class="keep">{head}{blocks[0] if blocks else ""}</div>')
    h.extend(blocks[1:])
    h.append(part.extra_html)
    h.append("</div>")
    return "".join(h)


# ══════════════════════════════════════════════════════════════════════════
# 4. Shared pages: the swim-lane, the checklist
# ══════════════════════════════════════════════════════════════════════════
LANE = [
    # (part, actor, what the actor does, {recipient: what arrives}, now waiting on)
    ("A", "Abdul", "Registers his bank account (once)", {"Krishna": "approval card", "Musa": "approval card"}, "Krishna and Musa"),
    ("A", "Krishna", "Approves the account — 1 of 2", {"Abdul": "“Approval 1 of 2”", "Musa": "“needs a SECOND”"}, "Musa"),
    ("A", "Musa", "Approves the account — 2 of 2", {"Abdul": "“Approved · 2 of 2”"}, "Abdul (the account is ready)"),
    ("B", "Abdul", "Asks for ₦25,000 · Transport to Idumota · bill", {"Krishna": "approval card + bill", "Musa": "approval card + bill"}, "Krishna and Musa"),
    ("C", "Krishna", "First approval", {"Abdul": "“Approval 1 of 2”", "Musa": "“needs a SECOND”"}, "Musa"),
    ("D", "Musa", "Last approval — taps the account to pay FROM", {"Abdul": "“Approved” + Paying from ZENITH", "Finance": "payment card: From and To"}, "Finance"),
    ("E", "Finance", "Pays at the bank, taps ✔ Mark Done", {"Abdul": "“Paid” · From and To", "Krishna": "“Paid” · From and To", "Musa": "“Paid” · From and To"}, "Finance (the proof)"),
    ("E", "Finance", "Sends the transfer screenshot", {"Abdul": "proof picture", "Krishna": "proof picture", "Musa": "proof picture"}, "nobody — finished"),
]
LANE_NEW = {5, 6}


def swimlane(highlight=None, title="The whole journey at a glance"):
    head = ['<div class="lh lstep">Part</div>']
    for n in NAMES:
        cls = " hl" if n == highlight else ""
        head.append(f'<div class="lh{cls}">{badge(n, "You (Abdul)" if highlight == n else n)}'
                    f'<div class="lrole">{html.escape(PEOPLE[n]["role"])}</div></div>')
    head.append('<div class="lh lwait">Now waiting on</div>')
    rows = []
    for k, (part, actor, does, recv, wait) in enumerate(LANE):
        rows.append(f'<div class="lc lstep"><b>{part}</b></div>')
        for n in NAMES:
            cls = " hl" if n == highlight else ""
            c = PEOPLE[n]["color"]
            inner = ""
            if n == actor:
                inner = f'<div class="ldo" style="background:{c}">{html.escape(does)}</div>'
            elif n in recv:
                nw = '<span class="lnew">NEW</span>' if k in LANE_NEW else ""
                inner = f'<div class="lget" style="border-color:{c}">receives {html.escape(recv[n])}{nw}</div>'
            rows.append(f'<div class="lc{cls}"><div class="lline" style="border-color:{c}"></div>{inner}</div>')
        rows.append(f'<div class="lc lwait">⏳ {html.escape(wait)}</div>')
    return (f'<div class="lanebox"><div class="ltitle">{title}</div>'
            f'<div class="lane">{"".join(head)}{"".join(rows)}</div>'
            '<div class="lfoot">Read down: each row is one moment. A filled box is the person who acts; '
            'an outlined box is what lands on that person\'s phone at that moment. '
            'The right-hand column says who everyone is waiting for next.</div></div>')


def checklist_rows(parts, only=None, messages_only=False):
    """Every card (and pop-up) of the checked steps, per phone, in order.
    messages_only: only what ARRIVES as a new message (no pop-up, no screen
    that changes under the person's own tap)."""
    per = {n: [] for n in NAMES}
    for part in parts:
        if not part.check:
            continue
        for st in part.steps:
            if not st.check:
                continue
            for it in st.items:
                if isinstance(it, Gone) or (isinstance(it, Card) and not it.check):
                    continue
                c = it.card
                if messages_only and (isinstance(it, Pop) or c["kind"] not in ("message", "photo", "document")):
                    continue
                names = it.phones() if isinstance(it, Card) else phones_of(c)
                first = plain(c).strip().split("\n")[0]
                if isinstance(it, Pop):
                    first = "pop-up: " + first
                elif c["kind"] == "photo":
                    first = "picture: " + first
                for n in names:
                    if only and n != only:
                        continue
                    per[n].append((st.num, first, isinstance(it, Card) and it.new))
    return per


# ══════════════════════════════════════════════════════════════════════════
# 5. The owner's copy
# ══════════════════════════════════════════════════════════════════════════
def owner_parts():
    acct_a, acct_b = [r[0].replace("🏦 ", "") for r in S("request", step="MAIN · Musa taps Approve on the card", kind="message")["buttons"][:2]]

    setup = Part("Set-up", "Set up the finance phone",
                 "Do this once, before the first payment. The finance phone is the ONE phone that pays: it gets the "
                 "payment card, taps ✔ Mark Done after the bank transfer, and sends the proof. "
                 "<b>Whoever approves a payment can never pay it</b> (the four-eyes rule) — so the finance phone must "
                 "belong to someone who never approves.", [
        Step("Krishna", "On Railway, open the bot's <b>Variables</b> and set "
             "<code>FINANCE_IDS</code> = the Telegram id of the person who pays. Save (press Deploy if Railway asks); "
             "the bot restarts with the new value.",
             [], "Use an id that <b>never approves</b>. If an admin's id is put here, that admin can still approve "
             "payments, but can never pay the ones they approved.", who_label="Krishna (you)", check=False),
        Step("Krishna", "On the laptop, in the <code>telegram-ops-bot</code> folder (it needs the bot's "
             "<code>.env</code> file; or put <code>railway run</code> in front), run "
             "<code>node scripts/seed-finance-department.js</code> "
             "(it only shows what it would do), then <code>node scripts/seed-finance-department.js --commit</code>.",
             [], "It adds the department <b>Finance</b> to the Departments sheet, with <b>payments</b> as its only "
             "activity. If the department is already there, it says so and changes nothing. Or, with no laptop: "
             "👥 Human Resources → 🏢 Manage Departments → add Finance with only Payments ticked.",
             who_label="Krishna (you)", check=False),
        Step("Krishna", "In the <b>Users</b> sheet, on the finance person's row: <b>department</b> = Finance, "
             "<b>status</b> = active, <b>role</b> = not admin.", [],
             "This gives that person the 💰 Finance → 💳 Payments menu. Only if FINANCE_IDS is left empty does the "
             "bot look here to find who pays: then exactly one active person must be in Finance; with nobody, or "
             "several, payment cards go to all admins with a warning.", who_label="Krishna (you)", check=False),
        Step("Krishna", f"Check on Telegram: open {b('💰 Finance')} → {b('💳 Payments')} on your phone, then on "
             "the finance phone.",
             [Card(S("setup", step="Krishna taps 💳 Payments")),
              Card(S("setup", step="SETUP — Finance types")),
              Card(S("setup", step="Finance taps 💳 Payments"))],
             "Your screen names the finance person on the line “Finance: … pays and marks done.” The finance phone's "
             "menu has 💰 Finance, and its Payments screen has the extra button “💳 Waiting for me to pay”, with the "
             "number of approved payments still to pay.", who_label="Krishna (you)", check=False),
    ], check=False, extra_html=f"""
<div class="infobox"><div class="ibtitle">Your paying accounts — the company accounts money leaves FROM</div>
<p>For now they are kept <b>by name</b>: <b>BANK — ACCOUNT NAME</b>, for example <b>{html.escape(acct_a)}</b> and
<b>{html.escape(acct_b)}</b>. The bot finds them in one of two places:</p>
<ul><li><b>The accounts already listed in 🏦 Manage Banks</b> that are written as BANK — ACCOUNT NAME. A plain bank name
(GTBank, Zenith …) is a bank, not a company account, and is never offered.</li>
<li><b>Or a list typed in Settings, key <code>PAYMENT_SOURCE_ACCOUNTS</code></b> — one account per line. When this cell
has anything in it, it is used instead of the Manage Banks list.</li></ul>
<table class="rules"><tr><th>How many paying accounts</th><th>What happens on the last ✅ Approve</th></tr>
<tr><td>two or more</td><td>The admin giving the last approval is asked <b>“Pay from which account?”</b> and taps one (Part D).</td></tr>
<tr><td>exactly one</td><td>It is used without asking, and named on every card that follows.</td></tr>
<tr><td><code>0</code> in that Settings cell</td><td>Switched off: nobody is asked, and the finance card shows only the account paid TO, as before.</td></tr></table>
<p class="small">Account numbers, and the QR details shown when a chip is tapped, come in a later release (your words: “polished later”).
Note: because they live in the Manage Banks list, these two company accounts also appear as bank choices when someone
registers an account (Part A, step 2) or records a customer payment (Part H).</p></div>""")

    A = Part("A", "Abdul registers his bank account; two admins approve it",
             "Once per account. A payment can only ever go to a registered account, and the number is typed twice "
             "because nothing else can check it.", [
        Step("Abdul", f"Type {ty('menu')}, tap {b('💰 Finance')}, then {b('💳 Payments')}.",
             [Card(S("register", step="=Abdul types: menu")),
              Card(S("register", step="=Abdul taps 💰 Finance", kind="edit")),
              Card(S("register", step="(he has no registered account yet)", kind="edit", text="Payments"))],
             "The menu, then the Finance screen, then Payments — all in the same message. He has no account yet."),
        Step("Abdul", f"Tap {b('🏦 Register account')}, type the 10-digit number, then type it once more.",
             [Card(S("register", step="Abdul taps 🏦 Register account", kind="edit")),
              Card(S("register", step="=Abdul types the account number: 0123456789")),
              Card(S("register", step="last digit wrong"), check=False),
              Card(S("register", step="Abdul types the same number once more"))],
             "If the two numbers differ, the bot says so and asks again (third card). When they match, it asks for the bank."),
        Step("Abdul", f"Tap {b('🏛 GTBank')}, check the card, tap {b('✅ Submit for approval')}.",
             [Card(S("register", step="Abdul taps 🏛 GTBank", kind="edit")),
              Card(S("register", step="=Abdul taps ✅ Submit for approval", to="Abdul", kind="message")),
              Card(S("register", step="=Abdul taps ✅ Submit for approval", to="Krishna"),
                   also=[S("register", step="=Abdul taps ✅ Submit for approval", to="Musa")])],
             "Abdul is told it is waiting for two admins. Each admin gets the approval card."),
        Step("Krishna", f"Tap {b('✅ Approve')} on the approval card.",
             [Pop(S("register", step="Krishna taps ✅ Approve", kind="popup")),
              Card(S("register", step="Krishna taps ✅ Approve", to="Krishna", kind="message")),
              Card(S("register", step="Krishna taps ✅ Approve", to="Abdul")),
              Card(S("register", step="Krishna taps ✅ Approve", to="Musa"))],
             "Krishna's card loses its buttons. Abdul sees 1 of 2; Musa is told a second approval is needed."),
        Step("Musa", f"Tap {b('✅ Approve')} on the approval card.",
             [Pop(S("register", step="Musa taps ✅ Approve on the reminder copy", kind="popup")),
              Card(S("register", step="Musa taps ✅ Approve on the reminder copy", to="Musa", kind="message")),
              Card(S("register", step="Musa taps ✅ Approve on the reminder copy", to="Abdul"))],
             "Two approvals: the account is registered. Any copy of the card works."),
        Step("Abdul", f"Open {b('💳 Payments')} again.",
             [Card(S("register", step="his account is now approved", kind="edit", text="Payments"))],
             "He now has 1 registered account and can ask for payments into it."),
    ])

    B = Part("B", "Abdul asks for a payment",
             "₦25,000 for “Transport to Idumota”, with a photo of the bill.", [
        Step("Abdul", f"In {b('💳 Payments')} tap {b('💸 Request payment')}.",
             [Card(S("request", step="MAIN · Abdul opens Payments")),
              Card(S("request", step="MAIN · Abdul asks for a payment"))],
             "He can only pick his own registered account."),
        Step("Abdul", f"Tap {b('👤 Abdul · GTBank 0123456789')}, type {ty('25000')}.",
             [Card(S("request", step="MAIN · Abdul picks his account")),
              Card(S("request", step="MAIN · Abdul gives the amount"))],
             "Then the bot asks what the payment is for. A salary is chosen with the two Salary buttons."),
        Step("Abdul", f"Type {ty('Transport to Idumota')}, then send the bill photo.",
             [Card(S("request", step="MAIN · Abdul gives the reason")),
              Card(S("request", step="MAIN · Abdul attaches the bill"))],
             "The bill is optional (⏭ Skip — no bill). Last look before sending."),
        Step("Abdul", f"Tap {b('✅ Submit for approval')}.",
             [Card(S("request", step="MAIN · Abdul submits", kind="edit")),
              Card(S("request", step="MAIN · Abdul submits", to="Abdul", kind="message")),
              Card(S("request", step="MAIN · Abdul submits", to="Krishna and Musa", kind="message")),
              Card(S("request", step="MAIN · Abdul submits", kind="photo"))],
             "Abdul gets his receipt with the payment number. Each admin gets the approval card, then the bill as a picture."),
    ])

    C = Part("C", "The first approval (Krishna) and what Abdul receives",
             "Any admin can give the first approval. The same admin can never give the second one.", [
        Step("Krishna", f"Tap {b('✅ Approve')} on the payment card.",
             [Pop(S("request", step="MAIN · Krishna approves", kind="popup")),
              Card(S("request", step="MAIN · Krishna approves", to="Krishna", kind="message")),
              Card(S("request", step="MAIN · Krishna approves", to="Abdul")),
              Card(S("request", step="MAIN · Krishna approves", to="Musa"))],
             "Abdul's card has two buttons: 🔔 Remind approvers and 📋 Status."),
        Step("Abdul", f"Open {b('📋 My requests')}, tap {b('🔔 Remind approvers · ₦25,000')}.",
             [Card(S("request", step="Abdul opens My requests after the first signature")),
              Pop(S("request", step="reminds the approvers after the first signature", kind="popup")),
              Card(S("request", step="reminds the approvers after the first signature", to="Abdul", kind="message")),
              Card(S("request", step="reminds the approvers after the first signature", to="Musa", kind="message")),
              Card(S("request", step="reminds the approvers after the first signature", kind="photo"))],
             "The reminder card goes only to the admin who has not signed (Musa). The bill picture is sent again to "
             "both admins, Krishna included (last card). Once a day at most.",
             check=False),
    ])

    D = Part("D", "The LAST approval — and the account the money is paid FROM (Musa)",
             "New in this release. The admin who gives the last approval names the company account the money "
             "leaves from. <b>Nothing is approved until an account is tapped.</b>", [
        Step("Musa", f"Tap {b('✅ Approve')} on the payment card.",
             [Pop(S("request", step="=MAIN · Musa taps Approve on the card in his chat (the last approval) — taps “✅ Approve”", kind="popup")),
              Card(S("request", step="=MAIN · Musa taps Approve on the card in his chat (the last approval) — taps “✅ Approve”", kind="message"), new=True)],
             "A new question arrives as a reply under the payment card. The payment card keeps its buttons. "
             "Nothing is approved yet and nobody else is told anything."),
        Step("Musa", f"Tap {b('✖ Not now')} (if he is not ready to choose).",
             [Card(S("request", step="MAIN · Musa closes the picker"), new=True),
              Card(S("request", step="MAIN · Abdul checks his request while the picker is open"))],
             "“Not now” approves nothing. Abdul's 📋 Status still reads 1 of 2. Musa can tap ✅ Approve again later "
             "— the same question comes back."),
        Step("Musa", f"Tap {b('✅ Approve')} again — the same question comes as a new message — then tap {b('🏦 ' + acct_a)}.",
             [Pop(S("request", step="MAIN · Musa taps Approve again", kind="popup")),
              Card(S("request", step="MAIN · Musa taps Approve again", kind="message"), new=True),
              Pop(S("request", step="MAIN · Musa picks the paying account", kind="popup")),
              Card(S("request", step="MAIN · Musa picks the paying account", to="Musa", kind="message"), new=True),
              Card(S("request", step="MAIN · Musa picks the paying account", to="Abdul"), new=True)],
             "Now it is approved. Musa's result and Abdul's closing card both end “Paying from …”. "
             "At the same moment the finance phone gets its card (Part E)."),
        Step("Musa", f"<b>Another way</b>, from {b('🛂 Approvals')} → {b('💳 Payments — 1 ⚠️ 🟢today')} → the request.",
             [Card(S("request", step="Musa opens 🛂 Approvals → 💳 Payments → the request")),
              Card(S("request", step="Musa picks the paying account (picker drawn from the inbox)", text="still pending"))],
             "The inbox card warns that one approval is already given. ✅ Approve asks the same question; after the "
             "pick the inbox says how many are still pending.", check=False, alt=3),
    ])

    E = Part("E", "The finance phone pays",
             "New in this release: the finance card shows <b>From</b> (the company account Musa chose) and "
             "<b>To</b> (Abdul's account) together.", [
        Step("Bot", "Nothing to tap — the card arrives on the finance phone the moment Musa picks the account.",
             [Card(S("request", step="=MAIN · Musa picks the paying account — taps “🏦 ZENITH — BLACK PANTHER”", to="Finance"), new=True, wide=True)],
             "The bill is the picture; the card is the text under it. ✔ Mark Done is for AFTER the bank transfer. "
             "If nobody pays or declines for 4 hours, the same card is sent again.", who_label="Bot (after Musa's pick)"),
        Step("Finance", f"Transfer the money in the bank app (From → To), then tap {b('✔ Mark Done')}.",
             [Pop(S("finance", step="Finance has made the transfer", kind="popup")),
              Card(S("finance", step="Finance has made the transfer", to="Abdul"), new=True,
                   also=[S("finance", step="Finance has made the transfer", to="Krishna"),
                         S("finance", step="Finance has made the transfer", to="Musa")]),
              Card(S("finance", step="Finance has made the transfer", to="Finance", kind="message"))],
             "The Paid message goes out at once to Abdul and both admins, with From and To. The card loses its "
             "buttons, and the finance phone is asked for proof."),
        Step("Finance", "Send the screenshot of the bank transfer into the chat (or tap ⏭ Skip — no proof).",
             [Card(S("finance", step="Finance sends a screenshot", to="Finance"), new=True),
              Card(S("finance", step="Finance sends a screenshot", to="Abdul"),
                   also=[S("finance", step="Finance sends a screenshot", to="Krishna"),
                         S("finance", step="Finance sends a screenshot", to="Musa")]),
              Card(S("finance", step="Finance taps ⏭ Skip — no proof"), new=True, check=False)],
             "With a screenshot: the finance phone's confirmation, then the proof picture to the same three people. "
             "With ⏭ Skip: the confirmation alone (third card)."),
    ])

    F = Part("F", "When finance declines — and the four-eyes lock",
             "Finance can refuse an approved payment with a reason. And an admin who approved a payment can never pay it.", [
        Step("Finance", f"Tap {b('✖ Decline')}, type the reason {ty('Account name does not match')}.",
             [Card(S("finance", step="=Finance taps ✖ Decline on the finance card")),
              Card(S("finance", step="Finance types the reason: \"Account name", to="Finance", kind="message")),
              Card(S("finance", step="Finance types the reason: \"Account name", to="Abdul"),
                   also=[S("finance", step="Finance types the reason: \"Account name", to="Krishna"),
                         S("finance", step="Finance types the reason: \"Account name", to="Musa")])],
             "Abdul and both admins see why. Nothing was paid; Abdul fixes the problem and asks again.", check=False),
        Step("Krishna", "Nothing to tap — this is what an admin who ALSO sits in FINANCE_IDS receives for a payment he approved.",
             [Card(S("finance", step="each gets a copy", to="Krishna"), new=True),
              Pop(S("finance", step="Krishna taps ✔ Mark Done on an OLDER copy"))],
             "No ✔ Mark Done, and the 🔒 line. Even a tap on an old copy is refused (the pop-up must be closed with OK). "
             "✖ Decline stays.", check=False),
        Step("Bot", "Nothing to tap — when EVERY finance seat also approved the payment, both admins get this.",
             [Card(S("finance", step="the ONLY finance seat is Krishna", to="Krishna", kind="message"),
                   also=[S("finance", step="the ONLY finance seat is Krishna", to="Musa", kind="message")])],
             "The way out: add a finance id that did not sign, or ✖ Decline it so it is raised again for different "
             "hands. With FINANCE_IDS set to a non-approver (Set-up step 1) this never happens.",
             who_label="Bot", check=False),
    ], check=False)

    G = Part("G", "Where everything stays on record",
             "Four places to look later — and one new column on the sheet.", [
        Step("Abdul", f"{b('💳 Payments')} → {b('📋 My requests')}.",
             [Card(S("finance", step="=Abdul taps 📋 My requests"))],
             "Every request, newest first: waiting, with finance to pay, paid, declined (with the reason).", check=False),
        Step("Finance", f"{b('💳 Payments')} → {b('💳 Waiting for me to pay (2)')}.",
             [Card(S("finance", step="Finance taps 💳 Waiting for me to pay (2)")),
              Card(S("finance", step="taps 💳 Waiting for me to pay (1)", to="Krishna"))],
             "Tap a row to get its card again. A 🔒 row (second card, an admin in FINANCE_IDS) is one he approved and cannot pay.",
             check=False),
        Step("Krishna", f"{b('🛂 Approvals')} → {b('💳 Payments — 1 ⚠️ 🟢today')} → the request; later "
             f"{b('✅❌ Decided — 1 (1 ✅ · 0 ❌)')} → the payment.",
             [Card(S("request", step="Krishna opens the request — taps")),
              Card(S("finance", step="=Krishna taps the payment row"), new=True),
              Card(S("finance", step="approved but NOT yet paid"), new=True)],
             "Waiting: the card with ✅ Approve / ❌ Reject. Decided: a record only, with “Pay from:” and a status line "
             "— “💸 Paid by …” once paid, “🏦 With finance to pay” before that, both ending “from …”.",
             check=False),
    ], check=False, extra_html=sheet_t_html(acct_a))

    H = Part("H", "A customer's payment is received and recorded",
             "Money coming IN: customer ABBA pays 50,000 into Zenith. Abdul records it; the admins approve; "
             "only then does ABBA's balance move. No paying-account question here.", [
        Step("Abdul", f"{b('💰 Finance')} → {b('💵 Payment Received')}, type {ty('abb')}, tap {b('👤 ABBA')}.",
             [Card(S("received", step="=Abdul taps 💵 Payment Received")),
              Card(S("received", step="=Abdul types part of the name: abb")),
              Card(S("received", step="=Abdul taps 👤 ABBA"))],
             "Tap the customer, or type part of the name."),
        Step("Abdul", f"Type {ty('50000')}, tap {b('🏦 Zenith')}, then {b('✅ Submit for approval')}.",
             [Card(S("received", step="=Abdul types the amount: 50000")),
              Card(S("received", step="=Abdul taps 🏦 Zenith")),
              Card(S("received", step="=Abdul taps ✅ Submit for approval", to="Abdul")),
              Card(S("received", step="=Abdul taps ✅ Submit for approval", to="Krishna"),
                   also=[S("received", step="=Abdul taps ✅ Submit for approval", to="Musa")])],
             "The admins' card shows what ABBA owes today and after this payment — that figure is for admins only."),
        Step("Krishna", f"Tap {b('✅ Approve')}.",
             [Pop(S("received", step="Krishna taps ✅ Approve on his approval card", kind="popup")),
              Card(S("received", step="Krishna taps ✅ Approve on his approval card", to="Abdul"))],
             "Today the bot asks for <b>two</b> admin approvals when an employee records a customer payment "
             "(one when an admin records it). The Payment Received specification says one — your ruling is still owed."),
        Step("Musa", f"Tap {b('✅ Approve')}.",
             [Pop(S("received", step="Musa taps ✅ Approve on his approval card", kind="popup")),
              Card(S("received", step="Musa taps ✅ Approve on his approval card", to="Musa", text="Changes applied")),
              Card(S("received", step="Musa taps ✅ Approve on his approval card", to="Musa", text="Outstanding")),
              Card(S("received", step="Musa taps ✅ Approve on his approval card", to="Abdul"))],
             "Recorded: ABBA's balance moves down by 50,000. Abdul's closing card does not show the balance."),
        Step("Abdul", "Enters the very same payment again while the first is still waiting for approval "
             "(more than 20 seconds later — a quick double tap is simply one request).",
             [Card(S("received", step="about three minutes after the open one", to="Abdul")),
              Card(S("received", step="about three minutes after the open one", to="Krishna"),
                   also=[S("received", step="about three minutes after the open one", to="Musa")])],
             "A separate example — its numbers differ from steps 30–33: R-E61D, another 50,000 from ABBA, was "
             "still waiting; R-A2F0 repeats it. It is NOT refused — both admins get it marked ⚠️ Possible duplicate.",
             check=False),
        Step("Krishna", f"Tap {b('⧉ Reject as duplicate')} on the marked card.",
             [Pop(S("received", step="Krishna taps ⧉ Reject as duplicate", kind="popup")),
              Card(S("received", step="Krishna taps ⧉ Reject as duplicate", to="Krishna", kind="message")),
              Card(S("received", step="Krishna taps ⧉ Reject as duplicate", to="Abdul"))],
             "One tap closes the copy and tells Abdul which request is still open.", check=False),
    ])
    return [setup, A, B, C, D, E, F, G, H]


def sheet_t_html(acct):
    return f"""
<div class="infobox"><div class="ibtitle">The PaymentRequests sheet — one new last column, T <code>paid_from</code></div>
<table class="sheet"><tr><th></th><th>A</th><th>…</th><th>G</th><th>…</th><th>L</th><th>M</th><th>…</th><th>S</th><th class="tnew">T</th></tr>
<tr><td class="rn">1</td><td>payment_id</td><td>…</td><td>amount_ngn</td><td>…</td><td>approved_by</td><td>status</td><td>…</td><td>reason</td><td class="tnew">paid_from</td></tr>
<tr><td class="rn">n</td><td>PAY-20261111-…</td><td>…</td><td>25000</td><td>…</td><td>Krishna ‖ Musa</td><td>approved</td><td>…</td><td>Transport to Idumota</td><td class="tnew">{html.escape(acct)}</td></tr></table>
<p class="small">Written at the moment of the last approval, together with “approved”. No other column moves. Payments approved
before this release have this cell empty and read as before.</p></div>"""


# ══════════════════════════════════════════════════════════════════════════
# 6. Abdul's copy (only his phone)
# ══════════════════════════════════════════════════════════════════════════
def abdul_parts():
    one = Part("1", "Register your bank account (once)",
               "Do this once. Money can only be paid into an account that two admins have approved.", [
        Step("Abdul", f"Type {ty('menu')}, tap {b('💰 Finance')}, then {b('💳 Payments')}.",
             [Card(S("register", step="=Abdul types: menu")),
              Card(S("register", step="=Abdul taps 💰 Finance", kind="edit")),
              Card(S("register", step="(he has no registered account yet)", kind="edit", text="Payments"))],
             "The same message changes each time you tap."),
        Step("Abdul", f"Tap {b('🏦 Register account')}. Type your 10-digit account number. Type it once more.",
             [Card(S("register", step="Abdul taps 🏦 Register account", kind="edit")),
              Card(S("register", step="=Abdul types the account number: 0123456789")),
              Card(S("register", step="last digit wrong"), check=False),
              Card(S("register", step="Abdul types the same number once more"))],
             "The bot compares the two. If they differ (third card), type it again. Then tap YOUR bank (GTBank, "
             "Zenith …). The two buttons ending “— BLACK PANTHER” are the company's own accounts — never pick them here."),
        Step("Abdul", f"Tap your bank ({b('🏛 GTBank')}), check, tap {b('✅ Submit for approval')}.",
             [Card(S("register", step="Abdul taps 🏛 GTBank", kind="edit")),
              Card(S("register", step="=Abdul taps ✅ Submit for approval", to="Abdul", kind="message"))],
             "Now two admins check it."),
        Step("Abdul", "Wait. You receive one card at each approval.",
             [Card(S("register", step="Krishna taps ✅ Approve", to="Abdul")),
              Card(S("register", step="Musa taps ✅ Approve on the reminder copy", to="Abdul")),
              Card(S("register", step="his account is now approved", kind="edit", text="Payments"))],
             "After the second approval, 💳 Payments says you have 1 registered account.", who_label="You wait"),
    ])
    two = Part("2", "Ask for a payment",
               "Example: ₦25,000 for “Transport to Idumota”, with a photo of the bill.", [
        Step("Abdul", f"{b('💳 Payments')} → {b('💸 Request payment')} → tap your account.",
             [Card(S("request", step="MAIN · Abdul asks for a payment")),
              Card(S("request", step="MAIN · Abdul picks his account"))],
             "You can only pick your own registered account."),
        Step("Abdul", f"Type the amount in figures: {ty('25000')}. Type what it is for: {ty('Transport to Idumota')}.",
             [Card(S("request", step="MAIN · Abdul gives the amount")),
              Card(S("request", step="MAIN · Abdul gives the reason"))],
             "Figures only — not words. A reason of 3 to 120 letters. For a salary use the two Salary buttons (part 7)."),
        Step("Abdul", f"Send the photo of the bill (or tap {b('⏭ Skip — no bill')}), check, tap {b('✅ Submit for approval')}.",
             [Card(S("request", step="MAIN · Abdul attaches the bill")),
              Card(S("request", step="MAIN · Abdul submits", to="Abdul", kind="message"))],
             "Your receipt has the payment number (PAY-…). Keep it. The approval cards that follow use a short "
             "number, R-…: both mean this same request — quote either."),
    ])
    three = Part("3", "While you wait",
                 "Two admins must approve. You are told at each approval.", [
        Step("Abdul", "Wait for the first approval.",
             [Card(S("request", step="MAIN · Krishna approves", to="Abdul")),
              Card(S("request", step="MAIN · Abdul checks his request while the picker is open"), check=False)],
             f"Tap {b('📋 Status')} any time to see who has signed and how long it has waited (second card — "
             "only if you tap it).",
             who_label="You wait"),
        Step("Abdul", f"If it waits too long, tap {b('🔔 Remind approvers')}.",
             [Card(S("request", step="Abdul opens My requests after the first signature")),
              Pop(S("request", step="reminds the approvers after the first signature", kind="popup")),
              Card(S("request", step="reminds the approvers after the first signature", to="Abdul", kind="message")),
              Pop(S("request", step="Abdul taps the reminder a second time the same day"))],
             "The reminder goes only to the admin who has not signed yet. <b>Once a day</b>: a second tap the same day "
             "is refused (last pop-up — close it with OK). Only if you need it.", check=False),
    ])
    four = Part("4", "Approved — the card now names the account it will be paid from",
                "New in this release: the last admin chooses the company account the money comes FROM.", [
        Step("Abdul", "Nothing to tap — wait for the second approval.",
             [Card(S("request", step="=MAIN · Musa picks the paying account — taps “🏦 ZENITH — BLACK PANTHER”", to="Abdul"), new=True)],
             "Approved is not yet paid: the finance person now makes the bank transfer.", who_label="You wait"),
    ])
    five = Part("5", "Paid — or declined",
                "The finance person pays at the bank, then the bot tells you.", [
        Step("Abdul", "Nothing to tap — wait for the money.",
             [Card(S("finance", step="Finance has made the transfer", to="Abdul"), new=True),
              Card(S("finance", step="Finance sends a screenshot", to="Abdul"))],
             "“From” is the company account; “To” is your account. Check your bank. When the finance person sends "
             "the transfer screenshot, you receive it too (second card).", who_label="You wait"),
        Step("Abdul", "If the finance person declines: read the reason, fix it, ask again.",
             [Card(S("finance", step="Finance types the reason: \"Account name", to="Abdul"))],
             "Nothing was paid. The last line before “Ref” is the reason. Fix the problem (for example the account), "
             "then raise a new request from 💸 Request payment.", who_label="If declined", check=False),
    ])
    six = Part("6", "My requests — every request and where it stands", "", [
        Step("Abdul", f"{b('💳 Payments')} → {b('📋 My requests')}.",
             [Card(S("request", step="Abdul opens My requests after both signatures"), edit_note="while finance has it"),
              Card(S("finance", step="=Abdul taps 📋 My requests"), edit_note="after it is paid")],
             "An example list — yours shows only the requests you raised. Each line carries one of these states: ⏳ waiting for approval (who signed, and a 🔔 button) · 🏦 with finance to pay · ✅ paid · "
             "✖ declined by finance (with the reason) · ❌ rejected.", check=False),
    ], check=False)
    seven = Part("7", "Two things the bot will refuse", "", [
        Step("Abdul", "Ask again for the same account and the same amount while the first one is still open.",
             [Card(S("request", step="VARIANT (a) same payment again · Abdul attaches the bill"))],
             "Nothing new is raised. 📋 Open it shows the open request. If it really is a second payment, ask an "
             "admin to raise it.", check=False),
        Step("Abdul", f"Salary: after the amount tap {b('💼 Salary')}, tap the month, check, submit.",
             [Card(S("request", step="Abdul TYPES a salary")),
              Card(S("request", step="Abdul uses the Salary chip")),
              Card(S("request", step="=VARIANT (b) salary · Abdul has no bill — taps “⏭ Skip — no bill”",
                     text="📝 Salary · Nov-2026")),
              Card(S("request", step="Abdul submits the salary request", to="Abdul"))],
             "Typing “salary” is refused (first card): use the button, so the month is recorded. "
             "💵 Salary advance works the same way.", check=False),
        Step("Abdul", "Ask for a second salary for the same month.",
             [Card(S("request", step="second salary, same month"))],
             "One salary per month. Nothing new is raised.", check=False),
    ], check=False)
    eight = Part("8", "Recording a payment a customer made (Payment Received)",
                 "Example: customer ABBA paid 50,000 into Zenith.", [
        Step("Abdul", f"{b('💰 Finance')} → {b('💵 Payment Received')}. Type part of the name ({ty('abb')}), tap {b('👤 ABBA')}.",
             [Card(S("received", step="=Abdul taps 💵 Payment Received")),
              Card(S("received", step="=Abdul types part of the name: abb")),
              Card(S("received", step="=Abdul taps 👤 ABBA"))], ""),
        Step("Abdul", f"Type {ty('50000')}, tap how it was paid ({b('🏦 Zenith')}), tap {b('✅ Submit for approval')}.",
             [Card(S("received", step="=Abdul types the amount: 50000")),
              Card(S("received", step="=Abdul taps 🏦 Zenith")),
              Card(S("received", step="=Abdul taps ✅ Submit for approval", to="Abdul"))],
             "Tap the bank the money went into — in this example 🏦 Zenith. The buttons ending “— BLACK PANTHER” "
             "are the company's own accounts; which one to tap for money paid into the company's Zenith account is "
             "Krishna's call — ask him before your first real entry. The customer's balance moves only after the "
             "admins approve."),
        Step("Abdul", "Wait for the approvals.",
             [Card(S("received", step="Krishna taps ✅ Approve on his approval card", to="Abdul")),
              Card(S("received", step="Musa taps ✅ Approve on his approval card", to="Abdul"))],
             "Two approvals today (the card above says “An admin”; Krishna is deciding which is right). "
             "💵 Record another starts the next one.", who_label="You wait"),
    ])
    return [one, two, three, four, five, six, seven, eight]


# ══════════════════════════════════════════════════════════════════════════
# 7. Pages
# ══════════════════════════════════════════════════════════════════════════
def legend_html():
    demo_toast = '<div class="toast">🔏 Approval 1 of 2 recorded.</div>'
    return f"""
<div class="legend">
 <div class="lgi"><div class="snum mini">7</div><div>The <b>step number</b>. Quote it when something differs.</div></div>
 <div class="lgi">{badge("Abdul")}<div><b>Who acts</b> — the colour never changes.</div></div>
 <div class="lgi"><div><b>Do:</b> what to tap <span class="chip">like this</span> or type <span class="typed">like this</span>.</div></div>
 <div class="lgi">{demo_toast}<div>A <b>pop-up</b>: the small grey note after a tap. A white box with OK must be closed.</div></div>
 <div class="lgi"><div class="tg mini"><div class="newrib">NEW</div><div class="bubble"><div class="txt">card</div></div></div><div>New with this release.</div></div>
 <div class="lgi"><div class="tick">☐ matches</div><div>Tick when the phone shows exactly this.</div></div>
</div>"""


def owner_cover():
    cast = "".join(f'<div class="castrow">{badge(n)}<span>{html.escape(PEOPLE[n]["role"])}</span></div>' for n in NAMES)
    parts = ["Set up the finance phone · your paying accounts", "A — Abdul registers his bank account",
             "B — Abdul asks for a payment", "C — the first approval", "D — the last approval and the paying account",
             "E — the finance phone pays", "F — declines and the four-eyes lock", "G — where it stays on record",
             "H — a customer's payment received", "Checklist — every message, by phone"]
    return f"""
<section class="cover">
 <div class="brand">black_panther bot (formerly AtFactoryPrice) · Owner's copy · {DATE}</div>
 <h1>Payments, card by card</h1>
 <div class="sub">Every card of the payment journey, one by one, on every phone it appears on — taken from the bot's own code,
 word for word. Verify it with Abdul card by card; he has his own copy with only his phone.</div>
 <div class="three">
  <div class="box"><div class="btitle">The cast</div>{cast}</div>
  <div class="box"><div class="btitle">The one payment everyone follows</div>
   <p><b>Abdul</b> registers his account <b>GTBank 0123456789</b>, then asks for <b>₦25,000</b> for
   <b>Transport to Idumota</b>, with a photo of the bill.</p>
   <p><b>Krishna</b> gives the first approval. <b>Musa</b> gives the last one and chooses the company account it is
   paid <b>from</b>: <b>ZENITH — BLACK PANTHER</b> or <b>GTBANK — BLACK PANTHER</b>.</p>
   <p>The <b>finance phone</b> sees From and To together, transfers the money, taps ✔ Mark Done and sends the screenshot.</p>
   <p>Separately, customer <b>ABBA</b> pays <b>50,000</b> into Zenith and Abdul records it (Part H).</p></div>
  <div class="box"><div class="btitle">In this copy</div><ol class="toc">{"".join(f"<li>{html.escape(p)}</li>" for p in parts)}</ol></div>
 </div>
 {legend_html()}
</section>"""


def abdul_cover():
    parts = ["Register your bank account (once)", "Ask for a payment", "While you wait", "Approved",
             "Paid — or declined", "My requests", "Two things the bot will refuse", "Recording a customer's payment",
             "Your checklist — and if a card looks different"]
    return f"""
<section class="cover">
 <div class="brand">black_panther bot (formerly AtFactoryPrice) · Abdul's copy · {DATE}</div>
 <h1>Payments, card by card</h1>
 <div class="sub">Abdul — this shows only what <b>you</b> tap and what arrives on <b>your</b> phone. Krishna has the same
 pages with every other phone. Go through it together, card by card.</div>
 <div class="three">
  <div class="box"><div class="btitle">What you will do</div>
   <p>Register your bank account once. Ask for a payment (amount, what it is for, the bill). Wait while two admins
   approve. Receive the Paid message. Record a payment a customer made.</p>
   <p class="small">In the live test Krishna may ask you to type test figures instead of the example here
   (₦1,000 with the reason <b>TEST do not pay</b>; a salary of ₦1,100 and an advance of ₦1,500 for next month).
   The cards are the same; only the figures change.</p></div>
  <div class="box"><div class="btitle">Who else is involved</div>
   <div class="castrow">{badge("Krishna")}<span>admin — approves</span></div>
   <div class="castrow">{badge("Musa")}<span>admin — approves, and chooses the company account that pays you</span></div>
   <div class="castrow">{badge("Finance")}<span>the person who makes the bank transfer</span></div></div>
  <div class="box"><div class="btitle">In this copy</div><ol class="toc">{"".join(f"<li>{html.escape(p)}</li>" for p in parts)}</ol></div>
 </div>
 {legend_html()}
</section>"""


def checklist_owner(parts):
    per = checklist_rows(parts, messages_only=True)
    optional = [str(st.num) for p in parts if p.check for st in p.steps if not st.check]
    cols = []
    for n in NAMES:
        items = "".join(
            f'<li><span class="cbx">☐</span><span class="cstep">{num}</span>{html.escape(first)}'
            f'{"<span class=lnew>NEW</span>" if new else ""}</li>' for num, first, new in per[n])
        cols.append(f'<div class="ckcol"><div class="ckh">{badge(n)}</div><ul>{items}</ul></div>')
    return f"""
<section class="part"><div class="pband"><span class="pkey">✓</span><span class="ptitle">Checklist — every message each phone should receive, in order</span></div>
<div class="pintro">Parts A to E and H (the main journey). Each line is the first line of the card; the number is the step.
Tick it when it arrives. The order is part of the test. Left out: the optional steps
{", ".join(optional)} and the parts F and G (do them only when you test them).</div>
<div class="ckgrid">{"".join(cols)}</div></section>"""


def checklist_abdul(parts):
    per = checklist_rows(parts, only="Abdul")["Abdul"]
    half = (len(per) + 1) // 2
    cols = []
    for chunk in (per[:half], per[half:]):
        items = "".join(
            f'<li><span class="cbx">☐</span><span class="cstep">{num}</span>{html.escape(first)}'
            f'{"<span class=lnew>NEW</span>" if new else ""}</li>' for num, first, new in chunk)
        cols.append(f'<div class="ckcol"><ul>{items}</ul></div>')
    return f"""
<section class="part"><div class="pband"><span class="pkey">9</span><span class="ptitle">Your checklist — and if a card looks different</span></div>
<div class="pintro">Every screen and message that should appear on your phone in parts 1 to 5 and 8, in order. Each line is the first line
of the card; the number is the step. Tick it when it arrives. Optional taps (📋 Status, 🔔 Remind approvers) are left out.</div>
<div class="ckgrid two">{"".join(cols)}</div>
<div class="golden"><div class="gbody">If a card looks different from this guide: take a screenshot and send it to Krishna,
with the step number.</div><div class="gwhy">Send the whole card, with its buttons. A different word, a missing line, a different
button, or a message arriving in a different order all count. Do not tap anything else on that card until Krishna answers.</div></div>
</section>"""


def number_steps(parts):
    n = 0
    for p in parts:
        for st in p.steps:
            n += 1
            st.num = n


def assert_abdul_only(parts):
    for p in parts:
        for st in p.steps:
            for it in st.items:
                if isinstance(it, Gone):
                    continue
                names = it.phones() if isinstance(it, Card) else phones_of(it.card)
                if "Abdul" not in names:
                    die(f"Abdul's copy would show a card that is not on his phone: step {st.num}, {it.card['step'][:80]!r}")
                if "Outstanding" in it.card["text"]:
                    die(f"Abdul's copy would show a customer's outstanding balance: step {st.num}")


# Words in “…” in the guide's own prose that are NOT the bot's: the owner's own words.
NOT_BOT_WORDS = {"polished later"}
PROSE = []


def check_quotes():
    """Every “…” quote in the hand-written prose (Do lines, captions, intros,
    info boxes, covers, the swim-lane) must be the bot's words: each piece of it
    (split on …) must appear in some captured card's text or buttons. A wording
    change in the bot then stops the build instead of leaving a stale quote."""
    corpus = []
    for seg in CARDS.values():
        for c in seg:
            corpus.append(plain(c))
            corpus.append(c["text"])
            corpus.extend(x for row in c["buttons"] for x in row)
    blob = "\n".join(corpus)
    flat = re.sub(r"\s+", " ", blob)
    bad = []
    for chunk in PROSE:
        t = html.unescape(re.sub(r"<[^>]+>", "", chunk))
        for q in re.findall(r"“([^”]{2,200})”", t):
            if q in NOT_BOT_WORDS:
                continue
            pieces = [x.strip() for x in re.split(r"…|\.\.\.", q) if x.strip()]
            if not all(x in blob or re.sub(r"\s+", " ", x) in flat for x in pieces):
                bad.append(q)
    if bad:
        die("the guide quotes words no captured card carries (the bot's wording changed?): "
            + ", ".join(repr(x) for x in sorted(set(bad))))


def collect_prose(parts):
    for p in parts:
        PROSE.extend([p.title, p.intro, p.extra_html])
        for st in p.steps:
            PROSE.extend([st.do, st.caption or "", st.note or ""])


def check_buttons():
    missing = sorted({x for x in USED_BUTTONS if x not in ALL_BUTTONS})
    if missing:
        die("a Do: line names a button no captured card carries: " + ", ".join(repr(m) for m in missing))


def page(title, copy, body):
    css = CSS.replace("@@FOOT@@", FOOT.format(copy=copy).replace('"', '\\"'))
    return (f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title>"
            f"<style>{css}</style></head><body>{body}</body></html>")


def build_owner():
    parts = owner_parts()
    number_steps(parts)
    collect_prose(parts)
    PROSE.append(owner_cover())
    body = [owner_cover(), f'<section class="lanepage">{swimlane()}</section>']
    body.append('<section class="flow">' + "".join(render_part(p) for p in parts) + "</section>")
    body.append(checklist_owner(parts))
    return page("Payments card by card — owner", "owner's copy", "".join(body))


def build_abdul():
    parts = abdul_parts()
    number_steps(parts)
    collect_prose(parts)
    assert_abdul_only(parts)
    PROSE.append(abdul_cover())
    body = [abdul_cover(), f'<section class="lanepage">{swimlane(highlight="Abdul", title="The whole journey at a glance — your column is highlighted")}</section>']
    body.append('<section class="flow">' + "".join(render_part(p, you="Abdul") for p in parts) + "</section>")
    body.append(checklist_abdul(parts))
    return page("Payments card by card — Abdul", "Abdul's copy", "".join(body))


# ══════════════════════════════════════════════════════════════════════════
# 8. Style (look of scripts/build-pay2-guides.py, laid out landscape)
# ══════════════════════════════════════════════════════════════════════════
CSS = """
@page { size: A4 landscape; margin: 9mm 10mm 13mm;
  @bottom-left { content: "@@FOOT@@" counter(page); font: 7.6pt "DejaVu Sans", Arial, sans-serif; color: #7d8b99; } }
* { box-sizing: border-box; }
body { margin:0; font-family:"DejaVu Sans","Segoe UI",Arial,sans-serif; color:#16202a; font-size:9.6pt; line-height:1.38; }
section { page-break-after: always; }
section:last-child { page-break-after: auto; }
h1 { font-size:30pt; margin:3mm 0 1mm; letter-spacing:-.5px; color:#0e2a47; }
.brand { font-size:8.4pt; letter-spacing:2px; text-transform:uppercase; color:#7d8b99; font-weight:700; }
.sub { font-size:11.4pt; color:#3d4b59; margin-bottom:3mm; max-width:240mm; }
.small { font-size:8.4pt; color:#5d6b79; }
code { font-family:"DejaVu Sans Mono",monospace; font-size:.9em; background:#eef2f6; border-radius:1mm; padding:0 .8mm; }

.three { display:flex; gap:5mm; margin:4mm 0; }
.box { flex:1; border:1px solid #dde4ea; border-radius:3mm; padding:3.4mm 4mm; background:#fbfcfd; }
.btitle { font-weight:700; color:#0e2a47; margin-bottom:2mm; font-size:10.4pt; }
.box p { margin:0 0 1.8mm; }
.castrow { display:flex; align-items:center; gap:2.4mm; margin-bottom:2mm; font-size:9pt; }
.castrow .badge { min-width:20mm; text-align:center; }
.toc { margin:0; padding-left:5mm; font-size:9pt; } .toc li { margin-bottom:.8mm; }

.badge { display:inline-block; color:#fff; font-weight:800; border-radius:2mm; padding:.6mm 2.6mm; font-size:9.4pt; letter-spacing:.2px; }
.chip { display:inline-block; background:#22303f; color:#e9eef3; border-radius:1.4mm; padding:0 1.6mm; font-size:.92em; white-space:nowrap; }
.typed { display:inline-block; background:#fff7dc; border:1px solid #e3c770; color:#3b2f05; border-radius:1.2mm; padding:0 1.4mm;
         font-family:"DejaVu Sans Mono",monospace; font-size:.9em; }

.legend { display:flex; flex-wrap:wrap; gap:3mm 6mm; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 4mm; background:#f4f7fa; }
.lgi { display:flex; align-items:center; gap:2.4mm; font-size:8.8pt; width:85mm; }
.snum.mini { width:9mm; height:9mm; line-height:7.6mm; font-size:11pt; margin:0; }
.tg.mini { width:22mm; padding:1.4mm; position:relative; } .tg.mini .txt { font-size:7pt; }

/* swim-lane */
.lanebox { border:1px solid #dde4ea; border-radius:3mm; padding:3mm 4mm 2mm; }
.ltitle { font-weight:800; color:#0e2a47; font-size:13pt; margin-bottom:2.4mm; }
.lane { display:grid; grid-template-columns: 13mm repeat(4, 1fr) 38mm; }
.lh { padding:1.2mm 1.6mm 2mm; text-align:center; border-bottom:2px solid #0e2a47; }
.lrole { font-size:7.4pt; color:#5d6b79; margin-top:.8mm; }
.lc { position:relative; padding:1.5mm 1.8mm; min-height:16.5mm; display:flex; align-items:center; justify-content:center;
      border-bottom:1px solid #eef2f5; }
.lline { position:absolute; left:50%; top:0; bottom:0; border-left:2px dashed; opacity:.35; }
.ldo { position:relative; color:#fff; font-weight:700; border-radius:2mm; padding:1.4mm 2mm; font-size:8.4pt; text-align:center; width:100%; }
.lget { position:relative; background:#fff; border:1.8px solid; border-radius:2mm; padding:1.2mm 1.8mm; font-size:8pt; text-align:center; width:100%; }
.lstep { font-size:11pt; color:#0e2a47; }
.lwait { font-size:8.2pt; color:#3d4b59; justify-content:flex-start; text-align:left; }
.lh.lwait, .lh.lstep { font-weight:700; font-size:8.4pt; display:flex; align-items:flex-end; justify-content:center; }
.hl { background:#e8f1fa; }
.lnew { display:inline-block; background:#c0392b; color:#fff; font-size:6.6pt; font-weight:800; border-radius:1mm; padding:0 1mm; margin-left:1.2mm; vertical-align:1px; }
.lfoot { font-size:8.2pt; color:#5d6b79; margin-top:2mm; }

/* parts and steps */
.pband { display:flex; align-items:center; gap:3mm; background:#0e2a47; color:#fff; border-radius:2.4mm; padding:2mm 3.4mm; }
.pkey { display:inline-block; background:#fff; color:#0e2a47; font-weight:900; border-radius:1.6mm; padding:.2mm 2.4mm; font-size:11.6pt; }
.ptitle { font-size:13.4pt; font-weight:800; }
.pintro { margin:2.2mm 0 3mm; color:#31404e; font-size:9.6pt; }
.stepwrap { page-break-inside:avoid; break-inside:avoid; }
.step { display:flex; gap:4mm; margin:0; }
.sl { width:54mm; flex:none; border-left:3px solid; padding-left:2.6mm; }
.sr { flex:1; min-width:0; }
.snum { display:inline-block; width:12mm; height:12mm; line-height:10mm; text-align:center; border:2.4px solid; border-radius:6mm;
        font-weight:900; font-size:15pt; background:#fff; }
.whorow { margin:1.6mm 0 1.6mm; }
.do { color:#16202a; font-size:9.4pt; }
.cap { margin-top:1.8mm; font-size:8.8pt; color:#3d4b59; }
.snote { margin-top:1.8mm; font-size:8.6pt; background:#fff4f4; border-left:3px solid #a3232a; padding:1.2mm 2mm; border-radius:0 2mm 2mm 0; }
.tick { margin-top:2.2mm; display:inline-block; border:1.4px solid #1c6b45; color:#1c6b45; border-radius:1.6mm; padding:.6mm 2.4mm; font-weight:700; font-size:8.6pt; }
.part { margin-top:5mm; }
.part:first-child { margin-top:0; }
.keep { break-inside:avoid; page-break-inside:avoid; }
.tsteps { display:flex; gap:4mm; align-items:stretch; break-inside:avoid; page-break-inside:avoid; }
.tstep { flex:1; border:1px solid #dde4ea; border-top:3px solid; border-radius:2mm; padding:2.4mm 3mm; background:#fbfcfd; }
.tshead { display:flex; align-items:center; gap:2.4mm; margin-bottom:1.6mm; }
.then { display:flex; align-items:center; gap:2mm; height:3.4mm; margin:1.4mm 0 .8mm; color:#7d8b99; font-size:7pt; letter-spacing:1px; }
.then::before, .then::after { content:""; flex:1; border-top:1px dashed #c9d3dc; }
.then.alt { color:#a3232a; font-weight:700; font-size:7.6pt; letter-spacing:.4px; }

/* cards */
.cards { display:flex; flex-wrap:wrap; gap:3.4mm 3.6mm; align-items:flex-start; }
.col { width:52mm; break-inside:avoid; page-break-inside:avoid; }
.col.wide { width:70mm; }
.onphone { font-size:7.4pt; color:#3d4b59; font-weight:700; margin:0 0 .8mm; }
.dot { display:inline-block; width:2.4mm; height:2.4mm; border-radius:1.2mm; margin-right:1mm; vertical-align:-.2mm; }
.poplbl { font-size:6.8pt; color:#7d8b99; text-transform:uppercase; letter-spacing:.6px; margin-bottom:.4mm; }
.toast { display:inline-block; background:#3a4652; color:#fff; font-size:7.8pt; border-radius:3mm; padding:.8mm 3mm; margin-bottom:1.2mm; box-shadow:0 .4mm 1mm rgba(0,0,0,.25); }
.alertbox { background:#fff; border:1px solid #c5ced8; border-radius:2.4mm; padding:2mm 2.6mm 1.4mm; margin-bottom:1.2mm; box-shadow:0 .6mm 1.6mm rgba(0,0,0,.25); font-size:8pt; }
.aok { text-align:right; color:#1d6fa5; font-weight:700; font-size:8pt; margin-top:1mm; }
.tg { position:relative; background:#0e1621; border-radius:3mm; padding:2.2mm; }
.newrib { position:absolute; top:-1.6mm; right:-1.6mm; background:#c0392b; color:#fff; font-weight:900; font-size:7.6pt; letter-spacing:1px;
          border-radius:1.4mm; padding:.4mm 2.2mm; box-shadow:0 .4mm 1mm rgba(0,0,0,.3); z-index:2; }
.bubble { background:#182533; border-radius:2.4mm; padding:2mm 2.4mm 1.8mm; }
.txt { color:#e9eef3; font-size:7.7pt; line-height:1.36; white-space:pre-wrap; word-wrap:break-word; overflow-wrap:anywhere; }
.txt b { color:#fff; }
.txt i { color:#b4c4d3; font-style:italic; }
.txt code { background:#0e1621; border-radius:1mm; padding:0 .6mm; font-family:"DejaVu Sans Mono",monospace; font-size:7.2pt; color:#a9c7e4; }
.krow { display:flex; gap:1.2mm; margin-top:1mm; }
.kbtn { flex:1; min-width:0; background:#22303f; color:#e9eef3; text-align:center; font-size:7.3pt; padding:1.3mm 1mm; border-radius:1.6mm; overflow-wrap:anywhere; }
.pic { height:20mm; border-radius:1.8mm; margin-bottom:1.6mm; overflow:hidden; }
.doc { display:flex; align-items:center; gap:2mm; background:#0e1621; border-radius:1.8mm; padding:1.6mm 2mm; margin-bottom:1.4mm; }
.dicon { font-size:12pt; } .dname { color:#a9c7e4; font-size:7.8pt; }
.mockbill, .mockshot { height:100%; display:flex; align-items:center; justify-content:center; font-size:7.6pt; text-align:center; }
.mockbill { background:repeating-linear-gradient(0deg,#f3efe4 0 2.4mm,#e6e0cf 2.4mm 2.7mm); color:#3b3524; }
.mockbill span, .mockshot span { background:rgba(255,255,255,.92); border-radius:1.4mm; padding:1mm 2.4mm; font-weight:700; }
.mockshot { background:linear-gradient(180deg,#0b5d3b 0 24%,#f6f8f7 24% 100%); color:#0b3b27; }
.gonebox { border:1px dashed #93a3b2; border-radius:2mm; padding:2mm; font-size:8pt; color:#4a5866; }

/* info boxes */
.infobox { margin-top:4mm; border:1.6px solid #1d6fa5; background:#f3f8fd; border-radius:3mm; padding:3mm 4mm; page-break-inside:avoid; }
.ibtitle { font-weight:800; color:#0e2a47; font-size:11pt; margin-bottom:1.6mm; }
.infobox p { margin:0 0 1.6mm; } .infobox ul { margin:0 0 2mm; padding-left:5mm; } .infobox li { margin-bottom:1mm; }
.rules { border-collapse:collapse; margin:1mm 0 2mm; font-size:9pt; }
.rules th { background:#0e2a47; color:#fff; text-align:left; padding:1.2mm 2.4mm; font-size:8.4pt; }
.rules td { border-bottom:1px solid #d5dde5; padding:1.2mm 2.4mm; vertical-align:top; }
.rules td:first-child { font-weight:700; white-space:nowrap; }
.sheet { border-collapse:collapse; font-size:8.4pt; margin:1mm 0 2mm; }
.sheet th { background:#e8edf2; color:#3d4b59; border:1px solid #c5ced8; padding:.8mm 2.4mm; font-weight:700; }
.sheet td { border:1px solid #c5ced8; padding:.8mm 2.4mm; background:#fff; white-space:nowrap; }
.sheet .rn { background:#e8edf2; color:#3d4b59; text-align:center; }
.sheet .tnew { background:#fdecea; border:2px solid #c0392b; font-weight:700; }

/* checklist */
.ckgrid { display:grid; grid-template-columns: repeat(4, 1fr); gap:3mm; }
.ckgrid.two { grid-template-columns: 1fr 1fr; }
.ckh { margin-bottom:1.4mm; }
.ckcol ul { list-style:none; margin:0; padding:0; }
.ckcol li { font-size:7.4pt; line-height:1.3; padding:.7mm 0; border-bottom:1px solid #eef2f5; display:flex; gap:1.2mm; align-items:baseline; }
.cbx { color:#1c6b45; font-size:9pt; }
.cstep { display:inline-block; min-width:5mm; font-weight:800; color:#0e2a47; }
.golden { margin:4mm 0 0; border:2.4px solid #b8860b; background:#fffaf0; border-radius:3mm; padding:3mm 4mm; }
.gbody { font-size:13pt; font-weight:700; margin:0 0 1.4mm; color:#1d1502; }
.gwhy { font-size:9pt; color:#4a4231; }
"""


# ══════════════════════════════════════════════════════════════════════════
# 9. Printing
# ══════════════════════════════════════════════════════════════════════════
def chromium():
    for c in sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"), reverse=True):
        if os.access(c, os.X_OK):
            return c
    for name in ("chromium", "chromium-browser", "google-chrome"):
        p = shutil.which(name)
        if p:
            return p
    die("no Chromium found (looked in /opt/pw-browsers/chromium-*/chrome-linux/chrome and on PATH for chromium)")


def print_pdf(html_path, pdf_path):
    exe = chromium()
    pdf = pathlib.Path(pdf_path)
    if pdf.exists():
        pdf.unlink()  # so a run that writes nothing can never leave the old PDF looking fresh
    p = subprocess.run([exe, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-pdf-header-footer",
                        f"--print-to-pdf={pdf_path}", str(html_path)], capture_output=True, text=True)
    if p.returncode != 0 or not pathlib.Path(pdf_path).exists():
        sys.stderr.write(p.stderr[-3000:])
        die(f"Chromium could not print {html_path}")
    print("wrote", pdf_path)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--json-dir")
    ap.add_argument("--save-json")
    ap.add_argument("--no-pdf", action="store_true")
    args = ap.parse_args()

    data = run_captures(args.json_dir, args.save_json)
    CARDS.update(normalise(data))
    for seg in CARDS.values():
        for c in seg:
            for row in c["buttons"]:
                ALL_BUTTONS.update(row)

    outputs = [("PAY-6_CARDS_OWNER", "Payments card by card — owner", build_owner()),
               ("PAY-6_CARDS_ABDUL", "Payments card by card — Abdul", build_abdul())]
    check_buttons()
    PROSE.extend(x for row in LANE for x in [row[2], row[4], *row[3].values()])
    check_quotes()
    for name, _title, doc in outputs:
        hp = DOCS / f"{name}.html"
        hp.write_text(doc, encoding="utf-8")
        print("wrote", hp)
        if not args.no_pdf:
            print_pdf(hp, DOCS / f"{name}.pdf")


if __name__ == "__main__":
    main()
