import { describe, expect, it, vi } from "vitest";
import { MemoryCoordinatorError } from "../../coordinator/errors";
import type { MemoryJobClaim } from "../../coordinator/types";
import {
  createMemoryRelationHandler
} from "./handler";
import {
  MEMORY_FACT_RELATION_PIPELINE_VERSION,
  type MemoryRelationSnapshot,
  type MemoryRelationVersionSnapshot
} from "./policy";
import type {
  MemoryAuxiliaryCallReservation,
  MemoryRelationRepository
} from "./repository";
import {
  memoryRelationAcceptedOutputHash,
  memoryRelationResolverInputHash,
  type MemoryRelationProviderResult
} from "./resolver";

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

function snapshot(ambiguous = false): MemoryRelationSnapshot {
  const current = version({
    structuredValue: ambiguous ? { unsupported: "left" } : { state: "owned" }
  });
  return {
    correctionTargetVersionId: null,
    current,
    dependencies: [],
    evidence: [],
    memoryGeneration: 2,
    memoryRevision: 7,
    pending: version({
      displayText: ambiguous
        ? "The user has a materially equivalent MacBook representation."
        : "The user returned the MacBook.",
      observedAt: "2026-08-24T09:30:00.000Z",
      ref: "P0",
      state: "PENDING_RELATION",
      structuredValue: ambiguous ? { unsupported: "right" } : { state: "returned" },
      systemFrom: "2026-08-24T09:30:00.000Z",
      versionId: "version-pending"
    }),
    related: [current],
    relations: [],
    sourceIdentity: {
      activeLeafMessageId: "assistant-1",
      branchGeneration: 3,
      chatId: "chat-1",
      sourceHash: "a".repeat(64),
      sourceMessageId: "message-1",
      sourceRevision: 4
    },
    sourceText: "I returned the MacBook."
  };
}

function claim(overrides: Partial<MemoryJobClaim> = {}): MemoryJobClaim {
  return {
    activeLeafMessageId: "assistant-1",
    attemptCount: 1,
    branchGeneration: 3,
    chatId: "chat-1",
    claimToken: "claim-1",
    id: "relation-job-1",
    idempotencyFingerprint: "f".repeat(64),
    kind: "RESOLVE_FACT_RELATIONS",
    leaseExpiresAt: new Date("2026-08-24T10:05:00.000Z"),
    memoryGenerationSnapshot: 2,
    memoryRevisionSnapshot: 7,
    pipelineVersion: MEMORY_FACT_RELATION_PIPELINE_VERSION,
    recoveredLease: false,
    sourceHash: "a".repeat(64),
    sourceMessageId: "message-1",
    sourceRevision: 4,
    stage: null,
    targetFactVersionId: "version-pending",
    userId: "user-1",
    ...overrides
  };
}

function providerResult(input: MemoryRelationSnapshot): MemoryRelationProviderResult {
  const inputHash = memoryRelationResolverInputHash(input);
  const decision = {
    confidenceBand: "HIGH" as const,
    operation: "MERGE_TARGET_INTO_NEW" as const,
    reasonCode: "same_truth_richer",
    targetRef: "R1"
  };
  return {
    acceptedOutputHash: memoryRelationAcceptedOutputHash(inputHash, decision),
    decision,
    executionId: "binding-1",
    inputHash,
    modelId: "model-1",
    policyVersion: "memory-fact-relation-policy-v2",
    providerId: "openai_compatible"
  };
}

function repository(
  input: MemoryRelationSnapshot,
  reservation: MemoryAuxiliaryCallReservation = { status: "ACQUIRED" }
) {
  return {
    apply: vi.fn(async () => undefined),
    auxiliaryCallAvailable: vi.fn(async () => true),
    preflight: vi.fn(async () => ({ status: "READY" as const })),
    prepare: vi.fn(async () => ({
      prepared: { snapshot: input, snapshotHash: "b".repeat(64) },
      status: "READY" as const
    })),
    recordAuxiliaryResult: vi.fn(async () => undefined),
    reserveAuxiliaryCall: vi.fn(async () => reservation),
    settleTerminal: vi.fn(async () => undefined)
  } satisfies MemoryRelationRepository;
}

function context() {
  return {
    now: () => NOW,
    setStage: vi.fn(async () => undefined),
    signal: new AbortController().signal
  };
}

function transaction() {
  return {
    $queryRaw: vi.fn(async () => [{
      acceptedUtilityEgressAt: null,
      acceptedUtilityEgressFingerprint: null,
      acceptedUtilityPolicyVersion: null,
      activeIndexGenerationId: null,
      embeddingProviderModelId: null,
      learnAutomatically: true,
      memoryConsentRevision: 0,
      memoryGeneration: 2,
      memoryRevision: 7,
      ownerStatus: "active",
      referenceChatHistory: true,
      sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
      settingsRevision: 0,
      useMemoryFacts: true,
      userId: "user-1"
    }])
  };
}

describe("memory relation handler", () => {
  it("applies deterministic transitions without spending the auxiliary call", async () => {
    const input = snapshot();
    const store = repository(input);
    const resolve = vi.fn();
    const handler = createMemoryRelationHandler({
      provider: { resolve },
      repository: store
    });
    const result = await handler.execute(claim(), context());
    expect(result.stage).toBe("relation_supersede_target");
    expect(resolve).not.toHaveBeenCalled();
    expect(store.reserveAuxiliaryCall).not.toHaveBeenCalled();
    await result.apply?.({} as never, claim());
    expect(store.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ operation: "SUPERSEDE_TARGET" }),
        executionId: null
      }),
      NOW
    );
  });

  it("settles a durable conflict when the relation target loses its current", async () => {
    const store = repository(snapshot());
    store.prepare.mockResolvedValueOnce({
      reason: "relation_current_missing",
      status: "TERMINAL"
    } as never);
    const handler = createMemoryRelationHandler({
      provider: { resolve: vi.fn() },
      repository: store
    });
    const result = await handler.execute(claim(), context());
    expect(result.stage).toBe("relation_current_missing");
    await result.apply?.({} as never, claim());
    expect(store.settleTerminal).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "relation_current_missing",
      NOW
    );
  });

  it("persists, authorizes, and applies one high-confidence merge decision", async () => {
    const input = snapshot(true);
    const store = repository(input);
    const output = providerResult(input);
    const authorizeResult = vi.fn(async () => undefined);
    const resolve = vi.fn(async () => output);
    const handler = createMemoryRelationHandler({
      authorizeResult,
      provider: { resolve },
      repository: store
    });
    const runContext = context();
    const result = await handler.execute(claim(), runContext);
    expect(result.stage).toBe("relation_merge_target_into_new");
    expect(store.recordAuxiliaryResult).toHaveBeenCalledWith(claim(), output, NOW);
    const tx = transaction();
    await result.apply?.(tx as never, claim());
    expect(authorizeResult).toHaveBeenCalledOnce();
    expect(store.apply).toHaveBeenCalledWith(
      tx,
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ operation: "MERGE_TARGET_INTO_NEW" }),
        executionId: output.executionId
      }),
      NOW
    );
  });

  it("recovers a stored call result without another provider request", async () => {
    const input = snapshot(true);
    const output = providerResult(input);
    const store = repository(input, { result: output, status: "RECOVERED" });
    const resolve = vi.fn();
    const handler = createMemoryRelationHandler({
      authorizeResult: vi.fn(async () => undefined),
      provider: { resolve },
      repository: store
    });
    const result = await handler.execute(claim({ attemptCount: 2 }), context());
    expect(resolve).not.toHaveBeenCalled();
    expect(store.recordAuxiliaryResult).not.toHaveBeenCalled();
    expect(result.stage).toBe("relation_merge_target_into_new");
  });

  it("maps an invalid receipt to a local conflict without authorizing it", async () => {
    const input = snapshot(true);
    const store = repository(input);
    const invalid = { ...providerResult(input), acceptedOutputHash: "0".repeat(64) };
    const authorizeResult = vi.fn(async () => undefined);
    const handler = createMemoryRelationHandler({
      authorizeResult,
      provider: { resolve: vi.fn(async () => invalid) },
      repository: store
    });
    const result = await handler.execute(claim(), context());
    expect(result.stage).toBe("relation_conflict");
    await result.apply?.(transaction() as never, claim());
    expect(authorizeResult).not.toHaveBeenCalled();
    expect(store.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ reasonCode: "provider_output_invalid" }),
        executionId: null
      }),
      NOW
    );
  });

  it("retries one provider failure, then terminalizes the consumed budget", async () => {
    const input = snapshot(true);
    const firstStore = repository(input);
    const handler = createMemoryRelationHandler({
      provider: { resolve: vi.fn(async () => { throw new Error("network"); }) },
      repository: firstStore
    });
    await expect(handler.execute(claim(), context())).rejects.toBeInstanceOf(
      MemoryCoordinatorError
    );

    const retryStore = repository(input, { status: "UNAVAILABLE" });
    const retry = createMemoryRelationHandler({
      provider: { resolve: vi.fn() },
      repository: retryStore
    });
    const result = await retry.execute(claim({ attemptCount: 2 }), context());
    expect(result.stage).toBe("relation_conflict");
    await result.apply?.({} as never, claim({ attemptCount: 2 }));
    expect(retryStore.apply).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        decision: expect.objectContaining({ reasonCode: "auxiliary_budget_exhausted" })
      }),
      NOW
    );
  });

  it("probes provider authority only for ambiguity with available budget", async () => {
    const probeAuthority = vi.fn(async () => undefined);
    const deterministicStore = repository(snapshot());
    const deterministic = createMemoryRelationHandler({
      probeAuthority,
      provider: { resolve: vi.fn() },
      repository: deterministicStore
    });
    await expect(deterministic.preflight(claim())).resolves.toEqual({ status: "READY" });
    expect(probeAuthority).not.toHaveBeenCalled();

    const ambiguous = createMemoryRelationHandler({
      probeAuthority,
      provider: { resolve: vi.fn() },
      repository: repository(snapshot(true))
    });
    await expect(ambiguous.preflight(claim())).resolves.toEqual({ status: "READY" });
    expect(probeAuthority).toHaveBeenCalledOnce();
  });
});
