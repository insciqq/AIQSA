import type { AdminMemoryStatus } from "@/lib/contracts/adminMemory";

export type AdminMemoryLocale = "EN" | "RU";

const COPY = {
  configured: "Configured models and providers",
  configuredEmpty: "No Memory models are configured",
  generation: "Index generation",
  heading: "Memory status",
  index: "Personal index",
  intro: "Check the few runtime signals needed to keep personal Memory available.",
  activeIssue: "Active issue code",
  loading: "Loading Memory status…",
  noError: "None",
  notice: "A bounded Memory index rebuild was queued.",
  queue: "Worker queue",
  rebuild: "Rebuild index",
  rebuildDescription: "The active index is incompatible or incomplete. This action admits a bounded batch and preserves the current generation until replacements are ready.",
  rebuildInProgress: "A generation-safe rebuild is in progress.",
  rebuildUnavailable: "A rebuild is required, but it cannot start until the Memory worker and model setup are ready.",
  refresh: "Refresh",
  saveTimeout: "Save timeout",
  statusUnavailable: "Status unavailable",
  timeoutDescription: "Applies to new personal Memory lookups. If the full Control, embedding, retrieval, and reranking chain exceeds this budget, the answer continues without Memory.",
  timeoutLabel: "Memory admission timeout (seconds)",
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
  if (status.generation === null) return readiness[status.readiness];
  const generation = status.generation === "MIXED"
    ? "Mixed generations"
    : `Generation ${status.generation.toLocaleString("en-US")}`;
  return `${generation} · ${readiness[status.readiness]}`;
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
