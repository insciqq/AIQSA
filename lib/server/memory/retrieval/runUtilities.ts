import type { PrismaClient } from "@prisma/client";
import { normalizeTokenUsage } from "../../../domain/usage";
import {
  createAcceptedEmbeddingRuntime,
  type AcceptedEmbeddingRuntimeEvidence
} from "../../providerRuntime/embeddingRuntime";
import { ProviderAdmissionError } from "../../providerRuntime/admission";
import {
  EmbeddingAdapterError,
  type EmbeddingResult
} from "../../providers/embeddings";
import {
  MAX_RERANK_DOCUMENT_CHARACTERS,
  MAX_RERANK_DOCUMENTS,
  MAX_RERANK_REQUEST_BYTES,
  RerankAdapterError,
  type RerankResult
} from "../../providers/rerank";
import { isProviderRetryableHttpStatus } from "../../providers/network";
import {
  createAcceptedRerankerRuntime,
  type AcceptedRerankerRuntimeEvidence
} from "../../providerRuntime/rerankerRuntime";
import { prisma } from "../../prisma";
import {
  createPrismaMemoryExecutionService,
  MemoryExecutionError,
  type MemoryExecutionAuthorityDependencies,
  type MemoryExecutionRole,
  type MemoryExecutionVersions,
  type MemoryReportedUsage,
  type PrismaMemoryExecutionService
} from "../execution";
import { memoryExecutionSha256 } from "../execution/canonical";
import type { MemorySecretFreeExecutionSnapshot } from "../execution/snapshot";
import type { MemoryExecutionOwner } from "../execution/owner";
import { memorySha256 } from "../persistence/lexical";
import {
  MEMORY_EMBEDDING_PROFILE,
  MEMORY_EMBEDDING_PROFILE_FINGERPRINT,
  renderMemoryQueryEmbeddingText
} from "../embedding/contract";
import {
  MEMORY_RETRIEVAL_RERANK_SCORE_FLOOR,
  MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES,
  MEMORY_RETRIEVAL_MAX_TARGETED_RERANK_CANDIDATES
} from "../../../domain/memory/retrieval/config";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  type MemoryVectorProfile
} from "./vector";
import {
  createAcceptedMemoryRunUtilityProvider,
  memoryRunUtilityProviderEvidence,
  memoryRunUtilityPromptCharacters,
  MemoryRunUtilityProviderCallError,
  MEMORY_RERANK_MAX_PROMPT_CHARACTERS,
  MEMORY_RERANK_TOOL_NAME,
  type MemoryRerankUtilityProviderInput,
  type MemoryRunUtilityProvider,
  type MemoryRunUtilityProviderInput,
  type MemoryUtilitySourceKind,
  type MemoryUtilitySpeakerScope
} from "./runUtilityRuntime";
import { sanitizeMemoryUtilityText } from "./querySafety";
import { RERANKER_ROUTE_POLICY_VERSION } from "../../../domain/rerankerModels";
import {
  approvedRerankerDeploymentByProviderModelId,
  approvedRerankerDeployments
} from "../../admin/providers/approvedRerankers";
import { createRerankerModelRoleResolver } from "../../providerRuntime/rerankerModelRole";
export const MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION =
  "memory-query-embedding-v12";
export const MEMORY_REMOTE_RERANK_PIPELINE_VERSION =
  "memory-multilingual-relevance-v31";
export const MEMORY_QUERY_EMBEDDING_MAX_ATTEMPTS = 1;
// Remote embedding engines commonly reserve a 30-second request window. The
// enclosing optional-role signal remains authoritative and clamps this window
// to the installation's remaining admission budget, so this cannot extend the
// user-visible Memory deadline.
export const MEMORY_QUERY_EMBEDDING_ATTEMPT_TIMEOUT_MS = 30_000;
export const MEMORY_RERANK_MAX_ATTEMPTS = 2;
export const MEMORY_RERANK_MAX_ROUTE_MODELS = 3;
const MEMORY_GENERATIVE_RERANK_MAX_ATTEMPTS = 2;
export const MEMORY_RERANK_AGGREGATION_BATCH_SIZE = 20;
export const MEMORY_RERANK_TARGETED_MAX_CANDIDATES =
  MEMORY_RETRIEVAL_MAX_TARGETED_RERANK_CANDIDATES;
export const MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES =
  MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES;
export const MEMORY_RERANK_AGGREGATION_MAX_BATCHES = Math.ceil(
  MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES / MEMORY_RERANK_AGGREGATION_BATCH_SIZE
);
export const MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES = 4;
export const MEMORY_DEDICATED_RERANK_WIRE_RESERVE_BYTES = 16 * 1024;
export const MEMORY_RERANK_TARGETED_MAX_TOTAL_CHARACTERS =
  MEMORY_RERANK_TARGETED_MAX_CANDIDATES * 4_000;
export const MEMORY_RERANK_AGGREGATION_MAX_TOTAL_CHARACTERS =
  MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES * 4_000;

export const MEMORY_QUERY_EMBEDDING_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION,
  policyVersion: "memory-query-embedding-policy-v11",
  promptVersion: MEMORY_EMBEDDING_PROFILE.queryInstructionVersion,
  // This field binds the generated vector to the active index space. Request
  // count/retry policy is already frozen by pipelineVersion/policyVersion and
  // must not replace the vector retrieval fingerprint.
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  schemaVersion: "memory-query-embedding-result-v3"
});

const rerankVersions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_REMOTE_RERANK_PIPELINE_VERSION,
  policyVersion: "memory-relevance-policy-v26",
  promptVersion: "memory-relevance-input-v18",
  retrievalConfigFingerprint: memoryExecutionSha256({
    candidateMaxCharacters: 4_000,
    contextualHintMaxCharacters: 1_000,
    aggregationBatchSize: MEMORY_RERANK_AGGREGATION_BATCH_SIZE,
    aggregationBatchMaxPromptCharacters: MEMORY_RERANK_MAX_PROMPT_CHARACTERS,
    maxAggregationBatches: MEMORY_RERANK_AGGREGATION_MAX_BATCHES,
    maxAggregationCandidates: MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES,
    maxTargetedCandidates: MEMORY_RERANK_TARGETED_MAX_CANDIDATES,
    maxAttemptsPerBatch: MEMORY_RERANK_MAX_ATTEMPTS,
    maxDedicatedRouteModels: MEMORY_RERANK_MAX_ROUTE_MODELS,
    generativeCompatibilityMaxAttempts: MEMORY_GENERATIVE_RERANK_MAX_ATTEMPTS,
    maxAggregationTotalCharacters: MEMORY_RERANK_AGGREGATION_MAX_TOTAL_CHARACTERS,
    maxParallelAggregationBatches: MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES,
    maxOutputTokens: 4_096,
    maxTargetedTotalCharacters: MEMORY_RERANK_TARGETED_MAX_TOTAL_CHARACTERS,
    maxInteractiveRetryAfterMs: 2_000,
    retryBackoff: "snapshot_hash_jittered_exponential_1000ms_cap_2000ms",
    atomicFullCoverage: true,
    partialPerCandidateDecisions: false,
    profileInventoryPostcondition: false,
    lifecycleTemporalModes: true,
    openRouterReasoning: "disabled_for_interactive_deadline",
    aggregationAware: true,
    aggregationCandidateSelection: "session_score_then_distinct_source_first",
    aggregationRoleAssignment: "reader_first_final_answer_model",
    ordinaryGenerativeAggregationCalls: 0,
    serverAuthorityOnly: true,
    nearZeroAdmissionFloor: MEMORY_RETRIEVAL_RERANK_SCORE_FLOOR,
    modelSpecificNearZeroFloors: approvedRerankerDeployments.map(({ preset }) => ({
      floor: preset.relevanceScoreFloor,
      upstreamModelId: preset.upstreamModelId
    })),
    nearZeroAdmissionGate: "complete_coverage_only_with_exact_profile_exemptions",
    transientReadOnlyRetry:
      "one_fresh_binding_same_snapshot_only_before_interactive_soft_deadline",
    interactiveSoftDeadlineMs: 20_000,
    interactiveHardDeadlineMs: 26_000,
    logicalOperationCount: 1,
    dedicatedRerankerAdapter: "openrouter-rerank-v2",
    dedicatedRerankerRoutePolicyVersion: RERANKER_ROUTE_POLICY_VERSION,
    dedicatedDocumentMaxCharacters: MAX_RERANK_DOCUMENT_CHARACTERS,
    dedicatedSupportExcerptAllocation: "equal-share-of-remaining-document-budget",
    contextualEvidenceDependencies: "cited-raw-rounds-v1",
    toolObservationContract: "source=tool_observation,speaker=tool,authority=supporting",
    dedicatedWireEnvelopeReserveBytes: MEMORY_DEDICATED_RERANK_WIRE_RESERVE_BYTES,
    generativeCompatibilityPath: "structured-output-v19",
    version: 31
  }),
  schemaVersion: "memory-relevance-result-v7"
});

export type MemoryRunUtilityUnavailable = Readonly<{
  bindingId?: string;
  externalCallCount?: number;
  providerRequestRoutes?: readonly (string | null)[];
  reason: string;
  status: "UNAVAILABLE";
}>;

export type MemoryRunQueryEmbeddingResult =
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      externalCallCount?: number;
      providerRequestRoutes?: readonly (string | null)[];
      profile: MemoryVectorProfile;
      status: "READY";
      vector: readonly number[];
    }>;

export type MemoryRerankDiagnostics = Readonly<{
  batchCount: number;
  candidateCount: number;
  coverageRatio: number;
  decisionCount: number;
  duplicateDecisionCount: number;
  failedBatchCount: number;
  fallbackDepth?: number | null;
  fullFallbackUsed: boolean;
  invalidResponseCount: number;
  missingDecisionCount: number;
  modelAttemptCount?: number;
  providerModelMismatchCount: number;
  readyBatchCount: number;
  retryCount: number;
  routePolicyVersion?: typeof RERANKER_ROUTE_POLICY_VERSION;
}>;

export type MemoryRerankRouteEvidence = Readonly<{
  fallbackDepth: number;
  policyFingerprint: string;
  policyVersion: typeof RERANKER_ROUTE_POLICY_VERSION;
  providerModelId: string;
}>;

export type MemoryRunRerankResult = (
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      decisions: readonly MemoryRunRerankDecision[];
      externalCallCount?: number;
      relevanceScoreFloor?: number | null;
      rerankerRoute?: MemoryRerankRouteEvidence;
      status: "READY";
    }>) & Readonly<{ diagnostics?: MemoryRerankDiagnostics }>;

export type MemoryRunRerankDecision = Readonly<{
  applicable: boolean | null;
  current: boolean | null;
  handle: string;
  reasonCode:
    | "DIRECT_RELEVANCE"
    | "SUPPORTING_CONTEXT"
    | "RESPONSE_PREFERENCE"
    | "OUTDATED"
    | "NOT_RELEVANT"
    | "SCORE_ONLY";
  relevanceScore: number;
}>;

type UtilityBaseInput = Readonly<{
  canRetry?: () => boolean;
  signal: AbortSignal;
  userId: string;
}> & (
  | Readonly<{ attemptId: string; owner?: never }>
  | Readonly<{ attemptId?: never; owner: MemoryExecutionOwner }>
);

type QueryEmbeddingBaseInput = Readonly<{
  signal: AbortSignal;
  userId: string;
}> & (
  | Readonly<{
      attemptId: string;
      jobAttemptCount?: never;
      owner?: never;
    }>
  | Readonly<{
      attemptId?: never;
      jobAttemptCount: 1 | 2;
      owner: Extract<MemoryExecutionOwner, { type: "JOB" }>;
    }>
  | Readonly<{
      attemptId?: never;
      jobAttemptCount?: never;
      owner: Exclude<MemoryExecutionOwner, { type: "JOB" }>;
    }>
);

export type MemoryRunUtilityService = Readonly<{
  embedQuery(input: QueryEmbeddingBaseInput & Readonly<{
    profile: MemoryVectorProfile;
    purpose?: "ACTION_TARGET" | "RETRIEVAL";
    query: string;
  }>): Promise<MemoryRunQueryEmbeddingResult>;
  rerank(input: UtilityBaseInput & Readonly<{
    aggregationRequested?: boolean;
    candidates: readonly Readonly<{
      authorityLevel: "LEARNED" | "PAST_CHAT" | "SAVED" | "SUPPORTING";
      current: boolean;
      directness: "DIRECT" | "INFERRED" | "PARAPHRASED" | null;
      handle: string;
      historical: boolean;
      lifecycleState: "ACTIVE" | "SUPERSEDED" | null;
      occurredFrom: string | null;
      occurredTo: string | null;
      sensitivityClass: "NORMAL";
      speakerScope: MemoryUtilitySpeakerScope;
      sourceKind: MemoryUtilitySourceKind;
      retrievalHint?: string | null;
      supportingEvidence?: readonly Readonly<{
        itemId: string;
        occurredFrom: string;
        occurredTo: string;
        sourceChatId: string;
        text: string;
      }>[];
      temporalReason: "any" | "as_of" | "between" | "current" | "historical";
      text: string;
    }>[];
    profileRequested: boolean;
    query: string;
    retrievalMode: "CURRENT_PROFILE" | "HISTORICAL_MEMORY" | "HISTORY_OVERVIEW" |
      "PAST_CHAT_SEARCH" | "TARGETED_CURRENT";
    temporalIntent: "ANY" | "AS_OF" | "BETWEEN" | "CURRENT" | "HISTORICAL";
  }>): Promise<MemoryRunRerankResult>;
}>;

type AcceptedEmbeddingRuntime = ReturnType<typeof createAcceptedEmbeddingRuntime>;
type AcceptedRerankerRuntime = ReturnType<typeof createAcceptedRerankerRuntime>;

type MemoryRerankPath = "DEDICATED" | "GENERATIVE_COMPATIBILITY";

type DedicatedRerankRoute = Readonly<{
  policyVersion: typeof RERANKER_ROUTE_POLICY_VERSION;
  providerModelIds: readonly string[];
}>;

type MemoryRunUtilityDependencies = Readonly<{
  embeddingRuntime: AcceptedEmbeddingRuntime;
  execution: PrismaMemoryExecutionService;
  provider: MemoryRunUtilityProvider;
  rerankerRuntime?: AcceptedRerankerRuntime;
  resolveDedicatedRerankRoute?: () => Promise<DedicatedRerankRoute>;
  resolveRerankPath?: (userId: string) => Promise<MemoryRerankPath>;
}>;

const unavailableUsage: MemoryReportedUsage = Object.freeze({
  cachedInputTokens: null,
  completeness: "UNAVAILABLE",
  estimatedCostMicros: null,
  inputTokens: null,
  outputTokens: null,
  reasoningTokens: null,
  totalTokens: null
});

const uncertainEmbeddingErrors = new Set([
  "embedding_provider_request_failed",
  "embedding_request_timed_out"
]);

const uncertainRerankErrors = new Set([
  "rerank_provider_request_failed",
  "rerank_request_timed_out"
]);

const retryableTextUtilityReasons = new Set([
  "memory_run_utility_output_invalid",
  "memory_run_utility_outcome_unknown",
  "memory_run_utility_provider_failed"
]);

function retryableTextUtilityReason(reason: string): boolean {
  return retryableTextUtilityReasons.has(reason);
}

const retryableDedicatedRerankReasons = new Set([
  "memory_run_utility_output_invalid",
  "memory_reranker_outcome_unknown",
  "memory_reranker_transient_http_failure"
]);

const dedicatedRerankerModelFallbackReasons = new Set([
  "memory_run_utility_output_invalid",
  "memory_reranker_model_unavailable",
  "memory_reranker_outcome_unknown",
  "memory_reranker_runtime_unavailable",
  "memory_reranker_transient_http_failure"
]);

const MEMORY_UTILITY_MAX_RETRY_AFTER_MS = 2_000;
const MEMORY_UTILITY_RETRY_BACKOFF_BASE_MS = 1_000;

function memoryUtilitySnapshotBackoffMs(
  snapshotHash: string,
  retryIndex: number
): number {
  if (!/^[a-f0-9]{64}$/.test(snapshotHash) ||
    !Number.isSafeInteger(retryIndex) || retryIndex < 1) {
    throw new Error("memory_utility_retry_backoff_invalid");
  }
  const ceiling = Math.min(
    MEMORY_UTILITY_MAX_RETRY_AFTER_MS,
    MEMORY_UTILITY_RETRY_BACKOFF_BASE_MS * (2 ** (retryIndex - 1))
  );
  const floor = Math.max(1, Math.floor(ceiling / 2));
  const sliceStart = ((retryIndex - 1) * 8) % 56;
  const entropy = Number.parseInt(
    snapshotHash.slice(sliceStart, sliceStart + 8),
    16
  );
  return floor + entropy % (ceiling - floor + 1);
}

function waitForMemoryUtilityRetry(
  retryAfterMs: number | null | undefined,
  signal: AbortSignal,
  fallback: Readonly<{ retryIndex: number; snapshotHash: string }> | null = null
): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  let delayMs: number;
  if (retryAfterMs === null || typeof retryAfterMs === "undefined") {
    if (!fallback) return Promise.resolve(true);
    delayMs = memoryUtilitySnapshotBackoffMs(
      fallback.snapshotHash,
      fallback.retryIndex
    );
  } else {
    if (
      !Number.isSafeInteger(retryAfterMs) || retryAfterMs <= 0 ||
      retryAfterMs > MEMORY_UTILITY_MAX_RETRY_AFTER_MS
    ) return Promise.resolve(false);
    delayMs = retryAfterMs;
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout);
      resolve(false);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, delayMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function boundedProviderAttemptSignal(
  parentSignal: AbortSignal,
  timeoutMs: number,
  timeoutCode: string
): Readonly<{
  dispose(): void;
  expired(): boolean;
  signal: AbortSignal;
}> {
  const controller = new AbortController();
  let expired = false;
  const forwardParentAbort = () => {
    if (!controller.signal.aborted) controller.abort(parentSignal.reason);
  };
  if (parentSignal.aborted) forwardParentAbort();
  else parentSignal.addEventListener("abort", forwardParentAbort, { once: true });
  const timeout = !controller.signal.aborted
    ? setTimeout(() => {
        expired = true;
        controller.abort({ code: timeoutCode });
      }, timeoutMs)
    : null;
  return Object.freeze({
    dispose() {
      if (timeout) clearTimeout(timeout);
      parentSignal.removeEventListener("abort", forwardParentAbort);
    },
    expired: () => expired,
    signal: controller.signal
  });
}

function unavailable(reason: string, bindingId?: string): MemoryRunUtilityUnavailable {
  return { ...(bindingId ? { bindingId } : {}), reason, status: "UNAVAILABLE" };
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  run: (value: T, index: number) => Promise<R>
): Promise<readonly R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("memory_run_utility_concurrency_invalid");
  }
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await run(values[index]!, index);
      }
    }
  ));
  return results;
}

function rerankProviderInput(
  input: Parameters<MemoryRunUtilityService["rerank"]>[0],
  candidates: readonly RerankCandidate[]
): MemoryRerankUtilityProviderInput {
  return {
    aggregationRequested: input.aggregationRequested === true,
    candidates: candidates.map((candidate) => {
      const {
        retrievalHint: _retrievalHint,
        supportingEvidence: _supportingEvidence,
        ...providerCandidate
      } = candidate;
      return {
        ...providerCandidate,
        text: memoryDedicatedRerankDocument(candidate)
      };
    }),
    profileRequested: input.profileRequested,
    query: input.query,
    retrievalMode: input.retrievalMode,
    role: "MEMORY_RERANK",
    temporalIntent: input.temporalIntent
  };
}

function partitionRerankCandidates(
  input: Parameters<MemoryRunUtilityService["rerank"]>[0]
): readonly (readonly RerankCandidate[])[] | null {
  const batches: RerankCandidate[][] = [];
  let current: RerankCandidate[] = [];
  for (const candidate of input.candidates) {
    const proposed = [...current, candidate];
    const request = rerankProviderInput(input, proposed);
    const exceedsBatchSize = proposed.length > MEMORY_RERANK_AGGREGATION_BATCH_SIZE;
    const exceedsPromptLimit = memoryRunUtilityPromptCharacters(request) >
      MEMORY_RERANK_MAX_PROMPT_CHARACTERS;
    if (!exceedsBatchSize && !exceedsPromptLimit) {
      current = proposed;
      continue;
    }
    if (current.length < 1) return null;
    batches.push(current);
    current = [candidate];
    if (memoryRunUtilityPromptCharacters(
      rerankProviderInput(input, current)
    ) > MEMORY_RERANK_MAX_PROMPT_CHARACTERS) return null;
  }
  if (current.length > 0) batches.push(current);
  return batches.length <= MEMORY_RERANK_AGGREGATION_MAX_BATCHES
    ? batches
    : null;
}

type RerankInput = Parameters<MemoryRunUtilityService["rerank"]>[0];
type RerankCandidate = RerankInput["candidates"][number];
type QueryEmbeddingInput = Parameters<MemoryRunUtilityService["embedQuery"]>[0];

function safeRerankCandidate(candidate: RerankCandidate): RerankCandidate | null {
  const raw = sanitizeMemoryUtilityText(candidate.text);
  if (!raw.eligible || !raw.safeText) return null;
  const rawOnly = {
    ...candidate,
    retrievalHint: null,
    supportingEvidence: Object.freeze([]),
    text: raw.safeText
  };
  if (candidate.retrievalHint === null || candidate.retrievalHint === undefined) {
    return rawOnly;
  }
  const hint = sanitizeMemoryUtilityText(candidate.retrievalHint);
  const supports = candidate.supportingEvidence ?? [];
  if (!hint.eligible || !hint.safeText || hint.safeText.length > 1_000 ||
    supports.length > 2) return rawOnly;
  const safeSupports = supports.flatMap((support) => {
    const safe = sanitizeMemoryUtilityText(support.text);
    const validIdentity = (value: string) => value.length > 0 &&
      value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
    const occurredFrom = Date.parse(support.occurredFrom);
    const occurredTo = Date.parse(support.occurredTo);
    return safe.eligible && safe.safeText && safe.safeText.length <= 4_000 &&
      validIdentity(support.itemId) && validIdentity(support.sourceChatId) &&
      Number.isFinite(occurredFrom) && Number.isFinite(occurredTo) &&
      occurredTo >= occurredFrom
      ? [{ ...support, text: safe.safeText }]
      : [];
  });
  if (safeSupports.length !== supports.length ||
    new Set(safeSupports.map(({ itemId }) => itemId)).size !== safeSupports.length) {
    return rawOnly;
  }
  return {
    ...candidate,
    retrievalHint: hint.safeText,
    supportingEvidence: Object.freeze(safeSupports),
    text: raw.safeText
  };
}

export function memoryDedicatedRerankDocument(candidate: RerankCandidate): string {
  const safe = sanitizeMemoryUtilityText(candidate.text);
  if (!safe.eligible || !safe.safeText) {
    throw new Error("memory_reranker_document_secret_only");
  }
  const occurredFrom = candidate.occurredFrom ?? "unknown";
  const occurredTo = candidate.occurredTo ?? "open";
  const retrievalHint = candidate.retrievalHint === null ||
    candidate.retrievalHint === undefined
    ? null
    : sanitizeMemoryUtilityText(candidate.retrievalHint);
  if (retrievalHint && (!retrievalHint.eligible || !retrievalHint.safeText ||
    retrievalHint.safeText.length > 1_000)) {
    throw new Error("memory_reranker_document_secret_only");
  }
  const supportingEvidence = retrievalHint
    ? (candidate.supportingEvidence ?? []).map((support, index) => {
        const supportText = sanitizeMemoryUtilityText(support.text);
        if (!supportText.eligible || !supportText.safeText) {
          throw new Error("memory_reranker_document_secret_only");
        }
        return {
          header: `[support_${index + 1} raw_excerpt=true ` +
            `date_from=${support.occurredFrom} date_to=${support.occurredTo}]`,
          text: supportText.safeText
        };
      })
    : [];
  if (supportingEvidence.length > 2) {
    throw new Error("memory_reranker_document_invalid");
  }
  const render = (supportTexts: readonly string[]) => [
    `[date_from=${occurredFrom} date_to=${occurredTo}]`,
    `[source=${candidate.sourceKind.toLocaleLowerCase("und")} ` +
      `speaker=${candidate.speakerScope} state=${candidate.current ? "current" : "historical"} ` +
      `lifecycle=${candidate.lifecycleState?.toLocaleLowerCase("und") ?? "not_applicable"}]`,
    ...(retrievalHint?.safeText
      ? ["[retrieval_hint derived=true authority=none]", retrievalHint.safeText]
      : []),
    "[authoritative_evidence]",
    safe.safeText,
    "[supporting_authoritative_evidence]",
    supportingEvidence.length > 0
      ? supportingEvidence.map((support, index) =>
          `${support.header}\n${supportTexts[index] ?? ""}`).join("\n")
      : "none"
  ].join("\n");
  if (supportingEvidence.length === 0) {
    const document = render([]);
    if (document.length > MAX_RERANK_DOCUMENT_CHARACTERS) {
      throw new Error("memory_reranker_document_invalid");
    }
    return document;
  }
  const emptySupportDocument = render(supportingEvidence.map(() => ""));
  let remaining = MAX_RERANK_DOCUMENT_CHARACTERS - emptySupportDocument.length;
  if (remaining < supportingEvidence.length) {
    throw new Error("memory_reranker_document_invalid");
  }
  const supportTexts = supportingEvidence.map((support, index) => {
    const allocation = Math.floor(remaining / (supportingEvidence.length - index));
    let text = support.text.slice(0, allocation);
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) text = text.slice(0, -1);
    remaining -= text.length;
    return text;
  });
  const document = render(supportTexts);
  if (document.length > MAX_RERANK_DOCUMENT_CHARACTERS) {
    throw new Error("memory_reranker_document_invalid");
  }
  return document;
}

function dedicatedEnvelopeBytes(
  input: RerankInput,
  candidates: readonly RerankCandidate[]
): number {
  return Buffer.byteLength(JSON.stringify({
    documents: candidates.map((candidate) => ({
      handle: candidate.handle,
      text: memoryDedicatedRerankDocument(candidate)
    })),
    instruction: null,
    query: input.query
  }), "utf8");
}

function partitionDedicatedRerankCandidates(
  input: RerankInput
): readonly (readonly RerankCandidate[])[] | null {
  const providerNeutralLimit = MAX_RERANK_REQUEST_BYTES -
    MEMORY_DEDICATED_RERANK_WIRE_RESERVE_BYTES;
  const batches: RerankCandidate[][] = [];
  let current: RerankCandidate[] = [];
  for (const candidate of input.candidates) {
    const proposed = [...current, candidate];
    if (proposed.length <= MAX_RERANK_DOCUMENTS &&
      dedicatedEnvelopeBytes(input, proposed) <= providerNeutralLimit) {
      current = proposed;
      continue;
    }
    if (current.length < 1) return null;
    batches.push(current);
    current = [candidate];
    if (dedicatedEnvelopeBytes(input, current) > providerNeutralLimit) return null;
  }
  if (current.length > 0) batches.push(current);
  return batches.length <= MEMORY_RERANK_AGGREGATION_MAX_BATCHES
    ? batches
    : null;
}

function rerankBatchFirstOrdinal(batchIndex: number): number {
  if (!Number.isSafeInteger(batchIndex) || batchIndex < 0 ||
    batchIndex >= MEMORY_RERANK_AGGREGATION_MAX_BATCHES) {
    throw new Error("memory_rerank_batch_ordinal_invalid");
  }
  return 2 + batchIndex * MEMORY_RERANK_MAX_ATTEMPTS;
}

function rerankRouteBatchOrdinal(routeIndex: number, batchIndex: number): number {
  if (
    !Number.isSafeInteger(routeIndex) || routeIndex < 0 ||
    routeIndex >= MEMORY_RERANK_MAX_ROUTE_MODELS ||
    !Number.isSafeInteger(batchIndex) || batchIndex < 0 ||
    batchIndex >= MEMORY_RERANK_AGGREGATION_MAX_BATCHES
  ) throw new Error("memory_rerank_route_ordinal_invalid");
  return 2 + routeIndex * MEMORY_RERANK_AGGREGATION_MAX_BATCHES + batchIndex;
}

function unavailableReason(error: unknown): string {
  if (error instanceof MemoryExecutionError) return error.code;
  if (error instanceof ProviderAdmissionError) {
    return "memory_execution_target_unavailable";
  }
  return "memory_run_utility_unavailable";
}

function embeddingUsage(result: EmbeddingResult): MemoryReportedUsage {
  const complete = result.usage.inputTokens !== null && result.usage.totalTokens !== null;
  if (!complete && result.usage.inputTokens === null && result.usage.totalTokens === null) {
    return unavailableUsage;
  }
  return {
    cachedInputTokens: 0,
    completeness: complete ? "COMPLETE" : "PARTIAL",
    estimatedCostMicros: null,
    inputTokens: result.usage.inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: result.usage.totalTokens
  };
}

function rerankerUsage(result: RerankResult): MemoryReportedUsage {
  const { inputTokens, totalTokens } = result.usage;
  if (inputTokens === null && totalTokens === null) return unavailableUsage;
  return {
    cachedInputTokens: 0,
    completeness: inputTokens !== null && totalTokens !== null
      ? "COMPLETE"
      : "PARTIAL",
    estimatedCostMicros: null,
    inputTokens,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens
  };
}

function providerUsage(
  usage: Parameters<typeof normalizeTokenUsage>[0]
): MemoryReportedUsage {
  const normalized = normalizeTokenUsage(usage);
  return {
    cachedInputTokens: normalized.cachedInputTokens,
    completeness: "COMPLETE",
    estimatedCostMicros: null,
    inputTokens: normalized.inputTokens,
    outputTokens: normalized.outputTokens,
    reasoningTokens: normalized.reasoningTokens,
    totalTokens: normalized.totalTokens
  };
}

function boundedResponseId(value: string | null): string | null {
  return value && value.length <= 256 &&
    /^[A-Za-z0-9][A-Za-z0-9._:+@/-]{0,255}$/u.test(value)
    ? value
    : null;
}

function embeddingEvidence(
  snapshot: MemorySecretFreeExecutionSnapshot
): AcceptedEmbeddingRuntimeEvidence {
  const provider = snapshot.providerExecutionSnapshot;
  if (!provider.credentialId || !provider.credentialVersionId) {
    throw new Error("memory_query_embedding_binding_invalid");
  }
  return {
    connectionId: provider.connectionId,
    credentialId: provider.credentialId,
    credentialVersionId: provider.credentialVersionId,
    executionSnapshot: provider,
    providerModelId: provider.providerModelId
  };
}

function rerankerEvidence(
  snapshot: MemorySecretFreeExecutionSnapshot
): AcceptedRerankerRuntimeEvidence {
  const provider = snapshot.providerExecutionSnapshot;
  if (!provider.credentialId || !provider.credentialVersionId) {
    throw new Error("memory_reranker_binding_invalid");
  }
  return {
    connectionId: provider.connectionId,
    credentialId: provider.credentialId,
    credentialVersionId: provider.credentialVersionId,
    executionSnapshot: provider,
    providerModelId: provider.providerModelId
  };
}

function embeddingSnapshotMatchesProfile(
  snapshot: MemorySecretFreeExecutionSnapshot,
  profile: MemoryVectorProfile
): boolean {
  const provider = snapshot.providerExecutionSnapshot;
  const model = provider.model;
  if (
    model.adapterKind !== "openai_embeddings_compatible" ||
    model.modelClass !== "embedding"
  ) return false;
  const embedding = model.embedding;
  return snapshot.logicalRole === "MEMORY_QUERY_EMBED" &&
    Boolean(embedding) &&
    embedding?.targetDimension === profile.dimension &&
    provider.connectionId === profile.connectionId &&
    provider.providerModelId === profile.providerModelId &&
    snapshot.compatibilityRequirement.vectorSpaceFingerprint ===
      profile.vectorSpaceFingerprint &&
    snapshot.compatibilityRequirement.retrievalConfigFingerprint ===
      profile.retrievalConfigFingerprint;
}

async function settleQuietly(
  deps: MemoryRunUtilityDependencies,
  userId: string,
  bindingId: string,
  input: Parameters<PrismaMemoryExecutionService["lifecycle"]["settle"]>[2]
): Promise<void> {
  await deps.execution.lifecycle.settle(userId, bindingId, input).catch(() => undefined);
}

async function authorizeAcceptedOutput(
  deps: MemoryRunUtilityDependencies,
  userId: string,
  bindingId: string,
  acceptedOutputHash: string
): Promise<boolean> {
  try {
    await deps.execution.lifecycle.withAuthorizedResultCommit(
      userId,
      { acceptedOutputHash, bindingId },
      async () => true
    );
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function decodeRerank(
  calls: Awaited<ReturnType<MemoryRunUtilityProvider["run"]>>["toolCalls"],
  expectedHandles: readonly string[]
): readonly MemoryRunRerankDecision[] | null {
  const call = calls?.[0];
  if (
    calls?.length !== 1 ||
    call?.name !== MEMORY_RERANK_TOOL_NAME ||
    !isRecord(call.arguments) ||
    !exactKeys(call.arguments, ["decisions"]) ||
    !Array.isArray(call.arguments.decisions) ||
    call.arguments.decisions.length !== expectedHandles.length
  ) return null;
  const expected = new Set(expectedHandles);
  const reasonCodes = new Set([
    "DIRECT_RELEVANCE", "SUPPORTING_CONTEXT", "RESPONSE_PREFERENCE",
    "OUTDATED", "NOT_RELEVANT"
  ]);
  const decisions: MemoryRunRerankDecision[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < call.arguments.decisions.length; index += 1) {
    const value = call.arguments.decisions[index];
    if (!isRecord(value) || !exactKeys(value, [
      "applicable", "current", "handle", "reason_code", "relevance_score"
    ]) || typeof value.handle !== "string" || !expected.has(value.handle) ||
      seen.has(value.handle) ||
      typeof value.applicable !== "boolean" || typeof value.current !== "boolean" ||
      typeof value.relevance_score !== "number" ||
      !Number.isFinite(value.relevance_score) || value.relevance_score < 0 ||
      value.relevance_score > 1 || typeof value.reason_code !== "string" ||
      !reasonCodes.has(value.reason_code)) return null;
    seen.add(value.handle);
    decisions.push({
      applicable: value.applicable,
      current: value.current,
      handle: value.handle,
      reasonCode: value.reason_code as MemoryRunRerankDecision["reasonCode"],
      relevanceScore: value.relevance_score
    });
  }
  return seen.size === expectedHandles.length ? decisions : null;
}

function decodeDedicatedRerank(
  result: RerankResult,
  candidates: readonly RerankCandidate[]
): readonly MemoryRunRerankDecision[] | null {
  if (!Array.isArray(result.scores) || result.scores.length !== candidates.length) {
    return null;
  }
  const seenIndices = new Set<number>();
  const seenHandles = new Set<string>();
  const decisions: MemoryRunRerankDecision[] = [];
  for (const score of result.scores) {
    if (!Number.isSafeInteger(score.index) || score.index < 0 ||
      score.index >= candidates.length || seenIndices.has(score.index) ||
      typeof score.handle !== "string" || seenHandles.has(score.handle) ||
      candidates[score.index]?.handle !== score.handle ||
      typeof score.relevanceScore !== "number" ||
      !Number.isFinite(score.relevanceScore) ||
      score.relevanceScore < 0 || score.relevanceScore > 1) {
      return null;
    }
    seenIndices.add(score.index);
    seenHandles.add(score.handle);
    decisions.push({
      applicable: null,
      current: null,
      handle: score.handle,
      reasonCode: "SCORE_ONLY",
      relevanceScore: score.relevanceScore
    });
  }
  return seenIndices.size === candidates.length &&
    seenHandles.size === candidates.length
    ? Object.freeze(decisions)
    : null;
}

type MemoryTextUtilityDecodeResult<T> = Readonly<{
  errorCode: string | null;
  output: T | null;
}>;

function decodedTextUtilityOutput<T>(
  output: T | null
): MemoryTextUtilityDecodeResult<T> {
  return {
    errorCode: output === null ? "memory_run_utility_output_invalid" : null,
    output
  };
}

async function bindAndStart(
  deps: MemoryRunUtilityDependencies,
  input: UtilityBaseInput,
  role: MemoryExecutionRole,
  ordinal: number,
  versions: MemoryExecutionVersions,
  inputHash: string,
  targetProviderModelId?: string
): Promise<
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      snapshot: MemorySecretFreeExecutionSnapshot;
      status: "STARTED";
    }>
> {
  let bindingId: string | null = null;
  try {
    const binding = await deps.execution.admission.bind(input.userId, {
      inputHash,
      ordinal,
      owner: input.owner ?? {
        retrievalAttemptId: input.attemptId,
        type: "RETRIEVAL_ATTEMPT"
      },
      role,
      ...(targetProviderModelId ? { targetProviderModelId } : {}),
      versions
    });
    bindingId = binding.id;
    if (input.signal.aborted) {
      await settleQuietly(deps, input.userId, bindingId, {
        acceptedOutputHash: null,
        errorCode: "memory_run_utility_cancelled",
        providerResponseId: null,
        state: "CANCELLED",
        usage: unavailableUsage
      });
      return unavailable("memory_run_utility_cancelled", bindingId);
    }
    const started = await deps.execution.admission.start(input.userId, bindingId);
    return { bindingId, snapshot: started.snapshot, status: "STARTED" };
  } catch (error) {
    if (bindingId) {
      await settleQuietly(deps, input.userId, bindingId, {
        acceptedOutputHash: null,
        errorCode: "memory_run_utility_start_failed",
        providerResponseId: null,
        state: "FAILED",
        usage: unavailableUsage
      });
    }
    return unavailable(unavailableReason(error), bindingId ?? undefined);
  }
}

async function runTextUtility<T>(
  deps: MemoryRunUtilityDependencies,
  input: UtilityBaseInput,
  request: Parameters<MemoryRunUtilityProvider["run"]>[1],
  role: "MEMORY_RERANK",
  ordinal: number,
  versions: MemoryExecutionVersions,
  inputHash: string,
  expectedSnapshotHash: string | null,
  decode: (
    calls: Awaited<ReturnType<MemoryRunUtilityProvider["run"]>>["toolCalls"]
  ) => MemoryTextUtilityDecodeResult<T>
): Promise<
  | Readonly<MemoryRunUtilityUnavailable & { snapshotHash?: string }>
  | Readonly<{
      bindingId: string;
      externalCallCount: 1;
      output: T;
      snapshotHash: string;
      status: "READY";
    }>
> {
  const started = await bindAndStart(
    deps,
    input,
    role,
    ordinal,
    versions,
    inputHash
  );
  if (started.status !== "STARTED") return started;
  const snapshotHash = memoryExecutionSha256(started.snapshot);
  const snapshotChanged = expectedSnapshotHash !== null &&
    snapshotHash !== expectedSnapshotHash;
  if (
    started.snapshot.logicalRole !== role ||
    !started.snapshot.requiresStrictStructuredOutput ||
    snapshotChanged
  ) {
    const reason = snapshotChanged
      ? "memory_run_utility_binding_changed"
      : "memory_run_utility_binding_invalid";
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: reason,
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return { ...unavailable(reason, started.bindingId), snapshotHash };
  }
  let result: Awaited<ReturnType<MemoryRunUtilityProvider["run"]>>;
  try {
    result = await deps.provider.run(
      memoryRunUtilityProviderEvidence(started.snapshot),
      request,
      input.signal
    );
  } catch (error) {
    const uncertain = error instanceof MemoryRunUtilityProviderCallError;
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: uncertain
        ? "memory_run_utility_outcome_unknown"
        : "memory_run_utility_provider_failed",
      providerResponseId: null,
      state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
      usage: uncertain && error.usage ? providerUsage(error.usage) : unavailableUsage
    });
    return {
      ...unavailable(uncertain
        ? "memory_run_utility_outcome_unknown"
        : "memory_run_utility_provider_failed", started.bindingId),
      externalCallCount: 1,
      snapshotHash
    };
  }
  const decoded = decode(result.toolCalls);
  const output = decoded.output;
  if (output === null) {
    const errorCode = decoded.errorCode === "memory_run_utility_output_invalid"
      ? decoded.errorCode
      : "memory_run_utility_output_invalid";
    try {
      await deps.execution.lifecycle.settle(input.userId, started.bindingId, {
        acceptedOutputHash: null,
        errorCode,
        providerResponseId: result.providerResponseId,
        state: "FAILED",
        usage: providerUsage(result.usage)
      });
    } catch {
      return {
        ...unavailable("memory_run_utility_settle_failed", started.bindingId),
        externalCallCount: 1,
        snapshotHash
      };
    }
    return {
      ...unavailable(errorCode, started.bindingId),
      externalCallCount: 1,
      snapshotHash
    };
  }
  const outputHash = memoryExecutionSha256({ inputHash, output, role, version: 1 });
  await deps.execution.lifecycle.settle(input.userId, started.bindingId, {
    acceptedOutputHash: outputHash,
    errorCode: null,
    providerResponseId: result.providerResponseId,
    state: "SUCCEEDED",
    usage: providerUsage(result.usage)
  });
  if (!await authorizeAcceptedOutput(
    deps,
    input.userId,
    started.bindingId,
    outputHash
  )) return {
    ...unavailable("memory_execution_policy_drift", started.bindingId),
    externalCallCount: 1,
    snapshotHash
  };
  return {
    bindingId: started.bindingId,
    externalCallCount: 1,
    output,
    snapshotHash,
    status: "READY"
  };
}

async function runDedicatedRerankBatch(
  deps: MemoryRunUtilityDependencies,
  input: RerankInput,
  candidates: readonly RerankCandidate[],
  ordinal: number,
  inputHash: string,
  expectedSnapshotHash: string | null,
  targetProviderModelId?: string,
  expectedPolicyFingerprint?: string | null
): Promise<
  | Readonly<MemoryRunUtilityUnavailable & {
      policyFingerprint?: string;
      retryAfterMs?: number | null;
      snapshotHash?: string;
    }>
  | Readonly<{
      bindingId: string;
      externalCallCount: 1;
      output: readonly MemoryRunRerankDecision[];
      policyFingerprint: string;
      providerModelId: string;
      relevanceScoreFloor: number | null;
      snapshotHash: string;
      status: "READY";
    }>
> {
  const started = await bindAndStart(
    deps,
    input,
    "MEMORY_RERANK",
    ordinal,
    rerankVersions,
    inputHash,
    targetProviderModelId
  );
  if (started.status !== "STARTED") return started;
  const snapshotHash = memoryExecutionSha256(started.snapshot);
  const policyFingerprint = started.snapshot.acceptedUtilityEgressFingerprint;
  const actualProviderModelId =
    started.snapshot.providerExecutionSnapshot.providerModelId;
  if (
    expectedSnapshotHash !== null && snapshotHash !== expectedSnapshotHash ||
    expectedPolicyFingerprint !== undefined &&
      expectedPolicyFingerprint !== null &&
      policyFingerprint !== expectedPolicyFingerprint ||
    targetProviderModelId !== undefined &&
      actualProviderModelId !== targetProviderModelId
  ) {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_run_utility_binding_changed",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable("memory_run_utility_binding_changed", started.bindingId),
      policyFingerprint,
      snapshotHash
    };
  }
  const model = started.snapshot.providerExecutionSnapshot.model;
  if (
    started.snapshot.logicalRole !== "MEMORY_RERANK" ||
    started.snapshot.requiresStrictStructuredOutput ||
    model.adapterKind === "fake" || model.modelClass !== "reranker" ||
    model.adapterKind !== "openrouter_rerank"
  ) {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_reranker_binding_invalid",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable("memory_reranker_binding_invalid", started.bindingId),
      policyFingerprint,
      snapshotHash
    };
  }
  let runtime: Awaited<ReturnType<AcceptedRerankerRuntime["resolve"]>>;
  if (!deps.rerankerRuntime) {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_reranker_runtime_unavailable",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable("memory_reranker_runtime_unavailable", started.bindingId),
      policyFingerprint,
      snapshotHash
    };
  }
  try {
    runtime = await deps.rerankerRuntime.resolve(rerankerEvidence(started.snapshot));
  } catch {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_reranker_runtime_unavailable",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable("memory_reranker_runtime_unavailable", started.bindingId),
      policyFingerprint,
      snapshotHash
    };
  }
  let result: RerankResult;
  try {
    result = await runtime.adapter.rerank({
      documents: candidates.map((candidate) => ({
        handle: candidate.handle,
        text: memoryDedicatedRerankDocument(candidate)
      })),
      query: input.query,
      signal: input.signal
    });
  } catch (error) {
    const transientHttp = !input.signal.aborted &&
      error instanceof RerankAdapterError &&
      error.code === "rerank_provider_http_error" &&
      isProviderRetryableHttpStatus(error.httpStatus);
    const deploymentUnavailable = !input.signal.aborted &&
      error instanceof RerankAdapterError &&
      error.code === "rerank_provider_http_error" &&
      (error.httpStatus === 404 || error.httpStatus === 410);
    const invalidOutput = error instanceof RerankAdapterError &&
      error.code === "rerank_response_invalid";
    const deploymentMismatch = error instanceof RerankAdapterError && (
      error.code === "rerank_response_model_mismatch" ||
      error.code === "rerank_response_provider_mismatch"
    );
    const uncertain = input.signal.aborted || !(error instanceof RerankAdapterError) ||
      uncertainRerankErrors.has(error.code);
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: transientHttp
        ? "memory_reranker_transient_http_failure"
        : deploymentUnavailable
          ? "memory_reranker_model_unavailable"
        : error instanceof RerankAdapterError
          ? error.code
          : "memory_reranker_outcome_unknown",
      providerResponseId: null,
      state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable(uncertain
        ? "memory_reranker_outcome_unknown"
        : transientHttp
          ? "memory_reranker_transient_http_failure"
          : deploymentUnavailable
            ? "memory_reranker_model_unavailable"
          : invalidOutput
            ? "memory_run_utility_output_invalid"
            : deploymentMismatch
              ? "memory_run_utility_binding_changed"
              : "memory_reranker_failed", started.bindingId),
      externalCallCount: 1,
      ...(transientHttp ? { retryAfterMs: error.retryAfterMs } : {}),
      policyFingerprint,
      snapshotHash
    };
  }
  const output = decodeDedicatedRerank(result, candidates);
  if (!output) {
    try {
      await deps.execution.lifecycle.settle(input.userId, started.bindingId, {
        acceptedOutputHash: null,
        errorCode: "memory_run_utility_output_invalid",
        providerResponseId: boundedResponseId(result.requestId),
        state: "FAILED",
        usage: rerankerUsage(result)
      });
    } catch {
      return {
        ...unavailable("memory_run_utility_settle_failed", started.bindingId),
        externalCallCount: 1,
        policyFingerprint,
        snapshotHash
      };
    }
    return {
      ...unavailable("memory_run_utility_output_invalid", started.bindingId),
      externalCallCount: 1,
      policyFingerprint,
      snapshotHash
    };
  }
  const outputHash = memoryExecutionSha256({ inputHash, output, version: 1 });
  try {
    await deps.execution.lifecycle.settle(input.userId, started.bindingId, {
      acceptedOutputHash: outputHash,
      errorCode: null,
      providerResponseId: boundedResponseId(result.requestId),
      state: "SUCCEEDED",
      usage: rerankerUsage(result)
    });
  } catch {
    return {
      ...unavailable("memory_run_utility_settle_failed", started.bindingId),
      externalCallCount: 1,
      policyFingerprint,
      snapshotHash
    };
  }
  if (!await authorizeAcceptedOutput(
    deps,
    input.userId,
    started.bindingId,
    outputHash
  )) return {
    ...unavailable("memory_execution_policy_drift", started.bindingId),
    externalCallCount: 1,
    policyFingerprint,
    snapshotHash
  };
  return {
    bindingId: started.bindingId,
    externalCallCount: 1,
    output,
    policyFingerprint,
    providerModelId: actualProviderModelId,
    relevanceScoreFloor:
      approvedRerankerDeploymentByProviderModelId(actualProviderModelId)
        ?.preset.relevanceScoreFloor ?? null,
    snapshotHash,
    status: "READY"
  };
}

async function runQueryEmbeddingAttempt(
  deps: MemoryRunUtilityDependencies,
  input: QueryEmbeddingInput,
  renderedQuery: string,
  inputHash: string,
  ordinal: number,
  expectedSnapshotHash: string | null
): Promise<
  | Readonly<MemoryRunUtilityUnavailable & {
      retryAfterMs?: number | null;
      snapshotHash?: string;
    }>
  | Readonly<{
      bindingId: string;
      externalCallCount: number;
      providerRequestRoutes?: readonly (string | null)[];
      profile: MemoryVectorProfile;
      snapshotHash: string;
      status: "READY";
      vector: readonly number[];
    }>
> {
  const started = await bindAndStart(
    deps,
    input,
    "MEMORY_QUERY_EMBED",
    ordinal,
    MEMORY_QUERY_EMBEDDING_VERSIONS,
    inputHash
  );
  if (started.status !== "STARTED") return started;
  const snapshotHash = memoryExecutionSha256(started.snapshot);
  if (expectedSnapshotHash !== null && snapshotHash !== expectedSnapshotHash) {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_run_utility_binding_changed",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable("memory_run_utility_binding_changed", started.bindingId),
      snapshotHash
    };
  }
  if (!embeddingSnapshotMatchesProfile(started.snapshot, input.profile)) {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_query_embedding_profile_changed",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable("memory_query_embedding_profile_changed", started.bindingId),
      snapshotHash
    };
  }
  let runtime: Awaited<ReturnType<AcceptedEmbeddingRuntime["resolve"]>>;
  try {
    runtime = await deps.embeddingRuntime.resolve(embeddingEvidence(started.snapshot));
  } catch (error) {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_query_embedding_runtime_unavailable",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable(unavailableReason(error), started.bindingId),
      snapshotHash
    };
  }
  let result: EmbeddingResult;
  const attempt = boundedProviderAttemptSignal(
    input.signal,
    MEMORY_QUERY_EMBEDDING_ATTEMPT_TIMEOUT_MS,
    "memory_query_embedding_attempt_timeout"
  );
  try {
    result = await runtime.adapter.embed({
      // The Memory instruction is part of the versioned Memory profile.
      // Use document mode so a mutable provider-level query template
      // cannot prepend a second, domain-inappropriate instruction.
      latencyClass: "interactive",
      mode: "document",
      signal: attempt.signal,
      texts: [renderedQuery]
    });
  } catch (error) {
    const attemptTimedOut = attempt.expired() && !input.signal.aborted;
    const transientHttp = !attempt.signal.aborted &&
      error instanceof EmbeddingAdapterError &&
      error.code === "embedding_provider_http_error" &&
      isProviderRetryableHttpStatus(error.httpStatus);
    const uncertain = !(error instanceof EmbeddingAdapterError) ||
      uncertainEmbeddingErrors.has(error.code) || attempt.signal.aborted;
    const externalCallCount = error instanceof EmbeddingAdapterError &&
      error.providerRequestCount !== null
      ? error.providerRequestCount
      : 1;
    const providerRequestRoutes = error instanceof EmbeddingAdapterError
      ? error.providerRequestRoutes
      : null;
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: attemptTimedOut
        ? "memory_query_embedding_attempt_timed_out"
        : transientHttp
        ? "memory_query_embedding_transient_http_failure"
        : error instanceof EmbeddingAdapterError
          ? error.code
          : "memory_query_embedding_outcome_unknown",
      providerResponseId: null,
      state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
      usage: unavailableUsage
    });
    return {
      ...unavailable(uncertain
        ? "memory_query_embedding_outcome_unknown"
        : transientHttp
          ? "memory_query_embedding_transient_http_failure"
          : "memory_query_embedding_failed", started.bindingId),
      externalCallCount,
      ...(providerRequestRoutes !== null ? { providerRequestRoutes } : {}),
      ...(transientHttp ? { retryAfterMs: error.retryAfterMs } : {}),
      snapshotHash
    };
  } finally {
    attempt.dispose();
  }
  const externalCallCount = result.providerRequestCount ?? 1;
  const providerRequestRoutes = result.providerRequestRoutes ?? null;
  const vector = result.vectors[0];
  const squaredNorm = vector?.reduce((total, value) => total + value * value, 0) ?? 0;
  if (
    result.vectors.length !== 1 ||
    !vector ||
    vector.length !== input.profile.dimension ||
    vector.some((value) => !Number.isFinite(value)) ||
    !Number.isFinite(squaredNorm) ||
    squaredNorm <= 0
  ) {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_query_embedding_output_invalid",
      providerResponseId: boundedResponseId(result.requestId),
      state: "FAILED",
      usage: embeddingUsage(result)
    });
    return {
      ...unavailable("memory_query_embedding_output_invalid", started.bindingId),
      externalCallCount,
      ...(providerRequestRoutes !== null ? { providerRequestRoutes } : {}),
      snapshotHash
    };
  }
  const outputHash = memoryExecutionSha256({ inputHash, vector, version: 1 });
  await deps.execution.lifecycle.settle(input.userId, started.bindingId, {
    acceptedOutputHash: outputHash,
    errorCode: null,
    providerResponseId: boundedResponseId(result.requestId),
    state: "SUCCEEDED",
    usage: embeddingUsage(result)
  });
  if (!await authorizeAcceptedOutput(
    deps,
    input.userId,
    started.bindingId,
    outputHash
  )) return {
    ...unavailable("memory_execution_policy_drift", started.bindingId),
    externalCallCount,
    ...(providerRequestRoutes !== null ? { providerRequestRoutes } : {}),
    snapshotHash
  };
  return {
    bindingId: started.bindingId,
    externalCallCount,
    ...(providerRequestRoutes !== null ? { providerRequestRoutes } : {}),
    profile: input.profile,
    snapshotHash,
    status: "READY",
    vector
  };
}

function validSafeQuery(query: string): boolean {
  return query.length > 0 && query.length <= 2_000 && !query.includes("\u0000");
}

function queryEmbeddingOrdinal(
  input: QueryEmbeddingBaseInput,
  purpose: "ACTION_TARGET" | "RETRIEVAL"
): number | null {
  if (input.owner?.type === "JOB") {
    return purpose === "RETRIEVAL" &&
      (input.jobAttemptCount === 1 || input.jobAttemptCount === 2)
      ? input.jobAttemptCount
      : null;
  }
  if ("jobAttemptCount" in input && input.jobAttemptCount !== undefined) return null;
  return purpose === "ACTION_TARGET" ? 3 : 1;
}

export function createMemoryRunUtilityService(
  deps: MemoryRunUtilityDependencies
): MemoryRunUtilityService {
  return Object.freeze({

    async embedQuery(input) {
      const safeQuery = sanitizeMemoryUtilityText(input.query);
      if (!safeQuery.eligible || !safeQuery.safeText ||
        !validSafeQuery(safeQuery.safeText)) return unavailable("memory_utility_input_blocked");
      const purpose = input.purpose ?? "RETRIEVAL";
      const ordinal = queryEmbeddingOrdinal(input, purpose);
      if (ordinal === null) return unavailable("memory_utility_input_blocked");
      const renderedQuery = renderMemoryQueryEmbeddingText(safeQuery.safeText);
      const inputHash = memoryExecutionSha256({
        domain: "aiqsa.memory.query-embedding-input",
        embeddingProfileFingerprint: MEMORY_EMBEDDING_PROFILE_FINGERPRINT,
        profile: input.profile,
        attemptTimeoutMs: MEMORY_QUERY_EMBEDDING_ATTEMPT_TIMEOUT_MS,
        ...(purpose === "ACTION_TARGET" ? { purpose } : {}),
        queryHash: memorySha256(safeQuery.safeText),
        renderedQueryHash: memorySha256(renderedQuery),
        version: purpose === "ACTION_TARGET" ? 6 : 5
      });
      const result = await runQueryEmbeddingAttempt(
        deps,
        input,
        renderedQuery,
        inputHash,
        ordinal,
        null
      );
      return result.status === "READY"
        ? {
            bindingId: result.bindingId,
            ...(result.externalCallCount !== undefined
              ? { externalCallCount: result.externalCallCount }
              : {}),
            profile: result.profile,
            ...(result.providerRequestRoutes !== undefined
              ? { providerRequestRoutes: result.providerRequestRoutes }
              : {}),
            status: "READY",
            vector: result.vector
          }
        : {
            ...unavailable(result.reason, result.bindingId),
            ...(result.externalCallCount !== undefined
              ? { externalCallCount: result.externalCallCount }
              : {}),
            ...(result.providerRequestRoutes !== undefined
              ? { providerRequestRoutes: result.providerRequestRoutes }
              : {})
          };
    },

    async rerank(input) {
      const safeQuery = sanitizeMemoryUtilityText(input.query);
      const safeCandidates = input.candidates.map(safeRerankCandidate);
      if (!safeQuery.eligible || !safeQuery.safeText || safeCandidates.some((item) => !item)) {
        return unavailable("memory_utility_input_blocked");
      }
      const safeInput = {
        ...input,
        candidates: safeCandidates as typeof input.candidates,
        query: safeQuery.safeText
      };
      const aggregationRequested = safeInput.aggregationRequested === true;
      const totalCharacters = safeInput.candidates.reduce(
        (total, candidate) => total + candidate.text.length,
        0
      );
      const handles = safeInput.candidates.map((candidate) => candidate.handle);
      if (
        !validSafeQuery(safeInput.query) ||
        typeof safeInput.profileRequested !== "boolean" ||
        !["CURRENT_PROFILE", "TARGETED_CURRENT", "HISTORICAL_MEMORY",
          "PAST_CHAT_SEARCH", "HISTORY_OVERVIEW"].includes(safeInput.retrievalMode) ||
        !["CURRENT", "HISTORICAL", "AS_OF", "BETWEEN", "ANY"]
          .includes(safeInput.temporalIntent) ||
        safeInput.candidates.length < 1 ||
        safeInput.candidates.length > (aggregationRequested
          ? MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES
          : MEMORY_RERANK_TARGETED_MAX_CANDIDATES) ||
        totalCharacters > (aggregationRequested
          ? MEMORY_RERANK_AGGREGATION_MAX_TOTAL_CHARACTERS
          : MEMORY_RERANK_TARGETED_MAX_TOTAL_CHARACTERS) ||
        new Set(handles).size !== handles.length ||
        safeInput.candidates.some((candidate, index) =>
          candidate.handle !== `c${index}` ||
          candidate.text.length < 1 ||
          candidate.text.length > 4_000 ||
          candidate.text.includes("\u0000") ||
          candidate.current === candidate.historical ||
          !["EVENT", "FACT", "HISTORY", "TOOL_OBSERVATION"]
            .includes(candidate.sourceKind) ||
          !["assistant", "memory_record", "mixed_conversation", "tool", "user"]
            .includes(candidate.speakerScope) ||
          !["any", "as_of", "between", "current", "historical"]
            .includes(candidate.temporalReason) ||
          [candidate.occurredFrom, candidate.occurredTo].some((value) =>
            value !== null && (value.length < 1 || value.length > 64 ||
              !Number.isFinite(Date.parse(value))))
        ) || safeInput.profileRequested && safeInput.candidates.some((candidate) =>
          !candidate.current || candidate.sourceKind === "HISTORY" ||
          candidate.sourceKind === "TOOL_OBSERVATION")
      ) return unavailable("memory_utility_input_blocked");
      let rerankPath: MemoryRerankPath;
      try {
        rerankPath = await deps.resolveRerankPath?.(safeInput.userId) ??
          "GENERATIVE_COMPATIBILITY";
      } catch {
        // This hint controls envelope partitioning only. Immutable admission
        // remains authoritative and rejects a path mismatch before external I/O.
        rerankPath = "GENERATIVE_COMPATIBILITY";
      }
      const candidateBatches = rerankPath === "DEDICATED"
        ? partitionDedicatedRerankCandidates(safeInput)
        : partitionRerankCandidates(safeInput);
      if (!candidateBatches) return unavailable("memory_utility_input_blocked");
      let dedicatedRoute: DedicatedRerankRoute | null = null;
      if (rerankPath === "DEDICATED" && deps.resolveDedicatedRerankRoute) {
        try {
          const resolved = await deps.resolveDedicatedRerankRoute();
          if (
            resolved.policyVersion === RERANKER_ROUTE_POLICY_VERSION &&
            resolved.providerModelIds.length > 0 &&
            resolved.providerModelIds.length <= MEMORY_RERANK_MAX_ROUTE_MODELS &&
            new Set(resolved.providerModelIds).size === resolved.providerModelIds.length
          ) dedicatedRoute = resolved;
        } catch {
          return unavailable("memory_reranker_runtime_unavailable");
        }
      }
      const rerankBatchInputHash = (
        candidates: readonly RerankCandidate[],
        batchIndex: number
      ) => memoryExecutionSha256({
        rerankBatchCount: candidateBatches.length,
        rerankBatchIndex: batchIndex,
        aggregationRequested,
        candidates: candidates.map((candidate) => ({
          authorityLevel: candidate.authorityLevel,
          current: candidate.current,
          directness: candidate.directness,
          handle: candidate.handle,
          historical: candidate.historical,
          lifecycleState: candidate.lifecycleState,
          occurredFrom: candidate.occurredFrom,
          occurredTo: candidate.occurredTo,
          sensitivityClass: candidate.sensitivityClass,
          speakerScope: candidate.speakerScope,
          sourceKind: candidate.sourceKind,
          temporalReason: candidate.temporalReason,
          documentHash: memorySha256(memoryDedicatedRerankDocument(candidate))
        })),
        domain: "aiqsa.memory.relevance-input",
        profileRequested: safeInput.profileRequested,
        queryHash: memorySha256(safeInput.query),
        rerankPath,
        retrievalMode: safeInput.retrievalMode,
        temporalIntent: safeInput.temporalIntent,
        version: 15
      });
      const runLegacyBatches = () => mapWithConcurrency(
        candidateBatches,
        MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES,
        async (candidates, batchIndex) => {
          const batchHandles = candidates.map((candidate) => candidate.handle);
          const inputHash = rerankBatchInputHash(candidates, batchIndex);
          const firstOrdinal = rerankBatchFirstOrdinal(batchIndex);
          if (rerankPath === "DEDICATED") {
            let result = await runDedicatedRerankBatch(
              deps,
              safeInput,
              candidates,
              firstOrdinal,
              inputHash,
              null
            );
            let externalCallCount = result.externalCallCount ?? 0;
            let invalidResponseCount = result.status === "UNAVAILABLE" &&
              result.reason === "memory_run_utility_output_invalid" ? 1 : 0;
            let providerModelMismatchCount = result.status === "UNAVAILABLE" &&
              result.reason === "memory_run_utility_binding_changed" ? 1 : 0;
            const expectedSnapshotHash = result.snapshotHash;
            for (let retryIndex = 1;
              retryIndex < MEMORY_RERANK_MAX_ATTEMPTS &&
              result.status !== "READY" &&
              retryableDedicatedRerankReasons.has(result.reason) &&
              expectedSnapshotHash !== undefined &&
              !safeInput.signal.aborted &&
              (safeInput.canRetry?.() ?? true) &&
              await waitForMemoryUtilityRetry(
                result.retryAfterMs,
                safeInput.signal,
                { retryIndex, snapshotHash: expectedSnapshotHash }
              ) &&
              (safeInput.canRetry?.() ?? true);
              retryIndex += 1
            ) {
              const retry = await runDedicatedRerankBatch(
                deps,
                safeInput,
                candidates,
                firstOrdinal + retryIndex,
                inputHash,
                expectedSnapshotHash
              );
              externalCallCount += retry.externalCallCount ?? 0;
              invalidResponseCount += retry.status === "UNAVAILABLE" &&
                retry.reason === "memory_run_utility_output_invalid" ? 1 : 0;
              providerModelMismatchCount += retry.status === "UNAVAILABLE" &&
                retry.reason === "memory_run_utility_binding_changed" ? 1 : 0;
              result = retry;
            }
            return {
              ...result,
              externalCallCount,
              invalidResponseCount,
              providerModelMismatchCount
            };
          }
          let result = await runTextUtility(
            deps,
            safeInput,
            rerankProviderInput(safeInput, candidates),
            "MEMORY_RERANK",
            firstOrdinal,
            rerankVersions,
            inputHash,
            null,
            (calls) => decodedTextUtilityOutput(decodeRerank(calls, batchHandles))
          );
          let externalCallCount = result.externalCallCount ?? 0;
          let invalidResponseCount = result.status === "UNAVAILABLE" &&
            result.reason === "memory_run_utility_output_invalid" ? 1 : 0;
          let providerModelMismatchCount = result.status === "UNAVAILABLE" &&
            result.reason === "memory_run_utility_binding_changed" ? 1 : 0;
          // The reranker is side-effect-free. One structurally invalid or
          // transport-uncertain result may therefore receive one fresh durable
          // binding against the exact same execution snapshot. Cancellation,
          // policy drift, and a second failure remain terminal degradation.
          if (
            result.status !== "READY" &&
            retryableTextUtilityReason(result.reason) &&
            result.snapshotHash !== undefined &&
            !safeInput.signal.aborted &&
            (safeInput.canRetry?.() ?? true)
          ) {
            const retry = await runTextUtility(
              deps,
              safeInput,
              rerankProviderInput(safeInput, candidates),
              "MEMORY_RERANK",
              firstOrdinal + 1,
              rerankVersions,
              inputHash,
              result.snapshotHash,
              (calls) => decodedTextUtilityOutput(decodeRerank(calls, batchHandles))
            );
            externalCallCount += retry.externalCallCount ?? 0;
            invalidResponseCount += retry.status === "UNAVAILABLE" &&
              retry.reason === "memory_run_utility_output_invalid" ? 1 : 0;
            providerModelMismatchCount += retry.status === "UNAVAILABLE" &&
              retry.reason === "memory_run_utility_binding_changed" ? 1 : 0;
            result = retry;
          }
          return {
            ...result,
            externalCallCount,
            invalidResponseCount,
            providerModelMismatchCount
          };
        }
      );
      type BatchResults = Awaited<ReturnType<typeof runLegacyBatches>>;
      let routeFallbackDepth: number | null = null;
      let routeModelAttemptCount = 0;
      let results: BatchResults;
      if (dedicatedRoute) {
        let accumulatedExternalCallCount = 0;
        let accumulatedInvalidResponseCount = 0;
        let accumulatedProviderModelMismatchCount = 0;
        let expectedPolicyFingerprint: string | null = null;
        let lastResults: BatchResults | null = null;
        for (const [routeIndex, providerModelId] of
          dedicatedRoute.providerModelIds.entries()) {
          routeModelAttemptCount += 1;
          const routeResults = await mapWithConcurrency(
            candidateBatches,
            MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES,
            async (candidates, batchIndex) => {
              const result = await runDedicatedRerankBatch(
                deps,
                safeInput,
                candidates,
                rerankRouteBatchOrdinal(routeIndex, batchIndex),
                rerankBatchInputHash(candidates, batchIndex),
                null,
                providerModelId,
                expectedPolicyFingerprint
              );
              return {
                ...result,
                externalCallCount: result.externalCallCount ?? 0,
                invalidResponseCount: result.status === "UNAVAILABLE" &&
                  result.reason === "memory_run_utility_output_invalid" ? 1 : 0,
                providerModelMismatchCount: result.status === "UNAVAILABLE" &&
                  result.reason === "memory_run_utility_binding_changed" ? 1 : 0
              };
            }
          );
          const policyFingerprints = new Set(routeResults.flatMap((result) =>
            result.policyFingerprint ? [result.policyFingerprint] : []));
          const routeSnapshotHashes = new Set(routeResults.flatMap((result) =>
            result.status === "READY" ? [result.snapshotHash] : []));
          const routePolicyConsistent =
            routeResults.every((result) => Boolean(result.policyFingerprint)) &&
            policyFingerprints.size === 1 &&
            (expectedPolicyFingerprint === null ||
              policyFingerprints.has(expectedPolicyFingerprint));
          if (expectedPolicyFingerprint === null && routePolicyConsistent) {
            expectedPolicyFingerprint = [...policyFingerprints][0]!;
          }
          const priorExternalCallCount = accumulatedExternalCallCount;
          const priorInvalidResponseCount = accumulatedInvalidResponseCount;
          const priorProviderModelMismatchCount =
            accumulatedProviderModelMismatchCount;
          accumulatedExternalCallCount += routeResults.reduce((total, result) =>
            total + result.externalCallCount, 0);
          accumulatedInvalidResponseCount += routeResults.reduce((total, result) =>
            total + result.invalidResponseCount, 0);
          accumulatedProviderModelMismatchCount += routeResults.reduce((total, result) =>
            total + result.providerModelMismatchCount, 0);
          lastResults = routeResults.map((result, index) => ({
            ...result,
            externalCallCount: result.externalCallCount +
              (index === 0 ? priorExternalCallCount : 0),
            invalidResponseCount: result.invalidResponseCount +
              (index === 0 ? priorInvalidResponseCount : 0),
            providerModelMismatchCount: result.providerModelMismatchCount +
              (index === 0 ? priorProviderModelMismatchCount : 0)
          })) as BatchResults;
          const routeReady = routeResults.length === candidateBatches.length &&
            routeResults.every((result) => result.status === "READY") &&
            routeSnapshotHashes.size === 1 && routePolicyConsistent;
          if (routeReady) {
            routeFallbackDepth = routeIndex;
            break;
          }
          const unavailableResults = routeResults.filter(
            (result) => result.status === "UNAVAILABLE"
          );
          const canFallback = routePolicyConsistent &&
            unavailableResults.length > 0 &&
            unavailableResults.every((result) =>
              dedicatedRerankerModelFallbackReasons.has(result.reason)) &&
            routeIndex + 1 < dedicatedRoute.providerModelIds.length &&
            !safeInput.signal.aborted &&
            (safeInput.canRetry?.() ?? true);
          if (!canFallback) break;
        }
        results = lastResults ?? [];
      } else {
        results = await runLegacyBatches();
      }
      const externalCallCount = results.reduce((total, result) =>
        total + result.externalCallCount, 0);
      const ready = results.filter((result) => result.status === "READY");
      const decisions = ready.flatMap((result) => result.output);
      const decisionHandles = decisions.map(({ handle }) => handle);
      const expectedHandles = new Set(handles);
      const uniqueDecisionHandles = new Set(decisionHandles.filter((handle) =>
        expectedHandles.has(handle)));
      const duplicateDecisionCount = decisionHandles.length -
        new Set(decisionHandles).size;
      const allBatchesReady = ready.length === candidateBatches.length &&
        results.length === candidateBatches.length;
      const batchCoverageExact = results.every((result, index) => {
        if (result.status !== "READY") return false;
        const expectedBatchHandles = new Set(candidateBatches[index]!.map(({ handle }) =>
          handle));
        const actualBatchHandles = result.output.map(({ handle }) => handle);
        return result.output.length === candidateBatches[index]!.length &&
          new Set(actualBatchHandles).size === actualBatchHandles.length &&
          actualBatchHandles.every((handle) => expectedBatchHandles.has(handle));
      });
      const globalCoverageExact = decisions.length === handles.length &&
        duplicateDecisionCount === 0 &&
        uniqueDecisionHandles.size === handles.length;
      const snapshotHashes = new Set(ready.map(({ snapshotHash }) => snapshotHash));
      const snapshotConsistent = ready.length > 0 && snapshotHashes.size === 1;
      const atomicReady = allBatchesReady && batchCoverageExact &&
        globalCoverageExact && snapshotConsistent;
      const invalidResponseCount = results.reduce((count, result, index) =>
        count + result.invalidResponseCount +
        (result.status === "READY" &&
          result.output.length !== candidateBatches[index]!.length ? 1 : 0), 0);
      const diagnostics = Object.freeze({
        batchCount: candidateBatches.length,
        candidateCount: safeInput.candidates.length,
        coverageRatio: safeInput.candidates.length === 0
          ? 0
          : uniqueDecisionHandles.size / safeInput.candidates.length,
        decisionCount: decisions.length,
        duplicateDecisionCount,
        failedBatchCount: candidateBatches.length - ready.length,
        ...(dedicatedRoute ? { fallbackDepth: routeFallbackDepth } : {}),
        fullFallbackUsed: !atomicReady,
        invalidResponseCount: Math.max(
          invalidResponseCount,
          allBatchesReady && (!batchCoverageExact || !globalCoverageExact) ? 1 : 0
        ),
        missingDecisionCount: Math.max(
          0,
          safeInput.candidates.length - uniqueDecisionHandles.size
        ),
        ...(dedicatedRoute ? { modelAttemptCount: routeModelAttemptCount } : {}),
        providerModelMismatchCount: results.reduce((count, result) =>
          count + result.providerModelMismatchCount, 0) +
          (ready.length > 1 && !snapshotConsistent ? 1 : 0),
        readyBatchCount: ready.length,
        retryCount: Math.max(0, externalCallCount - candidateBatches.length),
        ...(dedicatedRoute
          ? { routePolicyVersion: RERANKER_ROUTE_POLICY_VERSION }
          : {})
      } satisfies MemoryRerankDiagnostics);
      const bindingId = ready[0]?.bindingId;
      if (bindingId && atomicReady) {
        const successful = ready[0]!;
        const relevanceScoreFloor = rerankPath === "DEDICATED" &&
          "relevanceScoreFloor" in successful &&
          typeof successful.relevanceScoreFloor !== "undefined"
          ? successful.relevanceScoreFloor
          : null;
        const rerankerRoute = dedicatedRoute && routeFallbackDepth !== null &&
          "providerModelId" in successful &&
          "policyFingerprint" in successful &&
          typeof successful.providerModelId === "string" &&
          typeof successful.policyFingerprint === "string"
          ? {
              fallbackDepth: routeFallbackDepth,
              policyFingerprint: successful.policyFingerprint,
              policyVersion: RERANKER_ROUTE_POLICY_VERSION,
              providerModelId: successful.providerModelId
            }
          : null;
        return {
          bindingId,
          decisions,
          diagnostics,
          ...(externalCallCount > 1 ? { externalCallCount } : {}),
          relevanceScoreFloor,
          ...(rerankerRoute ? { rerankerRoute } : {}),
          status: "READY"
        };
      }
      const failed = results.find((result) => result.status === "UNAVAILABLE");
      const reason = failed?.status === "UNAVAILABLE"
        ? failed.reason
        : !snapshotConsistent
          ? "memory_run_utility_binding_changed"
          : "memory_run_utility_output_invalid";
      return {
        ...unavailable(reason, failed?.bindingId ?? bindingId),
        diagnostics,
        ...(externalCallCount > 1 ? { externalCallCount } : {})
      };
    }
  });
}

export function createPrismaMemoryRunUtilityService(
  authority: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma,
  options: Readonly<{
    embeddingRuntime?: AcceptedEmbeddingRuntime;
    execution?: PrismaMemoryExecutionService;
    provider?: MemoryRunUtilityProvider;
    rerankerRuntime?: AcceptedRerankerRuntime;
    resolveDedicatedRerankRoute?: () => Promise<DedicatedRerankRoute>;
    resolveRerankPath?: (userId: string) => Promise<MemoryRerankPath>;
  }> = {}
): MemoryRunUtilityService {
  const rerankerRoleResolver = createRerankerModelRoleResolver(client);
  return createMemoryRunUtilityService({
    embeddingRuntime: options.embeddingRuntime ?? createAcceptedEmbeddingRuntime(client),
    execution: options.execution ?? createPrismaMemoryExecutionService(authority, client),
    provider: options.provider ?? createAcceptedMemoryRunUtilityProvider(client),
    rerankerRuntime: options.rerankerRuntime ?? createAcceptedRerankerRuntime(client),
    resolveDedicatedRerankRoute: options.resolveDedicatedRerankRoute ?? (async () => {
      const resolution = await rerankerRoleResolver.resolve();
      return {
        policyVersion: RERANKER_ROUTE_POLICY_VERSION,
        providerModelIds: resolution.ok
          ? (resolution.routes ?? [{
              providerModelId: resolution.providerModelId,
              role: resolution.role
            }]).map(({ providerModelId }) => providerModelId)
          : []
      };
    }),
    resolveRerankPath: options.resolveRerankPath ?? (async () => {
      const policy = await client.systemModelPolicy.findUnique({
        select: { rerankerProviderModelId: true },
        where: { id: "installation" }
      });
      return policy?.rerankerProviderModelId
        ? "DEDICATED" as const
        : "GENERATIVE_COMPATIBILITY" as const;
    })
  });
}
