import { prisma } from "../prisma";
import {
  createPrismaKnowledgeEmbeddingRuntime,
  createPrismaKnowledgeRetrievalStore
} from "./prismaRetrievalRepository";
import { createKnowledgeToolExecutor } from "./toolExecutor";
import { createPrismaKnowledgeBudgetReservationRepository } from "./knowledgeBudgetReservationRepository";

export const knowledgeToolExecutor = createKnowledgeToolExecutor({
  budgetReservations: createPrismaKnowledgeBudgetReservationRepository(prisma),
  embeddingRuntime: createPrismaKnowledgeEmbeddingRuntime(prisma),
  store: createPrismaKnowledgeRetrievalStore(prisma)
});
