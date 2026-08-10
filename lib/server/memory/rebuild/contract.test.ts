import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MEMORY_REDREAM_BATCH_PIPELINE_VERSION,
  MEMORY_SHADOW_REBUILD_PIPELINE_VERSION,
  memoryRebuildJobClaimIsValid,
  memoryRedreamBatchJobFingerprint,
  memoryShadowRebuildJobFingerprint,
  parseMemoryRebuildJobFingerprint
} from "./contract";

function descriptor(input: Readonly<{
  fingerprint: string;
  pipelineVersion: string;
}>) {
  return {
    activeLeafMessageId: null,
    attemptCount: 0,
    branchGeneration: null,
    chatId: null,
    id: randomUUID(),
    idempotencyFingerprint: input.fingerprint,
    kind: "REBUILD_INDEX" as const,
    memoryGenerationSnapshot: 2,
    memoryRevisionSnapshot: 7,
    pipelineVersion: input.pipelineVersion,
    sourceHash: null,
    sourceRevision: null,
    stage: null,
    userId: "user-1"
  };
}

describe("Memory rebuild job contract", () => {
  it("round-trips bounded operation-specific shadow identities", () => {
    const generationId = randomUUID();
    for (const operation of ["REBUILD_SEARCH_INDEX", "REEMBED"] as const) {
      const fingerprint = memoryShadowRebuildJobFingerprint({
        generationId,
        operation,
        requestIdentity: { expectedMemoryRevision: 7 }
      });
      expect(fingerprint.length).toBeLessThanOrEqual(128);
      expect(parseMemoryRebuildJobFingerprint(fingerprint)).toMatchObject({
        generationId,
        operation,
        type: "SHADOW"
      });
      expect(memoryRebuildJobClaimIsValid(descriptor({
        fingerprint,
        pipelineVersion: MEMORY_SHADOW_REBUILD_PIPELINE_VERSION
      }))).toBe(true);
    }
  });

  it("round-trips redream batches and rejects pipeline or source ambiguity", () => {
    const batchId = randomUUID();
    const fingerprint = memoryRedreamBatchJobFingerprint({
      batchId,
      requestIdentity: { authorizationId: "authorization-1" }
    });
    expect(parseMemoryRebuildJobFingerprint(fingerprint)).toMatchObject({
      batchId,
      operation: "REDREAM_EXISTING_CHATS",
      type: "REDREAM"
    });
    expect(memoryRebuildJobClaimIsValid(descriptor({
      fingerprint,
      pipelineVersion: MEMORY_REDREAM_BATCH_PIPELINE_VERSION
    }))).toBe(true);
    expect(memoryRebuildJobClaimIsValid({
      ...descriptor({ fingerprint, pipelineVersion: MEMORY_SHADOW_REBUILD_PIPELINE_VERSION }),
      chatId: "chat-1"
    })).toBe(false);
    expect(parseMemoryRebuildJobFingerprint(`${fingerprint}x`)).toBeNull();
  });
});
