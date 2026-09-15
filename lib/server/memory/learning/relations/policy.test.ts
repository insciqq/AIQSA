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
    modality: "STATE",
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
  function propositionCorrection(): MemoryRelationSnapshot {
    const current = version({
      canonicalKey: "proposition:old-preference",
      dimensionKey: null,
      identityKind: "PROPOSITION",
      predicateKey: null,
      structuredValue: { statement: "The user prefers cedar layouts." },
      subjectKey: null
    });
    return snapshot({
      correctionTargetVersionId: current.versionId,
      current,
      pending: version({
        canonicalKey: "proposition:corrected-preference",
        dimensionKey: null,
        factId: "corrected-fact",
        identityKind: "PROPOSITION",
        observedAt: "2026-08-24T09:30:00.000Z",
        predicateKey: null,
        ref: "P0",
        semanticAdjudication: adjudication("SUPERSEDE_TARGET"),
        semanticFrame: { ...semanticFrame, changeIntent: "CORRECTION" },
        state: "PENDING_RELATION",
        structuredValue: { statement: "The user prefers maple layouts." },
        subjectKey: null,
        versionId: "corrected-version"
      }),
      related: [current]
    });
  }

  it.each(["SUPERSEDE_TARGET", "MOVE_TO_DISTINCT_FACT"] as const)(
    "resolves an exact direct proposition correction admitted as %s",
    (operation) => {
      const input = propositionCorrection();
      expect(decideMemoryFactRelation({
        ...input,
        pending: {
          ...input.pending,
          semanticAdjudication: adjudication(operation)
        }
      }, NOW)).toMatchObject({
        operation: "MOVE_TO_DISTINCT_FACT",
        targetVersionId: input.current.versionId
      });
    }
  );

  it("resolves a directly asserted current proposition state change", () => {
    const input = propositionCorrection();
    expect(decideMemoryFactRelation({
      ...input,
      pending: {
        ...input.pending,
        semanticFrame: {
          ...semanticFrame,
          changeIntent: "STATE_CHANGE",
          polarity: "AFFIRMED"
        }
      }
    }, NOW)).toMatchObject({
      operation: "MOVE_TO_DISTINCT_FACT",
      targetVersionId: input.current.versionId
    });
  });

  function scheduledRevision(expectedAt = "2026-10-28T09:00:00.000Z") {
    const input = propositionCorrection();
    const current = {
      ...input.current,
      expectedAt: "2026-10-14T09:00:00.000Z",
      modality: "CONSTRAINT" as const,
      semanticFrame: {
        ...semanticFrame,
        changeIntent: "NONE" as const,
        temporalPerspective: "FUTURE" as const
      }
    };
    const pending = {
      ...input.pending,
      expectedAt,
      modality: "PLAN" as const,
      semanticFrame: {
        ...semanticFrame,
        changeIntent: "STATE_CHANGE" as const,
        temporalPerspective: "FUTURE" as const
      },
      semanticAdjudication: {
        ...adjudication(),
        temporalPerspective: "FUTURE" as const
      }
    };
    return { ...input, current, pending, related: [current] };
  }

  it.each(["2026-10-07T09:00:00.000Z", "2026-10-28T09:00:00.000Z"])(
    "replaces an exactly adjudicated schedule with its newly agreed date %s",
    (expectedAt) => {
      const input = scheduledRevision(expectedAt);
      expect(decideMemoryFactRelation(input, NOW)).toMatchObject({
        operation: "MOVE_TO_DISTINCT_FACT",
        targetVersionId: input.current.versionId
      });
      // The scheduled occurrence can move earlier or later. The new testimony
      // still arrives after the old testimony in either case.
      expect(new Date(input.pending.observedAt!).getTime())
        .toBeGreaterThan(new Date(input.current.observedAt!).getTime());
    }
  );

  it.each([
    { currentModality: "STATE", pendingModality: "PLAN" },
    { currentModality: "CONSTRAINT", pendingModality: "STATE" },
    { currentModality: "STATE", pendingModality: "STATE" }
  ] as const)("revises a future $currentModality schedule as $pendingModality", ({
    currentModality, pendingModality
  }) => {
    for (const date of ["2026-10-07T09:00:00.000Z", "2026-10-28T09:00:00.000Z"]) {
      const input = scheduledRevision(date);
      const current = { ...input.current, modality: currentModality };
      expect(decideMemoryFactRelation({
        ...input,
        current,
        pending: { ...input.pending, modality: pendingModality },
        related: [current]
      }, NOW)).toMatchObject({
        operation: "MOVE_TO_DISTINCT_FACT",
        targetVersionId: current.versionId
      });
    }
  });

  it("keeps actual states, unsupported dates and unproved future changes protected", () => {
    const input = scheduledRevision();
    const variants: MemoryRelationSnapshot[] = [
      { ...input, current: { ...input.current, sourceMode: "EXPLICIT" } },
      { ...input, current: { ...input.current, modality: "STATE",
        semanticFrame: { ...input.current.semanticFrame, temporalPerspective: "CURRENT" }
      } },
      { ...input, current: { ...input.current, expectedAt: null } },
      { ...input, current: { ...input.current, expectedAt: "invalid" } },
      { ...input, current: {
        ...input.current,
        semanticFrame: { ...input.current.semanticFrame, temporalPerspective: "FORMER" }
      } },
      { ...input, pending: { ...input.pending, modality: "STATE",
        semanticFrame: { ...input.pending.semanticFrame, temporalPerspective: "CURRENT" }
      } },
      { ...input, pending: { ...input.pending, modality: "INTENTION" } },
      { ...input, pending: { ...input.pending, modality: "CONSIDERATION" } },
      { ...input, pending: { ...input.pending, expectedAt: null } },
      { ...input, pending: { ...input.pending, expectedAt: "invalid" } },
      { ...input, pending: { ...input.pending, observedAt: null } },
      { ...input, pending: { ...input.pending, observedAt: input.current.observedAt } },
      { ...input, pending: { ...input.pending, observedAt: "2026-08-23T09:30:00.000Z" } },
      { ...input, pending: { ...input.pending, semanticAdjudication: null } },
      { ...input, pending: {
        ...input.pending,
        semanticAdjudication: { ...input.pending.semanticAdjudication, confidenceBand: "MEDIUM" }
      } },
      { ...input, pending: {
        ...input.pending,
        semanticAdjudication: { ...input.pending.semanticAdjudication, temporalPerspective: "FORMER" }
      } },
      { ...input, correctionTargetVersionId: null }
    ];
    for (const variant of variants) {
      expect(decideMemoryFactRelation(variant, NOW).operation).toBe("CONFLICT");
    }
  });

  it("accepts a current adjudication of a grounded future constraint revision", () => {
    const input = scheduledRevision();
    expect(decideMemoryFactRelation({
      ...input,
      current: {
        ...input.current,
        modality: "PLAN",
        semanticFrame: { ...input.current.semanticFrame, temporalPerspective: "CURRENT" }
      },
      pending: {
        ...input.pending,
        modality: "CONSTRAINT",
        semanticAdjudication: {
          ...input.pending.semanticAdjudication, temporalPerspective: "CURRENT"
        }
      }
    }, NOW).operation).toBe("MOVE_TO_DISTINCT_FACT");
  });

  it.each([
    ["PROPOSITION", "SLOT"],
    ["SLOT", "PROPOSITION"]
  ] as const)("resolves a proved current update from %s to %s", (from, to) => {
    const input = propositionCorrection();
    const structured = {
      dimensionKey: "format:layouts",
      predicateKey: "preference",
      structuredValue: { schema: "preference-v1", value: "maple" },
      subjectKey: "person:self"
    };
    const current = {
      ...input.current,
      ...(from === "SLOT" ? structured : {}),
      identityKind: from
    };
    const pending = {
      ...input.pending,
      ...(to === "SLOT" ? structured : {}),
      identityKind: to
    };
    expect(decideMemoryFactRelation({ ...input, current, pending }, NOW))
      .toMatchObject({ operation: "MOVE_TO_DISTINCT_FACT", targetVersionId: current.versionId });
    expect(decideMemoryFactRelation({
      ...input, current: { ...current, sourceMode: "EXPLICIT" }, pending
    }, NOW).operation).toBe("CONFLICT");
    expect(decideMemoryFactRelation({
      ...input, current, pending: { ...pending, semanticAdjudication: null }
    }, NOW).operation).toBe("CONFLICT");
  });

  it("keeps unproven, retrospective and protected proposition corrections in conflict", () => {
    const input = propositionCorrection();
    const pendingVariants: Partial<MemoryRelationVersionSnapshot>[] = [
      { directness: "INFERRED" },
      { semanticAdjudication: null },
      { semanticAdjudication: { ...adjudication(), confidenceBand: "LOW" } },
      { semanticAdjudication: { ...adjudication(), entailment: "UNKNOWN" } },
      { semanticAdjudication: { ...adjudication(), resolvedTargetVersionId: "unrelated-version" } },
      { semanticFrame: { ...semanticFrame, changeIntent: "NONE" } },
      { semanticFrame: { ...semanticFrame, changeIntent: "CORRECTION", temporalPerspective: "FORMER" } }
    ];
    for (const pending of pendingVariants) {
      expect(decideMemoryFactRelation({
        ...input,
        pending: { ...input.pending, ...pending }
      }, NOW).operation).toBe("CONFLICT");
    }
    expect(decideMemoryFactRelation({
      ...input,
      correctionTargetVersionId: null
    }, NOW).operation).toBe("CONFLICT");
    expect(decideMemoryFactRelation({
      ...input,
      current: { ...input.current, sourceMode: "EXPLICIT" }
    }, NOW).operation).toBe("CONFLICT");
    expect(decideMemoryFactRelation({
      ...input,
      current: { ...input.current, identityKind: "SLOT", sourceMode: "EXPLICIT" }
    }, NOW).operation).toBe("CONFLICT");
  });

  it("applies an ENTAILED HIGH code-owned transition", () => {
    expect(decideMemoryFactRelation(snapshot(), NOW)).toMatchObject({
      operation: "SUPERSEDE_TARGET",
      targetVersionId: "version-current"
    });
  });

  it("keeps relationship transitions bound to the same grounded subject", () => {
    const relationshipFrame = {
      ...semanticFrame,
      subjectScope: "USER_RELATIONSHIP_CONTEXT" as const
    };
    const ana = {
      canonicalKey: "entity:v4:person:ana",
      entityType: "PERSON",
      role: "SUBJECT" as const
    };
    const noor = { ...ana, canonicalKey: "entity:v4:person:noor" };
    const base = snapshot({
      current: version({
        entities: [ana],
        semanticFrame: relationshipFrame
      }),
      pending: version({
        entities: [ana],
        semanticAdjudication: {
          ...adjudication("REINFORCE"),
          subjectScope: "USER_RELATIONSHIP_CONTEXT" as const
        },
        semanticFrame: relationshipFrame
      })
    });
    expect(decideMemoryFactRelation(base, NOW).operation).toBe("MERGE_NEW_INTO_TARGET");
    expect(decideMemoryFactRelation({
      ...base,
      pending: { ...base.pending, entities: [noor] }
    }, NOW).operation).toBe("CONFLICT");
    expect(decideMemoryFactRelation({
      ...base,
      current: { ...base.current, semanticFrame: semanticFrame }
    }, NOW).operation).toBe("CONFLICT");
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
