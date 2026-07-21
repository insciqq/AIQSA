import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaPromptRepository } from "../prompts/prismaRepository";
import { prisma } from "../prisma";
import type { SettingsValidationModel, UserSettingsUpdate } from "./handlers";
import { createPrismaSettingsRepository } from "./prismaRepository";

const validationModels: SettingsValidationModel[] = [
  {
    modelId: "fake-qsa",
    provider: "fake",
    searchStrategyIds: ["search-disabled"]
  },
  {
    modelId: "next-model",
    provider: "next-provider",
    searchStrategyIds: ["next-search"]
  }
];

function createTestSettingsRepository() {
  const repository = createPrismaSettingsRepository(prisma);

  return {
    updateSettings(userId: string, update: UserSettingsUpdate) {
      return repository.updateSettings(userId, update, validationModels);
    }
  };
}

async function withSettingsUser<T>(run: (input: { userId: string }) => Promise<T>): Promise<T> {
  const userId = `settings-prompt-test-${randomUUID()}`;

  await prisma.user.create({
    data: {
      displayName: "Settings Prompt Test User",
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

async function createPromptDefaults(userId: string) {
  const first = await prisma.promptPreset.create({
    data: {
      isDefault: true,
      name: "Default",
      systemPrompt: "Default system prompt.",
      userId
    }
  });
  const second = await prisma.promptPreset.create({
    data: {
      isDefault: false,
      name: "Second",
      systemPrompt: "Second system prompt.",
      userId
    }
  });

  await prisma.userSettings.update({
    data: {
      defaultPromptPresetId: first.id
    },
    where: {
      userId
    }
  });

  return { first, second };
}

async function promptFlags(userId: string): Promise<Map<string, boolean>> {
  const prompts = await prisma.promptPreset.findMany({
    select: {
      id: true,
      isDefault: true
    },
    where: {
      userId
    }
  });

  return new Map(prompts.map((prompt) => [prompt.id, prompt.isDefault]));
}

describe("Prisma settings repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("moves prompt default flags when settings select a prompt id", async () => {
    await withSettingsUser(async ({ userId }) => {
      const { first, second } = await createPromptDefaults(userId);
      const settingsRepository = createTestSettingsRepository();

      await expect(
        settingsRepository.updateSettings(userId, {
          defaultPromptPresetId: second.id
        })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: {
          defaultPromptPresetId: second.id
        }
      });

      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: {
            defaultPromptPresetId: true
          },
          where: {
            userId
          }
        })
      ).resolves.toEqual({
        defaultPromptPresetId: second.id
      });

      const flags = await promptFlags(userId);
      expect(flags.get(first.id)).toBe(false);
      expect(flags.get(second.id)).toBe(true);

      const promptRepository = createPrismaPromptRepository(prisma);
      await expect(promptRepository.deletePrompt({ promptId: first.id, userId })).resolves.toBe("deleted");
      await expect(promptRepository.deletePrompt({ promptId: second.id, userId })).resolves.toBe("default");
    });
  });

  it("clears prompt default flags when settings clear the prompt id", async () => {
    await withSettingsUser(async ({ userId }) => {
      await createPromptDefaults(userId);
      const settingsRepository = createTestSettingsRepository();

      await expect(
        settingsRepository.updateSettings(userId, {
          defaultPromptPresetId: null
        })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: {
          defaultPromptPresetId: null
        }
      });

      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: {
            defaultPromptPresetId: true
          },
          where: {
            userId
          }
        })
      ).resolves.toEqual({
        defaultPromptPresetId: null
      });
      await expect(
        prisma.promptPreset.findMany({
          where: {
            isDefault: true,
            userId
          }
        })
      ).resolves.toHaveLength(0);
    });
  });

  it("merges concurrent control patches against the latest settings row", async () => {
    await withSettingsUser(async ({ userId }) => {
      const settingsRepository = createTestSettingsRepository();

      await Promise.all([
        settingsRepository.updateSettings(userId, {
          defaultControlValues: {
            "openai:model-a": {
              temperature: "0.2"
            }
          }
        }),
        settingsRepository.updateSettings(userId, {
          defaultControlValues: {
            "anthropic:model-b": {
              reasoningEffort: "high"
            }
          }
        })
      ]);

      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: {
            defaultControlValues: true
          },
          where: {
            userId
          }
        })
      ).resolves.toEqual({
        defaultControlValues: {
          "anthropic:model-b": {
            reasoningEffort: "high"
          },
          "openai:model-a": {
            temperature: "0.2"
          }
        }
      });
    });
  });

  it("rejects a stale search patch waiting behind a concurrent model change", async () => {
    await withSettingsUser(async ({ userId }) => {
      const settingsRepository = createTestSettingsRepository();
      let staleSearchPatch: ReturnType<typeof settingsRepository.updateSettings> | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "UserSettings"
          WHERE "userId" = ${userId}
          FOR UPDATE
        `;
        staleSearchPatch = settingsRepository.updateSettings(userId, {
          defaultSearchStrategyId: "search-disabled"
        });
        await tx.userSettings.update({
          data: {
            defaultModelId: "next-model",
            defaultProvider: "next-provider",
            defaultSearchStrategyId: "next-search"
          },
          where: {
            userId
          }
        });
      });

      await expect(staleSearchPatch).resolves.toEqual({
        error: "default_search_unavailable",
        kind: "invalid"
      });
      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: {
            defaultModelId: true,
            defaultProvider: true,
            defaultSearchStrategyId: true
          },
          where: {
            userId
          }
        })
      ).resolves.toEqual({
        defaultModelId: "next-model",
        defaultProvider: "next-provider",
        defaultSearchStrategyId: "next-search"
      });
    });
  });

  it("keeps repeated concurrent settings prompt writes to one default flag", async () => {
    await withSettingsUser(async ({ userId }) => {
      const { second } = await createPromptDefaults(userId);
      const third = await prisma.promptPreset.create({
        data: {
          isDefault: false,
          name: "Third",
          systemPrompt: "Third system prompt.",
          userId
        }
      });
      const settingsRepository = createTestSettingsRepository();

      const results = await Promise.all([
        settingsRepository.updateSettings(userId, {
          defaultPromptPresetId: second.id
        }),
        settingsRepository.updateSettings(userId, {
          defaultPromptPresetId: third.id
        })
      ]);

      expect(results).toHaveLength(2);
      expect(results.every((result) => result.kind === "updated")).toBe(true);

      const [settings, defaultPrompts] = await Promise.all([
        prisma.userSettings.findUniqueOrThrow({
          select: {
            defaultPromptPresetId: true
          },
          where: {
            userId
          }
        }),
        prisma.promptPreset.findMany({
          select: {
            id: true
          },
          where: {
            isDefault: true,
            userId
          }
        })
      ]);

      expect(defaultPrompts).toHaveLength(1);
      expect(settings.defaultPromptPresetId).toBe(defaultPrompts[0]?.id);
      expect([second.id, third.id]).toContain(settings.defaultPromptPresetId);
    });
  });
});
