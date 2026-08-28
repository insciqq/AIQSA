import { finalizeParsedDocument } from "./assessment";
import { supplementImageHeavyPdfOcr } from "./ocrSupplement";
import type { DocumentParserEngine, ParsedDocument, ParsedDocumentBlock } from "./types";

function block(
  index: number,
  text: string,
  overrides: Partial<ParsedDocumentBlock> = {}
): ParsedDocumentBlock {
  return {
    assetIds: [],
    boundingBoxes: [],
    headingPath: [],
    index,
    isTable: false,
    languageHints: ["und-Latn"],
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: null,
    text,
    type: "paragraph",
    ...overrides
  };
}

function document(
  engine: DocumentParserEngine,
  blocks: readonly ParsedDocumentBlock[],
  pageCount = 1
): ParsedDocument {
  return finalizeParsedDocument({
    blocks,
    engine,
    mediaType: "application/pdf",
    pageCount,
    status: "complete"
  });
}

describe("image-heavy PDF OCR supplementation", () => {
  it("preserves primary structure and appends materially novel page OCR", () => {
    const primary = document("docling", [block(0, "Category alpha 10 Category beta", {
      isTable: true,
      table: {
        cells: [{ column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "alpha 10" }],
        columnCount: 1,
        rowCount: 1
      },
      type: "table"
    })]);
    const fallback = document("tika", [block(0, "Category alpha 10 Category beta 20")]);

    const result = supplementImageHeavyPdfOcr(primary, fallback, {
      maxBlocks: 10,
      maxCharacters: 1_000
    });

    expect(result.outcome).toBe("augmented");
    expect(result.document).toMatchObject({
      blocks: [
        { index: 0, isTable: true, readingOrder: 0, type: "table" },
        {
          boundingBoxes: [],
          index: 1,
          isTable: false,
          page: 1,
          readingOrder: 1,
          text: "Category alpha 10 Category beta 20",
          type: "paragraph"
        }
      ],
      engine: "docling"
    });
  });

  it("does not duplicate equivalent OCR that only differs in punctuation", () => {
    const primary = document("docling", [block(0, "Revenue: 10 percent")]);
    const fallback = document("tika", [block(0, "Revenue — 10 percent")]);

    const result = supplementImageHeavyPdfOcr(primary, fallback, {
      maxBlocks: 10,
      maxCharacters: 1_000
    });

    expect(result).toEqual({ document: primary, outcome: "unchanged" });
  });

  it("preserves novel value associations even when the token set is unchanged", () => {
    const primary = document("docling", [block(0, "Alpha 10 Beta 20")]);
    const fallback = document("tika", [block(0, "Alpha 20 Beta 10")]);

    const result = supplementImageHeavyPdfOcr(primary, fallback, {
      maxBlocks: 10,
      maxCharacters: 1_000
    });

    expect(result.outcome).toBe("augmented");
    expect(result.document.blocks.at(-1)?.text).toBe("Alpha 20 Beta 10");
  });

  it("treats leading zeroes in identifiers as material evidence", () => {
    const primary = document("docling", [block(0, "Code 1")]);
    const fallback = document("tika", [block(0, "Code 001")]);

    expect(supplementImageHeavyPdfOcr(primary, fallback, {
      maxBlocks: 10,
      maxCharacters: 1_000
    }).outcome).toBe("augmented");
  });

  it("rejects unsafe page attribution or an all-or-nothing output overflow", () => {
    const primary = document("docling", [block(0, "Primary text")]);
    const differentPages = document("tika", [block(0, "Novel value 20")], 2);
    const invalidAttribution = document("tika", [
      block(0, "Novel value 20"),
      block(1, "Invalid page", { page: 2, pageEnd: 1 })
    ]);
    const addition = document("tika", [block(0, "Novel value 20")]);

    expect(supplementImageHeavyPdfOcr(primary, differentPages, {
      maxBlocks: 10,
      maxCharacters: 1_000
    }).outcome).toBe("rejected");
    expect(supplementImageHeavyPdfOcr(primary, invalidAttribution, {
      maxBlocks: 10,
      maxCharacters: 1_000
    }).outcome).toBe("rejected");
    expect(supplementImageHeavyPdfOcr(primary, addition, {
      maxBlocks: 1,
      maxCharacters: 1_000
    })).toEqual({ document: primary, outcome: "rejected" });
  });
});
