import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
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
  const userId = `settings-test-${randomUUID()}`;
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
      displayName: "Settings Test User",
      id: userId,
      settings: {
        create: {
          defaultControlValues: {},
          defaultProviderModelId: fakeModel.id,
          defaultSearchPlan: { mode: "all_selected", optionIds: [] }
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

describe("Prisma-backed settings repository", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("persists and returns opaque relation identifiers", async () => {
    await withSettingsUser(async ({ nextModel, userId, validationModels }) => {
      const settingsRepository = createTestSettingsRepository(validationModels);

      await expect(
        settingsRepository.updateSettings(userId, {
          defaultProviderModelId: nextModel.id,
          defaultSearchPlan: { mode: "all_selected", optionIds: ["next-search"] },
          showCitations: false
        })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: {
          defaultProviderModelId: nextModel.id,
          defaultSearchPlan: { mode: "all_selected", optionIds: ["next-search"] },
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
        })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: {
          defaultProviderModelId: null,
        }
      });
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
          defaultSearchPlan: { mode: "all_selected", optionIds: [] }
        });
        await tx.userSettings.update({
          data: {
            defaultProviderModel: {
              connect: {
                id: nextModel.id
              }
            }
          },
          where: {
            userId
          }
        });
      });

      await expect(staleSearchPatch).resolves.toMatchObject({
        kind: "updated",
        settings: {
          defaultProviderModelId: nextModel.id,
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
            defaultSearchPlan: true
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
        defaultSearchPlan: { mode: "all_selected", optionIds: [] }
      });
    });
  });

  it("persists the chat defaults and Send with Enter, clears the Knowledge default with null, and bounds the MCP mode", async () => {
    await withSettingsUser(async ({ userId, validationModels }) => {
      const settingsRepository = createTestSettingsRepository(validationModels);
      const plan = { baseIds: ["kb-1"], mode: "explicit" as const, sourceIds: [], version: 1 as const };

      await expect(
        settingsRepository.updateSettings(userId, {
          defaultKnowledgePlan: plan,
          defaultMcpMode: "load_all",
          sendWithEnter: false
        })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: { defaultKnowledgePlan: plan, defaultMcpMode: "load_all", sendWithEnter: false }
      });
      await expect(
        settingsRepository.updateSettings(userId, { defaultKnowledgePlan: null })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: { defaultKnowledgePlan: null, defaultMcpMode: "load_all", sendWithEnter: false }
      });
      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: { defaultKnowledgePlan: true, defaultMcpMode: true, sendWithEnter: true },
          where: { userId }
        })
      ).resolves.toEqual({ defaultKnowledgePlan: null, defaultMcpMode: "load_all", sendWithEnter: false });
      await expect(
        prisma.$executeRaw`UPDATE "UserSettings" SET "defaultMcpMode" = 'always' WHERE "userId" = ${userId}`
      ).rejects.toThrow();
    });
  });
});
