import { prisma } from "../../../prisma";
import { defaultMemoryExecutionAuthority } from "../../execution/defaultAuthority";
import { createPrismaLocalMemoryRetrievalRepository } from "../../retrieval/localRepository";
import { createPrismaMemoryRunUtilityService } from "../../retrieval/runUtilities";
import { createPrismaMemoryVectorRepository } from "../../retrieval/vector";
import { createMemoryHistoryToolExecutor } from "./toolExecutor";
import { createMemoryUnifiedSearchService } from "./unifiedService";

export const defaultMemoryHistoryToolExecutor = createMemoryHistoryToolExecutor({
  client: prisma,
  service: createMemoryUnifiedSearchService({
    repository: createPrismaLocalMemoryRetrievalRepository(prisma),
    utilities: createPrismaMemoryRunUtilityService(defaultMemoryExecutionAuthority, prisma),
    vectorRepository: createPrismaMemoryVectorRepository(prisma)
  })
});
