import { createHash } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import {
  decodeModelPdfBatchOutput,
  modelPdfPagesToDocument,
  modelPdfTranscriptionPrompt
} from "../parsing/modelPdfOutput";
import {
  inspectPdfForModelProcessing,
  PDF_MODEL_BATCH_PAGE_COUNT,
  PDF_MODEL_VISION_BATCH_PAGE_COUNT,
  preparePdfModelBatch,
  type PdfModelProcessingMode,
  type PreparedPdfBatch
} from "../parsing/pdfPreparation";
import type { ParsedDocument } from "../parsing/types";
import { extractNativePdfGeometry } from "../parsing/nativePdf";
import { enrichModelPdfGeometry } from "../parsing/pdfGeometry";
import { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../providers/runtimeFactory";
import { KNOWLEDGE_PDF_PARSER_PROFILE_VERSION } from "./knowledgeProfile";
import type {
  ProviderAttachment,
  ProviderRunRequest,
  ProviderRunResult
} from "../providers/types";
import {
  createKnowledgeModelPdfAttemptRepository,
  KnowledgeModelPdfAttemptError,
  type KnowledgeModelPdfAttemptIdentity,
  type SettledKnowledgeModelPdfBatch
} from "./modelPdfAttemptRepository";

export type KnowledgeModelPdfParsingErrorCode =
  | "pdf_processing_ambiguous"
  | "pdf_processing_failed"
  | "pdf_processing_unavailable";

export class KnowledgeModelPdfParsingError extends Error {
  constructor(readonly code: KnowledgeModelPdfParsingErrorCode) {
    super(code);
    this.name = "KnowledgeModelPdfParsingError";
  }
}

export type KnowledgeModelPdfParser = Readonly<{
  parse(input: Readonly<{
    artifactId: string;
    bytes: Buffer;
    maxBlocks: number;
    maxCharacters: number;
    maxPages: number;
    mode: PdfModelProcessingMode;
    ownerUserId: string;
    parserProfileVersion: number;
    profileRevisionId: string;
    signal?: AbortSignal;
    sourceVersionId: string;
    systemModelPolicyVersion: number | null;
    systemModelSnapshot: unknown;
  }>): Promise<ParsedDocument>;
}>;

type AttemptRepository = ReturnType<typeof createKnowledgeModelPdfAttemptRepository>;
type AcceptedExecutor = ReturnType<typeof createAcceptedProviderRequestExecutor>;
type PdfVisionDetail = "auto" | "original";

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function digestPreparedBatch(input: Readonly<{
  batch: PreparedPdfBatch;
  mode: PdfModelProcessingMode;
  profileRevisionId: string;
  prompt: string;
  snapshot: ProviderExecutionSnapshot;
  visionDetail: PdfVisionDetail;
}>): string {
  const hash = createHash("sha256");
  hash.update(input.visionDetail === "original"
    ? "knowledge-model-pdf-request-v2\0"
    : "knowledge-model-pdf-request-v1\0", "utf8");
  hash.update(input.mode, "utf8");
  hash.update("\0", "utf8");
  hash.update(input.profileRevisionId, "utf8");
  hash.update("\0", "utf8");
  hash.update(input.snapshot.providerModelId, "utf8");
  hash.update("\0", "utf8");
  hash.update(input.snapshot.credentialVersionId ?? "", "utf8");
  hash.update("\0", "utf8");
  hash.update(input.prompt, "utf8");
  if (input.visionDetail === "original") {
    hash.update("\0original", "utf8");
  }
  if (input.batch.kind === "pdf") {
    hash.update(input.batch.bytes);
  } else {
    for (const image of input.batch.images) {
      if (input.visionDetail === "original") {
        hash.update("\0", "utf8");
        hash.update(JSON.stringify({
          height: image.height,
          mimeType: image.mimeType,
          page: image.page,
          width: image.width
        }), "utf8");
      }
      hash.update(image.bytes);
    }
  }
  return hash.digest("hex");
}

function attachments(
  batch: PreparedPdfBatch,
  visionDetail: PdfVisionDetail
): ProviderAttachment[] {
  if (batch.kind === "pdf") {
    return [{
      base64Data: batch.bytes.toString("base64"),
      byteSize: batch.bytes.byteLength,
      extractedText: null,
      fileName: `pages-${String(batch.pageStart).padStart(6, "0")}-${String(batch.pageEnd).padStart(6, "0")}.pdf`,
      id: "knowledge-pdf-range",
      kind: "pdf",
      metadata: {
        pdf: {
          pageCount: batch.pageEnd - batch.pageStart + 1,
          sourcePageEnd: batch.pageEnd,
          sourcePageStart: batch.pageStart
        }
      },
      mimeType: "application/pdf",
      status: "ready"
    }];
  }
  return batch.images.map((image) => {
    const pageName = `page-${String(image.page).padStart(6, "0")}`;
    return {
      byteSize: image.bytes.byteLength,
      dataUrl: `data:${image.mimeType};base64,${image.bytes.toString("base64")}`,
      extractedText: null,
      fileName: `${pageName}.${
        image.mimeType === "image/png" ? "png" : "jpg"
      }`,
      id: `knowledge-pdf-page-${image.page}`,
      kind: "image",
      metadata: {
        image: {
          detail: visionDetail,
          height: image.height,
          sourcePage: image.page,
          width: image.width
        }
      },
      mimeType: image.mimeType,
      status: "ready"
    };
  });
}

function providerRequest(input: Readonly<{
  batch: PreparedPdfBatch;
  mode: PdfModelProcessingMode;
  prompt: string;
  snapshot: ProviderExecutionSnapshot;
  visionDetail: PdfVisionDetail;
}>): ProviderRunRequest {
  const files = attachments(input.batch, input.visionDetail);
  const declaredOutput = input.snapshot.model.capabilities.defaultMaxOutputTokens;
  const maxOutputTokens = typeof declaredOutput === "number" &&
    Number.isSafeInteger(declaredOutput) && declaredOutput > 0
    ? Math.min(32_768, declaredOutput)
    : 16_384;
  return {
    attachmentIds: files.map((attachment) => attachment.id),
    attachments: files,
    chatId: "knowledge-pdf-transcription",
    content: { blocks: [{ text: input.prompt, type: "text" }] },
    forceNonStreaming: true,
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    modelCapabilities: {
      ...input.snapshot.model.capabilities,
      nativePdfInput: input.mode === "system_model_direct_pdf"
    },
    modelId: input.snapshot.model.upstreamModelId,
    params: {
      ...input.snapshot.model.defaultParams,
      background: false,
      maxOutputTokens,
      maxTokens: maxOutputTokens,
      max_output_tokens: maxOutputTokens,
      store: false,
      stream: false
    },
    prompt: { developer: null, system: null },
    provider: input.snapshot.providerFamily,
    searchPlan: { mode: "all_selected", options: [] },
    toolChoice: "none",
    toolMode: "none",
    tools: []
  };
}

function validSnapshot(
  input: Parameters<KnowledgeModelPdfParser["parse"]>[0]
): ProviderExecutionSnapshot {
  if (![1, 2, 3, 4, 5, 6, KNOWLEDGE_PDF_PARSER_PROFILE_VERSION]
    .includes(input.parserProfileVersion) ||
    !Number.isSafeInteger(input.systemModelPolicyVersion) ||
    Number(input.systemModelPolicyVersion) < 1) {
    throw new KnowledgeModelPdfParsingError("pdf_processing_unavailable");
  }
  let snapshot: ProviderExecutionSnapshot;
  try {
    snapshot = normalizeProviderExecutionSnapshot(input.systemModelSnapshot);
  } catch {
    throw new KnowledgeModelPdfParsingError("pdf_processing_unavailable");
  }
  const available = input.mode === "system_model_direct_pdf"
    ? snapshot.model.capabilities.nativePdfInput === true
    : snapshot.model.capabilities.vision === true;
  if (!available || snapshot.model.adapterKind === "fake" ||
    snapshot.model.modelClass !== "answer") {
    throw new KnowledgeModelPdfParsingError("pdf_processing_unavailable");
  }
  return snapshot;
}

function modelFailure(error: unknown): KnowledgeModelPdfParsingError {
  if (error instanceof KnowledgeModelPdfParsingError) return error;
  if (error instanceof KnowledgeModelPdfAttemptError &&
    error.code === "pdf_processing_ambiguous") {
    return new KnowledgeModelPdfParsingError("pdf_processing_ambiguous");
  }
  return new KnowledgeModelPdfParsingError("pdf_processing_failed");
}

export function createKnowledgeModelPdfParser(
  prisma: PrismaClient,
  options: Readonly<{
    attemptRepository?: AttemptRepository;
    execute?: AcceptedExecutor;
    extractGeometry?: typeof extractNativePdfGeometry;
    inspect?: typeof inspectPdfForModelProcessing;
    now?: () => Date;
    prepare?: typeof preparePdfModelBatch;
  }> = {}
): KnowledgeModelPdfParser {
  const attemptRepository = options.attemptRepository ??
    createKnowledgeModelPdfAttemptRepository(prisma);
  const execute = options.execute ?? createAcceptedProviderRequestExecutor(prisma);
  const extractGeometry = options.extractGeometry ?? extractNativePdfGeometry;
  const inspect = options.inspect ?? inspectPdfForModelProcessing;
  const prepare = options.prepare ?? preparePdfModelBatch;
  const now = options.now ?? (() => new Date());

  return {
    async parse(input) {
      if (input.signal?.aborted) throw abortReason(input.signal);
      const snapshot = validSnapshot(input);
      let pageCount: number;
      try {
        pageCount = (await inspect({
          bytes: input.bytes,
          mode: input.mode,
          ...(input.signal ? { signal: input.signal } : {})
        }, { maxPages: input.maxPages })).pageCount;
      } catch (error) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        throw modelFailure(error);
      }
      const settled: SettledKnowledgeModelPdfBatch[] = [];
      const highFidelityVision = input.mode === "system_model_vision" &&
        input.parserProfileVersion >= 3;
      const adaptiveHighFidelityVision = highFidelityVision &&
        input.parserProfileVersion >= 4;
      const visionDetail: PdfVisionDetail = input.mode === "system_model_vision" &&
        input.parserProfileVersion >= 5 ? "original" : "auto";
      const batchPageCount = highFidelityVision
        ? PDF_MODEL_VISION_BATCH_PAGE_COUNT
        : PDF_MODEL_BATCH_PAGE_COUNT;
      for (let pageStart = 1, batchIndex = 0; pageStart <= pageCount;
        pageStart += batchPageCount, batchIndex += 1) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        const pageEnd = Math.min(pageCount, pageStart + batchPageCount - 1);
        let prepared: PreparedPdfBatch;
        try {
          prepared = await prepare({
            bytes: input.bytes,
            mode: input.mode,
            pageEnd,
            pageStart,
            ...(input.signal ? { signal: input.signal } : {})
          }, {
            maxPages: input.maxPages,
            visionQuality: adaptiveHighFidelityVision ? "adaptive_high_fidelity"
              : highFidelityVision ? "high_fidelity" : "legacy"
          });
        } catch (error) {
          if (input.signal?.aborted) throw abortReason(input.signal);
          throw modelFailure(error);
        }
        const prompt = modelPdfTranscriptionPrompt({
          mode: input.mode,
          pageEnd,
          pageStart,
          promptVersion: input.parserProfileVersion >= 7
            ? 5
            : input.parserProfileVersion >= 6 ? 4
            : input.parserProfileVersion >= 5 ? 3
            : input.parserProfileVersion >= 3 ? 2 : 1
        });
        const identity: KnowledgeModelPdfAttemptIdentity = {
          artifactId: input.artifactId,
          batchIndex,
          mode: input.mode,
          pageEnd,
          pageStart,
          requestDigest: digestPreparedBatch({
            batch: prepared,
            mode: input.mode,
            profileRevisionId: input.profileRevisionId,
            prompt,
            snapshot,
            visionDetail
          }),
          sourceVersionId: input.sourceVersionId
        };
        let reservation;
        try {
          reservation = await attemptRepository.reserve({ ...identity, now: now() });
        } catch (error) {
          throw modelFailure(error);
        }
        if (reservation.kind === "settled") {
          settled.push(reservation.batch);
          continue;
        }
        const dispatched = await attemptRepository.markDispatched({
          ...identity,
          attemptId: reservation.attemptId,
          now: now()
        });
        if (!dispatched) {
          throw new KnowledgeModelPdfParsingError("pdf_processing_ambiguous");
        }
        let result: ProviderRunResult;
        try {
          result = await execute(snapshot, providerRequest({
            batch: prepared,
            mode: input.mode,
            prompt,
            snapshot,
            visionDetail
          }), {
            ...(input.signal ? { signal: input.signal } : {}),
            timeoutMs: 300_000
          });
        } catch (error) {
          await attemptRepository.markAmbiguous(reservation.attemptId, now()).catch(() => undefined);
          if (input.signal?.aborted) throw abortReason(input.signal);
          throw new KnowledgeModelPdfParsingError("pdf_processing_ambiguous");
        }
        let batch: SettledKnowledgeModelPdfBatch;
        try {
          batch = await attemptRepository.settle({
            ...identity,
            attemptId: reservation.attemptId,
            now: now(),
            ownerUserId: input.ownerUserId,
            resultText: result.finalText,
            snapshot,
            usage: result.usage as ModelRunUsage
          });
        } catch (error) {
          throw modelFailure(error);
        }
        settled.push(batch);
      }
      try {
        const pages = settled.flatMap((batch) => decodeModelPdfBatchOutput({
          mode: input.mode,
          pageEnd: batch.pageEnd,
          pageStart: batch.pageStart,
          text: batch.resultText
        }));
        const document = modelPdfPagesToDocument({
          maxBlocks: input.maxBlocks,
          maxCharacters: input.maxCharacters,
          mode: input.mode,
          pageCount,
          pages,
          tableContinuationMarkers: input.parserProfileVersion >= 7
        });
        try {
          const geometry = await extractGeometry({
            bytes: input.bytes,
            fileName: "source.pdf",
            mimeType: "application/pdf",
            ...(input.signal ? { signal: input.signal } : {})
          }, {
            maxBlocks: input.maxBlocks,
            maxCharacters: input.maxCharacters,
            maxPages: input.maxPages
          });
          return enrichModelPdfGeometry(document, geometry);
        } catch {
          if (input.signal?.aborted) throw abortReason(input.signal);
          return document;
        }
      } catch (error) {
        if (input.signal?.aborted) throw abortReason(input.signal);
        throw modelFailure(error);
      }
    }
  };
}
