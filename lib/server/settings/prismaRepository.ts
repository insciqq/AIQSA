import type { PrismaClient } from "@prisma/client";
import { prisma } from "../prisma";
import type {
  SettingsValidationModel,
  UserSettingsUpdate,
  UserSettingsUpdateResult
} from "./handlers";
import { applySettingsUpdateInTransaction } from "./settingsTransaction";

type SettingsPrismaClient = Pick<PrismaClient, "$transaction" | "userSettings">;

export function createPrismaSettingsRepository(prismaClient: SettingsPrismaClient = prisma) {
  return {
    updateSettings: async (
      userId: string,
      update: UserSettingsUpdate,
      validationModels: SettingsValidationModel[]
    ): Promise<UserSettingsUpdateResult> => {
      return prismaClient.$transaction((tx) =>
        applySettingsUpdateInTransaction(tx, userId, update, validationModels)
      );
    }
  };
}
