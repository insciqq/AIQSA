import type { PrismaClient } from "@prisma/client";
import type { CatalogWireModel, CatalogWireSearchStrategy } from "../../contracts/catalog";
import type { ScheduledTaskDraft } from "../../contracts/scheduledTasks";
import type { SearchPlan } from "../../contracts/search";
import { buildCurrentUserCatalog, resolveCurrentUserCatalogSelection } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";

/** The parts of the user's current personal-chat catalog that admit a task's model. */
export type ScheduledTaskCatalog = Readonly<{
  models: readonly Pick<CatalogWireModel, "capabilities" | "modelId" | "provider" | "searchStrategyIds">[];
  searchStrategies: readonly Readonly<{ kind: string; strategyId: string }>[];
}>;
export type ScheduledTaskCatalogLoader = (userId: string) => Promise<ScheduledTaskCatalog | null>;

/** What a run needs from the owner's current catalog, as `/api/me/catalog` publishes it to the composer. */
export type ScheduledTaskRunCatalog = Readonly<{
  models: readonly Pick<CatalogWireModel,
    "capabilities" | "modelId" | "provider" | "searchOptionCompatibility" | "searchStrategyIds">[];
  /** The owner's preferred Search selection that a new chat starts with. */
  searchPlan: SearchPlan;
  searchStrategies: readonly CatalogWireSearchStrategy[];
}>;
export type ScheduledTaskRunCatalogLoader = (userId: string) => Promise<ScheduledTaskRunCatalog | null>;

export type ScheduledTaskModelResolution =
  | { ok: true; searchOptionIds: string[] }
  | { ok: false; code: "scheduled_task_model_cannot_report" | "scheduled_task_model_unavailable" | "scheduled_task_search_unavailable" };

/** The same entitled selection `/api/me/catalog` publishes; null when the account has no catalog. */
export function createPrismaScheduledTaskCatalogLoader(prisma: PrismaClient): ScheduledTaskCatalogLoader {
  const loadCatalogData = createPrismaCatalogDataLoader({ checkDefaultAssistant: false, prisma });
  return async (userId) => {
    const data = await loadCatalogData(userId);
    if (!data) return null;
    const selection = resolveCurrentUserCatalogSelection(data);
    return { models: selection.models, searchStrategies: selection.entitledStrategies };
  };
}

export function createPrismaScheduledTaskRunCatalogLoader(prisma: PrismaClient): ScheduledTaskRunCatalogLoader {
  const loadCatalogData = createPrismaCatalogDataLoader({ checkDefaultAssistant: false, prisma });
  return async (userId) => {
    const data = await loadCatalogData(userId);
    if (!data) return null;
    const catalog = buildCurrentUserCatalog(data);
    return { models: catalog.models, searchPlan: catalog.defaults.searchPlan, searchStrategies: catalog.searchStrategies };
  };
}

/**
 * Admits a task's exact model identity at save and before every run, without
 * substitution. `searchOptionIds` lists the model's usable concrete Search
 * options in catalog order; requested Search needs at least one. A monitoring
 * task needs a model that can call tools: its checks report through one.
 */
export function resolveScheduledTaskModel(
  catalog: ScheduledTaskCatalog | null,
  task: Pick<ScheduledTaskDraft, "kind" | "modelId" | "provider" | "searchEnabled">
): ScheduledTaskModelResolution {
  const model = catalog?.models.find((entry) => entry.modelId === task.modelId && entry.provider === task.provider);
  if (!catalog || !model) return { ok: false, code: "scheduled_task_model_unavailable" };
  if (task.kind === "monitoring" && model.capabilities.toolCalling !== true) {
    return { ok: false, code: "scheduled_task_model_cannot_report" };
  }
  const concrete = new Set(catalog.searchStrategies.filter((option) => option.kind !== "none").map((option) => option.strategyId));
  const searchOptionIds = model.searchStrategyIds.filter((optionId) => concrete.has(optionId));
  return task.searchEnabled && searchOptionIds.length === 0
    ? { ok: false, code: "scheduled_task_search_unavailable" }
    : { ok: true, searchOptionIds };
}
