import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import { defaultKnowledgeStorage, kickDefaultKnowledgeIngestion } from "./defaultIngestion";
import type { KnowledgeUploadHandlerDeps } from "./uploadHandlers";
import { createPrismaKnowledgeUploadRepository } from "./uploadRepository";

export const defaultKnowledgeUploadRepository = createPrismaKnowledgeUploadRepository(prisma);

export const defaultKnowledgeUploadHandlerDeps: KnowledgeUploadHandlerDeps = {
  deletionOutbox: {
    async complete(jobId) {
      await prisma.attachmentDeletionJob.deleteMany({ where: { id: jobId } });
    },
    stage(storageKey, multipartUploadId = null) {
      return prisma.attachmentDeletionJob.upsert({
        create: { multipartUploadId, storageKey },
        update: multipartUploadId ? { multipartUploadId } : {},
        where: { storageKey }
      });
    }
  },
  kickProcessing: kickDefaultKnowledgeIngestion,
  repository: defaultKnowledgeUploadRepository,
  resolveAuth: resolveRequestAuth,
  storage: defaultKnowledgeStorage
};
