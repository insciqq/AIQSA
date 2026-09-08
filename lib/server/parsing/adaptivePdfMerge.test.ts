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

function nativeColumns(cells: readonly string[], index = 0): ParsedDocumentBlock {
  return {
    ...block(cells.join("\t"), index),
    isTable: true,
    table: {
      cells: cells.map((text, column) => ({
        column, columnSpan: 1, row: 0, rowSpan: 1, text
      })),
      columnCount: cells.length,
      rowCount: 1
    },
    type: "table"
  };
}

describe("adaptive PDF deterministic merge", () => {
  it("retains governed line corrections when model prose is grouped into a paragraph", () => {
    const first = "The northern station recorded 17 samples.";
    const corrected = "The northern station recorded 19 samples.";
    const second = "Maintenance begins after the operator confirms every recorded measurement.";
    const native = geometry([block(corrected), block(second, 1)]);
    const common = { docling: null, geometry: native, maxBlocks: 20, maxCharacters: 2_000,
      plan, deduplicateNativeText: true };
    const previous = mergeAdaptivePdfDocument({ ...common, vision: vision([block(first), block(second, 1)]) });
    expect(previous.text).toContain(corrected);
    const current = mergeAdaptivePdfDocument({ ...common, deduplicateNativeFragments: true,
      vision: vision([block(first + "\n" + second)]) });
    expect(current.blocks.some(block => block.text === corrected + "\n" + second)).toBe(true);
    expect(current.text).not.toContain(first);
  });

  it("rejects a native mathematical duplicate while preserving an omitted paragraph", () => {
    const formula = String.raw`The limit is \(\beta_i\leq\sqrt{11}\,s_i\).`;
    const duplicate = "The limit is β i ≤ 11 s i.";
    const omitted = "Calibration completed on 2042-03-06.";
    const input = {
      docling: null, geometry: geometry([block(duplicate), block(omitted, 1)]),
      maxBlocks: 20, maxCharacters: 2_000, plan, vision: vision([block(formula)])
    };
    expect(mergeAdaptivePdfDocument(input).text).toContain(duplicate);
    const current = mergeAdaptivePdfDocument({ ...input, deduplicateNativeText: true });
    expect(current.text).toContain(formula);
    expect(current.text).toContain(omitted);
    expect(current.text).not.toContain(duplicate);
  });

  it("does not add a synthetic table joining prose already read in separate columns", () => {
    const left = "The northern workshop builds wooden boats.";
    const right = "The southern workshop repairs bicycles.";
    const native = nativeColumns([left, right]);
    const paragraphs = [
      `${left} Every hull is assembled by hand.`,
      `${right} Broken wheels are replaced locally.`
    ];
    const input = {
      docling: null,
      geometry: geometry([native]),
      maxBlocks: 20,
      maxCharacters: 2_000,
      plan,
      vision: vision(paragraphs.map((text, index) => block(text, index)))
    };

    expect(mergeAdaptivePdfDocument(input).blocks.map(({ text }) => text))
      .toEqual([...paragraphs, native.text]);
    const result = mergeAdaptivePdfDocument({ ...input, deduplicateNativeProseRows: true });
    expect(result.blocks.map(({ text }) => text)).toEqual(paragraphs);
    expect(result.blocks.every((value) => value.table === null)).toBe(true);
  });

  it.each([
    ["missing column", "Unrelated notes about a different workshop."],
    ["numeric disagreement", "The southern workshop repairs 28 bicycles."]
  ])("retains all native cells when Vision has a %s", (_label, rightModel) => {
    const left = "The northern workshop builds wooden boats.";
    const right = "The southern workshop repairs 29 bicycles.";
    const native = nativeColumns([left, right]);
    const result = mergeAdaptivePdfDocument({
      deduplicateNativeProseRows: true,
      docling: null,
      geometry: geometry([native]),
      maxBlocks: 20,
      maxCharacters: 2_000,
      plan,
      vision: vision([block(left), block(rightModel, 1)])
    });

    expect(result.blocks.at(-1)?.table).toEqual(native.table);
  });

  it("does not discard a table relationship because its labels occur elsewhere", () => {
    const native = nativeColumns(["Northern workshop", "Southern workshop"]);
    const first = { ...nativeColumns(["Northern workshop", "Boats"]), text: "Northern workshop\tBoats" };
    const second = { ...nativeColumns(["Southern workshop", "Bicycles"], 1), text: "Southern workshop\tBicycles" };
    const result = mergeAdaptivePdfDocument({
      deduplicateNativeProseRows: true,
      docling: null,
      geometry: geometry([native]),
      maxBlocks: 20,
      maxCharacters: 2_000,
      plan,
      vision: vision([first, second])
    });

    expect(result.blocks.at(-1)?.table).toEqual(native.table);
  });

  it("does not treat substrings inside other words as an already preserved cell", () => {
    const native = nativeColumns(["international", "unremarkable"]);
    const result = mergeAdaptivePdfDocument({
      deduplicateNativeProseRows: true,
      docling: null,
      geometry: geometry([native]),
      maxBlocks: 20,
      maxCharacters: 2_000,
      plan,
      vision: vision([block("internationalization"), block("unremarkable", 1)])
    });

    expect(result.blocks.at(-1)?.table).toEqual(native.table);
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
