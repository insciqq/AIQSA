import { prisma } from "../prisma";
import {
  createPrismaKnowledgeEmbeddingRuntime,
  createPrismaKnowledgeRetrievalStore
} from "./prismaRetrievalRepository";
import { createKnowledgeToolExecutor } from "./toolExecutor";

export const knowledgeToolExecutor = createKnowledgeToolExecutor({
  embeddingRuntime: createPrismaKnowledgeEmbeddingRuntime(prisma),
  store: createPrismaKnowledgeRetrievalStore(prisma)
});
