import { describe, expect, it } from "vitest";
import {
  decideMemoryFactRelation,
  memorySlotTransitionAllowed,
  relationSnapshotHash,
  type MemoryRelationSnapshot,
  type MemoryRelationVersionSnapshot
} from "./policy";

const NOW = new Date("2026-08-24T10:00:00.000Z");

function version(
  overrides: Partial<MemoryRelationVersionSnapshot> = {}
): MemoryRelationVersionSnapshot {
  return {
    canonicalKey: "slot.product_status.product.macbook",
    dimensionKey: "product.macbook",
    directness: "DIRECT",
    entities: [],
    expectedAt: null,
    expiresAt: null,
    factId: "fact-1",
    identityKind: "SLOT",
    mergedIntoVersionId: null,
    observedAt: "2026-08-24T09:00:00.000Z",
    occurredAt: null,
    predicateKey: "product_status",
    ref: "R1",
    semanticAdjudication: null,
    semanticFrame: null,
    sourceMode: "AUTOMATIC",
    state: "ACTIVE",
    structuredValue: { state: "owned" },
    subjectKey: "product.macbook",
    supersedesVersionId: null,
    systemFrom: "2026-08-24T09:00:00.000Z",
    validFrom: null,
    validTo: null,
    versionId: "version-current",
    ...overrides
  };
}

const semanticFrame = {
  assertionStatus: "ASSERTED" as const,
  changeIntent: "STATE_CHANGE" as const,
  memoryDirective: "NONE" as const,
  polarity: "AFFIRMED" as const,
  speechAct: "ASSERTION" as const,
  subjectScope: "CURRENT_USER" as const,
  temporalPerspective: "CURRENT" as const
};

function adjudication(
  operation:
    | "MERGE_NEW_INTO_TARGET"
    | "MOVE_TO_DISTINCT_FACT"
    | "REINFORCE"
    | "SUPERSEDE_TARGET" = "SUPERSEDE_TARGET"
) {
  return {
    assertionStatus: "ASSERTED" as const,
    candidateRef: "C1",
    confidenceBand: "HIGH" as const,
    entailment: "ENTAILED" as const,
    entityRef: null,
    operation,
    reasonCode: "structured_authority",
    resolvedEntityId: null,
    resolvedTargetVersionId: "version-current",
    subjectScope: "CURRENT_USER" as const,
    targetRef: "F1",
    temporalPerspective: "CURRENT" as const
  };
}

function snapshot(
  overrides: Partial<MemoryRelationSnapshot> = {}
): MemoryRelationSnapshot {
  const current = version();
  const pending = version({
    observedAt: "2026-08-24T09:30:00.000Z",
    ref: "P0",
    semanticAdjudication: adjudication(),
    semanticFrame,
    state: "PENDING_RELATION",
    structuredValue: { state: "returned" },
    systemFrom: "2026-08-24T09:30:00.000Z",
    versionId: "version-pending"
  });
  return {
    correctionTargetVersionId: null,
    current,
    dependencies: [],
    evidence: [],
    memoryGeneration: 2,
    memoryRevision: 8,
    pending,
    related: [current],
    relations: [],
    sourceIdentity: {
      activeLeafMessageId: "assistant-1",
      branchGeneration: 1,
      chatId: "chat-1",
      sourceHash: "c".repeat(64),
      sourceMessageId: "message-1",
      sourceRevision: 3
    },
    ...overrides
  };
}

describe("structured Memory relation policy", () => {
  it("applies an ENTAILED HIGH code-owned transition", () => {
    expect(decideMemoryFactRelation(snapshot(), NOW)).toMatchObject({
      operation: "SUPERSEDE_TARGET",
      targetVersionId: "version-current"
    });
  });

  it("never mutates a pointer without fresh adjudication authority", () => {
    const base = snapshot();
    expect(decideMemoryFactRelation({
      ...base,
      pending: { ...base.pending, semanticAdjudication: null }
    }, NOW)).toMatchObject({
      operation: "CONFLICT",
      reasonCode: "semantic_adjudication_missing"
    });
    expect(decideMemoryFactRelation({
      ...base,
      pending: {
        ...base.pending,
        semanticAdjudication: {
          ...adjudication(),
          confidenceBand: "LOW",
          entailment: "UNKNOWN",
          operation: "AMBIGUOUS",
          resolvedTargetVersionId: null,
          targetRef: null
        }
      }
    }, NOW)).toMatchObject({ operation: "CONFLICT" });
  });

  it("merges an identical value only with compatible adjudication", () => {
    const base = snapshot();
    expect(decideMemoryFactRelation({
      ...base,
      pending: {
        ...base.pending,
        semanticAdjudication: adjudication("REINFORCE"),
        structuredValue: {
          ...base.current.structuredValue as Record<string, unknown>,
          detail: { memory: "24 GB" }
        }
      }
    }, NOW).operation).toBe("MERGE_TARGET_INTO_NEW");
    expect(decideMemoryFactRelation({
      ...base,
      pending: {
        ...base.pending,
        semanticAdjudication: null,
        structuredValue: base.current.structuredValue
      }
    }, NOW)).toMatchObject({
      operation: "CONFLICT",
      reasonCode: "semantic_adjudication_missing"
    });
  });

  it("requires the same authority for cross-fact moves, merges, and expiry activation", () => {
    const base = snapshot();
    const crossFact = {
      ...base.pending,
      factId: "fact-2",
      semanticAdjudication: adjudication("MERGE_NEW_INTO_TARGET"),
      structuredValue: base.current.structuredValue
    };
    expect(decideMemoryFactRelation({
      ...base,
      pending: crossFact
    }, NOW)).toMatchObject({ operation: "MERGE_NEW_INTO_TARGET" });
    expect(decideMemoryFactRelation({
      ...base,
      pending: { ...crossFact, semanticAdjudication: null }
    }, NOW)).toMatchObject({ operation: "CONFLICT" });

    expect(decideMemoryFactRelation({
      ...base,
      correctionTargetVersionId: base.current.versionId,
      pending: {
        ...crossFact,
        semanticAdjudication: adjudication("MOVE_TO_DISTINCT_FACT")
      }
    }, NOW)).toMatchObject({ operation: "MOVE_TO_DISTINCT_FACT" });

    const expiredCurrent = {
      ...base.current,
      expiresAt: "2026-08-24T09:45:00.000Z"
    };
    expect(decideMemoryFactRelation({
      ...base,
      current: expiredCurrent,
      pending: {
        ...base.pending,
        semanticAdjudication: adjudication("SUPERSEDE_TARGET")
      }
    }, NOW)).toMatchObject({ operation: "ACTIVATE_AFTER_EXPIRY" });
    expect(decideMemoryFactRelation({
      ...base,
      current: expiredCurrent,
      pending: { ...base.pending, semanticAdjudication: null }
    }, NOW)).toMatchObject({ operation: "CONFLICT" });
  });

  it("uses structured former perspective for residence", () => {
    const base = snapshot();
    expect(decideMemoryFactRelation({
      ...base,
      current: {
        ...base.current,
        predicateKey: "residence",
        structuredValue: { placeKey: "place:a" }
      },
      pending: {
        ...base.pending,
        predicateKey: "residence",
        semanticFrame: { ...semanticFrame, temporalPerspective: "FORMER" },
        structuredValue: { placeKey: "place:b" }
      }
    }, NOW)).toMatchObject({
      operation: "CONFLICT",
      reasonCode: "retrospective_state_not_current"
    });
  });

  it("keeps restart edges dependent on structured change intent", () => {
    expect(memorySlotTransitionAllowed({
      correction: false,
      explicitSignal: false,
      from: "completed",
      predicate: "goal_status",
      to: "in_progress"
    })).toBe(false);
    expect(memorySlotTransitionAllowed({
      correction: false,
      explicitSignal: true,
      from: "completed",
      predicate: "goal_status",
      to: "in_progress"
    })).toBe(true);
  });

  it("hashes semantic authority as part of the immutable snapshot", () => {
    const base = snapshot();
    expect(relationSnapshotHash(base)).not.toBe(relationSnapshotHash({
      ...base,
      pending: {
        ...base.pending,
        semanticFrame: { ...semanticFrame, changeIntent: "REOPEN" }
      }
    }));
  });
});
