import type { AdminMemoryProcessingIssue } from "../contracts/adminMemory";

const stages = {
  LEARNING: "Memory is not learning new facts",
  HISTORY: "Memory history processing needs attention",
  INDEXING: "Memory indexing is degraded",
  SYNTHESIS: "Memory synthesis needs attention",
  MAINTENANCE: "Memory processing needs attention",
  DELETION: "Memory deletion needs attention"
} as const;

const reasons = {
  MODEL_UNAVAILABLE: "The configured model cannot currently perform this operation. Check the model, key, and verified capabilities.",
  CAPABILITY_UNAVAILABLE: "The configured model lacks a required verified capability.",
  CONFIGURATION_REQUIRED: "The current model configuration cannot run this operation.",
  PROCESSING_FAILED: "Processing failed and has not recovered.",
  RETRYING: "Processing keeps failing and is waiting to retry.",
  STALLED: "No completed work has advanced this backlog for at least 15 minutes."
} as const;

/** Shared bounded copy for the Overview and Memory card; no stored error text. */
export function adminMemoryProcessingCopy(issue: AdminMemoryProcessingIssue) {
  const age = issue.oldestAgeSeconds;
  const duration = age === null ? "" : age < 60 ? `${age}s`
    : age < 3600 ? `${Math.floor(age / 60)}m` : `${Math.floor(age / 3600)}h`;
  const configuration = issue.stage !== "INDEXING" && (issue.reason === "MODEL_UNAVAILABLE" ||
    issue.reason === "CAPABILITY_UNAVAILABLE" || issue.reason === "CONFIGURATION_REQUIRED");
  return {
    action: configuration ? "Open Defaults & roles" : "Open Memory",
    detail: `${reasons[issue.reason]}${issue.count > 0 ? ` ${issue.count} affected job${issue.count === 1 ? "" : "s"}${duration ? `; oldest ${duration}` : ""}.` : ""}${issue.stage === "LEARNING" ? " Previously saved facts remain available when the index is ready." : ""}`,
    section: configuration ? "roles" as const : "retrieval" as const,
    title: issue.stage === "LEARNING" && issue.severity === "warn"
      ? "Memory learning is delayed" : stages[issue.stage]
  };
}
