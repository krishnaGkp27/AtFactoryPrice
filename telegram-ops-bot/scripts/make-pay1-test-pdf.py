"""PAY-1 field test script — a printable checklist for Abdul + the Office phone."""

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (BaseDocTemplate, Frame, PageTemplate, Paragraph,
                                Spacer, Table, TableStyle, KeepTogether)

DJ = "/usr/share/fonts/truetype/dejavu/"
pdfmetrics.registerFont(TTFont("DJ", DJ + "DejaVuSans.ttf"))
pdfmetrics.registerFont(TTFont("DJ-B", DJ + "DejaVuSans-Bold.ttf"))
# DejaVu ships no Sans-Oblique here; the serif face carries the same glyph
# coverage (naira, ballot box) and reads as a genuine change of voice.
pdfmetrics.registerFont(TTFont("DJ-I", DJ + "DejaVuSerif.ttf"))
pdfmetrics.registerFont(TTFont("DJ-M", DJ + "DejaVuSansMono.ttf"))
pdfmetrics.registerFontFamily("DJ", normal="DJ", bold="DJ-B", italic="DJ-I")

INK = colors.HexColor("#1A1A1A")
MUTED = colors.HexColor("#6B6B6B")
RULE = colors.HexColor("#D8D5CE")
BAND = colors.HexColor("#F4F2ED")
ABDUL_C = colors.HexColor("#1F5C3D")     # green — the person asking
OFFICE_C = colors.HexColor("#8A4B10")    # amber — the hand that pays
ADMIN_C = colors.HexColor("#2C3E7A")     # blue — the approvers
STOP_C = colors.HexColor("#9B1C1C")

PAGE_W, PAGE_H = A4
M = 16 * mm


def p(size=9.4, leading=13.2, font="DJ", color=INK, space=0, align=TA_LEFT, left=0):
    return ParagraphStyle(
        f"s{size}{font}{color}{space}{left}", fontName=font, fontSize=size,
        leading=leading, textColor=color, spaceAfter=space, alignment=align,
        leftIndent=left, allowWidows=0, allowOrphans=0,
    )


BODY = p()
SMALL = p(8.2, 11.4, color=MUTED)
H1 = p(19, 23, "DJ-B", space=1)
SUB = p(10, 14, "DJ-I", MUTED, space=0)
SEC = p(12.5, 16, "DJ-B", space=0)
STEPT = p(9.6, 13.4, "DJ")
EXPECT = p(9.0, 12.6, "DJ")


def esc(t):
    return t.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def role_chip(who):
    c = {"ABDUL": ABDUL_C, "OFFICE": OFFICE_C, "ADMINS": ADMIN_C}[who]
    label = {"ABDUL": "ABDUL", "OFFICE": "OFFICE PHONE", "ADMINS": "2 ADMINS"}[who]
    t = Table([[Paragraph(f'<font color="white"><b>{label}</b></font>', p(7.2, 9, "DJ-B"))]],
              colWidths=[26 * mm], rowHeights=[6.6 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), c),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("ALIGN", (0, 0), (-1, -1), "CENTRE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2),
        ("TOPPADDING", (0, 0), (-1, -1), 1), ("BOTTOMPADDING", (0, 0), (-1, -1), 1),
    ]))
    return t


def step(n, who, do, expect, stop=False):
    """One numbered step: role chip, the action, what must happen, a tick box."""
    exp_col = STOP_C if stop else INK
    exp_lbl = "MUST HAPPEN" if not stop else "THIS IS THE BIG ONE"
    inner = [
        [role_chip(who), Paragraph(f"<b>{n}.</b>  {esc(do)}", STEPT)],
        ["", Paragraph(
            f'<font color="{exp_col.hexval()}"><b>{exp_lbl} · </b></font>{esc(expect)}',
            EXPECT)],
    ]
    body = Table(inner, colWidths=[28 * mm, 108 * mm])
    body.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (0, 0), 0.5),
        ("TOPPADDING", (1, 1), (1, 1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    box = Paragraph('<font size="15">☐</font>', p(15, 16, "DJ", MUTED))
    row = Table([[body, box]], colWidths=[142 * mm, 12 * mm])
    row.setStyle(TableStyle([
        ("VALIGN", (0, 0), (0, 0), "TOP"), ("VALIGN", (1, 0), (1, 0), "MIDDLE"),
        ("ALIGN", (1, 0), (1, 0), "CENTRE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 0), ("RIGHTPADDING", (0, 0), (-1, -1), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 3.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#FBF4F2") if stop else colors.white),
    ]))
    return row


def section(title, note=None):
    bits = [Spacer(1, 3.4 * mm), Paragraph(esc(title), SEC)]
    if note:
        bits.append(Spacer(1, 1.2 * mm))
        bits.append(Paragraph(esc(note), SMALL))
    bits.append(Spacer(1, 1.8 * mm))
    return KeepTogether(bits)


def callout(title, lines, color=ADMIN_C):
    inner = [[Paragraph(f'<b>{esc(title)}</b>', p(9.4, 12.6, "DJ-B", color))]]
    for ln in lines:
        inner.append([Paragraph(esc(ln), p(8.8, 12.4))])
    t = Table(inner, colWidths=[154 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), BAND),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, color),
        ("LEFTPADDING", (0, 0), (-1, -1), 7), ("RIGHTPADDING", (0, 0), (-1, -1), 7),
        ("TOPPADDING", (0, 0), (0, 0), 5), ("BOTTOMPADDING", (0, -1), (-1, -1), 5),
        ("TOPPADDING", (0, 1), (-1, -1), 2),
    ]))
    return t


def header_block():
    title = Paragraph("Payments — live test script", H1)
    sub = Paragraph(
        "AtFactoryPrice ops bot · PAY-1 · one small real payment, end to end", SUB)
    who = Table([[
        Paragraph('<b>Abdul</b><br/><font size="8" color="#6B6B6B">asks to be paid</font>',
                  p(9.4, 12, "DJ", ABDUL_C)),
        Paragraph('<b>Two admins</b><br/><font size="8" color="#6B6B6B">approve, on their own phones</font>',
                  p(9.4, 12, "DJ", ADMIN_C)),
        Paragraph('<b>Office phone</b><br/><font size="8" color="#6B6B6B">pays at the bank, marks it done</font>',
                  p(9.4, 12, "DJ", OFFICE_C)),
    ]], colWidths=[45 * mm, 55 * mm, 54 * mm])
    who.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0), ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
    ]))
    rule = Table([[""]], colWidths=[154 * mm], rowHeights=[0.1])
    rule.setStyle(TableStyle([("LINEABOVE", (0, 0), (-1, -1), 1.1, INK)]))
    return [title, Spacer(1, 1.5 * mm), sub, Spacer(1, 4 * mm), rule,
            Spacer(1, 3.5 * mm), who, Spacer(1, 4 * mm), rule, Spacer(1, 1 * mm)]


def signoff():
    def line(lbl, w):
        return Table([[Paragraph(f'<font color="#6B6B6B" size="8">{lbl}</font>', SMALL)],
                      [""]], colWidths=[w], rowHeights=[4.6 * mm, 7 * mm],
                     style=TableStyle([
                         ("LINEBELOW", (0, 1), (0, 1), 0.6, INK),
                         ("LEFTPADDING", (0, 0), (-1, -1), 0),
                         ("BOTTOMPADDING", (0, 0), (-1, -1), 0),
                         ("TOPPADDING", (0, 0), (-1, -1), 0),
                     ]))
    grid = Table([[line("Tested by", 48 * mm), line("Date", 34 * mm),
                   line("Everything passed? (yes / no)", 66 * mm)]],
                 colWidths=[50 * mm, 36 * mm, 68 * mm])
    grid.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (0, 0), 0),
        ("TOPPADDING", (0, 0), (-1, -1), 0),
    ]))
    notes = Table([[""], [""], [""]], colWidths=[154 * mm], rowHeights=[7 * mm] * 3)
    notes.setStyle(TableStyle([
        ("LINEBELOW", (0, 0), (-1, -1), 0.4, RULE),
        ("LEFTPADDING", (0, 0), (-1, -1), 0),
    ]))
    return [grid, Spacer(1, 3.5 * mm),
            Paragraph('<font color="#6B6B6B" size="8">Anything that did not match — write the step number and what happened instead:</font>', SMALL),
            Spacer(1, 1.5 * mm), notes]


def on_page(canv, doc):
    canv.saveState()
    canv.setFont("DJ", 7.6)
    canv.setFillColor(MUTED)
    canv.drawString(M, 10 * mm, "AtFactoryPrice · Payments live test")
    canv.drawRightString(PAGE_W - M, 10 * mm, f"Page {canv.getPageNumber()}")
    canv.restoreState()


def build(path):
    doc = BaseDocTemplate(path, pagesize=A4,
                          leftMargin=M, rightMargin=M, topMargin=14 * mm, bottomMargin=16 * mm,
                          title="Payments — live test script",
                          author="AtFactoryPrice ops bot")
    frame = Frame(M, 16 * mm, PAGE_W - 2 * M, PAGE_H - 30 * mm, id="f", showBoundary=0,
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)
    doc.addPageTemplates([PageTemplate(id="all", frames=[frame], onPage=on_page)])

    S = []
    S += header_block()

    S.append(callout("Before you start", [
        "1.  Everyone opens the bot and types  hi   — that is what shows the menu.",
        "2.  Abdul, the two admins and the Office phone should each have the bot open.",
        "3.  Use a SMALL real amount you are willing to actually send. This test really pays money.",
        "4.  Tick each box only when what you SAW matches what the sheet says must happen.",
    ]))

    S.append(section("Part 1 — Abdul registers his bank account",
                     "Done once. Nothing can be paid to an account that has not been through this."))
    S.append(step(1, "ABDUL", "Type hi, then open Payments (it may sit under Finance).",
                  "It says he has no registered account yet."))
    S.append(step(2, "ABDUL", "Tap Register account. Type his 10-digit account number.",
                  "The bot asks for the same number a SECOND time."))
    S.append(step(3, "ABDUL", "On purpose, type a WRONG number the second time (change one digit).",
                  "The bot says the two did not match and starts the number over. Nothing is saved.",
                  stop=True))
    S.append(step(4, "ABDUL", "Now type the correct number twice, pick his bank, tap Submit.",
                  "It says Sent for approval."))
    S.append(step(5, "ADMINS", "Both admins open the approval and approve it.",
                  "Abdul is told it is approved. In the PaymentAccounts sheet the row turns 'active' "
                  "and the account number still shows its leading zero."))

    S.append(section("Part 2 — Abdul asks to be paid"))
    S.append(step(6, "ABDUL", "Payments, then Request payment.",
                  "He sees ONLY his own account. No colleague's account appears anywhere."))
    S.append(step(7, "ABDUL", "Pick the account, type  45000 , tap Skip - no bill, then Submit.",
                  "The confirm screen shows ₦45,000 with NO 'large payment' warning."))
    S.append(step(8, "ADMINS", "Both admins approve the payment request.",
                  "The Office phone receives a payment card showing the name, account, bank, "
                  "₦45,000, who approved it, and two buttons: Mark Done and Decline."))

    S.append(section("Part 3 — Only the Office phone can pay",
                     "This is the rule that protects the money: one hand pays, and only that hand."))
    S.append(step(9, "ADMINS", "From an ADMIN phone (not the Office phone), tap Mark Done on that card.",
                  "It refuses: 'Only the finance person marks a payment done.' Nothing changes.",
                  stop=True))
    S.append(step(10, "OFFICE", "Make the real transfer at the bank. Then tap Mark Done.",
                  "Abdul gets a message: Paid. The sheet shows 'done', who did it, and when."))
    S.append(step(11, "OFFICE", "Tap Mark Done on the same card once more.",
                  "It refuses: 'Already marked done.' The money cannot be sent twice.", stop=True))

    S.append(section("Part 4 — The large-payment mark, and refusing a payment"))
    S.append(step(12, "ABDUL", "Raise a second request, this time for  50000 .",
                  "A 'large payment' warning now shows — it appears at ₦50,000 and above."))
    S.append(step(13, "ADMINS", "Both admins approve it so it reaches the Office phone.",
                  "The card arrives carrying the large-payment warning."))
    S.append(step(14, "OFFICE", "Tap Decline. Type just the word  no .",
                  "It refuses and asks for a real reason."))
    S.append(step(15, "OFFICE", "Now type a proper reason, e.g. Account name does not match the invoice.",
                  "Abdul receives the refusal WITH that reason. No money moves."))
    S.append(step(16, "ABDUL", "Open Payments, then My requests.",
                  "He sees ₦45,000 - paid, and ₦50,000 - declined by finance."))

    S.append(Spacer(1, 3 * mm))
    S.append(callout("If something goes wrong", [
        "Stop at that step and write down the step number and exactly what the bot said.",
        "If the payment card in step 8 goes to ALL the admins instead of only the Office phone,",
        "the card itself will print a line explaining why — photograph that line and send it.",
        "Nothing in this test can lose money on its own: the bot never moves money by itself.",
    ], color=STOP_C))

    S.append(Spacer(1, 4 * mm))
    S += signoff()

    doc.build(S)


if __name__ == "__main__":
    out = "/home/user/AtFactoryPrice/telegram-ops-bot/docs/PAY-1_TEST_SCRIPT.pdf"
    build(out)
    print("written:", out)
