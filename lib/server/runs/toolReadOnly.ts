import { MCP_FIND_TOOLS_NAME } from "../mcp/discovery";
import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { MEMORY_SEARCH_TOOL_NAME } from "../memory/search/contract";
import { ANALYZE_IMAGE_TOOL_NAME } from "../tools/analyzeImage";
import { READ_ARTIFACT_TOOL_NAME } from "../tools/artifact";
import { FETCH_URL_TOOL_NAME } from "../tools/fetchUrlPlan";
import { CREATE_SCHEDULED_TASK_TOOL_NAME } from "../tools/scheduledTaskCreation";
import { MANAGE_SCHEDULED_TASK_TOOL_NAME } from "../tools/scheduledTaskManagement";
import type { RunTool } from "../tools/types";
import { VIEW_WORKSPACE_IMAGE } from "../tools/viewWorkspaceImage";

/** Run tools that only read: their calls cannot change what another call returns. */
const READ_ONLY_CAPABILITIES = new Set<RunTool["capability"]>(["knowledge", "session", "skill", "web_search"]);
/** A page read (`fetch_url`) is a GET of a page the user or Search supplied; it changes no AIQSA state. */
const READ_ONLY_NAMES = new Set([ANALYZE_IMAGE_TOOL_NAME, FETCH_URL_TOOL_NAME, MCP_FIND_TOOLS_NAME, MEMORY_SEARCH_TOOL_NAME,
  READ_ARTIFACT_TOOL_NAME, VIEW_WORKSPACE_IMAGE]);
/** Server-owned (`session`) tools that write: a created or managed scheduled task. */
const WRITING_NAMES = new Set([CREATE_SCHEDULED_TASK_TOOL_NAME, MANAGE_SCHEDULED_TASK_TOOL_NAME]);

/**
 * Whether a call of this run's tool is proven read-only. Workspace commands,
 * artifact and image writes, checkpoints, scheduled task tools and MCP
 * tools without the server's `readOnlyHint` may change state and are never
 * treated as read-only.
 */
export function readOnlyRunTool(input: Readonly<{ mcp?: McpRunPlanSnapshot | null; tools: readonly RunTool[] }>) {
  const mcpReadOnly = new Set((input.mcp?.tools ?? [])
    .filter(tool => tool.annotations?.readOnlyHint === true).map(tool => tool.namespacedName));
  const capabilities = new Map(input.tools.map(tool => [tool.name, tool.capability]));
  return (toolName: string): boolean => !WRITING_NAMES.has(toolName) && (READ_ONLY_NAMES.has(toolName) ||
    mcpReadOnly.has(toolName) || READ_ONLY_CAPABILITIES.has(capabilities.get(toolName)!));
}
