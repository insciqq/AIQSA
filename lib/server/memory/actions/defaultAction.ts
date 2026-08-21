import { prisma } from "../../prisma";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import { defaultExplicitMemoryService } from "../explicit/defaultExplicit";
import { defaultMemoryLifecycleService } from "../lifecycle/defaultLifecycle";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import { createPrismaMemoryRunUtilityService } from "../retrieval/runUtilities";
import { createPrismaMemoryVectorRepository } from "../retrieval/vector";
import { createMemoryIntentActionExecutor } from "./intentExecutor";
import {
  createMemoryActionTargetSearchService,
  createPrismaMemoryActionTargetRepository
} from "./targetSearch";
import { createPrismaMemoryTargetSelector } from "./targetSelector";

const targetSearch = createMemoryActionTargetSearchService({
  explicitService: defaultExplicitMemoryService,
  repository: createPrismaMemoryActionTargetRepository(prisma),
  utilities: createPrismaMemoryRunUtilityService(defaultMemoryExecutionAuthority, prisma),
  vectorRepository: createPrismaMemoryVectorRepository(prisma)
});

export const defaultMemoryIntentActionExecutor = createMemoryIntentActionExecutor({
  authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
  explicitService: defaultExplicitMemoryService,
  lifecycleService: defaultMemoryLifecycleService,
  targetSearch,
  targetSelector: createPrismaMemoryTargetSelector(defaultMemoryExecutionAuthority, prisma)
});
