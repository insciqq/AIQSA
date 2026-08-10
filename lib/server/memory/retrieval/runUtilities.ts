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
import { memoryExplicitStatementContainsSecret } from "../explicit/safety";
import { memorySha256 } from "../persistence/lexical";
import {
  MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  type MemoryVectorProfile
} from "./vector";
import {
  createAcceptedMemoryRunUtilityProvider,
  memoryRunUtilityProviderEvidence,
  MemoryRunUtilityProviderCallError,
  MEMORY_QUERY_EXPANSION_TOOL_NAME,
  MEMORY_RERANK_TOOL_NAME,
  type MemoryRunUtilityProvider
} from "./runUtilityRuntime";

export const MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION =
  "memory-query-embedding-v1";
export const MEMORY_QUERY_EXPANSION_PIPELINE_VERSION =
  "memory-query-expansion-v1";
export const MEMORY_REMOTE_RERANK_PIPELINE_VERSION =
  "memory-remote-rerank-v1";

const queryEmbeddingVersions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_QUERY_EMBEDDING_PIPELINE_VERSION,
  policyVersion: "memory-query-embedding-policy-v1",
  promptVersion: "memory-query-embedding-prompt-v1",
  retrievalConfigFingerprint: MEMORY_VECTOR_RETRIEVAL_CONFIG_FINGERPRINT,
  schemaVersion: "memory-query-embedding-result-v1"
});

const queryExpansionVersions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_QUERY_EXPANSION_PIPELINE_VERSION,
  policyVersion: "memory-query-expansion-policy-v1",
  promptVersion: "memory-query-expansion-prompt-v1",
  retrievalConfigFingerprint: memoryExecutionSha256({
    maxTerms: 8,
    termMaxCharacters: 80,
    version: 1
  }),
  schemaVersion: "memory-query-expansion-result-v1"
});

const rerankVersions: MemoryExecutionVersions = Object.freeze({
  pipelineVersion: MEMORY_REMOTE_RERANK_PIPELINE_VERSION,
  policyVersion: "memory-remote-rerank-policy-v1",
  promptVersion: "memory-remote-rerank-prompt-v1",
  retrievalConfigFingerprint: memoryExecutionSha256({
    candidateMaxCharacters: 4_000,
    maxCandidates: 25,
    maxTotalCharacters: 32_000,
    permutationOnly: true,
    version: 1
  }),
  schemaVersion: "memory-remote-rerank-result-v1"
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

export type MemoryRunQueryExpansionResult =
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      status: "READY";
      terms: readonly string[];
    }>;

export type MemoryRunRerankResult =
  | MemoryRunUtilityUnavailable
  | Readonly<{
      bindingId: string;
      orderedHandles: readonly string[];
      status: "READY";
    }>;

type UtilityBaseInput = Readonly<{
  attemptId: string;
  signal: AbortSignal;
  userId: string;
}>;

export type MemoryRunUtilityService = Readonly<{
  embedQuery(input: UtilityBaseInput & Readonly<{
    profile: MemoryVectorProfile;
    query: string;
  }>): Promise<MemoryRunQueryEmbeddingResult>;
  expandQuery(input: UtilityBaseInput & Readonly<{
    intent: string;
    language: string;
    query: string;
  }>): Promise<MemoryRunQueryExpansionResult>;
  rerank(input: UtilityBaseInput & Readonly<{
    candidates: readonly Readonly<{ handle: string; text: string }>[];
    intent: string;
    language: string;
    query: string;
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
    snapshot.qualificationRequirement.configFingerprint ===
      profile.configurationFingerprint &&
    snapshot.qualificationRequirement.vectorSpaceFingerprint ===
      profile.vectorSpaceFingerprint &&
    snapshot.qualificationRequirement.retrievalConfigFingerprint ===
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

function decodeExpansion(
  calls: Awaited<ReturnType<MemoryRunUtilityProvider["run"]>>["toolCalls"]
): readonly string[] | null {
  const call = calls?.[0];
  if (
    calls?.length !== 1 ||
    call?.name !== MEMORY_QUERY_EXPANSION_TOOL_NAME ||
    !isRecord(call.arguments) ||
    !exactKeys(call.arguments, ["terms"]) ||
    !Array.isArray(call.arguments.terms) ||
    call.arguments.terms.length > 8
  ) return null;
  const terms = call.arguments.terms;
  if (terms.some((term) =>
    typeof term !== "string" || term.trim() !== term || !term || term.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(term)
  )) return null;
  const values = terms as string[];
  return new Set(values).size === values.length ? values : null;
}

function decodeRerank(
  calls: Awaited<ReturnType<MemoryRunUtilityProvider["run"]>>["toolCalls"],
  expectedHandles: readonly string[]
): readonly string[] | null {
  const call = calls?.[0];
  if (
    calls?.length !== 1 ||
    call?.name !== MEMORY_RERANK_TOOL_NAME ||
    !isRecord(call.arguments) ||
    !exactKeys(call.arguments, ["ordered_handles"]) ||
    !Array.isArray(call.arguments.ordered_handles)
  ) return null;
  const ordered = call.arguments.ordered_handles;
  if (
    ordered.length !== expectedHandles.length ||
    ordered.some((handle) => typeof handle !== "string")
  ) return null;
  const values = ordered as string[];
  const expected = new Set(expectedHandles);
  return new Set(values).size === values.length &&
    values.every((handle) => expected.has(handle))
    ? values
    : null;
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
      owner: { retrievalAttemptId: input.attemptId, type: "RETRIEVAL_ATTEMPT" },
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

async function runTextUtility(
  deps: MemoryRunUtilityDependencies,
  input: UtilityBaseInput,
  request: Parameters<MemoryRunUtilityProvider["run"]>[1],
  role: "MEMORY_QUERY_EXPAND" | "MEMORY_RERANK",
  ordinal: number,
  versions: MemoryExecutionVersions,
  inputHash: string,
  decode: (
    calls: Awaited<ReturnType<MemoryRunUtilityProvider["run"]>>["toolCalls"]
  ) => readonly string[] | null
): Promise<
  | MemoryRunUtilityUnavailable
  | Readonly<{ bindingId: string; output: readonly string[]; status: "READY" }>
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
  if (started.snapshot.logicalRole !== role) {
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_run_utility_binding_invalid",
      providerResponseId: null,
      state: "FAILED",
      usage: unavailableUsage
    });
    return unavailable("memory_run_utility_binding_invalid", started.bindingId);
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
    await settleQuietly(deps, input.userId, started.bindingId, {
      acceptedOutputHash: null,
      errorCode: "memory_run_utility_output_invalid",
      providerResponseId: result.providerResponseId,
      state: "FAILED",
      usage: providerUsage(result.usage)
    });
    return unavailable("memory_run_utility_output_invalid", started.bindingId);
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
  )) return unavailable("memory_execution_policy_drift", started.bindingId);
  return { bindingId: started.bindingId, output, status: "READY" };
}

function validSafeQuery(query: string): boolean {
  return query.length > 0 && query.length <= 2_000 && !query.includes("\u0000") &&
    !memoryExplicitStatementContainsSecret(query);
}

export function createMemoryRunUtilityService(
  deps: MemoryRunUtilityDependencies
): MemoryRunUtilityService {
  return Object.freeze({
    async embedQuery(input) {
      if (!validSafeQuery(input.query)) return unavailable("memory_utility_input_blocked");
      const inputHash = memoryExecutionSha256({
        domain: "aiqsa.memory.query-embedding-input",
        profile: input.profile,
        queryHash: memorySha256(input.query),
        version: 1
      });
      const started = await bindAndStart(
        deps,
        input,
        "MEMORY_QUERY_EMBED",
        1,
        queryEmbeddingVersions,
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

    async expandQuery(input) {
      if (!validSafeQuery(input.query)) return unavailable("memory_utility_input_blocked");
      const inputHash = memoryExecutionSha256({
        domain: "aiqsa.memory.query-expansion-input",
        intent: input.intent,
        language: input.language,
        queryHash: memorySha256(input.query),
        version: 1
      });
      const result = await runTextUtility(
        deps,
        input,
        {
          intent: input.intent,
          language: input.language,
          query: input.query,
          role: "MEMORY_QUERY_EXPAND"
        },
        "MEMORY_QUERY_EXPAND",
        0,
        queryExpansionVersions,
        inputHash,
        decodeExpansion
      );
      return result.status === "READY"
        ? { bindingId: result.bindingId, status: "READY", terms: result.output }
        : result;
    },

    async rerank(input) {
      const totalCharacters = input.candidates.reduce(
        (total, candidate) => total + candidate.text.length,
        0
      );
      const handles = input.candidates.map((candidate) => candidate.handle);
      if (
        !validSafeQuery(input.query) ||
        input.candidates.length < 1 ||
        input.candidates.length > 25 ||
        totalCharacters > 32_000 ||
        new Set(handles).size !== handles.length ||
        input.candidates.some((candidate, index) =>
          candidate.handle !== `c${index}` ||
          candidate.text.length < 1 ||
          candidate.text.length > 4_000 ||
          candidate.text.includes("\u0000") ||
          memoryExplicitStatementContainsSecret(candidate.text)
        )
      ) return unavailable("memory_utility_input_blocked");
      const inputHash = memoryExecutionSha256({
        candidates: input.candidates.map((candidate) => ({
          handle: candidate.handle,
          textHash: memorySha256(candidate.text)
        })),
        domain: "aiqsa.memory.rerank-input",
        intent: input.intent,
        language: input.language,
        queryHash: memorySha256(input.query),
        version: 1
      });
      const result = await runTextUtility(
        deps,
        input,
        {
          candidates: input.candidates,
          intent: input.intent,
          language: input.language,
          query: input.query,
          role: "MEMORY_RERANK"
        },
        "MEMORY_RERANK",
        2,
        rerankVersions,
        inputHash,
        (calls) => decodeRerank(calls, handles)
      );
      return result.status === "READY"
        ? {
            bindingId: result.bindingId,
            orderedHandles: result.output,
            status: "READY"
          }
        : result;
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
