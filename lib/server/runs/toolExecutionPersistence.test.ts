import { describe, expect, it } from "vitest";
import {
  parsePersistedToolExecutionResult,
  snapshotToolExecutionResult
} from "./toolExecutionPersistence";

const call = { id: "call-1", name: "search_via_perplexity" };

describe("persisted tool execution result codec", () => {
  it("round-trips bounded search evidence and usage", () => {
    const result = {
      artifacts: [{
        data: { artifactType: "search" as const, payload: { query: "current news" } },
        type: "artifact" as const
      }],
      callId: call.id,
      content: [{ text: "result", type: "text" as const }],
      name: call.name,
      rawPreview: { providerResponseId: "search-response-1", requestPreview: { query: "current news" } },
      status: "complete" as const,
      usage: { inputTokens: 3, outputTokens: 4, reasoningTokens: 0, totalTokens: 7 }
    };

    const snapshot = snapshotToolExecutionResult(result, 32_000);

    expect(snapshot).not.toBeNull();
    expect(parsePersistedToolExecutionResult(call, snapshot)).toEqual(result);
  });

  it("rejects mismatched identity, malformed evidence, and oversized results", () => {
    expect(parsePersistedToolExecutionResult(call, {
      callId: "other-call",
      content: [{ text: "result", type: "text" }],
      name: call.name,
      status: "complete"
    })).toBeNull();
    expect(parsePersistedToolExecutionResult(call, {
      artifacts: [{ data: { artifactType: "unknown", payload: {} }, type: "artifact" }],
      callId: call.id,
      content: [{ text: "result", type: "text" }],
      name: call.name,
      status: "complete"
    })).toBeNull();
    expect(snapshotToolExecutionResult({
      callId: call.id,
      content: [{ text: "x".repeat(100), type: "text" }],
      name: call.name,
      status: "complete"
    }, 32)).toBeNull();
  });
});
