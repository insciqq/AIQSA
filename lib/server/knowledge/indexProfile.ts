import { createHash } from "node:crypto";
import type { EmbeddingProviderFamily } from "../../domain/embeddingModels";
import type { ProviderModelConfiguration } from "../providers/providerConfiguration";

export const KNOWLEDGE_INDEX_DIMENSIONS = [1024, 1536] as const;
export const KNOWLEDGE_CHUNKING_PROFILE_VERSION = 2;

export type KnowledgeIndexDimension = (typeof KNOWLEDGE_INDEX_DIMENSIONS)[number];

export type KnowledgeVectorSpaceConfiguration = Readonly<{
  adapterKind: "openai_embeddings_compatible";
  deploymentId: string;
  nativeDimension: number;
  providerFamily: EmbeddingProviderFamily;
  queryInstructionTemplate: string | null;
  schemaVersion: 1;
  supportsMrl: boolean;
  targetDimension: number;
  upstreamModelId: string;
}>;

export type KnowledgeVectorSpacePin = Readonly<{
  configuration: KnowledgeVectorSpaceConfiguration;
  fingerprint: string;
  indexSupported: boolean;
  targetDimension: number;
}>;

export function isKnowledgeIndexDimension(value: number): value is KnowledgeIndexDimension {
  return KNOWLEDGE_INDEX_DIMENSIONS.some((dimension) => dimension === value);
}

export function createKnowledgeVectorSpacePin(input: Readonly<{
  configuration: ProviderModelConfiguration;
  deploymentId: string;
}>): KnowledgeVectorSpacePin | null {
  const embedding = input.configuration.embedding;
  if (
    input.configuration.modelClass !== "embedding" ||
    input.configuration.adapterKind !== "openai_embeddings_compatible" ||
    !embedding
  ) {
    return null;
  }
  const configuration: KnowledgeVectorSpaceConfiguration = {
    adapterKind: "openai_embeddings_compatible",
    deploymentId: input.deploymentId,
    nativeDimension: embedding.nativeDimension,
    providerFamily: embedding.providerFamily,
    queryInstructionTemplate: embedding.queryInstructionTemplate,
    schemaVersion: 1,
    supportsMrl: embedding.supportsMrl,
    targetDimension: embedding.targetDimension,
    upstreamModelId: input.configuration.upstreamModelId
  };
  return {
    configuration,
    fingerprint: createHash("sha256").update(JSON.stringify(configuration), "utf8").digest("hex"),
    indexSupported: isKnowledgeIndexDimension(embedding.targetDimension),
    targetDimension: embedding.targetDimension
  };
}
