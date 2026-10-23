import { describe, expect, it } from "vitest";
import {
  displayedToolCallState,
  isRunEndedToolCallResult,
  isToolLoopJsonValue,
  runEndedToolCallResult,
  snapshotToolLoopJson
} from "./toolLoopPersistence";

describe("tool call JSON values", () => {
  it("snapshots bounded JSON and refuses what JSON cannot hold or the bound does not fit", () => {
    expect(snapshotToolLoopJson({ a: [1, "two", null, true] }, 100)).toEqual({ a: [1, "two", null, true] });
    expect(snapshotToolLoopJson(undefined, 100)).toBeNull();
    expect(snapshotToolLoopJson({ value: "x".repeat(200) }, 100)).toBeNull();
    expect(isToolLoopJsonValue({ value: Number.NaN })).toBe(false);
    expect(isToolLoopJsonValue({ nested: [{ ok: 1 }] })).toBe(true);
  });
});

describe("tool calls of an ended run", () => {
  it("recognizes only the exact content-free closure result", () => {
    expect(runEndedToolCallResult()).toEqual({ code: "run_ended_before_tool_settled", outcome: "unknown" });
    expect(isRunEndedToolCallResult(runEndedToolCallResult())).toBe(true);
    for (const value of [null, { code: "run_ended_before_tool_settled" }, { ...runEndedToolCallResult(), content: [] },
      { code: "agent_execution_interrupted", outcome: "unknown" }, [runEndedToolCallResult()]]) {
      expect(isRunEndedToolCallResult(value)).toBe(false);
    }
  });

  it("displays open calls of an ended run as stopped and leaves live runs alone", () => {
    for (const runStatus of ["complete", "cancelled", "error"]) {
      expect(displayedToolCallState({ state: "running" }, runStatus)).toBe("cancelled");
      expect(displayedToolCallState({ state: "pending" }, runStatus)).toBe("cancelled");
    }
    for (const runStatus of ["queued", "streaming", "in_progress", "preparing", undefined]) {
      expect(displayedToolCallState({ state: "running" }, runStatus)).toBe("running");
    }
    expect(displayedToolCallState({ result: runEndedToolCallResult(), state: "error" }, "streaming")).toBe("cancelled");
    expect(displayedToolCallState({ result: { code: "tool_failed" }, state: "error" }, "cancelled")).toBe("error");
    expect(displayedToolCallState({ state: "complete" }, "error")).toBe("complete");
  });
});
