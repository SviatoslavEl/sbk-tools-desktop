from __future__ import annotations

import io
from collections.abc import Callable
from pathlib import Path

from docx import Document
from docx.document import Document as DocumentType
from docx.oxml.ns import qn
from docx.table import Table as DocxTable
from docx.text.paragraph import Paragraph as DocxParagraph
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.utils import ImageReader
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Image,
    KeepTogether,
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from scandocument.errors import DocxConversionError
from scandocument.resources import find_font, find_soffice


A4_WIDTH_PT = 595.2756
A4_HEIGHT_PT = 841.8898
DEFAULT_MARGIN_PT = 72.0


def _points(value, default: float) -> float:
    """Return an OOXML length in points, tolerating omitted section properties."""
    if value is None:
        return default
    try:
        return float(value.pt)
    except (AttributeError, TypeError, ValueError):
        return default


def _register_fonts() -> tuple[str, str, str, str]:
    names: list[str] = []
    variants = ((False, False, "SDRegular"), (True, False, "SDBold"), (False, True, "SDItalic"), (True, True, "SDBoldItalic"))
    for bold, italic, name in variants:
        path = find_font(bold=bold, italic=italic)
        if path:
            try:
                pdfmetrics.registerFont(TTFont(name, str(path)))
                names.append(name)
                continue
            except Exception:
                pass
        names.append("Helvetica-Bold" if bold else "Helvetica")
    return tuple(names)  # type: ignore[return-value]


REGULAR, BOLD, ITALIC, BOLD_ITALIC = _register_fonts()


def _iter_blocks(parent: DocumentType):
    body = parent.element.body
    for child in body.iterchildren():
        if child.tag.endswith("}p"):
            yield DocxParagraph(child, parent)
        elif child.tag.endswith("}tbl"):
            yield DocxTable(child, parent)


def _escape(text: str) -> str:
    return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _paragraph_markup(paragraph: DocxParagraph) -> str:
    pieces: list[str] = []
    for run in paragraph.runs:
        text = _escape(run.text).replace("\n", "<br/>")
        if not text:
            continue
        if run.bold:
            text = f"<b>{text}</b>"
        if run.italic:
            text = f"<i>{text}</i>"
        if run.underline:
            text = f"<u>{text}</u>"
        pieces.append(text)
    return "".join(pieces) or "&#160;"


def _paragraph_style(paragraph: DocxParagraph, width: float) -> ParagraphStyle:
    fmt = paragraph.paragraph_format
    alignment = {0: TA_LEFT, 1: TA_CENTER, 2: TA_RIGHT, 3: TA_JUSTIFY}.get(paragraph.alignment, TA_LEFT)
    run = next((r for r in paragraph.runs if r.text), None)
    size = float(run.font.size.pt) if run and run.font.size else 10.5
    left = float(fmt.left_indent.pt) if fmt.left_indent else 0.0
    right = float(fmt.right_indent.pt) if fmt.right_indent else 0.0
    first = float(fmt.first_line_indent.pt) if fmt.first_line_indent else 0.0
    before = float(fmt.space_before.pt) if fmt.space_before else 0.0
    after = float(fmt.space_after.pt) if fmt.space_after else 4.0
    return ParagraphStyle(
        "docx", fontName=REGULAR, fontSize=max(5.0, min(72.0, size)),
        leading=max(7.0, size * 1.22), alignment=alignment, leftIndent=max(0.0, left),
        rightIndent=max(0.0, right), firstLineIndent=first, spaceBefore=before,
        spaceAfter=after, splitLongWords=True, allowWidows=1, allowOrphans=1,
        wordWrap="CJK", maxWidth=max(20, width - left - right),
    )


def _extract_inline_images(paragraph: DocxParagraph, max_width: float) -> list[Image]:
    result: list[Image] = []
    for run in paragraph.runs:
        for drawing in run._element.xpath(".//*[local-name()='blip']"):
            rel_id = drawing.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}embed")
            if not rel_id:
                continue
            try:
                blob = paragraph.part.related_parts[rel_id].blob
                reader = ImageReader(io.BytesIO(blob))
                width, height = reader.getSize()
                scale = min(1.0, max_width / max(width, 1))
                result.append(Image(io.BytesIO(blob), width=width * scale, height=height * scale))
            except Exception:
                continue
    return result


def _section_text(section, part_name: str) -> str:
    """Read an existing header/footer without making python-docx create one."""
    reference_name = "headerReference" if part_name == "header" else "footerReference"
    if not section._sectPr.findall(qn(f"w:{reference_name}")):
        return ""
    part = getattr(section, part_name)
    return " · ".join(paragraph.text.strip() for paragraph in part.paragraphs if paragraph.text.strip())


def _table_flowable(table: DocxTable, available_width: float) -> Table:
    data: list[list[Paragraph]] = []
    max_cols = max((len(row.cells) for row in table.rows), default=1)
    cell_width = available_width / max_cols
    cell_style = ParagraphStyle("cell", fontName=REGULAR, fontSize=9, leading=11, wordWrap="CJK")
    for row in table.rows:
        values = [Paragraph(_escape(cell.text).replace("\n", "<br/>"), cell_style) for cell in row.cells]
        values.extend(Paragraph("", cell_style) for _ in range(max_cols - len(values)))
        data.append(values)
    result = Table(data or [[Paragraph("", cell_style)]], colWidths=[cell_width] * max_cols, repeatRows=1)
    result.setStyle(TableStyle([
        ("FONTNAME", (0, 0), (-1, -1), REGULAR),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.45, colors.HexColor("#777777")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    return result


def _convert_docx_with_basic_layout(source: Path, destination: Path) -> list[str]:
    """Render common DOCX content locally without Word/LibreOffice.

    This intentionally supports the stable subset (paragraphs, basic tables, inline images,
    sections, simple headers/footers) and reports limitations rather than silently hiding them.
    """
    warnings = [
        "Проверьте предварительный просмотр: формулы, плавающие объекты, поля и сложные стили DOCX могут отличаться от Word."
    ]
    try:
        document = Document(str(source))
        section = document.sections[0]
        page_size = (
            _points(section.page_width, A4_WIDTH_PT),
            _points(section.page_height, A4_HEIGHT_PT),
        )
        margins = (
            _points(section.left_margin, DEFAULT_MARGIN_PT),
            _points(section.right_margin, DEFAULT_MARGIN_PT),
            _points(section.top_margin, DEFAULT_MARGIN_PT),
            _points(section.bottom_margin, DEFAULT_MARGIN_PT),
        )
        available_width = page_size[0] - margins[0] - margins[1]
        story = []
        for block in _iter_blocks(document):
            if isinstance(block, DocxParagraph):
                if "pageBreakBefore" in block._p.xml and story:
                    story.append(PageBreak())
                images = _extract_inline_images(block, available_width)
                text = _paragraph_markup(block)
                paragraph = Paragraph(text, _paragraph_style(block, available_width))
                story.append(KeepTogether([paragraph, *images]) if images else paragraph)
                if not block.text and not images:
                    story.append(Spacer(1, 3))
            else:
                story.append(_table_flowable(block, available_width))
                story.append(Spacer(1, 6))

        header_text = _section_text(section, "header")
        footer_text = _section_text(section, "footer")
        footer_style = getSampleStyleSheet()["Normal"]
        footer_style.fontName = REGULAR
        footer_style.fontSize = 8

        def decorate(canvas, doc):
            canvas.saveState()
            canvas.setFont(REGULAR, 8)
            if header_text:
                canvas.drawString(margins[0], page_size[1] - max(18, margins[2] * 0.55), header_text[:300])
            if footer_text:
                canvas.drawString(margins[0], max(12, margins[3] * 0.45), footer_text[:260])
            canvas.drawRightString(page_size[0] - margins[1], max(12, margins[3] * 0.45), str(doc.page))
            canvas.restoreState()

        buffer = io.BytesIO()
        template = SimpleDocTemplate(
            buffer, pagesize=page_size, leftMargin=margins[0], rightMargin=margins[1],
            topMargin=margins[2], bottomMargin=margins[3],
            title=source.stem, author="ScanDocument", pageCompression=1,
        )
        template.build(story or [Paragraph("", footer_style)], onFirstPage=decorate, onLaterPages=decorate)
        destination.write_bytes(buffer.getvalue())

        # Report mixed-section limitations explicitly; the renderer preserves the first section.
        if len(document.sections) > 1:
            warnings.append("Документ содержит несколько разделов; размер первой секции применён ко всему предпросмотру.")
        return warnings
    except Exception as exc:
        destination.unlink(missing_ok=True)
        raise DocxConversionError(
            "Не удалось безопасно отобразить DOCX. Сохраните его как PDF и повторите обработку."
        ) from exc


def convert_docx_to_pdf(
    source: Path,
    destination: Path,
    cancelled: Callable[[], bool] | None = None,
) -> list[str]:
    """Prefer the bundled Writer layout engine; retain a development fallback."""
    soffice = find_soffice()
    if soffice:
        from scandocument.office_engine import convert_with_office

        return convert_with_office(
            source, destination, soffice, destination.parent, cancelled,
        )
    if cancelled and cancelled():
        from scandocument.errors import CancelledError

        raise CancelledError("Подготовка документа остановлена.")
    return _convert_docx_with_basic_layout(source, destination)
