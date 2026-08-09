import { describe, expect, it } from "vitest";
import {
  mergeAnswerRoundUsage,
  parseToolLoopCheckpoint,
  snapshotToolLoopJson,
  toolLoopCheckpoint,
  toolLoopPersistenceLimits
} from "./toolLoopPersistence";

describe("tool-loop persistence values", () => {
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

  it("still accepts a strict legacy v1 checkpoint", () => {
    const checkpoint = {
      phase: "provider_running",
      providerContinuation: null,
      providerCursor: null,
      roundIndex: 1,
      version: 1
    } as const;
    expect(parseToolLoopCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("replaces partial round usage with terminal evidence and keeps terminal repeats idempotent", () => {
    const partial = {
      completeness: "partial" as const,
      roundIndex: 2,
      usage: {
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
    const usage = {
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
    ], 5))).toBeNull();
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

  it("rejects invalid and oversized continuation data", () => {
    expect(parseToolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: { value: Number.NaN },
      providerCursor: null,
      roundIndex: 0,
      version: 1
    })).toBeNull();
    expect(parseToolLoopCheckpoint({
      extra: "not compact",
      phase: "provider_running",
      providerContinuation: null,
      providerCursor: null,
      roundIndex: 0,
      version: 1
    })).toBeNull();
    expect(toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: { value: "x".repeat(toolLoopPersistenceLimits.checkpointBytes) },
      roundIndex: 0
    })).toBeNull();
    expect(snapshotToolLoopJson(undefined, 100)).toBeNull();
  });
});
