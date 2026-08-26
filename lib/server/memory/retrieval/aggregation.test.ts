import { describe, expect, it } from "vitest";
import { estimateApproxTokens } from "../../../domain/contextBudget";
import type { MemoryContextPack, MemoryPackedItem } from
  "../../../domain/memory/retrieval";
import { MEMORY_CONTEXT_AGGREGATION_GUIDANCE } from
  "../../../domain/memory/retrieval/packer";
import {
  applyMemoryAggregationPlan,
  type MemoryAggregationPlan
} from "./aggregation";

function item(index: number): MemoryPackedItem {
  return {
    exactSafeText: `release-${index}`,
    finalScore: 0.9,
    itemId: `item-${index}`,
    itemType: "RECALL_CHUNK",
    projectionKind: "CHAT_DIGEST_SAFE_TEXT",
    section: "HISTORY",
    sourceChatId: `source-${index}`,
    supportingItemId: `digest-${index}`,
    temporalReason: "any",
    tier: "DYNAMIC"
  };
}

function pack(text: string, items: readonly MemoryPackedItem[]): MemoryContextPack {
  const tokens = estimateApproxTokens(text);
  return {
    approxTokens: tokens,
    candidateCount: items.length,
    coreTokens: 0,
    hardCapTokens: tokens + 1_000,
    items,
    omissionCounts: {},
    packerVersion: "test-packer",
    targetTokens: tokens + 1_000,
    text
  };
}

describe("bounded Memory aggregation guide", () => {
  it("renders a server-computed member count separately from a boundary", () => {
    const evidence = Array.from({ length: 5 }, (_, index) => item(index));
    const context = pack([
      "PERSONAL CONTEXT",
      MEMORY_CONTEXT_AGGREGATION_GUIDANCE,
      ...evidence.map((entry) => `- ${entry.exactSafeText}`)
    ].join("\n"), evidence);
    const plan: MemoryAggregationPlan = {
      groups: [
        ...evidence.slice(0, 4).map((entry, index) => ({
          itemHandles: [`i${index}`],
          occurrence: entry.exactSafeText,
          quantity: 1,
          quantityEvidence: entry.exactSafeText,
          role: "MEMBER" as const
        })),
        {
          itemHandles: ["i4"],
          occurrence: "release-4",
          quantity: 0,
          quantityEvidence: null,
          role: "BOUNDARY"
        }
      ],
      operation: "COUNT",
      resolution: "RESOLVED"
    };

    const result = applyMemoryAggregationPlan(context, plan);

    expect(result).toMatchObject({
      boundaryCount: 1,
      format: "DETAILED",
      memberCount: 4
    });
    expect(result.text).toContain("distinct_members=4; boundary_events=1");
    expect(result.text).toContain("Counted or enumerated members:");
    expect(result.text).toContain("Boundary events:");
    expect(result.text).toContain("[evidence: memory-item:1]");
    expect(result.text).not.toContain("source-0");
    expect(result.text).not.toContain(MEMORY_CONTEXT_AGGREGATION_GUIDANCE);
  });

  it("uses a compact deterministic result when detailed labels would exceed the cap", () => {
    const evidence = Array.from({ length: 8 }, (_, index) => item(index));
    const text = `${MEMORY_CONTEXT_AGGREGATION_GUIDANCE}\n${"context ".repeat(300)}`;
    const originalTokens = estimateApproxTokens(text);
    const context: MemoryContextPack = {
      ...pack(text, evidence),
      hardCapTokens: originalTokens,
      targetTokens: originalTokens
    };
    const plan: MemoryAggregationPlan = {
      groups: evidence.map((entry, index) => ({
        itemHandles: [`i${index}`],
        occurrence: `${entry.exactSafeText}-${"detail".repeat(30)}`,
        quantity: 1,
        quantityEvidence: entry.exactSafeText,
        role: "MEMBER" as const
      })),
      operation: "ENUMERATE",
      resolution: "RESOLVED"
    };

    const result = applyMemoryAggregationPlan(context, plan);

    expect(result.format).toBe("COMPACT");
    expect(result.memberCount).toBe(8);
    expect(result.tokens).toBeLessThanOrEqual(context.hardCapTokens);
    expect(result.text).toContain("distinct_members=8");
    expect(result.text).not.toContain("Counted or enumerated members:");
  });

  it("counts an explicitly inclusive boundary as both a member and boundary", () => {
    const evidence = [item(0)];
    const context = pack(MEMORY_CONTEXT_AGGREGATION_GUIDANCE, evidence);
    const result = applyMemoryAggregationPlan(context, {
      groups: [{
        itemHandles: ["i0"],
        occurrence: "release-0",
        quantity: 1,
        quantityEvidence: "release-0",
        role: "MEMBER_AND_BOUNDARY"
      }],
      operation: "COUNT",
      resolution: "RESOLVED"
    });

    expect(result).toMatchObject({ boundaryCount: 1, memberCount: 1 });
  });

  it("sums evidence-grounded aggregate quantities instead of counting summary groups", () => {
    const evidence = [item(0), item(1), item(2)];
    const context = pack([
      MEMORY_CONTEXT_AGGREGATION_GUIDANCE,
      "- completed twelve inspections",
      "- completed 7 repairs",
      "- completed one follow-up"
    ].join("\n"), evidence);
    const result = applyMemoryAggregationPlan(context, {
      groups: [{
        itemHandles: ["i0"],
        occurrence: "twelve inspections",
        quantity: 12,
        quantityEvidence: "twelve inspections",
        role: "MEMBER"
      }, {
        itemHandles: ["i1"],
        occurrence: "7 repairs",
        quantity: 7,
        quantityEvidence: "7 repairs",
        role: "MEMBER"
      }, {
        itemHandles: ["i2"],
        occurrence: "one follow-up",
        quantity: 1,
        quantityEvidence: "one follow-up",
        role: "MEMBER"
      }],
      operation: "COUNT",
      resolution: "RESOLVED"
    });

    expect(result.memberCount).toBe(20);
    expect(result.text).toContain("distinct_members=20");
    expect(result.text).toContain("quantity=12");
    expect(result.text).toContain("quantity=7");
  });
});
