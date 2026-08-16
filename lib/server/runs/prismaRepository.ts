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
  summarizeMessageRunArtifacts
} from "../chats/prismaRepository";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { prisma } from "../prisma";
import type { ProviderConversationMessage } from "../providers/types";
import {
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
import type { MemorySourceMutationHooks } from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
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
  runControlRecord,
  unique
} from "./prismaRepositoryShared";
import {
  appendRunOutputEvents,
  createPrismaRunToolLoopOperations,
  isRecoveredRunTerminalPayload,
  recoveredRunErrorPayload
} from "./prismaRepositoryToolLoop";
import { createPrismaMcpDiscoveryOperations } from "./prismaRepositoryMcpDiscovery";

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
  async function loadConversationPath(
    chatId: string,
    userId: string,
    selector: ConversationPathSelector
  ): Promise<{ chatMatched: boolean; messages: ProviderConversationMessage[] }> {
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

  return {
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

        await tx.modelRunToolCall.updateMany({
          data: {
            completedAt: new Date(),
            state: "cancelled"
          },
          where: {
            modelRunId: input.runId,
            state: "pending"
          }
        });

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
            errorPayload: Prisma.JsonValue | null;
            modelId: string;
            provider: string;
            providerResponseId: string | null;
            status: ModelRunStatus;
            userId: string;
          }>
        >(Prisma.sql`
          SELECT
            "assistantMessageId",
            "chatId",
            "errorPayload",
            "modelId",
            "provider",
            "providerResponseId",
            "status",
            "userId"
          FROM "ModelRun"
          WHERE "id" = ${input.runId}
            AND "userId" = ${input.userId}
          FOR UPDATE
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
      const created = await createDormantPreparingRun(prismaClient, {
        ...input,
        admissionKind: "NORMAL_SEND"
      }, memoryRetrieval, memoryExecutionAuthority, memorySourceHooks);
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
      const created = await createDormantPreparingRun(prismaClient, {
        ...input,
        admissionKind: "REGENERATE"
      }, memoryRetrieval, memoryExecutionAuthority, memorySourceHooks);
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

        await tx.modelRunToolCall.updateMany({
          data: {
            completedAt: new Date(),
            state: "cancelled"
          },
          where: {
            modelRunId: runId,
            state: "pending"
          }
        });

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
    findOwnedChat: (chatId, userId) =>
	      prismaClient.chat.findFirst({
	        select: {
	          _count: {
	            select: {
	              messages: true
	            }
	          },
	          activeLeafMessageId: true,
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
	          title: true
	        },
        where: {
          archived: false,
          id: chatId,
          permanentDeletionAt: null,
          userId
        }
      }).then((chat) =>
        chat
	          ? {
	              activeLeafMessageId: chat.activeLeafMessageId,
	              defaultKnowledgePlan: chat.defaultKnowledgePlan,
	              defaultModelId: chat.defaultProviderModel?.id ?? "",
	              defaultProvider: chat.defaultProviderModel?.connectionId ?? "",
	              folderDefaultKnowledgePlan: chat.folder?.defaultKnowledgePlan ?? null,
	              id: chat.id,
	              memoryMode: chat.memoryMode,
	              messageCount: chat._count.messages,
	              projectMemory: chat.folder?.projectMemory ?? null,
	              title: chat.title
	            }
          : null
      ),
    findRecentActiveRunForChat: ({ chatId, since, userId }) =>
      prismaClient.modelRun.findFirst({
        select: {
          assistantMessageId: true,
          chatId: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true
        },
        orderBy: {
          updatedAt: "desc"
        },
        where: {
          chatId,
          userId,
          status: {
            in: activeModelRunStatuses
          },
          updatedAt: {
            gt: since
          }
        }
      }),
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
              memoryMode: true
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
            permanentDeletionAt: null,
            userId
          },
          id: sourceMessageId,
          role: { in: ["assistant", "user"] }
        }
      });

      if (!sourceMessage) {
        return null;
      }

      const chat = {
        defaultKnowledgePlan: sourceMessage.chat.defaultKnowledgePlan,
        defaultModelId: sourceMessage.chat.defaultProviderModel?.id ?? "",
        defaultProvider: sourceMessage.chat.defaultProviderModel?.connectionId ?? "",
        folderDefaultKnowledgePlan: sourceMessage.chat.folder?.defaultKnowledgePlan ?? null,
        id: sourceMessage.chat.id,
        memoryMode: sourceMessage.chat.memoryMode,
        projectMemory: sourceMessage.chat.folder?.projectMemory ?? null
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
          userId
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
      const run = await prismaClient.modelRun.findFirst({
        select: {
          assistantMessageId: true,
          chatId: true,
          errorPayload: true,
          id: true,
          modelId: true,
          provider: true,
          providerResponseId: true,
          status: true
        },
        where: {
          id: runId,
          userId
        }
      });

      return run
        ? {
            assistantMessageId: run.assistantMessageId,
            chatId: run.chatId,
            id: run.id,
            modelId: run.modelId,
            provider: run.provider,
            providerResponseId: run.providerResponseId,
            recoverySettled: isRecoveredRunTerminalPayload(run.errorPayload),
            status: run.status
          }
        : null;
    },
    getRunOutcomeForUser: async (runId, userId) => {
      const run = await prismaClient.modelRun.findFirst({
        select: {
          id: true,
          status: true
        },
        where: {
          id: runId,
          userId
        }
      });

      return run
        ? {
            id: run.id,
            status: acceptedRunStatus(run.status)
          }
        : null;
    },
    getChatUpdateForRun: async ({ assistantMessageId, chatId, userId, userMessageId }) => {
      return prismaClient.$transaction(async (tx) => {
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
          messages: {
            include: {
              assistantModelRuns: {
                orderBy: {
                  createdAt: "desc"
                },
                select: {
                  assistantId: true,
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
                  id: true,
                  knowledgeRuns: {
                    orderBy: { invocationOrdinal: "asc" },
                    select: {
                      invocationOrdinal: true,
                      outcome: true,
                      results: true
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
          permanentDeletionAt: null,
          userId
        }
        });

        if (!chat || chat.memoryMode === "TEMPORARY") {
          return null;
        }

        const runIds = chat.messages.flatMap((message) =>
          message.assistantModelRuns[0]?.id ? [message.assistantModelRuns[0].id] : []);
        const [{ contextStats, usageStats }, memoryActionsByRun] = await Promise.all([
          loadChatBranchSnapshotStats(tx, {
            activeLeafMessageId: chat.activeLeafMessageId,
            chatId
          }),
          loadMemoryRunActions(tx, { runIds, userId })
        ]);

        return {
          chat: {
            activeLeafMessageId: chat.activeLeafMessageId,
            contextStats,
            createdAt: chat.createdAt,
            defaultKnowledgePlan: knowledgeDefaultFromJson(chat.defaultKnowledgePlan),
            defaultModelId: chat.defaultProviderModel?.id ?? null,
            defaultProvider: chat.defaultProviderModel?.connectionId ?? null,
            folderId: chat.folderId,
            id: chat.id,
            messageCount: chat._count.messages,
            pinned: chat.pinned,
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
                    memoryActionsByRun.get(modelRun.id) ?? null
                  )
                : null,
              assistantIdentity: serializeRunAssistantIdentity(modelRun),
              content: message.content,
              createdAt: message.createdAt,
              errorMessage: message.errorMessage,
              id: message.id,
              modelId: message.modelId,
              modelRunId: modelRun?.id ?? null,
              parentMessageId: message.parentMessageId,
              provider: message.provider,
              role: message.role,
              status: message.status
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
    loadAttachments: async (userId, attachmentIds) => {
      if (attachmentIds.length === 0) {
        return [];
      }

      const attachments = await prismaClient.attachment.findMany({
        where: {
          id: {
            in: attachmentIds
          },
          userId
        }
      });

      return attachments.map(
        (attachment): RunAttachmentRecord => ({
          byteSize: attachment.byteSize,
          extractedText: attachment.extractedText,
          fileName: attachment.fileName,
          id: attachment.id,
          kind: attachment.kind,
          metadata: attachment.metadata,
          mimeType: attachment.mimeType,
          status: attachment.status,
          storageKey: attachment.storageKey
        })
      );
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
