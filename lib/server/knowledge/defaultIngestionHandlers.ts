import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import {
  defaultKnowledgeIngestionRepository,
  defaultKnowledgeStorage,
  kickDefaultKnowledgeIngestion
} from "./defaultIngestion";
import type { KnowledgeIngestionHandlerDeps } from "./ingestionHandlers";

export const defaultKnowledgeIngestionHandlerDeps: KnowledgeIngestionHandlerDeps = {
  deletionOutbox: {
    async complete(jobId) {
      await prisma.attachmentDeletionJob.deleteMany({ where: { id: jobId } });
    },
    stage(storageKey) {
      return prisma.attachmentDeletionJob.upsert({
        create: { storageKey },
        update: {},
        where: { storageKey }
      });
    }
  },
  kickProcessing: kickDefaultKnowledgeIngestion,
  repository: defaultKnowledgeIngestionRepository,
  resolveAuth: resolveRequestAuth,
  storage: defaultKnowledgeStorage
};
