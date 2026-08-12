import type { MemoryIndexMode, MemoryJobState } from "@prisma/client";
import type { MemorySettingsResponse } from "../../../contracts/memory";
import type {
  AdminMemoryHealth,
  UserMemoryHealth
} from "../../../contracts/memoryHealth";
import type { MemorySchedulerBudgetStatus } from "../coordinator/scheduler";

const ACTIVE_REBUILD_STATES = new Set<MemoryJobState>([
  "QUEUED",
  "WAITING_FOR_EGRESS_CONSENT",
  "CLAIMED",
  "RETRYABLE_FAILED"
]);
const MANY_COUNT_THRESHOLD = 25;
const MAX_USER_COUNT = 999;

export type UserMemoryHealthSnapshot = Readonly<{
  activeDeletionCount: number;
  activeIndexMode: MemoryIndexMode | null;
  blockedDeletionCount: number;
  latestRebuildState: MemoryJobState | null;
  overdueTemporaryCount: number;
  waitingForEgressCount: number;
}>;

export type AdminMemoryHealthSnapshot = Readonly<{
  activeDeletionCount: number;
  activeJobCount: number;
  blockedDeletionCount: number;
  failedExecutionCount: number;
  incompleteUsageCount: number;
  oldestActiveJobAt: Date | null;
  outcomeUnknownCount: number;
  overdueTemporaryCount: number;
  recentExecutionCount: number;
  recentTerminalJobCount: number;
  requestLocale: "EN" | "RU";
  retryingJobCount: number;
  waitingForEgressCount: number;
}>;

export type MemoryHealthRepository = Readonly<{
  readAdmin(adminUserId: string, now: Date): Promise<AdminMemoryHealthSnapshot>;
  readUser(userId: string, now: Date): Promise<UserMemoryHealthSnapshot>;
}>;

export type MemoryHealthService = Readonly<{
  admin(
    adminUserId: string,
    input: Readonly<{ egressReviewRequired: boolean }>
  ): Promise<AdminMemoryHealth>;
  user(userId: string): Promise<UserMemoryHealth>;
}>;

function checkedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("memory_health_count_invalid");
  }
  return value;
}

function boundedCount(value: number): Readonly<{ count: number; truncated: boolean }> {
  checkedCount(value);
  return Object.freeze({
    count: Math.min(value, MAX_USER_COUNT),
    truncated: value > MAX_USER_COUNT
  });
}

function countBand(value: number): AdminMemoryHealth["queue"]["active"] {
  checkedCount(value);
  if (value === 0) return "NONE";
  return value >= MANY_COUNT_THRESHOLD ? "MANY" : "SOME";
}

function lagBand(
  oldest: Date | null,
  now: Date
): AdminMemoryHealth["queue"]["oldestLag"] {
  if (!oldest) return "NONE";
  const lag = Math.max(0, now.getTime() - oldest.getTime());
  if (lag < 5 * 60_000) return "UNDER_5_MINUTES";
  if (lag < 15 * 60_000) return "UNDER_15_MINUTES";
  if (lag < 60 * 60_000) return "UNDER_1_HOUR";
  if (lag < 24 * 60 * 60_000) return "UNDER_24_HOURS";
  return "OVER_24_HOURS";
}

function schedulerState(
  status: MemorySchedulerBudgetStatus
): AdminMemoryHealth["scheduler"]["state"] {
  if (status.status === "unavailable") return "UNAVAILABLE";
  return status.installation.deferred ? "DEFERRED" : "READY";
}

function projectUser(input: Readonly<{
  now: Date;
  scheduler: MemorySchedulerBudgetStatus;
  settings: MemorySettingsResponse;
  snapshot: UserMemoryHealthSnapshot;
}>): UserMemoryHealth {
  const deletionCount = boundedCount(input.snapshot.activeDeletionCount);
  const temporaryCount = boundedCount(input.snapshot.overdueTemporaryCount);
  const history = input.settings.historyIndexing;
  const historyCount = boundedCount(history.totalChats);
  const completedChats = Math.min(history.completedChats, historyCount.count);
  const ftsOnly = input.settings.settings.referenceChatHistory && (
    input.snapshot.activeIndexMode === "LEXICAL_ONLY" ||
    input.settings.settings.embeddingDeployment === null
  );
  const egressReview = input.snapshot.waitingForEgressCount > 0 &&
      input.settings.egress.consentMode === "ADMIN"
    ? "ADMIN_REQUIRED" as const
    : input.settings.egress.reviewRequired
      ? "USER_REQUIRED" as const
      : "NONE" as const;
  const schedulerUnavailable = input.scheduler.status === "unavailable";
  const schedulerDeferred = input.scheduler.installation.deferred ||
    input.scheduler.user?.deferred === true;
  const learningDelayed = input.settings.settings.learnAutomatically && (
    !input.settings.capabilities.automaticLearning ||
    input.snapshot.waitingForEgressCount > 0 ||
    schedulerUnavailable ||
    schedulerDeferred
  );
  const learning = !input.settings.settings.learnAutomatically
    ? {
        reason: "USER_DISABLED" as const,
        resumeAt: null,
        state: "DISABLED" as const
      }
    : learningDelayed
      ? (() => {
          const reason = !input.settings.capabilities.automaticLearning
            ? "CAPABILITY_UNAVAILABLE" as const
            : input.snapshot.waitingForEgressCount > 0
            ? "EGRESS_REVIEW" as const
            : schedulerUnavailable
              ? "SCHEDULER_UNAVAILABLE" as const
              : "BUDGET" as const;
          return {
            reason,
            resumeAt: reason === "BUDGET" ? input.scheduler.resetAt : null,
            state: "DELAYED" as const
          };
        })()
      : { reason: "NONE" as const, resumeAt: null, state: "READY" as const };
  const indexing = {
    completedChats,
    countTruncated: historyCount.truncated,
    state: history.state === "DISABLED"
      ? "DISABLED" as const
      : history.state === "INDEXING"
        ? "INDEXING" as const
        : ftsOnly
          ? "FTS_ONLY" as const
          : "READY" as const,
    totalChats: historyCount.count
  };
  const rebuild = {
    state: input.snapshot.latestRebuildState === "TERMINAL_FAILED"
      ? "FAILED" as const
      : input.snapshot.latestRebuildState &&
          ACTIVE_REBUILD_STATES.has(input.snapshot.latestRebuildState)
        ? "IN_PROGRESS" as const
        : "IDLE" as const
  };
  const deletion = {
    activeCount: deletionCount.count,
    countTruncated: deletionCount.truncated,
    retrievalFenced: deletionCount.count > 0,
    state: input.snapshot.blockedDeletionCount > 0
      ? "BLOCKED_REQUIRES_ADMIN" as const
      : deletionCount.count > 0
        ? "IN_PROGRESS" as const
        : "CLEAR" as const
  };
  const temporary = {
    countTruncated: temporaryCount.truncated,
    overdueCount: temporaryCount.count,
    state: temporaryCount.count > 0 ? "OVERDUE" as const : "CLEAR" as const
  };
  const state = deletion.state === "BLOCKED_REQUIRES_ADMIN"
    ? "BLOCKED_REQUIRES_ADMIN" as const
    : temporary.state === "OVERDUE"
      ? "TEMPORARY_OVERDUE" as const
      : deletion.state === "IN_PROGRESS"
        ? "DELETION_IN_PROGRESS" as const
        : rebuild.state === "FAILED"
          ? "REBUILD_FAILED" as const
          : rebuild.state === "IN_PROGRESS" || indexing.state === "INDEXING"
            ? "INDEXING" as const
            : learning.state === "DELAYED"
              ? "LEARNING_DELAYED" as const
              : ftsOnly
                ? "FTS_ONLY" as const
                : "UP_TO_DATE" as const;
  const action = state === "REBUILD_FAILED" || state === "DELETION_IN_PROGRESS" ||
      state === "BLOCKED_REQUIRES_ADMIN"
    ? "OPEN_MEMORY_OPERATIONS" as const
    : egressReview === "USER_REQUIRED"
      ? "REVIEW_DESTINATIONS" as const
      : "NONE" as const;

  return Object.freeze({
    action,
    deletion: Object.freeze(deletion),
    egressReview,
    indexing: Object.freeze(indexing),
    learning: Object.freeze(learning),
    observedAt: input.now.toISOString(),
    rebuild: Object.freeze(rebuild),
    state,
    temporary: Object.freeze(temporary)
  });
}

function projectAdmin(input: Readonly<{
  egressReviewRequired: boolean;
  now: Date;
  scheduler: MemorySchedulerBudgetStatus;
  snapshot: AdminMemoryHealthSnapshot;
}>): AdminMemoryHealth {
  const lag = lagBand(input.snapshot.oldestActiveJobAt, input.now);
  const queueState = input.snapshot.recentTerminalJobCount > 0
    ? "BLOCKED" as const
    : input.snapshot.waitingForEgressCount > 0 ||
        input.snapshot.retryingJobCount > 0 ||
        ["UNDER_1_HOUR", "UNDER_24_HOURS", "OVER_24_HOURS"].includes(lag)
      ? "DELAYED" as const
      : input.snapshot.activeJobCount > 0
        ? "WORKING" as const
        : "CLEAR" as const;
  const providerState = input.snapshot.recentExecutionCount === 0
    ? "IDLE" as const
    : input.snapshot.failedExecutionCount > 0 ||
        input.snapshot.outcomeUnknownCount > 0 ||
        input.snapshot.incompleteUsageCount > 0
      ? "DEGRADED" as const
      : "READY" as const;
  const deletionState = input.snapshot.blockedDeletionCount > 0
    ? "ATTENTION_REQUIRED" as const
    : input.snapshot.activeDeletionCount > 0
      ? "WORKING" as const
      : "CLEAR" as const;
  const temporaryState = input.snapshot.overdueTemporaryCount > 0
    ? "OVERDUE" as const
    : "CLEAR" as const;
  const scheduler = schedulerState(input.scheduler);
  const actionRequired = input.egressReviewRequired ||
    deletionState === "ATTENTION_REQUIRED" ||
    temporaryState === "OVERDUE";
  const degraded = queueState === "BLOCKED" || queueState === "DELAYED" ||
    providerState === "DEGRADED" || scheduler !== "READY";

  return Object.freeze({
    deletion: Object.freeze({
      active: countBand(input.snapshot.activeDeletionCount),
      blocked: countBand(input.snapshot.blockedDeletionCount),
      state: deletionState
    }),
    observedAt: input.now.toISOString(),
    overall: actionRequired ? "ACTION_REQUIRED" : degraded ? "DEGRADED" : "HEALTHY",
    provider: Object.freeze({
      failedRecent: countBand(input.snapshot.failedExecutionCount),
      outcomeUnknown: countBand(input.snapshot.outcomeUnknownCount),
      state: providerState,
      usageIncomplete: countBand(input.snapshot.incompleteUsageCount)
    }),
    queue: Object.freeze({
      active: countBand(input.snapshot.activeJobCount),
      failed: countBand(input.snapshot.recentTerminalJobCount),
      oldestLag: lag,
      state: queueState,
      waitingForReview: countBand(input.snapshot.waitingForEgressCount)
    }),
    requestLocale: input.snapshot.requestLocale,
    scheduler: Object.freeze({ resetAt: input.scheduler.resetAt, state: scheduler }),
    temporary: Object.freeze({
      overdue: countBand(input.snapshot.overdueTemporaryCount),
      state: temporaryState
    })
  });
}

export function createMemoryHealthService(input: Readonly<{
  now?: () => Date;
  readSchedulerStatus(userId?: string): Promise<MemorySchedulerBudgetStatus>;
  readSettings(userId: string): Promise<MemorySettingsResponse>;
  repository: MemoryHealthRepository;
}>): MemoryHealthService {
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async admin(adminUserId, request) {
      const observedAt = now();
      const [snapshot, scheduler] = await Promise.all([
        input.repository.readAdmin(adminUserId, observedAt),
        input.readSchedulerStatus()
      ]);
      return projectAdmin({
        egressReviewRequired: request.egressReviewRequired,
        now: observedAt,
        scheduler,
        snapshot
      });
    },

    async user(userId) {
      const observedAt = now();
      const [settings, snapshot, scheduler] = await Promise.all([
        input.readSettings(userId),
        input.repository.readUser(userId, observedAt),
        input.readSchedulerStatus(userId)
      ]);
      return projectUser({ now: observedAt, scheduler, settings, snapshot });
    }
  });
}
