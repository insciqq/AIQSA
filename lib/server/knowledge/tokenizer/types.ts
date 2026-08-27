/**
 * Model-profile-aware token counting for Knowledge indexing and retrieval
 * formatting. A counter is deterministic for a given identity: the same text
 * always yields the same count, and the identity names the exact algorithm
 * and pinned asset fingerprint so accepted index generations and receipts
 * remain replayable.
 */
export type KnowledgeTokenizerIdentity = Readonly<{
  /** Pinned sha256 of the vendored tokenizer asset; null for asset-free counters. */
  assetSha256: string | null;
  name: string;
  version: number;
}>;

export type KnowledgeTokenCounter = Readonly<{
  countTokens(text: string): number;
  identity: KnowledgeTokenizerIdentity;
}>;

/** Bounded content-free identity string recorded in evidence surfaces. */
export function knowledgeTokenizerIdentityLabel(
  identity: KnowledgeTokenizerIdentity
): string {
  const asset = identity.assetSha256 ? `:${identity.assetSha256.slice(0, 16)}` : "";
  return `${identity.name}:${identity.version}${asset}`;
}
