import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { applySettingsUpdateInTransaction } from "../settings/settingsTransaction";
import type { PromptPresetRecord, PromptRepository } from "./handlers";
import { lockUserPromptDefaultsExclusive } from "./promptDefaultsLock";

function serializePrompt(prompt: {
  developerPrompt: string | null;
  id: string;
  isDefault: boolean;
  name: string;
  systemPrompt: string;
}): PromptPresetRecord {
  return {
    developerPrompt: prompt.developerPrompt,
    id: prompt.id,
    isDefault: prompt.isDefault,
    name: prompt.name,
    systemPrompt: prompt.systemPrompt
  };
}

export function createPrismaPromptRepository(prismaClient = prisma): PromptRepository {
  return {
    createPrompt: async ({ developerPrompt, name, systemPrompt, userId }) => {
      const trimmedName = name.trim().slice(0, 80);
      const trimmedSystem = systemPrompt.trim();
      if (!trimmedName || !trimmedSystem) {
        return null;
      }

      try {
        const prompt = await prismaClient.promptPreset.create({
          data: {
            developerPrompt: developerPrompt?.trim() || null,
            isDefault: false,
            name: trimmedName,
            systemPrompt: trimmedSystem,
            userId
          }
        });

        return serializePrompt(prompt);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return null;
        }

        throw error;
      }
    },
    deletePrompt: async ({ promptId, userId }) => {
      return prismaClient.$transaction(async (tx) => {
        await lockUserPromptDefaultsExclusive(tx, userId);
        const [prompt] = await tx.$queryRaw<Array<{ id: string; isDefault: boolean }>>`
          SELECT "id", "isDefault"
          FROM "PromptPreset"
          WHERE "id" = ${promptId}
            AND "userId" = ${userId}
          FOR UPDATE
        `;
        if (!prompt) {
          return "not_found";
        }

        if (prompt.isDefault) {
          return "default";
        }

        await tx.chat.updateMany({
          data: {
            defaultPromptPresetId: null
          },
          where: {
            defaultPromptPresetId: prompt.id,
            userId
          }
        });
        await tx.userSettings.updateMany({
          data: {
            defaultPromptPresetId: null
          },
          where: {
            defaultPromptPresetId: prompt.id,
            userId
          }
        });
        await tx.promptPreset.delete({
          where: {
            id: prompt.id
          }
        });

        return "deleted";
      });
    },
    setDefaultPrompt: async ({ promptId, userId }) => {
      return prismaClient.$transaction(async (tx) => {
        const result = await applySettingsUpdateInTransaction(
          tx,
          userId,
          { defaultPromptPresetId: promptId },
          []
        );
        if (result.kind !== "updated") {
          return null;
        }

        const prompt = await tx.promptPreset.findFirst({
          where: {
            id: promptId,
            userId
          }
        });
        return prompt ? serializePrompt(prompt) : null;
      });
    },
    updatePrompt: async ({ developerPrompt, name, promptId, systemPrompt, userId }) => {
      const prompt = await prismaClient.promptPreset.findFirst({
        select: {
          id: true
        },
        where: {
          id: promptId,
          userId
        }
      });

      if (!prompt) {
        return null;
      }

      const data: Prisma.PromptPresetUpdateInput = {};
      if (name !== undefined) {
        const trimmed = name?.trim().slice(0, 80);
        if (!trimmed) {
          return null;
        }
        data.name = trimmed;
      }

      if (systemPrompt !== undefined) {
        const trimmed = systemPrompt?.trim();
        if (!trimmed) {
          return null;
        }
        data.systemPrompt = trimmed;
      }

      if (developerPrompt !== undefined) {
        data.developerPrompt = developerPrompt?.trim() || null;
      }

      try {
        const updated = await prismaClient.promptPreset.update({
          data,
          where: {
            id: prompt.id
          }
        });

        return serializePrompt(updated);
      } catch (error) {
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
          return null;
        }

        throw error;
      }
    }
  };
}
