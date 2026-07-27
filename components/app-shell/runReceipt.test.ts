import { describe, expect, it } from "vitest";
import type { ThreadArtifactSummary } from "./types";
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

describe("deriveRunReceipt", () => {
  it("projects only message-bound model and artifact facts", () => {
    const receipt = deriveRunReceipt({
      artifactSummary: summary({
        citationCount: 3,
        contextTruncation: { approxDroppedTokens: 100, droppedMessages: 2 },
        reasoningCount: 2,
        searchCount: 1,
        searchStrategy: "openai-native-web-search",
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
        { detail: "OpenAI web_search", kind: "search", label: "1 search call" },
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

  it("includes only terminal message-bound provider usage", () => {
    expect(
      deriveRunReceipt({
        messageStatus: "complete",
        modelLabel: null,
        runUsage: { totalTokens: 1_234 }
      }).facts
    ).toContainEqual({ kind: "usage", label: "1,234 tokens used" });

    expect(
      deriveRunReceipt({
        messageStatus: "complete",
        modelLabel: null
      }).facts
    ).not.toContainEqual(expect.objectContaining({ kind: "usage" }));

    expect(
      deriveRunReceipt({
        messageStatus: "complete",
        modelLabel: null,
        runUsage: { totalTokens: 0 }
      }).facts
    ).not.toContainEqual(expect.objectContaining({ kind: "usage" }));

    expect(
      deriveRunReceipt({
        messageStatus: "streaming",
        modelLabel: null,
        runUsage: { totalTokens: 1_234 }
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
