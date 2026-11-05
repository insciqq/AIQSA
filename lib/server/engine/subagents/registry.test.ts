import { describe, expect, it, vi } from "vitest";
import { CHANGE_RESEARCH_FRAME_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME, type ResearchEvidenceRecord } from "../../../contracts/research";
import { SUBAGENT_TOOL_GROUPS } from "../../../contracts/subagents";
import { callSubagentTool, stopSubagentTool } from "../../subagents/tools";
import { recordEvidenceEngineTool } from "../../tools/recordEvidence";
import type { RunTool } from "../../tools/types";
import { namespacedWorkspaceToolName } from "../../workspace/toolCatalog";
import type { EngineTool, ToolRegistry } from "../toolRegistry";
import { subagentToolRegistry, withoutResearchBookkeeping } from "./registry";

function tool(name: string, capability: RunTool["capability"]): EngineTool {
  return { activity: () => ({}), definition: { capability, description: name, inputSchema: { type: "object" }, name }, effects: "none",
    execute: vi.fn(), observationSource: "workspace" };
}

const tools = [
  tool("manage_proxy", "session"), tool("manage_secret", "session"), tool("manage_skill", "skill"), tool("save_skill", "skill"), tool("manage_assistant", "session"),
  tool("create_artifact", "artifact"), tool("create_scheduled_task", "session"), tool("manage_scheduled_task", "session"),
  tool("report_monitoring_result", "session"), tool("checkpoint_outputs", "workspace"),
  tool(callSubagentTool.name, "session"), tool(stopSubagentTool.name, "session"),
  tool("load_skill", "skill"), tool("read_skill_file", "skill"), tool("read_secret", "session"), tool("update_plan", "session"),
  tool("read_tool_result", "session"), tool("read_aiqsa_guide", "session"), tool("fetch_url", "web_fetch"),
  tool("search_selected_engines", "web_search"), tool("mcp_jira_create_issue", "mcp"), tool("find_tools", "mcp"),
  tool("mcp_workspace__sandbox_exec", "workspace"), tool("apply_patch", "session"), tool("browser_handoff", "session"),
  tool("memory_search", "memory"), tool("generate_image", "image"), tool("analyze_image", "vision")
];
const parent: ToolRegistry = {
  definitions: () => tools.map((entry) => entry.definition),
  mcpLoadCall: (name, id) => ({ arguments: { query: `select:${name}` }, id, name: "find_tools" }),
  resolve: (name) => tools.find((entry) => entry.definition.name === name)
};

describe("sub-agent tool registry", () => {
  it("never offers a resource change, an export, the reserved report or a sub-agent tool, and keeps load_skill", () => {
    const registry = subagentToolRegistry(parent, null);
    const names = registry.definitions().map((definition) => definition.name);
    for (const excluded of ["manage_proxy", "manage_secret", "manage_skill", "save_skill", "manage_assistant", "create_artifact", "create_scheduled_task",
      "manage_scheduled_task", "report_monitoring_result", "checkpoint_outputs", callSubagentTool.name, stopSubagentTool.name]) {
      expect(names).not.toContain(excluded);
      // A call of one is an unknown tool: refused before anything is recorded as sent.
      expect(registry.resolve(excluded)).toBeUndefined();
    }
    expect(names).toEqual(expect.arrayContaining(["load_skill", "read_skill_file", "read_secret", "update_plan", "read_tool_result",
      "read_aiqsa_guide", "fetch_url", "search_selected_engines", "mcp_jira_create_issue", "find_tools", "mcp_workspace__sandbox_exec",
      "apply_patch", "browser_handoff", "memory_search", "generate_image", "analyze_image"]));
    expect(registry.mcpLoadCall?.("mcp_jira_create_issue", "c1")).toMatchObject({ name: "find_tools" });
  });

  it("narrows to a custom sub-agent's groups and always keeps the plan, saved results and the guide", () => {
    const registry = subagentToolRegistry(parent, [SUBAGENT_TOOL_GROUPS.web_search, SUBAGENT_TOOL_GROUPS.web_fetch]);
    expect(registry.definitions().map((definition) => definition.name).sort()).toEqual(
      ["fetch_url", "read_aiqsa_guide", "read_tool_result", "search_selected_engines", "update_plan"]);
    expect(registry.resolve("load_skill")).toBeUndefined();
    expect(registry.mcpLoadCall).toBeUndefined();
    const workspace = subagentToolRegistry(parent, [SUBAGENT_TOOL_GROUPS.workspace]).definitions().map((definition) => definition.name);
    expect(workspace).toEqual(expect.arrayContaining(["mcp_workspace__sandbox_exec", "apply_patch", "browser_handoff"]));
    expect(workspace).not.toContain("checkpoint_outputs");
  });

  describe("and research", () => {
    const researchTools = [...tools, tool(RECORD_EVIDENCE_TOOL_NAME, "session"), tool(CHANGE_RESEARCH_FRAME_TOOL_NAME, "session")];
    const research: ToolRegistry = { definitions: () => researchTools.map((entry) => entry.definition), resolve: (name) => researchTools.find((entry) => entry.definition.name === name) };
    const narrowed = [SUBAGENT_TOOL_GROUPS.web_search];
    const bookkeeping = [CHANGE_RESEARCH_FRAME_TOOL_NAME, RECORD_EVIDENCE_TOOL_NAME];

    it("keeps a researcher's bookkeeping whatever its groups, and widens the session capability for nothing else", () => {
      const registry = subagentToolRegistry(research, narrowed);
      expect(registry.definitions().map((definition) => definition.name).sort()).toEqual([...bookkeeping, "read_aiqsa_guide", "read_tool_result", "search_selected_engines", "update_plan"].sort());
      expect(registry.resolve(RECORD_EVIDENCE_TOOL_NAME)).toBeDefined();
      expect(registry.resolve(CHANGE_RESEARCH_FRAME_TOOL_NAME)).toBeDefined();
      expect(subagentToolRegistry(research, []).definitions().map((definition) => definition.name)).toEqual(expect.arrayContaining(bookkeeping));
      expect(registry.resolve("read_secret")).toBeUndefined();
    });

    it("gives a researcher narrowed to web tools no browser, so it records an unreachable site at once (operator decision 2026-11-05)", async () => {
      const record = vi.fn(async () => ({ kind: "recorded" as const, record: { id: "record-1", kind: "unreachable", quoteCheck: null } as unknown as ResearchEvidenceRecord }));
      const browsed = vi.fn(async () => false);
      const recorder = recordEvidenceEngineTool({ coverage: { frame: async () => null }, evidence: { browsed, page: async () => null, record }, researching: () => true },
        { kind: "subagent", name: "lab", threadId: "thread-lab" }, { browser: () => true });
      const offered = [tool(namespacedWorkspaceToolName("sandbox_exec"), "workspace"), tool("fetch_url", "web_fetch"), recorder];
      const withBrowser: ToolRegistry = { definitions: () => offered.map((entry) => entry.definition), resolve: (name) => offered.find((entry) => entry.definition.name === name) };
      const unreachable = { claim: null, criterion_key: null, dataset: null, kind: "unreachable", quote: null, reason: "Blocked.", row_key: null, source_class: null,
        standing: null, supersedes: null, target: "shop.example", url: null };
      const recordIn = (registry: ToolRegistry) => registry.resolve(RECORD_EVIDENCE_TOOL_NAME)!.execute({ call: { arguments: unreachable, id: "call", name: RECORD_EVIDENCE_TOOL_NAME },
        ordinal: 0, persistedToolCallId: "row", round: 1, signal: new AbortController().signal });
      const web = subagentToolRegistry(withBrowser, [SUBAGENT_TOOL_GROUPS.web_search, SUBAGENT_TOOL_GROUPS.web_fetch]);
      expect(web.resolve(RECORD_EVIDENCE_TOOL_NAME)).toBe(web.resolve(RECORD_EVIDENCE_TOOL_NAME));
      expect((await recordIn(web)).status).toBe("complete");
      expect(browsed).not.toHaveBeenCalled();
      for (const groups of [[SUBAGENT_TOOL_GROUPS.workspace], null]) expect((await recordIn(subagentToolRegistry(withBrowser, groups))).status).toBe("error");
      expect(browsed).toHaveBeenCalledTimes(2);
      expect(record).toHaveBeenCalledOnce();
    });

    it("offers it to no run that does not bind it", () => {
      expect(subagentToolRegistry(parent, narrowed).definitions().map((definition) => definition.name)).not.toContain(RECORD_EVIDENCE_TOOL_NAME);
    });

    it("leaves it out of a gate's turn, whatever its groups, as an unknown tool, and takes nothing else", () => {
      const gate = withoutResearchBookkeeping(research);
      for (const name of bookkeeping) expect(gate.resolve(name)).toBeUndefined();
      const offered = subagentToolRegistry(gate, narrowed);
      expect(offered.definitions().map((definition) => definition.name).sort()).toEqual(["read_aiqsa_guide", "read_tool_result", "search_selected_engines", "update_plan"]);
      for (const name of bookkeeping) expect(offered.resolve(name)).toBeUndefined();
      expect(gate.resolve("fetch_url")).toBeDefined();
    });
  });
});
