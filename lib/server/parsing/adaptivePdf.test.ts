import { describe, expect, it } from "vitest";
import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import {
  adaptivePdfTextSubstantiallyAgrees,
  MODEL_PDF_ADAPTIVE_HYBRID_PROFILE_VERSION,
  planAdaptivePdfPages,
  type AdaptivePdfPageReason
} from "./adaptivePdf";
import type { NativePdfGeometry, NativePdfPageMetrics } from "./nativePdf";
import type {
  ParsedDocument,
  ParsedDocumentAsset,
  ParsedDocumentBlock,
  ParsedTable
} from "./types";

const text = "A simple native paragraph with enough exact searchable text.";
const box = Object.freeze({
  bottom: 680,
  coordinateOrigin: "bottom_left" as const,
  left: 40,
  page: 1,
  right: 420,
  top: 700
});

function block(input: Readonly<{
  boxes?: ParsedDocumentBlock["boundingBoxes"];
  isTable?: boolean;
  table?: ParsedTable | null;
  text?: string;
  type?: ParsedDocumentBlock["type"];
}> = {}): ParsedDocumentBlock {
  const value = input.text ?? text;
  return Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: input.boxes ?? Object.freeze([box]),
    headingPath: Object.freeze([]),
    index: 0,
    isTable: input.isTable ?? false,
    languageHints: parsedLanguageHints(value),
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    table: input.table ?? null,
    text: value,
    type: input.type ?? "paragraph"
  });
}

function page(overrides: Partial<NativePdfPageMetrics> = {}): NativePdfPageMetrics {
  return Object.freeze({
    characterCount: text.length,
    classification: "native_text",
    duplicateTextItemCount: 0,
    imageCount: 0,
    invalidCharacterCount: 0,
    invisibleText: false,
    maxVisualGroupCount: 1,
    multiGroupRowCount: 0,
    outOfBoundsTextItemCount: 0,
    overlappingTextItemCount: 0,
    page: 1,
    pageBottom: 0,
    pageLeft: 0,
    pageRight: 600,
    pageRotation: 0,
    pageTop: 800,
    rotatedTextItemCount: 0,
    rowCount: 1,
    shortRowCount: 0,
    textAreaRatio: 0.02,
    textItemCount: 1,
    vectorGraphicsOperationCount: 0,
    visualGroupOverflow: false,
    ...overrides
  });
}

function geometry(input: Readonly<{
  block?: ParsedDocumentBlock;
  page?: NativePdfPageMetrics;
}> = {}): NativePdfGeometry {
  return Object.freeze({
    blocks: Object.freeze([input.block ?? block()]),
    classification: "native_text",
    pageCount: 1,
    quality: Object.freeze({
      pages: Object.freeze([input.page ?? page()]),
      visualGroupOverflow: input.page?.visualGroupOverflow ?? false
    })
  });
}

function docling(input: Readonly<{
  assets?: readonly ParsedDocumentAsset[];
  block?: ParsedDocumentBlock;
  pageCount?: number;
  status?: "complete" | "partial";
}> = {}): ParsedDocument {
  return finalizeParsedDocument({
    assets: input.assets ?? [],
    attempts: [{ engine: "docling", errorCode: null, outcome: "complete" }],
    blocks: [input.block ?? block()],
    engine: "docling",
    mediaType: "application/pdf",
    pageCount: input.pageCount ?? 1,
    status: input.status ?? "complete"
  });
}

function reasons(input: Readonly<{
  docling?: ParsedDocument | null;
  geometry?: NativePdfGeometry;
}>): readonly AdaptivePdfPageReason[] {
  return planAdaptivePdfPages({
    docling: input.docling === undefined ? docling() : input.docling,
    geometry: input.geometry ?? geometry()
  }).pages[0]!.reasons;
}

describe("adaptive PDF safe-native gate", () => {
  it("admits a page only when both parsers and every native signal agree", () => {
    const plan = planAdaptivePdfPages({ docling: docling(), geometry: geometry() });

    expect(MODEL_PDF_ADAPTIVE_HYBRID_PROFILE_VERSION).toBe(13);
    expect(plan).toMatchObject({ nativeOnlyPageCount: 1, visionRequiredPageCount: 0 });
    expect(plan.pages).toEqual([{ page: 1, reasons: [], route: "native_only" }]);
  });

  it.each([
    [{ classification: "mixed" }, "native_non_text"],
    [{ invalidCharacterCount: 1 }, "native_invalid_unicode"],
    [{ invisibleText: true }, "native_invisible_text"],
    [{ outOfBoundsTextItemCount: 1 }, "native_invalid_geometry"],
    [{ duplicateTextItemCount: 4, textItemCount: 100 }, "native_duplicate_glyphs"],
    [{ overlappingTextItemCount: 10, textItemCount: 100 }, "native_overlapping_glyphs"],
    [{ pageRotation: 90 }, "native_rotated"],
    [{ rotatedTextItemCount: 1 }, "native_rotated"],
    [{ multiGroupRowCount: 3, maxVisualGroupCount: 2, rowCount: 8 }, "native_multi_column"],
    [{ imageCount: 1 }, "native_visual_content"],
    [{ textAreaRatio: 0 }, "native_low_text_coverage"],
    [{ textItemCount: 1, vectorGraphicsOperationCount: 128 }, "native_vector_graphics"],
    [{ visualGroupOverflow: true }, "native_visual_group_overflow"]
  ] as const)("routes native signal %j to Vision", (overrides, reason) => {
    const plan = planAdaptivePdfPages({
      docling: docling(),
      geometry: geometry({ page: page(overrides) })
    });

    expect(plan.pages[0]).toMatchObject({ route: "vision_required" });
    expect(plan.pages[0]?.reasons).toContain(reason);
  });

  it("routes strong fragmentation and native table structure to Vision", () => {
    const fragmented = page({
      characterCount: 120,
      rowCount: 12,
      shortRowCount: 10,
      textItemCount: 12
    });
    const table = Object.freeze({
      cells: Object.freeze([
        Object.freeze({ column: 0, columnSpan: 1, row: 0, rowSpan: 1, text: "A" }),
        Object.freeze({ column: 1, columnSpan: 1, row: 0, rowSpan: 1, text: "B" })
      ]),
      columnCount: 2,
      rowCount: 1
    });

    expect(reasons({ geometry: geometry({ page: fragmented }) })).toContain("native_fragmented");
    expect(reasons({ geometry: geometry({
      block: block({ isTable: true, table, type: "table" }),
      page: page({ maxVisualGroupCount: 3, multiGroupRowCount: 3, rowCount: 10 })
    }) })).toContain("native_complex_table");
  });

  it("does not confuse isolated glyph contact or one wide gap with mass/layout ambiguity", () => {
    const isolated = page({
      duplicateTextItemCount: 1,
      maxVisualGroupCount: 2,
      multiGroupRowCount: 1,
      overlappingTextItemCount: 1,
      rowCount: 10,
      textItemCount: 100
    });

    expect(reasons({ geometry: geometry({ page: isolated }) })).not.toEqual(
      expect.arrayContaining([
        "native_duplicate_glyphs",
        "native_overlapping_glyphs",
        "native_multi_column"
      ])
    );
  });

  it("requires the independent parser and substantial material text agreement", () => {
    expect(reasons({ docling: null })).toContain("docling_unavailable");
    expect(reasons({ docling: docling({
      block: block({ text: "A materially different parser result." })
    }) })).toContain("docling_text_disagreement");
    expect(reasons({ docling: docling({
      block: block({ boxes: Object.freeze([]) })
    }) })).toContain("docling_geometry_unproven");
    expect(reasons({ docling: docling({ status: "partial" }) })).toContain("docling_partial");
    expect(reasons({ docling: docling({
      block: block({ type: "code" })
    }) })).toContain("docling_layout_ambiguous");
    expect(reasons({ docling: docling({ pageCount: 2 }) })).toContain(
      "docling_page_count_mismatch"
    );
  });

  it("ignores parser presentation differences but preserves lexical and numeric equality", () => {
    expect(adaptivePdfTextSubstantiallyAgrees(
      "Agents’ prefer-\nences reached 73.4% in 2024.",
      "Agents' preferences reached 73.4% in 2024."
    )).toBe(true);
    expect(adaptivePdfTextSubstantiallyAgrees(
      "Agents’ preferences reached 73.4% in 2024.",
      "Agents' preferences reached 74.3% in 2024."
    )).toBe(false);
    expect(adaptivePdfTextSubstantiallyAgrees(
      "The first parser retained a material operand.",
      "The first parser omitted an operand."
    )).toBe(false);
  });

  it("proves page-local geometry for a normal paragraph spanning two pages", () => {
    const secondBox = Object.freeze({
      ...box,
      bottom: 80,
      page: 2,
      top: 100
    });
    const firstNative = block({ text: "First page paragraph continues" });
    const secondNative = Object.freeze({
      ...block({ text: "on the second page" }),
      boundingBoxes: Object.freeze([secondBox]),
      index: 1,
      page: 2,
      pageEnd: 2,
      readingOrder: 1
    });
    const pageNumber = Object.freeze({
      ...block({ text: "2" }),
      boundingBoxes: Object.freeze([secondBox]),
      index: 2,
      page: 2,
      pageEnd: 2,
      readingOrder: 2
    });
    const nativeGeometry: NativePdfGeometry = Object.freeze({
      blocks: Object.freeze([firstNative, secondNative, pageNumber]),
      classification: "native_text",
      pageCount: 2,
      quality: Object.freeze({
        pages: Object.freeze([
          page({ characterCount: firstNative.text.length }),
          page({
            characterCount: secondNative.text.length + 1,
            page: 2
          })
        ]),
        visualGroupOverflow: false
      })
    });
    const spanning = Object.freeze({
      ...block({ text: "First page paragraph continues on the second page" }),
      boundingBoxes: Object.freeze([box, secondBox]),
      pageEnd: 2
    });
    const independent = finalizeParsedDocument({
      attempts: [{ engine: "docling", errorCode: null, outcome: "complete" }],
      blocks: [spanning],
      engine: "docling",
      mediaType: "application/pdf",
      pageCount: 2,
      status: "complete"
    });

    expect(planAdaptivePdfPages({
      docling: independent,
      geometry: nativeGeometry
    }).pages).toEqual([
      { page: 1, reasons: [], route: "native_only" },
      { page: 2, reasons: [], route: "native_only" }
    ]);
  });

  it("routes Docling tables and visual assets to mandatory Vision", () => {
    const table = Object.freeze({
      cells: Object.freeze([
        Object.freeze({ column: 0, columnSpan: 1, row: 0, rowSpan: 1, text })
      ]),
      columnCount: 1,
      rowCount: 1
    });
    const tableReasons = reasons({ docling: docling({
      block: block({ isTable: true, table, type: "table" })
    }) });
    const visualReasons = reasons({ docling: docling({
      assets: [{ boundingBoxes: [box], caption: null, id: "image-1", kind: "image", page: 1 }]
    }) });

    expect(tableReasons).toContain("docling_complex_table");
    expect(visualReasons).toContain("docling_visual_content");
  });
});
