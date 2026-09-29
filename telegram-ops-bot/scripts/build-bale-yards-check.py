#!/usr/bin/env python3
"""Bale yards check — the action list (docs/BALE_YARDS_CHECK_2026-09-28.pdf).

Owner, 28-Sep-2026: "I want to go ahead with some other corrections regarding
the total yards physically available inside a bale and what actually is present
in the sheet" … then, 29-Sep: "document the action item from the above analysis
into a PDF and store it in the codebase for later correction".

Source: the Inventory workbook export the owner shared on 28-Sep-2026 (8,153
Inventory rows, 6,155 holding a than). The export itself is NOT stored in the
repo. The March container was compared than by than with the supplier packing
list in the workbook's "CNTR CJE  FEB 2026" tab; the July container has no
packing list in the workbook, so its bales are listed for measuring instead.
The lists below were extracted from that export and embedded here — re-check a
row against the live sheet before correcting it.

    python3 scripts/build-bale-yards-check.py
    /opt/pw-browsers/chromium-1194/chrome-linux/chrome --headless=new --disable-gpu \\
      --no-sandbox --no-pdf-header-footer \\
      --print-to-pdf=docs/BALE_YARDS_CHECK_2026-09-28.pdf \\
      docs/BALE_YARDS_CHECK_2026-09-28.html
"""
import html
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'docs', 'BALE_YARDS_CHECK_2026-09-28.html')

# ── extracted from the 28-Sep-2026 export ────────────────────────────────────
# (design, bale, warehouse, thans on sheet, thans on shelf, yards on shelf,
#  than lengths on sheet in than order, Inventory rows, thans already sold)
MEASURE = [('202/201', '1090', 'IDUMOTA', 5, 5, 115, '30 · 21 · 25 · 19 · 20', '5707–5711', ''),
 ('202/201', '1099', 'IDUMOTA', 3, 3, 73, '32 · 21 · 20', '5730–5732', ''),
 ('202/201', '1111', 'IDUMOTA', 5, 5, 132, '30 · 30 · 30 · 21 · 21', '5761–5765', ''),
 ('202/201', '1112', 'IDUMOTA', 3, 3, 69, '29 · 20 · 20', '5766–5768', ''),
 ('44200', '1180', 'IDUMOTA', 5, 5, 128, '25 · 25 · 25 · 29 · 24', '5494–5498', ''),
 ('44201', '1038', 'IDUMOTA', 5, 5, 143, '30 · 29 · 29 · 27 · 28', '5584–5588', ''),
 ('77008', '1047', 'IDUMOTA', 5, 5, 126, '30 · 30 · 16 · 29 · 21', '5669–5673', ''),
 ('77014', '850', 'IDUMOTA', 3, 3, 74, '30 · 27 · 17', '6106–6108', ''),
 ('77014', '875', 'IDUMOTA', 5, 5, 111, '19 · 24 · 18 · 30 · 20', '6150–6154', ''),
 ('77016', '880', 'IDUMOTA', 5, 5, 153, '34 · 30 · 30 · 30 · 29', '5971–5975', ''),
 ('77016', '884', 'IDUMOTA', 4, 4, 120, '30 · 30 · 30 · 30', '5986–5989', ''),
 ('77016', '885', 'IDUMOTA', 4, 4, 99, '21 · 18 · 30 · 30', '5990–5993', ''),
 ('77016', '888', 'IDUMOTA', 5, 5, 180, '30 · 30 · 30 · 30 · 60', '6004–6008', ''),
 ('77016', '895', 'IDUMOTA', 3, 3, 73, '19 · 26 · 28', '6024–6026', ''),
 ('77016', '905', 'IDUMOTA', 4, 4, 110, '30 · 30 · 30 · 20', '6052–6055', ''),
 ('77016', '909', 'IDUMOTA', 5, 5, 144, '30 · 30 · 30 · 27 · 27', '6066–6070', ''),
 ('77018', '925', 'IDUMOTA', 5, 5, 140, '30 · 30 · 30 · 25 · 25', '5820–5824', ''),
 ('77018', '930', 'IDUMOTA', 3, 3, 90, '30 · 30 · 30', '5835–5837', ''),
 ('77018', '944', 'IDUMOTA', 3, 3, 87, '30 · 30 · 27', '5863–5865', ''),
 ('77018', '948', 'IDUMOTA', 5, 5, 117, '30 · 30 · 26 · 16 · 15', '5871–5875', ''),
 ('77018', '949', 'IDUMOTA', 3, 3, 70, '30 · 20 · 20', '5876–5878', ''),
 ('77018', '950', 'IDUMOTA', 2, 2, 93, '34 · 59', '5879–5880', ''),
 ('77019', '959', 'IDUMOTA', 3, 3, 88, '29 · 29 · 30', '5886–5888', ''),
 ('77019', '970', 'IDUMOTA', 3, 3, 76, '29 · 17 · 30', '5907–5909', ''),
 ('77019', '975', 'IDUMOTA', 4, 4, 95, '27 · 19 · 19 · 30', '5919–5922', ''),
 ('77019', '985', 'IDUMOTA', 3, 3, 72, '15 · 30 · 27', '5932–5934', ''),
 ('77019', '990', 'IDUMOTA', 3, 3, 69, '23 · 26 · 20', '5944–5946', ''),
 ('9037', '831', 'IDUMOTA', 5, 5, 143, '30 · 33 · 28 · 27 · 25', '4375–4379', ''),
 ('9037', '1036', 'IDUMOTA', 4, 4, 119, '30 · 30 · 30 · 29', '4405–4408', ''),
 ('9037', '1037', 'IDUMOTA', 4, 4, 111, '29 · 26 · 29 · 27', '4409–4412', ''),
 ('9037', '1188', 'IDUMOTA', 4, 4, 90, '21 · 19 · 27 · 23', '4443–4446', ''),
 ('9037', '1189', 'IDUMOTA', 3, 3, 59, '27 · 14 · 18', '4447–4449', ''),
 ('9037', '1193', 'IDUMOTA', 5, 5, 151, '22 · 20 · 30 · 58 · 21', '4460–4464', ''),
 ('9037', '1194', 'IDUMOTA', 5, 5, 129, '30 · 30 · 25 · 24 · 20', '4465–4469', ''),
 ('9037', '1198', 'IDUMOTA', 5, 5, 123, '30 · 19 · 24 · 30 · 20', '4485–4489', ''),
 ('9037', '1200', 'IDUMOTA', 5, 5, 171, '30 · 30 · 25 · 29 · 57', '4495–4499', ''),
 ('9037', '1201', 'IDUMOTA', 4, 4, 104, '32 · 20 · 22 · 30', '4500–4503', ''),
 ('9037', '1203', 'IDUMOTA', 5, 5, 138, '30 · 30 · 30 · 29 · 19', '4509–4513', ''),
 ('9037', '1204', 'IDUMOTA', 5, 5, 136, '25 · 16 · 21 · 24 · 50', '4514–4518', ''),
 ('9037', '1210', 'IDUMOTA', 4, 4, 123, '30 · 30 · 30 · 33', '4544–4547', ''),
 ('9037', '1211', 'IDUMOTA', 4, 4, 105, '22 · 33 · 22 · 28', '4548–4551', ''),
 ('9037', '1212', 'IDUMOTA', 3, 3, 90, '30 · 30 · 30', '4552–4554', ''),
 ('9037', '1215', 'IDUMOTA', 5, 5, 147, '60 · 26 · 19 · 22 · 20', '4555–4559', ''),
 ('9045', '1165', 'IDUMOTA', 5, 5, 137, '30 · 30 · 30 · 30 · 17', '4670–4674', ''),
 ('9045', '1166', 'IDUMOTA', 5, 5, 129, '24 · 28 · 23 · 29 · 25', '4675–4679', ''),
 ('9045', '1167', 'IDUMOTA', 4, 4, 101, '27 · 25 · 29 · 20', '4680–4683', ''),
 ('9045', '1174', 'IDUMOTA', 5, 5, 154, '30 · 30 · 30 · 45 · 19', '4714–4718', ''),
 ('202/201', '1120', 'Kano office', 6, 1, 30, '30 · 30 · 30 · 30 · 30 · 35', '2507, 2680–2681, 2852, 5789, 6156', '1, 2, 3, 4, 6'),
 ('202/201', '1128', 'Kano office', 5, 3, 110, '60 · 30 · 30 · 30 · 20', '5805–5809', '2, 3'),
 ('77014', '839', 'Kano office', 5, 5, 143, '25 · 30 · 28 · 30 · 30', '6076–6080', ''),
 ('77014', '845', 'Kano office', 5, 5, 175, '30 · 30 · 30 · 30 · 55', '6091–6095', ''),
 ('77014', '864', 'Kano office', 6, 1, 20, '30 · 30 · 30 · 28 · 21 · 20', '2837–2840, 3093, 6129', '1, 2, 3, 4, 5')]

LONG_JULY = [('202/201', '1128', 1, 60, 'on shelf', 'Kano office', '', 5805),
 ('77014', '845', 5, 55, 'on shelf', 'Kano office', '', 6095),
 ('77016', '888', 5, 60, 'on shelf', 'IDUMOTA', '', 6008),
 ('77018', '950', 2, 59, 'on shelf', 'IDUMOTA', '', 5880),
 ('9037', '1193', 4, 58, 'on shelf', 'IDUMOTA', '', 4463),
 ('9037', '1200', 5, 57, 'on shelf', 'IDUMOTA', '', 4499),
 ('9037', '1204', 5, 50, 'on shelf', 'IDUMOTA', '', 4518),
 ('9037', '1215', 1, 60, 'on shelf', 'IDUMOTA', '', 4555),
 ('9045', '1174', 4, 45, 'on shelf', 'IDUMOTA', '', 4717),
 ('202/201', '1129', 1, 60, 'sold', 'IDUMOTA', 'OKESON', 2484),
 ('408/204', '1142', 1, 60, 'sold', 'Kano office', 'ABBA', 5649),
 ('44200', '1181', 5, 56, 'sold', 'IDUMOTA', 'Madam Motunrayo', 2303),
 ('77008', '1054', 2, 60, 'sold', 'Kano office', 'Qaribullah', 2318),
 ('77008', '1055', 5, 40, 'sold', 'IDUMOTA', 'OKESON', 2439),
 ('77008', '1059', 1, 60, 'sold', 'IDUMOTA', 'OKESON', 1974),
 ('77008', '1062', 1, 60, 'sold', 'IDUMOTA', 'OKESON', 2085),
 ('77008', '1063', 1, 60, 'sold', 'IDUMOTA', 'Alabi Johnson', 2250),
 ('77008', '1066', 1, 60, 'sold', 'IDUMOTA', 'OKESON', 1984),
 ('77008', '1067', 1, 60, 'sold', 'IDUMOTA', 'Alabi Johnson', 2255),
 ('77008', '1076', 1, 60, 'sold', 'IDUMOTA', 'OKESON', 2454),
 ('77008', '1077', 1, 60, 'sold', 'Kano office', 'Qaribullah', 2338),
 ('77008', '1080', 1, 60, 'sold', 'Kano office', 'Qaribullah', 2343),
 ('77008', '1081', 1, 60, 'sold', 'IDUMOTA', 'OKESON', 2459),
 ('77016', '889', 1, 60, 'sold', 'IDUMOTA', 'OKESON', 2105),
 ('9037', '1213', 3, 40, 'sold', 'IDUMOTA', 'CJE', 2640),
 ('9037', '1213', 4, 60, 'sold', 'IDUMOTA', 'CJE', 2641)]


# ── the actions ──────────────────────────────────────────────────────────────
# (id, title, who, details, done when)
ACTIONS = [
    ('A1', 'Count bale 6438 in Lagos', 'Store · Lagos',
     'Design 16040, all five thans on the shelf. The sheet holds 5 thans — 14 · 26 · 30 · 30 · 30 = '
     '<b>130 yd</b> (Inventory rows 4022–4026). The supplier packing list holds 3 thans — 14 · 26 · 30 = '
     '<b>70 yd</b>, and its net weight of 19.2 kg fits 70 yd. Thans 4 and 5 (rows 4025 and 4026, 30 yd each) '
     'may not exist: <b>60 yd</b> of stock that could be on paper only.',
     'The bale is opened, its thans counted and measured, and the result written on this page.'),
    ('A2', 'Rule how a than that does not exist comes off the sheet', 'Owner, then agent',
     'If A1 finds 3 thans, rows 4025 and 4026 must go. ✏️ Edit Bale can change a than or add one; removing a '
     'than was deferred when Edit Bale shipped (02-Sep-2026). The sheet is never edited by hand. Two ways: a '
     '<b>remove-than step inside Edit Bale</b>, label photo and two admins as for every edit (recommended), or a '
     'one-off guarded script with a dry run.',
     'The chosen door is built and the two rows are corrected through it; Lagos stock of 16040 falls by 60 yd.'),
    ('A3', 'Measure the 52 July bales in Appendix A', 'Store · IDUMOTA, Kano office',
     'The July container has no packing list in the workbook. These 52 bales still have stock on the shelf and '
     'are not the usual 5 thans × 30 yd: <b>210 thans, 5,785 yd</b> on the sheet — 195 thans in IDUMOTA, 15 in '
     'Kano office. Appendix A lists each one with room to write the count and the measured yards. Measure only '
     'the thans still on the shelf.',
     'Appendix A is filled in and sent back; every difference is corrected through ✏️ Edit Bale (two admins).'),
    ('A4', 'Get the supplier packing list for the July container', 'Owner',
     'Without it, 542 standard July bales (5 × 30 yd) cannot be checked at all. The container carries indents '
     'SA/2521, SA/2522, SA/1328 and SA/1326 across 16 designs.',
     'The packing list is shared and the same than-by-than check runs on all 646 July bales.'),
    ('A5', 'Confirm what Ayubal Ansari paid on R-9BF6', 'Owner',
     'The sale is 3,712,500 (990 yd). The payment recorded with it is <b>3,750</b> — the same figure as the '
     'rate per yard (Ledger_Entries rows 192–193). Confirm the amount actually received.',
     'If more was paid, the balance is recorded through 💰 and his statement shows the true amount owed.'),
    ('A6', 'Rule on bank payments landing in the Cash account', 'Owner, then agent',
     'The same 3,750 was posted to <b>Cash</b> although its mode was "Paid to Zenith". The bot books a payment '
     'as bank only when the mode contains the word "bank", so every "Paid to &lt;bank&gt;" payment lands in '
     'Cash. The fix is a small change in the accounting service, plus moving the entries already posted.',
     'Bank-mode payments post to the bank account, and R-9BF6’s 3,750 is moved to it.'),
    ('A7', 'Check the last than of bale 6256 sold to ABBA', 'Owner',
     'Design 9032, all sold to ABBA. Than 5 is on the sheet as <b>28 yd</b> (row 3751, sold 03-Sep-2026); the '
     'packing list says 30. Nothing is left on the shelf.',
     'If ABBA received 30 yd, the 2 yd missing from that sale is billed; otherwise nothing to do.'),
    ('A8', 'Retire the “Sheet62” copy of the March packing list', 'Owner',
     'It swaps the totals of bales 6431 and 6438 and is missing bale 6391. The “CNTR CJE  FEB 2026” copy is '
     'consistent with its own weights and is the one to trust.',
     'Sheet62 is marked superseded or deleted, so nobody checks a bale against it.'),
    ('A9', 'Trim the 4-Sep oversize list to the July thans', 'Agent · Owner',
     'List A of docs/ISC-1_ROW_LISTS_2026-09-04.md sends 64 thans of 40 yd or more to ✏️ Edit Bale. The '
     '<b>35 March long thans all match the supplier packing list</b>: they are real long pieces, not typing '
     'errors. Only the 26 July ones stay unverified — Appendix B; the 9 still on the shelf are measured in A3.',
     'List A holds the July thans only, each settled by a measurement.'),
]

MARCH = [
    # bale, design, warehouse, status, sheet thans, sheet lengths, sheet yd, rows, packing thans, packing lengths, packing yd, finding
    ('6438', '16040', 'Lagos', '5 on the shelf', 5, '14 · 26 · 30 · 30 · 30', 130, '4022–4026', 3, '14 · 26 · 30', 70,
     'Two thans on the sheet are not on the packing list — A1, A2.'),
    ('6256', '9032', 'Kano office', '5 sold to ABBA', 5, '30 · 30 · 30 · 30 · 28', 148, '3109–3117, 3751', 5, '30 · 30 · 30 · 30 · 30', 150,
     'Than 5 recorded 2 yd short — A7.'),
    ('6294', '9031-C', 'Kano office', '5 on the shelf, 1 sold', 6, '30 · 30 · 44 · 16 · 35 · 30', 185, '2691, 3807–3810, 6155', 5, '60 · 30 · 44 · 16 · 35', 185,
     'Totals agree: the 60-yd than is held as two 30s (than 6 added by Edit Bale on 23-Sep). No action.'),
]

R9BF6 = [
    ('Request', 'approved 28-Sep-2026 15:11 (ApprovalQueue row 542)'),
    ('Stock', 'the 27 thans of the failed first run put back (BaleMovements kind “restart”), then all 33 sold in one pass, dated 25-Sep'),
    ('Transactions', 'one row: 990 yd, 33 thans (row 314)'),
    ('Ledger debits', '9006 · 337,500  ·  9037-D · 2,700,000  ·  9037-E · 675,000 (rows 189–191)'),
    ('Invoice', 'INV-2026-0077 for 3,712,500'),
    ('Payment', '3,750 posted to Cash — see A5 and A6'),
]

GLANCE = [
    ('597 of 600', 'March bales match the supplier packing list than for than'),
    ('1 bale', 'to count now — 6438, where 60 yd may not exist'),
    ('52 bales', 'from July to measure: 210 thans, 5,785 yd on the sheet'),
    ('R-9BF6', 'finished and booked once — only its payment needs a look'),
]


def esc(s):
    return html.escape(str(s), quote=False)


def who_class(w):
    w = w.lower()
    if w.startswith('store'):
        return 'w-store'
    if w.startswith('agent'):
        return 'w-agent'
    return 'w-owner'


def build():
    p = []
    p.append(f'''<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Bale yards check — action list</title>
<style>
@page {{ size: A4; margin: 15mm 13mm 14mm; }}
body {{ font: 10pt/1.45 "DejaVu Sans", Arial, sans-serif; color: #1f2328; margin: 0; }}
h1 {{ font-size: 19pt; margin: 0 0 2pt; letter-spacing: -.01em; }}
h2 {{ font-size: 12.5pt; margin: 16pt 0 6pt; padding-bottom: 3pt; border-bottom: 1.2pt solid #1f3a4d; }}
h3 {{ font-size: 10.5pt; margin: 12pt 0 4pt; }}
.sub {{ color: #5b6470; margin: 0 0 12pt; }}
p {{ margin: 0 0 6pt; }}
table {{ border-collapse: collapse; width: 100%; }}
th {{ font-size: 7.6pt; letter-spacing: .05em; text-transform: uppercase; color: #5b6470; text-align: left;
      font-weight: bold; padding: 4pt 5pt; border-bottom: 1pt solid #9aa5b1; vertical-align: bottom; }}
td {{ padding: 4pt 5pt; border-bottom: .6pt solid #d9dee3; vertical-align: top; }}
.num {{ text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }}
.mono {{ font-family: "DejaVu Sans Mono", monospace; font-size: 8.2pt; }}
.muted {{ color: #5b6470; }}
.glance {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 6pt; margin: 4pt 0 6pt; }}
.glance div {{ border: .8pt solid #c9d3da; border-radius: 3pt; padding: 6pt 7pt; }}
.glance b {{ display: block; font-size: 13pt; color: #1f3a4d; }}
.glance span {{ font-size: 8.4pt; color: #3d4652; }}
.action {{ border-bottom: .6pt solid #d9dee3; padding: 7pt 0 6pt; break-inside: avoid; }}
.action .ah {{ display: flex; align-items: baseline; gap: 6pt; margin-bottom: 3pt; }}
.action .id {{ font-weight: bold; color: #1f3a4d; min-width: 16pt; }}
.action .ttl {{ font-weight: bold; font-size: 10.5pt; flex: 1; }}
.action p {{ margin: 0 0 3pt 31pt; font-size: 9.2pt; }}
.action .done {{ color: #3d4652; font-size: 8.8pt; }}
.action .done b {{ color: #1f2328; }}
.cell-main {{ font-weight: bold; white-space: nowrap; }}
.cell-sub {{ color: #5b6470; font-size: 8.4pt; }}
.box {{ display: inline-block; width: 9pt; height: 9pt; border: 1pt solid #5b6470; border-radius: 1.5pt; vertical-align: -1pt; }}
.who {{ display: inline-block; font-size: 7.6pt; padding: 1pt 5pt; border-radius: 8pt; white-space: nowrap; }}
.w-owner {{ background: #f6ead2; color: #7d5f1d; }} .w-store {{ background: #dcefdd; color: #1e5b2a; }}
.w-agent {{ background: #e3ecf9; color: #1f4a8a; }}
.note {{ background: #f3f5f7; border-left: 2.5pt solid #9aa5b1; padding: 5pt 8pt; margin: 6pt 0; font-size: 9pt; }}
.appx td {{ font-size: 8.4pt; padding: 3pt 4pt; }}
.appx th {{ padding: 3pt 4pt; }}
.fill {{ border-bottom: .8pt solid #5b6470; min-width: 30pt; display: inline-block; height: 10pt; }}
.grp td {{ background: #eef3f6; font-weight: bold; font-size: 8.6pt; }}
table.fixed {{ table-layout: fixed; }}
.appx .mono {{ white-space: nowrap; font-size: 7.8pt; }}
.appx th, .appx th.num {{ white-space: normal; }}
.appx .fill {{ min-width: 0; width: 90%; }}
.pb {{ break-before: page; }}
tr {{ break-inside: avoid; }}
.foot {{ color: #5b6470; font-size: 8.2pt; margin-top: 12pt; }}
</style></head><body>''')

    p.append('<h1>Bale yards check — action list</h1>')
    p.append('<p class="sub">Inventory export of 28-Sep-2026, checked against the supplier packing list · prepared 29-Sep-2026 · '
             'tick each action when it is done</p>')
    p.append('<div class="glance">' + ''.join(f'<div><b>{esc(a)}</b><span>{esc(b)}</span></div>' for a, b in GLANCE) + '</div>')

    p.append('<h2>Actions</h2>')
    for aid, title, who, details, done in ACTIONS:
        p.append(f'<div class="action"><div class="ah"><span class="box"></span><span class="id">{aid}</span>'
                 f'<span class="ttl">{esc(title)}</span><span class="who {who_class(who)}">{esc(who)}</span></div>'
                 f'<p>{details}</p><p class="done"><b>Done when</b> — {esc(done)}</p></div>')

    p.append('<h2>March container against the supplier packing list</h2>')
    p.append('<p>600 March bales are on the sheet. 597 match the packing list in the “CNTR CJE  FEB 2026” tab than for than; '
             'these three differ.</p>')
    p.append('<table><thead><tr><th style="width:7%">Bale</th><th style="width:8%">Design</th><th style="width:14%">Where · status</th>'
             '<th style="width:24%">On the sheet</th><th style="width:19%">On the packing list</th><th>Finding</th></tr></thead><tbody>')
    for b, d, wh, st, sn, sl, sy, rows, pn, pl, py, f in MARCH:
        p.append(f'<tr><td><b>{b}</b></td><td>{esc(d)}</td><td>{esc(wh)}<br><span class="cell-sub">{esc(st)}</span></td>'
                 f'<td><span class="cell-main">{sn} thans · {sy} yd</span><br><span class="cell-sub">{esc(sl)}</span><br>'
                 f'<span class="cell-sub">rows {esc(rows)}</span></td>'
                 f'<td><span class="cell-main">{pn} thans · {py} yd</span><br><span class="cell-sub">{esc(pl)}</span></td><td>{esc(f)}</td></tr>')
    p.append('</tbody></table>')
    p.append('<div class="note">The 35 March thans of 40 yd or more (22 sold, 13 on the shelf) all match the packing list — genuine long pieces. '
             'The workbook holds a second copy of this packing list (“Sheet62”) with the totals of bales 6431 and 6438 swapped and bale 6391 missing; '
             'by the “CNTR CJE  FEB 2026” copy both 6431 and 6391 are correct on the sheet.</div>')

    p.append('<h2>R-9BF6 — Ayubal Ansari, 25-Sep-2026: confirmed complete</h2>')
    p.append('<table><tbody>' + ''.join(f'<tr><td style="width:18%" class="muted">{esc(a)}</td><td>{esc(b)}</td></tr>' for a, b in R9BF6) + '</tbody></table>')

    # Appendix A
    p.append('<h2 class="pb">Appendix A — July bales to measure (action A3)</h2>')
    p.append('<p>Not the usual 5 thans × 30 yd, stock still on the shelf. <b>Measure only the thans on the shelf</b>; the yards column is what '
             'the sheet says those thans hold. Write the count and the measured total in the last two columns.</p>')
    p.append('<table class="appx fixed"><colgroup><col style="width:9%"><col style="width:7%"><col style="width:7%"><col style="width:8%">'
             '<col style="width:23%"><col style="width:14%"><col style="width:9%"><col style="width:11%"><col style="width:12%"></colgroup>'
             '<thead><tr><th>Design</th><th>Bale</th><th class="num">Thans on shelf</th><th class="num">Yards (sheet)</th>'
             '<th>Than lengths (sheet)</th><th>Inventory rows</th><th>Note</th><th>Counted thans</th><th>Measured yd</th></tr></thead><tbody>')
    wh = None
    tot_t = tot_y = 0
    for d, b, w, nall, non, yon, lens, rows, sold in MEASURE:
        if w != wh:
            n = sum(1 for m in MEASURE if m[2] == w)
            t = sum(m[4] for m in MEASURE if m[2] == w)
            y = sum(m[5] for m in MEASURE if m[2] == w)
            p.append(f'<tr class="grp"><td colspan="9">{esc(w)} — {n} bales · {t} thans · {y:,} yd on the sheet</td></tr>')
            wh = w
        note = f'than {sold} sold' if sold else ''
        tot_t += non
        tot_y += yon
        p.append(f'<tr><td>{esc(d)}</td><td class="mono">{esc(b)}</td><td class="num">{non}</td><td class="num">{yon}</td>'
                 f'<td class="mono">{esc(lens)}</td><td class="mono">{esc(rows)}</td><td class="muted">{esc(note)}</td>'
                 f'<td><span class="fill"></span></td><td><span class="fill"></span></td></tr>')
    p.append(f'<tr><td colspan="2"><b>Total</b></td><td class="num"><b>{tot_t}</b></td><td class="num"><b>{tot_y:,}</b></td>'
             '<td colspan="5"></td></tr>')
    p.append('</tbody></table>')

    # Appendix B
    p.append('<h2>Appendix B — July thans of 40 yd or more (action A9)</h2>')
    p.append('<p>March long thans are confirmed by the packing list; these July ones are not. The ones on the shelf are measured with Appendix A.</p>')
    p.append('<table class="appx"><thead><tr><th>Design</th><th>Bale</th><th class="num">Than</th><th class="num">Yards</th><th>Status</th>'
             '<th>Warehouse</th><th>Sold to</th><th class="num">Inventory row</th></tr></thead><tbody>')
    for d, b, t, y, st, w, sold_to, row in LONG_JULY:
        p.append(f'<tr><td>{esc(d)}</td><td class="mono">{esc(b)}</td><td class="num">{t}</td><td class="num">{y}</td><td>{esc(st)}</td>'
                 f'<td>{esc(w)}</td><td>{esc(sold_to)}</td><td class="num">{row}</td></tr>')
    p.append('</tbody></table>')

    p.append('<p class="foot">How this was checked: every Inventory row of the 28-Sep export was grouped into bales (design · bale number · container). '
             'March bales were compared than by than with the supplier packing list in the “CNTR CJE  FEB 2026” tab; July bales, which have no packing '
             'list in the workbook, were compared with the usual 5 thans × 30 yd. Row numbers are the Inventory sheet rows on 28-Sep; the sheet may have '
             'moved since, so find each bale by its number before correcting it. Source: scripts/build-bale-yards-check.py.</p>')
    p.append('</body></html>')
    with open(OUT, 'w', encoding='utf-8') as fh:
        fh.write('\n'.join(p))
    print(f'wrote {OUT}')


if __name__ == '__main__':
    build()
