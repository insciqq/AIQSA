import { describe, expect, it } from "vitest";
import type { PersistedRun, ThreadArtifactSummary } from "./types";
import { deriveRunReceipt } from "./runReceipt";

function summary(overrides: Partial<ThreadArtifactSummary> = {}): ThreadArtifactSummary {
  return {
    citationCount: 0,
    citations: [],
    reasoningCount: 0,
    reasoningText: [],
    searchCount: 0,
    searchStrategy: null,
    toolCallCount: 0,
    toolCalls: [],
    ...overrides
  };
}

function persistedRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return {
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    errorPayload: null,
    estimatedCostMicros: null,
    events: [],
    id: "run-1",
    inputTokens: 900,
    modelId: "model-1",
    outputTokens: 334,
    provider: "provider-1",
    reasoningTokens: 0,
    searchRuns: [],
    status: "complete",
    toolCalls: [],
    totalTokens: 1_234,
    ...overrides
  };
}

describe("deriveRunReceipt", () => {
  it("projects only message-bound model and artifact facts", () => {
    const receipt = deriveRunReceipt({
      artifactSummary: summary({
        citationCount: 3,
        contextTruncation: { approxDroppedTokens: 100, droppedMessages: 2 },
        reasoningCount: 2,
        searchCount: 1,
        toolCallCount: 2,
        toolCalls: [
          {
            argumentsPreview: null,
            callId: "call-1",
            capability: "mcp",
            credentialSources: [],
            durationMs: 20,
            errorMessage: null,
            externalAccountLabel: null,
            ordinal: 0,
            resultPreview: null,
            round: 1,
            serverName: "Memory",
            status: "complete",
            toolName: "read"
          },
          {
            argumentsPreview: null,
            callId: "call-2",
            capability: "mcp",
            credentialSources: [],
            durationMs: 30,
            errorMessage: "failed",
            externalAccountLabel: null,
            ordinal: 1,
            resultPreview: null,
            round: 1,
            serverName: "Memory",
            status: "error",
            toolName: "write"
          }
        ]
      }),
      messageStatus: "complete",
      modelLabel: "OpenAI / GPT-5",
      warningCount: 1
    });

    expect(receipt).toEqual({
      facts: [
        { kind: "model", label: "OpenAI / GPT-5" },
        { kind: "search", label: "1 search call" },
        { kind: "tools", label: "2 tool calls (1 failed)" },
        { kind: "citations", label: "3 citations" },
        { kind: "reasoning", label: "2 reasoning traces" },
        { kind: "context", label: "Context trimmed" },
        { kind: "warnings", label: "1 warning" }
      ],
      status: "complete",
      statusLabel: "Complete"
    });
  });

  it("omits unavailable facts instead of inventing defaults", () => {
    const receipt = deriveRunReceipt({
      messageStatus: "complete",
      modelLabel: null
    });

    expect(receipt).toEqual({ facts: [], status: "complete", statusLabel: "Complete" });
    expect(JSON.stringify(receipt)).not.toMatch(/profile|cost|search off|usage|elapsed/i);
  });

  it("includes provider-reported token usage only for the exact answer run", () => {
    expect(
      deriveRunReceipt({
        messageRunId: "run-1",
        messageStatus: "complete",
        modelLabel: null,
        persistedRun: persistedRun()
      }).facts
    ).toContainEqual({ kind: "usage", label: "1,234 tokens used" });

    expect(
      deriveRunReceipt({
        messageRunId: "run-other",
        messageStatus: "complete",
        modelLabel: null,
        persistedRun: persistedRun()
      }).facts
    ).not.toContainEqual(expect.objectContaining({ kind: "usage" }));

    expect(
      deriveRunReceipt({
        messageRunId: "run-1",
        messageStatus: "complete",
        modelLabel: null,
        persistedRun: persistedRun({ totalTokens: 0 })
      }).facts
    ).not.toContainEqual(expect.objectContaining({ kind: "usage" }));

    expect(
      deriveRunReceipt({
        messageRunId: "run-1",
        messageStatus: "streaming",
        modelLabel: null,
        persistedRun: persistedRun({ status: "streaming" })
      }).facts
    ).not.toContainEqual(expect.objectContaining({ kind: "usage" }));
  });

  it("uses only observed live activity and terminal message status", () => {
    expect(
      deriveRunReceipt({
        messageStatus: "streaming",
        modelLabel: null,
        runActivity: { answer: "idle", phase: "running", question: "done", search: "active" }
      })
    ).toMatchObject({ status: "running", statusLabel: "Searching" });

    expect(
      deriveRunReceipt({
        messageStatus: "cancelled",
        modelLabel: null,
        runActivity: { answer: "active", phase: "running", question: "done", search: "done" }
      })
    ).toMatchObject({ status: "cancelled", statusLabel: "Stopped" });
  });
});
