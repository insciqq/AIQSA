import { randomUUID } from "node:crypto";
import {
  Prisma,
  type PrismaClient,
  type WorkspaceSessionState
} from "@prisma/client";
import type {
  ChatWorkspaceState,
  ThreadGeneratedFile
} from "@/lib/contracts/workspace";
import { workspaceModelSupportsTools, type WorkspaceAvailabilityService } from "./availability";
import type { WorkspaceConfig } from "./config";
import { acknowledgeWorkspaceCommandsStopped } from "./executionRegistry";
import { WORKSPACE_OPERATION_LEASE_MS, failWorkspaceExportsForLostDisk, workspaceOperationWhere } from "./sessionOperation";
import { parseWorkspaceOperation, type WorkspaceOperation } from "./operationFence";
import type { WorkspacePolicyRepository } from "./policyRepository";
import type { WorkspaceRuntime, WorkspaceOutputStream } from "./runtime";
import { WorkspaceRuntimeError } from "./runtime";
import { resolveProjectAccess } from "@/lib/server/projects/access";
import { activeModelRunStatuses } from "@/lib/server/runs/prismaRepositoryShared";
import type { StorageAdapter } from "@/lib/server/uploads/storage";

type LockedChat = Readonly<{
  archived: boolean;
  id: string;
  permanentDeletionAt: Date | null;
  projectId: string | null;
  userId: string | null;
}>;

type MutableSession = Readonly<{
  id: string;
  imageRef: string;
  internetEnabled: boolean;
  operationOwner: string | null;
  version: number;
  runtimeSandboxId: string | null;
  sandboxName: string;
  state: WorkspaceSessionState;
}>;

function operationFor(session: MutableSession): WorkspaceOperation {
  return parseWorkspaceOperation({ generation: session.version, owner: session.operationOwner });
}

type AuthorizedScope = Readonly<{
  projectId: string | null;
  userId: string;
}>;

export type WorkspaceLifecycleErrorCode =
  | "workspace_archive_limit_exceeded"
  | "workspace_busy"
  | "workspace_not_started"
  | "workspace_reset_conflict"
  | "workspace_runtime_unavailable"
  | "workspace_session_lost";

export class WorkspaceLifecycleError extends Error {
  readonly code: WorkspaceLifecycleErrorCode;
  readonly status: 404 | 409 | 503;

  constructor(code: WorkspaceLifecycleErrorCode, status: 404 | 409 | 503 = 409) {
    super(code);
    this.code = code;
    this.name = "WorkspaceLifecycleError";
    this.status = status;
  }
}

export type WorkspaceLifecycleService = Readonly<{
  archive(input: Readonly<{ chatId: string; userId: string }>): Promise<ThreadGeneratedFile>;
  reset(input: Readonly<{ chatId: string; userId: string }>): Promise<ChatWorkspaceState>;
  status(input: Readonly<{ chatId: string; userId: string }>): Promise<ChatWorkspaceState>;
}>;

function storageOwner(scope: AuthorizedScope): string {
  return scope.projectId ? `projects/${scope.projectId}` : scope.userId;
}

function validArchive(output: WorkspaceOutputStream, config: WorkspaceConfig): boolean {
  return output.relativePath === "workspace.tar.gz" &&
    output.mimeType === "application/gzip" &&
    Number.isSafeInteger(output.byteSize) &&
    output.byteSize > 0 &&
    output.byteSize <= config.outputTotalMaxBytes &&
    /^[a-f0-9]{64}$/u.test(output.checksum) &&
    /^[a-f0-9]{64}$/u.test(output.opaqueFileId);
}

function runtimeFailure(error: unknown): WorkspaceLifecycleError {
  if (error instanceof WorkspaceLifecycleError) return error;
  if (error instanceof WorkspaceRuntimeError) {
    if (error.code === "workspace_archive_limit_exceeded") {
      return new WorkspaceLifecycleError(error.code);
    }
    if (error.code === "workspace_session_lost") {
      return new WorkspaceLifecycleError(error.code);
    }
  }
  return new WorkspaceLifecycleError("workspace_runtime_unavailable", 503);
}

export function createWorkspaceLifecycleService(input: Readonly<{
  availability: WorkspaceAvailabilityService;
  config: WorkspaceConfig;
  policy: WorkspacePolicyRepository;
  prisma: PrismaClient;
  runtime: WorkspaceRuntime;
  storage: StorageAdapter;
}>): WorkspaceLifecycleService {
  async function authorizedScope(
    tx: Prisma.TransactionClient,
    chat: LockedChat,
    userId: string,
    mutable: boolean
  ): Promise<AuthorizedScope | null> {
    if (chat.permanentDeletionAt || chat.archived) return null;
    if (chat.userId) {
      return chat.userId === userId ? { projectId: null, userId } : null;
    }
    if (!chat.projectId) return null;
    const access = await resolveProjectAccess(tx, {
      minimumRole: mutable ? "CONTRIBUTOR" : "VIEWER",
      projectId: chat.projectId,
      requireActive: mutable,
      userId
    });
    return access ? { projectId: chat.projectId, userId } : null;
  }

  async function lockChat(
    tx: Prisma.TransactionClient,
    chatId: string
  ): Promise<LockedChat | null> {
    const rows = await tx.$queryRaw<LockedChat[]>(Prisma.sql`
      SELECT "id", "userId", "projectId", "archived", "permanentDeletionAt"
      FROM "Chat"
      WHERE "id" = ${chatId}
      FOR UPDATE
    `);
    return rows[0] ?? null;
  }

  async function beginExclusive(
    request: Readonly<{ chatId: string; userId: string }>,
    operation: "archive" | "reset"
  ): Promise<Readonly<{
    cleanupClaimToken: string | null;
    scope: AuthorizedScope;
    session: MutableSession;
  }>> {
    return input.prisma.$transaction(async (tx) => {
      const chat = await lockChat(tx, request.chatId);
      const scope = chat && await authorizedScope(tx, chat, request.userId, true);
      if (!chat || !scope) {
        throw new WorkspaceLifecycleError(
          operation === "reset" ? "workspace_reset_conflict" : "workspace_not_started",
          404
        );
      }
      const activeRuns = await tx.modelRun.count({
        where: { chatId: chat.id, status: { in: activeModelRunStatuses } }
      });
      if (activeRuns > 0) throw new WorkspaceLifecycleError("workspace_busy");
      await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "chatId" = ${chat.id} FOR UPDATE`;
      const session = await tx.workspaceSession.findUnique({ where: { chatId: chat.id } });
      if (!session?.runtimeSandboxId) {
        throw new WorkspaceLifecycleError("workspace_not_started");
      }
      if (session.operationOwner || session.state === "RUNNING" || session.state === "CREATING" || session.state === "DELETING") {
        throw new WorkspaceLifecycleError(
          operation === "reset" ? "workspace_reset_conflict" : "workspace_busy"
        );
      }
      if (operation === "reset") {
        const cleanupClaimToken = randomUUID();
        await tx.workspaceCleanupJob.upsert({
          create: {
            attemptCount: 1,
            claimedAt: new Date(),
            claimToken: cleanupClaimToken,
            lastAttemptAt: new Date(),
            nextAttemptAt: new Date(),
            runtimeSandboxId: session.runtimeSandboxId,
            sandboxName: session.sandboxName,
            state: "RUNNING",
            workspaceSessionId: session.id
          },
          update: {
            attemptCount: { increment: 1 },
            claimedAt: new Date(),
            claimToken: cleanupClaimToken,
            lastAttemptAt: new Date(),
            lastErrorCode: null,
            nextAttemptAt: new Date(),
            runtimeSandboxId: session.runtimeSandboxId,
            sandboxName: session.sandboxName,
            state: "RUNNING"
          },
          where: { workspaceSessionId: session.id }
        });
        const claimed = await tx.workspaceSession.update({
          data: { lastErrorCode: null, state: "DELETING", operationOwner: `reset:${cleanupClaimToken}`,
            operationExpiresAt: new Date(Date.now() + WORKSPACE_OPERATION_LEASE_MS), version: { increment: 1 } },
          where: { id: session.id }
        });
        return { cleanupClaimToken, scope, session: claimed };
      } else {
        const lastActiveAt = new Date();
        const claimed = await tx.workspaceSession.update({
          data: {
            operationOwner: `archive:${randomUUID()}`,
            operationExpiresAt: new Date(lastActiveAt.getTime() + WORKSPACE_OPERATION_LEASE_MS),
            version: { increment: 1 },
            expiresAt: new Date(
              lastActiveAt.getTime() + input.config.retentionSeconds * 1_000
            ),
            lastActiveAt,
            lastErrorCode: "workspace_archive_in_progress",
            state: "CREATING",
            stoppedAt: null
          },
          where: { id: session.id }
        });
        return { cleanupClaimToken: null, scope, session: claimed };
      }
    });
  }

  async function finishArchive(
    session: MutableSession,
    runtimeSandboxId: string,
    errorCode: string | null
  ): Promise<void> {
    if (!input.runtime.retireSessionOperation) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
    await input.runtime.retireSessionOperation({ operation: operationFor(session), runtimeSandboxId, sessionId: session.id });
    const lastActiveAt = new Date();
    await input.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id" = ${session.id} FOR UPDATE`;
    if (!(await tx.workspaceSession.findFirst({
      select: { id: true }, where: { ...workspaceOperationWhere(operationFor(session)), id: session.id, runtimeSandboxId }
    }))) return;
    await acknowledgeWorkspaceCommandsStopped(tx, session.id);
    await tx.workspaceSession.updateMany({
      data: {
        expiresAt: new Date(
          lastActiveAt.getTime() + input.config.retentionSeconds * 1_000
        ),
        lastActiveAt,
        lastErrorCode: errorCode,
        operationOwner: null, operationExpiresAt: null,
        runtimeSandboxId,
        state: "STOPPED",
        stoppedAt: lastActiveAt
      },
      where: { ...workspaceOperationWhere(operationFor(session)), id: session.id, runtimeSandboxId, state: "CREATING" }
    });
    });
  }

  async function readStatus(
    request: Readonly<{ chatId: string; userId: string }>
  ): Promise<ChatWorkspaceState> {
    const access = await input.prisma.chat.findUnique({
      select: {
        archived: true,
        defaultProviderModel: {
          select: {
            activeConfig: true,
            activeVersion: true,
            enabled: true,
            modelClass: true
          }
        },
        permanentDeletionAt: true,
        projectId: true,
        userId: true,
        workspaceEnabled: true,
        workspaceSession: {
          select: { internetEnabled: true, state: true }
        }
      },
      where: { id: request.chatId }
    });
    if (!access || access.archived || access.permanentDeletionAt) {
      throw new WorkspaceLifecycleError("workspace_not_started", 404);
    }
    const authorized = access.userId === request.userId ||
      access.userId === null && access.projectId !== null &&
        await resolveProjectAccess(input.prisma, {
          projectId: access.projectId,
          userId: request.userId
        });
    if (!authorized) throw new WorkspaceLifecycleError("workspace_not_started", 404);
    const snapshot = await input.availability.snapshot();
    return input.availability.project(snapshot, {
      enabled: access.workspaceEnabled,
      modelSupportsTools: workspaceModelSupportsTools(access.defaultProviderModel),
      session: access.workspaceSession
    });
  }

  return {
    async archive(request) {
      const { scope, session } = await beginExclusive(request, "archive");
      const operation = operationFor(session);
      let runtimeSandboxId = session.runtimeSandboxId!;
      try {
        const connected = await input.runtime.ensureSession({
          operation,
          cpus: input.config.cpus,
          diskMiB: input.config.diskMiB,
          imageRef: session.imageRef,
          internetEnabled: session.internetEnabled,
          memoryMiB: input.config.memoryMiB,
          runtimeSandboxId,
          sandboxName: session.sandboxName,
          sessionId: session.id
        });
        if (connected.runtimeSandboxId !== runtimeSandboxId) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        runtimeSandboxId = connected.runtimeSandboxId;
        const output = await input.runtime.createProjectArchive({
          operation,
          runtimeSandboxId,
          sessionId: session.id
        });
        if (!validArchive(output, input.config)) {
          throw new WorkspaceRuntimeError("workspace_archive_limit_exceeded");
        }
        if (!input.storage.putObjectStream || !input.storage.inspectObject) {
          throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
        }
        const attachmentId = randomUUID();
        const storageKey =
          `${storageOwner(scope)}/workspace-exports/${attachmentId}-${output.checksum}`;
        await input.storage.putObjectStream({
          body: output.body,
          byteSize: output.byteSize,
          checksum: output.checksum,
          contentType: output.mimeType,
          storageKey
        });
        const stored = await input.storage.inspectObject(storageKey, {
          maxBytes: output.byteSize,
          sampleBytes: 1
        });
        if (stored.byteSize !== output.byteSize || stored.checksum !== output.checksum) {
          await input.storage.deleteObject(storageKey).catch(() => undefined);
          throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
        }
        try {
          if (!input.runtime.retireSessionOperation) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
          await input.runtime.retireSessionOperation({ operation, runtimeSandboxId, sessionId: session.id });
          await input.prisma.$transaction(async (tx) => {
            const chat = await lockChat(tx, request.chatId);
            const currentScope = chat && await authorizedScope(tx, chat, request.userId, true);
            if (!chat || !currentScope ||
              currentScope.projectId !== scope.projectId ||
              currentScope.userId !== scope.userId) {
              throw new WorkspaceLifecycleError("workspace_not_started", 404);
            }
            await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id" = ${session.id} FOR UPDATE`;
            const currentSession = await tx.workspaceSession.findFirst({
              select: { id: true, state: true },
              where: { ...workspaceOperationWhere(operation), chatId: request.chatId, runtimeSandboxId }
            });
            if (!currentSession || currentSession.id !== session.id ||
              currentSession.state !== "CREATING") {
              throw new WorkspaceLifecycleError("workspace_busy");
            }
            const projectUploader = scope.projectId
              ? await tx.user.findUnique({
                  select: { displayName: true },
                  where: { id: request.userId }
                })
              : null;
            if (scope.projectId && !projectUploader) {
              throw new WorkspaceLifecycleError("workspace_not_started", 404);
            }
            await tx.attachment.create({
              data: {
                byteSize: output.byteSize,
                chatId: request.chatId,
                checksum: output.checksum,
                extractedText: null,
                fileName: "workspace.tar.gz",
                id: attachmentId,
                kind: "file",
                metadata: {} satisfies Prisma.InputJsonValue,
                mimeType: output.mimeType,
                origin: "WORKSPACE_EXPORT",
                processingErrorCode: null,
                ...(scope.projectId
                  ? {
                      projectId: scope.projectId,
                      uploaderDisplayName: projectUploader!.displayName,
                      uploaderUserId: request.userId
                    }
                  : { userId: request.userId }),
                status: "ready",
                storageKey
              }
            });
            const lastActiveAt = new Date();
            await acknowledgeWorkspaceCommandsStopped(tx, session.id);
            await tx.workspaceSession.update({
              data: {
                expiresAt: new Date(
                  lastActiveAt.getTime() + input.config.retentionSeconds * 1_000
                ),
                lastActiveAt,
                lastErrorCode: null,
                operationOwner: null, operationExpiresAt: null,
                runtimeSandboxId,
                state: "STOPPED",
                stoppedAt: lastActiveAt
              },
              where: { id: session.id }
            });
          });
        } catch (error) {
          await input.storage.deleteObject(storageKey).catch(() => undefined);
          throw error;
        }
        return {
          attachmentId,
          byteSize: output.byteSize,
          fileName: "workspace.tar.gz",
          mimeType: output.mimeType,
          relativePath: output.relativePath
        };
      } catch (error) {
        const failure = runtimeFailure(error);
        await finishArchive(session, runtimeSandboxId, failure.code).catch(() => undefined);
        throw failure;
      }
    },
    async reset(request) {
      const { cleanupClaimToken, session } = await beginExclusive(request, "reset");
      const operation = operationFor(session);
      try {
        if (!input.runtime.claimSessionOperation || !input.runtime.retireSessionOperation) {
          throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
        }
        await input.runtime.claimSessionOperation({ operation, runtimeSandboxId: session.runtimeSandboxId, sessionId: session.id });
        await input.runtime.removeSession({
          operation,
          runtimeSandboxId: session.runtimeSandboxId,
          sessionId: session.id
        });
        await input.runtime.retireSessionOperation({ operation, runtimeSandboxId: session.runtimeSandboxId, sessionId: session.id });
        const policy = await input.policy.read();
        await input.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id" = ${session.id} FOR UPDATE`;
          const owned = await tx.workspaceSession.findFirst({
            select: { id: true }, where: { ...workspaceOperationWhere(operation), id: session.id, runtimeSandboxId: session.runtimeSandboxId }
          });
          if (!owned) throw new WorkspaceLifecycleError("workspace_reset_conflict");
          const job = await tx.workspaceCleanupJob.findUnique({
            select: { claimToken: true, id: true, state: true },
            where: { workspaceSessionId: session.id }
          });
          if (
            !job ||
            job.claimToken !== cleanupClaimToken ||
            job.state !== "RUNNING"
          ) {
            throw new WorkspaceLifecycleError("workspace_reset_conflict");
          }
          const lastActiveAt = new Date();
          await acknowledgeWorkspaceCommandsStopped(tx, session.id);
          await failWorkspaceExportsForLostDisk(tx, session.id);
          const settled = await tx.workspaceSession.updateMany({
            data: {
              expiresAt: new Date(
                lastActiveAt.getTime() + input.config.retentionSeconds * 1_000
              ),
              imageRef: input.config.imageRef,
              internetEnabled: policy.internetEnabled,
              lastActiveAt,
              lastErrorCode: null,
              operationOwner: null, operationExpiresAt: null,
              policyRevision: policy.version,
              runtimeSandboxId: null,
              state: "PENDING",
              stoppedAt: null,
              version: { increment: 1 }
            },
            where: {
              ...workspaceOperationWhere(operation),
              id: session.id,
              runtimeSandboxId: session.runtimeSandboxId,
              state: "DELETING"
            }
          });
          if (settled.count !== 1) {
            throw new WorkspaceLifecycleError("workspace_reset_conflict");
          }
          await tx.workspaceCleanupJob.delete({ where: { id: job.id } });
        });
        return readStatus(request);
      } catch (error) {
        await input.prisma.$transaction(async (tx) => {
          await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id" = ${session.id} FOR UPDATE`;
          await tx.workspaceCleanupJob.updateMany({
            data: {
              attemptCount: { increment: 1 },
              claimedAt: null,
              claimToken: null,
              lastAttemptAt: new Date(),
              lastErrorCode: "workspace_reset_conflict",
              nextAttemptAt: new Date(Date.now() + 30_000),
              state: "FAILED"
            },
            where: {
              claimToken: cleanupClaimToken,
              workspaceSessionId: session.id
            }
          });
          await tx.workspaceSession.updateMany({
            data: { lastErrorCode: "workspace_reset_conflict", state: "DELETING" },
            where: { ...workspaceOperationWhere(operation), id: session.id, state: "DELETING" }
          });
        }).catch(() => undefined);
        throw error instanceof WorkspaceLifecycleError
          ? error
          : new WorkspaceLifecycleError("workspace_reset_conflict");
      }
    },
    status: readStatus
  };
}
