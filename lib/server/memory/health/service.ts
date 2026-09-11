import type { MemoryIndexMode, MemoryJobState } from "@prisma/client";
import type { MemorySettingsResponse } from "../../../contracts/memory";
import type {
  UserMemoryHealth
} from "../../../contracts/memoryHealth";

const ACTIVE_REBUILD_STATES = new Set<MemoryJobState>([
  "QUEUED",
  "WAITING_FOR_CONFIGURATION",
  "WAITING_FOR_EGRESS_CONSENT",
  "CLAIMED",
  "RETRYABLE_FAILED"
]);
const MAX_USER_COUNT = 999;

export type UserMemoryHealthSnapshot = Readonly<{
  activeDeletionCount: number;
  activeIndexMode: MemoryIndexMode | null;
  blockedDeletionCount: number;
  latestRebuildState: MemoryJobState | null;
  overdueTemporaryCount: number;
  waitingForConfigurationCount: number;
}>;

export type MemoryHealthService = Readonly<{
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

function projectUser(input: Readonly<{
  now: Date;
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
  const learningDelayed = input.settings.settings.learnAutomatically && (
    !input.settings.capabilities.automaticLearning ||
    input.snapshot.waitingForConfigurationCount > 0
  );
  const learning = !input.settings.settings.useMemoryFacts || !input.settings.settings.learnAutomatically
      ? {
        reason: "USER_DISABLED" as const,
        state: "DISABLED" as const
      }
    : learningDelayed
      ? (() => {
          const reason = !input.settings.capabilities.automaticLearning
            ? "CAPABILITY_UNAVAILABLE" as const
            : "CONFIGURATION_UNAVAILABLE" as const;
          return {
            reason,
            state: "DELAYED" as const
          };
        })()
      : { reason: "NONE" as const, state: "READY" as const };
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
    : "NONE" as const;

  return Object.freeze({
    action,
    deletion: Object.freeze(deletion),
    indexing: Object.freeze(indexing),
    learning: Object.freeze(learning),
    observedAt: input.now.toISOString(),
    rebuild: Object.freeze(rebuild),
    state,
    temporary: Object.freeze(temporary)
  });
}

export function createMemoryHealthService(input: Readonly<{
  now?: () => Date;
  readSettings(userId: string): Promise<MemorySettingsResponse>;
  readUser(userId: string, now: Date): Promise<UserMemoryHealthSnapshot>;
}>): MemoryHealthService {
  const now = input.now ?? (() => new Date());
  return Object.freeze({
    async user(userId) {
      const observedAt = now();
      const [settings, snapshot] = await Promise.all([
        input.readSettings(userId),
        input.readUser(userId, observedAt)
      ]);
      return projectUser({ now: observedAt, settings, snapshot });
    }
  });
}
