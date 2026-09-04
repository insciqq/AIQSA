import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { createPrismaProjectRepository } from "./prismaRepository";
import { createPrismaProjectContentRepository } from "./contentRepository";
import { createPrismaProjectMemoryRepository } from "./memoryRepository";
import { workspaceRuntime } from "../workspace/defaultServices";

export const defaultProjectHandlerDeps = {
  repository: createPrismaProjectRepository(prisma, { workspaceRuntime }),
  resolveAuth: resolveRequestAuth
};

export const defaultProjectContentHandlerDeps = {
  repository: createPrismaProjectContentRepository(prisma),
  resolveAuth: resolveRequestAuth
};

export const defaultProjectMemoryHandlerDeps = {
  repository: createPrismaProjectMemoryRepository(prisma),
  resolveAuth: resolveRequestAuth
};
