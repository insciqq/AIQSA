// @vitest-environment node
import { describe, expect, it } from "vitest";
import { invalidProviderToolArguments } from "./types";
import { UPDATE_PLAN_TOOL_NAME, executeUpdatePlan, updatePlanTool } from "./updatePlan";

const call = (args: Record<string, unknown>) => ({ arguments: args, id: "call_plan", name: UPDATE_PLAN_TOOL_NAME });

describe("update_plan", () => {
  it("declares no effects and needs neither approval nor the VM", () => {
    expect(updatePlanTool).toMatchObject({ effects: "none", name: "update_plan", needsApproval: false, requiresVm: false });
    expect(updatePlanTool.inputSchema).toMatchObject({ required: ["plan"] });
  });

  it("answers like Codex and carries the validated plan for the progress display", () => {
    const result = executeUpdatePlan(call({ explanation: "  Data was in two sheets ", plan: [
      { status: "completed", step: "Read the workbook" }, { status: "in_progress", step: " Merge the sheets " }, { status: "pending", step: "Draw the chart" }
    ] }));
    expect(result).toEqual({ callId: "call_plan", content: [{ text: "Plan updated", type: "text" }], name: "update_plan",
      rawPreview: { plan: { explanation: "Data was in two sheets", plan: [
        { status: "completed", step: "Read the workbook" }, { status: "in_progress", step: "Merge the sheets" }, { status: "pending", step: "Draw the chart" }
      ] } }, status: "complete" });
  });

  it.each([
    [{}, "plan must be a non-empty list"],
    [{ plan: [] }, "plan must be a non-empty list"],
    [{ plan: [{ status: "done", step: "x" }] }, "plan[0].status must be one of pending, in_progress, completed."],
    [{ plan: [{ status: "pending", step: " " }] }, "plan[0].step must be a non-empty string."],
    [{ plan: [{ status: "pending", step: "x", note: 1 }] }, "plan[0] has unknown field \"note\""],
    [{ plan: [{ status: "in_progress", step: "a" }, { status: "in_progress", step: "b" }] }, "2 steps are in_progress; at most one"],
    [{ plan: [{ status: "pending", step: "a" }], extra: true }, "Unknown argument \"extra\""],
    [{ explanation: 3, plan: [{ status: "pending", step: "a" }] }, "explanation must be a string."],
    [{ plan: Array.from({ length: 51 }, (_, index) => ({ status: "pending", step: `s${index}` })) }, "plan has 51 steps; the limit is 50."],
    [invalidProviderToolArguments(), "The arguments were not valid JSON."]
  ])("refuses %j with the invalid field", (args, message) => {
    const result = executeUpdatePlan(call(args));
    expect(result.status).toBe("error");
    expect(result.content[0]).toMatchObject({ type: "json", value: { code: "update_plan_invalid" } });
    expect(JSON.stringify(result.content[0])).toContain(JSON.stringify(message).slice(1, -1));
  });
});
