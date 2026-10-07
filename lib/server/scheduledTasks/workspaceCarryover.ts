import { Prisma, type PrismaClient } from "@prisma/client";
import type { StorageAdapter } from "../uploads/storage";
import { captureWorkspaceProjectSeed } from "../workspace/projectSeedCapture";
import type { WorkspaceRuntime } from "../workspace/runtime";
import { WORKSPACE_OPERATION_LEASE_MS } from "../workspace/sessionOperation";
import { SCHEDULED_TASK_ADMISSION_LEASE_MS } from "./runnerPolicy";

/**
 * The Workspace half of a same-chat task's monthly rotation: before the new
 * chat's first run is admitted, the `/workspace/project` of the chat it
 * leaves is captured into a private continuation seed (caches outside
 * `project/` stay behind) that the run's admission transfers to the new chat
 * and its first Workspace start restores before anything runs.
 *
 * - `none`: the old chat has no disk (never used, expired or lost): nothing to
 *   carry, the new chat starts empty as any lost disk would.
 * - `ready`: the seed to transfer.
 * - `busy`: the old chat has a run in progress (the owner's): retried like a busy chat.
 * - `retry`: a transient refusal (session busy with another operation, runtime
 *   or storage trouble): retried within the occurrence window, then a failure.
 * - `failed`: a project that cannot be archived (too large, invalid): the
 *   occurrence fails visibly; nothing runs against an empty project.
 */
export type ScheduledWorkspaceCarryoverResult =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "ready"; seedId: string }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "retry" }>
  | Readonly<{ kind: "failed" }>;

export type ScheduledWorkspaceCarryover = (input: Readonly<{
  sourceChatId: string;
  taskId: string;
  userId: string;
}>) => Promise<ScheduledWorkspaceCarryoverResult>;

/** Failures a retry cannot fix: the project itself cannot become a seed. */
const PERSISTENT_CAPTURE_FAILURES: ReadonlySet<string> = new Set([
  "workspace_archive_invalid", "workspace_archive_limit_exceeded", "workspace_output_limit_exceeded"
]);
/** A copy that stalls longer leaves the rest of the admission lease to the run's own admission. */
const CAPTURE_TIMEOUT_MS = 120_000;
const ACTIVE_RUN_STATUSES = ["preparing", "queued", "streaming", "in_progress"] as const;

/** The session operation owner of a rotation's capture; maintenance recovers it like any expired owner. */
export function scheduledCarryoverOperationOwner(seedId: string): string {
  return `scheduled-carryover:${seedId}`;
}

type Reservation =
  | Readonly<{ kind: "none" | "busy" | "retry" }>
  | Readonly<{ generation: number; kind: "reserved"; runtimeSandboxId: string; seedId: string; sessionId: string }>;

export function createPrismaScheduledWorkspaceCarryover(deps: Readonly<{
  clock?: () => Date;
  prisma: PrismaClient;
  runtime?: WorkspaceRuntime;
  storage?: StorageAdapter;
}>): ScheduledWorkspaceCarryover {
  const clock = deps.clock ?? (() => new Date());
  return async ({ sourceChatId, taskId, userId }) => {
    const now = clock();
    const reservation = await deps.prisma.$transaction(async (tx): Promise<Reservation> => {
      // Chat before session, the order run admission takes them.
      const [chat] = await tx.$queryRaw<Array<{ permanentDeletionAt: Date | null; userId: string | null }>>(Prisma.sql`
        SELECT "userId", "permanentDeletionAt" FROM "Chat" WHERE "id" = ${sourceChatId} FOR UPDATE
      `);
      if (!chat || chat.userId !== userId || chat.permanentDeletionAt) return { kind: "none" };
      if (await tx.modelRun.count({ where: { chatId: sourceChatId, status: { in: [...ACTIVE_RUN_STATUSES] } } }) > 0) {
        return { kind: "busy" };
      }
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "WorkspaceSession" WHERE "chatId" = ${sourceChatId} FOR UPDATE`);
      const session = await tx.workspaceSession.findUnique({ where: { chatId: sourceChatId } });
      // No disk, or one its retention is already removing: nothing survives to carry.
      if (!session?.runtimeSandboxId || session.state === "DELETING") return { kind: "none" };
      // A disk this process cannot reach, or one busy with another operation, waits.
      if (!deps.runtime || !deps.storage) return { kind: "retry" };
      if (session.operationOwner && (!session.operationExpiresAt || session.operationExpiresAt > now)) return { kind: "retry" };
      // An earlier attempt's copy still in flight waits; a settled one that never reached the new chat goes.
      const earlier = await tx.chatContinuationWorkspaceSeed.findMany({
        select: { id: true, leaseExpiresAt: true, status: true, storageKey: true },
        where: { newChatId: null, scheduledTaskId: taskId, status: { in: ["CAPTURING", "READY", "FAILED"] } }
      });
      if (earlier.some((seed) => seed.status === "CAPTURING" && seed.leaseExpiresAt !== null && seed.leaseExpiresAt > now)) {
        return { kind: "retry" };
      }
      for (const seed of earlier) {
        await tx.chatContinuationWorkspaceSeed.update({ where: { id: seed.id }, data: {
          failureCode: seed.status === "FAILED" ? undefined : "workspace_operation_interrupted", leaseExpiresAt: null, leaseToken: null,
          status: "ABANDONED"
        } });
        if (seed.storageKey) {
          await tx.attachmentDeletionJob.upsert({ where: { storageKey: seed.storageKey }, create: { storageKey: seed.storageKey }, update: {} });
        }
      }
      const seed = await tx.chatContinuationWorkspaceSeed.create({ data: {
        leaseExpiresAt: new Date(now.getTime() + WORKSPACE_OPERATION_LEASE_MS), scheduledTaskId: taskId, sourceChatId,
        status: "CAPTURING"
      } });
      const generation = session.version + 1;
      // Advance the durable generation before entering the runtime fence, as a continuation does.
      const reserved = await tx.workspaceSession.updateMany({
        where: { id: session.id, version: session.version, OR: [{ operationOwner: null }, { operationExpiresAt: { lte: now } }] },
        data: { operationExpiresAt: new Date(now.getTime() + WORKSPACE_OPERATION_LEASE_MS),
          operationOwner: scheduledCarryoverOperationOwner(seed.id), version: generation }
      });
      if (reserved.count !== 1) throw new CarryoverBusyError();
      return { generation, kind: "reserved", runtimeSandboxId: session.runtimeSandboxId, seedId: seed.id, sessionId: session.id };
    }).catch((error: unknown) => {
      if (error instanceof CarryoverBusyError) return { kind: "retry" } as const;
      throw error;
    });
    if (reservation.kind !== "reserved" || !deps.runtime || !deps.storage) {
      return reservation.kind === "reserved" ? { kind: "retry" } : reservation;
    }
    const captured = await captureWorkspaceProjectSeed({
      client: deps.prisma, generation: reservation.generation, owner: scheduledCarryoverOperationOwner(reservation.seedId),
      // The seed waits for its transfer as long as an admission attempt may take.
      readyLeaseExpiresAt: new Date(clock().getTime() + SCHEDULED_TASK_ADMISSION_LEASE_MS), runtime: deps.runtime,
      runtimeSandboxId: reservation.runtimeSandboxId, seedId: reservation.seedId, sessionId: reservation.sessionId,
      signal: AbortSignal.timeout(CAPTURE_TIMEOUT_MS), storage: deps.storage
    });
    if (captured.kind === "ready") return { kind: "ready", seedId: reservation.seedId };
    if (captured.kind === "failed" && PERSISTENT_CAPTURE_FAILURES.has(captured.failureCode)) return { kind: "failed" };
    return { kind: "retry" };
  };
}

class CarryoverBusyError extends Error {
  constructor() {
    super("scheduled_workspace_carryover_busy");
    this.name = "CarryoverBusyError";
  }
}
