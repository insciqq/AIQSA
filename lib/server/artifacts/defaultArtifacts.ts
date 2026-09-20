import { prisma } from "../prisma";
import { createS3StorageAdapter, type StorageAdapter } from "../uploads/storage";
import { createArtifactService } from "./service";

export const artifactServiceForStorage = (storage: StorageAdapter) =>
  createArtifactService(prisma, storage);

export const defaultArtifactService = () =>
  artifactServiceForStorage(createS3StorageAdapter());
