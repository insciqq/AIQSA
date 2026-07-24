import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { providerTemplateIds } from "../../domain/providerTemplates";
import { prisma } from "../prisma";
import { createPrismaPromptRepository } from "./prismaRepository";

describe("Prisma prompt repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("clears chat defaults and message references when deleting a non-default preset", async () => {
    const userId = `prompt-repository-test-${randomUUID()}`;
    await prisma.user.create({
      data: {
        displayName: "Prompt Repository Test User",
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
      const prompt = await prisma.promptPreset.create({
        data: {
          name: "Temporary",
          systemPrompt: "Temporary system prompt",
          userId
        }
      });
      const chat = await prisma.chat.create({
        data: {
          defaultProviderModelId: providerTemplateIds.fakeModel,
          defaultPromptPresetId: prompt.id,
          title: "Prompt cleanup",
          userId
        }
      });
      const message = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Prompt provenance"),
          promptPresetId: prompt.id,
          role: "user",
          status: "complete"
        }
      });
      await prisma.userSettings.update({
        data: {
          defaultPromptPresetId: prompt.id
        },
        where: {
          userId
        }
      });

      const repository = createPrismaPromptRepository(prisma);
      await expect(repository.deletePrompt({ promptId: prompt.id, userId })).resolves.toBe("deleted");

      const [storedChat, storedMessage, settings, storedPrompt] = await Promise.all([
        prisma.chat.findUniqueOrThrow({ select: { defaultPromptPresetId: true }, where: { id: chat.id } }),
        prisma.message.findUniqueOrThrow({ select: { promptPresetId: true }, where: { id: message.id } }),
        prisma.userSettings.findUniqueOrThrow({
          select: { defaultPromptPresetId: true },
          where: { userId }
        }),
        prisma.promptPreset.findUnique({ where: { id: prompt.id } })
      ]);

      expect(storedChat.defaultPromptPresetId).toBeNull();
      expect(storedMessage.promptPresetId).toBeNull();
      expect(settings.defaultPromptPresetId).toBeNull();
      expect(storedPrompt).toBeNull();
    } finally {
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
