import type { ThreadWorkspaceActivityCodeMcp } from "@/lib/contracts/workspace";

/** Grouped receipts of one sandbox command's code calls. */
export type WorkspaceCodeCallGroup = Readonly<{
  count: number;
  errorCode: string | null;
  state: string;
  toolName: string;
}>;

export type WorkspaceCodeToolLabel = Readonly<{ serverName?: string; toolName: string }>;

/** Content-free: tool identities, counts and stable error codes; never arguments or results. */
export type WorkspaceCodeCallSummary = Readonly<{
  calls: number;
  failed: number;
  refused: number;
  tools: readonly Readonly<{
    calls: number;
    errorCodes: readonly string[];
    failed: number;
    label: WorkspaceCodeToolLabel;
    unknown: number;
  }>[];
  unknown: number;
}>;

/** Model line and activity name at most this many tools; the rest are counted. */
const LISTED_TOOLS = 8;
const LISTED_ERROR_CODES = 2;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/u;

export function summarizeWorkspaceCodeCalls(
  groups: readonly WorkspaceCodeCallGroup[],
  refused: number,
  labels: ReadonlyMap<string, WorkspaceCodeToolLabel>
): WorkspaceCodeCallSummary | null {
  const byTool = new Map<string, { calls: number; errorCodes: Set<string>; failed: number; unknown: number }>();
  for (const group of groups) {
    const tool = byTool.get(group.toolName) ?? { calls: 0, errorCodes: new Set<string>(), failed: 0, unknown: 0 };
    tool.calls += group.count;
    if (group.state === "error") {
      tool.failed += group.count;
      if (group.errorCode && ERROR_CODE.test(group.errorCode)) tool.errorCodes.add(group.errorCode);
    } else if (group.state === "unknown") tool.unknown += group.count;
    byTool.set(group.toolName, tool);
  }
  const tools = [...byTool.entries()]
    .map(([toolName, tool]) => ({
      calls: tool.calls, errorCodes: [...tool.errorCodes].sort().slice(0, LISTED_ERROR_CODES), failed: tool.failed,
      label: labels.get(toolName) ?? { toolName }, unknown: tool.unknown
    }))
    .sort((left, right) => right.calls - left.calls || toolText(left.label).localeCompare(toolText(right.label)));
  const calls = tools.reduce((sum, tool) => sum + tool.calls, 0);
  if (calls === 0 && refused <= 0) return null;
  return {
    calls, failed: tools.reduce((sum, tool) => sum + tool.failed, 0), refused: Math.max(0, refused), tools,
    unknown: tools.reduce((sum, tool) => sum + tool.unknown, 0)
  };
}

function toolText(label: WorkspaceCodeToolLabel): string {
  return label.serverName ? `${label.serverName}.${label.toolName}` : label.toolName;
}

/**
 * The compact line appended to the enclosing sandbox tool result, for
 * example `code made 37 MCP calls: GitLab.list_commits ×35,
 * GitLab.get_job_log ×2 (1 failed: upstream_unavailable)`.
 */
export function workspaceCodeCallSummaryLine(summary: WorkspaceCodeCallSummary): string {
  const listed = summary.tools.slice(0, LISTED_TOOLS).map((tool) => {
    const notes = [
      ...(tool.failed ? [`${tool.failed} failed${tool.errorCodes.length ? `: ${tool.errorCodes.join(", ")}` : ""}`] : []),
      ...(tool.unknown ? [`${tool.unknown} outcome unknown, do not repeat writes`] : [])
    ];
    return `${toolText(tool.label)} ×${tool.calls}${notes.length ? ` (${notes.join("; ")})` : ""}`;
  });
  const hidden = summary.tools.length - listed.length;
  const made = summary.calls === 0 ? "code made no MCP calls"
    : `code made ${summary.calls} MCP call${summary.calls === 1 ? "" : "s"}: ${listed.join(", ")}` +
      (hidden > 0 ? `, +${hidden} more tool${hidden === 1 ? "" : "s"}` : "");
  return summary.refused > 0
    ? `${made}; ${summary.refused} more refused: the run's code MCP call budget is exhausted`
    : made;
}

/** Client-safe activity fact; the browser owns its wording. */
export function workspaceCodeCallActivity(summary: WorkspaceCodeCallSummary): ThreadWorkspaceActivityCodeMcp {
  return {
    calls: summary.calls,
    failed: summary.failed + summary.unknown,
    ...(summary.refused > 0 ? { refused: summary.refused } : {}),
    tools: summary.tools.slice(0, LISTED_TOOLS).map((tool) => ({
      calls: tool.calls,
      failed: tool.failed + tool.unknown,
      ...(tool.label.serverName ? { serverName: tool.label.serverName } : {}),
      toolName: tool.label.toolName
    }))
  };
}
