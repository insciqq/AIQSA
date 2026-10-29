import { resolveRequestAuth } from "../auth/defaultAuth";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";
import { prisma } from "../prisma";
import { catalogSubagentModelSource } from "./definitionModels";
import { createSubagentDefinitionHandlers } from "./definitionHandlers";
import { createSubagentDefinitionService } from "./definitionService";
import type { SubagentManagementRunDeps } from "./managementTools";
import { createSubagentTypeResolver } from "./typeResolver";

/** Production wiring of custom sub-agents: Studio's routes, the agent's management tools and the engine's type resolver. */
export const defaultSubagentModelSource = catalogSubagentModelSource(createPrismaCatalogDataLoader({ prisma }));

export const defaultSubagentDefinitionService = createSubagentDefinitionService({ db: prisma, models: defaultSubagentModelSource });

export const defaultSubagentDefinitionHandlers = createSubagentDefinitionHandlers({
  resolveAuth: resolveRequestAuth,
  service: defaultSubagentDefinitionService
});

/** The engine's `SubagentTypeResolver` (`ports.ts`). */
export const defaultSubagentTypeResolver = createSubagentTypeResolver(prisma);

/** What one main-agent run gives `executeSubagentManagementTool`. */
export function subagentManagementRunDeps(run: SubagentManagementRunDeps["run"]): SubagentManagementRunDeps {
  return { db: prisma, models: defaultSubagentModelSource, run };
}
