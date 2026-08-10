import { resolveRequestAuth } from "../../../auth/defaultAuth";
import { prisma } from "../../../prisma";
import type { MemoryHistorySearchHandlerDeps } from "./handlers";
import { createPrismaMemoryHistorySearchRepository } from "./repository";
import { createMemoryHistorySearchService } from "./service";

export const defaultMemoryHistorySearchService = createMemoryHistorySearchService({
  repository: createPrismaMemoryHistorySearchRepository(prisma),
  vectorLane: null
});

export const defaultMemoryHistorySearchHandlerDeps: MemoryHistorySearchHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: defaultMemoryHistorySearchService
};
