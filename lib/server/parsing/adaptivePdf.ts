import type { NativePdfGeometry, NativePdfPageMetrics } from "./nativePdf";

/** First immutable System Model Vision profile that routes simple PDF pages
 * through a strict native-text whitelist and keeps Vision mandatory for every
 * page that cannot prove all safe-native conditions. */
export const MODEL_PDF_ADAPTIVE_HYBRID_PROFILE_VERSION = 13 as const;

export const ADAPTIVE_PDF_MIN_NATIVE_CHARACTERS = 16;
export const ADAPTIVE_PDF_MIN_TEXT_AREA_RATIO = 0.001;
export const ADAPTIVE_PDF_VECTOR_MIN_OPERATIONS = 128;

/**
 * Why a page needs Vision. A page could skip Vision only where an independent layout agreed with its native text, and
 * none is left since the docling sidecar's removal (operator decision 2026-10-23), so every page carries
 * `docling_unavailable` and is read by Vision; the name stays as stored plans have always recorded it.
 */
export type AdaptivePdfPageReason =
  | "docling_unavailable"
  | "native_complex_table"
  | "native_duplicate_glyphs"
  | "native_fragmented"
  | "native_invalid_geometry"
  | "native_invalid_unicode"
  | "native_invisible_text"
  | "native_low_text_coverage"
  | "native_math_structure"
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

function nativeAdaptivePdfPageReasons(
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
  geometry: NativePdfGeometry;
}>): AdaptivePdfPlan {
  const pages = input.geometry.quality.pages.map((page): AdaptivePdfPageRoute => {
    const reasons = Object.freeze([...new Set<AdaptivePdfPageReason>([
      ...nativeAdaptivePdfPageReasons(page),
      "docling_unavailable"
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
