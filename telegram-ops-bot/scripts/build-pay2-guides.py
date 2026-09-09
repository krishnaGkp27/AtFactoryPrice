#!/usr/bin/env python3
"""PAY-2 — build the three role guides for the live payment test.

Writes:
    docs/PAY-2_GUIDE_WORKER.html    the two requesters (each raises his own request)
    docs/PAY-2_GUIDE_ADMIN.html     the two admins (first signer AND second signer)
    docs/PAY-2_GUIDE_FINANCE.html   the Office phone (the Railway FINANCE_IDS seat)

Usage (regenerate after any wording change in the flow):
    python3 scripts/build-pay2-guides.py
    for r in WORKER ADMIN FINANCE; do
      /opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless=new --disable-gpu \
        --no-sandbox --no-pdf-header-footer \
        --print-to-pdf=docs/PAY-2_GUIDE_$r.pdf docs/PAY-2_GUIDE_$r.html
    done
(any Chromium works; plain `chromium --headless ...` is the same command)

Every card body and button string below is copied VERBATIM from the shipped
code (main e7053cae — paymentFlow, paymentCards, approvalEvents,
approvalsInboxFlow, inventoryService, paymentService), with the Markdown
resolved the way Telegram renders it (*x* -> bold, _x_ -> dim italic,
`x` -> mono).  Lifecycle per specs/PAY-2_PAYMENT_REASON.md §2 and §5 and
docs/PAY-2_CARDS_AND_FLOW.html.

Worked example used throughout: worker Abdul asks for ₦4,000 into OPAY
7048940378, reason "Transport to Idumota", bill photo attached; admins =
the Owner (first signer) and Admin 2 (second signer); finance = the Office
phone.  The Paid notice goes out AT the ✔ Mark Done tap (row flipped,
buttons wiped, requester + both signers told), THEN the proof prompt; a
proof follows the same three people as "📎 Proof of transfer — PAY-…";
skip sends nothing more.
"""
import html
import pathlib

DOCS = pathlib.Path(__file__).resolve().parents[1] / "docs"
DATE = "09-Sep-2026"

UUID = "9ddc4b7e-2f1a-4c58-9e0b-7a1d3c5f2b84"
UUID_ACC = "5b21c7e0-8d4f-4a6b-9c13-2e7f0a9d4b61"
SHORT = "R-9DDC"
SHORT_ACC = "R-5B21"
PAYREF = "PAY-20260909-3F9A2C1E"


# ── Telegram renderer ────────────────────────────────────────────────────
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
        if c == "_" and (i == 0 or not t[i-1].isalnum()):
            j = t.find("_", i + 1)
            if j > i and (j + 1 >= n or not t[j+1].isalnum()):
                out.append(f"<i class=dim>{t[i+1:j]}</i>"); i = j + 1; continue
        if c == "`":
            j = t.find("`", i + 1)
            if j > i:
                out.append(f"<code>{t[i+1:j]}</code>"); i = j + 1; continue
        out.append(c); i += 1
    return "".join(out).replace("\n", "<br>")


def card(body, buttons=(), kind="text", photo=None, caption=None, time="14:32",
         who=None, toast=None, faded=False):
    """One Telegram message bubble.  kind: text | photo | document.
    who   = small label above the bubble ("from the bot, on Abdul's phone")
    toast = the grey pop-up Telegram shows for a moment after a tap
    faded = the bubble's buttons are gone (drawn greyed, no chips)"""
    p = []
    if who:
        p.append(f'<div class="who">{html.escape(who)}</div>')
    if toast:
        p.append(f'<div class="toast">{html.escape(toast)}</div>')
    p.append('<div class="tg">')
    p.append('<div class="bubble">')
    if kind == "photo":
        p.append(f'<div class="pic">{photo or PIC_BILL}</div>')
    if kind == "document":
        p.append(f'<div class="doc"><span class="dicon">📄</span><span class="dname">{html.escape(photo or "")}</span></div>')
    text = (caption or body) if kind in ("photo", "document") else body
    if text:
        p.append(f'<div class="txt">{md(text)}</div>')
    p.append(f'<div class="time">{time}</div>')
    p.append("</div>")
    if faded:
        p.append('<div class="gone">buttons gone</div>')
    for row in buttons:
        p.append('<div class="krow">')
        for b in row:
            p.append(f'<div class="kbtn">{html.escape(b)}</div>')
        p.append("</div>")
    p.append("</div>")
    return "".join(p)


PIC_BILL = '<div class="mockbill"><span>the bill photo</span></div>'
PIC_SHOT = '<div class="mockshot"><span>the bank-app screenshot</span></div>'


def step(n, title, do, right, receive=None, waits=False, tip=None, warn=None, variants=None):
    """One numbered step.  do = what to tap/type (bold); receive = what lands
    on the phone and from whom; waits = the role only waits here."""
    t = ['<div class="step"><div class="sleft">',
         f'<div class="snum{" wait" if waits else ""}">{n}</div><div class="stitle">{title}</div>']
    if waits:
        t.append(f'<div class="slead"><span class="waitlbl">Nothing to do</span> — {do}</div>')
    else:
        t.append(f'<div class="slead"><b>Do:</b> {do}</div>')
    if receive:
        t.append(f'<div class="recv"><b>You receive:</b> {receive}</div>')
    if tip:
        t.append(f'<div class="tip">{tip}</div>')
    if warn:
        t.append(f'<div class="warn">{warn}</div>')
    if variants:
        t.append('<div class="vars"><b>If the bot says something else:</b><ul>' +
                 "".join(f"<li>{v}</li>" for v in variants) + "</ul></div>")
    t.append('<div class="tick">☐ &nbsp;matches</div>')
    t.append('</div><div class="sright">' + right + '</div></div>')
    return "".join(t)


def h2(text):
    return f'<div class="ph">{text}</div>'


def checklist(items, role):
    rows = "".join(
        f'<tr><td class="cb">☐</td><td class="cwhen">{html.escape(w)}</td><td class="cmsg">{m}</td></tr>'
        for w, m in items)
    return f"""
<section class="page">
  {h2("Checklist &nbsp;·&nbsp; every message the " + role + " should see, in order")}
  <p class="lead">Tick each one as it arrives. The order matters — it is part of what is being tested.</p>
  <table class="ck"><thead><tr><th></th><th>When</th><th>What arrives</th></tr></thead><tbody>{rows}</tbody></table>
  <div class="golden"><div class="gbody">If anything differs, screenshot it and send it to the owner.</div>
  <div class="gwhy">Include the whole card — the time on it and the buttons under it. A wrong word, a missing line or a message that arrives in the wrong order all count.</div></div>
  <div class="foot">AtFactoryPrice · Payments live test · {role} guide · version {DATE}</div>
</section>"""


def cover(title, forwho, intro, prereqs, cast_note, steps_map):
    pre = "".join(f"<li>{p}</li>" for p in prereqs)
    mp = "".join(f'<div class="mstep"><b>{i+1}</b> {s}</div>' + ('<div class="marr">→</div>' if i < len(steps_map) - 1 else "")
                 for i, s in enumerate(steps_map))
    return f"""
<section class="page cover">
  <div class="brand">AtFactoryPrice · Live test guide</div>
  <h1>{title}</h1>
  <div class="sub">{forwho}</div>
  <div class="for">Date: <b>{DATE}</b> &nbsp;·&nbsp; Telegram: <b>Black Panther_Bot</b> &nbsp;·&nbsp; {intro}</div>

  <div class="two">
    <div class="box">
      <div class="btitle">The one payment everyone is testing</div>
      <p><b>Abdul</b> (a worker) asks for <b>₦4,000</b> into <b>OPAY 7048940378</b>, reason <b>Transport to Idumota</b>, with a photo of the bill.</p>
      <p><b>The Owner</b> signs first, <b>Admin 2</b> signs second. A payment needs two <i>different</i> admins when two are set up; if the Owner is the only admin, his one approval completes it. The person who asked can never sign his own.</p>
      <p><b>The Office phone</b> (finance) pays by hand in the bank app, taps <b>✔ Mark Done</b>, then sends the screenshot.</p>
      <p class="small">{cast_note}</p>
    </div>
    <div class="box">
      <div class="btitle">Before you start</div>
      <ul>{pre}</ul>
    </div>
  </div>

  <div class="map">
    <div class="mtitle">The whole job at a glance</div>
    <div class="mrow">{mp}</div>
  </div>
  <div class="notebox"><b>How to read the pages that follow.</b> The dark bubbles are exactly what the bot prints. <b>Do:</b> is what you tap or type. <b>You receive:</b> says what should land on your phone at that moment and who it comes from. Tick <b>☐ matches</b> when it does. A grey number means you only wait at that step. A <b>small grey pop-up</b> is the short note Telegram shows for a moment after a tap, then hides.</div>
  <div class="foot">Every screen in this guide is exactly what the bot shows. Guide version {DATE}.</div>
</section>"""


# ── the real strings ─────────────────────────────────────────────────────
# Payments hub
HUB_WORKER_NOACC = "💳 *Payments*\n\n_You have no registered account yet — register one before requesting a payment._"
HUB_WORKER_ACC = "💳 *Payments*\n\nYou have *1* registered account."
HUB_ADMIN = "💳 *Payments*\n\nYou have *1* registered account.\nFinance: *Office* pays and marks done."
HUB_ADMIN_NOACC = "💳 *Payments*\n\n_You have no registered account yet — register one before requesting a payment._\nFinance: *Office* pays and marks done."
HUB_FINANCE = "💳 *Payments*\n\n_You have no registered account yet — register one before requesting a payment._"
B_HUB = [["🏦 Register account"], ["💸 Request payment"], ["📋 My requests"], ["🏠 Back to menu"]]
B_HUB_FIN = [["🏦 Register account"], ["💸 Request payment"], ["📋 My requests"], ["💳 Waiting for me to pay (0)"], ["🏠 Back to menu"]]
B_HUB_FIN1 = [["🏦 Register account"], ["💸 Request payment"], ["📋 My requests"], ["💳 Waiting for me to pay (1)"], ["🏠 Back to menu"]]
WARN_NOFIN = "⚠️ No one is in the Finance department yet — this is with all admins until the Users sheet names exactly one finance person."
WARN_TWOFIN = "⚠️ 2 people are in the Finance department. One finance ID makes payments — fix the Users sheet; meanwhile this is with all admins."

# Register account
REG_NUM = "🏦 *Account for Abdul*\n\nType the *10-digit account number*."
REG_NUM_9 = "⚠️ Nigerian account numbers are 10 digits — that was 9."
REG_NUM_EMPTY = "⚠️ Enter the account number (digits only)."
REG_AGAIN = "🔁 *Type it once more*\n\nAn account number is the one thing here nothing else can check — so type it again and the bot will compare."
REG_MISMATCH = "⚠️ *The two did not match.*\n\nThat is exactly what this step is for. Type the 10-digit account number again."
REG_BANK = "🏦 *7048940378*\n\nWhich bank?"
B_BANK = [["🏛 GTBank", "🏛 Zenith"], ["🏛 FirstBank", "🏛 Access"], ["🏛 UBA", "🏛 OPAY"], ["⬅ Back", "❌ Cancel"]]
B_BACKCANCEL = [["⬅ Back", "❌ Cancel"]]
REG_CONFIRM = "🏦 *Register this account?*\n\n👤 Abdul · employee\n🔢 7048940378\n🏛 OPAY\n\n_Two admins must approve before any payment can be raised against it._"
B_SUBMIT = [["✅ Submit for approval"], ["⬅ Back", "❌ Cancel"]]
REG_SENT = "⏳ *Sent for approval*\n\n🏦 OPAY 7048940378\n👤 Abdul\n\n_You’ll be told when two admins have signed it._"
B_HOME = [["🏠 Back to menu"]]
REG_CLASH = "⚠️ *Already registered*\n\nOPAY 7048940378 is already registered and active for *Abdul*.\n\nNothing was submitted."

# Admin card — account
ADM_ACC = (f"🔔 *Approval required*\n\nRef: `{UUID_ACC}`\nFrom: Abdul\n\n"
           "Register payment account: Abdul (employee)\nAccount: 7048940378 · OPAY\n"
           "Linked Telegram: Abdul · 7012345678 ✓ registered employee\n"
           "Once approved, payments can be raised against this account.\n\n"
           "_All register payment account operations require two-admin approval._\n\nUse buttons below to approve or reject.")
B_APPROVE = [["✅ Approve", "❌ Reject"]]
ADM_ACC_DONE = f"✅ Request {UUID_ACC} approved by Owner + Admin 2. Changes applied."
ADM_ACC_FAIL = "⚠️ Approved but execution failed: Not registered: <message>"

# DUAL-1 messages
TOAST_1OF2 = "🔏 Approval 1 of 2 recorded."
DM_1OF2 = lambda u: f"🔏 Request {u}: your approval is recorded (1 of 2). Waiting for a second admin."
DM_POINTER = lambda u, a: f"🔔 Request {u} ({a}) has its first admin approval and needs a SECOND. Use the approval card in your chat."
DM_WORKER_1OF2 = lambda u: f"🔏 Your request ({u}) has 1 of 2 admin approvals — signed by Owner. One more to go."
ALERT_REPEAT = "🔏 You already gave the first approval — a different admin must give the second."
ALERT_SELF = "🔒 You cannot approve your own request — a second admin must review it."
ALERT_NONADMIN = "Only admins can approve."

WORKER_ACC_OK = f"✅ Your request {SHORT_ACC} has been approved by admin. Changes applied."

# Request payment
REQ_PICK = "💸 *Request payment*\n\nPay into which account?"
B_PICK = [["👤 Abdul · OPAY 7048940378"], ["❌ Cancel"]]
REQ_NOACC = "💸 *Request payment*\n\n_No approved account to pay into yet._\n\nRegister an account first — it needs two admins before a payment can use it."
B_NOACC = [["🏦 Register account"], ["🏠 Back to menu"]]
REQ_AMOUNT = "💸 *Abdul*\n🏦 OPAY 7048940378\n\nHow much, in naira? Type the figure, e.g. `45000`."
REQ_REASON = "💸 *Abdul*\n🏦 OPAY 7048940378 · ₦4,000\n\n📝 *What is this payment for?*\nType a short reason — e.g. transport to Idumota, loading at the warehouse."
REQ_REASON_BAD = "⚠️ Give a reason of 3 to 120 characters."
REQ_BILL = "📎 *Any paperwork?*\n\nSend a photo or PDF of the bill or invoice, or skip — it is not required."
B_BILL = [["⏭ Skip — no bill"], ["⬅ Back", "❌ Cancel"]]
REQ_CONFIRM = ("💸 *Send this for approval?*\n\n👤 Abdul · employee\n🏦 OPAY 7048940378\n💰 *₦4,000*\n"
               "📝 Transport to Idumota\n📎 Bill attached\n\n_Two admins approve, then finance pays._")
REQ_SENT = f"⏳ *Sent for approval*\n\n💰 ₦4,000 → Abdul\n`{PAYREF}`\n\n_Two admins sign, then finance pays and marks it done._"
REQ_ERR = "⚠️ Could not submit: <error>"

# Admin card — payment
ADM_PAY = (f"🔔 *Approval required*\n\nRef: `{UUID}`\nFrom: Abdul\n\n"
           "Payment request: ₦4,000\nPayee: Abdul (employee)\nAccount: 7048940378 · OPAY\n"
           "Reason: Transport to Idumota\nBill: attached\n\n"
           "_All request payment operations require two-admin approval._\n\nUse buttons below to approve or reject.")
ADM_BILL_CAP = f"📎 Bill for payment request {UUID}"
ADM_DUP = "⚠️ *Possible duplicate* — same request also pending as `xxxxxxxx…`. Approve ONE, reject the rest."
ADM_REMIND = "⏰ Reminder — this approval is still waiting"

# Inbox
INBOX_CAT = "💳 Payments — 1 ⚠️ 🟢today"
INBOX_ROW = "🟢 09 Sept · request payment · Abdul"  # day + short month, no year; the bot spells it Sept
INBOX_CHIPS = "Category chip: " + INBOX_CAT + "\nList chip: " + INBOX_ROW
INBOX_ITEM = ("Payment request: ₦4,000\nPayee: Abdul (employee)\nAccount: 7048940378 · OPAY\n"
              f"Reason: Transport to Idumota\nBill: attached\n\n_Requested by Abdul · today · {SHORT}_")
INBOX_ITEM_1OF2 = INBOX_ITEM + "\n⚠️ _1 of 2 approvals already given — a different admin must give the second._"
B_INBOX = [["✅ Approve", "❌ Reject"], ["📄 Bill"], ["⬅ Back to list"], ["❌ Close"]]
INBOX_REC = ("Payment request: ₦4,000\nPayee: Abdul (employee)\nAccount: 7048940378 · OPAY\n"
             f"Reason: Transport to Idumota\nBill: attached\n\n✅ _Already approved · {DATE} — no action needed._\n"
             f"💸 Paid by Office · {DATE}, 15:10 · {PAYREF}")
B_INBOX_REC = [["📄 Bill"], ["⬅ Back to list"], ["❌ Close"]]

# Second signature
ADM_APPROVED = f"✅ Request {UUID} approved by Owner + Admin 2. Changes applied."
ADM_NOTE = "✅ Payment of ₦4,000 to Abdul approved by Owner ‖ Admin 2 — now with finance to pay."
ADM_EXEC_FAIL = "⚠️ Approved but execution failed: <message>"
WORKER_APPROVED = f"✅ Your request {SHORT} has been approved by admin. Changes applied."
# approvalEvents joins the executor's note onto the SAME message with a newline
# (`approvedMsg + creditTail + noteTail`) — one message, two lines, on both sides.
ADM_APPROVED_FULL = ADM_APPROVED + "\n" + ADM_NOTE
WORKER_APPROVED_FULL = WORKER_APPROVED + "\n" + ADM_NOTE
WORKER_EXEC_FAIL = f"⚠️ Your request ({UUID}) was approved but could not be completed. Admin has been notified. Please follow up."
TOAST_APPROVING = "Approving..."
TOAST_STALE = "Already approved — nothing to do."
DM_STALE = f"ℹ️ Request {UUID} was already approved on {DATE} — no change made."

# Finance card
FIN_CARD = ("💳 *Payment* — Abdul · employee\n🏦 7048940378 · OPAY\n💰 *₦4,000*\n📝 Transport to Idumota\n"
            f"📎 Bill attached\n✅ Approved: Owner ‖ Admin 2\n_Raised by Abdul · {DATE}, 14:32_\n`{PAYREF}`")
B_FIN = [["✔ Mark Done", "✖ Decline"]]
WAIT_LIST = "💳 *Waiting for me to pay*\n\n_Tap one to get its card again._"
B_WAIT = [["₦4,000 → Abdul · 09-Sep-26 · Transport to Idumota"], ["⬅ Back"], ["🏠 Back to menu"]]
WAIT_EMPTY = "💳 *Waiting for me to pay*\n\n_Nothing approved is waiting — every approved payment has been paid or declined._"
B_WAIT_EMPTY = [["⬅ Back"], ["🏠 Back to menu"]]
WAIT_NOTFIN = "_That list is for the finance seat._"
WAIT_STALE = "_That list expired._"

# Mark Done
TOAST_DONE = "Marked done."
PROOF_PROMPT = f"📎 *Proof of transfer?*\n\nSend a screenshot of the bank transfer, or skip.\n₦4,000 → Abdul · `{PAYREF}`"
B_PROOF = [["⏭ Skip — no proof"]]
PAID_NOTICE = (f"💸 Paid — ₦4,000 to Abdul (employee)\n📝 Transport to Idumota\n🏦 OPAY 7048940378\n"
               f"Paid by Office · {DATE}, 15:10\nRef {PAYREF} · approved by Owner ‖ Admin 2")
PAID_CARD_PROOF = f"✅ *Paid* — ₦4,000 to Abdul\n`{PAYREF}`\n\n_Recorded {DATE}, 15:10._\n📎 Proof attached"
PAID_CARD_NOPROOF = f"✅ *Paid* — ₦4,000 to Abdul\n`{PAYREF}`\n\n_Recorded {DATE}, 15:10._"
PROOF_CAP = f"📎 Proof of transfer — {PAYREF} · ₦4,000 to Abdul (employee)"
GUARDS_DONE = ["Only the finance person marks a payment done.", "That payment was not found.",
               "Already marked done.", "That payment is pending approval — it cannot be paid."]

# My requests
MINE_PAID = "📋 *My requests*\n\n✅ ₦4,000 — paid · 📝 Transport to Idumota\n   _09-Sep-26_"
MINE_WAIT = "📋 *My requests*\n\n⏳ ₦4,000 — waiting for approval · 📝 Transport to Idumota\n   _09-Sep-26_"
MINE_NONE = "📋 *My requests*\n\n_You have not asked for a payment yet._"
MINE_REJ = "📋 *My requests*\n\n❌ ₦4,000 — rejected · 📝 Transport to Idumota\n   _09-Sep-26_"
MINE_DEC = "📋 *My requests*\n\n✖ ₦4,000 — declined by finance · 📝 Transport to Idumota\n   _09-Sep-26_ · Account name does not match — send the OPAY name."

# Exits
TOAST_REJECTING = "Rejecting..."
ADM_REJECTED = f"❌ Request {UUID} rejected."
ADM_REJECT_FAIL = "⚠️ Rejection failed: <message>"
WORKER_REJECTED = f"❌ Your request {SHORT} has been rejected by admin."
INBOX_REC_REJ = ("Payment request: ₦4,000\nPayee: Abdul (employee)\nAccount: 7048940378 · OPAY\n"
                 f"Reason: Transport to Idumota\nBill: attached\n\n❌ _Already rejected · {DATE} — no action needed._\n"
                 "❌ Rejected by Owner")
DEC_PROMPT = "✖ *Decline ₦4,000 to Abdul*\n\nWhy? The person who asked will see this, so say what would make it payable."
B_DEC = [["❌ Cancel"]]
DEC_SHORT = "⚠️ Give a reason — the requester needs to know what to fix."
DEC_DONE = "✖ *Declined* — ₦4,000 to Abdul\n\n_Account name does not match — send the OPAY name._\n\nThe requester has been told."
DEC_CANCELLED = "❌ Cancelled."
DEC_NOTICE = (f"✖ Payment declined — ₦4,000 to Abdul (employee) was not paid.\n📝 Transport to Idumota\n🏦 OPAY 7048940378\n"
              f"Declined by Office · {DATE}, 15:10\nAccount name does not match — send the OPAY name.\n"
              f"Ref {PAYREF} · approved by Owner ‖ Admin 2")
GUARDS_DEC = ["Only the finance person can decline a payment.", "That payment was not found.",
              "That payment is done — nothing to decline."]
INBOX_REC_DEC = ("Payment request: ₦4,000\nPayee: Abdul (employee)\nAccount: 7048940378 · OPAY\n"
                 f"Reason: Transport to Idumota\nBill: attached\n\n✅ _Already approved · {DATE} — no action needed._\n"
                 "✖ Declined by Office · Account name does not match — send the OPAY name.")
INBOX_REC_WITHFIN = ("Payment request: ₦4,000\nPayee: Abdul (employee)\nAccount: 7048940378 · OPAY\n"
                     f"Reason: Transport to Idumota\nBill: attached\n\n✅ _Already approved · {DATE} — no action needed._\n"
                     "🏦 With finance to pay")

NOT_AUTH = "You are not authorized to use this bot."
EXIT_A_FIN = ("Payment request: ₦4,000\nPayee: Abdul (employee)\nAccount: 7048940378 · OPAY\nReason: Transport to Idumota\n\n"
              "_(no finance card — the request was rejected before approval)_")


def alerts(items):
    return "".join(f'<div class="alert">{html.escape(a)}</div>' for a in items)


def bubble_list(*cards):
    return "".join(cards)


# ═════════════════════════════════════════════════════════════════════════
# WORKER GUIDE
# ═════════════════════════════════════════════════════════════════════════
def build_worker():
    P = []
    P.append(cover(
        "Payments live test — Worker guide",
        "For the two workers who ask for money: each of you does every step of this guide on your own phone, with your own account and your own request.",
        "About 10 minutes of tapping, then waiting",
        [
            "The owner has put you on the Users list as an <b>active employee</b>. You are <b>not</b> an admin — if you were, you could not be a requester in this test.",
            "You have sent <b>/start</b> to the bot at least once, so it can message you.",
            "Your bank is in the bot's bank list. For <b>OPAY</b> the owner adds it first — if you do not see 🏛 OPAY at step 3, stop and tell him.",
            "Have the <b>bill photo</b> on your phone (any receipt or invoice picture will do for the test).",
            "Know your account number by heart — the bot asks for it <b>twice</b> and compares.",
            "If you already have an approved account in the bot, skip steps 2–5 and start at step 6.",
        ],
        "In this guide the worker is called <b>Abdul</b>. Read your own name wherever it says Abdul.",
        ["Open 💳 Payments", "🏦 Register account", "Two admins sign it", "💸 Request payment", "Two admins sign", "Wait for 💸 Paid", "📋 My requests"],
    ))

    # ── part A: account ──
    P.append(f"""
<section class="flow">
  {h2("Part A &nbsp;·&nbsp; Register your account (once, before any payment)")}
  {step(1, "Open 💳 Payments",
        "send <b>/menu</b> (or <b>/start</b>) to the bot and tap the <b>💳 Payments</b> tile. It is on your first screen and also inside 💰 Finance.",
        card(HUB_WORKER_NOACC, B_HUB, who="the bot, on your phone"),
        receive="the Payments card. Because you have no account yet, the middle line says so in grey.",
        tip="No 💳 Payments tile? You are not on the Users list as active, or you are not allowed to use the bot at all (the bot would answer <i>You are not authorized to use this bot.</i>). Tell the owner.")}
  {step(2, "Tap 🏦 Register account, then type your account number",
        "tap <b>🏦 Register account</b>. The bot does not ask whose account — it is yours. Type <b>7048940378</b> (your own 10 digits).",
        card(REG_NUM, B_BACKCANCEL, who="the bot, on your phone"),
        receive="the <b>Account for Abdul</b> card (your own name on it).",
        variants=[f"<i>{html.escape(REG_NUM_9)}</i> — you typed the wrong number of digits; type all 10.",
                  f"<i>{html.escape(REG_NUM_EMPTY)}</i> — you sent something that is not a number."])}
  {step(3, "Type it once more, then tap your bank",
        "type the <b>same 10 digits again</b>. When they match the bot shows the number in bold and asks for the bank — tap <b>🏛 OPAY</b>.",
        bubble_list(card(REG_AGAIN, B_BACKCANCEL, who="the bot, after the first number"),
                    card(REG_BANK, B_BANK, who="the bot, after the second number matched")),
        receive="first the <b>Type it once more</b> card, then the <b>Which bank?</b> card with the bank chips, two per row.",
        warn="No 🏛 OPAY chip? The owner has not added OPAY to the bank list yet. Tap ❌ Cancel and tell him — do not pick a different bank for the test.",
        variants=[f"<i>{html.escape('⚠️ The two did not match.')}</i> — the two numbers differ. That is the check working; type the number again, carefully."])}
  {step(4, "Check and submit",
        "read the three lines. If they are right, tap <b>✅ Submit for approval</b>. A new <b>⏳ Sent for approval</b> card arrives below; the old card stays on screen — its button no longer does anything (tapping it only says <i>That screen expired.</i>).",
        bubble_list(card(REG_CONFIRM, B_SUBMIT, who="the bot, on your phone"),
                    card(REG_SENT, B_HOME, who="a new card, sent straight after")),
        receive="the confirmation card. Two admins now get a card each on their own phones; you are told when each one signs.",
        variants=[f"<i>⚠️ Already registered — OPAY 7048940378 is already registered and active for …</i> — that account is already in the bot; nothing was submitted. Skip to step 6.",
                  "<i>⚠️ Could not submit: …</i> — the bot could not reach the office records. Tell the owner; nothing was sent."])}
  {step(5, "Wait for the two signatures",
        "you will receive <b>two plain messages</b>, one after each admin signs. Nothing to tap.",
        bubble_list(card(DM_WORKER_1OF2(UUID_ACC), who="the bot, when the Owner signs", time="14:20"),
                    card(WORKER_ACC_OK, who="the bot, when Admin 2 signs", time="14:22")),
        receive="<b>first</b> the 🔏 “1 of 2 … signed by Owner” message (the first signer's name is on it), <b>then</b> the ✅ “approved by admin. Changes applied.” message. After the second one your account is live.",
        waits=True,
        tip="The long code in brackets is the request number; the admins know it by its first four letters (here <b>R-5B21</b>). If it has not come by the end of the day, ask the owner — the request is waiting, nothing is lost.")}
</section>""")

    # ── part B: request ──
    P.append(f"""
<section class="flow">
  {h2("Part B &nbsp;·&nbsp; Ask for the ₦4,000")}
  {step(6, "Open 💳 Payments → 💸 Request payment → pick your account",
        "open <b>💳 Payments</b> again (it now says <i>You have 1 registered account</i>), tap <b>💸 Request payment</b>, then tap the chip <b>👤 Abdul · OPAY 7048940378</b>.",
        bubble_list(card(HUB_WORKER_ACC, B_HUB, who="the Payments card now"),
                    card(REQ_PICK, B_PICK, who="the bot, after 💸 Request payment")),
        receive="the <b>Pay into which account?</b> card with one chip: your approved account. You only ever see your own accounts.",
        variants=["<i>No approved account to pay into yet.</i> with a 🏦 Register account button — your account is not approved yet (or was rejected). Go back to step 5 and wait, or ask the owner."])}
  {step(7, "Type the amount",
        "type <b>4000</b> (digits only, no ₦, no comma).",
        card(REQ_AMOUNT, B_BACKCANCEL, who="the bot, on your phone"),
        receive="the amount card naming you and your account.",
        warn="<b>⬅ Back</b> on this card and the next ones takes you back to the <b>Payments hub</b>, not to the previous question. If you want to change something, go back and start the request again — nothing is sent until you tap ✅ Submit.",
        variants=["<i>⚠️ …</i> with a reason — the figure was not a valid amount. Type digits only."])}
  {step(8, "Type the reason",
        "type <b>Transport to Idumota</b>. Between 3 and 120 characters; there is no skip — every payment must say what it is for.",
        card(REQ_REASON, B_BACKCANCEL, who="the bot, on your phone"),
        receive="the <b>📝 What is this payment for?</b> card, with your amount already on line two.",
        variants=[f"<i>{html.escape(REQ_REASON_BAD)}</i> on top of the same card — too short or too long; type it again."])}
  {step(9, "Send the bill photo",
        "send the <b>bill photo</b> (a normal photo is fine here, or a PDF as a File). For this test do <b>not</b> skip — the admins and finance must see the bill.",
        card(REQ_BILL, B_BILL, who="the bot, on your phone"),
        receive="the <b>📎 Any paperwork?</b> card. After you send the photo the bot goes straight to the confirm card.",
        tip="A real request may skip this with ⏭ Skip — no bill. Then the cards simply have no 📎 line.")}
  {step(10, "Check and submit",
        "read every line. If they are right, tap <b>✅ Submit for approval</b>.",
        card(REQ_CONFIRM, B_SUBMIT, who="the bot, on your phone"),
        receive="the <b>Send this for approval?</b> card: your name, account, <b>₦4,000</b>, the reason and <i>📎 Bill attached</i>.",
        tip="For ₦50,000 and above the amount line also says <i>⚠️ large payment</i>. Not for ₦4,000.")}
  {step(11, "Your receipt",
        "nothing more to tap — a new card arrives below; the old <b>Send this for approval?</b> card stays on screen — its button no longer does anything (tapping it only says <i>That screen expired.</i>). Note the <b>PAY-…</b> number: it is on every later message about this payment.",
        card(REQ_SENT, B_HOME, who="a new card, sent straight after"),
        receive="<b>⏳ Sent for approval</b> with the amount and the PAY number. Both admins now have your card and the bill photo on their phones.",
        variants=[f"<i>{html.escape(REQ_ERR)}</i> — nothing was sent; tell the owner."])}
</section>""")

    # ── part C: waiting ──
    P.append(f"""
<section class="flow">
  {h2("Part C &nbsp;·&nbsp; Wait — four messages will come, in this order")}
  {step(12, "First signature",
        "you will receive one plain message when the <b>first admin</b> signs. It names him.",
        card(DM_WORKER_1OF2(UUID), who="the bot, when the Owner signs", time="14:40"),
        receive="the 🔏 “1 of 2 admin approvals — signed by Owner” message.", waits=True)}
  {step(13, "Second signature — one message, two lines",
        "you will receive <b>one</b> plain message with <b>two lines</b> when the <b>second admin</b> signs. The second line names both signers and says the payment is now with finance.",
        card(WORKER_APPROVED_FULL, who="the bot, when Admin 2 signs", time="14:45"),
        receive="one message. Line 1: ✅ “Your request R-9DDC has been approved by admin. Changes applied.” Line 2: ✅ “Payment of ₦4,000 to Abdul approved by Owner ‖ Admin 2 — now with finance to pay.”",
        waits=True,
        variants=[f"<i>{html.escape(WORKER_EXEC_FAIL)}</i> — both admins signed but the bot could not write the record. Tell the owner."])}
  {step(14, "💸 Paid — the moment finance marks it done",
        "you will receive the <b>Paid notice</b> when the Office phone taps ✔ Mark Done. This can be minutes or hours later — finance pays by hand first. It arrives <b>before</b> any screenshot.",
        card(PAID_NOTICE, who="the bot, when finance taps ✔ Mark Done", time="15:10"),
        receive="the plain-text 💸 Paid message: amount, reason, account, who paid and when, the PAY number and both approvers. The Owner and Admin 2 get exactly the same message at the same moment.",
        waits=True)}
  {step(15, "📎 Proof of transfer — only if finance sends one",
        "if the Office phone sends the bank screenshot, you will receive it as a photo with the caption below, <b>after</b> the Paid notice. If finance taps ⏭ Skip, nothing more comes — the Paid notice was the last message.",
        card(PROOF_CAP, kind="photo", photo=PIC_SHOT, who="the bot, after finance sends the screenshot", time="15:11"),
        receive="the screenshot with caption “📎 Proof of transfer — PAY-… · ₦4,000 to Abdul (employee)”. In this test finance <b>does</b> send one for the first payment.",
        waits=True)}
  {step(16, "📋 My requests",
        "open <b>💳 Payments</b> and tap <b>📋 My requests</b>. Your own requests, newest first, with the status word and the reason.",
        bubble_list(card(MINE_PAID, B_HOME, who="the bot, after the payment is done"),
                    card(MINE_WAIT, B_HOME, who="the same list while the admins are still signing")),
        receive="✅ <b>paid</b> once finance has marked it done. Before that: ⏳ <b>waiting for approval</b>, then 🏦 <b>with finance to pay</b>.",
        tip="More than 12 requests? The list ends with <i>…and N older.</i> No requests at all: <i>You have not asked for a payment yet.</i>")}
</section>""")

    # ── exits ──
    P.append(f"""
<section class="flow">
  {h2("The two exits &nbsp;·&nbsp; the owner will run one of each after the first payment")}
  <p class="lead">Raise a second and a third request exactly like Part B (the owner will tell you when). One is <b>rejected by an admin</b> before approval; the other is approved and then <b>declined by finance</b>. This is what you see.</p>
  {step("A", "Rejected by an admin (before approval)",
        "you will receive one plain message. No reason is given by the bot — ask the admin if you need one.",
        bubble_list(card(WORKER_REJECTED, who="the bot, when an admin taps ❌ Reject"),
                    card(MINE_REJ, B_HOME, who="📋 My requests afterwards")),
        receive="❌ “Your request R-… has been rejected by admin.” — and 📋 My requests shows ❌ <b>rejected</b>.",
        waits=True)}
  {step("B", "Declined by finance (after approval, before the money moved)",
        "you will receive one plain message with finance's typed reason on it. The two admins who signed get the same message.",
        bubble_list(card(DEC_NOTICE, who="the bot, when finance declines", time="15:10"),
                    card(MINE_DEC, B_HOME, who="📋 My requests afterwards")),
        receive="✖ “Payment declined — ₦4,000 to Abdul (employee) was not paid.” with the reason line — and 📋 My requests shows ✖ <b>declined by finance</b> with the reason after the date, on the same line (only the date is in grey).",
        waits=True,
        tip="A decline is not the end: fix what the reason says and raise the request again.")}
</section>""")

    P.append(checklist([
        ("Step 1", "💳 Payments card — <i>no registered account yet</i>"),
        ("Step 2", "🏦 Account for Abdul — asks for 10 digits"),
        ("Step 3", "🔁 Type it once more → 🏦 7048940378 Which bank? (🏛 OPAY chip present)"),
        ("Step 4", "🏦 Register this account? → a new card ⏳ Sent for approval (the old card stays, its button dead)"),
        ("Step 5", "🔏 Your request (…) has 1 of 2 admin approvals — signed by Owner. One more to go."),
        ("Step 5", "✅ Your request R-… has been approved by admin. Changes applied."),
        ("Step 6", "💳 Payments now says <i>You have 1 registered account</i> → 💸 Pay into which account? with your chip"),
        ("Step 7", "💸 Abdul / 🏦 OPAY 7048940378 / How much, in naira?"),
        ("Step 8", "📝 What is this payment for?"),
        ("Step 9", "📎 Any paperwork?"),
        ("Step 10", "💸 Send this for approval? — ₦4,000 · Transport to Idumota · Bill attached"),
        ("Step 11", "a new card ⏳ Sent for approval — ₦4,000 → Abdul · PAY-… (the old card stays, its button dead)"),
        ("Step 12", "🔏 1 of 2 admin approvals — signed by Owner"),
        ("Step 13", "ONE message, two lines: ✅ Your request R-… has been approved by admin. Changes applied. ⏎ ✅ Payment of ₦4,000 to Abdul approved by Owner ‖ Admin 2 — now with finance to pay."),
        ("Step 14", "💸 Paid — ₦4,000 to Abdul (employee) … Paid by Office · date, time … approved by Owner ‖ Admin 2"),
        ("Step 15", "📎 Proof of transfer — PAY-… (photo) — only if finance sent one; it comes AFTER the Paid notice"),
        ("Step 16", "📋 My requests: ✅ ₦4,000 — paid · 📝 Transport to Idumota"),
        ("Exit A", "❌ Your request R-… has been rejected by admin. · My requests: ❌ rejected"),
        ("Exit B", "✖ Payment declined — … was not paid. + reason · My requests: ✖ declined by finance · reason"),
    ], "worker"))
    return P


# ═════════════════════════════════════════════════════════════════════════
# ADMIN GUIDE
# ═════════════════════════════════════════════════════════════════════════
def build_admin():
    P = []
    P.append(cover(
        "Payments live test — Admin guide",
        "For the two admins — the Owner and Admin 2. Both of you get the same cards; the guide marks what only the <b>first signer</b> or only the <b>second signer</b> sees. Decide between you who signs first; the owner may be either.",
        "Two taps per request, then waiting",
        [
            "Both of you have been set up by the owner as admins of the bot. With only <b>one</b> admin there, a single signature would be enough and the test proves nothing.",
            "Both of you have sent <b>/start</b> to the bot.",
            "The finance seat is set: open 💳 Payments and check the last line reads <b>Finance: Office pays and marks done.</b> If it shows a ⚠️ warning instead, stop — see step 1.",
            "Neither of you raises the test request — an admin who asks counts as his own first signature and is left off his own card.",
            "The bot's bank list includes <b>OPAY</b> (the owner adds it), or the worker cannot register the example account.",
            "Agree who is the first signer. The second signer must wait for the pointer message (step 6) before tapping.",
        ],
        "In this guide the first signer is the <b>Owner</b> and the second is <b>Admin 2</b>. Swap the names if you decide the other way round.",
        ["Open 💳 Payments", "Approve the account", "🔔 Payment card + bill", "First ✅", "Second ✅", "Wait for 💸 Paid", "🛂 Inbox record"],
    ))

    P.append(f"""
<section class="flow">
  {h2("Part A &nbsp;·&nbsp; Check the seat, then approve the worker's account")}
  {step(1, "Open 💳 Payments and read the Finance line",
        "send <b>/menu</b> and tap <b>💳 Payments</b>. An admin's card has one extra line at the bottom naming the finance seat.",
        card(HUB_ADMIN_NOACC, B_HUB, who="the bot, on an admin's phone"),
        receive="the Payments card ending <b>Finance: Office pays and marks done.</b>",
        warn=f"If the last line is <i>{html.escape(WARN_NOFIN)}</i> or <i>{html.escape(WARN_TWOFIN)}</i>, the finance phone has not been set up by the owner. Every finance card would go to all admins instead of the Office phone. Fix it before going on.")}
  {step(2, "🔔 Register payment account — both admins get this card",
        "read it. The <b>first signer</b> taps <b>✅ Approve</b>. The <b>second signer</b> waits for the pointer message, then taps ✅ Approve on <b>his own</b> card (it still has its buttons).",
        card(ADM_ACC, B_APPROVE, who="the bot, on BOTH admins' phones", time="14:18"),
        receive="the 🔔 Approval required card for <b>Register payment account: Abdul (employee)</b>, with the linked Telegram line ending <i>✓ registered employee</i>.",
        tip="The messages around the two signatures are exactly the ones in Part B, steps 5–8 — read those once and you know both.")}
  {step(3, "After the second signature on the account",
        "nothing more. The second signer's card loses its buttons and one line follows.",
        card(ADM_ACC_DONE, who="the bot, on the SECOND signer's phone", time="14:22"),
        receive="✅ “Request … approved by Owner + Admin 2. Changes applied.” — <b>only that line</b>. The bot does not add an “Account registered for Abdul” line; that is known and not a fault. The first signer hears nothing at this moment.",
        waits=True,
        variants=[f"<i>{html.escape(ADM_ACC_FAIL)}</i> — the worker is not an active employee on the Users list. Fix the Users list, ask him to register again."])}
</section>""")

    P.append(f"""
<section class="flow">
  {h2("Part B &nbsp;·&nbsp; The payment request — two signatures")}
  {step(4, "🔔 Payment request card, then the bill photo",
        "nothing yet — read it. Both admins get the same card, and right after it the bill as a separate photo.",
        bubble_list(card(ADM_PAY, B_APPROVE, who="the bot, on BOTH admins' phones", time="14:32"),
                    card(ADM_BILL_CAP, kind="photo", who="the bot, straight after the card", time="14:32")),
        receive="the 🔔 card with <b>Reason: Transport to Idumota</b> and <b>Bill: attached</b>, then the photo captioned <i>📎 Bill for payment request …</i>.",
        waits=True,
        tip="For ₦50,000 and above the card carries <i>⚠️ LARGE PAYMENT — above the threshold</i>. Two other lines can appear on real requests: a first line <i>⚠️ Possible duplicate — same request also pending as …</i> (approve ONE, reject the rest), and <i>⏰ Reminder — this approval is still waiting</i> on a re-sent copy.")}
  {step(5, "Another door — the 🛂 Approvals inbox",
        "optional: open <b>🛂 Approvals inbox</b> → <b>💳 Payments</b> → tap the row → the item card. <b>✅ Approve</b> here is the very same signature as on the card in your chat with the bot; <b>📄 Bill</b> re-sends the bill photo.",
        bubble_list(card(INBOX_CHIPS, who="the inbox, two taps in"),
                    card(INBOX_ITEM, B_INBOX, who="the item card")),
        receive="the same lines as the card in your chat with the bot, ending <i>Requested by Abdul · today · R-9DDC</i>. After the first signature the card gains <i>⚠️ 1 of 2 approvals already given — a different admin must give the second.</i>",
        tip="Use whichever door you like — the card in your chat with the bot, or the inbox — every message below is identical.")}
  {step(6, "First signature — the Owner taps ✅ Approve",
        "<b>first signer only:</b> tap <b>✅ Approve</b> once. Your card's buttons disappear; a small grey pop-up shows for a moment; a plain message follows.",
        card(DM_1OF2(UUID), who="the bot, on the FIRST signer's phone", toast=TOAST_1OF2, time="14:40"),
        receive="a small grey pop-up <b>🔏 Approval 1 of 2 recorded.</b>, then the message “🔏 Request …: your approval is recorded (1 of 2). Waiting for a second admin.” At the same moment the worker is told <i>signed by Owner</i>.",
        variants=[f"alert <i>{html.escape(ALERT_REPEAT)}</i> — you tapped a second time (or a copy in the inbox). Harmless.",
                  f"alert <i>{html.escape(ALERT_SELF)}</i> — this is your own request; the other admin must sign.",
                  f"alert <i>{html.escape(ALERT_NONADMIN)}</i> — the phone tapping is not an admin."])}
  {step(7, "The pointer — Admin 2 is told to sign",
        "<b>second signer only:</b> you get a plain message, <b>not</b> a new card. Scroll up to your original 🔔 Approval required card — its buttons are still live — and tap <b>✅ Approve</b> there (or use the inbox).",
        card(DM_POINTER(UUID, "request payment"), who="the bot, on every OTHER admin's phone", time="14:40"),
        receive="🔔 “Request … (request payment) has its first admin approval and needs a SECOND. Use the approval card in your chat.”",
        warn="The first signer's own card has no buttons now; the second signer's card does. If you cannot find it, open 🛂 Approvals inbox → 💳 Payments.")}
  {step(8, "Second signature — Admin 2 taps ✅ Approve (one message, two lines)",
        "<b>second signer only:</b> tap <b>✅ Approve</b>. A small grey pop-up <i>Approving...</i>, your buttons vanish, and <b>one</b> message with <b>two lines</b> follows.",
        card(ADM_APPROVED_FULL, who="the bot, on the SECOND signer's phone", toast=TOAST_APPROVING, time="14:45"),
        receive="one message. Line 1: “✅ Request … approved by Owner + Admin 2. Changes applied.” Line 2: “✅ Payment of ₦4,000 to Abdul approved by Owner ‖ Admin 2 — now with finance to pay.” The worker gets the same two lines in one message; the Office phone gets the finance card.",
        variants=[f"<i>{html.escape(ADM_EXEC_FAIL)}</i> — signed, but the record could not be written. Tell the owner."])}
  {step(9, "The first signer at this moment",
        "the Owner receives <b>nothing</b> at the second signature — that is how it is built. He hears the outcome at 💸 Paid (step 10) or at a decline (exit B). If he taps his old card anyway:",
        card(DM_STALE, who="the bot, only if the FIRST signer taps a stale card", toast=TOAST_STALE, time="14:46"),
        receive="nothing, unless you tap: then a small grey pop-up <b>Already approved — nothing to do.</b> and “ℹ️ Request … was already approved on … — no change made.”",
        waits=True)}
</section>""")

    P.append(f"""
<section class="flow">
  {h2("Part C &nbsp;·&nbsp; Both signers wait for finance")}
  {step(10, "💸 Paid — when the Office phone taps ✔ Mark Done",
        "<b>both signers</b> receive the Paid notice at the moment finance marks the payment done — <b>before</b> any screenshot. It is the same plain text the worker gets.",
        card(PAID_NOTICE, who="the bot, on BOTH signers' phones and the worker's", time="15:10"),
        receive="💸 Paid — amount, reason, account, <b>Paid by Office · date, time</b>, the PAY number and <b>approved by Owner ‖ Admin 2</b>.",
        waits=True)}
  {step(11, "📎 Proof of transfer — only if finance sends one",
        "if the Office phone sends the bank screenshot, both signers receive it as a photo with this caption, <b>after</b> the Paid notice. If finance skips, nothing more comes.",
        card(PROOF_CAP, kind="photo", photo=PIC_SHOT, who="the bot, after finance sends the screenshot", time="15:11"),
        receive="the screenshot captioned “📎 Proof of transfer — PAY-… · ₦4,000 to Abdul (employee)”.",
        waits=True)}
  {step(12, "🛂 Inbox — the record after it is paid",
        "open <b>🛂 Approvals inbox</b> → <b>💳 Payments</b> → the item. A resolved request opens as a <b>record</b>: no decision chips, one status line read live from the payment records.",
        card(INBOX_REC, B_INBOX_REC, who="the inbox record"),
        receive="the request lines, then <i>✅ Already approved · date — no action needed.</i> and <b>💸 Paid by Office · date, time · PAY-…</b>. Tap 📄 Bill to get the bill again.",
        tip="Between the second signature and Mark Done the last line reads <b>🏦 With finance to pay</b>. After a decline: <b>✖ Declined by Office · reason</b>. After a reject the header turns <i>❌ Already rejected …</i> and the line reads <b>❌ Rejected by Owner</b> — or <b>❌ Rejected by Owner + Admin 2</b> if the reject came after the other admin's first signature.")}
</section>""")

    P.append(f"""
<section class="flow">
  {h2("The two exits &nbsp;·&nbsp; run one of each after the first payment")}
  {step("A", "❌ Reject — any ONE admin, before approval",
        "on a fresh request (the worker raises one), <b>one admin</b> taps <b>❌ Reject</b> on the card in your chat with the bot or in the inbox. The bot asks for no reason. <b>For this test, reject before either admin has signed</b> — that keeps the record line below exactly as printed.",
        card(ADM_REJECTED, who="the bot, on the REJECTING admin's phone", toast=TOAST_REJECTING),
        receive="a small grey pop-up <b>Rejecting...</b>, your card's buttons vanish, then “❌ Request … rejected.” The worker gets “❌ Your request R-… has been rejected by admin.” <b>The other admin is not told</b> — even if he gave the first signature — and finance gets nothing (no finance card ever existed). The inbox record reads ❌ Rejected by Owner.",
        tip="If the reject follows the other admin's first signature, the record names both: <b>❌ Rejected by Owner + Admin 2</b> (first signer + rejecter). That is why the test rejects before any signature.",
        variants=[f"<i>{html.escape(ADM_REJECT_FAIL)}</i> — tell the owner."])}
  {step("B", "✖ Decline — by finance, after both signatures",
        "on another fresh request, both of you sign as in Part B; then the Office phone taps <b>✖ Decline</b> and types a reason. <b>Both signers</b> receive the decline notice — the same text as the worker.",
        bubble_list(card(DEC_NOTICE, who="the bot, on BOTH signers' phones and the worker's", time="15:10"),
                    card(INBOX_REC_DEC, B_INBOX_REC, who="the inbox record afterwards")),
        receive="✖ “Payment declined — ₦4,000 to Abdul (employee) was not paid.” with the reason line and <b>Declined by Office · date, time</b>; the inbox record ends <b>✖ Declined by Office · reason</b>.",
        waits=True)}
</section>""")

    P.append(checklist([
        ("Step 1", "💳 Payments card ends <b>Finance: Office pays and marks done.</b> (no ⚠️ line)"),
        ("Step 2", "🔔 Approval required — Register payment account: Abdul (employee) … ✓ registered employee (both admins)"),
        ("Step 2 · first signer", "pop-up 🔏 Approval 1 of 2 recorded. + 🔏 Request …: your approval is recorded (1 of 2). Waiting for a second admin."),
        ("Step 2 · second signer", "🔔 Request … (register payment account) has its first admin approval and needs a SECOND. Use the approval card in your chat."),
        ("Step 3 · second signer", "✅ Request … approved by Owner + Admin 2. Changes applied. (no “Account registered” line — expected)"),
        ("Step 4", "🔔 Approval required — Payment request: ₦4,000 … Reason: Transport to Idumota · Bill: attached (both admins)"),
        ("Step 4", "photo: 📎 Bill for payment request … (both admins)"),
        ("Step 5", "🛂 inbox: 💳 Payments — 1 ⚠️ 🟢today → 🟢 09 Sept · request payment · Abdul → item card with 📄 Bill"),
        ("Step 6 · first signer", "pop-up 🔏 Approval 1 of 2 recorded. + 🔏 Request …: your approval is recorded (1 of 2). Waiting for a second admin. — buttons gone"),
        ("Step 7 · second signer", "🔔 Request … (request payment) has its first admin approval and needs a SECOND. … (no new card)"),
        ("Step 8 · second signer", "pop-up Approving... · buttons gone · ONE message, two lines: ✅ Request … approved by Owner + Admin 2. Changes applied. ⏎ ✅ Payment of ₦4,000 to Abdul approved by Owner ‖ Admin 2 — now with finance to pay."),
        ("Step 9 · first signer", "NOTHING arrives at the second signature (a tap on the old card: pop-up Already approved — nothing to do.)"),
        ("Step 10 · both", "💸 Paid — ₦4,000 to Abdul (employee) … Paid by Office · date, time … approved by Owner ‖ Admin 2"),
        ("Step 11 · both", "📎 Proof of transfer — PAY-… (photo) — AFTER the Paid notice; nothing if finance skipped"),
        ("Step 12", "🛂 inbox record: ✅ Already approved · … + 💸 Paid by Office · date, time · PAY-…"),
        ("Exit A · rejecter", "pop-up Rejecting... + ❌ Request … rejected. (other admin: nothing) · inbox record: ❌ Rejected by Owner — rejected BEFORE any signature"),
        ("Exit B · both", "✖ Payment declined — … was not paid. + reason + Declined by Office · date, time"),
    ], "admin"))
    return P


# ═════════════════════════════════════════════════════════════════════════
# FINANCE GUIDE
# ═════════════════════════════════════════════════════════════════════════
def build_finance():
    P = []
    P.append(cover(
        "Payments live test — Finance guide",
        "For the <b>Office phone</b> — the finance seat that pays by hand and marks each payment done. This phone has been set up by the owner as the finance phone; nobody else can tap ✔ Mark Done or ✖ Decline.",
        "Nothing to do until both admins have signed",
        [
            "The owner has set this phone up as the finance phone and restarted the bot. Without that the finance card goes to the admins, not to you.",
            "This phone is an allowed bot user (an active row on the Users list). If the bot answers <i>You are not authorized to use this bot.</i> to anything, stop and tell the owner.",
            "You have sent <b>/start</b> to the bot.",
            "Open 💳 Payments once now: the button <b>💳 Waiting for me to pay (0)</b> must be there. It only shows for the finance seat — that is how you know the seat is set (step 1).",
            "The bank app is on this phone and ready — the payment itself is made <b>outside</b> the bot, by hand.",
            "Have a way to take a screenshot of the transfer; the first test payment sends the proof, the second skips it.",
            "This phone need not be an admin. If it is, it will also receive the 🔔 approval cards — ignore those; they are the admins' job.",
        ],
        "In this guide the finance seat is called <b>Office</b> — that is the name the bot prints on the Paid notice.",
        ["Open 💳 Payments", "💳 Finance card arrives", "Pay in the bank app", "✔ Mark Done", "📎 Proof or ⏭ Skip", "💳 Waiting list", "✖ Decline (exit)"],
    ))

    P.append(f"""
<section class="flow">
  {h2("Part A &nbsp;·&nbsp; The seat, the card, the payment")}
  {step(1, "Open 💳 Payments — check the seat is yours",
        "send <b>/menu</b> and tap <b>💳 Payments</b>. Look for the button <b>💳 Waiting for me to pay (0)</b>.",
        card(HUB_FINANCE, B_HUB_FIN, who="the bot, on the Office phone"),
        receive="the Payments card with the extra <b>💳 Waiting for me to pay</b> button. The number in brackets is how many approved payments are waiting — 0 before the test.",
        warn="No 💳 Waiting for me to pay button? This phone has not been set up by the owner as the finance phone. Stop and tell the owner — the finance card would go to the admins instead.")}
  {step(2, "💳 The finance card arrives — as the caption on the bill photo",
        "nothing to tap yet — read every line. It comes the moment the second admin signs. When the request had a bill, the card is the <b>caption of the bill photo</b>; without a bill it is a plain text card.",
        card(FIN_CARD, B_FIN, kind="photo", who="the bot, on the Office phone, right after the second signature", time="14:45"),
        receive="the photo with the 💳 Payment caption: payee, account, <b>₦4,000</b>, reason, <i>📎 Bill attached</i>, <b>✅ Approved: Owner ‖ Admin 2</b>, <i>Raised by Abdul · date, time</i>, the PAY number — and two buttons, <b>✔ Mark Done</b> and <b>✖ Decline</b>.",
        waits=True,
        tip="For ₦50,000 and above the amount line also carries <i>⚠️ large payment</i>. If you leave a card untouched for 4 hours the bot re-sends it unchanged — a reminder, not a second payment.",
        variants=[f"a line <i>{html.escape(WARN_NOFIN)}</i> at the bottom — the seat is not set; the same card went to every admin. Tell the owner."])}
  {step(3, "Pay by hand in the bank app",
        "open the bank app and transfer <b>₦4,000</b> to <b>OPAY 7048940378</b> (for the test, use whatever the owner tells you — a real transfer or a pretend one). Take a screenshot of the transfer. <b>Do not tap anything in the bot until the money has gone.</b>",
        card(FIN_CARD, B_FIN, kind="photo", who="the same card, still waiting on your phone", time="14:45"),
        receive="nothing new — the bot waits. The card's buttons work for as long as the payment is unpaid, even days later.")}
  {step(4, "Tap ✔ Mark Done",
        "tap <b>✔ Mark Done</b> on the finance card. A small grey pop-up shows <i>Marked done.</i>, the card's buttons disappear, and a new card asks for the proof.",
        bubble_list(card(FIN_CARD, kind="photo", who="the finance card, after your tap", toast=TOAST_DONE, faded=True, time="14:45"),
                    card(PROOF_PROMPT, B_PROOF, who="the bot, a fresh card straight after", time="15:10")),
        receive="a small grey pop-up <b>Marked done.</b> → buttons gone on every copy of the card → the <b>📎 Proof of transfer?</b> card.",
        warn="<b>The order matters and is part of the test.</b> At the moment you tap ✔ Mark Done — before you send anything — Abdul, the Owner and Admin 2 each receive the plain-text <b>💸 Paid</b> notice (drawn in step 5). The proof you send next is a separate follow-up. Ask them to confirm the Paid notice came in before the screenshot.",
        variants=[f"alert <i>{g}</i>" for g in GUARDS_DONE])}
  {step(5, "What the other three receive at your tap",
        "nothing for you to do. This is the notice the worker and both admins get at the same moment, so you know what they are checking.",
        card(PAID_NOTICE, who="the bot, on Abdul's, the Owner's and Admin 2's phones", time="15:10"),
        receive="nothing on this phone — the Office phone does not get its own Paid notice; your record is the ✅ Paid card in step 6.",
        waits=True)}
</section>""")

    P.append(f"""
<section class="flow">
  {h2("Part B &nbsp;·&nbsp; The proof — send it, or skip")}
  {step(6, "Send the screenshot (first test payment)",
        "while the <b>📎 Proof of transfer?</b> card is showing, send the bank screenshot as a photo (or a PDF as a File). A new <b>✅ Paid</b> card with <i>📎 Proof attached</i> arrives below; it has no buttons. The old 📎 Proof of transfer? card stays on screen — its button no longer does anything (tapping it only says <i>That screen expired.</i>).",
        bubble_list(card(PAID_CARD_PROOF, who="a new card, sent straight after", time="15:11"),
                    card(PROOF_CAP, kind="photo", photo=PIC_SHOT, who="what Abdul, the Owner and Admin 2 receive", time="15:11")),
        receive="✅ <b>Paid</b> — ₦4,000 to Abdul · PAY-… · <i>Recorded date, time.</i> · 📎 Proof attached. The three others receive your screenshot with the caption <b>📎 Proof of transfer — PAY-… · ₦4,000 to Abdul (employee)</b>.")}
  {step(7, "⏭ Skip — no proof (second test payment)",
        "on the second payment, tap <b>⏭ Skip — no proof</b> instead. A new <b>✅ Paid</b> card arrives below without the proof line; the old 📎 Proof of transfer? card stays on screen — its button no longer does anything (tapping it only says <i>That screen expired.</i>). <b>Nobody else gets anything</b> — the Paid notice at step 4 was their last message.",
        card(PAID_CARD_NOPROOF, who="a new card, sent straight after", time="15:10"),
        receive="a new card: ✅ <b>Paid</b> — ₦4,000 to Abdul · PAY-… · <i>Recorded date, time.</i> — no 📎 line, and the new card has no buttons.",
        tip="Leaving the proof card alone has the same effect as skipping: the payment is already marked done and everyone has already been told.")}
  {step(8, "💳 Waiting for me to pay — your queue",
        "open <b>💳 Payments</b> → <b>💳 Waiting for me to pay (n)</b>. Every approved-and-unpaid payment is a chip; tap one to get its finance card again (same card, same buttons). Use it when a card is lost in the chat.",
        bubble_list(card(WAIT_LIST, B_WAIT, who="the bot, while one payment is waiting"),
                    card(WAIT_EMPTY, B_WAIT_EMPTY, who="the same list when nothing is waiting")),
        receive="the list with one chip per waiting payment — amount → payee · date · reason — or the <i>Nothing approved is waiting</i> line once every payment is paid or declined.",
        variants=[f"<i>{html.escape('That list is for the finance seat.')}</i> — the phone tapping is not the finance seat.",
                  f"<i>{html.escape('That list expired.')}</i> — an old list; open it again from 💳 Payments."])}
</section>""")

    P.append(f"""
<section class="flow">
  {h2("The two exits &nbsp;·&nbsp; what the finance seat sees")}
  {step("A", "❌ Reject by an admin — you see nothing",
        "nothing. When an admin rejects a request before it is approved, no finance card is ever made, so this phone receives nothing at all. That is correct.",
        card(EXIT_A_FIN, who="for reference only — nothing arrives here"),
        receive="nothing.", waits=True)}
  {step("B", "✖ Decline — you refuse to pay an approved request",
        "on a fresh request that both admins have signed (the owner will tell you which), tap <b>✖ Decline</b> on its finance card, then <b>type a reason</b> of at least 3 characters — for the test: <b>Account name does not match — send the OPAY name.</b>",
        bubble_list(card(DEC_PROMPT, B_DEC, who="the bot, after ✖ Decline"),
                    card(DEC_DONE, B_HOME, who="a new card, sent straight after", time="15:10")),
        receive="the <b>✖ Decline ₦4,000 to Abdul</b> prompt; after your reason, a new <b>✖ Declined</b> card arrives below with your reason in grey and <i>The requester has been told.</i> The prompt stays on screen — its ❌ Cancel button now only prints <i>❌ Cancelled.</i> and undoes nothing (the decline has already happened). Every copy of the finance card loses its buttons.",
        variants=[f"<i>{html.escape(DEC_SHORT)}</i> — reason too short; type it again.",
                  f"<i>{html.escape(DEC_CANCELLED)}</i> after ❌ Cancel — nothing changed; the payment stays approved and waiting.",
                  ] + [f"alert <i>{g}</i>" for g in GUARDS_DEC])}
  {step("B2", "Who is told about the decline",
        "nothing more for you. Abdul, the Owner and Admin 2 each receive this plain-text notice with your reason.",
        card(DEC_NOTICE, who="the bot, on Abdul's, the Owner's and Admin 2's phones", time="15:10"),
        receive="nothing on this phone beyond the ✖ Declined card above.", waits=True)}
</section>""")

    P.append(checklist([
        ("Before", "💳 Payments card has the 💳 Waiting for me to pay (0) button"),
        ("Step 2", "photo + caption 💳 Payment — Abdul · employee … ✅ Approved: Owner ‖ Admin 2 … PAY-… with [✔ Mark Done] [✖ Decline]"),
        ("Step 3", "nothing arrives while you pay in the bank app"),
        ("Step 4", "pop-up Marked done. → buttons gone on the finance card"),
        ("Step 4", "📎 Proof of transfer? — Send a screenshot of the bank transfer, or skip. ₦4,000 → Abdul · PAY-…"),
        ("Step 4", "(on the other three phones, at this same moment, BEFORE any screenshot) 💸 Paid — … Paid by Office · date, time"),
        ("Step 6", "after the screenshot, a new card: ✅ Paid — ₦4,000 to Abdul · PAY-… · Recorded … · 📎 Proof attached — the new ✅ Paid card has no buttons"),
        ("Step 6", "(on the other three phones) photo captioned 📎 Proof of transfer — PAY-… · ₦4,000 to Abdul (employee)"),
        ("Step 7", "second payment, ⏭ Skip — a new card: ✅ Paid — … Recorded … (no 📎 line, no buttons on the new card); nothing more to anyone"),
        ("Step 8", "💳 Waiting for me to pay: one chip per waiting payment, or Nothing approved is waiting …"),
        ("Exit A", "nothing arrives when an admin rejects"),
        ("Exit B", "✖ Decline ₦4,000 to Abdul — Why? … → a new card ✖ Declined — … The requester has been told. (buttons gone on every copy of the finance card)"),
        ("Exit B", "(on the other three phones) ✖ Payment declined — … was not paid. + your reason + Declined by Office · date, time"),
    ], "finance seat"))
    return P


# ── CSS (house pattern) ──────────────────────────────────────────────────
CSS = """
@page { size: A4; margin: 12mm 11mm; }
* { box-sizing: border-box; }
body { margin:0; font-family:"DejaVu Sans","Segoe UI",Arial,sans-serif; color:#16202a; font-size:10.6pt; line-height:1.42; }
.page { page-break-after: always; }
.flow { page-break-before: always; }
.page:last-child { page-break-after: auto; }
h1 { font-size:28pt; margin:2mm 0 1mm; letter-spacing:-.5px; }
.brand { font-size:8.4pt; letter-spacing:2.4px; text-transform:uppercase; color:#7d8b99; font-weight:700; }
.sub { font-size:12pt; color:#3d4b59; margin-bottom:2mm; }
.for { font-size:9.4pt; color:#4a5866; padding:1.6mm 0 0; border-top:1px solid #e2e8ee; }
.ph { font-size:12.6pt; font-weight:700; color:#0e2a47; border-bottom:2.4px solid #0e2a47; padding-bottom:1.4mm; margin-bottom:3.4mm; }
.lead { margin:0 0 3mm; color:#31404e; }
.small { font-size:8.8pt; color:#5d6b79; }

.golden { margin:6mm 0 0; border:2.4px solid #b8860b; background:#fffaf0; border-radius:4mm; padding:4mm 5mm; }
.gbody { font-size:15pt; font-weight:700; margin:0 0 1.6mm; color:#1d1502; }
.gwhy { font-size:9.6pt; color:#4a4231; }

.two { display:flex; gap:5mm; margin:5mm 0; }
.box { flex:1; border:1px solid #dde4ea; border-radius:3mm; padding:3.4mm 4mm; background:#fbfcfd; }
.btitle { font-weight:700; color:#0e2a47; margin-bottom:1.6mm; }
.box p { margin:0 0 1.8mm; }
.box ul { margin:0 0 1.6mm; padding-left:5mm; }
.box li { margin-bottom:1mm; font-size:9.8pt; }

.map { margin-top:4mm; border:1px solid #dde4ea; border-radius:3mm; padding:3mm 4mm; background:#f4f7fa; }
.mtitle { font-weight:700; color:#0e2a47; margin-bottom:2mm; }
.mrow { display:flex; align-items:center; gap:1.4mm; }
.mstep { flex:1; text-align:center; background:#fff; border:1px solid #cfdae4; border-radius:2mm; padding:2mm .8mm; font-size:8.2pt; }
.mstep b { display:block; font-size:12pt; color:#1d6fa5; }
.marr { color:#93a3b2; font-size:11pt; }

/* steps */
.step { display:flex; gap:5mm; margin-bottom:6mm; page-break-inside:avoid; border-bottom:1px solid #eef2f5; padding-bottom:4mm; }
.sleft { flex:1.05; }
.sright { flex:1; }
.snum { display:inline-block; min-width:9mm; height:9mm; line-height:9mm; text-align:center; border-radius:4.5mm; padding:0 1.5mm;
        background:#0e2a47; color:#fff; font-weight:800; font-size:12pt; }
.snum.wait { background:#93a3b2; }
.stitle { display:inline-block; font-size:12.6pt; font-weight:700; margin-left:2.4mm; vertical-align:middle; color:#0e2a47; max-width:78%; }
.slead { margin-top:2.2mm; color:#31404e; }
.waitlbl { display:inline-block; background:#eceff2; color:#4a5866; border-radius:1.4mm; padding:.2mm 1.8mm; font-weight:700; font-size:9.2pt; }
.recv { margin-top:2mm; background:#f4f7fa; border:1px solid #dde4ea; border-radius:2mm; padding:1.8mm 2.6mm; font-size:9.8pt; }
.recv b { color:#0e2a47; }
.tip { margin-top:2.4mm; font-size:9.4pt; background:#eef6ff; border-left:3px solid #1d6fa5; padding:1.6mm 2.6mm; border-radius:0 2mm 2mm 0; }
.warn { margin-top:2.4mm; font-size:9.4pt; background:#fff4f4; border-left:3px solid #a3232a; padding:1.6mm 2.6mm; border-radius:0 2mm 2mm 0; }
.vars { margin-top:2.4mm; font-size:9pt; color:#41505e; }
.vars ul { margin:.8mm 0 0; padding-left:4.5mm; }
.vars li { margin-bottom:.6mm; }
.tick { margin-top:2.6mm; display:inline-block; border:1.6px solid #1c6b45; color:#1c6b45; border-radius:1.8mm; padding:1mm 3mm; font-weight:700; font-size:10pt; }

/* telegram card */
.who { font-size:7.8pt; color:#5d6b79; margin:1.6mm 0 .8mm; font-style:italic; }
.who:first-child { margin-top:0; }
.toast { display:inline-block; background:#3a4652; color:#fff; font-size:8pt; border-radius:3mm; padding:.8mm 3mm; margin-bottom:1mm; }
.tg { background:#0e1621; border-radius:3mm; padding:2.4mm; max-width:84mm; }
.bubble { background:#182533; border-radius:2.4mm; padding:2.2mm 2.6mm 1.2mm; position:relative; }
.txt { color:#e9eef3; font-size:9pt; line-height:1.4; word-wrap:break-word; overflow-wrap:anywhere; }
.txt b { color:#fff; }
.dim, .txt i { color:#8fa3b5; font-style:italic; }
.txt code { background:#0e1621; border-radius:1mm; padding:0 .8mm; font-family:"DejaVu Sans Mono",monospace; font-size:7.8pt; color:#a9c7e4; }
.time { text-align:right; color:#6d8298; font-size:7pt; margin-top:.8mm; }
.krow { display:flex; gap:1.2mm; margin-top:1mm; }
.kbtn { flex:1; background:#22303f; color:#e9eef3; text-align:center; font-size:8.6pt; padding:1.4mm 1mm; border-radius:1.6mm; }
.gone { text-align:center; color:#6d8298; font-size:7.4pt; margin-top:1mm; font-style:italic; }
.pic { height:26mm; border-radius:1.8mm; margin-bottom:1.6mm; overflow:hidden; }
.doc { display:flex; align-items:center; gap:2mm; background:#0e1621; border-radius:1.8mm; padding:1.8mm 2mm; margin-bottom:1.4mm; }
.dicon { font-size:13pt; }
.dname { color:#a9c7e4; font-size:8.2pt; }
.mockbill, .mockshot { height:100%; display:flex; align-items:center; justify-content:center; position:relative; font-size:8pt; text-align:center; }
.mockbill { background:repeating-linear-gradient(0deg,#f3efe4 0 2.4mm,#e6e0cf 2.4mm 2.7mm); color:#3b3524; }
.mockbill span { background:rgba(255,255,255,.92); border-radius:1.4mm; padding:1.2mm 2.4mm; font-weight:700; }
.mockshot { background:linear-gradient(180deg,#0b5d3b 0 22%,#f6f8f7 22% 100%); color:#0b3b27; }
.mockshot span { background:rgba(255,255,255,.92); border-radius:1.4mm; padding:1.2mm 2.4mm; font-weight:700; margin-top:6mm; }
.alert { background:#3a4652; color:#fff; font-size:8pt; border-radius:2mm; padding:1mm 2.4mm; margin-top:1mm; }

.notebox { margin-top:4mm; background:#f4f7fa; border:1px solid #dde4ea; border-radius:2.4mm; padding:2.8mm 3.4mm; font-size:9.6pt; }
.foot { margin-top:4mm; font-size:8.4pt; color:#7d8b99; border-top:1px solid #e2e8ee; padding-top:1.8mm; }

/* checklist */
.ck { width:100%; border-collapse:collapse; font-size:9.6pt; }
.ck th { text-align:left; background:#0e2a47; color:#fff; padding:2mm 2.4mm; font-size:8.6pt; letter-spacing:.4px; }
.ck td { border-bottom:1px solid #e2e8ee; padding:1.9mm 2.4mm; vertical-align:top; }
.ck .cb { width:8mm; font-size:14pt; color:#1c6b45; padding-top:1mm; }
.ck .cwhen { width:30mm; font-weight:700; color:#0e2a47; white-space:nowrap; font-size:8.8pt; }
.ck .cmsg { color:#16202a; }
"""


def write(name, title, parts):
    out = DOCS / name
    out.write_text(f"<!doctype html><html><head><meta charset='utf-8'><title>{html.escape(title)}</title>"
                   f"<style>{CSS}</style></head><body>{''.join(parts)}</body></html>", encoding="utf-8")
    print("wrote", out)


if __name__ == "__main__":
    write("PAY-2_GUIDE_WORKER.html", "Payments live test — Worker guide", build_worker())
    write("PAY-2_GUIDE_ADMIN.html", "Payments live test — Admin guide", build_admin())
    write("PAY-2_GUIDE_FINANCE.html", "Payments live test — Finance guide", build_finance())
