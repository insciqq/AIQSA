import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import type { KnowledgeLifecycleHandlerDeps } from "./lifecycleHandlers";
import { kickDefaultKnowledgeDeletionWorker } from "./accountDeletion";
import { createPrismaKnowledgeLifecycleRepository } from "./lifecycleRepository";

export const defaultKnowledgeLifecycleRepository =
  createPrismaKnowledgeLifecycleRepository(prisma);

export const defaultKnowledgeLifecycleHandlerDeps: KnowledgeLifecycleHandlerDeps = {
  kickDeletionWorker: kickDefaultKnowledgeDeletionWorker,
  repository: defaultKnowledgeLifecycleRepository,
  resolveAuth: resolveRequestAuth
};
