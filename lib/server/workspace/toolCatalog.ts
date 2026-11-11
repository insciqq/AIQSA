import {
  WORKSPACE_MCP_NAMESPACE,
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  WORKSPACE_EXEC_SESSION_TOOL_NAMES,
  workspaceToolIsAllowed,
  type WorkspaceMcpToolName
} from "@/lib/domain/workspace";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import { namespacedMcpToolName } from "@/lib/server/mcp/runPlan";
import type { WorkspaceBoundTool, WorkspaceToolCatalog, WorkspaceToolResult } from "./runtime";

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
  "timeoutMs",
  // The pinned MCP takes any resource name, while the guest accepts only its own lowercase ones: in production 21 of
  // 22 calls naming `RLIMIT_*` failed in the guest with no cause the model could act on. `ulimit` in a shell sets the
  // same limits, and the VM's own memory and CPU stay the real bounds.
  "rlimits"
] as const);
const HIDDEN_ARGUMENT_SET = new Set<string>(HIDDEN_ARGUMENTS);
const EXEC_SESSION_TOOL_SET = new Set<WorkspaceMcpToolName>(WORKSPACE_EXEC_SESSION_TOOL_NAMES);
const MAX_CATALOG_BYTES = 256 * 1_024;

/**
 * Provider-facing guidance prepended to the official descriptions. The model
 * must not pass pipelines, operators, redirects, globs, or heredocs to direct
 * exec; that mistake produced a dev-stand failure that only sandbox_shell can
 * serve. Guidance names are rendered from the exact provider-facing aliases
 * so the prompt and tool schema share one callable vocabulary.
 */
function descriptionGuidance(
  originalName: WorkspaceMcpToolName,
  namespacedName: string
): string | undefined {
  if (originalName === "sandbox_exec") {
    return "Executes a program directly without shell parsing: `command` is the program and `args` its " +
      "arguments. Pipes, redirects, &&, ||, glob expansion, variable expansion and heredocs are not " +
      `supported here; use ${namespacedWorkspaceToolName("sandbox_shell")} for shell syntax.`;
  }
  if (originalName === "sandbox_shell") {
    return `Executes a command through a shell. Use ${namespacedName} for pipes, redirects, globbing, &&, ||, heredocs and multi-step command lines.`;
  }
  return undefined;
}

/** Canonical provider-facing catalog proven against microsandbox-mcp 0.6.16 plus the guidance above. */
export const WORKSPACE_BOUND_TOOL_CATALOG_HASH =
  "c660a566446a5bdc45ff959ff13011cda9c443e47a04879c0fe94344ab226828";

export function namespacedWorkspaceToolName(originalName: WorkspaceMcpToolName): string {
  return namespacedMcpToolName(WORKSPACE_MCP_NAMESPACE, originalName);
}

/** Resolve a provider-facing alias for an original Workspace tool name. */
export function namespacedWorkspaceToolNameFromOriginal(originalName: string): string | null {
  return workspaceToolIsAllowed(originalName)
    ? namespacedWorkspaceToolName(originalName)
    : null;
}

/**
 * Normalize a known original Workspace name only when its canonical alias is
 * advertised in this provider round. Exact advertised names always win so a
 * same-named tool from another source cannot be redirected.
 */
export function normalizeWorkspaceProviderToolName(
  name: string,
  advertisedToolNames: ReadonlySet<string>
): string {
  if (advertisedToolNames.has(name)) return name;
  const namespacedName = namespacedWorkspaceToolNameFromOriginal(name);
  return namespacedName && advertisedToolNames.has(namespacedName) ? namespacedName : name;
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
    const officialDescription = typeof official.description === "string"
      ? official.description
      : "Workspace execution tool";
    const namespacedName = namespacedWorkspaceToolName(originalName);
    const guidance = descriptionGuidance(originalName, namespacedName);
    return {
      description: (guidance ? `${guidance} ${officialDescription}` : officialDescription).slice(0, 4_096),
      inputSchema: sanitizedSchema(official),
      namespacedName,
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

/**
 * A call naming an argument the catalog hides, which a model may still send, is refused before anything starts or
 * reaches the guest, as an ordinary error the model corrects by sending the call again without it. Thrown, it would
 * read as a command whose effect is unknown, and the model could never send it again.
 */
export function workspaceHiddenArgumentRefusal(
  originalName: WorkspaceMcpToolName,
  args: Readonly<Record<string, unknown>>
): WorkspaceToolResult | null {
  const hidden = HIDDEN_ARGUMENTS.filter((key) => Object.hasOwn(args, key));
  if (hidden.length === 0) return null;
  const code = "workspace_request_invalid";
  const them = hidden.length === 1 ? "it" : "them";
  const message = `Nothing ran: ${namespacedWorkspaceToolName(originalName)} does not take ` +
    `${hidden.map((key) => `\`${key}\``).join(", ")} here. Send the call again without ${them}.` +
    (hidden.includes("rlimits")
      ? ` To limit a command's resources, run \`ulimit\` before it in ${namespacedWorkspaceToolName("sandbox_shell")}.`
      : "");
  return { content: [{ text: JSON.stringify({ error: { code, message }, ok: false }), type: "text" }], errorCode: code,
    status: "error" };
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
