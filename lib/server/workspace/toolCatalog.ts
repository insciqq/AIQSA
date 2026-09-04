import {
  WORKSPACE_MCP_NAMESPACE,
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  WORKSPACE_EXEC_SESSION_TOOL_NAMES,
  workspaceToolIsAllowed,
  type WorkspaceMcpToolName
} from "@/lib/domain/workspace";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import { namespacedMcpToolName } from "@/lib/server/mcp/runPlan";
import type { WorkspaceBoundTool, WorkspaceToolCatalog } from "./runtime";

export type OfficialWorkspaceTool = Readonly<{
  description?: string;
  inputSchema: Record<string, unknown>;
  name: string;
}>;

const HIDDEN_ARGUMENTS = Object.freeze([
  "name",
  "sandbox",
  "sandboxId",
  "sandboxName",
  "toSandbox",
  "startIfStopped",
  "keepRunning",
  "maxBytes",
  "timeout",
  "timeoutMs"
] as const);
const HIDDEN_ARGUMENT_SET = new Set<string>(HIDDEN_ARGUMENTS);
const EXEC_SESSION_TOOL_SET = new Set<WorkspaceMcpToolName>(WORKSPACE_EXEC_SESSION_TOOL_NAMES);
const MAX_CATALOG_BYTES = 256 * 1_024;

/** Canonical provider-facing catalog proven against microsandbox-mcp 0.6.16. */
export const WORKSPACE_BOUND_TOOL_CATALOG_HASH =
  "8a284439b71c1a36c2a98bd5d345c5ae64c0436975cbcabf5603c44036c5c585";

export function namespacedWorkspaceToolName(originalName: WorkspaceMcpToolName): string {
  return namespacedMcpToolName(WORKSPACE_MCP_NAMESPACE, originalName);
}

export function workspaceToolNameFromNamespaced(
  namespacedName: string
): WorkspaceMcpToolName | null {
  return WORKSPACE_MCP_TOOL_ALLOWLIST.find(
    (originalName) => namespacedWorkspaceToolName(originalName) === namespacedName
  ) ?? null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sanitizedSchema(tool: OfficialWorkspaceTool): Record<string, unknown> {
  const schema = tool.inputSchema;
  if (
    schema.type !== "object" ||
    !isRecord(schema.properties)
  ) {
    throw new Error("workspace_tool_schema_incompatible");
  }
  const required = schema.required;
  const sessionTool = workspaceToolIsAllowed(tool.name) && EXEC_SESSION_TOOL_SET.has(tool.name);
  if (
    !Array.isArray(required) ||
    required.some((key) => typeof key !== "string") ||
    (sessionTool
      ? !isRecord(schema.properties.execSessionId) || !required.includes("execSessionId")
      : !isRecord(schema.properties.name) || !required.includes("name"))
  ) {
    throw new Error("workspace_tool_schema_incompatible");
  }

  const properties = Object.fromEntries(
    Object.entries(schema.properties).filter(([key]) => !HIDDEN_ARGUMENT_SET.has(key))
  );
  return {
    ...schema,
    properties,
    required: required.filter((key): key is string =>
      typeof key === "string" && !HIDDEN_ARGUMENT_SET.has(key)
    )
  };
}

export function bindOfficialWorkspaceTools(input: Readonly<{
  mcpVersion: string;
  runtimeVersion: string;
  tools: readonly OfficialWorkspaceTool[];
}>): WorkspaceToolCatalog {
  const byName = new Map<string, OfficialWorkspaceTool>();
  for (const tool of input.tools) {
    if (byName.has(tool.name)) throw new Error("workspace_tool_catalog_duplicate");
    byName.set(tool.name, tool);
  }

  const tools: WorkspaceBoundTool[] = WORKSPACE_MCP_TOOL_ALLOWLIST.map((originalName) => {
    const official = byName.get(originalName);
    if (!official) throw new Error("workspace_tool_catalog_incomplete");
    return {
      description: typeof official.description === "string"
        ? official.description.slice(0, 4_096)
        : "Workspace execution tool",
      inputSchema: sanitizedSchema(official),
      namespacedName: namespacedWorkspaceToolName(originalName),
      originalName
    };
  });
  const hash = hashCanonicalMcpValue(tools);
  if (new TextEncoder().encode(JSON.stringify(tools)).byteLength > MAX_CATALOG_BYTES) {
    throw new Error("workspace_tool_catalog_too_large");
  }
  return {
    hash,
    mcpVersion: input.mcpVersion,
    runtimeVersion: input.runtimeVersion,
    tools
  };
}

export function injectWorkspaceToolArguments(input: Readonly<{
  arguments: Record<string, unknown>;
  originalName: WorkspaceMcpToolName;
  sandboxName: string;
}>): Record<string, unknown> {
  if (!workspaceToolIsAllowed(input.originalName)) {
    throw new Error("workspace_tool_not_allowed");
  }
  for (const key of Object.keys(input.arguments)) {
    if (HIDDEN_ARGUMENT_SET.has(key)) throw new Error("workspace_tool_identity_forbidden");
  }
  if (EXEC_SESSION_TOOL_SET.has(input.originalName)) return { ...input.arguments };
  return {
    ...input.arguments,
    name: input.sandboxName
  };
}

export function originalWorkspaceToolName(
  catalog: WorkspaceToolCatalog,
  namespacedName: string
): WorkspaceMcpToolName | null {
  return catalog.tools.find((tool) => tool.namespacedName === namespacedName)?.originalName ?? null;
}
