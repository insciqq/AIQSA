import { estimateApproxTokens } from "../../../domain/contextBudget";
import {
  MEMORY_CARDINALITY_PARSER_VERSION,
  parseMemoryCardinality,
  type MemoryCardinalityRejectionReason,
  type MemoryContextPack
} from "../../../domain/memory/retrieval";
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

export const MEMORY_AGGREGATION_STATES = [
  "NOT_REQUESTED",
  "DETERMINISTIC_RESOLVED",
  "DETERMINISTIC_PARTIAL",
  "READER_REQUIRED",
  "READER_REQUIRED_UNSUPPORTED_QUANTITY",
  "READER_REQUIRED_AMBIGUOUS_OVERLAP",
  "UNAVAILABLE_MANDATORY_EVIDENCE"
] as const;

export const MEMORY_AGGREGATION_OVERLAP_RESOLUTIONS = [
  "NOT_APPLICABLE",
  "PROVEN_DISJOINT_UNION",
  "UNRESOLVED"
] as const;

export const MEMORY_AGGREGATION_POLICY_VERSION =
  "memory-reader-aggregation-policy-v14";

export type MemoryAggregationOperation =
  (typeof MEMORY_AGGREGATION_OPERATIONS)[number];
export type MemoryAggregationResolution =
  (typeof MEMORY_AGGREGATION_RESOLUTIONS)[number];
export type MemoryAggregationRole = (typeof MEMORY_AGGREGATION_ROLES)[number];
export type MemoryAggregationState = (typeof MEMORY_AGGREGATION_STATES)[number];
export type MemoryAggregationOverlapResolution =
  (typeof MEMORY_AGGREGATION_OVERLAP_RESOLUTIONS)[number];

export type MemorySourceBoundCardinalityEvidence = Readonly<{
  context: "EXACT_NOUN_COUNT";
  endOffset: number;
  exactText: string;
  kind: "SOURCE_CARDINALITY";
  languageTag: string;
  sourceField: "EXACT_SAFE_TEXT" | "RAW_SAFE_TEXT";
  sourceHandle: string;
  startOffset: number;
}>;

export type MemoryAggregationQuantityEvidence =
  | MemorySourceBoundCardinalityEvidence
  | Readonly<{
      identityRoot: string;
      kind: "INDIVIDUAL_OCCURRENCE";
    }>;

export type MemoryAggregationGroup = Readonly<{
  cardinalityEvidence: MemoryAggregationQuantityEvidence | null;
  itemHandles: readonly string[];
  occurrence: string;
  role: MemoryAggregationRole;
}>;

export type MemoryAggregationPlan = Readonly<{
  groups: readonly MemoryAggregationGroup[];
  operation: MemoryAggregationOperation;
  overlapResolution: MemoryAggregationOverlapResolution;
  resolution: MemoryAggregationResolution;
}>;

export type MemoryAggregationGuide = Readonly<{
  boundaryCount: number;
  format: "COMPACT" | "DETAILED";
  memberCount: number;
  text: string;
  tokens: number;
}>;

export type MemoryAggregationCardinalityMetrics = Readonly<{
  acceptedCount: number;
  parserVersion: typeof MEMORY_CARDINALITY_PARSER_VERSION;
  reasonCounts: Readonly<Partial<Record<MemoryCardinalityRejectionReason, number>>>;
  rejectedCount: number;
}>;

export type MemoryAggregationApplication = Readonly<{
  cardinalityMetrics: MemoryAggregationCardinalityMetrics;
  failureReason: string | null;
  guide: MemoryAggregationGuide | null;
  state: MemoryAggregationState;
}>;

type ResolvedMemoryAggregationGroup = Readonly<{
  identityKey: string | null;
  itemHandles: readonly string[];
  occurrence: string;
  quantity: number;
  role: MemoryAggregationRole;
}>;

type ResolvedMemoryAggregationPlan = Readonly<{
  groups: readonly ResolvedMemoryAggregationGroup[];
  operation: MemoryAggregationOperation;
  resolution: MemoryAggregationResolution;
}>;

function isMember(role: MemoryAggregationRole): boolean {
  return role === "MEMBER" || role === "MEMBER_AND_BOUNDARY";
}

function isBoundary(role: MemoryAggregationRole): boolean {
  return role === "BOUNDARY" || role === "MEMBER_AND_BOUNDARY";
}

function cardinalityMetrics(
  acceptedCount = 0,
  rejectedReason: MemoryCardinalityRejectionReason | null = null
): MemoryAggregationCardinalityMetrics {
  return Object.freeze({
    acceptedCount,
    parserVersion: MEMORY_CARDINALITY_PARSER_VERSION,
    reasonCounts: Object.freeze(rejectedReason ? { [rejectedReason]: 1 } : {}),
    rejectedCount: rejectedReason ? 1 : 0
  });
}

function unappliedAggregation(
  state: MemoryAggregationState,
  failureReason: string | null,
  metrics = cardinalityMetrics()
): MemoryAggregationApplication {
  return Object.freeze({
    cardinalityMetrics: metrics,
    failureReason,
    guide: null,
    state
  });
}

function groupContainsModelNumericField(group: MemoryAggregationGroup): boolean {
  const input = group as unknown as Record<string, unknown>;
  return ["member_count", "memberCount", "quantity", "total"]
    .some((field) => typeof input[field] === "number");
}

function packedItemsForHandles(
  handles: readonly string[],
  pack: MemoryContextPack
): readonly MemoryContextPack["items"][number][] | null {
  if (handles.length < 1 || new Set(handles).size !== handles.length) return null;
  const items = handles.map((handle) => {
    if (!/^i(?:0|[1-9]\d*)$/u.test(handle)) return null;
    const index = Number.parseInt(handle.slice(1), 10);
    return pack.items[index] ?? null;
  });
  return items.some((item) => item === null)
    ? null
    : items as readonly MemoryContextPack["items"][number][];
}

function sourceBoundText(
  evidence: MemorySourceBoundCardinalityEvidence,
  groupItems: readonly MemoryContextPack["items"][number][]
): string | null {
  const item = groupItems.find(({ evidenceHandle }) =>
    evidenceHandle === evidence.sourceHandle);
  if (!item || !Number.isSafeInteger(evidence.startOffset) ||
    !Number.isSafeInteger(evidence.endOffset) || evidence.startOffset < 0 ||
    evidence.endOffset <= evidence.startOffset) return null;
  const source = evidence.sourceField === "EXACT_SAFE_TEXT"
    ? item.exactSafeText
    : item.rawSafeText;
  if (evidence.endOffset > source.length ||
    source.slice(evidence.startOffset, evidence.endOffset) !== evidence.exactText) {
    return null;
  }
  return source;
}

type GroupResolution =
  | Readonly<{
      acceptedCount: number;
      group: ResolvedMemoryAggregationGroup;
      status: "READY";
    }>
  | Readonly<{
      acceptedCount: number;
      failureReason: string;
      rejectionReason: MemoryCardinalityRejectionReason | null;
      state: MemoryAggregationState;
      status: "UNAVAILABLE";
    }>;

function resolveAggregationGroup(
  group: MemoryAggregationGroup,
  pack: MemoryContextPack
): GroupResolution {
  if (groupContainsModelNumericField(group)) {
    return {
      acceptedCount: 0,
      failureReason: "memory_aggregation_model_numeric_field_rejected",
      rejectionReason: null,
      state: "READER_REQUIRED_UNSUPPORTED_QUANTITY",
      status: "UNAVAILABLE"
    };
  }
  const groupItems = packedItemsForHandles(group.itemHandles, pack);
  if (!groupItems || typeof group.occurrence !== "string" ||
    group.occurrence.length < 1 || group.occurrence.length > 4_000 ||
    group.occurrence.includes("\u0000")) {
    return {
      acceptedCount: 0,
      failureReason: "memory_aggregation_source_binding_invalid",
      rejectionReason: null,
      state: "UNAVAILABLE_MANDATORY_EVIDENCE",
      status: "UNAVAILABLE"
    };
  }
  if (!isMember(group.role)) {
    if (group.cardinalityEvidence !== null) {
      return {
        acceptedCount: 0,
        failureReason: "memory_aggregation_non_member_quantity_rejected",
        rejectionReason: null,
        state: "READER_REQUIRED_UNSUPPORTED_QUANTITY",
        status: "UNAVAILABLE"
      };
    }
    return {
      acceptedCount: 0,
      group: {
        identityKey: null,
        itemHandles: group.itemHandles,
        occurrence: group.occurrence,
        quantity: 0,
        role: group.role
      },
      status: "READY"
    };
  }
  const evidence = group.cardinalityEvidence;
  if (!evidence) {
    return {
      acceptedCount: 0,
      failureReason: "memory_aggregation_quantity_evidence_missing",
      rejectionReason: null,
      state: "READER_REQUIRED_UNSUPPORTED_QUANTITY",
      status: "UNAVAILABLE"
    };
  }
  if (evidence.kind === "INDIVIDUAL_OCCURRENCE") {
    if (typeof evidence.identityRoot !== "string" ||
      evidence.identityRoot.length < 1 || evidence.identityRoot.length > 512 ||
      evidence.identityRoot.includes("\u0000")) {
      return {
        acceptedCount: 0,
        failureReason: "memory_aggregation_identity_root_invalid",
        rejectionReason: null,
        state: "UNAVAILABLE_MANDATORY_EVIDENCE",
        status: "UNAVAILABLE"
      };
    }
    return {
      acceptedCount: 0,
      group: {
        identityKey: `identity:${evidence.identityRoot}`,
        itemHandles: group.itemHandles,
        occurrence: group.occurrence,
        quantity: 1,
        role: group.role
      },
      status: "READY"
    };
  }
  if (sourceBoundText(evidence, groupItems) === null) {
    return {
      acceptedCount: 0,
      failureReason: "memory_aggregation_source_binding_invalid",
      rejectionReason: null,
      state: "UNAVAILABLE_MANDATORY_EVIDENCE",
      status: "UNAVAILABLE"
    };
  }
  const parsed = parseMemoryCardinality({
    context: evidence.context,
    exactText: evidence.exactText,
    languageTag: evidence.languageTag
  });
  if (parsed.status === "REJECTED") {
    return {
      acceptedCount: 0,
      failureReason: "memory_aggregation_quantity_unsupported",
      rejectionReason: parsed.reason,
      state: "READER_REQUIRED_UNSUPPORTED_QUANTITY",
      status: "UNAVAILABLE"
    };
  }
  return {
    acceptedCount: 1,
    group: {
      identityKey: `span:${evidence.sourceHandle}:${evidence.sourceField}:` +
        `${evidence.startOffset}:${evidence.endOffset}`,
      itemHandles: group.itemHandles,
      occurrence: group.occurrence,
      quantity: parsed.value,
      role: group.role
    },
    status: "READY"
  };
}

function mergeDuplicateGroups(
  groups: readonly ResolvedMemoryAggregationGroup[]
): readonly ResolvedMemoryAggregationGroup[] {
  const merged: ResolvedMemoryAggregationGroup[] = [];
  const positions = new Map<string, number>();
  for (const group of groups) {
    if (!group.identityKey || !isMember(group.role)) {
      merged.push(group);
      continue;
    }
    const existingIndex = positions.get(group.identityKey);
    if (existingIndex === undefined) {
      positions.set(group.identityKey, merged.length);
      merged.push(group);
      continue;
    }
    const existing = merged[existingIndex]!;
    merged[existingIndex] = {
      ...existing,
      itemHandles: Object.freeze(Array.from(new Set([
        ...existing.itemHandles,
        ...group.itemHandles
      ]))),
      role: existing.role === "MEMBER_AND_BOUNDARY" ||
        group.role === "MEMBER_AND_BOUNDARY"
        ? "MEMBER_AND_BOUNDARY"
        : "MEMBER"
    };
  }
  return Object.freeze(merged);
}

function sourceLabels(handles: readonly string[], pack: MemoryContextPack): string {
  return handles.map((handle) => {
    if (!/^i\d+$/u.test(handle)) {
      throw new Error("memory_aggregation_evidence_handle_invalid");
    }
    const index = Number.parseInt(handle.slice(1), 10);
    const evidenceHandle = pack.items[index]?.evidenceHandle;
    if (!evidenceHandle) {
      throw new Error("memory_aggregation_evidence_handle_invalid");
    }
    return evidenceHandle;
  }).join(", ");
}

function safeOccurrence(value: string): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/>/gu, "\\u003e")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

function detailLines(
  heading: string,
  groups: readonly ResolvedMemoryAggregationGroup[],
  pack: MemoryContextPack
): readonly string[] {
  return groups.length === 0
    ? []
    : [
        heading,
        ...groups.map((group, index) =>
          `- ${index + 1}. occurrence=${safeOccurrence(group.occurrence)}; ` +
          `quantity=${group.quantity} [evidence: ${
            sourceLabels(group.itemHandles, pack)
          }]`)
      ];
}

function memberCount(plan: ResolvedMemoryAggregationPlan): number {
  const count = plan.groups.reduce((total, group) =>
    total + (isMember(group.role) ? group.quantity : 0), 0);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("memory_aggregation_quantity_invariant");
  }
  return count;
}

function compactGuide(
  plan: ResolvedMemoryAggregationPlan,
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
  plan: ResolvedMemoryAggregationPlan,
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
): MemoryAggregationApplication {
  if (!pack.text || !pack.text.includes(MEMORY_CONTEXT_AGGREGATION_GUIDANCE)) {
    return unappliedAggregation(
      "UNAVAILABLE_MANDATORY_EVIDENCE",
      "memory_aggregation_context_contract_invalid"
    );
  }
  if (!(MEMORY_AGGREGATION_OPERATIONS as readonly string[]).includes(plan.operation) ||
    !(MEMORY_AGGREGATION_RESOLUTIONS as readonly string[]).includes(plan.resolution) ||
    !(MEMORY_AGGREGATION_OVERLAP_RESOLUTIONS as readonly string[])
      .includes(plan.overlapResolution) || plan.groups.length > 400) {
    return unappliedAggregation(
      "UNAVAILABLE_MANDATORY_EVIDENCE",
      "memory_aggregation_plan_invalid"
    );
  }
  if (plan.resolution === "NOT_APPLICABLE") {
    return unappliedAggregation("READER_REQUIRED", null);
  }
  if (plan.resolution === "AMBIGUOUS") {
    return unappliedAggregation("READER_REQUIRED_AMBIGUOUS_OVERLAP", null);
  }
  const resolvedGroups: ResolvedMemoryAggregationGroup[] = [];
  let parserAcceptedCount = 0;
  for (const group of plan.groups) {
    const resolved = resolveAggregationGroup(group, pack);
    parserAcceptedCount += resolved.acceptedCount;
    if (resolved.status === "UNAVAILABLE") {
      return unappliedAggregation(
        resolved.state,
        resolved.failureReason,
        cardinalityMetrics(parserAcceptedCount, resolved.rejectionReason)
      );
    }
    resolvedGroups.push(resolved.group);
  }
  const groups = mergeDuplicateGroups(resolvedGroups);
  const memberGroups = groups.filter((group) => isMember(group.role));
  if (plan.overlapResolution === "UNRESOLVED" && memberGroups.length > 1) {
    return unappliedAggregation(
      "READER_REQUIRED_AMBIGUOUS_OVERLAP",
      "memory_aggregation_overlap_unresolved",
      cardinalityMetrics(parserAcceptedCount)
    );
  }
  const resolvedPlan: ResolvedMemoryAggregationPlan = {
    groups,
    operation: plan.operation,
    resolution: plan.resolution
  };
  let countedMembers: number;
  try {
    countedMembers = memberCount(resolvedPlan);
  } catch {
    return unappliedAggregation(
      "READER_REQUIRED_UNSUPPORTED_QUANTITY",
      "memory_aggregation_quantity_invariant",
      cardinalityMetrics(parserAcceptedCount)
    );
  }
  const boundaryCount = groups.filter((group) => isBoundary(group.role)).length;
  const detailed = pack.text.replace(
    MEMORY_CONTEXT_AGGREGATION_GUIDANCE,
    detailedGuide(resolvedPlan, pack, countedMembers, boundaryCount)
  );
  const detailedTokens = estimateApproxTokens(detailed);
  if (detailedTokens <= pack.hardCapTokens) {
    return Object.freeze({
      cardinalityMetrics: cardinalityMetrics(parserAcceptedCount),
      failureReason: null,
      guide: Object.freeze({
        boundaryCount,
        format: "DETAILED" as const,
        memberCount: countedMembers,
        text: detailed,
        tokens: detailedTokens
      }),
      state: plan.resolution === "RESOLVED"
        ? "DETERMINISTIC_RESOLVED" as const
        : "DETERMINISTIC_PARTIAL" as const
    });
  }
  const compact = pack.text.replace(
    MEMORY_CONTEXT_AGGREGATION_GUIDANCE,
    compactGuide(resolvedPlan, countedMembers, boundaryCount)
  );
  const compactTokens = estimateApproxTokens(compact);
  if (compactTokens > pack.hardCapTokens) {
    return unappliedAggregation(
      "UNAVAILABLE_MANDATORY_EVIDENCE",
      "memory_aggregation_context_budget_invariant",
      cardinalityMetrics(parserAcceptedCount)
    );
  }
  return Object.freeze({
    cardinalityMetrics: cardinalityMetrics(parserAcceptedCount),
    failureReason: null,
    guide: Object.freeze({
      boundaryCount,
      format: "COMPACT" as const,
      memberCount: countedMembers,
      text: compact,
      tokens: compactTokens
    }),
    state: plan.resolution === "RESOLVED"
      ? "DETERMINISTIC_RESOLVED" as const
      : "DETERMINISTIC_PARTIAL" as const
  });
}
