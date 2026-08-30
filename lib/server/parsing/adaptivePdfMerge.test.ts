import { describe, expect, it } from "vitest";
import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import type { AdaptivePdfPlan } from "./adaptivePdf";
import { mergeAdaptivePdfDocument } from "./adaptivePdfMerge";
import type { NativePdfGeometry } from "./nativePdf";
import type { ParsedDocumentBlock } from "./types";

function block(text: string, index = 0, page = 1): ParsedDocumentBlock {
  return Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: Object.freeze([{
      bottom: 680 - index * 30,
      coordinateOrigin: "bottom_left" as const,
      left: 40,
      page,
      right: 500,
      top: 700 - index * 30
    }]),
    headingPath: Object.freeze([]),
    index,
    isTable: false,
    languageHints: parsedLanguageHints(text),
    page,
    pageEnd: page,
    readingOrder: index,
    table: null,
    text,
    type: "paragraph"
  });
}

function geometry(blocks: readonly ParsedDocumentBlock[]): NativePdfGeometry {
  const pageCount = Math.max(1, ...blocks.map(({ page }) => page));
  return Object.freeze({
    blocks: Object.freeze(blocks),
    classification: "native_text",
    pageCount,
    quality: Object.freeze({
      pages: Object.freeze(Array.from({ length: pageCount }, (_, pageIndex) => {
        const page = pageIndex + 1;
        const pageBlocks = blocks.filter((value) => value.page === page);
        return Object.freeze({
          characterCount: pageBlocks.reduce((total, value) => total + value.text.length, 0),
          classification: "native_text",
          duplicateTextItemCount: 0,
          imageCount: 1,
          invalidCharacterCount: 0,
          invisibleText: false,
          maxVisualGroupCount: 1,
          multiGroupRowCount: 0,
          outOfBoundsTextItemCount: 0,
          overlappingTextItemCount: 0,
          page,
          pageBottom: 0,
          pageLeft: 0,
          pageRight: 600,
          pageRotation: 0,
          pageTop: 800,
          rotatedTextItemCount: 0,
          rowCount: pageBlocks.length,
          shortRowCount: 0,
          textAreaRatio: 0.05,
          textItemCount: pageBlocks.length,
          vectorGraphicsOperationCount: 0,
          visualGroupOverflow: false
        });
      })),
      visualGroupOverflow: false
    })
  });
}

function vision(blocks: readonly ParsedDocumentBlock[], pageCount = 1) {
  return finalizeParsedDocument({
    attempts: [{ engine: "system_model_vision", errorCode: null, outcome: "complete" }],
    blocks,
    engine: "system_model_vision",
    mediaType: "application/pdf",
    pageCount,
    status: "complete"
  });
}

const plan = Object.freeze({
  nativeOnlyPageCount: 0,
  pages: Object.freeze([{
    page: 1,
    reasons: Object.freeze(["native_visual_content" as const]),
    route: "vision_required" as const
  }]),
  visionRequiredPageCount: 1
}) satisfies AdaptivePdfPlan;

describe("adaptive PDF deterministic merge", () => {
  it("uses valid native letters and numbers for one uniquely aligned Vision row", () => {
    const native = "Company Tulnov signed 12.05.2024";
    const model = "Company Tulbinov signed 12.05.2029";
    const document = mergeAdaptivePdfDocument({
      docling: null,
      geometry: geometry([block(native)]),
      maxBlocks: 20,
      maxCharacters: 2_000,
      plan,
      vision: vision([block(model)])
    });

    expect(document.blocks.map(({ text }) => text)).toEqual([native]);
    expect(document.text).not.toContain("Tulbinov");
    expect(document.text).not.toContain("2029");
  });

  it("does not silently discard native evidence when no safe alignment exists", () => {
    const native = "Native exact identifier ZX-2048";
    const model = "Completely unrelated visual statement";
    const document = mergeAdaptivePdfDocument({
      docling: null,
      geometry: geometry([block(native)]),
      maxBlocks: 20,
      maxCharacters: 2_000,
      plan,
      vision: vision([block(model)])
    });

    expect(document.blocks.map(({ text }) => text)).toEqual([model, native]);
  });

  it("recomputes coverage warnings after merging a Vision page subset", () => {
    const nativePage = block("Native-only page text", 0, 1);
    const nativeVisualLabel = block("Native chart label 2048", 1, 2);
    const visionVisual = block("Chart showing the annual result", 0, 2);
    const subset = vision([visionVisual], 2);
    expect(subset.warnings).toEqual(expect.arrayContaining([
      "low_page_coverage",
      "unreadable_pages"
    ]));

    const document = mergeAdaptivePdfDocument({
      docling: null,
      geometry: geometry([nativePage, nativeVisualLabel]),
      maxBlocks: 20,
      maxCharacters: 2_000,
      plan: Object.freeze({
        nativeOnlyPageCount: 1,
        pages: Object.freeze([{
          page: 1,
          reasons: Object.freeze([]),
          route: "native_only" as const
        }, {
          page: 2,
          reasons: Object.freeze(["native_visual_content" as const]),
          route: "vision_required" as const
        }]),
        visionRequiredPageCount: 1
      }),
      vision: subset
    });

    expect(document.quality.coveredPageCount).toBe(2);
    expect(document.quality.pageCoverage).toBe(1);
    expect(document.warnings).not.toContain("low_page_coverage");
    expect(document.warnings).not.toContain("unreadable_pages");
  });
});
