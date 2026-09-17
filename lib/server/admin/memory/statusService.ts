import {
  ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS,
  adminMemoryStatusSchema,
  type AdminMemoryStatus
} from "../../../contracts/adminMemory";
import { MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS } from "../../memory/coordinator/workerHeartbeat";

export const ADMIN_MEMORY_WORKER_FRESHNESS_MS = MEMORY_WORKER_HEARTBEAT_FRESHNESS_MS;
export const ADMIN_MEMORY_WORKER_PROGRESS_STALE_MS = 15 * 60_000;
export const ADMIN_MEMORY_REBUILD_BATCH_SIZE = 8;
export const ADMIN_MEMORY_RECOVERY_BATCH_SIZE = 8;

export type AdminMemoryRebuildCandidate = Readonly<{
  embeddingDeploymentId: string | null;
  expectedMemoryRevision: number;
  expectedSettingsRevision: number;
  operation: "REBUILD_SEARCH_INDEX" | "REEMBED" | "REINDEX_HISTORY";
  userId: string;
}>;

export type AdminMemoryStatusSnapshot = Readonly<{
  admissionTimeout: Readonly<{
    seconds: number;
    version: number;
  }>;
  processing: AdminMemoryStatus["processing"];
  recovery: AdminMemoryStatus["recovery"];
  configuredTargets: readonly Readonly<{ model: string; provider: string }>[];
  index: Readonly<{
    activeGenerations: readonly number[];
    ownerCount: number;
    preparing: boolean;
    rebuildCandidates: readonly AdminMemoryRebuildCandidate[];
    rebuilding: boolean;
    requiresRebuild: boolean;
  }>;
  oldestQueuedAt: Date | null;
  inProgressCount: number;
  queueLength: number;
  workerLastSeenAt: Date | null;
  workerReady: boolean;
  workerHasStalledClaims: boolean;
  workerLastProgressAt: Date | null;
  workerLastSuccessfulJobAt: Date | null;
  workerActiveStages: AdminMemoryStatus["worker"]["activeStages"];
}>;

export type AdminMemoryStatusRepository = Readonly<{
  read(now: Date): Promise<AdminMemoryStatusSnapshot>;
  startRebuild(candidate: AdminMemoryRebuildCandidate): Promise<void>;
  recoverEligible?: (input: Readonly<{ limit: number; now: Date }>) => Promise<number>;
  updateAdmissionTimeout(input: Readonly<{
    expectedVersion: number;
    seconds: number;
    userId: string;
  }>): Promise<boolean>;
}>;

export type AdminMemoryStatusService = Readonly<{
  get(): Promise<AdminMemoryStatus>;
  rebuild(): Promise<AdminMemoryStatus>;
  recover(): Promise<AdminMemoryStatus>;
  updateAdmissionTimeout(input: Readonly<{
    expectedVersion: number;
    seconds: number;
    userId: string;
  }>): Promise<AdminMemoryStatus>;
}>;

export class AdminMemoryStatusServiceError extends Error {
  constructor(readonly code:
    | "memory_admin_rebuild_not_required"
    | "memory_admin_rebuild_unavailable"
    | "memory_admin_recovery_unavailable"
    | "memory_admin_timeout_stale") {
    super(code);
    this.name = "AdminMemoryStatusServiceError";
  }
}

function validDate(value: Date | null | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function checkedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("memory_admin_status_count_invalid");
  }
  return value;
}

function generation(
  generations: readonly number[]
): AdminMemoryStatus["index"]["generation"] {
  const unique = [...new Set(generations.map(checkedCount))].sort((left, right) => left - right);
  if (unique.length === 0) return null;
  return unique.length === 1 ? unique[0]! : "MIXED";
}

function workerRunning(snapshot: AdminMemoryStatusSnapshot, now: Date): boolean {
  if (!snapshot.workerReady || !validDate(snapshot.workerLastSeenAt)) return false;
  const age = now.getTime() - snapshot.workerLastSeenAt.getTime();
  return age >= 0 && age <= ADMIN_MEMORY_WORKER_FRESHNESS_MS;
}

function ageSeconds(value: Date | null | undefined, now: Date): number | null {
  if (!validDate(value)) return null;
  return Math.max(0, Math.floor((now.getTime() - value.getTime()) / 1_000));
}

function workerProjection(
  snapshot: AdminMemoryStatusSnapshot,
  now: Date,
  queueLength: number,
  inProgressCount: number,
  oldestAgeSeconds: number | null
): AdminMemoryStatus["worker"] {
  const lastSeenAgeSeconds = ageSeconds(snapshot.workerLastSeenAt, now);
  const lastProgressAgeSeconds = ageSeconds(snapshot.workerLastProgressAt, now);
  const lastSuccessAgeSeconds = ageSeconds(snapshot.workerLastSuccessfulJobAt, now);
  const evidence = {
    lastProgressAgeSeconds, lastSeenAgeSeconds, lastSuccessAgeSeconds,
    observationWindowSeconds: ADMIN_MEMORY_WORKER_PROGRESS_STALE_MS / 1_000,
    activeStages: snapshot.workerActiveStages
  };
  if (!workerRunning(snapshot, now)) {
    return {
      ...evidence,
      reason: snapshot.workerLastSeenAt && !snapshot.workerReady ? "NOT_READY" : "HEARTBEAT_STALE",
      state: "NOT_RUNNING"
    };
  }
  const hasQueue = queueLength > 0 || inProgressCount > 0;
  const progressStale = lastProgressAgeSeconds === null
    ? oldestAgeSeconds !== null && oldestAgeSeconds >= ADMIN_MEMORY_WORKER_PROGRESS_STALE_MS / 1_000
    : lastProgressAgeSeconds >= ADMIN_MEMORY_WORKER_PROGRESS_STALE_MS / 1_000;
  if (hasQueue && (snapshot.workerHasStalledClaims ||
    snapshot.processing.issues.some(({ reason }) => reason === "STALLED") ||
    (progressStale && inProgressCount > 0))) {
    return {
      ...evidence,
      reason: "QUEUE_STALLED",
      state: "STALLED"
    };
  }
  return {
    ...evidence,
    reason: hasQueue ? "ACTIVE" : "IDLE",
    state: "RUNNING"
  };
}

function project(snapshot: AdminMemoryStatusSnapshot, now: Date): AdminMemoryStatus {
  if (!validDate(now)) throw new Error("memory_admin_status_clock_invalid");
  const queueLength = checkedCount(snapshot.queueLength);
  if (queueLength > 0 && !validDate(snapshot.oldestQueuedAt)) {
    throw new Error("memory_admin_status_queue_invalid");
  }
  const oldestAgeSeconds = queueLength === 0
    ? null
    : Math.max(
        0,
        Math.floor((now.getTime() - snapshot.oldestQueuedAt!.getTime()) / 1_000)
      );
  const running = workerRunning(snapshot, now);
  const ownerCount = checkedCount(snapshot.index.ownerCount);
  const readiness = ownerCount === 0
    ? "NOT_CONFIGURED" as const
    : snapshot.index.rebuilding
      ? "REBUILDING" as const
      : snapshot.index.preparing
        ? "PREPARING" as const
        : snapshot.index.requiresRebuild
          ? "REBUILD_REQUIRED" as const
          : "READY" as const;
  const rebuildState = readiness === "REBUILDING"
    ? "IN_PROGRESS" as const
    : readiness === "REBUILD_REQUIRED"
      ? running && snapshot.index.rebuildCandidates.length > 0
        ? "AVAILABLE" as const
        : "UNAVAILABLE" as const
      : "NOT_REQUIRED" as const;

  return adminMemoryStatusSchema.parse({
    admissionTimeout: snapshot.admissionTimeout,
    processing: snapshot.processing,
    recovery: snapshot.recovery,
    configuredTargets: snapshot.configuredTargets,
    index: {
      generation: generation(snapshot.index.activeGenerations),
      readiness
    },
    queue: { inProgress: checkedCount(snapshot.inProgressCount), length: queueLength, oldestAgeSeconds },
    rebuild: { state: rebuildState },
    worker: workerProjection(
      snapshot,
      now,
      queueLength,
      checkedCount(snapshot.inProgressCount),
      oldestAgeSeconds
    )
  });
}

export function createAdminMemoryStatusService(input: Readonly<{
  now?: () => Date;
  repository: AdminMemoryStatusRepository;
}>): AdminMemoryStatusService {
  const now = input.now ?? (() => new Date());

  return Object.freeze({
    async get() {
      const observedAt = now();
      return project(await input.repository.read(observedAt), observedAt);
    },

    async rebuild() {
      const admittedAt = now();
      const before = await input.repository.read(admittedAt);
      const current = project(before, admittedAt);
      if (current.index.readiness !== "REBUILD_REQUIRED") {
        throw new AdminMemoryStatusServiceError("memory_admin_rebuild_not_required");
      }
      if (current.rebuild.state !== "AVAILABLE") {
        throw new AdminMemoryStatusServiceError("memory_admin_rebuild_unavailable");
      }
      const candidates = before.index.rebuildCandidates.slice(
        0,
        ADMIN_MEMORY_REBUILD_BATCH_SIZE
      );
      let admitted = 0;
      for (const candidate of candidates) {
        try {
          await input.repository.startRebuild(candidate);
          admitted += 1;
        } catch {
          // A concurrent rebuild or configuration change is reconciled by the
          // fresh status read below. No target identity crosses the boundary.
        }
      }
      if (admitted === 0) {
        throw new AdminMemoryStatusServiceError("memory_admin_rebuild_unavailable");
      }
      const observedAt = now();
      return project(await input.repository.read(observedAt), observedAt);
    },

    async recover() {
      const admittedAt = now();
      const before = await input.repository.read(admittedAt);
      const current = project(before, admittedAt);
      if (current.worker.state === "NOT_RUNNING") {
        throw new AdminMemoryStatusServiceError("memory_admin_recovery_unavailable");
      }
      const admitted = await input.repository.recoverEligible?.({
        limit: ADMIN_MEMORY_RECOVERY_BATCH_SIZE,
        now: admittedAt
      }) ?? 0;
      if (admitted === 0) {
        throw new AdminMemoryStatusServiceError("memory_admin_recovery_unavailable");
      }
      const observedAt = now();
      return project(await input.repository.read(observedAt), observedAt);
    },

    async updateAdmissionTimeout(update) {
      if (!Number.isSafeInteger(update.expectedVersion) || update.expectedVersion < 1 ||
        !Number.isSafeInteger(update.seconds) ||
        update.seconds < ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.minSeconds ||
        update.seconds > ADMIN_MEMORY_ADMISSION_TIMEOUT_LIMITS.maxSeconds) {
        throw new Error("memory_admin_timeout_input_invalid");
      }
      const updated = await input.repository.updateAdmissionTimeout(update);
      if (!updated) {
        throw new AdminMemoryStatusServiceError("memory_admin_timeout_stale");
      }
      const observedAt = now();
      return project(await input.repository.read(observedAt), observedAt);
    }
  });
}
