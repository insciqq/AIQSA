import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import type { SkillHandlerDeps } from "./handlers";
import { createPrismaSkillRepository } from "./prismaRepository";

export const defaultSkillRepository = createPrismaSkillRepository(prisma);

export const defaultSkillHandlerDeps: SkillHandlerDeps = {
  repository: defaultSkillRepository,
  resolveAuth: resolveRequestAuth
};
