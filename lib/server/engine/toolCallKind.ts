import type { ToolCallKind } from "../observability";
import { ANALYZE_IMAGE_TOOL_NAME } from "../tools/analyzeImage";
import { RECORD_REVIEW_DECISIONS_TOOL_NAME, SUBMIT_ANSWER_REVIEW_TOOL_NAME } from "../tools/answerReview";
import { MONITORING_VERDICT_TOOL_NAME } from "../tools/monitoringVerdict";
import { CREATE_SCHEDULED_TASK_TOOL_NAME } from "../tools/scheduledTaskCreation";
import { MANAGE_SCHEDULED_TASK_TOOL_NAME } from "../tools/scheduledTaskManagement";
import { SAVE_SKILL_TOOL_NAME } from "../tools/skillSave";
import type { RunTool, RunToolCapability } from "../tools/types";

/** The family of each tool capability; `session` tools are named one by one or are `other`. */
const CAPABILITY_KINDS: Readonly<Record<RunToolCapability, ToolCallKind>> = {
  artifact: "artifact", image: "image_generation", mcp: "mcp", memory: "memory", session: "other", skill: "skill",
  vision: "vision", web_fetch: "fetch_url", web_search: "search", workspace: "workspace"
};

const NAMED_KINDS: ReadonlyMap<string, ToolCallKind> = new Map([
  [ANALYZE_IMAGE_TOOL_NAME, "vision"],
  [CREATE_SCHEDULED_TASK_TOOL_NAME, "scheduled_task"],
  [MANAGE_SCHEDULED_TASK_TOOL_NAME, "scheduled_task"],
  [MONITORING_VERDICT_TOOL_NAME, "monitoring"],
  [RECORD_REVIEW_DECISIONS_TOOL_NAME, "answer_review"],
  [SAVE_SKILL_TOOL_NAME, "skill"],
  [SUBMIT_ANSWER_REVIEW_TOOL_NAME, "answer_review"]
]);

/**
 * The content-free family of one model tool call, from the tool the run's
 * registry resolved for it: a registered tool is one its run admitted, so its
 * name and capability decide. A call no tool answers is `other`, and so are
 * the harness and self-service tools. Names never leave here.
 */
export function engineToolCallKind(definition: RunTool | undefined): ToolCallKind {
  if (!definition) return "other";
  // MCP tool names are the servers' own; only built-in names are matched.
  if (definition.capability === "mcp") return "mcp";
  return NAMED_KINDS.get(definition.name) ?? CAPABILITY_KINDS[definition.capability] ?? "other";
}
