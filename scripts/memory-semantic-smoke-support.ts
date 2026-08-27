import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import type { MemoryConsumerSettingsResponse } from "../lib/contracts/memoryConsumer";
import { preflightPrismaMemoryProviderBindings } from "../lib/server/memory/coordinator/providerPreflight";
import { requireAdminAcceptedMemoryDestination } from "../lib/server/memory/execution/adminConsent";
import { resolveMemoryEgressConsentMode } from "../lib/server/memory/execution/consentMode";
import {
  requireAcceptedMemoryUtilityPolicy,
  resolveCurrentMemoryUtilityPolicy,
  type ResolvedMemoryExecutionTarget
} from "../lib/server/memory/execution/policy";
import {
  memoryRoleRequiresStrictOutput,
  type MemoryExecutionRole
} from "../lib/server/memory/execution/roles";
import { parseMemoryExecutionSnapshot } from "../lib/server/memory/execution/snapshot";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "../lib/server/memory/history/chunking";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "../lib/server/memory/history/sourceProjection";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "../lib/server/memory/learning/extraction/contract";
import { normalizeMemorySearchText } from "../lib/server/memory/persistence/lexical";
import { loadProviderAdmissionPlan } from "../lib/server/providerRuntime/admission";

export const MEMORY_SEMANTIC_SMOKE_PREFLIGHT_CODES = [
  "memory_smoke_answer_binding_mismatch",
  "memory_smoke_answer_binding_unavailable",
  "memory_smoke_credential_unreadable",
  "memory_smoke_egress_not_accepted",
  "memory_smoke_embedding_not_configured",
  "memory_smoke_embedding_unavailable",
  "memory_smoke_reranker_unavailable",
  "memory_smoke_settings_disabled",
  "memory_smoke_settings_unavailable",
  "memory_smoke_strict_output_unavailable",
  "memory_smoke_system_model_unavailable",
  "memory_smoke_tool_calling_unavailable"
] as const;

export type MemorySemanticSmokePreflightCode =
  (typeof MEMORY_SEMANTIC_SMOKE_PREFLIGHT_CODES)[number];

export class MemorySemanticSmokePreflightError extends Error {
  constructor(readonly code: MemorySemanticSmokePreflightCode) {
    super(code);
    this.name = "MemorySemanticSmokePreflightError";
  }
}

type BindingIdentity = Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  providerModelId: string;
}>;

export type MemorySemanticSmokePreflightSnapshot = Readonly<{
  answer: BindingIdentity | null;
  consentAccepted: boolean;
  credentialIntegrity: boolean;
  embeddingReady: boolean;
  embeddingSelected: boolean;
  rerankerReady: boolean;
  settingsAvailable: boolean;
  settingsEnabled: boolean;
  system: (BindingIdentity & Readonly<{
    strictOutput: boolean;
    toolCalling: boolean;
  }>) | null;
  systemRolesReady: boolean;
}>;

export type MemorySemanticSmokeTarget = Readonly<{
  connectionId: string;
  modelId: string;
}>;

export type MemorySemanticSmokeConsumerPreparation =
  | Readonly<{
      code: "memory_smoke_consumer_capability_unavailable" |
        "memory_smoke_settings_disabled";
      ok: false;
    }>
  | Readonly<{
      ok: true;
      retrievalReady: boolean;
    }>;

/**
 * Keep the mutation-free consumer gate strict about every prerequisite except
 * the exact active-index readiness shared by retrieval and the two background
 * capabilities, which the bounded administrator action can repair.
 */
export function validateMemorySemanticSmokeConsumerPreparation(
  settings: MemoryConsumerSettingsResponse
): MemorySemanticSmokeConsumerPreparation {
  if (!settings.settings.useMemoryFacts || !settings.settings.learnAutomatically ||
    !settings.settings.referenceChatHistory) {
    return { code: "memory_smoke_settings_disabled", ok: false };
  }
  const retrievalReady = settings.capabilities.retrievalAvailable;
  const indexRepairable = !retrievalReady &&
    !settings.capabilities.automaticLearningAvailable &&
    !settings.capabilities.pastChatIndexingAvailable;
  const statusMatchesRetrieval = retrievalReady
    ? settings.status === "ON" || settings.status === "PREPARING"
    : settings.status === "UNAVAILABLE";
  if (!settings.capabilities.managementAvailable ||
    !settings.capabilities.naturalLanguageActionsAvailable ||
    (!indexRepairable && (
      !settings.capabilities.automaticLearningAvailable ||
      !settings.capabilities.pastChatIndexingAvailable
    )) ||
    !statusMatchesRetrieval || settings.resetState !== "IDLE") {
    return { code: "memory_smoke_consumer_capability_unavailable", ok: false };
  }
  return { ok: true, retrievalReady };
}

export const MEMORY_SEMANTIC_SMOKE_SCENARIOS = Object.freeze([
  "intent_without_exact_keywords",
  "update_target_selection",
  "forget_target_selection",
  "plain_language_secret_rejection",
  "conservative_extraction",
  "relevant_rerank",
  "irrelevant_rerank",
  "russian",
  "english",
  "mixed_language",
  "strict_structured_output"
] as const);

export type MemorySemanticSmokeScenario =
  (typeof MEMORY_SEMANTIC_SMOKE_SCENARIOS)[number];

/** Keeps the executable smoke and its PRD scenario manifest coupled. */
export function createMemorySemanticSmokeScenarioLedger() {
  const complete = new Set<MemorySemanticSmokeScenario>();
  return Object.freeze({
    complete(scenario: MemorySemanticSmokeScenario): void {
      complete.add(scenario);
    },
    assertComplete(): number {
      if (MEMORY_SEMANTIC_SMOKE_SCENARIOS.some((scenario) => !complete.has(scenario))) {
        throw new Error("memory_smoke_scenario_incomplete");
      }
      return complete.size;
    }
  });
}

function preflightFailure(code: MemorySemanticSmokePreflightCode): never {
  throw new MemorySemanticSmokePreflightError(code);
}

function sameBinding(left: BindingIdentity, right: BindingIdentity): boolean {
  return left.connectionId === right.connectionId &&
    left.credentialId === right.credentialId &&
    left.credentialVersionId === right.credentialVersionId &&
    left.providerModelId === right.providerModelId;
}

export function validateMemorySemanticSmokePreflight(
  snapshot: MemorySemanticSmokePreflightSnapshot
): MemorySemanticSmokeTarget {
  if (!snapshot.settingsAvailable) return preflightFailure("memory_smoke_settings_unavailable");
  if (!snapshot.settingsEnabled) return preflightFailure("memory_smoke_settings_disabled");
  if (!snapshot.embeddingSelected) {
    return preflightFailure("memory_smoke_embedding_not_configured");
  }
  if (!snapshot.system || !snapshot.systemRolesReady) {
    return preflightFailure("memory_smoke_system_model_unavailable");
  }
  if (!snapshot.system.strictOutput) {
    return preflightFailure("memory_smoke_strict_output_unavailable");
  }
  if (!snapshot.system.toolCalling) {
    return preflightFailure("memory_smoke_tool_calling_unavailable");
  }
  if (!snapshot.embeddingReady) {
    return preflightFailure("memory_smoke_embedding_unavailable");
  }
  if (!snapshot.rerankerReady) {
    return preflightFailure("memory_smoke_reranker_unavailable");
  }
  if (!snapshot.consentAccepted) {
    return preflightFailure("memory_smoke_egress_not_accepted");
  }
  if (!snapshot.credentialIntegrity) {
    return preflightFailure("memory_smoke_credential_unreadable");
  }
  if (!snapshot.answer) {
    return preflightFailure("memory_smoke_answer_binding_unavailable");
  }
  if (!sameBinding(snapshot.system, snapshot.answer)) {
    return preflightFailure("memory_smoke_answer_binding_mismatch");
  }
  return {
    connectionId: snapshot.system.connectionId,
    modelId: snapshot.system.providerModelId
  };
}

function identity(target: ResolvedMemoryExecutionTarget | undefined): BindingIdentity | null {
  if (!target) return null;
  return {
    connectionId: target.authority.connectionId,
    credentialId: target.authority.credentialId,
    credentialVersionId: target.authority.credentialVersionId,
    providerModelId: target.authority.providerModelId
  };
}

function targetsShareBinding(
  targets: readonly (ResolvedMemoryExecutionTarget | undefined)[]
): boolean {
  const first = identity(targets[0]);
  return first !== null && targets.every((target) => {
    const candidate = identity(target);
    return candidate !== null && sameBinding(first, candidate);
  });
}

export const MEMORY_SEMANTIC_SMOKE_REQUIRED_ROLES = Object.freeze([
  "MEMORY_CONTROL",
  "MEMORY_STATEMENT_CLASSIFY",
  "MEMORY_HISTORY_CLASSIFY",
  "MEMORY_FACT_EXTRACT",
  "MEMORY_CONSOLIDATE",
  "MEMORY_RERANK",
  "MEMORY_DOCUMENT_EMBED",
  "MEMORY_QUERY_EMBED"
] as const satisfies readonly MemoryExecutionRole[]);

/**
 * Resolve the exact persisted System Model, per-user embedding, reranker, and
 * answer binding used by production admission. This is a database-only check:
 * it never refreshes a provider, changes policy, or acknowledges egress.
 */
export async function preflightPrismaMemorySemanticSmoke(
  client: PrismaClient,
  userId: string,
  encryptionKey: Buffer
): Promise<MemorySemanticSmokeTarget> {
  const settings = await client.userMemorySettings.findUnique({
    select: {
      acceptedUtilityEgressAt: true,
      acceptedUtilityEgressFingerprint: true,
      acceptedUtilityPolicyVersion: true,
      embeddingProviderModelId: true,
      learnAutomatically: true,
      referenceChatHistory: true,
      useMemoryFacts: true,
      userId: true
    },
    where: { userId }
  });
  if (!settings) {
    return validateMemorySemanticSmokePreflight({
      answer: null,
      consentAccepted: false,
      credentialIntegrity: false,
      embeddingReady: false,
      embeddingSelected: false,
      rerankerReady: false,
      settingsAvailable: false,
      settingsEnabled: false,
      system: null,
      systemRolesReady: false
    });
  }
  const settingsEnabled = settings.useMemoryFacts && settings.learnAutomatically &&
    settings.referenceChatHistory;
  if (!settingsEnabled || !settings.embeddingProviderModelId) {
    return validateMemorySemanticSmokePreflight({
      answer: null,
      consentAccepted: false,
      credentialIntegrity: false,
      embeddingReady: false,
      embeddingSelected: Boolean(settings.embeddingProviderModelId),
      rerankerReady: false,
      settingsAvailable: true,
      settingsEnabled,
      system: null,
      systemRolesReady: false
    });
  }

  const resolved = await client.$transaction(async (tx) => {
    const current = await tx.userMemorySettings.findUnique({
      select: {
        acceptedUtilityEgressAt: true,
        acceptedUtilityEgressFingerprint: true,
        acceptedUtilityPolicyVersion: true,
        embeddingProviderModelId: true,
        learnAutomatically: true,
        referenceChatHistory: true,
        useMemoryFacts: true,
        userId: true
      },
      where: { userId }
    });
    if (!current || !current.embeddingProviderModelId || !current.useMemoryFacts ||
      !current.learnAutomatically || !current.referenceChatHistory) {
      return null;
    }
    const policy = await resolveCurrentMemoryUtilityPolicy(tx, userId, current);
    const systemTargets = [
      policy.targets.get("MEMORY_CONTROL"),
      policy.targets.get("MEMORY_STATEMENT_CLASSIFY"),
      policy.targets.get("MEMORY_HISTORY_CLASSIFY"),
      policy.targets.get("MEMORY_FACT_EXTRACT"),
      policy.targets.get("MEMORY_CONSOLIDATE")
    ] as const;
    const embeddingTargets = [
      policy.targets.get("MEMORY_DOCUMENT_EMBED"),
      policy.targets.get("MEMORY_QUERY_EMBED")
    ] as const;
    const reranker = policy.targets.get("MEMORY_RERANK");
    const systemTarget = systemTargets[0];
    let consentAccepted = MEMORY_SEMANTIC_SMOKE_REQUIRED_ROLES.every((role) =>
      policy.targets.has(role));
    if (consentAccepted) {
      try {
        const consentMode = resolveMemoryEgressConsentMode();
        if (consentMode === "ADMIN") {
          for (const role of MEMORY_SEMANTIC_SMOKE_REQUIRED_ROLES) {
            await requireAdminAcceptedMemoryDestination(tx, {
              role,
              target: policy.targets.get(role)!
            });
          }
        } else {
          requireAcceptedMemoryUtilityPolicy(current, policy, consentMode);
        }
      } catch {
        consentAccepted = false;
      }
    }

    let answer: BindingIdentity | null = null;
    if (systemTarget) {
      try {
        const plan = await loadProviderAdmissionPlan(tx, {
          providerConnectionId: systemTarget.authority.connectionId,
          providerModelId: systemTarget.authority.providerModelId,
          searchPlan: { mode: "all_selected", optionIds: [] },
          userId
        });
        const authority = plan.answer.authority;
        if (authority) {
          answer = {
            connectionId: authority.connectionId,
            credentialId: authority.credentialId,
            credentialVersionId: authority.credentialVersionId,
            providerModelId: authority.providerModelId
          };
        }
      } catch {
        // The fixed preflight code is projected below; provider details stay private.
      }
    }

    const systemIdentity = identity(systemTarget);
    return {
      answer,
      consentAccepted,
      embeddingReady: targetsShareBinding(embeddingTargets),
      rerankerReady: Boolean(reranker) && systemTarget !== undefined &&
        targetsShareBinding([systemTarget, reranker]),
      system: systemIdentity && systemTarget
        ? {
            ...systemIdentity,
            strictOutput: systemTarget.snapshot.model.capabilities.structuredOutput === true,
            toolCalling: systemTarget.snapshot.model.capabilities.toolCalling === true
          }
        : null,
      systemRolesReady: targetsShareBinding(systemTargets)
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  if (!resolved) return preflightFailure("memory_smoke_settings_disabled");
  const capabilitySnapshot: MemorySemanticSmokePreflightSnapshot = {
    ...resolved,
    credentialIntegrity: true,
    embeddingSelected: true,
    settingsAvailable: true,
    settingsEnabled: true
  };
  // Validate capability and consent failures before touching credential
  // envelopes so missing setup always reports the most actionable blocker.
  validateMemorySemanticSmokePreflight(capabilitySnapshot);
  let credentialIntegrity = true;
  try {
    await preflightPrismaMemoryProviderBindings(client, encryptionKey);
  } catch {
    credentialIntegrity = false;
  }
  return validateMemorySemanticSmokePreflight({
    ...capabilitySnapshot,
    credentialIntegrity
  });
}

type SourceIdentity = Readonly<{
  chatId: string;
  messageId: string;
  notBefore: Date;
  userId: string;
}>;

async function currentAutomaticFactVersionIds(
  client: PrismaClient,
  source: SourceIdentity
): Promise<string[]> {
  const evidence = await client.memoryEvidence.findMany({
    distinct: ["factVersionId"],
    select: { factVersionId: true },
    where: {
      chatId: source.chatId,
      createdAt: { gte: source.notBefore },
      messageId: source.messageId,
      sourceRole: "user",
      sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
      sourceType: "MESSAGE",
      stance: "SUPPORTS",
      userId: source.userId
    }
  });
  const evidenceVersionIds = evidence.map(({ factVersionId }) => factVersionId);
  if (evidenceVersionIds.length === 0) return [];
  const versions = await client.memoryFactVersion.findMany({
    select: { id: true },
    where: {
      contentPurgedAt: null,
      createdAt: { gte: source.notBefore },
      id: { in: evidenceVersionIds },
      safetyClassificationState: "CLASSIFIED",
      sensitivityClass: "NORMAL",
      sourceMode: "AUTOMATIC",
      state: "ACTIVE",
      userId: source.userId
    }
  });
  const versionIds = versions.map(({ id }) => id);
  if (versionIds.length === 0) return [];
  const facts = await client.memoryFact.findMany({
    select: { currentVersionId: true },
    where: {
      currentVersionId: { in: versionIds },
      state: "ACTIVE",
      userId: source.userId
    }
  });
  return facts.flatMap(({ currentVersionId }) => currentVersionId ? [currentVersionId] : []);
}

async function indexedHistoryChunkIds(
  client: PrismaClient,
  input: Readonly<{ chatId: string; messageId: string; userId: string }>
): Promise<string[]> {
  const [chat, settings] = await Promise.all([
    client.chat.findFirst({
      select: { memoryBranchGeneration: true, memorySourceRevision: true },
      where: {
        id: input.chatId,
        memoryMode: "NORMAL",
        projectId: null,
        userId: input.userId
      }
    }),
    client.userMemorySettings.findUnique({
      select: { activeIndexGenerationId: true, embeddingProviderModelId: true },
      where: { userId: input.userId }
    })
  ]);
  if (!chat || !settings?.activeIndexGenerationId || !settings.embeddingProviderModelId) return [];
  const generation = await client.memoryIndexGeneration.findFirst({
    select: { id: true },
    where: {
      embeddingProviderModelId: settings.embeddingProviderModelId,
      id: settings.activeIndexGenerationId,
      indexMode: "HYBRID",
      state: "ACTIVE",
      userId: input.userId
    }
  });
  if (!generation) return [];
  const sourceRows = await client.memoryRecallChunkMessage.findMany({
    distinct: ["chunkId"],
    select: { chunkId: true },
    where: {
      chatId: input.chatId,
      messageId: input.messageId,
      role: "user",
      userId: input.userId
    }
  });
  const sourceChunkIds = sourceRows.map(({ chunkId }) => chunkId);
  if (sourceChunkIds.length === 0) return [];
  const chunks = await client.memoryRecallChunk.findMany({
    select: { id: true },
    where: {
      branchGeneration: chat.memoryBranchGeneration,
      chatId: input.chatId,
      chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
      id: { in: sourceChunkIds },
      redactionState: "NOT_NEEDED",
      safetyClass: "NORMAL",
      sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
      sourceRevisionAtCreation: chat.memorySourceRevision,
      state: "ACTIVE",
      userId: input.userId
    }
  });
  const currentChunkIds = chunks.map(({ id }) => id);
  if (currentChunkIds.length === 0) return [];
  const entries = await client.memorySearchEntry.findMany({
    distinct: ["recallChunkId"],
    select: { recallChunkId: true },
    where: {
      embeddingState: "READY",
      indexGenerationId: generation.id,
      itemType: "RECALL_CHUNK",
      recallChunkId: { in: currentChunkIds },
      userId: input.userId
    }
  });
  return entries.flatMap(({ recallChunkId }) => recallChunkId ? [recallChunkId] : []);
}

/** Internal-only verifier. It consumes exact database identities but returns
 * counts only, so neither provider output nor smoke reports expose row ids. */
export function createPrismaMemorySemanticSmokeVerifier(client: PrismaClient) {
  async function successfulExecutionBindingCount(input: Readonly<{
    logicalRole: "MEMORY_CONTROL" | "MEMORY_FACT_EXTRACT" | "MEMORY_RERANK";
    memoryJobIds?: readonly string[];
    retrievalAttemptIds?: readonly string[];
    userId: string;
  }>): Promise<number> {
    const bindings = await client.memoryExecutionBinding.findMany({
      select: { secretFreeExecutionSnapshot: true },
      where: {
        logicalRole: input.logicalRole,
        ...(input.memoryJobIds
          ? { memoryJobId: { in: [...input.memoryJobIds] } }
          : {}),
        ...(input.retrievalAttemptIds
          ? { retrievalAttemptId: { in: [...input.retrievalAttemptIds] } }
          : {}),
        state: "SUCCEEDED",
        userId: input.userId
      }
    });
    return bindings.filter((binding) => {
      try {
        const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
        const model = snapshot.providerExecutionSnapshot.model;
        const expectedStrictOutput = input.logicalRole === "MEMORY_RERANK"
          ? model.adapterKind !== "fake" && model.modelClass === "answer"
          : memoryRoleRequiresStrictOutput(input.logicalRole);
        return snapshot.logicalRole === input.logicalRole &&
          snapshot.requiresStrictStructuredOutput === expectedStrictOutput;
      } catch {
        return false;
      }
    }).length;
  }

  return Object.freeze({
    async currentAutomaticFactCount(source: SourceIdentity): Promise<number> {
      return (await currentAutomaticFactVersionIds(client, source)).length;
    },

    async sourceBackedFactVersionCount(source: SourceIdentity): Promise<number> {
      return client.memoryEvidence.count({
        where: {
          chatId: source.chatId,
          createdAt: { gte: source.notBefore },
          messageId: source.messageId,
          sourceRole: "user",
          sourceType: "MESSAGE",
          userId: source.userId
        }
      });
    },

    async sourceBackedFactEmbeddingReadyCount(source: SourceIdentity): Promise<number> {
      const [versionIds, settings] = await Promise.all([
        currentAutomaticFactVersionIds(client, source),
        client.userMemorySettings.findUnique({
          select: { activeIndexGenerationId: true },
          where: { userId: source.userId }
        })
      ]);
      if (versionIds.length === 0 || !settings?.activeIndexGenerationId) return 0;
      return client.memorySearchEntry.count({
        where: {
          embeddingState: "READY",
          factVersionId: { in: versionIds },
          indexGenerationId: settings.activeIndexGenerationId,
          itemType: "FACT_VERSION",
          userId: source.userId
        }
      });
    },

    async readyExplicitFactEmbeddingCount(input: Readonly<{
      query: string;
      userId: string;
    }>): Promise<number> {
      const normalizedQuery = normalizeMemorySearchText(input.query);
      if (!normalizedQuery) return 0;
      const settings = await client.userMemorySettings.findUnique({
        select: { activeIndexGenerationId: true },
        where: { userId: input.userId }
      });
      if (!settings?.activeIndexGenerationId) return 0;
      const rows = await client.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::integer AS "count"
        FROM "MemoryFact" AS fact
        INNER JOIN "MemoryFactVersion" AS version
          ON version."userId" = fact."userId"
         AND version."factId" = fact."id"
         AND version."id" = fact."currentVersionId"
        INNER JOIN "MemoryScope" AS scope
          ON scope."userId" = fact."userId" AND scope."id" = fact."scopeId"
        INNER JOIN "MemorySearchEntry" AS search
          ON search."userId" = version."userId"
         AND search."factVersionId" = version."id"
         AND search."indexGenerationId" = ${settings.activeIndexGenerationId}
        WHERE fact."userId" = ${input.userId}
          AND fact."state" = 'ACTIVE'::"MemoryFactState"
          AND version."state" = 'ACTIVE'::"MemoryFactVersionState"
          AND version."sourceMode" = 'EXPLICIT'::"MemoryFactSourceMode"
          AND version."safetyClassificationState" =
            'CLASSIFIED'::"MemorySafetyClassificationState"
          AND version."contentPurgedAt" IS NULL
          AND scope."state" = 'ACTIVE'::"MemoryScopeState"
          AND scope."scopeType" = 'GLOBAL_USER'::"MemoryScopeType"
          AND search."itemType" = 'FACT_VERSION'::"MemorySearchItemType"
          AND search."embeddingState" = 'READY'::"MemoryEmbeddingState"
          AND strpos(search."normalizedSearchText", ${normalizedQuery}) > 0
      `);
      return rows[0]?.count ?? 0;
    },

    async recalledAutomaticFactCount(
      source: SourceIdentity & Readonly<{ recallModelRunId: string }>
    ): Promise<number> {
      const factVersionIds = await currentAutomaticFactVersionIds(client, source);
      if (factVersionIds.length === 0) return 0;
      const attempts = await client.memoryRetrievalAttempt.findMany({
        select: { id: true },
        where: {
          modelRunId: source.recallModelRunId,
          outcome: "USED",
          state: "CONSUMED",
          userId: source.userId
        }
      });
      if (attempts.length === 0) return 0;
      return client.memoryRetrievalAttemptItem.count({
        where: {
          attemptId: { in: attempts.map(({ id }) => id) },
          factVersionId: { in: factVersionIds },
          itemType: "FACT_VERSION",
          userId: source.userId
        }
      });
    },

    async indexedHistorySourceCount(
      input: Readonly<{ chatId: string; messageId: string; userId: string }>
    ): Promise<number> {
      return (await indexedHistoryChunkIds(client, input)).length;
    },

    async sourceJobStateCounts(
      input: Readonly<{ chatId: string; userId: string }>
    ): Promise<Readonly<{
      active: number;
      successfulEmptyExtraction: boolean;
      total: number;
      unsuccessfulTerminal: number;
    }>> {
      const jobs = await client.memoryJob.findMany({
        select: { id: true, kind: true, stage: true, state: true },
        where: { chatId: input.chatId, userId: input.userId }
      });
      if (jobs.length === 0) {
        return {
          active: 0,
          successfulEmptyExtraction: false,
          total: 0,
          unsuccessfulTerminal: 0
        };
      }
      const bindings = await client.memoryExecutionBinding.findMany({
        select: { memoryJobId: true, ordinal: true, state: true },
        where: {
          memoryJobId: { in: jobs.map(({ id }) => id) },
          userId: input.userId
        }
      });
      const latestBindingByJob = new Map<string, typeof bindings[number]>();
      for (const binding of bindings) {
        if (!binding.memoryJobId) continue;
        const prior = latestBindingByJob.get(binding.memoryJobId);
        if (!prior || binding.ordinal > prior.ordinal) {
          latestBindingByJob.set(binding.memoryJobId, binding);
        }
      }
      const activeStates = new Set([
        "QUEUED",
        "WAITING_FOR_EGRESS_CONSENT",
        "CLAIMED",
        "RETRYABLE_FAILED"
      ]);
      const unsuccessfulJobIds = new Set(jobs
        .filter(({ state }) => ["TERMINAL_FAILED", "STALE", "CANCELLED"].includes(state))
        .map(({ id }) => id));
      for (const [jobId, binding] of latestBindingByJob) {
        if (binding.state === "FAILED" || binding.state === "OUTCOME_UNKNOWN") {
          unsuccessfulJobIds.add(jobId);
        }
      }
      return {
        active: jobs.filter(({ state }) => activeStates.has(state)).length,
        successfulEmptyExtraction: jobs.some((job) =>
          job.kind === "EXTRACT_FACTS" &&
          job.stage === "fact_observations_empty" &&
          job.state === "SUCCEEDED"),
        total: jobs.length,
        unsuccessfulTerminal: unsuccessfulJobIds.size
      };
    },

    async successfulSourceExecutionCount(
      input: Readonly<{
        chatId: string;
        role: "MEMORY_FACT_EXTRACT";
        userId: string;
      }>
    ): Promise<number> {
      const jobs = await client.memoryJob.findMany({
        select: { id: true },
        where: { chatId: input.chatId, userId: input.userId }
      });
      if (jobs.length === 0) return 0;
      return successfulExecutionBindingCount({
        logicalRole: input.role,
        memoryJobIds: jobs.map(({ id }) => id),
        userId: input.userId
      });
    },

    async successfulRetrievalExecutionCount(
      input: Readonly<{
        modelRunId: string;
        role: "MEMORY_CONTROL" | "MEMORY_RERANK";
        userId: string;
      }>
    ): Promise<number> {
      const attempts = await client.memoryRetrievalAttempt.findMany({
        select: { errorCode: true, id: true, state: true },
        where: {
          modelRunId: input.modelRunId,
          state: { in: ["CONSUMED", "STALE"] },
          userId: input.userId
        }
      });
      // A settings/revision drift retry can legitimately consume attempt 1
      // while the strict control execution remains attached to attempt 0.
      // Count that exact retry ancestor only when this run also has a consumed
      // attempt; a stale-only or otherwise abandoned run is not smoke evidence.
      if (!attempts.some(({ state }) => state === "CONSUMED")) return 0;
      const evidenceAttemptIds = attempts.flatMap((attempt) =>
        attempt.state === "CONSUMED" || (
          attempt.state === "STALE" &&
          attempt.errorCode === "memory_admission_settings_changed"
        )
          ? [attempt.id]
          : []
      );
      return successfulExecutionBindingCount({
        logicalRole: input.role,
        retrievalAttemptIds: evidenceAttemptIds,
        userId: input.userId
      });
    },

    async mutationPersistenceCount(
      input: Readonly<{ modelRunId: string; userId: string }>
    ): Promise<number> {
      const [authorizations, receipts] = await Promise.all([
        client.memoryMutationAuthorization.count({
          where: { modelRunId: input.modelRunId, userId: input.userId }
        }),
        client.memoryOperationReceipt.count({
          where: { modelRunId: input.modelRunId, userId: input.userId }
        })
      ]);
      return authorizations + receipts;
    },

    async recalledHistorySourceCount(
      input: Readonly<{
        chatId: string;
        messageId: string;
        recallModelRunId: string;
        userId: string;
      }>
    ): Promise<number> {
      const chunkIds = await indexedHistoryChunkIds(client, input);
      if (chunkIds.length === 0) return 0;
      const attempts = await client.memoryRetrievalAttempt.findMany({
        select: { id: true },
        where: {
          modelRunId: input.recallModelRunId,
          outcome: "USED",
          state: "CONSUMED",
          userId: input.userId
        }
      });
      if (attempts.length === 0) return 0;
      return client.memoryRetrievalAttemptItem.count({
        where: {
          attemptId: { in: attempts.map(({ id }) => id) },
          itemType: "RECALL_CHUNK",
          recallChunkId: { in: chunkIds },
          userId: input.userId
        }
      });
    }
  });
}

export type SmokeResourceLimits = Readonly<{
  cpu?: number;
  memoryGiB?: number;
}>;

function positiveNumber(value: string): number | null {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function readCgroupResourceLimits(
  read: (path: string) => string | null
): SmokeResourceLimits | null {
  let cpu: number | null = null;
  const cpuMax = read("/sys/fs/cgroup/cpu.max")?.trim().split(/\s+/u) ?? [];
  if (cpuMax.length === 2 && cpuMax[0] !== "max") {
    const quota = positiveNumber(cpuMax[0] ?? "");
    const period = positiveNumber(cpuMax[1] ?? "");
    if (quota !== null && period !== null) cpu = quota / period;
  } else {
    const quota = positiveNumber(read("/sys/fs/cgroup/cpu/cpu.cfs_quota_us") ?? "");
    const period = positiveNumber(read("/sys/fs/cgroup/cpu/cpu.cfs_period_us") ?? "");
    if (quota !== null && period !== null) cpu = quota / period;
  }

  const memoryRaw = read("/sys/fs/cgroup/memory.max") ??
    read("/sys/fs/cgroup/memory/memory.limit_in_bytes") ?? "";
  const memoryBytes = memoryRaw.trim() === "max" ? null : positiveNumber(memoryRaw);
  // Common cgroup-v1 hosts expose a near-int64 maximum when no limit exists.
  const memoryGiB = memoryBytes !== null && memoryBytes < 2 ** 50
    ? memoryBytes / 2 ** 30
    : null;
  const result: { cpu?: number; memoryGiB?: number } = {};
  if (cpu !== null) result.cpu = Number(cpu.toFixed(3));
  if (memoryGiB !== null) result.memoryGiB = Number(memoryGiB.toFixed(3));
  return Object.keys(result).length > 0 ? Object.freeze(result) : null;
}
