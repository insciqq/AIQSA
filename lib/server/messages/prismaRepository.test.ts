import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { ActiveLeafConflictError, type RunRepository } from "../runs/runRepositoryContract";
import { createPrismaRetentionRepository } from "../retention/prune";
import { ActiveMessageMutationConflictError } from "./handlers";
import { createPrismaMessageBranchRepository } from "./prismaRepository";

async function withMessageBranchUser<T>(run: (input: { userId: string }) => Promise<T>): Promise<T> {
  const userId = `message-branch-test-${randomUUID()}`;

  await prisma.user.create({
    data: {
      displayName: "Message Branch Test User",
      id: userId,
      settings: {
        create: {
          defaultControlValues: {},
          defaultProviderModelId: providerTemplateIds.fakeModel,
          defaultSearchStrategyId: "search-disabled"
        }
      }
    }
  });

  try {
    return await run({ userId });
  } finally {
    await prisma.user.deleteMany({
      where: {
        id: userId
      }
    });
  }
}

function createRunInput(input: {
  chatId: string;
  expectedActiveLeafId: string | null;
  userId: string;
}): Parameters<RunRepository["createRun"]>[0] {
  const content = textMessageContent("Concurrent send");

  return {
    chatId: input.chatId,
    content,
    defaults: {
      controlDefaults: {},
      modelId: providerTemplateIds.fakeModel,
      provider: providerTemplateIds.fakeConnection,
      searchStrategy: "search-disabled",
      userId: input.userId
    },
    expectedActiveLeafId: input.expectedActiveLeafId,
    modelId: "fake-qsa",
    normalizedRequest: {
      attachmentIds: [],
      chatId: input.chatId,
      content,
      modelCapabilities: {
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        vision: false
      },
      modelId: "fake-qsa",
      params: {},
      prompt: {
        developer: null,
        system: null
      },
      provider: "fake",
      searchStrategy: "search-disabled"
    },
    provider: "fake",
    providerRequestPreview: {},
    userId: input.userId
  };
}

function referencedAttachmentIds(content: unknown): string[] {
  if (typeof content !== "object" || content === null || !("blocks" in content)) {
    return [];
  }

  const blocks = (content as { blocks?: unknown }).blocks;
  return Array.isArray(blocks)
    ? blocks.flatMap((block) =>
        typeof block === "object" &&
        block !== null &&
        "attachmentId" in block &&
        typeof block.attachmentId === "string"
          ? [block.attachmentId]
          : []
      )
    : [];
}

describe("Prisma message branch repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("rejects edit, branch, and delete while the chat has an active run", async () => {
    await withMessageBranchUser(async ({ userId }) => {
      const sourceChat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Source chat",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Question", type: "text" }]
          },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Partial", type: "text" }]
          },
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "streaming"
        }
      });
      await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId: sourceChat.id,
          modelId: "fake-qsa",
          normalizedRequest: {},
          provider: "fake",
          status: "streaming",
          userId,
          userMessageId: userMessage.id
        }
      });
      const repository = createPrismaMessageBranchRepository(prisma);

      await expect(
        repository.createEditedMessageBranch({
          content: {
            blocks: [{ text: "Edited question", type: "text" }]
          },
          originalMessageId: userMessage.id,
          userId
        })
      ).rejects.toBeInstanceOf(ActiveMessageMutationConflictError);
      await expect(
        repository.createChatBranchFromMessage({
          sourceMessageId: assistantMessage.id,
          userId
        })
      ).rejects.toBeInstanceOf(ActiveMessageMutationConflictError);
      await expect(
        repository.deleteMessageSubtree({
          messageId: userMessage.id,
          userId
        })
      ).rejects.toBeInstanceOf(ActiveMessageMutationConflictError);

      await expect(
        prisma.message.count({
          where: {
            chatId: sourceChat.id
          }
        })
      ).resolves.toBe(2);
      await expect(
        prisma.modelRun.count({
          where: {
            chatId: sourceChat.id,
            status: "streaming"
          }
        })
      ).resolves.toBe(1);
    });
  });

  it("settles message mutations behind a run that wins the chat lock", async () => {
    await withMessageBranchUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Run wins",
          userId
        }
      });
      const root = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Root"),
          role: "user",
          status: "complete"
        }
      });
      const selected = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Selected answer"),
          modelId: "fake-qsa",
          parentMessageId: root.id,
          provider: "fake",
          role: "assistant",
          status: "complete"
        }
      });
      const sideBranch = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Side branch"),
          parentMessageId: root.id,
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: selected.id },
        where: { id: chat.id }
      });

      const repository = createPrismaMessageBranchRepository(prisma);
      let mutations: Promise<unknown>[] = [];
      let streamingAssistantId = "";

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "Chat"
          WHERE "id" = ${chat.id}
          FOR UPDATE
        `;
        mutations = [
          repository.createEditedMessageBranch({
            content: textMessageContent("Edited while run starts"),
            originalMessageId: selected.id,
            userId
          }),
          repository.createChatBranchFromMessage({
            sourceMessageId: selected.id,
            userId
          }),
          repository.deleteMessageSubtree({
            messageId: sideBranch.id,
            userId
          })
        ];
        for (const mutation of mutations) {
          void mutation.catch(() => undefined);
        }

        const runUserMessage = await tx.message.create({
          data: {
            chatId: chat.id,
            content: textMessageContent("Run question"),
            parentMessageId: selected.id,
            role: "user",
            status: "complete"
          }
        });
        const streamingAssistant = await tx.message.create({
          data: {
            chatId: chat.id,
            content: textMessageContent(""),
            modelId: "fake-qsa",
            parentMessageId: runUserMessage.id,
            provider: "fake",
            role: "assistant",
            status: "streaming"
          }
        });
        streamingAssistantId = streamingAssistant.id;
        await tx.modelRun.create({
          data: {
            assistantMessageId: streamingAssistant.id,
            chatId: chat.id,
            modelId: "fake-qsa",
            normalizedRequest: {},
            provider: "fake",
            status: "streaming",
            userId,
            userMessageId: runUserMessage.id
          }
        });
        await tx.chat.update({
          data: { activeLeafMessageId: streamingAssistant.id },
          where: { id: chat.id }
        });
      });

      for (const mutation of mutations) {
        await expect(mutation).rejects.toBeInstanceOf(ActiveMessageMutationConflictError);
      }
      await expect(
        prisma.chat.findUniqueOrThrow({
          select: { activeLeafMessageId: true },
          where: { id: chat.id }
        })
      ).resolves.toEqual({ activeLeafMessageId: streamingAssistantId });
      await expect(prisma.message.findUnique({ where: { id: sideBranch.id } })).resolves.not.toBeNull();
    });
  });

  it("makes a waiting run observe the leaf committed by a chat mutation", async () => {
    await withMessageBranchUser(async ({ userId }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Mutation wins",
          userId
        }
      });
      const original = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Original"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: original.id },
        where: { id: chat.id }
      });
      const runRepository = createPrismaRunRepository(prisma);
      let waitingRun: ReturnType<RunRepository["createRun"]> | undefined;
      let editedId = "";

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "Chat"
          WHERE "id" = ${chat.id}
          FOR UPDATE
        `;
        waitingRun = runRepository.createRun(
          createRunInput({
            chatId: chat.id,
            expectedActiveLeafId: original.id,
            userId
          })
        );
        const edited = await tx.message.create({
          data: {
            chatId: chat.id,
            content: textMessageContent("Edited"),
            parentMessageId: null,
            role: "user",
            status: "complete"
          }
        });
        editedId = edited.id;
        await tx.chat.update({
          data: { activeLeafMessageId: edited.id },
          where: { id: chat.id }
        });
      });

      await expect(waitingRun).rejects.toBeInstanceOf(ActiveLeafConflictError);
      await expect(
        prisma.chat.findUniqueOrThrow({
          select: { activeLeafMessageId: true },
          where: { id: chat.id }
        })
      ).resolves.toEqual({ activeLeafMessageId: editedId });
      await expect(prisma.modelRun.count({ where: { chatId: chat.id } })).resolves.toBe(0);
    });
  });

  it("does not serialize message mutations across different chats", async () => {
    await withMessageBranchUser(async ({ userId }) => {
      const [chatA, chatB] = await Promise.all(
        ["A", "B"].map((suffix) =>
          prisma.chat.create({
            data: {
              defaultProviderModelId: providerTemplateIds.fakeModel,
              title: `Chat ${suffix}`,
              userId
            }
          })
        )
      );
      const messageB = await prisma.message.create({
        data: {
          chatId: chatB!.id,
          content: textMessageContent("Chat B message"),
          role: "user",
          status: "complete"
        }
      });
      const repository = createPrismaMessageBranchRepository(prisma);

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "Chat"
          WHERE "id" = ${chatA!.id}
          FOR UPDATE
        `;
        await expect(
          repository.createEditedMessageBranch({
            content: textMessageContent("Chat B edited"),
            originalMessageId: messageB.id,
            userId
          })
        ).resolves.toMatchObject({
          chatId: chatB!.id,
          role: "user",
          status: "complete"
        });
      });
    });
  });

  it.each(["queued", "streaming"] as const)("rejects branching from a %s message even without a live run row", async (status) => {
    await withMessageBranchUser(async ({ userId }) => {
      const sourceChat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Source chat",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Question", type: "text" }]
          },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Partial answer", type: "text" }]
          },
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status
        }
      });
      const repository = createPrismaMessageBranchRepository(prisma);

      await expect(
        repository.createChatBranchFromMessage({
          sourceMessageId: assistantMessage.id,
          userId
        })
      ).rejects.toBeInstanceOf(ActiveMessageMutationConflictError);
      await expect(
        prisma.chat.count({
          where: {
            userId
          }
        })
      ).resolves.toBe(1);
    });
  });

  it.each(["complete", "error", "cancelled"] as const)("allows deleting message subtrees with %s model runs", async (status) => {
    await withMessageBranchUser(async ({ userId }) => {
      const sourceChat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Source chat",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Question", type: "text" }]
          },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Answer", type: "text" }]
          },
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status
        }
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: assistantMessage.id
        },
        where: {
          id: sourceChat.id
        }
      });
      await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId: sourceChat.id,
          modelId: "fake-qsa",
          normalizedRequest: {},
          provider: "fake",
          status,
          userId,
          userMessageId: userMessage.id
        }
      });
      const repository = createPrismaMessageBranchRepository(prisma);

      const deleted = await repository.deleteMessageSubtree({
        messageId: userMessage.id,
        userId
      });

      expect(deleted).toMatchObject({
        activeLeafMessageId: null,
        chatId: sourceChat.id,
        deletedMessageIds: expect.arrayContaining([userMessage.id, assistantMessage.id])
      });
      await expect(
        prisma.modelRun.count({
          where: {
            chatId: sourceChat.id
          }
        })
      ).resolves.toBe(0);
      await expect(
        prisma.message.count({
          where: {
            chatId: sourceChat.id
          }
        })
      ).resolves.toBe(0);
    });
  });

  it("allows editing an assistant message after a terminal error run", async () => {
    await withMessageBranchUser(async ({ userId }) => {
      const sourceChat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Source chat",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Question", type: "text" }]
          },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Error answer", type: "text" }]
          },
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "error"
        }
      });
      await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId: sourceChat.id,
          modelId: "fake-qsa",
          normalizedRequest: {},
          provider: "fake",
          status: "error",
          userId,
          userMessageId: userMessage.id
        }
      });
      const repository = createPrismaMessageBranchRepository(prisma);

      const edited = await repository.createEditedMessageBranch({
        content: {
          blocks: [{ text: "Edited answer", type: "text" }]
        },
        originalMessageId: assistantMessage.id,
        userId
      });

      expect(edited).toMatchObject({
        chatId: sourceChat.id,
        parentMessageId: userMessage.id,
        role: "assistant",
        status: "complete"
      });
    });
  });

  it("copies input, output, and reasoning token metadata into branch chats", async () => {
    await withMessageBranchUser(async ({ userId }) => {
      const sourceChat = await prisma.chat.create({
        data: {
          title: "Source chat",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Question", type: "text" }]
          },
          inputTokens: 11,
          outputTokens: 0,
          reasoningTokens: 0,
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Answer", type: "text" }]
          },
          inputTokens: 13,
          modelId: "fake-qsa",
          outputTokens: 17,
          parentMessageId: userMessage.id,
          provider: "fake",
          reasoningTokens: 19,
          role: "assistant",
          status: "complete"
        }
      });

      const repository = createPrismaMessageBranchRepository(prisma);
      const branched = await repository.createChatBranchFromMessage({
        sourceMessageId: assistantMessage.id,
        userId
      });

      expect(branched).toMatchObject({
        activeLeafMessageId: expect.any(String),
        defaultModelId: null,
        defaultProvider: null,
        messageCount: 2,
        pinned: false
      });
      expect(branched).not.toHaveProperty("messages");
      expect(branched).not.toHaveProperty("usageStats");
      const clonedAssistant = await prisma.message.findFirstOrThrow({
        select: {
          inputTokens: true,
          outputTokens: true,
          reasoningTokens: true
        },
        where: {
          chatId: branched?.id,
          role: "assistant"
        }
      });

      expect(clonedAssistant).toEqual({
        inputTokens: 13,
        outputTokens: 17,
        reasoningTokens: 19
      });
    });
  });

  it("clones ancestor attachments and keeps shared objects runnable after source retention", async () => {
    await withMessageBranchUser(async ({ userId }) => {
      const imageId = randomUUID();
      const documentId = randomUUID();
      const imageStorageKey = `${userId}/branch-image-${randomUUID()}`;
      const documentStorageKey = `${userId}/branch-document-${randomUUID()}`;
      const sourceChat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Attachment source",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [
              { text: "Inspect this image", type: "text" },
              { alt: "diagram", attachmentId: imageId, type: "image" }
            ]
          },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [
              { text: "Use this document next", type: "text" },
              { attachmentId: documentId, fileName: "brief.pdf", type: "file" }
            ]
          },
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "complete"
        }
      });
      await prisma.attachment.createMany({
        data: [
          {
            byteSize: 17,
            chatId: sourceChat.id,
            checksum: "image-checksum",
            createdAt: new Date("2000-01-01T00:00:00.000Z"),
            fileName: "diagram.png",
            id: imageId,
            kind: "image",
            messageId: userMessage.id,
            metadata: { width: 10 },
            mimeType: "image/png",
            status: "ready",
            storageKey: imageStorageKey,
            userId
          },
          {
            byteSize: 23,
            chatId: sourceChat.id,
            checksum: "document-checksum",
            createdAt: new Date("2000-01-01T00:00:00.000Z"),
            extractedText: "Document text",
            fileName: "brief.pdf",
            id: documentId,
            kind: "pdf",
            messageId: assistantMessage.id,
            metadata: { pages: 1 },
            mimeType: "application/pdf",
            status: "ready",
            storageKey: documentStorageKey,
            userId
          }
        ]
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: assistantMessage.id },
        where: { id: sourceChat.id }
      });
      const repository = createPrismaMessageBranchRepository(prisma);

      try {
        const branched = await repository.createChatBranchFromMessage({
          sourceMessageId: assistantMessage.id,
          userId
        });
        expect(branched).toMatchObject({ messageCount: 2 });
        if (!branched) {
          throw new Error("branch_not_created");
        }

        const clonedMessages = await prisma.message.findMany({
          where: { chatId: branched.id }
        });
        const clonedUser = clonedMessages.find((message) => message.role === "user");
        const clonedAssistant = clonedMessages.find((message) => message.role === "assistant");
        const clonedImageId = referencedAttachmentIds(clonedUser?.content).at(0);
        const clonedDocumentId = referencedAttachmentIds(clonedAssistant?.content).at(0);
        expect(clonedImageId).toEqual(expect.any(String));
        expect(clonedDocumentId).toEqual(expect.any(String));
        expect([clonedImageId, clonedDocumentId]).not.toContain(imageId);
        expect([clonedImageId, clonedDocumentId]).not.toContain(documentId);

        const clonedAttachments = await prisma.attachment.findMany({
          orderBy: { storageKey: "asc" },
          where: {
            id: { in: [clonedImageId!, clonedDocumentId!] }
          }
        });
        expect(clonedAttachments).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              chatId: branched.id,
              id: clonedImageId,
              messageId: clonedUser?.id,
              storageKey: imageStorageKey,
              userId
            }),
            expect.objectContaining({
              chatId: branched.id,
              extractedText: "Document text",
              id: clonedDocumentId,
              messageId: clonedAssistant?.id,
              storageKey: documentStorageKey,
              userId
            })
          ])
        );

        await repository.deleteMessageSubtree({
          messageId: userMessage.id,
          userId
        });
        const staged = await createPrismaRetentionRepository(prisma).stageOrphanedAttachments({
          cutoff: new Date(),
          limit: 10
        });

        expect(staged).toMatchObject({
          jobsStaged: 0,
          matched: 2,
          rowsDeleted: 2,
          sharedRowsDeleted: 2
        });
        await expect(
          createPrismaRunRepository(prisma).loadAttachments(userId, [
            clonedImageId!,
            clonedDocumentId!
          ])
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({ id: clonedImageId, storageKey: imageStorageKey }),
            expect.objectContaining({ id: clonedDocumentId, storageKey: documentStorageKey })
          ])
        );
      } finally {
        await prisma.attachmentDeletionJob.deleteMany({
          where: {
            storageKey: { in: [imageStorageKey, documentStorageKey] }
          }
        });
      }
    });
  });

  it.each(["missing", "other-chat"] as const)(
    "rolls back a branch with a %s attachment reference",
    async (referenceKind) => {
      await withMessageBranchUser(async ({ userId }) => {
        const sourceChat = await prisma.chat.create({
          data: {
            defaultProviderModelId: providerTemplateIds.fakeModel,
            title: "Invalid attachment source",
            userId
          }
        });
        let attachmentId: string = randomUUID();
        if (referenceKind === "other-chat") {
          const otherChat = await prisma.chat.create({
            data: {
              defaultProviderModelId: providerTemplateIds.fakeModel,
              title: "Other chat",
              userId
            }
          });
          const otherMessage = await prisma.message.create({
            data: {
              chatId: otherChat.id,
              content: textMessageContent("Other message"),
              role: "user",
              status: "complete"
            }
          });
          const otherAttachment = await prisma.attachment.create({
            data: {
              byteSize: 5,
              chatId: otherChat.id,
              fileName: "other.txt",
              kind: "document",
              messageId: otherMessage.id,
              metadata: {},
              mimeType: "text/plain",
              status: "ready",
              storageKey: `${userId}/other-${randomUUID()}`,
              userId
            }
          });
          attachmentId = otherAttachment.id;
        }
        const sourceMessage = await prisma.message.create({
          data: {
            chatId: sourceChat.id,
            content: {
              blocks: [{ attachmentId, fileName: "missing.txt", type: "file" }]
            },
            role: "user",
            status: "complete"
          }
        });
        const chatCountBefore = await prisma.chat.count({ where: { userId } });

        await expect(
          createPrismaMessageBranchRepository(prisma).createChatBranchFromMessage({
            sourceMessageId: sourceMessage.id,
            userId
          })
        ).rejects.toThrow("branch_attachment_clone_failed");
        await expect(prisma.chat.count({ where: { userId } })).resolves.toBe(chatCountBefore);
      });
    }
  );

  it("edits an assistant message by creating a same-parent sibling branch", async () => {
    await withMessageBranchUser(async ({ userId }) => {
      const sourceChat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          title: "Source chat",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Question", type: "text" }]
          },
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Answer", type: "text" }]
          },
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "complete"
        }
      });
      const descendant = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: {
            blocks: [{ text: "Follow-up", type: "text" }]
          },
          parentMessageId: assistantMessage.id,
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: descendant.id
        },
        where: {
          id: sourceChat.id
        }
      });

      const repository = createPrismaMessageBranchRepository(prisma);
      const edited = await repository.createEditedMessageBranch({
        content: {
          blocks: [{ text: "Edited answer", type: "text" }]
        },
        originalMessageId: assistantMessage.id,
        userId
      });

      expect(edited).toMatchObject({
        chatId: sourceChat.id,
        parentMessageId: userMessage.id,
        role: "assistant",
        status: "complete"
      });
      expect(edited?.id).not.toBe(assistantMessage.id);
      await expect(
        prisma.chat.findUniqueOrThrow({
          select: {
            activeLeafMessageId: true
          },
          where: {
            id: sourceChat.id
          }
        })
      ).resolves.toEqual({
        activeLeafMessageId: edited?.id
      });
      await expect(
        prisma.message.findUniqueOrThrow({
          select: {
            parentMessageId: true
          },
          where: {
            id: descendant.id
          }
        })
      ).resolves.toEqual({
        parentMessageId: assistantMessage.id
      });
    });
  });
});
