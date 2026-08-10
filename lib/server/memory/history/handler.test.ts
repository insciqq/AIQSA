import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { MemoryJobClaim } from "../coordinator/types";
import {
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryIndexJobFingerprint,
  memoryHistoryIndexResultHash,
  type MemoryHistoryIndexPlan,
  type MemoryHistoryIndexSourceIdentity
} from "./contract";
import { createMemoryHistoryIndexHandler } from "./handler";
import type { MemoryHistoryIndexRepository } from "./repository";

const source: MemoryHistoryIndexSourceIdentity = Object.freeze({
  activeLeafMessageId: "assistant-1",
  branchGeneration: 3,
  chatId: "chat-1",
  sourceHash: "a".repeat(64),
  sourceRevision: 7,
  userId: "user-1"
});

function claim(): MemoryJobClaim {
  return {
    ...source,
    attemptCount: 1,
    claimToken: randomUUID(),
    id: randomUUID(),
    idempotencyFingerprint: memoryHistoryIndexJobFingerprint({
      activeLeafMessageId: source.activeLeafMessageId,
      id: source.chatId,
      memoryBranchGeneration: source.branchGeneration,
      memorySourceRevision: source.sourceRevision,
      sourceHash: source.sourceHash,
      userId: source.userId
    }),
    kind: "INDEX_HISTORY",
    leaseExpiresAt: new Date("2026-08-10T12:05:00.000Z"),
    memoryGenerationSnapshot: 2,
    memoryRevisionSnapshot: 5,
    pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
    recoveredLease: false,
    stage: null
  };
}

function plan(): MemoryHistoryIndexPlan {
  const suppressionIdentitySnapshot = "b".repeat(64);
  return {
    chunks: [],
    resultHash: memoryHistoryIndexResultHash(
      source,
      [],
      suppressionIdentitySnapshot
    ),
    source,
    suppressionIdentitySnapshot
  };
}

function context() {
  return {
    now: () => new Date("2026-08-10T12:00:00.000Z"),
    setStage: vi.fn(async (_stage: string) => undefined),
    signal: new AbortController().signal
  };
}

describe("Memory INDEX_HISTORY handler", () => {
  it("rejects malformed jobs before repository access", async () => {
    const repository = {
      apply: vi.fn(),
      preflight: vi.fn(),
      prepare: vi.fn()
    } as unknown as MemoryHistoryIndexRepository;
    const handler = createMemoryHistoryIndexHandler({ repository });

    await expect(handler.preflight({
      ...claim(),
      idempotencyFingerprint: "index-history:wrong"
    })).resolves.toEqual({
      errorCode: "memory_history_job_invalid",
      status: "CANCELLED"
    });
    expect(repository.preflight).not.toHaveBeenCalled();
  });

  it("delegates local gating without consulting learning state", async () => {
    const current = claim();
    const preflight = vi.fn(async () => ({ status: "READY" as const }));
    const repository = {
      apply: vi.fn(),
      preflight,
      prepare: vi.fn()
    } as unknown as MemoryHistoryIndexRepository;
    const handler = createMemoryHistoryIndexHandler({ repository });

    await expect(handler.preflight(current)).resolves.toEqual({ status: "READY" });
    expect(preflight).toHaveBeenCalledWith(current);
  });

  it("returns one atomic apply closure for the exact prepared plan", async () => {
    const currentClaim = claim();
    const currentPlan = plan();
    const apply = vi.fn(async () => undefined);
    const repository = {
      apply,
      preflight: vi.fn(async () => ({ status: "READY" as const })),
      prepare: vi.fn(async () => ({ plan: currentPlan }))
    } as unknown as MemoryHistoryIndexRepository;
    const handler = createMemoryHistoryIndexHandler({ repository });
    const executionContext = context();

    const result = await handler.execute(currentClaim, executionContext);

    expect(result).toMatchObject({
      acceptedResultHash: currentPlan.resultHash,
      stage: "lexical_ready"
    });
    expect(executionContext.setStage.mock.calls.map(([stage]) => stage)).toEqual([
      "source_snapshot",
      "lexical_apply"
    ]);
    expect(result.apply).toBeTypeOf("function");
    await result.apply?.({} as never, currentClaim);
    expect(apply).toHaveBeenCalledWith(
      expect.anything(),
      currentClaim,
      currentPlan,
      new Date("2026-08-10T12:00:00.000Z")
    );
  });
});
