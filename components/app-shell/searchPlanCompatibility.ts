import type {
  CatalogModel,
  CatalogSearchStrategy
} from "@/components/app-shell/types";
import { reconcileSearchPlanSelection } from "@/lib/domain/catalogMatrix";
import type { SearchPlan, SearchPlanMode } from "@/lib/domain/search";

export type SearchPlanCompatibilityProjection = {
  attachmentBlockedOptionIds: string[];
  compatibleOptionIds: string[];
  effectivePlan: SearchPlan;
  executionModesByOptionId: Record<string, SearchPlanMode[]>;
};

function attachmentCompatible(
  model: CatalogModel | undefined,
  option: CatalogSearchStrategy
): boolean {
  const compatibility = model?.searchOptionCompatibility?.[option.strategyId];
  if (compatibility) {
    return compatibility.attachments;
  }

  return !(
    option.adapterKind === "provider_model_client" ||
    option.kind === "perplexity_tool_search" ||
    option.kind === "provider_model_web_search"
  );
}

export function projectSearchPlanCompatibility(input: {
  hasAttachments: boolean;
  mode: SearchPlanMode;
  model: CatalogModel | undefined;
  modelCompatibleOptionIds?: readonly string[];
  searchOptions: readonly CatalogSearchStrategy[];
  selectedOptionIds: readonly string[];
}): SearchPlanCompatibilityProjection {
  const modelCompatibleOptionIds = input.modelCompatibleOptionIds ??
    input.model?.searchStrategyIds ??
    [];
  const attachmentBlockedOptionIds = input.hasAttachments
    ? input.searchOptions
        .filter((option) => !attachmentCompatible(input.model, option))
        .map((option) => option.strategyId)
    : [];
  const attachmentBlockedOptionIdSet = new Set(attachmentBlockedOptionIds);
  const concreteOptionIds = new Set(
    input.searchOptions
      .filter((option) => option.kind !== "none")
      .map((option) => option.strategyId)
  );
  const compatibleOptionIds = modelCompatibleOptionIds.filter(
    (optionId) =>
      concreteOptionIds.has(optionId) &&
      !attachmentBlockedOptionIdSet.has(optionId)
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
    attachmentBlockedOptionIds,
    compatibleOptionIds,
    effectivePlan: reconcileSearchPlanSelection(
      input.selectedOptionIds.filter((optionId) => compatibleOptionIdSet.has(optionId)),
      input.mode,
      effectiveOptions
    ),
    executionModesByOptionId
  };
}
