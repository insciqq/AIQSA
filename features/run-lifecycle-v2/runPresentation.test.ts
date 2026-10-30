import { describe, expect, it } from "vitest";
import type { RunEventView } from "@/lib/contracts/runs";
import { RUN_INTERRUPTED_FAILURE, RUN_PREPARATION_FAILURE_MESSAGE, RUN_TIME_LIMIT_FAILURE, TOOL_SYNTHESIS_FAILURE } from "@/lib/contracts/runs";
import { CHAT_PDF_READER_OUTPUT_LIMIT } from "@/lib/contracts/chatPdfPreparation";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import type { ThreadToolActivity } from "@/lib/contracts/chats";
import { makeContextCompactionStatus } from "@/lib/contracts/contextCompaction";
import {
  answerProcessLabelV2,
  contextCompactionCopyV2,
  describeToolCallV2,
  memorySearchCallHiddenV2,
  formatWorkDurationV2,
  presentRunLifecycleV2,
  presentToolActivityV2,
  RUN_WAITING_PHRASES_V2,
  runWaitingPhraseV2,
  stepDurationSumV2,
  stepRunAnnouncementV2,
  toolActivityOriginV2,
  type AnnouncedRunPresentationV2,
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

describe("native Memory search activity", () => {
  const event = (payload: Record<string, unknown>): RunEventView => ({ type: "artifact",
    data: { artifactType: "memory_search_activity", payload: { call: 1, round: 1, ...payload } } });
  it("deduplicates replayed status and keeps settlement over late progress and reload", () => {
    const running = event({ status: "running" });
    const settled = event({ status: "complete", outcome: "limited" });
    const projected = presentToolActivityV2([running, running, settled, settled, running]);
    expect(projected?.calls).toHaveLength(1);
    expect(projected?.calls[0]).toMatchObject({ status: "complete", memorySearchOutcome: "limited" });
    expect(presentToolActivityV2([running, settled], projected)).toEqual(projected);
    expect(presentRunLifecycleV2(state({ events: [running], runId: "run" })).activity?.label).toBe("Searching memory…");
    expect(presentRunLifecycleV2(state({ events: [running, settled, running], runId: "run" })).activity?.label).toBe(runWaitingPhraseV2("run"));
    expect(presentToolActivityV2([running, event({ call: 2, status: "running" })])?.calls).toHaveLength(2);
    expect(presentRunLifecycleV2(state({ events: [running, event({ call: 2, status: "running" }), settled], runId: "run" }))
      .activity?.label).toBe("Searching memory…");
  });
  it.each([
    ["results", "Searched memory"], ["no_results", "No matching memories found"],
    ["limited", "Searched memory"], ["cancelled", "Memory search stopped"]
  ])("uses a safe label without limits for %s", (memorySearchOutcome, label) => {
    expect(describeToolCallV2({ origin: "memory", toolName: "memory_search", memorySearchOutcome }, "settled")).toBe(label);
  });

  it("drops a failed Memory search step entirely and keeps other calls", () => {
    const failed = event({ status: "error", outcome: "failure" });
    expect(presentToolActivityV2([event({ status: "running" }), failed])).toBeNull();
    const kept = presentToolActivityV2([failed, event({ call: 2, status: "complete", outcome: "results" }),
      event({ call: 3, status: "cancelled", outcome: "cancelled" })]);
    expect(kept?.calls.map(call => call.memorySearchOutcome)).toEqual(["results", "cancelled"]);
    expect(memorySearchCallHiddenV2({ origin: "memory", toolName: "memory_search", status: "complete",
      memorySearchOutcome: "failure" })).toBe(true);
    expect(memorySearchCallHiddenV2({ origin: "mcp", serverName: "Docs", toolName: "search", status: "error" })).toBe(false);
    for (const phase of ["failed", "settled"] as const) {
      expect(describeToolCallV2({ origin: "memory", toolName: "memory_search", memorySearchOutcome: "failure" }, phase))
        .not.toMatch(/unavailable|fail|limit/iu);
    }
  });
});

describe("live reasoning headings", () => {
  const heading = (text: unknown) => summary({ heading: text, stage: "reasoning", status: "running" });
  const token = { data: { delta: "Ninety-two" }, type: "token" } satisfies RunEventView;
  const toolCall = { data: { artifactType: "tool_call", payload: { name: "search_web", origin: "web_search", round: 1,
    serverName: "Web search", status: "requested" } }, type: "artifact" } satisfies RunEventView;

  it("names the waiting phase with the latest heading until the answer text starts", () => {
    const waiting = presentRunLifecycleV2(state({ events: [heading("Setting up queen enumeration"),
      heading("**Checking  the diagonals**\n")], runId: "run-1", status: "streaming" }));
    expect(waiting).toMatchObject({ activity: { kind: "provider", reasoningHeading: "**Checking the diagonals**" }, kind: "activity" });
    expect(waiting.activity?.label).not.toBe(waiting.activity?.reasoningHeading);
    // Text replaces the status; the run keeps the fact that it showed thinking.
    expect(presentRunLifecycleV2(state({ events: [heading("Checking"), token], runId: "run-1", status: "streaming" })))
      .toEqual({ kind: "streaming", reasoningObserved: true, runId: "run-1" });
    expect(presentRunLifecycleV2(state({ events: [token], runId: "run-1", status: "streaming" })))
      .toEqual({ kind: "streaming", runId: "run-1" });
  });

  it("never lets an older heading name a later phase, and ignores malformed headings", () => {
    const tool = presentRunLifecycleV2(state({ events: [heading("Planning the search"), toolCall], runId: "run-1", status: "streaming" }));
    expect(tool.activity).toMatchObject({ kind: "tool", label: "Searching the web…" });
    expect(tool.activity).not.toHaveProperty("reasoningHeading");
    for (const malformed of [heading(" "), heading(7), summary({ heading: "x", stage: "reasoning" })]) {
      expect(presentRunLifecycleV2(state({ events: [malformed], runId: "run-1", status: "streaming" })).activity)
        .not.toHaveProperty("reasoningHeading");
    }
    const bounded = presentRunLifecycleV2(state({ events: [heading("x".repeat(500))], runId: "run-1", status: "streaming" }));
    expect(bounded.activity?.reasoningHeading).toHaveLength(80);
    expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: "complete", events: [heading("Checking")], runId: "run-1" })))
      .toEqual({ kind: "complete", runId: "run-1" });
  });
});

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

  it("names the agent's browser handoff in plain words", () => {
    for (const origin of ["tool", "workspace"] as const) {
      const call = { origin, toolName: "browser_handoff" };
      expect(describeToolCallV2(call, "running")).toBe("Waiting for you in the browser");
      expect(describeToolCallV2(call, "settled")).toBe("Asked for your help in the browser");
      expect(describeToolCallV2(call, "cancelled")).toBe("Browser handoff stopped");
    }
    expect(describeToolCallV2({ origin: "mcp", serverName: "Team", toolName: "browser_handoff" }, "running")).toBe("Using Team: browser handoff");
  });

  it("names a chat Skill save instead of a load", () => {
    const call = { origin: "skill", toolName: "save_skill" };
    expect(describeToolCallV2(call, "running")).toBe("Saving Skill");
    expect(describeToolCallV2(call, "settled")).toBe("Saved Skill");
    expect(describeToolCallV2(call, "failed")).toBe("Skill was not saved");
    expect(describeToolCallV2(call, "cancelled")).toBe("Saving Skill stopped");
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

  it("names chat System Vision analysis without exposing the tool identifier", () => {
    const call = { origin: "vision", serverName: "System Vision", toolName: "analyze_image" };
    expect(toolActivityOriginV2(call)).toBe("vision");
    expect(describeToolCallV2(call, "running")).toBe("Analyzing image");
    expect(describeToolCallV2(call, "settled")).toBe("Analyzed image");
    expect(describeToolCallV2(call, "failed")).toBe("Image analysis failed");
    expect(describeToolCallV2(call, "cancelled")).toBe("Image analysis stopped");
  });

  it("shows Workspace waiting before document work, and leaves a published answer complete", () => {
    expect(presentRunLifecycleV2(state({ status: "queued", runId: "next", workspacePreparation: true,
      pdfPreparation: [{ completedPages: 0, pageCount: null, phase: "checking", retryable: false,
        route: "local_text", limitedReadingQuality: false, longDocument: false }] })))
      .toEqual({ kind: "activity", activity: { kind: "preparing", label: "Preparing workspace..." }, runId: "next" });
    expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: "complete", status: "complete",
      runId: "previous", content: "File saved.", events: [summary({ stage: "files", status: "running" })] })))
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

  it("offers Continue on an answer whose work was kept, live by its code and after a reload by its saved text", () => {
    expect(presentRunLifecycleV2(state({ content: "Partial", events: [
      { type: "error", data: { code: RUN_TIME_LIMIT_FAILURE.code, message: RUN_TIME_LIMIT_FAILURE.message } }
    ] }))).toMatchObject({ failure: { ...RUN_TIME_LIMIT_FAILURE, recovery: "continue" }, kind: "terminal_error" });
    expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: "error", content: "",
      failure: { message: RUN_INTERRUPTED_FAILURE.message }, status: "error" })))
      .toMatchObject({ failure: { ...RUN_INTERRUPTED_FAILURE, recovery: "continue" }, kind: "terminal_error" });
    // Any other failure keeps its own recovery.
    expect(presentRunLifecycleV2(state({ authoritativeMessageStatus: "error", content: "",
      failure: { message: "The answer could not be completed." }, status: "error" })).failure?.recovery).toBe("change_parameters");
  });

  it("stays silent without explicit lifecycle state", () => {
    expect(presentRunLifecycleV2(state({ content: "A finished-looking sentence." }))).toEqual({
      kind: "idle",
      runId: null
    });
  });

  it.each([
    ["queued", null, "queued", "Queued"],
    ["preparing", null, "preparing", "Preparing request…"],
    // Not yet accepted by the server: the request is still being prepared.
    ["in_progress", null, "preparing", "Preparing request…"],
    ["streaming", null, "preparing", "Preparing request…"],
    ["in_progress", "run-1", "provider", runWaitingPhraseV2("run-1")],
    ["streaming", "run-1", "provider", runWaitingPhraseV2("run-1")]
  ] as const)("maps explicit %s status (run %s) to its truthful activity", (status, runId, kind, label) => {
    expect(presentRunLifecycleV2(state({ runId, status: status as RunLifecycleStatusV2 }))).toMatchObject({
      activity: { kind, label },
      kind: "activity"
    });
  });

  it("waits with one neutral phrase per run that never changes for that run", () => {
    const runIds = Array.from({ length: 64 }, (_, index) => `0b9a3981-${String(index).padStart(4, "0")}-4e58-9d1f-2b9a5c1e7a10`);
    const phrases = runIds.map(runWaitingPhraseV2);
    expect(phrases.every((phrase) => (RUN_WAITING_PHRASES_V2 as readonly string[]).includes(phrase))).toBe(true);
    expect(new Set(phrases).size).toBeGreaterThan(3);
    expect(RUN_WAITING_PHRASES_V2).toContain("Thinking…");
    // The same run reads the same phrase on every render, event and reconnect.
    for (const runId of runIds.slice(0, 8)) {
      const phrase = runWaitingPhraseV2(runId);
      expect(presentRunLifecycleV2(state({ runId, status: "streaming" })).activity?.label).toBe(phrase);
      expect(presentRunLifecycleV2(state({ events: [summary({ stage: "model", status: "waiting" })], runId, status: "streaming" }))
        .activity?.label).toBe(phrase);
      expect(presentRunLifecycleV2(state({ runId, status: "streaming" })).activity?.label).toBe(phrase);
    }
    // Specific work keeps its own words; settled answers keep their factual line.
    expect(presentRunLifecycleV2(state({ events: [summary({ stage: "files", status: "running" })], runId: runIds[0]!,
      status: "streaming" })).activity?.label).toBe("Reading files…");
    expect(answerProcessLabelV2({ hasReasoning: true, memoryCount: 0, stepCount: 0, workDurationMs: 12_000 })).toBe("Thought for 12s");
  });

  it.each([
    [summary({ stage: "files", status: "running" }), "files", "Reading files…"],
    [summary({ stage: "model", status: "waiting" }), "provider", "Thinking…"]
  ] as const)("uses normalized lifecycle artifacts", (event, kind, label) => {
    expect(presentRunLifecycleV2(state({ events: [event] }))).toMatchObject({
      activity: { kind, label },
      kind: "activity"
    });
  });

  it("marks a model request after shown tool work, which waits with the run's own phrase", () => {
    const model = summary({ stage: "model", status: "waiting" });
    const files = summary({ stage: "files", status: "running" });
    const tool = { data: { artifactType: "tool_call", payload: { name: "fetch_url", origin: "web_fetch", round: 1,
      serverName: "Web", status: "requested" } }, type: "artifact" } satisfies RunEventView;
    const heading = summary({ heading: "Comparing the two pages", stage: "reasoning", status: "running" });
    expect(presentRunLifecycleV2(state({ events: [tool, model], runId: "run-tools" })).activity)
      .toMatchObject({ kind: "results", label: runWaitingPhraseV2("run-tools") });
    expect(presentRunLifecycleV2(state({ events: [files, model] })).activity).toMatchObject({ kind: "provider" });
    expect(presentRunLifecycleV2(state({ events: [tool, model, heading] })).activity)
      .toMatchObject({ kind: "results", label: runWaitingPhraseV2(null), reasoningHeading: "Comparing the two pages" });
    // No answer ever reads "Reading results…" (operator decision 2026-10-21).
    expect(presentRunLifecycleV2(state({ events: [tool, model, tool, model], runId: "run-loop" })).activity?.label)
      .toBe(runWaitingPhraseV2("run-loop"));
    // Retired stages name nothing.
    for (const stage of ["search", "compute", "preview"]) {
      expect(presentRunLifecycleV2(state({ events: [summary({ stage, status: "running" })] }))).toEqual({ kind: "idle", runId: null });
    }
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

  describe("live tool call settlement (#61)", () => {
    const call = (payload: Record<string, unknown>): RunEventView => ({ type: "artifact", data: { artifactType: "tool_call",
      payload: { name: "search", origin: "mcp", serverName: "Repository Tools", ...payload } } });
    const requested = (round: number, ordinal: number) => call({ ordinal, round, status: "requested" });
    const settled = (round: number, ordinal: number, status: "complete" | "error", durationMs = 40) =>
      call({ durationMs, ordinal, round, status });
    const statuses = (activity: ThreadToolActivity | null) => activity?.calls.map((row) => [row.round, row.status, row.durationMs]);

    it("settles each row by its own identity, also between calls of one tool on one server in one round", () => {
      const events = [requested(1, 0), requested(1, 1), settled(1, 1, "error", 75), settled(1, 0, "complete", 120), requested(2, 0)];
      expect(statuses(presentToolActivityV2(events.slice(0, 3)))).toEqual([[1, "running", undefined], [1, "error", 75]]);
      // Round 1 stops spinning while round 2 still runs.
      expect(statuses(presentToolActivityV2(events))).toEqual([[1, "complete", 120], [1, "error", 75], [2, "running", undefined]]);
      // A replayed settlement changes nothing.
      expect(presentToolActivityV2([...events, settled(1, 1, "complete", 1)])).toEqual(presentToolActivityV2(events));
    });

    it("settles a running persisted row by the name match and never overrides a persisted outcome", () => {
      const persisted: ThreadToolActivity = { calls: [
        { origin: "mcp", round: 1, serverName: "Repository Tools", status: "complete", toolName: "search", durationMs: 9 },
        { origin: "mcp", round: 1, serverName: "Repository Tools", status: "running", toolName: "search" }
      ] };
      expect(statuses(presentToolActivityV2([settled(1, 1, "error", 30)], persisted))).toEqual([[1, "complete", 9], [1, "error", 30]]);
      // Its live start was seen: the requested identity owns the row it matched.
      expect(statuses(presentToolActivityV2([requested(1, 0), requested(1, 1), settled(1, 1, "error", 30)], persisted)))
        .toEqual([[1, "complete", 9], [1, "error", 30]]);
      // The initiator's MCP details name the exact persisted row.
      const detailed: ThreadToolActivity = { calls: persisted.calls.map((row, ordinal) => ({ ...row, details: { ordinal, roundIndex: 1 } })) };
      expect(statuses(presentToolActivityV2([requested(1, 1), settled(1, 1, "complete", 30)], detailed)))
        .toEqual([[1, "complete", 9], [1, "complete", 30]]);
    });

    it("stops a row the ended run never settled without claiming success or failure", () => {
      const events = [requested(1, 0), requested(1, 1), settled(1, 0, "complete")];
      expect(statuses(presentToolActivityV2(events))).toEqual([[1, "complete", 40], [1, "running", undefined]]);
      const ended = presentToolActivityV2(events, null, true);
      expect(statuses(ended)).toEqual([[1, "complete", 40], [1, "cancelled", undefined]]);
      expect(describeToolCallV2(ended!.calls[1]!, "cancelled")).not.toMatch(/fail|used/iu);
    });

    it("ignores a malformed or unknown settlement", () => {
      const events = [requested(1, 0)];
      for (const malformed of [
        call({ durationMs: -1, ordinal: 0, round: 1, status: "complete" }),
        call({ durationMs: "5", ordinal: 0, round: 1, status: "complete" }),
        call({ durationMs: 1.5, ordinal: 0, round: 1, status: "complete" }),
        call({ ordinal: 0, round: 1, status: "done" }),
        call({ ordinal: 0, status: "complete" }),
        call({ name: "<script>", ordinal: 0, round: 1, status: "complete" }),
        // Another identity never settles a row a live identity owns.
        settled(1, 7, "complete"),
        settled(2, 0, "complete"),
        { type: "artifact", data: { artifactType: "tool_call", payload: null } } satisfies RunEventView
      ]) {
        expect(statuses(presentToolActivityV2([...events, malformed]))).toEqual([[1, "running", undefined]]);
        expect(presentRunLifecycleV2(state({ events: [...events, malformed] })).activity?.label).toBe("Using Repository Tools: search…");
      }
    });

    it("stops naming a settled call in the live status", () => {
      const other = call({ name: "list_files", ordinal: 1, round: 1, status: "requested" });
      const events = [requested(1, 0), other, call({ durationMs: 3, name: "list_files", ordinal: 1, round: 1, status: "complete" })];
      expect(presentRunLifecycleV2(state({ events: events.slice(0, 2), runId: "run" })).activity?.label)
        .toBe("Using Repository Tools: list files…");
      expect(presentRunLifecycleV2(state({ events, runId: "run" })).activity?.label).toBe("Using Repository Tools: search…");
      expect(presentRunLifecycleV2(state({ events: [...events, settled(1, 0, "error")], runId: "run" })).activity)
        .toMatchObject({ kind: "provider", label: runWaitingPhraseV2("run") });
    });
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

  it.each([
    ["memory_preparing_failed", "Memory preparation failed before provider dispatch."],
    ["memory_preparing_attempt_expired", "Memory preparation expired before dispatch."],
    ["memory_preparing_recovery_required", "Memory preparation was interrupted before dispatch."],
    ["memory_all_reusable_deleted", "Memory preparation stopped because reusable Memory was deleted."],
    ["memory_item_forgotten", "Memory preparation stopped because a selected Memory item was forgotten."],
    ["memory_preparing_failed", "The answer could not be prepared. Try again."]
  ])("neutralizes a Memory run failure %s by code and text", (code, message) => {
    const live = presentRunLifecycleV2(state({
      events: [{ type: "error", data: { code, message, recovery: "change_parameters" } }]
    }));
    expect(live).toMatchObject({ kind: "terminal_error", failure: {
      code: "preparation_failed", message: "The answer could not be prepared. Try again.", recovery: "change_parameters"
    } });
    // Historical persisted text without a live code is neutralized too.
    const persisted = presentRunLifecycleV2(state({ failure: { message }, status: "error" }));
    expect(persisted.failure?.message).toBe("The answer could not be prepared. Try again.");
    expect(JSON.stringify([live, persisted])).not.toMatch(/memory/iu);
  });

  it("neutralizes the settle failure text while keeping its non-Memory code", () => {
    expect(presentRunLifecycleV2(state({
      events: [{ type: "error", data: { code: "tool_call_settle_conflict", message: "Memory search could not be settled." } }]
    }))).toMatchObject({ failure: {
      code: "tool_call_settle_conflict", message: "The answer could not be prepared. Try again."
    } });
    expect(presentRunLifecycleV2(state({
      events: [{ type: "error", data: { code: "context_budget_exceeded", message: "Choose a model with a larger context." } }]
    })).failure).toMatchObject({ code: "context_budget_exceeded", message: "Choose a model with a larger context." });
  });

  it.each([
    ["memory_egress_destination_revoked", "Knowledge access changed before answer dispatch", "egress_destination_revoked"],
    ["memory_egress_receipt_conflict", "Provider dispatch evidence could not be completed.", "egress_receipt_conflict"],
    ["memory_egress_receipt_unavailable", "Provider dispatch evidence is unavailable.", "egress_receipt_unavailable"]
  ])("keeps the egress-ledger failure %s visible with an egress support code", (code, message, shown) => {
    const live = presentRunLifecycleV2(state({
      events: [{ type: "error", data: { code, message, recovery: "change_parameters" } }]
    }));
    expect(live.failure).toMatchObject({ code: shown, message });
    expect(JSON.stringify(live)).not.toMatch(/memory_/u);
  });

  it.each([
    ["memory_egress_receipt_unavailable", "Memory egress evidence is unavailable."],
    [null, "This run uses a retired answer-model Memory tool contract."],
    [null, "Checkpointed answer-model Memory tools cannot be replayed."]
  ])("neutralizes Memory-worded egress and retired-tool text (%s)", (code, message) => {
    const live = presentRunLifecycleV2(state({
      events: [{ type: "error", data: { ...(code ? { code } : {}), message, recovery: "change_parameters" } }]
    }));
    expect(live.failure?.message).toBe("The answer could not be prepared. Try again.");
    const persisted = presentRunLifecycleV2(state({ failure: { message }, status: "error" }));
    expect(persisted.failure?.message).toBe("The answer could not be prepared. Try again.");
    expect(JSON.stringify([live, persisted])).not.toMatch(/memory/iu);
  });

  it.each([
    "A retired answer-model Memory tool request cannot be rebuilt.",
    "This saved run uses a retired answer-model Memory tool contract."
  ])("neutralizes the historical retired-tool text %s live and after reload", (message) => {
    const coded = presentRunLifecycleV2(state({
      events: [{ type: "error", data: { code: "memory_answer_model_tools_retired", message, recovery: "change_parameters" } }]
    }));
    expect(coded.failure).toMatchObject({ code: "preparation_failed", message: RUN_PREPARATION_FAILURE_MESSAGE });
    const uncoded = presentRunLifecycleV2(state({
      events: [{ type: "error", data: { message, recovery: "change_parameters" } }]
    }));
    expect(uncoded.failure?.message).toBe(RUN_PREPARATION_FAILURE_MESSAGE);
    const persisted = presentRunLifecycleV2(state({ failure: { message }, status: "error" }));
    expect(persisted.failure?.message).toBe(RUN_PREPARATION_FAILURE_MESSAGE);
    expect(JSON.stringify([coded, uncoded, persisted])).not.toMatch(/memory/iu);
  });

  it("keeps a retired non-Memory runtime failure unchanged", () => {
    const message = "The retired Knowledge planning runtime cannot be replayed.";
    const live = presentRunLifecycleV2(state({
      events: [{ type: "error", data: { code: "knowledge_legacy_runtime_retired", message } }]
    }));
    expect(live.failure).toMatchObject({ code: "knowledge_legacy_runtime_retired", message });
    const persisted = presentRunLifecycleV2(state({ failure: { message }, status: "error" }));
    expect(persisted.failure?.message).toBe(message);
  });

  it("shows the server-written neutral text exactly as the live neutralization does", () => {
    expect(memoryUiCopy("answer.preparationFailed")).toBe(RUN_PREPARATION_FAILURE_MESSAGE);
    const persisted = presentRunLifecycleV2(state({
      failure: { message: RUN_PREPARATION_FAILURE_MESSAGE }, status: "error"
    }));
    expect(persisted.failure?.message).toBe(RUN_PREPARATION_FAILURE_MESSAGE);
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
    })).toBe("Worked for 8s");
    expect(answerProcessLabelV2({
      hasReasoning: true, memoryCount: 2, pastChatCount: 1, stepCount: 0, workDurationMs: null
    })).toBe("Thought process");
    expect(answerProcessLabelV2({
      hasReasoning: false, memoryCount: 2, pastChatCount: 1, stepCount: 0, workDurationMs: 8_000
    })).toBe("Past chats · 1 · Memory · 2");
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

  it("merges absolute search outcomes across duplicate and reordered live snapshots", () => {
    const event = (requested: number, complete: number, error = 0) => ({
      type: "artifact", data: { artifactType: "search_activity", payload: { engines: [
        { engine: 1, name: "Perplexity", requested, settled: complete + error, complete, error, skipped: 0 }
      ] } }
    });
    const activity = presentToolActivityV2([event(2, 1), event(1, 0), event(2, 1), event(2, 2)]);
    expect(activity?.searchEngines).toEqual([
      { engine: 1, name: "Perplexity", requested: 2, settled: 2, complete: 2, error: 0, skipped: 0 }
    ]);
    expect(presentToolActivityV2([event(1, 0)], activity)?.searchEngines).toEqual(activity?.searchEngines);
    expect(presentToolActivityV2([event(1, 0)], null, true)?.searchEngines).toEqual([
      { engine: 1, name: "Perplexity", requested: 1, settled: 1, complete: 0, error: 0, skipped: 0 }
    ]);
    expect(JSON.stringify(activity)).not.toMatch(/invocationId|optionId|query|requestBody/iu);
  });

  it.each([
    ["Repository Tools", "search", "search"],
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

  it.each(["search", "find_tools"])(
    "retains the server for a %s call without explicit origin",
    (toolName) => {
      expect(toolActivityOriginV2({ serverName: "Repository Tools", toolName })).toBe("mcp");
      expect(describeToolCallV2({ serverName: "Repository Tools", toolName }, "settled"))
        .toContain("Used Repository Tools:");
    }
  );

  it.each([
    ["web_search", "Searching the web", "Searched the web", "Web search failed", "Web search stopped"],
    ["discovery", "Finding relevant tools", "Found relevant tools", "Tool discovery failed", "Tool discovery stopped"],
    ["workspace", "Working in Workspace", "Worked in Workspace", "Workspace step failed", "Workspace step stopped"]
  ])("preserves explicit built-in %s regardless of its display names", (origin, running, settled, failed, cancelled) => {
    const call = { origin, serverName: "Catalog Search", toolName: "search" };
    expect(describeToolCallV2(call, "running")).toBe(running);
    expect(describeToolCallV2(call, "settled")).toBe(settled);
    expect(describeToolCallV2(call, "failed")).toBe(failed);
    expect(describeToolCallV2(call, "cancelled")).toBe(cancelled);
  });

  it("reads a page as Reading host/path and names each refusal or failure in plain words", () => {
    const call = (fetchOutcome?: string, fetchHttpStatus?: number) => ({ origin: "web_fetch", serverName: "Web", toolName: "fetch_url",
      fetchTarget: "news.example/today", ...(fetchOutcome ? { fetchOutcome } : {}), ...(fetchHttpStatus ? { fetchHttpStatus } : {}) });
    expect(describeToolCallV2(call(), "running")).toBe("Reading news.example/today");
    expect(describeToolCallV2(call("read"), "settled")).toBe("Read news.example/today");
    expect(describeToolCallV2(call(), "cancelled")).toBe("Reading news.example/today stopped");
    expect(describeToolCallV2(call("fetch_url_not_in_conversation"), "failed"))
      .toBe("Skipped news.example/today: only links from this chat or web search are read");
    expect(describeToolCallV2({ ...call("fetch_url_not_in_conversation"), fetchRefusalScope: "scheduled_run" }, "failed"))
      .toBe("Didn't read news.example/today: open the automation and save its instructions to allow this link");
    expect(describeToolCallV2({ ...call("fetch_url_not_in_conversation"), fetchRefusalScope: "task_instructions" }, "failed"))
      .toBe("Didn't read news.example/today: links in an automation's instructions are read only by that automation's runs");
    for (const blocked of ["fetch_blocked_address", "fetch_port_not_allowed", "fetch_url_credentials"]) {
      expect(describeToolCallV2(call(blocked), "failed")).toBe("Blocked news.example/today: this address is not allowed");
    }
    expect(describeToolCallV2(call("fetch_timeout"), "failed")).toBe("Couldn't read news.example/today: the page took too long");
    expect(describeToolCallV2(call("fetch_too_large"), "failed")).toBe("Couldn't read news.example/today: the page is too large");
    expect(describeToolCallV2(call("fetch_unsupported_content_type"), "failed"))
      .toBe("Couldn't read news.example/today: not a web page or PDF, upload the file instead");
    expect(describeToolCallV2(call("fetch_http_status", 404), "failed")).toBe("Couldn't read news.example/today: the site returned 404");
    expect(describeToolCallV2({ origin: "web_fetch", toolName: "fetch_url" }, "failed")).toBe("Couldn't read web page");
    // The live requested event carries only the bounded target, never a scheme.
    const requested: RunEventView = { type: "artifact", data: { artifactType: "tool_call", payload: { name: "fetch_url",
      origin: "web_fetch", round: 1, serverName: "Web", status: "requested", fetchTarget: "news.example/today" } } };
    expect(presentRunLifecycleV2(state({ events: [requested], runId: "run" })).activity?.label).toBe("Reading news.example/today…");
    expect(presentToolActivityV2([requested])?.calls).toEqual([expect.objectContaining({ fetchTarget: "news.example/today",
      origin: "web_fetch", status: "running" })]);
    const unsafe: RunEventView = { type: "artifact", data: { artifactType: "tool_call", payload: { name: "fetch_url",
      origin: "web_fetch", round: 1, status: "requested", fetchTarget: "https://news.example/today" } } };
    expect(presentToolActivityV2([unsafe])?.calls[0]).not.toHaveProperty("fetchTarget");
  });

  it("names a link read as a PDF and each PDF failure", () => {
    const call = (fetchOutcome: string, pdf = true) => ({ origin: "web_fetch", toolName: "fetch_url",
      fetchTarget: "arxiv.org/pdf/2401.00001", fetchOutcome, ...(pdf ? { fetchContentKind: "pdf" } : {}) });
    expect(describeToolCallV2(call("read"), "settled")).toBe("Read PDF arxiv.org/pdf/2401.00001");
    expect(describeToolCallV2(call("read", false), "settled")).toBe("Read arxiv.org/pdf/2401.00001");
    expect(describeToolCallV2(call("fetch_no_readable_text"), "failed"))
      .toBe("No readable text in PDF arxiv.org/pdf/2401.00001, it may be scanned");
    expect(describeToolCallV2(call("fetch_timeout"), "failed")).toBe("Couldn't read arxiv.org/pdf/2401.00001: the PDF took too long");
    expect(describeToolCallV2(call("fetch_too_large"), "failed")).toBe("Couldn't read arxiv.org/pdf/2401.00001: the PDF is too large");
    expect(describeToolCallV2(call("fetch_pdf_password_protected"), "failed"))
      .toBe("Couldn't read arxiv.org/pdf/2401.00001: the PDF is password-protected");
    expect(describeToolCallV2(call("fetch_pdf_invalid"), "failed"))
      .toBe("Couldn't read arxiv.org/pdf/2401.00001: the PDF is damaged or unreadable");
    expect(describeToolCallV2(call("fetch_pdf_too_many_pages"), "failed"))
      .toBe("Couldn't read arxiv.org/pdf/2401.00001: the PDF has too many pages");
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

  it("falls back to the settled step durations", () => {
    expect(stepDurationSumV2(null)).toBeNull();
    expect(stepDurationSumV2({ calls: [{ round: 1, status: "running", toolName: "web_search" }] })).toBeNull();
    expect(stepDurationSumV2({
      calls: [
        { durationMs: 1_400, round: 1, status: "complete", toolName: "web_search" },
        { durationMs: 800, round: 2, status: "complete", toolName: "fetch_url" }
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

  it.each([
    ["live", { events: [{ type: "error", data: { code: "pdf_reader_output_limit", message: "x", retryable: false } }] }],
    ["reloaded", { failure: { message: CHAT_PDF_READER_OUTPUT_LIMIT.message } }]
  ])("explains an exhausted reader output budget without a retry (%s)", (_kind, source) => {
    expect(presentRunLifecycleV2({ content: "", events: [], runId: "run-pdf", status: "error", ...source,
      pdfPreparation: [{ completedPages: 1, pageCount: 3, phase: "failed", retryable: false,
        route: "system_vision", limitedReadingQuality: false, longDocument: false }] } as RunLifecycleStateV2)).toEqual({
      kind: "terminal_error", runId: "run-pdf",
      failure: { code: "pdf_reader_output_limit", message: CHAT_PDF_READER_OUTPUT_LIMIT.message, recovery: "change_parameters" }
    });
  });
});

describe("run announcer policy", () => {
  function speak(sequence: readonly AnnouncedRunPresentationV2[]) {
    let memory: RunAnnouncerMemoryV2 | null = null;
    const spoken: string[] = [];
    for (const presentation of sequence) {
      const step = stepRunAnnouncementV2(memory, "chat-a", presentation);
      memory = step.memory;
      const text = [...step.parts, step.terminal].filter(Boolean).join(" ");
      if (text) spoken.push(text);
      if (step.withdrawn) spoken.push("(withdrawn)");
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

  it("withdraws a started answer that a refused send rolled back, once and silently", () => {
    const idle: RunPresentationV2 = { kind: "idle", runId: null };
    const steps = (sequence: readonly RunPresentationV2[]) => {
      let memory: RunAnnouncerMemoryV2 | null = null;
      return sequence.map((presentation) => {
        const step = stepRunAnnouncementV2(memory, "chat-a", presentation);
        memory = step.memory;
        return step.withdrawn ? "(withdrawn)" : [...step.parts, step.terminal].filter(Boolean).join(" ");
      });
    };
    // The refused answer is withdrawn once; the next send is a new run and starts again.
    expect(steps([idle, thinking(null), idle, idle, thinking(null), { kind: "complete", runId: "run-b" }]))
      .toEqual(["", "Working on the answer…", "(withdrawn)", "", "Working on the answer…",
        "Answer ready. The message field is available."]);
    // An answer that had adopted its run id is withdrawn the same way.
    expect(steps([idle, thinking("run-a"), idle])).toEqual(["", "Working on the answer…", "(withdrawn)"]);
    // Nothing was announced, nothing is withdrawn.
    expect(steps([idle, idle])).toEqual(["", ""]);
    // Settled and historical answers are never withdrawn.
    expect(steps([idle, thinking("run-a"), { kind: "cancelled", runId: "run-a" }, idle]))
      .toEqual(["", "Working on the answer…", "Run stopped. The message field is available.", ""]);
    expect(steps([idle, thinking("run-a"), { failure: { code: null, message: "Provider timed out", recovery: "retry" },
      kind: "terminal_error", runId: "run-a" }, idle]))
      .toEqual(["", "Working on the answer…", "Run failed. Provider timed out. The message field is available.", ""]);
    expect(steps([{ kind: "complete", runId: "run-old" }, idle])).toEqual(["", ""]);
    // A chat change is not a withdrawal.
    const started = stepRunAnnouncementV2(null, "chat-a", thinking(null)).memory;
    expect(stepRunAnnouncementV2(started, "chat-b", idle)).toMatchObject({ chatChanged: true, withdrawn: false });
  });

  it("withdraws a refused answer when the earlier settled answer is the tail again", () => {
    const READY = "Answer ready. The message field is available.";
    const answer = (answerId: string, presentation: RunPresentationV2): AnnouncedRunPresentationV2 =>
      ({ ...presentation, answerId });
    const earlier = answer("message-old", { kind: "complete", runId: "run-old" });
    const done = answer("message-b", { kind: "complete", runId: "run-b" });
    // Refused, then sent again: the second send starts and settles once.
    expect(speak([earlier, answer("assistant-1", thinking(null)), earlier, earlier,
      answer("assistant-2", thinking(null)), answer("message-b", thinking("run-b")), done, done]))
      .toEqual(["Working on the answer…", "(withdrawn)", "Working on the answer…", READY]);
    // So after an earlier answer without a run id, such as a continuation summary.
    const summary = answer("message-summary", { kind: "complete", runId: null });
    expect(speak([summary, answer("assistant-1", thinking(null)), summary]))
      .toEqual(["Working on the answer…", "(withdrawn)"]);
    // The followed answer adopting its durable id as it settles is its own settlement.
    expect(speak([earlier, answer("assistant-1", thinking(null)), done])).toEqual(["Working on the answer…", READY]);
    expect(speak([earlier, answer("assistant-1", thinking(null)), answer("message-b", { kind: "complete", runId: null })]))
      .toEqual(["Working on the answer…", READY]);
    // An answer settled in place keeps its id and is announced.
    const failed = answer("message-x", { failure: { code: null, message: "Provider timed out", recovery: "retry" },
      kind: "recoverable_error", runId: "run-x" });
    expect(speak([failed, answer("message-x", thinking("run-y")), answer("message-x", { kind: "complete", runId: "run-y" })]))
      .toEqual(["Working on the answer…", READY]);
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
