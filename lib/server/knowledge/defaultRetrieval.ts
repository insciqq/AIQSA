import { prisma } from "../prisma";
import {
  createPrismaKnowledgeEmbeddingRuntime,
  createPrismaKnowledgeRetrievalStore
} from "./prismaRetrievalRepository";
import { createPrismaKnowledgePolicyResolver } from "./knowledgePolicy";
import { createKnowledgeToolExecutor } from "./toolExecutor";

export const knowledgeToolExecutor = createKnowledgeToolExecutor({
  embeddingRuntime: createPrismaKnowledgeEmbeddingRuntime(prisma),
  policy: createPrismaKnowledgePolicyResolver(prisma),
  store: createPrismaKnowledgeRetrievalStore(prisma)
});
