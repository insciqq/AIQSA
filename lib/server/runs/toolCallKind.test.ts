// @vitest-environment node
import { describe, expect, it } from "vitest";
import { FETCH_URL_ACTIVITY_OUTCOMES } from "@/lib/contracts/fetchUrlActivity";
import { SCHEDULED_TASK_ERROR_CODES } from "@/lib/contracts/scheduledTasks";
import observedFailureCodes from "../observability/failureCodes.json";
import { freezeSkillManifest } from "../skills/runManifest";
import { toolCallKind, toolExecutionKind, type ToolCallKindRequest, type ToolCallRoutes } from "./toolCallKind";

const MCP_NAME = "mcp_PRIVATE_SERVER_PRIVATE_TOOL_0123456789";
const routes: ToolCallRoutes = {
  search: (name) => name === "web_search",
  knowledge: (name) => name === "search_knowledge",
  workspace: (name) => name === "workspace_exec",
  mcp: (name) => name === "find_tools" || name === MCP_NAME
};
const skills = freezeSkillManifest({ mode: "auto", pinned: [], toolsSupported: true,
  available: [{ skillId: "skill-1", revisionId: "revision-1", name: "review", description: "Review", fileCount: 1 }] }).manifest;
const admitted = {
  answerReviewStep: { kind: "review", modelName: "GPT-5", reviewer: 1, round: 1, sessionId: "session-1", step: 1, version: 1 },
  artifactTool: true, artifactReferences: [{ artifactId: "artifact-1" }],
  fetchUrl: { version: 1, userUrlDigests: [] }, imagePlan: {}, memorySearch: {}, monitoringVerdictTool: true,
  scheduledTaskManagementTool: {}, scheduledTaskTool: {}, sessionStatusTool: true, skillSaveTool: true, skills,
  toolCallReader: true, toolObservationVersion: 1, visionAnalysis: {}, workspace: {}, workspaceCheckpoints: true,
  workspaceImageView: true
} as unknown as ToolCallKindRequest;

describe("tool call family", () => {
  it.each([
    ["fetch_url", "fetch_url"], ["create_scheduled_task", "scheduled_task"], ["manage_scheduled_task", "scheduled_task"],
    ["save_skill", "skill"], ["load_skill", "skill"], ["read_skill_file", "skill"], ["create_artifact", "artifact"],
    ["read_artifact", "artifact"], ["generate_image", "image_generation"], ["analyze_image", "vision"],
    ["view_workspace_image", "workspace_image"], ["checkpoint_outputs", "workspace"], ["get_session_status", "session_status"],
    ["memory_search", "memory"], ["read_tool_result", "tool_history"], ["read_tool_call", "tool_history"],
    ["report_monitoring_result", "monitoring"], ["submit_answer_review", "answer_review"], ["web_search", "search"],
    ["search_knowledge", "knowledge"], ["workspace_exec", "workspace"], ["find_tools", "mcp"], [MCP_NAME, "mcp"],
    ["PRIVATE_UNKNOWN_TOOL", "other"]
  ] as const)("maps %s to %s for an admitting run", (name, kind) => {
    expect(toolCallKind(admitted, name, routes)).toBe(kind);
  });

  it("maps a built-in name the run did not admit to other", () => {
    const bare = { workspace: undefined } as unknown as ToolCallKindRequest;
    for (const name of ["fetch_url", "create_artifact", "generate_image", "save_skill", "get_session_status",
      "report_monitoring_result", "submit_answer_review", "view_workspace_image", "memory_search"]) {
      expect(toolCallKind(bare, name, routes)).toBe("other");
    }
  });

  it("keeps the executor families' narrower kind for their own records", () => {
    expect(["web_search", "search_knowledge", "workspace_exec", MCP_NAME, "get_session_status", "checkpoint_outputs"]
      .map((name) => toolExecutionKind(name, routes))).toEqual(["search", "knowledge", "workspace", "mcp", undefined, undefined]);
  });

  it("registers every bounded refusal code of the page reader and scheduled task tools", () => {
    const registered = new Set<string>(observedFailureCodes);
    const codes = [...FETCH_URL_ACTIVITY_OUTCOMES.filter((code) => code !== "read"), ...SCHEDULED_TASK_ERROR_CODES];
    expect(codes.filter((code) => !registered.has(code))).toEqual([]);
  });
});
