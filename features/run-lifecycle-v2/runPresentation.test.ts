import { describe, expect, it } from "vitest";
import type { RunEventView } from "@/lib/contracts/runs";
import { TOOL_SYNTHESIS_FAILURE } from "@/lib/contracts/runs";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { makeContextCompactionStatus } from "@/lib/contracts/contextCompaction";
import {
  answerProcessLabelV2,
  contextCompactionCopyV2,
  describeToolCallV2,
  formatWorkDurationV2,
  presentRunLifecycleV2,
  presentToolActivityV2,
  stepDurationSumV2,
  stepRunAnnouncementV2,
  toolActivityOriginV2,
  type RunAnnouncerMemoryV2,
  type RunPresentationV2,
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
  it("projects compaction as a live process status and keeps terminal state over late progress", () => {
    const running = {
      type: "artifact",
      data: { artifactType: "context_compaction", payload: makeContextCompactionStatus({
        afterTokens: 600, beforeTokens: 1_200, outcome: "pending", state: "running"
      }) }
    } satisfies RunEventView;
    const complete = {
      type: "artifact",
      data: { artifactType: "context_compaction", payload: makeContextCompactionStatus({
        afterTokens: 600, beforeTokens: 1_200, outcome: "summary_applied", state: "complete"
      }) }
    } satisfies RunEventView;
    expect(presentRunLifecycleV2(state({ events: [running] }))).toMatchObject({
      activity: { kind: "compaction", label: "Compacting context…" },
      compaction: { state: "running", outcome: "pending" },
      kind: "activity"
    });
    expect(presentRunLifecycleV2(state({
      authoritativeMessageStatus: "complete", events: [complete, running], runId: "run-1"
    })).compaction).toMatchObject({ state: "complete", outcome: "summary_applied", reducedTokens: 600 });
    expect(presentRunLifecycleV2(state({ contextCompaction: complete.data.payload, runId: "run-1" })).compaction)
      .toMatchObject({ state: "complete", outcome: "summary_applied" });
    expect(presentRunLifecycleV2(state({ contextCompaction: complete.data.payload, events: [running], runId: "run-1" })).compaction)
      .toMatchObject({ state: "complete", outcome: "summary_applied" });
    const later = { ...running, data: { ...running.data, payload: { ...running.data.payload, cycle: 2 } } };
    expect(presentRunLifecycleV2(state({ contextCompaction: complete.data.payload, events: [later, running] })).compaction)
      .toMatchObject({ cycle: 2, state: "running" });
    for (const terminal of ["complete", "cancelled", "error"] as const) {
      // Never a spinner on a settled answer, and never a client-invented outcome.
      expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: terminal, events: [later] })).compaction)
        .toBeUndefined();
    }
    const serverUnknown = { ...running, data: { ...running.data, payload: makeContextCompactionStatus({
      beforeTokens: 1_200, cycle: 2, outcome: "unknown", state: "failed"
    }) } };
    expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: "cancelled", events: [later, serverUnknown] })).compaction)
      .toMatchObject({ cycle: 2, outcome: "unknown", state: "failed" });
  });

  it("does not flash an unavailable outcome when resume settles the answer before the chat refresh", () => {
    const running = makeContextCompactionStatus({ beforeTokens: 1_200, outcome: "pending", state: "running" });
    const complete = makeContextCompactionStatus({ afterTokens: 600, beforeTokens: 1_200, outcome: "summary_applied", state: "complete" });
    // Resume poll: the persisted answer is still streaming with a running cycle.
    expect(presentRunLifecycleV2(state({ contextCompaction: running, runId: "run-1", status: "streaming" }))).toMatchObject({
      activity: { kind: "compaction", label: "Compacting context…" }, compaction: { state: "running" }, kind: "activity"
    });
    // The run outcome marks the message complete before the refreshed summary arrives.
    const beforeRefresh = presentRunLifecycleV2(state({ authoritativeMessageStatus: "complete", contextCompaction: running, runId: "run-1" }));
    expect(beforeRefresh).toEqual({ kind: "complete", runId: "run-1" });
    // The refresh carries the server-settled cycle.
    expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: "complete", contextCompaction: complete, runId: "run-1" })))
      .toMatchObject({ compaction: { outcome: "summary_applied", state: "complete" }, kind: "complete" });
  });

  it("keeps every server-settled failed cycle that a later cycle superseded, once each", () => {
    const cycle = (status: ReturnType<typeof makeContextCompactionStatus>) =>
      ({ type: "artifact", data: { artifactType: "context_compaction", payload: status } }) satisfies RunEventView;
    const running = (number: number) => makeContextCompactionStatus({ beforeTokens: 1_200, cycle: number, outcome: "pending", state: "running" });
    const failed = (number: number, outcome: "provider_failed" | "summary_failed" = "summary_failed") =>
      makeContextCompactionStatus({ beforeTokens: 1_200, cycle: number, outcome, state: "failed" });
    const masked = makeContextCompactionStatus({ afterTokens: 600, beforeTokens: 1_200, cycle: 3, outcome: "masking_applied", state: "complete" });
    const batch = presentRunLifecycleV2(state({
      events: [cycle(running(1)), cycle(failed(1)), cycle(running(1)), cycle(running(2)), cycle(failed(2, "provider_failed")), cycle(masked)],
      runId: "run-1", status: "streaming"
    }));
    expect(batch.compaction).toEqual(masked);
    expect(batch.compactionFailures).toEqual([failed(1), failed(2, "provider_failed")]);
    // The saved fallback and the replayed feed describe one cycle once.
    expect(presentRunLifecycleV2(state({ contextCompaction: failed(1), events: [cycle(failed(1)), cycle(masked)], runId: "run-1" }))
      .compactionFailures).toEqual([failed(1)]);
    // The latest failure is the presented cycle, never listed twice; a settled answer keeps no superseded list.
    expect(presentRunLifecycleV2(state({ events: [cycle(failed(1))], runId: "run-1" }))).toEqual({
      compaction: failed(1), kind: "idle", runId: "run-1"
    });
    expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: "complete", contextCompaction: masked, runId: "run-1" })))
      .toEqual({ compaction: masked, kind: "complete", runId: "run-1" });
    // A terminal run hides its unsettled cycle but keeps the failures the server settled before it.
    const orphaned = presentRunLifecycleV2(state({ authoritativeMessageStatus: "error", events: [cycle(failed(1)), cycle(running(2))], runId: "run-1" }));
    expect(orphaned).toMatchObject({ compactionFailures: [failed(1)], kind: "terminal_error" });
    expect(orphaned.compaction).toBeUndefined();
  });

  it("keeps a running cycle under a lost connection without presenting live compaction", () => {
    const running = makeContextCompactionStatus({ beforeTokens: 1_200, outcome: "pending", state: "running" });
    const presentation = presentRunLifecycleV2(state({ connectionLost: true, contextCompaction: running, runId: "run-1" }));
    expect(presentation).toMatchObject({ compaction: { state: "running" }, kind: "connection_lost" });
    expect(presentation.activity).toBeUndefined();
  });

  it("describes only server-published compaction states, with each whole reason", () => {
    const running = makeContextCompactionStatus({ beforeTokens: 1_200, outcome: "pending", state: "running" });
    expect(contextCompactionCopyV2(running).label).toBe("Compacting context…");
    expect(contextCompactionCopyV2(running).detail)
      .toBe("Summarizing earlier messages to fit the working context. The answer starts after this step.");
    expect(contextCompactionCopyV2(running, { connectionLost: true })).toEqual({
      detail: "The connection was lost while the context was being compacted. Refresh to see the confirmed outcome.",
      label: "Context compaction · connection lost"
    });
    expect(contextCompactionCopyV2(makeContextCompactionStatus({
      afterTokens: 1_200, beforeTokens: 1_200, outcome: "masking_applied", state: "complete"
    }))).toEqual({ detail: null, label: "Context compacted" });
    expect(contextCompactionCopyV2(makeContextCompactionStatus({ outcome: "unknown", state: "failed" })).label)
      .toBe("Context compaction outcome unavailable");
  });

  it("ignores malformed compaction payloads and keeps private fields out of the projection", () => {
    const event = { type: "artifact", data: { artifactType: "context_compaction", payload: {
      afterTokens: 1, beforeTokens: 2, outcome: "summary_applied", reducedTokens: 1,
      stage: "settled", state: "complete", version: 1, notes: "private"
    } } } satisfies RunEventView;
    expect(presentRunLifecycleV2(state({ events: [event] }))).toEqual({ kind: "idle", runId: null });
  });

  it("projects safe Skill facts only from the Skill origin and keeps model payloads out of activity", () => {
    const event = { type: "artifact", data: { artifactType: "tool_call", payload: {
      name: "load_skill", origin: "skill", skillId: "review", skillName: "Careful review", round: 1,
      status: "requested", arguments: { secret: "hidden instructions" }, result: "hidden file content"
    } } } satisfies RunEventView;
    expect(presentToolActivityV2([event])).toEqual({ calls: [{ toolName: "load_skill", origin: "skill", skillId: "review", skillName: "Careful review", round: 1, status: "running" }] });
    expect(presentRunLifecycleV2(state({ events: [event] })).activity?.label).toBe("Loading skill “Careful review”…");
    const external = { ...event, data: { ...event.data, payload: { ...event.data.payload, origin: "mcp", serverName: "Team tools" } } };
    expect(presentToolActivityV2([external])?.calls[0]).not.toHaveProperty("skillId");
    expect(presentToolActivityV2([external])?.calls[0]).not.toHaveProperty("skillName");
  });

  it("names artifact lifecycle phases and preserves an explicit MCP origin", () => {
    for (const call of [{ origin: "artifact" }, { toolName: "create_artifact" }]) {
      expect(describeToolCallV2(call, "running")).toBe("Creating artifact");
      expect(describeToolCallV2(call, "settled")).toBe("Artifact ready");
      expect(describeToolCallV2(call, "failed")).toBe("Artifact creation failed");
      expect(describeToolCallV2(call, "cancelled")).toBe("Artifact creation stopped");
    }
    expect(toolActivityOriginV2({ origin: "mcp", toolName: "create_artifact" })).toBe("mcp");
    expect(describeToolCallV2({ toolName: "read_artifact" }, "running")).toBe("Reading artifact");
    expect(describeToolCallV2({ origin: "artifact", toolName: "read_artifact" }, "settled")).toBe("Read artifact");
    expect(describeToolCallV2({ origin: "artifact", toolName: "read_artifact" }, "failed")).toBe("Artifact reading failed");
  });

  it("shows Workspace waiting before document work, and leaves a published answer complete", () => {
    expect(presentRunLifecycleV2(state({ status: "queued", runId: "next", workspacePreparation: true,
      pdfPreparation: [{ completedPages: 0, pageCount: null, phase: "checking", retryable: false,
        route: "local_text", limitedReadingQuality: false, longDocument: false }] })))
      .toEqual({ kind: "activity", activity: { kind: "preparing", label: "Preparing workspace..." }, runId: "next" });
    expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: "complete", status: "complete",
      runId: "previous", content: "File saved.", events: [summary({ stage: "compute", status: "running" })] })))
      .toEqual({ kind: "complete", runId: "previous" });
  });

  it("shows a safe live tool budget and a synthesis failure without blaming request parameters", () => {
    const event: RunEventView = { type: "artifact", data: { artifactType: "tool_budget", payload: { kind: "rounds", limit: 8 } } };
    expect(presentRunLifecycleV2(state({ events: [event] })).activity).toMatchObject({
      kind: "synthesis", label: "Tool round limit (8) reached. Finishing the answer…"
    });
    expect(presentToolActivityV2([event])).toEqual({ calls: [], warning: { kind: "rounds", limit: 8 } });
    expect(presentRunLifecycleV2(state({ content: "Partial answer", events: [event,
      { type: "error", data: { code: TOOL_SYNTHESIS_FAILURE.code, message: "unexposed provider diagnostic" } }
    ] }))).toMatchObject({ kind: "terminal_error", failure: { ...TOOL_SYNTHESIS_FAILURE, recovery: "regenerate" } });
    expect(presentToolActivityV2([{ type: "artifact", data: { artifactType: "tool_budget", payload: { kind: "rounds", limit: -1 } } }])).toBeNull();
  });

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

  it.each(["complete", "error", "cancelled"] as const)(
    "keeps MCP search origin when live activity reconciles with %s history",
    (status) => {
      const event: RunEventView = {
        type: "artifact",
        data: { artifactType: "tool_call", payload: {
          arguments: { query: "unexposed query" },
          error: "unexposed diagnostic",
          name: "search",
          origin: "mcp",
          round: 2,
          serverName: "Repository Tools",
          status: "requested"
        } }
      };
      const persisted: ThreadToolActivity = { calls: [{
        durationMs: 120,
        origin: "mcp",
        round: 2,
        serverName: "Repository Tools",
        status,
        toolName: "search"
      }] };
      const live = presentToolActivityV2([event]);

      expect(live?.calls[0]).toMatchObject({ origin: "mcp", status: "running" });
      expect(describeToolCallV2(live!.calls[0]!, "running")).toBe("Using Repository Tools: search");
      expect(presentRunLifecycleV2(state({ events: [event] })).activity?.label)
        .toBe("Using Repository Tools: search…");
      expect(presentToolActivityV2([event], persisted)).toEqual(persisted);
      expect(presentToolActivityV2([], persisted)).toEqual(persisted);
      expect(JSON.stringify(live)).not.toContain("unexposed");
    }
  );

  it("keeps different explicit origins distinct while reconciling identical display names", () => {
    const persisted: ThreadToolActivity = { calls: [{
      origin: "web_search", round: 1, serverName: "Web search", status: "complete", toolName: "search"
    }] };
    const activity = presentToolActivityV2([{
      type: "artifact",
      data: { artifactType: "tool_call", payload: {
        name: "search", origin: "mcp", round: 1, serverName: "Web search", status: "requested"
      } }
    }], persisted);

    expect(activity?.calls.map((call) => [call.origin, call.status])).toEqual([
      ["web_search", "complete"], ["mcp", "running"]
    ]);
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

  it("keeps the live failure code and recovery when the persisted message is also available", () => {
    expect(presentRunLifecycleV2(state({
      content: "Partial answer", status: "error", failure: { message: "Connection interrupted." },
      events: [{ type: "error", data: { code: "provider_stream_reset", message: "Connection interrupted.", recovery: "retry" } }]
    }))).toMatchObject({ kind: "recoverable_error", failure: {
      code: "provider_stream_reset", message: "Connection interrupted.", recovery: "retry"
    } });
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
    })).toBe("Worked for 8s · Memory · 2");
    expect(answerProcessLabelV2({
      hasReasoning: false, memoryCount: 1, stepCount: 0, workDurationMs: null
    })).toBe("Memory · 1");
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

  it.each([
    ["Repository Tools", "search", "search"],
    ["Document Tools", "search_knowledge", "search knowledge"],
    ["Knowledge", "retrieve_knowledge", "retrieve knowledge"],
    ["Auto tools", "find_tools", "find tools"],
    ["Web search", "web_search", "web search"],
    ["Workspace", "search", "search"]
  ])("keeps MCP %s / %s distinct from built-ins in every phase", (serverName, toolName, operation) => {
    const call = { origin: "mcp", serverName, toolName };
    expect(describeToolCallV2(call, "running")).toBe(`Using ${serverName}: ${operation}`);
    expect(describeToolCallV2(call, "settled")).toBe(`Used ${serverName}: ${operation}`);
    expect(describeToolCallV2(call, "failed")).toBe(`${serverName}: ${operation} failed`);
    expect(describeToolCallV2(call, "cancelled")).toBe(`${serverName}: ${operation} stopped`);
  });

  it.each(["search", "search_knowledge", "find_tools"])(
    "retains the server for a %s call without explicit origin",
    (toolName) => {
      expect(toolActivityOriginV2({ serverName: "Repository Tools", toolName })).toBe("mcp");
      expect(describeToolCallV2({ serverName: "Repository Tools", toolName }, "settled"))
        .toContain("Used Repository Tools:");
    }
  );

  it.each([
    ["web_search", "Searching the web", "Searched the web", "Web search failed", "Web search stopped"],
    ["knowledge", "Searching Knowledge", "Searched Knowledge", "Knowledge search unavailable", "Knowledge search stopped"],
    ["discovery", "Finding relevant tools", "Found relevant tools", "Tool discovery failed", "Tool discovery stopped"],
    ["workspace", "Working in Workspace", "Worked in Workspace", "Workspace step failed", "Workspace step stopped"]
  ])("preserves explicit built-in %s regardless of its display names", (origin, running, settled, failed, cancelled) => {
    const call = { origin, serverName: "Catalog Search", toolName: "search" };
    expect(describeToolCallV2(call, "running")).toBe(running);
    expect(describeToolCallV2(call, "settled")).toBe(settled);
    expect(describeToolCallV2(call, "failed")).toBe(failed);
    expect(describeToolCallV2(call, "cancelled")).toBe(cancelled);
  });

  it("does not infer a built-in from a tool with explicitly generic origin", () => {
    expect(describeToolCallV2({ origin: "tool", toolName: "search" }, "settled")).toBe("Ran search");
  });

  it("bounds names and withholds namespaces, endpoints, and control characters from labels", () => {
    for (const call of [
      { serverName: "https://example.test/mcp", toolName: "mcp_repository_search_fixture" },
      { serverName: "mcp_repository_fixture", toolName: "https://example.test/search" },
      { serverName: "Repository\u0000 Tools", toolName: "search\u0000diagnostic" }
    ]) {
      const label = describeToolCallV2({ ...call, origin: "mcp" }, "failed");
      expect(label).toBe("MCP server failed");
      expect(label).not.toMatch(/https|example|mcp_|diagnostic|\u0000/iu);
    }
    expect(describeToolCallV2({ origin: "mcp", serverName: "S".repeat(200), toolName: "t".repeat(100) }, "running"))
      .toBe(`Using ${"S".repeat(160)}: ${"t".repeat(80)}`);
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

describe("run announcer policy", () => {
  function speak(sequence: readonly RunPresentationV2[]) {
    let memory: RunAnnouncerMemoryV2 | null = null;
    const spoken: string[] = [];
    for (const presentation of sequence) {
      const step = stepRunAnnouncementV2(memory, "chat-a", presentation);
      memory = step.memory;
      const text = [...step.parts, step.terminal].filter(Boolean).join(" ");
      if (text) spoken.push(text);
    }
    return spoken;
  }
  const thinking = (runId: string | null): RunPresentationV2 =>
    ({ activity: { kind: "provider", label: "Thinking…" }, kind: "activity", runId });

  it("treats a new answer after a settled one as a new run even without run ids", () => {
    expect(speak([
      { kind: "complete", runId: null },
      thinking(null),
      { kind: "streaming", runId: null },
      { kind: "cancelled", runId: null }
    ])).toEqual(["Working on the answer…", "Run stopped. The message field is available."]);
  });

  it("keeps history silent when a settled tail without a run id loads after an empty chat", () => {
    const idle: RunPresentationV2 = { kind: "idle", runId: null };
    expect(speak([idle, { kind: "complete", runId: null }])).toEqual([]);
    expect(speak([idle, idle, { kind: "complete", runId: null }, { kind: "complete", runId: null }])).toEqual([]);
    expect(speak([idle, { kind: "cancelled", runId: null }])).toEqual([]);
    // Control: a settled tail with a run id is history as before.
    expect(speak([idle, { kind: "complete", runId: "run-old" }])).toEqual([]);
    // An answer that was followed while running still announces its end once.
    expect(speak([idle, thinking(null), { kind: "complete", runId: null }, { kind: "complete", runId: null }]))
      .toEqual(["Working on the answer…", "Answer ready. The message field is available."]);
    expect(speak([idle, thinking("run-a"), { kind: "complete", runId: "run-a" }]))
      .toEqual(["Working on the answer…", "Answer ready. The message field is available."]);
  });

  it("speaks a failed cycle superseded before a render once with its reason, and never again on reconnect", () => {
    const cycle = (status: ReturnType<typeof makeContextCompactionStatus>) =>
      ({ type: "artifact", data: { artifactType: "context_compaction", payload: status } }) satisfies RunEventView;
    const running = makeContextCompactionStatus({ beforeTokens: 9_000, cycle: 1, outcome: "pending", state: "running" });
    const failed = makeContextCompactionStatus({ beforeTokens: 9_000, cycle: 1, outcome: "provider_failed", state: "failed" });
    const masked = makeContextCompactionStatus({ afterTokens: 4_000, beforeTokens: 9_000, cycle: 2, outcome: "masking_applied", state: "complete" });
    const live = (events: RunEventView[], extra: Partial<RunLifecycleStateV2> = {}) =>
      presentRunLifecycleV2(state({ events, runId: "run-a", status: "streaming", ...extra }));
    const replay = [cycle(running), cycle(failed), cycle(masked)];
    expect(speak([
      live([]),
      live([cycle(running)]),
      live(replay),
      live(replay),
      // Connection loss, then Refresh replays the same server cycles or reads the saved one.
      live(replay, { connectionLost: true }),
      live(replay),
      live([], { contextCompaction: masked }),
      live(replay),
      presentRunLifecycleV2(state({ authoritativeMessageStatus: "complete", contextCompaction: masked, runId: "run-a" }))
    ])).toEqual([
      "Working on the answer…",
      "Compacting context…",
      "Provider could not compact the context. Context compacted.",
      "Connection lost. Refresh the run state.",
      "Answer ready. The message field is available."
    ]);
    // A replay first observed mid-run counts its settled cycles as already seen.
    expect(speak([live(replay), live(replay)])).toEqual(["Working on the answer…"]);
  });

  it("does not count a cycle already settled when the run was first observed", () => {
    const settled = makeContextCompactionStatus({ afterTokens: 1, beforeTokens: 2, cycle: 3, outcome: "masking_applied", state: "complete" });
    expect(speak([
      { ...thinking("run-a"), compaction: settled },
      { ...thinking("run-a"), compaction: { ...settled, cycle: 4 } },
      { ...thinking("run-a"), compaction: makeContextCompactionStatus({ cycle: 5, outcome: "irreducible_overflow", state: "failed" }) }
    ])).toEqual(["Working on the answer…", "Context is still too large."]);
  });
});
