import { prisma } from "../../prisma";
import { resolveRequestAuth } from "../../auth/defaultAuth";
import { createPrismaAdminRunProfileRepository } from "./prismaRepository";
import { createAdminRunProfileService } from "./service";

export const adminRunProfileService = createAdminRunProfileService(
  createPrismaAdminRunProfileRepository(prisma)
);

export const adminRunProfileHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: adminRunProfileService
};
