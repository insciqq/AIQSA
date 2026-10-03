import { describe, expect, it } from "vitest";
import type { MemoryJobDescriptor } from "../coordinator/types";
import {
  MEMORY_HISTORY_AUTO_HEAL_POLICY_VERSION,
  MEMORY_HISTORY_INDEX_PIPELINE_VERSION,
  memoryHistoryAutoHealJobFingerprint,
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

describe("memory history auto-heal identity", () => {
  it("admits v3 repairs and keeps v2 repairs admitted before the upgrade valid until they settle", () => {
    expect(MEMORY_HISTORY_AUTO_HEAL_POLICY_VERSION).toBe("v3");
    const current = memoryHistoryAutoHealJobFingerprint(source, 2, 22);
    const stable = memoryHistoryIndexJobFingerprint(source).slice("index-history:".length);
    expect(current).toBe(`heal-history:${stable}:v3:22:2`);
    const previous = current.replace(":v3:", ":v2:");

    expect(memoryHistoryIndexClaimIsValid(claim(memoryHistoryIndexJobFingerprint(source)))).toBe(true);
    expect(memoryHistoryIndexClaimIsValid(claim(current))).toBe(true);
    expect(memoryHistoryIndexClaimIsValid(claim(previous))).toBe(true);
    // Legacy unversioned repairs stay valid as before.
    expect(memoryHistoryIndexClaimIsValid(claim(memoryHistoryAutoHealJobFingerprint(source, 3)))).toBe(true);
  });

  it("rejects retired, future and forged repair identities", () => {
    const current = memoryHistoryAutoHealJobFingerprint(source, 1, 22);
    for (const fingerprint of [
      current.replace(":v3:", ":v1:"),
      current.replace(":v3:", ":v4:"),
      current.replace(":v3:22:", ":v3:022:"),
      current.replace(/:1$/u, ":4"),
      `heal-history:${"0".repeat(64)}:v3:22:1`,
      `heal-history:${"0".repeat(64)}:v2:22:1`
    ]) {
      expect(memoryHistoryIndexClaimIsValid(claim(fingerprint)), fingerprint).toBe(false);
    }
    // A repair proves only its own exact source.
    expect(memoryHistoryIndexClaimIsValid({ ...claim(current), sourceRevision: 6 })).toBe(false);
    expect(memoryHistoryIndexClaimIsValid({ ...claim(current.replace(":v3:", ":v2:")), sourceRevision: 6 })).toBe(false);
  });
});
