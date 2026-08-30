import { approximateKnowledgeTokenCount } from "../chunking";
import {
  KNOWLEDGE_QWEN2_BPE_IDENTITY,
  qwen2BpeTokenCounter
} from "./qwen2BpeTokenizer";
import {
  knowledgeTokenizerIdentityLabel,
  type KnowledgeTokenCounter,
  type KnowledgeTokenizerIdentity
} from "./types";

/**
 * Deterministic tokenizer-profile resolution for Knowledge token budgets.
 *
 * The built-in Qwen3 embedding profile counts with the model-native Qwen2
 * byte-level BPE tokenizer; every other embedding deployment keeps the
 * language-neutral generic Unicode estimator (no language branches). The
 * choice is a pure function of the immutable embedding configuration pinned
 * on the profile revision/artifact, so chunking stays reproducible for an
 * accepted generation and the identity can be recorded in evidence.
 *
 * Defensive byte/code-point caps remain an independent second guard in the
 * chunking pipeline regardless of which counter is selected.
 */
export const KNOWLEDGE_GENERIC_ESTIMATOR_IDENTITY: KnowledgeTokenizerIdentity =
  Object.freeze({
    assetSha256: null,
    name: "unicode-estimator",
    version: 1
  });

const QWEN2_BPE_UPSTREAM_MODEL_IDS = new Set(["qwen/qwen3-embedding-8b"]);

export const KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER: KnowledgeTokenCounter =
  Object.freeze({
    countTokens: (text: string) => (text ? approximateKnowledgeTokenCount(text) : 0),
    identity: KNOWLEDGE_GENERIC_ESTIMATOR_IDENTITY
  });

export function knowledgeTokenizerIdentityFor(
  upstreamModelId: string
): KnowledgeTokenizerIdentity {
  return QWEN2_BPE_UPSTREAM_MODEL_IDS.has(upstreamModelId.trim().toLowerCase())
    ? KNOWLEDGE_QWEN2_BPE_IDENTITY
    : KNOWLEDGE_GENERIC_ESTIMATOR_IDENTITY;
}

/**
 * Resolves the counter for an indexing operation. When the profile selects the
 * model-native tokenizer and its pinned asset cannot be verified, this throws
 * `KnowledgeTokenizerError` — indexing must fail the generation before
 * activation instead of silently mixing counting profiles.
 */
export function requireKnowledgeTokenCounter(
  upstreamModelId: string
): KnowledgeTokenCounter {
  return knowledgeTokenizerIdentityFor(upstreamModelId) === KNOWLEDGE_QWEN2_BPE_IDENTITY
    ? qwen2BpeTokenCounter()
    : KNOWLEDGE_GENERIC_ESTIMATOR_COUNTER;
}

/**
 * Content-free tokenizer identity recorded next to profile identity in
 * evidence. Never throws: an unavailable model-native asset is reported as the
 * identity label alone (the indexing path fails separately and loudly).
 */
export function knowledgeTokenizerEvidenceLabel(upstreamModelId: string): string {
  return knowledgeTokenizerIdentityLabel(knowledgeTokenizerIdentityFor(upstreamModelId));
}
