import type { KnowledgeRetrievalCandidate } from "./retrievalRanking";

export type KnowledgeCanonicalSourceIdentity = Readonly<{
  artifactId: string;
  sourceId: string;
  sourceVersionId: string;
}>;

export type KnowledgeCanonicalBindingProvenance = Readonly<{
  baseName: string;
  bindingOrdinal: number;
  knowledgeBaseId: string;
}>;

export type KnowledgeCanonicalSourceBinding = KnowledgeCanonicalSourceIdentity &
  KnowledgeCanonicalBindingProvenance;

export type KnowledgeCanonicalSourceProvenance = KnowledgeCanonicalSourceIdentity & Readonly<{
  bindings: readonly KnowledgeCanonicalBindingProvenance[];
  primaryBindingOrdinal: number;
}>;

export type KnowledgeCanonicalCandidateProvenance = KnowledgeCanonicalSourceProvenance & Readonly<{
  chunkId: string;
}>;

export type KnowledgeCanonicalSourceCandidates = Readonly<{
  candidateProvenance: readonly KnowledgeCanonicalCandidateProvenance[];
  candidates: readonly KnowledgeRetrievalCandidate[];
  sourceProvenance: readonly KnowledgeCanonicalSourceProvenance[];
}>;

type CanonicalSourceCandidateShape = KnowledgeCanonicalBindingProvenance & Readonly<{
  artifactId: string;
  documentId: string;
  documentVersionId: string;
}>;

export type KnowledgeCanonicalSourceArtifactCandidates<
  Candidate extends CanonicalSourceCandidateShape
> = Readonly<{
  candidates: readonly Candidate[];
  sourceProvenance: readonly KnowledgeCanonicalSourceProvenance[];
}>;

type SourceGroup = {
  bindings: Map<number, KnowledgeCanonicalBindingProvenance>;
  candidates: KnowledgeRetrievalCandidate[];
  identity: KnowledgeCanonicalSourceIdentity;
};

function identity(candidate: Readonly<{
  artifactId?: string;
  documentId?: string;
  documentVersionId?: string;
  sourceArtifactId?: string | null;
  sourceId?: string;
  sourceVersionId?: string;
}>): KnowledgeCanonicalSourceIdentity {
  const artifactId = candidate.artifactId ?? candidate.sourceArtifactId;
  const sourceId = candidate.sourceId ?? candidate.documentId;
  const sourceVersionId = candidate.sourceVersionId ?? candidate.documentVersionId;
  if (
    !artifactId ||
    !sourceId ||
    !sourceVersionId
  ) throw new Error("knowledge_canonical_source_identity_invalid");
  return Object.freeze({
    artifactId,
    sourceId,
    sourceVersionId
  });
}

function identityKey(value: KnowledgeCanonicalSourceIdentity): string {
  return JSON.stringify([value.sourceId, value.sourceVersionId, value.artifactId]);
}

function compareIdentity(
  left: KnowledgeCanonicalSourceIdentity,
  right: KnowledgeCanonicalSourceIdentity
): number {
  return left.sourceId.localeCompare(right.sourceId) ||
    left.sourceVersionId.localeCompare(right.sourceVersionId) ||
    left.artifactId.localeCompare(right.artifactId);
}

function compareBinding(
  left: KnowledgeCanonicalBindingProvenance,
  right: KnowledgeCanonicalBindingProvenance
): number {
  return left.bindingOrdinal - right.bindingOrdinal ||
    left.knowledgeBaseId.localeCompare(right.knowledgeBaseId) ||
    left.baseName.localeCompare(right.baseName);
}

function sameEvidence(
  left: KnowledgeRetrievalCandidate,
  right: KnowledgeRetrievalCandidate
): boolean {
  return left.chunkId === right.chunkId &&
    left.chunkIndex === right.chunkIndex &&
    left.contentHash === right.contentHash &&
    left.documentId === right.documentId &&
    left.documentVersionId === right.documentVersionId &&
    left.documentVersionNumber === right.documentVersionNumber &&
    left.fileName === right.fileName &&
    left.headingPath.length === right.headingPath.length &&
    left.headingPath.every((entry, index) => entry === right.headingPath[index]) &&
    left.layoutKind === right.layoutKind &&
    left.page === right.page &&
    left.sectionId === right.sectionId &&
    left.sourceArtifactId === right.sourceArtifactId &&
    left.sourceName === right.sourceName &&
    left.text === right.text;
}

function binding(candidate: Readonly<{
  baseName: string;
  bindingOrdinal: number;
  knowledgeBaseId: string;
}>): KnowledgeCanonicalBindingProvenance {
  if (!Number.isSafeInteger(candidate.bindingOrdinal) || candidate.bindingOrdinal < 0) {
    throw new Error("knowledge_canonical_source_binding_invalid");
  }
  if (!candidate.baseName || !candidate.knowledgeBaseId) {
    throw new Error("knowledge_canonical_source_binding_invalid");
  }
  return Object.freeze({
    baseName: candidate.baseName,
    bindingOrdinal: candidate.bindingOrdinal,
    knowledgeBaseId: candidate.knowledgeBaseId
  });
}

/**
 * Chooses one deterministic Base projection for an immutable Source artifact.
 * Structured and visual retrieval operate on artifacts rather than passages,
 * so the exact Source tuple must be collapsed before either analyzer sees it.
 */
export function canonicalizeKnowledgeSourceArtifactCandidates<
  Candidate extends CanonicalSourceCandidateShape
>(
  candidates: readonly Candidate[]
): KnowledgeCanonicalSourceArtifactCandidates<Candidate> {
  const groups = new Map<string, {
    bindings: Map<number, KnowledgeCanonicalBindingProvenance>;
    candidates: Candidate[];
    identity: KnowledgeCanonicalSourceIdentity;
  }>();
  for (const candidate of candidates) {
    const sourceIdentity = identity(candidate);
    const key = identityKey(sourceIdentity);
    const group = groups.get(key) ?? {
      bindings: new Map<number, KnowledgeCanonicalBindingProvenance>(),
      candidates: [],
      identity: sourceIdentity
    };
    addBinding(group, binding(candidate));
    group.candidates.push(candidate);
    groups.set(key, group);
  }

  const canonicalCandidates: Candidate[] = [];
  const sourceProvenance: KnowledgeCanonicalSourceProvenance[] = [];
  for (const group of [...groups.values()].sort((left, right) =>
    compareIdentity(left.identity, right.identity))) {
    const bindings = Object.freeze([...group.bindings.values()].sort(compareBinding));
    const primaryBinding = bindings[0];
    if (!primaryBinding) throw new Error("knowledge_canonical_source_binding_invalid");
    const representative = group.candidates.find((candidate) =>
      candidate.bindingOrdinal === primaryBinding.bindingOrdinal &&
      candidate.knowledgeBaseId === primaryBinding.knowledgeBaseId);
    if (!representative) throw new Error("knowledge_canonical_source_candidate_invalid");
    canonicalCandidates.push(representative);
    sourceProvenance.push(Object.freeze({
      ...group.identity,
      bindings,
      primaryBindingOrdinal: primaryBinding.bindingOrdinal
    }));
  }
  return Object.freeze({
    candidates: Object.freeze(canonicalCandidates),
    sourceProvenance: Object.freeze(sourceProvenance)
  });
}

function addBinding(
  group: Readonly<{ bindings: Map<number, KnowledgeCanonicalBindingProvenance> }>,
  value: KnowledgeCanonicalBindingProvenance
): void {
  const existing = group.bindings.get(value.bindingOrdinal);
  if (existing && (
    existing.baseName !== value.baseName ||
    existing.knowledgeBaseId !== value.knowledgeBaseId
  )) throw new Error("knowledge_canonical_source_binding_conflict");
  group.bindings.set(value.bindingOrdinal, value);
}

/**
 * Collapses the same immutable Source artifact admitted through multiple Bases.
 * The lowest binding ordinal owns the legacy singular binding fields. Only that
 * binding's signals contribute when it returned the passage, so selecting A+B
 * cannot improve a Source's lexical/vector/fusion score over selecting A alone.
 */
export function canonicalizeKnowledgeSourceCandidates(
  candidates: readonly KnowledgeRetrievalCandidate[],
  sourceBindings: readonly KnowledgeCanonicalSourceBinding[] = []
): KnowledgeCanonicalSourceCandidates {
  const groups = new Map<string, SourceGroup>();
  const chunkOwners = new Map<string, string>();
  for (const candidate of candidates) {
    const sourceIdentity = identity(candidate);
    const sourceKey = identityKey(sourceIdentity);
    const existingOwner = chunkOwners.get(candidate.chunkId);
    if (existingOwner && existingOwner !== sourceKey) {
      throw new Error("knowledge_canonical_source_candidate_conflict");
    }
    chunkOwners.set(candidate.chunkId, sourceKey);

    const group = groups.get(sourceKey) ?? {
      bindings: new Map<number, KnowledgeCanonicalBindingProvenance>(),
      candidates: [],
      identity: sourceIdentity
    };
    const candidateBinding = binding(candidate);
    addBinding(group, candidateBinding);
    group.candidates.push(candidate);
    groups.set(sourceKey, group);
  }
  for (const sourceBinding of sourceBindings) {
    const sourceKey = identityKey(sourceBinding);
    const group = groups.get(sourceKey);
    if (!group) continue;
    const bindingProvenance = binding({
      ...group.candidates[0]!,
      baseName: sourceBinding.baseName,
      bindingOrdinal: sourceBinding.bindingOrdinal,
      knowledgeBaseId: sourceBinding.knowledgeBaseId
    });
    addBinding(group, bindingProvenance);
  }

  const canonicalCandidates: KnowledgeRetrievalCandidate[] = [];
  const candidateProvenance: KnowledgeCanonicalCandidateProvenance[] = [];
  const sourceProvenance: KnowledgeCanonicalSourceProvenance[] = [];
  for (const group of [...groups.values()].sort((left, right) =>
    compareIdentity(left.identity, right.identity))) {
    const bindings = Object.freeze([...group.bindings.values()].sort(compareBinding));
    const primaryBinding = bindings[0];
    if (!primaryBinding) throw new Error("knowledge_canonical_source_binding_invalid");
    const provenance = Object.freeze({
      ...group.identity,
      bindings,
      primaryBindingOrdinal: primaryBinding.bindingOrdinal
    });
    sourceProvenance.push(provenance);

    const byChunk = new Map<string, KnowledgeRetrievalCandidate[]>();
    for (const candidate of group.candidates) {
      const entries = byChunk.get(candidate.chunkId) ?? [];
      entries.push(candidate);
      byChunk.set(candidate.chunkId, entries);
    }
    for (const [chunkId, entries] of [...byChunk.entries()].sort(([left], [right]) =>
      left.localeCompare(right))) {
      const ordered = [...entries].sort((left, right) =>
        left.bindingOrdinal - right.bindingOrdinal ||
        left.knowledgeBaseId.localeCompare(right.knowledgeBaseId));
      const representative = ordered.find((candidate) =>
        candidate.bindingOrdinal === primaryBinding.bindingOrdinal);
      if (!representative || ordered.some((candidate) =>
        !sameEvidence(representative, candidate))) {
        throw new Error("knowledge_canonical_source_candidate_conflict");
      }
      canonicalCandidates.push(Object.freeze({
        ...representative,
        baseName: primaryBinding.baseName,
        bindingOrdinal: primaryBinding.bindingOrdinal,
        knowledgeBaseId: primaryBinding.knowledgeBaseId,
        signals: Object.freeze([...representative.signals])
      }));
      candidateProvenance.push(Object.freeze({
        ...provenance,
        chunkId
      }));
    }
  }

  return Object.freeze({
    candidateProvenance: Object.freeze(candidateProvenance),
    candidates: Object.freeze(canonicalCandidates),
    sourceProvenance: Object.freeze(sourceProvenance)
  });
}
