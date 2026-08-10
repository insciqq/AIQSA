import type { MemoryEmbeddingState } from "@prisma/client";
import type { MemorySecretFreeExecutionSnapshot } from "../execution/snapshot";
import { memoryExecutionSha256 } from "../execution/canonical";
import { memorySha256 } from "../persistence/lexical";

export const MEMORY_EXPLICIT_EMBEDDING_PIPELINE_VERSION =
  "memory-explicit-embed-v1";

export const MEMORY_EXPLICIT_EMBEDDING_VERSIONS = Object.freeze({
  pipelineVersion: MEMORY_EXPLICIT_EMBEDDING_PIPELINE_VERSION,
  policyVersion: "memory-explicit-embed-policy-v1",
  promptVersion: "memory-document-embed-v1",
  retrievalConfigFingerprint: "memory-explicit-vector-v1",
  schemaVersion: "memory-document-embed-result-v1"
});

const jobPrefix = "memory-explicit-embed-v1:";
const jobPattern = new RegExp(
  `^${jobPrefix}([a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}):([a-f0-9]{64})$`,
  "u"
);

export type MemoryExplicitEmbeddingGeneration = Readonly<{
  embeddingConfigurationFingerprint: string | null;
  embeddingConnectionId: string | null;
  embeddingDimension: number | null;
  embeddingProviderModelId: string | null;
  id: string;
  indexMode: "HYBRID" | "LEXICAL_ONLY";
  vectorSpaceFingerprint: string | null;
}>;

export type MemoryExplicitEmbeddingTarget = Readonly<{
  embeddingState: MemoryEmbeddingState;
  entryId: string;
  factId: string;
  factVersionId: string;
  generation: MemoryExplicitEmbeddingGeneration;
  safeContentHash: string;
  safeSearchText: string;
  selectedEmbeddingProviderModelId: string | null;
  userId: string;
}>;

export type MemoryExplicitEmbeddingPin = Readonly<{
  configurationFingerprint: string;
  connectionId: string;
  dimension: number;
  providerModelId: string;
  vectorSpaceFingerprint: string;
}>;

export function memoryExplicitEmbeddingJobFingerprint(
  entryId: string,
  triggerIdentity: string
): string {
  const candidate = `${jobPrefix}${entryId}:${memorySha256({
    domain: "aiqsa.memory.explicit-embedding-trigger",
    triggerIdentity,
    version: "v1"
  })}`;
  if (!jobPattern.test(candidate) || candidate.length > 128) {
    throw new Error("memory_explicit_embedding_job_identity_invalid");
  }
  return candidate;
}

export function parseMemoryExplicitEmbeddingJobFingerprint(
  value: string
): Readonly<{ entryId: string; triggerHash: string }> | null {
  const match = jobPattern.exec(value);
  return match ? { entryId: match[1]!, triggerHash: match[2]! } : null;
}

export function memoryExplicitEmbeddingInputHash(
  target: MemoryExplicitEmbeddingTarget
): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.explicit-embedding-input",
    entryId: target.entryId,
    factVersionId: target.factVersionId,
    generation: target.generation,
    safeContentHash: target.safeContentHash,
    safeSearchTextHash: memorySha256(target.safeSearchText),
    version: "v1"
  });
}

export function memoryExplicitEmbeddingOutputHash(input: Readonly<{
  inputHash: string;
  vector: readonly number[];
}>): string {
  return memoryExecutionSha256({
    domain: "aiqsa.memory.explicit-embedding-output",
    inputHash: input.inputHash,
    vector: input.vector,
    version: "v1"
  });
}

export function memoryExplicitEmbeddingPinFromSnapshot(
  snapshot: MemorySecretFreeExecutionSnapshot
): MemoryExplicitEmbeddingPin | null {
  const provider = snapshot.providerExecutionSnapshot;
  const vectorSpaceFingerprint =
    snapshot.qualificationRequirement.vectorSpaceFingerprint;
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
      snapshot.qualificationRequirement.configFingerprint,
    connectionId: provider.connectionId,
    dimension: embedding.targetDimension,
    providerModelId: provider.providerModelId,
    vectorSpaceFingerprint
  };
}

export function memoryExplicitEmbeddingGenerationMatchesPin(
  generation: MemoryExplicitEmbeddingGeneration,
  pin: MemoryExplicitEmbeddingPin
): boolean {
  return generation.indexMode === "HYBRID" &&
    generation.embeddingConnectionId === pin.connectionId &&
    generation.embeddingProviderModelId === pin.providerModelId &&
    generation.embeddingConfigurationFingerprint === pin.configurationFingerprint &&
    generation.embeddingDimension === pin.dimension &&
    generation.vectorSpaceFingerprint === pin.vectorSpaceFingerprint;
}
