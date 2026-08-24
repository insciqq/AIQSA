import type { PrismaClient } from "@prisma/client";
import { MEMORY_DECAY_POLICY_VERSION } from "../../../domain/memory/retrieval";
import type { MemorySettingsResponse } from "../../../contracts/memory";
import {
  memoryVectorSpaceFingerprint,
  type ResolvedMemoryExecutionTarget,
  type ResolvedMemoryUtilityPolicy
} from "../execution/policy";
import type { MemoryExecutionRole } from "../execution/roles";
import {
  MEMORY_LEXICAL_CHUNKING_VERSION,
  MEMORY_LEXICAL_LANGUAGE_PROFILE,
  MEMORY_LEXICAL_NORMALIZATION_VERSION
} from "../persistence/lexical";
import type { MemorySettingsPersistenceSnapshot } from "../persistence/settings";
import { MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION } from "../retrieval/vector";
import { MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS } from "../coordinator/workerHeartbeat";
import type { MemoryEgressConsentMode } from "../execution/consentMode";
import {
  decodeMemoryAdminDestinations,
  type MemoryAdminAcceptedDestination
} from "../execution/adminConsent";

export type MemoryCapabilityOperationalState = Readonly<{
  adminAcceptedDestinations: readonly MemoryAdminAcceptedDestination[];
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
    model.capabilities.structuredOutput === true
  );
}

function embeddingTargetAvailable(
  policy: ResolvedMemoryUtilityPolicy,
  role: "MEMORY_DOCUMENT_EMBED" | "MEMORY_QUERY_EMBED"
): boolean {
  const resolved = target(policy, role);
  const model = resolved?.snapshot.model;
  return Boolean(model && "modelClass" in model && model.modelClass === "embedding");
}

function egressAccepted(
  settings: MemorySettingsPersistenceSnapshot,
  policy: ResolvedMemoryUtilityPolicy,
  consentMode: MemoryEgressConsentMode,
  adminAcceptedDestinations: readonly MemoryAdminAcceptedDestination[],
  role: MemoryExecutionRole
): boolean {
  if (consentMode === "PER_USER") {
    return Boolean(
      settings.acceptedUtilityEgressAt &&
      settings.acceptedUtilityEgressFingerprint === policy.fingerprint &&
      settings.acceptedUtilityPolicyVersion === policy.policyVersion
    );
  }
  const resolved = target(policy, role);
  return Boolean(resolved && adminAcceptedDestinations.some((destination) =>
    destination.role === role &&
    destination.destinationFingerprint === resolved.destinationFingerprint));
}

export function deriveMemorySettingsCapabilities(input: Readonly<{
  base: MemoryCapabilityBase;
  consentMode: MemoryEgressConsentMode;
  operations: MemoryCapabilityOperationalState;
  policy: ResolvedMemoryUtilityPolicy;
  settings: MemorySettingsPersistenceSnapshot;
}>): MemorySettingsResponse["capabilities"] {
  const accepted = (role: MemoryExecutionRole) => egressAccepted(
    input.settings,
    input.policy,
    input.consentMode,
    input.operations.adminAcceptedDestinations,
    role
  );
  const strictRoleAvailable = (role: Exclude<
    MemoryExecutionRole,
    "MEMORY_DOCUMENT_EMBED" | "MEMORY_QUERY_EMBED"
  >) => strictSystemTargetAvailable(input.policy, role) && accepted(role);
  const embeddingRoleAvailable = (
    role: "MEMORY_DOCUMENT_EMBED" | "MEMORY_QUERY_EMBED"
  ) => embeddingTargetAvailable(input.policy, role) && accepted(role);
  const controlAvailable = strictRoleAvailable("MEMORY_CONTROL");
  const extractionAvailable = strictRoleAvailable("MEMORY_FACT_EXTRACT");
  const consolidationAvailable = strictRoleAvailable("MEMORY_CONSOLIDATE");
  const rerankerAvailable = strictRoleAvailable("MEMORY_RERANK");
  const synthesisTargetAvailable = strictRoleAvailable("MEMORY_SYNTHESIZE");
  const statementClassifierAvailable = strictRoleAvailable("MEMORY_STATEMENT_CLASSIFY");
  const historyClassifierAvailable = strictRoleAvailable("MEMORY_HISTORY_CLASSIFY");
  const documentEmbeddingAvailable = embeddingRoleAvailable("MEMORY_DOCUMENT_EMBED");
  const queryEmbeddingAvailable = embeddingRoleAvailable("MEMORY_QUERY_EMBED");
  const masterOn = input.settings.useMemoryFacts;
  const managementAvailable = true;
  const administratorSetupRequired = masterOn && !(
    statementClassifierAvailable &&
    controlAvailable &&
    rerankerAvailable &&
    queryEmbeddingAvailable &&
    (!input.settings.learnAutomatically ||
      extractionAvailable && consolidationAvailable && documentEmbeddingAvailable) &&
    (!input.settings.referenceChatHistory ||
      historyClassifierAvailable && documentEmbeddingAvailable) &&
    (!input.settings.synthesisEnabled ||
      synthesisTargetAvailable && input.operations.workerAvailable)
  );
  const naturalLanguageActionsAvailable = masterOn && controlAvailable &&
    statementClassifierAvailable;
  const retrievalAvailable = masterOn && controlAvailable &&
    rerankerAvailable && queryEmbeddingAvailable && input.operations.retrievalIndexAvailable;
  const automaticLearningAvailable = masterOn && input.settings.learnAutomatically &&
    extractionAvailable && consolidationAvailable && documentEmbeddingAvailable &&
    queryEmbeddingAvailable && input.operations.retrievalIndexAvailable &&
    input.operations.workerAvailable;
  const pastChatIndexingAvailable = masterOn && input.settings.referenceChatHistory &&
    historyClassifierAvailable && documentEmbeddingAvailable &&
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
    "memoryEgressAdminPolicy" | "memoryIndexGeneration" | "memoryWorkerHeartbeat"
  >,
  input: Readonly<{
    consentMode: MemoryEgressConsentMode;
    now: Date;
    policy: ResolvedMemoryUtilityPolicy;
    settings: MemorySettingsPersistenceSnapshot;
  }>
): Promise<MemoryCapabilityOperationalState> {
  const [adminPolicy, generation, heartbeat] = await Promise.all([
    input.consentMode === "ADMIN"
      ? client.memoryEgressAdminPolicy.findUnique({
          select: {
            acceptedAt: true,
            acceptedDestinations: true,
            acceptedPolicyVersion: true
          },
          where: { id: "installation" }
        })
      : Promise.resolve(null),
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
  const queryEmbedding = target(input.policy, "MEMORY_QUERY_EMBED");
  const expectedVectorSpace = queryEmbedding
    ? memoryVectorSpaceFingerprint(queryEmbedding)
    : null;
  const retrievalIndexAvailable = Boolean(
    generation &&
    queryEmbedding &&
    expectedVectorSpace &&
    generation.state === "ACTIVE" &&
    generation.indexMode === "HYBRID" &&
    generation.chunkingVersion === MEMORY_LEXICAL_CHUNKING_VERSION &&
    generation.languageProfile === MEMORY_LEXICAL_LANGUAGE_PROFILE &&
    generation.normalizationVersion === MEMORY_LEXICAL_NORMALIZATION_VERSION &&
    generation.retrievalPipelineVersion === MEMORY_VECTOR_RETRIEVAL_PIPELINE_VERSION &&
    generation.embeddingProviderModelId === input.settings.embeddingProviderModelId &&
    generation.embeddingProviderModelId === queryEmbedding.snapshot.providerModelId &&
    generation.embeddingConfigurationFingerprint ===
      queryEmbedding.compatibilityFingerprints.configFingerprint &&
    generation.vectorSpaceFingerprint === expectedVectorSpace
  );
  const nowMs = input.now.getTime();
  const workerAge = heartbeat ? nowMs - heartbeat.lastSeenAt.getTime() : Number.POSITIVE_INFINITY;

  return Object.freeze({
    adminAcceptedDestinations: Object.freeze(
      input.consentMode === "ADMIN" && adminPolicy?.acceptedAt &&
        adminPolicy.acceptedPolicyVersion === input.policy.policyVersion
        ? decodeMemoryAdminDestinations(adminPolicy?.acceptedDestinations) ?? []
        : []
    ),
    retrievalIndexAvailable,
    workerAvailable: Number.isFinite(nowMs) && workerAge >= 0 &&
      workerAge <= MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS
  });
}
