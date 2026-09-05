import { describe, expect, it } from "vitest";
import type { RunEventView } from "@/lib/contracts/runs";
import {
  answerProcessLabelV2,
  describeToolCallV2,
  formatWorkDurationV2,
  presentRunLifecycleV2,
  presentToolActivityV2,
  stepDurationSumV2,
  type RunLifecycleStateV2,
  type RunLifecycleStatusV2
} from "./runPresentation";

function state(overrides: Partial<RunLifecycleStateV2> = {}): RunLifecycleStateV2 {
  return {
    content: "",
    events: [],
    runId: null,
    ...overrides
  };
}

function summary(payload: Record<string, unknown>): RunEventView {
  return {
    data: { artifactType: "summary", payload },
    type: "artifact"
  };
}

describe("run lifecycle v2 presentation", () => {
  it("stays silent without explicit lifecycle state", () => {
    expect(presentRunLifecycleV2(state({ content: "A finished-looking sentence." }))).toEqual({
      kind: "idle",
      runId: null
    });
  });

  it.each([
    ["queued", "queued", "Queued"],
    ["preparing", "preparing", "Preparing request…"],
    ["in_progress", "provider", "Thinking…"],
    ["streaming", "provider", "Thinking…"]
  ] as const)("maps explicit %s status to its truthful activity", (status, kind, label) => {
    expect(presentRunLifecycleV2(state({ status: status as RunLifecycleStatusV2 }))).toMatchObject({
      activity: { kind, label },
      kind: "activity"
    });
  });

  it.each([
    [summary({ stage: "search", status: "running" }), "search", "Searching the web…"],
    [summary({ stage: "compute", status: "running" }), "compute", "Computing…"],
    [summary({ stage: "preview", status: "running" }), "preview", "Rendering preview…"],
    [summary({ stage: "model", status: "waiting" }), "provider", "Thinking…"]
  ] as const)("uses normalized lifecycle artifacts", (event, kind, label) => {
    expect(presentRunLifecycleV2(state({ events: [event] }))).toMatchObject({
      activity: { kind, label },
      kind: "activity"
    });
  });

  it("uses only bounded tool names and never server-authored display prose", () => {
    const requested = {
      data: {
        artifactType: "tool_call",
        payload: {
          name: "create_workbook",
          round: 2,
          serverName: "Spreadsheet Studio",
          status: "requested"
        }
      },
      type: "artifact"
    } satisfies RunEventView;
    const unsafe = {
      data: {
        artifactType: "tool_call",
        payload: { name: "<script>alert(1)</script>", status: "requested" }
      },
      type: "artifact"
    } satisfies RunEventView;

    expect(presentRunLifecycleV2(state({ events: [requested] }))).toMatchObject({
      activity: {
        kind: "tool",
        label: "Using Spreadsheet Studio: create workbook…",
        serverName: "Spreadsheet Studio",
        toolName: "create_workbook"
      }
    });
    expect(presentRunLifecycleV2(state({ events: [unsafe] }))).toMatchObject({
      activity: { kind: "tool", label: "Running tools…" }
    });
  });

  it("lets the latest explicit signal choose between tool rounds and token streaming", () => {
    const token = { data: { delta: "partial" }, type: "token" } satisfies RunEventView;
    const tool = summary({ stage: "tools", status: "running", toolName: "lookup" });

    expect(presentRunLifecycleV2(state({ events: [tool, token] })).kind).toBe("streaming");
    expect(presentRunLifecycleV2(state({ events: [token, tool] }))).toMatchObject({
      activity: { kind: "tool", label: "Running lookup…" },
      kind: "activity"
    });
  });

  it("merges safe live tool calls without exposing event payload internals", () => {
    const events = [{
      data: {
        artifactType: "tool_call",
        payload: {
          arguments: { secret: "never-project" },
          name: "find_tools",
          round: 1,
          serverName: "Auto tools",
          status: "requested"
        }
      },
      type: "artifact"
    }] satisfies RunEventView[];

    const activity = presentToolActivityV2(events);
    expect(activity).toEqual({
      calls: [{
        round: 1,
        serverName: "Auto tools",
        status: "running",
        toolName: "find_tools"
      }]
    });
    expect(JSON.stringify(activity)).not.toContain("never-project");
  });

  it("does not surface an internal MCP namespace from a live event", () => {
    expect(presentToolActivityV2([{
      data: {
        artifactType: "tool_call",
        payload: {
          name: "mcp_private_internal_tool_0123456789",
          round: 1,
          status: "requested"
        }
      },
      type: "artifact"
    }])).toBeNull();
  });

  it("keeps ambiguous EOF distinct until terminal server truth arrives", () => {
    const partial = state({
      connectionLost: true,
      content: "Partial answer",
      events: [{ data: { delta: "Partial answer" }, type: "token" }],
      runId: "run-a"
    });

    expect(presentRunLifecycleV2(partial)).toEqual({
      kind: "connection_lost",
      runId: "run-a"
    });
    expect(presentRunLifecycleV2({
      ...partial,
      events: [...partial.events, { data: { status: "complete" }, type: "done" }]
    })).toEqual({
      kind: "complete",
      runId: "run-a"
    });
  });

  it("requires an authoritative terminal transition for complete or cancelled", () => {
    expect(presentRunLifecycleV2(state({
      authoritativeMessageStatus: "complete",
      content: "Persisted answer"
    })).kind).toBe("complete");
    expect(presentRunLifecycleV2(state({
      events: [{ data: { status: "cancelled" }, type: "done" }]
    })).kind).toBe("cancelled");
    expect(presentRunLifecycleV2(state({ content: "Looks complete" })).kind).toBe("idle");
  });

  it("distinguishes retryable partial failure from terminal parameter failure", () => {
    expect(presentRunLifecycleV2(state({
      content: "Partial answer",
      events: [{
        data: {
          code: "provider_stream_reset",
          message: "Соединение с провайдером сброшено.",
          recovery: "retry"
        },
        type: "error"
      }]
    }))).toMatchObject({
      failure: {
        code: "provider_stream_reset",
        message: "Соединение с провайдером сброшено.",
        recovery: "retry"
      },
      kind: "recoverable_error"
    });

    expect(presentRunLifecycleV2(state({
      failure: {
        code: "context_budget_exceeded",
        message: "Контекст выбранной модели слишком мал.",
        recovery: "change_parameters"
      },
      status: "error"
    }))).toMatchObject({
      failure: { code: "context_budget_exceeded", recovery: "change_parameters" },
      kind: "terminal_error"
    });
  });

  it("bounds malformed error state and supplies factual fallback copy", () => {
    expect(presentRunLifecycleV2(state({
      events: [{
        data: { code: "<unsafe>", message: "   " },
        type: "error"
      }]
    }))).toMatchObject({
      failure: {
        code: null,
        message: "The run failed. Change the request parameters and try again."
      },
      kind: "terminal_error"
    });
  });
});

describe("answer process label", () => {
  it("formats work time the way a person says it", () => {
    expect(formatWorkDurationV2(0)).toBe("a few seconds");
    expect(formatWorkDurationV2(4_900)).toBe("a few seconds");
    expect(formatWorkDurationV2(12_400)).toBe("12s");
    expect(formatWorkDurationV2(60_000)).toBe("1m");
    expect(formatWorkDurationV2(64_000)).toBe("1m 4s");
    expect(formatWorkDurationV2(3_720_000)).toBe("1h 2m");
  });

  it("names only the facts that exist and never counts tool calls", () => {
    expect(answerProcessLabelV2({
      hasReasoning: false, memoryCount: 0, stepCount: 0, workDurationMs: 8_000
    })).toBeNull();
    expect(answerProcessLabelV2({
      hasReasoning: true, memoryCount: 0, stepCount: 0, workDurationMs: 12_000
    })).toBe("Thought for 12s");
    expect(answerProcessLabelV2({
      hasReasoning: true, memoryCount: 2, stepCount: 3, workDurationMs: 8_000
    })).toBe("Worked for 8s · Used 2 memories");
    expect(answerProcessLabelV2({
      hasReasoning: false, memoryCount: 1, stepCount: 0, workDurationMs: null
    })).toBe("Used 1 memory");
    expect(answerProcessLabelV2({
      hasReasoning: false, memoryCount: 0, stepCount: 2, workDurationMs: null
    })).toBe("Steps");
    expect(answerProcessLabelV2({
      hasReasoning: true, memoryCount: 0, stepCount: 0, workDurationMs: null
    })).toBe("Thought process");
  });

  it("names the built-in engine search as a web search", () => {
    expect(describeToolCallV2({ toolName: "search_selected_engines" }, "settled")).toBe("Searched the web");
    expect(describeToolCallV2({ toolName: "search_selected_engines" }, "running")).toBe("Searching the web");
  });

  it("distinguishes Knowledge retrieval progress, success, and technical failure", () => {
    expect(describeToolCallV2({ toolName: "search_knowledge" }, "running"))
      .toBe("Searching Knowledge");
    expect(describeToolCallV2({ toolName: "search_knowledge" }, "settled"))
      .toBe("Searched Knowledge");
    expect(describeToolCallV2({ toolName: "search_knowledge" }, "failed"))
      .toBe("Knowledge search unavailable");
    expect(describeToolCallV2({ toolName: "retrieve_knowledge" }, "failed"))
      .toBe("Knowledge search unavailable");
  });

  it("falls back to the settled step durations", () => {
    expect(stepDurationSumV2(null)).toBeNull();
    expect(stepDurationSumV2({ calls: [{ round: 1, status: "running", toolName: "web_search" }] })).toBeNull();
    expect(stepDurationSumV2({
      calls: [
        { durationMs: 1_400, round: 1, status: "complete", toolName: "web_search" },
        { durationMs: 800, round: 2, status: "complete", toolName: "search_knowledge" }
      ]
    })).toBe(2_200);
  });
});

describe("PDF preparation presentation", () => {
  it("uses only durable aggregate page counts before any answer activity", () => {
    const document = { completedPages: 4, pageCount: 10, phase: "preparing" as const, retryable: false,
      route: "selected_model_vision" as const, limitedReadingQuality: false, longDocument: false };
    expect(presentRunLifecycleV2({ content: "", events: [], runId: "run-pdf", status: "streaming",
      pdfPreparation: [document, { ...document, completedPages: 2 }] })).toMatchObject({
      kind: "activity", activity: { kind: "preparing", label: "Preparing documents · 6 of 20 pages…" }
    });
  });

  it("offers retry for a failed document even when no answer text exists", () => {
    expect(presentRunLifecycleV2({ content: "", events: [], runId: "run-pdf", status: "error",
      pdfPreparation: [{ completedPages: 4, pageCount: 10, phase: "failed", retryable: true,
        route: "selected_model_vision", limitedReadingQuality: false, longDocument: false }] })).toMatchObject({
      kind: "recoverable_error", failure: { recovery: "retry", message: "Document preparation could not finish." }
    });
  });
});
