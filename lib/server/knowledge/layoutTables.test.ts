import { describe, expect, it } from "vitest";
import { finalizeParsedDocument } from "../parsing/assessment";
import type { ParsedDocumentBlock } from "../parsing";
import { withLayoutAwareTables } from "./layoutTables";
import { chunkKnowledgeDocument } from "./chunking";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import { encodeKnowledgeNormalizedDocument } from "./normalizedDocument";

function positionedBlocks(rowCount = 3): readonly ParsedDocumentBlock[] {
  const rows = [
    ["Metric", "Actual"],
    ["Alpha", "1.5"],
    ["Beta", "2.5"]
  ] as const;
  return Object.freeze(rows.slice(0, rowCount).flatMap((row, rowIndex) =>
    row.map((value, columnIndex) => {
      const top = 10 + rowIndex * 20;
      return Object.freeze({
        assetIds: Object.freeze([]),
        boundingBoxes: Object.freeze([Object.freeze({
          bottom: top + 10,
          coordinateOrigin: "top_left" as const,
          left: columnIndex === 0 ? 10 : 130,
          page: 1,
          right: columnIndex === 0 ? 90 : 180,
          top
        })]),
        headingPath: Object.freeze([]),
        index: rowIndex * 2 + columnIndex,
        isTable: false,
        languageHints: Object.freeze(["und-Latn"]),
        page: 1,
        pageEnd: 1,
        readingOrder: rowIndex * 2 + columnIndex,
        table: null,
        text: value,
        type: "paragraph" as const
      });
    })));
}

function reconstruct(ocrConfidence: number | null, rowCount = 3) {
  return withLayoutAwareTables(finalizeParsedDocument({
    blocks: positionedBlocks(rowCount),
    engine: "docling",
    mediaType: "application/pdf",
    ocrConfidence,
    pageCount: 1,
    status: "complete"
  }));
}

describe("positioned loose-block table reconstruction", () => {
  it.each([0.65, 0.9])(
    "reconstructs stable geometry when OCR confidence is %s",
    (ocrConfidence) => {
      const document = reconstruct(ocrConfidence);

      expect(document.blocks).toHaveLength(1);
      expect(document.blocks[0]).toMatchObject({
        isTable: true,
        table: { columnCount: 2, rowCount: 3 },
        type: "table"
      });
      expect(document.warnings).not.toContain("table_extraction_degraded");
    }
  );

  it("keeps stable geometry cell-local when OCR confidence is unavailable", () => {
    const document = reconstruct(null);

    expect(document.blocks).toHaveLength(6);
    expect(document.blocks.every((block) =>
      block.isTable && block.table === null && block.type === "table")).toBe(true);
    expect(document.warnings).toContain("table_extraction_degraded");
    expect(document.warnings).not.toContain("low_ocr_confidence");
  });

  it("keeps stable geometry cell-local when OCR confidence is below 0.65", () => {
    const document = reconstruct(0.64);

    expect(document.blocks).toHaveLength(6);
    expect(document.blocks.every((block) =>
      block.isTable && block.table === null && block.type === "table")).toBe(true);
    expect(document.blocks.map((block) => block.text)).toEqual([
      "Metric",
      "Actual",
      "Alpha",
      "1.5",
      "Beta",
      "2.5"
    ]);
    expect(document.warnings).toEqual(expect.arrayContaining([
      "low_ocr_confidence",
      "table_extraction_degraded"
    ]));
  });

  it.each([null, 0.64])(
    "keeps an aligned two-row loose layout cell-local and non-mergeable at confidence %s",
    (ocrConfidence) => {
      const parsed = reconstruct(ocrConfidence, 2);
      const normalized = encodeKnowledgeNormalizedDocument(parsed, {
        maxChunksPerDocument: 100,
        maxFileBytes: 1_000_000,
        maxNormalizedChars: 1_000_000,
        maxNormalizedObjectBytes: 4_000_000,
        maxPages: 100
      }, { layoutAwareTables: true, sourceDisplayName: "report.pdf" }).document;
      const chunks = chunkKnowledgeDocument({
        document: normalized,
        maxChunks: 20,
        profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
      });

      expect(parsed.blocks).toHaveLength(4);
      expect(parsed.blocks.every((block) =>
        block.isTable && block.table === null && block.type === "table")).toBe(true);
      expect(parsed.warnings).toContain("table_extraction_degraded");
      expect(chunks.map((chunk) => chunk.text)).toEqual(["Metric", "Actual", "Alpha", "1.5"]);
      expect(chunks.every((chunk) => chunk.documentContext === null &&
        chunk.contextPrefix.startsWith("Evidence layout: table_ambiguous_v1"))).toBe(true);
    }
  );

  it("keeps a misaligned two-row loose layout cell-local at high OCR confidence", () => {
    const blocks = positionedBlocks(2).map((block, index) => {
      if (index < 2) return block;
      const box = block.boundingBoxes[0]!;
      return Object.freeze({
        ...block,
        boundingBoxes: Object.freeze([Object.freeze({
          ...box,
          left: box.left + 40,
          right: box.right + 40
        })])
      });
    });
    const parsed = withLayoutAwareTables(finalizeParsedDocument({
      blocks,
      engine: "docling",
      mediaType: "application/pdf",
      ocrConfidence: 0.9,
      pageCount: 1,
      status: "complete"
    }));
    const normalized = encodeKnowledgeNormalizedDocument(parsed, {
      maxChunksPerDocument: 100,
      maxFileBytes: 1_000_000,
      maxNormalizedChars: 1_000_000,
      maxNormalizedObjectBytes: 4_000_000,
      maxPages: 100
    }, { layoutAwareTables: true, sourceDisplayName: "report.pdf" }).document;
    const chunks = chunkKnowledgeDocument({
      document: normalized,
      maxChunks: 20,
      profileVersion: KNOWLEDGE_CHUNKING_PROFILE_VERSION
    });

    expect(parsed.blocks).toHaveLength(4);
    expect(parsed.blocks.every((block) =>
      block.isTable && block.table === null && block.type === "table")).toBe(true);
    expect(parsed.warnings).toContain("table_extraction_degraded");
    expect(chunks.map((chunk) => chunk.text)).toEqual(["Metric", "Actual", "Alpha", "1.5"]);
    expect(chunks.every((chunk) => chunk.documentContext === null &&
      chunk.contextPrefix.startsWith("Evidence layout: table_ambiguous_v1"))).toBe(true);
  });
});
