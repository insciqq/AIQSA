import {
  Prisma,
  type ModelRunStatus
} from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import { groundedLiveOnlyMessageContent } from "../../domain/grounding";
import { textFromContentBlocks } from "../../domain/modelRunEvents";
import { normalizeTokenUsage } from "../../domain/usage";
import {
  loadChatBranchSnapshotStats,
  summarizeMessageRunArtifacts,
  summarizeMessageRunToolActivity
} from "../chats/prismaRepository";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { prisma } from "../prisma";
import type { ProviderConversationMessage } from "../providers/types";
import {
  type ProjectRunAdmission,
  type RunAttachmentRecord,
  type RunRepository
} from "./runRepositoryContract";
import {
  createPrismaMemoryRunRetrievalService,
  type MemoryRunRetrievalService
} from "../memory/retrieval";
import type { MemoryExecutionAuthorityDependencies } from "../memory/execution";
import { defaultMemoryExecutionAuthority } from "../memory/execution/defaultAuthority";
import { decodeKnowledgePlan, type KnowledgePlan } from "../../contracts/knowledge";
import { loadMemoryRunActions } from "../memory/actions/runProjection";
import { loadMemoryRunSources } from "../memory/sources/runProjection";
import { loadMemoryRunPresentationStatuses } from "../memory/retrieval/runProjection";
import type { MemorySourceMutationHooks } from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import {
  boundedMemoryAdmissionDeadlineMs,
  memoryAdmissionDeadlineMsFromPolicySeconds,
  MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS
} from "../memory/admissionDeadline";
import { serializeRunAssistantIdentity } from "./prismaRepositoryBindings";
import {
  admitPreparingRunWithClient,
  beginPreparingRunAttemptWithClient,
  completePreparingRunAttemptWithClient,
  createDormantPreparingRun,
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
  projectRunRecoveryAuthority,
  runControlRecord,
  unique
} from "./prismaRepositoryShared";
import {
  appendRunOutputEvents,
  cancelPendingToolLoopCallsInTransaction,
  createPrismaRunToolLoopOperations,
  isRecoveredRunTerminalPayload,
  recoveredRunErrorPayload
} from "./prismaRepositoryToolLoop";
import { createPrismaMcpDiscoveryOperations } from "./prismaRepositoryMcpDiscovery";
import { resolveChatAccess, resolveProjectAccess } from "../projects/access";
import {
  decodeProjectDefaults,
  decodeProjectPolicy
} from "../../contracts/projects";
import {
  groundKnowledgeRunAnswer,
  groundKnowledgeRunAnswerV5,
  loadKnowledgeFullContextDispatchRecovery,
  settleKnowledgeGrounding
} from "../knowledge/evidenceRepository";
import { decodeKnowledgeDocumentContext } from "../knowledge/documentContext";
import type { KnowledgeFullContextPassage } from "../knowledge/fullContext";

export { insertAcceptedMcpRunBindings } from "./prismaRepositoryBindings";

function knowledgeDefaultFromJson(value: unknown): KnowledgePlan | null {
  if (value === null || value === undefined) return null;
  const decoded = decodeKnowledgePlan(value);
  if (!decoded.ok) throw new Error("knowledge_default_integrity_invalid");
  return decoded.plan;
}

type ConversationPathSelector =
  | { kind: "active" }
  | { kind: "expected"; leafMessageId: string | null }
  | { kind: "explicit"; leafMessageId: string };

type ConversationPathRow = {
  chatId: string;
  messageGroundedAt: Date | null;
  messageContent: Prisma.JsonValue | null;
  messageId: string | null;
  messageParentId?: string | null;
  messageRole: string | null;
  messageStatus: string | null;
};

export function conversationMessagesFromPathRows(rows: ConversationPathRow[]): ProviderConversationMessage[] {
  const failedWithoutAnswer = new Set<string>();
  for (let index = 1; index < rows.length; index += 1) {
    const row = rows[index]!;
    const parent = rows[index - 1]!;
    if (
      row.messageRole === "assistant" &&
      row.messageStatus === "error" &&
      (!isRecord(row.messageContent) || !textFromContentBlocks(row.messageContent).trim()) &&
      parent.messageId &&
      parent.messageRole === "user" &&
      parent.messageStatus === "complete" &&
      (row.messageParentId === undefined || row.messageParentId === parent.messageId)
    ) {
      failedWithoutAnswer.add(parent.messageId);
    }
  }

  return rows.flatMap((row) => {
    if (
      !row.messageId ||
      failedWithoutAnswer.has(row.messageId) ||
      (row.messageRole !== "user" && row.messageRole !== "assistant") ||
      (row.messageStatus !== "complete" && row.messageStatus !== "streaming")
    ) {
      return [];
    }

    return [
      {
        content: row.messageGroundedAt
          ? groundedLiveOnlyMessageContent()
          : row.messageContent as { blocks: unknown[] },
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
  }> = {}
): RunRepository {
  const memorySourceHooks = options.memorySourceHooks ?? defaultMemorySourceMutationHooks;
  const memoryExecutionAuthority = options.memoryExecutionAuthority ??
    defaultMemoryExecutionAuthority;
  const memoryRetrieval = options.memoryRetrieval ??
    createPrismaMemoryRunRetrievalService(prismaClient, {
      authority: memoryExecutionAuthority
    });
  const toolLoopOperations = createPrismaRunToolLoopOperations(
    prismaClient,
    memorySourceHooks
  );
  const mcpDiscoveryOperations = createPrismaMcpDiscoveryOperations(prismaClient);
  async function loadMemoryAdmissionDeadlineMs(): Promise<number> {
    if (options.memoryAdmissionDeadlineMs !== undefined) {
      return boundedMemoryAdmissionDeadlineMs(options.memoryAdmissionDeadlineMs);
    }
    const policy = await prismaClient.modelPolicy.findUnique({
      select: { memoryAdmissionTimeoutSeconds: true },
      where: { id: "installation" }
    });
    if (!policy) throw new Error("installation_model_policy_missing");
    return memoryAdmissionDeadlineMsFromPolicySeconds(
      policy.memoryAdmissionTimeoutSeconds
    );
  }
  async function loadConversationPath(
    chatId: string,
    userId: string,
    selector: ConversationPathSelector
  ): Promise<{ chatMatched: boolean; messages: ProviderConversationMessage[] }> {
    const access = await resolveChatAccess(prismaClient, {
      chatId,
      userId
    });
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
          AND (
            chat."userId" = ${userId}
            OR EXISTS (
              SELECT 1
              FROM "ProjectGrant" AS project_grant
              WHERE project_grant."projectId" = chat."projectId"
                AND (
                  project_grant."userId" = ${userId}
                  OR EXISTS (
                    SELECT 1
                    FROM "UserGroup" AS membership
                    INNER JOIN "Group" AS member_group
                      ON member_group."id" = membership."groupId"
                    WHERE membership."userId" = ${userId}
                      AND membership."groupId" = project_grant."groupId"
                      AND member_group."archivedAt" IS NULL
                  )
                )
            )
          )
          AND chat."archived" = false
          AND chat."permanentDeletionAt" IS NULL
          ${expectedLeafPredicate}
      ),
      "ancestor_path" AS (
        SELECT
          message."chatId",
          message."content",
          message."groundedAt",
          message."id",
          message."parentMessageId",
          message."role",
          message."status"::text AS "status",
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
          parent."groundedAt",
          parent."id",
          parent."parentMessageId",
          parent."role",
          parent."status"::text AS "status",
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
        path."groundedAt" AS "messageGroundedAt",
        path."id" AS "messageId",
        path."parentMessageId" AS "messageParentId",
        path."role" AS "messageRole",
        path."status" AS "messageStatus"
      FROM "selected_chat" AS chat
      LEFT JOIN "ancestor_path" AS path ON true
      ORDER BY path."depth" DESC NULLS LAST
    `);

    return {
      chatMatched: rows.length > 0,
      messages: conversationMessagesFromPathRows(rows)
    };
  }

  async function loadProjectRunAdmission(
    projectId: string,
    userId: string
  ): Promise<ProjectRunAdmission | null> {
    const access = await resolveProjectAccess(prismaClient, {
      minimumRole: "CONTRIBUTOR",
      projectId,
      requireActive: true,
      userId
    });
    if (!access) return null;
    const project = await prismaClient.project.findUnique({
      include: {
        assistantBindings: { select: { assistantId: true, revisionId: true } },
        knowledgeBaseBindings: { select: { knowledgeBaseId: true } },
        mcpBindings: { select: { serverId: true } },
        modelBindings: { select: { providerModelId: true } },
        searchBindings: { include: { searchOption: { select: { id: true, optionId: true } } } },
        skillBindings: { select: { skillId: true } }
      },
      where: { id: projectId }
    });
    if (!project || project.status !== "ACTIVE") return null;
    const defaults = decodeProjectDefaults(project.defaults);
    const policy = decodeProjectPolicy(project.policy);
    if (!defaults.ok || !policy.ok) return null;
    return {
      accessRevision: access.accessRevision,
      assistantBindings: project.assistantBindings,
      defaults: defaults.defaults,
      instructions: project.instructions,
      instructionsRevision: access.instructionsRevision,
      knowledgeBaseIds: project.knowledgeBaseBindings.map(({ knowledgeBaseId }) => knowledgeBaseId),
      mcpServerIds: project.mcpBindings.map(({ serverId }) => serverId),
      // Project Memory remains persisted and manageable through its existing
      // control plane, but Personal Memory v1 deliberately makes it dormant
      // for newly admitted Project runs. Do not load any fact text here.
      memoryEnabled: false,
      memoryItems: [],
      memoryRevision: access.memoryRevision,
      modelIds: project.modelBindings.map(({ providerModelId }) => providerModelId),
      policy: policy.policy,
      policyRevision: access.policyRevision,
      projectId,
      executionScope: "project",
      role: access.effectiveRole,
      searchOptionIds: project.searchBindings.flatMap(({ searchOption }) =>
        [searchOption.id, searchOption.optionId]
      ),
      skillIds: project.skillBindings.map(({ skillId }) => skillId)
    };
  }

  async function loadInternalRunControl(runId: string) {
    const run = await prismaClient.modelRun.findFirst({
      select: {
        assistantMessageId: true,
        chatId: true,
        errorPayload: true,
        id: true,
        modelId: true,
        projectRunBinding: {
          select: {
            accessRevision: true,
            instructionsRevision: true,
            memoryRevision: true,
            policyRevision: true,
            projectId: true,
            providerAdmissionFingerprint: true,
            providerConnectionId: true,
            providerModelId: true,
            providerRequiresClientTools: true,
            providerSearchPlan: true
          }
        },
        provider: true,
        providerResponseId: true,
        status: true
      },
      where: { id: runId }
    });
    if (!run) return null;
    let project;
    let projectRecoveryInvalid = false;
    if (run.projectRunBinding) {
      try {
        project = projectRunRecoveryAuthority(run.projectRunBinding);
      } catch {
        projectRecoveryInvalid = true;
      }
    }
    return {
      assistantMessageId: run.assistantMessageId,
      chatId: run.chatId,
      id: run.id,
      modelId: run.modelId,
      ...(project ? { project } : {}),
      ...(projectRecoveryInvalid ? { projectRecoveryInvalid: true as const } : {}),
      provider: run.provider,
      providerResponseId: run.providerResponseId,
      recoverySettled: isRecoveredRunTerminalPayload(run.errorPayload),
      status: run.status
    };
  }

  return {
    groundKnowledgeAnswer: (input) => groundKnowledgeRunAnswer(prismaClient, input),
    groundKnowledgeAnswerV5: (input) => groundKnowledgeRunAnswerV5(prismaClient, input),
    loadKnowledgeFullContextDispatchRecovery: (input) =>
      loadKnowledgeFullContextDispatchRecovery(prismaClient, input),
    admitPreparingRun: (input) =>
      admitPreparingRunWithClient(prismaClient, input, memorySourceHooks),
    beginPreparingRunAttempt: (input) =>
      beginPreparingRunAttemptWithClient(prismaClient, input),
    completePreparingRunAttempt: (input) =>
      completePreparingRunAttemptWithClient(prismaClient, input),
    finalizePreparingRun: (input) =>
      finalizePreparingRunWithClient(prismaClient, input, memoryExecutionAuthority),
    recoverPreparingRun: (input) =>
      recoverPreparingRunWithClient(prismaClient, input, memorySourceHooks),
    retryPreparingRunAttempt: (input) =>
      retryPreparingRunAttemptWithClient(prismaClient, input),
    settlePreparingRunFailure: (input) =>
      settlePreparingRunFailureWithClient(prismaClient, input, memorySourceHooks),
    ...mcpDiscoveryOperations,
    ...toolLoopOperations,
    sweepBootOrphanedRuns: async ({ createdBefore, liveRunIds }) => {
      const liveRunIdFilter = unique(liveRunIds);
      const payload = {
        code: "run_orphaned_on_boot",
        message: "Run was active when this server process started and was marked failed."
      };

      return prismaClient.$transaction(async (tx) => {
        const runs = await tx.modelRun.findMany({
          select: {
            assistantMessageId: true,
            chatId: true,
            id: true,
            status: true,
            userId: true
          },
          where: {
            createdAt: {
              lt: createdBefore
            },
            ...(liveRunIdFilter.length > 0
              ? {
                  id: {
                    notIn: liveRunIdFilter
                  }
                }
              : {}),
            status: {
              in: activeModelRunStatuses
            },
            // Project-bound runs require their accepted recovery authority to
            // be checked by the installation reconciler before they settle.
            // The generic boot orphan sweep cannot make that authorization
            // decision and must not mask it with run_orphaned_on_boot.
            projectRunBinding: null,
            providerResponseId: null,
            toolLoopState: { equals: Prisma.DbNull }
          }
        });

        if (runs.length === 0) {
          return 0;
        }

        let preparedSettled = 0;
        let dispatchableSettled = 0;
        for (const run of runs) {
          if (run.status === "preparing") {
            if (await settlePreparingRunInTransaction(tx, {
              errorCode: payload.code,
              message: payload.message,
              runId: run.id,
              state: "FAILED",
              userId: run.userId
            }, memorySourceHooks)) preparedSettled += 1;
            continue;
          }
          const updated = await tx.modelRun.updateMany({
            data: {
              errorPayload: json(payload),
              status: "error"
            },
            where: {
              id: run.id,
              providerResponseId: null,
              status: { in: dispatchableModelRunStatuses },
              toolLoopState: { equals: Prisma.DbNull }
            }
          });
          if (updated.count !== 1) continue;
          if (run.assistantMessageId) {
            await tx.message.updateMany({
              data: {
                errorMessage: payload.message,
                status: "error"
              },
              where: {
                id: run.assistantMessageId,
                status: { in: activeMessageStatuses }
              }
            });
          }
          await settleTerminalMemorySource(tx, {
            assistantMessageId: run.assistantMessageId,
            chatId: run.chatId,
            runId: run.id,
            status: "error",
            userId: run.userId
          }, memorySourceHooks);
          dispatchableSettled += 1;
        }

        return preparedSettled + dispatchableSettled;
      });
    },
    cancelRun: async (input) => {
      return prismaClient.$transaction(async (tx) => {
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
      });
    },
    completeRun: async (input) => {
      const usage = normalizeTokenUsage(input.usage);
      const usageAttributions = (
        input.usageAttributions?.length
          ? input.usageAttributions
          : [
              {
                estimatedCostMicros: input.estimatedCostMicros,
                modelId: input.modelId,
                provider: input.provider,
                usage
              }
            ]
      ).map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));

      return prismaClient.$transaction(async (tx) => {
        const [existingRun] = await tx.$queryRaw<
          Array<{
            assistantMessageId: string | null;
            chatId: string;
            projectId: string | null;
            errorPayload: Prisma.JsonValue | null;
            modelId: string;
            provider: string;
            providerResponseId: string | null;
            status: ModelRunStatus;
            userId: string;
          }>
        >(Prisma.sql`
          SELECT
            run."assistantMessageId",
            run."chatId",
            chat."projectId" AS "projectId",
            run."errorPayload",
            run."modelId",
            run."provider",
            run."providerResponseId",
            run."status",
            run."userId"
          FROM "ModelRun" AS run
          INNER JOIN "Chat" AS chat ON chat."id" = run."chatId"
          WHERE run."id" = ${input.runId}
            AND run."userId" = ${input.userId}
          FOR UPDATE OF run
        `);
        const activeCompletion = Boolean(
          existingRun && dispatchableModelRunStatuses.includes(existingRun.status)
        );
        const recoveredCompletion = Boolean(
          existingRun &&
            existingRun.status === "error" &&
            existingRun.providerResponseId === (input.providerResponseId ?? null) &&
            !isRecoveredRunTerminalPayload(existingRun.errorPayload)
        );
        if (
          !existingRun ||
          (!activeCompletion && !recoveredCompletion) ||
          existingRun.assistantMessageId !== input.assistantMessageId ||
          existingRun.chatId !== input.chatId ||
          existingRun.modelId !== input.modelId ||
          existingRun.provider !== input.provider
        ) {
          return false;
        }

        const assistantMessage = await tx.message.findUnique({
          select: { groundedAt: true },
          where: { id: input.assistantMessageId }
        });
        const groundedLiveOnly = Boolean(assistantMessage?.groundedAt);

        await tx.modelRun.update({
          data: {
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            errorPayload: Prisma.JsonNull,
            estimatedCostMicros: input.estimatedCostMicros ?? 0,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            providerResponseId: input.providerResponseId ?? existingRun?.providerResponseId ?? null,
            reasoningTokens: usage.reasoningTokens,
            status: "complete",
            totalTokens: usage.totalTokens
          },
          where: {
            id: input.runId
          }
        });

        if (input.knowledgeGrounding) {
          await settleKnowledgeGrounding(tx, input.knowledgeGrounding);
        }

        await tx.message.updateMany({
          data: {
            content: json(
              groundedLiveOnly ? groundedLiveOnlyMessageContent() : textMessageContent(input.finalText)
            ),
            errorMessage: null,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            status: "complete"
          },
          where: {
            id: input.assistantMessageId,
            OR: [
              {
                status: {
                  in: activeMessageStatuses
                }
              },
              {
                status: "error"
              }
            ]
          }
        });
        await settleTerminalMemorySource(tx, {
          assistantMessageId: input.assistantMessageId,
          chatId: input.chatId,
          runId: input.runId,
          status: "complete",
          userId: input.userId
        }, memorySourceHooks);
        await tx.usageEvent.deleteMany({
          where: {
            modelRunId: input.runId
          }
        });
        await tx.usageEvent.createMany({
          data: usageAttributions.map((attribution) => ({
            chatId: input.chatId,
            cachedInputTokens: attribution.usage.cachedInputTokens,
            cacheWriteInputTokens: attribution.usage.cacheWriteInputTokens,
            estimatedCostMicros: attribution.estimatedCostMicros ?? 0,
            inputTokens: attribution.usage.inputTokens,
            modelId: attribution.modelId,
            modelRunId: input.runId,
            outputTokens: attribution.usage.outputTokens,
            provider: attribution.provider,
            reasoningTokens: attribution.usage.reasoningTokens,
            totalTokens: attribution.usage.totalTokens,
            ...(existingRun.projectId ? { projectId: existingRun.projectId } : {}),
            userId: input.userId
          }))
        });
        await tx.chat.update({
          data: {
            totalInputTokens: {
              increment: usage.inputTokens
            },
            totalOutputTokens: {
              increment: usage.outputTokens
            },
            totalReasoningTokens: {
              increment: usage.reasoningTokens
            }
          },
          where: {
            id: input.chatId
          }
        });
        if (!groundedLiveOnly) {
          await appendRunOutputEvents(tx, input.runId, input.outputEvents ?? []);
        }
        return true;
      });
    },
    createRun: async (input) => {
      const memoryAdmissionDeadlineMs = input.project
        ? MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS
        : await loadMemoryAdmissionDeadlineMs();
      const created = await createDormantPreparingRun(prismaClient, {
        ...input,
        admissionKind: "NORMAL_SEND"
      }, memoryRetrieval, memoryExecutionAuthority, memorySourceHooks,
        memoryAdmissionDeadlineMs);
      return {
        assistantMessageId: created.assistantMessageId,
        ...(created.materializedRequest
          ? { materializedRequest: created.materializedRequest }
          : {}),
        runId: created.runId,
        userMessageId: created.userMessageId
      };
    },
    createRegenerationRun: async (input) => {
      const memoryAdmissionDeadlineMs = input.project
        ? MEMORY_ADMISSION_DEFAULT_TIMEOUT_MS
        : await loadMemoryAdmissionDeadlineMs();
      const created = await createDormantPreparingRun(prismaClient, {
        ...input,
        admissionKind: "REGENERATE"
      }, memoryRetrieval, memoryExecutionAuthority, memorySourceHooks,
        memoryAdmissionDeadlineMs);
      return {
        assistantMessageId: created.assistantMessageId,
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
        });
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
        });
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
      });
    },
    failRun: async (runId, assistantMessageId, error, options) => {
      return prismaClient.$transaction(async (tx) => {
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
        const assistantMessage = await tx.message.findUnique({
          select: { groundedAt: true },
          where: { id: assistantMessageId }
        });
        const groundedLiveOnly = Boolean(assistantMessage?.groundedAt);
        const durableError = groundedLiveOnly
          ? { code: error.code, message: "Grounded live-only run failed." }
          : error;
        const updatedCount = lockedRun.status === "preparing"
          ? Number(await settlePreparingRunInTransaction(tx, {
              errorCode: durableError.code,
              message: durableError.message,
              runId,
              state: "FAILED",
              userId: lockedRun.userId
            }, memorySourceHooks))
          : (await tx.modelRun.updateMany({
              data: {
                errorPayload: json(
                  options?.recoveryTerminal
                    ? recoveredRunErrorPayload(durableError)
                    : durableError
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

        if (groundedLiveOnly) {
          await tx.modelRunEvent.deleteMany({
            where: { modelRunId: runId }
          });
        }

        await tx.message.updateMany({
          data: {
            ...(groundedLiveOnly
              ? { content: json(groundedLiveOnlyMessageContent()) }
              : {}),
            errorMessage: durableError.message,
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
      });
    },
    findOwnedChat: async (chatId, userId) => {
      const chat = await prismaClient.chat.findFirst({
        select: {
          _count: { select: { messages: true } },
          activeLeafMessageId: true,
          defaultKnowledgePlan: true,
          defaultProviderModel: { select: { connectionId: true, id: true } },
          folder: { select: { defaultKnowledgePlan: true, projectMemory: true } },
          id: true,
          memoryMode: true,
          projectFolderId: true,
          projectId: true,
          title: true
        },
        where: {
          archived: false,
          id: chatId,
          permanentDeletionAt: null,
          OR: [
            { userId },
            { projectId: { not: null } }
          ]
        }
      });
      if (!chat) return null;
      const project = chat.projectId
        ? await loadProjectRunAdmission(chat.projectId, userId)
        : null;
      if (chat.projectId && !project) return null;
      return {
        activeLeafMessageId: chat.activeLeafMessageId,
        defaultKnowledgePlan: chat.defaultKnowledgePlan,
        defaultModelId: chat.defaultProviderModel?.id ?? "",
        defaultProvider: chat.defaultProviderModel?.connectionId ?? "",
        folderDefaultKnowledgePlan: chat.folder?.defaultKnowledgePlan ?? null,
        id: chat.id,
        memoryMode: chat.memoryMode,
        messageCount: chat._count.messages,
        projectFolderId: chat.projectFolderId,
        projectMemory: chat.folder?.projectMemory ?? null,
        ...(project ? { project } : {}),
        title: chat.title
      };
    },
    loadProjectFirstSend: async ({ chatId, folderId, projectId, userId }) => {
      const [existing, project] = await Promise.all([
        prismaClient.chat.findUnique({ select: { id: true }, where: { id: chatId } }),
        loadProjectRunAdmission(projectId, userId)
      ]);
      if (existing || !project) return null;
      if (folderId) {
        const folder = await prismaClient.projectFolder.findUnique({
          select: { id: true },
          where: { projectId_id: { id: folderId, projectId } }
        });
        if (!folder) return null;
      }
      const defaultModelId = project.defaults.providerModelId;
      const model = defaultModelId && project.modelIds.includes(defaultModelId)
        ? await prismaClient.providerModel.findUnique({
            select: { connectionId: true, id: true },
            where: { id: defaultModelId }
          })
        : null;
      return {
        activeLeafMessageId: null,
        defaultKnowledgePlan: project.defaults.knowledgePlan,
        defaultModelId: model?.id ?? "",
        defaultProvider: model?.connectionId ?? "",
        folderDefaultKnowledgePlan: null,
        id: chatId,
        memoryMode: "EXCLUDED",
        messageCount: 0,
        project,
        projectFolderId: folderId,
        projectMemory: null,
        title: "New Chat"
      };
    },
    findRecentActiveRunForChat: async ({ chatId, since, userId }) => {
      const chat = await prismaClient.chat.findUnique({ select: { projectId: true, userId: true }, where: { id: chatId } });
      const access = chat?.projectId
        ? await resolveProjectAccess(prismaClient, {
            projectId: chat.projectId,
            requireActive: true,
            userId
          })
        : null;
      if (!chat || (chat.userId !== userId && (!chat.projectId || !access))) return null;
      return prismaClient.modelRun.findFirst({
        select: {
          assistantMessageId: true, chatId: true, id: true, modelId: true,
          provider: true, providerResponseId: true, status: true
        },
        orderBy: { updatedAt: "desc" },
        where: { chatId, status: { in: activeModelRunStatuses }, updatedAt: { gt: since } }
      });
    },
    findStaleActiveRunsForUser: (input) =>
      prismaClient.modelRun.findMany({
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true,
          updatedAt: true
        },
        where: {
          ...(input.chatId ? { chatId: input.chatId } : {}),
          ...(input.runId ? { id: input.runId } : {}),
          userId: input.userId,
          status: {
            in: activeModelRunStatuses
          },
          updatedAt: {
            lt: input.staleBefore
          }
        }
      }),
    findInstallationRecoverableRuns: (input) =>
      prismaClient.modelRun.findMany({
        orderBy: { updatedAt: "asc" },
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true,
          updatedAt: true,
          userId: true
        },
        take: input.limit,
        where: {
          OR: [
            {
              createdAt: { lt: input.bootedBefore },
              OR: [
                { providerResponseId: { not: null } },
                { toolLoopState: { not: Prisma.DbNull } }
              ]
            },
            { updatedAt: { lt: input.staleBefore } }
          ],
          status: { in: activeModelRunStatuses }
        }
      }),
    findRegenerationSource: async (sourceMessageId, userId) => {
      const sourceMessage = await prismaClient.message.findFirst({
        include: {
          chat: {
            select: {
              defaultKnowledgePlan: true,
              defaultProviderModel: {
                select: {
                  connectionId: true,
                  id: true
                }
              },
              folder: {
                select: {
                  defaultKnowledgePlan: true,
                  projectMemory: true
                }
              },
              id: true,
              memoryMode: true,
              projectId: true
            }
          },
          parent: {
            select: {
              content: true,
              id: true,
              role: true
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
      });

      if (!sourceMessage) {
        return null;
      }

      const access = await resolveChatAccess(prismaClient, {
        chatId: sourceMessage.chat.id,
        minimumProjectRole: "CONTRIBUTOR",
        requireMutable: true,
        userId
      });
      if (!access) return null;
      const project = sourceMessage.chat.projectId
        ? await loadProjectRunAdmission(sourceMessage.chat.projectId, userId)
        : null;
      if (sourceMessage.chat.projectId && !project) return null;

      const chat = {
        defaultKnowledgePlan: sourceMessage.chat.defaultKnowledgePlan,
        defaultModelId: sourceMessage.chat.defaultProviderModel?.id ?? "",
        defaultProvider: sourceMessage.chat.defaultProviderModel?.connectionId ?? "",
        folderDefaultKnowledgePlan: sourceMessage.chat.folder?.defaultKnowledgePlan ?? null,
        id: sourceMessage.chat.id,
        memoryMode: sourceMessage.chat.memoryMode,
        projectMemory: sourceMessage.chat.folder?.projectMemory ?? null,
        ...(project ? { project } : {})
      };

      if (sourceMessage.role === "user") {
        return {
          assistantMessage: null,
          chat,
          userMessage: {
            content: sourceMessage.content,
            id: sourceMessage.id
          }
        };
      }

      if (!sourceMessage.parent || sourceMessage.parent.role !== "user") {
        return null;
      }

      const sourceRun = await prismaClient.modelRun.findFirst({
        orderBy: { createdAt: "desc" },
        select: {
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
          ...(sourceMessage.chat.projectId ? {} : { userId })
        }
      });
      const answerBinding = sourceRun?.providerRunBindings[0];

      return {
        assistantMessage: {
          id: sourceMessage.id,
          modelId: answerBinding?.providerModelId ?? null,
          provider: answerBinding?.connectionId ?? null
        },
        chat,
        userMessage: {
          content: sourceMessage.parent.content,
          id: sourceMessage.parent.id
        }
      };
    },
    getRunControlForUser: async (runId, userId) => {
      const control = await loadInternalRunControl(runId);
      if (control) {
        const chat = await prismaClient.chat.findUnique({ select: { projectId: true, userId: true }, where: { id: control.chatId } });
        const projectAccess = chat?.projectId
          ? await resolveProjectAccess(prismaClient, { projectId: chat.projectId, userId })
          : null;
        if (chat?.userId !== userId && !projectAccess) return null;
      }
      return control;
    },
    getRunControlForRecovery: loadInternalRunControl,
    isProjectRunAccessCurrent: async ({
      accessRevision,
      instructionsRevision,
      memoryRevision,
      policyRevision,
      projectId,
      userId
    }) => {
      const access = await resolveProjectAccess(prismaClient, {
        minimumRole: "CONTRIBUTOR",
        projectId,
        requireActive: true,
        userId
      });
      return access?.accessRevision === accessRevision &&
        access.instructionsRevision === instructionsRevision &&
        access.memoryRevision === memoryRevision &&
        access.policyRevision === policyRevision;
    },
    getRunOutcomeForUser: async (runId, userId) => {
      const run = await prismaClient.modelRun.findFirst({
        select: {
          chatId: true,
          id: true,
          status: true
        },
        where: { id: runId }
      });
      if (run) {
        const chat = await prismaClient.chat.findUnique({ select: { projectId: true, userId: true }, where: { id: run.chatId } });
        const projectAccess = chat?.projectId
          ? await resolveProjectAccess(prismaClient, { projectId: chat.projectId, userId })
          : null;
        if (chat?.userId !== userId && !projectAccess) return null;
      }

      return run
        ? {
            id: run.id,
            status: acceptedRunStatus(run.status)
          }
        : null;
    },
    getChatUpdateForRun: async ({ assistantMessageId, chatId, userId, userMessageId }) => {
      return prismaClient.$transaction(async (tx) => {
        const access = await resolveChatAccess(tx, { chatId, userId });
        if (!access) return null;
        const chat = await tx.chat.findFirst({
        select: {
          _count: {
            select: {
              messages: true
            }
          },
          activeLeafMessageId: true,
          createdAt: true,
          defaultKnowledgePlan: true,
          defaultProviderModel: {
            select: {
              connectionId: true,
              id: true
            }
          },
          folderId: true,
          id: true,
          memoryMode: true,
          projectFolderId: true,
          projectId: true,
          messages: {
            include: {
              assistantModelRuns: {
                orderBy: {
                  createdAt: "desc"
                },
                select: {
                  assistantId: true,
                  assistantMessageId: true,
                  assistantRevision: {
                    select: {
                      avatar: true,
                      name: true,
                      revisionNumber: true
                    }
                  },
                  events: {
                    orderBy: {
                      sequence: "asc"
                    },
                    select: {
                      payload: true
                    },
                    where: {
                      eventType: "artifact"
                    }
                  },
                  errorPayload: true,
                  id: true,
                  knowledgeRuns: {
                    orderBy: { invocationOrdinal: "asc" },
                    select: {
                      invocationOrdinal: true,
                      outcome: true,
                      results: true
                    }
                  },
                  knowledgeRetrievalSession: {
                    select: {
                      degradedFlags: true,
                      evidenceItems: {
                        orderBy: { ordinal: "asc" },
                        select: { handle: true, state: true }
                      },
                      groundingResult: { select: { outcome: true } }
                    }
                  },
                  searchRuns: {
                    orderBy: {
                      createdAt: "asc"
                    },
                    select: {
                      artifacts: true
                    }
                  },
                  normalizedRequest: true,
                  status: true,
                  toolCalls: {
                    orderBy: [{ roundIndex: "asc" }, { ordinal: "asc" }],
                    select: {
                      completedAt: true,
                      ordinal: true,
                      roundIndex: true,
                      startedAt: true,
                      state: true,
                      toolName: true
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
          updatedAt: true
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
          chat.projectId ? Promise.resolve(new Map<string, never>()) : loadMemoryRunActions(tx, { runIds, userId }),
          chat.projectId ? Promise.resolve(new Map<string, never>()) : loadMemoryRunSources(tx, { runIds, userId }),
          chat.projectId
            ? Promise.resolve(new Map<string, never>())
            : loadMemoryRunPresentationStatuses(tx, { runIds, userId })
        ]);

        return {
          chat: {
            activeLeafMessageId: chat.activeLeafMessageId,
            contextStats,
            createdAt: chat.createdAt,
            defaultKnowledgePlan: knowledgeDefaultFromJson(chat.defaultKnowledgePlan),
            defaultModelId: chat.defaultProviderModel?.id ?? null,
            defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
            folderId: chat.projectFolderId ?? chat.folderId,
            id: chat.id,
            messageCount: chat._count.messages,
            pinned: chat.pinned,
            projectId: chat.projectId,
            title: chat.title,
            updatedAt: chat.updatedAt,
            usageStats
          },
          messages: chat.messages.map((message) => {
            const modelRun = message.assistantModelRuns[0];

            return {
              artifactSummary: modelRun
                ? summarizeMessageRunArtifacts(
                    modelRun,
                    message.content,
                    memoryActionsByRun.get(modelRun.id) ?? null,
                    memorySourcesByRun.get(modelRun.id) ?? [],
                    memoryStatusesByRun.get(modelRun.id)
                  )
                : null,
              assistantIdentity: serializeRunAssistantIdentity(modelRun),
              author: message.authorDisplayName && message.authorProjectRole
                ? {
                    displayName: message.authorDisplayName,
                    role: message.authorProjectRole,
                    userId: message.authorUserId
                  }
                : null,
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
              toolActivity: modelRun ? summarizeMessageRunToolActivity(modelRun) : null
            };
          })
        };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    },
    isSearchStrategyEnabled: async (searchOptionId) => {
      const option = await prismaClient.searchOption.findFirst({
        select: { id: true },
        where: {
          archivedAt: null,
          enabled: true,
          optionId: searchOptionId,
          strategies: {
            some: {
              activeRevisionId: { not: null },
              archivedAt: null,
              enabled: true
            }
          }
        }
      });

      return Boolean(option);
    },
    loadConversationContext: async (chatId, userId) => {
      const context = await loadConversationPath(chatId, userId, { kind: "active" });
      return context.messages;
    },
    loadConversationContextForExpectedLeaf: async (
      chatId,
      userId,
      expectedActiveLeafMessageId
    ) => {
      const context = await loadConversationPath(chatId, userId, {
        kind: "expected",
        leafMessageId: expectedActiveLeafMessageId
      });
      return context.chatMatched ? context.messages : null;
    },
    loadConversationContextForLeaf: async (chatId, userId, leafMessageId) => {
      const context = await loadConversationPath(chatId, userId, {
        kind: "explicit",
        leafMessageId
      });
      return context.messages;
    },
    loadAttachments: async (userId, attachmentIds, projectId) => {
      if (attachmentIds.length === 0) {
        return [];
      }

      const attachments = await prismaClient.attachment.findMany({
        where: {
          id: {
            in: attachmentIds
          },
          ...(projectId ? { projectId } : { userId })
        }
      });

      return attachments.map(
        (attachment): RunAttachmentRecord => ({
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
    loadKnowledgeFullContextPassages: async (sources) => {
      if (sources.length < 1) return null;
      const baseIds = [...new Set(sources.flatMap((source) =>
        source.authority.knowledgeBaseIds.slice(0, 1)))];
      const [artifacts, bases] = await Promise.all([
        prismaClient.knowledgeSourceIndexArtifact.findMany({
          select: {
            hierarchicalIndexes: {
              orderBy: { schemaVersion: "desc" },
              select: {
                passageIndexes: {
                  orderBy: { ordinal: "asc" },
                  select: {
                    contentHash: true,
                    documentContext: true,
                    headingPath: true,
                    id: true,
                    ordinal: true,
                    page: true,
                    pageEnd: true,
                    sectionId: true,
                    text: true,
                    tokenCount: true
                  }
                },
                passageCount: true
              },
              take: 1,
              where: { state: "ready" }
            },
            id: true,
            sourceVersionId: true,
            state: true
          },
          where: { id: { in: sources.map((source) => source.sourceArtifactId) } }
        }),
        baseIds.length > 0
          ? prismaClient.knowledgeBase.findMany({
              select: { id: true, name: true },
              where: { id: { in: baseIds } }
            })
          : []
      ]);
      const artifactById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
      const baseNameById = new Map(bases.map((base) => [base.id, base.name]));
      const passages: KnowledgeFullContextPassage[] = [];
      for (const source of sources) {
        const artifact = artifactById.get(source.sourceArtifactId);
        const hierarchy = artifact?.hierarchicalIndexes[0];
        const baseId = source.authority.knowledgeBaseIds[0];
        const baseName = baseId ? baseNameById.get(baseId) : "Direct source";
        if (!artifact || artifact.state !== "ready" ||
          artifact.sourceVersionId !== source.sourceVersionId || !hierarchy || !baseName ||
          hierarchy.passageCount !== source.passageCount ||
          hierarchy.passageIndexes.length !== source.passageCount) return null;
        for (const passage of hierarchy.passageIndexes) {
          const documentContext = passage.documentContext === null
            ? null
            : decodeKnowledgeDocumentContext(passage.documentContext);
          if (passage.documentContext !== null && !documentContext) return null;
          passages.push({
            baseName,
            contentHash: passage.contentHash,
            documentContext,
            headingPath: [...passage.headingPath],
            page: passage.page,
            pageEnd: passage.pageEnd,
            passageId: passage.id,
            passageOrdinal: passage.ordinal,
            sectionId: passage.sectionId,
            sourceArtifactId: source.sourceArtifactId,
            sourceId: source.sourceId,
            sourceOrdinal: source.ordinal,
            sourceVersionId: source.sourceVersionId,
            sourceVersionNumber: source.sourceVersionNumber,
            text: passage.text,
            tokenCount: passage.tokenCount
          });
        }
      }
      return passages;
    },
    loadEntitlements: (userId) => loadEntitlementsForUser(userId),
    loadModelPricing: async (provider, modelId) => {
      const models = await prismaClient.providerModel.findMany({
        select: {
          inputTokenPriceMicros: true,
          outputTokenPriceMicros: true
        },
        take: 2,
        where: { modelClass: "answer", modelId, provider }
      });

      return models.length === 1
        ? {
            inputTokenPriceMicros: models[0].inputTokenPriceMicros,
            outputTokenPriceMicros: models[0].outputTokenPriceMicros
          }
        : null;
    },
    loadRunUsageAttributions: async (input) => {
      const rows = await prismaClient.usageEvent.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          createdAt: true,
          estimatedCostMicros: true,
          inputTokens: true,
          modelId: true,
          outputTokens: true,
          provider: true,
          reasoningTokens: true,
          totalTokens: true
        },
        where: { modelRunId: input.runId, userId: input.userId }
      });
      return rows.map((row) => ({
        estimatedCostMicros: row.estimatedCostMicros,
        modelId: row.modelId,
        provider: row.provider,
        recordedAt: row.createdAt.toISOString(),
        usage: {
          cachedInputTokens: row.cachedInputTokens ?? 0,
          cacheWriteInputTokens: row.cacheWriteInputTokens ?? 0,
          inputTokens: row.inputTokens ?? 0,
          outputTokens: row.outputTokens ?? 0,
          reasoningTokens: row.reasoningTokens ?? 0,
          totalTokens: row.totalTokens ?? 0
        }
      }));
    },
    markAssistantMessageGroundedLiveOnly: async (input) => {
      const provider = input.provider.trim().slice(0, 128);
      const strategy = input.strategy.trim().slice(0, 128);
      if (provider !== "gemini" || strategy !== "gemini-google-search") return false;

      return prismaClient.$transaction(async (tx) => {
        const run = await tx.modelRun.findUnique({
          select: { assistantMessageId: true, status: true },
          where: { id: input.runId }
        });
        if (
          run?.assistantMessageId !== input.assistantMessageId ||
          !dispatchableModelRunStatuses.includes(run.status)
        ) return false;

        const updated = await tx.message.updateMany({
          data: {
            content: json(groundedLiveOnlyMessageContent()),
            groundedAt: input.groundedAt,
            groundingProvider: provider,
            groundingStrategy: strategy
          },
          where: { id: input.assistantMessageId }
        });
        if (updated.count !== 1) return false;

        await tx.modelRunEvent.deleteMany({
          where: { modelRunId: input.runId }
        });
        await tx.modelRun.update({
          data: { updatedAt: new Date() },
          where: { id: input.runId }
        });
        return true;
      });
    },
  };
}
