import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import type { AssistantDeletionHandlerDeps } from "./deletionHandlers";
import { createPrismaAssistantDeletionRepository } from "./deletionRepository";

export const defaultAssistantDeletionHandlerDeps: AssistantDeletionHandlerDeps = {
  repository: createPrismaAssistantDeletionRepository(prisma),
  resolveAuth: resolveRequestAuth
};
