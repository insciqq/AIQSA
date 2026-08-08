import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaRunRepository } from "../runs/prismaRepository";
import { ActiveLeafConflictError, ActiveRunConflictError } from "../runs/runRepositoryContract";
import { createPrismaChatRepository } from "./prismaRepository";

type FolderUserFixture = {
  fakeProviderConnectionId: string;
  fakeProviderModelId: string;
  userId: string;
};

async function withFolderUser<T>(run: (input: FolderUserFixture) => Promise<T>): Promise<T> {
  const userId = `folder-test-${randomUUID()}`;
  const fakeModel = await prisma.providerModel.findUniqueOrThrow({
    select: {
      connectionId: true,
      id: true
    },
    where: {
      templateKey: "fake:fake-qsa"
    }
  });

  await prisma.user.create({
    data: {
      displayName: "Folder Test User",
      id: userId,
      settings: {
        create: {
          defaultControlValues: {},
          defaultProviderModelId: fakeModel.id,
          defaultSearchStrategyId: "search-disabled"
        }
      }
    }
  });
  await prisma.accessGrant.create({
    data: {
      enabled: true,
      providerModelId: fakeModel.id,
      userId
    }
  });

  try {
    return await run({
      fakeProviderConnectionId: fakeModel.connectionId,
      fakeProviderModelId: fakeModel.id,
      userId
    });
  } finally {
    await prisma.user.deleteMany({
      where: {
        id: userId
      }
    });
  }
}

describe("Prisma chat repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("keeps create and update records summary-only while detail hydrates the thread", async () => {
    await withFolderUser(async ({ fakeProviderConnectionId, fakeProviderModelId, userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const created = await repository.createChat({ title: "Summary chat", userId });

      expect(created).toMatchObject({
        defaultModelId: fakeProviderModelId,
        defaultProvider: fakeProviderConnectionId,
        messageCount: 0,
        pinned: false,
        title: "Summary chat"
      });
      expect(created).not.toHaveProperty("messages");
      expect(created).not.toHaveProperty("usageStats");
      await expect(
        prisma.chat.findUniqueOrThrow({
          select: {
            defaultProviderModelId: true
          },
          where: { id: created?.id ?? "" }
        })
      ).resolves.toEqual({
        defaultProviderModelId: fakeProviderModelId
      });

      const userMessage = await prisma.message.create({
        data: {
          chatId: created?.id ?? "",
          content: textMessageContent("Question"),
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: created?.id ?? "",
          content: textMessageContent("Answer"),
          parentMessageId: userMessage.id,
          role: "assistant",
          status: "complete"
        }
      });
      const updated = await repository.updateChat({
        activeLeafMessageId: assistantMessage.id,
        chatId: created?.id ?? "",
        title: "Updated summary",
        userId
      });

      expect(updated).toMatchObject({
        activeLeafMessageId: assistantMessage.id,
        messageCount: 2,
        pinned: false,
        title: "Updated summary"
      });
      expect(updated).not.toHaveProperty("messages");
      expect(updated).not.toHaveProperty("usageStats");

      await expect(
        repository.getChat({ chatId: created?.id ?? "", userId })
      ).resolves.toMatchObject({
        messageCount: 2,
        messages: [{ id: userMessage.id }, { id: assistantMessage.id }],
        usageStats: {
          activeBranchMessageCount: 2
        }
      });
    });
  });

  it("preserves an absent chat default across create, workspace, and detail reads", async () => {
    await withFolderUser(async ({ userId }) => {
      await prisma.userSettings.update({
        data: {
          defaultProviderModel: {
            disconnect: true
          }
        },
        where: { userId }
      });
      const repository = createPrismaChatRepository(prisma);

      const created = await repository.createChat({ userId });

      expect(created).toMatchObject({
        defaultModelId: null,
        defaultProvider: null
      });
      await expect(
        prisma.chat.findUniqueOrThrow({
          select: {
            defaultProviderModelId: true
          },
          where: { id: created?.id ?? "" }
        })
      ).resolves.toEqual({
        defaultProviderModelId: null
      });
      await expect(repository.listWorkspace(userId)).resolves.toMatchObject({
        chats: [
          {
            defaultModelId: null,
            defaultProvider: null,
            id: created?.id
          }
        ]
      });
      await expect(
        repository.getChat({ chatId: created?.id ?? "", userId })
      ).resolves.toMatchObject({
        defaultModelId: null,
        defaultProvider: null,
        id: created?.id
      });
    });
  });

  it("seeds a new chat from an entitled installation default without copying it personally", async () => {
    await withFolderUser(async ({ fakeProviderConnectionId, fakeProviderModelId, userId }) => {
      const priorPolicy = await prisma.modelPolicy.findUniqueOrThrow({
        select: { defaultProviderModelId: true },
        where: { id: "installation" }
      });
      try {
        await Promise.all([
          prisma.modelPolicy.update({
            data: {
              defaultProviderModelId: fakeProviderModelId,
              version: { increment: 1 }
            },
            where: { id: "installation" }
          }),
          prisma.userSettings.update({
            data: { defaultProviderModelId: null },
            where: { userId }
          })
        ]);

        const created = await createPrismaChatRepository(prisma).createChat({ userId });
        expect(created).toMatchObject({
          defaultModelId: fakeProviderModelId,
          defaultProvider: fakeProviderConnectionId
        });
        await expect(prisma.userSettings.findUniqueOrThrow({
          select: { defaultProviderModelId: true },
          where: { userId }
        })).resolves.toEqual({ defaultProviderModelId: null });
      } finally {
        await prisma.modelPolicy.update({
          data: {
            defaultProviderModelId: priorPolicy.defaultProviderModelId,
            version: { increment: 1 }
          },
          where: { id: "installation" }
        });
      }
    });
  });

  it("allows the same folder name below different parents", async () => {
    await withFolderUser(async ({ userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const clientA = await repository.createFolder({
        name: "Client A",
        userId
      });
      const clientB = await repository.createFolder({
        name: "Client B",
        userId
      });

      expect(clientA).not.toBeNull();
      expect(clientB).not.toBeNull();

      const researchA = await repository.createFolder({
        name: "Research",
        parentId: clientA?.id,
        userId
      });
      const researchB = await repository.createFolder({
        name: "Research",
        parentId: clientB?.id,
        userId
      });

      expect(researchA).toMatchObject({
        name: "Research",
        parentId: clientA?.id
      });
      expect(researchB).toMatchObject({
        name: "Research",
        parentId: clientB?.id
      });
      expect(researchA?.id).not.toBe(researchB?.id);
    });
  });

  it("rejects duplicate folder names within the same parent and at top level", async () => {
    await withFolderUser(async ({ userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const firstTopLevel = await repository.createFolder({
        name: "Research",
        userId
      });
      const duplicateTopLevel = await repository.createFolder({
        name: "Research",
        userId
      });
      const parent = await repository.createFolder({
        name: "Client",
        userId
      });
      const firstChild = await repository.createFolder({
        name: "Notes",
        parentId: parent?.id,
        userId
      });
      const duplicateChild = await repository.createFolder({
        name: "Notes",
        parentId: parent?.id,
        userId
      });

      expect(firstTopLevel).not.toBeNull();
      expect(duplicateTopLevel).toBeNull();
      expect(firstChild).not.toBeNull();
      expect(duplicateChild).toBeNull();
    });
  });

  it("rejects renaming or moving folders into a sibling-name conflict", async () => {
    await withFolderUser(async ({ userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const alpha = await repository.createFolder({
        name: "Alpha",
        userId
      });
      const beta = await repository.createFolder({
        name: "Beta",
        userId
      });
      const renameConflict = await repository.updateFolder({
        folderId: beta?.id ?? "",
        name: "Alpha",
        userId
      });
      const clientA = await repository.createFolder({
        name: "Client A",
        userId
      });
      const clientB = await repository.createFolder({
        name: "Client B",
        userId
      });
      const researchA = await repository.createFolder({
        name: "Research",
        parentId: clientA?.id,
        userId
      });
      const researchB = await repository.createFolder({
        name: "Research",
        parentId: clientB?.id,
        userId
      });
      const moveConflict = await repository.updateFolder({
        folderId: researchA?.id ?? "",
        parentId: clientB?.id,
        userId
      });

      expect(alpha).not.toBeNull();
      expect(beta).not.toBeNull();
      expect(renameConflict).toBeNull();
      expect(researchA).not.toBeNull();
      expect(researchB).not.toBeNull();
      expect(moveConflict).toBeNull();
    });
  });

  it("rejects folder moves that would create a parent cycle", async () => {
    await withFolderUser(async ({ userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const parent = await repository.createFolder({
        name: "Parent",
        userId
      });
      const child = await repository.createFolder({
        name: "Child",
        parentId: parent?.id,
        userId
      });
      const cycle = await repository.updateFolder({
        folderId: parent?.id ?? "",
        parentId: child?.id,
        userId
      });

      expect(parent).not.toBeNull();
      expect(child).not.toBeNull();
      expect(cycle).toBeNull();
    });
  });

  it("hydrates token usage stats from the active branch only", async () => {
    await withFolderUser(async ({ fakeProviderModelId, userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: fakeProviderModelId,
          title: "Usage chat",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Question"),
          role: "user",
          status: "complete"
        }
      });
      const activeAssistant = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Active answer"),
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "complete"
        }
      });
      const siblingAssistant = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Sibling answer"),
          modelId: "fake-qsa",
          parentMessageId: userMessage.id,
          provider: "fake",
          role: "assistant",
          status: "complete"
        }
      });

      await prisma.chat.update({
        data: {
          activeLeafMessageId: activeAssistant.id
        },
        where: {
          id: chat.id
        }
      });
      await prisma.modelRun.createMany({
        data: [
          {
            assistantMessageId: activeAssistant.id,
            cachedInputTokens: 3,
            chatId: chat.id,
            inputTokens: 7,
            modelId: "fake-qsa",
            normalizedRequest: {},
            outputTokens: 5,
            provider: "fake",
            providerRequestPreview: {},
            reasoningTokens: 1,
            status: "complete",
            totalTokens: 0,
            userId,
            userMessageId: userMessage.id
          },
          {
            assistantMessageId: siblingAssistant.id,
            cachedInputTokens: 999,
            chatId: chat.id,
            inputTokens: 999,
            modelId: "fake-qsa",
            normalizedRequest: {},
            outputTokens: 999,
            provider: "fake",
            providerRequestPreview: {},
            reasoningTokens: 0,
            status: "complete",
            totalTokens: 999,
            userId,
            userMessageId: userMessage.id
          }
        ]
      });

      const detail = await repository.getChat({ chatId: chat.id, userId });

      expect(detail).toMatchObject({
        usageStats: {
          activeBranchMessageCount: 2,
          cachedInputTokens: 3,
          totalTokens: 12
        }
      });
      expect(detail?.messages).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: activeAssistant.id,
          runUsage: { totalTokens: 12 }
        }),
        expect.objectContaining({
          id: siblingAssistant.id,
          runUsage: { totalTokens: 999 }
        })
      ]));
    });
  });

  it("blocks active-leaf checkout and archive while allowing non-branch metadata updates during a run", async () => {
    await withFolderUser(async ({ fakeProviderModelId, userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: fakeProviderModelId,
          title: "Active mutation gate",
          userId
        }
      });
      const userMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Question"),
          role: "user",
          status: "complete"
        }
      });
      const assistantMessage = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent(""),
          parentMessageId: userMessage.id,
          role: "assistant",
          status: "streaming"
        }
      });
      await prisma.chat.update({
        data: {
          activeLeafMessageId: assistantMessage.id
        },
        where: {
          id: chat.id
        }
      });
      await prisma.modelRun.create({
        data: {
          assistantMessageId: assistantMessage.id,
          chatId: chat.id,
          modelId: "fake-qsa",
          normalizedRequest: {},
          provider: "fake",
          providerRequestPreview: {},
          status: "streaming",
          userId,
          userMessageId: userMessage.id
        }
      });

      await expect(
        repository.updateChat({
          activeLeafMessageId: userMessage.id,
          chatId: chat.id,
          userId
        })
      ).rejects.toBeInstanceOf(ActiveRunConflictError);
      await expect(repository.archiveChat({ chatId: chat.id, userId })).rejects.toBeInstanceOf(
        ActiveRunConflictError
      );
      await expect(
        repository.updateChat({
          chatId: chat.id,
          pinned: true,
          title: "Metadata remains editable",
          userId
        })
      ).resolves.toMatchObject({
        activeLeafMessageId: assistantMessage.id,
        pinned: true,
        title: "Metadata remains editable"
      });
      await expect(
        prisma.chat.findUniqueOrThrow({
          select: {
            activeLeafMessageId: true,
            archived: true
          },
          where: {
            id: chat.id
          }
        })
      ).resolves.toEqual({
        activeLeafMessageId: assistantMessage.id,
        archived: false
      });
    });
  });

  it("serializes concurrent archive and prepared run creation without an archived active run", async () => {
    await withFolderUser(async ({
      fakeProviderConnectionId,
      fakeProviderModelId,
      userId
    }) => {
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: fakeProviderModelId,
          title: "Archive versus run",
          userId
        }
      });
      const content = textMessageContent("Prepared before archive");
      const runRepository = createPrismaRunRepository(prisma);
      const chatRepository = createPrismaChatRepository(prisma);

      const [runResult, archiveResult] = await Promise.allSettled([
        runRepository.createRun({
          chatId: chat.id,
          content,
          defaults: {
            controlDefaults: {},
            modelId: fakeProviderModelId,
            provider: fakeProviderConnectionId,
            searchStrategy: "search-disabled",
            userId
          },
          expectedActiveLeafId: null,
          modelId: "fake-qsa",
          normalizedRequest: {
            attachmentIds: [],
            chatId: chat.id,
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
          userId
        }),
        chatRepository.archiveChat({ chatId: chat.id, userId })
      ]);
      const stored = await prisma.chat.findUniqueOrThrow({
        select: {
          _count: {
            select: {
              messages: true,
              modelRuns: true
            }
          },
          archived: true,
          modelRuns: {
            select: { status: true }
          }
        },
        where: { id: chat.id }
      });

      if (runResult.status === "fulfilled") {
        expect(archiveResult.status).toBe("rejected");
        expect(archiveResult.status === "rejected" ? archiveResult.reason : null).toBeInstanceOf(
          ActiveRunConflictError
        );
        expect(stored).toMatchObject({
          _count: { messages: 2, modelRuns: 1 },
          archived: false,
          modelRuns: [{ status: "streaming" }]
        });
      } else {
        expect(runResult.reason).toBeInstanceOf(ActiveLeafConflictError);
        expect(archiveResult).toEqual({ status: "fulfilled", value: true });
        expect(stored).toMatchObject({
          _count: { messages: 0, modelRuns: 0 },
          archived: true,
          modelRuns: []
        });
      }

      expect(stored.archived && stored.modelRuns.some((run) => run.status === "streaming")).toBe(false);
    });
  });
});
