import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import type { MemoryProfileHandlerDependencies } from "./handlers";
import { createMemoryProfileService } from "./service";

export const defaultMemoryProfileService = createMemoryProfileService(prisma);

export const defaultMemoryProfileHandlerDependencies: MemoryProfileHandlerDependencies = {
  resolveAuth: resolveRequestAuth,
  service: defaultMemoryProfileService
};
