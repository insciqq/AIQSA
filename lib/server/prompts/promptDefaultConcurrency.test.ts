import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { createPrismaChatRepository } from "../chats/prismaRepository";
import { createPrismaMessageBranchRepository } from "../messages/prismaRepository";
import { prisma } from "../prisma";
import { promptDefaultsAdvisoryLockKey } from "./promptDefaultsLock";
import { createPrismaPromptRepository } from "./prismaRepository";

async function withPromptUser<T>(run: (input: { userId: string }) => Promise<T>): Promise<T> {
  const userId = `prompt-concurrency-test-${randomUUID()}`;
  await prisma.user.create({
    data: {
      displayName: "Prompt Concurrency Test User",
      id: userId,
      settings: {
        create: {
          defaultControlValues: {},
          defaultModelId: "fake-qsa",
          defaultProvider: "fake",
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

async function createPrompt(userId: string, name: string, isDefault = false) {
  return prisma.promptPreset.create({
    data: {
      isDefault,
      name,
      systemPrompt: `${name} system prompt`,
      userId
    }
  });
}

async function tryPromptDefaultsLock(
  userId: string,
  mode: "exclusive" | "shared"
): Promise<boolean> {
  const key = promptDefaultsAdvisoryLockKey(userId);
  return prisma.$transaction(async (tx) => {
    const [row] =
      mode === "exclusive"
        ? await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
            SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS "acquired"
          `)
        : await tx.$queryRaw<Array<{ acquired: boolean }>>(Prisma.sql`
            SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${key}, 0)) AS "acquired"
          `);

    return row?.acquired ?? false;
  });
}

async function waitForPromptDefaultsLockConflict(
  userId: string,
  attemptedMode: "exclusive" | "shared"
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (!(await tryPromptDefaultsLock(userId, attemptedMode))) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for the ${attemptedMode} prompt-default lock conflict`);
}

async function waitForGrantedSharedLocks(userId: string, minimum: number): Promise<void> {
  const key = promptDefaultsAdvisoryLockKey(userId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await prisma.$queryRaw<Array<{ count: number }>>`
      SELECT count(*)::int AS "count"
      FROM pg_locks
      WHERE "locktype" = 'advisory'
        AND "mode" = 'ShareLock'
        AND "granted" = true
        AND "classid"::bigint = ((hashtextextended(${key}, 0) >> 32) & 4294967295)
        AND "objid"::bigint = (hashtextextended(${key}, 0) & 4294967295)
    `;
    if ((row?.count ?? 0) >= minimum) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  throw new Error(`Timed out waiting for ${minimum} shared prompt-default locks`);
}

describe("prompt default concurrency", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("lets delete win before Make default without reporting two successes", async () => {
    await withPromptUser(async ({ userId }) => {
      const prompt = await createPrompt(userId, "Delete wins");
      const repository = createPrismaPromptRepository(prisma);
      let deletePromise!: ReturnType<typeof repository.deletePrompt>;
      let defaultPromise!: ReturnType<typeof repository.setDefaultPrompt>;

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "PromptPreset"
          WHERE "id" = ${prompt.id}
          FOR UPDATE
        `;
        deletePromise = repository.deletePrompt({ promptId: prompt.id, userId });
        await waitForPromptDefaultsLockConflict(userId, "shared");
        defaultPromise = repository.setDefaultPrompt({ promptId: prompt.id, userId });
      });

      await expect(deletePromise).resolves.toBe("deleted");
      await expect(defaultPromise).resolves.toBeNull();
      await expect(prisma.promptPreset.findUnique({ where: { id: prompt.id } })).resolves.toBeNull();
    });
  });

  it("lets Make default win before delete and preserves deletion protection", async () => {
    await withPromptUser(async ({ userId }) => {
      const prompt = await createPrompt(userId, "Default wins");
      const repository = createPrismaPromptRepository(prisma);
      let defaultPromise!: ReturnType<typeof repository.setDefaultPrompt>;
      let deletePromise!: ReturnType<typeof repository.deletePrompt>;

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "UserSettings"
          WHERE "userId" = ${userId}
          FOR UPDATE
        `;
        defaultPromise = repository.setDefaultPrompt({ promptId: prompt.id, userId });
        await waitForPromptDefaultsLockConflict(userId, "shared");
        deletePromise = repository.deletePrompt({ promptId: prompt.id, userId });
      });

      await expect(defaultPromise).resolves.toMatchObject({ id: prompt.id, isDefault: true });
      await expect(deletePromise).resolves.toBe("default");
      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: { defaultPromptPresetId: true },
          where: { userId }
        })
      ).resolves.toEqual({ defaultPromptPresetId: prompt.id });
    });
  });

  it.each(["delete", "create"] as const)(
    "keeps createChat valid when %s acquires the prompt lock first",
    async (first) => {
      await withPromptUser(async ({ userId }) => {
        const prompt = await createPrompt(userId, `Create race ${first}`);
        await prisma.userSettings.update({
          data: { defaultPromptPresetId: prompt.id },
          where: { userId }
        });
        const promptRepository = createPrismaPromptRepository(prisma);
        const chatRepository = createPrismaChatRepository(prisma);
        let deletePromise!: ReturnType<typeof promptRepository.deletePrompt>;
        let createPromise!: ReturnType<typeof chatRepository.createChat>;

        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "PromptPreset"
            WHERE "id" = ${prompt.id}
            FOR UPDATE
          `;
          if (first === "delete") {
            deletePromise = promptRepository.deletePrompt({ promptId: prompt.id, userId });
            await waitForPromptDefaultsLockConflict(userId, "shared");
            createPromise = chatRepository.createChat({ title: "Concurrent chat", userId });
          } else {
            createPromise = chatRepository.createChat({ title: "Concurrent chat", userId });
            await waitForPromptDefaultsLockConflict(userId, "exclusive");
            deletePromise = promptRepository.deletePrompt({ promptId: prompt.id, userId });
          }
        });

        const [deleted, created] = await Promise.all([deletePromise, createPromise]);
        expect(deleted).toBe("deleted");
        expect(created).not.toBeNull();
        expect(created?.defaultPromptPresetId).toBe(first === "create" ? prompt.id : null);
        await expect(
          prisma.chat.findUniqueOrThrow({
            select: { defaultPromptPresetId: true },
            where: { id: created?.id }
          })
        ).resolves.toEqual({ defaultPromptPresetId: null });
        await expect(
          prisma.userSettings.findUniqueOrThrow({
            select: { defaultPromptPresetId: true },
            where: { userId }
          })
        ).resolves.toEqual({ defaultPromptPresetId: null });
      });
    }
  );

  it.each(["delete", "branch"] as const)(
    "keeps branchChat valid when %s acquires the prompt lock first",
    async (first) => {
      await withPromptUser(async ({ userId }) => {
        const prompt = await createPrompt(userId, `Branch race ${first}`);
        const sourceChat = await prisma.chat.create({
          data: {
            defaultModelId: "fake-qsa",
            defaultProvider: "fake",
            title: "Branch source",
            userId
          }
        });
        const sourceMessage = await prisma.message.create({
          data: {
            chatId: sourceChat.id,
            content: textMessageContent("Branch source message"),
            promptPresetId: prompt.id,
            role: "user",
            status: "complete"
          }
        });
        const promptRepository = createPrismaPromptRepository(prisma);
        const branchRepository = createPrismaMessageBranchRepository(prisma);
        let deletePromise!: ReturnType<typeof promptRepository.deletePrompt>;
        let branchPromise!: ReturnType<typeof branchRepository.createChatBranchFromMessage>;

        await prisma.$transaction(async (tx) => {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "PromptPreset"
            WHERE "id" = ${prompt.id}
            FOR UPDATE
          `;
          if (first === "delete") {
            deletePromise = promptRepository.deletePrompt({ promptId: prompt.id, userId });
            await waitForPromptDefaultsLockConflict(userId, "shared");
            branchPromise = branchRepository.createChatBranchFromMessage({
              sourceMessageId: sourceMessage.id,
              userId
            });
          } else {
            branchPromise = branchRepository.createChatBranchFromMessage({
              sourceMessageId: sourceMessage.id,
              userId
            });
            await waitForPromptDefaultsLockConflict(userId, "exclusive");
            deletePromise = promptRepository.deletePrompt({ promptId: prompt.id, userId });
          }
        });

        const [deleted, branch] = await Promise.all([deletePromise, branchPromise]);
        expect(deleted).toBe("deleted");
        expect(branch).not.toBeNull();
        expect(branch?.defaultPromptPresetId).toBe(first === "branch" ? prompt.id : null);
        await expect(
          prisma.chat.findUniqueOrThrow({
            select: { defaultPromptPresetId: true },
            where: { id: branch?.id }
          })
        ).resolves.toEqual({ defaultPromptPresetId: null });
        const storedPromptReferences = await prisma.message.findMany({
          select: { promptPresetId: true },
          where: {
            chatId: {
              in: [sourceChat.id, branch?.id ?? ""]
            }
          }
        });
        expect(storedPromptReferences).toHaveLength(2);
        expect(storedPromptReferences.every((message) => message.promptPresetId === null)).toBe(true);
      });
    }
  );

  it("grants shared prompt locks concurrently to create and branch operations", async () => {
    await withPromptUser(async ({ userId }) => {
      const [defaultPrompt, branchPrompt] = await Promise.all([
        createPrompt(userId, "Concurrent create", true),
        createPrompt(userId, "Concurrent branch")
      ]);
      await prisma.userSettings.update({
        data: { defaultPromptPresetId: defaultPrompt.id },
        where: { userId }
      });
      const sourceChat = await prisma.chat.create({
        data: {
          defaultModelId: "fake-qsa",
          defaultProvider: "fake",
          title: "Independent branch source",
          userId
        }
      });
      const sourceMessage = await prisma.message.create({
        data: {
          chatId: sourceChat.id,
          content: textMessageContent("Independent branch"),
          promptPresetId: branchPrompt.id,
          role: "user",
          status: "complete"
        }
      });
      const chatRepository = createPrismaChatRepository(prisma);
      const branchRepository = createPrismaMessageBranchRepository(prisma);
      let createPromise!: ReturnType<typeof chatRepository.createChat>;
      let branchPromise!: ReturnType<typeof branchRepository.createChatBranchFromMessage>;

      await prisma.$transaction(async (tx) => {
        for (const promptId of [defaultPrompt.id, branchPrompt.id].sort()) {
          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT "id"
            FROM "PromptPreset"
            WHERE "id" = ${promptId}
            FOR UPDATE
          `;
        }
        createPromise = chatRepository.createChat({ title: "Independent create", userId });
        branchPromise = branchRepository.createChatBranchFromMessage({
          sourceMessageId: sourceMessage.id,
          userId
        });
        await waitForGrantedSharedLocks(userId, 2);
      });

      await expect(createPromise).resolves.toMatchObject({
        defaultPromptPresetId: defaultPrompt.id
      });
      await expect(branchPromise).resolves.toMatchObject({
        defaultPromptPresetId: branchPrompt.id
      });
    });
  });
});
