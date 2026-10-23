import { describe, expect, it } from "vitest";
import { MCP_FIND_TOOLS_NAME } from "../mcp/discovery";
import type { RunTool, RunToolCapability } from "../tools/types";
import { engineToolCallKind } from "./toolCallKind";

const tool = (name: string, capability: RunToolCapability): RunTool => ({ capability, description: "", inputSchema: {}, name });

describe("engine tool call family", () => {
  it.each([
    ["fetch_url", "web_fetch", "fetch_url"], ["create_scheduled_task", "session", "scheduled_task"],
    ["manage_scheduled_task", "session", "scheduled_task"], ["save_skill", "session", "skill"], ["load_skill", "skill", "skill"],
    ["manage_skill", "skill", "skill"], ["create_artifact", "artifact", "artifact"], ["read_artifact", "artifact", "artifact"],
    ["generate_image", "image", "image_generation"], ["analyze_image", "workspace", "vision"], ["analyze_image", "vision", "vision"],
    ["checkpoint_outputs", "workspace", "workspace"], ["workspace_exec", "workspace", "workspace"], ["apply_patch", "workspace", "workspace"],
    ["memory_search", "memory", "memory"], ["report_monitoring_result", "session", "monitoring"],
    ["submit_answer_review", "session", "answer_review"], ["record_review_decisions", "session", "answer_review"],
    ["web_search", "web_search", "search"], [MCP_FIND_TOOLS_NAME, "mcp", "mcp"],
    ["read_tool_result", "session", "other"], ["update_plan", "session", "other"], ["read_secret", "session", "other"]
  ] as const)("maps %s (%s) to %s", (name, capability, kind) => {
    expect(engineToolCallKind(tool(name, capability))).toBe(kind);
  });

  it("keeps an MCP tool named like a built-in one MCP, and a call no tool answers other", () => {
    expect(engineToolCallKind(tool("report_monitoring_result", "mcp"))).toBe("mcp");
    expect(engineToolCallKind(undefined)).toBe("other");
  });
});
