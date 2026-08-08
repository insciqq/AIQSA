import type {
  CatalogModel,
  CatalogSearchStrategy
} from "@/components/app-shell/types";
import { reconcileSearchPlanSelection } from "@/lib/domain/catalogMatrix";
import type { SearchPlan, SearchPlanMode } from "@/lib/domain/search";

export type SearchPlanCompatibilityProjection = {
  compatibleOptionIds: string[];
  effectivePlan: SearchPlan;
  executionModesByOptionId: Record<string, SearchPlanMode[]>;
};

export function projectSearchPlanCompatibility(input: {
  mode: SearchPlanMode;
  model: CatalogModel | undefined;
  modelCompatibleOptionIds?: readonly string[];
  searchOptions: readonly CatalogSearchStrategy[];
  selectedOptionIds: readonly string[];
}): SearchPlanCompatibilityProjection {
  const modelCompatibleOptionIds = input.modelCompatibleOptionIds ??
    input.model?.searchStrategyIds ??
    [];
  const concreteOptionIds = new Set(
    input.searchOptions
      .filter((option) => option.kind !== "none")
      .map((option) => option.strategyId)
  );
  const compatibleOptionIds = modelCompatibleOptionIds.filter((optionId) =>
    concreteOptionIds.has(optionId)
  );
  const compatibleOptionIdSet = new Set(compatibleOptionIds);
  const executionModesByOptionId = Object.fromEntries(
    input.searchOptions.map((option) => [
      option.strategyId,
      [
        ...(input.model?.searchOptionCompatibility?.[option.strategyId]?.executionModes ??
          option.executionModes ??
          [])
      ]
    ])
  );
  const effectiveOptions = input.searchOptions.map((option) => ({
    ...option,
    executionModes: executionModesByOptionId[option.strategyId]
  }));

  return {
    compatibleOptionIds,
    effectivePlan: reconcileSearchPlanSelection(
      input.selectedOptionIds.filter((optionId) => compatibleOptionIdSet.has(optionId)),
      input.mode,
      effectiveOptions
    ),
    executionModesByOptionId
  };
}
