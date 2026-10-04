import { describe, expect, it, vi } from "vitest";
import { readOnlyRunTool } from "../runs/toolReadOnly";
import {
  executeMonitoringVerdict,
  isMonitoringVerdictCall,
  MONITORING_VERDICT_TOOL_NAME,
  monitoringCheckInstruction,
  monitoringVerdictTool,
  type MonitoringVerdictRecorder
} from "./monitoringVerdict";

const call = (args: Record<string, unknown>) => ({ arguments: args, id: "report-1", name: MONITORING_VERDICT_TOOL_NAME });
const actor = { runId: "run-1", userId: "user-1" };

describe("monitoring verdict tool", () => {
  it("is a strict, server-owned report that never reaches another run", () => {
    expect(monitoringVerdictTool).toMatchObject({ capability: "session", name: "report_monitoring_result", strict: true,
      inputSchema: { additionalProperties: false, required: ["status"] } });
    expect(isMonitoringVerdictCall({ monitoringVerdictTool: true }, MONITORING_VERDICT_TOOL_NAME)).toBe(true);
    for (const request of [{}, { monitoringVerdictTool: "true" }]) {
      expect(isMonitoringVerdictCall(request, MONITORING_VERDICT_TOOL_NAME)).toBe(false);
    }
    expect(isMonitoringVerdictCall({ monitoringVerdictTool: true }, "get_session_status")).toBe(false);
    // Reporting changes nothing another call reads: repeated identical business calls stay detectable.
    expect(readOnlyRunTool({ tools: [monitoringVerdictTool] })(MONITORING_VERDICT_TOOL_NAME)).toBe(true);
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
});
