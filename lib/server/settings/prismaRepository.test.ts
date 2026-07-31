import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { createPrismaPromptRepository } from "../prompts/prismaRepository";
import { prisma } from "../prisma";
import type { SettingsValidationModel, UserSettingsUpdate } from "./handlers";
import { createPrismaSettingsRepository } from "./prismaRepository";

function createTestSettingsRepository(validationModels: SettingsValidationModel[]) {
  const repository = createPrismaSettingsRepository(prisma);

  return {
    updateSettings(userId: string, update: UserSettingsUpdate) {
      return repository.updateSettings(userId, update, validationModels);
    }
  };
}

type SettingsUserFixture = {
  fakeModel: { connectionId: string; id: string };
  nextModel: { connectionId: string; id: string };
  userId: string;
  validationModels: SettingsValidationModel[];
};

async function withSettingsUser<T>(run: (input: SettingsUserFixture) => Promise<T>): Promise<T> {
  const userId = `settings-prompt-test-${randomUUID()}`;
  const models = await prisma.providerModel.findMany({
    select: {
      connectionId: true,
      id: true,
      templateKey: true
    },
    where: {
      templateKey: {
        in: ["fake:fake-qsa", "openai:gpt-5.5"]
      }
    }
  });
  const fakeModel = models.find((model) => model.templateKey === "fake:fake-qsa");
  const nextModel = models.find((model) => model.templateKey === "openai:gpt-5.5");
  if (!fakeModel || !nextModel) {
    throw new Error("Provider model fixtures are not seeded");
  }
  const validationModels: SettingsValidationModel[] = [
    {
      modelId: fakeModel.id,
      provider: fakeModel.connectionId,
      searchStrategyIds: ["search-disabled"]
    },
    {
      modelId: nextModel.id,
      provider: nextModel.connectionId,
      searchStrategyIds: ["next-search"]
    }
  ];

  await prisma.user.create({
    data: {
      displayName: "Settings Prompt Test User",
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

  try {
    return await run({ fakeModel, nextModel, userId, validationModels });
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

  it("persists and returns opaque relation identifiers", async () => {
    await withSettingsUser(async ({ nextModel, userId, validationModels }) => {
      const settingsRepository = createTestSettingsRepository(validationModels);

      await expect(
        settingsRepository.updateSettings(userId, {
          defaultProviderModelId: nextModel.id,
          defaultSearchStrategyId: "next-search",
          showCitations: false
        })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: {
          defaultModelId: nextModel.id,
          defaultProvider: nextModel.connectionId,
          defaultProviderConnectionId: nextModel.connectionId,
          defaultProviderModelId: nextModel.id,
          defaultSearchStrategyId: "next-search",
          showCitations: false
        }
      });
      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: {
            defaultProviderModel: {
              select: {
                connectionId: true,
                id: true
              }
            }
          },
          where: { userId }
        })
      ).resolves.toEqual({
        defaultProviderModel: {
          connectionId: nextModel.connectionId,
          id: nextModel.id
        }
      });
    });
  });

  it("preserves an empty relation default", async () => {
    await withSettingsUser(async ({ userId, validationModels }) => {
      const settingsRepository = createTestSettingsRepository(validationModels);

      await expect(
        settingsRepository.updateSettings(userId, {
          defaultProviderModelId: null,
          showToolActivity: false
        })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: {
          defaultModelId: "",
          defaultProvider: "",
          defaultProviderConnectionId: null,
          defaultProviderModelId: null,
          showToolActivity: false
        }
      });
    });
  });

  it("moves prompt default flags when settings select a prompt id", async () => {
    await withSettingsUser(async ({ userId, validationModels }) => {
      const { first, second } = await createPromptDefaults(userId);
      const settingsRepository = createTestSettingsRepository(validationModels);

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
    await withSettingsUser(async ({ userId, validationModels }) => {
      await createPromptDefaults(userId);
      const settingsRepository = createTestSettingsRepository(validationModels);

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
    await withSettingsUser(async ({ userId, validationModels }) => {
      const settingsRepository = createTestSettingsRepository(validationModels);

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

  it("applies a global Search preference waiting behind a concurrent model change", async () => {
    await withSettingsUser(async ({ nextModel, userId, validationModels }) => {
      const settingsRepository = createTestSettingsRepository(validationModels);
      let staleSearchPatch: ReturnType<typeof settingsRepository.updateSettings> | undefined;

      await prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "UserSettings"
          WHERE "userId" = ${userId}
          FOR UPDATE
        `;
        staleSearchPatch = settingsRepository.updateSettings(userId, {
          defaultSearchPlan: { mode: "all_selected", optionIds: [] },
          defaultSearchStrategyId: "search-disabled"
        });
        await tx.userSettings.update({
          data: {
            defaultProviderModel: {
              connect: {
                id: nextModel.id
              }
            },
            defaultSearchStrategyId: "next-search"
          },
          where: {
            userId
          }
        });
      });

      await expect(staleSearchPatch).resolves.toMatchObject({
        kind: "updated",
        settings: {
          defaultModelId: nextModel.id,
          defaultSearchPlan: { mode: "all_selected", optionIds: [] }
        }
      });
      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: {
            defaultProviderModel: {
              select: {
                connectionId: true,
                id: true
              }
            },
            defaultSearchPlan: true,
            defaultSearchStrategyId: true
          },
          where: {
            userId
          }
        })
      ).resolves.toEqual({
        defaultProviderModel: {
          connectionId: nextModel.connectionId,
          id: nextModel.id
        },
        defaultSearchPlan: { mode: "all_selected", optionIds: [] },
        defaultSearchStrategyId: "search-disabled"
      });
    });
  });

  it("keeps repeated concurrent settings prompt writes to one default flag", async () => {
    await withSettingsUser(async ({ userId, validationModels }) => {
      const { second } = await createPromptDefaults(userId);
      const third = await prisma.promptPreset.create({
        data: {
          isDefault: false,
          name: "Third",
          systemPrompt: "Third system prompt.",
          userId
        }
      });
      const settingsRepository = createTestSettingsRepository(validationModels);

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
