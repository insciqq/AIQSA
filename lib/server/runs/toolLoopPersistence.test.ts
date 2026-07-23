import { describe, expect, it } from "vitest";
import {
  parseToolLoopCheckpoint,
  snapshotToolLoopJson,
  toolLoopCheckpoint,
  toolLoopPersistenceLimits
} from "./toolLoopPersistence";

describe("tool-loop persistence values", () => {
  it("creates a detached bounded v1 checkpoint", () => {
    const continuation = { responseId: "response-1", toolCalls: [{ id: "call-1" }] };
    const checkpoint = toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: continuation,
      providerCursor: 2,
      roundIndex: 1
    });
    continuation.responseId = "mutated";

    expect(checkpoint).toEqual({
      phase: "provider_running",
      providerContinuation: { responseId: "response-1", toolCalls: [{ id: "call-1" }] },
      providerCursor: 2,
      roundIndex: 1,
      version: 1
    });
    expect(parseToolLoopCheckpoint(checkpoint)).toEqual(checkpoint);
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
