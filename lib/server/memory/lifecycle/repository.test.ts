import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { MemoryDeletionContributorRegistry } from "../purge/registry";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  createPrismaMemoryLifecycleRepository,
  type MemoryForgetMutationInput
} from "./repository";

const keyring = MemorySuppressionKeyring.parse(
  `current=fixture,fixture=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 31)).toString("base64")}`
);
const contributors = new MemoryDeletionContributorRegistry({
  operation: "FORGET_PURGE",
  requirements: [{ id: "fixture", version: "v1" }]
});

function input(modelRunId: string | null, persistedToolCallId: string | null): MemoryForgetMutationInput {
  return {
    authorization: {
      action: "FORGET",
      authorizationId: "authorization-1",
      authorizedPayloadHash: "a".repeat(64),
      expectedTargetVersionId: "version-1",
      targetFactId: "fact-1"
    },
    expectedVersionId: "version-1",
    factId: "fact-1",
    idempotencyFingerprint: "operation-1",
    idempotencyPayloadHash: "b".repeat(64),
    modelRunId,
    now: new Date("2026-08-10T12:00:00.000Z"),
    persistedToolCallId,
    requestId: "request-1"
  };
}

describe("Memory lifecycle provenance admission", () => {
  it.each([
    { origin: "UI", modelRunId: null, persistedToolCallId: null },
    { origin: "chat control", modelRunId: "run-1", persistedToolCallId: null },
    { origin: "legacy tool", modelRunId: "run-1", persistedToolCallId: "tool-1" }
  ])("reaches transactional authority checks for $origin", async ({ modelRunId, persistedToolCallId }) => {
    const transactionalGuard = new Error("transactional_authority_guard");
    const transaction = vi.fn(async () => { throw transactionalGuard; });
    const repository = createPrismaMemoryLifecycleRepository(
      keyring,
      contributors,
      { $transaction: transaction } as unknown as PrismaClient
    );
    await expect(repository.forget("owner-1", input(modelRunId, persistedToolCallId)))
      .rejects.toBe(transactionalGuard);
    expect(transaction).toHaveBeenCalledOnce();
  });

  it("rejects an orphan tool reference before opening a transaction", async () => {
    const transaction = vi.fn();
    const repository = createPrismaMemoryLifecycleRepository(
      keyring,
      contributors,
      { $transaction: transaction } as unknown as PrismaClient
    );
    await expect(repository.forget("owner-1", input(null, "tool-1")))
      .rejects.toMatchObject({ code: "memory_input_invalid" });
    expect(transaction).not.toHaveBeenCalled();
  });
});
