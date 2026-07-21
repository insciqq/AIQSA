import { Prisma, type MessageStatus, type ModelRunStatus } from "@prisma/client";
import { textMessageContent } from "../../domain/content";
import type { ModelRunSseEvent } from "../../domain/modelRunEvents";
import { normalizeTokenUsage, sumTokenUsage } from "../../domain/usage";
import { loadChatUsageStats, summarizeMessageRunArtifacts } from "../chats/prismaRepository";
import { titleFromMessageContent } from "../chats/titlePolicy";
import { loadEntitlementsForUser } from "../auth/dbEntitlements";
import { prisma } from "../prisma";
import type { ProviderConversationMessage } from "../providers/types";
import {
  applySettingsUpdateInTransaction,
  type SettingsTransactionClient
} from "../settings/settingsTransaction";
import {
  ActiveLeafConflictError,
  ActiveRunConflictError,
  AttachmentLinkConflictError,
  type AcceptedRunDefaults,
  type DurableRunControlRecord,
  type RunAttachmentRecord,
  type RunRepository
} from "./runRepositoryContract";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function defaultMaxOutputTokens(defaultParams: unknown): number | undefined {
  if (!isRecord(defaultParams)) {
    return undefined;
  }

  return (
    numberValue(defaultParams.maxOutputTokens) ??
    numberValue(defaultParams.maxTokens) ??
    numberValue(defaultParams.max_output_tokens) ??
    numberValue(defaultParams.max_tokens) ??
    numberValue(defaultParams.max_completion_tokens) ??
    undefined
  );
}

function modelControlKey(input: { modelId: string; provider: string }): string {
  return `${input.provider}:${input.modelId}`;
}

function runControlRecord(run: {
  assistantMessageId: string | null;
  chatId: string;
  id: string;
  modelId: string;
  provider: string;
  providerResponseId: string | null;
  status: DurableRunControlRecord["status"];
}): DurableRunControlRecord {
  return {
    assistantMessageId: run.assistantMessageId,
    chatId: run.chatId,
    id: run.id,
    modelId: run.modelId,
    provider: run.provider,
    providerResponseId: run.providerResponseId,
    status: run.status
  };
}

async function persistAcceptedRunDefaults(
  tx: SettingsTransactionClient,
  userId: string,
  defaults: AcceptedRunDefaults
): Promise<void> {
  if (defaults.userId !== userId) {
    throw new Error("Run defaults user does not match run owner");
  }

  if (defaults.promptPresetId) {
    const prompt = await tx.promptPreset.findFirst({
      select: {
        id: true
      },
      where: {
        id: defaults.promptPresetId,
        userId
      }
    });
    if (!prompt) {
      throw new Error("Run defaults persistence failed: not_found");
    }
  }

  const searchStrategyId = defaults.searchStrategy ?? "search-disabled";
  const result = await applySettingsUpdateInTransaction(
    tx,
    userId,
    {
      defaultControlValues: {
        [modelControlKey(defaults)]: { ...defaults.controlDefaults }
      },
      defaultModelId: defaults.modelId,
      defaultProvider: defaults.provider,
      defaultSearchStrategyId: searchStrategyId
    },
    [
      {
        modelId: defaults.modelId,
        provider: defaults.provider,
        searchStrategyIds: [searchStrategyId]
      }
    ]
  );

  if (result.kind !== "updated") {
    throw new Error(`Run defaults persistence failed: ${result.kind}`);
  }
}

const activeModelRunStatuses: ModelRunStatus[] = ["streaming", "queued", "in_progress"];
const activeMessageStatuses: MessageStatus[] = ["streaming", "queued"];
const recoveredRunTerminalMarker = "recoveryTerminal";

function isRecoveredRunTerminalPayload(value: unknown): boolean {
  return isRecord(value) && value[recoveredRunTerminalMarker] === true;
}

function recoveredRunErrorPayload(error: { code: string; message: string }) {
  return {
    ...error,
    [recoveredRunTerminalMarker]: true
  };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
    return true;
  }

  if (!(error instanceof Error)) {
    return false;
  }

  return (
    error.message.includes("ModelRun_one_active_per_chat_idx") ||
    error.message.includes("ModelRun_one_active_per_user_idx") ||
    error.message.includes("Unique constraint failed") ||
    error.message.includes("duplicate key value violates unique constraint")
  );
}

async function mapActiveRunConflict<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isPrismaUniqueViolation(error)) {
      throw new ActiveRunConflictError();
    }

    throw error;
  }
}

type ConversationPathSelector =
  | { kind: "active" }
  | { kind: "expected"; leafMessageId: string | null }
  | { kind: "explicit"; leafMessageId: string };

type ConversationPathRow = {
  chatId: string;
  messageContent: Prisma.JsonValue | null;
  messageId: string | null;
  messageRole: string | null;
  messageStatus: string | null;
};

function conversationMessagesFromPathRows(rows: ConversationPathRow[]): ProviderConversationMessage[] {
  return rows.flatMap((row) => {
    if (
      !row.messageId ||
      (row.messageRole !== "user" && row.messageRole !== "assistant") ||
      (row.messageStatus !== "complete" && row.messageStatus !== "streaming")
    ) {
      return [];
    }

    return [
      {
        content: row.messageContent as { blocks: unknown[] },
        id: row.messageId,
        role: row.messageRole
      }
    ];
  });
}

export function createPrismaRunRepository(prismaClient = prisma): RunRepository {
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
    appendAssistantText: async (assistantMessageId, text) => {
      await prismaClient.message.updateMany({
        data: {
          content: json(textMessageContent(text)),
          status: "streaming"
        },
        where: {
          id: assistantMessageId,
          status: "streaming"
        }
      });
    },
    appendRunEvent: async (runId, sequence, event) => {
      await prismaClient.$transaction(async (tx) => {
        await tx.modelRunEvent.create({
          data: {
            eventType: event.type,
            modelRunId: runId,
            payload: json(event.data),
            sequence
          }
        });
        await tx.modelRun.update({
          data: {
            updatedAt: new Date()
          },
          where: {
            id: runId
          }
        });
      });
    },
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
            id: true
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
            }
          }
        });

        if (runs.length === 0) {
          return 0;
        }

        const runIds = runs.map((run) => run.id);
        const updatedRuns = await tx.modelRun.updateMany({
          data: {
            errorPayload: json(payload),
            status: "error"
          },
          where: {
            id: {
              in: runIds
            },
            status: {
              in: activeModelRunStatuses
            }
          }
        });
        const assistantMessageIds = unique(
          runs.flatMap((run) => (run.assistantMessageId ? [run.assistantMessageId] : []))
        );

        if (assistantMessageIds.length > 0) {
          await tx.message.updateMany({
            data: {
              errorMessage: payload.message,
              status: "error"
            },
            where: {
              id: {
                in: assistantMessageIds
              },
              status: {
                in: activeMessageStatuses
              }
            }
          });
        }

        return updatedRuns.count;
      });
    },
    cancelRun: async (input) => {
      return prismaClient.$transaction(async (tx) => {
        const updatedRun = await tx.modelRun.updateMany({
          data: {
            errorPayload: json(input.payload),
            status: "cancelled"
          },
          where: {
            id: input.runId,
            status: {
              in: activeModelRunStatuses
            },
            userId: input.userId
          }
        });
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
          if (updatedRun.count > 0) {
            throw new Error("Cancelled run disappeared before transaction commit");
          }

          return { kind: "not_found" } as const;
        }

        if (updatedRun.count === 0) {
          return {
            kind: "current",
            run: runControlRecord(run)
          } as const;
        }

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
          existingRun && activeModelRunStatuses.includes(existingRun.status)
        );
        const recoveredCompletion = Boolean(
          existingRun &&
            existingRun.status === "error" &&
            input.providerResponseId &&
            existingRun.providerResponseId === input.providerResponseId &&
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

        await tx.modelRun.update({
          data: {
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            errorPayload: Prisma.JsonNull,
            estimatedCostMicros: input.estimatedCostMicros ?? 0,
            finalProviderResponsePreview: json(input.finalProviderResponsePreview),
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
            content: json(textMessageContent(input.finalText)),
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
        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: input.runId
          }
        });
        const firstTerminalSequence = (latestEvent._max.sequence ?? -1) + 1;
        const terminalEvents: ModelRunSseEvent[] = [
          ...(input.eventsBeforeTerminal ?? []),
          {
            data: usage,
            type: "usage"
          },
          {
            data: {
              runId: input.runId,
              status: "complete"
            },
            type: "done"
          }
        ];
        await tx.modelRunEvent.createMany({
          data: terminalEvents.map((event, offset) => ({
            eventType: event.type,
            modelRunId: input.runId,
            payload: json(event.data),
            sequence: firstTerminalSequence + offset
          }))
        });
        return true;
      });
    },
    createRun: async (input) => {
      return mapActiveRunConflict(() =>
        prismaClient.$transaction(async (tx) => {
          const lockedChats = await tx.$queryRaw<
            Array<{ activeLeafMessageId: string | null; archived: boolean; id: string }>
          >`
            SELECT "id", "activeLeafMessageId", "archived"
            FROM "Chat"
            WHERE "id" = ${input.chatId}
              AND "userId" = ${input.userId}
            FOR UPDATE
          `;
          const lockedChat = lockedChats[0];
          if (
            !lockedChat ||
            lockedChat.archived ||
            lockedChat.activeLeafMessageId !== input.expectedActiveLeafId
          ) {
            throw new ActiveLeafConflictError();
          }

          const chat = await tx.chat.findFirst({
            select: {
              _count: {
                select: {
                  messages: true
                }
              },
              activeLeafMessageId: true,
              id: true,
              title: true
            },
            where: {
              archived: false,
              id: input.chatId,
              userId: input.userId
            }
          });

          if (!chat) {
            throw new Error("Chat not found for run creation");
          }

          const userMessage = await tx.message.create({
            data: {
              chatId: input.chatId,
              content: json(input.content),
              modelId: input.modelId,
              parentMessageId: input.expectedActiveLeafId,
              promptPresetId: input.normalizedRequest.prompt.presetId ?? null,
              provider: input.provider,
              role: "user",
              status: "complete"
            }
          });
          const assistantMessage = await tx.message.create({
            data: {
              chatId: input.chatId,
              content: json(textMessageContent("")),
              modelId: input.modelId,
              parentMessageId: userMessage.id,
              promptPresetId: input.normalizedRequest.prompt.presetId ?? null,
              provider: input.provider,
              role: "assistant",
              status: "streaming"
            }
          });

          const attachmentIds = unique(input.normalizedRequest.attachmentIds);
          if (attachmentIds.length > 0) {
            const linkedAttachments = await tx.attachment.updateMany({
              data: {
                chatId: input.chatId,
                messageId: userMessage.id
              },
              where: {
                id: {
                  in: attachmentIds
                },
                chatId: null,
                messageId: null,
                userId: input.userId
              }
            });
            if (linkedAttachments.count !== attachmentIds.length) {
              throw new AttachmentLinkConflictError();
            }
          }

          const run = await tx.modelRun.create({
            data: {
              assistantMessageId: assistantMessage.id,
              chatId: input.chatId,
              modelId: input.modelId,
              normalizedRequest: json(input.normalizedRequest),
              provider: input.provider,
              providerRequestPreview: json(input.providerRequestPreview),
              status: "streaming",
              userId: input.userId,
              userMessageId: userMessage.id
            }
          });

          await persistAcceptedRunDefaults(tx, input.userId, input.defaults);

          await tx.chat.update({
            data: {
              activeLeafMessageId: assistantMessage.id,
              ...(chat._count.messages === 0
                ? {
                    defaultModelId: input.modelId,
                    defaultPromptPresetId: input.normalizedRequest.prompt.presetId ?? null,
                    defaultProvider: input.provider
                  }
                : {})
            },
            where: {
              id: input.chatId
            }
          });

          if (chat._count.messages === 0) {
            await tx.chat.updateMany({
              data: {
                title: titleFromMessageContent(input.content)
              },
              where: {
                archived: false,
                id: input.chatId,
                title: {
                  in: ["New Chat", "Untitled QSA"]
                },
                userId: input.userId
              }
            });
          }

          return {
            assistantMessageId: assistantMessage.id,
            runId: run.id,
            userMessageId: userMessage.id
          };
        })
      );
    },
    createRegenerationRun: async (input) => {
      return mapActiveRunConflict(() =>
        prismaClient.$transaction(async (tx) => {
          const lockedChats = await tx.$queryRaw<Array<{ archived: boolean; id: string }>>`
            SELECT "id", "archived"
            FROM "Chat"
            WHERE "id" = ${input.chatId}
              AND "userId" = ${input.userId}
            FOR UPDATE
          `;
          if (!lockedChats[0] || lockedChats[0].archived) {
            throw new ActiveLeafConflictError();
          }

          const userMessage = await tx.message.findFirst({
            select: {
              chatId: true,
              id: true
            },
            where: {
              chat: {
                userId: input.userId
              },
              chatId: input.chatId,
              id: input.userMessageId,
              role: "user"
            }
          });

          if (!userMessage) {
            throw new Error("User message not found for regeneration");
          }

          const assistantMessage = await tx.message.create({
            data: {
              chatId: input.chatId,
              content: json(textMessageContent("")),
              modelId: input.modelId,
              parentMessageId: input.userMessageId,
              promptPresetId: input.normalizedRequest.prompt.presetId ?? null,
              provider: input.provider,
              role: "assistant",
              status: "streaming"
            }
          });
          const run = await tx.modelRun.create({
            data: {
              assistantMessageId: assistantMessage.id,
              chatId: input.chatId,
              modelId: input.modelId,
              normalizedRequest: json(input.normalizedRequest),
              provider: input.provider,
              providerRequestPreview: json(input.providerRequestPreview),
              status: "streaming",
              userId: input.userId,
              userMessageId: input.userMessageId
            }
          });

          await persistAcceptedRunDefaults(tx, input.userId, input.defaults);

          await tx.chat.update({
            data: {
              activeLeafMessageId: assistantMessage.id
            },
            where: {
              id: input.chatId
            }
          });

          return {
            assistantMessageId: assistantMessage.id,
            runId: run.id,
            userMessageId: input.userMessageId
          };
        })
      );
    },
    createSearchRun: async (input) => {
      await prismaClient.searchRun.create({
        data: {
          artifacts: json(input.artifacts),
          modelId: input.modelId,
          modelRunId: input.modelRunId,
          provider: input.provider,
          requestPreview: json(input.requestPreview),
          status: input.status,
          strategyId: input.strategyId
        }
      });
    },
    failRun: async (runId, assistantMessageId, error) => {
      return prismaClient.$transaction(async (tx) => {
        const updatedRun = await tx.modelRun.updateMany({
          data: {
            errorPayload: json(error),
            status: "error"
          },
          where: {
            id: runId,
            status: {
              in: activeModelRunStatuses
            }
          }
        });

        if (updatedRun.count === 0) {
          return false;
        }

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
        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: runId
          }
        });
        await tx.modelRunEvent.create({
          data: {
            eventType: "error",
            modelRunId: runId,
            payload: json(error),
            sequence: (latestEvent._max.sequence ?? -1) + 1
          }
        });
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
	          defaultModelId: true,
	          defaultProvider: true,
	          folder: {
	            select: {
	              projectMemory: true
	            }
	          },
	          id: true,
	          title: true
	        },
        where: {
          archived: false,
          id: chatId,
          userId
        }
      }).then((chat) =>
        chat
	          ? {
	              activeLeafMessageId: chat.activeLeafMessageId,
	              defaultModelId: chat.defaultModelId,
	              defaultProvider: chat.defaultProvider,
	              id: chat.id,
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
    findRegenerationSource: async (assistantMessageId, userId) => {
      const assistantMessage = await prismaClient.message.findFirst({
        include: {
          chat: {
            select: {
              defaultModelId: true,
              defaultProvider: true,
              folder: {
                select: {
                  projectMemory: true
                }
              },
              id: true
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
            userId
          },
          id: assistantMessageId,
          role: "assistant"
        }
      });

      if (!assistantMessage?.parent || assistantMessage.parent.role !== "user") {
        return null;
      }

      return {
        assistantMessage: {
          id: assistantMessage.id,
          modelId: assistantMessage.modelId,
          provider: assistantMessage.provider
        },
        chat: {
          defaultModelId: assistantMessage.chat.defaultModelId,
          defaultProvider: assistantMessage.chat.defaultProvider,
          id: assistantMessage.chat.id,
          projectMemory: assistantMessage.chat.folder?.projectMemory ?? null
        },
        userMessage: {
          content: assistantMessage.parent.content,
          id: assistantMessage.parent.id
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
    getRunForUser: async (runId, userId) => {
      const run = await prismaClient.modelRun.findFirst({
        include: {
          events: {
            orderBy: {
              sequence: "asc"
            }
          },
          searchRuns: {
            orderBy: {
              createdAt: "asc"
            }
          }
        },
        where: {
          id: runId,
          userId
        }
      });

      if (!run) {
        return null;
      }

      return {
        assistantMessageId: run.assistantMessageId,
        chatId: run.chatId,
        createdAt: run.createdAt.toISOString(),
        errorPayload: run.errorPayload,
        estimatedCostMicros: run.estimatedCostMicros > 0 ? run.estimatedCostMicros : null,
        events: run.events.map((event) => ({
          createdAt: event.createdAt.toISOString(),
          eventType: event.eventType,
          payload: event.payload,
          sequence: event.sequence
        })),
        finalProviderResponsePreview: run.finalProviderResponsePreview,
        id: run.id,
        cachedInputTokens: run.cachedInputTokens,
        cacheWriteInputTokens: run.cacheWriteInputTokens,
        inputTokens: run.inputTokens,
        modelId: run.modelId,
        normalizedRequest: run.normalizedRequest,
        outputTokens: run.outputTokens,
        provider: run.provider,
        providerRequestPreview: run.providerRequestPreview,
        providerResponseId: run.providerResponseId,
        reasoningTokens: run.reasoningTokens,
        totalTokens: run.totalTokens,
        searchRuns: run.searchRuns.map((searchRun) => ({
          artifacts: searchRun.artifacts,
          createdAt: searchRun.createdAt.toISOString(),
          id: searchRun.id,
          modelId: searchRun.modelId,
          provider: searchRun.provider,
          requestPreview: searchRun.requestPreview,
          status: searchRun.status,
          strategyId: searchRun.strategyId,
          updatedAt: searchRun.updatedAt.toISOString()
        })),
        status: run.status,
        updatedAt: run.updatedAt.toISOString(),
        userMessageId: run.userMessageId
      };
    },
    getChatUpdateForRun: async ({ assistantMessageId, chatId, userId, userMessageId }) => {
      const chat = await prismaClient.chat.findFirst({
        select: {
          _count: {
            select: {
              messages: true
            }
          },
          activeLeafMessageId: true,
          createdAt: true,
          defaultModelId: true,
          defaultPromptPresetId: true,
          defaultProvider: true,
          folderId: true,
          id: true,
          messages: {
            include: {
              assistantModelRuns: {
                orderBy: {
                  createdAt: "desc"
                },
                select: {
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
                  searchRuns: {
                    orderBy: {
                      createdAt: "asc"
                    },
                    select: {
                      artifacts: true,
                      modelId: true,
                      provider: true,
                      requestPreview: true,
                      status: true,
                      strategyId: true
                    }
                  },
                  status: true
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
          userId
        }
      });

      if (!chat) {
        return null;
      }

      const usageStats = await loadChatUsageStats(prismaClient, { chatId, userId });

      return {
        chat: {
          activeLeafMessageId: chat.activeLeafMessageId,
          createdAt: chat.createdAt,
          defaultModelId: chat.defaultModelId,
          defaultPromptPresetId: chat.defaultPromptPresetId,
          defaultProvider: chat.defaultProvider,
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
            artifactSummary: modelRun ? summarizeMessageRunArtifacts(modelRun) : null,
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
    },
    isPromptPresetAvailable: async (userId, promptPresetId) => {
      const prompt = await prismaClient.promptPreset.findFirst({
        select: {
          id: true
        },
        where: {
          id: promptPresetId,
          userId
        }
      });

      return Boolean(prompt);
    },
    isSearchStrategyEnabled: async (searchStrategyId) => {
      const strategy = await prismaClient.searchStrategy.findFirst({
        select: {
          strategyId: true
        },
        where: {
          enabled: true,
          strategyId: searchStrategyId
        }
      });

      return Boolean(strategy);
    },
    loadSearchStrategyConfiguration: async (searchStrategyId) => {
      const strategy = await prismaClient.searchStrategy.findFirst({
        select: {
          config: true,
          kind: true,
          modelId: true,
          provider: true,
          strategyId: true
        },
        where: {
          enabled: true,
          strategyId: searchStrategyId
        }
      });

      if (!strategy) {
        return null;
      }

      return {
        config: isRecord(strategy.config)
          ? { ...(strategy.config as Record<string, unknown>) }
          : {},
        kind: strategy.kind,
        modelId: strategy.modelId,
        provider: strategy.provider,
        strategyId: strategy.strategyId
      };
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
    loadModelConfiguration: async (provider, modelId) => {
      const model = await prismaClient.providerModel.findFirst({
        select: {
          capabilities: true,
          contextWindow: true,
          defaultParams: true,
          supportsNativeSearch: true,
          supportsPdf: true,
          supportsReasoning: true,
          supportsVision: true
        },
        where: {
          enabled: true,
          modelId,
          provider
        }
      });

      if (!model) {
        return null;
      }
      const defaultCapabilities =
        typeof model.capabilities === "object" && model.capabilities !== null && !Array.isArray(model.capabilities)
          ? (model.capabilities as Record<string, unknown>)
          : {};

      return {
        capabilities: {
          contextWindow: model.contextWindow,
          defaultMaxOutputTokens: defaultMaxOutputTokens(model.defaultParams),
          nativePdfInput:
            typeof defaultCapabilities.nativePdfInput === "boolean" ? defaultCapabilities.nativePdfInput : false,
          nativeSearch: model.supportsNativeSearch,
          pdf: model.supportsPdf,
          reasoning: model.supportsReasoning,
          streaming: typeof defaultCapabilities.streaming === "boolean" ? defaultCapabilities.streaming : false,
          vision: model.supportsVision
        },
        defaultParams: isRecord(model.defaultParams)
          ? { ...(model.defaultParams as Record<string, unknown>) }
          : {}
      };
    },
    loadModelPricing: async (provider, modelId) => {
      const model = await prismaClient.providerModel.findUnique({
        select: {
          inputTokenPriceMicros: true,
          outputTokenPriceMicros: true
        },
        where: {
          provider_modelId: {
            modelId,
            provider
          }
        }
      });

      return model
        ? {
            inputTokenPriceMicros: model.inputTokenPriceMicros,
            outputTokenPriceMicros: model.outputTokenPriceMicros
          }
        : null;
    },
    recordRunUsageEvents: async (input) => {
      if (input.usageAttributions.length === 0) {
        return false;
      }

      const usageAttributions = input.usageAttributions.map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));
      const usage = sumTokenUsage(usageAttributions.map((attribution) => attribution.usage));
      const estimatedCostMicros = usageAttributions.reduce(
        (total, attribution) => total + (attribution.estimatedCostMicros ?? 0),
        0
      );

      return prismaClient.$transaction(async (tx) => {
        const updatedRun = await tx.modelRun.updateMany({
          data: {
            cachedInputTokens: usage.cachedInputTokens,
            cacheWriteInputTokens: usage.cacheWriteInputTokens,
            estimatedCostMicros,
            inputTokens: usage.inputTokens,
            outputTokens: usage.outputTokens,
            reasoningTokens: usage.reasoningTokens,
            totalTokens: usage.totalTokens
          },
          where: {
            chatId: input.chatId,
            id: input.runId,
            status: {
              not: "complete"
            },
            userId: input.userId
          }
        });
        if (updatedRun.count === 0) {
          return false;
        }

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
        return true;
      });
    },
    settleRecoveredRunError: async (input) => {
      const usageAttributions = input.usageAttributions.map((attribution) => ({
        ...attribution,
        usage: normalizeTokenUsage(attribution.usage)
      }));
      const usage =
        usageAttributions.length > 0
          ? sumTokenUsage(usageAttributions.map((attribution) => attribution.usage))
          : null;
      const estimatedCostMicros = usageAttributions.reduce(
        (total, attribution) => total + (attribution.estimatedCostMicros ?? 0),
        0
      );

      return prismaClient.$transaction(async (tx) => {
        const [run] = await tx.$queryRaw<
          Array<{
            assistantMessageId: string | null;
            chatId: string;
            errorPayload: Prisma.JsonValue | null;
            providerResponseId: string | null;
            status: ModelRunStatus;
            userId: string;
          }>
        >(Prisma.sql`
          SELECT
            "assistantMessageId",
            "chatId",
            "errorPayload",
            "providerResponseId",
            "status",
            "userId"
          FROM "ModelRun"
          WHERE "id" = ${input.runId}
            AND "userId" = ${input.userId}
          FOR UPDATE
        `);

        if (
          !run ||
          (!activeModelRunStatuses.includes(run.status) && run.status !== "error") ||
          isRecoveredRunTerminalPayload(run.errorPayload)
        ) {
          return false;
        }

        await tx.modelRun.update({
          data: {
            errorPayload: json(recoveredRunErrorPayload(input.error)),
            ...(input.providerResponseId
              ? { providerResponseId: input.providerResponseId }
              : {}),
            status: "error",
            ...(usage
              ? {
                  cachedInputTokens: usage.cachedInputTokens,
                  cacheWriteInputTokens: usage.cacheWriteInputTokens,
                  estimatedCostMicros,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  reasoningTokens: usage.reasoningTokens,
                  totalTokens: usage.totalTokens
                }
              : {})
          },
          where: {
            id: input.runId
          }
        });

        if (run.assistantMessageId) {
          await tx.message.updateMany({
            data: {
              errorMessage: input.error.message,
              status: "error"
            },
            where: {
              chatId: run.chatId,
              id: run.assistantMessageId,
              status: {
                in: [...activeMessageStatuses, "error"]
              }
            }
          });
        }

        if (usageAttributions.length > 0) {
          await tx.usageEvent.deleteMany({
            where: {
              modelRunId: input.runId
            }
          });
          await tx.usageEvent.createMany({
            data: usageAttributions.map((attribution) => ({
              chatId: run.chatId,
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
              userId: run.userId
            }))
          });
        }

        const latestEvent = await tx.modelRunEvent.aggregate({
          _max: {
            sequence: true
          },
          where: {
            modelRunId: input.runId
          }
        });
        const firstSequence = (latestEvent._max.sequence ?? -1) + 1;
        const events: ModelRunSseEvent[] = [
          ...input.events,
          {
            data: input.error,
            type: "error"
          }
        ];
        await tx.modelRunEvent.createMany({
          data: events.map((event, offset) => ({
            eventType: event.type,
            modelRunId: input.runId,
            payload: json(event.data),
            sequence: firstSequence + offset
          }))
        });

        return true;
      });
    },
    nextRunEventSequence: async (runId) => {
      const aggregate = await prismaClient.modelRunEvent.aggregate({
        _max: {
          sequence: true
        },
        where: {
          modelRunId: runId
        }
      });

      return (aggregate._max.sequence ?? -1) + 1;
    },
    updateRunProviderResponseId: async (runId, providerResponseId) => {
      const updated = await prismaClient.modelRun.updateMany({
        data: {
          providerResponseId
        },
        where: {
          id: runId,
          status: {
            in: activeModelRunStatuses
          }
        }
      });
      if (updated.count > 0) {
        return "published";
      }

      const current = await prismaClient.modelRun.findUnique({
        select: {
          status: true
        },
        where: {
          id: runId
        }
      });
      return current?.status === "cancelled" ? "cancelled" : "terminal";
    },
    updateRunProviderRequestPreview: async (runId, providerRequestPreview) => {
      await prismaClient.modelRun.update({
        data: {
          providerRequestPreview: json(providerRequestPreview)
        },
        where: {
          id: runId
        }
      });
    },
    updateCancelledRunProviderPreview: async (input) => {
      const preview = JSON.stringify(input.providerCancelPreview);
      const updated = await prismaClient.$executeRaw`
        UPDATE "ModelRun"
        SET
          "errorPayload" = COALESCE("errorPayload", '{}'::jsonb) ||
            jsonb_build_object('providerCancelPreview', ${preview}::jsonb),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${input.runId}
          AND "userId" = ${input.userId}
          AND "status" = 'cancelled'::"ModelRunStatus"
      `;

      return updated === 1;
    }
  };
}
