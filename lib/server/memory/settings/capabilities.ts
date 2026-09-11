import type { PrismaClient } from "@prisma/client";
import { MEMORY_DECAY_POLICY_VERSION } from "../../../domain/memory/retrieval";
import type { MemorySettingsResponse } from "../../../contracts/memory";
import {
  type ResolvedMemoryExecutionTarget,
  type ResolvedMemoryUtilityPolicy
} from "../execution/policy";
import type { MemoryExecutionRole } from "../execution/roles";
import { memoryRoleRequiresForcedToolCall } from "../execution/roles";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_ANALYSIS_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION,
  MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
} from "../persistence/lexical";
import type { MemorySettingsPersistenceSnapshot } from "../persistence/settings";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import { MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS } from "../coordinator/workerHeartbeat";

export type MemoryCapabilityOperationalState = Readonly<{
  retrievalIndexAvailable: boolean;
  workerAvailable: boolean;
}>;

type MemoryCapabilityBase = Readonly<{
  permanentChatDeletion: boolean;
  temporaryChats: boolean;
}>;

function target(
  policy: ResolvedMemoryUtilityPolicy,
  role: MemoryExecutionRole
): ResolvedMemoryExecutionTarget | null {
  return policy.targets.get(role) ?? null;
}

function strictSystemTargetAvailable(
  policy: ResolvedMemoryUtilityPolicy,
  role: MemoryExecutionRole
): boolean {
  const resolved = target(policy, role);
  const model = resolved?.snapshot.model;
  return Boolean(
    model &&
    "modelClass" in model &&
    model.modelClass === "answer" &&
    model.capabilities.toolCalling === true &&
    (memoryRoleRequiresForcedToolCall(role)
      ? model.capabilities.forcedToolCalling === true
      : model.capabilities.structuredOutput === true)
  );
}

export function deriveMemorySettingsCapabilities(input: Readonly<{
  base: MemoryCapabilityBase;
  operations: MemoryCapabilityOperationalState;
  policy: ResolvedMemoryUtilityPolicy;
  settings: MemorySettingsPersistenceSnapshot;
}>): MemorySettingsResponse["capabilities"] {
  const strictRoleAvailable = (role: Exclude<
    MemoryExecutionRole,
    "MEMORY_DOCUMENT_EMBED" | "MEMORY_QUERY_EMBED"
  >) => strictSystemTargetAvailable(input.policy, role);
  const controlAvailable = strictRoleAvailable("MEMORY_CONTROL");
  const extractionAvailable = strictRoleAvailable("MEMORY_FACT_EXTRACT");
  const consolidationAvailable = strictRoleAvailable("MEMORY_CONSOLIDATE");
  const synthesisTargetAvailable = strictRoleAvailable("MEMORY_SYNTHESIZE");
  const masterOn = input.settings.useMemoryFacts;
  const managementAvailable = true;
  const administratorSetupRequired = masterOn && !(
    (!input.settings.learnAutomatically ||
      extractionAvailable && consolidationAvailable) &&
    (!input.settings.synthesisEnabled ||
      synthesisTargetAvailable && input.operations.workerAvailable)
  );
  const naturalLanguageActionsAvailable = masterOn && controlAvailable;
  // Query embeddings and reranking are optional accelerators. The local
  // planner plus the active lexical generation remain a complete read path.
  const retrievalAvailable = masterOn && input.operations.retrievalIndexAvailable;
  const automaticLearningAvailable = masterOn && input.settings.learnAutomatically &&
    extractionAvailable && consolidationAvailable &&
    input.operations.retrievalIndexAvailable &&
    input.operations.workerAvailable;
  const pastChatIndexingAvailable = masterOn && input.settings.referenceChatHistory &&
    input.operations.retrievalIndexAvailable && input.operations.workerAvailable;
  const synthesisAvailable = masterOn && input.settings.synthesisEnabled &&
    synthesisTargetAvailable && input.operations.workerAvailable;
  const decayAvailable = masterOn && input.settings.decayEnabled &&
    input.settings.decayPolicyVersion === MEMORY_DECAY_POLICY_VERSION &&
    retrievalAvailable;

  return Object.freeze({
    administratorSetupRequired,
    automaticLearning: automaticLearningAvailable,
    automaticLearningAvailable,
    decayAvailable,
    explicitMemory: managementAvailable,
    historyRecall: pastChatIndexingAvailable,
    managementAvailable,
    naturalLanguageActionsAvailable,
    pastChatIndexingAvailable,
    permanentChatDeletion: input.base.permanentChatDeletion,
    retrievalAvailable,
    synthesisAvailable,
    temporaryChats: input.base.temporaryChats
  });
}

export async function readMemoryCapabilityOperationalState(
  client: Pick<
    PrismaClient,
    "memoryIndexGeneration" | "memoryWorkerHeartbeat"
  >,
  input: Readonly<{
    now: Date;
    settings: MemorySettingsPersistenceSnapshot;
  }>
): Promise<MemoryCapabilityOperationalState> {
  const [generation, heartbeat] = await Promise.all([
    input.settings.activeIndexGenerationId
      ? client.memoryIndexGeneration.findFirst({
          select: {
            chunkingVersion: true,
            embeddingConfigurationFingerprint: true,
            embeddingProviderModelId: true,
            indexMode: true,
            languageProfile: true,
            normalizationVersion: true,
            retrievalPipelineVersion: true,
            state: true,
            vectorSpaceFingerprint: true
          },
          where: {
            id: input.settings.activeIndexGenerationId,
            userId: input.settings.userId
          }
        })
      : Promise.resolve(null),
    client.memoryWorkerHeartbeat.findUnique({
      select: { lastSeenAt: true },
      where: { id: "installation" }
    })
  ]);
  const indexMode = generation?.indexMode;
  const expectedRetrievalPipeline = indexMode === "HYBRID"
    ? MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION
    : indexMode === "LEXICAL_ONLY"
      ? MEMORY_LEXICAL_RETRIEVAL_PIPELINE_VERSION
      : null;
  const retrievalIndexAvailable = Boolean(
    generation &&
    generation.state === "ACTIVE" &&
    (indexMode === "HYBRID" || indexMode === "LEXICAL_ONLY") &&
    generation.chunkingVersion === MEMORY_LEXICAL_CHUNKING_VERSION &&
    generation.languageProfile === MEMORY_LEXICAL_ANALYSIS_PROFILE &&
    generation.normalizationVersion === MEMORY_LEXICAL_NORMALIZATION_VERSION &&
    generation.retrievalPipelineVersion === expectedRetrievalPipeline
  );
  const nowMs = input.now.getTime();
  const workerAge = heartbeat ? nowMs - heartbeat.lastSeenAt.getTime() : Number.POSITIVE_INFINITY;

  return Object.freeze({
    retrievalIndexAvailable,
    workerAvailable: Number.isFinite(nowMs) && workerAge >= 0 &&
      workerAge <= MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS
  });
}
