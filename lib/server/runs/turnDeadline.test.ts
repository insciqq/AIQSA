import { describe, expect, it } from "vitest";
import { MCP_RUNTIME_TIMEOUT_LIMITS } from "../../contracts/mcp";
import type { McpDiscoveryState, McpRunPlanSnapshot } from "../mcp/runPlan";
import type { NormalizedRunRequest, NormalizedSearchPlanOption } from "../providers/types";
import { ANALYZE_IMAGE_TOOL_NAME } from "../tools/analyzeImage";
import { IMAGE_GENERATION_TOOL_NAME } from "../tools/imageGeneration";
import { getWorkspaceConfig } from "../workspace/config";
import { toolCallBounds, turnSoftDeadlineMs } from "./turnDeadline";

type Frozen = Parameters<typeof toolCallBounds>[0];
const bare: Frozen = { searchPlan: { mode: "all_selected", options: [] } };
const timeouts = (callTimeoutMs: number) => ({ callTimeoutMs, startupTimeoutMs: 60_000 });
const mcpTool = (namespacedName: string, serverId: string) => ({ definitionHash: "a".repeat(64), description: null,
  inputSchema: { type: "object" }, name: namespacedName, namespacedName, originalName: namespacedName, serverId, serverName: serverId });
// Jira keeps MCP's default call timeout; Export has a ten-minute one of its own.
const loaded = (exportTimeoutMs: number): McpRunPlanSnapshot => ({ servers: [
  { fingerprint: "fp-1", revisionId: "rev-1", serverId: "jira", serverName: "Jira" },
  { fingerprint: "fp-2", revisionId: "rev-2", serverId: "export", serverName: "Export", runtimeTimeouts: timeouts(exportTimeoutMs) }
], tools: [mcpTool("mcp_jira_get_issue", "jira"), mcpTool("mcp_export_run", "export")], version: 1 } as McpRunPlanSnapshot);
// An Auto catalog server the run may load with find_tools: twenty minutes.
const catalog: McpDiscoveryState = { catalog: { servers: [{ description: "", namespace: "wiki", revisionId: "rev-3", serverId: "wiki",
  serverName: "Wiki", runtimeTimeouts: timeouts(1_200_000),
  tools: [{ description: null, namespacedName: "mcp_wiki_search", originalName: "search" }] }], version: 1 }, epochs: [], version: 2 };
const source = (timeoutMs: number) => ({ adapterKind: "provider_model_client", config: { timeoutMs } }) as unknown as
  NormalizedSearchPlanOption;
const imagePlan = (responseTimeoutMs: number) => ({ snapshot: { connection: { responseTimeoutMs }, model: { adapterKind: "openai" } } }) as
  unknown as NonNullable<NormalizedRunRequest["imagePlan"]>;
// A reasoning System Vision model: its wait is the 300 s reasoning bound, under the connection's ten minutes.
const vision = { available: true, reasoningEffort: "high", snapshot: { connection: { responseTimeoutMs: 600_000 },
  model: { adapterKind: "openai", capabilities: { reasoning: true }, defaultParams: {} } } } as unknown as
  NonNullable<NormalizedRunRequest["visionAnalysis"]>;
// The answer model's own response timeout: the 300 s provider default.
const ANSWER_MS = 300_000;

describe("turn deadlines", () => {
  it("lets a default turn work for 49 of its 60 minutes before it must answer, with or without a Workspace", () => {
    const config = getWorkspaceConfig({});
    const workspace = { syncToolTimeoutSeconds: config.syncToolTimeoutSeconds } as NormalizedRunRequest["workspace"];
    const bounds = toolCallBounds(bare, ANSWER_MS);
    expect(bounds).toMatchObject({ answer: ANSWER_MS, round: MCP_RUNTIME_TIMEOUT_LIMITS.defaultCallMs });
    // A 300 s call or a round under way at the tool time, then a 300 s answer and the minute's handoff: 660 s.
    expect(turnSoftDeadlineMs(3_600_000, bounds.round, bounds.answer)).toBe(2_940_000);
    const withWorkspace = toolCallBounds({ ...bare, workspace }, ANSWER_MS);
    expect(turnSoftDeadlineMs(config.turnTimeoutSeconds * 1_000, withWorkspace.round, withWorkspace.answer)).toBe(2_940_000);
  });

  it("leaves room for a round under way when the answer model may take longer than a call", () => {
    // A model allowed ten minutes a request: a round started just before the tool time, then the answer.
    const bounds = toolCallBounds(bare, 600_000);
    expect(bounds.round).toBe(600_000);
    expect(turnSoftDeadlineMs(3_600_000, bounds.round, bounds.answer)).toBe(2_340_000);
  });

  it("follows the turn and keeps half of a short one for work", () => {
    // A scheduled run's 30-minute occurrence answers from 19 minutes.
    expect(turnSoftDeadlineMs(1_800_000, 300_000, ANSWER_MS)).toBe(1_140_000);
    expect(turnSoftDeadlineMs(7_200_000, 300_000, ANSWER_MS)).toBe(6_540_000);
    expect(turnSoftDeadlineMs(300_000, 300_000, ANSWER_MS)).toBe(150_000);
    expect(turnSoftDeadlineMs(3_600_000, 2_147_483_647, ANSWER_MS)).toBe(1_800_000);
  });

  it("bounds each call by its own tool's frozen timeout, and slow sources never move the rounds' tool time", () => {
    const bounds = toolCallBounds({ imagePlan: imagePlan(86_400_000), mcp: loaded(600_000), mcpDiscovery: catalog,
      searchPlan: { mode: "all_selected", options: [source(120_000), source(900_000)] }, visionAnalysis: vision,
      workspace: { syncToolTimeoutSeconds: 120 } as NormalizedRunRequest["workspace"] }, ANSWER_MS);
    expect(bounds.call({ capability: "mcp", name: "mcp_jira_get_issue" })).toBe(300_000);
    expect(bounds.call({ capability: "mcp", name: "mcp_export_run" })).toBe(600_000);
    expect(bounds.call({ capability: "mcp", name: "mcp_wiki_search" })).toBe(1_200_000);
    expect(bounds.call({ capability: "mcp", name: "find_tools" })).toBe(300_000);
    expect(bounds.call({ capability: "web_search", name: "search_selected_engines" })).toBe(900_000);
    expect(bounds.call({ capability: "workspace", name: "workspace_exec" })).toBe(120_000);
    expect(bounds.call({ capability: "workspace", name: ANALYZE_IMAGE_TOOL_NAME })).toBe(300_000);
    expect(bounds.call({ capability: "image", name: IMAGE_GENERATION_TOOL_NAME })).toBe(86_400_000);
    expect(bounds.call({ capability: "session", name: "read_tool_result" })).toBe(300_000);
    expect(bounds.round).toBe(300_000);
    // An hour's turn: a ten-minute call may start until 44 minutes, a 24-hour image wait in the turn's first half.
    expect(turnSoftDeadlineMs(3_600_000, bounds.call({ capability: "mcp", name: "mcp_export_run" }), bounds.answer)).toBe(2_640_000);
    expect(turnSoftDeadlineMs(3_600_000, bounds.call({ capability: "image", name: IMAGE_GENERATION_TOOL_NAME }), bounds.answer))
      .toBe(1_800_000);
  });

  it("bounds a search tool by its own sources when each source has a tool", () => {
    const bounds = toolCallBounds({ searchPlan: { mode: "model_choice", options: [source(120_000), source(900_000)] } }, ANSWER_MS);
    expect(bounds.call({ capability: "web_search", name: "search_engine_1" })).toBe(120_000);
    expect(bounds.call({ capability: "web_search", name: "search_engine_2" })).toBe(900_000);
  });

  it("counts a malformed frozen bound as MCP's default", () => {
    const bounds = toolCallBounds({ ...bare, imagePlan: imagePlan(Number.NaN), mcp: loaded(Number.NaN) }, Number.NaN);
    expect(bounds.call({ capability: "mcp", name: "mcp_export_run" })).toBe(300_000);
    expect(bounds.call({ capability: "image", name: IMAGE_GENERATION_TOOL_NAME })).toBe(300_000);
    expect(bounds.answer).toBe(300_000);
  });
});
