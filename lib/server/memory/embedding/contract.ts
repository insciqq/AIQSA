import type {
  MemoryEmbeddingState
} from "@prisma/client";
import type { MemorySecretFreeExecutionSnapshot } from "../execution/snapshot";
import { memoryExecutionSha256 } from "../execution/canonical";
import { memorySha256 } from "../persistence/lexical";

export const MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION = "memory-item-embed-v1";

export const MEMORY_ITEM_EMBEDDING_VERSIONS = Object.freeze({
  pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
  policyVersion: "memory-item-embed-policy-v1",
  promptVersion: "memory-document-embed-v1",
  retrievalConfigFingerprint:
    "memory-vector-pg16.14-pgvector0.8.5-filtered-hnsw-v2",
  schemaVersion: "memory-document-embed-result-v1"
});

const itemJobPrefix = "memory-item-embed-v1:";
const uuidCapture =
  "([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})";
const hashCapture = "([a-f0-9]{64})";
const itemJobPattern = new RegExp(
  `^${itemJobPrefix}${uuidCapture}:${hashCapture}$`,
  "u"
);

export type MemoryItemEmbeddingGeneration = Readonly<{
  embeddingConfigurationFingerprint: string | null;
  embeddingConnectionId: string | null;
  embeddingDimension: number | null;
  embeddingProviderModelId: string | null;
  id: string;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
  vectorSpaceFingerprint: string | null;
}>;

type MemoryItemEmbeddingTargetBase = Readonly<{
  embeddingState: MemoryEmbeddingState;
  entryId: string;
  generation: MemoryItemEmbeddingGeneration;
  itemId: string;
  itemType: "FACT_VERSION" | "RECALL_CHUNK";
  safeContentHash: string;
  safeSearchText: string;
  selectedEmbeddingProviderModelId: string | null;
  userId: string;
}>;

export type MemoryFactEmbeddingTarget = MemoryItemEmbeddingTargetBase & Readonly<{
  factId: string;
  factVersionId: string;
  itemType: "FACT_VERSION";
}>;

export type MemoryRecallChunkEmbeddingTarget = MemoryItemEmbeddingTargetBase & Readonly<{
  itemType: "RECALL_CHUNK";
  recallChunkId: string;
}>;

export type MemoryItemEmbeddingTarget =
  | MemoryFactEmbeddingTarget
  | MemoryRecallChunkEmbeddingTarget;

export type MemoryItemEmbeddingPin = Readonly<{
  configurationFingerprint: string;
  connectionId: string;
  dimension: number;
  providerModelId: string;
  vectorSpaceFingerprint: string;
}>;

function jobFingerprint(
  prefix: string,
  entryId: string,
  triggerIdentity: string,
  domain: string,
  pattern: RegExp
): string {
  const candidate = `${prefix}${entryId}:${memorySha256({
    domain,
    triggerIdentity,
    version: "v1"
  })}`;
  if (!pattern.test(candidate) || candidate.length > 128) {
    throw new Error("memory_item_embedding_job_identity_invalid");
  }
  return candidate;
}

export function memoryItemEmbeddingJobFingerprint(
  entryId: string,
  triggerIdentity: string
): string {
  return jobFingerprint(
    itemJobPrefix,
    entryId,
    triggerIdentity,
    "aiqsa.memory.item-embedding-trigger",
    itemJobPattern
  );
}

export type MemoryEmbeddingJobIdentity = Readonly<{
  entryId: string;
  pipelineVersion: string;
  triggerHash: string;
}>;

export function parseMemoryEmbeddingJobFingerprint(
  value: string
): MemoryEmbeddingJobIdentity | null {
  const item = itemJobPattern.exec(value);
  return item ? {
    entryId: item[1]!,
    pipelineVersion: MEMORY_ITEM_EMBEDDING_PIPELINE_VERSION,
    triggerHash: item[2]!
  } : null;
}

export function memoryItemEmbeddingInputHash(
  target: MemoryItemEmbeddingTarget
): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.item-embedding-input",
    entryId: target.entryId,
    generation: target.generation,
    itemId: target.itemId,
    itemType: target.itemType,
    safeContentHash: target.safeContentHash,
    safeSearchTextHash: memorySha256(target.safeSearchText),
    version: "v1"
  });
}

export function memoryItemEmbeddingOutputHash(input: Readonly<{
  inputHash: string;
  vector: readonly number[];
}>): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.item-embedding-output",
    inputHash: input.inputHash,
    vector: input.vector,
    version: "v1"
  });
}

export function memoryItemEmbeddingPinFromSnapshot(
  snapshot: MemorySecretFreeExecutionSnapshot
): MemoryItemEmbeddingPin | null {
  const provider = snapshot.providerExecutionSnapshot;
  const vectorSpaceFingerprint =
    snapshot.compatibilityRequirement.vectorSpaceFingerprint;
  if (
    snapshot.logicalRole !== "MEMORY_DOCUMENT_EMBED" ||
    provider.model.adapterKind !== "openai_embeddings_compatible" ||
    provider.model.modelClass !== "embedding" ||
    !provider.model.embedding ||
    !vectorSpaceFingerprint
  ) {
    return null;
  }
  const embedding = provider.model.embedding;
  return {
    configurationFingerprint:
      snapshot.compatibilityRequirement.configFingerprint,
    connectionId: provider.connectionId,
    dimension: embedding.targetDimension,
    providerModelId: provider.providerModelId,
    vectorSpaceFingerprint
  };
}

export function memoryItemEmbeddingGenerationMatchesPin(
  generation: MemoryItemEmbeddingGeneration,
  pin: MemoryItemEmbeddingPin
): boolean {
  return generation.indexMode === "HYBRID" &&
    generation.embeddingConnectionId === pin.connectionId &&
    generation.embeddingProviderModelId === pin.providerModelId &&
    generation.embeddingConfigurationFingerprint === pin.configurationFingerprint &&
    generation.embeddingDimension === pin.dimension &&
    generation.vectorSpaceFingerprint === pin.vectorSpaceFingerprint;
}
