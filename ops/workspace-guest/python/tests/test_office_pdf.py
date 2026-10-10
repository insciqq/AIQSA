"""aiqsa-office-pdf sanitization without LibreOffice: JPEG metadata, tracked changes and PDF rewriting.

Run: python3 -m unittest discover -s ops/workspace-guest/python/tests
The PDF rewrite test needs pypdf, as installed in the Workspace guest image; the other tests use the standard
library only.
"""

from __future__ import annotations

import importlib.machinery
import importlib.util
import io
import sys
import types
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree

SCRIPT = Path(__file__).resolve().parents[2] / "bin" / "aiqsa-office-pdf"
PYPDF = importlib.util.find_spec("pypdf") is not None


def load_script() -> types.ModuleType:
    """Imports the script as a module. Without pypdf, placeholders stand in for its names at import time only."""
    stubs: dict = {}
    if not PYPDF:
        root, errors, generic = (types.ModuleType(name) for name in ("pypdf", "pypdf.errors", "pypdf.generic"))
        root.PdfReader = root.PdfWriter = None
        errors.PyPdfError = type("PyPdfError", (Exception,), {})
        for name in ("ArrayObject", "DictionaryObject", "IndirectObject", "NameObject", "NumberObject", "StreamObject"):
            setattr(generic, name, type(name, (), {}))
        stubs = {"pypdf": root, "pypdf.errors": errors, "pypdf.generic": generic}
    saved = {name: sys.modules.get(name) for name in stubs}
    sys.modules.update(stubs)
    try:
        loader = importlib.machinery.SourceFileLoader("aiqsa_office_pdf", str(SCRIPT))
        spec = importlib.util.spec_from_loader(loader.name, loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        return module
    finally:
        for name, previous in saved.items():
            if previous is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = previous


office = load_script()


def segment(marker: int, payload: bytes) -> bytes:
    return bytes((0xFF, marker)) + (len(payload) + 2).to_bytes(2, "big") + payload


SOI, EOI = b"\xff\xd8", b"\xff\xd9"
JFIF = segment(0xE0, b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x02\x01" + b"THUMB!")
EXIF = segment(0xE1, b"Exif\x00\x00MM\x00*GPS-55.7558N-CAMERA-SECRET")
XMP = segment(0xE1, b"http://ns.adobe.com/xap/1.0/\x00<x:xmpmeta>AUTHOR-SECRET</x:xmpmeta>")
ICC = segment(0xE2, b"ICC_PROFILE\x00\x01\x01DEVICE-SECRET")
MPF = segment(0xE2, b"MPF\x00II*\x00")
IPTC = segment(0xED, b"Photoshop 3.0\x00IPTC-SECRET")
ADOBE = segment(0xEE, b"Adobe\x00\x64\x00\x00\x00\x00\x01")
COMMENT = segment(0xFE, b"COMMENT-SECRET")
DQT = segment(0xDB, b"\x00" + bytes(range(64)))
SOF = segment(0xC0, b"\x08\x00\x10\x00\x10\x03\x01\x11\x00\x02\x11\x01\x03\x11\x01")
DHT = segment(0xC4, b"\x00" + b"\x01" + b"\x00" * 15 + b"\x00")
SOS = segment(0xDA, b"\x03\x01\x00\x02\x11\x03\x11\x00\x3f\x00")
# Entropy-coded data: a stuffed 0xFF00 and a restart marker belong to the scan.
SCAN = b"\x12\x34\xff\x00\x56\xff\xd0\x78\x9a"
SECRETS = (b"Exif", b"CAMERA-SECRET", b"AUTHOR-SECRET", b"DEVICE-SECRET", b"IPTC-SECRET", b"COMMENT-SECRET",
           b"THUMB!", b"MPF", b"APPENDED-SECRET")


class JpegMetadataTests(unittest.TestCase):
    def test_keeps_only_decoding_segments_scans_and_the_end(self) -> None:
        appended = SOI + EXIF + b"APPENDED-SECRET" + EOI
        image = (SOI + JFIF + EXIF + XMP + ICC + MPF + IPTC + ADOBE + COMMENT + DQT + SOF + DHT + SOS + SCAN +
                 COMMENT + DHT + SOS + SCAN + b"\xff\xff" + EOI + appended)
        cleaned = office.jpeg_without_metadata(image)
        # Fill bytes before a marker are valid JPEG and carry nothing.
        self.assertEqual(cleaned, SOI + ADOBE + DQT + SOF + DHT + SOS + SCAN + DHT + SOS + SCAN + b"\xff\xff" + EOI)
        for secret in SECRETS:
            self.assertNotIn(secret, cleaned)
        self.assertEqual(office.jpeg_without_metadata(cleaned), cleaned)

    def test_a_truncated_scan_keeps_its_data_and_gains_an_end(self) -> None:
        self.assertEqual(office.jpeg_without_metadata(SOI + EXIF + DQT + SOF + DHT + SOS + SCAN),
                         SOI + DQT + SOF + DHT + SOS + SCAN + EOI)

    def test_rejects_damaged_structures(self) -> None:
        for damaged in (b"", b"GIF89a", SOI, SOI + b"\x00\x01", SOI + b"\xff\xe1\x00\x40Exif", SOI + b"\xff\xe1\x00\x01" + EOI):
            with self.subTest(damaged=damaged[:12]), self.assertRaises(ValueError):
                office.jpeg_without_metadata(damaged)


TEXT_NS = "urn:oasis:names:tc:opendocument:xmlns:text:1.0"
CONTENT = f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="{TEXT_NS}"
 xmlns:t2="{TEXT_NS}" xmlns:dc="http://purl.org/dc/elements/1.1/" office:version="1.3"><office:body><office:text>
<text:tracked-changes text:track-changes="false">
<text:changed-region text:id="ct1"><text:deletion><office:change-info><dc:creator>REVIEWER-SECRET</dc:creator></office:change-info><text:p>DELETED-SECRET</text:p><text:p/></text:deletion></text:changed-region>
<text:changed-region text:id="ct2"><text:insertion><office:change-info><dc:creator>REVIEWER-SECRET</dc:creator></office:change-info></text:insertion></text:changed-region>
</text:tracked-changes>
<text:p>Kept &amp; &lt;escaped&gt; <text:change-start text:change-id="ct2"/>INSERTED<text:change-end text:change-id="ct2"/> <text:change text:change-id="ct1"/>after<text:s text:c="2"/>end</text:p>
<text:p><office:annotation office:name="a1"><dc:creator>COMMENTER-SECRET</dc:creator><text:p>COMMENT-SECRET</text:p></office:annotation>Commented<office:annotation-end office:name="a1"/> tail</text:p>
<t2:p>Other prefix <t2:change t2:change-id="ct1"/>works</t2:p>
</office:text></office:body></office:document-content>"""
STYLES = f"""<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="{TEXT_NS}"
 xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0"><office:master-styles><style:master-page style:name="Standard">
<style:header><text:p>Header <text:change text:change-id="ct3"/>text</text:p></style:header></style:master-page></office:master-styles></office:document-styles>"""
PICTURE = b"\xff\xd8binary picture bytes\xff\xd9"


def odt_package() -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(zipfile.ZipInfo("mimetype"), b"application/vnd.oasis.opendocument.text")
        archive.writestr(zipfile.ZipInfo("Configurations2/"), b"")
        for name, data in (("content.xml", CONTENT.encode()), ("styles.xml", STYLES.encode()),
                           ("Pictures/1.jpg", PICTURE), ("META-INF/manifest.xml", b"<manifest/>")):
            info = zipfile.ZipInfo(name)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, data)
    return buffer.getvalue()


class AcceptChangesTests(unittest.TestCase):
    def test_drops_deleted_text_change_markers_and_comments_and_keeps_the_rest(self) -> None:
        import tempfile
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "input.odt", Path(directory) / "accepted.odt"
            source.write_bytes(odt_package())
            self.assertEqual(office.accept_changes(source, target), target)
            with zipfile.ZipFile(source) as original, zipfile.ZipFile(target) as accepted:
                self.assertEqual(accepted.namelist(), original.namelist())
                self.assertEqual(accepted.infolist()[0].compress_type, zipfile.ZIP_STORED)
                for name in ("mimetype", "Pictures/1.jpg", "META-INF/manifest.xml"):
                    self.assertEqual(accepted.read(name), original.read(name))
                content = accepted.read("content.xml").decode()
                styles = accepted.read("styles.xml").decode()
        for secret in ("DELETED-SECRET", "REVIEWER-SECRET", "COMMENT-SECRET", "COMMENTER-SECRET", "tracked-changes",
                       "change-start", "change-end", "change-id", "annotation"):
            self.assertNotIn(secret, content)
        self.assertIn('<text:p>Kept &amp; &lt;escaped&gt; INSERTED after<text:s text:c="2"/>end</text:p>', content)
        self.assertIn("<text:p>Commented tail</text:p>", content)
        self.assertIn("<t2:p>Other prefix works</t2:p>", content)
        self.assertIn(f'xmlns:t2="{TEXT_NS}"', content)
        self.assertIn("<text:p>Header text</text:p>", styles)
        for part in (content, styles):
            ElementTree.fromstring(part.encode())


@unittest.skipUnless(PYPDF, "needs pypdf, which the Workspace guest image installs")
class RewriteTests(unittest.TestCase):
    def test_copies_pages_without_metadata_and_strips_every_reachable_jpeg(self) -> None:
        import tempfile
        from pypdf import PdfReader, PdfWriter
        from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, NameObject, NumberObject, StreamObject

        jpeg = SOI + JFIF + EXIF + XMP + ADOBE + COMMENT + DQT + SOF + DHT + SOS + SCAN + EOI
        writer = PdfWriter()
        page = writer.add_blank_page(200, 200)

        def stream(data: bytes, entries: dict) -> object:
            value = DecodedStreamObject() if "/Filter" not in entries else StreamObject()
            value.update({NameObject(key): item for key, item in entries.items()})
            StreamObject.set_data(value, data)
            return writer._add_object(value)

        xmp = stream(b"<x:xmpmeta>XMP-SECRET</x:xmpmeta>", {"/Type": NameObject("/Metadata"), "/Subtype": NameObject("/XML")})
        image = stream(jpeg, {"/Type": NameObject("/XObject"), "/Subtype": NameObject("/Image"), "/Width": NumberObject(16),
                              "/Height": NumberObject(16), "/ColorSpace": NameObject("/DeviceRGB"),
                              "/BitsPerComponent": NumberObject(8), "/Filter": NameObject("/DCTDecode"), "/Metadata": xmp})
        form = stream(b"q 16 0 0 16 0 0 cm /Inner Do Q", {
            "/Type": NameObject("/XObject"), "/Subtype": NameObject("/Form"), "/BBox": ArrayObject([NumberObject(0)] * 2 + [NumberObject(16)] * 2),
            "/Resources": DictionaryObject({NameObject("/XObject"): DictionaryObject({NameObject("/Inner"): image})}),
            "/PieceInfo": DictionaryObject({NameObject("/Editor"): DictionaryObject()})})
        page[NameObject("/Resources")] = DictionaryObject({NameObject("/XObject"): DictionaryObject({
            NameObject("/Im0"): image, NameObject("/Fm0"): form})})
        page[NameObject("/Contents")] = stream(b"q 16 0 0 16 10 10 cm /Im0 Do Q /Fm0 Do", {})
        page[NameObject("/Metadata")] = xmp
        writer.add_blank_page(200, 200)[NameObject("/Resources")] = page["/Resources"]
        writer.add_metadata({"/Author": "INFO-SECRET"})
        with tempfile.TemporaryDirectory() as directory:
            source, target = Path(directory) / "input.pdf", Path(directory) / "clean.pdf"
            with open(source, "wb") as handle:
                writer.write(handle)
            self.assertEqual(office.rewrite(source, target), 2)
            data = target.read_bytes()
            for secret in (b"Exif", b"CAMERA-SECRET", b"AUTHOR-SECRET", b"COMMENT-SECRET", b"XMP-SECRET", b"INFO-SECRET",
                           b"THUMB!", b"/PieceInfo", b"/Metadata"):
                self.assertNotIn(secret, data)
            reader = PdfReader(target)
            self.assertEqual(dict(reader.metadata), {"/Producer": "aiqsa-office-pdf"})
            images = [page["/Resources"]["/XObject"]["/Im0"].get_object() for page in reader.pages]
            images.append(reader.pages[0]["/Resources"]["/XObject"]["/Fm0"]["/Resources"]["/XObject"]["/Inner"].get_object())
            for image in images:
                self.assertEqual(StreamObject.get_data(image), SOI + ADOBE + DQT + SOF + DHT + SOS + SCAN + EOI)


if __name__ == "__main__":
    unittest.main()
