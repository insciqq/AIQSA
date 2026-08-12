import { prisma } from "../../prisma";
import { readDefaultMemorySchedulerStatus } from "../coordinator/defaultCoordinator";
import { defaultMemorySettingsService } from "../settings/defaultSettings";
import { createPrismaMemoryHealthRepository } from "./prismaRepository";
import { createMemoryHealthService } from "./service";

export const defaultMemoryHealthRepository =
  createPrismaMemoryHealthRepository(prisma);

export const defaultMemoryHealthService = createMemoryHealthService({
  readSchedulerStatus: readDefaultMemorySchedulerStatus,
  readSettings: (userId) => defaultMemorySettingsService.get(userId),
  repository: defaultMemoryHealthRepository
});
