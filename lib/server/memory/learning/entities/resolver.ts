import {
  memoryEntityCanonicalKey,
  normalizeMemoryEntityAlias,
  type MemoryEntityType
} from "./normalization";

export type MemoryEntityResolutionCandidate = Readonly<{
  aliases: readonly string[];
  canonicalKey: string;
  entityType: MemoryEntityType;
  id: string;
  rootId: string;
}>;

export type MemoryEntityResolutionProposal = Readonly<{
  aliases: readonly string[];
  canonicalLabel: string;
  contextEntityId: string | null;
  entityType: MemoryEntityType;
  qualifiers: Readonly<Record<string, string | null>>;
}>;

export type MemoryEntityResolution = Readonly<
  | { canonicalKey: string; entityId: null; outcome: "CREATE" }
  | { canonicalKey: string; entityId: string; outcome: "REUSE" }
  | { canonicalKey: string; entityId: null; outcome: "AMBIGUOUS" }
>;

function compatible(
  left: MemoryEntityType,
  right: MemoryEntityType
): boolean {
  return left === right ||
    (left === "PRODUCT" && right === "DEVICE") ||
    (left === "DEVICE" && right === "PRODUCT");
}

/** Pure deterministic candidate order. The database repository supplies only
 * owner-scoped active roots and remains responsible for locking/race repair. */
export function resolveMemoryEntityCandidate(
  proposal: MemoryEntityResolutionProposal,
  candidates: readonly MemoryEntityResolutionCandidate[]
): MemoryEntityResolution {
  const canonicalKey = memoryEntityCanonicalKey(proposal);
  if (!canonicalKey) throw new Error("memory_entity_proposal_invalid");
  const compatibleCandidates = candidates.filter((candidate) =>
    compatible(candidate.entityType, proposal.entityType));
  if (proposal.contextEntityId !== null) {
    const context = compatibleCandidates.find((candidate) =>
      candidate.id === proposal.contextEntityId ||
      candidate.rootId === proposal.contextEntityId);
    return context
      ? { canonicalKey, entityId: context.rootId, outcome: "REUSE" }
      : { canonicalKey, entityId: null, outcome: "AMBIGUOUS" };
  }
  const canonical = compatibleCandidates.filter((candidate) =>
    candidate.canonicalKey === canonicalKey);
  if (canonical.length === 1) {
    return { canonicalKey, entityId: canonical[0]!.rootId, outcome: "REUSE" };
  }
  if (canonical.length > 1) {
    return { canonicalKey, entityId: null, outcome: "AMBIGUOUS" };
  }
  const aliases = new Set(proposal.aliases
    .map(normalizeMemoryEntityAlias)
    .filter((alias): alias is string => alias !== null));
  const aliasCandidates = proposal.entityType === "PRODUCT" ||
    proposal.entityType === "DEVICE"
    ? compatibleCandidates.filter((candidate) =>
        candidate.canonicalKey === canonicalKey)
    : compatibleCandidates;
  const exactRoots = new Set(aliasCandidates
    .filter((candidate) => candidate.aliases.some((alias) => aliases.has(alias)))
    .map((candidate) => candidate.rootId));
  if (exactRoots.size === 1) {
    return {
      canonicalKey,
      entityId: [...exactRoots][0]!,
      outcome: "REUSE"
    };
  }
  if (exactRoots.size > 1) {
    return { canonicalKey, entityId: null, outcome: "AMBIGUOUS" };
  }
  return { canonicalKey, entityId: null, outcome: "CREATE" };
}

export function resolveMemoryEntityRoot(
  id: string,
  mergedInto: ReadonlyMap<string, string | null>,
  maxDepth = 16
): string {
  const visited = new Set<string>();
  let current = id;
  for (let depth = 0; depth <= maxDepth; depth += 1) {
    if (visited.has(current)) throw new Error("memory_entity_merge_cycle");
    visited.add(current);
    const next = mergedInto.get(current);
    if (next === undefined) throw new Error("memory_entity_root_missing");
    if (next === null) return current;
    current = next;
  }
  throw new Error("memory_entity_merge_depth_exceeded");
}
