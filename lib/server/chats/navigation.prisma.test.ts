import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaChatNavigationRepository } from "./navigation";

describe("Prisma chat navigation repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("paginates owner summaries, exposes active runs, and searches title/folder only", async () => {
    const ownerId = `navigation-owner-${randomUUID()}`;
    const foreignId = `navigation-foreign-${randomUUID()}`;
    await prisma.user.createMany({
      data: [
        { displayName: "Navigation owner", id: ownerId, status: "active" },
        { displayName: "Navigation foreign", id: foreignId, status: "active" }
      ]
    });
    try {
      const folder = await prisma.folder.create({
        data: { name: "Research notebooks", userId: ownerId }
      });
      const [first, second, contentOnly, foreign] = await Promise.all([
        prisma.chat.create({
          data: {
            folderId: folder.id,
            title: "First roadmap",
            updatedAt: new Date("2026-08-13T00:03:00.000Z"),
            userId: ownerId
          }
        }),
        prisma.chat.create({
          data: {
            title: "Second roadmap",
            updatedAt: new Date("2026-08-13T00:02:00.000Z"),
            userId: ownerId
          }
        }),
        prisma.chat.create({
          data: {
            title: "Unrelated title",
            updatedAt: new Date("2026-08-13T00:01:00.000Z"),
            userId: ownerId
          }
        }),
        prisma.chat.create({
          data: {
            title: "Foreign roadmap",
            updatedAt: new Date("2026-08-13T00:04:00.000Z"),
            userId: foreignId
          }
        })
      ]);
      const userMessage = await prisma.message.create({
        data: {
          chatId: first.id,
          content: textMessageContent("Run question"),
          role: "user",
          status: "complete"
        }
      });
      await prisma.modelRun.create({
        data: {
          chatId: first.id,
          modelId: "navigation-model",
          normalizedRequest: {},
          provider: "navigation-provider",
          status: "streaming",
          userId: ownerId,
          userMessageId: userMessage.id
        }
      });
      await prisma.message.create({
        data: {
          chatId: contentOnly.id,
          content: textMessageContent("private needle must not be searched"),
          role: "user",
          status: "complete"
        }
      });

      const repository = createPrismaChatNavigationRepository(prisma);
      const firstPage = await repository.listPage({ cursor: null, limit: 1, userId: ownerId });
      expect(firstPage).toMatchObject({
        kind: "ok",
        page: {
          chats: [{ activeRun: true, id: first.id }],
          folders: [{ id: folder.id, name: "Research notebooks" }],
          nextCursor: expect.any(String)
        }
      });
      if (firstPage.kind !== "ok") throw new Error("navigation_page_missing");
      const secondPage = await repository.listPage({
        cursor: firstPage.page.nextCursor,
        limit: 1,
        userId: ownerId
      });
      expect(secondPage).toMatchObject({
        kind: "ok",
        page: { chats: [{ activeRun: false, id: second.id }] }
      });
      expect(JSON.stringify(firstPage)).not.toContain(foreign.id);
      await expect(repository.listPage({
        cursor: firstPage.page.nextCursor,
        limit: 1,
        userId: foreignId
      })).resolves.toEqual({ kind: "cursor_invalid" });

      await expect(repository.searchPage({
        cursor: null,
        limit: 10,
        query: "research",
        userId: ownerId
      })).resolves.toMatchObject({
        kind: "ok",
        page: { chats: [{ id: first.id }] }
      });
      await expect(repository.searchPage({
        cursor: null,
        limit: 10,
        query: "private needle",
        userId: ownerId
      })).resolves.toMatchObject({ kind: "ok", page: { chats: [] } });
      await expect(repository.searchPage({
        cursor: null,
        limit: 10,
        query: "roadmap",
        userId: ownerId
      })).resolves.toMatchObject({
        kind: "ok",
        page: { chats: [{ id: first.id }, { id: second.id }] }
      });

      const searchPage = await repository.searchPage({
        cursor: null,
        limit: 1,
        query: "roadmap",
        userId: ownerId
      });
      if (searchPage.kind !== "ok") throw new Error("navigation_search_missing");
      const decodedCursor = Buffer.from(
        searchPage.page.nextCursor ?? "",
        "base64url"
      ).toString("utf8");
      expect(decodedCursor).not.toContain("roadmap");
      expect(decodedCursor).not.toContain(ownerId);
      await expect(repository.searchPage({
        cursor: searchPage.page.nextCursor,
        limit: 1,
        query: "different",
        userId: ownerId
      })).resolves.toEqual({ kind: "cursor_invalid" });
    } finally {
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, foreignId] } } });
    }
  });
});
