import { prisma } from "../prisma";
import {
  createPrismaKnowledgeEmbeddingRuntime,
  createPrismaKnowledgeRetrievalStore
} from "./prismaRetrievalRepository";
import { createPrismaKnowledgePolicyResolver } from "./knowledgePolicy";
import { createKnowledgeToolExecutor } from "./toolExecutor";
import { createS3StorageAdapter } from "../uploads/storage";
import { createAcceptedKnowledgeVisionRuntime } from "./visualRuntime";

const knowledgeRetrievalStorage = createS3StorageAdapter();

export const knowledgeToolExecutor = createKnowledgeToolExecutor({
  embeddingRuntime: createPrismaKnowledgeEmbeddingRuntime(prisma),
  policy: createPrismaKnowledgePolicyResolver(prisma),
  store: createPrismaKnowledgeRetrievalStore(prisma, {
    storage: knowledgeRetrievalStorage,
    visualRuntime: createAcceptedKnowledgeVisionRuntime(prisma)
  })
});
