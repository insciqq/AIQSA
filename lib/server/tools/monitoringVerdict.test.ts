import { describe, expect, it, vi } from "vitest";
import {
  executeMonitoringVerdict,
  isMonitoringVerdictCall,
  MONITORING_VERDICT_TOOL_NAME,
  monitoringAnswerTextInstruction,
  monitoringCheckInstruction,
  monitoringVerdictNeedsText,
  monitoringVerdictTool,
  type MonitoringVerdictRecorder
} from "./monitoringVerdict";
import { reservedToolCallForRequest } from "./reservedToolCall";

const call = (args: Record<string, unknown>) => ({ arguments: args, id: "report-1", name: MONITORING_VERDICT_TOOL_NAME });
const actor = { runId: "run-1", userId: "user-1" };

describe("monitoring verdict tool", () => {
  it("is a strict, server-owned report that never reaches another run", () => {
    expect(monitoringVerdictTool).toMatchObject({ capability: "session", name: "report_monitoring_result", strict: true,
      inputSchema: { additionalProperties: false, required: ["status"] } });
    expect(monitoringVerdictTool.inputSchema.properties).toEqual({
      status: { enum: ["update", "no_update", "goal_reached", "could_not_check"], type: "string" }
    });
    expect(isMonitoringVerdictCall({ monitoringVerdictTool: true }, MONITORING_VERDICT_TOOL_NAME)).toBe(true);
    for (const request of [{}, { monitoringVerdictTool: "true" }]) {
      expect(isMonitoringVerdictCall(request, MONITORING_VERDICT_TOOL_NAME)).toBe(false);
    }
    expect(isMonitoringVerdictCall({ monitoringVerdictTool: true }, "get_session_status")).toBe(false);
  });

  it("records a valid report for its own run, and the same report again records the same value", async () => {
    const recorded: unknown[] = [];
    const record = vi.fn<MonitoringVerdictRecorder>(async (input) => { recorded.push(input); return true; });
    const first = await executeMonitoringVerdict(call({ status: "no_update" }), actor, record);
    const again = await executeMonitoringVerdict(call({ status: "no_update" }), actor, record);
    expect(first).toEqual({ callId: "report-1", content: [{ type: "json", value: { recorded: true, status: "no_update" } }],
      name: MONITORING_VERDICT_TOOL_NAME, status: "complete" });
    expect(again).toEqual(first);
    expect(recorded).toEqual([{ ...actor, verdict: "no_update" }, { ...actor, verdict: "no_update" }]);
    // A check that could not reach what it needed says so instead of a hidden no_update.
    expect(await executeMonitoringVerdict(call({ status: "could_not_check" }), actor, record)).toMatchObject({
      content: [{ type: "json", value: { recorded: true, status: "could_not_check" } }], status: "complete" });
    expect(recorded.at(-1)).toEqual({ ...actor, verdict: "could_not_check" });
  });

  it("answers an invalid or unrecordable report with an error and records nothing invalid", async () => {
    const record = vi.fn<MonitoringVerdictRecorder>(async () => true);
    for (const args of [{}, { status: "maybe" }, { status: "update", note: "extra" }, { status: ["update"] }]) {
      expect(await executeMonitoringVerdict(call(args), actor, record)).toMatchObject({ status: "error" });
    }
    expect(record).not.toHaveBeenCalled();
    // No running occurrence of this run (deleted task) or no writer: the check stays unreported.
    expect(await executeMonitoringVerdict(call({ status: "update" }), actor, async () => false)).toMatchObject({ status: "error" });
    expect(await executeMonitoringVerdict(call({ status: "update" }), actor, undefined)).toMatchObject({ status: "error" });
    expect(await executeMonitoringVerdict(call({ status: "update" }), {}, record)).toMatchObject({ status: "error" });
    expect(record).not.toHaveBeenCalled();
  });

  it("instructs a comparison only when the context holds the previous shown result", () => {
    expect(monitoringCheckInstruction({ previousResult: true })).toContain("last result the user was shown");
    expect(monitoringCheckInstruction({ previousResult: false })).toContain("No earlier result has been shown");
    for (const previousResult of [true, false]) {
      expect(monitoringCheckInstruction({ previousResult })).toContain(`call ${MONITORING_VERDICT_TOOL_NAME} exactly once`);
    }
  });

  it("tells the model that only a reached goal ends the automation and that a failed check is no no_update", () => {
    for (const previousResult of [true, false]) {
      const instruction = monitoringCheckInstruction({ previousResult });
      // A scheduled run has no other way to stop its automation.
      expect(instruction).toContain("\"goal_reached\" if what the user is waiting for has happened: it ends the automation permanently " +
        "and is the only way this run can stop it");
      expect(instruction).toContain("report it rather than \"update\"");
      expect(instruction).toContain("\"could_not_check\" if a page, search or tool the check needs failed or could not be reached");
      expect(instruction).toContain("never report \"no_update\" then");
      expect(instruction).toContain("Then write your answer as text, as usual, never the call alone.");
    }
    expect(monitoringCheckInstruction({ previousResult: true })).toContain("\"update\" if something the user asked to watch changed " +
      "since the last shown result; the automation keeps checking.");
    expect(monitoringCheckInstruction({ previousResult: false })).toContain("\"update\" on this first check");
    // The tool's own description says the same.
    expect(monitoringVerdictTool.description).toContain("goal_reached: what the user is waiting for has happened; this ends the " +
      "automation for good, and nothing else in this run can stop it.");
    expect(monitoringVerdictTool.description).toContain("update: something the user watches changed since the last shown result; " +
      "the automation keeps checking.");
    expect(monitoringVerdictTool.description).toContain("could_not_check: a page, search or tool the check needs failed or could " +
      "not be reached, so you cannot tell whether anything changed; never report no_update then.");
  });

  it("asks a shown check for its answer's text, never a hidden one or one that could not check", () => {
    // A later check: only an update or a reached goal is shown.
    expect(monitoringVerdictNeedsText("update", true)).toBe(true);
    expect(monitoringVerdictNeedsText("goal_reached", true)).toBe(true);
    expect(monitoringVerdictNeedsText("no_update", true)).toBe(false);
    expect(monitoringVerdictNeedsText("could_not_check", true)).toBe(false);
    // A first check is shown as the starting point whatever it reports, unless it could not check.
    expect(monitoringVerdictNeedsText("update", false)).toBe(true);
    expect(monitoringVerdictNeedsText("no_update", false)).toBe(true);
    expect(monitoringVerdictNeedsText("could_not_check", false)).toBe(false);
    expect(monitoringAnswerTextInstruction()).toContain("Do not call any tool.");
  });

  it("reserves the text instruction with the verdict, deciding from the recorded call's arguments", () => {
    const later = reservedToolCallForRequest({ monitoringPreviousResult: true, monitoringVerdictTool: true });
    expect(later?.textInstruction).toBe(monitoringAnswerTextInstruction());
    expect(later?.textNeeded({ status: "update" })).toBe(true);
    expect(later?.textNeeded({ status: "no_update" })).toBe(false);
    expect(later?.textNeeded({ status: "maybe" })).toBe(false);
    expect(reservedToolCallForRequest({ monitoringPreviousResult: false, monitoringVerdictTool: true })?.textNeeded({ status: "no_update" }))
      .toBe(true);
    // A run admitted before the previous result was recorded reads as a later check.
    expect(reservedToolCallForRequest({ monitoringVerdictTool: true })?.textNeeded({ status: "no_update" })).toBe(false);
    expect(reservedToolCallForRequest({})).toBeNull();
  });
});
