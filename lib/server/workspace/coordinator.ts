import { databaseFailureCode, rememberDatabaseFailure } from "../observability/databaseFailure";
import { logEvent } from "../observability";
import { WorkspaceActivityText, workspaceSecretMatches, type WorkspaceSecretMatch } from "./activityText";
import { WorkspaceSecretOutputMask } from "./secretOutput";
import { WORKSPACE_CODE_TOKEN_ENV, WORKSPACE_CODE_UNAVAILABLE_ENV } from "./codeMcp";
import { createPrismaWorkspaceCodeGrantRepository, type WorkspaceCodeGrantIssue, type WorkspaceCodeInvocationKind,
  type WorkspaceCodeRunIdentity } from "./codeMcpStore";
import { workspaceCodeCallActivity, workspaceCodeCallSummaryLine, type WorkspaceCodeCallSummary } from "./codeMcpSummary";
import { inheritWorkspaceResultCode, observeWorkspaceAbort, observeWorkspaceToolExecution, retainWorkspaceResultCode } from "./toolObservability";
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { agentExecutionId } from "../agents/runtime";
import { CodexJsonlDecoder, type CodexEvent } from "../agents/codexProtocol";
import type { CodexManagedProfile } from "../agents/codexProfile";
import { workspaceSkillPath, type WorkspaceSkillBundles, type WorkspaceSkillPlan } from "../skills/workspaceBundles";
import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  ThreadGeneratedFile,
  ThreadWorkspaceActivityEntry
} from "@/lib/contracts/workspace";
import { isWorkspaceErrorCode, type WorkspaceErrorCode } from "@/lib/contracts/workspace";
import {
  isRetryableWorkspaceExportErrorCode,
  isSafeWorkspaceRelativePath,
  WORKSPACE_EXEC_SESSION_TOOL_NAMES,
  WORKSPACE_MCP_TOOL_ALLOWLIST,
  WORKSPACE_PERMANENT_EXPORT_ERROR_CODES,
  WORKSPACE_EXPORT_MAX_ATTEMPTS,
  workspaceAttachmentPath,
  workspaceMessageManifestPath,
  workspaceToolIsAllowed
} from "@/lib/domain/workspace";
import { uploadFormatForExtension, type UploadKind } from "@/lib/domain/uploadFormats";
import { hashCanonicalMcpValue } from "@/lib/server/mcp/definitions";
import type { NormalizedRunWorkspace } from "@/lib/server/providers/types";
import { workspaceAncestorMessageIds, workspaceInboxAttachmentWhere } from "./inboxSelection";
import type { ModelToolCall, RunTool, ToolExecutionResult } from "@/lib/server/tools/types";
import {
  getStoredObjectStream,
  type StorageAdapter
} from "@/lib/server/uploads/storage";
import { resolveProjectAccess } from "@/lib/server/projects/access";
import type { WorkspaceConfig } from "./config";
import { outputIdentities, parseOutputCapture, sameOutputIdentities, type WorkspaceOutputCapture, type WorkspaceOutputIdentity } from "./outputManifest";
import {
  UNREGISTERED_WORKSPACE_COMMAND_FILTER,
  acknowledgeWorkspaceCommandsStopped,
  workspaceSyncCleanupId,
  type WorkspaceExecutionRecord,
  type WorkspaceExecutionRegistry
} from "./executionRegistry";
import { quiesceWorkspaceExecutions, type WorkspaceQuiescence } from "./quiescence";
import { createWorkspaceAttachmentAcquisition } from "./attachmentAcquisition";
import { workspaceOperationFailureMessage, type WorkspaceOperationFailureCode } from "@/lib/contracts/workspaceFailure";
import {
  projectWorkspaceActivity,
  workspaceActivityEvent,
  workspaceLifecycleActivity,
  type ExecOutputBuffer
} from "./activityProjection";
import type {
  WorkspaceAttachmentStream,
  WorkspaceBoundTool,
  WorkspaceOutputStream,
  WorkspaceRuntime,
  WorkspaceToolResult
} from "./runtime";
import { WorkspaceRuntimeError } from "./runtime";
import type { WorkspaceOperation } from "./operationFence";
import { WORKSPACE_OPERATION_LEASE_MS, failWorkspaceExportsForLostDisk, lockWorkspaceSession, workspaceOperationWhere, workspaceRunOperationOwner } from "./sessionOperation";
import { workspaceRunTools } from "./admission";
import { decryptWorkspaceSecret, type AcceptedWorkspaceSecret } from "./secrets/store";
import { saveWorkspaceBrowserSessions, type WorkspaceBrowserSaveInput } from "./secrets/browserStore";
import { readWorkspaceBrowserCollection } from "./secrets/browserCollection";
import type { WorkspaceBrowserSaveReport } from "./secrets/browserSession";
import {
  namespacedWorkspaceToolName,
  workspaceToolNameFromNamespaced
} from "./toolCatalog";

type WorkspaceAttachmentRecord = Readonly<{
  attachmentId: string;
  byteSize: number;
  checksum: string;
  createdAt?: string;
  origin?: "USER_UPLOAD" | "WORKSPACE_OUTPUT" | "IMAGE_OUTPUT";
  fileName: string;
  kind: "document" | "file" | "image" | "pdf";
  messageId: string;
  mimeType: string;
  storageKey: string;
}>;

export type WorkspaceExecutionBinding = Readonly<{
  assistantMessageId: string;
  chatId: string;
  guestUsed: boolean;
  imageRef: string;
  internetEnabled: boolean;
  mcpVersion: string;
  outputDirectory: string;
  operationOwner: string | null;
  operationGeneration: number;
  policyRevision: number;
  projectId: string | null;
  runId: string;
  runtimeSandboxId: string | null;
  runtimeVersion: string;
  sandboxName: string;
  /** The run belongs to a scheduled task (its schedule or Run now); absent means interactive. */
  scheduled?: boolean;
  sessionId: string;
  sessionErrorCode: string | null;
  sessionState: string;
  toolCatalogHash: string;
  toolDefinitions: readonly WorkspaceBoundTool[];
  userId: string;
}>;

function ownedOperation(binding: WorkspaceExecutionBinding): WorkspaceOperation {
  if (!binding.operationOwner) {
    throw new WorkspaceRuntimeError("workspace_operation_stale");
  }
  return { generation: binding.operationGeneration, owner: binding.operationOwner };
}

/** Authority returned only by the exact disk-loss transaction. */
class WorkspaceConfirmedSessionLoss extends WorkspaceRuntimeError {
  constructor(readonly operation: WorkspaceOperation) {
    super("workspace_session_lost");
  }
}

/** The runtime's ensure, which looks the sandbox up by its name, found none. */
class WorkspaceSandboxMissing extends WorkspaceRuntimeError {
  constructor() {
    super("workspace_session_lost");
  }
}

/** Content-free names of the export steps, in order. */
type WorkspaceExportStep = "claim" | "initialize" | "quiesce" | "resume" | "collect" | "seal";

/**
 * An export meets an unproven loss (a runner without the session in its
 * cache, or a lookup right after the export's own stop) at most once: after
 * this pause it initializes once more within the same lease.
 */
const WORKSPACE_EXPORT_LOSS_RETRY_DELAY_MS = 1_000;

function exportRetryDelay(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, WORKSPACE_EXPORT_LOSS_RETRY_DELAY_MS);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Result of one atomic export claim. Exactly one worker owns an `EXPORTING`
 * binding at a time through a bounded lease; `busy` means another live lease
 * exists, `complete` returns the settled files, and `failed` marks a permanent
 * error that retries must not repeat.
 */
export type WorkspaceExportClaim =
  | Readonly<{ status: "busy" }>
  | Readonly<{ operation: WorkspaceOperation; status: "claimed"; token: string }>
  | Readonly<{ status: "complete" }>
  | Readonly<{ status: "exhausted" }>
  | Readonly<{ code: string; status: "failed" }>;

/** Lease window for one export attempt; renewed before every long step. */
export const WORKSPACE_EXPORT_LEASE_MS = 120_000;
export { WORKSPACE_EXPORT_MAX_ATTEMPTS } from "@/lib/domain/workspace";
/** Retry spacing also bounds repeated storage failures after a durable handoff. */
export const WORKSPACE_EXPORT_RECOVERY_GRACE_MS = 30_000;

export type WorkspaceExportRecoveryCursor = Readonly<{ runId: string; updatedAt: Date }>;

export type WorkspaceExportLease = Readonly<{
  operation: WorkspaceOperation;
  runId: string;
  runtimeSandboxId: string | null;
  sessionId: string;
  token: string;
}>;

export type WorkspaceCoordinatorRepository = Readonly<{
  /**
   * Accepted command calls, in any result state, that own no
   * registry row: the process may be running, so only a VM stop proves
   * quiescence.
   */
  unregisteredCommands(input: Readonly<{ runId: string }>): Promise<number>;
  attachments(binding: WorkspaceExecutionBinding): Promise<readonly WorkspaceAttachmentRecord[]>;
  personalSecrets(binding: WorkspaceExecutionBinding): Promise<readonly AcceptedWorkspaceSecret[]>;
  /**
   * MCP from guest code. Each execution initialization rotates the run's
   * bearer (fencing the previous incarnation's invocations and receipts);
   * every terminal path revokes it before guest authority retires.
   */
  issueCodeGrant?(binding: WorkspaceCodeRunIdentity): Promise<WorkspaceCodeGrantIssue>;
  revokeCodeGrant?(input: Readonly<{ runId: string }>): Promise<void>;
  /** Persisted before dispatch; only that command's environment carries the id. */
  openCodeInvocation?(input: Readonly<{
    kind: WorkspaceCodeInvocationKind; modelRunToolCallId: string; runId: string; sessionId: string;
  }>): Promise<string | null>;
  closeCodeInvocation?(input: Readonly<{ invocationId: string; runId: string }>): Promise<void>;
  codeCallSummary?(input: Readonly<{ runId: string; toolCallId: string }>): Promise<WorkspaceCodeCallSummary | null>;
  saveBrowserSessions(input: WorkspaceBrowserSaveInput): Promise<WorkspaceBrowserSaveReport | null>;
  binding(input: Readonly<{ runId: string; userId: string }>): Promise<WorkspaceExecutionBinding | null>;
  /** Persist before guest I/O, including attempts with an ambiguous result. */
  markGuestUsed(binding: WorkspaceExecutionBinding): Promise<boolean>;
  /** Release an unused run's authority without changing the guest or its activity window. */
  retireUnusedRun(binding: WorkspaceExecutionBinding): Promise<boolean>;
  /**
   * `required`: a scheduled task's rotation carried this seed, so no run of
   * the chat, scheduled or the owner's, goes on with an empty project instead
   * (`workspace_carryover_unavailable`) until a restore succeeds.
   */
  claimContinuationSeed?(input: Readonly<{ chatId: string; operation: WorkspaceOperation; sessionId: string }>): Promise<Readonly<{
    id: string; storageKey: string; checksum: string; byteSize: number; token: string; required?: boolean;
  }> | null>;
  /** `TRANSFERRED` releases a required seed's claim, keeping its archive for a later attempt. */
  settleContinuationSeed?(input: Readonly<{
    id: string; token: string; status: "RESTORED" | "FAILED" | "TRANSFERRED"; failureCode?: string;
  }>): Promise<boolean>;
  /** The run is a scheduled task's run whose chat still awaits the files that task's rotation carried. */
  pendingCarryover?(input: Readonly<{ chatId: string; runId: string }>): Promise<boolean>;
  claimExport(input: Readonly<{
    handoff?: boolean;
    leaseMs: number;
    operation: WorkspaceOperation;
    runId: string;
    runtimeSandboxId: string | null;
    sessionId: string;
  }>): Promise<WorkspaceExportClaim>;
  /**
   * Same atomic claim for background recovery, taken under the session row
   * lock and only while the chat has no active run, so a retry can never
   * overlap a new mutating turn on the same sandbox (admission holds the
   * mirror-image check against a live lease).
   */
  claimExportForRecovery(input: Readonly<{
    generation: number;
    leaseMs: number;
    runId: string;
    runtimeSandboxId: string | null;
    sessionId: string;
  }>): Promise<WorkspaceExportClaim>;
  /**
   * Completed runs whose export is still owed: pending, retryably failed, or
   * left EXPORTING by a worker whose lease expired. Bounded and oldest-first.
   */
  exportRecoveryCandidates(input: Readonly<{
    cursor?: WorkspaceExportRecoveryCursor;
    limit: number;
    staleBefore: Date;
  }>): Promise<readonly Readonly<{ runId: string; updatedAt: Date; userId: string }>[]>;
  generatedFiles(input: Readonly<{ runId: string; userId: string }>): Promise<readonly ThreadGeneratedFile[]>;
  reserveOutputCapture(input: WorkspaceExportLease): Promise<(WorkspaceOutputCapture & Readonly<{ create: boolean }>) | null>;
  sealOutputCapture(input: WorkspaceExportLease & Readonly<{ capture: WorkspaceOutputCapture & { outputs: readonly WorkspaceOutputIdentity[] } }>): Promise<boolean>;
  outputHandoffReady(input: Readonly<{ runId: string; sessionId: string }>): Promise<boolean>;
  markExportPending(input: WorkspaceExportLease): Promise<boolean>;
  markExportComplete(input: WorkspaceExportLease): Promise<boolean>;
  markExportFailed(input: WorkspaceExportLease & Readonly<{ code: string }>): Promise<boolean>;
  renewExportLease(input: WorkspaceExportLease & Readonly<{ leaseMs: number }>): Promise<boolean>;
  prepareOutput(input: WorkspaceExportLease & Readonly<{ storageKey: string }>): Promise<boolean>;
  markSessionFailed(input: Readonly<{ code: string; operation: WorkspaceOperation; sessionId: string }>): Promise<void>;
  markSessionLost(input: Readonly<{
    operation: WorkspaceOperation;
    runtimeSandboxId: string;
    sessionId: string;
  }>): Promise<WorkspaceOperation | null>;
  markSessionRunning(input: Readonly<{
    operation: WorkspaceOperation;
    expiresAt: Date;
    lastActiveAt: Date;
    runtimeSandboxId: string;
    sessionId: string;
  }>): Promise<boolean>;
  markSessionStarting(input: Readonly<{
    operation: WorkspaceOperation;
    expiresAt: Date;
    lastActiveAt: Date;
    sessionId: string;
  }>): Promise<boolean>;
  markSessionReady(input: Readonly<{
    operation: WorkspaceOperation;
    expiresAt: Date;
    lastActiveAt: Date;
    sessionId: string;
  }>): Promise<void>;
  settleOutput(input: Readonly<{
    binding: WorkspaceExecutionBinding;
    output: Omit<WorkspaceOutputStream, "body" | "opaqueFileId">;
    storageKey: string;
    token: string;
  }>): Promise<ThreadGeneratedFile>;
  /**
   * Guarded terminal transition of a session that no run uses any more.
   * Never touches DELETING, FAILED, or an in-progress archive/idle-stop marker,
   * and never extends the activity window.
   */
  settleSession(input: Readonly<{
    operation: WorkspaceOperation;
    outcome: "pending" | "ready" | "stopped";
    runtimeSandboxId: string | null;
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
        scheduledTaskId: true,
        userId: true,
        workspaceRunBinding: {
          select: {
            guestUsedAt: true,
            _count: { select: { toolCalls: true, selectedCaptures: true } },
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
                lastErrorCode: true,
                operationOwner: true,
                version: true,
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
      guestUsed: run.workspaceRunBinding.guestUsedAt !== null ||
        run.workspaceRunBinding._count.toolCalls > 0 || run.workspaceRunBinding._count.selectedCaptures > 0,
      imageRef: run.workspaceRunBinding.imageRef,
      internetEnabled: run.workspaceRunBinding.internetEnabled,
      mcpVersion: run.workspaceRunBinding.mcpVersion,
      outputDirectory: run.workspaceRunBinding.outputDirectory,
      operationOwner: session.operationOwner,
      operationGeneration: session.version,
      policyRevision: run.workspaceRunBinding.policyRevision,
      projectId: run.chat.projectId,
      runId: run.id,
      runtimeSandboxId: session.runtimeSandboxId,
      runtimeVersion: run.workspaceRunBinding.runtimeVersion,
      sandboxName: session.sandboxName,
      scheduled: run.scheduledTaskId !== null,
      sessionId: session.id,
      sessionErrorCode: session.lastErrorCode,
      sessionState: session.state,
      toolCatalogHash: run.workspaceRunBinding.toolCatalogHash,
      toolDefinitions: definitions,
      userId: run.userId
    };
  }

  return {
    ...createPrismaWorkspaceCodeGrantRepository(prisma),
    saveBrowserSessions: (input) => saveWorkspaceBrowserSessions(prisma, input),
    async personalSecrets(binding) {
      const current = await loadBinding(binding.runId, binding.userId);
      if (!current || current.operationOwner !== binding.operationOwner || current.operationGeneration !== binding.operationGeneration) {
        throw new WorkspaceRuntimeError("workspace_operation_stale");
      }
      if (current.projectId) return [];
      const owner = await prisma.user.findFirst({ select: { id: true }, where: { id: binding.userId, status: "active" } });
      if (!owner) throw new WorkspaceRuntimeError("workspace_secrets_prepare_failed");
      const bound = await prisma.workspaceRunSecret.findMany({
        select: { valueId: true }, where: { modelRunId: binding.runId }, orderBy: { secretId: "asc" }
      });
      // One ciphertext at a time: browser states can reach the aggregate budget.
      const secrets: AcceptedWorkspaceSecret[] = [];
      for (const { valueId } of bound) {
        secrets.push(decryptWorkspaceSecret(await prisma.workspaceSecretValue.findUniqueOrThrow({ where: { id: valueId } }), binding.userId));
      }
      return secrets;
    },
    async unregisteredCommands({ runId }) {
      return prisma.modelRunToolCall.count({
        where: {
          ...UNREGISTERED_WORKSPACE_COMMAND_FILTER,
          workspaceRunBindingId: runId
        }
      });
    },
    async binding({ runId, userId }) {
      return loadBinding(runId, userId);
    },
    async markGuestUsed(binding) {
      if (!binding.operationOwner) return false;
      return prisma.$transaction(async tx => {
        const session = await lockWorkspaceSession(tx, binding.sessionId);
        if (!session || session.operationOwner !== binding.operationOwner || session.version !== binding.operationGeneration ||
          session.state === "DELETING") return false;
        const row = await tx.workspaceRunBinding.findFirst({
          where: { modelRunId: binding.runId, workspaceSessionId: binding.sessionId }, select: { guestUsedAt: true }
        });
        if (!row) return false;
        if (row.guestUsedAt === null) await tx.workspaceRunBinding.update({
          where: { modelRunId: binding.runId }, data: { guestUsedAt: new Date() }
        });
        return true;
      });
    },
    async retireUnusedRun(binding) {
      if (!binding.operationOwner) return false;
      return prisma.$transaction(async tx => {
        const session = await lockWorkspaceSession(tx, binding.sessionId);
        if (!session || session.operationOwner !== binding.operationOwner || session.version !== binding.operationGeneration ||
          session.state === "DELETING") return false;
        const unused = await tx.workspaceRunBinding.findFirst({
          where: { modelRunId: binding.runId, workspaceSessionId: binding.sessionId, guestUsedAt: null,
            toolCalls: { none: {} }, selectedCaptures: { none: {} } }, select: { modelRunId: true }
        });
        if (!unused) return false;
        await tx.workspaceSession.update({ where: { id: binding.sessionId },
          data: { operationOwner: null, operationExpiresAt: null } });
        return true;
      });
    },
    async claimContinuationSeed({ chatId, operation, sessionId }) {
      return prisma.$transaction(async (tx) => {
        const session = await lockWorkspaceSession(tx, sessionId);
        if (!session || session.chatId !== chatId || session.version !== operation.generation || session.operationOwner !== operation.owner) {
          throw new WorkspaceRuntimeError("workspace_operation_stale");
        }
        const seed = await tx.chatContinuationWorkspaceSeed.findUnique({ where: { newChatId: chatId } });
        if (!seed || !["TRANSFERRED", "RESTORING"].includes(seed.status)) return null;
        // A scheduled task's rotation carried it: whichever run starts the chat's Workspace
        // first restores it or runs nothing, the owner's own runs included. Deleting the
        // task leaves an ordinary continuation seed; a Workspace reset of the chat abandons it.
        const required = seed.scheduledTaskId !== null;
        if (!seed.storageKey || !seed.checksum || !seed.byteSize) {
          throw new WorkspaceRuntimeError(required ? "workspace_carryover_unavailable" : "workspace_archive_invalid");
        }
        const now = new Date();
        if (seed.status === "RESTORING" && seed.leaseExpiresAt && seed.leaseExpiresAt > now) {
          throw new WorkspaceRuntimeError(required ? "workspace_carryover_unavailable" : "workspace_archive_restore_failed");
        }
        const token = randomUUID();
        const claimed = await tx.chatContinuationWorkspaceSeed.updateMany({
          where: { id: seed.id, OR: [
            { status: "TRANSFERRED" },
            { status: "RESTORING", OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: now } }] }
          ] },
          data: { status: "RESTORING", leaseToken: token, leaseExpiresAt: new Date(now.getTime() + WORKSPACE_OPERATION_LEASE_MS),
            restoreStartedAt: now, attemptCount: { increment: 1 } }
        });
        if (claimed.count !== 1) {
          if (required) throw new WorkspaceRuntimeError("workspace_carryover_unavailable");
          return null;
        }
        return { id: seed.id, storageKey: seed.storageKey, checksum: seed.checksum, byteSize: seed.byteSize, token,
          ...(required ? { required: true } : {}) };
      });
    },
    async pendingCarryover({ chatId, runId }) {
      const [row] = await prisma.$queryRaw<Array<{ pending: boolean }>>(Prisma.sql`
        SELECT EXISTS (
          SELECT 1 FROM "ChatContinuationWorkspaceSeed" AS seed
          JOIN "ModelRun" AS run ON run."id" = ${runId} AND run."scheduledTaskId" = seed."scheduledTaskId"
          WHERE seed."newChatId" = ${chatId}
            AND seed."status" IN ('TRANSFERRED'::"ChatContinuationWorkspaceSeedStatus", 'RESTORING'::"ChatContinuationWorkspaceSeedStatus")
        ) AS "pending"
      `);
      return row?.pending === true;
    },
    async settleContinuationSeed({ id, token, status, failureCode }) {
      return prisma.$transaction(async (tx) => {
        const settled = await tx.chatContinuationWorkspaceSeed.updateMany({
          where: { id, leaseToken: token, status: "RESTORING" },
          data: { status, failureCode: failureCode ?? null, leaseToken: null, leaseExpiresAt: null }
        });
        if (settled.count !== 1) return false;
        if (status === "FAILED") {
          const seed = await tx.chatContinuationWorkspaceSeed.findUniqueOrThrow({ where: { id } });
          if (seed.storageKey) await tx.attachmentDeletionJob.upsert({ where: { storageKey: seed.storageKey },
            create: { storageKey: seed.storageKey }, update: {} });
        }
        return true;
      });
    },
    async attachments(binding) {
      const accepted = await prisma.modelRun.findUnique({ where: { id: binding.runId }, select: { normalizedRequest: true } });
      const snapshot = accepted?.normalizedRequest as { imageReferences?: Array<{ attachmentId: string }> } | null;
      const imageIds = snapshot?.imageReferences?.map(reference => reference.attachmentId) ?? [];
      // Earlier exported bytes are admitted from this run's immutable message
      // ancestry, not from the mutable current branch or guest output folders.
      const ancestors = (await workspaceAncestorMessageIds(prisma, binding.chatId, binding.assistantMessageId))
        .filter(id => id !== binding.assistantMessageId);
      const rows = await prisma.attachment.findMany({
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          byteSize: true,
          checksum: true,
          createdAt: true,
          fileName: true,
          id: true,
          kind: true,
          messageId: true,
          mimeType: true,
          origin: true,
          storageKey: true
        },
        where: workspaceInboxAttachmentWhere({ chatId: binding.chatId, userId: binding.userId, projectId: binding.projectId,
          ancestorMessageIds: ancestors, imageIds, runId: binding.runId })
      });
      return rows.flatMap((row) =>
        row.checksum && row.messageId &&
        (row.kind === "document" || row.kind === "file" || row.kind === "image" || row.kind === "pdf")
          ? [{
              attachmentId: row.id,
              byteSize: row.byteSize,
              checksum: row.checksum,
              createdAt: row.createdAt.toISOString(),
              fileName: row.fileName,
              kind: row.kind,
              messageId: row.messageId,
              mimeType: row.mimeType,
              origin: row.origin === "IMAGE_OUTPUT" ? "IMAGE_OUTPUT" as const : row.origin === "WORKSPACE_OUTPUT" ? "WORKSPACE_OUTPUT" as const : "USER_UPLOAD" as const,
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
    async claimExport(request) {
      return prisma.$transaction(async (tx) => {
        const session = await lockWorkspaceSession(tx, request.sessionId);
        if (await exportAlreadyComplete(tx, request, request.handoff === true)) return { status: "complete" as const };
        if (!session || !request.operation || session.operationOwner !== request.operation.owner ||
          session.version !== request.operation.generation || session.runtimeSandboxId !== request.runtimeSandboxId ||
          session.state === "DELETING") return { status: "busy" as const };
        const runOwner = session.operationOwner === workspaceRunOperationOwner(request.runId);
        // A crashed foreground capture can be resumed only by that same run,
        // after both durable leases expire. It never adopts another turn.
        const expiredHandoff = request.handoff &&
          session.operationOwner?.startsWith(`export:${request.runId}:`) &&
          session.operationExpiresAt !== null && session.operationExpiresAt <= new Date();
        if (!runOwner && !expiredHandoff) return { status: "busy" as const };
        const claim = await claimExportWith(tx, request);
        return ownExportClaim(tx, session, claim, request);
      });
    },
    async claimExportForRecovery(request) {
      return prisma.$transaction(async (tx) => {
        const session = await lockWorkspaceSession(tx, request.sessionId);
        if (await exportAlreadyComplete(tx, request)) return { status: "complete" as const };
        if (!session) throw new WorkspaceRuntimeError("workspace_output_export_failed");
        if (session.version !== request.generation || session.runtimeSandboxId !== request.runtimeSandboxId || session.state === "DELETING") return { status: "busy" as const };
        if (session.operationOwner && (!session.operationOwner.startsWith("export:") || !session.operationExpiresAt ||
          session.operationExpiresAt > new Date())) return { status: "busy" as const };
        const active = await tx.modelRun.count({
          where: { chatId: session.chatId, status: { in: [...ACTIVE_RUN_STATUSES] } }
        });
        if (active > 0) return { status: "busy" as const };
        const claim = await claimExportWith(tx, { ...request, recovery: true });
        return ownExportClaim(tx, session, claim, request);
      });
    },
    async exportRecoveryCandidates({ cursor, limit, staleBefore }) {
      const rows = await prisma.workspaceRunBinding.findMany({
        orderBy: [{ updatedAt: "asc" }, { modelRunId: "asc" }],
        select: { modelRun: { select: { userId: true } }, modelRunId: true, updatedAt: true },
        take: Math.max(1, Math.min(limit, 100)),
        where: {
          ...(cursor ? { AND: [{ OR: [
            { updatedAt: { gt: cursor.updatedAt } },
            { modelRunId: { gt: cursor.runId }, updatedAt: cursor.updatedAt }
          ] }] } : {}),
          exportAttemptCount: { lt: WORKSPACE_EXPORT_MAX_ATTEMPTS },
          modelRun: { status: "complete" },
          updatedAt: { lte: staleBefore },
          OR: [
            { exportState: "PENDING" },
            {
              exportState: "FAILED",
              updatedAt: { lte: new Date(staleBefore.getTime() - WORKSPACE_EXPORT_RECOVERY_GRACE_MS) },
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
      return rows.map((row) => ({ runId: row.modelRunId, updatedAt: row.updatedAt, userId: row.modelRun.userId }));
    },
    async reserveOutputCapture(lease) {
      return prisma.$transaction(async (tx) => {
        if (!(await hasActiveExportLease(tx, lease))) return null;
        const binding = await tx.workspaceRunBinding.findUniqueOrThrow({ select: { outputCapture: true }, where: { modelRunId: lease.runId } });
        if (binding.outputCapture !== null) return { ...parseOutputCapture(binding.outputCapture), create: false };
        const capture = { id: randomUUID().replaceAll("-", ""), outputs: null };
        await tx.workspaceRunBinding.update({ data: { outputCapture: capture }, where: { modelRunId: lease.runId } });
        return { ...capture, create: true };
      });
    },
    async sealOutputCapture(lease) {
      const outputs = outputIdentities(lease.capture.outputs);
      return prisma.$transaction(async (tx) => {
        if (!(await hasActiveExportLease(tx, lease))) return false;
        const binding = await tx.workspaceRunBinding.findUniqueOrThrow({ select: { outputCapture: true }, where: { modelRunId: lease.runId } });
        const capture = parseOutputCapture(binding.outputCapture);
        if (capture.id !== lease.capture.id) return false;
        if (capture.outputs !== null) return sameOutputIdentities(capture.outputs, outputs);
        await tx.workspaceRunBinding.update({ data: { outputCapture: { id: capture.id, outputs } }, where: { modelRunId: lease.runId } });
        return true;
      });
    },
    async outputHandoffReady({ runId, sessionId }) {
      const binding = await prisma.workspaceRunBinding.findFirst({
        select: { outputCapture: true },
        where: {
          modelRunId: runId, workspaceSessionId: sessionId, exportState: { in: ["PENDING", "COMPLETE"] },
          workspaceSession: { operationOwner: null, state: { in: ["PENDING", "READY", "STOPPED"] } }
        }
      });
      return binding?.outputCapture != null && parseOutputCapture(binding.outputCapture).outputs !== null;
    },
    async markExportPending(lease) {
      return prisma.$transaction(async (tx) => {
        if (!(await hasActiveExportLease(tx, lease))) return false;
        const binding = await tx.workspaceRunBinding.findUniqueOrThrow({ select: { outputCapture: true }, where: { modelRunId: lease.runId } });
        if (binding.outputCapture === null || parseOutputCapture(binding.outputCapture).outputs === null) return false;
        await tx.workspaceRunBinding.update({
          data: { exportState: "PENDING", exportLeaseToken: null, exportLeaseExpiresAt: null,
            exportAttemptCount: { decrement: 1 }, lastExportErrorCode: null },
          where: { modelRunId: lease.runId }
        });
        return true;
      });
    },
    async markExportComplete(lease) {
      return prisma.$transaction(async (tx) => {
        if (!(await hasActiveExportLease(tx, lease))) return false;
        const binding = await tx.workspaceRunBinding.findUniqueOrThrow({
          select: { outputCapture: true, outputs: { select: {
            byteSize: true, checksum: true, relativePath: true, attachment: { select: { mimeType: true } }
          } } }, where: { modelRunId: lease.runId }
        });
        if (binding.outputCapture === null) return false;
        const capture = parseOutputCapture(binding.outputCapture);
        if (capture.outputs === null || !sameOutputIdentities(capture.outputs,
          binding.outputs.map(({ attachment, ...output }) => ({ ...output, mimeType: attachment.mimeType })))) return false;
        const updated = await tx.workspaceRunBinding.updateMany({
          data: { exportCompletedAt: new Date(), exportLeaseExpiresAt: null, exportLeaseToken: null,
            exportState: "COMPLETE", lastExportErrorCode: null },
          where: { exportLeaseToken: lease.token, exportState: "EXPORTING", modelRunId: lease.runId, workspaceSessionId: lease.sessionId }
        });
        return updated.count === 1;
      });
    },
    async markExportFailed(lease) {
      return prisma.$transaction(async (tx) => {
        if (!(await hasActiveExportLease(tx, lease))) return false;
        const updated = await tx.workspaceRunBinding.updateMany({
          data: { exportLeaseExpiresAt: null, exportLeaseToken: null, exportState: "FAILED", lastExportErrorCode: lease.code.slice(0, 64) },
          where: { exportLeaseToken: lease.token, exportState: "EXPORTING", modelRunId: lease.runId, workspaceSessionId: lease.sessionId }
        });
        return updated.count === 1;
      });
    },
    async renewExportLease(lease) {
      return prisma.$transaction(async (tx) => {
        if (!(await hasActiveExportLease(tx, lease))) return false;
        const expiresAt = new Date(Date.now() + lease.leaseMs);
        const updated = await tx.workspaceRunBinding.updateMany({
          data: { exportLeaseExpiresAt: expiresAt },
          where: { exportLeaseToken: lease.token, exportState: "EXPORTING", modelRunId: lease.runId, workspaceSessionId: lease.sessionId }
        });
        if (updated.count !== 1) return false;
        await tx.workspaceSession.update({ data: { operationExpiresAt: expiresAt }, where: { id: lease.sessionId } });
        await tx.attachmentDeletionJob.updateMany({ data: { claimedAt: new Date() }, where: { claimToken: lease.token } });
        return true;
      });
    },
    async prepareOutput(lease) {
      return prisma.$transaction(async (tx) => {
        if (!(await hasActiveExportLease(tx, lease))) return false;
        // A crashed upload retains a leased cleanup obligation. Publication
        // deletes it atomically; otherwise normal retention reclaims it.
        await tx.attachmentDeletionJob.createMany({ data: {
          claimedAt: new Date(), claimToken: lease.token, storageKey: lease.storageKey
        }, skipDuplicates: true });
        const jobs = await tx.$queryRaw<Array<{ claimToken: string | null }>>`
          SELECT "claimToken" FROM "AttachmentDeletionJob" WHERE "storageKey" = ${lease.storageKey} FOR UPDATE`;
        return jobs[0]?.claimToken === lease.token;
      });
    },
    async markSessionFailed({ code, operation, sessionId }) {
      await prisma.workspaceSession.updateMany({
        data: { lastErrorCode: code.slice(0, 64), state: "FAILED" },
        where: { ...workspaceOperationWhere(operation), id: sessionId, state: { not: "DELETING" } }
      });
    },
    async markSessionLost({ operation, runtimeSandboxId, sessionId }) {
      return prisma.$transaction(async (tx) => {
        const session = await lockWorkspaceSession(tx, sessionId);
        if (!session || session.version !== operation.generation || session.operationOwner !== operation.owner ||
          session.runtimeSandboxId !== runtimeSandboxId || session.state === "DELETING") return null;
        const updated = await tx.workspaceSession.updateMany({
          data: {
            lastErrorCode: "workspace_session_lost",
            runtimeSandboxId: null,
            state: "FAILED",
            version: { increment: 1 }
          },
          where: {
            ...workspaceOperationWhere(operation),
            id: sessionId,
            runtimeSandboxId,
            state: { not: "DELETING" }
          }
        });
        if (updated.count === 1) await failWorkspaceExportsForLostDisk(tx, sessionId,
          operation.owner.startsWith("run:") ? operation.owner.slice(4) : undefined);
        return updated.count === 1 ? { generation: operation.generation + 1, owner: operation.owner } : null;
      });
    },
    async markSessionRunning({ expiresAt, lastActiveAt, operation, runtimeSandboxId, sessionId }) {
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
          ...workspaceOperationWhere(operation),
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
    async markSessionStarting({ expiresAt, lastActiveAt, operation, sessionId }) {
      const updated = await prisma.workspaceSession.updateMany({
        data: {
          expiresAt,
          lastActiveAt,
          lastErrorCode: null,
          state: "CREATING",
          stoppedAt: null
        },
        where: { ...workspaceOperationWhere(operation), id: sessionId, state: { not: "DELETING" } }
      });
      return updated.count === 1;
    },
    async markSessionReady({ expiresAt, lastActiveAt, operation, sessionId }) {
      await prisma.workspaceSession.updateMany({
        data: { expiresAt, lastActiveAt, state: "READY", stoppedAt: null },
        where: { ...workspaceOperationWhere(operation), id: sessionId, state: { in: ["CREATING", "RUNNING", "READY"] } }
      });
    },
    async settleSession({ operation, outcome, runtimeSandboxId, sessionId }) {
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "WorkspaceSession" WHERE "id" = ${sessionId} FOR UPDATE`;
        if (!(await tx.workspaceSession.findFirst({
          select: { id: true }, where: { ...workspaceOperationWhere(operation), id: sessionId, runtimeSandboxId }
        }))) return false;
        await acknowledgeWorkspaceCommandsStopped(tx, sessionId);
        const updated = await tx.workspaceSession.updateMany({
          data: {
            operationOwner: null, operationExpiresAt: null,
            ...(outcome === "stopped"
              ? { state: "STOPPED" as const, stoppedAt: new Date() }
              : { state: outcome === "ready" ? "READY" as const : "PENDING" as const, stoppedAt: null })
          },
          where: {
            ...workspaceOperationWhere(operation),
            id: sessionId,
            runtimeSandboxId,
            state: { not: "DELETING" }
          }
        });
        return updated.count === 1;
      });
    },
    async settleOutput({ binding, output, storageKey, token }) {
      if (!isSafeWorkspaceRelativePath(output.relativePath)) {
        throw new WorkspaceRuntimeError("workspace_output_limit_exceeded");
      }
      const lease = { operation: ownedOperation(binding), runId: binding.runId, runtimeSandboxId: binding.runtimeSandboxId,
        sessionId: binding.sessionId, token };
      const reuse = (existing: Parameters<typeof generatedFile>[0] & { byteSize: number; checksum: string }) => {
        // Same path with different bytes means the output changed after it was
        // settled: fail closed instead of silently replacing a delivered file.
        if (existing.byteSize !== output.byteSize || existing.checksum !== output.checksum) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        return generatedFile(existing);
      };
      // The session lock serializes all publishers of this binding/path.
      return prisma.$transaction(async (tx) => {
        if (!(await hasActiveExportLease(tx, lease))) throw new WorkspaceRuntimeError("workspace_operation_stale");
        const captureRow = await tx.workspaceRunBinding.findUniqueOrThrow({ select: { outputCapture: true }, where: { modelRunId: binding.runId } });
        const owed = parseOutputCapture(captureRow.outputCapture).outputs?.find((entry) => entry.relativePath === output.relativePath);
        if (!owed || !sameOutputIdentities([owed], [output])) throw new WorkspaceRuntimeError("workspace_output_export_failed");
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
        const jobs = await tx.$queryRaw<Array<{ claimToken: string | null }>>`
          SELECT "claimToken" FROM "AttachmentDeletionJob" WHERE "storageKey" = ${storageKey} FOR UPDATE`;
        if (jobs[0]?.claimToken !== token) throw new WorkspaceRuntimeError("workspace_operation_stale");
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
        await tx.attachmentDeletionJob.delete({ where: { storageKey } });
        return generatedFile(row);
      });
    }
  };
}

/** All export writers take the same Chat -> session lock before the binding. */
async function hasActiveExportLease(tx: Prisma.TransactionClient, lease: WorkspaceExportLease): Promise<boolean> {
  const session = await lockWorkspaceSession(tx, lease.sessionId);
  if (!session || !lease.operation || session.operationOwner !== lease.operation.owner || session.version !== lease.operation.generation ||
    session.runtimeSandboxId !== lease.runtimeSandboxId || session.state === "DELETING") return false;
  const now = new Date();
  if (!session.operationExpiresAt || session.operationExpiresAt <= now) return false;
  return await tx.workspaceRunBinding.count({ where: {
    exportLeaseExpiresAt: { gt: now }, exportLeaseToken: lease.token, exportState: "EXPORTING",
    modelRunId: lease.runId, workspaceSessionId: lease.sessionId
  } }) === 1;
}

type WorkspaceBindingExportClaim = Exclude<WorkspaceExportClaim, { status: "claimed" }> |
  Readonly<{ status: "claimed"; token: string }>;

async function exportAlreadyComplete(tx: Prisma.TransactionClient, request: { runId: string; sessionId: string }, handoff = false): Promise<boolean> {
  const binding = await tx.workspaceRunBinding.findUnique({
    select: { exportState: true, workspaceSessionId: true }, where: { modelRunId: request.runId }
  });
  if (!binding || binding.workspaceSessionId !== request.sessionId) throw new WorkspaceRuntimeError("workspace_output_export_failed");
  // A failed capture may already have retired its session owner. Report its
  // terminal result before the owner check can misclassify it as still busy.
  if (handoff && binding.exportState === "FAILED") throw new WorkspaceRuntimeError("workspace_output_export_failed");
  return binding.exportState === "COMPLETE";
}

async function ownExportClaim(
  tx: Prisma.TransactionClient, session: { id: string; version: number }, claim: WorkspaceBindingExportClaim,
  request: { leaseMs: number; runId: string }
): Promise<WorkspaceExportClaim> {
  if (claim.status !== "claimed") return claim;
  const operation = { generation: session.version + 1, owner: `export:${request.runId}:${claim.token}` };
  await tx.workspaceSession.update({ data: {
    version: operation.generation, operationOwner: operation.owner, operationExpiresAt: new Date(Date.now() + request.leaseMs)
  }, where: { id: session.id } });
  return { ...claim, operation };
}

const ACTIVE_RUN_STATUSES = ["preparing", "queued", "in_progress", "streaming"] as const;

async function claimExportWith(
  client: Prisma.TransactionClient | PrismaClient,
  input: Readonly<{ leaseMs: number; recovery?: boolean; runId: string; sessionId: string }>
): Promise<WorkspaceBindingExportClaim> {
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
      ...(input.recovery ? { exportAttemptCount: { lt: WORKSPACE_EXPORT_MAX_ATTEMPTS } } : {}),
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
    select: { exportAttemptCount: true, exportState: true, lastExportErrorCode: true, workspaceSessionId: true },
    where: { modelRunId: input.runId }
  });
  if (!binding || binding.workspaceSessionId !== input.sessionId) {
    throw new WorkspaceRuntimeError("workspace_output_export_failed");
  }
  if (binding.exportState === "COMPLETE") return { status: "complete" };
  if (input.recovery && binding.exportAttemptCount >= WORKSPACE_EXPORT_MAX_ATTEMPTS) return { status: "exhausted" };
  if (binding.exportState === "FAILED") {
    return {
      code: binding.lastExportErrorCode ?? "workspace_output_export_failed",
      status: "failed"
    };
  }
  return { status: "busy" };
}

export type WorkspaceExportResult =
  | Readonly<{ status: "pending" }>
  | Readonly<{ files: readonly ThreadGeneratedFile[]; status: "complete" }>
  | Readonly<{ reason: "access_unavailable" | "attempts_exhausted" | "cancelled"; status: "deferred" }>
  | Readonly<{ status: "busy" }>
  | Readonly<{ code: WorkspaceRuntimeError["code"]; retryable: boolean; status: "failed" }>;

export type WorkspaceSettlementOutcome = "cancelled" | "completed" | "failed" | "timed_out";

export type WorkspaceActivityListener = (entry: ThreadWorkspaceActivityEntry) => Promise<void>;

export type WorkspaceSettlementResult = Readonly<{
  /** Every execution of the run is provably gone (closed, or the VM was stopped). */
  quiesced: boolean;
  sessionSettled: boolean;
  stoppedVm: boolean;
}>;

export type WorkspaceCoordinator = Readonly<{
  /** Stage authorized immutable images into an already running operation. */
  imagePath?(input: Readonly<{
    attachmentId: string; runId: string; userId: string; workspace: NormalizedRunWorkspace; signal?: AbortSignal;
  }>): Promise<string>;
  /** Deliver only a frozen, server-resolved bundle after the tool result budget accepts it. */
  skillBundlePath?(input: Readonly<{
    alias: string;
    install: boolean;
    onActivity?: WorkspaceActivityListener;
    runId: string;
    signal?: AbortSignal;
    userId: string;
    workspace: NormalizedRunWorkspace;
  }>): Promise<string>;
  /** One native Codex turn. The caller has persisted its dispatch obligation. */
  executeAgent?(input: Readonly<{
    modelRunToolCallId: string;
    onActivity?: WorkspaceActivityListener;
    onEvent(event: CodexEvent, text: WorkspaceActivityText): Promise<void>;
    profile: CodexManagedProfile;
    prompt: string;
    resumePrompt: string;
    runId: string;
    runToken: string;
    signal: AbortSignal;
    threadId?: string;
    previousToolCallId?: string;
    /** Claims a durable interrupt only at a settled native tool boundary. */
    shouldInterrupt?(): Promise<boolean>;
    timeoutSeconds: number | null;
    userId: string;
    workspace: NormalizedRunWorkspace;
  }>): Promise<"interrupted" | void>;
  accepts(input: Readonly<{ name: string; workspace: NormalizedRunWorkspace }>): boolean;
  /**
   * Before a scheduled run's first model request: starts the Workspace and
   * restores the files its task's monthly rotation carried into the chat,
   * so no tool or command of the run meets an empty carried project. A
   * restore that cannot complete throws `workspace_carryover_unavailable`.
   * Does nothing for any other run.
   */
  prepareCarryover?(input: Readonly<{
    onActivity?: WorkspaceActivityListener;
    runId: string;
    signal?: AbortSignal;
    userId: string;
    workspace: NormalizedRunWorkspace;
  }>): Promise<void>;
  execute(input: Readonly<{
    call: ModelToolCall;
    modelRunToolCallId: string;
    /** Receives client-safe activity entries in timeline order (lifecycle, then the running step). */
    onActivity?: WorkspaceActivityListener;
    runId: string;
    signal?: AbortSignal;
    userId: string;
    workspace: NormalizedRunWorkspace;
  }>): Promise<ToolExecutionResult>;
  /** Quiesce, pin private bytes and release session ownership before answer completion. */
  handoff(input: Readonly<{
    onActivity?: WorkspaceActivityListener;
    runId: string;
    signal?: AbortSignal;
    userId: string;
    workspace: NormalizedRunWorkspace;
  }>): Promise<Readonly<{ status: "busy" | "ready" }>>;
  /**
   * Leased, idempotent output export. Never throws for export trouble: the
   * answer stays complete and the binding records the export state instead.
   */
  finalize(input: Readonly<{
    /** Internal capture phase used by handoff; it never transfers objects. */
    handoff?: boolean;
    onActivity?: WorkspaceActivityListener;
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
    onActivity?: WorkspaceActivityListener;
    /** Captured by an export attempt; a retry must never adopt a successor. */
    operation?: WorkspaceOperation;
    /** Export/recovery finalizers must not write personal session settings. */
    skipBrowserSave?: boolean;
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

function activityErrorCode(code: WorkspaceRuntimeError["code"]): WorkspaceErrorCode {
  if (isWorkspaceErrorCode(code)) return code;
  if (code === "workspace_operation_stale") return "workspace_busy";
  if (code === "workspace_session_lost_before_dispatch") return "workspace_session_lost";
  return "workspace_runtime_unavailable";
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

function outputStorageKey(binding: WorkspaceExecutionBinding, output: WorkspaceOutputStream, token: string): string {
  const pathHash = createHash("sha256").update(output.relativePath).digest("hex");
  const owner = binding.projectId ? `projects/${binding.projectId}` : binding.userId;
  return `${owner}/workspace-outputs/${binding.runId}/${token}/${pathHash}-${output.checksum}`;
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
/**
 * Settlement and handoff share one browser autosave window, sized for the
 * aggregate state budget. States committed before it ends remain saved and an
 * unfinished save is recorded in the run's visible autosave outcome.
 */
const BROWSER_SESSION_SAVE_TIMEOUT_MS = 30_000;

function isExecSessionTool(name: string): boolean {
  return EXEC_SESSION_TOOLS.has(name);
}

function executionErrorResult(
  call: ModelToolCall,
  text: string,
  code: "operation_failed" | "workspace_shell_syntax_requires_shell" | WorkspaceOperationFailureCode = "operation_failed"
): ToolExecutionResult {
  return retainWorkspaceResultCode({
    callId: call.id,
    content: [{ text: JSON.stringify({ error: { code, message: text }, ok: false }), type: "text" }],
    name: call.name,
    rawPreview: { truncated: false },
    status: "error"
  }, code);
}

function withActivity(
  result: ToolExecutionResult,
  entry: ThreadWorkspaceActivityEntry | null
): ToolExecutionResult {
  return inheritWorkspaceResultCode(result, entry
    ? { ...result, artifacts: [...(result.artifacts ?? []), workspaceActivityEvent(entry)] }
    : result);
}

function resultFromRuntime(call: ModelToolCall, result: WorkspaceToolResult, secretMasked = false): ToolExecutionResult {
  const content: ToolExecutionResult["content"] = [];
  for (const entry of result.content) {
    if (entry.type === "text" && typeof entry.text === "string") {
      content.push({ text: entry.text, type: "text" });
    } else if (entry.type === "json") {
      content.push({ type: "json", value: entry.value });
    }
  }
  const projected: ToolExecutionResult = {
    callId: call.id,
    content,
    name: call.name,
    rawPreview: {
      ...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
      ...(result.originalByteCount === undefined
        ? {}
        : { originalByteCount: result.originalByteCount }),
      // Content-free: tells activity that delivered secret values were masked.
      ...(secretMasked ? { secretMasked: true } : {}),
      truncated: result.truncated === true
    },
    status: result.status
  };
  return result.errorCode ? retainWorkspaceResultCode(projected, result.errorCode) : projected;
}

/**
 * One compact, content-free line for the model about the MCP calls the
 * command's code made, and the same facts for activity. Never arguments,
 * results or endpoints.
 */
function withCodeCallSummary(result: ToolExecutionResult, summary: WorkspaceCodeCallSummary | null): ToolExecutionResult {
  if (!summary) return result;
  return inheritWorkspaceResultCode(result, {
    ...result,
    content: [...result.content, { text: workspaceCodeCallSummaryLine(summary), type: "text" }],
    rawPreview: { ...result.rawPreview, codeMcp: workspaceCodeCallActivity(summary) }
  });
}

function codeCallSignature(summary: WorkspaceCodeCallSummary): string {
  return `${summary.calls}:${summary.failed}:${summary.unknown}:${summary.refused}`;
}

export function createWorkspaceCoordinator(input: Readonly<{
  config: WorkspaceConfig;
  registry: WorkspaceExecutionRegistry;
  repository: WorkspaceCoordinatorRepository;
  runtime: WorkspaceRuntime;
  skills?: WorkspaceSkillBundles;
  storage: StorageAdapter;
}>): WorkspaceCoordinator {
  const initializing = new Map<string, Promise<WorkspaceExecutionBinding>>();
  const initialized = new Map<string, WorkspaceExecutionBinding>();
  const skillPlans = new Map<string, WorkspaceSkillPlan>();
  // Projection state for the activity timeline: original inbox filenames per
  // guest path and bounded output buffers per long-lived execution.
  const inboxNamesByRun = new Map<string, Map<string, string>>();
  const execOutputsByRun = new Map<string, Map<string, ExecOutputBuffer>>();
  const activityTextByRun = new Map<string, WorkspaceActivityText>();
  const outputMaskByRun = new Map<string, WorkspaceSecretOutputMask>();
  // Exec sessions report their code calls on the first poll that changes them.
  const reportedCodeCallsByRun = new Map<string, Map<string, string>>();
  const lifecycleOrdinal = new Map<string, number>();
  let recoveryCursor: WorkspaceExportRecoveryCursor | undefined;
  let recoveryScanBefore: Date | undefined;
  let recoveryWork: Promise<Readonly<{ attempted: number; completed: number }>> | null = null;

  function nextLifecycleOrdinal(runId: string): number {
    const value = (lifecycleOrdinal.get(runId) ?? 0) + 1;
    lifecycleOrdinal.set(runId, value);
    return value;
  }

  function forgetRun(runId: string): void {
    initializing.delete(runId);
    initialized.delete(runId);
    skillPlans.delete(runId);
    inboxNamesByRun.delete(runId);
    execOutputsByRun.delete(runId);
    activityTextByRun.delete(runId);
    outputMaskByRun.delete(runId);
    reportedCodeCallsByRun.delete(runId);
    lifecycleOrdinal.delete(runId);
  }

  /**
   * MCP from guest code: the run environment of this initialization (a fresh
   * bearer with the relay origin, or why there is none). A failure grants
   * nothing and leaves the Workspace usable; a stale operation still fails.
   */
  async function issueCodeGrant(binding: WorkspaceExecutionBinding): Promise<WorkspaceCodeGrantIssue | null> {
    if (!input.repository.issueCodeGrant) return null;
    try {
      return await input.repository.issueCodeGrant(binding);
    } catch (error) {
      if (error instanceof WorkspaceRuntimeError) throw error;
      logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "prepare", outcome: "degraded",
        code: "workspace_code_grant_unavailable", prisma_code: databaseFailureCode(error), action: "degrade" });
      return { environment: { [WORKSPACE_CODE_UNAVAILABLE_ENV]: "gateway_unavailable" } };
    }
  }

  async function revokeCodeGrant(runId: string): Promise<void> {
    await input.repository.revokeCodeGrant?.({ runId }).catch((error: unknown) => {
      logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "release", outcome: "failed",
        code: "workspace_code_grant_unavailable", prisma_code: databaseFailureCode(error), action: "skip" });
    });
  }

  /** Every code call of an accepted sandbox tool call; exec polls report only changes. */
  async function codeCallSummary(runId: string, toolCallId: string | null, onlyChanges: boolean): Promise<WorkspaceCodeCallSummary | null> {
    if (!toolCallId || !input.repository.codeCallSummary) return null;
    const summary = await input.repository.codeCallSummary({ runId, toolCallId }).catch(() => null);
    if (!summary) return null;
    const reported = reportedCodeCallsByRun.get(runId) ?? new Map<string, string>();
    reportedCodeCallsByRun.set(runId, reported);
    const signature = codeCallSignature(summary);
    if (onlyChanges && reported.get(toolCallId) === signature) return null;
    reported.set(toolCallId, signature);
    return summary;
  }

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
    if (binding.operationOwner !== workspaceRunOperationOwner(runId)) throw new WorkspaceRuntimeError("workspace_operation_stale");
    ownedOperation(binding);
    return binding;
  }

  async function stageInputs(binding: WorkspaceExecutionBinding, signal?: AbortSignal, onActivity?: WorkspaceActivityListener, requiredImageId?: string) {
    if (!binding.runtimeSandboxId) throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
    signal?.throwIfAborted();
    const lifecycle = (entry: Parameters<typeof workspaceLifecycleActivity>[0]) =>
      onActivity?.(workspaceLifecycleActivity(entry)).catch(() => undefined) ?? Promise.resolve();
    const attachments = await input.repository.attachments(binding);
    if (requiredImageId && !attachments.some(attachment => attachment.attachmentId === requiredImageId && attachment.kind === "image")) {
      throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
    }
    const prepareStartedAt = new Date();
    const prepareOrdinal = nextLifecycleOrdinal(binding.runId);
    const entries = attachments.map((attachment) => ({
      attachmentId: attachment.attachmentId,
      byteSize: attachment.byteSize,
      checksum: attachment.checksum,
      createdAt: attachment.createdAt,
      kind: attachment.kind,
      messageId: attachment.messageId,
      mimeType: attachment.mimeType,
      originalName: attachment.fileName,
      source: attachment.origin === "WORKSPACE_OUTPUT" || attachment.origin === "IMAGE_OUTPUT" ? "export" : "upload",
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
      attachments: entries.map(({ attachmentId, byteSize, checksum, sandboxPath }) => ({ attachmentId, byteSize, checksum, sandboxPath })),
      runtimeSandboxId: binding.runtimeSandboxId,
      operation: ownedOperation(binding), sessionId: binding.sessionId,
      signal
    }).catch(() => []);
    const missing = entries.filter(entry => !staged.some((candidate) =>
        candidate.attachmentId === entry.attachmentId &&
        candidate.byteSize === entry.byteSize &&
        candidate.checksum === entry.checksum &&
        candidate.sandboxPath === entry.sandboxPath));
    if (missing.reduce((sum, entry) => sum + entry.byteSize, 0) + 16 * 1024 * 1024 > input.config.diskMiB * 1024 * 1024) {
      throw new WorkspaceRuntimeError("workspace_storage_full");
    }
    // Originals open lazily, one storage connection at a time, as the runtime
    // consumes them; opening every body up front exhausted the shared pool.
    const acquisition = createWorkspaceAttachmentAcquisition({ signal, storage: input.storage });
    const streams: WorkspaceAttachmentStream[] = missing.map((entry) => ({
      attachmentId: entry.attachmentId,
      body: acquisition.body(entry),
      byteSize: entry.byteSize,
      checksum: entry.checksum,
      kind: entry.kind,
      messageId: entry.messageId,
      mimeType: entry.mimeType,
      originalName: entry.originalName,
      sandboxPath: entry.sandboxPath
    }));
    // Only originals that actually transfer are "prepared"; an unchanged
    // inbox produces no row at all.
    if (streams.length > 0) {
      await lifecycle({
        count: streams.length,
        kind: "attachments_prepare",
        ordinal: prepareOrdinal,
        phase: "running",
        runId: binding.runId,
        startedAt: prepareStartedAt
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
      createdAt: entry.createdAt,
      kind: entry.kind,
      mimeType: entry.mimeType,
      originalName: entry.originalName,
      messageId: entry.messageId,
      source: entry.source,
      sandboxPath: entry.sandboxPath
    });
    // The index, every message manifest, and the current run's output
    // directory are always rewritten so the guest view stays complete.
    try {
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
        runtimeSandboxId: binding.runtimeSandboxId,
        operation: ownedOperation(binding), sessionId: binding.sessionId,
        signal
      });
      if (signal?.aborted) throw new WorkspaceRuntimeError("workspace_tool_cancelled");
    } catch (error) {
      // A runtime reports a failed body as its own transport error; the
      // acquisition knows whether storage was missing, stalled or cancelled.
      const failure = acquisition.failure() ?? error;
      if (streams.length > 0) {
        await lifecycle({
          ...(signal?.aborted ? {} : { errorCode: activityErrorCode(runtimeCode(failure)) }),
          count: streams.length,
          durationMs: Date.now() - prepareStartedAt.getTime(),
          kind: "attachments_prepare",
          ordinal: prepareOrdinal,
          phase: signal?.aborted ? "cancelled" : "failed",
          runId: binding.runId,
          startedAt: prepareStartedAt
        });
      }
      throw failure;
    } finally {
      await acquisition.close();
    }
    inboxNamesByRun.set(
      binding.runId,
      new Map(entries.map((entry) => [entry.sandboxPath, entry.originalName]))
    );
    if (streams.length > 0) {
      await lifecycle({
        count: streams.length,
        durationMs: Date.now() - prepareStartedAt.getTime(),
        kind: "attachments_prepare",
        ordinal: prepareOrdinal,
        phase: "succeeded",
        runId: binding.runId,
        startedAt: prepareStartedAt
      });
    }
    return entries;
  }

  async function initialize(
    binding: WorkspaceExecutionBinding,
    purpose: "execution" | "export",
    signal?: AbortSignal,
    onActivity?: WorkspaceActivityListener,
    predecessor?: WorkspaceOperation
  ): Promise<WorkspaceExecutionBinding> {
    ownedOperation(binding);
    const ready = initialized.get(binding.runId);
    if (
      ready &&
      ready.operationGeneration === binding.operationGeneration &&
      ready.operationOwner === binding.operationOwner &&
      ready.runtimeSandboxId !== null &&
      ready.runtimeSandboxId === binding.runtimeSandboxId &&
      (purpose === "export" || skillPlans.has(binding.runId))
    ) {
      return ready;
    }
    const pending = initializing.get(binding.runId);
    if (pending) {
      const resolved = await pending;
      if (purpose === "export" || skillPlans.has(binding.runId)) return resolved;
      return initialize(resolved, purpose, signal, onActivity);
    }
    skillPlans.delete(binding.runId);
    const operation = (async () => {
      if (!await input.repository.markGuestUsed(binding)) throw new WorkspaceRuntimeError("workspace_operation_stale");
      const startedAt = new Date();
      const startOrdinal = nextLifecycleOrdinal(binding.runId);
      const lifecycle = (entry: Parameters<typeof workspaceLifecycleActivity>[0]) =>
        onActivity?.(workspaceLifecycleActivity(entry)).catch(() => undefined) ?? Promise.resolve();
      await lifecycle({
        kind: "workspace_start",
        ordinal: startOrdinal,
        phase: "running",
        runId: binding.runId,
        startedAt
      });
      if (!(await input.repository.markSessionStarting({
        ...activityWindow(),
        operation: ownedOperation(binding), sessionId: binding.sessionId
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
          operation: ownedOperation(binding), ...(predecessor ? { predecessor } : {}), sessionId: binding.sessionId,
          signal
        }).catch((error: unknown) => {
          throw error instanceof WorkspaceRuntimeError && error.code === "workspace_session_lost" ? new WorkspaceSandboxMissing() : error;
        });
        const continuationSeed = await input.repository.claimContinuationSeed?.({
          chatId: binding.chatId, operation: ownedOperation(binding), sessionId: binding.sessionId
        });
        if (continuationSeed) {
          // A scheduled task's carried files never give way to an empty project:
          // the claim is released with its archive kept for a later run.
          const releaseRequired = async () => {
            if (!await input.repository.settleContinuationSeed?.({ id: continuationSeed.id, token: continuationSeed.token,
              status: "TRANSFERRED" })) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
            throw new WorkspaceRuntimeError("workspace_carryover_unavailable");
          };
          if (!input.runtime.restoreProjectArchive) {
            if (continuationSeed.required) await releaseRequired();
            await input.repository.settleContinuationSeed?.({ id: continuationSeed.id, token: continuationSeed.token,
              status: "FAILED", failureCode: "workspace_archive_restore_failed" });
            throw new WorkspaceRuntimeError("workspace_archive_restore_failed");
          }
          let restored = false;
          try {
            const archive = await getStoredObjectStream(input.storage, continuationSeed.storageKey, {
              maxBytes: input.config.outputTotalMaxBytes, signal
            });
            if (archive.byteSize !== continuationSeed.byteSize) {
              await archive.body.cancel().catch(() => undefined);
              throw new WorkspaceRuntimeError("workspace_archive_invalid");
            }
            await input.runtime.restoreProjectArchive({ archive: archive.body, byteSize: continuationSeed.byteSize,
              checksum: continuationSeed.checksum, runtimeSandboxId: session.runtimeSandboxId,
              operation: ownedOperation(binding), sessionId: binding.sessionId, signal });
            restored = true;
          } catch (error) {
            // Restore is transactional at the runtime boundary: it validates
            // before touching the project and removes its own staging. Only an
            // unproven cleanup keeps the claim, so lease expiry retries it;
            // otherwise the original bytes are never retried automatically.
            if (error instanceof WorkspaceRuntimeError && error.code === "workspace_execution_cleanup_failed") throw error;
            if (continuationSeed.required) await releaseRequired();
            if (!await input.repository.settleContinuationSeed?.({ id: continuationSeed.id, token: continuationSeed.token,
              status: "FAILED", failureCode: error instanceof WorkspaceRuntimeError ? error.code : "workspace_archive_restore_failed" })) {
              throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
            }
          }
          // A lost settlement response can already have committed RESTORED.
          // Never erase proven files because a database acknowledgement failed.
          if (restored && !await input.repository.settleContinuationSeed?.({
            id: continuationSeed.id, token: continuationSeed.token, status: "RESTORED"
          })) throw new WorkspaceRuntimeError("workspace_operation_stale");
        }
        if (!(await input.repository.markSessionRunning({
          ...activityWindow(),
          runtimeSandboxId: session.runtimeSandboxId,
          operation: ownedOperation(binding), sessionId: binding.sessionId
        }))) {
          throw new WorkspaceRuntimeError("workspace_session_lost");
        }
        await lifecycle({
          durationMs: Date.now() - startedAt.getTime(),
          kind: "workspace_start",
          ordinal: startOrdinal,
          phase: "succeeded",
          runId: binding.runId,
          startedAt
        });
        try {
          const secrets = await input.repository.personalSecrets(binding);
          // Only an execution initialization of the run itself mints guest-code
          // MCP authority. It travels in the same run-bound managed environment
          // (also for Project runs, which receive no personal secrets) and its
          // exact value is masked like a delivered secret.
          const code = purpose === "execution" ? await issueCodeGrant(binding) : null;
          const matches: WorkspaceSecretMatch[] = [...workspaceSecretMatches(secrets),
            ...(code?.token ? [{ name: WORKSPACE_CODE_TOKEN_ENV, value: code.token }] : [])];
          activityTextByRun.set(binding.runId, new WorkspaceActivityText(matches));
          outputMaskByRun.set(binding.runId, new WorkspaceSecretOutputMask(matches));
          await input.runtime.syncPersonalSecrets({
            secrets, modelRunId: binding.runId,
            ...(code && Object.keys(code.environment).length > 0 ? { runEnvironment: code.environment } : {}),
            // Unattended runs keep the chat's package cache bounded; interactive ones are left alone.
            ...(purpose === "execution" && binding.scheduled ? { boundUvCache: true } : {}),
            runtimeSandboxId: session.runtimeSandboxId, operation: ownedOperation(binding), sessionId: binding.sessionId, signal
          });
        } catch (error) {
          if (error instanceof WorkspaceRuntimeError) throw error;
          throw new WorkspaceRuntimeError("workspace_secrets_prepare_failed");
        }
        await stageInputs({ ...binding, runtimeSandboxId: session.runtimeSandboxId }, signal, onActivity);
        // Export settles an accepted output obligation, including after access
        // revocation. It must not authorize or redeliver Skill instructions.
        if (purpose === "execution") {
          const skillPlan = input.skills ? await input.skills.plan({ runId: binding.runId, userId: binding.userId })
            : { agent: false, initial: [], manifestHash: hashCanonicalMcpValue({ version: 1, skills: [] }) };
          const skillIdentity = { modelRunId: binding.runId, manifestHash: skillPlan.manifestHash,
            runtimeSandboxId: session.runtimeSandboxId, operation: ownedOperation(binding), sessionId: binding.sessionId, signal };
          const skillState = await input.runtime.prepareSkillRun({ ...skillIdentity, initial: skillPlan.initial });
          // The guest's durable marker is authoritative after app/runner restart.
          // Replaying a settled load must preserve edits in that same guest.
          if (skillState.state !== "ready") {
            for (const expected of skillPlan.initial) {
              const archive = await input.skills!.archive({ runId: binding.runId, userId: binding.userId, alias: expected.alias, signal });
              if (hashCanonicalMcpValue(archive.bundle) !== hashCanonicalMcpValue(expected)) {
                await archive.archive.cancel().catch(() => undefined);
                throw new WorkspaceRuntimeError("workspace_skill_bundle_invalid");
              }
              const installed = await input.runtime.installSkillBundle({ ...skillIdentity, ...archive });
              if (installed.workspacePath !== workspaceSkillPath(expected.alias)) throw new WorkspaceRuntimeError("workspace_skill_bundle_invalid");
            }
            await input.runtime.completeSkillRunPreparation(skillIdentity);
          }
          skillPlans.set(binding.runId, skillPlan);
        }
        const catalog = await input.runtime.loadBoundTools({
          runtimeSandboxId: session.runtimeSandboxId,
          operation: ownedOperation(binding), sessionId: binding.sessionId,
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
          await lifecycle({
            kind: "workspace_start",
            ordinal: startOrdinal,
            phase: "cancelled",
            runId: binding.runId,
            startedAt
          });
          throw new WorkspaceRuntimeError("workspace_tool_cancelled");
        }
        await lifecycle({
          errorCode: activityErrorCode(runtimeCode(error)),
          kind: "workspace_start",
          ordinal: startOrdinal,
          phase: "failed",
          runId: binding.runId,
          startedAt
        });
        let lostOperation: WorkspaceOperation | null = null;
        // An export confirms a loss itself, only through a second lookup within its lease.
        if (
          purpose === "execution" &&
          error instanceof WorkspaceRuntimeError &&
          error.code === "workspace_session_lost" &&
          binding.runtimeSandboxId
        ) {
          lostOperation = await input.repository.markSessionLost({
            runtimeSandboxId: binding.runtimeSandboxId,
            operation: ownedOperation(binding), sessionId: binding.sessionId
          }).catch(() => null);
        }
        await input.repository.markSessionFailed({
          code: runtimeCode(error),
          operation: ownedOperation(binding), sessionId: binding.sessionId
        }).catch(() => undefined);
        if (lostOperation) throw new WorkspaceConfirmedSessionLoss(lostOperation);
        throw error;
      }
    })().finally(() => initializing.delete(binding.runId));
    initializing.set(binding.runId, operation);
    return operation;
  }

  async function initializeWithLostSessionRecovery(
    binding: WorkspaceExecutionBinding,
    workspace: NormalizedRunWorkspace,
    signal?: AbortSignal,
    onActivity?: WorkspaceActivityListener
  ): Promise<Readonly<{ binding: WorkspaceExecutionBinding; recreated: boolean }>> {
    let recreated = binding.runtimeSandboxId === null && binding.sessionErrorCode === "workspace_session_lost";
    let ready: WorkspaceExecutionBinding;
    try {
      ready = await initialize(binding, "execution", signal, onActivity);
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
      ready = await initialize(fresh, "execution", signal, onActivity);
      recreated = true;
    }
    if (recreated) {
      // Loss may have been confirmed by the previous answer's handoff.
      await onActivity?.(workspaceLifecycleActivity({
        kind: "workspace_recreated",
        ordinal: nextLifecycleOrdinal(binding.runId),
        phase: "succeeded",
        runId: binding.runId,
        startedAt: new Date()
      })).catch(() => undefined);
    }
    return { binding: ready, recreated };
  }

  const SHELL_SYNTAX = /&&|\|\||[|;<>`$\n]|\s/u;

  function projectionState(runId: string): Map<string, ExecOutputBuffer> {
    const existing = execOutputsByRun.get(runId);
    if (existing) return existing;
    const created = new Map<string, ExecOutputBuffer>();
    execOutputsByRun.set(runId, created);
    return created;
  }

  async function quiesceRun(
    binding: WorkspaceExecutionBinding,
    signal?: AbortSignal
  ): Promise<WorkspaceQuiescence> {
    if (!binding.runtimeSandboxId) {
      if (binding.sessionState === "CREATING" || binding.sessionState === "FAILED") {
        // An aborted remote bootstrap can have acquired a VM without returning
        // its identity. The runner retains that exact handle and waits for its
        // accepted initializer before acknowledging this cleanup.
        try {
          await input.runtime.stopSession({ runtimeSandboxId: null, operation: ownedOperation(binding), sessionId: binding.sessionId });
        } catch {
          return { proven: false, stoppedVm: false, failureCode: "workspace_execution_stop_failed" };
        }
      }
      return { proven: true, stoppedVm: false };
    }
    return quiesceWorkspaceExecutions({
      unregisteredCommands: await input.repository.unregisteredCommands({ runId: binding.runId }),
      modelRunId: binding.runId,
      registry: input.registry,
      runtime: input.runtime,
      runtimeSandboxId: binding.runtimeSandboxId,
      operation: ownedOperation(binding), sessionId: binding.sessionId,
      signal
    });
  }

  async function persistBrowserSessions(binding: WorkspaceExecutionBinding, signal: AbortSignal, handoffToken?: string): Promise<void> {
    if (binding.projectId || !binding.runtimeSandboxId || !binding.operationOwner) return;
    let collection: Awaited<ReturnType<WorkspaceRuntime["collectBrowserSessions"]>> | null = null;
    try {
      try {
        collection = await input.runtime.collectBrowserSessions({ modelRunId: binding.runId, runtimeSandboxId: binding.runtimeSandboxId,
          operation: ownedOperation(binding), sessionId: binding.sessionId, signal });
      } catch {
        collection = null;
      }
      // States stream one at a time into the store after it authorizes this
      // run; an expired deadline is recorded there as an unfinished save.
      const report = await input.repository.saveBrowserSessions({
        files: collection ? readWorkspaceBrowserCollection(collection, signal) : [],
        skipped: collection ? collection.skipped : signal.aborted ? [] : ["browser_session_read_failed"],
        runId: binding.runId, userId: binding.userId, sessionId: binding.sessionId, runtimeSandboxId: binding.runtimeSandboxId,
        operation: ownedOperation(binding), handoffToken, signal
      });
      if (report?.failure) {
        logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "write", outcome: "failed",
          code: "workspace_browser_session_save_failed", action: "skip" });
      }
    } catch (error) {
      // Cache failure must not fail an otherwise completed task or expose file data.
      logEvent("runtime_lifecycle", { error, subsystem: "workspace", stage: "write", outcome: "failed",
        code: "workspace_browser_session_save_failed", prisma_code: databaseFailureCode(error), action: "skip" });
    } finally {
      if (collection) {
        await Promise.allSettled(collection.files.map((file) => file.body.cancel()));
        for (const batchId of new Set(collection.files.flatMap((file) => file.batchId ? [file.batchId] : []))) {
          await input.runtime.releaseOutputs?.({ batchId, operation: ownedOperation(binding), runtimeSandboxId: binding.runtimeSandboxId,
            sessionId: binding.sessionId, signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
        }
      }
    }
  }

  async function ownedExecution(
    binding: WorkspaceExecutionBinding,
    execSessionId: unknown
  ): Promise<WorkspaceExecutionRecord | null> {
    if (typeof execSessionId !== "string") return null;
    const record = await input.registry.find({
      runtimeExecSessionId: execSessionId,
      operation: ownedOperation(binding), sessionId: binding.sessionId
    });
    return record?.modelRunId === binding.runId ? record : null;
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
          operation: ownedOperation(binding), sessionId: binding.sessionId
        }).catch(() => "conflict" as const)
      : "conflict";
    if (registered === "registered") return true;
    // Ownership is not durable: kill the process now, or stop the VM when even
    // that cannot be proven, before the model is told anything.
    const terminated = execSessionId
      ? await input.runtime.terminateExecutions({
          executions: [{ modelRunId: binding.runId, runtimeExecSessionId: execSessionId }],
          runtimeSandboxId,
          operation: ownedOperation(binding), sessionId: binding.sessionId
        }).catch(() => null)
      : null;
    if (!terminated?.some((entry) => entry.runtimeExecSessionId === execSessionId && entry.outcome === "closed")) {
      try {
        await input.runtime.stopSession({ runtimeSandboxId, operation: ownedOperation(binding), sessionId: binding.sessionId });
      } catch {
        throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
      }
      initialized.delete(binding.runId);
      // The run still owns this operation. Only terminal settlement may
      // retire the receiver and release admission to a successor.
    }
    return false;
  }

  return {
    async imagePath(request) {
      const binding = await requireBinding(request.runId, request.userId, request.workspace);
      if (!binding.runtimeSandboxId || binding.sessionState !== "RUNNING") throw new WorkspaceRuntimeError("workspace_session_lost");
      if (!await input.repository.markGuestUsed(binding)) throw new WorkspaceRuntimeError("workspace_operation_stale");
      const entries = await stageInputs(binding, request.signal, undefined, request.attachmentId);
      const image = entries.find(entry => entry.attachmentId === request.attachmentId && entry.kind === "image");
      if (!image) throw new WorkspaceRuntimeError("workspace_attachment_unavailable");
      request.signal?.throwIfAborted();
      return image.sandboxPath;
    },
    async skillBundlePath(request) {
      if (!input.skills) throw new WorkspaceRuntimeError("workspace_skills_prepare_failed");
      const initial = await requireBinding(request.runId, request.userId, request.workspace);
      const { binding } = await initializeWithLostSessionRecovery(initial, request.workspace, request.signal, request.onActivity);
      const plan = skillPlans.get(request.runId);
      if (!binding.runtimeSandboxId || !plan) throw new WorkspaceRuntimeError("workspace_skills_prepare_failed");
      const path = workspaceSkillPath(request.alias);
      if (!request.install) {
        const current = await input.skills.plan({ runId: request.runId, userId: request.userId });
        if (current.manifestHash !== plan.manifestHash || !current.initial.some(bundle => bundle.alias === request.alias)) {
          throw new WorkspaceRuntimeError("workspace_skill_bundle_invalid");
        }
        return path;
      }
      const archive = await input.skills.archive({ runId: request.runId, userId: request.userId,
        alias: request.alias, currentAccess: true, signal: request.signal });
      if (archive.bundle.alias !== request.alias) {
        await archive.archive.cancel().catch(() => undefined);
        throw new WorkspaceRuntimeError("workspace_skill_bundle_invalid");
      }
      const installed = await input.runtime.installSkillBundle({ ...archive,
        modelRunId: request.runId, manifestHash: plan.manifestHash, runtimeSandboxId: binding.runtimeSandboxId,
        operation: ownedOperation(binding), sessionId: binding.sessionId, signal: request.signal });
      if (installed.workspacePath !== path) throw new WorkspaceRuntimeError("workspace_skill_bundle_invalid");
      return path;
    },
    async executeAgent(request) {
      if (!input.runtime.startAgent || !input.runtime.pollAgent) {
        throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      }
      const initial = await requireBinding(request.runId, request.userId, request.workspace);
      const cached = initialized.get(request.runId);
      if (request.previousToolCallId && (!request.threadId || !cached?.runtimeSandboxId ||
        cached.runtimeSandboxId !== initial.runtimeSandboxId || cached.operationOwner !== initial.operationOwner ||
        cached.operationGeneration !== initial.operationGeneration)) throw new WorkspaceRuntimeError("workspace_session_lost");
      const { binding, recreated } = request.previousToolCallId
        ? { binding: cached!, recreated: false }
        : await initializeWithLostSessionRecovery(initial, request.workspace, request.signal, request.onActivity);
      if (!binding.runtimeSandboxId) throw new WorkspaceRuntimeError("workspace_runtime_unavailable");
      const runtimeExecSessionId = agentExecutionId(request.modelRunToolCallId);
      // Persist before releasing the prompt to Codex. A lost HTTP response or
      // app restart cannot turn this execution into an unowned guest process.
      const registered = await input.registry.register({
        modelRunId: request.runId, modelRunToolCallId: request.modelRunToolCallId,
        runtimeExecSessionId, operation: ownedOperation(binding), sessionId: binding.sessionId
      });
      if (registered !== "registered") throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
      const identity = {
        modelRunId: request.runId, runtimeExecSessionId, runtimeSandboxId: binding.runtimeSandboxId,
        operation: ownedOperation(binding), sessionId: binding.sessionId, signal: request.signal
      };
      const threadId = recreated ? undefined : request.threadId;
      await input.runtime.startAgent({ ...identity, profile: request.profile,
        skillManifestHash: skillPlans.get(request.runId)!.manifestHash,
        prompt: threadId ? request.resumePrompt : request.prompt, threadId,
        ...(request.previousToolCallId ? { previousExecSessionId: agentExecutionId(request.previousToolCallId) } : {}),
        runToken: request.runToken, timeoutSeconds: request.timeoutSeconds });
      const decoder = new CodexJsonlDecoder();
      const text = activityTextByRun.get(request.runId)!.withValues([request.runToken]);
      activityTextByRun.set(request.runId, text);
      let cursor = 0;
      let interruptRequestedAt: number | null = null;
      let interrupted = false;
      for (;;) {
        request.signal.throwIfAborted();
        const page = await input.runtime.pollAgent({ ...identity, cursor });
        for (const event of decoder.push(Buffer.from(page.stdoutBase64, "base64"))) await request.onEvent(event, text);
        cursor = page.nextCursor;
        if (page.done) {
          const events = interrupted ? decoder.finishInterrupted(page.exitCode) : decoder.finish(page.exitCode);
          for (const event of events) await request.onEvent(event, text);
          return interrupted ? "interrupted" : undefined;
        }
        if (!interruptRequestedAt && decoder.canInterrupt && await request.shouldInterrupt?.()) {
          if (!input.runtime.interruptAgent) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
          interruptRequestedAt = Date.now();
        }
        if (interruptRequestedAt) {
          if (!interrupted) interrupted = await input.runtime.interruptAgent!(identity);
          if (Date.now() - interruptRequestedAt > 10_000) throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
        }
        if (page.stdoutBase64.length === 0) await sleep(200, undefined, { signal: request.signal });
      }
    },
    accepts({ name, workspace }) {
      return workspace.enabled && workspaceToolNameFromNamespaced(name) !== null;
    },
    async settle({ onActivity, operation: expectedOperation, outcome, runId, userId, workspace, skipBrowserSave }) {
      // Every terminal path ends guest-code MCP authority first, before any
      // quiescence wait. A terminal run's bearer is refused by status anyway.
      await revokeCodeGrant(runId);
      const receipt = async (closed: boolean, errorCode?: WorkspaceErrorCode) => {
        await onActivity?.(workspaceLifecycleActivity({ kind: "execution_status", runId,
          phase: closed ? "closed" : "unknown", ...(errorCode ? { errorCode } : {}) })).catch(() => undefined);
      };
      const binding = await input.repository.binding({ runId, userId });
      const cached = initialized.get(runId);
      const expected = expectedOperation ?? (cached ? ownedOperation(cached) : null);
      if (!binding || (expected
        ? binding.operationOwner !== expected.owner || binding.operationGeneration !== expected.generation
        : binding.operationOwner !== workspaceRunOperationOwner(runId)) || (workspace && !exactBinding(binding, workspace))) {
        forgetRun(runId);
        await receipt(false);
        return { quiesced: false, sessionSettled: false, stoppedVm: false };
      }
      const current = binding.runtimeSandboxId === null && cached?.runtimeSandboxId
        ? { ...binding, runtimeSandboxId: cached.runtimeSandboxId }
        : binding;
      if (!current.guestUsed && await input.repository.retireUnusedRun(current)) {
        forgetRun(runId);
        return { quiesced: true, sessionSettled: true, stoppedVm: false };
      }
      let quiescence = await quiesceRun(current);
      if (quiescence.proven && !skipBrowserSave && current.operationOwner === workspaceRunOperationOwner(runId)) {
        await persistBrowserSessions(current, AbortSignal.timeout(BROWSER_SESSION_SAVE_TIMEOUT_MS));
      }
      try {
        const operation = { operation: ownedOperation(current), runtimeSandboxId: current.runtimeSandboxId, sessionId: current.sessionId };
        if (!input.runtime.claimSessionOperation || !input.runtime.retireSessionOperation) {
          throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
        }
        // A retry may find the same receiver operation already retired; only
        // its idempotent retirement can then acknowledge that exact owner.
        await input.runtime.claimSessionOperation(operation).catch(() => undefined);
        await input.runtime.retireSessionOperation(operation);
        quiescence = { proven: true, stoppedVm: current.runtimeSandboxId !== null };
      } catch (error) {
        const failureCode = quiescence.stoppedVm ? "workspace_execution_settlement_failed" : "workspace_execution_stop_failed";
        logEvent("runtime_lifecycle", { error, subsystem: "workspace", stage: "release", outcome: "failed",
          code: failureCode, prisma_code: databaseFailureCode(error), action: "wait" });
        quiescence = { proven: false, stoppedVm: quiescence.stoppedVm, failureCode };
      }
      if (quiescence.proven && (outcome === "cancelled" || outcome === "timed_out") && cached) {
        await onActivity?.(workspaceLifecycleActivity({
          kind: "workspace_stopped",
          ordinal: nextLifecycleOrdinal(runId),
          phase: "cancelled",
          runId,
          startedAt: new Date()
        })).catch(() => undefined);
      }
      forgetRun(runId);
      if (!quiescence.proven) {
        // The session stays RUNNING on purpose: maintenance retries the
        // backstop later instead of reporting a live process as idle.
        await receipt(false, quiescence.failureCode);
        return { quiesced: false, sessionSettled: false, stoppedVm: quiescence.stoppedVm };
      }
      const sessionSettled = await input.repository.settleSession({
        outcome: quiescence.stoppedVm ? "stopped" : current.runtimeSandboxId ? "ready" : "pending",
        runtimeSandboxId: current.runtimeSandboxId,
        operation: ownedOperation(binding), sessionId: binding.sessionId
      }).catch(async error => {
        await receipt(false, "workspace_execution_settlement_failed");
        const failure = new WorkspaceRuntimeError("workspace_execution_settlement_failed");
        rememberDatabaseFailure(failure, databaseFailureCode(error));
        logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "settle", outcome: "failed",
          code: failure.code, prisma_code: databaseFailureCode(failure), action: "wait" });
        throw failure;
      });
      await receipt(sessionSettled, sessionSettled ? undefined : "workspace_execution_settlement_failed");
      return { quiesced: true, sessionSettled, stoppedVm: quiescence.stoppedVm };
    },
    async execute({ call, modelRunToolCallId, onActivity, runId, signal, userId, workspace }) {
      return observeWorkspaceToolExecution(async () => {
        const initial = await requireBinding(runId, userId, workspace);
        const definitionByName = initial.toolDefinitions.find((tool) => tool.namespacedName === call.name);
        if (definitionByName?.originalName === "sandbox_exec" &&
          typeof call.arguments.command === "string" &&
          SHELL_SYNTAX.test(call.arguments.command)) {
          // Direct exec spawns `command` as one program: pipes, operators,
          // redirects, and embedded arguments belong to sandbox_shell.
          const shellToolName = initial.toolDefinitions.find((tool) =>
            tool.originalName === "sandbox_shell"
          )?.namespacedName ?? "sandbox_shell";
          const rejected = executionErrorResult(
            call,
            `This command uses shell syntax, but ${call.name} does not invoke a shell. ` +
            `Use ${shellToolName}, or pass only the program in \`command\` and its arguments in \`args\`.`,
            "workspace_shell_syntax_requires_shell"
          );
          const entry = projectWorkspaceActivity({
            arguments: call.arguments,
            text: activityTextByRun.get(runId) ?? new WorkspaceActivityText(
              workspaceSecretMatches(await input.repository.personalSecrets(initial))),
            callId: modelRunToolCallId,
            originalName: "sandbox_exec",
            result: rejected,
            runId,
            startedAt: new Date()
          }, "settled");
          return withActivity(rejected, entry);
        }
        let initializedBinding = await initializeWithLostSessionRecovery(
          initial,
          workspace,
          signal,
          onActivity
        );
        let binding = initializedBinding.binding;
        const definition = binding.toolDefinitions.find((tool) => tool.namespacedName === call.name);
        if (!definition || !binding.runtimeSandboxId) {
          throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
        }
        const startedAt = new Date();
        // The durable owner also supplies logical command identity after cache loss.
        const execution = isExecSessionTool(definition.originalName)
          ? await ownedExecution(binding, call.arguments.execSessionId) : null;
        if (isExecSessionTool(definition.originalName) && !execution) {
          return executionErrorResult(call, "This execution does not belong to the current run.");
        }
        if (execution?.state === "LOST") {
          const code = execution.stopConfirmed ? "workspace_execution_stopped" : "workspace_execution_outcome_unknown";
          return executionErrorResult(call, workspaceOperationFailureMessage(code), code);
        }
        const projectionInput = {
          arguments: call.arguments,
          text: activityTextByRun.get(runId),
          callId: modelRunToolCallId,
          execOutputs: projectionState(runId),
          ...(execution ? { executionStartCallId: execution.modelRunToolCallId } : {}),
          inboxNames: inboxNamesByRun.get(runId),
          originalName: definition.originalName,
          runId,
          startedAt
        };
        const requested = projectWorkspaceActivity(projectionInput, "running");
        if (requested) await onActivity?.(requested).catch(() => undefined);
        const observeAbort = observeWorkspaceAbort();
        logEvent("tool_deadline", { tool_kind: "workspace", configured_timeout_ms: workspace.syncToolTimeoutSeconds * 1_000,
          effective_timeout_ms: workspace.syncToolTimeoutSeconds * 1_000 });
        const timeout = new AbortController();
        const timer = setTimeout(
          () => timeout.abort(new WorkspaceRuntimeError("workspace_tool_timeout")),
          workspace.syncToolTimeoutSeconds * 1_000
        );
        const combined = signal
          ? AbortSignal.any([signal, timeout.signal])
          : timeout.signal;
        const onAbort = () => observeAbort({ stage: "delivery", deadline_kind: "operation",
          abort_source: timeout.signal.aborted && combined.reason === timeout.signal.reason ? "workspace_deadline" : "parent_signal",
          timeout_ms: workspace.syncToolTimeoutSeconds * 1_000 });
        if (combined.aborted) observeAbort({ stage: "before_start", abort_source: "unknown", deadline_kind: "operation", timeout_ms: workspace.syncToolTimeoutSeconds * 1_000 });
        else combined.addEventListener("abort", onAbort, { once: true });
        // Every dispatched command or exec session is one code invocation:
        // only its environment carries the id, and its code's MCP calls are
        // attributed to it. A synchronous command's invocation closes with it.
        const codeKind: WorkspaceCodeInvocationKind | null = definition.originalName === "sandbox_exec_start" ? "session"
          : definition.originalName === "sandbox_shell" || definition.originalName === "sandbox_exec" ? "command" : null;
        let invocationId: string | null = null;
        const openInvocation = async (active: WorkspaceExecutionBinding) => codeKind && input.repository.openCodeInvocation
          ? await input.repository.openCodeInvocation({ kind: codeKind, modelRunToolCallId, runId: active.runId,
            sessionId: active.sessionId }).catch(() => null)
          : null;
        const closeInvocation = async () => {
          if (codeKind !== "command" || !invocationId) return;
          const closing = invocationId;
          invocationId = null;
          await input.repository.closeCodeInvocation?.({ invocationId: closing, runId }).catch(() => undefined);
        };
        try {
          if (definition.originalName === "sandbox_shell" || definition.originalName === "sandbox_exec") {
            const registered = await input.registry.register({
              modelRunId: binding.runId,
              modelRunToolCallId,
              runtimeExecSessionId: workspaceSyncCleanupId(modelRunToolCallId),
              operation: ownedOperation(binding), sessionId: binding.sessionId
            }).catch(() => "conflict" as const);
            if (registered !== "registered") throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
          }
          invocationId = await openInvocation(binding);
          const dispatch = (active: WorkspaceExecutionBinding) =>
            input.runtime.callBoundTool({
              arguments: call.arguments,
              ...(invocationId ? { invocationId } : {}),
              modelRunId: active.runId,
              modelRunToolCallId,
              originalName: definition.originalName,
              runtimeSandboxId: active.runtimeSandboxId!,
              operation: ownedOperation(active), sessionId: active.sessionId,
              signal: combined
            });
          let result: WorkspaceToolResult;
          try {
            result = await dispatch(binding);
          } catch (error) {
            if (
              !(error instanceof WorkspaceRuntimeError) ||
              error.code !== "workspace_session_lost_before_dispatch" ||
              !binding.runtimeSandboxId ||
              combined.aborted ||
              isExecSessionTool(definition.originalName)
            ) {
              throw error;
            }
            initialized.delete(binding.runId);
            if (!(await input.repository.markSessionLost({
              runtimeSandboxId: binding.runtimeSandboxId,
              operation: ownedOperation(binding), sessionId: binding.sessionId
            }))) {
              throw error;
            }
            const fresh = await requireBinding(runId, userId, workspace);
            initializedBinding = await initializeWithLostSessionRecovery(
              fresh,
              workspace,
              combined,
              onActivity
            );
            binding = initializedBinding.binding;
            // Recreation rotated the bearer and fenced the undispatched invocation.
            invocationId = await openInvocation(binding);
            result = await dispatch(binding);
            initializedBinding = { binding, recreated: true };
          }
          if (definition.originalName === "sandbox_exec_start" && result.status === "complete") {
            const registered = await registerExecution(binding, modelRunToolCallId, result);
            if (!registered) {
              const rejected = executionErrorResult(
                call,
                "The long-running execution could not be registered and was stopped. Its exit outcome is unknown; do not repeat an uncertain action."
              );
              return withActivity(rejected, projectWorkspaceActivity({
                ...projectionInput,
                durationMs: Date.now() - startedAt.getTime(),
                result: rejected
              }, "settled"));
            }
          }
          // The single normalization point for guest output: the persisted
          // row, provider projection, observation and activity all derive from
          // this masked result. Cache loss reloads the run's accepted revisions.
          const mask = outputMaskByRun.get(runId) ??
            new WorkspaceSecretOutputMask(workspaceSecretMatches(await input.repository.personalSecrets(binding)));
          const output = mask.result(result, input.config.toolOutputMaxBytes);
          // A returned command's code can no longer call MCP; then summarize.
          await closeInvocation();
          const settled = withCodeCallSummary(resultFromRuntime(call, output.result, output.masked),
            await codeCallSummary(runId, codeKind ? modelRunToolCallId
              : definition.originalName === "sandbox_exec_poll" ? execution?.modelRunToolCallId ?? null : null,
            codeKind === null));
          // MCP close only disposes the observation handle. The durable cleanup
          // obligation survives until terminal process/VM proof.
          const projected = withActivity(
            settled,
            projectWorkspaceActivity({
              ...projectionInput,
              durationMs: Date.now() - startedAt.getTime(),
              result: settled
            }, "settled")
          );
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
                operation: ownedOperation(binding), sessionId: binding.sessionId
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
          combined.removeEventListener("abort", onAbort);
          await closeInvocation();
        }
      });
    },
    async handoff(request) {
      request.signal?.throwIfAborted();
      await revokeCodeGrant(request.runId);
      const binding = await input.repository.binding(request);
      if (!binding || !exactBinding(binding, request.workspace)) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      const obligation = { runId: request.runId, sessionId: binding.sessionId };
      // Covers a crash after retirement/DB handoff but before run completion.
      // No guest or provider I/O is needed to acknowledge that same obligation.
      const acknowledge = async () => {
        if (binding.guestUsed) await request.onActivity?.(workspaceLifecycleActivity({ kind: "execution_status", runId: request.runId,
          phase: "closed" })).catch(() => undefined);
        return { status: "ready" as const };
      };
      if (await input.repository.outputHandoffReady(obligation)) return acknowledge();
      const result = await this.finalize({ ...request, handoff: true });
      request.signal?.throwIfAborted();
      if (result.status === "busy") return result;
      if (result.status === "failed") throw new WorkspaceRuntimeError(result.code);
      if ((result.status !== "pending" && result.status !== "complete") ||
        !(await input.repository.outputHandoffReady(obligation))) {
        throw new WorkspaceRuntimeError("workspace_execution_cleanup_failed");
      }
      return acknowledge();
    },
    async finalize({ handoff, onActivity, recovery, runId, signal, userId, workspace }) {
      if (signal?.aborted) return { reason: "cancelled", status: "deferred" };
      let initial = await input.repository.binding({ runId, userId });
      if (recovery && !initial) return { reason: "access_unavailable", status: "deferred" };
      if (!initial || (workspace && !exactBinding(initial, workspace))) {
        return { code: "workspace_runtime_incompatible", retryable: false, status: "failed" };
      }
      const leaseInput = { generation: initial.operationGeneration, leaseMs: WORKSPACE_EXPORT_LEASE_MS, runId, runtimeSandboxId: initial.runtimeSandboxId, sessionId: initial.sessionId };
      if (signal?.aborted) return { reason: "cancelled", status: "deferred" };
      let claim: WorkspaceExportClaim;
      try {
        claim = recovery
          ? await input.repository.claimExportForRecovery(leaseInput)
          : await input.repository.claimExport({ ...leaseInput, ...(handoff ? { handoff: true } : {}), operation: {
              generation: initial.operationGeneration,
              owner: handoff && initial.operationOwner ? initial.operationOwner : workspaceRunOperationOwner(runId)
            } });
      } catch (error) {
        logEvent("runtime_lifecycle", { error, subsystem: "workspace", stage: "export", work_stage: "claim", outcome: "failed",
          code: runtimeCode(error), action: handoff ? "fail" : "retry", run_id: runId });
        return { code: runtimeCode(error), retryable: true, status: "failed" };
      }
      if (claim.status === "complete") {
        // Empty capture publication and authority retirement are separate
        // durable steps. Finish the latter after a crash, without touching a
        // successor's operation or contacting the runner.
        if (!initial.guestUsed && (initial.operationOwner === workspaceRunOperationOwner(runId) ||
          initial.operationOwner?.startsWith(`export:${runId}:`))) {
          await input.repository.retireUnusedRun(initial);
        }
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
      if (claim.status === "exhausted") return { reason: "attempts_exhausted", status: "deferred" };
      // The same run's operation this export continues. Its receiver may hand
      // over without a VM stop, because quiescence below stops whatever the run
      // may have left running before any guest byte is read.
      const predecessor = initial.operationOwner === workspaceRunOperationOwner(runId) ||
        initial.operationOwner?.startsWith(`export:${runId}:`)
        ? { generation: initial.operationGeneration, owner: initial.operationOwner! } : undefined;
      initial = { ...initial, operationGeneration: claim.operation.generation, operationOwner: claim.operation.owner };
      const lease = { operation: ownedOperation(initial), runId, runtimeSandboxId: initial.runtimeSandboxId, sessionId: initial.sessionId, token: claim.token };
      let retirementOperation = lease.operation;
      let leaseLost = false;
      const heartbeat = new AbortController();
      const exportSignal = signal ? AbortSignal.any([signal, heartbeat.signal]) : heartbeat.signal;
      const renewal: { pending: Promise<void> | null } = { pending: null };
      const renew = (): Promise<void> => {
        renewal.pending ??= (async () => {
          exportSignal.throwIfAborted();
          if (leaseLost) throw new WorkspaceRuntimeError("workspace_output_export_failed");
          if (!(await input.repository.renewExportLease({ ...lease, leaseMs: WORKSPACE_EXPORT_LEASE_MS }))) {
            leaseLost = true;
            throw new WorkspaceRuntimeError("workspace_output_export_failed");
          }
          exportSignal.throwIfAborted();
        })().finally(() => { renewal.pending = null; });
        return renewal.pending;
      };
      // A worker whose lease was reclaimed stops touching the database; the
      // owner-guarded terminal updates would refuse it anyway.
      const heartbeatTimer = setInterval(() => {
        void renew().catch(() => heartbeat.abort(new WorkspaceRuntimeError("workspace_output_export_failed")));
      }, Math.max(1_000, Math.floor(WORKSPACE_EXPORT_LEASE_MS / 3)));
      heartbeatTimer.unref?.();
      let batch: Readonly<{ batchId: string; runtimeSandboxId: string }> | null = null;
      const exportStartedAt = new Date();
      const exportOrdinal = nextLifecycleOrdinal(runId);
      let exportCount = 0;
      const exportActivity = (
        phase: "failed" | "running" | "succeeded",
        errorCode?: WorkspaceRuntimeError["code"]
      ) => onActivity?.(workspaceLifecycleActivity({
        count: exportCount,
        ...(phase === "running" ? {} : { durationMs: Date.now() - exportStartedAt.getTime() }),
        ...(errorCode ? { errorCode: activityErrorCode(errorCode) } : {}),
        kind: "outputs_export",
        ordinal: exportOrdinal,
        phase,
        runId,
        startedAt: exportStartedAt
      })).catch(() => undefined) ?? Promise.resolve();
      let step: WorkspaceExportStep = "claim";
      try {
        exportSignal.throwIfAborted();
        const capture = await input.repository.reserveOutputCapture(lease);
        if (!capture) throw new WorkspaceRuntimeError("workspace_operation_stale");
        // The claim fences new dispatches. Re-read after it to include a guest
        // operation that raced our initial binding read.
        const current = await input.repository.binding({ runId, userId });
        if (!current || current.operationOwner !== lease.operation.owner || current.operationGeneration !== lease.operation.generation) {
          throw new WorkspaceRuntimeError("workspace_operation_stale");
        }
        const runtimeSandboxId = initial.runtimeSandboxId;
        if (!current.guestUsed || !runtimeSandboxId) {
          step = "seal";
          if (!(await input.repository.sealOutputCapture({ ...lease, capture: { id: capture.id, outputs: [] } }))) {
            throw new WorkspaceRuntimeError("workspace_output_export_failed");
          }
          if (!(await input.repository.markExportComplete(lease))) {
            throw new WorkspaceRuntimeError("workspace_output_export_failed");
          }
          return { files: [], status: "complete" };
        }
        let quiesced = false;
        let browserSessionsSaved = !handoff;
        // A provider-complete run may be finalized by a fresh app process after
        // the runner itself was restarted. Reconnect and restage originals
        // before collecting output, but never recreate a genuinely lost VM:
        // doing so would silently turn missing deliverables into a success.
        const collect = async (): Promise<Readonly<{
          binding: WorkspaceExecutionBinding & Readonly<{ runtimeSandboxId: string }>; outputs: readonly WorkspaceOutputStream[];
        }>> => {
          step = "initialize";
          const binding = await initialize(initial, "export", exportSignal, undefined, predecessor);
          if (!binding.runtimeSandboxId) throw new WorkspaceRuntimeError("workspace_session_lost");
          if (!quiesced) {
            // Freeze the output set: no process of this run may still be writing
            // between the listing/hash and the upload. The proof outlives a
            // later attempt, which starts no process of the run either.
            step = "quiesce";
            const quiescence = await quiesceRun(binding, exportSignal);
            if (!quiescence.proven) throw new WorkspaceRuntimeError(quiescence.failureCode ?? "workspace_execution_cleanup_failed");
            quiesced = true;
            if (quiescence.stoppedVm) {
              // Stopping proves descendants are gone; resume only this exact disk
              // for file I/O. No accepted command is dispatched again.
              step = "resume";
              const resumed = await input.runtime.ensureSession({
                cpus: input.config.cpus, diskMiB: input.config.diskMiB, imageRef: binding.imageRef,
                internetEnabled: binding.internetEnabled, memoryMiB: input.config.memoryMiB,
                runtimeSandboxId: binding.runtimeSandboxId, sandboxName: binding.sandboxName,
                operation: ownedOperation(binding), sessionId: binding.sessionId, signal: exportSignal
              });
              if (resumed.runtimeSandboxId !== binding.runtimeSandboxId || resumed.sandboxName !== binding.sandboxName) {
                throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
              }
            }
          }
          step = "collect";
          await renew();
          if (!browserSessionsSaved) {
            browserSessionsSaved = true;
            await persistBrowserSessions(binding, AbortSignal.any([exportSignal, AbortSignal.timeout(BROWSER_SESSION_SAVE_TIMEOUT_MS)]), claim.token);
          }
          return { binding: { ...binding, runtimeSandboxId: binding.runtimeSandboxId }, outputs: await input.runtime.collectOutputs({
            capture: { create: capture.create, id: capture.id },
            modelRunId: runId,
            outputDirectory: binding.outputDirectory,
            runtimeSandboxId: binding.runtimeSandboxId,
            operation: ownedOperation(binding), sessionId: binding.sessionId,
            signal: exportSignal
          }) };
        };
        let collected: Awaited<ReturnType<typeof collect>>;
        try {
          collected = await collect();
        } catch (error) {
          // Unproven: the runner may not hold the session in its cache, or a
          // lookup came right after this export's own stop. Initialize once
          // more in this lease; only that lookup by name may prove the loss.
          if (!(error instanceof WorkspaceRuntimeError) || error.code !== "workspace_session_lost" || exportSignal.aborted) throw error;
          logEvent("runtime_lifecycle", { subsystem: "workspace", stage: "export", work_stage: step, outcome: "degraded",
            code: error.code, action: "retry", run_id: runId });
          initialized.delete(runId);
          await exportRetryDelay(exportSignal);
          await renew();
          try {
            collected = await collect();
          } catch (retryError) {
            if (!(retryError instanceof WorkspaceSandboxMissing) || exportSignal.aborted) throw retryError;
            // The second lookup by name in this lease proves the disk gone.
            await renew();
            const lost = await input.repository.markSessionLost({ operation: lease.operation, runtimeSandboxId, sessionId: initial.sessionId });
            throw lost ? new WorkspaceConfirmedSessionLoss(lost) : retryError;
          }
        }
        const { binding, outputs } = collected;
        const batchId = outputs.find((output) => output.batchId)?.batchId;
        if (batchId) batch = { batchId, runtimeSandboxId: binding.runtimeSandboxId };
        exportCount = outputs.length;
        if (outputs.length > 0) await exportActivity("running");
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
        step = "seal";
        const identities = outputIdentities(outputs, input.config);
        if (!(await input.repository.sealOutputCapture({ ...lease, capture: { id: capture.id, outputs: identities } }))) {
          throw new WorkspaceRuntimeError("workspace_output_export_failed");
        }
        if (handoff) {
          // Returned streams are lazy transport handles; all protected bytes
          // already live in the receiver's durable capture at this boundary.
          await Promise.allSettled(outputs.map((output) => output.body.cancel()));
          const recorded = outputs.length === 0
            ? await input.repository.markExportComplete(lease)
            : await input.repository.markExportPending(lease);
          if (!recorded) throw new WorkspaceRuntimeError("workspace_output_export_failed");
          if (outputs.length === 0) {
            await input.runtime.releaseOutputCapture?.({ captureId: capture.id, modelRunId: runId,
              operation: lease.operation, runtimeSandboxId: binding.runtimeSandboxId, sessionId: binding.sessionId,
              signal: exportSignal }).catch(() => undefined);
            return { status: "complete", files: [] };
          }
          return { status: "pending" };
        }
        const files: ThreadGeneratedFile[] = [];
        for (const output of outputs) {
          await renew();
          const storageKey = outputStorageKey(binding, output, lease.token);
          if (!(await input.repository.prepareOutput({ ...lease, storageKey }))) {
            throw new WorkspaceRuntimeError("workspace_operation_stale");
          }
          if (!(await objectMatches(input.storage, storageKey, output, exportSignal))) {
            if (!input.storage.putObjectStream) {
              throw new WorkspaceRuntimeError("workspace_output_export_failed");
            }
            try {
              await input.storage.putObjectStream({
                body: output.body,
                byteSize: output.byteSize,
                checksum: output.checksum,
                contentType: output.mimeType,
                signal: exportSignal,
                storageKey
              });
            } catch (error) {
              if (!(await objectMatches(input.storage, storageKey, output, exportSignal))) throw error;
            }
          }
          if (!(await objectMatches(input.storage, storageKey, output, exportSignal))) {
            throw new WorkspaceRuntimeError("workspace_output_export_failed");
          }
          await renew();
          files.push(await input.repository.settleOutput({
            binding, token: lease.token,
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
        await input.runtime.releaseOutputCapture?.({ captureId: capture.id, modelRunId: runId,
          operation: lease.operation, runtimeSandboxId: binding.runtimeSandboxId, sessionId: binding.sessionId,
          signal: exportSignal }).catch(() => undefined);
        await input.repository.markSessionReady({
          ...activityWindow(),
          operation: ownedOperation(binding), sessionId: binding.sessionId
        });
        if (files.length > 0) await exportActivity("succeeded");
        return { files, status: "complete" };
      } catch (error) {
        if (error instanceof WorkspaceConfirmedSessionLoss) retirementOperation = error.operation;
        // A lost lease or a loss this export did not confirm is an ordinary
        // failed attempt, never a missing disk.
        const code: WorkspaceRuntimeError["code"] = leaseLost || !(error instanceof WorkspaceRuntimeError) ||
          (error.code === "workspace_session_lost" && !(error instanceof WorkspaceConfirmedSessionLoss))
          ? "workspace_output_export_failed" : error.code;
        await exportActivity("failed", code === "workspace_output_limit_exceeded" ? code : "workspace_output_export_failed");
        const recorded = code === "workspace_output_limit_exceeded" ||
          code === "workspace_session_lost" ||
          code === "workspace_runtime_incompatible"
          ? code
          : "workspace_output_export_failed";
        const retryable = isRetryableWorkspaceExportErrorCode(recorded);
        logEvent("runtime_lifecycle", { error, subsystem: "workspace", stage: "export", work_stage: step,
          outcome: leaseLost ? "lost_lease" : "failed", code, action: handoff || !retryable ? "fail" : "retry", run_id: runId });
        if (!leaseLost) {
          await input.repository.markExportFailed({ ...lease, code: recorded }).catch(() => undefined);
        }
        return { code, retryable, status: "failed" };
      } finally {
        clearInterval(heartbeatTimer);
        await renewal.pending?.catch(() => undefined);
        if (batch && input.runtime.releaseOutputs) {
          await input.runtime.releaseOutputs({
            operation: lease.operation,
            batchId: batch.batchId,
            runtimeSandboxId: batch.runtimeSandboxId,
            sessionId: initial.sessionId,
            signal: AbortSignal.timeout(10_000)
          }).catch(() => undefined);
        }
        await this.settle({ onActivity, operation: retirementOperation, outcome: "completed", runId, userId, skipBrowserSave: true }).catch(() => undefined);
      }
    },
    async recoverExports({ limit, signal }) {
      if (recoveryWork) return recoveryWork;
      recoveryWork = (async () => {
        if (signal?.aborted) return { attempted: 0, completed: 0 };
        const batchLimit = limit !== undefined && Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 100) : 10;
        // Keep a fixed horizon for a sweep: new/retimestamped rows cannot
        // prevent reaching its end and revisiting previously deferred items.
        recoveryScanBefore ??= new Date();
        const candidates = await input.repository.exportRecoveryCandidates({
          ...(recoveryCursor ? { cursor: recoveryCursor } : {}),
          limit: batchLimit,
          staleBefore: recoveryScanBefore
        });
        let attempted = 0;
        let completed = 0;
        for (const candidate of candidates) {
          if (signal?.aborted) break;
          attempted += 1;
          try {
            const result = await this.finalize({ recovery: true, runId: candidate.runId, signal, userId: candidate.userId });
            if (result.status === "complete") completed += 1;
          } catch {
            // One unavailable binding must not monopolize later candidates.
          } finally {
            recoveryCursor = { runId: candidate.runId, updatedAt: candidate.updatedAt };
          }
        }
        if (candidates.length < batchLimit && !signal?.aborted) {
          recoveryCursor = undefined;
          recoveryScanBefore = undefined;
        }
        return { attempted, completed };
      })().finally(() => { recoveryWork = null; });
      return recoveryWork;
    },
    async prepareCarryover({ onActivity, runId, signal, userId, workspace }) {
      const initial = await input.repository.binding({ runId, userId });
      if (!initial || !exactBinding(initial, workspace) || !input.repository.pendingCarryover ||
        !await input.repository.pendingCarryover({ chatId: initial.chatId, runId })) return;
      try {
        await initializeWithLostSessionRecovery(await requireBinding(runId, userId, workspace), workspace, signal, onActivity);
      } catch (error) {
        // A cancellation stays one; any other start failure leaves the carried files unrestored.
        if (signal?.aborted || (error instanceof WorkspaceRuntimeError &&
          (error.code === "workspace_tool_cancelled" || error.code === "workspace_carryover_unavailable"))) throw error;
        throw new WorkspaceRuntimeError("workspace_carryover_unavailable");
      }
    },
    async tools({ runId, userId, workspace }) {
      // Reading the immutable catalog must also work after a capture handed
      // ownership back, so terminal provider recovery can finish that run.
      const binding = await input.repository.binding({ runId, userId });
      if (!binding || !exactBinding(binding, workspace)) throw new WorkspaceRuntimeError("workspace_runtime_incompatible");
      return workspaceRunTools(binding.toolDefinitions);
    }
  };
}
