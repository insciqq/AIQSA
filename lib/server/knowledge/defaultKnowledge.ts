import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import type { KnowledgeHandlerDeps } from "./handlers";
import { createPrismaKnowledgeRepository } from "./prismaRepository";

export const defaultKnowledgeRepository = createPrismaKnowledgeRepository(prisma);

export const defaultKnowledgeHandlerDeps: KnowledgeHandlerDeps = {
  repository: defaultKnowledgeRepository,
  resolveAuth: resolveRequestAuth
};
