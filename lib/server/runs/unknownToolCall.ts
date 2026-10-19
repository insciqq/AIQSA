import type { McpRunPlanSnapshot } from "../mcp/runPlan";
import { normalizeWorkspaceProviderToolName } from "../workspace/toolCatalog";
import type { PersistedToolLoopCall, ToolLoopJsonValue } from "./toolLoopPersistence";

/**
 * Calls of a tool their round did not declare. Models sometimes name a
 * declared tool inexactly: a bare MCP name, a truncated or corrupted alias,
 * leaked native tool markup. An exact, unambiguous alias stands for the one
 * declared tool it names (`normalizeProviderToolCallName`); any other name is
 * unknown. Such a call never executes: it is persisted already settled as an
 * undispatched `tool_call_unknown` error (no claim, approval, receipt or
 * observation), its batch's declared calls proceed, and the model reads the
 * error in its next round. Live execution and recovery derive every decision
 * from these functions and the persisted rows.
 */
export const TOOL_CALL_UNKNOWN = "tool_call_unknown";
export const UNKNOWN_TOOL_CALL_MESSAGE =
  "This tool does not exist in this step, so nothing was executed. Call one of the declared tools by its exact name.";

/** What every provider accepts as a function name. */
const VALID_TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/u;
/** The name an unknown call keeps when the requested one is no valid tool
 * name. No first-party tool is called so, and MCP names are namespaced. */
export const INVALID_TOOL_NAME = "invalid_tool_name";
const REQUESTED_NAME_CHARACTERS = 80;

type UnknownRow = Pick<PersistedToolLoopCall, "providerCallId" | "result" | "startedAt" | "state" | "toolName">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The name an unknown call keeps in its round's transcript, its row and its
 * result: the requested one when it is a valid tool name (undeclared, so it
 * names no declared tool), else `invalid_tool_name`. A blank name stays blank:
 * a call without a name is a protocol failure, not a correctable one.
 */
export function unknownToolCallName(requested: string): string {
  return !requested.trim() || VALID_TOOL_NAME.test(requested) ? requested : INVALID_TOOL_NAME;
}

/** The requested name as its result shows the model: letters, digits and
 * `_.:-` (any other run, markup included, reads `?`), at most 80 characters. */
export function requestedToolNameExcerpt(requested: string): string {
  const characters = [...requested.replace(/[^\p{L}\p{N}_.:-]+/gu, "?")];
  return characters.length > REQUESTED_NAME_CHARACTERS
    ? `${characters.slice(0, REQUESTED_NAME_CHARACTERS).join("")}…`
    : characters.join("");
}

/** A bounded excerpt as `requestedToolNameExcerpt` produces one. */
export function validRequestedToolName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= REQUESTED_NAME_CHARACTERS + 1 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

/** The persisted result of an unknown call: no dispatch, no receipt, no observation. */
export function unknownToolCallResult(input: Readonly<{
  providerCallId: string;
  requested: string;
  toolName: string;
}>): ToolLoopJsonValue {
  return {
    callId: input.providerCallId,
    name: input.toolName,
    status: "error",
    content: [{ type: "json", value: { error: TOOL_CALL_UNKNOWN, message: UNKNOWN_TOOL_CALL_MESSAGE, requested: input.requested } }]
  };
}

/**
 * Only the server's own whole combination is an unknown call: an error row
 * that never started, under its bounded name, whose result is exactly the
 * unknown form. Tool content naming the code is never one.
 */
export function unknownToolCall(row: UnknownRow): Readonly<{ requested: string }> | null {
  const result = row.result;
  if (row.state !== "error" || row.startedAt !== null || unknownToolCallName(row.toolName) !== row.toolName ||
    !isRecord(result) || Object.keys(result).sort().join(",") !== "callId,content,name,status" ||
    result.callId !== row.providerCallId || result.name !== row.toolName || result.status !== "error" ||
    !Array.isArray(result.content) || result.content.length !== 1) return null;
  const part = result.content[0];
  if (!isRecord(part) || Object.keys(part).sort().join(",") !== "type,value" || part.type !== "json" ||
    !isRecord(part.value) || Object.keys(part.value).sort().join(",") !== "error,message,requested" ||
    part.value.error !== TOOL_CALL_UNKNOWN || part.value.message !== UNKNOWN_TOOL_CALL_MESSAGE ||
    !validRequestedToolName(part.value.requested)) return null;
  return { requested: part.value.requested };
}

/** The suffix every namespaced MCP name ends with: that tool's own hash. */
function namespacedHashSuffix(namespacedName: string): string | null {
  return /_([0-9a-f]{10})$/u.exec(namespacedName)?.[1] ?? null;
}

/**
 * The declared name a provider-requested one stands for, the one rule of live
 * execution and recovery. A declared name is itself. Otherwise the original
 * name of a Workspace tool stands for its declared alias, and a name stands
 * for a declared MCP tool only when exactly one declared MCP tool has it as
 * its original name or as `<original name>_<its own hash suffix>`. Anything
 * else (truncated or corrupted aliases, markup, another case, an original name
 * two servers share) stays as requested, an unknown call: a guess could reach
 * another server's tool that changes data.
 */
export function normalizeProviderToolCallName(
  name: string,
  declared: ReadonlySet<string>,
  run: Readonly<{ mcp: McpRunPlanSnapshot | null | undefined; workspace: boolean }>
): string {
  if (declared.has(name)) return name;
  if (run.workspace) {
    const workspaceName = normalizeWorkspaceProviderToolName(name, declared);
    if (workspaceName !== name) return workspaceName;
  }
  const matches = new Set<string>();
  for (const tool of run.mcp?.tools ?? []) {
    if (!declared.has(tool.namespacedName)) continue;
    const suffix = namespacedHashSuffix(tool.namespacedName);
    if (name === tool.originalName || suffix !== null && name === `${tool.originalName}_${suffix}`) {
      matches.add(tool.namespacedName);
    }
  }
  return matches.size === 1 ? [...matches][0]! : name;
}
