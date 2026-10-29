// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SUBAGENT_LIMITS, SUBAGENT_TOOL_NAMES } from "../../contracts/subagents";
import { LOAD_SKILL_TOOL_NAME } from "../tools/skill";
import { READ_SECRET_TOOL_NAME } from "../tools/readSecret";
import { BROWSER_HANDOFF_TOOL_NAME } from "../tools/browserHandoff";
import {
  SUBAGENT_TOOLS,
  callSubagentTool,
  parseCallSubagentArguments,
  parseCreateSubagentArguments,
  parseDeleteSubagentArguments,
  parseEditSubagentArguments,
  parseStopSubagentArguments,
  subagentMayUseTool
} from "./tools";

describe("sub-agent tool definitions", () => {
  it("declares exactly the contract's tools, never retried blindly", () => {
    expect(SUBAGENT_TOOLS.map((tool) => tool.name)).toEqual([...SUBAGENT_TOOL_NAMES]);
    for (const tool of SUBAGENT_TOOLS) {
      expect(tool.tool).toMatchObject({ description: tool.description, inputSchema: tool.inputSchema, name: tool.name });
      expect(tool.effects).not.toBe("none");
      expect(tool.needsApproval).toBe(false);
      expect(tool.description.length).toBeLessThan(4_000);
    }
    // A sub-agent can act outside AIQSA, so an unknown outcome is never sent again.
    expect(callSubagentTool.effects).toBe("external");
    expect(callSubagentTool.inputSchema).toMatchObject({ required: ["name", "message"] });
  });

  it("never offers a sub-agent nesting or a change of the user's resources, and keeps what it needs", () => {
    for (const name of [...SUBAGENT_TOOL_NAMES, "manage_secret", "manage_skill", "save_skill", "manage_assistant", "create_artifact",
      "create_scheduled_task", "manage_scheduled_task", "report_monitoring_result", "checkpoint_outputs"]) {
      expect(subagentMayUseTool(name), name).toBe(false);
    }
    for (const name of [LOAD_SKILL_TOOL_NAME, READ_SECRET_TOOL_NAME, BROWSER_HANDOFF_TOOL_NAME, "update_plan", "apply_patch",
      "fetch_url", "memory_search", "read_tool_result", "workspace__exec"]) expect(subagentMayUseTool(name), name).toBe(true);
  });
});

describe("call_subagent and stop_subagent arguments", () => {
  it("normalizes a call and keeps the optional overrides", () => {
    expect(parseCallSubagentArguments({ message: "  Find vacuums. ", name: "Shop-Amazon" }))
      .toEqual({ ok: true, value: { background: false, message: "Find vacuums.", name: "shop-amazon" } });
    expect(parseCallSubagentArguments({ background: true, effort: "low", message: "Go", model: "gpt-6-luna", name: "a", type: "Browser" }))
      .toEqual({ ok: true, value: { background: true, effort: "low", message: "Go", model: "gpt-6-luna", name: "a", type: "browser" } });
    // Null optional fields mean not given, as strict-mode providers send them.
    expect(parseCallSubagentArguments({ background: null, effort: null, message: "Go", model: null, name: "a", type: null }))
      .toEqual({ ok: true, value: { background: false, message: "Go", name: "a" } });
  });

  it("refuses bad calls with the stable code the model can act on", () => {
    const cases: Array<[unknown, string]> = [
      [null, "subagent_arguments_invalid"],
      [{ message: "Go", name: "a", extra: 1 }, "subagent_arguments_invalid"],
      [{ message: "Go", name: "two words" }, "subagent_name_invalid"],
      [{ message: "Go", name: "main" }, "subagent_name_invalid"],
      [{ message: " ", name: "a" }, "subagent_message_invalid"],
      [{ message: "x".repeat(SUBAGENT_LIMITS.messageCharacters + 1), name: "a" }, "subagent_message_invalid"],
      [{ message: "Go", name: "a", type: "Bad Type" }, "subagent_type_unavailable"],
      [{ message: "Go", model: "", name: "a" }, "subagent_model_unavailable"],
      [{ effort: 3, message: "Go", name: "a" }, "subagent_effort_unsupported"],
      [{ background: "yes", message: "Go", name: "a" }, "subagent_arguments_invalid"]
    ];
    for (const [value, code] of cases) expect(parseCallSubagentArguments(value), JSON.stringify(value)?.slice(0, 60)).toMatchObject({ code, ok: false });
  });

  it("takes only a name to stop or delete", () => {
    expect(parseStopSubagentArguments({ name: "A" })).toEqual({ ok: true, value: { name: "a" } });
    expect(parseStopSubagentArguments({ name: "a", force: true })).toMatchObject({ ok: false });
    expect(parseDeleteSubagentArguments({ name: "browser" })).toEqual({ ok: true, value: { name: "browser" } });
  });
});

describe("custom sub-agent management arguments", () => {
  it("creates with optional model, effort and tool groups", () => {
    expect(parseCreateSubagentArguments({ description: "Long browsing.", instructions: "Browse carefully.", name: "browser" }))
      .toEqual({ ok: true, value: { description: "Long browsing.", effort: null, instructions: "Browse carefully.", model: null,
        name: "browser", tools: null } });
    expect(parseCreateSubagentArguments({ description: "d", effort: "low", instructions: "i", model: "gpt-6-luna", name: "browser",
      tools: ["web_fetch", "workspace"] })).toMatchObject({ ok: true, value: { effort: "low", model: "gpt-6-luna", tools: ["workspace", "web_fetch"] } });
    expect(parseCreateSubagentArguments({ description: "d", name: "browser" })).toMatchObject({ ok: false });
    expect(parseCreateSubagentArguments({ description: "d", instructions: "i", name: "browser", tools: ["manage_secret"] }))
      .toMatchObject({ ok: false });
  });

  it("edits only what is given, telling a reset from a change", () => {
    expect(parseEditSubagentArguments({ effort: null, expectedVersion: 3, name: "browser", newName: "Shopper" })).toEqual({ ok: true, value: {
      description: { kind: "unchanged" }, effort: { kind: "reset" }, expectedVersion: 3, instructions: { kind: "unchanged" },
      model: { kind: "unchanged" }, name: "browser", newName: "shopper", tools: { kind: "unchanged" }
    } });
    expect(parseEditSubagentArguments({ name: "browser", tools: [] })).toMatchObject({ ok: true, value: { tools: { kind: "set", value: [] } } });
    expect(parseEditSubagentArguments({ name: "browser" })).toMatchObject({ ok: false });
    expect(parseEditSubagentArguments({ expectedVersion: 0, name: "browser", description: "d" })).toMatchObject({ ok: false });
    expect(parseEditSubagentArguments({ instructions: "", name: "browser" })).toMatchObject({ ok: false });
  });
});
