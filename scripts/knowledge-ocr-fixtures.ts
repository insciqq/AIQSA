import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import sharp from "sharp";

export const KNOWLEDGE_OCR_DPI = 300;
export const KNOWLEDGE_OCR_PAGE_HEIGHT_PX = 3_508;
export const KNOWLEDGE_OCR_PAGE_WIDTH_PX = 2_480;
export const KNOWLEDGE_OCR_RUSSIAN_MARKER = "РУССКИЙ ТЕКСТ ДЛЯ ПОИСКА";
export const KNOWLEDGE_OCR_ENGLISH_MARKER = "ENGLISH TEXT FOR SEARCH";
export const KNOWLEDGE_OCR_NUMBER_MARKER = "2026 0842";

const RUSSIAN_TOKENS = Object.freeze([
  "русский",
  "текст",
  "поиска",
  "проверка",
  "скана",
  "документа",
  "параметр",
  "значение"
]);
const ENGLISH_TOKENS = Object.freeze([
  "english",
  "text",
  "search",
  "scanned",
  "document",
  "check",
  "pressure",
  "value"
]);

export type KnowledgeOcrFixtureSet = Readonly<{
  imageOnlyPdf: Buffer;
  imageOnlyPdfPath: string;
  jpeg?: Buffer;
  jpegPath?: string;
  pageCount: number;
  png: Buffer;
  pngPath: string;
  webp?: Buffer;
  webpPath?: string;
}>;

export type KnowledgeOcrTextEvidence = Readonly<{
  englishTokenCount: number;
  numberMarkerPresent: boolean;
  russianTokenCount: number;
  tableEvidence: Readonly<{
    englishHeadersPresent: boolean;
    numericValuesPresent: boolean;
    russianHeadersPresent: boolean;
    useful: boolean;
  }>;
  useful: boolean;
}>;

function fixturePageHtml(): string {
  return `<!doctype html>
    <html lang="ru">
      <head>
        <meta charset="utf-8">
        <style>
          * { box-sizing: border-box; }
          html, body { margin: 0; width: ${KNOWLEDGE_OCR_PAGE_WIDTH_PX}px; height: ${KNOWLEDGE_OCR_PAGE_HEIGHT_PX}px; }
          body {
            background: #fff;
            color: #000;
            font-family: "DejaVu Sans", "Liberation Sans", Arial, sans-serif;
            -webkit-font-smoothing: antialiased;
          }
          main {
            display: flex;
            flex-direction: column;
            gap: 104px;
            height: 100%;
            padding: 240px 220px;
          }
          h1 { font-size: 88px; line-height: 1.15; margin: 0; }
          p { font-size: 70px; font-weight: 600; line-height: 1.35; margin: 0; }
          table { border-collapse: collapse; font-size: 58px; line-height: 1.3; width: 100%; }
          th, td { border: 8px solid #000; padding: 30px 38px; text-align: left; }
          th { font-weight: 700; }
          .number { font-family: "DejaVu Sans Mono", monospace; font-size: 72px; }
        </style>
      </head>
      <body>
        <main>
          <h1>AIQSA OCR 300 DPI</h1>
          <p>${KNOWLEDGE_OCR_RUSSIAN_MARKER}<br>ПРОВЕРКА СКАНА ДОКУМЕНТА</p>
          <p>${KNOWLEDGE_OCR_ENGLISH_MARKER}<br>SCANNED DOCUMENT CHECK</p>
          <p class="number">НОМЕР ЗАКАЗА / ORDER ${KNOWLEDGE_OCR_NUMBER_MARKER}</p>
          <table aria-label="OCR fixture table">
            <thead><tr><th>ПАРАМЕТР / METRIC</th><th>ЗНАЧЕНИЕ / VALUE</th></tr></thead>
            <tbody>
              <tr><td>ТЕМПЕРАТУРА</td><td>42</td></tr>
              <tr><td>PRESSURE</td><td>1013</td></tr>
            </tbody>
          </table>
        </main>
      </body>
    </html>`;
}

function imageOnlyPdfHtml(png: Buffer, pageCount: number): string {
  const pages = Array.from({ length: pageCount }, () => "<div class=\"page\"></div>").join("");
  const image = png.toString("base64");
  return `<!doctype html>
    <html><head><meta charset="utf-8"><style>
      @page { size: 210mm 297mm; margin: 0; }
      html, body { margin: 0; padding: 0; }
      #source { display: none; }
      .page {
        background: #fff url("data:image/png;base64,${image}") center / 210mm 297mm no-repeat;
        break-after: page;
        height: 297mm;
        width: 210mm;
      }
      .page:last-child { break-after: auto; }
    </style></head><body><img id="source" alt="" src="data:image/png;base64,${image}">${pages}</body></html>`;
}

function pngChunk(png: Buffer, expectedType: string): Buffer | undefined {
  let offset = 8;
  while (offset + 12 <= png.byteLength) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const dataStart = offset + 8;
    const nextOffset = dataStart + length + 4;
    if (nextOffset > png.byteLength) {
      throw new Error("knowledge OCR fixture has a malformed PNG chunk");
    }
    if (type === expectedType) return png.subarray(dataStart, dataStart + length);
    if (type === "IEND") return undefined;
    offset = nextOffset;
  }
  return undefined;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function encodedPngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const chunk = Buffer.alloc(12 + data.byteLength);
  chunk.writeUInt32BE(data.byteLength, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength);
  return chunk;
}

function declarePngDensity(png: Buffer): Buffer {
  const signature = png.subarray(0, 8);
  const chunks: Buffer[] = [signature];
  const physicalDimensions = Buffer.alloc(9);
  const pixelsPerMeter = Math.round(KNOWLEDGE_OCR_DPI / 0.0254);
  physicalDimensions.writeUInt32BE(pixelsPerMeter, 0);
  physicalDimensions.writeUInt32BE(pixelsPerMeter, 4);
  physicalDimensions.writeUInt8(1, 8);
  let foundHeader = false;
  let foundEnd = false;
  let offset = 8;

  while (offset + 12 <= png.byteLength) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const nextOffset = offset + 12 + length;
    if (nextOffset > png.byteLength) {
      throw new Error("knowledge OCR fixture has a malformed PNG chunk");
    }
    if (type !== "pHYs") chunks.push(png.subarray(offset, nextOffset));
    if (type === "IHDR") {
      foundHeader = true;
      chunks.push(encodedPngChunk("pHYs", physicalDimensions));
    }
    if (type === "IEND") {
      foundEnd = true;
      break;
    }
    offset = nextOffset;
  }
  if (!foundHeader || !foundEnd) throw new Error("knowledge OCR fixture has an incomplete PNG");
  return Buffer.concat(chunks);
}

export function assertKnowledgeOcrPngContract(png: Buffer): void {
  if (
    png.byteLength < 33
    || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || png.toString("ascii", 12, 16) !== "IHDR"
    || png.readUInt32BE(16) !== KNOWLEDGE_OCR_PAGE_WIDTH_PX
    || png.readUInt32BE(20) !== KNOWLEDGE_OCR_PAGE_HEIGHT_PX
    || png.readUInt8(24) !== 8
    || png.readUInt8(25) !== 0
  ) {
    throw new Error("knowledge OCR fixture is not an A4 300 DPI grayscale PNG");
  }

  const pixelsPerMeter = Math.round(KNOWLEDGE_OCR_DPI / 0.0254);
  const physicalDimensions = pngChunk(png, "pHYs");
  if (
    physicalDimensions?.byteLength !== 9
    || physicalDimensions.readUInt32BE(0) !== pixelsPerMeter
    || physicalDimensions.readUInt32BE(4) !== pixelsPerMeter
    || physicalDimensions.readUInt8(8) !== 1
  ) {
    throw new Error("knowledge OCR fixture does not declare 300 DPI physical dimensions");
  }
}

function assertNoTextLayerMarker(pdf: Buffer): void {
  for (const marker of [KNOWLEDGE_OCR_RUSSIAN_MARKER, KNOWLEDGE_OCR_ENGLISH_MARKER]) {
    if (pdf.includes(Buffer.from(marker, "utf8"))) {
      throw new Error("knowledge OCR PDF unexpectedly contains a plain-text marker");
    }
  }
}

export function knowledgeOcrTextEvidence(text: string): KnowledgeOcrTextEvidence {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("ru-RU");
  const recognizedTokens = new Set(normalized.match(/[\p{L}\p{N}]+/gu) ?? []);
  const russianTokenCount = RUSSIAN_TOKENS.filter((token) => recognizedTokens.has(token)).length;
  const englishTokenCount = ENGLISH_TOKENS.filter((token) => recognizedTokens.has(token)).length;
  const numberMarkerPresent = recognizedTokens.has("2026") && recognizedTokens.has("0842");
  const englishHeadersPresent = recognizedTokens.has("pressure") && recognizedTokens.has("value");
  const numericValuesPresent = recognizedTokens.has("42") && recognizedTokens.has("1013");
  const russianHeadersPresent = recognizedTokens.has("параметр") && recognizedTokens.has("значение");
  const tableEvidence = Object.freeze({
    englishHeadersPresent,
    numericValuesPresent,
    russianHeadersPresent,
    useful: englishHeadersPresent && numericValuesPresent && russianHeadersPresent
  });
  return Object.freeze({
    englishTokenCount,
    numberMarkerPresent,
    russianTokenCount,
    tableEvidence,
    useful: russianTokenCount >= 2
      && englishTokenCount >= 2
      && numberMarkerPresent
      && tableEvidence.useful
  });
}

export async function createKnowledgeOcrFixtures(input: Readonly<{
  directory: string;
  includeJpeg?: boolean;
  includeWebp?: boolean;
  pageCount?: number;
}>): Promise<KnowledgeOcrFixtureSet> {
  const pageCount = input.pageCount ?? 1;
  if (!Number.isSafeInteger(pageCount) || pageCount < 1 || pageCount > 100) {
    throw new Error("knowledge OCR fixture page count must be between 1 and 100");
  }

  const pngPath = join(input.directory, "knowledge-ocr-a4-300dpi.png");
  const jpegPath = input.includeJpeg
    ? join(input.directory, "knowledge-ocr-a4-300dpi.jpg")
    : undefined;
  const webpPath = input.includeWebp
    ? join(input.directory, "knowledge-ocr-a4-300dpi.webp")
    : undefined;
  const imageOnlyPdfPath = join(input.directory, `knowledge-ocr-a4-300dpi-${pageCount}.pdf`);
  const browser = await chromium.launch({ headless: true });

  try {
    const page = await browser.newPage({
      deviceScaleFactor: 1,
      viewport: {
        height: KNOWLEDGE_OCR_PAGE_HEIGHT_PX,
        width: KNOWLEDGE_OCR_PAGE_WIDTH_PX
      }
    });
    await page.setContent(fixturePageHtml(), { waitUntil: "load" });
    await page.evaluate(async () => document.fonts.ready);
    const renderedPng = await page.screenshot({
      clip: {
        height: KNOWLEDGE_OCR_PAGE_HEIGHT_PX,
        width: KNOWLEDGE_OCR_PAGE_WIDTH_PX,
        x: 0,
        y: 0
      },
      type: "png"
    });
    const grayscalePng = await sharp(renderedPng)
      .removeAlpha()
      .grayscale()
      .toColourspace("b-w")
      .png({ compressionLevel: 9, palette: false })
      .toBuffer();
    const png = declarePngDensity(grayscalePng);
    assertKnowledgeOcrPngContract(png);
    await writeFile(pngPath, png, { flag: "wx" });

    const jpeg = jpegPath
      ? await sharp(png)
        .grayscale()
        .jpeg({ chromaSubsampling: "4:4:4", quality: 100 })
        .toBuffer()
      : undefined;
    if (jpegPath && jpeg) await writeFile(jpegPath, jpeg, { flag: "wx" });

    const webp = webpPath
      ? await sharp(png)
        .grayscale()
        .webp({ lossless: true })
        .toBuffer()
      : undefined;
    if (webpPath && webp) await writeFile(webpPath, webp, { flag: "wx" });

    await page.setContent(imageOnlyPdfHtml(png, pageCount), { waitUntil: "load" });
    await page.waitForFunction(() => {
      const source = document.querySelector<HTMLImageElement>("#source");
      return Boolean(source?.complete && source.naturalWidth > 0);
    });
    await page.pdf({
      displayHeaderFooter: false,
      height: "297mm",
      margin: { bottom: "0", left: "0", right: "0", top: "0" },
      outline: false,
      path: imageOnlyPdfPath,
      preferCSSPageSize: true,
      printBackground: true,
      tagged: false,
      width: "210mm"
    });

    const imageOnlyPdf = await readFile(imageOnlyPdfPath);
    assertNoTextLayerMarker(imageOnlyPdf);
    return Object.freeze({
      imageOnlyPdf,
      imageOnlyPdfPath,
      ...(jpegPath && jpeg ? { jpeg, jpegPath } : {}),
      pageCount,
      png,
      pngPath,
      ...(webpPath && webp ? { webp, webpPath } : {})
    });
  } finally {
    await browser.close();
  }
}
