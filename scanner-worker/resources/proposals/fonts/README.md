# Private proposal font family

SBK Proposal Sans is a name-only derivative of the four Noto Sans fonts in
the project's checksum-pinned LibreOffice 26.2.5 macOS ARM64 distribution.
The original copyright and SIL Open Font License 1.1 remain in each font.
The derivative has its own family and PostScript names; it does not reuse
the upstream reserved family name. No outline, cmap, spacing, kerning,
shaping or metric table is changed. Full SFNT checksums are regenerated.

`SOURCE.json` records the official package URL/SHA, upstream font SHAs,
derived font SHAs, and the reproducible build-only tool version. Only the
four derived font files are bundled. Upstream binaries are not duplicated
in application resources. The older scanner/OCR fonts are untouched.

To reproduce in a separate development environment:

1. Obtain the exact source package in `SOURCE.json`, verify its SHA-256,
   and extract its four listed fonts to a private source directory.
2. Install `fonttools==4.60.1` in that development environment.
3. Run `scripts/derive_proposal_fonts.py --source SOURCE_DIRECTORY
   --output OUTPUT_DIRECTORY --pins
   scanner-worker/resources/proposals/fonts/SOURCE.json` from the repo root.
4. Compare every output SHA-256 with `SOURCE.json`. The script also rejects
   any change to non-name tables, metrics or timestamps and checks the
   complete SFNT checksum.

FontTools is not imported by the worker, included in runtime dependencies,
or used during export. The renderer verifies the four derived font hashes,
checks document glyph coverage, and embeds the complete fonts using the
WordprocessingML font part format. Office loads the document-owned private
family in its isolated conversion process; no font installation or global
font-cache mutation is performed. Unsupported characters fail explicitly
without replacing or truncating the source Unicode.

The real-office regression requires the resulting PDF to embed the private
`SBKProposalSans` family and checks U+2011 / U+20BD glyph geometry against
the pinned font programs, in addition to exact text and a rendered preview.
This distinguishes a correct glyph from a square with a correct ToUnicode
mapping. Windows acceptance still requires the same real-office regression
on the packaged Windows runtime; a Mac result is not a Windows native PASS.

Word font-part format reference:
https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oi29500/ea097c57-5794-4624-b08e-017b47051b1d
