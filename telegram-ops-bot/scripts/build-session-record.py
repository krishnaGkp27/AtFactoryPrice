#!/usr/bin/env python3
"""Build the printable session record (docs/SESSION_RECORD_2026-08-10_to_2026-09-09.pdf).

The detailed window (31-Aug → 09-Sep-2026) is written by hand below; the
index of the earlier commits in the same session (10-Aug → 30-Aug) is read
from git at build time, so the appendix is always the true list.

    python3 scripts/build-session-record.py
    /opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless=new --disable-gpu \
      --no-sandbox --no-pdf-header-footer \
      --print-to-pdf=docs/SESSION_RECORD_2026-08-10_to_2026-09-09.pdf \
      docs/SESSION_RECORD_2026-08-10_to_2026-09-09.html
"""
import html
import os
import subprocess

SESSION = 'session_01UsVKL6Zp7EsKeNCqx55JnV'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs', 'SESSION_RECORD_2026-08-10_to_2026-09-09.html')
DETAIL_FROM = '2026-08-31'

# ── the detailed window, hand-written ────────────────────────────────────────
TIMELINE = [
    # date, hash, title, kind, size
    ('31-Aug', 'a9a41dcb', 'ANCH-1 — the confirm-sale wizard card follows the keyboard', 'shipped', '2 files · +171'),
    ('31-Aug', 'e1246886', 'DML-1 — design artboards and build spec landed', 'docs', '2 files · +546'),
    ('31-Aug', '6a56f7c1', 'DML-1 — the design movement ledger: endpoint, page, route', 'shipped', '11 files · +1,702'),
    ('31-Aug', '0a34cf34', 'DML-1 — defects found by the adversarial review fixed', 'shipped', '4 files · +496 −119'),
    ('01-Sep', '6e495e51', 'A date-dependent expense test fixed after the month rolled', 'fix', '1 file'),
    ('01-Sep', '29976186', 'SHT-1 — four dead sheets retired instead of migrated', 'shipped', '21 files · −435'),
    ('01-Sep', '1ac77b39', 'APR-1 — who approved, in a column, on every path', 'shipped', '13 files · +491'),
    ('01-Sep', 'f0a4af42', 'Rulings recorded; storage-split questions closed', 'docs', '2 files'),
    ('02-Sep', '7aef20fb', 'Approvals vs the floor — business-use audit of every approval system', 'analysis', '353 lines'),
    ('02-Sep', '6d5a8342', 'RET-3 — an approved return credits the buyer at the booked rate', 'shipped', '10 files · +502'),
    ('04-Sep', '69ab92f8', 'RET-4 — the return card: customer, bale, thans, date, condition, photo, one dual-admin request', 'shipped', '25 files · +3,646'),
    ('05-Sep', 'd38fccfe', 'DDC-1 — Daily Details Card proposal', 'proposal', '389 lines'),
    ('08-Sep', '1347af43', 'Rule 17 recorded — expenses keep ₦; sale invoices and Inventory outputs go bare', 'ruling', '1 file'),
    ('08-Sep', 'd41d4e0a', 'Where the customer-payment door stands — state of play', 'analysis', '497 lines'),
    ('08-Sep', 'f681c739', 'CUR-1 — the cumulative currency-display plan', 'proposal', '721 lines'),
    ('08-Sep', '464b9f7b', 'CUR-1 — the two-variable ruling: the second variable is a rate multiplier', 'ruling', '2 files'),
    ('08-Sep', 'da59be6e', 'CUR-1 — rulings closed as recommended; no multiplier means unconverted', 'ruling', '2 files'),
    ('09-Sep', '5f854d60', 'CUR-2 — invoice multiplier layouts drawn for the owner\'s go', 'proposal', '596 lines'),
    ('09-Sep', 'c8379328', 'CUR-1 step 1 — invoice brief and mockups follow rule 17', 'shipped', '5 files'),
    ('09-Sep', 'ae56422a', 'CUR-1 step 2 — money module, shims, multiplier setting, frozen invoice column', 'shipped', '11 files · +842'),
    ('09-Sep', 'dd873dc7', 'CUR-1 step 3 — the expense side pinned, outputs byte-identical', 'shipped', '10 files · +340'),
    ('09-Sep', '92f44400', 'CUR-2 — the customer invoice: bare figures, multiplier frozen at issue', 'shipped', '5 files · +782'),
    ('09-Sep', '5d46383d', 'CUR-1 step 5 — the sales and inventory side prints a bare number', 'shipped', '39 files · +803'),
    ('09-Sep', 'ecb9d3e2', 'CUR release A — rules, specs, register, settings table', 'docs', '9 files'),
    ('09-Sep', '8aa96036', 'CUR-2 — the factor is internal; the caption no longer names it', 'shipped', '5 files'),
    ('09-Sep', '59d8a5af', 'CUR-1 step 7 — the controller prints sale-side money bare', 'shipped', '2 files · +376'),
    ('09-Sep', '4cabaa95', 'CUR-2 — the wizard asks for the customer-copy multiplier; wizard money bare', 'shipped', '6 files · +741'),
    ('09-Sep', '15a78a5d', 'CUR-1 step 9 — currency shims removed; lint fails on any naira leak', 'shipped', '4 files · −115'),
    ('09-Sep', '33d32aa6', 'CUR release B — specs, register, settings table, edit-bale test PDF', 'docs', '4 files'),
]

FEATURES = [
    ('ANCH-1 · Wizard card follows the keyboard',
     'When an admin types a reply into the confirm-sale wizard, the card used to stay above the reply. '
     'Now a buried card is deleted and re-sent at the bottom (keyboard stripped if Telegram refuses the delete). '
     'The same rule was applied to the RET-4 return card after a typed reply or photo.'),
    ('DML-1 · Design Movement Ledger (/movement)',
     'A web page per design and warehouse: opening balance, receipts, sales, transfers, returns and the counted gap '
     'from stock takes, replayed from BaleMovements and Inventory. Gaps are stated in packaging, never invented in yards. '
     'Hints point at late-logged movements. Manager access is warehouse-scoped.'),
    ('SHT-1 · Storage split, step 1',
     'The workbook is split into sheets that stay (raw business records) and sheets that move to Railway Postgres. '
     'Four dead sheets (Stock_Ledger, UserPrefs, ShipmentEvents, BankFeed) were retired in code; the bootstrap can no '
     'longer recreate them. Owner still has to delete the tabs.'),
    ('APR-1 · Approver column',
     'ApprovalQueue gained column H, Approver. Every path that resolves a request — single admin, dual admin, transfer '
     'receipt, supply accept, boot sweep, task withdrawal — stamps who signed, and the requester is told by whom.'),
    ('RET-3 · Returns credit the buyer',
     'Every return approved since returns went behind approval had credited the customer ₦0: the executors emitted the '
     'ledger event without a rate. The credit now uses the request\'s rate, else the sold row\'s price, posts through the '
     'reporting emitter, and says what it credited. A read-only script lists past uncredited returns for the backfill ruling.'),
    ('RET-4 · Return goods card',
     'Customer-first: who is returning → which bale → tick the thans → returned on → condition → optional photo → confirm. '
     'One dual-admin return_thans request; the requester cannot sign. The executor flips each than in the warehouse it was '
     'sold from, dates the movement, credits per than at the booked rate, forwards the photo to both signers.'),
    ('CUR-1 · Currency display (releases A and B)',
     'Rule 17: expenses keep ₦ everywhere; sale invoices and Inventory-changing outputs print a bare number. One money '
     'module (expense → ₦12,345 · sale → 12,345 · saleRate → 1,450/yd), ≈300 sites swept across flows, services, cards, '
     'the wizard and the controller; the daybook and trial balance kept as today by ruling; old formatters removed; a '
     'smoke lint fails the run if a naira symbol reaches the sales side or an expense file loses its own.'),
    ('CUR-2 · Invoice rate multiplier (releases A and B)',
     'Two variables: CURRENCY is the accounting unit every rate is entered and booked in; a multiplier converts the '
     'entered rate for the customer copy of the invoice. The factor is chosen in the wizard\'s Step 5 (No multiplier · '
     'Settings value · type) or from Settings, frozen in the new trailing Invoices column at issue, and the document is '
     'rendered from stored base lines × stored factor. The sheet, ledger and Transactions never hold a multiplied figure. '
     'The factor is internal: shown only while entered, never on the document, caption, replies or cards.'),
]

ANALYSES = [
    ('docs/APPROVAL_BUSINESS_AUDIT_2026-09-01.md', 'Eight business scenarios traced through every approval system; 74 findings, 27 verified twice. Led to RET-3 and RET-4.'),
    ('specs/DDC-1_DAILY_DETAILS_CARD.md', 'The owner\'s Daily Details Card sketch mapped to the code: expenses reusable, sales per city new, outstanding per city barred by rule 15b. Fifteen rulings await.'),
    ('docs/CUSTOMER_PAYMENT_DOOR_2026-09-08.md', 'Where recording a customer payment stands: eight doors, one that books, no receipt or reference slot, sale-time cash double-count risk, fourteen questions.'),
    ('specs/CUR-1_CURRENCY_DISPLAY.md', 'Every money-printing site (498) classified under rule 17, the mechanism, tests, and the nine-step build. Shipped.'),
    ('specs/CUR-2_INVOICE_MULTIPLIER.md', 'The invoice and wizard drawn in both states on one worked example (3.20/yd entered; × 1,250 = 4,000.00/yd). Shipped.'),
]

RULINGS = [
    ('§6b / §6c', 'Bale, Than, Bundle defined; packaging wins the display word (Option A).'),
    ('§6d (RET-3, RET-4)', 'An approved return credits at the booked rate; the return card carries date, condition, photo; dual-admin kept.'),
    ('APR-1 / SHT-1', 'Who approved is a column; four dead sheets retired; storage split order recorded.'),
    ('§17 (08-Sep)', 'Expenses keep ₦; sale invoices and Inventory-changing outputs print a bare number; unit via the Railway variable.'),
    ('§17 amendment (08-Sep)', 'Two variables: the second is a multiplier on the entered rate for the customer copy; landed cost follows variable one.'),
    ('§17 amendment (09-Sep)', 'Internal calculations use the base figures only; the multiplier is stored separately; the factor is never shown after entry.'),
]

OWNER_STEPS = [
    'CUR-1 / CUR-2 live check (both releases): approve a sale with Step 5 = Settings value, open the invoice link and PDF, compare with the base figures on the reply and statement; a second sale with No multiplier; blank the cell and confirm the first invoice does not change. Then side A (one expense, the 20:00 report, one payment request, one incentive — all ₦) and side B (Stock Value, Check Stock, catalogue, Return goods card, /balance — all bare).',
    'Approve the rule 17 closing sentence verbatim (marked PENDING in BUSINESS_RULES).',
    'RET-3: run `node scripts/list-uncredited-returns.js` and rule on the backfill. RET-4: one live return end to end; three open questions in the spec.',
    'DML-1: open one clean design and one with a known discrepancy at /movement.',
    'SHT-1: delete the four retired tabs from the workbook. Confirm Railway Postgres snapshots are on. Give the go for the offsite backup job.',
    'DDC-1: seed the Locations sheet, set Users.branch to Kano or Lagos for every expense filer, answer the fifteen rulings.',
    'Customer-payment door: answer the fourteen questions before the Record Payment tile is built.',
    'Settings: REMINDER_HOURS_ADMIN and DIGEST_APPROVALS=1 so approval reminders run.',
]

GATE = '1,886 tests · smoke 609 checks · lint 0 errors (S-CUR currency lint in fail mode)'


def git_index():
    out = subprocess.run(
        ['git', 'log', f'--grep={SESSION}', '--format=%h|%ad|%s', '--date=short', '--reverse'],
        cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip().splitlines()
    rows = [l.split('|', 2) for l in out if l]
    return [r for r in rows if r[1] < DETAIL_FROM], len(rows)


def esc(s):
    return html.escape(s, quote=False)


def build():
    earlier, total = git_index()
    kinds = {'shipped': 'k-ship', 'docs': 'k-docs', 'analysis': 'k-ana', 'proposal': 'k-prop', 'ruling': 'k-rule', 'fix': 'k-fix'}
    tl = '\n'.join(
        f'<tr><td>{d}</td><td class="mono">{h}</td><td>{esc(t)}</td><td><span class="k {kinds[k]}">{k}</span></td><td class="muted">{esc(sz)}</td></tr>'
        for d, h, t, k, sz in TIMELINE)
    feats = '\n'.join(f'<h3>{esc(t)}</h3><p>{esc(b)}</p>' for t, b in FEATURES)
    ana = '\n'.join(f'<tr><td class="mono">{esc(p)}</td><td>{esc(b)}</td></tr>' for p, b in ANALYSES)
    rul = '\n'.join(f'<tr><td class="mono">{esc(r)}</td><td>{esc(b)}</td></tr>' for r, b in RULINGS)
    steps = '\n'.join(f'<li>{esc(s)}</li>' for s in OWNER_STEPS)
    idx = '\n'.join(f'<tr><td>{d}</td><td class="mono">{h}</td><td>{esc(s)}</td></tr>' for h, d, s in earlier)
    shipped = sum(1 for _, _, _, k, _ in TIMELINE if k == 'shipped')
    return f'''<!doctype html><html><head><meta charset="utf-8">
<title>Session record 10-Aug to 09-Sep-2026</title>
<style>
@page {{ size: A4; margin: 16mm 14mm; }}
body {{ font: 10.5pt/1.45 "DejaVu Sans", Arial, sans-serif; color: #1f2328; margin: 0; }}
h1 {{ font-size: 20pt; margin: 0 0 2pt; }}
.sub {{ color: #5b6470; margin: 0 0 14pt; }}
h2 {{ font-size: 13.5pt; margin: 18pt 0 6pt; border-bottom: 1.5pt solid #1f2328; padding-bottom: 2pt; }}
h3 {{ font-size: 11pt; margin: 10pt 0 2pt; }}
p {{ margin: 0 0 6pt; }}
table {{ border-collapse: collapse; width: 100%; font-size: 9.2pt; }}
th, td {{ text-align: left; vertical-align: top; padding: 3pt 5pt; border-bottom: 0.5pt solid #d9dee5; }}
th {{ font-size: 8pt; letter-spacing: .06em; text-transform: uppercase; color: #5b6470; }}
.mono {{ font-family: "DejaVu Sans Mono", monospace; font-size: 8.6pt; white-space: nowrap; }}
.muted {{ color: #5b6470; white-space: nowrap; }}
td:first-child {{ white-space: nowrap; }}
.k {{ font-size: 7.6pt; padding: 1pt 5pt; border-radius: 3pt; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }}
.k-ship {{ background: #dcefdd; color: #1e5b2a; }} .k-docs {{ background: #e8eaee; color: #3d4652; }}
.k-ana {{ background: #e3ecf9; color: #1f4a8a; }} .k-prop {{ background: #f6ead2; color: #7d5f1d; }}
.k-rule {{ background: #f1dfe8; color: #7a2b57; }} .k-fix {{ background: #fbe3df; color: #8a2f22; }}
.glance {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 8pt; margin: 8pt 0 4pt; }}
.glance div {{ border: 0.5pt solid #d9dee5; padding: 6pt 8pt; }}
.glance b {{ display: block; font-size: 16pt; }}
.glance span {{ font-size: 8pt; letter-spacing: .06em; text-transform: uppercase; color: #5b6470; }}
ol li {{ margin-bottom: 4pt; }}
.small td {{ font-size: 8.4pt; padding: 2pt 4pt; }}
.pb {{ page-break-before: always; }}
</style></head><body>
<h1>Session record — Telegram ops bot</h1>
<p class="sub">AtFactoryPrice · 10-Aug to 09-Sep-2026 · detailed from 31-Aug · generated 09-Sep-2026 from git (session {SESSION[-8:]})</p>

<div class="glance">
<div><b>{total}</b><span>commits this session</span></div>
<div><b>{len(TIMELINE)}</b><span>from 31-Aug, detailed below</span></div>
<div><b>{shipped}</b><span>of those shipped code</span></div>
<div><b>8</b><span>features live</span></div>
</div>
<p><b>Gate at close:</b> {esc(GATE)}. Every commit was fast-forwarded to <span class="mono">main</span> after a green gate; the bot redeploys from there.</p>

<h2>1 · Timeline, 31-Aug to 09-Sep</h2>
<table><tr><th>Date</th><th>Commit</th><th>What</th><th>Kind</th><th>Size</th></tr>{tl}</table>

<h2>2 · What each feature does</h2>
{feats}

<h2 class="pb">3 · Analyses and proposals written</h2>
<table><tr><th>Document</th><th>What it settles</th></tr>{ana}</table>

<h2>4 · Owner rulings recorded in BUSINESS_RULES</h2>
<table><tr><th>Rule</th><th>Ruling</th></tr>{rul}</table>

<h2>5 · Owner steps outstanding</h2>
<ol>{steps}</ol>

<h2 class="pb">Appendix · Earlier commits in the same session (10-Aug to 30-Aug)</h2>
<p class="sub">Index only, straight from git. Each has its own spec or doc in the repo.</p>
<table class="small"><tr><th>Date</th><th>Commit</th><th>Subject</th></tr>{idx}</table>
</body></html>'''


if __name__ == '__main__':
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(build())
    print('wrote', OUT)
