import { randomUUID } from "node:crypto";
import { runFollowupSelect } from "../runs/prismaRepositoryFollowups";
import { projectMessageFollowups } from "../runs/runFollowups";
import { Prisma, type ChatImportSource, type MessageStatus, type ModelRunStatus } from "@prisma/client";
import { prisma } from "../prisma";
import {
  applyMemorySourceMutations,
  deleteMemorySourceJobsForMessages,
  lockMemorySourceChat,
  type LockedMemorySourceChat,
  type MemorySourceMutationHooks
} from "../memory/sourceState";
import { defaultMemorySourceMutationHooks } from "../memory/sourceHooks";
import { collapseChatAnswerReviews, loadAnswerReviewDeletionPlan } from "../chats/legacyAnswerReviews";
import {
  ActiveMessageMutationConflictError,
  MessageDeleteConflictError,
  type BranchChatRecord,
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
  importSource: ChatImportSource | null;
  importSourceModel: string | null;
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
      chat."importSource",
      chat."importSourceModel",
      chat."title",
      chat."userId",
      chat."archived",
      chat."memoryMode",
      chat."memoryBranchGeneration",
      chat."memorySourceRevision",
      chat."temporaryRetentionPolicyVersion",
      chat."temporaryRetentionDeadline"
    FROM "Chat" AS chat
    WHERE chat."archived" = FALSE
      AND chat."userId" = ${input.userId}
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

/**
 * The main agent's active run holds off edits, branches and deletions; a
 * background sub-agent runs beside it (one active run per thread) and never
 * does: an edit branches past it, and a deletion stops the ones under the
 * deleted subtree first (`createDeleteMessageHandler`).
 */
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
      },
      subagentTurnId: null
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
    this.name = "BranchAttachmentCloneError";
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
        if (!lockedChat || lockedChat.memoryMode === "TEMPORARY") {
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
            assistantModelRuns: {
              orderBy: { createdAt: "desc" },
              select: { id: true, ...runFollowupSelect, status: true, answerCompletedAt: true },
              take: 1
            },
            branchSourceModelRunId: true,
            branchFollowups: true,
            content: true,
            createdAt: true,
            errorMessage: true,
            id: true,
            inputTokens: true,
            modelId: true,
            outputTokens: true,
            parentMessageId: true,
            provider: true,
            reasoningTokens: true,
            role: true,
            scheduledTaskPrompt: true,
            status: true,
            systemTurnKind: true,
            answerReviewSessionId: true
          },
          where: {
            chatId: lockedChat.id
          }
        });
        const ancestors = orderedAncestorPath(sourceMessages, sourceMessageId);
        if (ancestors.length === 0) {
          return null;
        }
        if (ancestors.some((message) => isActiveMessageStatus(message.status))) {
          throw new ActiveMessageMutationConflictError();
        }
        // The copy holds no answer review session: each one recorded before
        // the feature's removal is copied as its question followed by the
        // group's latest version, and a later message hangs from that version
        // (as exports read it).
        const reviewCollapse = await collapseChatAnswerReviews(tx, lockedChat.id, ancestors.map((message) => ({
          answerReviewSessionId: message.answerReviewSessionId, id: message.id, parentId: message.parentMessageId,
          role: message.role, status: message.status, systemTurnKind: message.systemTurnKind
        })));
        const path = ancestors.filter((message) => !reviewCollapse.removed.has(message.id));
        // The branch's last message stands for its source when the source was a review step.
        const branchLeaf = path.at(-1)!;

        const sourceAnswerBinding =
          branchLeaf.role === "assistant"
            ? (
                await tx.modelRun.findFirst({
                  orderBy: { createdAt: "desc" },
                  select: {
                    providerRunBindings: {
                      select: { providerModelId: true },
                      // The answer model's own binding, never a sub-agent model's.
                      where: { bindingKey: "answer", role: "answer" }
                    }
                  },
                  where: {
                    assistantMessageId: branchLeaf.id,
                    userId
                  }
                })
              )?.providerRunBindings[0] ?? null
            : null;

        // A branch owns local copies of image outputs, independently of the
        // source run and chat. They join the ordinary attachment clone path.
        const generatedImages = await tx.attachment.findMany({
          where: { chatId: lockedChat.id, messageId: { in: path.map((message) => message.id) },
            origin: "IMAGE_OUTPUT", kind: "image", status: "ready", userId },
          select: { id: true, messageId: true, fileName: true }, orderBy: [{ createdAt: "asc" }, { id: "asc" }]
        });
        for (const message of path) {
          const images = generatedImages.filter((image) => image.messageId === message.id);
          if (!images.length) continue;
          const content = message.content;
          if (!content || typeof content !== "object" || Array.isArray(content) || !Array.isArray(content.blocks)) throw new BranchAttachmentCloneError();
          const present = new Set(attachmentIdsFromMessageContent(content));
          message.content = { ...content, blocks: [...content.blocks, ...images.filter((image) => !present.has(image.id)).map((image) => ({
            type: "image", attachmentId: image.id, label: image.fileName
          }))] };
        }

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
            // An Excluded source stays excluded; Temporary never branches.
            memoryMode: lockedChat.memoryMode,
            // A copy of an imported chat keeps its import marker, never the key,
            // so it can no more use Memory than its source.
            ...(lockedChat.importSource
              ? { importSource: lockedChat.importSource, importSourceModel: lockedChat.importSourceModel }
              : {}),
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
          const sourceParentId = reviewCollapse.parents.has(sourceMessage.id)
            ? reviewCollapse.parents.get(sourceMessage.id) ?? null
            : sourceMessage.parentMessageId;
          const parentMessageId = sourceParentId ? idMap.get(sourceParentId) ?? null : null;
          const clonedMessageId = randomUUID();
          const followups = projectMessageFollowups(sourceMessage);
          const clonedAttachmentIds = new Map(
            (attachmentIdsByMessageId.get(sourceMessage.id) ?? []).map((attachmentId) => [
              attachmentId,
              randomUUID()
            ])
          );
          const cloned = await tx.message.create({
            data: {
              ...(followups?.entries.length ? { branchFollowups: json({ ...followups, available: false }) } : {}),
              branchSourceModelRunId: sourceMessage.role === "assistant"
                ? sourceMessage.assistantModelRuns[0]?.id ??
                  sourceMessage.branchSourceModelRunId
                : null,
              chatId: chat.id,
              content: rewriteMessageAttachmentIds(
                sourceMessage.content,
                clonedAttachmentIds
              ),
              // Memory barriers, pauses and Resume cutoffs fence by message
              // creation time; a copy must not re-admit a fenced period.
              createdAt: sourceMessage.createdAt,
              errorMessage: sourceMessage.errorMessage,
              id: clonedMessageId,
              inputTokens: sourceMessage.inputTokens,
              modelId: sourceMessage.modelId,
              outputTokens: sourceMessage.outputTokens,
              parentMessageId,
              provider: sourceMessage.provider,
              reasoningTokens: sourceMessage.reasoningTokens,
              role: sourceMessage.role,
              // A copied scheduled task's prompt stays one, at any branch depth:
              // the copy has no runs to say so, and the prompt and every answer
              // to it must stay out of Memory and never create a task.
              ...(sourceMessage.role === "user" && sourceMessage.scheduledTaskPrompt
                ? { scheduledTaskPrompt: true }
                : {}),
              // A turn the server wrote for the user stays one in the copy too.
              ...(sourceMessage.role === "user" && sourceMessage.systemTurnKind
                ? { systemTurnKind: sourceMessage.systemTurnKind }
                : {}),
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
          branchSourceChatId: lockedChat.id,
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
            importSource: true,
            importSourceModel: true,
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
            role: { in: ["assistant", "user"] }
          }
        });

        if (!original) {
          return null;
        }
        if (isActiveMessageStatus(original.status)) {
          throw new ActiveMessageMutationConflictError();
        }

        // The inline editor changes only text. Its sibling must own new
        // attachment rows so deleting either branch cannot detach the other.
        const originalBlocks = typeof original.content === "object" && original.content !== null &&
          !Array.isArray(original.content) && Array.isArray(original.content.blocks)
          ? original.content.blocks : [];
        const textOnlyEdit = content.blocks.every((block) =>
          typeof block === "object" && block !== null && "type" in block && block.type === "text"
        );
        const editedContent = {
          blocks: textOnlyEdit
            ? [...content.blocks, ...originalBlocks.filter((block) =>
                typeof block === "object" && block !== null && !Array.isArray(block) &&
                (block.type === "file" || block.type === "image")
              )]
            : content.blocks
        };
        const attachmentIds = [...new Set(attachmentIdsFromMessageContent(editedContent))];
        const attachments = attachmentIds.length === 0 ? [] : await tx.attachment.findMany({
          where: {
            chatId: lockedChat.id,
            id: { in: attachmentIds },
            messageId: original.id,
            userId
          }
        });
        if (attachments.length !== attachmentIds.length) return null;
        const clonedAttachmentIds = new Map(attachmentIds.map((id) => [id, randomUUID()]));

        const message = await tx.message.create({
          data: {
            chatId: original.chatId,
            content: rewriteMessageAttachmentIds(editedContent, clonedAttachmentIds),
            modelId: original.modelId,
            parentMessageId: original.parentMessageId,
            provider: original.provider,
            role: original.role,
            status: "complete"
          }
        });

        for (const attachment of attachments) {
          await tx.attachment.create({
            data: {
              byteSize: attachment.byteSize,
              chatId: lockedChat.id,
              checksum: attachment.checksum,
              extractedText: attachment.extractedText,
              fileName: attachment.fileName,
              id: clonedAttachmentIds.get(attachment.id)!,
              kind: attachment.kind,
              messageId: message.id,
              metadata: attachment.metadata === null ? Prisma.JsonNull : json(attachment.metadata),
              mimeType: attachment.mimeType,
              processingErrorCode: attachment.processingErrorCode,
              ...(attachment.status === "processing"
                ? { processingJob: { create: { ownerUserId: userId } } }
                : {}),
              status: attachment.status,
              storageKey: attachment.storageKey,
              userId
            }
          });
        }

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
        // A chat holding an answer review recorded before Answer Review was
        // removed deletes what its reader deletes; any other chat deletes the
        // message's subtree.
        const reviewPlan = await loadAnswerReviewDeletionPlan(tx, lockedChat, root.id);
        if (reviewPlan === null) throw new MessageDeleteConflictError();
        const rootIds = reviewPlan ? reviewPlan.roots : [root.id];

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

        const deletedDepths = new Map<string, number>(rootIds.map((id) => [id, 0]));
        const queue = [...rootIds];
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
        const nextActiveLeafMessageId = reviewPlan ? reviewPlan.leafId
          : activeLeafMessageId && deletedDepths.has(activeLeafMessageId) ? root.parentMessageId : activeLeafMessageId;

        const deletedRunScope: Prisma.ModelRunWhereInput = { chatId: root.chatId,
          OR: [{ assistantMessageId: { in: deletedMessageIds } }, { userMessageId: { in: deletedMessageIds } }] };
        // A background sub-agent of the subtree that started after its stop (the stop runs before this transaction):
        // its run shares a deleted user message, so the deletion waits for it rather than cut it off mid-call.
        const activeSubagentRun = await tx.modelRun.findFirst({ select: { id: true, status: true },
          where: { ...deletedRunScope, status: { in: activeRunStatuses } } });
        if (activeSubagentRun) throw new ActiveMessageMutationConflictError(activeSubagentRun);
        // Release deleted image outputs into ordinary orphan retention before
        // their producer calls/runs disappear. Saved copies retain their objects.
        await tx.attachment.updateMany({
          where: { origin: "IMAGE_OUTPUT", producerModelRun: deletedRunScope },
          data: { imageToolCallId: null, producerModelRunId: null, messageId: null, origin: "USER_UPLOAD" }
        });
        // Workspace exports and checkpoint files hold the same restricting
        // producer reference. Released rows follow orphan retention, whose
        // reference-checked object deletion protects storage keys shared with
        // captures or copies. Their publishers insert with a chat foreign key,
        // which waits for the chat row lock taken above: no new row appears
        // before the runs are deleted, and later inserts lose their producer.
        await tx.attachment.updateMany({
          where: { producerModelRun: deletedRunScope },
          data: { producerModelRunId: null, messageId: null }
        });
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

        // A new active leaf bumps the chat revision; the browser summary
        // adopts it so revision-keyed readers do not chase a lagging copy.
        const { updatedAt: chatUpdatedAt } = await tx.chat.findUniqueOrThrow({
          select: { updatedAt: true },
          where: { id: root.chatId }
        });
        return {
          activeLeafMessageId: nextActiveLeafMessageId,
          chatId: root.chatId,
          chatUpdatedAt,
          deletedMessageIds
        };
      }).catch((error: unknown) => {
        // A restricting reference to a deleted run or message rolls the whole
        // deletion back; report a retryable conflict instead of a server error.
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
          throw new MessageDeleteConflictError();
        }
        throw error;
      })
  };
}
