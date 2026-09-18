import { z } from "zod";

export const ADMIN_MEMORY_INDEX_READINESS = [
  "NOT_CONFIGURED",
  "PREPARING",
  "READY",
  "REBUILD_REQUIRED",
  "REBUILDING"
] as const;

export const ADMIN_MEMORY_REBUILD_STATES = [
  "AVAILABLE",
  "IN_PROGRESS",
  "NOT_REQUIRED",
  "UNAVAILABLE"
] as const;

export const ADMIN_MEMORY_WORKER_STATES = [
  "NOT_RUNNING",
  "RUNNING",
  "STALLED"
] as const;

export const ADMIN_MEMORY_WORKER_REASONS = [
  "HEARTBEAT_STALE",
  "NOT_READY",
  "IDLE",
  "ACTIVE",
  "QUEUE_STALLED"
] as const;

export const ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS = Object.freeze({
  defaultSeconds: 30,
  maxSeconds: 120,
  minSeconds: 1
});

const safeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const safeLabel = z.string().trim().min(1).max(200);
const processingStage = z.enum(["LEARNING", "HISTORY", "INDEXING", "SYNTHESIS", "MAINTENANCE", "DELETION"]);
export const adminMemoryProcessingIssueSchema = z.strictObject({
  stage: processingStage,
  reason: z.enum(["MODEL_UNAVAILABLE", "CAPABILITY_UNAVAILABLE", "CONFIGURATION_REQUIRED", "PROCESSING_FAILED", "OUTPUT_LIMIT", "HISTORY_INCOMPLETE", "RETRYING", "STALLED"]),
  severity: z.enum(["bad", "warn"]),
  count: safeInteger,
  oldestAgeSeconds: safeInteger.nullable(),
  autoHeal: z.enum(["RETRYING", "EXHAUSTED", "UNAVAILABLE"]).optional()
});

export type AdminMemoryProcessingIssue = z.infer<typeof adminMemoryProcessingIssueSchema>;

export const adminMemoryStatusSchema = z.strictObject({
  admissionTimeout: z.strictObject({
    seconds: safeInteger.min(ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds)
      .max(ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds),
    version: safeInteger.min(1)
  }),
  processing: z.strictObject({
    enabled: z.boolean(),
    issues: z.array(adminMemoryProcessingIssueSchema).max(6)
  }),
  configuredTargets: z.array(z.strictObject({
    model: safeLabel,
    provider: safeLabel
  })).max(64),
  index: z.strictObject({
    generation: z.union([safeInteger, z.literal("MIXED")]).nullable(),
    readiness: z.enum(ADMIN_MEMORY_INDEX_READINESS)
  }),
  queue: z.strictObject({
    inProgress: safeInteger,
    length: safeInteger,
    oldestAgeSeconds: safeInteger.nullable()
  }),
  rebuild: z.strictObject({
    state: z.enum(ADMIN_MEMORY_REBUILD_STATES)
  }),
  recovery: z.strictObject({
    eligible: safeInteger,
    scheduled: safeInteger,
    permanent: safeInteger,
    protected: safeInteger,
    exhausted: safeInteger,
    obsolete: safeInteger,
    configurationRequired: safeInteger,
    nextRetrySeconds: safeInteger.nullable()
  }),
  worker: z.strictObject({
    state: z.enum(ADMIN_MEMORY_WORKER_STATES),
    reason: z.enum(ADMIN_MEMORY_WORKER_REASONS),
    lastSeenAgeSeconds: safeInteger.nullable(),
    lastProgressAgeSeconds: safeInteger.nullable(),
    lastSuccessAgeSeconds: safeInteger.nullable(),
    observationWindowSeconds: safeInteger.min(1),
    activeStages: z.array(processingStage).max(6)
  })
}).superRefine((value, context) => {
  if (new Set(value.processing.issues.map((issue) => issue.stage)).size !== value.processing.issues.length ||
    value.processing.issues.some((issue) => (issue.count === 0) !== (issue.oldestAgeSeconds === null))) {
    context.addIssue({ code: "custom", message: "Memory processing stages, counts and ages must agree" });
  }
  if ((value.queue.length === 0) !== (value.queue.oldestAgeSeconds === null)) {
    context.addIssue({
      code: "custom",
      message: "Memory queue length and oldest age must agree"
    });
  }
  if (
    (value.index.readiness === "REBUILDING") !==
    (value.rebuild.state === "IN_PROGRESS")
  ) {
    context.addIssue({
      code: "custom",
      message: "Memory rebuild and index readiness must agree"
    });
  }
  if (
    value.rebuild.state === "AVAILABLE" &&
    value.index.readiness !== "REBUILD_REQUIRED"
  ) {
    context.addIssue({
      code: "custom",
      message: "Memory rebuild is available only for an index that requires it"
    });
  }
  if (value.worker.state === "NOT_RUNNING" && value.worker.reason !== "HEARTBEAT_STALE" && value.worker.reason !== "NOT_READY") {
    context.addIssue({ code: "custom", message: "An unavailable Memory worker must have startup or heartbeat evidence" });
  }
  if (value.worker.state === "STALLED" && value.worker.reason !== "QUEUE_STALLED") {
    context.addIssue({ code: "custom", message: "A stalled Memory worker must have queue stall evidence" });
  }
  if (value.worker.state === "RUNNING" &&
    (value.worker.reason === "HEARTBEAT_STALE" || value.worker.reason === "QUEUE_STALLED" || value.worker.reason === "NOT_READY")) {
    context.addIssue({ code: "custom", message: "A running Memory worker cannot report stale or stalled evidence" });
  }
  if ((value.recovery.scheduled === 0) !== (value.recovery.nextRetrySeconds === null)) {
    context.addIssue({ code: "custom", message: "Scheduled recovery must include its next retry" });
  }
});

export const adminMemoryStatusResponseSchema = z.strictObject({
  memory: adminMemoryStatusSchema
});

export const adminMemoryRebuildInputSchema = z.strictObject({
  action: z.literal("REBUILD_REQUIRED")
});

export const adminMemoryRecoveryInputSchema = z.strictObject({
  action: z.literal("RECOVER_ELIGIBLE")
});

export const adminMemoryActionInputSchema = z.union([
  adminMemoryRebuildInputSchema,
  adminMemoryRecoveryInputSchema
]);

export const adminMemoryAdmissionTimeoutInputSchema = z.strictObject({
  expectedVersion: safeInteger.min(1),
  timeoutSeconds: safeInteger.min(ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds)
    .max(ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds)
});

export type AdminMemoryStatus = z.infer<typeof adminMemoryStatusSchema>;
export type AdminMemoryStatusResponse = z.infer<typeof adminMemoryStatusResponseSchema>;
export type AdminMemoryRebuildInput = z.infer<typeof adminMemoryRebuildInputSchema>;
export type AdminMemoryRecoveryInput = z.infer<typeof adminMemoryRecoveryInputSchema>;
export type AdminMemoryActionInput = z.infer<typeof adminMemoryActionInputSchema>;
export type AdminMemoryAdmissionTimeoutInput = z.infer<
  typeof adminMemoryAdmissionTimeoutInputSchema
>;

export function decodeAdminMemoryStatusResponse(
  value: unknown
): AdminMemoryStatusResponse | null {
  const decoded = adminMemoryStatusResponseSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

export function decodeAdminMemoryRebuildInput(
  value: unknown
): AdminMemoryRebuildInput | null {
  const decoded = adminMemoryRebuildInputSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

export function decodeAdminMemoryActionInput(
  value: unknown
): AdminMemoryActionInput | null {
  const decoded = adminMemoryActionInputSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}

export function decodeAdminMemoryAdmissionTimeoutInput(
  value: unknown
): AdminMemoryAdmissionTimeoutInput | null {
  const decoded = adminMemoryAdmissionTimeoutInputSchema.safeParse(value);
  return decoded.success ? decoded.data : null;
}
