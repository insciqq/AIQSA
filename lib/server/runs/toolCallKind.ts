import type { ToolCallKind, ToolKind } from "../observability";
import type { NormalizedRunRequest } from "../providers/types";
import { MEMORY_SEARCH_TOOL_NAME } from "../memory/search/contract";
import { ANALYZE_IMAGE_TOOL_NAME } from "../tools/analyzeImage";
import { isAnswerReviewCall } from "../tools/answerReview";
import { ARTIFACT_TOOL_NAME, READ_ARTIFACT_TOOL_NAME } from "../tools/artifact";
import { CHECKPOINT_OUTPUTS_TOOL_NAME } from "../tools/checkpointOutputs";
import { isFetchUrlCall } from "../tools/fetchUrlPlan";
import { IMAGE_GENERATION_TOOL_NAME } from "../tools/imageGeneration";
import { isMonitoringVerdictCall } from "../tools/monitoringVerdict";
import { READ_TOOL_RESULT_NAME } from "../tools/readToolResult";
import { isScheduledTaskCreateCall } from "../tools/scheduledTaskCreation";
import { isScheduledTaskManageCall } from "../tools/scheduledTaskManagement";
import { SESSION_STATUS_TOOL_NAME } from "../tools/sessionStatus";
import { acceptsSkillTool } from "../tools/skill";
import { isSkillSaveCall } from "../tools/skillSave";
import { VIEW_WORKSPACE_IMAGE } from "../tools/viewWorkspaceImage";
import { READ_TOOL_CALL_NAME } from "./toolHistoryContract";

/** The accepted run's markers that admit its built-in tools. */
export type ToolCallKindRequest = Pick<NormalizedRunRequest,
  | "answerReviewStep" | "artifactReferences" | "artifactTool" | "fetchUrl" | "imagePlan" | "memorySearch" | "monitoringVerdictTool"
  | "scheduledTaskManagementTool" | "scheduledTaskTool" | "sessionStatusTool" | "skillSaveTool" | "skills"
  | "toolCallReader" | "toolObservationVersion" | "visionAnalysis" | "workspace" | "workspaceCheckpoints"
  | "workspaceImageView">;

/** The run's live routes of the families whose names are not fixed. */
export type ToolCallRoutes = Readonly<{
  knowledge(name: string): boolean;
  /** MCP tool search or a tool of the run's current MCP snapshot. */
  mcp(name: string): boolean;
  search(name: string): boolean;
  workspace(name: string): boolean;
}>;

/** The family whose executors report their own `tool_execution` stages. */
export function toolExecutionKind(name: string, routes: ToolCallRoutes): ToolKind | undefined {
  return routes.search(name) ? "search"
    : routes.knowledge(name) ? "knowledge"
    : routes.workspace(name) ? "workspace"
    : routes.mcp(name) ? "mcp" : undefined;
}

/**
 * The content-free family of one model tool call, shared by execution and
 * recovery. Built-in tools count only as the run admitted them; a name the
 * run did not admit, or a tool added later, is `other`. Names never leave here.
 */
export function toolCallKind(request: ToolCallKindRequest, name: string, routes: ToolCallRoutes): ToolCallKind {
  if (isFetchUrlCall(request, name)) return "fetch_url";
  if (isScheduledTaskCreateCall(request, name) || isScheduledTaskManageCall(request, name)) return "scheduled_task";
  if (isSkillSaveCall(request, name) || acceptsSkillTool(request, name)) return "skill";
  if (request.artifactTool === true && (name === ARTIFACT_TOOL_NAME ||
    name === READ_ARTIFACT_TOOL_NAME && Boolean(request.artifactReferences?.length))) return "artifact";
  if (request.imagePlan && name === IMAGE_GENERATION_TOOL_NAME) return "image_generation";
  if (request.visionAnalysis && name === ANALYZE_IMAGE_TOOL_NAME) return "vision";
  if (request.workspaceImageView === true && name === VIEW_WORKSPACE_IMAGE) return "workspace_image";
  if (request.workspaceCheckpoints === true && name === CHECKPOINT_OUTPUTS_TOOL_NAME) return "workspace";
  if (request.sessionStatusTool === true && name === SESSION_STATUS_TOOL_NAME) return "session_status";
  if (request.memorySearch && name === MEMORY_SEARCH_TOOL_NAME) return "memory";
  if (request.toolObservationVersion === 1 && name === READ_TOOL_RESULT_NAME ||
    request.toolCallReader === true && name === READ_TOOL_CALL_NAME) return "tool_history";
  if (isMonitoringVerdictCall(request, name)) return "monitoring";
  if (isAnswerReviewCall(request, name)) return "answer_review";
  return toolExecutionKind(name, routes) ?? "other";
}
