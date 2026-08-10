import { prisma } from "../../prisma";
import { defaultExplicitMemoryService } from "../explicit/defaultExplicit";
import { defaultMemoryLifecycleService } from "../lifecycle/defaultLifecycle";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import { createMemoryActionExecutor } from "./toolExecutor";

export const defaultMemoryActionExecutor = createMemoryActionExecutor({
  authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
  explicitService: defaultExplicitMemoryService,
  lifecycleService: defaultMemoryLifecycleService
});
