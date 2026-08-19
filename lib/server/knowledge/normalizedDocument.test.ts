import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import type { ParsedDocument } from "../parsing";
import { parseSpreadsheetDocument } from "../parsing";
import { finalizeParsedDocument } from "../parsing/assessment";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import {
  decodeKnowledgeNormalizedDocument,
  encodeKnowledgeNormalizedDocument
} from "./normalizedDocument";

const config: KnowledgeExtractionConfig = {
  maxChunksPerDocument: 100,
  maxFileBytes: 10_000,
  maxNormalizedChars: 10_000,
  maxNormalizedObjectBytes: 100_000,
  maxPages: 10
};

function parsedBlock(overrides: Partial<ParsedDocument["blocks"][number]> = {}): ParsedDocument["blocks"][number] {
  return {
    assetIds: [],
    boundingBoxes: [],
    headingPath: [" Section\n"],
    index: 0,
    isTable: false,
    languageHints: ["und-Latn"],
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    table: null,
    text: "hello\r\nworld",
    type: "paragraph",
    ...overrides
  };
}

function parsed(overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return finalizeParsedDocument({
    blocks: overrides.blocks ?? [parsedBlock()],
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: overrides.pageCount ?? 1,
    status: overrides.status ?? "complete",
    text: overrides.text ?? "hello world"
  });
}

describe("Knowledge normalized document", () => {
  it("round-trips a bounded complete parse with canonical text", () => {
    const encoded = encodeKnowledgeNormalizedDocument(parsed(), config, {
      sourceDisplayName: "runbook.pdf"
    });
    expect(encoded.checksum).toMatch(/^[0-9a-f]{64}$/u);
    const decoded = decodeKnowledgeNormalizedDocument(encoded.body, config);
    expect(decoded).toMatchObject({
      blocks: [{
        headingPath: ["Section"],
        locator: { pageEnd: 1, pageStart: 1 },
        text: "hello\nworld",
        type: "paragraph"
      }],
      pageCount: 1,
      parser: { engine: "docling" },
      schemaVersion: 3,
      source: { displayName: "runbook.pdf", mediaType: "application/pdf" }
    });
    expect(decoded.blocks[0]?.id).toMatch(/^b_[0-9a-f]{24}_0$/u);
    expect(decoded.blocks[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(decoded.contentHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("persists an immutable typed workbook and detects cell tampering", () => {
    const sheet = utils.aoa_to_sheet([
      ["Region", "Revenue", "Closed at", "Total"],
      ["North", 10, new Date(2026, 0, 2), null],
      ["South", 20, new Date(2026, 0, 3), null]
    ], { cellDates: true });
    sheet.D2 = { f: "SUM(B2:B3)", t: "n", v: 30, z: "0.00" };
    const workbook = utils.book_new();
    utils.book_append_sheet(workbook, sheet, "Sales");
    const parsedWorkbook = parseSpreadsheetDocument({
      bytes: write(workbook, { bookType: "xlsx", type: "buffer" }),
      fileName: "sales.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    });
    const encoded = encodeKnowledgeNormalizedDocument(parsedWorkbook, config);

    expect(decodeKnowledgeNormalizedDocument(encoded.body, config)).toMatchObject({
      parser: { engine: "spreadsheet" },
      schemaVersion: 3,
      workbook: {
        sheets: [{
          cells: expect.arrayContaining([
            expect.objectContaining({ address: "B2", type: "number", value: 10 }),
            expect.objectContaining({ address: "C2", type: "date", value: "2026-01-02" }),
            expect.objectContaining({ address: "D2", formula: "SUM(B2:B3)", value: 30 })
          ]),
          name: "Sales"
        }]
      }
    });

    const tampered = JSON.parse(encoded.body.toString("utf8")) as {
      workbook: { sheets: Array<{ cells: Array<{ address: string; value: unknown }> }> };
    };
    const revenue = tampered.workbook.sheets[0]?.cells.find((cell) => cell.address === "B2");
    expect(revenue).toBeDefined();
    revenue!.value = 9_999;
    expect(() => decodeKnowledgeNormalizedDocument(
      Buffer.from(JSON.stringify(tampered), "utf8"),
      config
    )).toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });

  it("keeps usable partial parses with truthful warnings and rejects invalid locators", () => {
    const partial = encodeKnowledgeNormalizedDocument(parsed({ status: "partial" }), config);
    expect(partial.document).toMatchObject({
      status: "partial",
      warnings: expect.arrayContaining(["partial_parse"])
    });
    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      blocks: [parsedBlock({ headingPath: [], page: 2, pageEnd: 2, text: "outside" })]
    }), config)).toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });

  it("fails closed on page, text, and serialized-object limits", () => {
    expect(() => encodeKnowledgeNormalizedDocument(parsed({ pageCount: 11 }), config))
      .toThrowError(expect.objectContaining({ code: "knowledge_page_limit_exceeded" }));
    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      blocks: [parsedBlock({ headingPath: [], text: "x".repeat(10_001) })]
    }), config)).toThrowError(expect.objectContaining({ code: "knowledge_text_limit_exceeded" }));
  });

  it("rejects inverted bounding boxes for either coordinate origin", () => {
    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      blocks: [parsedBlock({
        boundingBoxes: [{
          bottom: 10,
          coordinateOrigin: "top_left",
          left: 0,
          page: 1,
          right: 10,
          top: 20
        }]
      })]
    }), config)).toThrowError(expect.objectContaining({ code: "parser_rejected" }));

    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      blocks: [parsedBlock({
        boundingBoxes: [{
          bottom: 20,
          coordinateOrigin: "bottom_left",
          left: 0,
          page: 1,
          right: 10,
          top: 10
        }]
      })]
    }), config)).toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });

  it("upgrades a bounded schema-v1 object in memory so passages can be regenerated", () => {
    const legacy = Buffer.from(JSON.stringify({
      blocks: [{ headingPath: ["Legacy"], page: 1, text: "preserved text" }],
      pageCount: 1,
      parserEngine: "tika",
      schemaVersion: 1
    }));

    expect(decodeKnowledgeNormalizedDocument(legacy, config)).toMatchObject({
      blocks: [{ headingPath: ["Legacy"], text: "preserved text" }],
      parser: { engine: "tika" },
      schemaVersion: 3
    });
  });
});
