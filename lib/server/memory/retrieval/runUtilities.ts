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
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import { memorySha256 } from "../persistence/lexical";
import { MEMORY_RETRIEVAL_RERANK_SCORE_FLOOR } from
  "../../../domain/memory/retrieval/config";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  type MemoryVectorProfile
} from "./vector";
import {
  createAcceptedMemoryRunUtilityProvider,
  memoryRunUtilityProviderEvidence,
  MemoryRunUtilityProviderCallError,
  MEMORY_RERANK_TOOL_NAME,
  type MemoryRunUtilityProvider
} from "./runUtilityRuntime";

export const MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION =
  "memory-query-embedding-v1";
export const MEMORY_REMOTE_RERANK_PIPELINE_VERSION =
  "memory-multilingual-relevance-v9";
export const MEMORY_RERANK_MAX_ATTEMPTS = 2;

export const MEMORY_QUERY_EMBEDDING_VERSIONS: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION,
  policyVersion: "memory-query-embedding-policy-v1",
  promptVersion: "memory-query-embedding-prompt-v1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  schemaVersion: "memory-query-embedding-result-v1"
});

const rerankVersions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_REMOTE_RERANK_PIPELINE_VERSION,
  policyVersion: "memory-relevance-policy-v9",
  promptVersion: "memory-relevance-prompt-v9",
  retrievalConfigFingerprint: memoryExecutionSha256({
    candidateMaxCharacters: 4_000,
    maxCandidates: 30,
    maxAttempts: MEMORY_RERANK_MAX_ATTEMPTS,
    maxOutputTokens: 4_096,
    maxTotalCharacters: 32_000,
    completePerCandidateDecisions: true,
    profileInventoryPostcondition: true,
    lifecycleTemporalModes: true,
    version: 9
  }),
  schemaVersion: "memory-relevance-result-v5"
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

export type MemoryRunRerankDecision = Readonly<{
  applicable: boolean;
  current: boolean;
  handle: string;
  reasonCode:
    | "DIRECT_RELEVANCE"
    | "SUPPORTING_CONTEXT"
    | "RESPONSE_PREFERENCE"
    | "OUTDATED"
    | "NOT_RELEVANT";
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
  embedQuery(input: QueryEmbeddingBaseInput & Readonly<{
    profile: MemoryVectorProfile;
    purpose?: "ACTION_TARGET" | "RETRIEVAL";
    query: string;
  }>): Promise<MemoryRunQueryEmbeddingResult>;
  rerank(input: UtilityBaseInput & Readonly<{
    candidates: readonly Readonly<{
      authorityLevel: "LEARNED" | "PAST_CHAT" | "SAVED";
      current: boolean;
      directness: "DIRECT" | "INFERRED" | "PARAPHRASED" | null;
      handle: string;
      historical: boolean;
      lifecycleState: "ACTIVE" | "SUPERSEDED" | null;
      occurredFrom: string | null;
      occurredTo: string | null;
      sensitivityClass: "NORMAL";
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

type MemoryRunUtilityDependencies = Readonly<{
  embeddingRuntime: AcceptedEmbeddingRuntime;
  execution: PrismaMemoryExecutionService;
  provider: MemoryRunUtilityProvider;
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

function unavailable(reason: string, bindingId?: string): MemoryRunUtilityUnavailable {
  return { ...(bindingId ? { bindingId } : {}), reason, status: "UNAVAILABLE" };
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
  expectedHandles: readonly string[],
  profileRequested: boolean
): readonly MemoryRunRerankDecision[] | null {
  const call = calls?.[0];
  if (
    calls?.length !== 1 ||
    call?.name !== MEMORY_RERANK_TOOL_NAME ||
    !isRecord(call.arguments) ||
    !exactKeys(call.arguments, ["decisions"]) ||
    !Array.isArray(call.arguments.decisions)
  ) return null;
  if (call.arguments.decisions.length !== expectedHandles.length) return null;
  const reasonCodes = new Set([
    "DIRECT_RELEVANCE", "SUPPORTING_CONTEXT", "RESPONSE_PREFERENCE",
    "OUTDATED", "NOT_RELEVANT"
  ]);
  const decisions: MemoryRunRerankDecision[] = [];
  for (let index = 0; index < call.arguments.decisions.length; index += 1) {
    const value = call.arguments.decisions[index];
    if (!isRecord(value) || !exactKeys(value, [
      "applicable", "current", "handle", "reason_code", "relevance_score"
    ]) || value.handle !== expectedHandles[index] ||
      typeof value.applicable !== "boolean" || typeof value.current !== "boolean" ||
      typeof value.relevance_score !== "number" ||
      !Number.isFinite(value.relevance_score) || value.relevance_score < 0 ||
      value.relevance_score > 1 || typeof value.reason_code !== "string" ||
      !reasonCodes.has(value.reason_code)) return null;
    const positive = value.reason_code === "DIRECT_RELEVANCE" ||
      value.reason_code === "SUPPORTING_CONTEXT" ||
      value.reason_code === "RESPONSE_PREFERENCE";
    if (
      (positive && (!value.applicable || !value.current)) ||
      (value.reason_code === "OUTDATED" && (value.applicable || value.current)) ||
      (value.reason_code === "NOT_RELEVANT" && value.applicable)
    ) return null;
    decisions.push({
      applicable: value.applicable,
      current: value.current,
      handle: value.handle,
      reasonCode: value.reason_code as MemoryRunRerankDecision["reasonCode"],
      relevanceScore: value.relevance_score
    });
  }
  if (profileRequested && decisions.some((decision) =>
    !decision.applicable || !decision.current ||
    decision.reasonCode !== "DIRECT_RELEVANCE" ||
    decision.relevanceScore <= MEMORY_RETRIEVAL_RERANK_SCORE_FLOOR)) return null;
  return decisions;
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
  role: "MEMORY_RERANK",
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

function validSafeQuery(query: string): boolean {
  return query.length > 0 && query.length <= 2_000 && !query.includes("\u0000") &&
    !memoryExplicitStatementContainsSecret(query);
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
      if (!validSafeQuery(input.query)) return unavailable("memory_utility_input_blocked");
      const purpose = input.purpose ?? "RETRIEVAL";
      const ordinal = queryEmbeddingOrdinal(input, purpose);
      if (ordinal === null) return unavailable("memory_utility_input_blocked");
      const inputHash = memoryExecutionSha256({
        domain: "aiqsa.memory.query-embedding-input",
        profile: input.profile,
        ...(purpose === "ACTION_TARGET" ? { purpose } : {}),
        queryHash: memorySha256(input.query),
        version: purpose === "ACTION_TARGET" ? 2 : 1
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
          mode: "query",
          signal: input.signal,
          texts: [input.query]
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
      const totalCharacters = input.candidates.reduce(
        (total, candidate) => total + candidate.text.length,
        0
      );
      const handles = input.candidates.map((candidate) => candidate.handle);
      if (
        !validSafeQuery(input.query) ||
        typeof input.profileRequested !== "boolean" ||
        !["CURRENT_PROFILE", "TARGETED_CURRENT", "HISTORICAL_MEMORY",
          "PAST_CHAT_SEARCH", "HISTORY_OVERVIEW"].includes(input.retrievalMode) ||
        !["CURRENT", "HISTORICAL", "AS_OF", "BETWEEN", "ANY"]
          .includes(input.temporalIntent) ||
        input.candidates.length < 1 ||
        input.candidates.length > 30 ||
        totalCharacters > 32_000 ||
        new Set(handles).size !== handles.length ||
        input.candidates.some((candidate, index) =>
          candidate.handle !== `c${index}` ||
          candidate.text.length < 1 ||
          candidate.text.length > 4_000 ||
          candidate.text.includes("\u0000") ||
          memoryExplicitStatementContainsSecret(candidate.text) ||
          candidate.current === candidate.historical
        ) || input.profileRequested && input.candidates.some((candidate) =>
          !candidate.current || candidate.sourceKind === "HISTORY")
      ) return unavailable("memory_utility_input_blocked");
      const inputHash = memoryExecutionSha256({
        candidates: input.candidates.map((candidate) => ({
          authorityLevel: candidate.authorityLevel,
          current: candidate.current,
          directness: candidate.directness,
          handle: candidate.handle,
          historical: candidate.historical,
          lifecycleState: candidate.lifecycleState,
          occurredFrom: candidate.occurredFrom,
          occurredTo: candidate.occurredTo,
          sensitivityClass: candidate.sensitivityClass,
          sourceKind: candidate.sourceKind,
          temporalReason: candidate.temporalReason,
          textHash: memorySha256(candidate.text)
        })),
        domain: "aiqsa.memory.relevance-input",
        profileRequested: input.profileRequested,
        queryHash: memorySha256(input.query),
        retrievalMode: input.retrievalMode,
        temporalIntent: input.temporalIntent,
        version: 6
      });
      let result = await runTextUtility(
        deps,
        input,
        {
          candidates: input.candidates,
          profileRequested: input.profileRequested,
          query: input.query,
          retrievalMode: input.retrievalMode,
          role: "MEMORY_RERANK",
          temporalIntent: input.temporalIntent
        },
        "MEMORY_RERANK",
        2,
        rerankVersions,
        inputHash,
        null,
        (calls) => decodeRerank(calls, handles, input.profileRequested)
      );
      // A structurally invalid settled response is safe to retry once: the
      // reranker has no side effects, and each attempt receives its own
      // durable execution binding/usage record.  Provider uncertainty,
      // transport failure, cancellation, or policy drift is never replayed.
      if (
        result.status !== "READY" &&
        result.reason === "memory_run_utility_output_invalid" &&
        result.snapshotHash !== undefined &&
        !input.signal.aborted
      ) {
        result = await runTextUtility(
          deps,
          input,
          {
            candidates: input.candidates,
            profileRequested: input.profileRequested,
            query: input.query,
            retrievalMode: input.retrievalMode,
            role: "MEMORY_RERANK",
            temporalIntent: input.temporalIntent
          },
          "MEMORY_RERANK",
          3,
          rerankVersions,
          inputHash,
          result.snapshotHash,
          (calls) => decodeRerank(calls, handles, input.profileRequested)
        );
      }
      return result.status === "READY"
        ? {
            bindingId: result.bindingId,
            decisions: result.output,
            status: "READY"
          }
        : unavailable(result.reason, result.bindingId);
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
  }> = {}
): MemoryRunUtilityService {
  return createMemoryRunUtilityService({
    embeddingRuntime: options.embeddingRuntime ?? createAcceptedEmbeddingRuntime(client),
    execution: options.execution ?? createPrismaMemoryExecutionService(authority, client),
    provider: options.provider ?? createAcceptedMemoryRunUtilityProvider(client)
  });
}
