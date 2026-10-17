"""Optional, bounded proof of adjacent PDF table cells from real vector edges.

This is deliberately not a general table recognizer. It only exports a closed
two-column ``Артикул`` / ``Наименование`` grid. Text order, page proximity,
filenames and a model's proposed pairing are never evidence of a row relation.
Uncertain geometry returns no extra fragments; the original page text remains
the extraction's authoritative fallback.
"""
from __future__ import annotations

import ctypes
import math
import re
import time
from dataclasses import dataclass, field

import pypdfium2.raw as pdfium_raw


MAX_GRID_OBJECTS = 5_000
MAX_GRID_SEGMENTS = 64
MAX_GRID_EDGES = 512
MAX_GRID_CHARACTERS = 50_000
MAX_GRID_AXIS_VALUES = 128
MAX_GRID_ROWS = 64
MAX_GRID_TABLES = 4
MAX_GRID_CELL_CHARS = 20_000
MAX_GRID_OUTPUT_CHARS = 100_000
MAX_GRID_SECONDS = .5
MAX_GRID_DEPTH = 4
# Thin rectangles used by office exporters have half-width gaps at line
# intersections. Only sub-point join/rounding differences may be closed.
EDGE_TOLERANCE = .6
MAX_EDGE_THICKNESS = 1.
FLOAT_EPSILON = 1e-4


class _UncertainGrid(Exception):
    pass


class _GridLimit(Exception):
    pass


@dataclass
class PdfGridResult:
    fragments: list[dict] = field(default_factory=list)
    limited: bool = False


def _finite(bounds) -> bool:
    return all(math.isfinite(value) and abs(value) <= 1_000_000 for value in bounds)


def _identity(obj) -> bool:
    return all(abs(actual - expected) <= 1e-6 for actual, expected in
               zip(obj.get_matrix().get(), (1., 0., 0., 1., 0., 0.), strict=True))


def _color_visible(obj, *, stroke: bool) -> bool:
    values = [ctypes.c_uint() for _ in range(4)]
    getter = pdfium_raw.FPDFPageObj_GetStrokeColor if stroke else pdfium_raw.FPDFPageObj_GetFillColor
    return bool(getter(obj, *values) and values[3].value == 255
                and min(value.value for value in values[:3]) < 250)


def _path_edges(obj) -> tuple[list[tuple[float, float, float]], list[tuple[float, float, float]]]:
    """Return H(y,left,right), V(x,bottom,top); ignore unsupported paths."""
    if not _identity(obj):
        return [], []
    clip = pdfium_raw.FPDFPageObj_GetClipPath(obj)
    if clip and pdfium_raw.FPDFClipPath_CountPaths(clip) > 0:
        return [], []
    count = pdfium_raw.FPDFPath_CountSegments(obj)
    if count < 2 or count > MAX_GRID_SEGMENTS:
        return [], []
    points: list[tuple[float, float]] = []
    closed = False
    for index in range(count):
        segment = pdfium_raw.FPDFPath_GetPathSegment(obj, index)
        kind = pdfium_raw.FPDFPathSegment_GetType(segment)
        if kind != (pdfium_raw.FPDF_SEGMENT_MOVETO if index == 0 else pdfium_raw.FPDF_SEGMENT_LINETO):
            return [], []
        x, y = ctypes.c_float(), ctypes.c_float()
        if not pdfium_raw.FPDFPathSegment_GetPoint(segment, x, y) or not _finite((x.value, y.value)):
            return [], []
        points.append((x.value, y.value))
        closed = bool(pdfium_raw.FPDFPathSegment_GetClose(segment))
    if closed and points[-1] != points[0]:
        points.append(points[0])
    if any(abs(a[0] - b[0]) > 1e-5 and abs(a[1] - b[1]) > 1e-5 for a, b in zip(points, points[1:])):
        return [], []
    fill, stroke = ctypes.c_int(), ctypes.c_int()
    if not pdfium_raw.FPDFPath_GetDrawMode(obj, fill, stroke):
        return [], []
    left, right = min(x for x, _ in points), max(x for x, _ in points)
    bottom, top = min(y for _, y in points), max(y for _, y in points)
    # A real, opaque, closed thin rectangle is a painted vector line. Large
    # filled backgrounds are NOT borders and cannot establish any cells.
    corners = {(left, bottom), (left, top), (right, bottom), (right, top)}
    rectangle = closed and 4 <= count <= 5 and set(points) == corners
    if rectangle and fill.value and _color_visible(obj, stroke=False):
        if top - bottom <= MAX_EDGE_THICKNESS and right - left >= 3:
            return [((top + bottom) / 2, left, right)], []
        if right - left <= MAX_EDGE_THICKNESS and top - bottom >= 3:
            return [], [((left + right) / 2, bottom, top)]
    if not stroke.value or not _color_visible(obj, stroke=True):
        return [], []
    width = ctypes.c_float()
    if not pdfium_raw.FPDFPageObj_GetStrokeWidth(obj, width) or not 0 <= width.value <= MAX_EDGE_THICKNESS:
        return [], []
    horizontal, vertical = [], []
    for a, b in zip(points, points[1:]):
        if abs(a[1] - b[1]) <= 1e-5 and abs(a[0] - b[0]) >= 3:
            horizontal.append((a[1], min(a[0], b[0]), max(a[0], b[0])))
        elif abs(a[0] - b[0]) <= 1e-5 and abs(a[1] - b[1]) >= 3:
            vertical.append((a[0], min(a[1], b[1]), max(a[1], b[1])))
    return horizontal, vertical


def _axis(values: list[float]) -> list[float]:
    groups: list[list[float]] = []
    for value in sorted(values):
        if groups and value - groups[-1][0] <= EDGE_TOLERANCE:
            groups[-1].append(value)
        else:
            groups.append([value])
    if len(groups) > MAX_GRID_AXIS_VALUES:
        raise _GridLimit()
    return [sum(group) / len(group) for group in groups]


def _covers(edges, position: float, start: float, end: float) -> bool:
    current = start
    for left, right in sorted((a, b) for coordinate, a, b in edges if abs(coordinate - position) <= EDGE_TOLERANCE):
        if right < current - EDGE_TOLERANCE:
            continue
        if left > current + EDGE_TOLERANCE:
            return False
        current = max(current, right)
        if current >= end - EDGE_TOLERANCE:
            return True
    return False


def _closed(horizontal, vertical, left: float, bottom: float, right: float, top: float) -> bool:
    return right - left >= 4 and top - bottom >= 4 and (
        _covers(horizontal, bottom, left, right) and _covers(horizontal, top, left, right)
        and _covers(vertical, left, bottom, top) and _covers(vertical, right, bottom, top))


def _normal_header(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip().lower()


def _header_role(text: str) -> str | None:
    value = _normal_header(text)
    if value == "артикул":
        return "sku"
    if re.fullmatch(r"наименование(?: (?:оборудования|товара|продукции))?(?: (?:предложенного|предлагаемого) к поставке)?", value):
        return "name"
    return None


def _text(text_page, bounds) -> str:
    value = text_page.get_text_bounded(*bounds).strip()
    if len(value) > MAX_GRID_CELL_CHARS:
        raise _GridLimit()
    # A tab inside one cell would change the row's asserted column structure.
    if "\t" in value:
        raise _UncertainGrid()
    return value


def _intersects(a, b) -> bool:
    return a[0] < b[2] and a[2] > b[0] and a[1] < b[3] and a[3] > b[1]


def _glyphs(text_page, deadline):
    count = text_page.count_chars()
    if count > MAX_GRID_CHARACTERS:
        raise _GridLimit()
    result = []
    for index in range(count):
        if index % 128 == 0 and time.monotonic() > deadline:
            raise _GridLimit()
        code = pdfium_raw.FPDFText_GetUnicode(text_page, index)
        if 0xd800 <= code <= 0xdfff:
            raise _UncertainGrid()
        if not code or code > 0x10ffff:
            continue
        char = chr(code)
        if char.isspace():
            result.append((None, char, None, False, False))
            continue
        bounds = text_page.get_charbox(index)
        if not _finite(bounds):
            raise _UncertainGrid()
        angle = pdfium_raw.FPDFText_GetCharAngle(text_page, index)
        obj = pdfium_raw.FPDFText_GetTextObject(text_page, index)
        mode = pdfium_raw.FPDFTextObj_GetTextRenderMode(obj) if obj else -1
        x, y = ctypes.c_double(), ctypes.c_double()
        origin_ok = pdfium_raw.FPDFText_GetCharOrigin(text_page, index, x, y)
        rgba = [ctypes.c_uint() for _ in range(4)]
        color = pdfium_raw.FPDFPageObj_GetStrokeColor if mode == 1 else pdfium_raw.FPDFPageObj_GetFillColor
        color_ok = bool(obj and color(obj, *rgba))
        valid = bool(obj and mode in (0, 1, 2, 3) and color_ok and origin_ok and _finite((x.value, y.value))
                     and math.isfinite(angle) and abs(math.remainder(angle, 2 * math.pi)) < 1e-5)
        result.append((bounds, char, (x.value, y.value), valid, mode == 3 or rgba[3].value == 0))
    return result


def _paint_band(obj, edge, horizontal):
    bounds = obj.get_bounds()
    low, high = (bounds[1], bounds[3]) if horizontal else (bounds[0], bounds[2])
    if high - low <= MAX_EDGE_THICKNESS:
        return (edge[0], edge[1], edge[2], low, high)
    width = ctypes.c_float()
    if not pdfium_raw.FPDFPageObj_GetStrokeWidth(obj, width):
        raise _UncertainGrid()
    return (edge[0], edge[1], edge[2], edge[0] - width.value / 2, edge[0] + width.value / 2)


def _border_band(bands, position, start, end):
    selected = sorted((low, high) for coordinate, left, right, low, high in bands
                      if abs(coordinate - position) <= EDGE_TOLERANCE and right >= start and left <= end)
    if not selected:
        raise _UncertainGrid()
    low, high = selected[0]
    for next_low, next_high in selected[1:]:
        # Two separate parallel painted lines are not one invented borderband.
        if next_low > high + FLOAT_EPSILON:
            raise _UncertainGrid()
        high = max(high, next_high)
    return low, high


def _cell_interior(cell, horizontal_bands, vertical_bands):
    left, bottom, right, top = cell
    lb = _border_band(vertical_bands, left, bottom, top)
    rb = _border_band(vertical_bands, right, bottom, top)
    bb = _border_band(horizontal_bands, bottom, left, right)
    tb = _border_band(horizontal_bands, top, left, right)
    return (lb[1], bb[1], rb[0], tb[0]), (lb, bb, rb, tb)


def _char_owner(box, origin, interior, bands) -> bool:
    center = ((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
    left, bottom, right, top = interior
    lb, bb, rb, _ = bands
    # Character origin is PDFium's text-space baseline origin. A baseline at
    # the upper outer edge of the bottom paint band belongs only to the upper
    # cell. Origins inside paint, or a glyph center in another cell, do not.
    return (left - FLOAT_EPSILON <= origin[0] <= right + FLOAT_EPSILON
            and bottom - FLOAT_EPSILON <= origin[1] <= top + FLOAT_EPSILON
            and left - FLOAT_EPSILON <= center[0] <= right + FLOAT_EPSILON
            and bb[0] - FLOAT_EPSILON <= center[1] <= top + FLOAT_EPSILON
            and box[0] >= lb[0] - FLOAT_EPSILON and box[2] <= rb[1] + FLOAT_EPSILON
            and box[3] <= top + FLOAT_EPSILON)


def _reconstruct_cell_texts(glyphs, cells, bounds, horizontal_bands, vertical_bands, deadline=math.inf) -> list[str]:
    """Assign source characters, never a PDFium bounded-text bleed, to cells."""
    assigned = [[] for _ in cells]
    ocr = [False for _ in cells]
    interiors = [_cell_interior(cell["bounds"], horizontal_bands, vertical_bands) for cell in cells]
    pending = ""
    previous_owner = None
    for glyph_index, (box, char, origin, valid, invisible) in enumerate(glyphs):
        if glyph_index % 64 == 0 and time.monotonic() > deadline:
            raise _GridLimit()
        if box is None:
            pending += char
            continue
        if not _intersects(box, bounds):
            continue
        if not valid:
            raise _UncertainGrid()
        owners = [index for index, (interior, bands) in enumerate(interiors) if _char_owner(box, origin, interior, bands)]
        if len(owners) != 1:
            raise _UncertainGrid()
        if "\t" in pending:
            raise _UncertainGrid()
        if previous_owner is not None and previous_owner != owners[0] and not pending:
            raise _UncertainGrid()
        assigned[owners[0]].append(pending + char)
        pending = ""
        previous_owner = owners[0]
        ocr[owners[0]] = ocr[owners[0]] or invisible
    for index, cell in enumerate(cells):
        value = "".join(assigned[index]).strip()
        if len(value) > MAX_GRID_CELL_CHARS:
            raise _GridLimit()
        cell["text"] = value
    return ["ocr" if value else "text" for value in ocr]


def extract_pdf_table_rows(page, text_page, page_number: int, *, deadline: float | None = None) -> PdfGridResult:
    """Return supplemental literal row fragments, atomically failing closed.

    ``deadline`` lets extraction bound total optional-grid work across pages.
    The page and text page stay owned by the caller and are never mutated.
    """
    deadline = min(deadline if deadline is not None else math.inf, time.monotonic() + MAX_GRID_SECONDS)
    try:
        if page.get_rotation() != 0:
            return PdfGridResult()
        horizontal, vertical = [], []
        horizontal_bands, vertical_bands = [], []
        for index, obj in enumerate(page.get_objects(max_depth=MAX_GRID_DEPTH)):
            if index >= MAX_GRID_OBJECTS or time.monotonic() > deadline:
                raise _GridLimit()
            if obj.type == pdfium_raw.FPDF_PAGEOBJ_FORM:
                if not _identity(obj) or (obj.level >= MAX_GRID_DEPTH - 1 and pdfium_raw.FPDFFormObj_CountObjects(obj)):
                    raise _UncertainGrid()
            if obj.type == pdfium_raw.FPDF_PAGEOBJ_PATH:
                h, v = _path_edges(obj)
                horizontal.extend(h)
                vertical.extend(v)
                horizontal_bands.extend(_paint_band(obj, edge, True) for edge in h)
                vertical_bands.extend(_paint_band(obj, edge, False) for edge in v)
                if len(horizontal) + len(vertical) > MAX_GRID_EDGES:
                    raise _GridLimit()
        if not horizontal or len(vertical) < 3:
            return PdfGridResult()
        if text_page.count_chars() > MAX_GRID_CHARACTERS:
            raise _GridLimit()
        xs = _axis([value for value, _, _ in vertical])
        ys = _axis([value for value, _, _ in horizontal])
        # Short closed cells are examined for literal labels. Tall body cells
        # are never mistaken for headings based on the start of their prose.
        headers = []
        for top, bottom in zip(reversed(ys), reversed(ys[:-1])):
            for left, right in zip(xs, xs[1:]):
                if time.monotonic() > deadline:
                    raise _GridLimit()
                if top - bottom > 100 or not _closed(horizontal, vertical, left, bottom, right, top):
                    continue
                bounds = [left, bottom, right, top]
                text = _text(text_page, bounds)
                role = _header_role(text)
                if role:
                    headers.append((bounds, text, role))
        pairs = []
        for a in headers:
            for b in headers:
                if a[2] == b[2] or abs(a[0][2] - b[0][0]) > EDGE_TOLERANCE:
                    continue
                if abs(a[0][1] - b[0][1]) <= EDGE_TOLERANCE and abs(a[0][3] - b[0][3]) <= EDGE_TOLERANCE:
                    pairs.append((a, b))
        if not pairs:
            return PdfGridResult()
        if len(pairs) > MAX_GRID_TABLES:
            raise _GridLimit()
        glyphs = _glyphs(text_page, deadline)
        tables = []
        for a, b in sorted(pairs, key=lambda pair: (-pair[0][0][3], pair[0][0][0])):
            left, middle, right = a[0][0], a[0][2], b[0][2]
            top, boundary = a[0][3], a[0][1]
            rows = [[{"bounds": a[0], "text": a[1]}, {"bounds": b[0], "text": b[1]}]]
            # Every intersecting internal horizontal line is a boundary. A
            # partial/merged required cell rejects the table, rather than
            # jumping over that line to create a larger invented row.
            boundaries = [y for y in reversed(ys) if y < boundary - EDGE_TOLERANCE and any(
                abs(position - y) <= EDGE_TOLERANCE and end > left + EDGE_TOLERANCE and start < right - EDGE_TOLERANCE
                for position, start, end in horizontal)]
            for bottom in boundaries:
                if not _closed(horizontal, vertical, left, bottom, middle, boundary) or not _closed(horizontal, vertical, middle, bottom, right, boundary):
                    if any(_covers(vertical, x, bottom, boundary) for x in (left, middle, right)):
                        raise _UncertainGrid()
                    break
                cells = [{"bounds": [l, bottom, r, boundary], "text": ""}
                         for l, r in ((left, middle), (middle, right))]
                rows.append(cells)
                boundary = bottom
                if len(rows) > MAX_GRID_ROWS:
                    raise _GridLimit()
            if len(rows) < 2:
                continue
            bounds = [left, boundary, right, top]
            cell_layers = _reconstruct_cell_texts(glyphs, [cell for cells in rows for cell in cells], bounds,
                                                  horizontal_bands, vertical_bands, deadline)
            layers = ["ocr" if "ocr" in cell_layers[index:index + 2] else "text" for index in range(0, len(cell_layers), 2)]
            if _header_role(rows[0][0]["text"]) != a[2] or _header_role(rows[0][1]["text"]) != b[2]:
                raise _UncertainGrid()
            for cells in rows[1:]:
                if any(_header_role(cell["text"]) for cell in cells):
                    raise _UncertainGrid()
                sku = cells[0 if a[2] == "sku" else 1]["text"]
                name = cells[1 if a[2] == "sku" else 0]["text"]
                if not re.fullmatch(r"[\w./-]{2,128}", sku) or not name:
                    raise _UncertainGrid()
            if any(_intersects(bounds, prior[0]) for prior in tables):
                raise _UncertainGrid()
            tables.append((bounds, rows, layers))
        fragments = []
        characters = 0
        for grid_index, (_, rows, layers) in enumerate(tables, 1):
            for row_index, cells in enumerate(rows, 1):
                if time.monotonic() > deadline:
                    raise _GridLimit()
                text = "\t".join(cell["text"] for cell in cells)
                characters += len(text)
                if characters > MAX_GRID_OUTPUT_CHARS or len(fragments) >= MAX_GRID_ROWS:
                    raise _GridLimit()
                fragments.append({"id": f"page-{page_number}-grid-{grid_index}-row-{row_index}",
                                  "locator": f"Страница {page_number}, таблица {grid_index}, строка {row_index}",
                                  "page": page_number, "text": text,
                                  "pdfGrid": {"version": 1, "page": page_number,
                                              "textLayer": layers[row_index - 1],
                                              "bounds": [cells[0]["bounds"][0], cells[0]["bounds"][1], cells[-1]["bounds"][2], cells[0]["bounds"][3]],
                                              "cells": cells}})
        return PdfGridResult(fragments)
    except _GridLimit:
        return PdfGridResult(limited=True)
    except (_UncertainGrid, RuntimeError, ValueError, IndexError, TypeError, AttributeError, OverflowError):
        # An optional proof must never make ordinary source text unavailable.
        return PdfGridResult()
