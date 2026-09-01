import { describe, expect, it } from "vitest";
import type { RunEventView } from "@/lib/contracts/runs";
import {
  presentRunLifecycleV2,
  presentToolActivityV2,
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
