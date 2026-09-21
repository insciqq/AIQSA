import { skillWorkspacePath } from "../../domain/skillBundlePaths";
import type { NormalizedRunRequest } from "../providers/types";
import { LOAD_SKILL_TOOL_NAME, READ_SKILL_FILE_TOOL_NAME, skillToolError } from "../tools/skill";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import type { WorkspaceCoordinator, WorkspaceActivityListener } from "../workspace/coordinator";
import { SkillBundleError } from "./bundleErrors";

/** Called only after result-budget acceptance and before durable settlement.
 * An oversized result must never create files or a loaded binding. */
export async function deliverSkillWorkspaceBundle(input: Readonly<{
  call: ModelToolCall;
  result: ToolExecutionResult;
  request: NormalizedRunRequest;
  coordinator?: WorkspaceCoordinator;
  runId: string;
  userId: string;
  signal: AbortSignal;
  onActivity?: WorkspaceActivityListener;
}>): Promise<ToolExecutionResult> {
  const { call, result, request } = input;
  if (!request.workspace?.enabled) return result;
  const first = result.content[0];
  const value = first?.type === "json" && first.value && typeof first.value === "object" && !Array.isArray(first.value)
    ? first.value as Record<string, unknown> : null;
  const loading = call.name === LOAD_SKILL_TOOL_NAME && result.status === "complete";
  const binary = call.name === READ_SKILL_FILE_TOOL_NAME && result.status === "error" && value?.error === "skill_file_binary";
  if (!loading && !binary) return result;
  const alias = typeof call.arguments.skill === "string" ? call.arguments.skill : "";
  const expected = skillWorkspacePath(alias);
  if (!expected || !value || (loading ? value.workspacePath !== expected
    : typeof call.arguments.path !== "string" || value.workspacePath !== `${expected}/${call.arguments.path}`)) {
    return skillToolError(call, "skill_workspace_unavailable");
  }
  try {
    input.signal.throwIfAborted();
    if (!input.coordinator?.skillBundlePath) return skillToolError(call, "skill_workspace_unavailable");
    const path = await input.coordinator.skillBundlePath({ alias, install: loading, runId: input.runId,
      userId: input.userId, workspace: request.workspace, signal: input.signal, onActivity: input.onActivity });
    input.signal.throwIfAborted();
    return path === expected ? result : skillToolError(call, "skill_workspace_unavailable");
  } catch (error) {
    input.signal.throwIfAborted();
    return skillToolError(call, error instanceof SkillBundleError && error.issue.code === "skill_not_available"
      ? "skill_not_available" : "skill_workspace_unavailable");
  }
}
