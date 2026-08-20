import { prisma } from "../prisma";
import { createPrismaKnowledgeEvidenceDispatchRepository } from "./evidenceDispatchRepository";
import { createKnowledgeProviderDispatchLifecycle } from "./providerDispatchLifecycle";

export const knowledgeProviderDispatchLifecycle = createKnowledgeProviderDispatchLifecycle(
  createPrismaKnowledgeEvidenceDispatchRepository(prisma)
);
