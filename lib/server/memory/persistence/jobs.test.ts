import { describe, expect, it, vi } from "vitest";
import { enqueueMemoryJob } from "./jobs";
import type { LockedMemorySettings, MemoryTransaction } from "./transaction";

const settings = {
  acceptedUtilityEgressAt: null,
  acceptedUtilityEgressFingerprint: null,
  acceptedUtilityPolicyVersion: null,
  activeIndexGenerationId: null,
  embeddingProviderModelId: null,
  learnAutomatically: true,
  memoryConsentRevision: 0,
  memoryGeneration: 0,
  memoryRevision: 0,
  referenceChatHistory: true,
  sensitiveAutomaticPolicy: "EXPLICIT_ONLY",
  settingsRevision: 0,
  useMemoryFacts: true,
  userId: "user-1"
} satisfies LockedMemorySettings;

describe("Memory job enqueue boundary", () => {
  it("rejects retired coordinator kinds before touching the database", async () => {
    const memoryJob = {
      create: vi.fn(),
      findUnique: vi.fn()
    };
    const tx = { memoryJob } as unknown as MemoryTransaction;

    await expect(enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: "job-fingerprint",
      kind: "RECONCILE_BRANCH",
      pipelineVersion: "memory-test-v1"
    })).rejects.toThrow("memory_input_invalid");
    expect(memoryJob.findUnique).not.toHaveBeenCalled();
    expect(memoryJob.create).not.toHaveBeenCalled();
  });
});
