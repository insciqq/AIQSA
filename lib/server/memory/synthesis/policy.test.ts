import { describe, expect, it } from "vitest";
import {
  buildMemorySynthesisPlan,
  memorySynthesisPatternFingerprint,
  memorySynthesisSourceEligibilityHash,
  memorySynthesisSourceSetFingerprint,
  MEMORY_SYNTHESIS_CLUSTER_WINDOW_MS,
  MEMORY_SYNTHESIS_MAX_CLUSTERS,
  MEMORY_SYNTHESIS_MAX_SOURCES,
  MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES,
  type MemorySynthesisSource
} from "./policy";

const boundary = new Date("2026-08-01T00:00:00.000Z");

function source(
  index: number,
  overrides: Partial<MemorySynthesisSource> = {}
): MemorySynthesisSource {
  const base = {
    canonicalKey: `habit:${index}`,
    category: "habits",
    directness: "DIRECT" as const,
    displayText: `I follow durable workflow step ${index}.`,
    entityIds: ["entity-shared"],
    factId: `fact-${index}`,
    ingestionFingerprint: `${index.toString(16).padStart(64, "0")}`,
    memoryGeneration: 3,
    modality: "HABIT" as const,
    observedAt: new Date(boundary.getTime() + (index + 1) * 60_000),
    pipelineVersion: "memory-fact-extraction-vnext-v2",
    predicateKey: "workflow",
    sourceChatIds: [`chat-${index % 4}`],
    sourceMessageIds: [`message-${index}`],
    sourceMode: "AUTOMATIC" as const,
    structuredValue: { index },
    subjectKey: "user",
    versionId: `version-${index}`,
    ...overrides
  };
  return {
    ...base,
    eligibilityHash: overrides.eligibilityHash ??
      memorySynthesisSourceEligibilityHash(base)
  };
}

describe("Dream synthesis policy", () => {
  it("binds per-pattern ingestion to canonical identity instead of model wording", () => {
    const input = {
      canonicalPatternIdentity: `prop:v1:${"a".repeat(64)}`,
      sourceSetFingerprint: "b".repeat(64)
    };
    const fingerprint = memorySynthesisPatternFingerprint(input);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(memorySynthesisPatternFingerprint({ ...input })).toBe(fingerprint);
    expect(memorySynthesisPatternFingerprint({
      ...input,
      canonicalPatternIdentity: `prop:v1:${"c".repeat(64)}`
    })).not.toBe(fingerprint);
  });

  it("requires twenty distinct eligible direct facts after the forward boundary", () => {
    expect(buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: Array.from(
        { length: MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES - 1 },
        (_, index) => source(index)
      )
    })).toBeNull();

    const plan = buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: [
        source(100, { observedAt: new Date(boundary.getTime() - 1) }),
        source(101, { directness: "INFERRED" }),
        source(102, { modality: "PATTERN" }),
        ...Array.from({ length: 20 }, (_, index) => source(index)),
        source(103, { factId: "fact-0" })
      ]
    });

    expect(plan).not.toBeNull();
    expect(plan?.sources).toHaveLength(20);
    expect(plan?.sources.every((entry) =>
      entry.observedAt >= boundary && entry.directness !== "INFERRED" &&
      entry.modality !== "PATTERN")).toBe(true);
    expect(new Set(plan?.sources.map(({ factId }) => factId)).size).toBe(20);
  });

  it("binds deterministic bounded clusters and source-set identity", () => {
    const sources = Array.from({ length: 45 }, (_, index) => source(index, {
      entityIds: [`entity-${index % 10}`],
      predicateKey: `predicate-${index % 10}`
    }));
    const first = buildMemorySynthesisPlan({ boundary, generation: 3, sources });
    const reordered = buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: [...sources].reverse()
    });

    expect(first).not.toBeNull();
    expect(first?.sources.length).toBeLessThanOrEqual(MEMORY_SYNTHESIS_MAX_SOURCES);
    expect(first?.clusters.length).toBeLessThanOrEqual(MEMORY_SYNTHESIS_MAX_CLUSTERS);
    expect(reordered?.sourceSetFingerprint).toBe(first?.sourceSetFingerprint);
    expect(reordered?.sourceSnapshotHash).toBe(first?.sourceSnapshotHash);
    expect(memorySynthesisSourceSetFingerprint({
      generation: 4,
      sources: first!.sources
    })).not.toBe(first?.sourceSetFingerprint);
  });

  it("does not admit a provider job when no cluster has three facts", () => {
    const sources = Array.from({ length: 20 }, (_, index) => source(index, {
      entityIds: [`entity-${index}`],
      predicateKey: `predicate-${index}`,
      subjectKey: `subject-${index}`
    }));
    expect(buildMemorySynthesisPlan({ boundary, generation: 3, sources })).toBeNull();
  });

  it("does not join otherwise compatible sources across the bounded time window", () => {
    const isolated = Array.from({ length: 20 }, (_, index) => source(index, {
      entityIds: [`isolated-entity-${index}`],
      predicateKey: `isolated-predicate-${index}`,
      subjectKey: `isolated-subject-${index}`
    }));
    const nearbyAt = new Date(boundary.getTime() + 24 * 60 * 60 * 1_000);
    const compatible = (index: number, observedAt: Date) => source(index, {
      entityIds: ["bounded-window-entity"],
      observedAt,
      predicateKey: "workflow",
      subjectKey: "user"
    });
    const tooWide = [
      compatible(0, nearbyAt),
      compatible(1, new Date(nearbyAt.getTime() + 60_000)),
      compatible(2, new Date(
        nearbyAt.getTime() + MEMORY_SYNTHESIS_CLUSTER_WINDOW_MS + 1
      )),
      ...isolated.slice(3)
    ];
    expect(buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: tooWide
    })).toBeNull();

    const withinWindow = [
      ...tooWide.slice(0, 2),
      compatible(2, new Date(nearbyAt.getTime() + 120_000)),
      ...tooWide.slice(3)
    ];
    expect(buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: withinWindow
    })?.clusters[0]?.sources).toHaveLength(3);
  });
});
