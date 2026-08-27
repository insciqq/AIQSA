import { createHash } from "node:crypto";
import type { EmbeddingProviderFamily } from "../../domain/embeddingModels";
import type { ProviderModelConfiguration } from "../providers/providerConfiguration";

export const KNOWLEDGE_INDEX_DIMENSIONS = [1024, 1536] as const;
/**
 * Version 7: language-neutral embedding document format (source title, heading
 * path, atomic evidence text only — no English labels, no page prose) and
 * model-profile token counting (model-native Qwen2 BPE for the built-in Qwen3
 * embedding profile, generic Unicode estimator otherwise). Bumping this
 * version changes embedding text, so existing ready artifacts are reindexed
 * through the safe profile-revision shadow lifecycle; version 6 and older
 * behavior stays byte-identical for their immutable revisions.
 *
 * Tokenizer identity joins the index-profile identity through this version
 * plus the vector-space fingerprint: the pair (chunking profile version,
 * upstream embedding model id hashed into the fingerprint below) selects
 * exactly one token counter, and the model-native counter's pinned asset is
 * sha256-verified at load (`tokenizer/qwen2BpeTokenizer.ts`), failing the
 * generation before activation when unverifiable. Any change to a tokenizer
 * algorithm, selection rule, or vendored asset therefore REQUIRES bumping
 * this version so accepted generations and receipts stay replayable. The
 * resolved identity label (name:version[:asset fingerprint]) is additionally
 * recorded in retrieval evidence next to the vector-space fingerprint.
 */
export const KNOWLEDGE_CHUNKING_PROFILE_VERSION = 7;
export const KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION = 3;
export const KNOWLEDGE_DOCUMENT_CONTEXT_CHUNKING_PROFILE_MIN_VERSION = 4;
export const KNOWLEDGE_CONSERVATIVE_FURNITURE_PROFILE_MIN_VERSION = 5;
/** Profiles counting chunk budgets in (estimated or model) tokens. */
export const KNOWLEDGE_TOKEN_SIZED_CHUNKING_PROFILE_MIN_VERSION = 6;
/** Profiles emitting the language-neutral embedding format with the
 * deployment-resolved model token counter. */
export const KNOWLEDGE_NEUTRAL_EMBEDDING_FORMAT_PROFILE_MIN_VERSION = 7;

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
