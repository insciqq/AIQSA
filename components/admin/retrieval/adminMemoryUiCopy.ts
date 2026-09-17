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
  recovery: "Retry eligible work",
  recoveryDescription: "The worker automatically retries eligible failures after a delay. You can request the next due batch here.",
  recoveryNotice: "Eligible Memory work was queued for retry.",
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
  worker: AdminMemoryStatus["worker"]
): string {
  if (worker.state === "NOT_RUNNING") return "Not running";
  if (worker.state === "STALLED") return "Running, queue stalled";
  return "Running";
}

export function adminMemoryWorkerEvidenceCopy(
  _locale: AdminMemoryLocale,
  worker: AdminMemoryStatus["worker"]
): string {
  if (worker.state === "NOT_RUNNING") {
    if (worker.reason === "NOT_READY") return "Startup has not completed, or the worker has stopped";
    return worker.lastSeenAgeSeconds === null
      ? "No heartbeat observed"
      : `Heartbeat stale for ${formatAge(worker.lastSeenAgeSeconds)}`;
  }
  if (worker.state === "STALLED") {
    if (worker.lastProgressAgeSeconds !== null && worker.lastProgressAgeSeconds < worker.observationWindowSeconds) {
      return "Some queued work is not progressing";
    }
    return worker.lastProgressAgeSeconds === null
      ? "Queue has no recorded progress"
      : `No queue progress for ${formatAge(worker.lastProgressAgeSeconds)}`;
  }
  if (worker.reason === "IDLE") return "Heartbeat healthy · queue idle";
  return worker.lastProgressAgeSeconds == null
    ? "Heartbeat healthy · progress not yet recorded"
    : `Progress ${formatAge(worker.lastProgressAgeSeconds)} ago`;
}

export function adminMemorySuccessCopy(worker: AdminMemoryStatus["worker"]): string {
  return worker.lastSuccessAgeSeconds === null ? "No completed job recorded" :
    `Last completed job ${formatAge(worker.lastSuccessAgeSeconds)} ago`;
}

export function adminMemoryRecoveryCopy(recovery: AdminMemoryStatus["recovery"]): readonly string[] {
  const lines: string[] = [];
  if (recovery.eligible) lines.push(`${recovery.eligible} eligible for retry`);
  if (recovery.scheduled) lines.push(`${recovery.scheduled} scheduled · next retry in ${formatAge(recovery.nextRetrySeconds)}`);
  if (recovery.configurationRequired) lines.push(`${recovery.configurationRequired} waiting for model setup. Check Defaults & roles.`);
  if (recovery.protected) lines.push(`${recovery.protected} ${recovery.protected === 1 ? "has" : "have"} a recorded provider execution. Safe result recovery is required before retry.`);
  if (recovery.exhausted) lines.push(`${recovery.exhausted} exhausted automatic retries. Check worker logs and resolve the cause.`);
  if (recovery.permanent) lines.push(`${recovery.permanent} ${recovery.permanent === 1 ? "requires" : "require"} a fix before retry. Check worker logs for the failure code.`);
  if (recovery.obsolete) lines.push(`${recovery.obsolete} outdated or already resolved failures excluded from retry`);
  return lines.length ? lines : ["No failures awaiting recovery"];
}

function formatAge(seconds: number | null | undefined): string {
  if (seconds == null) return "an unknown period";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h`;
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
  if (queue.length === 0 && queue.inProgress === 0) return "Empty";
  const activity = `${queue.inProgress.toLocaleString("en-US")} in progress · ${queue.length.toLocaleString("en-US")} waiting`;
  if (queue.length === 0) return activity;
  const seconds = queue.oldestAgeSeconds ?? 0;
  if (seconds < 60) return `${activity} · oldest ${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${activity} · oldest ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${activity} · oldest ${hours}h`;
  return `${activity} · oldest ${Math.floor(hours / 24)}d`;
}
