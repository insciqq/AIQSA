import { resolveRequestAuth } from "../../auth/defaultAuth";
import { prisma } from "../../prisma";
import { kickDefaultMemoryCoordinator } from "../coordinator/defaultCoordinator";
import { probeCurrentMemoryEmbeddingPin } from "../embedding/handler";
import { MEMORY_ITEM_EMBEDDING_VERSIONS } from "../embedding/contract";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import type { MemoryRebuildHandlerDeps } from "./handlers";
import { createPrismaMemoryRebuildRepository } from "./repository";
import { createMemoryRebuildService } from "./service";

const repository = createPrismaMemoryRebuildRepository(prisma);

export const defaultMemoryRebuildService = createMemoryRebuildService({
  kick: kickDefaultMemoryCoordinator,
  probeEmbeddingPin: (userId) => probeCurrentMemoryEmbeddingPin(
    defaultMemoryExecutionAuthority,
    prisma,
    userId,
    MEMORY_ITEM_EMBEDDING_VERSIONS
  ),
  repository
});

export const defaultMemoryRebuildHandlerDeps: MemoryRebuildHandlerDeps = {
  resolveAuth: resolveRequestAuth,
  service: defaultMemoryRebuildService
};
