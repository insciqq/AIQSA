import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { boundedChatBranchPreview } from "../../contracts/chats";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memory";
import { textMessageContent } from "../../domain/content";
import { estimateApproxTokens } from "../../domain/contextBudget";
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

  it("bounds active history pages while retaining full-DAG counts, context, and branches", async () => {
    await withFolderUser(async ({ fakeProviderModelId, userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: fakeProviderModelId,
          title: "Long branch",
          userId
        }
      });
      const ids = Array.from({ length: 55 }, (_, index) => `history-${randomUUID()}-${index}`);
      await prisma.message.createMany({
        data: ids.map((id, index) => ({
          chatId: chat.id,
          content: textMessageContent(`Message ${index}`),
          id,
          parentMessageId: index === 0 ? null : ids[index - 1],
          role: index % 2 === 0 ? "user" : "assistant",
          status: "complete" as const
        }))
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: ids.at(-1) },
        where: { id: chat.id }
      });

      const detail = await repository.getChat({ chatId: chat.id, userId });
      expect(detail).toMatchObject({
        contextStats: { approximateActiveBranchInputTokens: expect.any(Number) },
        messageCount: 55,
        pageInfo: {
          activeLeafMessageId: ids.at(-1),
          beforeCursor: expect.any(String),
          hasOlder: true
        },
        usageStats: { activeBranchMessageCount: 55 }
      });
      expect(detail?.contextStats.approximateActiveBranchInputTokens).toBeGreaterThan(0);
      expect(detail?.messages.map(({ id }) => id)).toEqual(ids.slice(5));

      const older = await repository.getMessagesPage({
        before: detail?.pageInfo.beforeCursor ?? "",
        chatId: chat.id,
        userId
      });
      expect(older).toMatchObject({
        kind: "ok",
        page: { pageInfo: { beforeCursor: null, hasOlder: false } }
      });
      if (older.kind === "ok") {
        expect(older.page.messages.map(({ id }) => id)).toEqual(ids.slice(0, 5));
      }
      await expect(repository.getMessagesPage({
        before: detail?.pageInfo.beforeCursor ?? "",
        chatId: chat.id,
        userId: `foreign-${userId}`
      })).resolves.toEqual({ kind: "not_found" });
      await expect(repository.getBranches({
        chatId: chat.id,
        userId: `foreign-${userId}`
      })).resolves.toBeNull();
      await expect(repository.getMessagesPage({
        before: "malformed!",
        chatId: chat.id,
        userId
      })).resolves.toEqual({ kind: "cursor_invalid" });

      const sibling = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Sibling plaintext preview"),
          parentMessageId: ids[0],
          role: "assistant",
          status: "error"
        }
      });
      const graph = await repository.getBranches({ chatId: chat.id, userId });
      expect(graph?.nodes).toHaveLength(56);
      expect(graph?.nodes).toContainEqual(expect.objectContaining({
        id: sibling.id,
        parentMessageId: ids[0],
        preview: "Sibling plaintext preview"
      }));

      await prisma.chat.update({
        data: { updatedAt: new Date(Date.now() + 60_000) },
        where: { id: chat.id }
      });
      await expect(repository.getMessagesPage({
        before: detail?.pageInfo.beforeCursor ?? "",
        chatId: chat.id,
        userId
      })).resolves.toEqual({ kind: "stale" });
    });
  });

  it("matches the shared estimator across text and non-text blocks and bounds emoji previews", async () => {
    await withFolderUser(async ({ fakeProviderModelId, userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: fakeProviderModelId,
          title: "Projected context estimator",
          userId
        }
      });
      const text = `Привет ${"😀".repeat(100)}`;
      const content = {
        blocks: [
          { text, type: "text" },
          {
            attachmentId: `attachment-${"ascii".repeat(80)}`,
            type: "attachment"
          }
        ]
      };
      const message = await prisma.message.create({
        data: {
          chatId: chat.id,
          content,
          role: "user"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: message.id },
        where: { id: chat.id }
      });

      const detail = await repository.getChat({ chatId: chat.id, userId });
      const graph = await repository.getBranches({ chatId: chat.id, userId });
      const preview = graph?.nodes.find((node) => node.id === message.id)?.preview;

      expect(detail?.contextStats.approximateActiveBranchInputTokens).toBe(
        estimateApproxTokens(content)
      );
      expect(preview).toBe(boundedChatBranchPreview(text));
      expect(preview?.length).toBeLessThanOrEqual(160);
      expect(preview?.endsWith("\ud83d")).toBe(false);
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

  it("routes chat moves and folder deletion through source metadata fencing", async () => {
    await withFolderUser(async ({ fakeProviderModelId, userId }) => {
      const ownerLifecycle = vi.fn(async () => undefined);
      const repository = createPrismaChatRepository(prisma, {
        memorySourceHooks: { onScopedTargetOwnerLifecycle: ownerLifecycle }
      });
      const [folderA, folderB] = await Promise.all([
        repository.createFolder({ name: "Source A", userId }),
        repository.createFolder({ name: "Source B", userId })
      ]);
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: fakeProviderModelId,
          folderId: folderA?.id,
          title: "Movable source",
          userId
        }
      });
      const message = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Retained source"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: message.id },
        where: { id: chat.id }
      });

      await expect(repository.updateChat({
        chatId: chat.id,
        folderId: folderB?.id,
        userId
      })).resolves.toMatchObject({ folderId: folderB?.id });
      await expect(Promise.all([
        prisma.chat.findUniqueOrThrow({
          select: {
            folderId: true,
            memoryBranchGeneration: true,
            memorySourceRevision: true
          },
          where: { id: chat.id }
        }),
        prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryGeneration: true, memoryRevision: true },
          where: { userId }
        })
      ])).resolves.toEqual([
        {
          folderId: folderB?.id,
          memoryBranchGeneration: 0,
          memorySourceRevision: 1
        },
        { memoryGeneration: 0, memoryRevision: 1 }
      ]);

      await expect(repository.deleteFolder({
        folderId: folderB?.id ?? "",
        userId
      })).resolves.toBe(true);
      expect(ownerLifecycle).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
        kind: "FOLDER_DELETE",
        sourceSnapshots: [expect.objectContaining({ id: chat.id, folderId: null })],
        targetId: folderB?.id,
        userId
      }));
      await expect(Promise.all([
        prisma.chat.findUniqueOrThrow({
          select: {
            folderId: true,
            memoryBranchGeneration: true,
            memorySourceRevision: true
          },
          where: { id: chat.id }
        }),
        prisma.userMemorySettings.findUniqueOrThrow({
          select: { memoryGeneration: true, memoryRevision: true },
          where: { userId }
        })
      ])).resolves.toEqual([
        { folderId: null, memoryBranchGeneration: 0, memorySourceRevision: 2 },
        { memoryGeneration: 0, memoryRevision: 2 }
      ]);
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
        })
      ]));
      expect(detail?.messages).not.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: siblingAssistant.id })
      ]));
      await expect(repository.getBranches({ chatId: chat.id, userId })).resolves.toMatchObject({
        nodes: expect.arrayContaining([
          expect.objectContaining({ id: siblingAssistant.id, preview: "Sibling answer" })
        ])
      });
    });
  });

  it.each(["preparing", "streaming"] as const)(
    "blocks active-leaf checkout and archive while allowing non-branch metadata updates during a %s run",
    async (runStatus) => {
    await withFolderUser(async ({ fakeProviderConnectionId, fakeProviderModelId, userId }) => {
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
      let activeAssistantMessageId = assistantMessage.id;
      if (runStatus === "preparing") {
        const content = textMessageContent("Preparing gate");
        const admitted = await createPrismaRunRepository(prisma).admitPreparingRun({
          admissionKind: "NORMAL_SEND",
          chatId: chat.id,
          content,
          defaults: {
            controlDefaults: {},
            modelId: fakeProviderModelId,
            provider: fakeProviderConnectionId,
            searchStrategy: "search-disabled",
            userId
          },
          expectedActiveLeafId: assistantMessage.id,
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
            prompt: { developer: null, system: null },
            provider: "fake",
            searchStrategy: "search-disabled"
          },
          provider: "fake",
          providerRequestPreview: {},
          userId
        });
        activeAssistantMessageId = admitted.assistantMessageId;
      } else {
        await prisma.modelRun.create({
          data: {
            assistantMessageId: assistantMessage.id,
            chatId: chat.id,
            modelId: "fake-qsa",
            normalizedRequest: {},
            provider: "fake",
            providerRequestPreview: {},
            status: runStatus,
            userId,
            userMessageId: userMessage.id
          }
        });
      }

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
        activeLeafMessageId: activeAssistantMessageId,
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
        activeLeafMessageId: activeAssistantMessageId,
        archived: false
      });
      });
    }
  );

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

  it("keeps explicit Archive/Restore counter-neutral while serving owner-only Archived history", async () => {
    await withFolderUser(async ({ fakeProviderModelId, userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const chat = await prisma.chat.create({
        data: { defaultProviderModelId: fakeProviderModelId, title: "Archived history", userId }
      });
      const ids = Array.from({ length: 51 }, (_, index) =>
        `archived-history-${randomUUID()}-${index}`);
      await prisma.message.createMany({
        data: ids.map((id, index) => ({
          chatId: chat.id,
          content: textMessageContent(`Archived message ${index}`),
          id,
          parentMessageId: index === 0 ? null : ids[index - 1],
          role: index % 2 === 0 ? "user" : "assistant",
          status: "complete" as const
        }))
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: ids.at(-1) },
        where: { id: chat.id }
      });
      const countersBefore = await prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId }
      });

      await expect(repository.getChatMemoryState({ chatId: chat.id, userId })).resolves.toMatchObject({
        archived: false,
        chatId: chat.id,
        mode: "NORMAL",
        sourceRevision: 0,
        temporaryRetentionDeadline: null,
        temporaryRetentionPolicyVersion: null
      });
      await expect(repository.getChatMemoryState({
        chatId: chat.id,
        userId: `foreign-${userId}`
      })).resolves.toBeNull();

      await expect(repository.setArchived({
        archived: true,
        chatId: chat.id,
        expectedChatRevision: 0,
        userId
      })).resolves.toMatchObject({
        chat: { archived: true, id: chat.id, sourceRevision: 0 },
        kind: "ok"
      });
      await expect(repository.getChatMemoryState({ chatId: chat.id, userId })).resolves.toMatchObject({
        archived: true,
        mode: "NORMAL",
        sourceRevision: 0
      });
      await expect(repository.getChat({ chatId: chat.id, userId })).resolves.toBeNull();
      const preview = await repository.getArchivedChat({ chatId: chat.id, userId });
      expect(preview).toMatchObject({
        archived: true,
        messageCount: 51,
        pageInfo: { beforeCursor: expect.any(String), hasOlder: true },
        sourceRevision: 0
      });
      expect(preview?.messages.map(({ id }) => id)).toEqual(ids.slice(1));
      const older = await repository.getArchivedMessagesPage({
        before: preview?.pageInfo.beforeCursor ?? "",
        chatId: chat.id,
        userId
      });
      expect(older).toMatchObject({ kind: "ok", page: { messages: [{ id: ids[0] }] } });
      await expect(repository.getArchivedChat({
        chatId: chat.id,
        userId: `foreign-${userId}`
      })).resolves.toBeNull();
      await expect(repository.resolveChatSource({ chatId: chat.id, userId })).resolves.toMatchObject({
        location: "ARCHIVED_PREVIEW",
        sourceRevision: 0
      });
      await expect(repository.listArchivedChats({ cursor: null, userId })).resolves.toMatchObject({
        chats: [expect.objectContaining({ id: chat.id })],
        kind: "ok"
      });
      await expect(repository.setArchived({
        archived: false,
        chatId: chat.id,
        expectedChatRevision: 1,
        userId
      })).resolves.toEqual({ kind: "stale" });
      await expect(repository.setArchived({
        archived: false,
        chatId: chat.id,
        expectedChatRevision: 0,
        userId
      })).resolves.toMatchObject({
        chat: { archived: false, sourceRevision: 0 },
        kind: "ok"
      });
      await expect(repository.resolveChatSource({ chatId: chat.id, userId })).resolves.toMatchObject({
        location: "ACTIVE_CHAT",
        sourceRevision: 0
      });
      await expect(repository.getArchivedChat({ chatId: chat.id, userId })).resolves.toBeNull();
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId }
      })).resolves.toEqual(countersBefore);
      await expect(prisma.memoryJob.count({ where: { chatId: chat.id, userId } })).resolves.toBe(0);
    });
  });

  it("paginates Archived chats by owner with opaque cursor validation", async () => {
    await withFolderUser(async ({ fakeProviderModelId, userId }) => {
      const repository = createPrismaChatRepository(prisma);
      const base = new Date("2026-08-10T00:00:00.000Z").getTime();
      await prisma.chat.createMany({
        data: Array.from({ length: 21 }, (_, index) => ({
          archived: true,
          defaultProviderModelId: fakeProviderModelId,
          title: `Archived ${index}`,
          updatedAt: new Date(base + index * 1_000),
          userId
        }))
      });
      const first = await repository.listArchivedChats({ cursor: null, userId });
      expect(first).toMatchObject({
        chats: expect.any(Array),
        kind: "ok",
        nextCursor: expect.any(String)
      });
      if (first.kind !== "ok") throw new Error("expected archived page");
      expect(first.chats).toHaveLength(20);
      const second = await repository.listArchivedChats({
        cursor: first.nextCursor,
        userId
      });
      expect(second).toMatchObject({ chats: [expect.any(Object)], kind: "ok", nextCursor: null });
      if (second.kind !== "ok") throw new Error("expected archived page");
      expect(new Set([...first.chats, ...second.chats].map(({ id }) => id)).size).toBe(21);
      await expect(repository.listArchivedChats({
        cursor: "malformed!",
        userId
      })).resolves.toEqual({ kind: "cursor_invalid" });
      await expect(repository.listArchivedChats({
        cursor: null,
        userId: `foreign-${userId}`
      })).resolves.toEqual({ chats: [], kind: "ok", nextCursor: null });
    });
  });

  it("fences Exclude synchronously and resumes without crossing suppression or source cutoffs", async () => {
    await withFolderUser(async ({ fakeProviderModelId, userId }) => {
      const preflight = vi.fn(async () => true);
      const repository = createPrismaChatRepository(prisma, {
        resumeSuppressionPreflight: preflight
      });
      const chat = await prisma.chat.create({
        data: { defaultProviderModelId: fakeProviderModelId, title: "Memory source", userId }
      });
      const message = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Remember only eligible evidence"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: message.id },
        where: { id: chat.id }
      });
      const barrier = await prisma.memorySourceBarrier.create({
        data: {
          kind: "ALL_REUSABLE",
          memoryGeneration: 0,
          sourceCreatedAtCutoff: new Date("2026-08-09T00:00:00.000Z"),
          userId
        }
      });
      const suppression = await prisma.memorySuppression.create({
        data: {
          deletionGeneration: 0,
          fingerprintKeyVersion: "v1",
          normalizationVersion: "memory-normalization-v1",
          scope: "ALL",
          userId
        }
      });

      await expect(repository.setMemoryMode({
        chatId: chat.id,
        expectedChatRevision: 0,
        expectedMemoryRevision: 0,
        mode: "EXCLUDED",
        userId
      })).resolves.toEqual({
        kind: "ok",
        response: {
          chatId: chat.id,
          memoryGeneration: 1,
          memoryRevision: 1,
          mode: "EXCLUDED",
          sourceRevision: 1
        }
      });
      await expect(prisma.chat.findUniqueOrThrow({
        select: { archived: true, memoryMode: true, memorySourceRevision: true },
        where: { id: chat.id }
      })).resolves.toEqual({
        archived: false,
        memoryMode: "EXCLUDED",
        memorySourceRevision: 1
      });
      await expect(repository.setMemoryMode({
        chatId: chat.id,
        expectedChatRevision: 1,
        expectedMemoryRevision: 1,
        mode: "EXCLUDED",
        userId
      })).resolves.toEqual({ kind: "source_stale" });

      await expect(repository.setMemoryMode({
        chatId: chat.id,
        expectedChatRevision: 1,
        expectedMemoryRevision: 1,
        mode: "NORMAL",
        resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        userId
      })).resolves.toEqual({
        kind: "ok",
        response: {
          chatId: chat.id,
          memoryGeneration: 1,
          memoryRevision: 2,
          mode: "NORMAL",
          sourceRevision: 2
        }
      });
      expect(preflight).toHaveBeenCalledWith(expect.anything(), userId);
      await expect(prisma.memoryJob.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          kind: true,
          memoryGenerationSnapshot: true,
          memoryRevisionSnapshot: true,
          sourceRevision: true
        },
        where: { chatId: chat.id, userId }
      })).resolves.toEqual([
        {
          kind: "RECONCILE_SOURCE",
          memoryGenerationSnapshot: 1,
          memoryRevisionSnapshot: 1,
          sourceRevision: 1
        },
        {
          kind: "RECONCILE_SOURCE",
          memoryGenerationSnapshot: 1,
          memoryRevisionSnapshot: 2,
          sourceRevision: 2
        }
      ]);
      await expect(prisma.memorySourceBarrier.findUnique({
        where: { userId_id: { id: barrier.id, userId } }
      })).resolves.toMatchObject({
        explicitOverrideAllowed: false,
        id: barrier.id,
        sourceCreatedAtCutoff: barrier.sourceCreatedAtCutoff
      });
      await expect(prisma.memorySuppression.findUnique({
        where: { userId_id: { id: suppression.id, userId } }
      })).resolves.toMatchObject({ explicitOverrideAllowed: false, id: suppression.id });

      await repository.setMemoryMode({
        chatId: chat.id,
        expectedChatRevision: 2,
        expectedMemoryRevision: 2,
        mode: "EXCLUDED",
        userId
      });
      const blockedRepository = createPrismaChatRepository(prisma, {
        resumeSuppressionPreflight: async () => false
      });
      await expect(blockedRepository.setMemoryMode({
        chatId: chat.id,
        expectedChatRevision: 3,
        expectedMemoryRevision: 3,
        mode: "NORMAL",
        resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        userId
      })).resolves.toEqual({ kind: "resume_blocked" });
      await expect(prisma.chat.findUniqueOrThrow({
        select: { memoryMode: true, memorySourceRevision: true },
        where: { id: chat.id }
      })).resolves.toEqual({ memoryMode: "EXCLUDED", memorySourceRevision: 3 });
      await expect(prisma.userMemorySettings.findUniqueOrThrow({
        select: { memoryGeneration: true, memoryRevision: true },
        where: { userId }
      })).resolves.toEqual({ memoryGeneration: 2, memoryRevision: 3 });
    });
  });
});
