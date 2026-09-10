"""Build the release PDF from the versioned risk document.

Requires reportlab. Run from any directory; paths resolve beside this script.
"""
from pathlib import Path
import json
import re
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, PageBreak

ROOT = Path(__file__).resolve().parents[1]
VERSION = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))["version"]
OUTPUT = ROOT / "whatsapp_report_bot_limitations_and_risks.pdf"
NAVY = colors.HexColor("#123044")
TEAL = colors.HexColor("#007F7A")
MUTED = colors.HexColor("#546875")

styles = getSampleStyleSheet()
styles.add(ParagraphStyle("ReportTitle", fontName="Helvetica-Bold", fontSize=30,
    leading=35, textColor=NAVY, spaceAfter=18))
styles.add(ParagraphStyle("ReportSubtitle", fontName="Helvetica", fontSize=17,
    leading=23, textColor=TEAL, spaceAfter=14))
styles.add(ParagraphStyle("ReportBody", fontName="Helvetica", fontSize=10,
    leading=13.3, textColor=NAVY, spaceAfter=7.5, splitLongWords=True))
styles.add(ParagraphStyle("ReportHeading", fontName="Helvetica-Bold", fontSize=16,
    leading=19, textColor=TEAL, spaceBefore=14, spaceAfter=8, keepWithNext=True))
styles.add(ParagraphStyle("ReportBullet", parent=styles["ReportBody"],
    leftIndent=13, firstLineIndent=-9, spaceAfter=6))
styles.add(ParagraphStyle("ReportMeta", parent=styles["ReportBody"],
    fontSize=9, leading=13, textColor=MUTED))


def inline(text):
    text = text.replace("\u2013", "-").replace("\u2014", "-").replace("\u2011", "-")
    text = text.replace("\u2018", "'").replace("\u2019", "'").replace("\u201c", '"').replace("\u201d", '"')
    text = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r"\1", text)
    text = escape(text)
    text = re.sub(r"`([^`]+)`", r'<font name="Courier" size="8.7">\1</font>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    return text


def footer(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(colors.HexColor("#D2E1E7"))
    canvas.line(20 * mm, 18 * mm, width - 20 * mm, 18 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("Helvetica", 8)
    canvas.drawString(20 * mm, 12 * mm, f"LOOKER STUDIO > WHATSAPP | RELEASE {VERSION}")
    canvas.drawRightString(width - 20 * mm, 12 * mm, str(doc.page))
    canvas.restoreState()


def main():
    story = [Spacer(1, 25 * mm),
        Paragraph("Looker Studio to<br/>WhatsApp Report Bot", styles["ReportTitle"]),
        Paragraph("Implementation controls, risks<br/>and acceptance guide", styles["ReportSubtitle"]),
        Paragraph(f"Release {VERSION} | Updated 11 September 2026", styles["ReportMeta"]),
        Spacer(1, 17 * mm),
        Paragraph("What changed", styles["ReportHeading"]),
        Paragraph("This release addresses missing-report retries, busy and stale delivery claims, multi-chat routing, saved page progress, command replay, session security, mail-forwarding diagnostics and PDF resource limits.", styles["ReportBody"]),
        Paragraph("Verification", styles["ReportHeading"]),
        Paragraph("The local suite passed 69 tests with no failures or skips, including real PDF-to-PNG conversion. A fresh scheduled email and the destination WhatsApp images are the final acceptance evidence for the live installation.", styles["ReportBody"]),
        Paragraph("Release boundary", styles["ReportHeading"]),
        Paragraph("This report describes the implemented pilot and its remaining operational limits. It does not promise uninterrupted delivery, certify recipient read receipts, or claim a successful online dependency audit when the registry was unavailable.", styles["ReportBody"]),
        Spacer(1, 10 * mm),
        Paragraph("Source of truth: versioned implementation, configuration and RISKS_AND_LIMITATIONS.md. The usage guide and handover provide step-by-step operator instructions.", styles["ReportMeta"]),
        PageBreak()]

    lines = (ROOT / "RISKS_AND_LIMITATIONS.md").read_text(encoding="utf-8").splitlines()
    paragraph = []

    def flush():
        if paragraph:
            story.append(Paragraph(inline(" ".join(paragraph)), styles["ReportBody"]))
            paragraph.clear()

    for line in lines:
        if line.startswith("# "):
            continue
        if line.startswith("## "):
            flush()
            story.append(Paragraph(inline(line[3:]), styles["ReportHeading"]))
        elif line.startswith("- "):
            flush()
            story.append(Paragraph("- " + inline(line[2:]), styles["ReportBullet"]))
        elif not line.strip():
            flush()
        else:
            paragraph.append(line.strip())
    flush()
    doc = SimpleDocTemplate(str(OUTPUT), pagesize=A4, rightMargin=20 * mm,
        leftMargin=20 * mm, topMargin=18 * mm, bottomMargin=25 * mm,
        title=f"Looker Studio WhatsApp Bot {VERSION} - Risks and Controls",
        author="WhatsApp Report Bot Project", pageCompression=1)
    doc.build(story, onFirstPage=footer, onLaterPages=footer)
    print(OUTPUT)


if __name__ == "__main__":
    main()
