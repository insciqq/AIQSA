import { prisma } from "../prisma";
import { createPrismaImageGenerationService } from "./service";
import type { StorageAdapter } from "../uploads/storage";

export const imageGenerationForStorage = (storage: StorageAdapter) => createPrismaImageGenerationService(prisma, storage);
