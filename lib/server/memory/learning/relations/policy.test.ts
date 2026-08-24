import { describe, expect, it } from "vitest";
import {
  decideMemoryFactRelation,
  memorySlotTransitionAllowed,
  relationSnapshotHash,
  type MemoryRelationSnapshot,
  type MemoryRelationVersionSnapshot
} from "./policy";

const NOW = new Date("2026-08-24T10:00:00.000Z");

function version(overrides: Partial<MemoryRelationVersionSnapshot> = {}):
MemoryRelationVersionSnapshot {
  return {
    canonicalKey: "slot.product_status.product.macbook",
    dimensionKey: "product.macbook",
    directness: "DIRECT",
    displayText: "The user owns a MacBook.",
    entities: [{
      canonicalKey: "product.macbook",
      entityType: "PRODUCT",
      role: "SUBJECT"
    }],
    expectedAt: null,
    expiresAt: null,
    factId: "fact-1",
    identityKind: "SLOT",
    mergedIntoVersionId: null,
    observedAt: "2026-08-24T09:00:00.000Z",
    occurredAt: null,
    predicateKey: "product_status",
    ref: "R1",
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

function snapshot(overrides: Partial<MemoryRelationSnapshot> = {}):
MemoryRelationSnapshot {
  const current = version();
  const pending = version({
    displayText: "The user returned the MacBook.",
    observedAt: "2026-08-24T09:30:00.000Z",
    ref: "P0",
    state: "PENDING_RELATION",
    structuredValue: { state: "returned" },
    systemFrom: "2026-08-24T09:30:00.000Z",
    versionId: "version-pending"
  });
  return {
    correctionTargetVersionId: null,
    current,
    dependencies: [],
    evidence: [{
      branchGeneration: 1,
      evidenceFingerprint: "e".repeat(64),
      evidenceId: "evidence-1",
      messageId: "message-1",
      observedAt: "2026-08-24T09:30:00.000Z",
      safeSourceHash: "a".repeat(64),
      sourceMessageContentHash: "b".repeat(64),
      sourceProjectionVersion: "memory-source-v1"
    }],
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
    sourceText: "I returned my MacBook.",
    ...overrides
  };
}

const registries = {
  employment_status: {
    current: ["leave_planned", "former"],
    former: ["current"],
    leave_planned: ["former"]
  },
  goal_status: {
    abandoned: ["planned", "in_progress"],
    blocked: ["in_progress", "paused", "completed", "cancelled", "abandoned"],
    cancelled: ["planned", "in_progress"],
    completed: ["in_progress"],
    considering: ["planned", "in_progress", "cancelled", "abandoned"],
    in_progress: ["paused", "blocked", "completed", "cancelled", "abandoned"],
    paused: ["in_progress", "blocked", "completed", "cancelled", "abandoned"],
    planned: ["in_progress", "paused", "blocked", "completed", "cancelled", "abandoned"]
  },
  product_status: {
    borrowed: ["owned", "returned", "no_longer_owned"],
    cancelled: ["considering", "planned", "ordered", "owned", "borrowed", "work_device", "shared"],
    considering: ["planned", "ordered", "owned", "cancelled"],
    no_longer_owned: ["considering", "planned", "ordered", "owned", "borrowed", "work_device", "shared"],
    ordered: ["owned", "cancelled"],
    owned: ["returned", "sold", "no_longer_owned"],
    planned: ["ordered", "owned", "cancelled"],
    returned: ["considering", "planned", "ordered", "owned", "borrowed", "work_device", "shared"],
    shared: ["owned", "returned", "no_longer_owned"],
    sold: ["considering", "planned", "ordered", "owned", "borrowed", "work_device", "shared"],
    work_device: ["owned", "returned", "no_longer_owned"]
  },
  project_status: {
    active: ["paused", "blocked", "completed", "cancelled"],
    archived: ["active"],
    blocked: ["active", "paused", "completed", "cancelled"],
    cancelled: ["planned", "active"],
    completed: ["archived", "active"],
    paused: ["active", "blocked", "completed", "cancelled"],
    planned: ["active", "paused", "blocked", "completed", "cancelled"]
  }
} as const;

const explicitOnlyEdges = new Set([
  "goal_status:abandoned:planned",
  "goal_status:abandoned:in_progress",
  "goal_status:cancelled:planned",
  "goal_status:cancelled:in_progress",
  "goal_status:completed:in_progress",
  "project_status:archived:active",
  "project_status:cancelled:planned",
  "project_status:cancelled:active",
  "project_status:completed:active"
]);

describe("memory relation transition policy", () => {
  for (const [predicate, registry] of Object.entries(registries)) {
    const states = Object.keys(registry);
    it(`is exhaustive for ${predicate}`, () => {
      for (const from of states) {
        for (const to of states) {
          const expected = from !== to &&
            (registry[from as keyof typeof registry] as readonly string[])
              .includes(to) &&
            !explicitOnlyEdges.has(`${predicate}:${from}:${to}`);
          expect(memorySlotTransitionAllowed({
            correction: false,
            explicitSignal: false,
            from,
            predicate,
            to
          }), `${predicate}:${from}:${to}`).toBe(expected);
        }
      }
    });
  }

  it.each([...explicitOnlyEdges].map((edge) =>
    edge.split(":") as [string, string, string]))(
    "requires an explicit restart for %s:%s:%s", (predicate, from, to) => {
    expect(memorySlotTransitionAllowed({
      correction: false,
      explicitSignal: false,
      from,
      predicate,
      to
    })).toBe(false);
    expect(memorySlotTransitionAllowed({
      correction: false,
      explicitSignal: true,
      from,
      predicate,
      to
    })).toBe(true);
    });

  it("keeps work, borrowed, and shared states distinct from owned", () => {
    for (const state of ["work_device", "borrowed", "shared"]) {
      const current = version({ structuredValue: { state } });
      const result = decideMemoryFactRelation(snapshot({
        current,
        pending: version({
          ref: "P0",
          state: "PENDING_RELATION",
          structuredValue: { state: "owned" },
          versionId: `pending-${state}`
        }),
        related: [current],
        sourceText: "I now own this MacBook."
      }), NOW);
      expect(result.operation).toBe("SUPERSEDE_TARGET");
    }
  });

  it("preserves a repeated acquisition as a genuine state transition", () => {
    const current = version({ structuredValue: { state: "returned" } });
    expect(decideMemoryFactRelation(snapshot({
      current,
      pending: version({
        ref: "P0",
        state: "PENDING_RELATION",
        structuredValue: { state: "owned" },
        versionId: "owned-again"
      }),
      related: [current],
      sourceText: "I bought a MacBook again."
    }), NOW)).toMatchObject({
      operation: "SUPERSEDE_TARGET",
      reasonCode: "allowed_state_transition"
    });
  });
});

describe("memory relation decisions", () => {
  it("merges richer compatible truth without inventing a transition", () => {
    const pending = version({
      displayText: "The user owns a 15-inch MacBook Air M4.",
      ref: "P0",
      state: "PENDING_RELATION",
      structuredValue: { detail: { display: "15-inch", model: "Air M4" }, state: "owned" },
      versionId: "richer"
    });
    expect(decideMemoryFactRelation(snapshot({ pending }), NOW)).toMatchObject({
      operation: "MERGE_TARGET_INTO_NEW",
      targetVersionId: "version-current"
    });
  });

  it("merges automatic same-truth evidence into an explicit current", () => {
    const current = version({ sourceMode: "EXPLICIT" });
    expect(decideMemoryFactRelation(snapshot({
      current,
      pending: version({
        ref: "P0",
        state: "PENDING_RELATION",
        versionId: "automatic-copy"
      }),
      related: [current]
    }), NOW)).toMatchObject({
      operation: "MERGE_NEW_INTO_TARGET",
      reasonCode: "explicit_canonical_authority"
    });
  });

  it("never replaces conflicting explicit current with automatic evidence", () => {
    const current = version({ sourceMode: "EXPLICIT" });
    expect(decideMemoryFactRelation(snapshot({ current, related: [current] }), NOW))
      .toMatchObject({
        operation: "CONFLICT",
        reasonCode: "explicit_current_conflict"
      });
  });

  it("requires an explicit change signal for contradictory preferences", () => {
    const current = version({
      canonicalKey: "slot.preference.drink",
      dimensionKey: "drink",
      predicateKey: "preference",
      structuredValue: { value: "tea" }
    });
    const pending = version({
      canonicalKey: current.canonicalKey,
      dimensionKey: current.dimensionKey,
      predicateKey: current.predicateKey,
      ref: "P0",
      state: "PENDING_RELATION",
      structuredValue: { value: "coffee" },
      versionId: "preference-coffee"
    });
    expect(decideMemoryFactRelation(snapshot({
      current,
      pending,
      related: [current],
      sourceText: "Coffee is nice."
    }), NOW).operation).toBe("AMBIGUOUS");
    expect(decideMemoryFactRelation(snapshot({
      current,
      pending,
      related: [current],
      sourceText: "I now prefer coffee instead."
    }), NOW).operation).toBe("SUPERSEDE_TARGET");
  });

  it("keeps retrospective residence non-current", () => {
    const current = version({
      canonicalKey: "slot.residence.primary",
      dimensionKey: "primary",
      predicateKey: "residence",
      structuredValue: { placeKey: "helsinki" }
    });
    const pending = version({
      canonicalKey: current.canonicalKey,
      dimensionKey: current.dimensionKey,
      predicateKey: current.predicateKey,
      ref: "P0",
      state: "PENDING_RELATION",
      structuredValue: { placeKey: "turku" },
      versionId: "past-residence"
    });
    expect(decideMemoryFactRelation(snapshot({
      current,
      pending,
      related: [current],
      sourceText: "I used to live in Turku."
    }), NOW)).toMatchObject({
      operation: "CONFLICT",
      reasonCode: "retrospective_state_not_current"
    });
  });

  it("moves an explicit cross-fact correction and merges compatible roots", () => {
    const current = version();
    const pending = version({
      canonicalKey: "slot.product_status.product.macbook-m4",
      factId: "fact-2",
      ref: "P0",
      state: "PENDING_RELATION",
      versionId: "m4"
    });
    expect(decideMemoryFactRelation(snapshot({
      correctionTargetVersionId: current.versionId,
      current,
      pending,
      related: [current]
    }), NOW).operation).toBe("MOVE_TO_DISTINCT_FACT");
    expect(decideMemoryFactRelation(snapshot({
      current,
      pending,
      related: [current]
    }), NOW).operation).toBe("MERGE_NEW_INTO_TARGET");
  });

  it("expires due observations and replaces a due current without resurrection", () => {
    expect(decideMemoryFactRelation(snapshot({
      pending: version({
        expiresAt: "2026-08-24T09:59:59.000Z",
        ref: "P0",
        state: "PENDING_RELATION",
        versionId: "expired-pending"
      })
    }), NOW).operation).toBe("EXPIRE");
    const current = version({ expiresAt: "2026-08-24T09:59:59.000Z" });
    expect(decideMemoryFactRelation(snapshot({ current, related: [current] }), NOW))
      .toMatchObject({
        operation: "ACTIVATE_AFTER_EXPIRY",
        reasonCode: "expired_current_replaced"
      });
  });

  it("hashes every material source, dependency, and lifecycle snapshot", () => {
    const original = snapshot();
    expect(relationSnapshotHash(original)).toBe(relationSnapshotHash(snapshot()));
    expect(relationSnapshotHash({
      ...original,
      dependencies: [{
        dependencyId: "dependency-1",
        dependencyKind: "RELATION_CONTEXT",
        sourceFactVersionId: original.current.versionId,
        sourceMessageContentHash: null,
        sourceMessageId: null,
        sourceMessageUpdatedAt: null,
        sourceProjectionVersion: null
      }]
    })).not.toBe(relationSnapshotHash(original));
    expect(relationSnapshotHash({
      ...original,
      evidence: [{ ...original.evidence[0]!, safeSourceHash: "f".repeat(64) }]
    })).not.toBe(relationSnapshotHash(original));
  });
});
