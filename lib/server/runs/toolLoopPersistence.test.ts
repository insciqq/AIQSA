import { describe, expect, it } from "vitest";
import {
  mergeAnswerRoundUsage,
  parseToolLoopCheckpoint,
  snapshotToolLoopJson,
  toolLoopCheckpoint,
  toolLoopPersistenceLimits
} from "./toolLoopPersistence";

describe("tool-loop persistence values", () => {
  it("round-trips the bounded masking checkpoint without archiving the transcript", () => {
    const contextCompaction = {
      branchId: "message-1",
      followupDigest: "b".repeat(64),
      followupRevision: 2,
      measurement: {
        afterTokens: 40,
        beforeTokens: 120,
        budgetTokens: 200,
        legacyFallback: false,
        maskedBatches: 1,
        maskedObservations: 2,
        outcome: "masking_applied" as const,
        version: 1 as const
      },
      observationRefs: [`tor1_${"a".repeat(32)}`],
      ownerId: "user-1",
      pinDigest: "c".repeat(64),
      policyRevision: "legacy-compatible-v1" as const,
      providerProjectionRevision: 1,
      recentTailCallIds: ["call-2"],
      runId: "run-1",
      sourceDigest: "d".repeat(64),
      version: 1 as const
    };
    const checkpoint = toolLoopCheckpoint({
      contextCompaction,
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 1
    });
    expect(checkpoint?.contextCompaction).toEqual(contextCompaction);
    expect(parseToolLoopCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("round-trips bounded hybrid summary notes and attempt receipts", () => {
    const summary = {
      formatVersion: 1 as const,
      id: "cs1_" + "a".repeat(32),
      notes: "A bounded derived note.",
      sourceDigest: "b".repeat(64),
      sourceRefs: ["message-old"]
    };
    const summaryAttempts = [{
      attempt: 1,
      bindingDigest: "c".repeat(64),
      id: "csa1_" + "d".repeat(32),
      sourceDigest: "b".repeat(64),
      state: "committed" as const,
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }
    }];
    const contextCompaction = {
      branchId: "message-current",
      followupDigest: "e".repeat(64),
      followupRevision: 0,
      measurement: {
        afterTokens: 100,
        beforeTokens: 300,
        budgetTokens: 200,
        legacyFallback: false,
        maskedBatches: 1,
        maskedObservations: 2,
        outcome: "needs_summary" as const,
        version: 1 as const
      },
      observationRefs: [],
      ownerId: "user-1",
      pinDigest: "f".repeat(64),
      policyRevision: "hybrid-v1" as const,
      providerProjectionRevision: 1,
      recentTailCallIds: [],
      runId: "run-1",
      sourceDigest: "1".repeat(64),
      summary,
      summaryAttempts,
      version: 1 as const
    };
    const checkpoint = toolLoopCheckpoint({
      contextCompaction,
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 1
    });
    expect(parseToolLoopCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("creates a detached bounded v2 checkpoint", () => {
    const continuation = { responseId: "response-1", toolCalls: [{ id: "call-1" }] };
    const checkpoint = toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: continuation,
      providerCursor: 2,
      roundIndex: 1
    });
    continuation.responseId = "mutated";

    expect(checkpoint).toEqual({
      answerRoundUsage: [],
      phase: "provider_running",
      providerContinuation: { responseId: "response-1", toolCalls: [{ id: "call-1" }] },
      providerCursor: 2,
      roundIndex: 1,
      version: 2
    });
    expect(parseToolLoopCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("replaces partial round usage with terminal evidence and keeps terminal repeats idempotent", () => {
    const partial = {
      completeness: "partial" as const,
      roundIndex: 2,
      usage: { completeness: "complete" as const,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        inputTokens: 7,
        outputTokens: 2,
        reasoningTokens: 1,
        totalTokens: 9
      }
    };
    const terminal = {
      completeness: "terminal" as const,
      roundIndex: 2,
      usage: { ...partial.usage, outputTokens: 4, totalTokens: 11 }
    };

    expect(mergeAnswerRoundUsage([], partial, 2)).toEqual([partial]);
    expect(mergeAnswerRoundUsage([partial], terminal, 2)).toEqual([terminal]);
    expect(mergeAnswerRoundUsage([terminal], terminal, 2)).toEqual([terminal]);
    expect(mergeAnswerRoundUsage([terminal], partial, 2)).toBeNull();
    expect(mergeAnswerRoundUsage([terminal], {
      ...terminal,
      usage: { ...terminal.usage, totalTokens: 12 }
    }, 2)).toBeNull();
  });

  it("rejects malformed, duplicate, and out-of-bound round usage evidence", () => {
    const usage = { completeness: "complete" as const,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2
    };
    const checkpoint = (answerRoundUsage: unknown, roundIndex = 2) => ({
      answerRoundUsage,
      phase: "provider_running",
      providerContinuation: null,
      providerCursor: null,
      roundIndex,
      version: 2
    });

    expect(parseToolLoopCheckpoint(checkpoint([
      { completeness: "terminal", roundIndex: 1, usage },
      { completeness: "partial", roundIndex: 1, usage }
    ]))).toBeNull();
    expect(parseToolLoopCheckpoint(checkpoint([
      { completeness: "terminal", extra: true, roundIndex: 1, usage }
    ]))).toBeNull();
    expect(parseToolLoopCheckpoint(checkpoint([
      { completeness: "terminal", roundIndex: 3, usage }
    ]))).toBeNull();
    expect(parseToolLoopCheckpoint(checkpoint([
      { completeness: "terminal", roundIndex: 5, usage }
    ], 5))).toEqual(checkpoint([
      { completeness: "terminal", roundIndex: 5, usage }
    ], 5));
    expect(parseToolLoopCheckpoint(checkpoint([
      {
        completeness: "terminal",
        roundIndex: 1,
        usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }
      },
      { completeness: "terminal", roundIndex: 2, usage }
    ]))).toBeNull();
    expect(mergeAnswerRoundUsage([{
      completeness: "terminal",
      roundIndex: 1,
      usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }
    }], {
      completeness: "terminal",
      roundIndex: 2,
      usage
    }, 2)).toBeNull();
  });

  it("keeps usage evidence for 200 tool rounds plus final synthesis", () => {
    const usage = { completeness: "complete" as const,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2
    };
    const answerRoundUsage = Array.from({ length: 201 }, (_, index) => ({
      completeness: "terminal" as const,
      roundIndex: index + 1,
      usage
    }));

    const checkpoint = toolLoopCheckpoint({
      answerRoundUsage,
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 201
    });

    expect(checkpoint?.answerRoundUsage).toHaveLength(201);
    expect(checkpoint?.answerRoundUsage.at(-1)?.roundIndex).toBe(201);
  });

  it("rejects invalid and oversized continuation data", () => {
    expect(parseToolLoopCheckpoint({
      answerRoundUsage: [],
      phase: "provider_running",
      providerContinuation: { value: Number.NaN },
      providerCursor: null,
      roundIndex: 0,
      version: 2
    })).toBeNull();
    expect(parseToolLoopCheckpoint({
      answerRoundUsage: [],
      extra: "not compact",
      phase: "provider_running",
      providerContinuation: null,
      providerCursor: null,
      roundIndex: 0,
      version: 2
    })).toBeNull();
    expect(toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: { value: "x".repeat(toolLoopPersistenceLimits.checkpointBytes) },
      roundIndex: 0
    })).toBeNull();
    expect(snapshotToolLoopJson(undefined, 100)).toBeNull();
  });
});
