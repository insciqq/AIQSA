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
  MAX_RERANK_DOCUMENTS,
  MAX_RERANK_REQUEST_BYTES,
  RerankAdapterError,
  type RerankResult
} from "../../providers/rerank";
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
  MEMORY_EMBEDDING_PROFILE_FINGERPRINT,
  renderMemoryQueryEmbeddingText
} from "../embedding/contract";
import {
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
  MEMORY_AGGREGATION_TOOL_NAME,
  MEMORY_RERANK_MAX_PROMPT_CHARACTERS,
  MEMORY_RERANK_TOOL_NAME,
  type MemoryAggregationUtilityProviderInput,
  type MemoryRerankUtilityProviderInput,
  type MemoryRunUtilityProvider,
  type MemoryRunUtilityProviderInput
} from "./runUtilityRuntime";
import { sanitizeMemoryUtilityText } from "./querySafety";
import {
  MEMORY_AGGREGATION_MAX_MEMBER_QUANTITY,
  MEMORY_AGGREGATION_OPERATIONS,
  MEMORY_AGGREGATION_RESOLUTIONS,
  MEMORY_AGGREGATION_ROLES,
  type MemoryAggregationPlan
} from "./aggregation";

export const MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION =
  "memory-query-embedding-v2";
export const MEMORY_REMOTE_RERANK_PIPELINE_VERSION =
  "memory-multilingual-relevance-v20";
export const MEMORY_AGGREGATION_PIPELINE_VERSION =
  "memory-evidence-aggregation-v2";
export const MEMORY_RERANK_MAX_ATTEMPTS = 2;
export const MEMORY_RERANK_AGGREGATION_BATCH_SIZE = 20;
export const MEMORY_RERANK_TARGETED_MAX_CANDIDATES =
  MEMORY_RETRIEVAL_MAX_TARGETED_RERANK_CANDIDATES;
export const MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES =
  MEMORY_RETRIEVAL_MAX_AGGREGATION_HISTORY_CANDIDATES;
export const MEMORY_RERANK_AGGREGATION_MAX_BATCHES = Math.ceil(
  MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES / MEMORY_RERANK_AGGREGATION_BATCH_SIZE
);
export const MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES = 3;
export const MEMORY_DEDICATED_RERANK_WIRE_RESERVE_BYTES = 16 * 1024;
export const MEMORY_RERANK_TARGETED_MAX_TOTAL_CHARACTERS =
  MEMORY_RERANK_TARGETED_MAX_CANDIDATES * 4_000;
export const MEMORY_RERANK_AGGREGATION_MAX_TOTAL_CHARACTERS =
  MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES * 4_000;
export const MEMORY_AGGREGATION_MAX_ATTEMPTS = 2;
export const MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS = 24;
export const MEMORY_AGGREGATION_PRIMARY_ORDINAL = 0;

export const MEMORY_QUERY_EMBEDDING_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION,
  policyVersion: "memory-query-embedding-policy-v2",
  promptVersion: "memory-query-instruction-v2",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  schemaVersion: "memory-query-embedding-result-v2"
});

const rerankVersions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_REMOTE_RERANK_PIPELINE_VERSION,
  policyVersion: "memory-relevance-policy-v17",
  promptVersion: "memory-relevance-input-v16",
  retrievalConfigFingerprint: memoryExecutionSha256({
    candidateMaxCharacters: 4_000,
    aggregationBatchSize: MEMORY_RERANK_AGGREGATION_BATCH_SIZE,
    aggregationBatchMaxPromptCharacters: MEMORY_RERANK_MAX_PROMPT_CHARACTERS,
    maxAggregationBatches: MEMORY_RERANK_AGGREGATION_MAX_BATCHES,
    maxAggregationCandidates: MEMORY_RERANK_AGGREGATION_MAX_CANDIDATES,
    maxTargetedCandidates: MEMORY_RERANK_TARGETED_MAX_CANDIDATES,
    maxAttemptsPerBatch: MEMORY_RERANK_MAX_ATTEMPTS,
    maxAggregationTotalCharacters: MEMORY_RERANK_AGGREGATION_MAX_TOTAL_CHARACTERS,
    maxParallelAggregationBatches: MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES,
    maxOutputTokens: 4_096,
    maxTargetedTotalCharacters: MEMORY_RERANK_TARGETED_MAX_TOTAL_CHARACTERS,
    partialPerCandidateDecisions: true,
    profileInventoryPostcondition: false,
    lifecycleTemporalModes: true,
    openRouterReasoning: "disabled_for_interactive_deadline",
    aggregationAware: true,
    aggregationCandidateSelection: "session_score_then_distinct_source_first",
    aggregationRoleAssignment: "separate_global_evidence_planner",
    serverAuthorityOnly: true,
    sorterNotGate: true,
    dedicatedRerankerAdapter: "openrouter-rerank-v1",
    dedicatedWireEnvelopeReserveBytes: MEMORY_DEDICATED_RERANK_WIRE_RESERVE_BYTES,
    generativeCompatibilityPath: "structured-output-v19",
    version: 20
  }),
  schemaVersion: "memory-relevance-result-v6"
});

const aggregationVersions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_AGGREGATION_PIPELINE_VERSION,
  policyVersion: "memory-evidence-aggregation-policy-v2",
  promptVersion: "memory-evidence-aggregation-prompt-v2",
  retrievalConfigFingerprint: memoryExecutionSha256({
    completeEvidenceView: true,
    exactOccurrenceGrounding: true,
    exactQuantityEvidenceGrounding: true,
    maxAttempts: MEMORY_AGGREGATION_MAX_ATTEMPTS,
    maxEvidenceItems: MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS,
    maxOutputTokens: 4_096,
    operationSet: MEMORY_AGGREGATION_OPERATIONS,
    resolutionSet: MEMORY_AGGREGATION_RESOLUTIONS,
    roleSet: MEMORY_AGGREGATION_ROLES,
    serverComputedMemberCount: "sum_grounded_quantities",
    version: 2
  }),
  schemaVersion: "memory-evidence-aggregation-result-v2"
});

export type MemoryRunUtilityUnavailable = Readonly<{
  bindingId?: string;
  reason: string;
  status: "UNAVAILABLE";
}>;

export type MemoryRunQueryEmbeddingResult =
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      profile: MemoryVectorProfile;
      status: "READY";
      vector: readonly number[];
    }>;

export type MemoryRunRerankResult =
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      decisions: readonly MemoryRunRerankDecision[];
      status: "READY";
    }>;

export type MemoryRunAggregationResult =
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      plan: MemoryAggregationPlan;
      status: "READY";
    }>;

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
  aggregate(input: UtilityBaseInput & Readonly<{
    evidence: readonly Readonly<{
      handle: string;
      occurredFrom: string | null;
      occurredTo: string | null;
      sourceKind: "EVENT" | "FACT" | "HISTORY";
      text: string;
    }>[];
    query: string;
  }>): Promise<MemoryRunAggregationResult>;
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
      speakerScope: "assistant" | "memory_record" | "mixed_conversation" | "user";
      sourceKind: "EVENT" | "FACT" | "HISTORY";
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

type MemoryRunUtilityDependencies = Readonly<{
  embeddingRuntime: AcceptedEmbeddingRuntime;
  execution: PrismaMemoryExecutionService;
  provider: MemoryRunUtilityProvider;
  rerankerRuntime?: AcceptedRerankerRuntime;
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
  candidates: MemoryRerankUtilityProviderInput["candidates"]
): MemoryRerankUtilityProviderInput {
  return {
    aggregationRequested: input.aggregationRequested === true,
    candidates,
    profileRequested: input.profileRequested,
    query: input.query,
    retrievalMode: input.retrievalMode,
    role: "MEMORY_RERANK",
    temporalIntent: input.temporalIntent
  };
}

function aggregationProviderInput(
  input: Parameters<MemoryRunUtilityService["aggregate"]>[0]
): MemoryAggregationUtilityProviderInput {
  return {
    evidence: input.evidence,
    kind: "AGGREGATE",
    query: input.query,
    role: "MEMORY_AGGREGATE"
  };
}

function partitionRerankCandidates(
  input: Parameters<MemoryRunUtilityService["rerank"]>[0]
): readonly MemoryRerankUtilityProviderInput["candidates"][] | null {
  const batches: MemoryRerankUtilityProviderInput["candidates"][] = [];
  let current: MemoryRerankUtilityProviderInput["candidates"] = [];
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

export function memoryDedicatedRerankDocument(candidate: RerankCandidate): string {
  const safe = sanitizeMemoryUtilityText(candidate.text);
  if (!safe.eligible || !safe.safeText) {
    throw new Error("memory_reranker_document_secret_only");
  }
  const occurredFrom = candidate.occurredFrom ?? "unknown";
  const occurredTo = candidate.occurredTo ?? "open";
  return [
    `[date_from=${occurredFrom} date_to=${occurredTo}]`,
    `[source=${candidate.sourceKind.toLocaleLowerCase("und")} ` +
      `speaker=${candidate.speakerScope} state=${candidate.current ? "current" : "historical"} ` +
      `lifecycle=${candidate.lifecycleState?.toLocaleLowerCase("und") ?? "not_applicable"}]`,
    safe.safeText
  ].join("\n");
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
    snapshot.compatibilityRequirement.configFingerprint ===
      profile.configurationFingerprint &&
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
    !Array.isArray(call.arguments.decisions)
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
      !reasonCodes.has(value.reason_code)) continue;
    seen.add(value.handle);
    decisions.push({
      applicable: value.applicable,
      current: value.current,
      handle: value.handle,
      reasonCode: value.reason_code as MemoryRunRerankDecision["reasonCode"],
      relevanceScore: value.relevance_score
    });
  }
  return decisions.length > 0 ? decisions : null;
}

function decodeAggregation(
  calls: Awaited<ReturnType<MemoryRunUtilityProvider["run"]>>["toolCalls"],
  evidence: MemoryAggregationUtilityProviderInput["evidence"]
): MemoryAggregationPlan | null {
  const call = calls?.[0];
  if (
    calls?.length !== 1 ||
    call?.name !== MEMORY_AGGREGATION_TOOL_NAME ||
    !isRecord(call.arguments) ||
    !exactKeys(call.arguments, ["groups", "operation", "resolution"]) ||
    !Array.isArray(call.arguments.groups) ||
    call.arguments.groups.length > 30 ||
    typeof call.arguments.operation !== "string" ||
    !MEMORY_AGGREGATION_OPERATIONS.some((value) =>
      value === call.arguments.operation) ||
    typeof call.arguments.resolution !== "string" ||
    !MEMORY_AGGREGATION_RESOLUTIONS.some((value) =>
      value === call.arguments.resolution)
  ) return null;
  if (call.arguments.resolution === "NOT_APPLICABLE" &&
    call.arguments.groups.length !== 0) return null;
  if (call.arguments.resolution === "RESOLVED" &&
    call.arguments.groups.length === 0) return null;

  const byHandle = new Map(evidence.map((item) => [item.handle, item]));
  const seenGroups = new Set<string>();
  const groups: MemoryAggregationPlan["groups"][number][] = [];
  for (const value of call.arguments.groups) {
    if (
      !isRecord(value) ||
      !exactKeys(value, [
        "item_handles",
        "occurrence",
        "quantity",
        "quantity_evidence",
        "role"
      ]) ||
      !Array.isArray(value.item_handles) ||
      value.item_handles.length < 1 ||
      value.item_handles.length > 8 ||
      value.item_handles.some((handle) => typeof handle !== "string") ||
      new Set(value.item_handles).size !== value.item_handles.length ||
      typeof value.occurrence !== "string" ||
      value.occurrence.length < 1 ||
      value.occurrence.length > 256 ||
      value.occurrence !== value.occurrence.trim() ||
      value.occurrence.includes("\u0000") ||
      /[\r\n]/u.test(value.occurrence) ||
      typeof value.quantity !== "number" ||
      !Number.isSafeInteger(value.quantity) ||
      value.quantity < 0 ||
      value.quantity > MEMORY_AGGREGATION_MAX_MEMBER_QUANTITY ||
      value.quantity_evidence !== null && (
        typeof value.quantity_evidence !== "string" ||
        value.quantity_evidence.length < 1 ||
        value.quantity_evidence.length > 256 ||
        value.quantity_evidence !== value.quantity_evidence.trim() ||
        value.quantity_evidence.includes("\u0000") ||
        /[\r\n]/u.test(value.quantity_evidence)
      ) ||
      typeof value.role !== "string" ||
      !MEMORY_AGGREGATION_ROLES.some((role) => role === value.role)
    ) return null;
    const occurrence = value.occurrence;
    const items = value.item_handles.map((handle) => byHandle.get(handle));
    const member = value.role === "MEMBER" || value.role === "MEMBER_AND_BOUNDARY";
    const quantityEvidence = value.quantity_evidence;
    if (
      items.some((item) => !item) ||
      member !== (value.quantity > 0) ||
      member !== (quantityEvidence !== null) ||
      call.arguments.operation !== "COUNT" && member && value.quantity !== 1 ||
      !items.some((item) => item!.text.includes(occurrence) && (
        quantityEvidence === null || item!.text.includes(quantityEvidence)
      ))
    ) return null;
    if (value.quantity > 1 && quantityEvidence !== null) {
      const explicitIntegers = [...quantityEvidence.matchAll(/\d+/gu)]
        .map((match) => Number(match[0]))
        .filter(Number.isSafeInteger);
      if (explicitIntegers.length > 0 && !explicitIntegers.includes(value.quantity)) {
        return null;
      }
    }
    const itemHandles = [...value.item_handles].sort((left, right) =>
      left.localeCompare(right));
    const groupKey = `${value.role}:${occurrence.normalize("NFKC")
      .toLocaleLowerCase("und")}:${itemHandles.join(",")}`;
    if (seenGroups.has(groupKey)) return null;
    seenGroups.add(groupKey);
    groups.push({
      itemHandles,
      occurrence,
      quantity: value.quantity,
      quantityEvidence,
      role: value.role as MemoryAggregationPlan["groups"][number]["role"]
    });
  }
  const totalQuantity = groups.reduce((total, group) => total + group.quantity, 0);
  if (!Number.isSafeInteger(totalQuantity)) return null;
  if (call.arguments.operation === "COUNT" &&
    call.arguments.resolution === "RESOLVED" && totalQuantity < 1) return null;
  return {
    groups,
    operation: call.arguments.operation as MemoryAggregationPlan["operation"],
    resolution: call.arguments.resolution as MemoryAggregationPlan["resolution"]
  };
}

async function bindAndStart(
  deps: MemoryRunUtilityDependencies,
  input: UtilityBaseInput,
  role: MemoryExecutionRole,
  ordinal: number,
  versions: MemoryExecutionVersions,
  inputHash: string
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
  role: "MEMORY_AGGREGATE" | "MEMORY_RERANK",
  ordinal: number,
  versions: MemoryExecutionVersions,
  inputHash: string,
  expectedSnapshotHash: string | null,
  decode: (
    calls: Awaited<ReturnType<MemoryRunUtilityProvider["run"]>>["toolCalls"]
  ) => T | null
): Promise<
  | Readonly<MemoryRunUtilityUnavailable & { snapshotHash?: string }>
  | Readonly<{
      bindingId: string;
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
    return unavailable(uncertain
      ? "memory_run_utility_outcome_unknown"
      : "memory_run_utility_provider_failed", started.bindingId);
  }
  const output = decode(result.toolCalls);
  if (!output) {
    try {
      await deps.execution.lifecycle.settle(input.userId, started.bindingId, {
        acceptedOutputHash: null,
        errorCode: "memory_run_utility_output_invalid",
        providerResponseId: result.providerResponseId,
        state: "FAILED",
        usage: providerUsage(result.usage)
      });
    } catch {
      return {
        ...unavailable("memory_run_utility_settle_failed", started.bindingId),
        snapshotHash
      };
    }
    return {
      ...unavailable("memory_run_utility_output_invalid", started.bindingId),
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
    snapshotHash
  };
  return { bindingId: started.bindingId, output, snapshotHash, status: "READY" };
}

async function runDedicatedRerankBatch(
  deps: MemoryRunUtilityDependencies,
  input: RerankInput,
  candidates: readonly RerankCandidate[],
  ordinal: number,
  inputHash: string
): Promise<
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      output: readonly MemoryRunRerankDecision[];
      status: "READY";
    }>
> {
  const started = await bindAndStart(
    deps,
    input,
    "MEMORY_RERANK",
    ordinal,
    rerankVersions,
    inputHash
  );
  if (started.status !== "STARTED") return started;
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
    return unavailable("memory_reranker_binding_invalid", started.bindingId);
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
    return unavailable("memory_reranker_runtime_unavailable", started.bindingId);
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
    return unavailable("memory_reranker_runtime_unavailable", started.bindingId);
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
    const uncertain = input.signal.aborted || !(error instanceof RerankAdapterError) ||
      uncertainRerankErrors.has(error.code);
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: error instanceof RerankAdapterError
        ? error.code
        : "memory_reranker_outcome_unknown",
      providerResponseId: null,
      state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
      usage: unavailableUsage
    });
    return unavailable(uncertain
      ? "memory_reranker_outcome_unknown"
      : "memory_reranker_failed", started.bindingId);
  }
  const output = result.scores.map((score): MemoryRunRerankDecision => ({
    applicable: null,
    current: null,
    handle: score.handle,
    reasonCode: "SCORE_ONLY",
    relevanceScore: score.relevanceScore
  }));
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
    return unavailable("memory_run_utility_settle_failed", started.bindingId);
  }
  if (!await authorizeAcceptedOutput(
    deps,
    input.userId,
    started.bindingId,
    outputHash
  )) return unavailable("memory_execution_policy_drift", started.bindingId);
  return { bindingId: started.bindingId, output, status: "READY" };
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
    async aggregate(input) {
      const safeQuery = sanitizeMemoryUtilityText(input.query);
      const safeEvidence = input.evidence.map((item) => {
        const safe = sanitizeMemoryUtilityText(item.text);
        return safe.eligible && safe.safeText ? { ...item, text: safe.safeText } : null;
      });
      if (!safeQuery.eligible || !safeQuery.safeText || safeEvidence.some((item) => !item)) {
        return unavailable("memory_utility_input_blocked");
      }
      const safeInput = {
        ...input,
        evidence: safeEvidence as typeof input.evidence,
        query: safeQuery.safeText
      };
      const handles = safeInput.evidence.map((item) => item.handle);
      const request = aggregationProviderInput(safeInput);
      if (
        !validSafeQuery(safeInput.query) ||
        safeInput.evidence.length < 1 ||
        safeInput.evidence.length > MEMORY_AGGREGATION_MAX_EVIDENCE_ITEMS ||
        new Set(handles).size !== handles.length ||
        safeInput.evidence.some((item, index) =>
          item.handle !== `i${index}` ||
          item.text.length < 1 ||
          item.text.length > 4_000 ||
          item.text.includes("\u0000") ||
          !["EVENT", "FACT", "HISTORY"].includes(item.sourceKind) ||
          [item.occurredFrom, item.occurredTo].some((value) =>
            value !== null && (
              value.length < 1 || value.length > 64 ||
              !Number.isFinite(Date.parse(value))
            ))
        ) ||
        memoryRunUtilityPromptCharacters(request) >
          MEMORY_RERANK_MAX_PROMPT_CHARACTERS
      ) return unavailable("memory_utility_input_blocked");

      const inputHash = memoryExecutionSha256({
        domain: "aiqsa.memory.evidence-aggregation-input",
        evidence: safeInput.evidence.map((item) => ({
          handle: item.handle,
          occurredFrom: item.occurredFrom,
          occurredTo: item.occurredTo,
          sourceKind: item.sourceKind,
          textHash: memorySha256(item.text)
        })),
        queryHash: memorySha256(safeInput.query),
        version: 2
      });
      let result = await runTextUtility(
        deps,
        safeInput,
        request,
        "MEMORY_AGGREGATE",
        MEMORY_AGGREGATION_PRIMARY_ORDINAL,
        aggregationVersions,
        inputHash,
        null,
        (calls) => decodeAggregation(calls, safeInput.evidence)
      );
      if (
        result.status !== "READY" &&
        result.reason === "memory_run_utility_output_invalid" &&
        result.snapshotHash !== undefined &&
        !safeInput.signal.aborted
      ) {
        result = await runTextUtility(
          deps,
          safeInput,
          request,
          "MEMORY_AGGREGATE",
          MEMORY_AGGREGATION_PRIMARY_ORDINAL + 1,
          aggregationVersions,
          inputHash,
          result.snapshotHash,
          (calls) => decodeAggregation(calls, safeInput.evidence)
        );
      }
      return result.status === "READY"
        ? {
            bindingId: result.bindingId,
            plan: result.output,
            status: "READY"
          }
        : unavailable(result.reason, result.bindingId);
    },

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
        ...(purpose === "ACTION_TARGET" ? { purpose } : {}),
        queryHash: memorySha256(safeQuery.safeText),
        renderedQueryHash: memorySha256(renderedQuery),
        version: purpose === "ACTION_TARGET" ? 4 : 3
      });
      const started = await bindAndStart(
        deps,
        input,
        "MEMORY_QUERY_EMBED",
        ordinal,
        MEMORY_QUERY_EMBEDDING_VERSIONS,
        inputHash
      );
      if (started.status !== "STARTED") return started;
      if (!embeddingSnapshotMatchesProfile(started.snapshot, input.profile)) {
        await settleQuietly(deps, input.userId, started.bindingId, {
          acceptedOutputHash: null,
          errorCode: "memory_query_embedding_profile_changed",
          providerResponseId: null,
          state: "FAILED",
          usage: unavailableUsage
        });
        return unavailable("memory_query_embedding_profile_changed", started.bindingId);
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
        return unavailable(unavailableReason(error), started.bindingId);
      }
      let result: EmbeddingResult;
      try {
        result = await runtime.adapter.embed({
          // The Memory instruction is part of the versioned Memory profile.
          // Use document mode so a mutable provider-level query template
          // cannot prepend a second, domain-inappropriate instruction.
          mode: "document",
          signal: input.signal,
          texts: [renderedQuery]
        });
      } catch (error) {
        const uncertain = !(error instanceof EmbeddingAdapterError) ||
          uncertainEmbeddingErrors.has(error.code) || input.signal.aborted;
        await settleQuietly(deps, input.userId, started.bindingId, {
          acceptedOutputHash: null,
          errorCode: error instanceof EmbeddingAdapterError
            ? error.code
            : "memory_query_embedding_outcome_unknown",
          providerResponseId: null,
          state: uncertain ? "OUTCOME_UNKNOWN" : "FAILED",
          usage: unavailableUsage
        });
        return unavailable(uncertain
          ? "memory_query_embedding_outcome_unknown"
          : "memory_query_embedding_failed", started.bindingId);
      }
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
        return unavailable("memory_query_embedding_output_invalid", started.bindingId);
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
      )) return unavailable("memory_execution_policy_drift", started.bindingId);
      return {
        bindingId: started.bindingId,
        profile: input.profile,
        status: "READY",
        vector
      };
    },

    async rerank(input) {
      const safeQuery = sanitizeMemoryUtilityText(input.query);
      const safeCandidates = input.candidates.map((candidate) => {
        const safe = sanitizeMemoryUtilityText(candidate.text);
        return safe.eligible && safe.safeText ? { ...candidate, text: safe.safeText } : null;
      });
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
          !["EVENT", "FACT", "HISTORY"].includes(candidate.sourceKind) ||
          !["assistant", "memory_record", "mixed_conversation", "user"]
            .includes(candidate.speakerScope) ||
          !["any", "as_of", "between", "current", "historical"]
            .includes(candidate.temporalReason) ||
          [candidate.occurredFrom, candidate.occurredTo].some((value) =>
            value !== null && (value.length < 1 || value.length > 64 ||
              !Number.isFinite(Date.parse(value))))
        ) || safeInput.profileRequested && safeInput.candidates.some((candidate) =>
          !candidate.current || candidate.sourceKind === "HISTORY")
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
      const results = await mapWithConcurrency(
        candidateBatches,
        MEMORY_RERANK_AGGREGATION_MAX_PARALLEL_BATCHES,
        async (candidates, batchIndex) => {
          const batchHandles = candidates.map((candidate) => candidate.handle);
          const inputHash = memoryExecutionSha256({
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
              textHash: memorySha256(candidate.text)
            })),
            domain: "aiqsa.memory.relevance-input",
            profileRequested: safeInput.profileRequested,
            queryHash: memorySha256(safeInput.query),
            rerankPath,
            retrievalMode: safeInput.retrievalMode,
            temporalIntent: safeInput.temporalIntent,
            version: 12
          });
          const firstOrdinal = rerankBatchFirstOrdinal(batchIndex);
          if (rerankPath === "DEDICATED") {
            return runDedicatedRerankBatch(
              deps,
              safeInput,
              candidates,
              firstOrdinal,
              inputHash
            );
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
            (calls) => decodeRerank(calls, batchHandles)
          );
          // A structurally invalid settled response is safe to retry once: the
          // reranker has no side effects, and each attempt receives its own
          // durable execution binding/usage record. Provider uncertainty,
          // transport failure, cancellation, or policy drift is never replayed.
          if (
            result.status !== "READY" &&
            result.reason === "memory_run_utility_output_invalid" &&
            result.snapshotHash !== undefined &&
            !safeInput.signal.aborted
          ) {
            result = await runTextUtility(
              deps,
              safeInput,
              rerankProviderInput(safeInput, candidates),
              "MEMORY_RERANK",
              firstOrdinal + 1,
              rerankVersions,
              inputHash,
              result.snapshotHash,
              (calls) => decodeRerank(calls, batchHandles)
            );
          }
          return result;
        }
      );
      const ready = results.filter((result) => result.status === "READY");
      const bindingId = ready[0]?.bindingId;
      if (bindingId && ready.length > 0) {
        return {
          bindingId,
          decisions: ready.flatMap((result) => result.output),
          status: "READY"
        };
      }
      const failed = results.find((result) => result.status === "UNAVAILABLE");
      return failed?.status === "UNAVAILABLE"
        ? unavailable(failed.reason, failed.bindingId)
        : unavailable("memory_run_utility_unavailable");
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
    resolveRerankPath?: (userId: string) => Promise<MemoryRerankPath>;
  }> = {}
): MemoryRunUtilityService {
  return createMemoryRunUtilityService({
    embeddingRuntime: options.embeddingRuntime ?? createAcceptedEmbeddingRuntime(client),
    execution: options.execution ?? createPrismaMemoryExecutionService(authority, client),
    provider: options.provider ?? createAcceptedMemoryRunUtilityProvider(client),
    rerankerRuntime: options.rerankerRuntime ?? createAcceptedRerankerRuntime(client),
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
