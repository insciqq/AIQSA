import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { crc32 } from "../../../lib/domain/crc32";
import { writeZip } from "../../../lib/server/artifacts/zip";

/**
 * Synthetic files for the file-to-artifact specs: each generator returns the
 * upload bytes and the oracle the spec checks. Everything except the recorded
 * videos is byte-for-byte deterministic (fixed dates, no randomness) and holds
 * only obviously synthetic values.
 */

export type FileFixture<Expected> = Readonly<{
  fileName: string;
  mimeType: string;
  bytes: Buffer;
  expected: Expected;
}>;

const MIB = 1024 * 1024;
const FIXED_DATE = "2026-01-01T00:00:00Z";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[char]!);
}

function utf8(text: string): Buffer {
  return Buffer.from(text, "utf8");
}

function zipOf(files: Readonly<Record<string, string | Buffer>>): Buffer {
  return writeZip(Object.entries(files).map(([path, content]) => ({
    path,
    bytes: typeof content === "string" ? utf8(content) : content
  })));
}

// ---------------------------------------------------------------- OOXML ---

const NS = {
  contentTypes: "http://schemas.openxmlformats.org/package/2006/content-types",
  packageRels: "http://schemas.openxmlformats.org/package/2006/relationships",
  rel: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  sml: "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  wml: "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  pml: "http://schemas.openxmlformats.org/presentationml/2006/main",
  dml: "http://schemas.openxmlformats.org/drawingml/2006/main"
} as const;
const REL_TYPE = {
  officeDocument: `${NS.rel}/officeDocument`,
  core: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  app: `${NS.rel}/extended-properties`,
  worksheet: `${NS.rel}/worksheet`,
  styles: `${NS.rel}/styles`,
  sharedStrings: `${NS.rel}/sharedStrings`,
  comments: `${NS.rel}/comments`,
  vmlDrawing: `${NS.rel}/vmlDrawing`,
  slideMaster: `${NS.rel}/slideMaster`,
  slideLayout: `${NS.rel}/slideLayout`,
  slide: `${NS.rel}/slide`,
  theme: `${NS.rel}/theme`,
  presProps: `${NS.rel}/presProps`,
  viewProps: `${NS.rel}/viewProps`,
  tableStyles: `${NS.rel}/tableStyles`
} as const;
const CT = "application/vnd.openxmlformats-officedocument";

function contentTypes(overrides: Readonly<Record<string, string>>, defaults: Readonly<Record<string, string>> = {}): string {
  const allDefaults = { rels: "application/vnd.openxmlformats-package.relationships+xml", xml: "application/xml", ...defaults };
  return `${XML_HEAD}<Types xmlns="${NS.contentTypes}">` +
    Object.entries(allDefaults).map(([extension, type]) => `<Default Extension="${extension}" ContentType="${type}"/>`).join("") +
    Object.entries({
      "/docProps/core.xml": "application/vnd.openxmlformats-package.core-properties+xml",
      "/docProps/app.xml": `${CT}.extended-properties+xml`,
      ...overrides
    }).map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("") +
    "</Types>";
}

function relationships(targets: readonly (readonly [type: string, target: string])[]): string {
  return `${XML_HEAD}<Relationships xmlns="${NS.packageRels}">` +
    targets.map(([type, target], index) => `<Relationship Id="rId${index + 1}" Type="${type}" Target="${target}"/>`).join("") +
    "</Relationships>";
}

function packageParts(mainPart: string, core: Readonly<{ title: string; description: string }>): Record<string, string> {
  return {
    "_rels/.rels": relationships([
      [REL_TYPE.officeDocument, mainPart],
      [REL_TYPE.core, "docProps/core.xml"],
      [REL_TYPE.app, "docProps/app.xml"]
    ]),
    "docProps/core.xml": `${XML_HEAD}<cp:coreProperties ` +
      'xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:title>${escapeXml(core.title)}</dc:title>` +
      "<dc:creator>Synthetic Fixture Author</dc:creator>" +
      `<dc:description>${escapeXml(core.description)}</dc:description>` +
      "<cp:lastModifiedBy>Synthetic Fixture Author</cp:lastModifiedBy>" +
      `<dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_DATE}</dcterms:created>` +
      `<dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_DATE}</dcterms:modified>` +
      "</cp:coreProperties>",
    "docProps/app.xml": `${XML_HEAD}<Properties xmlns="${CT}.extended-properties" ` +
      `xmlns:vt="${CT}.docPropsVTypes"><Application>AIQSA synthetic fixture</Application></Properties>`
  };
}

// ----------------------------------------------------------------- XLSX ---

export type SalesRow = Readonly<{ region: string; month: string; units: number; revenue: number }>;

const SALES_ROWS: readonly SalesRow[] = [
  { region: "North", month: "Jan", units: 120, revenue: 15400.5 },
  { region: "North", month: "Feb", units: 135, revenue: 17325.25 },
  { region: "North", month: "Mar", units: 128, revenue: 16384 },
  { region: "South", month: "Jan", units: 90, revenue: 11250 },
  { region: "South", month: "Feb", units: 104, revenue: 13000.75 },
  { region: "South", month: "Mar", units: 97, revenue: 12125 },
  { region: "East", month: "Jan", units: 150, revenue: 19500 },
  { region: "East", month: "Feb", units: 142, revenue: 18460.4 },
  { region: "East", month: "Mar", units: 160, revenue: 20800 },
  { region: "West", month: "Jan", units: 75, revenue: 9375 },
  { region: "West", month: "Feb", units: 82, revenue: 10250.1 },
  { region: "West", month: "Mar", units: 88, revenue: 11000 }
];

export const XLSX_MARKERS = Object.freeze({
  hiddenSheetText: "HIDDEN-SHEET-MARKER-7Q",
  hiddenSheetNumber: 987654.321,
  comment: "COMMENT-MARKER-3Z",
  metadata: "METADATA-MARKER-9K"
});

/** Sums in integer cents so the oracle carries no float drift. */
function centsSum(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + Math.round(value * 100), 0) / 100;
}

/**
 * A workbook with a visible "Sales" sheet, a hidden "Internal" sheet, a cell
 * comment (comments part plus the VML shape Excel needs to show it) and core
 * metadata. The hidden sheet, the comment and the metadata each carry a marker
 * that a faithful artifact of the visible data never shows.
 */
export function salesWorkbookXlsx(): FileFixture<{
  visibleSheet: string;
  hiddenSheet: string;
  header: readonly string[];
  rows: readonly SalesRow[];
  revenueByRegion: Readonly<Record<string, number>>;
  unitsByRegion: Readonly<Record<string, number>>;
  totalRevenue: number;
  totalUnits: number;
  commentCell: string;
  /** Strings from hidden parts that must not appear in an artifact built from the visible sheet. */
  forbiddenMarkers: readonly string[];
}> {
  const header = ["Region", "Month", "Units", "Revenue"] as const;
  const strings: string[] = [];
  let stringRefs = 0;
  const sharedString = (text: string): number => {
    stringRefs += 1;
    const known = strings.indexOf(text);
    if (known >= 0) return known;
    strings.push(text);
    return strings.length - 1;
  };
  const textCell = (ref: string, text: string, style = 0) =>
    `<c r="${ref}" t="s"${style ? ` s="${style}"` : ""}><v>${sharedString(text)}</v></c>`;
  const numberCell = (ref: string, value: number, style = 0) => `<c r="${ref}"${style ? ` s="${style}"` : ""}><v>${value}</v></c>`;

  const salesRows = [
    `<row r="1">${header.map((title, index) => textCell(`${"ABCD"[index]}1`, title, 1)).join("")}</row>`,
    ...SALES_ROWS.map((row, index) => {
      const r = index + 2;
      return `<row r="${r}">${textCell(`A${r}`, row.region)}${textCell(`B${r}`, row.month)}` +
        `${numberCell(`C${r}`, row.units)}${numberCell(`D${r}`, row.revenue, 2)}</row>`;
    })
  ];
  const lastRow = SALES_ROWS.length + 1;
  const sheet1 = `${XML_HEAD}<worksheet xmlns="${NS.sml}" xmlns:r="${NS.rel}">` +
    `<dimension ref="A1:D${lastRow}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="4" width="14" customWidth="1"/></cols>' +
    `<sheetData>${salesRows.join("")}</sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '<legacyDrawing r:id="rId1"/></worksheet>';
  const sheet2 = `${XML_HEAD}<worksheet xmlns="${NS.sml}" xmlns:r="${NS.rel}">` +
    '<dimension ref="A1:B2"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/>' +
    `<sheetData><row r="1">${textCell("A1", XLSX_MARKERS.hiddenSheetText)}${numberCell("B1", XLSX_MARKERS.hiddenSheetNumber)}</row>` +
    `<row r="2">${textCell("A2", "Synthetic internal adjustment")}${numberCell("B2", 1)}</row></sheetData>` +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>';
  const commentText = `${XLSX_MARKERS.comment}: synthetic reviewer note, not part of the data.`;
  const comments = `${XML_HEAD}<comments xmlns="${NS.sml}"><authors><author>Synthetic Reviewer</author></authors>` +
    `<commentList><comment ref="D2" authorId="0"><text><r><t xml:space="preserve">${escapeXml(commentText)}</t></r></text>` +
    "</comment></commentList></comments>";
  const vml = '<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" ' +
    'xmlns:x="urn:schemas-microsoft-com:office:excel">' +
    '<o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="1"/></o:shapelayout>' +
    '<v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe">' +
    '<v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>' +
    '<v:shape id="_x0000_s1025" type="#_x0000_t202" style="position:absolute;margin-left:260pt;margin-top:10pt;' +
    'width:120pt;height:60pt;z-index:1;visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto">' +
    '<v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/>' +
    '<v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox>' +
    '<x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>4, 15, 0, 10, 6, 15, 4, 4</x:Anchor>' +
    "<x:AutoFill>False</x:AutoFill><x:Row>1</x:Row><x:Column>3</x:Column></x:ClientData></v:shape></xml>";
  const styles = `${XML_HEAD}<styleSheet xmlns="${NS.sml}">` +
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="#,##0.00"/></numFmts>' +
    '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  // Built after both sheets so every reference is counted.
  const sharedStrings = `${XML_HEAD}<sst xmlns="${NS.sml}" count="${stringRefs}" uniqueCount="${strings.length}">` +
    strings.map((text) => `<si><t>${escapeXml(text)}</t></si>`).join("") + "</sst>";
  const workbook = `${XML_HEAD}<workbook xmlns="${NS.sml}" xmlns:r="${NS.rel}">` +
    '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
    '<sheet name="Sales" sheetId="1" r:id="rId1"/><sheet name="Internal" sheetId="2" state="hidden" r:id="rId2"/>' +
    "</sheets></workbook>";

  const bytes = zipOf({
    "[Content_Types].xml": contentTypes({
      "/xl/workbook.xml": `${CT}.spreadsheetml.sheet.main+xml`,
      "/xl/worksheets/sheet1.xml": `${CT}.spreadsheetml.worksheet+xml`,
      "/xl/worksheets/sheet2.xml": `${CT}.spreadsheetml.worksheet+xml`,
      "/xl/styles.xml": `${CT}.spreadsheetml.styles+xml`,
      "/xl/sharedStrings.xml": `${CT}.spreadsheetml.sharedStrings+xml`,
      "/xl/comments1.xml": `${CT}.spreadsheetml.comments+xml`
    }, { vml: `${CT}.vmlDrawing` }),
    ...packageParts("xl/workbook.xml", {
      title: "Synthetic sales workbook",
      description: `${XLSX_MARKERS.metadata} synthetic document metadata`
    }),
    "xl/workbook.xml": workbook,
    "xl/_rels/workbook.xml.rels": relationships([
      [REL_TYPE.worksheet, "worksheets/sheet1.xml"],
      [REL_TYPE.worksheet, "worksheets/sheet2.xml"],
      [REL_TYPE.styles, "styles.xml"],
      [REL_TYPE.sharedStrings, "sharedStrings.xml"]
    ]),
    "xl/worksheets/sheet1.xml": sheet1,
    "xl/worksheets/_rels/sheet1.xml.rels": relationships([
      [REL_TYPE.vmlDrawing, "../drawings/vmlDrawing1.vml"],
      [REL_TYPE.comments, "../comments1.xml"]
    ]),
    "xl/worksheets/sheet2.xml": sheet2,
    "xl/drawings/vmlDrawing1.vml": vml,
    "xl/comments1.xml": comments,
    "xl/styles.xml": styles,
    "xl/sharedStrings.xml": sharedStrings
  });

  const regions = [...new Set(SALES_ROWS.map((row) => row.region))];
  const byRegion = (field: "units" | "revenue") => Object.fromEntries(regions.map((region) =>
    [region, centsSum(SALES_ROWS.filter((row) => row.region === region).map((row) => row[field]))]));
  return {
    fileName: "synthetic-sales.xlsx",
    mimeType: `${CT}.spreadsheetml.sheet`,
    bytes,
    expected: {
      visibleSheet: "Sales",
      hiddenSheet: "Internal",
      header,
      rows: SALES_ROWS,
      revenueByRegion: byRegion("revenue"),
      unitsByRegion: byRegion("units"),
      totalRevenue: centsSum(SALES_ROWS.map((row) => row.revenue)),
      totalUnits: centsSum(SALES_ROWS.map((row) => row.units)),
      commentCell: "D2",
      forbiddenMarkers: [
        XLSX_MARKERS.hiddenSheetText,
        String(XLSX_MARKERS.hiddenSheetNumber),
        XLSX_MARKERS.hiddenSheetNumber.toLocaleString("en-US", { maximumFractionDigits: 3 }),
        XLSX_MARKERS.comment,
        XLSX_MARKERS.metadata
      ]
    }
  };
}

// ----------------------------------------------------------------- DOCX ---

/** A heading, two paragraphs and a bordered two-column table. */
export function reportDocx(): FileFixture<{
  heading: string;
  paragraphs: readonly string[];
  table: readonly (readonly string[])[];
  phrases: readonly string[];
}> {
  const heading = "Quarterly Lighthouse Report";
  const paragraphs = [
    "The amber lighthouse protocol reached forty-two synthetic harbors this quarter.",
    "Next quarter targets the cobalt tide expansion across three fictional coasts."
  ];
  const table = [["Harbor", "Visits"], ["Northpoint Synthetic", "17"], ["Southreach Synthetic", "25"]];
  const run = (text: string) => `<w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r>`;
  const widths = [4800, 2400];
  const border = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="444444"/>`;
  const tableXml = "<w:tbl><w:tblPr><w:tblW w:w=\"0\" w:type=\"auto\"/><w:tblBorders>" +
    ["top", "left", "bottom", "right", "insideH", "insideV"].map(border).join("") +
    `</w:tblBorders></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join("")}</w:tblGrid>` +
    table.map((row, rowIndex) => "<w:tr>" + row.map((cell, index) => `<w:tc><w:tcPr><w:tcW w:w="${widths[index]}" w:type="dxa"/></w:tcPr>` +
      `<w:p>${rowIndex === 0 ? `<w:r><w:rPr><w:b/></w:rPr><w:t>${escapeXml(cell)}</w:t></w:r>` : run(cell)}</w:p></w:tc>`).join("") + "</w:tr>").join("") +
    "</w:tbl>";
  const document = `${XML_HEAD}<w:document xmlns:w="${NS.wml}" xmlns:r="${NS.rel}"><w:body>` +
    `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr>${run(heading)}</w:p>` +
    paragraphs.map((text) => `<w:p>${run(text)}</w:p>`).join("") +
    tableXml +
    // Word requires a paragraph between a table and the section properties.
    "<w:p/><w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/>" +
    '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>' +
    "</w:sectPr></w:body></w:document>";
  const styles = `${XML_HEAD}<w:styles xmlns:w="${NS.wml}">` +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>' +
    '<w:pPrDefault><w:pPr><w:spacing w:after="160"/></w:pPr></w:pPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/>' +
    '<w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr>' +
    '<w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style></w:styles>';
  const bytes = zipOf({
    "[Content_Types].xml": contentTypes({
      "/word/document.xml": `${CT}.wordprocessingml.document.main+xml`,
      "/word/styles.xml": `${CT}.wordprocessingml.styles+xml`
    }),
    ...packageParts("word/document.xml", { title: heading, description: "Synthetic report fixture" }),
    "word/document.xml": document,
    "word/_rels/document.xml.rels": relationships([[REL_TYPE.styles, "styles.xml"]]),
    "word/styles.xml": styles
  });
  return {
    fileName: "lighthouse-report.docx",
    mimeType: `${CT}.wordprocessingml.document`,
    bytes,
    expected: { heading, paragraphs, table, phrases: ["Quarterly Lighthouse Report", "amber lighthouse protocol", "cobalt tide expansion", "Southreach Synthetic"] }
  };
}

// ----------------------------------------------------------------- PPTX ---

type Box = readonly [x: number, y: number, cx: number, cy: number];
const TITLE_BOX: Box = [838200, 365125, 10515600, 1325563];
const BODY_BOX: Box = [838200, 1825625, 10515600, 4351338];

function pptxShape(id: number, name: string, placeholder: string, box: Box, body: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` +
    `<p:nvPr>${placeholder}</p:nvPr></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box[0]}" y="${box[1]}"/><a:ext cx="${box[2]}" cy="${box[3]}"/></a:xfrm></p:spPr>` +
    `<p:txBody><a:bodyPr/><a:lstStyle/>${body}</p:txBody></p:sp>`;
}

function pptxTree(shapes: string): string {
  return '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
    '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
    `${shapes}</p:spTree></p:cSld>`;
}

const pptxParagraph = (text: string, bullet = false) => "<a:p>" +
  (bullet ? '<a:pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>' : "") +
  `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${escapeXml(text)}</a:t></a:r></a:p>`;

function pptxTheme(): string {
  const colors = ["dk1:000000", "lt1:FFFFFF", "dk2:1F2937", "lt2:F3F4F6", "accent1:2563EB", "accent2:DC2626", "accent3:16A34A",
    "accent4:D97706", "accent5:7C3AED", "accent6:0891B2", "hlink:1D4ED8", "folHlink:6D28D9"];
  const font = '<a:latin typeface="Arial"/><a:ea typeface=""/><a:cs typeface=""/>';
  const fill = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  return `${XML_HEAD}<a:theme xmlns:a="${NS.dml}" name="Synthetic"><a:themeElements><a:clrScheme name="Synthetic">` +
    colors.map((entry) => { const [slot, rgb] = entry.split(":"); return `<a:${slot}><a:srgbClr val="${rgb}"/></a:${slot}>`; }).join("") +
    `</a:clrScheme><a:fontScheme name="Synthetic"><a:majorFont>${font}</a:majorFont><a:minorFont>${font}</a:minorFont></a:fontScheme>` +
    `<a:fmtScheme name="Synthetic"><a:fillStyleLst>${fill.repeat(3)}</a:fillStyleLst>` +
    `<a:lnStyleLst>${`<a:ln w="6350">${fill}</a:ln>`.repeat(3)}</a:lnStyleLst>` +
    `<a:effectStyleLst>${"<a:effectStyle><a:effectLst/></a:effectStyle>".repeat(3)}</a:effectStyleLst>` +
    `<a:bgFillStyleLst>${fill.repeat(3)}</a:bgFillStyleLst></a:fmtScheme></a:themeElements>` +
    "<a:objectDefaults/><a:extraClrSchemeLst/></a:theme>";
}

/** Two slides, each with a title placeholder and bulleted body text, on one master, layout and theme. */
export function deckPptx(): FileFixture<{
  slideCount: number;
  slideTitles: readonly string[];
  bullets: readonly (readonly string[])[];
}> {
  const slides = [
    { title: "Aurora Harbor Overview", bullets: ["Synthetic metric: 314 lanterns lit", "Owner: Synthetic Team Alpha"] },
    { title: "Cobalt Tide Next Steps", bullets: ["Launch window: synthetic week 27"] }
  ];
  const ns = `xmlns:a="${NS.dml}" xmlns:r="${NS.rel}" xmlns:p="${NS.pml}"`;
  const placeholders = (title: string, bodyParagraphs: string) =>
    pptxShape(2, "Title 1", '<p:ph type="title"/>', TITLE_BOX, pptxParagraph(title)) +
    pptxShape(3, "Content Placeholder 2", '<p:ph idx="1"/>', BODY_BOX, bodyParagraphs);
  const master = `${XML_HEAD}<p:sldMaster ${ns}>` +
    '<p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>' +
    pptxTree(pptxShape(2, "Title Placeholder 1", '<p:ph type="title"/>', TITLE_BOX, pptxParagraph("Master title")) +
      pptxShape(3, "Text Placeholder 2", '<p:ph type="body" idx="1"/>', BODY_BOX, pptxParagraph("Master text"))).slice("<p:cSld>".length) +
    '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
    'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
    '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
    '<p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4000"/></a:lvl1pPr></p:titleStyle>' +
    '<p:bodyStyle><a:lvl1pPr marL="342900" indent="-342900"><a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>' +
    '<a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr/></a:lvl1pPr></p:otherStyle></p:txStyles>' +
    "</p:sldMaster>";
  const layout = `${XML_HEAD}<p:sldLayout ${ns} type="obj" preserve="1">` +
    pptxTree(placeholders("Layout title", pptxParagraph("Layout text"))).replace("<p:cSld>", '<p:cSld name="Title and Content">') +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>";
  const slideXml = (slide: (typeof slides)[number]) => `${XML_HEAD}<p:sld ${ns}>` +
    pptxTree(placeholders(slide.title, slide.bullets.map((bullet) => pptxParagraph(bullet, true)).join(""))) +
    "<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>";
  const presentation = `${XML_HEAD}<p:presentation ${ns} saveSubsetFonts="1">` +
    '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
    `<p:sldIdLst>${slides.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join("")}</p:sldIdLst>` +
    '<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>';
  const slideParts = Object.fromEntries(slides.flatMap((slide, index) => [
    [`ppt/slides/slide${index + 1}.xml`, slideXml(slide)],
    [`ppt/slides/_rels/slide${index + 1}.xml.rels`, relationships([[REL_TYPE.slideLayout, "../slideLayouts/slideLayout1.xml"]])]
  ]));
  const bytes = zipOf({
    "[Content_Types].xml": contentTypes({
      "/ppt/presentation.xml": `${CT}.presentationml.presentation.main+xml`,
      "/ppt/slideMasters/slideMaster1.xml": `${CT}.presentationml.slideMaster+xml`,
      "/ppt/slideLayouts/slideLayout1.xml": `${CT}.presentationml.slideLayout+xml`,
      ...Object.fromEntries(slides.map((_, index) => [`/ppt/slides/slide${index + 1}.xml`, `${CT}.presentationml.slide+xml`])),
      "/ppt/theme/theme1.xml": `${CT}.theme+xml`,
      "/ppt/presProps.xml": `${CT}.presentationml.presProps+xml`,
      "/ppt/viewProps.xml": `${CT}.presentationml.viewProps+xml`,
      "/ppt/tableStyles.xml": `${CT}.presentationml.tableStyles+xml`
    }),
    ...packageParts("ppt/presentation.xml", { title: "Synthetic harbor deck", description: "Synthetic deck fixture" }),
    "ppt/presentation.xml": presentation,
    "ppt/_rels/presentation.xml.rels": relationships([
      [REL_TYPE.slideMaster, "slideMasters/slideMaster1.xml"],
      ...slides.map((_, index) => [REL_TYPE.slide, `slides/slide${index + 1}.xml`] as const),
      [REL_TYPE.presProps, "presProps.xml"],
      [REL_TYPE.viewProps, "viewProps.xml"],
      [REL_TYPE.theme, "theme/theme1.xml"],
      [REL_TYPE.tableStyles, "tableStyles.xml"]
    ]),
    "ppt/slideMasters/slideMaster1.xml": master,
    "ppt/slideMasters/_rels/slideMaster1.xml.rels": relationships([
      [REL_TYPE.slideLayout, "../slideLayouts/slideLayout1.xml"],
      [REL_TYPE.theme, "../theme/theme1.xml"]
    ]),
    "ppt/slideLayouts/slideLayout1.xml": layout,
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels": relationships([[REL_TYPE.slideMaster, "../slideMasters/slideMaster1.xml"]]),
    ...slideParts,
    "ppt/theme/theme1.xml": pptxTheme(),
    "ppt/presProps.xml": `${XML_HEAD}<p:presentationPr ${ns}/>`,
    "ppt/viewProps.xml": `${XML_HEAD}<p:viewPr ${ns}><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`,
    "ppt/tableStyles.xml": `${XML_HEAD}<a:tblStyleLst xmlns:a="${NS.dml}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`
  });
  return {
    fileName: "harbor-deck.pptx",
    mimeType: `${CT}.presentationml.presentation`,
    bytes,
    expected: { slideCount: slides.length, slideTitles: slides.map((slide) => slide.title), bullets: slides.map((slide) => slide.bullets) }
  };
}

// ------------------------------------------------------------------ PDF ---

/** Letter-size pages with Helvetica text; the xref table carries exact byte offsets. */
export function samplePdf(pages = 2): FileFixture<{
  pageCount: number;
  phrase: string;
  pagePhrases: readonly string[];
}> {
  if (!Number.isInteger(pages) || pages < 1 || pages > 50) throw new Error("sample_pdf_pages_invalid");
  const phrase = "VERMILION-ORCHARD-PDF-41";
  const pagePhrases = Array.from({ length: pages }, (_, index) => `Page marker QUARTZ-${index + 1}`);
  const pdfText = (text: string) => `(${text.replace(/[\\()]/gu, "\\$&")})`;
  const objects: string[] = [];
  const pageIds = Array.from({ length: pages }, (_, index) => 5 + index * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pages} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Title (Synthetic PDF fixture) /Author (Synthetic Fixture Author) /Producer (AIQSA synthetic fixture) " +
    "/CreationDate (D:20260101000000Z) /ModDate (D:20260101000000Z) >>";
  pageIds.forEach((id, index) => {
    const lines: [size: number, y: number, text: string][] = [
      [24, 720, "Synthetic PDF Fixture"],
      [14, 690, `Page ${index + 1} of ${pages}`],
      [14, 666, pagePhrases[index]!],
      [12, 642, index === 0 ? `Distinctive phrase: ${phrase}` : "Synthetic continuation text for page checks."]
    ];
    const stream = lines.map(([size, y, text]) => `BT /F1 ${size} Tf 72 ${y} Td ${pdfText(text)} Tj ET`).join("\n");
    objects[id] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] " +
      `/Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`;
    objects[id + 1] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`;
  });
  let body = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(body, "latin1");
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n` +
    offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("") +
    `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 4 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return {
    fileName: "synthetic-orchard.pdf",
    mimeType: "application/pdf",
    bytes: Buffer.from(body, "latin1"),
    expected: { pageCount: pages, phrase, pagePhrases }
  };
}

// ------------------------------------------------------------------ GIF ---

/** GIF variable-width LZW with a full-table clear, as in common encoders. */
function gifLzw(indices: Uint8Array, minCodeSize: number): Buffer {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let bits = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  const emit = (code: number) => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      out.push(bits & 0xff);
      bits >>>= 8;
      bitCount -= 8;
    }
  };
  let table = new Map<number, number>();
  let next = eoi + 1;
  emit(clear);
  let prefix = indices[0]!;
  for (let index = 1; index < indices.length; index++) {
    const symbol = indices[index]!;
    const key = (prefix << 8) | symbol;
    const known = table.get(key);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    if (next === 4096) {
      emit(clear);
      table = new Map();
      next = eoi + 1;
      codeSize = minCodeSize + 1;
    } else {
      if (next >= 1 << codeSize) codeSize++;
      table.set(key, next++);
    }
    prefix = symbol;
  }
  emit(prefix);
  emit(eoi);
  if (bitCount > 0) out.push(bits & 0xff);
  const blocks: number[] = [minCodeSize];
  for (let start = 0; start < out.length; start += 255) {
    const block = out.slice(start, start + 255);
    blocks.push(block.length, ...block);
  }
  blocks.push(0);
  return Buffer.from(blocks);
}

/** Frame-indexed pixels of the animated GIF, exported for decoder checks. */
export function animatedGifFrames(): { width: number; height: number; palette: readonly number[]; frames: Uint8Array[] } {
  const width = 32;
  const height = 32;
  const frames = [0, 1, 2].map((frame) => {
    const pixels = new Uint8Array(width * height);
    for (let y = 12; y < 20; y++) for (let x = 4 + frame * 8; x < 12 + frame * 8; x++) pixels[y * width + x] = frame + 1;
    return pixels;
  });
  return { width, height, palette: [0xffffff, 0xd9480f, 0x2f9e44, 0x1c7ed6], frames };
}

/** A looping 32×32, three-frame GIF: a square that moves right and changes colour. */
export function animatedGif(): FileFixture<{ width: number; height: number; frameCount: number; frameDelayMs: number; loops: boolean }> {
  const { width, height, palette, frames } = animatedGifFrames();
  const delayCs = 40;
  const header = Buffer.alloc(13);
  header.write("GIF89a", 0, "ascii");
  header.writeUInt16LE(width, 6);
  header.writeUInt16LE(height, 8);
  header[10] = 0xf1; // Global table, 8-bit colour resolution, 4 entries.
  const colorTable = Buffer.from(palette.flatMap((rgb) => [(rgb >> 16) & 0xff, (rgb >> 8) & 0xff, rgb & 0xff]));
  const loop = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "ascii"), 0x03, 0x01, 0x00, 0x00, 0x00]);
  const frameBytes = frames.map((pixels) => {
    const control = Buffer.from([0x21, 0xf9, 0x04, 0x04, delayCs & 0xff, delayCs >> 8, 0x00, 0x00]);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    return Buffer.concat([control, descriptor, gifLzw(pixels, 2)]);
  });
  return {
    fileName: "moving-square.gif",
    mimeType: "image/gif",
    bytes: Buffer.concat([header, colorTable, loop, ...frameBytes, Buffer.from([0x3b])]),
    expected: { width, height, frameCount: frames.length, frameDelayMs: delayCs * 10, loops: true }
  };
}

// ------------------------------------------------------------------ PNG ---

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typed = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** An RGB PNG with diagonal colour bands; only node:zlib is used. */
export function tinyPng(width = 24, height = 16): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const band = Math.floor((x + y) / 8) % 3;
      raw.set(band === 0 ? [0x1c, 0x7e, 0xd6] : band === 1 ? [0xf7, 0x67, 0x07] : [0xf8, 0xf9, 0xfa], row + 1 + x * 3);
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

// ------------------------------------------------------------ Site ZIPs ---

const sitePage = (title: string, heading: string, stylesheet: string, body: string) =>
  `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<title>${title}</title>\n` +
  `<link rel="stylesheet" href="${stylesheet}">\n</head>\n<body>\n<h1>${heading}</h1>\n${body}\n</body>\n</html>\n`;

/**
 * A three-page site wrapped in one `site/` folder, with macOS junk beside it.
 * Root-relative and relative URLs, a preload hint, a script fetch and a
 * script-set image exercise the artifact's path rewriting.
 */
export function multiPageSiteZip(): FileFixture<{
  strippedRoot: string;
  skippedEntries: number;
  /** Paths after root stripping, sorted as `readZipArchive` returns them. */
  paths: readonly string[];
  entry: string;
  headings: Readonly<Record<string, string>>;
  dataValue: string;
  imageWidth: number;
}> {
  const headings = {
    "index.html": "Harborlight Home Page",
    "about.html": "Harborlight About Page",
    "docs/guide.html": "Harborlight Field Guide"
  };
  const dataValue = "TIDEWATER-DATA-58";
  const logo = tinyPng(24, 16);
  const files: Record<string, string | Buffer> = {
    "site/index.html": sitePage("Harborlight Home", headings["index.html"], "assets/style.css",
      '<nav><a id="about-link" href="about.html">About</a> <a id="guide-link" href="/docs/guide.html">Field guide</a></nav>\n' +
      '<p>Data value: <span id="data-value">loading</span></p>\n<p>Image width: <span id="img-width">loading</span></p>\n' +
      '<div id="logo-slot"></div>\n<script src="/assets/app.js"></script>')
      .replace("<meta charset=\"utf-8\">\n", '<meta charset="utf-8">\n<link rel="preload" href="/assets/app.js" as="script">\n'),
    "site/about.html": sitePage("Harborlight About", headings["about.html"], "/assets/style.css",
      '<p>A synthetic page about a fictional harbor.</p>\n<a id="home-link" href="index.html">Back home</a>'),
    "site/docs/guide.html": sitePage("Harborlight Guide", headings["docs/guide.html"], "../assets/style.css",
      '<p>Synthetic field guide text.</p>\n<a id="home-link" href="../index.html">Back home</a>'),
    "site/assets/app.js": "fetch('data.json')\n" +
      "  .then((response) => response.json())\n" +
      "  .then((data) => { document.getElementById('data-value').textContent = data.value; })\n" +
      "  .catch(() => { document.getElementById('data-value').textContent = 'fetch-failed'; });\n" +
      "const img = new Image();\n" +
      "img.alt = 'Synthetic logo';\n" +
      "img.onload = () => { document.getElementById('img-width').textContent = String(img.naturalWidth); };\n" +
      "img.onerror = () => { document.getElementById('img-width').textContent = 'image-failed'; };\n" +
      "img.src = 'img/logo.png';\n" +
      "document.getElementById('logo-slot').appendChild(img);\n",
    "site/assets/style.css": "body { font-family: sans-serif; margin: 24px; color: #1f2937; }\nh1 { color: #1c7ed6; }\n",
    "site/data.json": `${JSON.stringify({ value: dataValue, source: "synthetic" })}\n`,
    "site/img/logo.png": logo,
    "site/.DS_Store": Buffer.from("Bud1\0synthetic finder metadata", "latin1"),
    "__MACOSX/._index.html": Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00])
  };
  const paths = Object.keys(files).filter((path) => path.startsWith("site/") && !path.endsWith(".DS_Store"))
    .map((path) => path.slice("site/".length)).sort();
  return {
    fileName: "harborlight-site.zip",
    mimeType: "application/zip",
    bytes: zipOf(files),
    expected: { strippedRoot: "site", skippedEntries: 2, paths, entry: "index.html", headings, dataValue, imageWidth: 24 }
  };
}

/** The value the module site computes, from the same source the ZIP ships. */
const MODULE_INPUT = [3, 1, 4, 1, 5, 9, 2, 6];
const moduleChecksum = (values: readonly number[]) => values.reduce((sum, value, index) => sum + value * (index + 1), 0);

/**
 * A site whose entry loads an ES module that imports a sibling module, so it
 * cannot be used directly (`artifact_module_graph_unsupported`) and must be
 * bundled first.
 */
export function multiModuleSiteZip(): FileFixture<{ paths: readonly string[]; entry: string; resultSelector: string; result: string }> {
  const result = `MODULE-RESULT-${moduleChecksum(MODULE_INPUT)}`;
  const files = {
    "index.html": "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Module Checksum</title>\n" +
      '<script type="module" src="main.js"></script>\n</head>\n<body>\n<h1>Module Checksum</h1>\n' +
      '<p id="result">pending</p>\n</body>\n</html>\n',
    "main.js": "import { checksum, label } from './util.js';\n\n" +
      `const values = ${JSON.stringify(MODULE_INPUT)};\n` +
      "document.getElementById('result').textContent = label(checksum(values));\n",
    "util.js": "export function checksum(values) {\n" +
      "  return values.reduce((sum, value, index) => sum + value * (index + 1), 0);\n}\n\n" +
      "export function label(value) {\n  return 'MODULE-RESULT-' + value;\n}\n"
  };
  return {
    fileName: "module-checksum-site.zip",
    mimeType: "application/zip",
    bytes: zipOf(files),
    expected: { paths: Object.keys(files).sort(), entry: "index.html", resultSelector: "#result", result }
  };
}

// ----------------------------------------------------------------- HTML ---

const WORKER_INPUT = 12;

/** A single-file page with a data: favicon, a blob: worker and a canvas. */
export function selfContainedHtml(): FileFixture<{ workerResultSelector: string; workerResult: string; heading: string }> {
  let sum = 0;
  for (let value = 1; value <= WORKER_INPUT; value++) sum += value * value;
  const heading = "Prism Worker Check";
  const icon = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E" +
    "%3Crect width='16' height='16' rx='3' fill='%23d9480f'/%3E%3C/svg%3E";
  const html = "<!doctype html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n<title>Prism Worker Check</title>\n" +
    `<link rel="icon" href="${icon}">\n</head>\n<body>\n<h1>${heading}</h1>\n` +
    '<p>Worker answer: <span id="worker-result">waiting</span></p>\n<canvas id="sky" width="96" height="48"></canvas>\n<script>\n' +
    "const source = \"self.onmessage = (event) => { let sum = 0; for (let i = 1; i <= event.data; i++) sum += i * i; " +
    "self.postMessage('WORKER-SUM-' + sum); };\";\n" +
    "const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));\n" +
    "worker.onmessage = (event) => { document.getElementById('worker-result').textContent = event.data; };\n" +
    `worker.postMessage(${WORKER_INPUT});\n` +
    "const context = document.getElementById('sky').getContext('2d');\n" +
    "context.fillStyle = '#1c7ed6';\ncontext.fillRect(0, 0, 96, 48);\n" +
    "context.fillStyle = '#f8f9fa';\ncontext.fillRect(12, 12, 24, 24);\n</script>\n</body>\n</html>\n";
  return {
    fileName: "prism-worker.html",
    mimeType: "text/html",
    bytes: utf8(html),
    expected: { workerResultSelector: "#worker-result", workerResult: `WORKER-SUM-${sum}`, heading }
  };
}

// ---------------------------------------------------------------- Video ---

type RecordOptions = Readonly<{
  width: number;
  height: number;
  bitrate: number;
  mode: "pattern" | "noise";
  durationMs?: number;
  targetBytes?: number;
  maxMs: number;
}>;

const VIDEO_GLOBAL = "__aiqsaFixtureVideo";

/**
 * Records a canvas with MediaRecorder in the page and copies the WebM out in
 * chunks. Needs Chromium; use a blank page (`about:blank`), since the canvas
 * is briefly attached to the document.
 */
async function recordCanvas(target: Page, options: RecordOptions): Promise<{ bytes: Buffer; durationMs: number }> {
  const recorded = await target.evaluate(async ({ options, key }) => {
    const canvas = document.createElement("canvas");
    canvas.width = options.width;
    canvas.height = options.height;
    canvas.style.cssText = "position:fixed;left:-20000px;top:0";
    document.body.append(canvas);
    const context = canvas.getContext("2d")!;
    const noise = context.createImageData(options.width, options.height);
    const pixels = new Uint32Array(noise.data.buffer);
    let seed = 0x9e3779b9;
    let frame = 0;
    const draw = () => {
      if (options.mode === "noise") {
        for (let index = 0; index < pixels.length; index++) {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
          pixels[index] = seed | 0xff000000;
        }
        context.putImageData(noise, 0, 0);
      } else {
        context.fillStyle = "#f8f9fa";
        context.fillRect(0, 0, options.width, options.height);
        context.fillStyle = ["#d9480f", "#2f9e44", "#1c7ed6"][Math.floor(frame / 15) % 3]!;
        context.fillRect((frame * 4) % options.width, options.height / 3, 40, options.height / 3);
        context.fillStyle = "#1f2937";
        context.font = "20px sans-serif";
        context.fillText(`Synthetic frame ${frame}`, 12, 28);
      }
      frame++;
    };
    draw();
    const mimeType = ["video/webm;codecs=vp8", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mimeType) throw new Error("fixture_video_webm_unsupported");
    const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType, videoBitsPerSecond: options.bitrate });
    const chunks: Blob[] = [];
    let size = 0;
    let startedAt = 0;
    const stopped = new Promise<number>((resolve) => { recorder.onstop = () => resolve(performance.now()); });
    const started = new Promise<void>((resolve) => { recorder.onstart = () => { startedAt = performance.now(); resolve(); }; });
    let enough: () => void = () => undefined;
    const reachedTarget = new Promise<void>((resolve) => { enough = resolve; });
    recorder.ondataavailable = (event) => {
      chunks.push(event.data);
      size += event.data.size;
      if (options.targetBytes && size >= options.targetBytes) enough();
    };
    const timer = setInterval(draw, 1000 / 30);
    recorder.start(200);
    await started;
    await Promise.race([
      reachedTarget,
      new Promise((resolve) => setTimeout(resolve, options.durationMs ?? options.maxMs))
    ]);
    recorder.stop();
    const stoppedAt = await stopped;
    clearInterval(timer);
    canvas.remove();
    const blob = new Blob(chunks, { type: "video/webm" });
    (window as unknown as Record<string, Blob>)[key] = blob;
    return { size: blob.size, durationMs: stoppedAt - startedAt };
  }, { options, key: VIDEO_GLOBAL });
  const parts: Buffer[] = [];
  const chunkSize = 8 * MIB;
  for (let start = 0; start < recorded.size; start += chunkSize) {
    const base64 = await target.evaluate(async ({ key, start, end }) => {
      const blob = (window as unknown as Record<string, Blob>)[key]!;
      return await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).slice(String(reader.result).indexOf(",") + 1));
        reader.onerror = () => reject(new Error("fixture_video_read_failed"));
        reader.readAsDataURL(blob.slice(start, end));
      });
    }, { key: VIDEO_GLOBAL, start, end: Math.min(start + chunkSize, recorded.size) });
    parts.push(Buffer.from(base64, "base64"));
  }
  await target.evaluate((key) => { delete (window as unknown as Record<string, unknown>)[key]; }, VIDEO_GLOBAL);
  const bytes = Buffer.concat(parts);
  if (bytes.length !== recorded.size) throw new Error("fixture_video_copy_incomplete");
  return { bytes: withWebmDuration(bytes, recorded.durationMs), durationMs: recorded.durationMs };
}

function readVint(bytes: Buffer, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = bytes[at]!;
  let length = 1;
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++;
  if (length > 8 || at + length > bytes.length) throw new Error("fixture_webm_invalid");
  let value = keepMarker ? first : first & ((0x80 >> (length - 1)) - 1);
  let allOnes = value === (0x80 >> (length - 1)) - 1;
  for (let index = 1; index < length; index++) {
    value = value * 256 + bytes[at + index]!;
    allOnes &&= bytes[at + index] === 0xff;
  }
  return { value, length, unknown: !keepMarker && allOnes };
}

function writeSize(value: number, length: number): Buffer {
  if (value >= 2 ** (7 * length) - 1) throw new Error("fixture_webm_size_overflow");
  const out = Buffer.alloc(length);
  let rest = value;
  for (let index = length - 1; index >= 0; index--) {
    out[index] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  out[0] = out[0]! | (0x80 >> (length - 1));
  return out;
}

/**
 * Chromium's MediaRecorder writes no Segment Info Duration, so players report
 * an infinite duration. Insert one, as recorded files from cameras carry it.
 */
export function withWebmDuration(bytes: Buffer, durationMs: number): Buffer {
  let at = 0;
  const header = readVint(bytes, at, true);
  if (header.value !== 0x1a45dfa3) throw new Error("fixture_webm_invalid");
  const headerSize = readVint(bytes, at + header.length, false);
  at += header.length + headerSize.length + headerSize.value;
  const segmentId = readVint(bytes, at, true);
  if (segmentId.value !== 0x18538067) throw new Error("fixture_webm_invalid");
  const segmentSize = readVint(bytes, at + segmentId.length, false);
  const segmentSizeAt = at + segmentId.length;
  let child = segmentSizeAt + segmentSize.length;
  for (;;) {
    const id = readVint(bytes, child, true);
    const size = readVint(bytes, child + id.length, false);
    const payloadAt = child + id.length + size.length;
    if (id.value !== 0x1549a966) {
      if (size.unknown) throw new Error("fixture_webm_info_missing");
      child = payloadAt + size.value;
      continue;
    }
    const payload = bytes.subarray(payloadAt, payloadAt + size.value);
    if (payload.includes(Buffer.from([0x44, 0x89]))) return bytes;
    const duration = Buffer.alloc(11);
    duration.set([0x44, 0x89, 0x88]);
    duration.writeDoubleBE(durationMs, 3); // TimecodeScale is 1 ms in Chromium recordings.
    const info = Buffer.concat([bytes.subarray(child, child + id.length), writeSize(size.value + 11, size.length), payload, duration]);
    const segmentHead = segmentSize.unknown ? bytes.subarray(at, segmentSizeAt + segmentSize.length)
      : Buffer.concat([bytes.subarray(at, segmentSizeAt), writeSize(segmentSize.value + 11, segmentSize.length)]);
    return Buffer.concat([bytes.subarray(0, at), segmentHead, bytes.subarray(segmentSizeAt + segmentSize.length, child), info,
      bytes.subarray(payloadAt + size.value)]);
  }
}

/** A short VP8 WebM of a moving bar. Bytes vary per run; the duration bounds hold. */
export async function recordShortVideo(target: Page, seconds = 3, bitrate = 400_000): Promise<FileFixture<{
  width: number;
  height: number;
  minSeconds: number;
  maxSeconds: number;
  recordedSeconds: number;
}>> {
  const width = 320;
  const height = 180;
  const recorded = await recordCanvas(target, { width, height, bitrate, mode: "pattern", durationMs: seconds * 1000, maxMs: seconds * 1000 });
  return {
    fileName: "synthetic-moving-bar.webm",
    mimeType: "video/webm",
    bytes: recorded.bytes,
    expected: { width, height, minSeconds: Math.max(0, seconds - 0.5), maxSeconds: seconds + 1.5, recordedSeconds: recorded.durationMs / 1000 }
  };
}

export const VIDEO_UPLOAD_LIMIT_BYTES = 24 * MIB;

/**
 * A 1280×720 noise WebM recorded until it passes 26 MiB, for the over-the-limit
 * case. Noise defeats compression, so this takes about 5 s in headless Chromium.
 */
export async function largeVideoWebm(target: Page, targetBytes = 26 * MIB): Promise<FileFixture<{
  width: number;
  height: number;
  minBytes: number;
  limitBytes: number;
  recordedSeconds: number;
}>> {
  const width = 1280;
  const height = 720;
  const recorded = await recordCanvas(target, { width, height, bitrate: 80_000_000, mode: "noise", targetBytes, maxMs: 60_000 });
  if (recorded.bytes.length <= VIDEO_UPLOAD_LIMIT_BYTES) throw new Error("fixture_large_video_too_small");
  return {
    fileName: "synthetic-noise-large.webm",
    mimeType: "video/webm",
    bytes: recorded.bytes,
    expected: { width, height, minBytes: VIDEO_UPLOAD_LIMIT_BYTES + 1, limitBytes: VIDEO_UPLOAD_LIMIT_BYTES, recordedSeconds: recorded.durationMs / 1000 }
  };
}
