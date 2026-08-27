import { describe, expect, it } from "vitest";
import { memorySha256 } from "../persistence/lexical";
import { memoryHistorySuppressionIdentitySnapshot } from "./admissionIdentity";

describe("memory history admission identity", () => {
  it("preserves the canonical incremental-index fingerprint shape", () => {
    const createdAt = new Date("2026-08-27T08:00:00.000Z");
    const cutoff = new Date("2026-08-27T07:00:00.000Z");
    const pausedAt = new Date("2026-08-27T06:00:00.000Z");
    const resumedAt = new Date("2026-08-27T06:30:00.000Z");
    const expiresAt = new Date("2026-08-28T08:00:00.000Z");
    const input = {
      barriers: [{
        createdAt,
        explicitOverrideAllowed: false,
        id: "barrier-1",
        kind: "HISTORY_INDEX",
        memoryGeneration: 3,
        sourceCreatedAtCutoff: cutoff
      }],
      checkpointResumeCutoff: cutoff,
      pauseIntervals: [{
        id: "pause-1",
        memoryGeneration: 4,
        pausedAt,
        resumedAt,
        scope: "SEARCH_HISTORY"
      }],
      suppressions: [{
        expiresAt,
        fingerprintKeyVersion: "key-v1",
        id: "suppression-1",
        scope: "SOURCE_MESSAGE",
        sourceBranchGeneration: 5,
        sourceChatId: "chat-1",
        sourceMessageId: "message-1"
      }]
    } as const;

    expect(memoryHistorySuppressionIdentitySnapshot(input)).toBe(memorySha256({
      barriers: input.barriers,
      checkpointResumeCutoff: cutoff,
      pauseIntervals: input.pauseIntervals,
      suppressions: input.suppressions
    }));
  });

  it("does not admit ordering-only metadata into the fingerprint", () => {
    const suppression = {
      expiresAt: null,
      fingerprintKeyVersion: "key-v1",
      id: "suppression-1",
      scope: "ALL",
      sourceBranchGeneration: null,
      sourceChatId: null,
      sourceMessageId: null
    } as const;
    const baseline = memoryHistorySuppressionIdentitySnapshot({
      barriers: [],
      checkpointResumeCutoff: null,
      pauseIntervals: [],
      suppressions: [suppression]
    });
    const withOrderingMetadata = {
      ...suppression,
      createdAt: new Date("2026-08-27T08:00:00.000Z")
    };

    expect(memoryHistorySuppressionIdentitySnapshot({
      barriers: [],
      checkpointResumeCutoff: null,
      pauseIntervals: [],
      suppressions: [withOrderingMetadata]
    })).toBe(baseline);
  });
});
