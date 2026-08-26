import { estimateApproxTokens } from "../../../domain/contextBudget";
import type { MemoryContextPack } from "../../../domain/memory/retrieval";
import { MEMORY_CONTEXT_AGGREGATION_GUIDANCE } from
  "../../../domain/memory/retrieval/packer";

export const MEMORY_AGGREGATION_OPERATIONS = [
  "COMPARE",
  "COUNT",
  "ENUMERATE",
  "ORDER",
  "RELATE"
] as const;

export const MEMORY_AGGREGATION_RESOLUTIONS = [
  "AMBIGUOUS",
  "NOT_APPLICABLE",
  "PARTIAL",
  "RESOLVED"
] as const;

export const MEMORY_AGGREGATION_ROLES = [
  "BOUNDARY",
  "EXCLUDED",
  "MEMBER",
  "MEMBER_AND_BOUNDARY",
  "SUPPORT"
] as const;

export const MEMORY_AGGREGATION_MAX_MEMBER_QUANTITY = 1_000_000;

export type MemoryAggregationOperation =
  (typeof MEMORY_AGGREGATION_OPERATIONS)[number];
export type MemoryAggregationResolution =
  (typeof MEMORY_AGGREGATION_RESOLUTIONS)[number];
export type MemoryAggregationRole = (typeof MEMORY_AGGREGATION_ROLES)[number];

export type MemoryAggregationGroup = Readonly<{
  itemHandles: readonly string[];
  occurrence: string;
  quantity: number;
  quantityEvidence: string | null;
  role: MemoryAggregationRole;
}>;

export type MemoryAggregationPlan = Readonly<{
  groups: readonly MemoryAggregationGroup[];
  operation: MemoryAggregationOperation;
  resolution: MemoryAggregationResolution;
}>;

export type MemoryAggregationGuide = Readonly<{
  boundaryCount: number;
  format: "COMPACT" | "DETAILED";
  memberCount: number;
  text: string;
  tokens: number;
}>;

function isMember(role: MemoryAggregationRole): boolean {
  return role === "MEMBER" || role === "MEMBER_AND_BOUNDARY";
}

function isBoundary(role: MemoryAggregationRole): boolean {
  return role === "BOUNDARY" || role === "MEMBER_AND_BOUNDARY";
}

function sourceLabels(handles: readonly string[]): string {
  return handles.map((handle) => {
    const index = Number.parseInt(handle.slice(1), 10);
    return `memory-item:${index + 1}`;
  }).join(", ");
}

function detailLines(
  heading: string,
  groups: readonly MemoryAggregationGroup[],
  pack: MemoryContextPack
): readonly string[] {
  return groups.length === 0
    ? []
    : [
        heading,
        ...groups.map((group, index) =>
          `- ${index + 1}. ${group.occurrence}; quantity=${group.quantity} [evidence: ${
            sourceLabels(group.itemHandles)
          }]`)
      ];
}

function memberCount(plan: MemoryAggregationPlan): number {
  const count = plan.groups.reduce((total, group) =>
    total + (isMember(group.role) ? group.quantity : 0), 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("memory_aggregation_quantity_invariant");
  }
  return count;
}

function compactGuide(
  plan: MemoryAggregationPlan,
  memberCount: number,
  boundaryCount: number
): string {
  const confidence = plan.resolution === "RESOLVED"
    ? "Use distinct_members as the exact result for a count; do not add boundary or support groups."
    : "The evidence plan is not fully resolved; state uncertainty instead of inventing a complete count.";
  return [
    "BOUNDED MEMORY AGGREGATION — server-validated organization of the evidence below.",
    `operation=${plan.operation}; resolution=${plan.resolution}; ` +
      `distinct_members=${memberCount}; boundary_events=${boundaryCount}.`,
    confidence
  ].join("\n");
}

function detailedGuide(
  plan: MemoryAggregationPlan,
  pack: MemoryContextPack,
  memberCount: number,
  boundaryCount: number
): string {
  const members = plan.groups.filter((group) => isMember(group.role));
  const boundaries = plan.groups.filter((group) => isBoundary(group.role));
  const supports = plan.groups.filter((group) => group.role === "SUPPORT");
  return [
    compactGuide(plan, memberCount, boundaryCount),
    ...detailLines("Counted or enumerated members:", members, pack),
    ...detailLines("Boundary events:", boundaries, pack),
    ...detailLines("Supporting evidence:", supports, pack)
  ].join("\n");
}

/** Replaces the generic aggregation hint already included in the pack. The
 * compact form is deliberately shorter than that reserved hint, so a resolved
 * count can always reach the answer model without exceeding the frozen Memory
 * hard cap. */
export function applyMemoryAggregationPlan(
  pack: MemoryContextPack,
  plan: MemoryAggregationPlan
): MemoryAggregationGuide {
  if (!pack.text || !pack.text.includes(MEMORY_CONTEXT_AGGREGATION_GUIDANCE)) {
    throw new Error("memory_aggregation_context_contract_invalid");
  }
  const countedMembers = memberCount(plan);
  const boundaryCount = plan.groups.filter((group) => isBoundary(group.role)).length;
  const detailed = pack.text.replace(
    MEMORY_CONTEXT_AGGREGATION_GUIDANCE,
    detailedGuide(plan, pack, countedMembers, boundaryCount)
  );
  const detailedTokens = estimateApproxTokens(detailed);
  if (detailedTokens <= pack.hardCapTokens) {
    return {
      boundaryCount,
      format: "DETAILED",
      memberCount: countedMembers,
      text: detailed,
      tokens: detailedTokens
    };
  }
  const compact = pack.text.replace(
    MEMORY_CONTEXT_AGGREGATION_GUIDANCE,
    compactGuide(plan, countedMembers, boundaryCount)
  );
  const compactTokens = estimateApproxTokens(compact);
  if (compactTokens > pack.hardCapTokens) {
    throw new Error("memory_aggregation_context_budget_invariant");
  }
  return {
    boundaryCount,
    format: "COMPACT",
    memberCount: countedMembers,
    text: compact,
    tokens: compactTokens
  };
}
