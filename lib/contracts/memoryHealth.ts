import { z } from "zod";

export const USER_MEMORY_HEALTH_STATES = [
  "UP_TO_DATE",
  "LEARNING_DELAYED",
  "INDEXING",
  "FTS_ONLY",
  "REBUILD_FAILED",
  "DELETION_IN_PROGRESS",
  "TEMPORARY_OVERDUE",
  "BLOCKED_REQUIRES_ADMIN"
] as const;

export const ADMIN_MEMORY_COUNT_BANDS = ["NONE", "SOME", "MANY", "UNKNOWN"] as const;
export const ADMIN_MEMORY_LAG_BANDS = [
  "NONE",
  "UNDER_5_MINUTES",
  "UNDER_15_MINUTES",
  "UNDER_1_HOUR",
  "UNDER_24_HOURS",
  "OVER_24_HOURS",
  "UNKNOWN"
] as const;

const safeCount = z.number().int().min(0).max(999);
const timestamp = z.string().datetime();

export const userMemoryHealthSchema = z.strictObject({
  action: z.enum(["NONE", "OPEN_MEMORY_OPERATIONS", "REVIEW_DESTINATIONS"]),
  deletion: z.strictObject({
    activeCount: safeCount,
    countTruncated: z.boolean(),
    retrievalFenced: z.boolean(),
    state: z.enum(["CLEAR", "IN_PROGRESS", "BLOCKED_REQUIRES_ADMIN"])
  }),
  egressReview: z.enum(["NONE", "ADMIN_REQUIRED", "USER_REQUIRED"]),
  indexing: z.strictObject({
    completedChats: safeCount,
    countTruncated: z.boolean(),
    state: z.enum(["DISABLED", "READY", "INDEXING", "FTS_ONLY"]),
    totalChats: safeCount
  }),
  learning: z.strictObject({
    reason: z.enum([
      "NONE",
      "USER_DISABLED",
      "CAPABILITY_UNAVAILABLE",
      "BUDGET",
      "EGRESS_REVIEW",
      "SCHEDULER_UNAVAILABLE"
    ]),
    resumeAt: timestamp.nullable(),
    state: z.enum(["DISABLED", "READY", "DELAYED"])
  }),
  observedAt: timestamp,
  rebuild: z.strictObject({
    state: z.enum(["IDLE", "IN_PROGRESS", "FAILED"])
  }),
  state: z.enum(USER_MEMORY_HEALTH_STATES),
  temporary: z.strictObject({
    countTruncated: z.boolean(),
    overdueCount: safeCount,
    state: z.enum(["CLEAR", "OVERDUE"])
  })
}).superRefine((value, context) => {
  if (value.indexing.completedChats > value.indexing.totalChats) {
    context.addIssue({ code: "custom", message: "indexing progress exceeds total" });
  }
  if ((value.deletion.activeCount > 0) !== (value.deletion.state !== "CLEAR")) {
    context.addIssue({ code: "custom", message: "deletion count/state mismatch" });
  }
  if (value.deletion.retrievalFenced !== (value.deletion.activeCount > 0)) {
    context.addIssue({ code: "custom", message: "deletion fence/count mismatch" });
  }
  if ((value.temporary.overdueCount > 0) !== (value.temporary.state === "OVERDUE")) {
    context.addIssue({ code: "custom", message: "temporary count/state mismatch" });
  }
  if (value.learning.state === "DELAYED" && value.learning.reason === "NONE") {
    context.addIssue({ code: "custom", message: "delayed learning requires a reason" });
  }
  if (value.learning.state === "DISABLED" && value.learning.reason !== "USER_DISABLED") {
    context.addIssue({ code: "custom", message: "disabled learning requires the user-disabled reason" });
  }
  if (value.learning.state === "READY" && value.learning.reason !== "NONE") {
    context.addIssue({ code: "custom", message: "ready learning cannot have a delay reason" });
  }
  if (value.learning.state === "DELAYED" && value.learning.reason === "USER_DISABLED") {
    context.addIssue({ code: "custom", message: "user-disabled learning is not delayed" });
  }
  if (value.learning.state !== "DELAYED" && value.learning.resumeAt !== null) {
    context.addIssue({ code: "custom", message: "only delayed learning has a resume time" });
  }
  if ((value.learning.reason === "BUDGET") !== (value.learning.resumeAt !== null)) {
    context.addIssue({ code: "custom", message: "only a budget delay has a resume time" });
  }

  const expectedState = value.deletion.state === "BLOCKED_REQUIRES_ADMIN"
    ? "BLOCKED_REQUIRES_ADMIN"
    : value.temporary.state === "OVERDUE"
      ? "TEMPORARY_OVERDUE"
      : value.deletion.state === "IN_PROGRESS"
        ? "DELETION_IN_PROGRESS"
        : value.rebuild.state === "FAILED"
          ? "REBUILD_FAILED"
          : value.rebuild.state === "IN_PROGRESS" || value.indexing.state === "INDEXING"
            ? "INDEXING"
            : value.learning.state === "DELAYED"
              ? "LEARNING_DELAYED"
              : value.indexing.state === "FTS_ONLY"
                ? "FTS_ONLY"
                : "UP_TO_DATE";
  if (value.state !== expectedState) {
    context.addIssue({ code: "custom", message: "top-level health state hides nested status" });
  }
  const expectedAction = [
    "REBUILD_FAILED",
    "DELETION_IN_PROGRESS",
    "BLOCKED_REQUIRES_ADMIN"
  ].includes(expectedState)
    ? "OPEN_MEMORY_OPERATIONS"
    : value.egressReview === "USER_REQUIRED"
      ? "REVIEW_DESTINATIONS"
      : "NONE";
  if (value.action !== expectedAction) {
    context.addIssue({ code: "custom", message: "health action/state mismatch" });
  }
});

export const memoryHealthResponseSchema = z.strictObject({
  health: userMemoryHealthSchema
});

export type UserMemoryHealth = z.infer<typeof userMemoryHealthSchema>;
export type MemoryHealthResponse = z.infer<typeof memoryHealthResponseSchema>;

export function decodeMemoryHealthResponse(value: unknown): MemoryHealthResponse | null {
  const decoded = memoryHealthResponseSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

const countBand = z.enum(ADMIN_MEMORY_COUNT_BANDS);

export const adminMemoryHealthSchema = z.strictObject({
  deletion: z.strictObject({
    active: countBand,
    blocked: countBand,
    state: z.enum(["CLEAR", "WORKING", "ATTENTION_REQUIRED", "UNKNOWN"])
  }),
  observedAt: timestamp,
  overall: z.enum(["HEALTHY", "DEGRADED", "ACTION_REQUIRED", "UNAVAILABLE"]),
  provider: z.strictObject({
    failedRecent: countBand,
    outcomeUnknown: countBand,
    state: z.enum(["IDLE", "READY", "DEGRADED", "UNKNOWN"]),
    usageIncomplete: countBand
  }),
  queue: z.strictObject({
    active: countBand,
    failed: countBand,
    oldestLag: z.enum(ADMIN_MEMORY_LAG_BANDS),
    state: z.enum(["CLEAR", "WORKING", "DELAYED", "BLOCKED", "UNKNOWN"]),
    waitingForReview: countBand
  }),
  requestLocale: z.enum(["EN", "RU"]),
  scheduler: z.strictObject({
    resetAt: timestamp,
    state: z.enum(["READY", "DEFERRED", "UNAVAILABLE"])
  }),
  temporary: z.strictObject({
    overdue: countBand,
    state: z.enum(["CLEAR", "OVERDUE", "UNKNOWN"])
  })
});

export type AdminMemoryHealth = z.infer<typeof adminMemoryHealthSchema>;

export function unavailableAdminMemoryHealth(
  requestLocale: "EN" | "RU",
  observedAt = new Date()
): AdminMemoryHealth {
  const unknown = "UNKNOWN" as const;
  const fallback = {
    deletion: { active: unknown, blocked: unknown, state: unknown },
    observedAt: observedAt.toISOString(),
    overall: "UNAVAILABLE" as const,
    provider: {
      failedRecent: unknown,
      outcomeUnknown: unknown,
      state: unknown,
      usageIncomplete: unknown
    },
    queue: {
      active: unknown,
      failed: unknown,
      oldestLag: unknown,
      state: unknown,
      waitingForReview: unknown
    },
    requestLocale,
    scheduler: { resetAt: observedAt.toISOString(), state: "UNAVAILABLE" as const },
    temporary: { overdue: unknown, state: unknown }
  };
  return adminMemoryHealthSchema.parse(fallback);
}
