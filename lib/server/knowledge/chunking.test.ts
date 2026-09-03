import { describe, expect, it } from "vitest";
import { finalizeParsedDocument } from "../parsing/assessment";
import type { ParsedDocumentBlock } from "../parsing";
import {
  approximateKnowledgeTokenCount,
  chunkKnowledgeDocument,
  KNOWLEDGE_CHUNK_MAX_CHARS,
  KNOWLEDGE_CHUNK_MAX_TOKENS,
  KNOWLEDGE_CHUNK_MAX_UTF8_BYTES,
  KNOWLEDGE_EMBEDDING_BATCH_MAX_TOKENS,
  KNOWLEDGE_EMBEDDING_BATCH_MAX_UTF8_BYTES,
  KNOWLEDGE_EMBEDDING_BATCH_SIZE,
  knowledgeEmbeddingBatches
} from "./chunking";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER } from "./tokenizer/knowledgeTokenCounter";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";
import {
  decodeKnowledgeDocumentContext,
  isCompleteKnowledgeTableRowProjectionSequence,
  KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS,
  KNOWLEDGE_TABLE_HEADER_LINEAGE_MAX_CHARS,
  KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS,
  KNOWLEDGE_TABLE_ROW_MAX_UTF8_BYTES
} from "./documentContext";

const config = {
  maxChunksPerDocument: 1_000,
  maxFileBytes: 1_000_000,
  maxNormalizedChars: 1_000_000,
  maxNormalizedObjectBytes: 4_000_000,
  maxPages: 1_000
};

function block(
  index: number,
  text: string,
  input: Partial<ParsedDocumentBlock> = {}
): ParsedDocumentBlock {
  return {
    assetIds: [],
    boundingBoxes: [],
    headingPath: ["Guide"],
    index,
    isTable: false,
    languageHints: ["und-Latn"],
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: null,
    text,
    type: "paragraph",
    ...input
  };
}

function document(
  blocks: readonly ParsedDocumentBlock[],
  sourceDisplayName = "runbook.pdf",
  ocrConfidence: number | null = null
) {
  return encodeKnowledgeNormalizedDocument(finalizeParsedDocument({
    blocks,
    engine: "docling",
    mediaType: "application/pdf",
    ocrConfidence,
    pageCount: Math.max(...blocks.map((item) => item.pageEnd), 1),
    status: "complete"
  }), config, { layoutAwareTables: true, sourceDisplayName }).document;
}

function fieldDocument(value: string) {
  return {
    ...document([block(0, "Form")]),
    fieldGroups: [{
      boundingBoxes: [],
      cells: [
        {
          boundingBoxes: [],
          confidence: 0.9,
          id: 1,
          itemRef: null,
          label: "key" as const,
          order: 0,
          originalText: "Narrative",
          text: "Narrative"
        },
        {
          boundingBoxes: [],
          confidence: 0.9,
          id: 2,
          itemRef: null,
          label: "value" as const,
          order: 1,
          originalText: value,
          text: value
        }
      ],
      confidence: 0.9,
      contentHash: "f".repeat(64),
      id: "fg_overflow_1",
      kind: "key_value" as const,
      links: [{
        confidence: 0.9,
        label: "to_value" as const,
        order: 0,
        sourceCellId: 1,
        targetCellId: 2
      }],
      locator: { kind: "page" as const, pageEnd: 1, pageStart: 1 },
      order: 0,
      readingOrder: 0,
      sourceRef: "#/key_value_items/0"
    }]
  };
}

describe("Knowledge chunk profiles", () => {
  it("activates only bounded singleton or sparse inline form pairs in profile 11", () => {
    const cells = [{
      column: 0,
      columnSpan: 1,
      row: 0,
      rowSpan: 1,
      text: "Reviewer"
    }, {
      column: 9,
      columnSpan: 1,
      row: 0,
      rowSpan: 1,
      text: "Alex Rivera"
    }];
    const normalized = document([block(0, "Reviewer\t\t\t\t\t\t\t\t\tAlex Rivera", {
      isTable: true,
      table: { cells, columnCount: 10, rowCount: 1 },
      type: "table"
    })]);
    const current = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const previous = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION - 1,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(current).toHaveLength(1);
    expect(current[0]?.documentContext).toMatchObject({
      ambiguityReasons: [],
      observations: [{
        ambiguityReasons: [],
        metric: "Reviewer",
        rawValue: "Alex Rivera"
      }]
    });
    expect(previous[0]?.documentContext?.ambiguityReasons).toContain("missing_header");

    const singletonCells = cells.map((cell, index) => ({ ...cell, column: index }));
    const singleton = chunkKnowledgeDocument({
      document: document([block(0, "Reviewer\tAlex Rivera", {
        isTable: true,
        table: { cells: singletonCells, columnCount: 2, rowCount: 1 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const multiRowCells = [
      singletonCells,
      singletonCells.map((cell, index) => ({
        ...cell,
        row: 1,
        text: index === 0 ? "Approver" : "Sam Lee"
      }))
    ].flat();
    const multiRow = chunkKnowledgeDocument({
      document: document([block(0, "Reviewer\tAlex Rivera\nApprover\tSam Lee", {
        isTable: true,
        table: { cells: multiRowCells, columnCount: 2, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(singleton[0]?.documentContext).toMatchObject({
      ambiguityReasons: [],
      observations: [{ metric: "Reviewer", rawValue: "Alex Rivera" }]
    });
    expect(multiRow).toHaveLength(2);
    expect(multiRow.every((chunk) =>
      chunk.documentContext?.ambiguityReasons.includes("missing_header"))).toBe(true);
  });

  it("keeps a short logical section together across a page boundary with deterministic context", () => {
    const normalized = document([
      block(0, "Guide", { type: "title" }),
      block(1, "first page", { headingPath: ["Guide", "Setup"] }),
      block(2, "second page", {
        headingPath: ["Guide", "Setup"],
        page: 2,
        pageEnd: 2
      })
    ]);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toMatchObject({
      headingPath: ["Guide", "Setup"],
      page: 1,
      pageEnd: 2,
      sourceBlockStart: 1,
      sourceBlockEnd: 2,
      text: "first page\n\nsecond page"
    });
    // Language-neutral embedding format (FR-12): source title then heading
    // path only; page location stays structured metadata outside the dense
    // text.
    expect(chunks[1]!.contextPrefix).toBe("runbook.pdf\nGuide / Setup");
    expect(chunks[1]!.contextPrefix).not.toMatch(/Source:|Title:|Section:|Location:|Evidence layout/u);
    expect(chunks[1]!.embeddingText).toBe(`${chunks[1]!.contextPrefix}\n\n${chunks[1]!.text}`);
  });

  it("splits long prose at token boundaries with bounded overlap and deterministic hashes", () => {
    const long = Array.from({ length: 1_000 }, (_, index) => `word-${index}`).join(" ");
    const normalized = document([block(0, long)]);
    const first = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const second = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(first.length).toBeGreaterThan(2);
    expect(first.every((chunk) => chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS)).toBe(true);
    expect(first.map((chunk) => chunk.embeddingTextHash)).toEqual(
      second.map((chunk) => chunk.embeddingTextHash)
    );
    expect(first[1]!.text.split(/\s+/u).some((word) => first[0]!.text.endsWith(word))).toBe(true);
  });

  it("enforces hard token and character bounds even without whitespace", () => {
    const punctuation = chunkKnowledgeDocument({
      document: document([block(0, "!".repeat(1_000))]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    expect(punctuation.length).toBeGreaterThan(2);
    expect(punctuation.every((chunk) => chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS))
      .toBe(true);

    const longWord = chunkKnowledgeDocument({
      document: document([block(0, "a".repeat(KNOWLEDGE_CHUNK_MAX_CHARS + 100))]),
      maxChunks: 40,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    expect(longWord.length).toBeGreaterThan(2);
    expect(longWord.every((chunk) => chunk.text.length <= KNOWLEDGE_CHUNK_MAX_CHARS))
      .toBe(true);
  });

  it("advances a chunk-boundary search that probes inside a surrogate pair", () => {
    // Five UTF-16 code units make the binary-search midpoint land between the
    // two code units of the final mathematical symbol. The safe boundary may
    // move left, but the raw probe must still advance on the next iteration.
    const text = "1A\u2003\u{1D54F}";
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, text)]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe(text);
  });

  it("keeps table rows intact and carries exact block provenance", () => {
    const cells = Array.from({ length: 40 }, (_, row) => [
      { column: 0, columnSpan: 1, row, rowSpan: 1, text: `row-${row}` },
      { column: 1, columnSpan: 1, row, rowSpan: 1, text: "value ".repeat(20).trim() }
    ]).flat();
    const normalized = document([block(0, "", {
      isTable: true,
      table: { cells, columnCount: 2, rowCount: 40 },
      text: cells.reduce((rows, cell) => {
        rows[cell.row] ??= [];
        rows[cell.row]![cell.column] = cell.text;
        return rows;
      }, [] as string[][]).map((row) => row.join("\t")).join("\n"),
      type: "table"
    })]);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 50,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks).toHaveLength(40);
    expect(chunks.every((chunk) => chunk.sourceBlockStart === 0 && chunk.sourceBlockEnd === 0))
      .toBe(true);
    expect(chunks[0]!.text).toBe(`row-0\t${"value ".repeat(20).trim()}`);
    expect(chunks.every((chunk) => chunk.text.includes("\t") && !chunk.text.includes("\n")))
      .toBe(true);
    expect(chunks.every((chunk) =>
      ["table_row", "table_row_projection"].includes(chunk.layoutKind))).toBe(true);
    expect(chunks.map((chunk) => chunk.documentContext?.locator).every((locator, rowIndex) =>
      locator?.kind === "table_row" && locator.rowIndex === rowIndex)).toBe(true);
  });

  it("repeats a detected header and preserves its row lineage after a page-style repetition", () => {
    const rows = [
      ["Metric", "Date", "Actual", "Reference", "Unit"],
      ["Glucose", "2026-08-20", "5.4", "3.9–6.1", "mmol/L"],
      ["Metric", "Date", "Actual", "Reference", "Unit"],
      ["Hemoglobin", "2026-08-21", "142", "120–160", "g/L"]
    ];
    const cells = rows.flatMap((row, rowIndex) => row.map((text, column) => ({
      column,
      columnSpan: 1,
      row: rowIndex,
      rowSpan: 1,
      text
    })));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, rows.map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        table: { cells, columnCount: 5, rowCount: 4 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      rows[0]!.join("\t"),
      `${rows[0]!.join("\t")}\n${rows[1]!.join("\t")}`,
      rows[2]!.join("\t"),
      `${rows[2]!.join("\t")}\n${rows[3]!.join("\t")}`
    ]);
    expect(chunks[3]!.documentContext?.locator).toMatchObject({
      headerLineage: expect.arrayContaining([
        { columnEnd: 2, columnStart: 2, rowIndex: 2, text: "Actual" },
        { columnEnd: 3, columnStart: 3, rowIndex: 2, text: "Reference" }
      ]),
      kind: "table_row",
      rowIndex: 3,
      rowKind: "data"
    });
    expect(chunks[3]!.documentContext?.observations.find((observation) =>
      observation.origin.kind === "table_cell" && observation.origin.columnStart === 2))
      .toMatchObject({
        date: "2026-08-21",
        metric: "Hemoglobin",
        role: "observation",
        unit: "g/L"
      });
  });

  it("carries an exact textual header across page-separated table fragments", () => {
    const header = ["Category", "Lower band", "Upper band"];
    const firstRows = [
      header,
      ["Alpha", "low", "high"],
      ["Beta", "medium", "very high"]
    ];
    const secondRows = [
      header,
      ["Gamma", "minimal", "maximal"]
    ];
    const tableBlock = (index: number, page: number, rows: readonly (readonly string[])[]) => {
      const cells = rows.flatMap((row, rowIndex) => row.map((text, column) => ({
        column,
        columnSpan: 1,
        row: rowIndex,
        rowSpan: 1,
        text
      })));
      return block(index, rows.map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        page,
        pageEnd: page,
        table: { cells, columnCount: 3, rowCount: rows.length },
        type: "table"
      });
    };
    const normalized = document([
      tableBlock(0, 1, firstRows),
      tableBlock(1, 2, secondRows)
    ]);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      header.join("\t"),
      `${header.join("\t")}\n${firstRows[1]!.join("\t")}`,
      `${header.join("\t")}\n${firstRows[2]!.join("\t")}`,
      header.join("\t"),
      `${header.join("\t")}\n${secondRows[1]!.join("\t")}`
    ]);
    expect(chunks.filter((chunk) => chunk.documentContext?.locator.kind === "table_row" &&
      chunk.documentContext.locator.rowKind === "data")
      .every((chunk) => chunk.documentContext?.locator.kind === "table_row" &&
        chunk.documentContext.locator.headerLineage.length === 3)).toBe(true);

    const legacy = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: 7,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    expect(legacy.map((chunk) => chunk.text)).toEqual([...firstRows, ...secondRows]
      .map((row) => row.join("\t")));
    expect(legacy.every((chunk) => chunk.documentContext?.locator.kind === "table_row" &&
      chunk.documentContext.locator.headerLineage.length === 0)).toBe(true);
  });

  it("does not invent a textual header for unrelated page-separated tables", () => {
    const rowsByPage = [
      [["Alpha", "low"], ["Beta", "high"]],
      [["Gamma", "minimal"], ["Delta", "maximal"]]
    ];
    const blocks = rowsByPage.map((rows, index) => {
      const cells = rows.flatMap((row, rowIndex) => row.map((text, column) => ({
        column,
        columnSpan: 1,
        row: rowIndex,
        rowSpan: 1,
        text
      })));
      return block(index, rows.map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        page: index + 1,
        pageEnd: index + 1,
        table: { cells, columnCount: 2, rowCount: rows.length },
        type: "table"
      });
    });
    const chunks = chunkKnowledgeDocument({
      document: document(blocks),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks.every((chunk) => !chunk.text.includes("\n") &&
      chunk.documentContext?.locator.kind === "table_row" &&
      chunk.documentContext.locator.headerLineage.length === 0)).toBe(true);
  });

  it("recognizes a conservative dated-series header with year and quarter columns", () => {
    const rows = [
      ["Metric", "2024", "2025", "Q1 2026", "2025/Q1 2026"],
      ["Revenue", "100", "120", "31", "40"]
    ];
    const cells = rows.flatMap((row, rowIndex) => row.map((text, column) => ({
      column,
      columnSpan: 1,
      row: rowIndex,
      rowSpan: 1,
      text
    })));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, rows.map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        table: { cells, columnCount: 5, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 10,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      rows[0]!.join("\t"),
      `${rows[0]!.join("\t")}\n${rows[1]!.join("\t")}`
    ]);
    expect(chunks[0]!.documentContext?.locator).toMatchObject({
      kind: "table_row",
      rowIndex: 0,
      rowKind: "header"
    });
    expect(chunks[1]!.documentContext?.locator).toMatchObject({
      headerLineage: expect.arrayContaining([
        expect.objectContaining({ columnStart: 1, text: "2024" }),
        expect.objectContaining({ columnStart: 3, text: "Q1 2026" }),
        expect.objectContaining({ columnStart: 4, text: "2025/Q1 2026" })
      ]),
      kind: "table_row",
      rowIndex: 1,
      rowKind: "data"
    });
    const observationAt = (columnStart: number) => chunks[1]!.documentContext?.observations
      .find((observation) => observation.origin.kind === "table_cell" &&
        observation.origin.columnStart === columnStart);
    expect(observationAt(1)).toMatchObject({
      effectiveFrom: "2024-01-01",
      effectiveTo: "2024-12-31",
      metric: "Revenue",
      normalizedValue: "100",
      role: "observation"
    });
    expect(observationAt(2)).toMatchObject({
      effectiveFrom: "2025-01-01",
      effectiveTo: "2025-12-31",
      metric: "Revenue",
      normalizedValue: "120",
      role: "observation"
    });
    expect(observationAt(3)).toMatchObject({
      effectiveFrom: "2026-01-01",
      effectiveTo: "2026-03-31",
      metric: "Revenue",
      normalizedValue: "31",
      role: "observation"
    });
    expect(observationAt(4)).toMatchObject({
      effectiveFrom: null,
      effectiveTo: null,
      role: "metadata"
    });
  });

  it.each(["Көрсеткіш", "Показник", "Показатељ"])(
    "detects the typed dated-series shape without a ru/en label vocabulary: %s",
    (label) => {
      const rows = [
        [label, "2024", "Q1 2025"],
        ["Revenue", "100", "25"]
      ];
      const cells = rows.flatMap((row, rowIndex) => row.map((text, column) => ({
        column,
        columnSpan: 1,
        row: rowIndex,
        rowSpan: 1,
        text
      })));
      const chunks = chunkKnowledgeDocument({
        document: document([block(0, rows.map((row) => row.join("\t")).join("\n"), {
          isTable: true,
          table: { cells, columnCount: 3, rowCount: 2 },
          type: "table"
        })]),
        maxChunks: 10,
        profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
        tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
      });

      expect(chunks[0]?.documentContext?.locator).toMatchObject({
        kind: "table_row",
        rowIndex: 0,
        rowKind: "header"
      });
      expect(chunks[1]?.documentContext?.locator).toMatchObject({
        headerLineage: expect.arrayContaining([
          expect.objectContaining({ columnStart: 1, text: "2024" }),
          expect.objectContaining({ columnStart: 2, text: "Q1 2025" })
        ]),
        kind: "table_row",
        rowIndex: 1,
        rowKind: "data"
      });
    }
  );

  it("does not promote an ordinary data row containing a year to table header", () => {
    const rows = [
      ["Invoice", "2024", "100"],
      ["Order", "2025", "200"]
    ];
    const cells = rows.flatMap((row, rowIndex) => row.map((text, column) => ({
      column,
      columnSpan: 1,
      row: rowIndex,
      rowSpan: 1,
      text
    })));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, rows.map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        table: { cells, columnCount: 3, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 10,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual(rows.map((row) => row.join("\t")));
    expect(chunks.every((chunk) => chunk.documentContext?.locator.kind === "table_row" &&
      chunk.documentContext.locator.rowKind === "data" &&
      chunk.documentContext.locator.headerLineage.length === 0)).toBe(true);
  });

  it.each([
    ["Dose", "5mg", "5", "mg"],
    ["Temperature", "37°C", "37", "°C"],
    ["Count", "1e3mg", "1000", "mg"]
  ])("detects a header before attached/scientific evidence %s = %s", (
    metric,
    rawValue,
    normalizedValue,
    unit
  ) => {
    const rows = [["Metric", "Actual"], [metric!, rawValue!]];
    const cells = rows.flatMap((row, rowIndex) => row.map((text, column) => ({
      column,
      columnSpan: 1,
      row: rowIndex,
      rowSpan: 1,
      text
    })));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, rows.map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        table: { cells, columnCount: 2, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 10,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const valueObservation = chunks[1]?.documentContext?.observations.find((observation) =>
      observation.origin.kind === "table_cell" && observation.origin.columnStart === 1);

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Metric\tActual",
      `Metric\tActual\n${metric}\t${rawValue}`
    ]);
    expect(chunks[0]?.documentContext?.locator).toMatchObject({
      kind: "table_row",
      rowIndex: 0,
      rowKind: "header"
    });
    expect(chunks[1]?.documentContext?.locator).toMatchObject({
      kind: "table_row",
      rowIndex: 1,
      rowKind: "data"
    });
    expect(valueObservation).toMatchObject({
      ambiguityReasons: [],
      metric,
      normalizedValue,
      role: "observation",
      unit
    });
  });

  it("projects an oversized row by bounded column groups with one stable original-row identity", () => {
    const headers = [
      "Subject", "Date", "Actual", "Reference", "Unit", "Target", "Threshold", "Comment"
    ];
    const values = Array.from({ length: 8 }, (_, column) =>
      `Value ${column} ${"word ".repeat(90).trim()}`);
    const cells = [headers, values].flatMap((row, rowIndex) => row.map((text, column) => ({
      column,
      columnSpan: 1,
      row: rowIndex,
      rowSpan: 1,
      text
    })));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, [headers, values].map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        table: { cells, columnCount: 8, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const projections = chunks.filter((chunk) =>
      chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 1);

    expect(projections.length).toBeGreaterThan(1);
    expect(projections.every((chunk) =>
      chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS && chunk.text.includes("\n"))).toBe(true);
    expect(new Set(projections.map((chunk) => {
      const locator = chunk.documentContext!.locator;
      return locator.kind === "table_row_projection" ? locator.rowId : null;
    })).size).toBe(1);
    const columnRanges = projections.map((chunk) => {
      const locator = chunk.documentContext!.locator;
      return locator.kind === "table_row_projection"
        ? [locator.columnStart, locator.columnEnd]
        : null;
    });
    expect(columnRanges[0]?.[0]).toBe(0);
    expect(columnRanges.at(-1)?.[1]).toBe(7);
    expect(columnRanges.every((range, index) => index === 0 ||
      range?.[0] === (columnRanges[index - 1]?.[1] ?? -1) + 1)).toBe(true);
    const headerLineages = projections.map((chunk) => {
      const locator = chunk.documentContext!.locator;
      return locator.kind === "table_row_projection" ? locator.headerLineage : [];
    });
    expect(new Set(headerLineages.flatMap((headers) =>
      headers.map((header) => header.rowIndex)))).toEqual(new Set([0]));
    expect(new Set(headerLineages.map((headers) => JSON.stringify(headers))).size)
      .toBe(projections.length);
    expect(isCompleteKnowledgeTableRowProjectionSequence(projections.flatMap((chunk) => {
      const locator = chunk.documentContext?.locator;
      return locator?.kind === "table_row_projection" ? [locator] : [];
    }))).toBe(true);
  });

  it("splits one oversized cell into an ordered repeated-column projection group", () => {
    const header = "Narrative";
    const value = ["42", ...Array.from({ length: 649 }, (_, index) => `value${index}`)]
      .join(" ");
    const cells = [header, value].map((text, row) => ({
      column: 0,
      columnSpan: 1,
      row,
      rowSpan: 1,
      text
    }));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, `${header}\n${value}`, {
        isTable: true,
        table: { cells, columnCount: 1, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: 5
    });
    const projections = chunks.filter((chunk) =>
      chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 1);
    const locators = projections.flatMap((chunk) => {
      const locator = chunk.documentContext?.locator;
      return locator?.kind === "table_row_projection" ? [locator] : [];
    });

    expect(projections).toHaveLength(2);
    expect(locators.map((locator) => [locator.columnStart, locator.columnEnd])).toEqual([
      [0, 0],
      [0, 0]
    ]);
    expect(locators.map((locator) => locator.projectionIndex)).toEqual([0, 1]);
    expect(isCompleteKnowledgeTableRowProjectionSequence(locators)).toBe(true);
    expect(projections.every((chunk) => chunk.text.startsWith(`${header}\n`) &&
      chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS)).toBe(true);
    expect(projections.map((chunk) => chunk.text.slice(header.length + 1)).join(" ")).toBe(value);
  });

  it("keeps one merged-cell span intact across projection boundaries", () => {
    const headers = ["Group", "Detail", "Other", "Unit"];
    const mergedValue = ["42", ...Array.from({ length: 449 }, (_, index) => `value${index}`)]
      .join(" ");
    const trailingValue = "tail 7";
    const cells = [
      ...headers.map((text, column) => ({
        column,
        columnSpan: 1,
        row: 0,
        rowSpan: 1,
        text
      })),
      { column: 0, columnSpan: 2, row: 1, rowSpan: 1, text: mergedValue },
      { column: 2, columnSpan: 2, row: 1, rowSpan: 1, text: trailingValue }
    ];
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, `${headers.join("\t")}\n${mergedValue}\t\t${trailingValue}`, {
        isTable: true,
        table: { cells, columnCount: 4, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: 5
    });
    const projections = chunks.filter((chunk) =>
      chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 1);
    const locators = projections.flatMap((chunk) => {
      const locator = chunk.documentContext?.locator;
      return locator?.kind === "table_row_projection" ? [locator] : [];
    });
    const firstCellPayloads = projections
      .filter((_, index) => locators[index]?.columnStart === 0)
      .map((chunk) => chunk.text.slice(chunk.text.indexOf("\n") + 1));
    const trailingPayloads = projections
      .filter((_, index) => locators[index]?.columnStart === 2)
      .map((chunk) => chunk.text.slice(chunk.text.indexOf("\n") + 1));

    expect(locators.map((locator) => [locator.columnStart, locator.columnEnd])).toEqual([
      [0, 1],
      [0, 1],
      [2, 3]
    ]);
    expect(isCompleteKnowledgeTableRowProjectionSequence(locators)).toBe(true);
    expect(firstCellPayloads.join(" ")).toBe(mergedValue);
    expect(trailingPayloads).toEqual([trailingValue]);
  });

  it("carries a row-spanning identity into every atomic table row", () => {
    const headers = ["Group", "Field", "Value"];
    const cells = [
      ...headers.map((text, column) => ({
        column,
        columnSpan: 1,
        row: 0,
        rowSpan: 1,
        text
      })),
      { column: 0, columnSpan: 1, row: 1, rowSpan: 3, text: "Alpha" },
      { column: 1, columnSpan: 1, row: 1, rowSpan: 1, text: "Identifier" },
      { column: 2, columnSpan: 1, row: 1, rowSpan: 1, text: "A-1" },
      { column: 1, columnSpan: 1, row: 2, rowSpan: 1, text: "Serial" },
      { column: 2, columnSpan: 1, row: 2, rowSpan: 1, text: "S-2" },
      { column: 1, columnSpan: 1, row: 3, rowSpan: 1, text: "Expiry" },
      { column: 2, columnSpan: 1, row: 3, rowSpan: 1, text: "2040-01-15" }
    ];
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, [
        headers.join("\t"),
        "Alpha\tIdentifier\tA-1",
        "\tSerial\tS-2",
        "\tExpiry\t2040-01-15"
      ].join("\n"), {
        isTable: true,
        table: { cells, columnCount: 3, rowCount: 4 },
        type: "table"
      })]),
      maxChunks: 10,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Group\tField\tValue",
      "Group\tField\tValue\nAlpha\tIdentifier\tA-1",
      "Group\tField\tValue\nAlpha\tSerial\tS-2",
      "Group\tField\tValue\nAlpha\tExpiry\t2040-01-15"
    ]);
    expect(chunks[3]?.documentContext?.observations.map(({ rawValue }) => rawValue))
      .toEqual(["Alpha", "Expiry", "2040-01-15"]);
  });

  it("degrades instead of duplicating a merged header across incompatible cell boundaries", () => {
    const header = "Merged header";
    const value = ["42", ...Array.from({ length: 449 }, (_, index) => `value${index}`)]
      .join(" ");
    const cells = [
      { column: 0, columnSpan: 2, row: 0, rowSpan: 1, text: header },
      { column: 0, columnSpan: 1, row: 1, rowSpan: 1, text: value },
      { column: 1, columnSpan: 1, row: 1, rowSpan: 1, text: "second 7" }
    ];
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, `${header}\t\n${value}\tsecond 7`, {
        isTable: true,
        table: { cells, columnCount: 2, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const dataChunks = chunks.filter((chunk) => chunk.documentContext === null);

    expect(dataChunks.length).toBeGreaterThan(0);
    expect(dataChunks.every((chunk) => chunk.documentContext === null &&
      chunk.layoutKind === "table_ambiguous")).toBe(true);
    expect(chunks.some((chunk) => chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 1)).toBe(false);
    expect(dataChunks.at(-1)!.text).toContain("second 7");
  });

  it("projects sparse oversized rows across leading, internal, and trailing blank columns", () => {
    const headers = ["Unused", "Narrative", "Blank", "Result", "Trailing"];
    const value = ["42", ...Array.from({ length: 449 }, (_, index) => `value${index}`)]
      .join(" ");
    const cells = [
      ...headers.map((text, column) => ({
        column,
        columnSpan: 1,
        row: 0,
        rowSpan: 1,
        text
      })),
      { column: 1, columnSpan: 1, row: 1, rowSpan: 1, text: value },
      { column: 3, columnSpan: 1, row: 1, rowSpan: 1, text: "complete 7" }
    ];
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, `${headers.join("\t")}\n\t${value}\t\tcomplete 7\t`, {
        isTable: true,
        table: { cells, columnCount: 5, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: 5
    });
    const projections = chunks.filter((chunk) =>
      chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 1);
    const locators = projections.flatMap((chunk) => {
      const locator = chunk.documentContext?.locator;
      return locator?.kind === "table_row_projection" ? [locator] : [];
    });

    expect(locators.map((locator) => [locator.columnStart, locator.columnEnd])).toEqual([
      [0, 1],
      [0, 1],
      [2, 4]
    ]);
    expect(isCompleteKnowledgeTableRowProjectionSequence(locators)).toBe(true);
    expect(projections.slice(0, 2).map((chunk) =>
      chunk.text.slice(chunk.text.indexOf("\n") + 1)).join(" ")).toBe(value);
    expect(projections[2]!.text.slice(projections[2]!.text.indexOf("\n") + 1))
      .toBe("\tcomplete 7");
  });

  it("keeps one bounded sparse projection when trailing header-only columns exceed the row budget", () => {
    const headers = Array.from(
      { length: 11 },
      () => Array<string>(25).fill("heading").join(" ")
    );
    const values = [
      Array<string>(30).fill("value").join(" "),
      Array<string>(30).fill("value").join(" "),
      ...Array<string>(9).fill("")
    ];
    const observations = ["2026-01-01", ...Array<string>(10).fill("")];
    const rows = [headers, values, observations];
    const cells = rows.flatMap((row, rowIndex) => row.map((text, column) => ({
      column,
      columnSpan: 1,
      row: rowIndex,
      rowSpan: 1,
      text
    })));

    const chunks = chunkKnowledgeDocument({
      document: document([block(0, rows.map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        table: { cells, columnCount: 11, rowCount: 3 },
        type: "table"
      })]),
      maxChunks: 100,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const projections = chunks.filter((chunk) =>
      chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 2);
    const locators = projections.flatMap((chunk) => {
      const locator = chunk.documentContext?.locator;
      return locator?.kind === "table_row_projection" ? [locator] : [];
    });

    expect(projections).toHaveLength(1);
    expect(locators[0]).toMatchObject({
      columnEnd: 1,
      columnStart: 0,
      projectionCount: 1,
      projectionIndex: 0,
      rowIndex: 2
    });
    expect(isCompleteKnowledgeTableRowProjectionSequence(locators)).toBe(true);
    expect(projections[0]!.text).toContain(observations[0]);
  });

  it.each([4_097, 7_003, 12_000])(
    "splits a %i-character low-token cell without losing source text",
    (valueLength) => {
      const header = "Narrative";
      const value = `42 ${"x".repeat(valueLength - 3)}`;
      const cells = [header, value].map((text, row) => ({
        column: 0,
        columnSpan: 1,
        row,
        rowSpan: 1,
        text
      }));
      const chunks = chunkKnowledgeDocument({
        document: document([block(0, `${header}\n${value}`, {
          isTable: true,
          table: { cells, columnCount: 1, rowCount: 2 },
          type: "table"
        })]),
        maxChunks: 20,
        profileVersion: 5
      });
      const projections = chunks.filter((chunk) =>
        chunk.documentContext?.locator.kind === "table_row_projection" &&
        chunk.documentContext.locator.rowIndex === 1);
      const locators = projections.flatMap((chunk) => {
        const locator = chunk.documentContext?.locator;
        return locator?.kind === "table_row_projection" ? [locator] : [];
      });

      expect(value).toHaveLength(valueLength);
      expect(projections.length).toBeGreaterThan(1);
      expect(isCompleteKnowledgeTableRowProjectionSequence(locators)).toBe(true);
      expect(projections.every((chunk) => chunk.text.length <= KNOWLEDGE_CHUNK_MAX_CHARS &&
        chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS &&
        chunk.documentContext!.observations.every((observation) =>
          observation.rawValue.length <= KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS))).toBe(true);
      expect(projections.map((chunk) => chunk.text.slice(header.length + 1)).join(""))
        .toBe(value);
    }
  );

  it("omits an oversized authoritative header while retaining its full source text", () => {
    const header = `${"h".repeat(1_023)}😀tail`;
    const value = ["42", ...Array.from({ length: 649 }, (_, index) => `value${index}`)]
      .join(" ");
    const cells = [header, value].map((text, row) => ({
      column: 0,
      columnSpan: 1,
      row,
      rowSpan: 1,
      text
    }));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, `${header}\n${value}`, {
        isTable: true,
        table: { cells, columnCount: 1, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 20,
      profileVersion: 5
    });
    const projections = chunks.filter((chunk) =>
      chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 1);
    const headerLineage = projections.flatMap((chunk) => {
      const locator = chunk.documentContext?.locator;
      return locator?.kind === "table_row_projection" ? locator.headerLineage : [];
    });

    expect(projections).toHaveLength(2);
    expect(header.length).toBeGreaterThan(KNOWLEDGE_TABLE_HEADER_LINEAGE_MAX_CHARS);
    expect(projections.every((chunk) => chunk.text.startsWith(`${header}\n`))).toBe(true);
    expect(headerLineage).toEqual([]);
    expect(projections.every((chunk) =>
      chunk.documentContext!.ambiguityReasons.includes("missing_header"))).toBe(true);
  });

  it("degrades a data row when its full source header cannot fit any bounded projection", () => {
    const header = Array.from({ length: 401 }, (_, index) => `header${index}`).join(" ");
    const value = ["42", ...Array.from({ length: 449 }, (_, index) => `value${index}`)]
      .join(" ");
    const cells = [header, value].map((text, row) => ({
      column: 0,
      columnSpan: 1,
      row,
      rowSpan: 1,
      text
    }));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, `${header}\n${value}`, {
        isTable: true,
        table: { cells, columnCount: 1, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 100,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const degraded = chunks.filter((chunk) => chunk.documentContext === null);

    expect(degraded.length).toBeGreaterThan(1);
    expect(degraded.every((chunk) =>
      chunk.layoutKind === "table_ambiguous" &&
      chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS)).toBe(true);
    expect(chunks.some((chunk) => chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 1)).toBe(false);
  });

  it("degrades a row whose complete UTF-8 projection group exceeds the dispatch budget", () => {
    const header = "Narrative";
    const value = `42 ${"界".repeat(11_500)}`;
    const cells = [header, value].map((text, row) => ({
      column: 0,
      columnSpan: 1,
      row,
      rowSpan: 1,
      text
    }));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, `${header}\n${value}`, {
        isTable: true,
        table: { cells, columnCount: 1, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 100,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const dataChunks = chunks.filter((chunk) => chunk.text.includes("42"));

    expect(Buffer.byteLength(`${header}\n${value}`, "utf8"))
      .toBeGreaterThan(KNOWLEDGE_TABLE_ROW_MAX_UTF8_BYTES);
    expect(dataChunks.length).toBeGreaterThan(0);
    expect(dataChunks.every((chunk) => chunk.documentContext === null &&
      chunk.layoutKind === "table_ambiguous")).toBe(true);
  });

  it("degrades rows beyond the atomic read cap without publishing unreachable row locators", () => {
    const headers = Array.from({ length: 9 }, (_, column) => `Header${column}`);
    const values = Array.from({ length: 9 }, (_, column) =>
      [`column${column}`, String(column + 1), ...Array<string>(397).fill("word")].join(" "));
    const cells = [headers, values].flatMap((row, rowIndex) => row.map((text, column) => ({
      column,
      columnSpan: 1,
      row: rowIndex,
      rowSpan: 1,
      text
    })));
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, [headers, values].map((row) => row.join("\t")).join("\n"), {
        isTable: true,
        table: { cells, columnCount: 9, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 100,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const degraded = chunks.filter((chunk) => chunk.documentContext === null);

    expect(degraded.length).toBeGreaterThan(KNOWLEDGE_TABLE_ROW_MAX_PROJECTIONS);
    expect(degraded.every((chunk) =>
      chunk.layoutKind === "table_ambiguous" &&
      chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS)).toBe(true);
    expect(chunks.some((chunk) => chunk.documentContext?.locator.kind === "table_row_projection" &&
      chunk.documentContext.locator.rowIndex === 1)).toBe(false);
  });

  it("retains immutable profile 3 rows without header repetition or typed document context", () => {
    const cells = [
      { column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "Metric" },
      { column: 1, columnSpan: 1, row: 0, rowSpan: 1, text: "Actual" },
      { column: 0, columnSpan: 1, row: 1, rowSpan: 1, text: "Alpha" },
      { column: 1, columnSpan: 1, row: 1, rowSpan: 1, text: "30" }
    ];
    const chunks = chunkKnowledgeDocument({
      document: document([block(0, "Metric\tActual\nAlpha\t30", {
        isTable: true,
        table: { cells, columnCount: 2, rowCount: 2 },
        type: "table"
      })]),
      maxChunks: 10,
      profileVersion: 3
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual(["Metric\tActual", "Alpha\t30"]);
    expect(chunks.every((chunk) => chunk.documentContext === null)).toBe(true);
    expect(chunks.every((chunk) =>
      ["table_row", "table_row_projection"].includes(chunk.layoutKind))).toBe(true);
  });

  it("chunks only parser-linked field pairs atomically and isolates competing cells", () => {
    const normalized = {
      ...document([block(0, "Form")]),
      fieldGroups: [{
        boundingBoxes: [],
        cells: [
          { boundingBoxes: [], confidence: 0.9, id: 1, itemRef: null, label: "key" as const, order: 0, originalText: "Actual", text: "Actual" },
          { boundingBoxes: [], confidence: 0.9, id: 2, itemRef: null, label: "value" as const, order: 1, originalText: "5,4", text: "5,4" },
          { boundingBoxes: [], confidence: null, id: 3, itemRef: null, label: "key" as const, order: 2, originalText: "Reference", text: "Reference" },
          { boundingBoxes: [], confidence: null, id: 4, itemRef: null, label: "key" as const, order: 3, originalText: "Target", text: "Target" },
          { boundingBoxes: [], confidence: null, id: 5, itemRef: null, label: "value" as const, order: 4, originalText: "6,0", text: "6,0" }
        ],
        confidence: 0.8,
        contentHash: "f".repeat(64),
        id: "fg_form_1",
        kind: "key_value" as const,
        links: [
          { confidence: 0.8, label: "to_value" as const, order: 0, sourceCellId: 1, targetCellId: 2 },
          { confidence: null, label: "to_value" as const, order: 1, sourceCellId: 3, targetCellId: 5 },
          { confidence: null, label: "to_value" as const, order: 2, sourceCellId: 4, targetCellId: 5 }
        ],
        locator: { kind: "page" as const, pageEnd: 1, pageStart: 1 },
        order: 0,
        readingOrder: 0,
        sourceRef: "#/key_value_items/0"
      }]
    };
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Actual\t5,4",
      "Reference",
      "Target",
      "6,0",
      "Form"
    ]);
    expect(chunks[0]!.documentContext).toMatchObject({
      locator: { kind: "field_pair", labelCellId: 1, valueCellId: 2 },
      observations: [{ normalizedValue: "5.4", role: "observation" }]
    });
    expect(chunks.slice(1, 4).every((chunk) =>
      chunk.documentContext?.locator.kind === "field_ambiguous" &&
      chunk.documentContext.ambiguityReasons.includes("competing_pair"))).toBe(true);
    expect(chunks.slice(0, 4).every((chunk) =>
      chunk.layoutKind === (chunk.documentContext?.locator.kind === "field_pair"
        ? "field_pair"
        : "field_ambiguous"))).toBe(true);
  });

  it("uses the heading active before a field-group insertion point", () => {
    const normalized = {
      ...document([
        block(0, "Section A", { headingPath: ["A"], type: "heading" }),
        block(1, "Section B", { headingPath: ["B"], type: "heading" })
      ]),
      fieldGroups: [{
        boundingBoxes: [],
        cells: [
          { boundingBoxes: [], confidence: 0.9, id: 1, itemRef: null, label: "key" as const, order: 0, originalText: "Actual", text: "Actual" },
          { boundingBoxes: [], confidence: 0.9, id: 2, itemRef: null, label: "value" as const, order: 1, originalText: "5", text: "5" }
        ],
        confidence: 0.9,
        contentHash: "a".repeat(64),
        id: "fg_between_a_and_b",
        kind: "key_value" as const,
        links: [{
          confidence: 0.9,
          label: "to_value" as const,
          order: 0,
          sourceCellId: 1,
          targetCellId: 2
        }],
        locator: { kind: "page" as const, pageEnd: 1, pageStart: 1 },
        order: 0,
        readingOrder: 1,
        sourceRef: "#/key_value_items/0"
      }]
    };
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const fieldChunk = chunks.find((chunk) =>
      chunk.sourceBlockIds.includes("fg_between_a_and_b"));

    expect(fieldChunk).toMatchObject({
      headingPath: ["A"],
      text: "Actual\t5"
    });
    expect(fieldChunk?.contextPrefix).toContain("\nA");
    expect(fieldChunk?.contextPrefix).not.toContain("\nB");
  });

  it("keeps a 4097-character form value searchable as bounded ambiguous cell evidence", () => {
    const value = `42 ${"x".repeat(4_094)}`;
    const chunks = chunkKnowledgeDocument({
      document: fieldDocument(value),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const fieldChunks = chunks.filter((chunk) =>
      chunk.sourceBlockIds.includes("fg_overflow_1"));
    const valueChunks = fieldChunks.filter((chunk) =>
      chunk.documentContext?.locator.kind === "field_ambiguous" &&
      chunk.documentContext.locator.cellId === 2);

    expect(value).toHaveLength(KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS + 1);
    expect(valueChunks.length).toBeGreaterThan(1);
    expect(valueChunks.map((chunk) => chunk.text).join("")).toBe(value);
    expect(fieldChunks.every((chunk) =>
      chunk.documentContext?.locator.kind === "field_ambiguous" &&
      chunk.documentContext.ambiguityReasons.includes("ambiguous_role") &&
      chunk.documentContext.observations.every((observation) =>
        observation.rawValue.length <= KNOWLEDGE_TABLE_CONTEXT_CELL_MAX_CHARS) &&
      chunk.layoutKind === "field_ambiguous")).toBe(true);
    expect(fieldChunks.every((chunk) => decodeKnowledgeDocumentContext(
      JSON.parse(JSON.stringify(chunk.documentContext))
    ) !== null)).toBe(true);
    expect(fieldChunks.some((chunk) =>
      chunk.documentContext?.locator.kind === "field_pair")).toBe(false);
  });

  it("splits a large-token form pair into searchable ambiguous cell chunks", () => {
    const value = Array.from({ length: 650 }, (_, index) => `value${index}`).join(" ");
    const chunks = chunkKnowledgeDocument({
      document: fieldDocument(value),
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const fieldChunks = chunks.filter((chunk) =>
      chunk.sourceBlockIds.includes("fg_overflow_1"));
    const valueChunks = fieldChunks.filter((chunk) =>
      chunk.documentContext?.locator.kind === "field_ambiguous" &&
      chunk.documentContext.locator.cellId === 2);

    expect(valueChunks.length).toBeGreaterThan(1);
    expect(fieldChunks.every((chunk) =>
      chunk.documentContext?.locator.kind === "field_ambiguous" &&
      chunk.tokenCount <= KNOWLEDGE_CHUNK_MAX_TOKENS)).toBe(true);
    expect(fieldChunks.some((chunk) => chunk.text === "Narrative")).toBe(true);
    expect(valueChunks[0]!.text).toContain("value0");
    expect(valueChunks.at(-1)!.text).toContain("value649");
    expect(valueChunks.map((chunk) => chunk.text).join(" ")).toBe(value);
  });

  it("retains the immutable profile 2 table projection", () => {
    const cells = [
      { column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "Metric" },
      { column: 1, columnSpan: 1, row: 0, rowSpan: 1, text: "Value" },
      { column: 0, columnSpan: 1, row: 1, rowSpan: 1, text: "Alpha" },
      { column: 1, columnSpan: 1, row: 1, rowSpan: 1, text: "30" }
    ];
    const normalized = document([block(0, "Metric\tValue\nAlpha\t30", {
      isTable: true,
      table: { cells, columnCount: 2, rowCount: 2 },
      type: "table"
    })]);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 10,
      profileVersion: 2
    });

    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe("Metric\tValue\nAlpha\t30");
    expect(chunks[0]!.contextPrefix).not.toContain("Evidence layout:");
  });

  it("reconstructs only stable positioned rows and keeps every reconstructed row atomic", () => {
    const boxes = [10, 30, 50].flatMap((top, row) => [{
      bottom: top + 10,
      coordinateOrigin: "top_left" as const,
      left: 10,
      page: 1,
      right: 90,
      top
    }, {
      bottom: top + 10,
      coordinateOrigin: "top_left" as const,
      left: 140 - row * 10,
      page: 1,
      right: 180,
      top
    }]);
    const normalized = document(boxes.map((box, index) => block(
      index,
      index % 2 === 0 ? `Metric ${index / 2 + 1}` : `${index / 2 + 0.5}`,
      { boundingBoxes: [box] }
    )), "runbook.pdf", 0.9);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 10,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(normalized.blocks).toHaveLength(1);
    expect(normalized.blocks[0]).toMatchObject({
      table: { columnCount: 2, rowCount: 3 },
      type: "table"
    });
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      "Metric 1\t1",
      "Metric 2\t2",
      "Metric 3\t3"
    ]);
    expect(chunks.every((chunk) =>
      ["table_row", "table_row_projection"].includes(chunk.layoutKind))).toBe(true);
  });

  it("isolates ambiguous positioned cells instead of joining labels and values", () => {
    const valueLefts = [120, 155, 120];
    const blocks = [10, 30, 50].flatMap((top, row) => [
      block(row * 2, `Metric ${row + 1}`, { boundingBoxes: [{
        bottom: top + 10,
        coordinateOrigin: "top_left",
        left: 10,
        page: 1,
        right: 90,
        top
      }] }),
      block(row * 2 + 1, `${row + 1}`, { boundingBoxes: [{
        bottom: top + 10,
        coordinateOrigin: "top_left",
        left: valueLefts[row]!,
        page: 1,
        right: valueLefts[row]! + 50,
        top
      }] })
    ]);
    const normalized = document(blocks, "runbook.pdf", 0.9);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 10,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(normalized.warnings).not.toContain("table_extraction_degraded");
    expect(normalized.blocks).toHaveLength(6);
    expect(normalized.blocks.every((entry) => entry.type === "table" && entry.table === null))
      .toBe(true);
    expect(chunks).toHaveLength(6);
    expect(chunks.every((chunk) =>
      chunk.layoutKind === "table_ambiguous")).toBe(true);
    expect(chunks.every((chunk) => chunk.documentContext === null)).toBe(true);
    expect(chunks.every((chunk) => !chunk.text.includes("\n"))).toBe(true);
  });

  it("deduplicates repeated page furniture supported by stable edge geometry", () => {
    const box = (page: number, top: number, bottom: number) => ({
      bottom,
      coordinateOrigin: "top_left" as const,
      left: 20,
      page,
      right: 500,
      top
    });
    const normalized = document(Array.from({ length: 10 }, (_, pageIndex) => {
      const page = pageIndex + 1;
      return [
        block(pageIndex * 3, "Company handbook", {
          boundingBoxes: [box(page, 10, 30)],
          page,
          pageEnd: page,
          readingOrder: pageIndex * 3
        }),
        block(pageIndex * 3 + 1, `Body page ${page}`, {
          boundingBoxes: [box(page, 390, 430)],
          page,
          pageEnd: page,
          readingOrder: pageIndex * 3 + 1
        }),
        block(pageIndex * 3 + 2, "10 / 2026", {
          boundingBoxes: [box(page, 770, 790)],
          page,
          pageEnd: page,
          readingOrder: pageIndex * 3 + 2
        })
      ];
    }).flat());
    const text = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 40,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    }).map((chunk) => chunk.text).join("\n");

    expect(text.split("Company handbook")).toHaveLength(2);
    expect(text.split("10 / 2026")).toHaveLength(2);
    expect(text).toContain("Body page 10");
  });

  it("keeps one canonical copy of semantic values repeated in a report header", () => {
    const box = (page: number, top: number, bottom: number) => ({
      bottom,
      coordinateOrigin: "top_left" as const,
      left: 20,
      page,
      right: 500,
      top
    });
    const normalized = document(Array.from({ length: 3 }, (_, pageIndex) => {
      const page = pageIndex + 1;
      return [
        block(pageIndex * 3, "Материал получен: 14.11.2024", {
          boundingBoxes: [box(page, 10, 25)],
          page,
          pageEnd: page,
          readingOrder: pageIndex * 3
        }),
        block(pageIndex * 3 + 1, "Результат выдан: 29.11.2024", {
          boundingBoxes: [box(page, 30, 45)],
          page,
          pageEnd: page,
          readingOrder: pageIndex * 3 + 1
        }),
        block(pageIndex * 3 + 2, `Содержимое страницы ${page}`, {
          boundingBoxes: [box(page, 390, 430)],
          page,
          pageEnd: page,
          readingOrder: pageIndex * 3 + 2
        })
      ];
    }).flat());
    const currentText = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    }).map((chunk) => chunk.text).join("\n");
    const profile9Text = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: 9,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    }).map((chunk) => chunk.text).join("\n");

    expect(currentText.split("Материал получен: 14.11.2024")).toHaveLength(2);
    expect(currentText.split("Результат выдан: 29.11.2024")).toHaveLength(2);
    expect(profile9Text).not.toContain("14.11.2024");
    expect(profile9Text).not.toContain("29.11.2024");
  });

  it("keeps repeated body, table, and geometry-free content", () => {
    const box = (page: number, top: number, bottom: number) => ({
      bottom,
      coordinateOrigin: "top_left" as const,
      left: 20,
      page,
      right: 500,
      top
    });
    const normalized = document(Array.from({ length: 4 }, (_, pageIndex) => {
      const page = pageIndex + 1;
      return [
        block(pageIndex * 4, "Repeated legal clause", {
          boundingBoxes: [box(page, 360, 390)], page, pageEnd: page,
          readingOrder: pageIndex * 4
        }),
        block(pageIndex * 4 + 1, "Repeated table row", {
          boundingBoxes: [box(page, 20, 40)], isTable: true, page, pageEnd: page,
          readingOrder: pageIndex * 4 + 1,
          table: {
            cells: [{ column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "Repeated table row" }],
            columnCount: 1,
            rowCount: 1
          },
          type: "table"
        }),
        block(pageIndex * 4 + 2, "No geometry disclaimer", {
          page, pageEnd: page, readingOrder: pageIndex * 4 + 2
        }),
        block(pageIndex * 4 + 3, `Unique body ${page}`, {
          boundingBoxes: [box(page, 700, 730)], page, pageEnd: page,
          readingOrder: pageIndex * 4 + 3
        })
      ];
    }).flat());
    const text = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 40,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    }).map((chunk) => chunk.text).join("\n");

    expect(text).toContain("Repeated legal clause");
    expect(text).toContain("Repeated table row");
    expect(text).toContain("No geometry disclaimer");
  });

  it("does not treat repetition on three of one hundred pages as global furniture", () => {
    const repeatedPages = [1, 2, 100];
    const normalized = document(repeatedPages.flatMap((page, index) => [
      block(index * 2, "Sparse repeated header", {
        boundingBoxes: [{
          bottom: 25, coordinateOrigin: "top_left" as const, left: 20,
          page, right: 500, top: 5
        }],
        page,
        pageEnd: page,
        readingOrder: index * 2
      }),
      block(index * 2 + 1, `Body ${page}`, {
        boundingBoxes: [{
          bottom: 700, coordinateOrigin: "top_left" as const, left: 20,
          page, right: 500, top: 650
        }],
        page,
        pageEnd: page,
        readingOrder: index * 2 + 1
      })
    ]));
    const text = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    }).map((chunk) => chunk.text).join("\n");

    expect(text).toContain("Sparse repeated header");
  });

  it("keeps immutable profile 4 furniture behavior while profile 5 requires geometry", () => {
    const normalized = document(Array.from({ length: 3 }, (_, pageIndex) =>
      block(pageIndex, "Legacy repeated text", {
        page: pageIndex + 1,
        pageEnd: pageIndex + 1,
        readingOrder: pageIndex
      })));

    expect(() => chunkKnowledgeDocument({ document: normalized, maxChunks: 10, profileVersion: 4 }))
      .toThrowError(expect.objectContaining({ code: "chunking_failed" }));
    expect(chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 10,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    }).map((chunk) => chunk.text).join("\n")).toContain("Legacy repeated text");
  });

  it("retains immutable profile 1 behavior while rejecting unknown profiles and chunk overflow", () => {
    const normalized = document([block(0, "valid")]);
    expect(chunkKnowledgeDocument({ document: normalized, maxChunks: 1, profileVersion: 1 }))
      .toHaveLength(1);
    expect(() => chunkKnowledgeDocument({ document: normalized, maxChunks: 1, profileVersion: 99 }))
      .toThrowError(expect.objectContaining({ code: "chunking_failed" }));

    const split = document([
      block(0, "one", { headingPath: ["one"] }),
      block(1, "two", { headingPath: ["two"] })
    ]);
    expect(() => chunkKnowledgeDocument({
      document: split,
      maxChunks: 1,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    })).toThrowError(expect.objectContaining({ code: "knowledge_chunk_limit_exceeded" }));
  });

  it("batches derived passages without changing their token or provenance evidence", () => {
    const normalized = document([block(0, "one passage")]);
    const [entry] = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 1,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const entries = Array.from({ length: KNOWLEDGE_EMBEDDING_BATCH_SIZE + 1 }, (_, index) => ({
      ...entry!,
      contentHash: `${entry!.contentHash}-${index}`,
      embeddingTextHash: `${entry!.embeddingTextHash}-${index}`,
      index
    }));
    expect(approximateKnowledgeTokenCount(entry!.text)).toBe(entry!.tokenCount);
    expect(knowledgeEmbeddingBatches(
      entries,
      KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    ).map((batch) => ({
      batchIndex: batch.batchIndex,
      size: batch.chunks.length
    }))).toEqual([
      { batchIndex: 0, size: KNOWLEDGE_EMBEDDING_BATCH_SIZE },
      { batchIndex: 1, size: 1 }
    ]);
  });

  it("conservatively estimates hostile multilingual and no-space inputs", () => {
    expect(approximateKnowledgeTokenCount(`https://example.test/${"a".repeat(1_200)}`))
      .toBeGreaterThan(KNOWLEDGE_CHUNK_MAX_TOKENS);
    expect(approximateKnowledgeTokenCount("f".repeat(1_200)))
      .toBeGreaterThan(KNOWLEDGE_CHUNK_MAX_TOKENS);
    expect(approximateKnowledgeTokenCount("Ж".repeat(900)))
      .toBeGreaterThan(KNOWLEDGE_CHUNK_MAX_TOKENS);
    expect(approximateKnowledgeTokenCount("слово ".repeat(100))).toBeGreaterThan(100);
  });

  it("splits indivisible hostile text against the full prefixed embedding input", () => {
    const normalized = document([
      block(0, "a".repeat(3_000), {
        headingPath: [`https://example.test/${"f".repeat(900)}`]
      })
    ], `${"source".repeat(160)}.pdf`);
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 50,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) =>
      approximateKnowledgeTokenCount(chunk.embeddingText) <= KNOWLEDGE_CHUNK_MAX_TOKENS &&
      chunk.embeddingText.length <= KNOWLEDGE_CHUNK_MAX_CHARS &&
      Buffer.byteLength(chunk.embeddingText, "utf8") <= KNOWLEDGE_CHUNK_MAX_UTF8_BYTES
    )).toBe(true);
    expect(chunks.map((chunk) => chunk.text).join("").length).toBeGreaterThanOrEqual(3_000);
  });

  it("partitions embedding batches by count, UTF-8 bytes, and estimated tokens", () => {
    const [entry] = chunkKnowledgeDocument({
      document: document([block(0, "seed")]),
      maxChunks: 1,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    const entries = Array.from({ length: 64 }, (_, index) => {
      const embeddingText = Array.from({ length: 40 }, (_value, word) =>
        `ordinaryword${index}-${word}`).join(" ");
      return {
        ...entry!,
        embeddingText,
        embeddingTextHash: `${index.toString(16).padStart(64, "0")}`,
        index
      };
    });
    const first = knowledgeEmbeddingBatches(
      entries,
      KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    );
    const second = knowledgeEmbeddingBatches(
      entries,
      KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    );

    expect(first).toEqual(second);
    expect(first.flatMap((batch) => batch.chunks.map((chunk) => chunk.index)))
      .toEqual(entries.map((entry) => entry.index));
    expect(first.every((batch) =>
      batch.chunks.length <= KNOWLEDGE_EMBEDDING_BATCH_SIZE &&
      batch.chunks.reduce((total, chunk) =>
        total + Buffer.byteLength(chunk.embeddingText, "utf8"), 0) <=
          KNOWLEDGE_EMBEDDING_BATCH_MAX_UTF8_BYTES &&
      batch.chunks.reduce((total, chunk) =>
        total + approximateKnowledgeTokenCount(chunk.embeddingText), 0) <=
          KNOWLEDGE_EMBEDDING_BATCH_MAX_TOKENS
    )).toBe(true);
    expect(first.length).toBeGreaterThan(1);
  });

  it("rejects a manually supplied oversized embedding input before provider dispatch", () => {
    const [entry] = chunkKnowledgeDocument({
      document: document([block(0, "seed")]),
      maxChunks: 1,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION,
      tokenCounter: KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER
    });
    expect(() => knowledgeEmbeddingBatches([{
      ...entry!,
      embeddingText: "x".repeat(KNOWLEDGE_CHUNK_MAX_CHARS + 1)
    }])).toThrowError(expect.objectContaining({ code: "chunking_failed" }));
  });
});
