import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { NOOP_MEMORY_SOURCE_MUTATION_HOOKS } from "../memory/sourceState";
import { createPrismaRunRepository } from "./prismaRepository";

function repositoryCancellationHarness(mode: "cancel" | "fail") {
  const assistantMessageId = "assistant-message-one";
  const chatId = "chat-one";
  const runId = "run-one";
  const userId = "owner-one";
  const pendingCallIds = ["reserved-call", "dispatched-call"];
  let queryOrdinal = 0;
  const tx = {
    $queryRaw: vi.fn(async () => {
      queryOrdinal += 1;
      if (queryOrdinal === 1) {
        return mode === "cancel"
          ? [{
              assistantId: null,
              assistantMessageId,
              assistantRevisionId: null,
              chatId,
              id: runId,
              modelId: "answer-model",
              normalizedRequest: {},
              provider: "test",
              status: "in_progress",
              userId,
              userMessageId: "user-message-one"
            }]
          : [{ status: "in_progress", userId }];
      }
      return pendingCallIds.map((id) => ({ id }));
    }),
    chat: {
      findUnique: vi.fn(async () => ({ projectId: "project-one", userId: null }))
    },
    knowledgeBudgetReservation: {
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    message: {
      findUnique: vi.fn(async () => ({ groundedAt: null })),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    modelRun: {
      findFirst: vi.fn(async () => ({
        assistantMessageId,
        chatId,
        id: runId,
        modelId: "answer-model",
        provider: "test",
        providerResponseId: null,
        status: "cancelled"
      })),
      findUniqueOrThrow: vi.fn(async () => ({ assistantMessageId, chatId, id: runId })),
      updateMany: vi.fn(async () => ({ count: 1 }))
    },
    modelRunEvent: {
      deleteMany: vi.fn(async () => ({ count: 0 }))
    },
    modelRunToolCall: {
      updateMany: vi.fn(async () => ({ count: pendingCallIds.length }))
    }
  };
  const transaction = vi.fn(async (consume: (tx: unknown) => Promise<unknown>) => consume(tx));
  const client = { $transaction: transaction } as unknown as PrismaClient;
  return {
    assistantMessageId,
    repository: createPrismaRunRepository(client, {
      memorySourceHooks: NOOP_MEMORY_SOURCE_MUTATION_HOOKS
    }),
    runId,
    transaction,
    tx,
    userId
  };
}

function expectBudgetCancellationWrites(
  tx: ReturnType<typeof repositoryCancellationHarness>["tx"],
  runId: string
): void {
  expect(tx.knowledgeBudgetReservation.updateMany).toHaveBeenCalledTimes(4);
  expect(tx.knowledgeBudgetReservation.updateMany).toHaveBeenNthCalledWith(1, {
    data: {
      failureCode: "operation_cancelled",
      leaseExpiresAt: null,
      leaseToken: null,
      releasedAt: expect.any(Date),
      state: "released"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: ["reserved-call", "dispatched-call"] },
      purgedAt: null,
      state: "reserved"
    }
  });
  expect(tx.knowledgeBudgetReservation.updateMany).toHaveBeenNthCalledWith(3, {
    data: {
      ambiguousAt: expect.any(Date),
      failureCode: "operation_cancelled_after_dispatch",
      leaseExpiresAt: null,
      leaseToken: null,
      state: "ambiguous"
    },
    where: {
      modelRunId: runId,
      modelRunToolCallId: { in: ["reserved-call", "dispatched-call"] },
      purgedAt: null,
      state: "dispatched"
    }
  });
  expect(tx.modelRunToolCall.updateMany).toHaveBeenCalledWith({
    data: {
      completedAt: expect.any(Date),
      state: "cancelled"
    },
    where: {
      id: { in: ["reserved-call", "dispatched-call"] },
      modelRunId: runId,
      state: "pending"
    }
  });
}

describe("Prisma run terminal cancellation integration", () => {
  it("settles pending Knowledge reservations inside cancelRun's transaction", async () => {
    const harness = repositoryCancellationHarness("cancel");

    await expect(harness.repository.cancelRun({
      payload: { code: "run_cancelled", message: "Run cancelled" },
      runId: harness.runId,
      userId: harness.userId
    })).resolves.toMatchObject({ kind: "cancelled" });

    expectBudgetCancellationWrites(harness.tx, harness.runId);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });

  it("settles pending Knowledge reservations inside failRun's transaction", async () => {
    const harness = repositoryCancellationHarness("fail");

    await expect(harness.repository.failRun(
      harness.runId,
      harness.assistantMessageId,
      { code: "run_failed", message: "Run failed" }
    )).resolves.toBe(true);

    expectBudgetCancellationWrites(harness.tx, harness.runId);
    expect(harness.transaction).toHaveBeenCalledTimes(1);
  });
});
