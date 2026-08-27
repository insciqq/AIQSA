import { prisma } from "../prisma";
import {
  createPrismaKnowledgeEmbeddingRuntime,
  createPrismaKnowledgeRetrievalStore
} from "./prismaRetrievalRepository";
import { createKnowledgeToolExecutor } from "./toolExecutor";
import { createPrismaKnowledgeBudgetReservationRepository } from "./knowledgeBudgetReservationRepository";
import { createPrismaKnowledgeRerankerRuntime } from "./rerankerRuntime";

export const knowledgeToolExecutor = createKnowledgeToolExecutor({
  budgetReservations: createPrismaKnowledgeBudgetReservationRepository(prisma),
  embeddingRuntime: createPrismaKnowledgeEmbeddingRuntime(prisma),
  rerankerRuntime: createPrismaKnowledgeRerankerRuntime(prisma),
  store: createPrismaKnowledgeRetrievalStore(prisma)
});
