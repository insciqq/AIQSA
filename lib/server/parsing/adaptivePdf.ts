import type { NativePdfGeometry, NativePdfPageMetrics } from "./nativePdf";
import type { ParsedBoundingBox, ParsedDocument, ParsedDocumentBlock } from "./types";

/** First immutable System Model Vision profile that routes simple PDF pages
 * through a strict native-text whitelist and keeps Vision mandatory for every
 * page that cannot prove all safe-native conditions. */
export const MODEL_PDF_ADAPTIVE_HYBRID_PROFILE_VERSION = 13 as const;

export const ADAPTIVE_PDF_MIN_NATIVE_CHARACTERS = 16;
export const ADAPTIVE_PDF_MIN_TEXT_AREA_RATIO = 0.001;
export const ADAPTIVE_PDF_VECTOR_MIN_OPERATIONS = 128;

export type AdaptivePdfPageReason =
  | "docling_complex_table"
  | "docling_geometry_unproven"
  | "docling_layout_ambiguous"
  | "docling_page_count_mismatch"
  | "docling_partial"
  | "docling_text_disagreement"
  | "docling_unavailable"
  | "docling_visual_content"
  | "native_complex_table"
  | "native_duplicate_glyphs"
  | "native_fragmented"
  | "native_invalid_geometry"
  | "native_invalid_unicode"
  | "native_invisible_text"
  | "native_low_text_coverage"
  | "native_multi_column"
  | "native_non_text"
  | "native_overlapping_glyphs"
  | "native_rotated"
  | "native_vector_graphics"
  | "native_visual_content"
  | "native_visual_group_overflow";

export type AdaptivePdfPageRoute = Readonly<{
  page: number;
  reasons: readonly AdaptivePdfPageReason[];
  route: "native_only" | "vision_required";
}>;

export type AdaptivePdfPlan = Readonly<{
  nativeOnlyPageCount: number;
  pages: readonly AdaptivePdfPageRoute[];
  visionRequiredPageCount: number;
}>;

function normalizedText(value: string): string {
  return value.normalize("NFKC")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function isPageFurniture(value: string): boolean {
  const normalized = normalizedText(value);
  return /^(?:page\s+)?\d+(?:\s+(?:of|\/)\s*\d+)?$/iu.test(normalized);
}

function blocksOnPage(
  blocks: readonly ParsedDocumentBlock[],
  page: number
): readonly ParsedDocumentBlock[] {
  return blocks.filter((block) => block.page <= page && block.pageEnd >= page);
}

function rangeText(
  blocks: readonly ParsedDocumentBlock[],
  pageStart: number,
  pageEnd: number
): string {
  return normalizedText(blocks.filter((block) =>
    block.page >= pageStart && block.pageEnd <= pageEnd)
    .filter((block) => !isPageFurniture(block.text))
    .map((block) => block.text)
    .join("\n"));
}

function agreementRange(
  blocks: readonly ParsedDocumentBlock[],
  page: number
): Readonly<{ pageEnd: number; pageStart: number }> {
  const touching = blocksOnPage(blocks, page);
  return Object.freeze({
    pageEnd: Math.max(page, ...touching.map((block) => block.pageEnd)),
    pageStart: Math.min(page, ...touching.map((block) => block.page))
  });
}

function lexicalSignature(value: string): string {
  return normalizedText(value).toLocaleLowerCase("und").replace(/[^\p{L}\p{N}]+/gu, "");
}

function numericSignature(value: string): string {
  const normalized = normalizedText(value)
    .replace(/[\u2212\u2012-\u2014]/gu, "-")
    .replace(/\s*([.,:%/])\s*/gu, "$1");
  return (normalized.match(/[+-]?\d+(?:[.,]\d+)*(?:%|‰)?/gu) ?? []).join("\u0001");
}

/** Independent parsers may join lines, dehyphenate, or normalize typography.
 * Native-only remains admissible only when the ordered letters/digits and all
 * numeric expressions still agree exactly after those presentation-only
 * differences are removed. */
export function adaptivePdfTextSubstantiallyAgrees(
  nativeText: string,
  independentText: string
): boolean {
  const nativeLexical = lexicalSignature(nativeText);
  return nativeLexical.length > 0 && nativeLexical === lexicalSignature(independentText) &&
    numericSignature(nativeText) === numericSignature(independentText);
}

function nativeFragmented(page: NativePdfPageMetrics): boolean {
  return page.rowCount >= 12 &&
    page.characterCount / Math.max(1, page.rowCount) < 18 &&
    page.shortRowCount / Math.max(1, page.rowCount) >= 0.65;
}

function repeatedMultiColumnPattern(page: NativePdfPageMetrics): boolean {
  return page.multiGroupRowCount >= 3 && page.rowCount >= 4 &&
    page.multiGroupRowCount / page.rowCount >= 0.15;
}

function complexNativeTablePattern(page: NativePdfPageMetrics): boolean {
  return page.maxVisualGroupCount >= 3 && page.multiGroupRowCount >= 3 &&
    page.multiGroupRowCount / Math.max(1, page.rowCount) >= 0.1;
}

function massDuplicateGlyphs(page: NativePdfPageMetrics): boolean {
  return page.duplicateTextItemCount >= Math.max(4, Math.ceil(page.textItemCount * 0.02));
}

function massOverlappingGlyphs(page: NativePdfPageMetrics): boolean {
  return page.overlappingTextItemCount >= Math.max(8, Math.ceil(page.textItemCount * 0.1));
}

export function adaptiveNativeTextLexicallyValid(page: NativePdfPageMetrics): boolean {
  return page.characterCount > 0 && page.textItemCount > 0 &&
    page.invalidCharacterCount === 0 && !page.invisibleText &&
    page.outOfBoundsTextItemCount === 0 && !massDuplicateGlyphs(page) &&
    !massOverlappingGlyphs(page);
}

function materialVectorGraphics(page: NativePdfPageMetrics): boolean {
  return page.vectorGraphicsOperationCount >= ADAPTIVE_PDF_VECTOR_MIN_OPERATIONS &&
    page.vectorGraphicsOperationCount > Math.max(1, page.textItemCount) * 12;
}

function boxWithinPage(box: ParsedBoundingBox, page: NativePdfPageMetrics): boolean {
  if (box.page !== page.page || ![box.left, box.right, box.top, box.bottom].every(Number.isFinite)) {
    return false;
  }
  const width = page.pageRight - page.pageLeft;
  const height = page.pageTop - page.pageBottom;
  const tolerance = Math.max(2, width * 0.02, height * 0.02);
  const horizontal = box.left >= Math.min(0, page.pageLeft) - tolerance &&
    box.right <= Math.max(width, page.pageRight) + tolerance && box.left <= box.right;
  const vertical = box.coordinateOrigin === "top_left"
    ? box.top >= -tolerance && box.bottom <= height + tolerance && box.top <= box.bottom
    : box.bottom >= Math.min(0, page.pageBottom) - tolerance &&
      box.top <= Math.max(height, page.pageTop) + tolerance && box.bottom <= box.top;
  return horizontal && vertical;
}

function doclingReasons(
  geometry: NativePdfGeometry,
  docling: ParsedDocument | null,
  page: NativePdfPageMetrics
): AdaptivePdfPageReason[] {
  if (!docling) return ["docling_unavailable"];
  const reasons: AdaptivePdfPageReason[] = [];
  if (docling.status !== "complete") reasons.push("docling_partial");
  if (docling.pageCount !== geometry.pageCount) reasons.push("docling_page_count_mismatch");
  const blocks = blocksOnPage(docling.blocks, page.page);
  const assets = docling.assets.filter((asset) => asset.page === page.page);
  const fields = docling.fieldGroups.filter((group) =>
    group.page <= page.page && group.pageEnd >= page.page);
  if (assets.length > 0 || blocks.some((block) => block.assetIds.length > 0 ||
    block.type === "image")) reasons.push("docling_visual_content");
  if (blocks.some((block) => block.isTable || block.table !== null || block.type === "table")) {
    reasons.push("docling_complex_table");
  }
  if (fields.length > 0 || blocks.some((block) => block.type === "code")) {
    reasons.push("docling_layout_ambiguous");
  }
  const textualBlocks = blocks.filter((block) => normalizedText(block.text));
  if (textualBlocks.length === 0 || textualBlocks.some((block) =>
    block.boundingBoxes.filter((box) => box.page === page.page).length === 0 ||
    block.boundingBoxes.filter((box) => box.page === page.page)
      .some((box) => !boxWithinPage(box, page)))) {
    reasons.push("docling_geometry_unproven");
  }
  const range = agreementRange(docling.blocks, page.page);
  const nativeText = rangeText(geometry.blocks, range.pageStart, range.pageEnd);
  const independentText = rangeText(docling.blocks, range.pageStart, range.pageEnd);
  if (!adaptivePdfTextSubstantiallyAgrees(nativeText, independentText)) {
    reasons.push("docling_text_disagreement");
  }
  return reasons;
}

export function nativeAdaptivePdfPageReasons(
  page: NativePdfPageMetrics
): AdaptivePdfPageReason[] {
  const reasons: AdaptivePdfPageReason[] = [];
  if (page.classification !== "native_text" || page.characterCount <
    ADAPTIVE_PDF_MIN_NATIVE_CHARACTERS || page.textItemCount < 1 || page.rowCount < 1) {
    reasons.push("native_non_text");
  }
  if (page.invalidCharacterCount > 0) reasons.push("native_invalid_unicode");
  if (page.invisibleText) reasons.push("native_invisible_text");
  if (page.outOfBoundsTextItemCount > 0) reasons.push("native_invalid_geometry");
  if (massDuplicateGlyphs(page)) reasons.push("native_duplicate_glyphs");
  if (massOverlappingGlyphs(page)) reasons.push("native_overlapping_glyphs");
  if (page.pageRotation !== 0 || page.rotatedTextItemCount > 0) {
    reasons.push("native_rotated");
  }
  if (repeatedMultiColumnPattern(page)) {
    reasons.push("native_multi_column");
  }
  if (nativeFragmented(page)) reasons.push("native_fragmented");
  if (page.imageCount > 0) reasons.push("native_visual_content");
  if (materialVectorGraphics(page)) reasons.push("native_vector_graphics");
  if (page.textAreaRatio < ADAPTIVE_PDF_MIN_TEXT_AREA_RATIO) {
    reasons.push("native_low_text_coverage");
  }
  if (page.visualGroupOverflow) reasons.push("native_visual_group_overflow");
  if (complexNativeTablePattern(page)) {
    reasons.push("native_complex_table");
  }
  return reasons;
}

export function planAdaptivePdfPages(input: Readonly<{
  docling: ParsedDocument | null;
  geometry: NativePdfGeometry;
}>): AdaptivePdfPlan {
  const pages = input.geometry.quality.pages.map((page): AdaptivePdfPageRoute => {
    const reasons = Object.freeze([...new Set([
      ...nativeAdaptivePdfPageReasons(page),
      ...doclingReasons(input.geometry, input.docling, page)
    ])]);
    return Object.freeze({
      page: page.page,
      reasons,
      route: reasons.length === 0 ? "native_only" : "vision_required"
    });
  });
  const nativeOnlyPageCount = pages.filter((page) => page.route === "native_only").length;
  return Object.freeze({
    nativeOnlyPageCount,
    pages: Object.freeze(pages),
    visionRequiredPageCount: pages.length - nativeOnlyPageCount
  });
}
