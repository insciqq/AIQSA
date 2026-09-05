import { createHash } from "node:crypto";
import { ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS, PDF_PROCESSING_MAX_PAGES } from "../../contracts/uploads";
import { planAdaptivePdfPages, type AdaptivePdfPlan } from "../parsing/adaptivePdf";
import { assembleAdaptivePdfPages } from "../parsing/adaptivePdfAssembly";
import { adaptivePdfTableRegions, adaptivePdfVisionPrompt, prepareAdaptivePdfVisionSupplement } from "../parsing/adaptivePdfVision";
import { finalizeParsedDocument } from "../parsing/assessment";
import { createConfiguredDoclingLayoutParser, type DoclingLayoutParser } from "../parsing/doclingLayout";
import { decodeModelPdfBatchOutput, MODEL_PDF_VISUAL_DATA_PROJECTION_PROFILE_VERSION, modelPdfPagesToDocument, modelPdfTranscriptionPrompt } from "../parsing/modelPdfOutput";
import { digestPreparedPdfBatch, modelPdfProviderRequest } from "../parsing/modelPdfRequest";
import { extractNativePdfGeometry, type NativePdfGeometry } from "../parsing/nativePdf";
import { inspectPdfForModelProcessing, preparePdfModelBatch } from "../parsing/pdfPreparation";
import type { ParsedBoundingBox, ParsedDocument } from "../parsing/types";
import type { ProviderModelCapabilities, ProviderRunRequest } from "../providers/types";
import { applyProviderRequestContextBudget } from "../runs/runContextBudget";
import { type ChatPdfAttachmentAdmission, chatPdfFingerprint } from "./chatPdfAdmission";
import { getPdfExtractionConfig } from "./pdfConfig";

export const CHAT_PDF_PARSER_VERSION = MODEL_PDF_VISUAL_DATA_PROJECTION_PROFILE_VERSION;
export const CHAT_PDF_RENDER_VERSION = 1;
export const CHAT_PDF_PROMPT_VERSION = 6;
export const CHAT_PDF_ARTIFACT_MAX_BYTES = 32 * 1024 * 1024;
export const CHAT_PDF_PAGE_OUTPUT_MAX_CHARACTERS = 500_000;
export const CHAT_PDF_WORKSPACE_ORIGINAL_NOTICE =
  "PDF text preparation was unsuccessful. The original file is available through Workspace tools; inspect it there before making claims about its contents.";
// These are application ceilings, not a claim about a provider's capacity.
// One page and at most two table crops are sent in each bounded request.
export const CHAT_PDF_IMAGE_LIMITS: NonNullable<ProviderModelCapabilities["imageInputLimits"]> = Object.freeze({
  imageBytes: 2 * 1024 * 1024,
  imageCount: 3,
  imagePixels: 10_000_000,
  payloadBytes: 9 * 1024 * 1024
});

export function chatPdfImageLimits(admission: ChatPdfAttachmentAdmission): typeof CHAT_PDF_IMAGE_LIMITS {
  const declared = admission.snapshot?.model.capabilities.imageInputLimits;
  return { imageBytes: Math.min(declared?.imageBytes ?? Infinity, CHAT_PDF_IMAGE_LIMITS.imageBytes),
    imageCount: Math.min(declared?.imageCount ?? Infinity, CHAT_PDF_IMAGE_LIMITS.imageCount),
    imagePixels: Math.min(declared?.imagePixels ?? Infinity, CHAT_PDF_IMAGE_LIMITS.imagePixels),
    payloadBytes: Math.min(declared?.payloadBytes ?? Infinity, CHAT_PDF_IMAGE_LIMITS.payloadBytes) };
}

export class ChatPdfPreparationError extends Error {
  constructor(readonly code: "pdf_preparation_failed" | "pdf_preparation_ambiguous" |
    "pdf_preparation_unavailable" | "pdf_preparation_invalid" | "pdf_local_text_unusable" |
    "pdf_page_limit_exceeded" | "pdf_preparation_context_limit" | "pdf_transcription_failed", readonly retryable = false) {
    super(code);
    this.name = "ChatPdfPreparationError";
  }
}

export type ChatPdfLocalExtraction = Readonly<{
  docling: ParsedDocument | null;
  geometry: NativePdfGeometry | null;
  pageCount: number;
}>;

export type ChatPdfWorkPlan = Readonly<{
  adaptive: AdaptivePdfPlan | null;
  compatibilityKey: string;
  limits: typeof CHAT_PDF_IMAGE_LIMITS;
  maxBlocks: number;
  maxCharacters: number;
  pageCount: number;
  parserVersion: number;
  promptVersion: number;
  renderVersion: number;
  units: readonly Readonly<{
    crops: readonly ParsedBoundingBox[];
    key: string;
    page: number;
    route: "native_only" | "vision_required";
  }>[];
  version: 1;
}>;

function aborted(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function chatPdfCompatibilityKey(admission: ChatPdfAttachmentAdmission): string {
  return chatPdfFingerprint({
    authority: admission.authority,
    limits: chatPdfImageLimits(admission),
    parserVersion: CHAT_PDF_PARSER_VERSION,
    promptVersion: CHAT_PDF_PROMPT_VERSION,
    renderVersion: CHAT_PDF_RENDER_VERSION,
    route: admission.route,
    snapshot: admission.snapshot,
    sourceChecksum: admission.sourceChecksum
  });
}

export function validateChatPdfSource(bytes: Buffer, admission: ChatPdfAttachmentAdmission): void {
  if (bytes.length !== admission.byteSize ||
    createHash("sha256").update(bytes).digest("hex") !== admission.sourceChecksum) {
    throw new ChatPdfPreparationError("pdf_preparation_invalid");
  }
}

export function encodeChatPdfArtifact(value: unknown): Readonly<{ body: Buffer; checksum: string }> {
  const body = Buffer.from(JSON.stringify({ version: 1, value }));
  if (body.length > CHAT_PDF_ARTIFACT_MAX_BYTES) {
    throw new ChatPdfPreparationError("pdf_preparation_invalid");
  }
  return { body, checksum: createHash("sha256").update(body).digest("hex") };
}

/** Only checksum-authenticated, private objects written by this pipeline reach
 * this decoder. Provider text is decoded separately before artifact publication. */
export function decodeChatPdfArtifact(body: Buffer, expected: Readonly<{
  byteSize: number; checksum: string;
}>): unknown {
  if (body.length > CHAT_PDF_ARTIFACT_MAX_BYTES || body.length !== expected.byteSize ||
    createHash("sha256").update(body).digest("hex") !== expected.checksum) {
    throw new ChatPdfPreparationError("pdf_preparation_invalid");
  }
  try {
    const artifact = JSON.parse(body.toString("utf8"));
    if (artifact?.version !== 1 || !Object.hasOwn(artifact, "value")) throw new Error();
    return artifact.value;
  } catch {
    throw new ChatPdfPreparationError("pdf_preparation_invalid");
  }
}

export function createChatPdfCore(options: Readonly<{
  extractGeometry?: typeof extractNativePdfGeometry;
  inspect?: typeof inspectPdfForModelProcessing;
  parseDocling?: DoclingLayoutParser | null;
  prepare?: typeof preparePdfModelBatch;
}> = {}) {
  const inspect = options.inspect ?? inspectPdfForModelProcessing;
  const extractGeometry = options.extractGeometry ?? extractNativePdfGeometry;
  const parseDocling = options.parseDocling === undefined
    ? createConfiguredDoclingLayoutParser() : options.parseDocling;
  const prepare = options.prepare ?? preparePdfModelBatch;
  return {
    async plan(input: Readonly<{
      admission: ChatPdfAttachmentAdmission;
      bytes: Buffer;
      onPageCount(pageCount: number): Promise<void>;
      signal?: AbortSignal;
    }>): Promise<Readonly<{ local: ChatPdfLocalExtraction; plan: ChatPdfWorkPlan }>> {
      aborted(input.signal);
      validateChatPdfSource(input.bytes, input.admission);
      const config = getPdfExtractionConfig();
      const maxPages = Math.min(PDF_PROCESSING_MAX_PAGES, config.maxPages);
      const { pageCount } = await inspect({ bytes: input.bytes, mode: "system_model_vision",
        signal: input.signal }, { maxPages });
      if (input.admission.pageCount !== null && pageCount !== input.admission.pageCount) {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      await input.onPageCount(pageCount);
      const maxBlocks = 100_000;
      const maxCharacters = Math.min(ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS, config.extractedTextMaxChars);
      let geometry: NativePdfGeometry | null = null;
      let docling: ParsedDocument | null = null;
      try {
        geometry = await extractGeometry({ bytes: input.bytes, fileName: "source.pdf",
          mimeType: "application/pdf", signal: input.signal }, { maxBlocks, maxCharacters, maxPages });
        if (geometry.pageCount !== pageCount) geometry = null;
      } catch { aborted(input.signal); }
      if (input.admission.route !== "local_text" && geometry && parseDocling) {
        try {
          docling = await parseDocling({ bytes: input.bytes, fileName: "source.pdf",
            mimeType: "application/pdf", parserProfileVersion: CHAT_PDF_PARSER_VERSION,
            signal: input.signal });
        } catch { aborted(input.signal); }
      }
      const adaptive = input.admission.route !== "local_text" && geometry
        ? planAdaptivePdfPages({ geometry, docling }) : null;
      const compatibilityKey = chatPdfCompatibilityKey(input.admission);
      const units = Array.from({ length: pageCount }, (_, index) => {
        const page = index + 1;
        const route = input.admission.route === "local_text" ? "native_only" as const
          : adaptive?.pages[index]?.route ?? "vision_required" as const;
        const metrics = geometry?.quality.pages[index];
        const crops = route === "vision_required" && geometry && metrics
          ? adaptivePdfTableRegions({ geometry, docling, page: metrics }) : [];
        return { crops, key: chatPdfFingerprint({ compatibilityKey, crops, page, route }), page, route };
      });
      return { local: { docling, geometry, pageCount }, plan: {
        adaptive, compatibilityKey, limits: chatPdfImageLimits(input.admission), maxBlocks, maxCharacters,
        pageCount, parserVersion: CHAT_PDF_PARSER_VERSION, promptVersion: CHAT_PDF_PROMPT_VERSION,
        renderVersion: CHAT_PDF_RENDER_VERSION, units, version: 1
      } };
    },

    async page(input: Readonly<{
      admission: ChatPdfAttachmentAdmission;
      bytes: Buffer;
      local: ChatPdfLocalExtraction;
      plan: ChatPdfWorkPlan;
      page: number;
      signal?: AbortSignal;
    }>): Promise<Readonly<{ request: ProviderRunRequest; requestDigest: string }>> {
      aborted(input.signal);
      validateChatPdfSource(input.bytes, input.admission);
      const snapshot = input.admission.snapshot;
      const unit = input.plan.units[input.page - 1];
      if (!snapshot || input.admission.route === "local_text" || input.admission.route === "direct_pdf" ||
        input.plan.compatibilityKey !== chatPdfCompatibilityKey(input.admission) ||
        !unit || unit.page !== input.page || unit.route !== "vision_required") {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      const batch = await prepare({ bytes: input.bytes, mode: "system_model_vision",
        pageStart: input.page, pageEnd: input.page, signal: input.signal }, {
        maxImageBytes: input.plan.limits.imageBytes, maxPages: PDF_PROCESSING_MAX_PAGES,
        visionQuality: "adaptive_high_fidelity"
      });
      aborted(input.signal);
      const supplement = input.local.geometry ? await prepareAdaptivePdfVisionSupplement({
        batch, docling: input.local.docling, geometry: input.local.geometry
      }) : null;
      aborted(input.signal);
      if ((supplement?.crops.length ?? 0) !== unit.crops.length) {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      const base = modelPdfTranscriptionPrompt({ mode: "system_model_vision",
        pageStart: input.page, pageEnd: input.page, promptVersion: CHAT_PDF_PROMPT_VERSION });
      const prompt = supplement ? adaptivePdfVisionPrompt(base, supplement) : base;
      const request = modelPdfProviderRequest({ batch, mode: "system_model_vision",
        prompt, snapshot, supplement, visionDetail: "original" });
      request.chatId = "chat-pdf-transcription";
      if (request.attachments.length > input.plan.limits.imageCount ||
        request.attachments.some((image) => image.byteSize > input.plan.limits.imageBytes) ||
        request.attachments.some((image) => {
          const size = (image.metadata as { image?: { height?: number; width?: number } })?.image;
          return !size?.height || !size.width || size.height * size.width > input.plan.limits.imagePixels;
        }) ||
        Buffer.byteLength(JSON.stringify(request)) > input.plan.limits.payloadBytes) {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      // Budget the actual rendered images and native-text supplement against
      // this frozen model before reserving a billable provider attempt.
      if (!applyProviderRequestContextBudget({ request }).ok) {
        throw new ChatPdfPreparationError("pdf_preparation_context_limit");
      }
      return { request, requestDigest: digestPreparedPdfBatch({ batch, mode: "system_model_vision",
        profileRevisionId: unit.key, prompt, snapshot, supplement, visionDetail: "original" }) };
    },

    assemble(input: Readonly<{
      admission: ChatPdfAttachmentAdmission;
      local: ChatPdfLocalExtraction;
      plan: ChatPdfWorkPlan;
      results: readonly Readonly<{ page: number; text: string }>[];
    }>): ParsedDocument {
      if (input.plan.compatibilityKey !== chatPdfCompatibilityKey(input.admission)) {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      if (input.admission.route === "local_text") {
        const document = finalizeParsedDocument({ blocks: input.local.geometry?.blocks ?? [],
          engine: "native_pdf", mediaType: "application/pdf", pageCount: input.plan.pageCount,
          status: "complete" });
        if (!document.text.trim() || !document.quality.encodingValid) {
          throw new ChatPdfPreparationError("pdf_local_text_unusable");
        }
        return document;
      }
      const required = input.plan.units.filter((unit) => unit.route === "vision_required");
      if (input.results.length !== required.length || new Set(input.results.map(({ page }) => page)).size !== required.length ||
        required.some((unit) => !input.results.some(({ page }) => page === unit.page))) {
        throw new ChatPdfPreparationError("pdf_preparation_invalid");
      }
      const pages = [...input.results].sort((a, b) => a.page - b.page).flatMap(({ page, text }) =>
        decodeChatPdfPage(page, text));
      return input.plan.adaptive && input.local.geometry
        ? assembleAdaptivePdfPages({ docling: input.local.docling, geometry: input.local.geometry,
            maxBlocks: input.plan.maxBlocks, maxCharacters: input.plan.maxCharacters,
            pages, plan: input.plan.adaptive })
        : modelPdfPagesToDocument({ maxBlocks: input.plan.maxBlocks,
            maxCharacters: input.plan.maxCharacters, mode: "system_model_vision",
            pageCount: input.plan.pageCount, pages, tableContinuationMarkers: true });
    }
  };
}

export function decodeChatPdfPage(page: number, text: string) {
  if (text.length > CHAT_PDF_PAGE_OUTPUT_MAX_CHARACTERS) {
    throw new ChatPdfPreparationError("pdf_preparation_invalid", true);
  }
  return decodeModelPdfBatchOutput({ mode: "system_model_vision", pageStart: page, pageEnd: page, text });
}
