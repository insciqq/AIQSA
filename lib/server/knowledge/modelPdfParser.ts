import { digestPreparedPdfBatch as digestPreparedBatch, modelPdfProviderRequest as providerRequest, type PdfVisionDetail } from "../parsing/modelPdfRequest";
import type { PrismaClient } from "@prisma/client";
import type { ModelRunUsage } from "../../domain/modelRunEvents";
import { sumTokenUsage } from "../../domain/usage";
import { ingestionConcurrency, IngestionWorkPool, mapIngestionWork } from "./ingestionConcurrency";
import {
  decodeModelPdfBatchOutput,
  MODEL_PDF_VISUAL_DATA_PROJECTION_PROFILE_VERSION,
  MODEL_PDF_EXPLICIT_TABLE_STRUCTURE_PROFILE_VERSION,
  MODEL_PDF_CHART_POINT_PROJECTION_PROFILE_VERSION,
  MODEL_PDF_FIGURE_CROP_PROFILE_VERSION,
  MODEL_PDF_TEXT_COVERAGE_PROFILE_VERSION,
  MODEL_PDF_LAYOUT_TEXT_PROFILE_VERSION,
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
import {
  extractNativePdfGeometry,
  type NativePdfGeometry
} from "../parsing/nativePdf";
import {
  MODEL_PDF_ADAPTIVE_HYBRID_PROFILE_VERSION,
  planAdaptivePdfPages,
  type AdaptivePdfPlan
} from "../parsing/adaptivePdf";
import { assembleAdaptivePdfPages } from "../parsing/adaptivePdfAssembly";
import {
  assemblePdfOcrDocument, decodePdfOcrPage, isSharedPdfOcrParserVersion,
  planPdfOcrSource, preparePdfOcrPage
} from "../parsing/pdfOcrPipeline";
import {
  adaptivePdfVisionPrompt,
  prepareAdaptivePdfVisionSupplement,
  type AdaptivePdfVisionSupplement
} from "../parsing/adaptivePdfVision";
import type { DoclingLayoutParser } from "../parsing/doclingLayout";
import {
  enrichModelPdfGeometry,
  mergeModelPdfWithNativeText,
  MODEL_PDF_NATIVE_PROSE_DEDUPLICATION_PROFILE_VERSION,
  MODEL_PDF_NATIVE_TEXT_COLLABORATION_PROFILE_VERSION,
  MODEL_PDF_NATIVE_TEXT_CORRECTION_PROFILE_VERSION
} from "../parsing/pdfGeometry";
import { createAcceptedProviderRequestExecutor } from "../providerRuntime/acceptedRequestExecutor";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../providers/runtimeFactory";
import { isProviderDeadlineExceededError } from "../providers/network";
import { effectiveProviderResponseTimeoutMs } from "../providers/providerConfiguration";
import { openAIRetryableErrorPayload } from "../providers/openaiResponsesTransport";
import {
  executeWithProviderRetry,
  isRetryableProviderNetworkError,
  type ProviderRetryOptions
} from "../providers/providerRetry";
import type {
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
    processingGeneration: number;
    profileRevisionId: string;
    signal?: AbortSignal;
    sourceVersionId: string;
    systemModelPolicyVersion: number | null;
    systemModelSnapshot: unknown;
  }>): Promise<ParsedDocument>;
}>;

type AttemptRepository = ReturnType<typeof createKnowledgeModelPdfAttemptRepository>;
type AcceptedExecutor = ReturnType<typeof createAcceptedProviderRequestExecutor>;

export const KNOWLEDGE_MODEL_PDF_VISION_PAGE_CONCURRENCY = 4 as const;
export const KNOWLEDGE_MODEL_PDF_PROVIDER_MAX_ATTEMPTS = 3 as const;

class RetryableKnowledgeModelPdfOutputError extends Error {
  constructor() {
    super("pdf_processing_output_invalid");
    this.name = "RetryableKnowledgeModelPdfOutputError";
  }
}

function retryableProviderFailure(error: unknown): Readonly<{ retryAfterMs: null }> | null {
  return error instanceof RetryableKnowledgeModelPdfOutputError ||
    isProviderDeadlineExceededError(error) ||
    openAIRetryableErrorPayload(error) !== null ||
    isRetryableProviderNetworkError(error)
    ? { retryAfterMs: null }
    : null;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function validSnapshot(
  input: Parameters<KnowledgeModelPdfParser["parse"]>[0]
): ProviderExecutionSnapshot {
  // Explicitly pinned supported profiles remain usable independently of the
  // profile selected by default for new installation revisions.
  if (!Number.isSafeInteger(input.parserProfileVersion) || input.parserProfileVersion < 1 ||
    input.parserProfileVersion > MODEL_PDF_LAYOUT_TEXT_PROFILE_VERSION ||
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
    parseDocling?: DoclingLayoutParser | null;
    prepare?: typeof preparePdfModelBatch;
    retry?: ProviderRetryOptions;
    visionConcurrency?: number;
  }> = {}
): KnowledgeModelPdfParser {
  const attemptRepository = options.attemptRepository ??
    createKnowledgeModelPdfAttemptRepository(prisma);
  const execute = options.execute ?? createAcceptedProviderRequestExecutor(prisma);
  const extractGeometry = options.extractGeometry ?? extractNativePdfGeometry;
  const inspect = options.inspect ?? inspectPdfForModelProcessing;
  const parseDocling = options.parseDocling ?? null;
  const prepare = options.prepare ?? preparePdfModelBatch;
  const retry = options.retry;
  const now = options.now ?? (() => new Date());
  const visionConcurrency = ingestionConcurrency(
    options.visionConcurrency, KNOWLEDGE_MODEL_PDF_VISION_PAGE_CONCURRENCY, 64
  );
  const visionPool = new IngestionWorkPool(options.visionConcurrency ?? 32);

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
      let adaptiveGeometry: NativePdfGeometry | null = null;
      let adaptiveDocling: ParsedDocument | null = null;
      let adaptivePlan: AdaptivePdfPlan | null = null;
      const sharedOcr = input.mode === "system_model_vision" && isSharedPdfOcrParserVersion(input.parserProfileVersion);
      const adaptiveHybrid = input.mode === "system_model_vision" &&
        input.parserProfileVersion >= MODEL_PDF_ADAPTIVE_HYBRID_PROFILE_VERSION;
      if (sharedOcr) {
        const local = await planPdfOcrSource({ ...input, pageCount, parserVersion: input.parserProfileVersion },
          { extractGeometry, parseDocling });
        adaptiveGeometry = local.geometry;
        adaptiveDocling = local.docling;
        adaptivePlan = local.plan;
      } else if (adaptiveHybrid && parseDocling) {
        try {
          adaptiveGeometry = await extractGeometry({
            bytes: input.bytes,
            fileName: "source.pdf",
            mimeType: "application/pdf",
            ...(input.signal ? { signal: input.signal } : {})
          }, {
            maxBlocks: input.maxBlocks,
            maxCharacters: input.maxCharacters,
            maxPages: input.maxPages
          });
          if (adaptiveGeometry.pageCount !== pageCount) adaptiveGeometry = null;
        } catch {
          if (input.signal?.aborted) throw abortReason(input.signal);
          adaptiveGeometry = null;
        }
        if (adaptiveGeometry) {
          try {
            adaptiveDocling = await parseDocling({
              bytes: input.bytes,
              fileName: "source.pdf",
              mimeType: "application/pdf",
              parserProfileVersion: input.parserProfileVersion,
              ...(input.signal ? { signal: input.signal } : {})
            });
          } catch {
            if (input.signal?.aborted) throw abortReason(input.signal);
            adaptiveDocling = null;
          }
          adaptivePlan = planAdaptivePdfPages({
            docling: adaptiveDocling,
            geometry: adaptiveGeometry
          });
        }
      }
      const highFidelityVision = input.mode === "system_model_vision" &&
        input.parserProfileVersion >= 3;
      const adaptiveHighFidelityVision = highFidelityVision &&
        input.parserProfileVersion >= 4;
      const visionDetail: PdfVisionDetail = input.mode === "system_model_vision" &&
        input.parserProfileVersion >= 5 ? "original" : "auto";
      const batchPageCount = highFidelityVision
        ? PDF_MODEL_VISION_BATCH_PAGE_COUNT
        : PDF_MODEL_BATCH_PAGE_COUNT;
      const batches: Array<Readonly<{
        batchIndex: number;
        pageEnd: number;
        pageStart: number;
      }>> = [];
      const visionPages = adaptivePlan
        ? new Set(adaptivePlan.pages.filter((page) =>
            page.route === "vision_required").map((page) => page.page))
        : null;
      for (let pageStart = 1, batchIndex = 0; pageStart <= pageCount;
        pageStart += batchPageCount, batchIndex += 1) {
        if (visionPages && !visionPages.has(pageStart)) continue;
        batches.push(Object.freeze({
          batchIndex,
          pageEnd: Math.min(pageCount, pageStart + batchPageCount - 1),
          pageStart
        }));
      }
      const concurrency = input.mode === "system_model_vision"
        ? visionConcurrency
        : 1;
      let pageFailure: { error: unknown } | null = null;
      const settled = await mapIngestionWork(batches, concurrency, async ({
        batchIndex,
        pageEnd,
        pageStart
      }) => {
        const processPage = async () => {
          if (pageFailure) throw pageFailure.error;
          if (input.signal?.aborted) throw abortReason(input.signal);
          let prepared: PreparedPdfBatch;
          let sharedPage: Awaited<ReturnType<typeof preparePdfOcrPage>> | null = null;
          try {
            if (sharedOcr) {
              sharedPage = await preparePdfOcrPage({ bytes: input.bytes,
                local: { geometry: adaptiveGeometry, docling: adaptiveDocling, plan: adaptivePlan },
                maxPages: input.maxPages, page: pageStart, parserVersion: input.parserProfileVersion,
                signal: input.signal, snapshot }, prepare);
              prepared = sharedPage.batch;
            } else prepared = await prepare({
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
          const basePrompt = modelPdfTranscriptionPrompt({
            mode: input.mode,
            pageEnd,
            pageStart,
            promptVersion: input.parserProfileVersion >=
              MODEL_PDF_CHART_POINT_PROJECTION_PROFILE_VERSION ? 8
              : input.parserProfileVersion >=
              MODEL_PDF_EXPLICIT_TABLE_STRUCTURE_PROFILE_VERSION ? 7
              : input.parserProfileVersion >=
              MODEL_PDF_VISUAL_DATA_PROJECTION_PROFILE_VERSION
              ? 6
              : input.parserProfileVersion >= 7
              ? 5
              : input.parserProfileVersion >= 6 ? 4
              : input.parserProfileVersion >= 5 ? 3
              : input.parserProfileVersion >= 3 ? 2 : 1
          });
          let supplement: AdaptivePdfVisionSupplement | null = sharedPage?.supplement ?? null;
          if (!sharedOcr && adaptivePlan && adaptiveGeometry && input.mode === "system_model_vision") {
            try {
              supplement = await prepareAdaptivePdfVisionSupplement({
                batch: prepared,
                docling: adaptiveDocling,
                geometry: adaptiveGeometry,
                includeFigures: input.parserProfileVersion === MODEL_PDF_FIGURE_CROP_PROFILE_VERSION
              });
            } catch (error) {
              if (input.signal?.aborted) throw abortReason(input.signal);
              throw modelFailure(error);
            }
          }
          const prompt = sharedPage?.prompt ?? (supplement ? adaptivePdfVisionPrompt(basePrompt, supplement) : basePrompt);
          const identity: KnowledgeModelPdfAttemptIdentity = {
            artifactId: input.artifactId,
            batchIndex,
            mode: input.mode,
            pageEnd,
            pageStart,
            processingGeneration: input.processingGeneration,
            requestDigest: digestPreparedBatch({
              batch: prepared,
              mode: input.mode,
              profileRevisionId: input.profileRevisionId,
              prompt,
              snapshot,
              supplement,
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
            return reservation.batch;
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
          const acceptedUsages: ModelRunUsage[] = [];
          try {
            const signal = input.signal ?? new AbortController().signal;
            result = await executeWithProviderRetry({
              operation: async () => {
                const candidate = await execute(snapshot, sharedPage?.request ?? providerRequest({
                  batch: prepared,
                  mode: input.mode,
                  prompt,
                  snapshot,
                  supplement,
                  visionDetail
                }), {
                  signal,
                  timeoutMs: effectiveProviderResponseTimeoutMs(
                    snapshot.connection,
                    snapshot.model.adapterKind === "fake" ? null : snapshot.model
                  )
                });
                try {
                  if (sharedOcr) decodePdfOcrPage(pageStart, candidate.finalText);
                  else decodeModelPdfBatchOutput({
                    preserveTableWhitespace: input.parserProfileVersion >= MODEL_PDF_EXPLICIT_TABLE_STRUCTURE_PROFILE_VERSION,
                    mode: input.mode,
                    pageEnd,
                    pageStart,
                    text: candidate.finalText
                  });
                } catch {
                  acceptedUsages.push(candidate.usage as ModelRunUsage);
                  throw new RetryableKnowledgeModelPdfOutputError();
                }
                return candidate;
              },
              options: {
                ...retry,
                maxAttempts: KNOWLEDGE_MODEL_PDF_PROVIDER_MAX_ATTEMPTS
              },
              shouldRetry: retryableProviderFailure,
              signal
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
              usage: sumTokenUsage([
                ...acceptedUsages,
                result.usage as ModelRunUsage
              ])
            });
          } catch (error) {
            throw modelFailure(error);
          }
          return batch;
        };
        const guardedPage = async () => {
          try {
            return await processPage();
          } catch (error) {
            pageFailure ??= { error };
            throw error;
          }
        };
        return input.mode === "system_model_vision"
          ? visionPool.run(guardedPage, input.signal)
          : guardedPage();
      });
      try {
        const decodedPages = settled.flatMap((batch) => sharedOcr ? decodePdfOcrPage(batch.pageStart, batch.resultText)
          : decodeModelPdfBatchOutput({
          preserveTableWhitespace: input.parserProfileVersion >= MODEL_PDF_EXPLICIT_TABLE_STRUCTURE_PROFILE_VERSION,
          mode: input.mode,
          pageEnd: batch.pageEnd,
          pageStart: batch.pageStart,
          text: batch.resultText
        }));
        if (sharedOcr) return assemblePdfOcrDocument({
          parserVersion: input.parserProfileVersion,
          local: { geometry: adaptiveGeometry, docling: adaptiveDocling, plan: adaptivePlan },
          maxBlocks: input.maxBlocks, maxCharacters: input.maxCharacters, pageCount, pages: decodedPages
        });
        if (adaptivePlan && adaptiveGeometry) {
          return assembleAdaptivePdfPages({
            deduplicateNativeText: input.parserProfileVersion >= MODEL_PDF_TEXT_COVERAGE_PROFILE_VERSION,
            deduplicateNativeProseRows: input.parserProfileVersion >=
              MODEL_PDF_NATIVE_PROSE_DEDUPLICATION_PROFILE_VERSION,
            legacyTableInference: input.parserProfileVersion < MODEL_PDF_EXPLICIT_TABLE_STRUCTURE_PROFILE_VERSION,
            docling: adaptiveDocling,
            geometry: adaptiveGeometry,
            maxBlocks: input.maxBlocks,
            maxCharacters: input.maxCharacters,
            pages: decodedPages,
            plan: adaptivePlan
          });
        }
        const pages = decodedPages;
        const document = modelPdfPagesToDocument({
          preserveDisplayMath: input.parserProfileVersion >= MODEL_PDF_TEXT_COVERAGE_PROFILE_VERSION,
          legacyTableInference: input.parserProfileVersion < MODEL_PDF_EXPLICIT_TABLE_STRUCTURE_PROFILE_VERSION,
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
          if (input.mode === "system_model_vision" &&
            input.parserProfileVersion >= MODEL_PDF_NATIVE_TEXT_COLLABORATION_PROFILE_VERSION) {
            return mergeModelPdfWithNativeText(document, geometry, {
              deduplicateNativeText: input.parserProfileVersion >= MODEL_PDF_TEXT_COVERAGE_PROFILE_VERSION,
              allowTextCorrections: input.parserProfileVersion >=
                MODEL_PDF_NATIVE_TEXT_CORRECTION_PROFILE_VERSION,
              deduplicateNativeProseRows: input.parserProfileVersion >=
                MODEL_PDF_NATIVE_PROSE_DEDUPLICATION_PROFILE_VERSION,
              maxBlocks: input.maxBlocks,
              maxCharacters: input.maxCharacters
            }).document;
          }
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
