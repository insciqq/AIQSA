import { describe, expect, it } from "vitest";
import { WORKSPACE_MCP_TOOL_ALLOWLIST } from "../../domain/workspace";
import { MAX_SEARCH_PLAN_OPTIONS } from "../../contracts/search";
import { SUBAGENT_TOOL_NAMES } from "../../contracts/subagents";
import { namespacedWorkspaceToolName } from "../workspace/toolCatalog";
import { serializeEvent } from "./runtime.cjs";
import names from "./toolNames.json";

describe("telemetry tool identity allowlist", () => {
  it("recognizes the official Workspace aliases, Search slots and sub-agent tools", () => {
    for (const name of WORKSPACE_MCP_TOOL_ALLOWLIST) expect(names).toHaveProperty(namespacedWorkspaceToolName(name), "workspace");
    for (let ordinal = 1; ordinal <= MAX_SEARCH_PLAN_OPTIONS; ordinal += 1) expect(names).toHaveProperty(`search_engine_${ordinal}`, "search");
    for (const name of SUBAGENT_TOOL_NAMES) expect(names).toHaveProperty(name, "other");
    for (const name of Object.keys(names)) {
      expect(JSON.parse(serializeEvent("tool_call", { tool_kind: "other", outcome: "completed", tool_identity: name })!))
        .toHaveProperty("tool_identity", name);
    }
  });
});
