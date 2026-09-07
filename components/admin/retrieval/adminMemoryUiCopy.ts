import type { AdminMemoryStatus } from "@/lib/contracts/adminMemory";

export type AdminMemoryLocale = "EN" | "RU";

const COPY = {
  configured: "Models in use",
  configuredEmpty: "No Memory models are configured",
  heading: "Memory",
  index: "Personal index",
  intro: "The few runtime signals needed to keep personal Memory available.",
  activeIssue: "Active issue",
  loading: "Loading Memory status...",
  noError: "None",
  notice: "A bounded Memory index rebuild was queued.",
  queue: "Worker queue",
  rebuild: "Rebuild",
  rebuildConfirmTitle: "Rebuild the Memory index?",
  rebuildDescription: "The current index is incompatible or incomplete. Rebuilding admits a bounded batch and keeps the current index in use until replacements are ready.",
  rebuildInProgress: "A rebuild is in progress. Answers keep using the current index until it is ready.",
  rebuildUnavailable: "A rebuild is required, but it cannot start until the Memory worker and model setup are ready.",
  saveTimeout: "Save",
  statusUnavailable: "Status unavailable",
  timeoutDescription: "Applies to new personal Memory lookups. If the full Memory chain exceeds this budget, the answer continues without Memory.",
  timeoutLabel: "Admission timeout (seconds)",
  timeoutNotice: "Memory admission timeout saved. New messages use the updated budget.",
  worker: "Memory worker"
} as const;

export function adminMemoryCopy(_locale: AdminMemoryLocale) {
  return COPY;
}

export function adminMemoryWorkerCopy(
  _locale: AdminMemoryLocale,
  state: AdminMemoryStatus["worker"]["state"]
): string {
  return state === "RUNNING" ? "Running" : "Not running";
}

export function adminMemoryIndexCopy(
  _locale: AdminMemoryLocale,
  status: AdminMemoryStatus["index"]
): string {
  const readiness = {
    NOT_CONFIGURED: "No active index",
    PREPARING: "Preparing existing memories",
    READY: "Ready",
    REBUILD_REQUIRED: "Rebuild required",
    REBUILDING: "Rebuilding"
  } as const;
  return readiness[status.readiness];
}

export function adminMemoryQueueCopy(
  _locale: AdminMemoryLocale,
  queue: AdminMemoryStatus["queue"]
): string {
  if (queue.length === 0) return "Empty";
  const count = queue.length.toLocaleString("en-US");
  const seconds = queue.oldestAgeSeconds ?? 0;
  if (seconds < 60) return `${count} waiting · oldest ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${count} waiting · oldest ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${count} waiting · oldest ${hours}h`;
  return `${count} waiting · oldest ${Math.floor(hours / 24)}d`;
}
