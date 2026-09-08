import type { ProviderExecutionSnapshot } from "../providers/runtimeFactory";
import type { ProviderModelCapabilities } from "../providers/types";
import { applyProviderRequestContextBudget } from "../runs/runContextBudget";
import { planAdaptivePdfPages, type AdaptivePdfPlan } from "./adaptivePdf";
import { assembleAdaptivePdfPages } from "./adaptivePdfAssembly";
import { adaptivePdfVisionPrompt, prepareAdaptivePdfVisionSupplement } from "./adaptivePdfVision";
import type { DoclingLayoutParser } from "./doclingLayout";
import { DocumentParserError } from "./errors";
import {
  decodeModelPdfBatchOutput, MODEL_PDF_TEXT_COVERAGE_PROFILE_VERSION,
  modelPdfPagesToDocument, modelPdfTranscriptionPrompt
} from "./modelPdfOutput";
import { modelPdfProviderRequest } from "./modelPdfRequest";
import { nativeTextIsProse } from "./pdfGeometry";
import { extractNativePdfGeometry, type NativePdfGeometry } from "./nativePdf";
import { PDF_MODEL_MAX_IMAGE_BYTES, PDF_MODEL_MAX_IMAGE_PIXELS, preparePdfModelBatch } from "./pdfPreparation";
import type { ParsedDocument } from "./types";

export const PDF_OCR_PARSER_VERSION = MODEL_PDF_TEXT_COVERAGE_PROFILE_VERSION;
export const PDF_OCR_PROMPT_VERSION = 8;
export const PDF_OCR_PAGE_OUTPUT_MAX_CHARACTERS = 500_000;
// One full page plus at most two table crops. The renderer's 16 MiB page
// ceiling and two 2 MiB crops fit within this bounded base64 request envelope.
export const PDF_OCR_IMAGE_LIMITS: NonNullable<ProviderModelCapabilities["imageInputLimits"]> = Object.freeze({
  imageBytes: PDF_MODEL_MAX_IMAGE_BYTES, imageCount: 3,
  imagePixels: PDF_MODEL_MAX_IMAGE_PIXELS, payloadBytes: 32 * 1024 * 1024
});

export function pdfOcrImageLimits(capabilities: ProviderModelCapabilities): typeof PDF_OCR_IMAGE_LIMITS {
  const declared = capabilities.imageInputLimits;
  return {
    imageBytes: Math.min(declared?.imageBytes ?? Infinity, PDF_OCR_IMAGE_LIMITS.imageBytes),
    imageCount: Math.min(declared?.imageCount ?? Infinity, PDF_OCR_IMAGE_LIMITS.imageCount),
    imagePixels: Math.min(declared?.imagePixels ?? Infinity, PDF_OCR_IMAGE_LIMITS.imagePixels),
    payloadBytes: Math.min(declared?.payloadBytes ?? Infinity, PDF_OCR_IMAGE_LIMITS.payloadBytes)
  };
}

export type PdfOcrLocal = Readonly<{
  docling: ParsedDocument | null;
  geometry: NativePdfGeometry | null;
  plan: AdaptivePdfPlan | null;
}>;

/** Shared quality policy; callers retain their own authority, durable work,
 * storage, concurrency and accounting. Local failure never changes provider. */
export async function planPdfOcrSource(input: Readonly<{
  bytes: Buffer; maxBlocks: number; maxCharacters: number; maxPages: number;
  pageCount: number; signal?: AbortSignal;
}>, options: Readonly<{
  extractGeometry?: typeof extractNativePdfGeometry;
  parseDocling?: DoclingLayoutParser | null;
}> = {}): Promise<PdfOcrLocal> {
  input.signal?.throwIfAborted();
  const source = { bytes: input.bytes, fileName: "source.pdf", mimeType: "application/pdf", signal: input.signal };
  let geometry: NativePdfGeometry | null = null;
  let docling: ParsedDocument | null = null;
  try {
    geometry = await (options.extractGeometry ?? extractNativePdfGeometry)(source, {
      maxBlocks: input.maxBlocks, maxCharacters: input.maxCharacters, maxPages: input.maxPages
    });
    if (geometry.pageCount !== input.pageCount) geometry = null;
  } catch { input.signal?.throwIfAborted(); }
  if (geometry && options.parseDocling) {
    try {
      docling = await options.parseDocling({ ...source, parserProfileVersion: PDF_OCR_PARSER_VERSION });
    } catch { input.signal?.throwIfAborted(); }
  }
  input.signal?.throwIfAborted();
  if (!geometry) return { geometry, docling, plan: null };
  const baseline = planAdaptivePdfPages({ geometry, docling });
  const needsStructure = new Set(geometry.blocks.filter(block => block.isTable ||
    /\p{L}/u.test(block.text) && !nativeTextIsProse(block.text)).map(block => block.page));
  const pages = baseline.pages.map(page => page.route === "native_only" && needsStructure.has(page.page)
    ? { ...page, route: "vision_required" as const, reasons: [...page.reasons, "native_math_structure" as const] }
    : page);
  const nativeOnlyPageCount = pages.filter(page => page.route === "native_only").length;
  return { geometry, docling, plan: { pages, nativeOnlyPageCount,
    visionRequiredPageCount: pages.length - nativeOnlyPageCount } };
}

export async function preparePdfOcrPage(input: Readonly<{
  bytes: Buffer; local: PdfOcrLocal; maxPages: number; page: number;
  signal?: AbortSignal; snapshot: ProviderExecutionSnapshot;
}>, prepare: typeof preparePdfModelBatch = preparePdfModelBatch) {
  input.signal?.throwIfAborted();
  const limits = pdfOcrImageLimits(input.snapshot.model.capabilities);
  const batch = await prepare({ bytes: input.bytes, mode: "system_model_vision",
    pageStart: input.page, pageEnd: input.page, signal: input.signal }, {
    maxImageBytes: limits.imageBytes, maxPages: input.maxPages, visionQuality: "adaptive_high_fidelity"
  });
  input.signal?.throwIfAborted();
  const supplement = input.local.geometry ? await prepareAdaptivePdfVisionSupplement({
    batch, docling: input.local.docling, geometry: input.local.geometry, includeFigures: false
  }) : null;
  input.signal?.throwIfAborted();
  const base = modelPdfTranscriptionPrompt({ mode: "system_model_vision", pageStart: input.page,
    pageEnd: input.page, promptVersion: PDF_OCR_PROMPT_VERSION });
  const prompt = supplement ? adaptivePdfVisionPrompt(base, supplement) : base;
  const request = modelPdfProviderRequest({ batch, mode: "system_model_vision", prompt,
    snapshot: input.snapshot, supplement, visionDetail: "original" });
  if (request.attachments.length > limits.imageCount ||
    request.attachments.some(image => image.byteSize > limits.imageBytes) ||
    request.attachments.some(image => {
      const size = (image.metadata as { image?: { height?: number; width?: number } })?.image;
      return !size?.height || !size.width || size.height * size.width > limits.imagePixels;
    }) || Buffer.byteLength(JSON.stringify(request)) > limits.payloadBytes ||
    !applyProviderRequestContextBudget({ request }).ok) {
    throw new DocumentParserError("parser_output_too_large", "system_model_vision");
  }
  return { batch, prompt, request, supplement };
}

export function decodePdfOcrPage(page: number, text: string) {
  if (text.length > PDF_OCR_PAGE_OUTPUT_MAX_CHARACTERS) {
    throw new DocumentParserError("parser_output_too_large", "system_model_vision");
  }
  return decodeModelPdfBatchOutput({ mode: "system_model_vision", pageStart: page, pageEnd: page,
    preserveTableWhitespace: true, text });
}

export function assemblePdfOcrDocument(input: Readonly<{
  local: PdfOcrLocal; maxBlocks: number; maxCharacters: number; pageCount: number;
  pages: readonly Readonly<{ page: number; text: string }>[];
}>): ParsedDocument {
  const { geometry, docling, plan } = input.local;
  return plan && geometry
    ? assembleAdaptivePdfPages({ docling, geometry, plan, pages: input.pages,
      maxBlocks: input.maxBlocks, maxCharacters: input.maxCharacters,
      deduplicateNativeText: true, deduplicateNativeProseRows: true, legacyTableInference: false })
    : modelPdfPagesToDocument({ pages: input.pages, pageCount: input.pageCount,
      maxBlocks: input.maxBlocks, maxCharacters: input.maxCharacters, mode: "system_model_vision",
      preserveDisplayMath: true, tableContinuationMarkers: true, legacyTableInference: false });
}
