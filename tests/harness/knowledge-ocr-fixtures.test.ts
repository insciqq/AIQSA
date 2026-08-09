import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertKnowledgeOcrPngContract,
  KNOWLEDGE_OCR_DPI,
  KNOWLEDGE_OCR_ENGLISH_MARKER,
  KNOWLEDGE_OCR_NUMBER_MARKER,
  KNOWLEDGE_OCR_PAGE_HEIGHT_PX,
  KNOWLEDGE_OCR_PAGE_WIDTH_PX,
  KNOWLEDGE_OCR_RUSSIAN_MARKER,
  knowledgeOcrTextEvidence
} from "../../scripts/knowledge-ocr-fixtures";

const productionCompose = readFileSync(resolve(process.cwd(), "docker-compose.yml"), "utf8");
const developmentCompose = readFileSync(resolve(process.cwd(), "docker-compose.dev.yml"), "utf8");
const fixtureSource = readFileSync(
  resolve(process.cwd(), "scripts/knowledge-ocr-fixtures.ts"),
  "utf8"
);
const parserSmoke = readFileSync(
  resolve(process.cwd(), "scripts/smoke-parser-sidecars.ts"),
  "utf8"
);
const benchmark = readFileSync(
  resolve(process.cwd(), "scripts/benchmark-knowledge-ocr.ts"),
  "utf8"
);
const doclingDockerfile = readFileSync(resolve(process.cwd(), "ops/docling/Dockerfile"), "utf8");

function pngChunk(type: string, data: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(data.byteLength, 0);
  header.write(type, 4, "ascii");
  return Buffer.concat([header, data, Buffer.alloc(4)]);
}

function grayscaleA4Png(colorType = 0, dpi = KNOWLEDGE_OCR_DPI): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(KNOWLEDGE_OCR_PAGE_WIDTH_PX, 0);
  header.writeUInt32BE(KNOWLEDGE_OCR_PAGE_HEIGHT_PX, 4);
  header.writeUInt8(8, 8);
  header.writeUInt8(colorType, 9);
  const physicalDimensions = Buffer.alloc(9);
  const pixelsPerMeter = Math.round(dpi / 0.0254);
  physicalDimensions.writeUInt32BE(pixelsPerMeter, 0);
  physicalDimensions.writeUInt32BE(pixelsPerMeter, 4);
  physicalDimensions.writeUInt8(1, 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("pHYs", physicalDimensions),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

describe("Knowledge OCR fixture contract", () => {
  it("defines an A4 raster at 300 DPI", () => {
    const widthDpi = KNOWLEDGE_OCR_PAGE_WIDTH_PX / (210 / 25.4);
    const heightDpi = KNOWLEDGE_OCR_PAGE_HEIGHT_PX / (297 / 25.4);
    expect(KNOWLEDGE_OCR_DPI).toBe(300);
    expect(Math.round(widthDpi)).toBe(KNOWLEDGE_OCR_DPI);
    expect(Math.round(heightDpi)).toBe(KNOWLEDGE_OCR_DPI);
    expect(() => assertKnowledgeOcrPngContract(grayscaleA4Png())).not.toThrow();
    expect(() => assertKnowledgeOcrPngContract(grayscaleA4Png(2))).toThrow(
      "knowledge OCR fixture is not an A4 300 DPI grayscale PNG"
    );
    expect(() => assertKnowledgeOcrPngContract(grayscaleA4Png(0, 72))).toThrow(
      "knowledge OCR fixture does not declare 300 DPI physical dimensions"
    );
  });

  it("requires Russian, English, order-number, and table-only recognition evidence", () => {
    expect(knowledgeOcrTextEvidence([
      KNOWLEDGE_OCR_RUSSIAN_MARKER,
      "ПРОВЕРКА СКАНА ДОКУМЕНТА",
      KNOWLEDGE_OCR_ENGLISH_MARKER,
      "SCANNED DOCUMENT CHECK",
      KNOWLEDGE_OCR_NUMBER_MARKER,
      "ПАРАМЕТР ЗНАЧЕНИЕ",
      "PRESSURE VALUE",
      "42 1013"
    ].join("\n"))).toMatchObject({
      englishTokenCount: 8,
      numberMarkerPresent: true,
      russianTokenCount: 8,
      tableEvidence: {
        englishHeadersPresent: true,
        numericValuesPresent: true,
        russianHeadersPresent: true,
        useful: true
      },
      useful: true
    });

    expect(knowledgeOcrTextEvidence("ENGLISH TEXT FOR SEARCH 2026 0842")).toMatchObject({
      numberMarkerPresent: true,
      russianTokenCount: 0,
      tableEvidence: { useful: false },
      useful: false
    });

    expect(knowledgeOcrTextEvidence([
      KNOWLEDGE_OCR_RUSSIAN_MARKER,
      KNOWLEDGE_OCR_ENGLISH_MARKER,
      KNOWLEDGE_OCR_NUMBER_MARKER,
      "ПАРАМЕТР ЗНАЧЕНИЕ PRESSURE VALUE 1013"
    ].join("\n"))).toMatchObject({
      tableEvidence: { numericValuesPresent: false, useful: false },
      useful: false
    });
  });

  it("converts the Chromium render once and derives every raster format from grayscale PNG", () => {
    expect(fixtureSource).toMatch(/const renderedPng = await page\.screenshot/u);
    expect(fixtureSource).toMatch(/await sharp\(renderedPng\)[\s\S]*?\.removeAlpha\(\)[\s\S]*?\.grayscale\(\)/u);
    expect(fixtureSource).toContain('.toColourspace("b-w")');
    expect(fixtureSource).toContain('encodedPngChunk("pHYs", physicalDimensions)');
    expect(fixtureSource).toContain(".png({ compressionLevel: 9, palette: false })");
    expect(fixtureSource).toMatch(/const jpeg = jpegPath[\s\S]*?await sharp\(png\)[\s\S]*?\.grayscale\(\)/u);
    expect(fixtureSource).toMatch(/const webp = webpPath[\s\S]*?await sharp\(png\)[\s\S]*?\.grayscale\(\)/u);
  });

  it("smokes PNG, JPEG, WebP, and image-only PDF through the useful OCR contract", () => {
    expect(parserSmoke).toContain("includeJpeg: true");
    expect(parserSmoke).toContain("includeWebp: true");
    expect(parserSmoke).toContain('evidenceKey: "ocrPng"');
    expect(parserSmoke).toContain('evidenceKey: "ocrJpeg"');
    expect(parserSmoke).toContain('evidenceKey: "ocrWebp"');
    expect(parserSmoke).toContain('evidenceKey: "ocrImageOnlyPdf"');
    expect(parserSmoke).toContain("assert.equal(textEvidence.useful, true)");
  });

  it("builds Docling locally while benchmark recovery forbids rebuilds and pulls", () => {
    for (const compose of [productionCompose, developmentCompose]) {
      expect(compose).toContain([
        "  docling:",
        "    build:",
        "      context: ./ops/docling",
        "    image: aiqsa-docling:v1.21.0-easyocr-ru-en-1",
        "    pull_policy: build"
      ].join("\n"));
      for (const setting of [
        'DOCLING_NUM_THREADS: "2"',
        'DOCLING_SERVE_ENG_LOC_NUM_WORKERS: "1"',
        'DOCLING_SERVE_LAYOUT_BATCH_SIZE: "4"',
        'DOCLING_SERVE_LOAD_MODELS_AT_BOOT: "false"',
        'DOCLING_SERVE_OCR_BATCH_SIZE: "4"',
        'DOCLING_SERVE_OPTIONS_CACHE_SIZE: "1"',
        'DOCLING_SERVE_QUEUE_MAX_SIZE: "4"',
        'DOCLING_SERVE_TABLE_BATCH_SIZE: "4"',
        'OMP_NUM_THREADS: "2"'
      ]) {
        expect(compose).toContain(setting);
      }
    }
    expect(benchmark).toMatch(/"--no-build",\s+"--pull",\s+"never",/u);
  });

  it("fails closed on the exact benchmark image, resources, timeouts, and sealed assets", () => {
    expect(doclingDockerfile).toContain(
      'org.opencontainers.image.base.digest="sha256:c7d56cf78c45ab61406bc2dfebbac562c16e38538393f838991a949577cd3d0a"'
    );
    expect(doclingDockerfile).toContain('org.opencontainers.image.version="v1.21.0-easyocr-ru-en-1"');
    expect(benchmark).toContain(
      'const EXPECTED_IMAGE_BASE_DIGEST = "sha256:c7d56cf78c45ab61406bc2dfebbac562c16e38538393f838991a949577cd3d0a"'
    );
    expect(benchmark).toContain("org.opencontainers.image.base.digest");
    expect(benchmark).toContain("org.opencontainers.image.version");
    expect(benchmark).toContain("const EXPECTED_CLIENT_TIMEOUT_MS = 300_000");
    expect(benchmark).toContain("const EXPECTED_CPU_LIMIT = 2");
    expect(benchmark).toContain("const EXPECTED_MEMORY_LIMIT_BYTES = 10 * 1_024 ** 3");
    expect(benchmark).toContain("const EXPECTED_SERVER_SYNC_WAIT_SECONDS = 290");
    expect(benchmark).toContain('"DOCLING_SERVE_ENG_LOC_NUM_WORKERS=1"');
    expect(benchmark).toContain('"DOCLING_NUM_THREADS=2"');
    expect(benchmark).toContain(
      'const OCR_ASSET_VERIFIER_PATH = "/opt/app-root/src/aiqsa-verify-ocr-assets.py"'
    );
    expect(benchmark.indexOf("assertCanonicalProfile(docling, clientTimeoutMs)")).toBeLessThan(
      benchmark.indexOf("for (const pageCount of MATRIX)")
    );
    expect(benchmark.indexOf("await verifyDoclingOcrAssets(docling.id)")).toBeLessThan(
      benchmark.indexOf("for (const pageCount of MATRIX)")
    );
  });

  it("records recovery before stopping on a 10-page failure while measured 50/100 limits may continue", () => {
    const failedEvidence = benchmark.indexOf('errorCode: "docling_recovery_failed"');
    const failedStop = benchmark.indexOf('throw new Error("ocr_benchmark_docling_recovery_failed")');
    const completedEvidence = benchmark.lastIndexOf("writeBoundedJson({");
    const tenPageStop = benchmark.indexOf('throw new Error("ocr_benchmark_ten_page_failed")');
    expect(failedEvidence).toBeGreaterThan(0);
    expect(failedStop).toBeGreaterThan(failedEvidence);
    expect(tenPageStop).toBeGreaterThan(completedEvidence);
    expect(benchmark).toContain("await verifyDoclingOcrAssets(inspection.id)");
    expect(benchmark).toMatch(/if \(result\.recoveryReason\)[\s\S]*?recoverTimedOutDocling/u);
    expect(benchmark).toContain('"event=oom"');
    expect(benchmark).toContain('errorCode: "container_oom"');
    expect(benchmark).toContain("writeBoundedJson({");
  });
});
