import { createHash } from "node:crypto";
import type { EmbeddingProviderFamily } from "../../domain/embeddingModels";
import type { ProviderModelConfiguration } from "../providers/providerConfiguration";

export const KNOWLEDGE_INDEX_DIMENSIONS = [1024, 1536] as const;
/**
 * Version 12 requires independent table-header evidence and normalizes
 * decimal observations exactly within fixed string bounds. Older artifact
 * profiles retain their original projection and numeric semantics.
 *
 * Version 11: a headerless table row may expose one explicit inline
 * label/value association only when the complete bounded row contains exactly
 * two non-empty cells, the leading cell has a conservative label shape, and
 * the table is a singleton or the cells have a structural gap. Other
 * headerless rows remain association-ambiguous. Version 10 remains
 * byte-identical for immutable revisions.
 *
 * Version 10: repeated edge furniture is deduplicated without deleting its
 * only retrievable occurrence. This preserves document-level facts carried in
 * repeated letterheads and report headers while preventing page-by-page spam.
 * Version 9 remains byte-identical for immutable revisions.
 *
 * Version 9 introduced geometry-aware inline reference separation. Isolated superscript
 * markers no longer merge into body evidence, while the referenced footnote
 * text remains independently chunkable. Version 8 remains byte-identical for
 * immutable revisions.
 *
 * Version 8 introduced language-neutral, page-fragment-aware table header lineage.
 * When separate table blocks on different pages repeat the same complete
 * first row, that row is treated as an authoritative repeated header and is
 * carried into every atomic data-row chunk. Version 7 remains byte-identical
 * for immutable revisions.
 *
 * Version 7 introduced the language-neutral embedding document format (source title, heading
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
export const KNOWLEDGE_CHUNKING_PROFILE_VERSION = 12;
export const KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION = 3;
export const KNOWLEDGE_DOCUMENT_CONTEXT_CHUNKING_PROFILE_MIN_VERSION = 4;
export const KNOWLEDGE_CONSERVATIVE_FURNITURE_PROFILE_MIN_VERSION = 5;
/** Profiles counting chunk budgets in (estimated or model) tokens. */
export const KNOWLEDGE_TOKEN_SIZED_CHUNKING_PROFILE_MIN_VERSION = 6;
/** Profiles emitting the language-neutral embedding format with the
 * deployment-resolved model token counter. */
export const KNOWLEDGE_NEUTRAL_EMBEDDING_FORMAT_PROFILE_MIN_VERSION = 7;
/** Profiles recognizing exact repeated headers across page-separated table fragments. */
export const KNOWLEDGE_REPEATED_TABLE_HEADER_PROFILE_MIN_VERSION = 8;
/** Profiles that classify and suppress geometry-proven inline reference glyphs. */
export const KNOWLEDGE_INLINE_REFERENCE_PROFILE_MIN_VERSION = 9;
/** Profiles preserving one canonical occurrence of geometry-proven repeated furniture. */
export const KNOWLEDGE_CANONICAL_FURNITURE_PROFILE_MIN_VERSION = 10;
/** Profiles recognizing one structurally explicit inline label/value row. */
export const KNOWLEDGE_INLINE_PAIR_PROFILE_MIN_VERSION = 11;
/** Header interpretation needs corroborating schema roles or dated-series
 * structure. Headerless forms retain raw cells and association ambiguity. */
export const KNOWLEDGE_SAFE_TABLE_HEADER_PROFILE_MIN_VERSION = 12;
export const KNOWLEDGE_EXACT_OBSERVATION_NORMALIZATION_PROFILE_MIN_VERSION = 12;

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
