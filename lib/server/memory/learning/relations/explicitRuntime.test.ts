import type { PrismaClient } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../../coordinator/types";
import { MemoryExecutionError } from "../../execution/errors";
import type { MemoryTransaction } from "../../persistence/transaction";
import { createPrismaMemoryExplicitRelationAuxiliaryStore } from "./explicitAuxiliary";
import { createMemoryExplicitRelationHandler } from "./explicitHandler";
import type { MemoryExplicitRelationSnapshot } from "./explicitPolicy";
import {
  assertMemoryExplicitRelationRecoverySnapshot,
  createMemoryExplicitRelationRecovery,
  decodeMemoryExplicitRelationRecovery,
  memoryExplicitRelationOutputHash
} from "./explicitRecovery";
import type { MemoryExplicitRelationRepository } from "./explicitRepository";
import { memoryExplicitRelationInputHash } from "./explicitResolver";

const { transaction } = vi.hoisted(() => ({ transaction: vi.fn() }));
vi.mock("../../persistence/transaction", async (original) => ({
  ...await original<typeof import("../../persistence/transaction")>(),
  withLockedMemoryTransaction: transaction
}));

const now = new Date("2026-09-14T12:00:00.000Z");
const job: MemoryJobClaim = {
  activeLeafMessageId: null, attemptCount: 1, branchGeneration: null, chatId: null,
  claimToken: "lease-token", id: "job", idempotencyFingerprint: "fingerprint",
  kind: "RESOLVE_FACT_RELATIONS", leaseExpiresAt: new Date(now.getTime() + 30_000),
  memoryGenerationSnapshot: 1, memoryRevisionSnapshot: 4,
  pipelineVersion: "memory-explicit-relation-v1", recoveredLease: false,
  sourceHash: null, sourceMessageId: null, sourceRevision: null, stage: null,
  targetFactVersionId: "source-version", userId: "owner"
};

function snapshot(): MemoryExplicitRelationSnapshot {
  const source = {
    createdAt: now.toISOString(), evidenceHash: "a".repeat(64), expectedAt: null,
    expiresAt: null, factId: "source-fact", modality: "STATE", observedAt: now.toISOString(),
    occurredAt: null, pinned: false, scopeId: "scope", statement: "私は陶芸を教えています。",
    systemFrom: now.toISOString(), validFrom: null, validTo: null, versionId: "source-version"
  };
  return {
    candidates: [{ ...source, factId: "other-fact", statement: "Doy clases de cerámica.", versionId: "other-version" }],
    memoryGeneration: 1, source, userId: "owner"
  };
}

function accepted(input = snapshot()) {
  const decisions = [{ confidenceBand: "HIGH", relation: "EQUIVALENT", targetRef: "R1" }] as const;
  const inputHash = memoryExplicitRelationInputHash(input);
  const outputHash = memoryExplicitRelationOutputHash(inputHash, decisions);
  return {
    bindingId: "binding",
    packet: createMemoryExplicitRelationRecovery(input, decisions, outputHash)
  };
}

function reservation() {
  return {
    acceptedOutputHash: null, completedAt: null, createdAt: now, executionId: null,
    inputHash: null, ownerJobId: "job", purpose: "EXPLICIT_FACT_EQUIVALENCE",
    result: null, sourceMessageId: null, targetFactVersionId: "source-version", userId: "owner"
  };
}

function settledReservation() {
  const result = accepted();
  return {
    ...reservation(), acceptedOutputHash: result.packet.outputHash, completedAt: now,
    executionId: result.bindingId, inputHash: result.packet.inputHash, result: result.packet
  };
}

beforeEach(() => vi.resetAllMocks());

describe("explicit relation recovery packet", () => {
  it("recovers exact accepted decisions without storing source statements", () => {
    const input = snapshot();
    const result = accepted(input);
    const packet = JSON.parse(JSON.stringify(result.packet));
    expect(decodeMemoryExplicitRelationRecovery(packet, {
      acceptedOutputHash: result.packet.outputHash, inputHash: result.packet.inputHash,
      sourceVersionId: job.targetFactVersionId!
    })).toEqual(result.packet);
    expect(JSON.stringify(packet)).not.toContain(input.source.statement);
    expect(JSON.stringify(packet)).not.toContain(input.candidates[0]!.statement);
    expect(() => assertMemoryExplicitRelationRecoverySnapshot(result.packet, input)).not.toThrow();
  });

  it("rejects altered decisions, private extra fields, missing coverage and different receipts", () => {
    const { packet } = accepted();
    const expected = {
      acceptedOutputHash: packet.outputHash, inputHash: packet.inputHash, sourceVersionId: packet.sourceVersionId
    };
    for (const value of [
      { ...packet, statement: "private source text" },
      { ...packet, decisions: [] },
      { ...packet, decisions: [{ ...packet.decisions[0], relation: "DISTINCT" }] },
      { ...packet, decisions: [{ ...packet.decisions[0], targetRef: "R2" }] },
      { ...packet, decisions: [{ ...packet.decisions[0], reason: "private source text" }] },
      { ...packet, candidateVersionIds: [packet.sourceVersionId] },
      { ...packet, candidateVersionIds: ["other-version", "other-version"] },
      { ...packet, sourceVersionId: "replacement-version" },
      { ...packet, outputHash: "b".repeat(64) },
      { ...packet, inputHash: "b".repeat(64) }
    ]) expect(() => decodeMemoryExplicitRelationRecovery(value, expected))
      .toThrow("memory_explicit_relation_recovery_invalid");
  });

  it("rejects replay after owner, evidence, version, pin, or generation changes", () => {
    const input = snapshot();
    const { packet } = accepted(input);
    for (const changed of [
      { ...input, userId: "another-owner" },
      { ...input, memoryGeneration: 2 },
      { ...input, source: { ...input.source, versionId: "replacement-version" } },
      { ...input, source: { ...input.source, evidenceHash: "b".repeat(64) } },
      { ...input, candidates: [{ ...input.candidates[0]!, pinned: true }] }
    ]) expect(() => assertMemoryExplicitRelationRecoverySnapshot(packet, changed))
      .toThrow("memory_explicit_relation_snapshot_stale");
  });
});

function storeFixture() {
  const db = {
    memoryAuxiliarySemanticCall: {
      create: vi.fn(), findUnique: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    memoryExecutionBinding: { findMany: vi.fn().mockResolvedValue([]) },
    memoryJob: { findFirst: vi.fn().mockResolvedValue({ id: "job" }) }
  };
  const settings = { memoryGeneration: 1, useMemoryFacts: true, userId: "owner" };
  transaction.mockImplementation(async (_client, _userId, fn) => fn(db, settings));
  return {
    db, settings, store: createPrismaMemoryExplicitRelationAuxiliaryStore(db as unknown as PrismaClient),
    tx: db as unknown as MemoryTransaction
  };
}

describe("explicit relation single-dispatch reservation", () => {
  it("reserves the exact version under its current lease without a synthetic message", async () => {
    const { db, store } = storeFixture();
    await expect(store.reserve(job, accepted().packet.inputHash, now)).resolves.toEqual({ status: "ACQUIRED" });
    expect(db.memoryJob.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      leaseToken: "lease-token", attemptCount: 1, memoryGenerationSnapshot: 1, state: "CLAIMED", userId: "owner"
    }) }));
    const data = db.memoryAuxiliarySemanticCall.create.mock.calls[0]![0].data;
    expect(data).toMatchObject({ ownerJobId: "job", targetFactVersionId: "source-version", purpose: "EXPLICIT_FACT_EQUIVALENCE" });
    expect(data).not.toHaveProperty("sourceMessageId");
  });

  it("fences expired leases, pause and reset before reserving provider work", async () => {
    const { db, settings, store } = storeFixture();
    db.memoryJob.findFirst.mockResolvedValueOnce(null);
    await expect(store.reserve(job, accepted().packet.inputHash, now)).resolves.toEqual({ status: "UNAVAILABLE" });
    settings.useMemoryFacts = false;
    await expect(store.reserve(job, accepted().packet.inputHash, now)).resolves.toEqual({ status: "UNAVAILABLE" });
    settings.useMemoryFacts = true;
    settings.memoryGeneration = 2;
    await expect(store.reserve(job, accepted().packet.inputHash, now)).resolves.toEqual({ status: "UNAVAILABLE" });
    expect(db.memoryAuxiliarySemanticCall.create).not.toHaveBeenCalled();
  });

  it("recovers the retained result without asking for another execution", async () => {
    const { db, store } = storeFixture();
    db.memoryAuxiliarySemanticCall.findUnique.mockResolvedValue(settledReservation());
    await expect(store.reserve(job, accepted().packet.inputHash, now))
      .resolves.toEqual({ result: accepted(), status: "RECOVERED" });
    expect(db.memoryExecutionBinding.findMany).not.toHaveBeenCalled();
    expect(db.memoryAuxiliarySemanticCall.create).not.toHaveBeenCalled();
  });

  it("resumes only an unstarted identical binding and never repeats a dispatched or ambiguous call", async () => {
    const { db, store } = storeFixture();
    const inputHash = accepted().packet.inputHash;
    db.memoryAuxiliarySemanticCall.findUnique.mockResolvedValue(reservation());
    const pending = { inputHash, ordinal: 0, pipelineVersion: job.pipelineVersion, state: "PENDING" };
    db.memoryExecutionBinding.findMany.mockResolvedValue([pending]);
    await expect(store.reserve(job, inputHash, now)).resolves.toEqual({ status: "ACQUIRED" });
    for (const execution of [
      ...["RUNNING", "OUTCOME_UNKNOWN", "FAILED", "CANCELLED", "SUCCEEDED"].map((state) => ({ ...pending, state })),
      { ...pending, inputHash: "b".repeat(64) }, { ...pending, ordinal: 1 },
      { ...pending, pipelineVersion: "another-pipeline" }
    ]) {
      db.memoryExecutionBinding.findMany.mockResolvedValue([execution]);
      await expect(store.reserve(job, inputHash, now)).resolves.toEqual({ status: "UNAVAILABLE" });
    }
    expect(db.memoryAuxiliarySemanticCall.create).not.toHaveBeenCalled();
  });

  it("rejects a reservation belonging to another owner or job", async () => {
    const { db, store } = storeFixture();
    for (const change of [{ userId: "another-owner" }, { ownerJobId: "another-job" }]) {
      db.memoryAuxiliarySemanticCall.findUnique.mockResolvedValue({ ...reservation(), ...change });
      await expect(store.load(job)).rejects.toThrow("memory_explicit_relation_owner_invalid");
    }
  });

  it("persists the decoded packet once and treats identical settlement replay as read-only", async () => {
    const { db, store, tx } = storeFixture();
    const result = accepted();
    const durable = {
      acceptedOutputHash: result.packet.outputHash, bindingId: result.bindingId, completedAt: now,
      inputHash: result.packet.inputHash, recoverableUntil: new Date(now.getTime() + 86_400_000),
      replayed: false, value: result.packet.decisions
    };
    db.memoryAuxiliarySemanticCall.findUnique.mockResolvedValue(reservation());
    await store.persist(tx, job, snapshot(), durable);
    expect(db.memoryAuxiliarySemanticCall.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ executionId: "binding", result: result.packet })
    }));
    db.memoryAuxiliarySemanticCall.findUnique.mockResolvedValue(settledReservation());
    await store.persist(tx, job, snapshot(), { ...durable, replayed: true });
    expect(db.memoryAuxiliarySemanticCall.updateMany).toHaveBeenCalledOnce();
    await expect(store.persist(tx, job, snapshot(), { ...durable, bindingId: "another-binding" }))
      .rejects.toThrow("memory_explicit_relation_result_conflict");
  });

  it("does not invent a missing durable result for an already settled binding", async () => {
    const { db, store, tx } = storeFixture();
    const result = accepted();
    db.memoryAuxiliarySemanticCall.findUnique.mockResolvedValue(reservation());
    await expect(store.persist(tx, job, snapshot(), {
      acceptedOutputHash: result.packet.outputHash, bindingId: result.bindingId, completedAt: now,
      inputHash: result.packet.inputHash, recoverableUntil: now, replayed: true, value: result.packet.decisions
    })).rejects.toThrow("memory_explicit_relation_recovery_missing");
    expect(db.memoryAuxiliarySemanticCall.updateMany).not.toHaveBeenCalled();
  });
});

function handlerFixture() {
  const repository = {
    apply: vi.fn().mockResolvedValue(undefined), loadResult: vi.fn().mockResolvedValue(null),
    persistResult: vi.fn(), preflight: vi.fn().mockResolvedValue({ status: "READY" }),
    prepare: vi.fn().mockResolvedValue(snapshot()), reserve: vi.fn().mockResolvedValue({ status: "ACQUIRED" })
  } satisfies MemoryExplicitRelationRepository;
  const classify = vi.fn().mockResolvedValue(accepted());
  const probeAuthority = vi.fn().mockResolvedValue(undefined);
  const abort = new AbortController();
  const context = { now: () => now, setStage: vi.fn().mockResolvedValue(undefined), signal: abort.signal };
  return { abort, classify, context, probeAuthority, repository,
    handler: createMemoryExplicitRelationHandler({ classify, probeAuthority, repository }) };
}

describe("explicit relation job recovery and dispatch", () => {
  it("compares once and defers the mutation to the coordinator transaction", async () => {
    const { classify, context, handler, repository } = handlerFixture();
    const result = await handler.execute(job, context);
    expect(classify).toHaveBeenCalledExactlyOnceWith(job, snapshot(), context.signal);
    expect(repository.apply).not.toHaveBeenCalled();
    const tx = {} as MemoryTransaction;
    await result.apply!(tx, job);
    expect(repository.apply).toHaveBeenCalledExactlyOnceWith(tx, job, accepted(), now);
  });

  it("replays accepted output without another search, reservation or model call", async () => {
    const { classify, context, handler, probeAuthority, repository } = handlerFixture();
    repository.loadResult.mockResolvedValue(accepted());
    await expect(handler.preflight(job)).resolves.toEqual({ status: "READY" });
    const result = await handler.execute(job, context);
    expect(result.apply).toBeTypeOf("function");
    expect(probeAuthority).not.toHaveBeenCalled();
    expect(repository.prepare).not.toHaveBeenCalled();
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(classify).not.toHaveBeenCalled();
  });

  it("does not call the model for empty candidates or an unavailable reservation", async () => {
    const { classify, context, handler, repository } = handlerFixture();
    repository.prepare.mockResolvedValueOnce({ ...snapshot(), candidates: [] });
    expect((await handler.execute(job, context)).stage).toBe("explicit_relation_no_candidates");
    expect(repository.reserve).not.toHaveBeenCalled();
    repository.reserve.mockResolvedValue({ status: "UNAVAILABLE" });
    expect((await handler.execute(job, context)).stage).toBe("explicit_relation_call_unavailable");
    expect(classify).not.toHaveBeenCalled();
  });

  it("stops before external dispatch when cancelled after reservation", async () => {
    const { abort, classify, context, handler } = handlerFixture();
    context.setStage.mockImplementation(async (stage) => {
      if (stage === "explicit_relation_compare") abort.abort(new Error("job_stopped"));
    });
    await expect(handler.execute(job, context)).rejects.toThrow("job_stopped");
    expect(classify).not.toHaveBeenCalled();
  });

  it("does not retry a failed classification inside the handler", async () => {
    const { classify, context, handler, repository } = handlerFixture();
    classify.mockRejectedValue(new Error("transport_outcome_unknown"));
    await expect(handler.execute(job, context)).rejects.toThrow("transport_outcome_unknown");
    expect(classify).toHaveBeenCalledOnce();
    expect(repository.apply).not.toHaveBeenCalled();
  });

  it("waits for a missing configured capability and rejects fabricated chat authority", async () => {
    const { handler, probeAuthority, repository } = handlerFixture();
    probeAuthority.mockRejectedValue(new MemoryExecutionError("memory_execution_capability_unavailable"));
    await expect(handler.preflight(job)).resolves.toMatchObject({ status: "WAITING_FOR_CONFIGURATION" });
    repository.preflight.mockClear();
    await expect(handler.preflight({ ...job, sourceMessageId: "fabricated-message" }))
      .resolves.toMatchObject({ status: "CANCELLED" });
    expect(repository.preflight).not.toHaveBeenCalled();
  });
});
