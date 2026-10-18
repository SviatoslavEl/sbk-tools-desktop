"""Proposal metadata cleanup must preserve actual PDF page destinations.

Office is mocked: only the existing final PDF rewrite is under test. All
synthetic PDFs are isolated pytest files, never the frozen QA/native exports.
"""
from __future__ import annotations

import ctypes
from io import BytesIO

import pypdf
import pytest
from pypdf import PdfReader, PdfWriter
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject

from scandocument.proposals import render
from test_proposals import document_fixture


def _source_pdf():
    writer = PdfWriter()
    for _ in range(3):
        writer.add_blank_page(width=100, height=100)
    # Include direct/indirect arrays, /GoTo actions, repeated future targets,
    # self and backward links. Existing-object resolution is not sufficient.
    cases = [(0, 2, "direct"), (0, 2, "indirect"), (0, 2, "action"), (1, 1, "direct"), (2, 0, "action"), (2, 1, "indirect")]
    for source_page, target_page, kind in cases:
        destination = ArrayObject([writer.pages[target_page].indirect_reference, NameObject("/Fit")])
        if kind == "indirect":
            destination = writer._add_object(destination)
        annotation = DictionaryObject({
            NameObject("/Type"): NameObject("/Annot"), NameObject("/Subtype"): NameObject("/Link"),
            NameObject("/Rect"): ArrayObject([NumberObject(value) for value in (0, 0, 20, 20)]),
        })
        if kind == "action":
            annotation[NameObject("/A")] = DictionaryObject({NameObject("/S"): NameObject("/GoTo"), NameObject("/D"): destination})
        else:
            annotation[NameObject("/Dest")] = destination
        page = writer.pages[source_page]
        if "/Annots" not in page:
            page[NameObject("/Annots")] = ArrayObject()
        page["/Annots"].append(writer._add_object(annotation))
    sentinels = {key: f"PRIVATEMETADATA{key[1:].upper()}SENTINEL" for key in
                 ["/Author", "/Title", "/Subject", "/Creator", "/Producer", "/Keywords", "/CreationDate", "/ModDate"]}
    writer.add_metadata(sentinels)
    metadata = DecodedStreamObject()
    metadata.set_data(b"<x:xmpmeta>PRIVATEXMPSENTINEL</x:xmpmeta>")
    metadata.update({NameObject("/Type"): NameObject("/Metadata"), NameObject("/Subtype"): NameObject("/XML")})
    writer.root_object[NameObject("/Metadata")] = writer._add_object(metadata)
    buffer = BytesIO()
    writer.write(buffer)
    return buffer.getvalue(), cases, sentinels


def _destinations(reader):
    page_tree = {(page.indirect_reference.idnum, page.indirect_reference.generation): index for index, page in enumerate(reader.pages)}
    destinations = []
    for source_page, page in enumerate(reader.pages):
        for reference in page.get("/Annots", []):
            annotation = reference.get_object()
            if annotation.get("/Subtype") != "/Link":
                continue
            destination = annotation.get("/Dest")
            if destination is None:
                assert annotation["/A"]["/S"] == "/GoTo"
                destination = annotation["/A"]["/D"]
            destination = destination.get_object()
            target = destination[0]
            key = (target.idnum, target.generation)
            # An orphan target can still resolve as /Type /Page. It must be
            # the exact object reachable through this document's page tree.
            assert target.get_object()["/Type"] == "/Page"
            assert key in page_tree
            assert target.get_object().get("/Parent") is not None
            destinations.append((source_page, page_tree[key]))
    return destinations


@pytest.fixture
def cleaned_pdf(tmp_path, monkeypatch):
    raw, cases, sentinels = _source_pdf()
    original = PdfReader(BytesIO(raw))
    assert _destinations(original) == [(source, target) for source, target, _ in cases]
    monkeypatch.setattr("scandocument.proposals.render_docx", lambda _document, output, _assets: output.write_bytes(b"synthetic-office-input"))
    monkeypatch.setattr("scandocument.proposals.find_soffice", lambda: "/unused/mock-office")

    def office(_source, output, _office, _profile, _cancelled):
        output.write_bytes(raw)

    monkeypatch.setattr("scandocument.office_engine.convert_with_office", office)
    document = document_fixture()
    reply = render({"document": document, "workdir": str(tmp_path), "format": "pdf", "assets": []})
    output = tmp_path / "proposal.pdf"
    assert reply["outputPath"] == str(output) and reply["pageCount"] == 3
    assert reply["outputBytes"] == output.stat().st_size
    return output, document, cases, sentinels, raw


def test_cleanup_keeps_forward_backward_self_repeated_and_indirect_destinations_in_page_tree(cleaned_pdf):
    output, _document, cases, _sentinels, _raw = cleaned_pdf
    reader = PdfReader(output)
    assert len(reader.pages) == 3
    assert _destinations(reader) == [(source, target) for source, target, _ in cases]


@pytest.mark.skipif(pypdf.__version__ != "5.6.0", reason="Negative baseline is specific to the deployed worker's pinned pypdf 5.6.0")
def test_the_previous_page_by_page_copy_is_detected_even_when_orphan_page_objects_resolve():
    raw, _cases, _sentinels = _source_pdf()
    reader, writer = PdfReader(BytesIO(raw)), PdfWriter()
    for page in reader.pages:
        writer.add_page(page)
    copied = BytesIO()
    writer.write(copied)
    with pytest.raises(AssertionError):
        _destinations(PdfReader(BytesIO(copied.getvalue())))


def test_cleanup_does_not_copy_office_info_or_xmp_and_keeps_the_existing_metadata_allowlist(cleaned_pdf):
    output, document, _cases, sentinels, raw = cleaned_pdf
    reader = PdfReader(output)
    assert dict(reader.metadata) == {"/Producer": "pypdf", "/Title": document["title"],
                                     "/Subject": "Коммерческое предложение", "/Creator": "СБК Инструменты"}
    assert "/Metadata" not in reader.root_object
    output_bytes = output.read_bytes()
    for sentinel in [*sentinels.values(), "PRIVATEXMPSENTINEL"]:
        assert sentinel.encode("ascii") in raw
        assert sentinel.encode("ascii") not in output_bytes
    assert "/Author" not in reader.metadata and "/Keywords" not in reader.metadata


def test_pdfium_resolves_every_cleaned_destination_to_its_actual_page(cleaned_pdf):
    pdfium = pytest.importorskip("pypdfium2")
    output, _document, cases, _sentinels, _raw = cleaned_pdf
    destinations = []
    with pdfium.PdfDocument(output) as document:
        for page_index in range(len(document)):
            page = document[page_index]
            try:
                position = ctypes.c_int(0)
                link = pdfium.raw.FPDF_LINK()
                while pdfium.raw.FPDFLink_Enumerate(page.raw, ctypes.byref(position), ctypes.byref(link)):
                    destination = pdfium.raw.FPDFLink_GetDest(document.raw, link)
                    if not destination:
                        action = pdfium.raw.FPDFLink_GetAction(link)
                        destination = pdfium.raw.FPDFAction_GetDest(document.raw, action)
                    assert destination
                    target = pdfium.raw.FPDFDest_GetDestPageIndex(document.raw, destination)
                    assert target >= 0
                    destinations.append((page_index, target))
            finally:
                page.close()
    assert destinations == [(source, target) for source, target, _ in cases]
