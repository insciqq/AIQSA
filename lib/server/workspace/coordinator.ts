import { createHash, randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import type { ThreadGeneratedFile } from "@/lib/contracts/workspace";
import {
  isRetryableWorkspaceExportErrorCode,
  isSafeWorkspaceRelativePath,
  WORKSPACE_EXEC_SESSION_TOOL_NAMES,
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  WORKSPACE_PERMANENT_EXPORT_ERROR_CODES,
  workspaceAttachmentPath,
  workspaceMessageManifestPath,
  workspaceToolIsAllowed
} from "@/lib/domain/workspace";
import { uploadFormatForExtension, type UploadKind } from "@/lib/domain/uploadFormats";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import type { NormalizedRunWorkspace } from "@/lib/server/providers/types";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "@/lib/server/tools/types";
import {
  getStoredObjectStream,
  type StorageAdapter
} from "@/lib/server/uploads/storage";
import { resolveProjectAccess } from "@/lib/server/projects/access";
import type { WorkspaceConfig } from "./config";
import {
  WORKSPACE_EXECUTION_OPEN_STATES,
  type WorkspaceExecutionRegistry
} from "./executionRegistry";
import { quiesceWorkspaceExecutions } from "./quiescence";
import type {
  WorkspaceAttachmentStream,
  WorkspaceBoundTool,
  WorkspaceOutputStream,
  WorkspaceRuntime,
  WorkspaceToolResult
} from "./runtime";
import { WorkspaceRuntimeError } from "./runtime";
import { workspaceRunTools } from "./admission";
import {
  namespacedWorkspaceToolName,
  workspaceToolNameFromNamespaced
} from "./toolCatalog";

type WorkspaceAttachmentRecord = Readonly<{
  attachmentId: string;
  byteSize: number;
  checksum: string;
  fileName: string;
  kind: "document" | "file" | "image" | "pdf";
  messageId: string;
  mimeType: string;
  storageKey: string;
}>;

export type WorkspaceExecutionBinding = Readonly<{
  assistantMessageId: string;
  chatId: string;
  imageRef: string;
  internetEnabled: boolean;
  mcpVersion: string;
  outputDirectory: string;
  policyRevision: number;
  projectId: string | null;
  runId: string;
  runtimeSandboxId: string | null;
  runtimeVersion: string;
  sandboxName: string;
  sessionId: string;
  sessionState: string;
  toolCatalogHash: string;
  toolDefinitions: readonly WorkspaceBoundTool[];
  userId: string;
}>;

/**
 * Result of one atomic export claim. Exactly one worker owns an `EXPORTING`
 * binding at a time through a bounded lease; `busy` means another live lease
 * exists, `complete` returns the settled files, and `failed` marks a permanent
 * error that retries must not repeat.
 */
export type WorkspaceExportClaim =
  | Readonly<{ status: "busy" }>
  | Readonly<{ status: "claimed"; token: string }>
  | Readonly<{ status: "complete" }>
  | Readonly<{ code: string; status: "failed" }>;

/** Lease window for one export attempt; renewed before every long step. */
export const WORKSPACE_EXPORT_LEASE_MS = 120_000;
/** Background recovery gives up on a binding after this many attempts. */
export const WORKSPACE_EXPORT_MAX_ATTEMPTS = 20;
/** Completed runs younger than this are left to their own live finalize. */
export const WORKSPACE_EXPORT_RECOVERY_GRACE_MS = 30_000;

export type WorkspaceCoordinatorRepository = Readonly<{
  /**
   * Accepted `sandbox_exec_start` calls that never settled and own no
   * registry row: the process may be running, so only a VM stop proves
   * quiescence.
   */
  ambiguousExecutionStarts(input: Readonly<{ runId: string }>): Promise<number>;
  attachments(binding: WorkspaceExecutionBinding): Promise<readonly WorkspaceAttachmentRecord[]>;
  binding(input: Readonly<{ runId: string; userId: string }>): Promise<WorkspaceExecutionBinding | null>;
  claimExport(input: Readonly<{
    leaseMs: number;
    runId: string;
    sessionId: string;
  }>): Promise<WorkspaceExportClaim>;
  /**
   * Same atomic claim for background recovery, taken under the session row
   * lock and only while the chat has no active run, so a retry can never
   * overlap a new mutating turn on the same sandbox (admission holds the
   * mirror-image check against a live lease).
   */
  claimExportForRecovery(input: Readonly<{
    leaseMs: number;
    runId: string;
    sessionId: string;
  }>): Promise<WorkspaceExportClaim>;
  /**
   * Completed runs whose export is still owed: pending, retryably failed, or
   * left EXPORTING by a worker whose lease expired. Bounded and oldest-first.
   */
  exportRecoveryCandidates(input: Readonly<{
    limit: number;
    staleBefore: Date;
  }>): Promise<readonly Readonly<{ runId: string; userId: string }>[]>;
  generatedFiles(input: Readonly<{ runId: string; userId: string }>): Promise<readonly ThreadGeneratedFile[]>;
  markExportComplete(input: Readonly<{
    runId: string;
    sessionId: string;
    token: string;
  }>): Promise<boolean>;
  markExportFailed(input: Readonly<{
    code: string;
    runId: string;
    sessionId: string;
    token: string;
  }>): Promise<boolean>;
  renewExportLease(input: Readonly<{
    leaseMs: number;
    runId: string;
    sessionId: string;
    token: string;
  }>): Promise<boolean>;
  markSessionFailed(input: Readonly<{ code: string; sessionId: string }>): Promise<void>;
  markSessionLost(input: Readonly<{
    runtimeSandboxId: string;
    sessionId: string;
  }>): Promise<boolean>;
  markSessionRunning(input: Readonly<{
    expiresAt: Date;
    lastActiveAt: Date;
    runtimeSandboxId: string;
    sessionId: string;
  }>): Promise<boolean>;
  markSessionStarting(input: Readonly<{
    expiresAt: Date;
    lastActiveAt: Date;
    sessionId: string;
  }>): Promise<boolean>;
  markSessionReady(input: Readonly<{
    expiresAt: Date;
    lastActiveAt: Date;
    sessionId: string;
  }>): Promise<void>;
  settleOutput(input: Readonly<{
    binding: WorkspaceExecutionBinding;
    output: Omit<WorkspaceOutputStream, "body" | "opaqueFileId">;
    storageKey: string;
  }>): Promise<ThreadGeneratedFile>;
  /**
   * Guarded terminal transition of a session that no run uses any more.
   * Never touches DELETING, FAILED, or an in-progress archive/idle-stop marker,
   * and never extends the activity window.
   */
  settleSession(input: Readonly<{
    outcome: "pending" | "ready" | "stopped";
    sessionId: string;
  }>): Promise<boolean>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolDefinitions(value: unknown): WorkspaceBoundTool[] | null {
  if (!Array.isArray(value) || value.length !== WORKSPACE_MCP_TOOL_ALLOWLIST.length) return null;
  const tools = value.map((entry): WorkspaceBoundTool | null => {
    if (
      !isRecord(entry) ||
      typeof entry.description !== "string" ||
      !entry.description.trim() ||
      entry.description.length > 4_096 ||
      !isRecord(entry.inputSchema) ||
      typeof entry.namespacedName !== "string" ||
      !entry.namespacedName.trim() ||
      entry.namespacedName.length > 256 ||
      typeof entry.originalName !== "string" ||
      !workspaceToolIsAllowed(entry.originalName) ||
      entry.namespacedName !== namespacedWorkspaceToolName(entry.originalName)
    ) return null;
    return entry as WorkspaceBoundTool;
  });
  if (tools.some((tool) => tool === null)) return null;
  const parsed = tools as WorkspaceBoundTool[];
  const originalNames = new Set(parsed.map((tool) => tool.originalName));
  return originalNames.size === WORKSPACE_MCP_TOOL_ALLOWLIST.length &&
    WORKSPACE_MCP_TOOL_ALLOWLIST.every((name) => originalNames.has(name))
    ? parsed
    : null;
}

function outputKind(fileName: string): UploadKind {
  return uploadFormatForExtension(fileName, "workspace")?.kind ?? "file";
}

function generatedFile(row: Readonly<{
  attachment: { byteSize: number; fileName: string; id: string; mimeType: string };
  relativePath: string;
}>): ThreadGeneratedFile {
  return {
    attachmentId: row.attachment.id,
    byteSize: row.attachment.byteSize,
    fileName: row.attachment.fileName,
    mimeType: row.attachment.mimeType,
    relativePath: row.relativePath
  };
}

export function createPrismaWorkspaceCoordinatorRepository(
  prisma: PrismaClient
): WorkspaceCoordinatorRepository {
  async function loadBinding(
    runId: string,
    userId: string
  ): Promise<WorkspaceExecutionBinding | null> {
    const run = await prisma.modelRun.findUnique({
      select: {
        assistantMessageId: true,
        chat: { select: { projectId: true, userId: true } },
        chatId: true,
        id: true,
        userId: true,
        workspaceRunBinding: {
          select: {
            imageRef: true,
            internetEnabled: true,
            mcpVersion: true,
            outputDirectory: true,
            policyRevision: true,
            runtimeVersion: true,
            toolCatalogHash: true,
            toolDefinitions: true,
            workspaceSession: {
              select: {
                id: true,
                runtimeSandboxId: true,
                sandboxName: true,
                state: true
              }
            }
          }
        }
      },
      where: { id: runId }
    });
    if (!run || run.userId !== userId || !run.assistantMessageId || !run.workspaceRunBinding) {
      return null;
    }
    if (run.chat.projectId) {
      const access = await resolveProjectAccess(prisma, {
        minimumRole: "CONTRIBUTOR",
        projectId: run.chat.projectId,
        requireActive: true,
        userId
      });
      if (!access) return null;
    } else if (run.chat.userId !== userId) {
      return null;
    }
    const definitions = toolDefinitions(run.workspaceRunBinding.toolDefinitions);
    if (
      !definitions ||
      hashCanonicalMcpValue(definitions) !== run.workspaceRunBinding.toolCatalogHash
    ) return null;
    const session = run.workspaceRunBinding.workspaceSession;
    return {
      assistantMessageId: run.assistantMessageId,
      chatId: run.chatId,
      imageRef: run.workspaceRunBinding.imageRef,
      internetEnabled: run.workspaceRunBinding.internetEnabled,
      mcpVersion: run.workspaceRunBinding.mcpVersion,
      outputDirectory: run.workspaceRunBinding.outputDirectory,
      policyRevision: run.workspaceRunBinding.policyRevision,
      projectId: run.chat.projectId,
      runId: run.id,
      runtimeSandboxId: session.runtimeSandboxId,
      runtimeVersion: run.workspaceRunBinding.runtimeVersion,
      sandboxName: session.sandboxName,
      sessionId: session.id,
      sessionState: session.state,
      toolCatalogHash: run.workspaceRunBinding.toolCatalogHash,
      toolDefinitions: definitions,
      userId: run.userId
    };
  }

  return {
    async ambiguousExecutionStarts({ runId }) {
      return prisma.modelRunToolCall.count({
        where: {
          state: { in: ["pending", "running"] },
          toolName: { contains: "sandbox_exec_start" },
          workspaceExecution: { is: null },
          workspaceRunBindingId: runId
        }
      });
    },
    async binding({ runId, userId }) {
      return loadBinding(runId, userId);
    },
    async attachments(binding) {
      const rows = await prisma.attachment.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          byteSize: true,
          checksum: true,
          fileName: true,
          id: true,
          kind: true,
          messageId: true,
          mimeType: true,
          storageKey: true
        },
        where: {
          chatId: binding.chatId,
          checksum: { not: null },
          messageId: { not: null },
          origin: "USER_UPLOAD",
          ...(binding.projectId
            ? { projectId: binding.projectId }
            : { projectId: null, userId: binding.userId })
        }
      });
      return rows.flatMap((row) =>
        row.checksum && row.messageId &&
        (row.kind === "document" || row.kind === "file" || row.kind === "image" || row.kind === "pdf")
          ? [{
              attachmentId: row.id,
              byteSize: row.byteSize,
              checksum: row.checksum,
              fileName: row.fileName,
              kind: row.kind,
              messageId: row.messageId,
              mimeType: row.mimeType,
              storageKey: row.storageKey
            }]
          : []
      );
    },
    async generatedFiles({ runId, userId }) {
      const binding = await loadBinding(runId, userId);
      if (!binding) return [];
      const rows = await prisma.workspaceRunOutput.findMany({
        orderBy: [{ relativePath: "asc" }, { id: "asc" }],
        select: {
          attachment: {
            select: { byteSize: true, fileName: true, id: true, mimeType: true }
          },
          relativePath: true
        },
        where: { workspaceRunBindingId: runId }
      });
      return rows.map(generatedFile);
    },
    async claimExport({ leaseMs, runId, sessionId }) {
      return claimExportWith(prisma, { leaseMs, runId, sessionId });
    },
    async claimExportForRecovery({ leaseMs, runId, sessionId }) {
      return prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ chatId: string }>>(Prisma.sql`
          SELECT "chatId" FROM "WorkspaceSession" WHERE "id" = ${sessionId} FOR UPDATE
        `);
        const chatId = locked[0]?.chatId;
        if (!chatId) throw new WorkspaceRuntimeError("workspace_output_export_failed");
        const active = await tx.modelRun.count({
          where: { chatId, status: { in: [...ACTIVE_RUN_STATUSES] } }
        });
        if (active > 0) return { status: "busy" as const };
        return claimExportWith(tx, { leaseMs, runId, sessionId });
      });
    },
    async exportRecoveryCandidates({ limit, staleBefore }) {
      const rows = await prisma.workspaceRunBinding.findMany({
        orderBy: [{ updatedAt: "asc" }, { modelRunId: "asc" }],
        select: { modelRun: { select: { userId: true } }, modelRunId: true },
        take: Math.max(1, Math.min(limit, 100)),
        where: {
          exportAttemptCount: { lt: WORKSPACE_EXPORT_MAX_ATTEMPTS },
          modelRun: { status: "complete" },
          updatedAt: { lte: staleBefore },
          OR: [
            { exportState: "PENDING" },
            {
              exportState: "FAILED",
              OR: [
                { lastExportErrorCode: null },
                { lastExportErrorCode: { notIn: [...WORKSPACE_PERMANENT_EXPORT_ERROR_CODES] } }
              ]
            },
            {
              exportState: "EXPORTING",
              OR: [
                { exportLeaseExpiresAt: null },
                { exportLeaseExpiresAt: { lte: new Date() } }
              ]
            }
          ]
        }
      });
      return rows.map((row) => ({ runId: row.modelRunId, userId: row.modelRun.userId }));
    },
    async markExportComplete({ runId, sessionId, token }) {
      const updated = await prisma.workspaceRunBinding.updateMany({
        data: {
          exportCompletedAt: new Date(),
          exportLeaseExpiresAt: null,
          exportLeaseToken: null,
          exportState: "COMPLETE",
          lastExportErrorCode: null
        },
        where: {
          exportLeaseToken: token,
          exportState: "EXPORTING",
          modelRunId: runId,
          workspaceSessionId: sessionId
        }
      });
      return updated.count === 1;
    },
    async markExportFailed({ code, runId, sessionId, token }) {
      // Only the current lease owner may fail its own attempt, and a settled
      // COMPLETE binding is never downgraded by a late worker.
      const updated = await prisma.workspaceRunBinding.updateMany({
        data: {
          exportLeaseExpiresAt: null,
          exportLeaseToken: null,
          exportState: "FAILED",
          lastExportErrorCode: code.slice(0, 64)
        },
        where: {
          exportLeaseToken: token,
          exportState: "EXPORTING",
          modelRunId: runId,
          workspaceSessionId: sessionId
        }
      });
      return updated.count === 1;
    },
    async renewExportLease({ leaseMs, runId, sessionId, token }) {
      const updated = await prisma.workspaceRunBinding.updateMany({
        data: { exportLeaseExpiresAt: new Date(Date.now() + leaseMs) },
        where: {
          exportLeaseToken: token,
          exportState: "EXPORTING",
          modelRunId: runId,
          workspaceSessionId: sessionId
        }
      });
      return updated.count === 1;
    },
    async markSessionFailed({ code, sessionId }) {
      await prisma.workspaceSession.updateMany({
        data: { lastErrorCode: code.slice(0, 64), state: "FAILED" },
        where: { id: sessionId, state: { not: "DELETING" } }
      });
    },
    async markSessionLost({ runtimeSandboxId, sessionId }) {
      const updated = await prisma.workspaceSession.updateMany({
        data: {
          lastErrorCode: "workspace_session_lost",
          runtimeSandboxId: null,
          state: "FAILED",
          version: { increment: 1 }
        },
        where: {
          id: sessionId,
          runtimeSandboxId,
          state: { not: "DELETING" }
        }
      });
      return updated.count === 1;
    },
    async markSessionRunning({ expiresAt, lastActiveAt, runtimeSandboxId, sessionId }) {
      const updated = await prisma.workspaceSession.updateMany({
        data: {
          expiresAt,
          lastActiveAt,
          lastErrorCode: null,
          runtimeSandboxId,
          state: "RUNNING",
          stoppedAt: null
        },
        where: {
          id: sessionId,
          OR: [
            { runtimeSandboxId: null },
            { runtimeSandboxId }
          ],
          state: { not: "DELETING" }
        }
      });
      return updated.count === 1;
    },
    async markSessionStarting({ expiresAt, lastActiveAt, sessionId }) {
      const updated = await prisma.workspaceSession.updateMany({
        data: {
          expiresAt,
          lastActiveAt,
          lastErrorCode: null,
          state: "CREATING",
          stoppedAt: null
        },
        where: { id: sessionId, state: { not: "DELETING" } }
      });
      return updated.count === 1;
    },
    async markSessionReady({ expiresAt, lastActiveAt, sessionId }) {
      await prisma.workspaceSession.updateMany({
        data: { expiresAt, lastActiveAt, state: "READY", stoppedAt: null },
        where: { id: sessionId, state: { in: ["CREATING", "RUNNING", "READY"] } }
      });
    },
    async settleSession({ outcome, sessionId }) {
      const updated = await prisma.workspaceSession.updateMany({
        data: outcome === "stopped"
          ? { state: "STOPPED", stoppedAt: new Date() }
          : { state: outcome === "ready" ? "READY" : "PENDING", stoppedAt: null },
        where: {
          id: sessionId,
          lastErrorCode: null,
          runtimeSandboxId: outcome === "pending" ? null : { not: null },
          state: { in: outcome === "stopped" ? ["CREATING", "RUNNING", "READY"] : ["CREATING", "RUNNING"] }
        }
      });
      return updated.count === 1;
    },
    async settleOutput({ binding, output, storageKey }) {
      if (!isSafeWorkspaceRelativePath(output.relativePath)) {
        throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
      }
      const existingOutput = () => prisma.workspaceRunOutput.findUnique({
        include: {
          attachment: {
            select: { byteSize: true, fileName: true, id: true, mimeType: true }
          }
        },
        where: {
          workspaceRunBindingId_relativePath: {
            relativePath: output.relativePath,
            workspaceRunBindingId: binding.runId
          }
        }
      });
      const reuse = (existing: NonNullable<Awaited<ReturnType<typeof existingOutput>>>) => {
        // Same path with different bytes means the output changed after it was
        // settled: fail closed instead of silently replacing a delivered file.
        if (existing.byteSize !== output.byteSize || existing.checksum !== output.checksum) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        return generatedFile(existing);
      };
      try {
        return await prisma.$transaction(async (tx) => {
        const existing = await tx.workspaceRunOutput.findUnique({
          include: {
            attachment: {
              select: { byteSize: true, fileName: true, id: true, mimeType: true }
            }
          },
          where: {
            workspaceRunBindingId_relativePath: {
              relativePath: output.relativePath,
              workspaceRunBindingId: binding.runId
            }
          }
        });
        if (existing) return reuse(existing);
        const projectUploader = binding.projectId
          ? await tx.user.findUnique({
              select: { displayName: true },
              where: { id: binding.userId }
            })
          : null;
        if (binding.projectId && !projectUploader) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        const fileName = output.relativePath.split("/").at(-1)!;
        const attachment = await tx.attachment.create({
          data: {
            byteSize: output.byteSize,
            chatId: binding.chatId,
            checksum: output.checksum,
            extractedText: null,
            fileName,
            kind: outputKind(fileName),
            messageId: binding.assistantMessageId,
            metadata: {} satisfies Prisma.InputJsonValue,
            mimeType: output.mimeType,
            origin: "WORKSPACE_OUTPUT",
            processingErrorCode: null,
            producerModelRunId: binding.runId,
            ...(binding.projectId
              ? {
                  projectId: binding.projectId,
                  uploaderDisplayName: projectUploader!.displayName,
                  uploaderUserId: binding.userId
                }
              : { userId: binding.userId }),
            status: "ready",
            storageKey
          }
        });
        const row = await tx.workspaceRunOutput.create({
          data: {
            attachmentId: attachment.id,
            byteSize: output.byteSize,
            checksum: output.checksum,
            relativePath: output.relativePath,
            workspaceRunBindingId: binding.runId
          },
          include: {
            attachment: {
              select: { byteSize: true, fileName: true, id: true, mimeType: true }
            }
          }
        });
        return generatedFile(row);
        });
      } catch (error) {
        // Two workers settling the same path race on the unique index; the
        // loser reads the winner's row instead of surfacing a duplicate error.
        if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
          throw error;
        }
        const winner = await existingOutput();
        if (!winner) throw new WorkspaceRuntimeError("workspace_output_export_failed");
        return reuse(winner);
      }
    }
  };
}

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "in_progress", "streaming"] as const;

async function claimExportWith(
  client: Prisma.TransactionClient | PrismaClient,
  input: Readonly<{ leaseMs: number; runId: string; sessionId: string }>
): Promise<WorkspaceExportClaim> {
  const now = new Date();
  const token = randomUUID().replaceAll("-", "");
  // One conditional UPDATE is the whole claim: a pending binding, a retryable
  // failure, or an expired/absent lease may be taken; a live lease or a
  // settled binding may not.
  const claimed = await client.workspaceRunBinding.updateMany({
    data: {
      exportAttemptCount: { increment: 1 },
      exportLeaseExpiresAt: new Date(now.getTime() + input.leaseMs),
      exportLeaseToken: token,
      exportStartedAt: now,
      exportState: "EXPORTING",
      lastExportErrorCode: null
    },
    where: {
      modelRunId: input.runId,
      workspaceSessionId: input.sessionId,
      OR: [
        { exportState: "PENDING" },
        {
          exportState: "FAILED",
          OR: [
            { lastExportErrorCode: null },
            { lastExportErrorCode: { notIn: [...WORKSPACE_PERMANENT_EXPORT_ERROR_CODES] } }
          ]
        },
        {
          exportState: "EXPORTING",
          OR: [
            { exportLeaseExpiresAt: null },
            { exportLeaseExpiresAt: { lte: now } }
          ]
        }
      ]
    }
  });
  if (claimed.count === 1) return { status: "claimed", token };
  const binding = await client.workspaceRunBinding.findUnique({
    select: { exportState: true, lastExportErrorCode: true, workspaceSessionId: true },
    where: { modelRunId: input.runId }
  });
  if (!binding || binding.workspaceSessionId !== input.sessionId) {
    throw new WorkspaceRuntimeError("workspace_output_export_failed");
  }
  if (binding.exportState === "COMPLETE") return { status: "complete" };
  if (binding.exportState === "FAILED") {
    return {
      code: binding.lastExportErrorCode ?? "workspace_output_export_failed",
      status: "failed"
    };
  }
  return { status: "busy" };
}

export type WorkspaceExportResult =
  | Readonly<{ files: readonly ThreadGeneratedFile[]; status: "complete" }>
  | Readonly<{ status: "busy" }>
  | Readonly<{ code: WorkspaceRuntimeError["code"]; retryable: boolean; status: "failed" }>;

export type WorkspaceSettlementOutcome = "cancelled" | "completed" | "failed" | "timed_out";

export type WorkspaceSettlementResult = Readonly<{
  /** Every execution of the run is provably gone (closed, or the VM was stopped). */
  quiesced: boolean;
  sessionSettled: boolean;
  stoppedVm: boolean;
}>;

export type WorkspaceCoordinator = Readonly<{
  accepts(input: Readonly<{ name: string; workspace: NormalizedRunWorkspace }>): boolean;
  execute(input: Readonly<{
    call: ModelToolCall;
    modelRunToolCallId: string;
    runId: string;
    signal?: AbortSignal;
    userId: string;
    workspace: NormalizedRunWorkspace;
  }>): Promise<ToolExecutionResult>;
  /**
   * Leased, idempotent output export. Never throws for export trouble: the
   * answer stays complete and the binding records the export state instead.
   */
  finalize(input: Readonly<{
    recovery?: boolean;
    runId: string;
    signal?: AbortSignal;
    userId: string;
    workspace?: NormalizedRunWorkspace;
  }>): Promise<WorkspaceExportResult>;
  /** Retries owed exports of completed runs whose chats are idle. */
  recoverExports(input: Readonly<{ limit?: number; signal?: AbortSignal }>): Promise<Readonly<{
    attempted: number;
    completed: number;
  }>>;
  /**
   * Idempotent terminal settlement for any run outcome: quiesce the run's
   * executions (falling back to a VM stop), then move the session out of
   * RUNNING/CREATING. Safe to call more than once and without a runtime.
   */
  settle(input: Readonly<{
    outcome: WorkspaceSettlementOutcome;
    runId: string;
    userId: string;
    workspace?: NormalizedRunWorkspace;
  }>): Promise<WorkspaceSettlementResult>;
  tools(input: Readonly<{
    runId: string;
    userId: string;
    workspace: NormalizedRunWorkspace;
  }>): Promise<readonly RunTool[]>;
}>;

function runtimeCode(error: unknown): WorkspaceRuntimeError["code"] {
  return error instanceof WorkspaceRuntimeError
    ? error.code
    : "workspace_runtime_unavailable";
}

function exactBinding(
  binding: WorkspaceExecutionBinding,
  workspace: NormalizedRunWorkspace
): boolean {
  return binding.imageRef === workspace.imageRef &&
    binding.internetEnabled === workspace.internetEnabled &&
    binding.mcpVersion === workspace.mcpVersion &&
    binding.outputDirectory === workspace.outputDirectory &&
    binding.runtimeVersion === workspace.runtimeVersion &&
    binding.sessionId === workspace.sessionId &&
    binding.toolCatalogHash === workspace.toolCatalogHash;
}

function outputStorageKey(binding: WorkspaceExecutionBinding, output: WorkspaceOutputStream): string {
  const pathHash = createHash("sha256").update(output.relativePath).digest("hex");
  const owner = binding.projectId ? `projects/${binding.projectId}` : binding.userId;
  return `${owner}/workspace-outputs/${binding.runId}/${pathHash}-${output.checksum}`;
}

async function objectMatches(
  storage: StorageAdapter,
  storageKey: string,
  output: WorkspaceOutputStream,
  signal?: AbortSignal
): Promise<boolean> {
  if (!storage.inspectObject) return false;
  try {
    const inspected = await storage.inspectObject(storageKey, {
      maxBytes: output.byteSize,
      sampleBytes: 1,
      signal
    });
    return inspected.byteSize === output.byteSize && inspected.checksum === output.checksum;
  } catch {
    return false;
  }
}

const EXEC_SESSION_TOOLS = new Set<string>(WORKSPACE_EXEC_SESSION_TOOL_NAMES);

function isExecSessionTool(name: string): boolean {
  return EXEC_SESSION_TOOLS.has(name);
}

function executionErrorResult(call: ModelToolCall, text: string): ToolExecutionResult {
  return {
    callId: call.id,
    content: [{ text, type: "text" }],
    name: call.name,
    rawPreview: { truncated: false },
    status: "error"
  };
}

function resultFromRuntime(call: ModelToolCall, result: WorkspaceToolResult): ToolExecutionResult {
  const content: ToolExecutionResult["content"] = [];
  for (const entry of result.content) {
    if (entry.type === "text" && typeof entry.text === "string") {
      content.push({ text: entry.text, type: "text" });
    } else if (entry.type === "json") {
      content.push({ type: "json", value: entry.value });
    }
  }
  return {
    callId: call.id,
    content,
    name: call.name,
    rawPreview: {
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.originalByteCount === undefined
        ? {}
        : { originalByteCount: result.originalByteCount }),
      truncated: result.truncated === true
    },
    status: result.status
  };
}

export function createWorkspaceCoordinator(input: Readonly<{
  config: WorkspaceConfig;
  registry: WorkspaceExecutionRegistry;
  repository: WorkspaceCoordinatorRepository;
  runtime: WorkspaceRuntime;
  storage: StorageAdapter;
}>): WorkspaceCoordinator {
  const initializing = new Map<string, Promise<WorkspaceExecutionBinding>>();
  const initialized = new Map<string, WorkspaceExecutionBinding>();

  function activityWindow(): Readonly<{ expiresAt: Date; lastActiveAt: Date }> {
    const lastActiveAt = new Date();
    return {
      expiresAt: new Date(lastActiveAt.getTime() + input.config.retentionSeconds * 1_000),
      lastActiveAt
    };
  }

  async function requireBinding(
    runId: string,
    userId: string,
    workspace: NormalizedRunWorkspace
  ): Promise<WorkspaceExecutionBinding> {
    const binding = await input.repository.binding({ runId, userId });
    if (!binding || !exactBinding(binding, workspace)) {
      throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
    }
    return binding;
  }

  async function initialize(
    binding: WorkspaceExecutionBinding,
    _workspace: NormalizedRunWorkspace | null,
    signal?: AbortSignal
  ): Promise<WorkspaceExecutionBinding> {
    const ready = initialized.get(binding.runId);
    if (
      ready &&
      ready.runtimeSandboxId !== null &&
      ready.runtimeSandboxId === binding.runtimeSandboxId
    ) {
      return ready;
    }
    const pending = initializing.get(binding.runId);
    if (pending) return pending;
    const operation = (async () => {
      if (!(await input.repository.markSessionStarting({
        ...activityWindow(),
        sessionId: binding.sessionId
      }))) {
        throw new WorkspaceRuntimeError("workspace_session_lost");
      }
      try {
        const session = await input.runtime.ensureSession({
          cpus: input.config.cpus,
          diskMiB: input.config.diskMiB,
          imageRef: binding.imageRef,
          internetEnabled: binding.internetEnabled,
          memoryMiB: input.config.memoryMiB,
          runtimeSandboxId: binding.runtimeSandboxId,
          sandboxName: binding.sandboxName,
          sessionId: binding.sessionId,
          signal
        });
        if (!(await input.repository.markSessionRunning({
          ...activityWindow(),
          runtimeSandboxId: session.runtimeSandboxId,
          sessionId: binding.sessionId
        }))) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        const attachments = await input.repository.attachments(binding);
        const entries = attachments.map((attachment) => ({
          attachmentId: attachment.attachmentId,
          byteSize: attachment.byteSize,
          checksum: attachment.checksum,
          kind: attachment.kind,
          messageId: attachment.messageId,
          mimeType: attachment.mimeType,
          originalName: attachment.fileName,
          sandboxPath: workspaceAttachmentPath({
            attachmentId: attachment.attachmentId,
            messageId: attachment.messageId,
            originalName: attachment.fileName
          }),
          storageKey: attachment.storageKey
        }));
        // Incremental staging: the guest index says which originals already
        // exist as intact files; only missing or changed ones are read from
        // private storage and written again. A fresh or recreated sandbox
        // has no index and receives everything.
        const staged = await input.runtime.listStagedAttachments({
          runtimeSandboxId: session.runtimeSandboxId,
          sessionId: binding.sessionId,
          signal
        }).catch(() => []);
        const streams: WorkspaceAttachmentStream[] = [];
        for (const entry of entries) {
          const present = staged.some((candidate) =>
            candidate.attachmentId === entry.attachmentId &&
            candidate.byteSize === entry.byteSize &&
            candidate.checksum === entry.checksum &&
            candidate.sandboxPath === entry.sandboxPath);
          if (present) continue;
          let object;
          try {
            object = await getStoredObjectStream(input.storage, entry.storageKey, {
              maxBytes: entry.byteSize,
              signal
            });
          } catch {
            throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
          }
          if (object.byteSize !== entry.byteSize) {
            throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
          }
          streams.push({
            attachmentId: entry.attachmentId,
            body: object.body,
            byteSize: entry.byteSize,
            checksum: entry.checksum,
            kind: entry.kind,
            messageId: entry.messageId,
            mimeType: entry.mimeType,
            originalName: entry.originalName,
            sandboxPath: entry.sandboxPath
          });
        }
        const byMessage = new Map<string, typeof entries>();
        for (const entry of entries) {
          const values = byMessage.get(entry.messageId) ?? [];
          values.push(entry);
          byMessage.set(entry.messageId, values);
        }
        const project = (entry: (typeof entries)[number]) => ({
          attachmentId: entry.attachmentId,
          byteSize: entry.byteSize,
          checksum: entry.checksum,
          kind: entry.kind,
          mimeType: entry.mimeType,
          originalName: entry.originalName,
          sandboxPath: entry.sandboxPath
        });
        // The index, every message manifest, and the current run's output
        // directory are always rewritten so the guest view stays complete.
        await input.runtime.stageAttachments({
          attachments: streams,
          inboxIndex: {
            attachments: entries.map(project),
            manifests: [...byMessage.keys()].sort().map((messageId) => ({
              messageId,
              path: workspaceMessageManifestPath(messageId)
            })),
            version: 1
          },
          manifests: [...byMessage.entries()].map(([messageId, values]) => ({
            body: { attachments: values.map(project), messageId, version: 1 },
            messageId
          })),
          outputDirectory: binding.outputDirectory,
          runtimeSandboxId: session.runtimeSandboxId,
          sessionId: binding.sessionId,
          signal
        });
        const catalog = await input.runtime.loadBoundTools({
          runtimeSandboxId: session.runtimeSandboxId,
          sessionId: binding.sessionId,
          signal
        });
        if (
          catalog.hash !== binding.toolCatalogHash ||
          catalog.mcpVersion !== binding.mcpVersion ||
          catalog.runtimeVersion !== binding.runtimeVersion ||
          hashCanonicalMcpValue(catalog.tools) !== hashCanonicalMcpValue(binding.toolDefinitions)
        ) {
          throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        }
        const readyBinding = {
          ...binding,
          runtimeSandboxId: session.runtimeSandboxId,
          sessionState: "RUNNING"
        };
        initialized.set(binding.runId, readyBinding);
        return readyBinding;
      } catch (error) {
        initialized.delete(binding.runId);
        // A cancelled turn is not a runtime failure: the row keeps its
        // CREATING/RUNNING state so terminal settlement can resolve it, and a
        // sandbox that did get created is reconnected by name on the next turn.
        if (
          signal?.aborted ||
          (error instanceof WorkspaceRuntimeError && error.code === "workspace_tool_cancelled")
        ) {
          throw new WorkspaceRuntimeError("workspace_tool_cancelled");
        }
        if (
          error instanceof WorkspaceRuntimeError &&
          error.code === "workspace_session_lost" &&
          binding.runtimeSandboxId
        ) {
          await input.repository.markSessionLost({
            runtimeSandboxId: binding.runtimeSandboxId,
            sessionId: binding.sessionId
          }).catch(() => false);
        }
        await input.repository.markSessionFailed({
          code: runtimeCode(error),
          sessionId: binding.sessionId
        }).catch(() => undefined);
        throw error;
      }
    })().finally(() => initializing.delete(binding.runId));
    initializing.set(binding.runId, operation);
    return operation;
  }

  async function initializeWithLostSessionRecovery(
    binding: WorkspaceExecutionBinding,
    workspace: NormalizedRunWorkspace,
    signal?: AbortSignal
  ): Promise<Readonly<{ binding: WorkspaceExecutionBinding; recreated: boolean }>> {
    try {
      return { binding: await initialize(binding, workspace, signal), recreated: false };
    } catch (error) {
      if (
        !(error instanceof WorkspaceRuntimeError) ||
        error.code !== "workspace_session_lost" ||
        !binding.runtimeSandboxId
      ) {
        throw error;
      }
      const fresh = await requireBinding(binding.runId, binding.userId, workspace);
      if (fresh.runtimeSandboxId !== null) throw error;
      return { binding: await initialize(fresh, workspace, signal), recreated: true };
    }
  }

  async function quiesceRun(
    binding: WorkspaceExecutionBinding,
    signal?: AbortSignal
  ): Promise<Readonly<{ proven: boolean; stoppedVm: boolean }>> {
    if (!binding.runtimeSandboxId) return { proven: true, stoppedVm: false };
    return quiesceWorkspaceExecutions({
      ambiguousStarts: await input.repository.ambiguousExecutionStarts({ runId: binding.runId }),
      modelRunId: binding.runId,
      registry: input.registry,
      runtime: input.runtime,
      runtimeSandboxId: binding.runtimeSandboxId,
      sessionId: binding.sessionId,
      signal
    });
  }

  async function ownedExecution(
    binding: WorkspaceExecutionBinding,
    execSessionId: unknown
  ): Promise<boolean> {
    if (typeof execSessionId !== "string") return false;
    const record = await input.registry.find({
      runtimeExecSessionId: execSessionId,
      sessionId: binding.sessionId
    });
    return record?.modelRunId === binding.runId;
  }

  async function registerExecution(
    binding: WorkspaceExecutionBinding,
    modelRunToolCallId: string,
    result: WorkspaceToolResult
  ): Promise<boolean> {
    const runtimeSandboxId = binding.runtimeSandboxId;
    if (!runtimeSandboxId) return false;
    const execSessionId = result.execSessionId;
    const registered = execSessionId
      ? await input.registry.register({
          modelRunId: binding.runId,
          modelRunToolCallId,
          runtimeExecSessionId: execSessionId,
          sessionId: binding.sessionId
        }).catch(() => "conflict" as const)
      : "conflict";
    if (registered === "registered") return true;
    // Ownership is not durable: kill the process now, or stop the VM when even
    // that cannot be proven, before the model is told anything.
    const terminated = execSessionId
      ? await input.runtime.terminateExecutions({
          executions: [{ modelRunId: binding.runId, runtimeExecSessionId: execSessionId }],
          runtimeSandboxId,
          sessionId: binding.sessionId
        }).catch(() => null)
      : null;
    if (!terminated?.every((entry) => entry.outcome === "closed")) {
      await input.runtime.stopSession({ runtimeSandboxId, sessionId: binding.sessionId })
        .catch(() => undefined);
      initialized.delete(binding.runId);
      await input.repository.settleSession({ outcome: "stopped", sessionId: binding.sessionId })
        .catch(() => false);
    }
    return false;
  }

  async function closeExecution(
    binding: WorkspaceExecutionBinding,
    execSessionId: unknown
  ): Promise<void> {
    if (typeof execSessionId !== "string") return;
    const record = await input.registry.find({
      runtimeExecSessionId: execSessionId,
      sessionId: binding.sessionId
    });
    if (record?.modelRunId !== binding.runId) return;
    await input.registry.transition({
      from: [...WORKSPACE_EXECUTION_OPEN_STATES],
      id: record.id,
      to: "CLOSED"
    });
  }

  return {
    accepts({ name, workspace }) {
      return workspace.enabled && workspaceToolNameFromNamespaced(name) !== null;
    },
    async settle({ outcome: _outcome, runId, userId, workspace }) {
      const binding = await input.repository.binding({ runId, userId });
      if (!binding || (workspace && !exactBinding(binding, workspace))) {
        initializing.delete(runId);
        initialized.delete(runId);
        return { quiesced: false, sessionSettled: false, stoppedVm: false };
      }
      const cached = initialized.get(runId);
      const current = binding.runtimeSandboxId === null && cached?.runtimeSandboxId
        ? { ...binding, runtimeSandboxId: cached.runtimeSandboxId }
        : binding;
      const quiescence = await quiesceRun(current);
      initializing.delete(runId);
      initialized.delete(runId);
      if (!quiescence.proven) {
        // The session stays RUNNING on purpose: maintenance retries the
        // backstop later instead of reporting a live process as idle.
        return { quiesced: false, sessionSettled: false, stoppedVm: false };
      }
      const sessionSettled = await input.repository.settleSession({
        outcome: quiescence.stoppedVm ? "stopped" : current.runtimeSandboxId ? "ready" : "pending",
        sessionId: binding.sessionId
      });
      return { quiesced: true, sessionSettled, stoppedVm: quiescence.stoppedVm };
    },
    async execute({ call, modelRunToolCallId, runId, signal, userId, workspace }) {
      const initial = await requireBinding(runId, userId, workspace);
      let initializedBinding = await initializeWithLostSessionRecovery(
        initial,
        workspace,
        signal
      );
      let binding = initializedBinding.binding;
      const definition = binding.toolDefinitions.find((tool) => tool.namespacedName === call.name);
      if (!definition || !binding.runtimeSandboxId) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      if (isExecSessionTool(definition.originalName)) {
        // The durable registry, not the runner cache, decides ownership.
        const owned = await ownedExecution(binding, call.arguments.execSessionId);
        if (!owned) {
          return executionErrorResult(call, "This execution does not belong to the current run.");
        }
      }
      const timeout = new AbortController();
      const timer = setTimeout(
        () => timeout.abort(new WorkspaceRuntimeError("workspace_tool_timeout")),
        workspace.syncToolTimeoutSeconds * 1_000
      );
      const combined = signal
        ? AbortSignal.any([signal, timeout.signal])
        : timeout.signal;
      try {
        const dispatch = (active: WorkspaceExecutionBinding) =>
          input.runtime.callBoundTool({
            arguments: call.arguments,
            modelRunId: active.runId,
            modelRunToolCallId,
            originalName: definition.originalName,
            runtimeSandboxId: active.runtimeSandboxId!,
            sessionId: active.sessionId,
            signal: combined
          });
        let result: WorkspaceToolResult;
        try {
          result = await dispatch(binding);
        } catch (error) {
          if (
            !(error instanceof WorkspaceRuntimeError) ||
            error.code !== "workspace_session_lost" ||
            !binding.runtimeSandboxId
          ) {
            throw error;
          }
          initialized.delete(binding.runId);
          if (!(await input.repository.markSessionLost({
            runtimeSandboxId: binding.runtimeSandboxId,
            sessionId: binding.sessionId
          }))) {
            throw error;
          }
          const fresh = await requireBinding(runId, userId, workspace);
          initializedBinding = await initializeWithLostSessionRecovery(
            fresh,
            workspace,
            combined
          );
          binding = initializedBinding.binding;
          result = await dispatch(binding);
          initializedBinding = { binding, recreated: true };
        }
        if (definition.originalName === "sandbox_exec_start" && result.status === "complete") {
          const registered = await registerExecution(binding, modelRunToolCallId, result);
          if (!registered) {
            return executionErrorResult(
              call,
              "The long-running execution could not be registered and was stopped. Start it again."
            );
          }
        } else if (definition.originalName === "sandbox_exec_close" && result.status === "complete") {
          await closeExecution(binding, call.arguments.execSessionId);
        }
        const projected = resultFromRuntime(call, result);
        return initializedBinding.recreated
          ? {
              ...projected,
              content: [{
                text: "Workspace storage was unavailable and a clean workspace was recreated from the original attachments.",
                type: "text"
              }, ...projected.content]
            }
          : projected;
      } catch (error) {
        if (combined.aborted) {
          if (binding.runtimeSandboxId) {
            await input.runtime.cancelToolCall({
              modelRunId: binding.runId,
              modelRunToolCallId,
              runtimeSandboxId: binding.runtimeSandboxId,
              sessionId: binding.sessionId
            }).catch(() => undefined);
          }
          if (timeout.signal.aborted) {
            throw new WorkspaceRuntimeError("workspace_tool_timeout");
          }
          throw new WorkspaceRuntimeError("workspace_tool_cancelled");
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    },
    async finalize({ recovery, runId, signal, userId, workspace }) {
      const initial = await input.repository.binding({ runId, userId });
      if (!initial || (workspace && !exactBinding(initial, workspace))) {
        return { code: "workspace_runtime_incompatible", retryable: false, status: "failed" };
      }
      const leaseInput = { leaseMs: WORKSPACE_EXPORT_LEASE_MS, runId, sessionId: initial.sessionId };
      let claim: WorkspaceExportClaim;
      try {
        claim = recovery
          ? await input.repository.claimExportForRecovery(leaseInput)
          : await input.repository.claimExport(leaseInput);
      } catch (error) {
        return { code: runtimeCode(error), retryable: true, status: "failed" };
      }
      if (claim.status === "complete") {
        return { files: await input.repository.generatedFiles({ runId, userId }), status: "complete" };
      }
      if (claim.status === "failed") {
        return {
          code: claim.code === "workspace_output_limit_exceeded"
            ? "workspace_output_limit_exceeded"
            : "workspace_output_export_failed",
          retryable: false,
          status: "failed"
        };
      }
      if (claim.status === "busy") return { status: "busy" };
      const lease = { runId, sessionId: initial.sessionId, token: claim.token };
      let leaseLost = false;
      const renew = async () => {
        if (leaseLost) throw new WorkspaceRuntimeError("workspace_output_export_failed");
        if (!(await input.repository.renewExportLease({ ...lease, leaseMs: WORKSPACE_EXPORT_LEASE_MS }))) {
          leaseLost = true;
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
      };
      // A worker whose lease was reclaimed stops touching the database; the
      // owner-guarded terminal updates would refuse it anyway.
      const heartbeat = new AbortController();
      const heartbeatTimer = setInterval(() => {
        void renew().catch(() => heartbeat.abort(new WorkspaceRuntimeError("workspace_output_export_failed")));
      }, Math.max(1_000, Math.floor(WORKSPACE_EXPORT_LEASE_MS / 3)));
      heartbeatTimer.unref?.();
      const exportSignal = signal ? AbortSignal.any([signal, heartbeat.signal]) : heartbeat.signal;
      let batch: Readonly<{ batchId: string; runtimeSandboxId: string }> | null = null;
      try {
        if (!initial.runtimeSandboxId) {
          if (!(await input.repository.markExportComplete(lease))) {
            throw new WorkspaceRuntimeError("workspace_output_export_failed");
          }
          return { files: [], status: "complete" };
        }
        // A provider-complete run may be finalized by a fresh app process after
        // the runner itself was restarted. Reconnect and restage originals
        // before collecting output, but never recreate a genuinely lost VM:
        // doing so would silently turn missing deliverables into a success.
        const binding = await initialize(initial, workspace ?? null, exportSignal);
        if (!binding.runtimeSandboxId) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        // Freeze the output set: no process of this run may still be writing
        // between the listing/hash and the upload.
        const quiescence = await quiesceRun(binding, exportSignal);
        if (!quiescence.proven || quiescence.stoppedVm) {
          throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
        }
        await renew();
        const outputs = await input.runtime.collectOutputs({
          modelRunId: runId,
          outputDirectory: binding.outputDirectory,
          runtimeSandboxId: binding.runtimeSandboxId,
          sessionId: binding.sessionId,
          signal: exportSignal
        });
        const batchId = outputs.find((output) => output.batchId)?.batchId;
        if (batchId) batch = { batchId, runtimeSandboxId: binding.runtimeSandboxId };
        const total = outputs.reduce((sum, output) => sum + output.byteSize, 0);
        if (
          outputs.length > input.config.outputMaxFiles ||
          total > input.config.outputTotalMaxBytes ||
          outputs.some((output) =>
            output.byteSize < 1 ||
            output.byteSize > input.config.outputFileMaxBytes ||
            !/^[a-f0-9]{64}$/u.test(output.checksum) ||
            !isSafeWorkspaceRelativePath(output.relativePath)
          )
        ) {
          throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
        }
        const files: ThreadGeneratedFile[] = [];
        for (const output of outputs) {
          await renew();
          const storageKey = outputStorageKey(binding, output);
          if (!(await objectMatches(input.storage, storageKey, output, exportSignal))) {
            if (!input.storage.putObjectStream) {
              throw new WorkspaceRuntimeError("workspace_output_export_failed");
            }
            try {
              await input.storage.putObjectStream({
                body: output.body,
                byteSize: output.byteSize,
                contentType: output.mimeType,
                signal: exportSignal,
                storageKey
              });
            } catch (error) {
              if (!(await objectMatches(input.storage, storageKey, output, exportSignal))) throw error;
            }
          }
          await renew();
          files.push(await input.repository.settleOutput({
            binding,
            output: {
              byteSize: output.byteSize,
              checksum: output.checksum,
              mimeType: output.mimeType,
              relativePath: output.relativePath
            },
            storageKey
          }));
        }
        await renew();
        if (!(await input.repository.markExportComplete(lease))) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        await input.repository.markSessionReady({
          ...activityWindow(),
          sessionId: binding.sessionId
        });
        return { files, status: "complete" };
      } catch (error) {
        const code = runtimeCode(error);
        const recorded = code === "workspace_output_limit_exceeded" ||
          code === "workspace_session_lost" ||
          code === "workspace_runtime_incompatible"
          ? code
          : "workspace_output_export_failed";
        if (!leaseLost) {
          await input.repository.markExportFailed({ ...lease, code: recorded }).catch(() => undefined);
        }
        return {
          code: error instanceof WorkspaceRuntimeError ? error.code : "workspace_output_export_failed",
          retryable: isRetryableWorkspaceExportErrorCode(recorded),
          status: "failed"
        };
      } finally {
        clearInterval(heartbeatTimer);
        if (batch && input.runtime.releaseOutputs) {
          await input.runtime.releaseOutputs({
            batchId: batch.batchId,
            runtimeSandboxId: batch.runtimeSandboxId,
            sessionId: initial.sessionId
          }).catch(() => undefined);
        }
      }
    },
    async recoverExports({ limit, signal }) {
      const candidates = await input.repository.exportRecoveryCandidates({
        limit: limit ?? 10,
        staleBefore: new Date(Date.now() - WORKSPACE_EXPORT_RECOVERY_GRACE_MS)
      });
      let attempted = 0;
      let completed = 0;
      for (const candidate of candidates) {
        if (signal?.aborted) break;
        attempted += 1;
        const result = await this.finalize({
          recovery: true,
          runId: candidate.runId,
          signal,
          userId: candidate.userId
        });
        if (result.status === "complete") completed += 1;
      }
      return { attempted, completed };
    },
    async tools({ runId, userId, workspace }) {
      const binding = await requireBinding(runId, userId, workspace);
      return workspaceRunTools(binding.toolDefinitions);
    }
  };
}
