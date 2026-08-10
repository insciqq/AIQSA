import { randomUUID } from "node:crypto";
import { Prisma, type MessageStatus, type ModelRunStatus } from "@prisma/client";
import { prisma } from "../prisma";
import {
  applyMemorySourceMutations,
  deleteMemorySourceJobsForMessages,
  lockMemorySourceChat,
  type LockedMemorySourceChat,
  type MemorySourceMutationHooks
} from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import {
  ActiveMessageMutationConflictError,
  type BranchChatRecord,
  type BranchMessageRecord,
  type MessageBranchRepository
} from "./handlers";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function branchChatTitle(title: string): string {
  const base = title.trim() || "New Chat";
  const next = `Branch: ${base}`;

  return next.length > 80 ? `${next.slice(0, 77)}...` : next;
}

const activeRunStatuses: ModelRunStatus[] = ["preparing", "streaming", "queued", "in_progress"];
const activeMessageStatuses: MessageStatus[] = ["streaming", "queued"];

function isActiveMessageStatus(status: MessageStatus): boolean {
  return activeMessageStatuses.includes(status);
}

type LockedOwnedChat = LockedMemorySourceChat & {
  defaultProviderModelId: string | null;
  title: string;
};

async function lockOwnedChatForMessage(
  tx: Prisma.TransactionClient,
  input: { messageId: string; userId: string }
): Promise<LockedOwnedChat | null> {
  const chats = await tx.$queryRaw<LockedOwnedChat[]>`
    SELECT
      chat."activeLeafMessageId",
      chat."defaultProviderModelId",
      chat."folderId",
      chat."id",
      chat."title",
      chat."userId",
      chat."archived",
      chat."memoryMode",
      chat."memoryBranchGeneration",
      chat."memorySourceRevision",
      chat."temporaryRetentionPolicyVersion",
      chat."temporaryRetentionDeadline"
    FROM "Chat" AS chat
    WHERE chat."userId" = ${input.userId}
      AND chat."archived" = FALSE
      AND EXISTS (
        SELECT 1
        FROM "Message" AS message
        WHERE message."id" = ${input.messageId}
          AND message."chatId" = chat."id"
      )
    FOR UPDATE OF chat
  `;

  return chats[0] ?? null;
}

async function assertChatHasNoActiveRun(tx: Prisma.TransactionClient, chatId: string) {
  const activeRun = await tx.modelRun.findFirst({
    select: {
      id: true,
      status: true
    },
    where: {
      chatId,
      status: {
        in: activeRunStatuses
      }
    }
  });

  if (activeRun) {
    throw new ActiveMessageMutationConflictError(activeRun);
  }
}

function orderedAncestorPath<TMessage extends { id: string; parentMessageId: string | null }>(
  messages: TMessage[],
  leafMessageId: string
): TMessage[] {
  const byId = new Map(messages.map((message) => [message.id, message]));
  const path: TMessage[] = [];
  const seen = new Set<string>();
  let cursor: string | null = leafMessageId;

  while (cursor) {
    if (seen.has(cursor)) {
      return [];
    }

    const message = byId.get(cursor);
    if (!message) {
      return [];
    }

    seen.add(cursor);
    path.push(message);
    cursor = message.parentMessageId;
  }

  return path.reverse();
}

class BranchAttachmentCloneError extends Error {
  constructor() {
    super("branch_attachment_clone_failed");
  }
}

function attachmentIdsFromMessageContent(content: unknown): string[] {
  if (typeof content !== "object" || content === null || !("blocks" in content)) {
    return [];
  }

  const blocks = (content as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) {
    return [];
  }

  return blocks.flatMap((block) =>
    typeof block === "object" &&
    block !== null &&
    "attachmentId" in block &&
    typeof block.attachmentId === "string"
      ? [block.attachmentId]
      : []
  );
}

function rewriteMessageAttachmentIds(
  content: unknown,
  clonedAttachmentIds: ReadonlyMap<string, string>
): Prisma.InputJsonValue {
  if (clonedAttachmentIds.size === 0) {
    return json(content);
  }
  if (typeof content !== "object" || content === null || !("blocks" in content)) {
    throw new BranchAttachmentCloneError();
  }

  const blocks = (content as { blocks?: unknown }).blocks;
  if (!Array.isArray(blocks)) {
    throw new BranchAttachmentCloneError();
  }

  return json({
    ...content,
    blocks: blocks.map((block) => {
      if (
        typeof block !== "object" ||
        block === null ||
        !("attachmentId" in block) ||
        typeof block.attachmentId !== "string"
      ) {
        return block;
      }

      const attachmentId = clonedAttachmentIds.get(block.attachmentId);
      if (!attachmentId) {
        throw new BranchAttachmentCloneError();
      }

      return {
        ...block,
        attachmentId
      };
    })
  });
}

export function createPrismaMessageBranchRepository(
  prismaClient = prisma,
  options: Readonly<{ memorySourceHooks?: MemorySourceMutationHooks }> = {}
): MessageBranchRepository {
  const memorySourceHooks = options.memorySourceHooks ?? defaultMemorySourceMutationHooks;
  return {
    createChatBranchFromMessage: async ({ sourceMessageId, userId }) =>
      prismaClient.$transaction(async (tx) => {
        const lockedChat = await lockOwnedChatForMessage(tx, {
          messageId: sourceMessageId,
          userId
        });
        if (!lockedChat) {
          return null;
        }
        await assertChatHasNoActiveRun(tx, lockedChat.id);

        const source = await tx.message.findFirst({
          select: {
            chatId: true,
            id: true,
            role: true,
            status: true
          },
          where: {
            chatId: lockedChat.id,
            id: sourceMessageId
          }
        });

        if (!source) {
          return null;
        }
        if (isActiveMessageStatus(source.status)) {
          throw new ActiveMessageMutationConflictError();
        }

        const sourceMessages = await tx.message.findMany({
          orderBy: {
            createdAt: "asc"
          },
          select: {
            content: true,
            errorMessage: true,
            id: true,
            inputTokens: true,
            modelId: true,
            outputTokens: true,
            parentMessageId: true,
            provider: true,
            reasoningTokens: true,
            role: true,
            status: true
          },
          where: {
            chatId: lockedChat.id
          }
        });
        const path = orderedAncestorPath(sourceMessages, sourceMessageId);
        if (path.length === 0) {
          return null;
        }
        if (path.some((message) => isActiveMessageStatus(message.status))) {
          throw new ActiveMessageMutationConflictError();
        }

        const sourceAnswerBinding =
          source.role === "assistant"
            ? (
                await tx.modelRun.findFirst({
                  orderBy: { createdAt: "desc" },
                  select: {
                    providerRunBindings: {
                      select: { providerModelId: true },
                      where: { role: "answer" }
                    }
                  },
                  where: {
                    assistantMessageId: source.id,
                    userId
                  }
                })
              )?.providerRunBindings[0] ?? null
            : null;

        const attachmentIdsByMessageId = new Map(
          path.map((message) => [
            message.id,
            [...new Set(attachmentIdsFromMessageContent(message.content))]
          ])
        );
        const referencedAttachmentIds = [
          ...new Set(Array.from(attachmentIdsByMessageId.values()).flat())
        ];
        const sourceAttachments =
          referencedAttachmentIds.length === 0
            ? []
            : await tx.attachment.findMany({
                select: {
                  byteSize: true,
                  checksum: true,
                  extractedText: true,
                  fileName: true,
                  id: true,
                  kind: true,
                  messageId: true,
                  metadata: true,
                  mimeType: true,
                  status: true,
                  storageKey: true
                },
                where: {
                  chatId: lockedChat.id,
                  id: {
                    in: referencedAttachmentIds
                  },
                  messageId: {
                    in: path.map((message) => message.id)
                  },
                  userId
                }
              });
        const sourceAttachmentsById = new Map(
          sourceAttachments.map((attachment) => [attachment.id, attachment])
        );
        for (const sourceMessage of path) {
          for (const attachmentId of attachmentIdsByMessageId.get(sourceMessage.id) ?? []) {
            if (sourceAttachmentsById.get(attachmentId)?.messageId !== sourceMessage.id) {
              throw new BranchAttachmentCloneError();
            }
          }
        }

        const chat = await tx.chat.create({
          data: {
            defaultProviderModelId:
              sourceAnswerBinding?.providerModelId ?? lockedChat.defaultProviderModelId,
            folderId: lockedChat.folderId,
            pinned: false,
            title: branchChatTitle(lockedChat.title),
            userId
          },
          select: {
            id: true
          }
        });

        const idMap = new Map<string, string>();
        let activeLeafMessageId: string | null = null;
        for (const sourceMessage of path) {
          const parentMessageId = sourceMessage.parentMessageId ? idMap.get(sourceMessage.parentMessageId) ?? null : null;
          const clonedMessageId = randomUUID();
          const clonedAttachmentIds = new Map(
            (attachmentIdsByMessageId.get(sourceMessage.id) ?? []).map((attachmentId) => [
              attachmentId,
              randomUUID()
            ])
          );
          const cloned = await tx.message.create({
            data: {
              chatId: chat.id,
              content: rewriteMessageAttachmentIds(
                sourceMessage.content,
                clonedAttachmentIds
              ),
              errorMessage: sourceMessage.errorMessage,
              id: clonedMessageId,
              inputTokens: sourceMessage.inputTokens,
              modelId: sourceMessage.modelId,
              outputTokens: sourceMessage.outputTokens,
              parentMessageId,
              provider: sourceMessage.provider,
              reasoningTokens: sourceMessage.reasoningTokens,
              role: sourceMessage.role,
              status: sourceMessage.status
            },
            select: {
              id: true
            }
          });

          for (const [sourceAttachmentId, clonedAttachmentId] of clonedAttachmentIds) {
            const sourceAttachment = sourceAttachmentsById.get(sourceAttachmentId);
            if (!sourceAttachment) {
              throw new BranchAttachmentCloneError();
            }

            await tx.attachment.create({
              data: {
                byteSize: sourceAttachment.byteSize,
                chatId: chat.id,
                checksum: sourceAttachment.checksum,
                extractedText: sourceAttachment.extractedText,
                fileName: sourceAttachment.fileName,
                id: clonedAttachmentId,
                kind: sourceAttachment.kind,
                messageId: cloned.id,
                metadata: json(sourceAttachment.metadata),
                mimeType: sourceAttachment.mimeType,
                status: sourceAttachment.status,
                storageKey: sourceAttachment.storageKey,
                userId
              }
            });
          }

          idMap.set(sourceMessage.id, cloned.id);
          activeLeafMessageId = cloned.id;
        }

        const newChat = await lockMemorySourceChat(tx, {
          chatId: chat.id,
          lock: "UPDATE",
          userId
        });
        if (!newChat) throw new Error("branch_chat_disappeared");
        await applyMemorySourceMutations(tx, {
          chat: newChat,
          hooks: memorySourceHooks,
          mutations: ["NORMAL_APPEND"],
          patch: { activeLeafMessageId }
        });
        const updated = await tx.chat.findUniqueOrThrow({
          select: {
            activeLeafMessageId: true,
            createdAt: true,
            defaultProviderModel: {
              select: {
                connectionId: true,
                id: true
              }
            },
            folderId: true,
            id: true,
            pinned: true,
            title: true,
            updatedAt: true
          },
          where: {
            id: chat.id
          }
        });

        const { defaultProviderModel, ...chatSummary } = updated;

        return {
          ...chatSummary,
          defaultModelId: defaultProviderModel?.id ?? null,
          defaultProvider: defaultProviderModel?.connectionId ?? null,
          messageCount: path.length
        } satisfies BranchChatRecord;
      }),
    createEditedMessageBranch: async ({ content, originalMessageId, userId }) =>
      prismaClient.$transaction(async (tx) => {
        const lockedChat = await lockOwnedChatForMessage(tx, {
          messageId: originalMessageId,
          userId
        });
        if (!lockedChat) {
          return null;
        }
        await assertChatHasNoActiveRun(tx, lockedChat.id);

        const original = await tx.message.findFirst({
          where: {
            chatId: lockedChat.id,
            id: originalMessageId,
            role: {
              in: ["assistant", "user"]
            }
          }
        });

        if (!original) {
          return null;
        }
        if (isActiveMessageStatus(original.status)) {
          throw new ActiveMessageMutationConflictError();
        }

        const message = await tx.message.create({
          data: {
            chatId: original.chatId,
            content: json(content),
            modelId: original.modelId,
            parentMessageId: original.parentMessageId,
            provider: original.provider,
            role: original.role,
            status: "complete"
          }
        });

        await applyMemorySourceMutations(tx, {
          chat: lockedChat,
          hooks: memorySourceHooks,
          mutations: ["BRANCH_PATH_CHANGE"],
          patch: { activeLeafMessageId: message.id }
        });

        return message;
      }),
    deleteMessageSubtree: async ({ messageId, userId }) =>
      prismaClient.$transaction(async (tx) => {
        const lockedChat = await lockOwnedChatForMessage(tx, {
          messageId,
          userId
        });
        if (!lockedChat) {
          return null;
        }
        await assertChatHasNoActiveRun(tx, lockedChat.id);

        const root = await tx.message.findFirst({
          select: {
            chatId: true,
            id: true,
            parentMessageId: true
          },
          where: {
            chatId: lockedChat.id,
            id: messageId
          }
        });

        if (!root) {
          return null;
        }

        const chatMessages = await tx.message.findMany({
          select: {
            id: true,
            parentMessageId: true,
            status: true
          },
          where: {
            chatId: root.chatId
          }
        });
        const childrenByParent = new Map<string, string[]>();
        for (const message of chatMessages) {
          if (!message.parentMessageId) {
            continue;
          }

          childrenByParent.set(message.parentMessageId, [
            ...(childrenByParent.get(message.parentMessageId) ?? []),
            message.id
          ]);
        }

        const deletedDepths = new Map<string, number>([[messageId, 0]]);
        const queue = [messageId];
        while (queue.length > 0) {
          const parentId = queue.shift()!;
          const parentDepth = deletedDepths.get(parentId) ?? 0;
          for (const childId of childrenByParent.get(parentId) ?? []) {
            if (deletedDepths.has(childId)) {
              continue;
            }

            deletedDepths.set(childId, parentDepth + 1);
            queue.push(childId);
          }
        }

        const deletedMessageIds = Array.from(deletedDepths.keys());
        const activeMessage = chatMessages.find(
          (message) => deletedDepths.has(message.id) && isActiveMessageStatus(message.status)
        );
        if (activeMessage) {
          throw new ActiveMessageMutationConflictError({
            id: null,
            status: activeMessage.status
          });
        }
        const activeLeafMessageId = lockedChat.activeLeafMessageId;
        const nextActiveLeafMessageId =
          activeLeafMessageId && deletedDepths.has(activeLeafMessageId) ? root.parentMessageId : activeLeafMessageId;

        await tx.modelRun.deleteMany({
          where: {
            OR: [
              {
                assistantMessageId: {
                  in: deletedMessageIds
                }
              },
              {
                userMessageId: {
                  in: deletedMessageIds
                }
              }
            ],
            status: {
              notIn: activeRunStatuses
            }
          }
        });
        await tx.attachment.updateMany({
          data: {
            messageId: null
          },
          where: {
            messageId: {
              in: deletedMessageIds
            },
            userId
          }
        });
        await deleteMemorySourceJobsForMessages(tx, {
          chatId: root.chatId,
          messageIds: deletedMessageIds,
          userId
        });
        if (nextActiveLeafMessageId !== activeLeafMessageId) {
          await applyMemorySourceMutations(tx, {
            chat: lockedChat,
            hooks: memorySourceHooks,
            mutations: ["BRANCH_PATH_CHANGE"],
            patch: { activeLeafMessageId: nextActiveLeafMessageId }
          });
        }

        for (const id of deletedMessageIds.sort((a, b) => (deletedDepths.get(b) ?? 0) - (deletedDepths.get(a) ?? 0))) {
          await tx.message.delete({
            where: {
              id
            }
          });
        }

        return {
          activeLeafMessageId: nextActiveLeafMessageId,
          chatId: root.chatId,
          deletedMessageIds
        };
      })
  };
}
