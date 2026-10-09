import { describe, expect, it } from "vitest";
import type { MemoryJobDescriptor } from "../coordinator/types";
import {
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryIndexClaimIsValid,
  memoryHistoryIndexJobFingerprint,
  memoryHistoryIndexPlanIsPartial,
  memoryHistoryIndexResultHash,
  type MemoryHistoryToolCallReplay
} from "./contract";

const source = Object.freeze({
  activeLeafMessageId: "assistant-1",
  id: "chat-1",
  memoryBranchGeneration: 2,
  memorySourceRevision: 5,
  sourceHash: "a".repeat(64),
  userId: "user-1"
});

function claim(idempotencyFingerprint: string): MemoryJobDescriptor {
  return {
    activeLeafMessageId: source.activeLeafMessageId,
    attemptCount: 1,
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    id: "job-1",
    idempotencyFingerprint,
    kind: "INDEX_HISTORY",
    memoryGenerationSnapshot: 1,
    memoryRevisionSnapshot: 1,
    pipelineVersion: MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
    sourceHash: source.sourceHash,
    sourceMessageId: null,
    sourceRevision: source.memorySourceRevision,
    stage: null,
    targetFactVersionId: null,
    userId: source.userId
  };
}

describe("memory history index identity", () => {
  it("claims only the exact source job, never a retired enrichment repair", () => {
    const fingerprint = memoryHistoryIndexJobFingerprint(source);
    const stable = fingerprint.slice("index-history:".length);
    expect(memoryHistoryIndexClaimIsValid(claim(fingerprint))).toBe(true);
    for (const repair of [
      `heal-history:${stable}:v3:22:2`,
      `heal-history:${stable}:v2:22:1`,
      `heal-history:${stable}:3`
    ]) {
      expect(memoryHistoryIndexClaimIsValid(claim(repair)), repair).toBe(false);
    }
    expect(memoryHistoryIndexClaimIsValid({ ...claim(fingerprint), sourceRevision: 6 })).toBe(false);
  });
});

describe("memory history index pages", () => {
  const identity = Object.freeze({
    activeLeafMessageId: source.activeLeafMessageId,
    branchGeneration: source.memoryBranchGeneration,
    chatId: source.id,
    sourceHash: source.sourceHash,
    sourceRevision: source.memorySourceRevision,
    userId: source.userId
  });
  const checkpointMessages = [{
    createdAt: "2026-10-09T10:00:00.000Z",
    messageId: source.activeLeafMessageId,
    ordinal: 0,
    sourceMessageUpdatedAt: "2026-10-09T10:00:00.000Z"
  }];

  it("keeps a page that leaves changed tool calls to replay partial", () => {
    expect(memoryHistoryIndexPlanIsPartial({ checkpointMessages, source: identity, toolCallReplay: null }))
      .toBe(false);
    expect(memoryHistoryIndexPlanIsPartial({ checkpointMessages, source: identity,
      toolCallReplay: { after: null } })).toBe(true);
    expect(memoryHistoryIndexPlanIsPartial({ checkpointMessages, source: identity,
      toolCallReplay: { after: { id: "call-7", updatedAt: "2026-10-09T10:05:00.000Z" } } })).toBe(true);
    // A page of a longer tail stays partial as before.
    expect(memoryHistoryIndexPlanIsPartial({ checkpointMessages, source: { ...identity,
      activeLeafMessageId: "assistant-2" }, toolCallReplay: null })).toBe(true);
  });

  it("binds the replay position into the accepted result and leaves other plans' hashes as they were", () => {
    const hash = (toolCallReplay?: MemoryHistoryToolCallReplay | null) =>
      memoryHistoryIndexResultHash(identity, [], "b".repeat(64), null, "UTC",
        { checkpointMessages, ...(toolCallReplay === undefined ? {} : { toolCallReplay }) });
    const after = { id: "call-7", updatedAt: "2026-10-09T10:05:00.000Z" };
    expect(hash(null)).toBe(hash());
    expect(new Set([
      hash(null),
      hash({ after: null }),
      hash({ after }),
      hash({ after: { ...after, id: "call-8" } }),
      hash({ after: { ...after, updatedAt: "2026-10-09T10:05:00.001Z" } })
    ]).size).toBe(5);
  });
});
