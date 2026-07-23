import { describe, expect, it } from "vitest";
import {
  appendAssistantDelta,
  appendCompactRunEvent,
  mergeThreadMessages,
  pipelineStage,
  runActivityLabel
} from "./runState";
import type { RunEventView, ThreadMessage } from "./types";

function message(overrides: Partial<ThreadMessage>): ThreadMessage {
  return {
    content: "",
    id: "message-1",
    modelId: "fake-model",
    parentMessageId: null,
    provider: "fake",
    role: "user",
    status: "complete",
    ...overrides
  };
}

const tokenEvent: RunEventView = { data: { delta: "word " }, type: "token" };

const searchArtifact: RunEventView = {
  data: { artifactType: "search", payload: { query: "pipeline" } },
  type: "artifact"
};

const citationArtifact: RunEventView = {
  data: { artifactType: "citation", payload: { citations: [] } },
  type: "artifact"
};

const searchSkipArtifact: RunEventView = {
  data: { artifactType: "summary", payload: { stage: "search", status: "skipped" } },
  type: "artifact"
};

const fakeSummaryArtifact: RunEventView = {
  data: { artifactType: "summary", payload: { source: "fake-provider" } },
  type: "artifact"
};

const modelWaitingArtifact: RunEventView = {
  data: { artifactType: "summary", payload: { stage: "model", status: "waiting" } },
  type: "artifact"
};

const toolsRunningArtifact: RunEventView = {
  data: { artifactType: "summary", payload: { count: 2, stage: "tools", status: "running" } },
  type: "artifact"
};

const errorEvent: RunEventView = { data: { message: "provider exploded" }, type: "error" };

function doneEvent(status = "complete"): RunEventView {
  return { data: { runId: "run-1", status }, type: "done" };
}

function stage(events: RunEventView[], overrides: { searchEnabled?: boolean; streaming?: boolean } = {}) {
  return pipelineStage({
    events,
    searchEnabled: overrides.searchEnabled ?? true,
    streaming: overrides.streaming ?? true
  });
}

describe("pipelineStage", () => {
  it("stays idle before a run produces any signal", () => {
    expect(stage([], { streaming: false })).toEqual({
      answer: "idle",
      phase: "idle",
      question: "idle",
      search: "idle"
    });
  });

  it("activates Q as soon as the stream opens", () => {
    expect(stage([])).toEqual({
      answer: "idle",
      phase: "running",
      question: "active",
      search: "idle"
    });
  });

  it("renders S as skipped from the start when search is disabled", () => {
    expect(stage([], { searchEnabled: false }).search).toBe("skipped");
    expect(stage([tokenEvent], { searchEnabled: false })).toEqual({
      answer: "active",
      phase: "running",
      question: "done",
      search: "skipped"
    });
  });

  it("hands off Q to S on the first search artifact", () => {
    expect(stage([searchArtifact])).toEqual({
      answer: "idle",
      phase: "running",
      question: "done",
      search: "active"
    });
  });

  it("treats citation artifacts as search/tool activity", () => {
    expect(stage([citationArtifact]).search).toBe("active");
  });

  it("does not regress S once A starts streaming", () => {
    expect(stage([searchArtifact, tokenEvent])).toEqual({
      answer: "active",
      phase: "running",
      question: "done",
      search: "done"
    });
  });

  it("marks S done when search evidence arrives after the first tokens", () => {
    expect(stage([tokenEvent, searchArtifact, tokenEvent])).toEqual({
      answer: "active",
      phase: "running",
      question: "done",
      search: "done"
    });
  });

  it("keeps S pending while streaming when search is enabled but silent so far", () => {
    expect(stage([tokenEvent])).toEqual({
      answer: "active",
      phase: "running",
      question: "done",
      search: "idle"
    });
  });

  it("renders S as skipped when the backend reports the stage was skipped", () => {
    expect(stage([searchSkipArtifact, tokenEvent])).toEqual({
      answer: "active",
      phase: "running",
      question: "done",
      search: "skipped"
    });
  });

  it("ignores summary artifacts that are not search/tool signals", () => {
    const snapshot = stage([fakeSummaryArtifact]);

    expect(snapshot.search).toBe("idle");
    expect(snapshot.question).toBe("active");
  });

  it("settles all stages on completion", () => {
    expect(stage([searchArtifact, tokenEvent, doneEvent()], { streaming: false })).toEqual({
      answer: "done",
      phase: "settled",
      question: "done",
      search: "done"
    });
  });

  it("settles with S skipped when the run never searched", () => {
    expect(stage([fakeSummaryArtifact, tokenEvent, doneEvent()], { streaming: false })).toEqual({
      answer: "done",
      phase: "settled",
      question: "done",
      search: "skipped"
    });
  });

  it("pins the error on Q when the run fails before any stage signal", () => {
    expect(stage([errorEvent], { streaming: false })).toEqual({
      answer: "idle",
      phase: "error",
      question: "error",
      search: "idle"
    });
  });

  it("pins the error on S when search activity was the last signal", () => {
    expect(stage([searchArtifact, errorEvent], { streaming: false })).toEqual({
      answer: "idle",
      phase: "error",
      question: "done",
      search: "error"
    });
  });

  it("pins the error on A once tokens have streamed", () => {
    expect(stage([searchArtifact, tokenEvent, errorEvent], { streaming: false })).toEqual({
      answer: "error",
      phase: "error",
      question: "done",
      search: "done"
    });

    expect(stage([tokenEvent, errorEvent], { searchEnabled: false, streaming: false })).toEqual({
      answer: "error",
      phase: "error",
      question: "done",
      search: "skipped"
    });
  });

  it("keeps the first error stage when later events arrive", () => {
    expect(stage([errorEvent, tokenEvent, errorEvent], { streaming: false }).question).toBe("error");
  });

  it("reports a cancelled run without pretending the answer finished", () => {
    expect(stage([searchArtifact, doneEvent("cancelled")], { streaming: false })).toEqual({
      answer: "idle",
      phase: "cancelled",
      question: "done",
      search: "done"
    });

    expect(stage([tokenEvent, doneEvent("cancelled")], { streaming: false })).toEqual({
      answer: "done",
      phase: "cancelled",
      question: "done",
      search: "skipped"
    });
  });

  it("returns to idle for abandoned event surfaces without a live stream", () => {
    expect(stage([tokenEvent], { streaming: false })).toEqual({
      answer: "idle",
      phase: "idle",
      question: "idle",
      search: "idle"
    });
  });
});

describe("runActivityLabel", () => {
  it("stays generic until events prove search or answer activity", () => {
    expect(runActivityLabel(stage([]))).toBe("Working");
    expect(runActivityLabel(stage([searchArtifact]))).toBe("Searching");
    expect(runActivityLabel(stage([searchArtifact, tokenEvent]))).toBe("Answering");
  });

  it("keeps failures readable without inventing the interrupted stage", () => {
    expect(runActivityLabel(stage([searchArtifact, errorEvent], { streaming: false }))).toBe("Run error");
  });

  it("shows explicit model and MCP tool phases until the next answer token", () => {
    expect(runActivityLabel(stage([modelWaitingArtifact]))).toBe("Waiting for model");
    expect(runActivityLabel(stage([modelWaitingArtifact, toolsRunningArtifact]))).toBe("Running 2 tools");
    expect(runActivityLabel(stage([toolsRunningArtifact, tokenEvent]))).toBe("Answering");
  });
});

describe("run state helpers", () => {
  it("compacts a 2,000-token stream into one bounded timeline event", () => {
    let events: RunEventView[] = [];

    for (let index = 0; index < 2_000; index += 1) {
      events = appendCompactRunEvent(events, {
        data: { chunkCount: 1, delta: "x" },
        type: "token"
      });
    }

    expect(events).toEqual([
      {
        data: {
          characterCount: 2_000,
          chunkCount: 2_000
        },
        type: "token"
      }
    ]);
  });

  it("preserves chronology by starting a new token aggregate after another event", () => {
    const events = [tokenEvent, searchArtifact, tokenEvent].reduce(appendCompactRunEvent, [] as RunEventView[]);

    expect(events.map((event) => event.type)).toEqual(["token", "artifact", "token"]);
  });

  it("preserves optimistic in-flight rows when stale chat detail is merged", () => {
    const persistedUser = message({ content: "Before", id: "user-1" });
    const optimisticUser = message({ content: "Question", id: "user-optimistic", parentMessageId: "user-1" });
    const optimisticAssistant = message({
      id: "assistant-optimistic",
      parentMessageId: "user-optimistic",
      role: "assistant",
      status: "streaming"
    });

    const merged = mergeThreadMessages(
      [persistedUser, optimisticUser, optimisticAssistant],
      [{ ...persistedUser, content: "Before from server" }]
    );

    expect(merged.map((candidate) => candidate.id)).toEqual([
      "user-1",
      "user-optimistic",
      "assistant-optimistic"
    ]);
    expect(merged[0].content).toBe("Before from server");
    expect(merged[2]).toMatchObject({
      role: "assistant",
      status: "streaming"
    });
  });
});
