import { modelSearchPricing, modelSearchPricingSelect } from "../providers/modelTokenPricing";
import { loadProviderModelCostBasis } from "../usage";
import { loadWorkspaceInboxFacts } from "../workspace/inboxFacts";
import { decodeSearchPlan } from "../../domain/search";
import { chatTitleMetadataSelect, chatTitlePending } from "../chats/titleMetadata";
import { AttachmentLinkConflictError } from "./runRepositoryContract";
import { projectChatPdfPreparation } from "../uploads/chatPdfProjection";
import { assertWorkspaceFollowupClaim } from "./workspaceFollowupPersistence";
import {
  Prisma,
  type ModelRunStatus
} from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { WORKSPACE_ACTIVITY_SNAPSHOT } from "./workspaceActivityPersistence";
import {
  loadChatBranchSnapshotStats,
  summarizeMessageRunArtifacts,
  summarizeMessageRunToolActivity,
  summarizeMessageRunWorkspaceActivity
} from "../chats/prismaRepository";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { prisma } from "../prisma";
import type { ProviderConversationMessage } from "../providers/types";
import {
  type ConversationContextOptions,
  type RunAttachmentRecord,
  type RunRepository
} from "./runRepositoryContract";
import { collapseAnswerReviews } from "../../domain/answerReviewTranscript";
import { answerReviewStepModelName, loadAnswerReviewProjection } from "../answerReviews/repository";
import {
  createPrismaMemoryRunRetrievalService,
  type MemoryRunRetrievalService
} from "../memory/retrieval";
import type { MemoryExecutionAuthorityDependencies } from "../memory/execution";
import { defaultMemoryExecutionAuthority } from "../memory/execution/defaultAuthority";
import { loadMemoryRunActions } from "../memory/actions/runProjection";
import { loadMemoryRunSources } from "../memory/sources/runProjection";
import { loadMemoryRunPresentationStatuses } from "../memory/retrieval/runProjection";
import { loadChatCreationDefaults } from "../chats/chatCreationDefaults";
import { loadPersonalAssistantRowContext } from "../assistants/rowContext";
import type { MemorySourceMutationHooks } from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import {
  boundedMemoryAdmissionDeadlineMs,
  MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS
} from "../memory/admissionDeadline";
import { signalRunCancelled, signalRunTerminal } from "../push/runTerminalSignal";
import { serializeRunAssistantIdentity } from "./prismaRepositoryBindings";
import {
  admitPreparingRunWithClient,
  beginPreparingRunAttemptWithClient,
  completePreparingRunAttemptWithClient,
  createDormantPreparingRun,
  MEMORY_STANDING_PREPARATION_TIMEOUT_MS,
  continuePdfPreparedRunWithClient,
  continueWorkspacePreparedRunWithClient,
  finalizePreparingRunWithClient,
  lockPreparingRun,
  recoverPreparingRunWithClient,
  retryPreparingRunAttemptWithClient,
  settlePreparingRunFailureWithClient,
  settlePreparingRunInTransaction,
  settleTerminalMemorySource
} from "./prismaRepositoryPreparation";
import {
  acceptedRunStatus,
  activeMessageStatuses,
  activeModelRunStatuses,
  dispatchableModelRunStatuses,
  isRecord,
  json,
  lockRunSettlementScope,
  runControlRecord
} from "./prismaRepositoryShared";
import {
  cancelPendingToolLoopCallsInTransaction,
  closeRunningToolLoopCallsInTransaction,
  createPrismaRunToolLoopOperations,
  isRecoveredRunTerminalPayload,
  recoveredRunErrorPayload
} from "./prismaRepositoryToolLoop";
import { createPrismaMcpDiscoveryOperations } from "./prismaRepositoryMcpDiscovery";
import { createPrismaFetchUrlOperations } from "./prismaRepositoryFetchUrl";
import { recordScheduledMonitoringVerdict } from "../scheduledTasks/monitoringVerdict";
import { createPrismaScheduledTaskCatalogLoader } from "../scheduledTasks/catalog";
import { createPrismaScheduledTaskPinnedSkillLoader } from "../scheduledTasks/pinnedSkills";
import { createPrismaWorkspacePolicyRepository } from "../workspace/policyRepository";
import { saveSkillForToolCall } from "./prismaRepositorySkillSaveCall";
import { createScheduledTaskForToolCall } from "./prismaRepositoryScheduledTaskCall";
import {
  loadScheduledTaskManagementAdmission,
  manageScheduledTaskForToolCall
} from "./prismaRepositoryScheduledTaskManagement";
import { resolveChatAccess } from "../chats/access";
import {
  loadMcpApprovalContinuation,
  loadMcpToolConsentServerIds,
  loadRunMcpApprovalCards,
  mcpApprovalCardSelect
} from "../mcp/writeApprovalRepository";
import type { WorkspaceAvailabilityService } from "../workspace/availability";
import { workspaceModelSupportsTools } from "../workspace/availability";
import { workspaceAvailabilityService as defaultWorkspaceAvailabilityService } from "../workspace/defaultServices";
import { retainRunPrismaCode } from "./prismaRepositoryObservability";
import { measureTransaction } from "../observability/transactionTiming";
import { createPrismaRunFollowupOperations, runFollowupSelect } from "./prismaRepositoryFollowups";
import { projectRunFollowups } from "./runFollowups";
import { decodeRunFollowupState } from "../../contracts/runFollowups";

export { insertAcceptedMcpRunBindings } from "./prismaRepositoryBindings";

type ConversationPathSelector =
  | { kind: "active" }
  | { kind: "expected"; leafMessageId: string | null }
  | { kind: "explicit"; leafMessageId: string };

type ConversationPathRow = {
  messageAnswerReviewSessionId?: string | null;
  messageSystemTurnKind?: string | null;
  messageBranchFollowups?: unknown;
  followups?: readonly { id: string; ordinal: number; text: string; delivered: boolean; precedingText: string | null }[];
  chatId: string;
  messageContent: Prisma.JsonValue | null;
  messageId: string | null;
  messageParentId?: string | null;
  messageRole: string | null;
  messageStatus: string | null;
};

function contentHasImage(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.blocks) && value.blocks.some((block) => isRecord(block) && block.type === "image" && typeof block.attachmentId === "string");
}

export function conversationMessagesFromPathRows(rows: ConversationPathRow[]): ProviderConversationMessage[] {
  return rows.flatMap((row) => {
    const followups = row.followups?.length ? row.followups
      : (decodeRunFollowupState(row.messageBranchFollowups)?.entries ?? []).map(entry => ({
        ...entry, delivered: entry.delivery === "delivered", precedingText: entry.precedingText ?? null
      }));
    const followupMessages: ProviderConversationMessage[] = row.messageRole === "assistant" && row.messageParentId
      ? followups.flatMap(entry => {
          // Which answer the follow-up went to, and whether it reached it: that answer's native items may hold it already.
          const marker = row.messageId ? { followupOf: { answerId: row.messageId, delivered: entry.delivered } } : {};
          return [
            ...(entry.precedingText ? [{ id: `${entry.id}-partial`, ...marker, role: "assistant" as const,
              content: textMessageContent(`Partial answer before follow-up:\n${entry.precedingText}`) }] : []),
            { id: entry.id, contextTurnId: row.messageParentId!, ...marker, role: "user" as const,
              content: textMessageContent(`${entry.delivered ? "Follow-up" : "Follow-up not delivered to the previous answer"}:\n${entry.text}`) }
          ];
        }) : [];
    const terminalWithText = row.messageRole === "assistant" &&
      (row.messageStatus === "cancelled" || row.messageStatus === "error") &&
      isRecord(row.messageContent) &&
      Boolean(textFromContentBlocks(row.messageContent).trim());
    if (
      !row.messageId ||
      (row.messageRole !== "user" && row.messageRole !== "assistant") ||
      (row.messageStatus !== "complete" && row.messageStatus !== "streaming" && !terminalWithText && !contentHasImage(row.messageContent))
    ) {
      return followupMessages;
    }

    return [
      ...followupMessages,
      {
        content: row.messageContent as { blocks: unknown[] },
        id: row.messageId,
        role: row.messageRole
      }
    ];
  });
}

export function createPrismaRunRepository(
  prismaClient = prisma,
  options: Readonly<{
    memoryAdmissionDeadlineMs?: number;
    memoryExecutionAuthority?: MemoryExecutionAuthorityDependencies;
    memoryRetrieval?: MemoryRunRetrievalService;
    memorySourceHooks?: MemorySourceMutationHooks;
    workspaceAvailability?: WorkspaceAvailabilityService;
  }> = {}
): RunRepository {
  const memorySourceHooks = options.memorySourceHooks ?? defaultMemorySourceMutationHooks;
  const memoryExecutionAuthority = options.memoryExecutionAuthority ??
    defaultMemoryExecutionAuthority;
  const memoryRetrieval = options.memoryRetrieval ??
    createPrismaMemoryRunRetrievalService(prismaClient, {
      authority: memoryExecutionAuthority
    });
  const workspaceAvailability = options.workspaceAvailability ??
    defaultWorkspaceAvailabilityService;
  const toolLoopOperations = createPrismaRunToolLoopOperations(prismaClient);
  const mcpDiscoveryOperations = createPrismaMcpDiscoveryOperations(prismaClient);
  const fetchUrlOperations = createPrismaFetchUrlOperations(prismaClient);
  // A chat's scheduled tasks are created and changed under the owner API's own rules.
  const scheduledTaskCreationDeps = {
    loadCatalog: createPrismaScheduledTaskCatalogLoader(prismaClient),
    loadPinnedSkills: createPrismaScheduledTaskPinnedSkillLoader(prismaClient),
    workspacePolicy: createPrismaWorkspacePolicyRepository(prismaClient)
  };
  async function loadMemoryAdmissionDeadlineMs(request?: { memoryStandingVersion?: 1 }): Promise<number> {
    if (request?.memoryStandingVersion === 1) return MEMORY_STANDING_PREPARATION_TIMEOUT_MS;
    if (options.memoryAdmissionDeadlineMs !== undefined) {
      return boundedMemoryAdmissionDeadlineMs(options.memoryAdmissionDeadlineMs);
    }
    return MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS;
  }
  /**
   * A regenerated answer to a scheduled task's prompt reads Memory only while
   * the task, found through the scheduled run that posted the prompt in this
   * chat, still exists with Memory on. A branch copy has no such run.
   */
  async function scheduledTaskMemory(
    prompt: Readonly<{ chatId: string; id: string; scheduledTaskPrompt: boolean }>,
    userId: string
  ): Promise<boolean> {
    if (!prompt.scheduledTaskPrompt) return false;
    const origin = await prismaClient.modelRun.findFirst({
      select: { scheduledTaskId: true },
      where: { chatId: prompt.chatId, scheduledTaskId: { not: null }, userId, userMessageId: prompt.id }
    }).catch(retainRunPrismaCode);
    const task = origin?.scheduledTaskId ? await prismaClient.scheduledTask.findFirst({
      select: { memoryEnabled: true },
      where: { id: origin.scheduledTaskId, userId }
    }).catch(retainRunPrismaCode) : null;
    return task?.memoryEnabled === true;
  }
  async function loadConversationPath(
    chatId: string,
    userId: string,
    selector: ConversationPathSelector,
    options: ConversationContextOptions = {}
  ): Promise<{ chatMatched: boolean; messages: ProviderConversationMessage[] }> {
    const access = await resolveChatAccess(prismaClient, {
      chatId,
      userId
    }).catch(retainRunPrismaCode);
    if (!access) return { chatMatched: false, messages: [] };
    const selectedLeaf =
      selector.kind === "active"
        ? Prisma.sql`chat."activeLeafMessageId"`
        : Prisma.sql`${selector.leafMessageId}::text`;
    const expectedLeafPredicate =
      selector.kind === "expected"
        ? Prisma.sql`AND chat."activeLeafMessageId" IS NOT DISTINCT FROM ${selector.leafMessageId}`
        : Prisma.empty;
    const rows = await prismaClient.$queryRaw<ConversationPathRow[]>(Prisma.sql`
      WITH RECURSIVE "selected_chat" AS (
        SELECT
          chat."id",
          ${selectedLeaf} AS "selectedLeafMessageId"
        FROM "Chat" AS chat
        WHERE chat."id" = ${chatId}
          AND chat."userId" = ${userId}
          AND chat."archived" = false
          AND chat."permanentDeletionAt" IS NULL
          ${expectedLeafPredicate}
      ),
      "ancestor_path" AS (
        SELECT
          message."chatId",
          message."content",
          message."id",
          message."parentMessageId",
          message."role",
          message."status"::text AS "status",
          message."branchFollowups",
          message."answerReviewSessionId",
          message."systemTurnKind"::text AS "systemTurnKind",
          ARRAY[message."id"]::text[] AS "visitedIds",
          0 AS "depth"
        FROM "selected_chat" AS chat
        INNER JOIN "Message" AS message
          ON message."chatId" = chat."id"
          AND message."id" = chat."selectedLeafMessageId"

        UNION ALL

        SELECT
          parent."chatId",
          parent."content",
          parent."id",
          parent."parentMessageId",
          parent."role",
          parent."status"::text AS "status",
          parent."branchFollowups",
          parent."answerReviewSessionId",
          parent."systemTurnKind"::text AS "systemTurnKind",
          path."visitedIds" || parent."id",
          path."depth" + 1
        FROM "ancestor_path" AS path
        INNER JOIN "Message" AS parent
          ON parent."chatId" = path."chatId"
          AND parent."id" = path."parentMessageId"
        WHERE NOT parent."id" = ANY(path."visitedIds")
      )
      SELECT
        chat."id" AS "chatId",
        path."content" AS "messageContent",
        path."id" AS "messageId",
        path."parentMessageId" AS "messageParentId",
        path."role" AS "messageRole",
        path."status" AS "messageStatus",
        path."branchFollowups" AS "messageBranchFollowups",
        path."answerReviewSessionId" AS "messageAnswerReviewSessionId",
        path."systemTurnKind" AS "messageSystemTurnKind",
        COALESCE(clarifications.entries, '[]'::jsonb) AS "followups"
      FROM "selected_chat" AS chat
      LEFT JOIN "ancestor_path" AS path ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('id', f."id", 'ordinal', f."ordinal", 'text', f."text",
          'delivered', f."deliveredAt" IS NOT NULL, 'precedingText', f."precedingText") ORDER BY f."ordinal") AS entries
        FROM "RunFollowup" f
        WHERE f."modelRunId" = (
          SELECT r."id" FROM "ModelRun" r WHERE path."role" = 'assistant' AND
            r."assistantMessageId" = path."id"
          ORDER BY r."createdAt" DESC LIMIT 1
        )
      ) clarifications ON true
      ORDER BY path."depth" DESC NULLS LAST
    `).catch(retainRunPrismaCode);

    const generated = await prismaClient.attachment.findMany({
      where: { chatId, messageId: { in: rows.flatMap((row) => row.messageId ? [row.messageId] : []) }, origin: "IMAGE_OUTPUT", status: "ready" },
      select: { id: true, messageId: true, fileName: true }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 256
    }).catch(retainRunPrismaCode);
    for (const row of rows) {
      const images = generated.filter((entry) => entry.messageId === row.messageId).reverse();
      if (images.length && isRecord(row.messageContent) && Array.isArray(row.messageContent.blocks)) {
        row.messageContent = { ...row.messageContent, blocks: [...row.messageContent.blocks, ...images.map((entry) => ({ type: "image", attachmentId: entry.id, label: entry.fileName }))] };
      }
    }
    return {
      chatMatched: rows.length > 0,
      // Only an explicit leaf is the run's own turn (a regeneration answers it
      // again); a send's expected leaf is the previous message and collapses.
      messages: conversationMessagesFromPathRows(await collapsedAnswerReviewRows(rows, chatId, options,
        selector.kind === "explicit"))
    };
  }

  /**
   * The path as runs read it (Run contracts): each answer review session
   * other than the run's own collapses to its source question followed by
   * the group's latest version. `keepLeaf` keeps the path's leaf when it is
   * the run's own turn, which a regeneration answers again even inside a
   * session; any other leaf collapses like every member.
   */
  async function collapsedAnswerReviewRows(
    rows: ConversationPathRow[],
    chatId: string,
    options: ConversationContextOptions,
    keepLeaf: boolean
  ): Promise<ConversationPathRow[]> {
    if (!rows.some((row) => row.messageAnswerReviewSessionId)) return rows;
    const sessions = await prismaClient.answerReviewSession.findMany({
      select: { id: true, sourceAssistantMessageId: true },
      where: { chatId, id: { in: [...new Set(rows.flatMap((row) => row.messageAnswerReviewSessionId ?? []))] } }
    }).catch(retainRunPrismaCode);
    const leaf = keepLeaf ? rows.at(-1)?.messageId : undefined;
    const collapse = collapseAnswerReviews(rows.flatMap((row) => row.messageId ? [{
      answerReviewSessionId: row.messageAnswerReviewSessionId ?? null,
      id: row.messageId,
      parentId: row.messageParentId ?? null,
      role: row.messageRole ?? "",
      status: row.messageStatus ?? "",
      systemTurnKind: row.messageSystemTurnKind ?? null
    }] : []), sessions, {
      ...(leaf ? { keepMessageIds: new Set([leaf]) } : {}),
      keepSessionId: options.answerReviewSessionId ?? null
    });
    return rows.filter((row) => !row.messageId || !collapse.removed.has(row.messageId));
  }

  async function loadInternalRunControl(runId: string) {
    const run = await prismaClient.modelRun.findFirst({
      select: {
        answerCompletedAt: true,
        workspaceWaitPending: true,
        assistantMessageId: true,
        chat: { select: { userId: true } },
        chatId: true,
        errorPayload: true,
        id: true,
        modelId: true,
        provider: true,
        providerResponseId: true,
        status: true
      },
      where: { id: runId }
    }).catch(retainRunPrismaCode);
    if (!run) return null;
    return {
      ...(run.answerCompletedAt ? { answerComplete: true as const } : {}),
      workspaceWaitPending: run.workspaceWaitPending,
      assistantMessageId: run.assistantMessageId,
      chatId: run.chatId,
      id: run.id,
      ...(run.chat.userId === null ? { legacyProjectChat: true as const } : {}),
      modelId: run.modelId,
      provider: run.provider,
      providerResponseId: run.providerResponseId,
      recoverySettled: isRecoveredRunTerminalPayload(run.errorPayload),
      status: run.status
    };
  }

  return {
    followups: createPrismaRunFollowupOperations(prismaClient),
    admitPreparingRun: (input) =>
      admitPreparingRunWithClient(prismaClient, input, memorySourceHooks).catch(retainRunPrismaCode),
    beginPreparingRunAttempt: (input) =>
      beginPreparingRunAttemptWithClient(prismaClient, input).catch(retainRunPrismaCode),
    completePreparingRunAttempt: (input) =>
      completePreparingRunAttemptWithClient(prismaClient, input).catch(retainRunPrismaCode),
    finalizePreparingRun: (input) =>
      finalizePreparingRunWithClient(prismaClient, input, memoryExecutionAuthority).catch(retainRunPrismaCode),
    hasPendingPdfPreparation: async (runId) => Boolean(await prismaClient.chatPdfRunPreparation.findFirst({
      select: { modelRunId: true }, where: { modelRunId: runId, state: { in: ["pending", "preparing", "answer_ready"] } }
    }).catch(retainRunPrismaCode)),
    recordMonitoringVerdict: (input) =>
      recordScheduledMonitoringVerdict(prismaClient, input).catch(retainRunPrismaCode),
    createScheduledTaskForCall: (input) => createScheduledTaskForToolCall(prismaClient, scheduledTaskCreationDeps, input)
      .catch(retainRunPrismaCode),
    saveSkillForCall: (input) => saveSkillForToolCall(prismaClient, input).catch(retainRunPrismaCode),
    loadRunSearchSourceUrls: (input) => fetchUrlOperations.loadRunSearchSourceUrls(input).catch(retainRunPrismaCode),
    loadRunFetchUrlCalls: (input) => fetchUrlOperations.loadRunFetchUrlCalls(input).catch(retainRunPrismaCode),
    loadScheduledPromptMessageIds: (input) =>
      fetchUrlOperations.loadScheduledPromptMessageIds(input).catch(retainRunPrismaCode),
    loadMcpToolConsentServerIds: (input) => loadMcpToolConsentServerIds(prismaClient, input).catch(retainRunPrismaCode),
    loadMcpApprovalContinuation: (input) => loadMcpApprovalContinuation(prismaClient, input).catch(retainRunPrismaCode),
    loadRunMcpApprovalCards: (input) => loadRunMcpApprovalCards(prismaClient, input).catch(retainRunPrismaCode),
    loadScheduledTaskManagement: (input) => loadScheduledTaskManagementAdmission(prismaClient, input).catch(retainRunPrismaCode),
    manageScheduledTaskForCall: (input) => manageScheduledTaskForToolCall(prismaClient, scheduledTaskCreationDeps, input)
      .catch(retainRunPrismaCode),
    recoverPreparingRun: (input) =>
      recoverPreparingRunWithClient(prismaClient, input, memorySourceHooks).catch(retainRunPrismaCode),
    retryPreparingRunAttempt: (input) =>
      retryPreparingRunAttemptWithClient(prismaClient, input).catch(retainRunPrismaCode),
    settlePreparingRunFailure: (input) =>
      settlePreparingRunFailureWithClient(prismaClient, input, memorySourceHooks).catch(retainRunPrismaCode),
    ...mcpDiscoveryOperations,
    ...toolLoopOperations,
    cancelRun: async (input) => {
      const cancellation = await measureTransaction({ subsystem: "runs", operation: "run_cancel" }, async (tx) => {
        const lockedRun = await lockPreparingRun(tx, input.runId, input.userId);
        const updatedCount = lockedRun?.status === "preparing"
          ? Number(await settlePreparingRunInTransaction(tx, {
              errorCode: input.payload.code,
              message: input.payload.message,
              runId: input.runId,
              state: "CANCELLED",
              userId: input.userId
            }, memorySourceHooks))
          : (await tx.modelRun.updateMany({
              data: {
                answerCompletionUsage: Prisma.DbNull,
                errorPayload: json(input.payload),
                status: "cancelled"
              },
              where: {
                id: input.runId,
                status: { in: dispatchableModelRunStatuses },
                userId: input.userId
              }
            })).count;
        const run = await tx.modelRun.findFirst({
          select: {
            assistantMessageId: true,
            chatId: true,
            id: true,
            modelId: true,
            provider: true,
            providerResponseId: true,
            status: true
          },
          where: {
            id: input.runId,
            userId: input.userId
          }
        });

        if (!run) {
          if (updatedCount > 0) {
            throw new Error("Cancelled run disappeared before transaction commit");
          }

          return { kind: "not_found" } as const;
        }

        if (updatedCount === 0) {
          if (run.status === "preparing") {
            throw new Error("PREPARING run could not be cancelled safely");
          }
          return {
            kind: "current",
            run: runControlRecord(run)
          } as const;
        }

        await cancelPendingToolLoopCallsInTransaction(tx, input.runId);
        await closeRunningToolLoopCallsInTransaction(tx, input.runId);
        await tx.workspaceFollowup.updateMany({ where: { modelRunId: input.runId, state: { in: ["waiting", "preparing"] } },
          data: { state: "cancelled", snapshot: Prisma.DbNull, admissionResult: Prisma.DbNull, claimToken: null, leaseExpiresAt: null } });

        if (run.assistantMessageId) {
          await tx.message.updateMany({
            data: {
              errorMessage: input.payload.message,
              status: "cancelled"
            },
            where: {
              id: run.assistantMessageId,
              status: {
                in: activeMessageStatuses
              }
            }
          });
        }
        if (lockedRun?.status !== "preparing") {
          await settleTerminalMemorySource(tx, {
            assistantMessageId: run.assistantMessageId,
            chatId: run.chatId,
            runId: run.id,
            status: "cancelled",
            userId: input.userId
          }, memorySourceHooks);
        }

        return {
          kind: "cancelled",
          run: {
            ...runControlRecord(run),
            status: "cancelled"
          }
        } as const;
      }, (body) => prismaClient.$transaction(body)).catch(retainRunPrismaCode);
      // After commit; browser push never notifies the user's own cancellation.
      if (cancellation.kind === "cancelled") signalRunCancelled(input.runId);
      return cancellation;
    },
    continuePdfPreparedRun: async (input) => {
      const created = await continuePdfPreparedRunWithClient(prismaClient, input,
        memoryRetrieval, memoryExecutionAuthority, memorySourceHooks,
        await loadMemoryAdmissionDeadlineMs(input.admission.normalizedRequest)).catch(retainRunPrismaCode);
      return { assistantMessageId: created.assistantMessageId, runId: created.runId,
        userMessageId: created.userMessageId,
        ...(created.materializedRequest ? { materializedRequest: created.materializedRequest } : {}) };
    },
    continueWorkspacePreparedRun: async (input) => {
      const created = await continueWorkspacePreparedRunWithClient(prismaClient, input,
        memoryRetrieval, memoryExecutionAuthority, memorySourceHooks,
        await loadMemoryAdmissionDeadlineMs(input.admission.normalizedRequest)).catch(retainRunPrismaCode);
      return { assistantMessageId: created.assistantMessageId, runId: created.runId,
        userMessageId: created.userMessageId, ...(created.deferredPdf ? { deferredPdf: true as const } : {}),
        ...(created.materializedRequest ? { materializedRequest: created.materializedRequest } : {}) };
    },
    createRun: async (input) => {
      const memoryAdmissionDeadlineMs = await loadMemoryAdmissionDeadlineMs(input.normalizedRequest);
      const created = await createDormantPreparingRun(prismaClient, {
        ...input,
        admissionKind: "NORMAL_SEND"
      }, memoryRetrieval, memoryExecutionAuthority, memorySourceHooks,
        memoryAdmissionDeadlineMs).catch(retainRunPrismaCode);
      return {
        acceptedAt: created.acceptedAt,
        assistantMessageId: created.assistantMessageId,
        ...(created.deferredPdf ? { deferredPdf: true as const } : {}),
        ...(created.deferredWorkspace ? { deferredWorkspace: true as const } : {}),
        ...(created.materializedRequest
          ? { materializedRequest: created.materializedRequest }
          : {}),
        runId: created.runId,
        userMessageId: created.userMessageId
      };
    },
    createRegenerationRun: async (input) => {
      const memoryAdmissionDeadlineMs = await loadMemoryAdmissionDeadlineMs(input.normalizedRequest);
      const created = await createDormantPreparingRun(prismaClient, {
        ...input,
        admissionKind: "REGENERATE"
      }, memoryRetrieval, memoryExecutionAuthority, memorySourceHooks,
        memoryAdmissionDeadlineMs).catch(retainRunPrismaCode);
      return {
        acceptedAt: created.acceptedAt,
        assistantMessageId: created.assistantMessageId,
        ...(created.deferredPdf ? { deferredPdf: true as const } : {}),
        ...(created.materializedRequest
          ? { materializedRequest: created.materializedRequest }
          : {}),
        runId: created.runId,
        userMessageId: created.userMessageId
      };
    },
    createSearchRun: async (input) => {
      if (input.invocationId) {
        const existingInvocation = await prismaClient.searchRun.findUnique({
          select: { id: true },
          where: {
            modelRunId_invocationId: {
              invocationId: input.invocationId,
              modelRunId: input.modelRunId
            }
          }
        }).catch(retainRunPrismaCode);
        if (existingInvocation) return;
      }
      const artifacts = isRecord(input.artifacts) ? input.artifacts : null;
      const toolCall = artifacts && isRecord(artifacts.toolCall) ? artifacts.toolCall : null;
      const providerCallId = toolCall && typeof toolCall.id === "string" ? toolCall.id : null;
      if (providerCallId) {
        const existing = await prismaClient.searchRun.findFirst({
          select: { id: true },
          where: {
            artifacts: { path: ["toolCall", "id"], equals: providerCallId },
            modelRunId: input.modelRunId,
            provider: input.provider,
            strategyId: input.strategyId
          }
        }).catch(retainRunPrismaCode);
        if (existing) return;
      }
      await prismaClient.searchRun.create({
        data: {
          artifacts: json(input.artifacts),
          invocationId: input.invocationId,
          modelId: input.modelId,
          modelRunId: input.modelRunId,
          provider: input.provider,
          searchRevisionId: input.searchRevisionId,
          status: input.status,
          strategyId: input.strategyId
        }
      }).catch(retainRunPrismaCode);
    },
    failRun: async (runId, assistantMessageId, error, options) => {
      const failed = await measureTransaction({ subsystem: "runs", operation: "run_fail" }, async (tx) => {
        await lockRunSettlementScope(tx, runId);
        const [lockedRun] = await tx.$queryRaw<Array<{
          status: ModelRunStatus;
          userId: string;
        }>>(Prisma.sql`
          SELECT "status", "userId"
          FROM "ModelRun"
          WHERE "id" = ${runId}
          FOR UPDATE
        `);
        if (!lockedRun) return false;
        if (options?.workspaceClaimToken) await assertWorkspaceFollowupClaim(tx, {
          claimToken: options.workspaceClaimToken, runId, userId: lockedRun.userId
        }, "settlement");
        const updatedCount = lockedRun.status === "preparing"
          ? Number(await settlePreparingRunInTransaction(tx, {
              errorCode: error.code,
              message: error.message,
              runId,
              state: "FAILED",
              userId: lockedRun.userId
            }, memorySourceHooks))
          : (await tx.modelRun.updateMany({
              data: {
                answerCompletionUsage: Prisma.DbNull,
                errorPayload: json(
                  options?.recoveryTerminal
                    ? recoveredRunErrorPayload(error)
                    : error
                ),
                status: "error"
              },
              where: {
                id: runId,
                status: { in: dispatchableModelRunStatuses }
              }
            })).count;

        if (updatedCount === 0) {
          return false;
        }

        await cancelPendingToolLoopCallsInTransaction(tx, runId);
        // Without the recovery marker the error run stays recoverable, and
        // recovery owns its running calls.
        if (options?.recoveryTerminal) await closeRunningToolLoopCallsInTransaction(tx, runId);
        await tx.workspaceFollowup.updateMany({ where: { modelRunId: runId, state: { in: ["waiting", "preparing"] } },
          data: { state: "failed", snapshot: Prisma.DbNull, admissionResult: Prisma.DbNull, claimToken: null, leaseExpiresAt: null } });

        await tx.message.updateMany({
          data: {
            errorMessage: error.message,
            status: "error"
          },
          where: {
            id: assistantMessageId,
            status: {
              in: activeMessageStatuses
            }
          }
        });
        if (lockedRun.status !== "preparing") {
          const run = await tx.modelRun.findUniqueOrThrow({
            select: { assistantMessageId: true, chatId: true, id: true },
            where: { id: runId }
          });
          await settleTerminalMemorySource(tx, {
            assistantMessageId: run.assistantMessageId,
            chatId: run.chatId,
            runId: run.id,
            status: "error",
            userId: lockedRun.userId
          }, memorySourceHooks);
        }
        return true;
      }, (body) => prismaClient.$transaction(body)).catch(retainRunPrismaCode);
      if (failed) signalRunTerminal(runId);
      return failed;
    },
    findOwnedChat: async (chatId, userId) => {
      const chat = await prismaClient.chat.findFirst({
        select: {
          _count: { select: { messages: true } },
          activeLeafMessageId: true,
          assistantId: true,
          assistantOverrides: true,
          defaultProviderModel: { select: { connectionId: true, id: true } },
          folder: { select: { projectMemory: true } },
          folderId: true,
          id: true,
          memoryMode: true,
          title: true,
          workspaceEnabled: true
        },
        where: {
          archived: false,
          id: chatId,
          permanentDeletionAt: null,
          userId
        }
      }).catch(retainRunPrismaCode);
      if (!chat) return null;
      return {
        activeLeafMessageId: chat.activeLeafMessageId,
        assistantId: chat.assistantId,
        assistantOverrides: chat.assistantOverrides,
        defaultModelId: chat.defaultProviderModel?.id ?? "",
        defaultProvider: chat.defaultProviderModel?.connectionId ?? "",
        folderId: chat.folderId,
        id: chat.id,
        memoryMode: chat.memoryMode,
        messageCount: chat._count.messages,
        projectMemory: chat.folder?.projectMemory ?? null,
        title: chat.title,
        workspaceEnabled: chat.workspaceEnabled
      };
    },
    loadAssistantRowContext: (input) =>
      loadPersonalAssistantRowContext(prismaClient, input).catch(retainRunPrismaCode),
    loadPersonalFirstSend: async ({ chatId, folderId, memoryMode, userId }) => {
      const [existing, defaults, folder] = await Promise.all([
        prismaClient.chat.findUnique({ select: { id: true }, where: { id: chatId } }).catch(retainRunPrismaCode),
        loadChatCreationDefaults(prismaClient, userId).catch(retainRunPrismaCode),
        folderId
          ? prismaClient.folder.findFirst({
              select: { id: true, projectMemory: true },
              where: { id: folderId, userId }
            }).catch(retainRunPrismaCode)
          : null
      ]);
      if (existing || !defaults || (folderId && !folder)) return null;
      const model = defaults.defaultProviderModelId
        ? await prismaClient.providerModel.findUnique({
            select: { connectionId: true, id: true },
            where: { id: defaults.defaultProviderModelId }
          }).catch(retainRunPrismaCode)
        : null;
      return {
        activeLeafMessageId: null,
        defaultModelId: model?.id ?? "",
        defaultProvider: model?.connectionId ?? "",
        folderId,
        id: chatId,
        // Temporary is an atomic NORMAL -> TEMPORARY first-send conversion;
        // prepareRun must see the pre-conversion source mode.
        memoryMode: memoryMode === "TEMPORARY" ? "NORMAL" : memoryMode,
        messageCount: 0,
        projectMemory: folder?.projectMemory ?? null,
        title: "New Chat",
        workspaceEnabled: false
      };
    },
    findRecentActiveRunForChat: async ({ chatId, since, userId }) => {
      const chat = await prismaClient.chat.findUnique({ select: { userId: true }, where: { id: chatId } }).catch(retainRunPrismaCode);
      if (!chat || chat.userId !== userId) return null;
      const run = await prismaClient.modelRun.findFirst({
        select: {
          assistantMessageId: true, chatId: true, id: true, modelId: true,
          provider: true, providerResponseId: true, status: true, answerCompletedAt: true, workspaceWaitPending: true,
          workspaceRunBinding: { select: { modelRunId: true } }
        },
        orderBy: { updatedAt: "desc" },
        where: { chatId, status: { in: activeModelRunStatuses }, updatedAt: { gt: since } }
      }).catch(retainRunPrismaCode);
      return run ? { assistantMessageId: run.assistantMessageId, chatId: run.chatId, id: run.id, modelId: run.modelId,
        provider: run.provider, providerResponseId: run.providerResponseId, status: run.status,
        workspaceWaitPending: run.workspaceWaitPending,
        ...(run.answerCompletedAt && run.workspaceRunBinding ? { answerComplete: true as const } : {}) } : null;
    },
    findRegenerationSource: async (sourceMessageId, userId) => {
      const sourceMessage = await prismaClient.message.findFirst({
        include: {
          chat: {
            select: {
              assistantId: true,
              assistantOverrides: true,
              defaultProviderModel: {
                select: {
                  connectionId: true,
                  id: true
                }
              },
              folder: {
                select: {
                  projectMemory: true
                }
              },
              id: true,
              memoryMode: true,
              workspaceEnabled: true
            }
          },
          parent: {
            select: {
              content: true,
              id: true,
              role: true,
              scheduledTaskPrompt: true
            }
          }
        },
          where: {
            chat: {
              archived: false,
              permanentDeletionAt: null
          },
          id: sourceMessageId,
          role: { in: ["assistant", "user"] }
        }
      }).catch(retainRunPrismaCode);

      if (!sourceMessage) {
        return null;
      }

      const access = await resolveChatAccess(prismaClient, {
        chatId: sourceMessage.chat.id,
        userId
      }).catch(retainRunPrismaCode);
      if (!access) return null;

      const chat = {
        // Regeneration and edited branches run with the chat's binding, never the composer's.
        assistantId: sourceMessage.chat.assistantId,
        assistantOverrides: sourceMessage.chat.assistantOverrides,
        defaultModelId: sourceMessage.chat.defaultProviderModel?.id ?? "",
        defaultProvider: sourceMessage.chat.defaultProviderModel?.connectionId ?? "",
        id: sourceMessage.chat.id,
        memoryMode: sourceMessage.chat.memoryMode,
        projectMemory: sourceMessage.chat.folder?.projectMemory ?? null,
        workspaceEnabled: sourceMessage.chat.workspaceEnabled
      };

      if (sourceMessage.role === "user") {
        const sourceRun = await prismaClient.modelRun.findFirst({
          where: { userMessageId: sourceMessage.id, userId },
          orderBy: { createdAt: "desc" },
          select: { normalizedRequest: true }
        }).catch(retainRunPrismaCode);
        const normalizedRequest = sourceRun?.normalizedRequest;
        const artifactEdit = normalizedRequest && typeof normalizedRequest === "object" && !Array.isArray(normalizedRequest)
          ? normalizedRequest.artifactEdit : undefined;
        const memory = await scheduledTaskMemory(sourceMessage, userId);
        return {
          ...(artifactEdit !== undefined ? { artifactEdit } : {}),
          ...(normalizedRequest && typeof normalizedRequest === "object" && !Array.isArray(normalizedRequest) && normalizedRequest.artifactIntent === "create" ? { artifactIntent: "create" } : {}),
          assistantMessage: null,
          chat,
          userMessage: {
            content: sourceMessage.content,
            id: sourceMessage.id,
            scheduledTaskPrompt: sourceMessage.scheduledTaskPrompt,
            ...(memory ? { scheduledTaskMemory: true as const } : {})
          }
        };
      }

      if (!sourceMessage.parent || sourceMessage.parent.role !== "user") {
        return null;
      }

      const sourceRun = await prismaClient.modelRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
          ...runFollowupSelect, id: true, followupRevision: true, status: true, answerCompletedAt: true,
          normalizedRequest: true,
          providerRunBindings: {
            select: {
              connectionId: true,
              providerModelId: true
            },
            where: { role: "answer" }
          }
        },
        where: {
          assistantMessageId: sourceMessage.id,
          userId
        }
      }).catch(retainRunPrismaCode);
      const answerBinding = sourceRun?.providerRunBindings[0];
      const regenerationFollowups = sourceRun?.followups.length ? projectRunFollowups(sourceRun)
        : decodeRunFollowupState(sourceMessage.branchFollowups);
      const normalizedRequest = sourceRun?.normalizedRequest;
      const artifactEdit = normalizedRequest && typeof normalizedRequest === "object" && !Array.isArray(normalizedRequest)
        ? normalizedRequest.artifactEdit : undefined;
      const memory = await scheduledTaskMemory({ ...sourceMessage.parent, chatId: sourceMessage.chat.id }, userId);

      return {
        ...(regenerationFollowups?.entries.length ? { followups: { messageId: sourceMessage.id,
          revision: regenerationFollowups.entries.length, entries: regenerationFollowups.entries } } : {}),
        ...(artifactEdit !== undefined ? { artifactEdit } : {}),
        ...(normalizedRequest && typeof normalizedRequest === "object" && !Array.isArray(normalizedRequest) && normalizedRequest.artifactIntent === "create" ? { artifactIntent: "create" } : {}),
        assistantMessage: {
          id: sourceMessage.id,
          modelId: answerBinding?.providerModelId ?? null,
          provider: answerBinding?.connectionId ?? null
        },
        chat,
        userMessage: {
          content: sourceMessage.parent.content,
          id: sourceMessage.parent.id,
          scheduledTaskPrompt: sourceMessage.parent.scheduledTaskPrompt,
          ...(memory ? { scheduledTaskMemory: true as const } : {})
        }
      };
    },
    getRunControlForUser: async (runId, userId) => {
      const control = await loadInternalRunControl(runId);
      if (control) {
        const chat = await prismaClient.chat.findUnique({ select: { userId: true }, where: { id: control.chatId } }).catch(retainRunPrismaCode);
        if (chat?.userId !== userId) return null;
      }
      return control;
    },
    getRunControlForRecovery: loadInternalRunControl,
    getRunOutcomeForUser: async (runId, userId) => {
      const run = await prismaClient.modelRun.findFirst({
        select: {
          ...runFollowupSelect,
          chatId: true,
          answerCompletedAt: true,
          workspaceWaitPending: true,
          workspaceFollowup: { select: { state: true } },
          chatPdfPreparation: { select: { retryable: true, state: true } },
          chatPdfAttachments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: {
            completedPages: true, pageCount: true, retryable: true, route: true, state: true,
            readerModelName: true, answerModelName: true
          } },
          id: true,
          status: true
        },
        where: { id: runId }
      }).catch(retainRunPrismaCode);
      if (run) {
        const chat = await prismaClient.chat.findUnique({ select: { userId: true }, where: { id: run.chatId } }).catch(retainRunPrismaCode);
        if (chat?.userId !== userId) return null;
      }

      return run
        ? {
            ...(run.followupMode || run.followups?.length ? { followups: projectRunFollowups(run) } : {}),
            ...(run.answerCompletedAt ? { answerComplete: true as const } : {}),
            ...(run.workspaceWaitPending && run.status === "preparing" ? { workspacePreparation: true as const } : {}),
            ...(run.chatPdfAttachments?.length ? { pdfPreparation: run.chatPdfAttachments.map((row) =>
              projectChatPdfPreparation(row, run.chatPdfPreparation?.state === "failed" || run.chatPdfPreparation?.state === "cancelled"
                ? { phase: run.status === "error" ? "failed" : "cancelled",
                    retryable: run.status === "error" && run.chatPdfPreparation?.retryable === true } : undefined)) } : {}),
            id: run.id,
            status: run.status === "preparing" && (run.followupMode || run.chatPdfPreparation || run.workspaceFollowup)
              ? "queued"
              : acceptedRunStatus(run.status)
          }
        : null;
    },
    getChatUpdateForRun: async ({ assistantMessageId, chatId, userId, userMessageId }) => {
      const workspaceSnapshot = await workspaceAvailability.snapshot();
      return prismaClient.$transaction(async (tx) => {
        const access = await resolveChatAccess(tx, { chatId, userId });
        if (!access) return null;
        const chat = await tx.chat.findFirst({
        select: {
          ...chatTitleMetadataSelect,
          _count: {
            select: {
              messages: true
            }
          },
          activeLeafMessageId: true,
          createdAt: true,
          defaultSearchPlan: true,
          defaultProviderModel: {
            select: {
              activeConfig: true,
              activeVersion: true,
              connectionId: true,
              enabled: true,
              id: true,
              modelClass: true
            }
          },
          folderId: true,
          id: true,
          memoryMode: true,
          messages: {
            include: {
              assistantModelRuns: {
                orderBy: {
                  createdAt: "desc"
                },
                select: {
                  ...runFollowupSelect,
                  answerCompletedAt: true,
                  engine: true,
                  chatPdfPreparation: { select: { retryable: true, state: true } },
                  chatPdfAttachments: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: {
                    completedPages: true, pageCount: true, retryable: true, route: true, state: true,
                    readerModelName: true, answerModelName: true
                  } },
                  answerStartedAt: true,
                  assistantId: true,
                  assistantMessageId: true,
                  assistantIdentity: true,
                  createdAt: true,
                  events: {
                    orderBy: {
                      sequence: "asc"
                    },
                    select: {
                      payload: true
                    },
                    where: {
                      eventType: { in: ["artifact", WORKSPACE_ACTIVITY_SNAPSHOT] }
                    }
                  },
                  errorPayload: true,
                  id: true,
                  searchRuns: {
                    orderBy: {
                      createdAt: "asc"
                    },
                    select: {
                      artifacts: true,
                      invocationId: true,
                      status: true,
                      strategyId: true
                    }
                  },
                  normalizedRequest: true,
                  userId: true,
                  status: true,
                  mcpToolApprovals: { orderBy: [{ createdAt: "asc" }, { id: "asc" }], select: mcpApprovalCardSelect, take: 16 },
                  workspaceExecutions: { take: 512, orderBy: { startedAt: "desc" },
                    select: { modelRunToolCallId: true, state: true, lastErrorCode: true } },
                  workspaceRunBinding: {
                    select: { exportAttemptCount: true, exportLeaseExpiresAt: true, exportState: true, lastExportErrorCode: true,
                      outputCapture: true, updatedAt: true }
                  },
                  toolCalls: {
                    orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
                    select: {
                      mcpRunBinding: { select: { runtimeGenerationFingerprint: true } },
                      completedAt: true,
                      id: true,
                      ordinal: true,
                      providerCallId: true,
                      result: true,
                      roundIndex: true,
                      startedAt: true,
                      state: true,
                      toolName: true
                    }
                  },
                  updatedAt: true,
                  workspaceProducedAttachments: {
                    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
                    select: {
                      byteSize: true,
                      checksum: true,
                      fileName: true,
                      id: true,
                      mimeType: true,
                      origin: true, metadata: true,
                      workspaceRunOutput: { select: { relativePath: true } },
                      workspaceCheckpointFile: { select: { relativePath: true, checkpoint: { select: { id: true, description: true, createdAt: true, state: true } } } }
                    }
                  }
                },
                take: 1
              }
            },
            orderBy: {
              createdAt: "asc"
            },
            where: {
              id: {
                in: [userMessageId, assistantMessageId]
              }
            }
          },
          pinned: true,
          title: true,
          updatedAt: true,
          workspaceEnabled: true,
          workspaceSession: {
            select: {
              internetEnabled: true,
              state: true
            }
          }
        },
        where: {
          archived: false,
          id: chatId,
          permanentDeletionAt: null
        }
        });

        if (!chat || chat.memoryMode === "TEMPORARY") {
          return null;
        }

        const runIds = chat.messages.flatMap((message) =>
          message.assistantModelRuns[0]?.id ? [message.assistantModelRuns[0].id] : []);
        // A review step's turn and answer carry their session for the live transcript.
        const answerReviews = await loadAnswerReviewProjection(tx, { chatId, messages: chat.messages.map((message) => ({
          answerReviewRound: message.answerReviewRound, answerReviewSessionId: message.answerReviewSessionId,
          answerReviewStep: message.answerReviewStep, id: message.id, parentMessageId: message.parentMessageId, role: message.role,
          stepModelName: answerReviewStepModelName(message.assistantModelRuns[0]?.normalizedRequest),
          systemTurnKind: message.systemTurnKind
        })), viewerUserId: userId });
        const [
          { contextStats, usageStats },
          memoryActionsByRun,
          memorySourcesByRun,
          memoryStatusesByRun
        ] = await Promise.all([
          loadChatBranchSnapshotStats(tx, {
            activeLeafMessageId: chat.activeLeafMessageId,
            chatId
          }),
          loadMemoryRunActions(tx, { runIds, userId }),
          loadMemoryRunSources(tx, { runIds, userId }),
          loadMemoryRunPresentationStatuses(tx, { runIds, userId })
        ]);

        return {
          chat: {
            activeLeafMessageId: chat.activeLeafMessageId,
            contextStats,
            createdAt: chat.createdAt,
            defaultSearchPlan: (() => { const decoded = decodeSearchPlan(chat.defaultSearchPlan); return decoded.ok ? decoded.plan : null; })(),
            defaultModelId: chat.defaultProviderModel?.id ?? null,
            defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
            folderId: chat.folderId,
            id: chat.id,
            messageCount: chat._count.messages,
            pinned: chat.pinned,
            title: chat.title,
            ...(chatTitlePending(chat) ? { titlePending: true } : {}),
            updatedAt: chat.updatedAt,
            usageStats,
            workspace: workspaceAvailability.project(workspaceSnapshot, {
              enabled: chat.workspaceEnabled,
              modelSupportsTools: workspaceModelSupportsTools(chat.defaultProviderModel),
              session: chat.workspaceSession
            })
          },
          messages: chat.messages.map((message) => {
            const modelRun = message.assistantModelRuns[0];

            return {
              ...(modelRun?.followupMode || modelRun?.followups?.length ? { followups: projectRunFollowups(modelRun) } : {}),
              artifactSummary: modelRun
                ? summarizeMessageRunArtifacts(
                    modelRun,
                    memoryActionsByRun.get(modelRun.id) ?? null,
                    memorySourcesByRun.get(modelRun.id) ?? [],
                    memoryStatusesByRun.get(modelRun.id),
                    undefined,
                    userId
                  )
                : null,
              assistantIdentity: serializeRunAssistantIdentity(modelRun),
              citationMessageId: modelRun?.assistantMessageId ?? message.id,
              content: message.content,
              createdAt: message.createdAt,
              errorMessage: message.errorMessage,
              id: message.id,
              modelId: message.modelId,
              modelRunId: modelRun?.id ?? null,
              parentMessageId: message.parentMessageId,
              provider: message.provider,
              role: message.role,
              status: message.status,
              ...(message.systemTurnKind ? { systemTurnKind: message.systemTurnKind } : {}),
              ...(answerReviews.get(message.id) ? { answerReview: answerReviews.get(message.id) } : {}),
              ...(modelRun?.chatPdfAttachments?.length ? { pdfPreparation: modelRun.chatPdfAttachments.map((row) =>
                projectChatPdfPreparation(row, modelRun.chatPdfPreparation?.state === "failed" || modelRun.chatPdfPreparation?.state === "cancelled"
                  ? { phase: modelRun.status === "error" ? "failed" : "cancelled",
                      retryable: modelRun.status === "error" && modelRun.chatPdfPreparation?.retryable === true } : undefined)) } : {}),
              toolActivity: modelRun ? summarizeMessageRunToolActivity(modelRun, userId) : null,
              workspaceActivity: modelRun ? summarizeMessageRunWorkspaceActivity(modelRun) : null
            };
          })
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }).catch(retainRunPrismaCode);
    },
    loadConversationContextForExpectedLeaf: async (
      chatId,
      userId,
      expectedActiveLeafMessageId,
      options
    ) => {
      const context = await loadConversationPath(chatId, userId, {
        kind: "expected",
        leafMessageId: expectedActiveLeafMessageId
      }, options);
      return context.chatMatched ? context.messages : null;
    },
    loadConversationContextForLeaf: async (chatId, userId, leafMessageId, options) => {
      const context = await loadConversationPath(chatId, userId, {
        kind: "explicit",
        leafMessageId
      }, options);
      return context.messages;
    },
    loadSystemTurnMessageIds: async ({ chatId, messageIds }) => {
      const ids = [...new Set(messageIds)];
      if (ids.length === 0) return new Set();
      const rows = await prismaClient.message.findMany({
        select: { id: true }, where: { chatId, id: { in: ids }, role: "user", systemTurnKind: { not: null } }
      }).catch(retainRunPrismaCode);
      return new Set(rows.map((row) => row.id));
    },
    loadWorkspaceFileFacts: input => loadWorkspaceInboxFacts(prismaClient, input).catch(retainRunPrismaCode),
    loadAttachments: async (userId, attachmentIds, runId) => {
      if (attachmentIds.length === 0) {
        return [];
      }

      const attachments = await prismaClient.attachment.findMany({
        where: {
          savedAt: null,
          id: {
            in: attachmentIds
          },
          userId
        }
      }).catch(retainRunPrismaCode);

      const preparedPdfs = runId ? await prismaClient.chatPdfAttachmentPreparation.findMany({ where: {
        modelRunId: runId, attachmentId: { in: attachmentIds }, route: { not: "direct_pdf" },
        modelRun: { userId }
      }, select: { attachmentId: true, state: true, sourceChecksum: true, sourceByteSize: true,
        modelRun: { select: { workspaceRunBinding: { select: { modelRunId: true } } } }, documentArtifact: { select: {
        byteSize: true, checksum: true, pageCount: true, sourceChecksum: true, storageKey: true, state: true
      } } } }).catch(retainRunPrismaCode) : [];
      if (preparedPdfs.some((row) => !attachments.some((attachment) => attachment.id === row.attachmentId &&
        attachment.checksum?.trim() === row.sourceChecksum.trim() && attachment.byteSize === row.sourceByteSize) ||
        (row.state === "original_only"
          ? !row.modelRun.workspaceRunBinding || row.documentArtifact !== null
          : row.state !== "ready" || row.documentArtifact?.state !== "ready"))) {
        throw new AttachmentLinkConflictError();
      }
      const documents = new Map(preparedPdfs.filter((row) => row.state === "ready")
        .map((row) => [row.attachmentId, row.documentArtifact!]));
      const originals = new Set(preparedPdfs.filter((row) => row.state === "original_only").map((row) => row.attachmentId));
      return attachments.map(
        (attachment): RunAttachmentRecord => ({
          ...(documents.has(attachment.id) ? { preparedPdf: documents.get(attachment.id)! } : {}),
          ...(originals.has(attachment.id) ? { workspaceOriginalOnly: true } : {}),
          byteSize: attachment.byteSize,
          checksum: attachment.checksum,
          extractedText: attachment.extractedText,
          fileName: attachment.fileName,
          id: attachment.id,
          kind: attachment.kind,
          metadata: attachment.metadata,
          mimeType: attachment.mimeType,
          processingErrorCode: attachment.processingErrorCode,
          status: attachment.status,
          storageKey: attachment.storageKey
        })
      );
    },
    loadEntitlements: (userId) => loadEntitlementsForUser(userId).catch(retainRunPrismaCode),
    loadModelPricing: async (provider, modelId, providerModelId) => {
      const models = await prismaClient.providerModel.findMany({
        // Answers and Search engines can report the web searches they ran.
        select: modelSearchPricingSelect,
        take: 2,
        where: { modelClass: "answer", ...(providerModelId ? { id: providerModelId } : { modelId, provider }) }
      }).catch(retainRunPrismaCode);

      return models.length === 1
        ? modelSearchPricing(models[0])
        : null;
    },
    loadProviderModelCostBasis: (providerModelId) =>
      loadProviderModelCostBasis(prismaClient, providerModelId).catch(retainRunPrismaCode),
  };
}
