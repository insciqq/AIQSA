import type { UserMemoryHealth } from "@/lib/contracts/memoryHealth";

export const MEMORY_HEALTH_UI_COPY_KEYS = [
  "checking",
  "unavailableTitle",
  "unavailableDescription",
  "retry",
  "openOperations",
  "reviewDestinations",
  "advanced",
  "advancedDescription",
  "lastChecked",
  "learning",
  "indexing",
  "rebuild",
  "cleanup",
  "temporaryCleanup",
  "egress",
  "yes",
  "no",
  "upToDateTitle",
  "upToDateDescription",
  "learningDelayedTitle",
  "learningDelayedDescription",
  "learningAdminDescription",
  "learningUserDescription",
  "learningCapabilityDescription",
  "indexingTitle",
  "indexingDescription",
  "ftsOnlyTitle",
  "ftsOnlyDescription",
  "rebuildFailedTitle",
  "rebuildFailedDescription",
  "deletionTitle",
  "deletionDescription",
  "temporaryOverdueTitle",
  "temporaryOverdueDescription",
  "blockedTitle",
  "blockedDescription",
  "alsoTemporaryOverdue",
  "stateReady",
  "stateDisabled",
  "stateDelayed",
  "stateInProgress",
  "stateFailed",
  "stateFtsOnly",
  "stateClear",
  "stateBlocked",
  "stateOverdue",
  "stateAdminReview",
  "stateUserReview"
] as const;

export type MemoryHealthUiCopyKey =
  (typeof MEMORY_HEALTH_UI_COPY_KEYS)[number];
type Copy = Readonly<Record<MemoryHealthUiCopyKey, string>>;

const EN = {
  advanced: "Advanced",
  advancedDescription: "Operational status, destinations, and capability evidence.",
  alsoTemporaryOverdue: "Temporary-chat cleanup is also past its retention deadline.",
  blockedDescription: "The selected information remains fenced from reuse. Fast retries are exhausted; slow reconciliation continues while an administrator investigates.",
  blockedTitle: "Memory cleanup needs administrator attention",
  checking: "Checking Memory status…",
  cleanup: "Physical cleanup",
  deletionDescription: "The selected information is already fenced from reuse while physical cleanup continues in the background.",
  deletionTitle: "Memory cleanup is in progress",
  egress: "Destination review",
  ftsOnlyDescription: "Text search continues to work. Semantic matching will return when a compatible embedding index is available.",
  ftsOnlyTitle: "Memory is using text search",
  indexing: "History index",
  indexingDescription: "Existing eligible chats are being indexed in the background. You can keep chatting.",
  indexingTitle: "Memory is getting ready",
  lastChecked: "Last checked",
  learning: "Automatic learning",
  learningCapabilityDescription: "Automatic learning is enabled as a preference, but this installation has no compatible runtime capability. Explicit Memory actions still work.",
  learningAdminDescription: "Background learning is waiting for an administrator to review the current destinations. Chat remains available.",
  learningDelayedDescription: "Background learning is delayed. Chat and explicit Memory actions remain available.",
  learningDelayedTitle: "Memory learning is paused",
  learningUserDescription: "Background learning is waiting for destination review.",
  no: "No",
  openOperations: "Open Memory operations",
  rebuild: "Rebuild",
  rebuildFailedDescription: "The last shadow rebuild failed. The previous working index remains active and was not replaced.",
  rebuildFailedTitle: "Memory needs a retry",
  retry: "Check again",
  reviewDestinations: "Review destinations",
  stateAdminReview: "Administrator review required",
  stateBlocked: "Administrator attention required",
  stateClear: "Clear",
  stateDelayed: "Delayed",
  stateDisabled: "Off",
  stateFailed: "Failed",
  stateFtsOnly: "Text search only",
  stateInProgress: "In progress",
  stateOverdue: "Overdue",
  stateReady: "Ready",
  stateUserReview: "Review required",
  temporaryCleanup: "Temporary-chat retention",
  temporaryOverdueDescription: "A Temporary chat passed its retention deadline. It stays hidden while durable cleanup and administrator reconciliation continue.",
  temporaryOverdueTitle: "Temporary-chat cleanup is overdue",
  unavailableDescription: "Your Memory settings are still available, but the current background status could not be checked.",
  unavailableTitle: "Memory status is unavailable",
  upToDateDescription: "Your current settings and background Memory work are in sync.",
  upToDateTitle: "Memory is up to date",
  yes: "Yes"
} satisfies Copy;


export function memoryHealthUiCopy(key: MemoryHealthUiCopyKey): string {
  return EN[key];
}

export function memoryHealthStateCopy(
  health: UserMemoryHealth
): Readonly<{ description: string; title: string }> {
  const copy = (key: MemoryHealthUiCopyKey) => memoryHealthUiCopy(key);
  switch (health.state) {
    case "UP_TO_DATE":
      return { description: copy("upToDateDescription"), title: copy("upToDateTitle") };
    case "LEARNING_DELAYED":
      return {
        description: health.learning.reason === "CAPABILITY_UNAVAILABLE"
          ? copy("learningCapabilityDescription")
          : health.egressReview === "ADMIN_REQUIRED"
            ? copy("learningAdminDescription")
            : health.egressReview === "USER_REQUIRED"
              ? copy("learningUserDescription")
              : copy("learningDelayedDescription"),
        title: copy("learningDelayedTitle")
      };
    case "INDEXING":
      return { description: copy("indexingDescription"), title: copy("indexingTitle") };
    case "FTS_ONLY":
      return { description: copy("ftsOnlyDescription"), title: copy("ftsOnlyTitle") };
    case "REBUILD_FAILED":
      return { description: copy("rebuildFailedDescription"), title: copy("rebuildFailedTitle") };
    case "DELETION_IN_PROGRESS":
      return { description: copy("deletionDescription"), title: copy("deletionTitle") };
    case "TEMPORARY_OVERDUE":
      return {
        description: copy("temporaryOverdueDescription"),
        title: copy("temporaryOverdueTitle")
      };
    case "BLOCKED_REQUIRES_ADMIN":
      return { description: copy("blockedDescription"), title: copy("blockedTitle") };
  }
}
