import { prisma } from "../prisma";
import {
  createPrismaKnowledgeEmbeddingRuntime,
  createPrismaKnowledgeRetrievalStore
} from "./prismaRetrievalRepository";
import { createPrismaKnowledgePolicyResolver } from "./knowledgePolicy";
import { createKnowledgeToolExecutor } from "./toolExecutor";
import { createS3StorageAdapter } from "../uploads/storage";
import { createAcceptedKnowledgeVisionRuntime } from "./visualRuntime";
import { createPrismaKnowledgeBudgetReservationRepository } from "./knowledgeBudgetReservationRepository";
import { createPrismaKnowledgeStrategyRepository } from "./knowledgeStrategyRepository";

const knowledgeRetrievalStorage = createS3StorageAdapter();

export const knowledgeToolExecutor = createKnowledgeToolExecutor({
  budgetReservations: createPrismaKnowledgeBudgetReservationRepository(prisma),
  embeddingRuntime: createPrismaKnowledgeEmbeddingRuntime(prisma),
  policy: createPrismaKnowledgePolicyResolver(prisma),
  strategies: createPrismaKnowledgeStrategyRepository(prisma),
  store: createPrismaKnowledgeRetrievalStore(prisma, {
    storage: knowledgeRetrievalStorage,
    visualRuntime: createAcceptedKnowledgeVisionRuntime(prisma)
  })
});
