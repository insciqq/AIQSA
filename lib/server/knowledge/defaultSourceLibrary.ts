import { resolveRequestAuth } from "../auth/defaultAuth";
import { prisma } from "../prisma";
import {
  defaultKnowledgeStorage,
  kickDefaultKnowledgeIngestion
} from "./defaultIngestion";
import type {
  KnowledgeSourceLibraryHandlerDeps,
  KnowledgeSourceVersionHandlerDeps
} from "./sourceLibraryHandlers";
import { createPrismaKnowledgeSourceLibraryRepository } from "./sourceLibraryRepository";

export const defaultKnowledgeSourceLibraryRepository =
  createPrismaKnowledgeSourceLibraryRepository(prisma);

export const defaultKnowledgeSourceLibraryHandlerDeps: KnowledgeSourceLibraryHandlerDeps = {
  kickProcessing: kickDefaultKnowledgeIngestion,
  repository: defaultKnowledgeSourceLibraryRepository,
  resolveAuth: resolveRequestAuth
};

export const defaultKnowledgeSourceVersionHandlerDeps: KnowledgeSourceVersionHandlerDeps = {
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
  repository: defaultKnowledgeSourceLibraryRepository,
  resolveAuth: resolveRequestAuth,
  storage: defaultKnowledgeStorage
};
