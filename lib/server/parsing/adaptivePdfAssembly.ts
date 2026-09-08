import type { AdaptivePdfPlan } from "./adaptivePdf";
import { mergeAdaptivePdfDocument } from "./adaptivePdfMerge";
import { modelPdfPagesToDocument } from "./modelPdfOutput";
import type { NativePdfGeometry } from "./nativePdf";
import type { ParsedDocument } from "./types";

/** Storage-neutral final assembly; missing required pages remain an error. */
export function assembleAdaptivePdfPages(input: Readonly<{
  deduplicateNativeProseRows?: boolean;
  deduplicateNativeText?: boolean;
  deduplicateNativeFragments?: boolean;
  docling: ParsedDocument | null;
  geometry: NativePdfGeometry;
  legacyTableInference?: boolean;
  maxBlocks: number;
  maxCharacters: number;
  pages: readonly Readonly<{ page: number; text: string }>[];
  plan: AdaptivePdfPlan;
}>): ParsedDocument {
  const decodedByPage = new Map(input.pages.map((page) => [page.page, page]));
  const pages = Array.from({ length: input.geometry.pageCount }, (_, index) =>
    decodedByPage.get(index + 1) ?? Object.freeze({ page: index + 1, text: "" }));
  const vision = input.plan.visionRequiredPageCount > 0
    ? modelPdfPagesToDocument({
        legacyTableInference: input.legacyTableInference,
        maxBlocks: input.maxBlocks,
        maxCharacters: input.maxCharacters,
        mode: "system_model_vision",
        pageCount: input.geometry.pageCount,
        pages,
        preserveDisplayMath: input.deduplicateNativeText,
        preserveTextStructure: input.deduplicateNativeFragments,
        tableContinuationMarkers: true
      })
    : null;
  return mergeAdaptivePdfDocument({ ...input, vision });
}
