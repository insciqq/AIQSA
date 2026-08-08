import { createPrismaEmbeddingRuntime } from "../providerRuntime/embeddingRuntime";
import { prisma } from "../prisma";
import { createS3StorageAdapter } from "../uploads/storage";
import { KnowledgeIngestionCoordinator } from "./ingestionCoordinator";
import { createKnowledgeIngestionProcessor } from "./ingestionProcessor";
import { createPrismaKnowledgeIngestionRepository } from "./prismaIngestionRepository";

export const defaultKnowledgeIngestionRepository = createPrismaKnowledgeIngestionRepository(prisma);
export const defaultKnowledgeStorage = createS3StorageAdapter();

type KnowledgeIngestionGlobal = typeof globalThis & {
  __aiqsaKnowledgeIngestionCoordinator?: KnowledgeIngestionCoordinator;
};

function createDefaultKnowledgeIngestionCoordinator(): KnowledgeIngestionCoordinator {
  return new KnowledgeIngestionCoordinator({
    process: createKnowledgeIngestionProcessor({
      embeddingRuntime: createPrismaEmbeddingRuntime(prisma),
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
