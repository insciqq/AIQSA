import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import {
  createDocumentParserBoundary,
  isDocumentParserError,
  type ParsedDocument
} from "../lib/server/parsing";
import {
  AttachmentProcessingError,
  createAttachmentProcessor,
  type AttachmentProcessingRecord
} from "../lib/server/uploads/processing";
import {
  createKnowledgeOcrFixtures,
  knowledgeOcrTextEvidence
} from "./knowledge-ocr-fixtures";

const PDF_MARKER = "AIQSA PDF parser fixture";
const DOCX_MARKER = "AIQSA DOCX parser fixture";
const DOC_MARKER = "AIQSA legacy parser fixture";
let smokeStage = "startup";

// A tiny one-page OLE Compound File produced as Word 97 format from the marker
// text above. The deterministic gzip wrapper keeps the opt-in smoke self-contained
// without shipping a binary fixture in the application image.
const LEGACY_DOC_GZIP_BASE64 = "H4sIAAAAAAACA+2Zz09cVRTHz30zjDO0HQYYaaUoUzoWpGX4VSpUtJ2BUoryqyCoVRtghjIUZnAYapu4MBoTFzXBuHBjYkyoMdEY1D9AN7ozuumiu9qdiYtq1KSLMn7veffByxTkzYBG7DuTz9z3695zf5x73rn3/fhD8c2Pvij/ibLkCXLQSsZDLtM1AYqMEx+Rpq6tZDIZ43LGlh0ld1Uqx9CJ8SsAcswfAG7gAYVgF9gN9gCvGnOfSm3ZuXKWkvilKUCnKIE0RVcoFymDxZjLs5JnxeJzVsXWn79+w3/nOv+L9FcAFYMSUAr84EG2CaK9YB94CJSD/aACPKz0VSINqOMqpAdBEDwKDoFqUAMeA7XgMDgC6kAI1IMG0AiaQDM4ClrAMfA4aAVt4Di/z4jawZPgKXACnARhEAEdoBOcAl3gNOgGZ0APeBo8A3pBH+gHA2AQnAVDYBg8C0bAKHgOPK/aeO4/6isFauUo1G3I5dHYJr7RTaNLjl9vfCKVnE9OpgOjyVS0rjN5cWE2lkizTfQOyWudyQm2BHkcwgnfD7XS721fvrK5LQo9jMhbSmBxhSjl3FpkQi/ANH/NaDKFLffBv6VolsZoRtlxY5BqgyIclFYUqaX+HgcNgo6efTTb7XHOg4EeJyW6ne40eBnHY7h3vrvN+bd16aKVSkGa6OL5000x6IxSHH71As+cIipduk3+pcvkCgrMjv6eAigugOIKkgp1RRWw44hPlnOU518E9Y/CKwdgXzG6DB8tZ56PSqJ+IVAi5t3SVZ5d9T4hSoScZU7Yapzm+VmN52g7VaHMKtHOdetAzeZwN46yE1y3EpR0meu2G3XzcmcccwvZ7pfcoopb1iSq2EOcQZ4o10WelXIOafXymYgYYa8wgD6P0eRq36fxiyGXuRWF8Bh6/Yl7w4XecEGzH73hQm+40Bt+7tlhbhM7HrZU6Zo+duveSh5/4qbVSHVYpZrPdGFA92bs1k6XLQorpjWM7plFZedR6T6kryKVr0vZHNlpLSjHiu0OYfBmaRw5pQE2H7KmPYyOiyujjUOTKN48jxz0cdQ0xR2uD24A+mNc1qSFNp1wQZOF2nUi7zTyjNACa5C552Vb0Trhy7+mRjnm1p9v2UqZvZwm2cUnUVtZrnzGaL90/04S7nfg7b7FcE6JdVyUevkN8pnGxvjmonbPVcMaqh38bmObtWULzr1h+8vMmrEBi4OUc01et/bYSsYwnnuN7uZbH/52p3/K9+m7bjpc/dUNWYfXVHwmVHzjUXFMoYpPdqm4QxpmVMVrc6rZP98lekQdN6h8hlg5Xk9+uSZEb8CDPrxd8rW5q5RXxptkLDkzlmhdpwM9zjKq95od7mZxbhF7fKGOXabjbHmb/2+pyXzLgk+Tz/hzGOA/hd7LmqanhtTj3K9t3VC9eZbRgbEYN+Ut1/So3Jb/p3iz7O/fEo1u2J1viy33tYSxGhxE4B5GJDWDgPoCgu8JXq3O4SiFYF4PticRdstV3wKvC/fgN0xTvEbNzjfKa0a5UoziaAI55IIlwXuUc7iTpEtqATPHwfwlDvdjvLKM00WcrenW194hjoJs+UdErcRtuS9FyPFvBcdVvP+H+e7GJ7bsOCn0kyNIY8HVLTu5geqoo/YGOjlAFBnQqHL5jVBg+bvwgeWEswocXEw4g6AZ92uayNtgff3L2ynXv7/+QWi/7733sf49cudzuT9fkHXtRdK/MwiFz7TW3ei6LWuynd//ZD9nf0NYL49D/u01HEgHbz/OUT+N03TuW0QYVX1DTu0MW5TpVQfWz/FH3rMC2qVeRw76ZX2NnYZGRC1jaHm+dfAq/bl8/5N1vaa2ywsQu8kIa5Yjpiu8t2/etTe+EGwkNdBvfDO0ql/uQX2mjo1orzMr1rMq5Xm0/4DcpfEa7c/WnFt/tOahX36XSm/jHN7K9+e/AFT8kSsAJAAA";

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

function zip(entries: ReadonlyArray<Readonly<{ data: string; name: string }>>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const dosDate = (44 << 9) | (1 << 5) | 1;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data, "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(dosDate, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function docxFixture(): Buffer {
  return zip([
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Default Extension="xml" ContentType="application/xml"/>
          <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
        </Types>`
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
        </Relationships>`
    },
    {
      name: "word/document.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
        <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
          <w:body>
            <w:p><w:r><w:t>${DOCX_MARKER}</w:t></w:r></w:p>
            <w:p><w:r><w:t>This OOXML document proves private Docling parsing.</w:t></w:r></w:p>
            <w:sectPr><w:pgSz w:w="12240" w:h="15840"/></w:sectPr>
          </w:body>
        </w:document>`
    }
  ]);
}

function pdfFixture(): Buffer {
  const content = `BT /F1 18 Tf 72 720 Td (${PDF_MARKER}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets.slice(1).map((value) => `${String(value).padStart(10, "0")} 00000 n \n`).join("");
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "ascii");
}

function assertOnePage(result: ParsedDocument, engine: "docling" | "tika", marker: string): void {
  assert.equal(result.engine, engine);
  assert.equal(result.pageCount, 1);
  assert(result.blocks.length > 0);
  assert(result.blocks.every((block) => block.page === 1));
  assert(result.text.includes(marker));
}

function processingRecord(
  bytes: Buffer,
  input: Readonly<Pick<AttachmentProcessingRecord, "fileName" | "kind" | "mimeType">>
): AttachmentProcessingRecord {
  return {
    attemptCount: 1,
    byteSize: bytes.byteLength,
    checksum: null,
    claimToken: "parser-smoke-claim",
    fileName: input.fileName,
    id: `parser-smoke-${input.kind}`,
    jobId: `parser-smoke-${input.kind}-job`,
    kind: input.kind,
    mimeType: input.mimeType,
    storageKey: `parser-smoke/${input.fileName}`
  };
}

function fixtureProcessor(bytes: Buffer) {
  return createAttachmentProcessor({
    storage: {
      getObject: async (storageKey) => ({
        body: bytes,
        contentType: "application/octet-stream",
        storageKey
      })
    }
  });
}

async function unavailableSmoke(): Promise<void> {
  smokeStage = "unavailable-readiness";
  const readinessUrl = process.env.AIQSA_PARSER_SMOKE_READINESS_URL?.trim();
  const readiness = readinessUrl
    ? await fetch(readinessUrl, {
        cache: "no-store",
        signal: AbortSignal.timeout(5_000)
      })
    : await (await import("../app/api/health/ready/route")).GET(
        new Request("http://localhost/api/health/ready")
      );
  assert(readiness.ok);

  try {
    await createDocumentParserBoundary().parse({
      bytes: pdfFixture(),
      fileName: "fixture.pdf",
      mimeType: "application/pdf"
    });
    assert.fail("parser should be unavailable");
  } catch (error) {
    assert(isDocumentParserError(error));
    assert.equal(error.code, "parser_unavailable");
  }

  const pdf = pdfFixture();
  const pdfResult = await fixtureProcessor(pdf)(processingRecord(pdf, {
    fileName: "fixture.pdf",
    kind: "pdf",
    mimeType: "application/pdf"
  }));
  assert(pdfResult.extractedText?.includes(PDF_MARKER));
  assert.deepEqual(pdfResult.metadata.pdf && {
    parserEngine: (pdfResult.metadata.pdf as Record<string, unknown>).parserEngine,
    status: (pdfResult.metadata.pdf as Record<string, unknown>).status
  }, {
    parserEngine: "unpdf",
    status: "complete"
  });

  const docx = docxFixture();
  try {
    await fixtureProcessor(docx)(processingRecord(docx, {
      fileName: "fixture.docx",
      kind: "document",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    }));
    assert.fail("DOCX attachment processing should require a parser sidecar");
  } catch (error) {
    assert(error instanceof AttachmentProcessingError);
    assert.equal(error.code, "parser_unavailable");
    assert.equal(error.retryable, true);
  }

  process.stdout.write(`${JSON.stringify({
    appReady: true,
    docxErrorCode: "parser_unavailable",
    mode: "unavailable",
    parserUnavailable: true,
    pdfFallbackEngine: "unpdf",
    pdfReady: true
  })}\n`);
}

async function availableSmoke(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "aiqsa-parser-smoke-"));
  try {
    smokeStage = "ocr-fixture-generation";
    const ocrFixtures = await createKnowledgeOcrFixtures({
      directory,
      includeJpeg: true,
      includeWebp: true,
      pageCount: 1
    });
    assert(ocrFixtures.jpeg);
    assert(ocrFixtures.webp);
    const fixtures = [
      {
        bytes: pdfFixture(),
        engine: "docling" as const,
        fileName: "fixture.pdf",
        marker: PDF_MARKER,
        mimeType: "application/pdf"
      },
      {
        bytes: docxFixture(),
        engine: "docling" as const,
        fileName: "fixture.docx",
        marker: DOCX_MARKER,
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      },
      {
        bytes: gunzipSync(Buffer.from(LEGACY_DOC_GZIP_BASE64, "base64")),
        engine: "tika" as const,
        fileName: "fixture.doc",
        marker: DOC_MARKER,
        mimeType: "application/msword"
      }
    ];
    const boundary = createDocumentParserBoundary();
    smokeStage = "sidecar-probe";
    const probe = await boundary.probe();
    assert.equal(probe.docling.available, true);
    assert.equal(probe.tika.available, true);
    const evidence: Record<string, unknown> = {
      probe: { doclingAvailable: true, tikaAvailable: true }
    };

    for (const fixture of fixtures) {
      smokeStage = `native-${fixture.fileName.split(".").at(-1) ?? "document"}`;
      const path = join(directory, fixture.fileName);
      await writeFile(path, fixture.bytes, { flag: "wx" });
      const result = await boundary.parse({
        bytes: await readFile(path),
        fileName: fixture.fileName,
        mimeType: fixture.mimeType
      });
      assertOnePage(result, fixture.engine, fixture.marker);
      evidence[fixture.fileName.split(".").at(-1) ?? fixture.fileName] = {
        blocks: result.blocks.length,
        engine: result.engine,
        markerPresent: true,
        pageAnchorsValid: true,
        pageCount: result.pageCount
      };
    }

    // Knowledge ingestion deliberately pins OCR-capable inputs to Docling and
    // fails closed instead of accepting a text-only Tika fallback. Keep this
    // smoke on the same boundary so a Docling failure cannot be hidden behind
    // a successful fallback response.
    const knowledgeBoundary = createDocumentParserBoundary({ sidecarFallback: false });
    const ocrInputs = [
      {
        bytes: ocrFixtures.imageOnlyPdf,
        evidenceKey: "ocrImageOnlyPdf",
        fileName: "knowledge-ocr-scan.pdf",
        mimeType: "application/pdf"
      },
      {
        bytes: ocrFixtures.png,
        evidenceKey: "ocrPng",
        fileName: "knowledge-ocr-scan.png",
        mimeType: "image/png"
      },
      {
        bytes: ocrFixtures.jpeg,
        evidenceKey: "ocrJpeg",
        fileName: "knowledge-ocr-scan.jpg",
        mimeType: "image/jpeg"
      },
      {
        bytes: ocrFixtures.webp,
        evidenceKey: "ocrWebp",
        fileName: "knowledge-ocr-scan.webp",
        mimeType: "image/webp"
      }
    ];

    for (const fixture of ocrInputs) {
      smokeStage = fixture.evidenceKey;
      const result = await knowledgeBoundary.parse({
        bytes: fixture.bytes,
        fileName: fixture.fileName,
        mimeType: fixture.mimeType
      });
      const textEvidence = knowledgeOcrTextEvidence(result.text);
      if (result.engine !== "docling") smokeStage = `${fixture.evidenceKey}-engine`;
      assert.equal(result.engine, "docling");
      if (result.pageCount !== 1) smokeStage = `${fixture.evidenceKey}-page-count`;
      assert.equal(result.pageCount, 1);
      if (result.blocks.length === 0) smokeStage = `${fixture.evidenceKey}-empty-blocks`;
      assert(result.blocks.length > 0);
      if (!result.blocks.every((block) => block.page === 1)) {
        smokeStage = `${fixture.evidenceKey}-page-anchors`;
      }
      assert(result.blocks.every((block) => block.page === 1));
      if (!textEvidence.useful) {
        const missing = [
          ...(textEvidence.russianTokenCount >= 2 ? [] : ["russian"]),
          ...(textEvidence.englishTokenCount >= 2 ? [] : ["english"]),
          ...(textEvidence.numberMarkerPresent ? [] : ["number"]),
          ...(textEvidence.tableEvidence.russianHeadersPresent ? [] : ["table-ru"]),
          ...(textEvidence.tableEvidence.englishHeadersPresent ? [] : ["table-en"]),
          ...(textEvidence.tableEvidence.numericValuesPresent ? [] : ["table-number"])
        ];
        smokeStage = `${fixture.evidenceKey}-evidence-${missing.join("-")}`;
      }
      assert.equal(textEvidence.useful, true);
      evidence[fixture.evidenceKey] = {
        blocks: result.blocks.length,
        engine: result.engine,
        pageAnchorsValid: true,
        pageCount: result.pageCount,
        ...textEvidence
      };
    }

    process.stdout.write(`${JSON.stringify({ evidence, mode: "available" })}\n`);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function main(): Promise<void> {
  if (process.env.AIQSA_PARSER_SMOKE_EXPECT_UNAVAILABLE === "1") {
    await unavailableSmoke();
    return;
  }
  await availableSmoke();
}

main().catch((error: unknown) => {
  process.stderr.write(`${
    isDocumentParserError(error) ? error.code : `parser_smoke_failed_${smokeStage}`
  }\n`);
  process.exitCode = 1;
});
