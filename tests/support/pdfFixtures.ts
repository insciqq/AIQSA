import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Small PDFs built byte by byte for the viewer's hostile-input tests and its
 * browser spec, so no binary fixture lives in the repository. Every document
 * is synthetic.
 */

type PdfObject = string | Readonly<{ dictionary: string; stream: Uint8Array | string }>;

const latin1 = (value: string) => Buffer.from(value, "latin1");
const bytesOf = (value: Uint8Array | string) => typeof value === "string" ? latin1(value) : Buffer.from(value);

/** Numbers objects from 1 (object 1 is the catalog) and writes a valid cross-reference table. */
export function buildPdf(objects: readonly PdfObject[], trailerEntries = ""): Uint8Array {
  const parts: Buffer[] = [latin1("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n")];
  let offset = parts[0].length;
  const offsets: number[] = [];
  const push = (part: Buffer) => { parts.push(part); offset += part.length; };
  objects.forEach((object, index) => {
    offsets.push(offset);
    push(latin1(`${index + 1} 0 obj\n`));
    if (typeof object === "string") {
      push(latin1(object));
    } else {
      const stream = bytesOf(object.stream);
      push(latin1(`<< ${object.dictionary} /Length ${stream.length} >>\nstream\n`));
      push(stream);
      push(latin1("\nendstream"));
    }
    push(latin1("\nendobj\n"));
  });
  const table = offset;
  const rows = offsets.map(value => `${String(value).padStart(10, "0")} 00000 n \n`).join("");
  push(latin1(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${rows}`));
  push(latin1(`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${trailerEntries} >>\nstartxref\n${table}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}

const hex = (value: number, width = 4) => value.toString(16).toUpperCase().padStart(width, "0");

/** The glyph index of each code point, from the font's format 4 `cmap` subtable. */
function glyphLookup(font: Buffer): (codePoint: number) => number {
  const tableCount = font.readUInt16BE(4);
  let cmap = -1;
  for (let index = 0; index < tableCount; index += 1) {
    const record = 12 + index * 16;
    if (font.toString("latin1", record, record + 4) === "cmap") cmap = font.readUInt32BE(record + 8);
  }
  if (cmap < 0) throw new Error("fixture font has no cmap");
  const subtables = font.readUInt16BE(cmap + 2);
  let format4 = -1;
  for (let index = 0; index < subtables; index += 1) {
    const candidate = cmap + font.readUInt32BE(cmap + 4 + index * 8 + 4);
    if (font.readUInt16BE(candidate) === 4) format4 = candidate;
  }
  if (format4 < 0) throw new Error("fixture font has no format 4 cmap");
  const segments = font.readUInt16BE(format4 + 6) / 2;
  const ends = format4 + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const ranges = deltas + segments * 2;
  return (codePoint) => {
    for (let segment = 0; segment < segments; segment += 1) {
      if (codePoint > font.readUInt16BE(ends + segment * 2)) continue;
      const start = font.readUInt16BE(starts + segment * 2);
      if (codePoint < start) return 0;
      const delta = font.readUInt16BE(deltas + segment * 2);
      const rangeOffset = font.readUInt16BE(ranges + segment * 2);
      if (rangeOffset === 0) return (codePoint + delta) & 0xffff;
      const glyph = font.readUInt16BE(ranges + segment * 2 + rangeOffset + (codePoint - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
}

/**
 * Pages of text in an embedded TrueType font behind a Type0/Identity-H CID
 * font with a ToUnicode map, the shape office software writes for Cyrillic.
 * Each page is a list of lines.
 */
export function cidFontPdf(pages: readonly (readonly string[])[]): Uint8Array {
  const font = readFileSync(join(process.cwd(), "node_modules/pdfjs-dist/standard_fonts/LiberationSans-Regular.ttf"));
  const glyph = glyphLookup(font);
  const used = new Map<number, number>();
  const encode = (line: string) => [...line].map((character) => {
    const codePoint = character.codePointAt(0)!;
    const id = glyph(codePoint);
    used.set(id, codePoint);
    return hex(id);
  }).join("");
  const contents = pages.map((lines) => lines.map((line, index) =>
    `BT /F1 14 Tf 72 ${720 - index * 20} Td <${encode(line)}> Tj ET`).join("\n"));
  const entries = [...used].map(([id, codePoint]) => `<${hex(id)}> <${hex(codePoint)}>`);
  const chunks: string[] = [];
  for (let index = 0; index < entries.length; index += 100) {
    const chunk = entries.slice(index, index + 100);
    chunks.push(`${chunk.length} beginbfchar`, ...chunk, "endbfchar");
  }
  const toUnicode = [
    "/CIDInit /ProcSet findresource begin 12 dict begin begincmap",
    "/CMapName /Synthetic def /CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange",
    ...chunks,
    "endcmap end end"
  ].join("\n");
  const firstPage = 8;
  const pageObject = (index: number) => firstPage + index * 2;
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, index) => `${pageObject(index)} 0 R`).join(" ")}] >>`,
    "<< /Type /Font /Subtype /Type0 /BaseFont /LiberationSans /Encoding /Identity-H /DescendantFonts [5 0 R] /ToUnicode 4 0 R >>",
    { dictionary: "", stream: toUnicode },
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /LiberationSans /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /CIDToGIDMap /Identity /DW 600 /FontDescriptor 6 0 R >>",
    "<< /Type /FontDescriptor /FontName /LiberationSans /Flags 4 /FontBBox [-200 -300 1200 1000] /ItalicAngle 0 /Ascent 900 /Descent -200 /CapHeight 700 /StemV 80 /FontFile2 7 0 R >>",
    { dictionary: `/Length1 ${font.length}`, stream: font },
    ...pages.flatMap((_, index): PdfObject[] => [
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${pageObject(index) + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> >>`,
      { dictionary: "", stream: contents[index] }
    ])
  ]);
}

/** A non-embedded CID font through a predefined CMap: rendering and text need the served `cmaps/` files. */
export function predefinedCmapPdf(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    { dictionary: "", stream: "BT /F1 24 Tf 40 100 Td <65E5672C8A9E> Tj ET" },
    "<< /Type /Font /Subtype /Type0 /BaseFont /KozMinPr6N-Regular /Encoding /UniJIS-UTF16-H /DescendantFonts [6 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /KozMinPr6N-Regular /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> >>"
  ]);
}

/**
 * Document JavaScript on open and on a page event, a `javascript:` link, a
 * data link, an external link and an internal link to page 2.
 */
export function activeContentPdf(): Uint8Array {
  const payload = "(globalThis.__aiqsaPdfPwned = true; app.alert('pwned');)";
  return buildPdf([
    `<< /Type /Catalog /Pages 2 0 R /OpenAction << /S /JavaScript /JS ${payload} >> /Names << /JavaScript << /Names [(run) << /S /JavaScript /JS ${payload} >>] >> >> >>`,
    "<< /Type /Pages /Count 2 /Kids [3 0 R 4 0 R] >>",
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /AA << /O << /S /JavaScript /JS ${payload} >> >> /Annots [6 0 R 7 0 R 8 0 R 9 0 R] /Contents 5 0 R >>`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    { dictionary: "", stream: "0.9 g 72 600 200 40 re f 72 500 200 40 re f 72 400 200 40 re f 72 300 200 40 re f" },
    "<< /Type /Annot /Subtype /Link /Rect [72 600 272 640] /Border [0 0 0] /A << /S /URI /URI (javascript:globalThis.__aiqsaPdfPwned=true) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [72 500 272 540] /Border [0 0 0] /A << /S /URI /URI (https://example.test/from-pdf?x=1) >> >>",
    "<< /Type /Annot /Subtype /Link /Rect [72 400 272 440] /Border [0 0 0] /Dest [4 0 R /Fit] >>",
    "<< /Type /Annot /Subtype /Link /Rect [72 300 272 340] /Border [0 0 0] /A << /S /JavaScript /JS (globalThis.__aiqsaPdfPwned=true) >> >>"
  ]);
}

/**
 * A Type1 font whose /FontMatrix carries the CVE-2024-4367 string payload that
 * older pdf.js compiled into a glyph function, with a garbage font program.
 */
export function maliciousFontPdf(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    { dictionary: "", stream: "BT /F1 24 Tf 20 100 Td (hostile font) Tj ET" },
    "<< /Type /Font /Subtype /Type1 /BaseFont /Hostile /FirstChar 32 /LastChar 33 /Widths [500 500] /FontDescriptor 6 0 R /FontMatrix [0.001 0 0 0.001 0 (0\\); globalThis.__aiqsaPdfPwned = true; //)] >>",
    "<< /Type /FontDescriptor /FontName /Hostile /Flags 4 /FontBBox [0 0 1000 1000] /ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 /FontFile 7 0 R >>",
    { dictionary: "/Length1 40 /Length2 40 /Length3 0", stream: `%!PS-AdobeFont-1.0: Hostile\n/FontMatrix [0.001 0 0 0.001 0 (0\\); globalThis.__aiqsaPdfPwned = true; //)] def\n${"\xFF\x00\x80".repeat(40)}` }
  ]);
}

/**
 * Everything in a PDF that could name a request: a Text annotation icon, a file
 * attachment icon, rich text with an image, link and CSS URL, a font's name and a
 * CMap's name. All point at `/api/pdf-beacon`, which nothing should ever request.
 */
export function pdfBeaconPdf(): Uint8Array {
  const up = "..#2F..#2F..#2F..#2F";
  const rich = "<?xml version=\"1.0\"?><body xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:xfa=\"http://www.xfa.org/schema/xfa-data/1.0/\"><p style=\"background:url(/api/pdf-beacon?css)\"><a href=\"/api/pdf-beacon?a\">a</a><img src=\"/api/pdf-beacon?img\"/></p></body>";
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Contents 4 0 R /Annots [5 0 R 6 0 R 7 0 R 8 0 R] /Resources << /Font << /F1 9 0 R /F2 10 0 R >> >> >>",
    { dictionary: "", stream: "BT /F1 18 Tf 20 300 Td (font) Tj ET BT /F2 18 Tf 20 260 Td <0041> Tj ET" },
    `<< /Type /Annot /Subtype /Text /Rect [20 340 42 362] /Name /x#2F${up}api#2Fpdf-beacon#3Fpdf-content=private-marker#26x= /Contents (note) /RC (${rich}) >>`,
    `<< /Type /Annot /Subtype /FileAttachment /Rect [60 340 82 362] /Name /x#2F${up}api#2Fpdf-beacon#3Fattachment /FS << /Type /Filespec /F (a.txt) >> >>`,
    `<< /Type /Annot /Subtype /FreeText /Rect [100 340 200 362] /DA (0 g /Helv 10 Tf) /Contents (rich) /RC (${rich}) >>`,
    "<< /Type /Annot /Subtype /Link /Rect [220 340 300 362] /Border [0 0 0] /A << /S /URI /URI (/api/pdf-beacon?link) >> >>",
    "<< /Type /Font /Subtype /TrueType /BaseFont /x#29#2Curl#28#2Fapi#2Fpdf-beacon#3Ffont#29 /FirstChar 32 /LastChar 33 /Widths [500 500] >>",
    "<< /Type /Font /Subtype /Type0 /BaseFont /Beacon /Encoding /x#2F..#2F..#2Fapi#2Fpdf-beacon#3Fcmap /DescendantFonts [11 0 R] >>",
    "<< /Type /Font /Subtype /CIDFontType0 /BaseFont /Beacon /CIDSystemInfo << /Registry (Adobe) /Ordering (Japan1) /Supplement 6 >> >>"
  ]);
}

/** The largest page the format describes, enlarged further by /UserUnit. */
export function oversizedPagePdf(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 14400 14400] /UserUnit 75 /Contents 4 0 R >>",
    { dictionary: "", stream: "0.5 g 0 0 14400 14400 re f" }
  ]);
}

/** More real pages than the viewer lays out; pdf.js checks a claimed /Count against the tree, so they all exist. */
export function manyPagesPdf(count: number): Uint8Array {
  const kids = Array.from({ length: count }, (_, index) => `${index + 3} 0 R`).join(" ");
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Count ${count} /Kids [${kids}] >>`,
    ...Array.from({ length: count }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>")
  ]);
}

/** Encrypted with the standard handler and a user password nobody knows: the empty password does not open it. */
export function passwordPdf(): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>",
    `<< /Filter /Standard /V 1 /R 2 /O <${"AB".repeat(32)}> /U <${"CD".repeat(32)}> /P -44 >>`
  ], `/Encrypt 4 0 R /ID [<${"01".repeat(16)}> <${"01".repeat(16)}>]`);
}

/** Not a PDF past its header. */
export function damagedPdf(): Uint8Array {
  return new Uint8Array(latin1(`%PDF-1.7\n${"\x00\xFFgarbage ".repeat(64)}`));
}

function imagePdf(filter: string, data: Uint8Array, entries: string): Uint8Array {
  return buildPdf([
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Count 1 /Kids [3 0 R] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R /Resources << /XObject << /Im0 5 0 R >> >> >>",
    { dictionary: "", stream: "q 200 0 0 200 0 0 cm /Im0 Do Q" },
    { dictionary: `/Type /XObject /Subtype /Image /Width 8 /Height 8 /Filter /${filter} ${entries}`, stream: data }
  ]);
}

const be32 = (value: number) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32BE(value);
  return bytes;
};
const be16 = (value: number) => {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
};

/** An 8x8 JPEG2000 codestream with one empty packet: every sample decodes to mid grey. */
export function jpxPdf(): Uint8Array {
  const codestream = Buffer.concat([
    Buffer.from([0xff, 0x4f]),
    Buffer.from([0xff, 0x51]), be16(41), be16(0), be32(8), be32(8), be32(0), be32(0), be32(8), be32(8), be32(0), be32(0),
    be16(1), Buffer.from([7, 1, 1]),
    Buffer.from([0xff, 0x52]), be16(12), Buffer.from([0, 0]), be16(1), Buffer.from([0, 0, 2, 2, 0, 1]),
    Buffer.from([0xff, 0x5c]), be16(4), Buffer.from([0x40, 0x40]),
    Buffer.from([0xff, 0x90]), be16(10), be16(0), be32(15), Buffer.from([0, 1]),
    Buffer.from([0xff, 0x93, 0x00]),
    Buffer.from([0xff, 0xd9])
  ]);
  return imagePdf("JPXDecode", codestream, "");
}

/** An 8x8 embedded JBIG2 stream: a page whose default pixel is black, with an all-white-coded MMR region OR-ed on it. */
export function jbig2Pdf(): Uint8Array {
  const segmentHeader = (number: number, type: number, length: number) => Buffer.concat([
    be32(number), Buffer.from([type, 0x00, 0x01]), be32(length)
  ]);
  const pageInfo = Buffer.concat([be32(8), be32(8), be32(0), be32(0), Buffer.from([0x04]), be16(0)]);
  const region = Buffer.concat([be32(8), be32(8), be32(0), be32(0), Buffer.from([0x00]), Buffer.from([0x01]), Buffer.from([0xff])]);
  const stream = Buffer.concat([segmentHeader(0, 48, pageInfo.length), pageInfo, segmentHeader(1, 38, region.length), region]);
  return imagePdf("JBIG2Decode", stream, "/ColorSpace /DeviceGray /BitsPerComponent 1");
}
