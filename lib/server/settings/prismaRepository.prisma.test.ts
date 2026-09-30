import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import type { SettingsValidationModel, UserSettingsUpdate } from "./handlers";
import { createPrismaSettingsRepository } from "./prismaRepository";
import { applySettingsUpdateInTransaction } from "./settingsTransaction";
import { ANSWER_SOUNDS } from "@/lib/contracts/answerSound";
import { provisionActiveUser } from "../auth/provisioning";

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
  it("persists Workspace choices across reads, isolates accounts and preserves other concurrent preferences", async () => {
    await withSettingsUser(async ({ userId, validationModels }) => {
      await withSettingsUser(async ({ userId: otherUserId }) => {
        const repository = createTestSettingsRepository(validationModels);
        expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).defaultWorkspaceEnabled).toBe(true);
        await Promise.all([
          repository.updateSettings(userId, { defaultWorkspaceEnabled: false }),
          repository.updateSettings(userId, { sendWithEnter: false })
        ]);
        expect(await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).toMatchObject({
          defaultWorkspaceEnabled: false, sendWithEnter: false
        });
        expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId: otherUserId } })).defaultWorkspaceEnabled).toBe(true);
        await prisma.$transaction((tx) => provisionActiveUser(tx, { userId }));
        expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).defaultWorkspaceEnabled).toBe(false);
        expect(await repository.updateSettings(userId, { defaultWorkspaceEnabled: true })).toMatchObject({
          kind: "updated", settings: { defaultWorkspaceEnabled: true, sendWithEnter: false }
        });
      });
    });
  });

  it("persists separate sound preferences through concurrent saves without changing another account", async () => {
    await withSettingsUser(async ({ userId, validationModels }) => {
      await withSettingsUser(async ({ userId: otherUserId }) => {
        const repository = createTestSettingsRepository(validationModels);
        await Promise.all([
          repository.updateSettings(userId, { answerSoundEnabled: false }),
          repository.updateSettings(userId, { answerSoundId: "bell" }),
          repository.updateSettings(userId, { sendWithEnter: false, showCitations: false })
        ]);
        expect(await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).toMatchObject({
          answerSoundEnabled: false, answerSoundId: "bell", sendWithEnter: false, showCitations: false
        });
        expect(await prisma.userSettings.findUniqueOrThrow({ where: { userId: otherUserId } })).toMatchObject({
          answerSoundEnabled: true, answerSoundId: "rise", sendWithEnter: true
        });
        expect(await repository.updateSettings(userId, { answerSoundEnabled: true })).toMatchObject({
          settings: { answerSoundEnabled: true, answerSoundId: "bell" }
        });
        for (const { value } of ANSWER_SOUNDS) {
          expect(await repository.updateSettings(userId, { answerSoundId: value })).toMatchObject({
            kind: "updated", settings: { answerSoundEnabled: true, answerSoundId: value }
          });
          expect((await prisma.userSettings.findUniqueOrThrow({ where: { userId } })).answerSoundId).toBe(value);
        }
        await expect(prisma.$executeRaw`UPDATE "UserSettings" SET "answerSoundId" = 'invalid' WHERE "userId" = ${userId}`)
          .rejects.toMatchObject({ code: "P2010" });
      });
    });
  });

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

  it("preserves keyed patches while an owner-locked admission accepts defaults without a lock cycle", async () => {
    await withSettingsUser(async ({ userId, validationModels }) => {
      const repository = createTestSettingsRepository(validationModels);
      await prisma.userSettings.update({ where: { userId }, data: {
        defaultControlValues: { "openai:model-a": { maxOutputTokens: "1024" } }
      } });
      let patch: ReturnType<typeof repository.updateSettings> | undefined;
      try {
        await prisma.$transaction(async tx => {
          // Run admission already owns this lock before it persists defaults.
          await tx.$queryRaw`SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE`;
          const [owner] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
          patch = repository.updateSettings(userId, { defaultProviderModelId: null,
            defaultControlValues: { "other:model": { reasoningEffort: "low" } } });
          void patch.catch(() => undefined);
          // Observe a real competing transaction blocked by this exact owner,
          // so the assertion does not depend on request scheduling or sleeps.
          const deadline = Date.now() + 3000;
          let waiting = false;
          while (!waiting && Date.now() < deadline) {
            await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`;
            const rows = await tx.$queryRaw<Array<{ pid: number }>>`
              SELECT pid FROM pg_stat_activity WHERE ${owner!.pid} = ANY(pg_blocking_pids(pid))
            `;
            waiting = rows.length > 0;
            if (!waiting) await new Promise(resolve => setTimeout(resolve, 10));
          }
          expect(waiting).toBe(true);
          // Before the fix the patch held UserSettings and waited for User;
          // this write then waited for UserSettings, closing the deadlock.
          expect(await applySettingsUpdateInTransaction(tx, userId,
            { defaultControlValues: { "openai:model-a": { temperature: "0.2" } } }, validationModels))
            .toMatchObject({ kind: "updated" });
        }, { timeout: 10_000 });
        await expect(patch).resolves.toMatchObject({ kind: "updated" });
        expect(await prisma.userSettings.findUniqueOrThrow({ where: { userId }, select: {
          defaultControlValues: true, defaultProviderModelId: true
        } })).toEqual({ defaultProviderModelId: null, defaultControlValues: {
          "openai:model-a": { maxOutputTokens: "1024", temperature: "0.2" },
          "other:model": { reasoningEffort: "low" }
        } });
      } finally { await patch?.catch(() => undefined); }
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
          defaultSkillsMode: "off",
          sendWithEnter: false
        })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: { defaultKnowledgePlan: plan, defaultMcpMode: "load_all", defaultSkillsMode: "off", sendWithEnter: false }
      });
      await expect(
        settingsRepository.updateSettings(userId, { defaultKnowledgePlan: null })
      ).resolves.toMatchObject({
        kind: "updated",
        settings: { defaultKnowledgePlan: null, defaultMcpMode: "load_all", defaultSkillsMode: "off", sendWithEnter: false }
      });
      await expect(
        prisma.userSettings.findUniqueOrThrow({
          select: { defaultKnowledgePlan: true, defaultMcpMode: true, defaultSkillsMode: true, sendWithEnter: true },
          where: { userId }
        })
      ).resolves.toEqual({ defaultKnowledgePlan: null, defaultMcpMode: "load_all", defaultSkillsMode: "off", sendWithEnter: false });
      await expect(prisma.$executeRaw`UPDATE "UserSettings" SET "defaultSkillsMode" = 'always' WHERE "userId" = ${userId}`).rejects.toThrow();
      await expect(
        prisma.$executeRaw`UPDATE "UserSettings" SET "defaultMcpMode" = 'always' WHERE "userId" = ${userId}`
      ).rejects.toThrow();
    });
  });

  it("saves only an available default Assistant and keeps a saved one when it becomes unavailable", async () => {
    await withSettingsUser(async ({ fakeModel, userId, validationModels }) => {
      await withSettingsUser(async ({ userId: ownerId }) => {
        const repository = createTestSettingsRepository(validationModels);
        const define = (ownerUserId: string, name: string) => prisma.assistantDefinition.create({
          data: {
            avatar: {
              accents: [0, 4], backgroundShape: "circle", foregroundShape: "diamond", kind: "generated",
              paletteId: "ocean", recipeVersion: 1, rotations: [0, 2]
            },
            name,
            ownerUserId,
            providerModelId: fakeModel.id,
            searchPlan: { mode: "off" },
            systemPrompt: "Answer directly."
          }
        });
        const own = await define(userId, "Own default");
        const shared = await define(ownerId, "Shared default");
        const foreign = await define(ownerId, "Foreign default");
        try {
          await prisma.assistantPublication.create({
            data: { assistantId: shared.id, publishedByUserId: ownerId, scope: "installation" }
          });
          const stored = async () => (await prisma.userSettings.findUniqueOrThrow({
            select: { defaultAssistantId: true }, where: { userId }
          })).defaultAssistantId;

          for (const assistantId of [foreign.id, randomUUID()]) {
            await expect(repository.updateSettings(userId, { defaultAssistantId: assistantId }))
              .resolves.toEqual({ kind: "assistant_not_available" });
          }
          expect(await stored()).toBeNull();
          await expect(repository.updateSettings(userId, { defaultAssistantId: own.id })).resolves.toMatchObject({
            kind: "updated", settings: { defaultAssistantAvailable: true, defaultAssistantId: own.id }
          });
          await expect(repository.updateSettings(userId, { defaultAssistantId: shared.id })).resolves.toMatchObject({
            kind: "updated", settings: { defaultAssistantAvailable: true, defaultAssistantId: shared.id }
          });

          // Revoking the publication is reported by readers, never applied as a silent clear.
          await prisma.assistantPublication.deleteMany({ where: { assistantId: shared.id } });
          await expect(repository.updateSettings(userId, { sendWithEnter: false })).resolves.toMatchObject({
            kind: "updated", settings: { defaultAssistantId: shared.id }
          });
          expect(await stored()).toBe(shared.id);
          await expect(repository.updateSettings(userId, { defaultAssistantId: null })).resolves.toMatchObject({
            kind: "updated", settings: { defaultAssistantAvailable: false, defaultAssistantId: null }
          });
          expect(await stored()).toBeNull();
        } finally {
          await prisma.userSettings.updateMany({ data: { defaultAssistantId: null }, where: { userId } });
          await prisma.assistantPublication.deleteMany({ where: { assistantId: shared.id } });
          await prisma.assistantDefinition.deleteMany({ where: { id: { in: [own.id, shared.id, foreign.id] } } });
        }
      });
    });
  });
});
