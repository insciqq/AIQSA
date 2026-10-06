import { describe, expect, it } from "vitest";
import type { MemoryJobDescriptor } from "../coordinator/types";
import {
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryIndexClaimIsValid,
  memoryHistoryIndexJobFingerprint
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
