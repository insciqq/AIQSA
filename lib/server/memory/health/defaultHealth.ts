import { prisma } from "../../prisma";
import { defaultMemorySettingsService } from "../settings/defaultSettings";
import { createPrismaMemoryHealthRepository } from "./prismaRepository";
import { createMemoryHealthService } from "./service";

export const defaultMemoryHealthRepository =
  createPrismaMemoryHealthRepository(prisma);

export const defaultMemoryHealthService = createMemoryHealthService({
  readSettings: (userId) => defaultMemorySettingsService.get(userId),
  repository: defaultMemoryHealthRepository
});
