import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { utils, write } from "xlsx";
import type { ParsedDocument } from "../parsing";
import type { ParsedFieldGroup } from "../parsing/types";
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

function parsed(
  overrides: Partial<ParsedDocument> & Readonly<{ ocrConfidence?: number | null }> = {}
): ParsedDocument {
  return finalizeParsedDocument({
    blocks: overrides.blocks ?? [parsedBlock()],
    engine: "docling",
    fieldGroups: overrides.fieldGroups ?? [],
    mediaType: "application/pdf",
    ocrConfidence: overrides.ocrConfidence ?? null,
    pageCount: overrides.pageCount ?? 1,
    status: overrides.status ?? "complete",
    text: overrides.text ?? "hello world"
  });
}

function fieldGroup(overrides: Partial<ParsedFieldGroup> = {}): ParsedFieldGroup {
  return {
    boundingBoxes: [],
    cells: [{
      boundingBoxes: [],
      confidence: null,
      id: 1,
      itemRef: null,
      label: "key",
      order: 0,
      originalText: "Metric",
      text: "Metric"
    }, {
      boundingBoxes: [],
      confidence: 0.8,
      id: 2,
      itemRef: null,
      label: "value",
      order: 1,
      originalText: "42 kg",
      text: "42 kg"
    }],
    confidence: null,
    kind: "key_value",
    links: [{
      confidence: null,
      label: "to_value",
      order: 0,
      sourceCellId: 1,
      targetCellId: 2
    }],
    page: 1,
    pageEnd: 1,
    readingOrder: 1,
    sourceRef: "#/key_value_items/0",
    ...overrides
  };
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
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
      fieldGroups: [],
      schemaVersion: 4,
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
      schemaVersion: 4,
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
    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      blocks: [parsedBlock({ headingPath: [undefined] as unknown as readonly string[] })]
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

  it("round-trips immutable field graphs with stable IDs and detects cell tampering", () => {
    const graph = fieldGroup();
    const source = parsed({
      fieldGroups: [fieldGroup({
        cells: [
          { ...graph.cells[0]!, originalText: " Metric OCR ", text: "Metric  label" },
          graph.cells[1]!
        ]
      })]
    });
    const first = encodeKnowledgeNormalizedDocument(source, config, { layoutAwareTables: true });
    const second = encodeKnowledgeNormalizedDocument(source, config, { layoutAwareTables: true });

    expect(first.document).toMatchObject({
      fieldGroups: [{
        cells: [
          {
            confidence: null,
            id: 1,
            label: "key",
            originalText: " Metric OCR ",
            order: 0,
            text: "Metric  label"
          },
          { confidence: 0.8, id: 2, label: "value", order: 1, text: "42 kg" }
        ],
        confidence: null,
        kind: "key_value",
        links: [{ label: "to_value", sourceCellId: 1, targetCellId: 2 }],
        locator: { pageEnd: 1, pageStart: 1 },
        readingOrder: 1,
        sourceRef: "#/key_value_items/0"
      }],
      schemaVersion: 4
    });
    expect(first.document.fieldGroups[0]?.id).toMatch(/^fg_[0-9a-f]{24}_0$/u);
    expect(first.document.fieldGroups[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.document.fieldGroups[0]?.id).toBe(first.document.fieldGroups[0]?.id);
    expect(second.document.contentHash).toBe(first.document.contentHash);
    expect(decodeKnowledgeNormalizedDocument(first.body, config).fieldGroups)
      .toEqual(first.document.fieldGroups);

    const tampered = JSON.parse(first.body.toString("utf8")) as {
      fieldGroups: Array<{ cells: Array<{ text: string }> }>;
    };
    tampered.fieldGroups[0]!.cells[1]!.text = "43 kg";
    expect(() => decodeKnowledgeNormalizedDocument(
      Buffer.from(JSON.stringify(tampered), "utf8"),
      config
    )).toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });

  it("remaps field-group reading order without allowing layout merges across a group", () => {
    const blocks = [10, 30, 50].flatMap((top, row) => [
      parsedBlock({
        boundingBoxes: [{
          bottom: top + 10,
          coordinateOrigin: "top_left",
          left: 10,
          page: 1,
          right: 90,
          top
        }],
        index: row * 2,
        readingOrder: row * 2,
        text: `Metric ${row + 1}`
      }),
      parsedBlock({
        boundingBoxes: [{
          bottom: top + 10,
          coordinateOrigin: "top_left",
          left: 120,
          page: 1,
          right: 180,
          top
        }],
        index: row * 2 + 1,
        readingOrder: row * 2 + 1,
        text: `${row + 1}`
      })
    ]);
    const afterTable = encodeKnowledgeNormalizedDocument(parsed({
      blocks,
      fieldGroups: [fieldGroup({ readingOrder: blocks.length })],
      ocrConfidence: 0.9
    }), config, { layoutAwareTables: true }).document;
    expect(afterTable.blocks).toMatchObject([{ table: { columnCount: 2, rowCount: 3 } }]);
    expect(afterTable.fieldGroups).toMatchObject([{ readingOrder: 1 }]);

    const insideTable = encodeKnowledgeNormalizedDocument(parsed({
      blocks,
      fieldGroups: [fieldGroup({ readingOrder: 3 })],
      ocrConfidence: 0.9
    }), config, { layoutAwareTables: true }).document;
    expect(insideTable.blocks).toHaveLength(6);
    expect(insideTable.fieldGroups).toMatchObject([{ readingOrder: 3 }]);
  });

  it("keeps graph-only documents usable but rejects a wholly empty graph artifact", () => {
    const graphOnly = encodeKnowledgeNormalizedDocument(parsed({
      blocks: [],
      fieldGroups: [fieldGroup({ readingOrder: 0 })],
      text: "Metric 42 kg"
    }), config);
    expect(graphOnly.document).toMatchObject({
      blocks: [],
      fieldGroups: [{ cells: [{ text: "Metric" }, { text: "42 kg" }] }]
    });
    expect(graphOnly.document.quality.usableBlockCount).toBe(1);

    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      blocks: [],
      fieldGroups: [fieldGroup({ cells: [], links: [], readingOrder: 0 })],
      text: ""
    }), config)).toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });

  it("rejects duplicate and dangling graph identities before persistence", () => {
    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      fieldGroups: [fieldGroup({
        cells: [
          { ...fieldGroup().cells[0]!, id: 1, order: 0 },
          { ...fieldGroup().cells[1]!, id: 1, order: 1 }
        ]
      })]
    }), config)).toThrowError(expect.objectContaining({ code: "parser_rejected" }));

    expect(() => encodeKnowledgeNormalizedDocument(parsed({
      fieldGroups: [fieldGroup({
        links: [{
          ...fieldGroup().links[0]!,
          targetCellId: 99
        }]
      })]
    }), config)).toThrowError(expect.objectContaining({ code: "parser_rejected" }));
  });

  it.each([2, 3] as const)("upgrades a schema-v%i object with its legacy hash recipe", (version) => {
    const current = encodeKnowledgeNormalizedDocument(parsed(), config).document;
    const legacy = {
      ...current,
      contentHash: sha256(version === 3 ? {
        assets: current.assets.map((asset) => asset.contentHash),
        blocks: current.blocks.map((block) => block.contentHash),
        status: current.status,
        workbook: current.workbook
      } : {
        assets: current.assets.map((asset) => asset.contentHash),
        blocks: current.blocks.map((block) => block.contentHash),
        status: current.status
      }),
      schemaVersion: version
    } as Record<string, unknown>;
    delete legacy.fieldGroups;
    if (version === 2) delete legacy.workbook;

    expect(decodeKnowledgeNormalizedDocument(
      Buffer.from(JSON.stringify(legacy), "utf8"),
      config
    )).toMatchObject({ fieldGroups: [], schemaVersion: 4 });
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
      fieldGroups: [],
      schemaVersion: 4
    });
  });
});
