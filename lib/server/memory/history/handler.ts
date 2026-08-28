import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import { MemoryCoordinatorError } from "../coordinator/errors";
import type {
  MemoryJobExecutionResult,
  MemoryJobHandler
} from "../coordinator/types";
import { memorySha256 } from "../persistence/lexical";
import {
  MEMORY_CONTEXTUAL_FALLBACK_COUNTER_KEYS,
  MEMORY_CONTEXTUAL_LANGUAGE_COUNTER_KEYS,
  type MemoryOperationalCounters
} from "../operational/counters";
import {
  authorizeMemoryExecutionResultsForCommit,
  type MemoryExecutionAuthorityDependencies,
  type MemoryStructuredOutputProvider
} from "../execution";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import {
  lockMemorySettings,
  type LockedMemorySettings
} from "../persistence/transaction";
import {
  type MemoryHistoryClassificationResult,
  type MemoryHistorySafetyClassifier
} from "./classifier";
import { MEMORY_SAFETY_LITE_POLICY_VERSION } from "../safetyLite";
import {
  memoryHistoryIndexClaimIsValid,
  memoryHistoryIndexResultHash,
  type MemoryHistoryIndexPlan
} from "./contract";
import {
  createPrismaMemoryChatDigestGenerator,
  MemoryChatDigestError,
  MemoryChatDigestOutputError,
  type MemoryChatDigestGenerationResult,
  type MemoryChatDigestGenerator
} from "./digest";
import {
  createPrismaMemoryContextualKeyGenerator,
  type MemoryContextualKeyGenerationResult,
  type MemoryContextualKeyGenerator
} from "./contextualKeys";
import {
  memoryQualificationLanguageBucket,
  type MemoryQualificationLanguageBucket
} from "./language";
import {
  applyMemoryRecallRoundContextualKeysWithDiagnostics,
  MEMORY_CONTEXTUAL_FALLBACK_REASONS,
  MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
  type MemoryContextualFallbackDiagnostic,
  type MemoryContextualFallbackReason
} from "./rounds";
import {
  createPrismaMemoryHistoryIndexRepository,
  type MemoryHistoryIndexRepository
} from "./repository";

export type MemoryHistoryIndexHandlerDependencies = Readonly<{
  authorizeResults?: (
    tx: Prisma.TransactionClient,
    settings: LockedMemorySettings,
    userId: string,
    jobId: string,
    results: readonly Readonly<{
      acceptedOutputHash: string;
      bindingId: string;
    }>[]
  ) => Promise<void>;
  classifier?: MemoryHistorySafetyClassifier;
  contextualKeyGenerator?: MemoryContextualKeyGenerator;
  digestGenerator?: MemoryChatDigestGenerator;
  repository: MemoryHistoryIndexRepository;
}>;

const MEMORY_CHAT_DIGEST_OUTPUT_DEGRADED_POLICY_VERSION =
  "memory-chat-digest-output-degraded-v1";

function degradedMemoryChatDigest(
  reason: "aggregate_limit" | "contract" | "invalid" | "safety_rejected" |
    "unavailable"
): Readonly<{
  generated: MemoryChatDigestGenerationResult;
  stage: string;
}> {
  return {
    generated: {
      classificationRequired: false,
      digest: null,
      executions: [],
      policyVersion:
        `${MEMORY_CHAT_DIGEST_OUTPUT_DEGRADED_POLICY_VERSION}:${reason}`,
      work: {
        digestSegmentsProcessed: 0,
        digestSourceChunksProcessed: 0
      }
    },
    stage: `lexical_ready:digest_${reason}`
  };
}

function classifyMemoryHistoryLite(
  chunks: readonly Readonly<{ id: string }>[],
  expectedIds: readonly string[]
): MemoryHistoryClassificationResult {
  const expected = new Set(expectedIds);
  const selected = chunks.filter((chunk) => expected.has(chunk.id));
  if (selected.length !== expected.size) {
    throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
  }
  return {
    decisions: selected.map((chunk) => ({
      chunkId: chunk.id,
      sensitivity: "NORMAL" as const
    })),
    executions: [],
    policyVersion: MEMORY_SAFETY_LITE_POLICY_VERSION
  };
}

export function applyMemoryHistoryClassifications(
  plan: MemoryHistoryIndexPlan,
  classification: MemoryHistoryClassificationResult
): MemoryHistoryIndexPlan {
  const rebuilt = new Set(plan.rebuiltChunkIds);
  if (
    !classification.policyVersion ||
    classification.policyVersion.length > 256 ||
    classification.decisions.length !== rebuilt.size
  ) {
    throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
  }
  const decisions = new Map(classification.decisions.map((decision) =>
    [decision.chunkId, decision.sensitivity] as const));
  if (
    decisions.size !== classification.decisions.length ||
    plan.chunks.some((chunk) => rebuilt.has(chunk.id) && !decisions.has(chunk.id)) ||
    classification.decisions.some((decision) => !rebuilt.has(decision.chunkId))
  ) {
    throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
  }
  const chunks = plan.chunks.map((chunk) => {
    if (!rebuilt.has(chunk.id)) return chunk;
    const sensitivity = decisions.get(chunk.id);
    if (sensitivity === "SECRET" || sensitivity === "UNCERTAIN") {
      return {
        ...chunk,
        publicationState: "SUPPRESSED" as const,
        redactionReasonCodes: [
          ...new Set([
            ...chunk.redactionReasonCodes,
            sensitivity === "SECRET"
              ? "semantic_secret"
              : "semantic_safety_uncertain"
          ])
        ].sort(),
        redactionState: "EXCLUDED" as const,
        safetyClass: "SECRET_TAINTED" as const
      };
    }
    if (sensitivity !== "NORMAL" && sensitivity !== "SENSITIVE") {
      throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
    }
    return {
      ...chunk,
      publicationState: "ACTIVE" as const,
      safetyClass: "NORMAL" as const
    };
  });
  const chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk] as const));
  const rounds = plan.rounds.map((round) => {
    const parent = chunksById.get(round.parentChunkId);
    if (!parent) {
      throw new MemoryCoordinatorError("memory_history_classification_invalid", true);
    }
    return parent.publicationState === "SUPPRESSED"
      ? {
          ...round,
          publicationState: "SUPPRESSED" as const,
          redactionReasonCodes: parent.redactionReasonCodes,
          redactionState: "EXCLUDED" as const,
          safetyClass: "SECRET_TAINTED" as const
        }
      : {
          ...round,
          publicationState: "ACTIVE" as const,
          safetyClass: "NORMAL" as const
        };
  });
  return {
    ...plan,
    classificationPolicyVersion: classification.policyVersion,
    chunks,
    rounds,
    preparedResultHash: plan.resultHash,
    resultHash: memoryHistoryIndexResultHash(
      plan.source,
      chunks,
      plan.suppressionIdentitySnapshot,
      classification.policyVersion,
      plan.timeZone,
      {
        checkpointMessages: plan.checkpointMessages,
        digest: null,
        digestPolicyVersion: null,
        incremental: plan.incremental,
        rebuiltChunkIds: plan.rebuiltChunkIds,
        rebuiltRoundIds: plan.rebuiltRoundIds,
        reusedChunkIds: plan.reusedChunkIds,
        reusedRoundIds: plan.reusedRoundIds,
        rounds,
        toolEvents: plan.toolEvents,
        work: plan.work
      }
    )
  };
}

export function attachMemoryContextualKeys(
  plan: MemoryHistoryIndexPlan,
  generated: MemoryContextualKeyGenerationResult,
  targetRoundIds: readonly string[]
): MemoryHistoryIndexPlan {
  const targets = new Set(targetRoundIds);
  const fallback = new Set(generated.fallbackRoundIds);
  const validReasons = new Set<string>(MEMORY_CONTEXTUAL_FALLBACK_REASONS);
  if (
    generated.policyVersion !== MEMORY_CONTEXTUAL_KEY_POLICY_VERSION ||
    targets.size !== targetRoundIds.length ||
    generated.providerRequests < 0 ||
    !Number.isSafeInteger(generated.providerRequests) ||
    generated.outputs.some((output) => !targets.has(output.roundId)) ||
    generated.fallbackRoundIds.some((id) => !targets.has(id)) ||
    generated.fallbackDiagnostics?.some((diagnostic) =>
      !targets.has(diagnostic.roundId) || !validReasons.has(diagnostic.reason))
  ) {
    throw new MemoryCoordinatorError("memory_contextual_key_invalid", true);
  }
  const applied = applyMemoryRecallRoundContextualKeysWithDiagnostics(
    plan.rounds,
    generated.outputs,
    generated.policyVersion
  );
  const rounds = applied.rounds;
  const generatedIds = new Set(rounds.flatMap((round) =>
    targets.has(round.id) && round.contextualKeyState === "GENERATED"
      ? [round.id]
      : []));
  const fallbackDiagnostics: MemoryContextualFallbackDiagnostic[] = [
    ...(generated.fallbackDiagnostics ?? generated.fallbackRoundIds.map((roundId) => ({
      reason: "PROVIDER_UNAVAILABLE" as const,
      roundId
    }))),
    ...applied.fallbackDiagnostics.filter((diagnostic) =>
      !fallback.has(diagnostic.roundId))
  ];
  for (const roundId of targetRoundIds) {
    if (generatedIds.has(roundId) || fallbackDiagnostics.some((diagnostic) =>
      diagnostic.roundId === roundId)) continue;
    fallbackDiagnostics.push({ reason: "PROVIDER_OUTPUT_INVALID", roundId });
  }
  const uniqueDiagnostics = [...new Map(fallbackDiagnostics.map((diagnostic) => [
    `${diagnostic.roundId}\u0000${diagnostic.reason}`,
    diagnostic
  ])).values()];
  const contextualFallbackReasonCounts: Partial<
    Record<MemoryContextualFallbackReason, number>
  > = {};
  for (const diagnostic of uniqueDiagnostics) {
    contextualFallbackReasonCounts[diagnostic.reason] =
      (contextualFallbackReasonCounts[diagnostic.reason] ?? 0) + 1;
  }
  const languageCounts: {
    fallback: Partial<Record<MemoryQualificationLanguageBucket, number>>;
    generated: Partial<Record<MemoryQualificationLanguageBucket, number>>;
  } = { fallback: {}, generated: {} };
  const roundById = new Map(rounds.map((round) => [round.id, round]));
  const outputByRoundId = new Map(generated.outputs.map((output) =>
    [output.roundId, output] as const));
  for (const roundId of targetRoundIds) {
    const round = roundById.get(roundId);
    if (!round) continue;
    const bucket = memoryQualificationLanguageBucket(
      outputByRoundId.get(roundId)?.languageCode ?? round.languageCode
    );
    const state = generatedIds.has(roundId) ? "generated" : "fallback";
    languageCounts[state][bucket] = (languageCounts[state][bucket] ?? 0) + 1;
  }
  const work = {
    ...plan.work,
    contextualFallbackReasonCounts: Object.freeze(contextualFallbackReasonCounts),
    contextualLanguageCounts: Object.freeze({
      fallback: Object.freeze(languageCounts.fallback),
      generated: Object.freeze(languageCounts.generated)
    }),
    contextualProviderRequests: generated.providerRequests,
    contextualRoundsFallback: targetRoundIds.filter((id) =>
      fallback.has(id) || !generatedIds.has(id)).length,
    contextualRoundsGenerated: generatedIds.size
  };
  return {
    ...plan,
    rounds,
    work,
    resultHash: memoryHistoryIndexResultHash(
      plan.source,
      plan.chunks,
      plan.suppressionIdentitySnapshot,
      plan.classificationPolicyVersion,
      plan.timeZone,
      {
        checkpointMessages: plan.checkpointMessages,
        digest: plan.digest,
        digestPolicyVersion: plan.digestPolicyVersion,
        incremental: plan.incremental,
        rebuiltChunkIds: plan.rebuiltChunkIds,
        rebuiltRoundIds: plan.rebuiltRoundIds,
        reusedChunkIds: plan.reusedChunkIds,
        reusedRoundIds: plan.reusedRoundIds,
        rounds,
        toolEvents: plan.toolEvents,
        work
      }
    )
  };
}

function attachMemoryChatDigest(
  plan: MemoryHistoryIndexPlan,
  generated: Awaited<ReturnType<MemoryChatDigestGenerator["generate"]>>,
  safety: MemoryHistoryClassificationResult | null
): MemoryHistoryIndexPlan {
  if (!generated.policyVersion || generated.policyVersion.length > 256) {
    throw new MemoryCoordinatorError("memory_chat_digest_invalid", true);
  }
  let digest = generated.digest;
  let digestPolicyVersion = generated.policyVersion;
  const work = {
    ...plan.work,
    digestSegmentsProcessed: generated.work.digestSegmentsProcessed,
    digestSourceChunksProcessed: generated.work.digestSourceChunksProcessed
  };
  if (digest) {
    if (generated.classificationRequired) {
      if (!safety || safety.decisions.length !== 1 ||
        safety.decisions[0]?.chunkId !== digest.id) {
        throw new MemoryCoordinatorError("memory_chat_digest_invalid", true);
      }
      digestPolicyVersion = `${generated.policyVersion}:${safety.policyVersion}`;
      if (safety.decisions[0].sensitivity === "SECRET" ||
        safety.decisions[0].sensitivity === "UNCERTAIN") digest = null;
    } else if (safety !== null) {
      throw new MemoryCoordinatorError("memory_chat_digest_invalid", true);
    }
  } else if (safety !== null) {
    throw new MemoryCoordinatorError("memory_chat_digest_invalid", true);
  }
  return {
    ...plan,
    digest,
    digestPolicyVersion,
    work,
    resultHash: memoryHistoryIndexResultHash(
      plan.source,
      plan.chunks,
      plan.suppressionIdentitySnapshot,
      plan.classificationPolicyVersion,
      plan.timeZone,
      {
        checkpointMessages: plan.checkpointMessages,
        digest,
        digestPolicyVersion,
        incremental: plan.incremental,
        rebuiltChunkIds: plan.rebuiltChunkIds,
        rebuiltRoundIds: plan.rebuiltRoundIds,
        reusedChunkIds: plan.reusedChunkIds,
        reusedRoundIds: plan.reusedRoundIds,
        rounds: plan.rounds,
        toolEvents: plan.toolEvents,
        work
      }
    )
  };
}

function staleExecutionResult(
  jobId: string,
  errorCode = "memory_history_job_invalid"
): MemoryJobExecutionResult {
  return {
    acceptedResultHash: memorySha256({ errorCode, jobId }),
    apply: async () => {
      throw new MemoryCoordinatorError(errorCode, false);
    },
    stage: "source_stale"
  };
}

function historyOperationalCounters(
  plan: MemoryHistoryIndexPlan
): MemoryOperationalCounters {
  const digestNoop = plan.digest && plan.work.digestSegmentsProcessed === 0
    ? 1
    : 0;
  const contextualCounters: Record<string, number> = {};
  for (const [reason, count] of Object.entries(
    plan.work.contextualFallbackReasonCounts ?? {}
  )) {
    if (count === undefined) continue;
    const key = MEMORY_CONTEXTUAL_FALLBACK_COUNTER_KEYS[
      reason as MemoryContextualFallbackReason
    ];
    if (key) contextualCounters[key] = count;
  }
  for (const state of ["fallback", "generated"] as const) {
    for (const [language, count] of Object.entries(
      plan.work.contextualLanguageCounts?.[state] ?? {}
    )) {
      if (count === undefined) continue;
      const key = MEMORY_CONTEXTUAL_LANGUAGE_COUNTER_KEYS[state][
        language as MemoryQualificationLanguageBucket
      ];
      if (key) contextualCounters[key] = count;
    }
  }
  return Object.freeze({
    digestFullRebuild: plan.digest?.updateMode === "FULL_REBUILD" ? 1 : 0,
    digestIncremental: plan.digest?.updateMode === "INCREMENTAL" ? 1 : 0,
    digestNoop,
    digestSegmentsProcessed: plan.work.digestSegmentsProcessed,
    digestSourceChunksProcessed: plan.work.digestSourceChunksProcessed,
    contextualProviderRequests: plan.work.contextualProviderRequests,
    contextualRoundsFallback: plan.work.contextualRoundsFallback,
    contextualRoundsGenerated: plan.work.contextualRoundsGenerated,
    historyChunksBuilt: plan.work.chunksBuilt,
    historyChunksReplaced: plan.work.chunksReplaced,
    historyChunksReused: plan.work.chunksReused,
    historyMessageContentRowsLoaded: plan.work.messageContentRowsLoaded,
    historyMessagesProjected: plan.work.messagesProjected,
    historyModelRunRowsLoaded: plan.work.modelRunRowsLoaded,
    historyPathMetadataRowsRead: plan.work.pathMetadataRowsRead,
    historyRoundSegmentsBuilt: plan.work.roundSegmentsBuilt,
    historyRoundSegmentsReplaced: plan.work.roundSegmentsReplaced,
    historyRoundSegmentsReused: plan.work.roundSegmentsReused,
    historyRoundsBuilt: plan.work.roundsBuilt,
    historyRoundsReplaced: plan.work.roundsReplaced,
    historyRoundsReused: plan.work.roundsReused,
    ...contextualCounters
  }) as MemoryOperationalCounters;
}

export function createMemoryHistoryIndexHandler(
  dependencies: MemoryHistoryIndexHandlerDependencies
): MemoryJobHandler {
  return Object.freeze({
    kind: "INDEX_HISTORY" as const,

    async preflight(job) {
      if (!memoryHistoryIndexClaimIsValid(job)) {
        return {
          errorCode: "memory_history_job_invalid",
          status: "CANCELLED" as const
        };
      }
      return dependencies.repository.preflight(job);
    },

    async execute(claim, context) {
      if (!memoryHistoryIndexClaimIsValid(claim)) {
        return staleExecutionResult(claim.id);
      }
      await context.setStage("source_snapshot");
      const prepared = await dependencies.repository.prepare(claim);
      if ("decision" in prepared) {
        return staleExecutionResult(claim.id, prepared.decision.errorCode);
      }
      if (context.signal.aborted) throw context.signal.reason;
      await context.setStage("safety_classification");
      let plan: MemoryHistoryIndexPlan;
      let completionStage = "lexical_ready";
      try {
        const classification = classifyMemoryHistoryLite(
          prepared.plan.chunks,
          prepared.plan.rebuiltChunkIds
        );
        plan = applyMemoryHistoryClassifications(prepared.plan, classification);
        let executionResults = [...(classification.executions ?? [])];
        const contextualTargets = plan.rounds.flatMap((round) =>
          round.publicationState === "ACTIVE" &&
          round.contextualKeyState === "RAW_FALLBACK"
            ? [round.id]
            : []);
        if (dependencies.contextualKeyGenerator && contextualTargets.length > 0) {
          await context.setStage("contextual_key_generation");
          let generated: MemoryContextualKeyGenerationResult;
          try {
            generated = await dependencies.contextualKeyGenerator.generate(
              plan.rounds,
              contextualTargets,
              {
                jobId: claim.id,
                signal: context.signal,
                userId: claim.userId
              }
            );
          } catch (error) {
            if (context.signal.aborted) throw context.signal.reason;
            generated = {
              executions: [],
              fallbackDiagnostics: contextualTargets.map((roundId) => ({
                reason: "PROVIDER_UNAVAILABLE" as const,
                roundId
              })),
              fallbackRoundIds: contextualTargets,
              outputs: [],
              policyVersion: MEMORY_CONTEXTUAL_KEY_POLICY_VERSION,
              providerRequests: 0
            };
            completionStage = "lexical_ready:contextual_unavailable";
          }
          executionResults.push(...generated.executions);
          plan = attachMemoryContextualKeys(plan, generated, contextualTargets);
        }
        if (dependencies.digestGenerator) {
          await context.setStage("digest_generation");
          let generated: MemoryChatDigestGenerationResult;
          try {
            generated = await dependencies.digestGenerator.generate(
              plan.source,
              plan.chunks,
              {
                jobId: claim.id,
                signal: context.signal,
                timeZone: plan.timeZone,
                userId: claim.userId
              }
            );
          } catch (error) {
            if (context.signal.aborted) throw context.signal.reason;
            const reason = error instanceof MemoryChatDigestOutputError
              ? error.reason
              : error instanceof MemoryChatDigestError
                ? error.code === "memory_chat_digest_unavailable"
                  ? "unavailable"
                  : "invalid"
                : null;
            if (!reason) throw error;
            const degraded = degradedMemoryChatDigest(reason);
            generated = degraded.generated;
            completionStage = degraded.stage;
          }
          executionResults.push(...generated.executions);
          if (generated.digest) {
            const digestSafety = generated.classificationRequired
              ? classifyMemoryHistoryLite(
                  [{ id: generated.digest.id }],
                  [generated.digest.id]
                )
              : null;
            if (digestSafety) executionResults.push(...(digestSafety.executions ?? []));
            plan = attachMemoryChatDigest(plan, generated, digestSafety);
          } else {
            plan = attachMemoryChatDigest(plan, generated, null);
          }
        } else {
          plan = attachMemoryChatDigest(plan, {
            classificationRequired: false,
            digest: null,
            executions: [],
            policyVersion: "memory-chat-digest-disabled",
            work: {
              digestSegmentsProcessed: 0,
              digestSourceChunksProcessed: 0
            }
          }, null);
        }
        await context.setStage("lexical_apply");
        return {
          acceptedResultHash: plan.resultHash,
          apply: async (tx, acceptedClaim) => {
            if (executionResults.length > 0) {
              if (!dependencies.authorizeResults) {
                throw new Error("memory_history_classification_authority_missing");
              }
              const settings = await lockMemorySettings(
                tx,
                acceptedClaim.userId,
                true
              );
              await dependencies.authorizeResults(
                tx,
                settings,
                acceptedClaim.userId,
                acceptedClaim.id,
                executionResults
              );
            }
            await dependencies.repository.apply(
              tx,
              acceptedClaim,
              plan,
              context.now()
            );
          },
          operationalCounters: historyOperationalCounters(plan),
          stage: completionStage
        };
      } catch (error) {
        if (context.signal.aborted) throw context.signal.reason;
        if (error instanceof MemoryCoordinatorError) throw error;
        throw new MemoryCoordinatorError(
          "memory_history_classification_unavailable",
          true
        );
      }
    }
  });
}

export function createPrismaMemoryHistoryIndexHandler(
  client: PrismaClient = prisma,
  _classifier?: MemoryHistorySafetyClassifier,
  options: Readonly<{
    authority?: MemoryExecutionAuthorityDependencies;
    contextualKeyGenerator?: MemoryContextualKeyGenerator;
    digestGenerator?: MemoryChatDigestGenerator;
    structuredProvider?: MemoryStructuredOutputProvider;
  }> = {}
): MemoryJobHandler {
  const authority = options.authority ?? defaultMemoryExecutionAuthority;
  const governed = _classifier === undefined;
  return createMemoryHistoryIndexHandler({
    ...(governed ? {
      authorizeResults: async (
        tx: Prisma.TransactionClient,
        settings: LockedMemorySettings,
        userId: string,
        jobId: string,
        results: readonly Readonly<{
          acceptedOutputHash: string;
          bindingId: string;
        }>[]
      ) => {
        await authorizeMemoryExecutionResultsForCommit(
          authority,
          tx,
          settings,
          userId,
          { memoryJobId: jobId, role: "MEMORY_HISTORY_CLASSIFY" },
          results
        );
      },
    } : {}),
    ...(options.digestGenerator
      ? { digestGenerator: options.digestGenerator }
      : governed
        ? {
            digestGenerator: createPrismaMemoryChatDigestGenerator(client, {
              authority,
              provider: options.structuredProvider
            })
          }
        : {}),
    ...(options.contextualKeyGenerator
      ? { contextualKeyGenerator: options.contextualKeyGenerator }
      : governed
        ? {
            contextualKeyGenerator: createPrismaMemoryContextualKeyGenerator(
              client,
              { authority, provider: options.structuredProvider }
            )
          }
        : {}),
    repository: createPrismaMemoryHistoryIndexRepository(client)
  });
}
