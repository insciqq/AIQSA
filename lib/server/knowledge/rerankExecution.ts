import {
  MAX_RERANK_DOCUMENTS,
  MAX_RERANK_QUERY_CHARACTERS,
  RerankAdapterError,
  type RerankAdapter,
  type RerankResult
} from "../providers/rerank";
import { ProviderAdmissionError } from "../providerRuntime/admission";
import {
  formatKnowledgeRerankCandidate,
  KNOWLEDGE_RERANK_CANDIDATE_FORMATTER_VERSION
} from "./rerankCandidateFormatter";
import {
  KNOWLEDGE_RERANKER_EVIDENCE_VERSION,
  type KnowledgeRerankerBindingEvidenceV2
} from "./rerankEvidence";
import { KNOWLEDGE_RANKING_PROFILE_VERSION } from "./retrievalRanking";

/** Versioned Knowledge-side identity of the hosted rerank adapter contract. */
export const KNOWLEDGE_RERANK_ADAPTER_VERSION = "openrouter-rerank-v1" as const;
/** Overall wall-clock budget for one hosted rerank operation. */
export const KNOWLEDGE_RERANK_TIMEOUT_MS = 15_000 as const;

/**
 * Immutable execution pin captured at operation time. Later reranker policy,
 * catalog, credential, or formatter changes never alter an accepted receipt.
 */
export type KnowledgeRerankPin = Readonly<{
  adapterVersion: string;
  candidateFormatterVersion: number;
  connectionSnapshotId: string;
  credentialSnapshotRef: string;
  policyVersion: number;
  provider: string;
  providerModelId: string;
  upstreamModelId: string;
}>;

export type KnowledgeRerankPoolCandidate = Readonly<{
  chunkId: string;
  headingPath: readonly string[];
  sourceName: string;
  text: string;
}>;

export type KnowledgeRerankStageResult = Readonly<{
  evidence: KnowledgeRerankerBindingEvidenceV2;
  /** chunkId -> relevance score for every candidate the provider scored. */
  scores: ReadonlyMap<string, number>;
  status: "complete" | "degraded" | "partial";
}>;

export type KnowledgeRerankExecutor = (input: Readonly<{
  candidates: readonly KnowledgeRerankPoolCandidate[];
  signal?: AbortSignal;
}>) => Promise<KnowledgeRerankStageResult>;

const MALFORMED_RESPONSE_CODES = Object.freeze(new Set([
  "rerank_response_invalid",
  "rerank_response_model_mismatch",
  "rerank_response_too_large"
]));

/** Content-free fallback codes that identify a malformed provider response. */
export function isKnowledgeRerankMalformedResponseCode(code: string): boolean {
  return MALFORMED_RESPONSE_CODES.has(code);
}

function boundedRerankQuery(query: string): string {
  if (query.length <= MAX_RERANK_QUERY_CHARACTERS) return query;
  let sliced = query.slice(0, MAX_RERANK_QUERY_CHARACTERS);
  const last = sliced.charCodeAt(sliced.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) sliced = sliced.slice(0, -1);
  return sliced;
}

function rerankCancellationError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("knowledge_retrieval_aborted");
  error.name = "AbortError";
  return error;
}

function usageEvidence(result: RerankResult | null) {
  return Object.freeze({
    searchUnits: result?.usage.searchUnits ?? null,
    totalTokens: result?.usage.totalTokens ?? null
  });
}

function pinnedEvidenceFields(pin: KnowledgeRerankPin) {
  return {
    adapterVersion: pin.adapterVersion,
    candidateFormatterVersion: pin.candidateFormatterVersion,
    connectionSnapshotId: pin.connectionSnapshotId,
    credentialSnapshotRef: pin.credentialSnapshotRef,
    policyVersion: pin.policyVersion,
    providerModelId: pin.providerModelId,
    upstreamModelId: pin.upstreamModelId
  };
}

/** Reranker role not configured: current deterministic retrieval, not a failure. */
export function knowledgeRerankerDisabledEvidence(): KnowledgeRerankerBindingEvidenceV2 {
  return Object.freeze({
    adapterVersion: null,
    candidateFormatterVersion: null,
    connectionSnapshotId: null,
    credentialSnapshotRef: null,
    durationMs: 0,
    fallbackReason: null,
    inputCandidateCount: 0,
    orderedCandidateChunkIds: Object.freeze([]),
    outputOrder: Object.freeze([]),
    policyVersion: null,
    provider: null,
    providerModelId: null,
    providerRequestId: null,
    rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION,
    relevanceScores: Object.freeze([]),
    status: "disabled" as const,
    timedOut: false,
    upstreamModelId: null,
    usage: Object.freeze({ searchUnits: null, totalTokens: null }),
    version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
  });
}

/** Configured reranker role whose runtime could not be resolved: deterministic
 * weighted RRF fallback without any provider request. */
export function knowledgeRerankerUnavailableEvidence(input: Readonly<{
  fallbackReason?: string;
  selectedProviderModelId: string | null;
}>): KnowledgeRerankerBindingEvidenceV2 {
  return Object.freeze({
    adapterVersion: null,
    candidateFormatterVersion: null,
    connectionSnapshotId: null,
    credentialSnapshotRef: null,
    durationMs: 0,
    fallbackReason: input.fallbackReason ?? "reranker_model_unavailable",
    inputCandidateCount: 0,
    orderedCandidateChunkIds: Object.freeze([]),
    outputOrder: Object.freeze([]),
    policyVersion: null,
    provider: null,
    providerModelId: input.selectedProviderModelId,
    providerRequestId: null,
    rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION,
    relevanceScores: Object.freeze([]),
    status: "degraded" as const,
    timedOut: false,
    upstreamModelId: null,
    usage: Object.freeze({ searchUnits: null, totalTokens: null }),
    version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
  });
}

function classifiedFallbackCode(error: unknown): string | null {
  if (error instanceof RerankAdapterError) {
    switch (error.code) {
      case "rerank_provider_http_error":
      case "rerank_provider_request_failed":
      case "rerank_request_timed_out":
      case "rerank_response_invalid":
      case "rerank_response_model_mismatch":
      case "rerank_response_too_large":
        return error.code;
      case "rerank_documents_invalid":
      case "rerank_input_invalid":
      case "rerank_request_too_large":
        // These describe a local contract/bounds defect, not a provider
        // outage. Propagate it so invariants are never hidden as fallback.
        return null;
    }
  }
  if (error instanceof ProviderAdmissionError) return error.code;
  return null;
}

/**
 * Creates the single hosted rerank execution for one Knowledge retrieval
 * operation. At most one provider request is made per invocation; zero or one
 * unique candidate skips the provider entirely; every classified provider
 * failure degrades to the deterministic weighted RRF fallback, while
 * database, authority, invariant, and cancellation failures propagate.
 */
export function createKnowledgeRerankStage(input: Readonly<{
  adapter: RerankAdapter;
  now?: () => number;
  pin: KnowledgeRerankPin;
  query: string;
  timeoutMs?: number;
}>): KnowledgeRerankExecutor {
  const now = input.now ?? Date.now;
  const timeoutMs = input.timeoutMs ?? KNOWLEDGE_RERANK_TIMEOUT_MS;
  const query = boundedRerankQuery(input.query);
  return async ({ candidates, signal }) => {
    if (candidates.length > MAX_RERANK_DOCUMENTS ||
      new Set(candidates.map((candidate) => candidate.chunkId)).size !== candidates.length) {
      throw new Error("knowledge_rerank_pool_invalid");
    }
    const orderedCandidateChunkIds = Object.freeze(
      candidates.map((candidate) => candidate.chunkId)
    );
    const inputCandidateCount = candidates.length;
    if (inputCandidateCount <= 1) {
      // FR-15: an empty pool or a single unique candidate never calls the
      // provider; the deterministic order is trivially complete.
      return {
        evidence: Object.freeze({
          ...pinnedEvidenceFields(input.pin),
          durationMs: 0,
          fallbackReason: null,
          inputCandidateCount,
          orderedCandidateChunkIds,
          outputOrder: orderedCandidateChunkIds,
          provider: null,
          providerRequestId: null,
          rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION,
          relevanceScores: Object.freeze(orderedCandidateChunkIds.map(() => null)),
          status: "complete" as const,
          timedOut: false,
          usage: usageEvidence(null),
          version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
        }),
        scores: new Map<string, number>(),
        status: "complete"
      };
    }
    const documents = candidates.map((candidate) => ({
      handle: candidate.chunkId,
      text: formatKnowledgeRerankCandidate({
        headingPath: candidate.headingPath,
        sourceName: candidate.sourceName,
        text: candidate.text
      })
    }));
    const controller = new AbortController();
    let deadlineFired = false;
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        deadlineFired = true;
        const error = new RerankAdapterError("rerank_request_timed_out");
        controller.abort(error);
        // Enforce the operation deadline even if a custom adapter ignores
        // AbortSignal. The one in-flight request is still never retried.
        reject(error);
      }, timeoutMs);
    });
    let forwardAbort: (() => void) | null = null;
    const cancellation = signal
      ? new Promise<never>((_resolve, reject) => {
          forwardAbort = () => {
            const error = rerankCancellationError(signal);
            controller.abort(error);
            // Cancellation is an operation-level control signal, not a
            // reranker fallback. Enforce it even if an adapter ignores abort.
            reject(error);
          };
          if (signal.aborted) forwardAbort();
          else signal.addEventListener("abort", forwardAbort, { once: true });
        })
      : null;
    const startedAt = now();
    let result: RerankResult;
    try {
      result = await Promise.race([
        input.adapter.rerank({
          documents,
          query,
          signal: controller.signal
        }),
        deadline,
        ...(cancellation ? [cancellation] : [])
      ]);
    } catch (error) {
      const durationMs = Math.max(0, now() - startedAt);
      if (signal?.aborted) throw rerankCancellationError(signal);
      const timedOut = deadlineFired ||
        error instanceof RerankAdapterError && error.code === "rerank_request_timed_out";
      const fallbackReason = timedOut
        ? "rerank_request_timed_out"
        : classifiedFallbackCode(error);
      if (!fallbackReason) throw error;
      return {
        evidence: Object.freeze({
          ...pinnedEvidenceFields(input.pin),
          durationMs: Math.min(durationMs, 3_600_000),
          fallbackReason,
          inputCandidateCount,
          orderedCandidateChunkIds,
          outputOrder: Object.freeze([]),
          provider: null,
          providerRequestId: null,
          rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION,
          relevanceScores: Object.freeze([]),
          status: "degraded" as const,
          timedOut,
          usage: usageEvidence(null),
          version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
        }),
        scores: new Map<string, number>(),
        status: "degraded"
      };
    } finally {
      clearTimeout(timer!);
      if (forwardAbort) signal?.removeEventListener("abort", forwardAbort);
    }
    const durationMs = Math.max(0, now() - startedAt);
    const scores = new Map<string, number>();
    for (const score of result.scores) {
      scores.set(score.handle, score.relevanceScore);
    }
    const scored = candidates
      .map((candidate, index) => ({ chunkId: candidate.chunkId, index }))
      .filter((entry) => scores.has(entry.chunkId))
      .sort((left, right) =>
        scores.get(right.chunkId)! - scores.get(left.chunkId)! || left.index - right.index);
    const omitted = candidates
      .map((candidate) => candidate.chunkId)
      .filter((chunkId) => !scores.has(chunkId));
    const outputOrder = Object.freeze([
      ...scored.map((entry) => entry.chunkId),
      ...omitted
    ]);
    const relevanceScores = Object.freeze(outputOrder.map((chunkId) =>
      scores.get(chunkId) ?? null));
    const status = scores.size === candidates.length ? "complete" as const : "partial" as const;
    return {
      evidence: Object.freeze({
        ...pinnedEvidenceFields(input.pin),
        durationMs: Math.min(durationMs, 3_600_000),
        fallbackReason: null,
        inputCandidateCount,
        orderedCandidateChunkIds,
        outputOrder,
        provider: result.provider ?? input.pin.provider,
        providerRequestId: result.requestId,
        rankingProfileVersion: KNOWLEDGE_RANKING_PROFILE_VERSION,
        relevanceScores,
        status,
        timedOut: false,
        usage: usageEvidence(result),
        version: KNOWLEDGE_RERANKER_EVIDENCE_VERSION
      }),
      scores,
      status
    };
  };
}
