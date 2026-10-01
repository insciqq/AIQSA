import {
  ADMIN_MEMORY_RECENT_ACTIVITY_STAGES,
  type AdminMemoryProcessingIssue,
  type AdminMemoryStatus
} from "../contracts/adminMemory";

const stages = {
  LEARNING: "Memory is not learning new facts",
  HISTORY: "Memory history processing needs attention",
  INDEXING: "Memory indexing is degraded",
  SYNTHESIS: "Memory synthesis needs attention",
  MAINTENANCE: "Memory processing needs attention",
  DELETION: "Memory deletion needs attention",
  COMMAND: "Memory commands failed recently",
  SEARCH: "Memory search degraded recently"
} as const;

const reasons = {
  MODEL_UNAVAILABLE: "The configured model cannot currently perform this operation. Check the model, key, and verified capabilities.",
  CAPABILITY_UNAVAILABLE: "The configured model lacks a required verified capability.",
  CONFIGURATION_REQUIRED: "The current model configuration cannot run this operation.",
  PROCESSING_FAILED: "Processing failed and has not recovered.",
  OUTPUT_LIMIT: "History text remains searchable, but some summaries or context exceeded the model's output limit.",
  HISTORY_INCOMPLETE: "History text remains searchable, but some generated summaries or context could not be validated.",
  RETRYING: "Processing keeps failing and is waiting to retry.",
  STALLED: "No completed work has advanced this backlog for at least 15 minutes.",
  COMMAND_FAILED: "Some Memory changes requested in chat could not be completed in the last 24 hours. Users are not shown these failures.",
  COMMAND_UNKNOWN: "Some Memory changes requested in chat ended with an unconfirmed outcome in the last 24 hours. They are not repeated automatically.",
  SEARCH_DEGRADED: "Some Memory searches returned limited results in the last 24 hours. Answers continued with the available evidence.",
  SEARCH_FAILED: "Some Memory searches failed in the last 24 hours. Answers continued without their results."
} as const;

/** Command and search outcomes from the last 24 hours: Control Center
 * diagnostics that are not blocked processing and not Overview attention. */
export function isAdminMemoryRecentActivityIssue(issue: AdminMemoryProcessingIssue): boolean {
  return (ADMIN_MEMORY_RECENT_ACTIVITY_STAGES as readonly string[]).includes(issue.stage);
}

/** The Overview attention source omits recent-activity diagnostics. */
export function adminMemoryStatusForAttention(status: AdminMemoryStatus): AdminMemoryStatus {
  return {
    ...status,
    processing: {
      ...status.processing,
      issues: status.processing.issues.filter((issue) => !isAdminMemoryRecentActivityIssue(issue))
    }
  };
}

function unit(issue: AdminMemoryProcessingIssue): string {
  const one = issue.count === 1;
  return issue.stage === "COMMAND" ? one ? "command" : "commands"
    : issue.stage === "SEARCH" ? one ? "search" : "searches"
    : one ? "affected job" : "affected jobs";
}

/** Shared bounded copy for the Overview and Memory card; no stored error text. */
export function adminMemoryProcessingCopy(issue: AdminMemoryProcessingIssue) {
  const age = issue.oldestAgeSeconds;
  const duration = age === null ? "" : age < 60 ? `${age}s`
    : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;
  const configuration = issue.stage !== "INDEXING" && (issue.reason === "MODEL_UNAVAILABLE" ||
    issue.reason === "CAPABILITY_UNAVAILABLE" || issue.reason === "CONFIGURATION_REQUIRED" || issue.autoHeal === "EXHAUSTED");
  const healing = issue.autoHeal === "RETRYING"
    ? " Auto-heal is retrying the missing work, with pauses between up to 3 attempts. No action is needed."
    : issue.autoHeal === "EXHAUSTED"
      ? " Auto-heal could not restore processing after 3 attempts. Check the Memory model and its output/reasoning settings in Defaults & roles."
      : issue.autoHeal === "UNAVAILABLE"
        ? " Auto-heal cannot safely retry yet. Check the Memory model and worker status; requests with an unknown outcome are not repeated."
        : "";
  return {
    action: configuration ? "Open Defaults & roles" : "Open Memory",
    detail: `${reasons[issue.reason]}${healing}${issue.count > 0 ? ` ${issue.count} ${unit(issue)}${duration ? `; oldest ${duration}` : ""}.` : ""}${issue.stage === "LEARNING" ? " Previously saved facts remain available when the index is ready." : ""}`,
    section: configuration ? "roles" as const : "retrieval" as const,
    title: issue.autoHeal === "RETRYING" ? "Memory history is recovering automatically"
      : issue.autoHeal === "EXHAUSTED" ? "Memory history auto-heal failed"
      : issue.stage === "HISTORY" && issue.reason === "PROCESSING_FAILED" ? "Memory history processing failed"
      : issue.reason === "HISTORY_INCOMPLETE" || issue.reason === "OUTPUT_LIMIT" ? "Memory history enrichment is incomplete"
      : issue.stage === "LEARNING" && issue.severity === "warn"
      ? "Memory learning is delayed" : stages[issue.stage]
  };
}
