import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../../coordinator/types";
import { createMemoryRelationHandler } from "./handler";
import {
  MEMORY_FACT_RELATION_PIPELINE_VERSION,
  type MemoryRelationSnapshot,
  type MemoryRelationVersionSnapshot
} from "./policy";
import type { MemoryRelationRepository } from "./repository";

const NOW = new Date("2026-08-24T10:00:00.000Z");

function version(
  overrides: Partial<MemoryRelationVersionSnapshot> = {}
): MemoryRelationVersionSnapshot {
  return {
    canonicalKey: "slot.product_status.product.macbook",
    dimensionKey: null,
    directness: "DIRECT",
    entities: [],
    expectedAt: null,
    expiresAt: null,
    factId: "fact-1",
    identityKind: "SLOT",
    mergedIntoVersionId: null,
    observedAt: NOW.toISOString(),
    occurredAt: null,
    predicateKey: "product_status",
    ref: "R1",
    semanticAdjudication: null,
    semanticFrame: null,
    sourceMode: "AUTOMATIC",
    state: "ACTIVE",
    structuredValue: { state: "owned" },
    subjectKey: "product:macbook",
    supersedesVersionId: null,
    systemFrom: NOW.toISOString(),
    validFrom: null,
    validTo: null,
    versionId: "version-current",
    ...overrides
  };
}

function snapshot(): MemoryRelationSnapshot {
  const current = version();
  return {
    correctionTargetVersionId: null,
    current,
    dependencies: [],
    evidence: [],
    memoryGeneration: 1,
    memoryRevision: 1,
    pending: version({
      ref: "P0",
      semanticAdjudication: {
        assertionStatus: "ASSERTED",
        candidateRef: "C1",
        confidenceBand: "HIGH",
        entailment: "ENTAILED",
        entityRef: null,
        operation: "SUPERSEDE_TARGET",
        reasonCode: "state_change",
        resolvedEntityId: null,
        resolvedTargetVersionId: "version-current",
        subjectScope: "CURRENT_USER",
        targetRef: "F1",
        temporalPerspective: "CURRENT"
      },
      semanticFrame: {
        assertionStatus: "ASSERTED",
        changeIntent: "STATE_CHANGE",
        memoryDirective: "NONE",
        polarity: "AFFIRMED",
        speechAct: "ASSERTION",
        subjectScope: "CURRENT_USER",
        temporalPerspective: "CURRENT"
      },
      state: "PENDING_RELATION",
      structuredValue: { state: "returned" },
      versionId: "version-pending"
    }),
    related: [current],
    relations: [],
    sourceIdentity: {
      activeLeafMessageId: "assistant-1",
      branchGeneration: 1,
      chatId: "chat-1",
      sourceHash: "a".repeat(64),
      sourceMessageId: "message-1",
      sourceRevision: 1
    }
  };
}

function claim(): MemoryJobClaim {
  return {
    activeLeafMessageId: "assistant-1",
    attemptCount: 1,
    branchGeneration: 1,
    chatId: "chat-1",
    claimToken: "claim-1",
    id: "job-1",
    idempotencyFingerprint: "f".repeat(64),
    kind: "RESOLVE_FACT_RELATIONS",
    leaseExpiresAt: new Date("2026-08-24T10:05:00.000Z"),
    memoryGenerationSnapshot: 1,
    memoryRevisionSnapshot: 1,
    pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: "a".repeat(64),
    sourceMessageId: "message-1",
    sourceRevision: 1,
    stage: null,
    targetFactVersionId: "version-pending",
    userId: "user-1"
  };
}

function repository(value = snapshot()) {
  const apply = vi.fn(async () => undefined);
  const repo = {
    apply,
    auxiliaryCallAvailable: vi.fn(async () => false),
    preflight: vi.fn(async () => ({ status: "READY" as const })),
    prepare: vi.fn(async () => ({
      prepared: { snapshot: value, snapshotHash: "b".repeat(64) },
      status: "READY" as const
    })),
    recordAuxiliaryResult: vi.fn(async () => undefined),
    reserveAuxiliaryCall: vi.fn(async () => ({ status: "UNAVAILABLE" as const })),
    settleTerminal: vi.fn(async () => undefined)
  } satisfies MemoryRelationRepository;
  return { apply, repo };
}

describe("Memory relation handler", () => {
  it("applies only the structured deterministic decision", async () => {
    const { apply, repo } = repository();
    const provider = { resolve: vi.fn() };
    const handler = createMemoryRelationHandler({ provider, repository: repo });
    const result = await handler.execute(claim(), {
      now: () => NOW,
      setStage: vi.fn(async () => undefined),
      signal: new AbortController().signal
    });
    expect(result.stage).toBe("relation_supersede_target");
    await result.apply?.({} as never, claim());
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ operation: "SUPERSEDE_TARGET" }),
        executionId: null
      }),
      NOW
    );
    expect(provider.resolve).not.toHaveBeenCalled();
  });

  it("terminalizes unresolved structure without a late provider call", async () => {
    const value = snapshot();
    const { repo } = repository({
      ...value,
      pending: {
        ...value.pending,
        semanticAdjudication: null,
        structuredValue: { unsupported: true }
      }
    });
    const provider = { resolve: vi.fn() };
    const result = await createMemoryRelationHandler({ provider, repository: repo })
      .execute(claim(), {
        now: () => NOW,
        setStage: vi.fn(async () => undefined),
        signal: new AbortController().signal
      });
    expect(result.stage).toBe("relation_conflict");
    expect(provider.resolve).not.toHaveBeenCalled();
  });
});
