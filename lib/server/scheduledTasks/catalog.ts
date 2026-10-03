import type { PrismaClient } from "@prisma/client";
import type { CatalogWireModel } from "../../contracts/catalog";
import type { ScheduledTaskDraft } from "../../contracts/scheduledTasks";
import type { SearchStrategyCatalogEntry } from "../../domain/catalog";
import { resolveCurrentUserCatalogSelection } from "../catalog/currentUserCatalog";
import { createPrismaCatalogDataLoader } from "../catalog/prismaCatalogData";

/** The parts of the user's current personal-chat catalog that admit a task's model. */
export type ScheduledTaskCatalog = Readonly<{
  models: readonly Pick<CatalogWireModel, "modelId" | "provider" | "searchStrategyIds">[];
  searchStrategies: readonly Pick<SearchStrategyCatalogEntry, "kind" | "strategyId">[];
}>;
export type ScheduledTaskCatalogLoader = (userId: string) => Promise<ScheduledTaskCatalog | null>;

export type ScheduledTaskModelResolution =
  | { ok: true; searchOptionIds: string[] }
  | { ok: false; code: "scheduled_task_model_unavailable" | "scheduled_task_search_unavailable" };

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

/**
 * Admits a task's exact model identity at save and before every run, without
 * substitution. `searchOptionIds` lists the model's usable concrete Search
 * options in catalog order; requested Search needs at least one.
 */
export function resolveScheduledTaskModel(
  catalog: ScheduledTaskCatalog | null,
  task: Pick<ScheduledTaskDraft, "modelId" | "provider" | "searchEnabled">
): ScheduledTaskModelResolution {
  const model = catalog?.models.find((entry) => entry.modelId === task.modelId && entry.provider === task.provider);
  if (!catalog || !model) return { ok: false, code: "scheduled_task_model_unavailable" };
  const concrete = new Set(catalog.searchStrategies.filter((option) => option.kind !== "none").map((option) => option.strategyId));
  const searchOptionIds = model.searchStrategyIds.filter((optionId) => concrete.has(optionId));
  return task.searchEnabled && searchOptionIds.length === 0
    ? { ok: false, code: "scheduled_task_search_unavailable" }
    : { ok: true, searchOptionIds };
}
