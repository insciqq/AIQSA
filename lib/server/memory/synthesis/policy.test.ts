import { describe, expect, it } from "vitest";
import { MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS } from "../../../domain/memory/retrieval/config";
import {
  buildMemorySynthesisPlan,
  decideMemorySynthesisSchedule,
  memorySynthesisPatternFingerprint,
  memorySynthesisSourceEligibilityHash,
  memorySynthesisSourceSetFingerprint,
  memorySynthesisSourcesSupportReason,
  MEMORY_SYNTHESIS_CLUSTER_WINDOW_MS,
  MEMORY_SYNTHESIS_COOLDOWN_MS,
  MEMORY_SYNTHESIS_LOW_ACTIVITY_FALLBACK_MS,
  MEMORY_SYNTHESIS_MAX_CLUSTERS,
  MEMORY_SYNTHESIS_MAX_SOURCES,
  MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES,
  MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER,
  MEMORY_SYNTHESIS_NEW_FACT_TRIGGER,
  MEMORY_SYNTHESIS_QUIET_PERIOD_MS,
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
    confidence: 1,
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
    sensitivityClass: "NORMAL" as const,
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
  it("bounds combined sources to the exact reader evidence capacity", () => {
    const sources = Array.from({ length: MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS + 1 },
      (_, index) => source(index));
    expect(memorySynthesisSourcesSupportReason(sources.slice(0, MEMORY_CONTEXT_PATTERN_MAX_SUPPORTS),
      "combined_refined_facts")).toBe(true);
    expect(memorySynthesisSourcesSupportReason(sources, "combined_refined_facts")).toBe(false);
    expect(memorySynthesisSourcesSupportReason(sources, "repeated_habit_pattern")).toBe(true);
  });
  it("binds per-pattern ingestion to canonical identity instead of model wording", () => {
    const input = {
      canonicalPatternIdentity: `prop:v1:${"a".repeat(64)}`,
      sourceEligibilityHashes: ["b".repeat(64), "c".repeat(64), "d".repeat(64)]
    };
    const fingerprint = memorySynthesisPatternFingerprint(input);

    expect(fingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(memorySynthesisPatternFingerprint({ ...input })).toBe(fingerprint);
    expect(memorySynthesisPatternFingerprint({
      ...input,
      canonicalPatternIdentity: `prop:v1:${"c".repeat(64)}`
    })).not.toBe(fingerprint);
    expect(memorySynthesisPatternFingerprint({
      ...input,
      sourceEligibilityHashes: [...input.sourceEligibilityHashes].reverse()
    })).toBe(fingerprint);
  });

  it("requires two distinct eligible direct facts after the forward boundary", () => {
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
        ...Array.from(
          { length: MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES },
          (_, index) => source(index)
        ),
        source(103, { factId: "fact-0" })
      ]
    });

    expect(plan).not.toBeNull();
    expect(plan?.sources).toHaveLength(MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES);
    expect(plan?.sources.every((entry) =>
      entry.observedAt >= boundary && entry.directness !== "INFERRED" &&
      entry.modality !== "PATTERN")).toBe(true);
    expect(new Set(plan?.sources.map(({ factId }) => factId)).size)
      .toBe(MEMORY_SYNTHESIS_MIN_ELIGIBLE_SOURCES);
  });

  it("does not treat several facts extracted from one message as independent support", () => {
    const sameMessage = buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: Array.from({ length: 3 }, (_, index) => source(index, {
        sourceChatIds: ["chat-shared"],
        sourceMessageIds: ["message-shared"]
      }))
    });
    expect(sameMessage?.clusters).toHaveLength(1);
    expect(memorySynthesisSourcesSupportReason(sameMessage!.sources, "combined_episode_facts"))
      .toBe(true);
    expect(memorySynthesisSourcesSupportReason(sameMessage!.sources, "repeated_habit_pattern"))
      .toBe(false);
    expect(memorySynthesisSourcesSupportReason(sameMessage!.sources, "combined_overlapping_facts"))
      .toBe(false);

    expect(buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: Array.from({ length: 3 }, (_, index) => source(index, {
        sourceChatIds: ["chat-shared"],
        sourceMessageIds: [`message-${index}`]
      }))
    })?.clusters).toHaveLength(1);
  });

  it("requires a distinct current message for each fact, including explicit facts", () => {
    const explicit = Array.from({ length: 3 }, (_, index) => source(index, {
      sourceMode: "EXPLICIT",
      sourceMessageIds: ["shared-message"],
      subjectScope: "CURRENT_USER"
    }));
    expect(memorySynthesisSourcesSupportReason(explicit, "repeated_habit_pattern"))
      .toBe(false);
    expect(memorySynthesisSourcesSupportReason(
      explicit.map((entry, index) => ({
        ...entry,
        sourceMessageIds: index === 0
          ? ["message-a", "message-b", "message-c"]
          : ["message-a"]
      })), "repeated_habit_pattern"
    )).toBe(false);
    expect(buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: explicit.map((entry, index) => ({
        ...entry,
        sourceMessageIds: [`message-${index}`]
      }))
    })?.clusters).toHaveLength(1);
  });

  it("schedules from meaningful activity while bounding frequency", () => {
    const now = new Date("2026-08-27T12:00:00.000Z");
    const quietChange = new Date(
      now.getTime() - MEMORY_SYNTHESIS_QUIET_PERIOD_MS - 1
    );
    const base = {
      changedFactCount: 3,
      eligibleSourceCount: 3,
      firstChangedAt: new Date(quietChange.getTime() - 60 * 60 * 1_000),
      lastChangedAt: quietChange,
      lastSynthesisAt: null,
      newEvidenceChatCount: MEMORY_SYNTHESIS_NEW_CHAT_TRIGGER
    };

    expect(decideMemorySynthesisSchedule(base, now)).toEqual({
      due: true,
      reason: "CHAT_ACTIVITY"
    });
    expect(decideMemorySynthesisSchedule({
      ...base,
      changedFactCount: MEMORY_SYNTHESIS_NEW_FACT_TRIGGER,
      newEvidenceChatCount: 1
    }, now)).toEqual({ due: true, reason: "FACT_ACTIVITY" });
    expect(decideMemorySynthesisSchedule({
      ...base,
      firstChangedAt: new Date(
        now.getTime() - MEMORY_SYNTHESIS_LOW_ACTIVITY_FALLBACK_MS
      ),
      newEvidenceChatCount: 1
    }, now)).toEqual({ due: true, reason: "LOW_ACTIVITY_FALLBACK" });
    expect(decideMemorySynthesisSchedule({
      ...base,
      lastChangedAt: new Date(
        now.getTime() - MEMORY_SYNTHESIS_QUIET_PERIOD_MS + 1
      )
    }, now)).toEqual({ due: false, reason: "QUIET_PERIOD" });
    expect(decideMemorySynthesisSchedule({
      ...base,
      lastSynthesisAt: new Date(
        now.getTime() - MEMORY_SYNTHESIS_COOLDOWN_MS + 1
      )
    }, now)).toEqual({ due: false, reason: "COOLDOWN" });
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

  it("does not admit a provider job when no grounded subject has two facts", () => {
    const sources = Array.from({ length: 20 }, (_, index) => source(index, {
      entityIds: [`entity-${index}`],
      predicateKey: `predicate-${index}`,
      sourceMode: "EXPLICIT",
      subjectKey: `subject-${index}`
    }));
    expect(buildMemorySynthesisPlan({ boundary, generation: 3, sources })).toBeNull();
  });

  it("lets automatic current-user facts form a cross-predicate candidate bucket", () => {
    const plan = buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: Array.from({ length: 3 }, (_, index) => source(index, {
        entityIds: [`entity-${index}`],
        category: index === 0 ? "work" : index === 1 ? "habits" : "preferences",
        modality: index === 0 ? "WORKFLOW" : index === 1 ? "HABIT" : "PREFERENCE",
        predicateKey: `predicate-${index}`,
        subjectKey: null,
        subjectScope: "CURRENT_USER"
      }))
    });

    expect(plan?.clusters).toHaveLength(1);
    expect(plan?.clusters[0]?.sources).toHaveLength(3);
  });

  it("does not infer the owner from an explicit fact without a grounded subject", () => {
    const sources = Array.from({ length: 3 }, (_, index) => source(index, {
      sourceMode: "EXPLICIT",
      subjectKey: null,
      subjectScope: null,
      subjectEntityIds: [],
      entityIds: ["same-mentioned-entity"]
    }));
    expect(buildMemorySynthesisPlan({ boundary, generation: 3, sources }))
      .toBeNull();
  });

  it("isolates automatic relationship facts by their grounded subject", () => {
    const ana = Array.from({ length: 3 }, (_, index) => source(index, {
      entityIds: [`entity-ana-${index}`],
      subjectEntityIds: ["entity-ana"],
      subjectKey: null,
      subjectScope: "USER_RELATIONSHIP_CONTEXT",
      predicateKey: `ana-predicate-${index}`
    }));
    const noor = Array.from({ length: 3 }, (_, index) => source(index + 3, {
      entityIds: [`entity-noor-${index}`],
      subjectEntityIds: ["entity-noor"],
      subjectKey: null,
      subjectScope: "USER_RELATIONSHIP_CONTEXT",
      predicateKey: `noor-predicate-${index}`
    }));
    const plan = buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: [...ana, ...noor]
    });
    expect(plan?.clusters).toHaveLength(2);
    const clusterSubjects = plan?.clusters.map(({ sources }) =>
      new Set(sources.map(({ subjectEntityIds }) => subjectEntityIds?.[0])));
    expect(clusterSubjects).toEqual(expect.arrayContaining([
      new Set(["entity-ana"]),
      new Set(["entity-noor"])
    ]));
  });

  it("does not join otherwise compatible sources across the bounded time window", () => {
    const isolated = Array.from({ length: 20 }, (_, index) => source(index, {
      entityIds: [`isolated-entity-${index}`],
      predicateKey: `isolated-predicate-${index}`,
      sourceMode: "EXPLICIT",
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
    const separated = buildMemorySynthesisPlan({
      boundary,
      generation: 3,
      sources: tooWide
    });
    expect(separated?.clusters).toHaveLength(1);
    expect(separated?.clusters[0]?.sources).toHaveLength(2);
    expect(Math.max(...separated!.clusters[0]!.sources.map(({ observedAt }) => observedAt.getTime())) -
      Math.min(...separated!.clusters[0]!.sources.map(({ observedAt }) => observedAt.getTime())))
      .toBeLessThanOrEqual(MEMORY_SYNTHESIS_CLUSTER_WINDOW_MS);

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
