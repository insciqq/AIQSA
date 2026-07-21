import { describe, expect, it } from "vitest";
import { summarizeInspectorEvents } from "./eventLog";

describe("summarizeInspectorEvents", () => {
  it("groups noisy artifact and token events into a readable digest", () => {
    const summaries = summarizeInspectorEvents([
      {
        data: {
          modelId: "gpt-5.5",
          provider: "openai",
          runId: "run-1",
          status: "streaming"
        },
        type: "run_start"
      },
      {
        data: {
          assistantMessageId: "assistant-1"
        },
        type: "message_start"
      },
      {
        data: {
          artifactType: "summary",
          payload: {
            status: "queued"
          }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "context_truncated",
          payload: {
            approxDroppedTokens: 42,
            droppedMessages: 3
          }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "citation",
          payload: {
            url: "https://example.com"
          }
        },
        type: "artifact"
      },
      {
        data: {
          delta: "hello world "
        },
        type: "token"
      },
      {
        data: {
          eventType: "token",
          message: "Skipped malformed stream frame"
        },
        type: "warning"
      },
      {
        data: {
          artifactType: "summary",
          payload: {
            status: "completed"
          }
        },
        type: "artifact"
      },
      {
        data: {
          chunkCount: 3,
          delta: "goodbye"
        },
        type: "token"
      },
      {
        data: {
          cachedInputTokens: 4,
          cacheWriteInputTokens: 1,
          estimatedCostMicros: 440,
          inputTokens: 10,
          outputTokens: 3,
          reasoningTokens: 0,
          totalTokens: 13
        },
        type: "usage"
      },
      {
        data: {
          runId: "run-1",
          status: "complete"
        },
        type: "done"
      }
    ]);

    expect(summaries.map((summary) => [summary.label, summary.value])).toEqual([
      ["Run", "streaming"],
      ["Assistant message", "created"],
      ["Provider status", "2 updates"],
      ["Context window", "dropped 3 messages"],
      ["Citations", "1"],
      ["Answer text", "4 chunks"],
      ["Warning", "Skipped malformed stream frame"],
      ["Usage", "13 tokens"],
      ["Done", "complete"]
    ]);
    expect(summaries[0]?.detail).toBe("OpenAI / gpt-5.5");
    expect(JSON.stringify(summaries)).not.toContain("hello world");
    expect(JSON.stringify(summaries)).not.toContain("assistant-1");
    expect(summaries.find((summary) => summary.label === "Answer text")?.detail).toBe("19 characters");
    expect(summaries.find((summary) => summary.label === "Provider status")?.detail).toBe("completed");
    expect(summaries.find((summary) => summary.label === "Context window")?.detail).toBe("~42 estimated tokens");
    expect(summaries.find((summary) => summary.label === "Usage")?.detail).toBe(
      "input 10 / cached 4 / cache write 1 / output 3 / reasoning 0 / total 13"
    );
    expect(JSON.stringify(summaries)).not.toContain("est. cost");
  });

  it("keeps search and tool activity at its chronological position while grouping repeated noise", () => {
    const longToolError = `Search provider rejected the tool result: ${"detail ".repeat(80).trim()}`;
    const summaries = summarizeInspectorEvents([
      {
        data: {
          artifactType: "tool_call",
          payload: { name: "search_via_perplexity", round: 1, status: "requested" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "search",
          payload: { provider: "openrouter", status: "in_progress", strategyId: "perplexity-tool-search" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "citation",
          payload: { title: "Source", url: "https://example.com/source" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "tool_result",
          payload: { name: "search_via_perplexity", round: 1, status: "complete" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "tool_call",
          payload: { name: "search_via_perplexity", round: 2, status: "requested" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "search",
          payload: { provider: "openrouter", status: "completed", strategyId: "perplexity-tool-search" }
        },
        type: "artifact"
      },
      {
        data: {
          artifactType: "tool_result",
          payload: {
            message: longToolError,
            name: "search_via_perplexity",
            round: 2,
            status: "error"
          }
        },
        type: "artifact"
      }
    ]);

    expect(summaries.map((summary) => [summary.label, summary.value])).toEqual([
      ["Tool calls", "2"],
      ["Search artifacts", "2"],
      ["Citations", "1"],
      ["Tool results", "2"]
    ]);
    expect(summaries.every((summary) => summary.stage === "S")).toBe(true);
    expect(summaries.find((summary) => summary.label === "Search artifacts")).toEqual(
      expect.objectContaining({
        detail: "openrouter / perplexity-tool-search / completed",
        tone: "success"
      })
    );
    expect(summaries.find((summary) => summary.label === "Tool results")).toEqual(
      expect.objectContaining({
        detail: `search_via_perplexity / error / round 2 / ${longToolError}`,
        tone: "error"
      })
    );
  });

  it("preserves long structured error details and distinguishes cancellation from completion", () => {
    const longMessage = `Provider request failed after validation: ${"unbroken-detail-".repeat(70)}`;
    const longDetail = `Upstream context: ${"nested detail ".repeat(70).trim()}`;
    const summaries = summarizeInspectorEvents([
      { data: { status: "streaming" }, type: "run_start" },
      { data: { delta: "partial answer" }, type: "token" },
      {
        data: {
          code: "provider_bad_request",
          detail: longDetail,
          message: longMessage
        },
        type: "error"
      },
      { data: { status: "cancelled" }, type: "done" }
    ]);

    expect(summaries.find((summary) => summary.label === "Error")).toEqual(
      expect.objectContaining({
        detail: `provider_bad_request / ${longDetail}`,
        stage: "A",
        tone: "error",
        value: longMessage
      })
    );
    expect(summaries.find((summary) => summary.label === "Cancelled")).toEqual(
      expect.objectContaining({
        stage: "A",
        tone: "warning",
        value: "response stopped"
      })
    );
    expect(summaries.some((summary) => summary.label === "Done" && summary.tone === "success")).toBe(false);
  });

  it("attributes a pre-token provider failure to the started answer stage", () => {
    const summaries = summarizeInspectorEvents([
      { data: { status: "streaming" }, type: "run_start" },
      { data: { assistantMessageId: "assistant-hidden" }, type: "message_start" },
      { data: { message: "Provider failed before the first token" }, type: "error" }
    ]);

    expect(summaries.find((summary) => summary.label === "Error")).toEqual(
      expect.objectContaining({ stage: "A", value: "Provider failed before the first token" })
    );
    expect(JSON.stringify(summaries)).not.toContain("assistant-hidden");
  });

  it("shows reasoning artifacts as neutral summaries instead of warnings or raw JSON", () => {
    const summaries = summarizeInspectorEvents([
      {
        data: {
          artifactType: "reasoning",
          payload: {
            id: "rs_123",
            summary: [],
            type: "reasoning"
          }
        },
        type: "artifact"
      }
    ]);

    expect(summaries).toContainEqual(
      expect.objectContaining({
        detail: "no reasoning summary captured",
        label: "Reasoning artifacts",
        tone: "default",
        value: "1"
      })
    );
    expect(JSON.stringify(summaries)).not.toContain("rs_123");
  });
});
