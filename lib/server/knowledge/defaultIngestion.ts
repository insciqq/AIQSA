import { createPrismaEmbeddingRuntime } from "../providerRuntime/embeddingRuntime";
import { prisma } from "../prisma";
import { createS3StorageAdapter } from "../uploads/storage";
import {
  KNOWLEDGE_INGESTION_PARALLELISM_DEFAULT,
  KnowledgeIngestionCoordinator
} from "./ingestionCoordinator";
import { createKnowledgeIngestionProcessor } from "./ingestionProcessor";
import { createKnowledgeModelPdfParser } from "./modelPdfParser";
import { createPrismaKnowledgeSourceIngestionRepository } from "./prismaSourceIngestionRepository";

export const defaultKnowledgeIngestionRepository =
  createPrismaKnowledgeSourceIngestionRepository(prisma);
export const defaultKnowledgeStorage = createS3StorageAdapter();

type KnowledgeIngestionGlobal = typeof globalThis & {
  __aiqsaKnowledgeIngestionCoordinator?: KnowledgeIngestionCoordinator;
};

function createDefaultKnowledgeIngestionCoordinator(): KnowledgeIngestionCoordinator {
  return new KnowledgeIngestionCoordinator({
    // Each drain cycle re-reads the installation setting so administrator
    // changes apply to future background processing without a restart. The
    // coordinator clamps the value and falls back to the default on failure.
    maxParallel: async () => {
      const policy = await prisma.knowledgeAnswerPolicy.findUnique({
        select: { ingestionParallelism: true },
        where: { id: "installation" }
      });
      return policy?.ingestionParallelism ?? KNOWLEDGE_INGESTION_PARALLELISM_DEFAULT;
    },
    process: createKnowledgeIngestionProcessor({
      embeddingRuntime: createPrismaEmbeddingRuntime(prisma),
      modelPdfParser: createKnowledgeModelPdfParser(prisma),
      repository: defaultKnowledgeIngestionRepository,
      storage: defaultKnowledgeStorage
    }),
    repository: defaultKnowledgeIngestionRepository
  });
}

export function getDefaultKnowledgeIngestionCoordinator(): KnowledgeIngestionCoordinator {
  const scope = globalThis as KnowledgeIngestionGlobal;
  const coordinator = scope.__aiqsaKnowledgeIngestionCoordinator ??
    createDefaultKnowledgeIngestionCoordinator();
  scope.__aiqsaKnowledgeIngestionCoordinator = coordinator;
  coordinator.start();
  return coordinator;
}

export function kickDefaultKnowledgeIngestion(): void {
  getDefaultKnowledgeIngestionCoordinator().kick();
}
