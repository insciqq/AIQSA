import type {
  AssistantRunControls
} from "../../contracts/assistants";
import type { CatalogWireModel } from "../../contracts/catalog";
import type { SearchPlan } from "../../contracts/search";
import { isSearchCombinationCompatible } from "../../domain/catalogMatrix";
import {
  buildMcpRunPlan,
  type McpRunPlanRecord
} from "../mcp/runPlan";
import { assistantRunControlsSupported } from "./runControlMaterialization";

export type AssistantCatalogView = {
  accessibleMcpServerIds: ReadonlySet<string>;
  entitledSearchOptionIds: ReadonlySet<string>;
  mcpRunPlan: {
    isGenerationLive(generationId: string): boolean;
    now: Date;
    recordsByServerId: ReadonlyMap<string, McpRunPlanRecord>;
  };
  modelById: ReadonlyMap<string, CatalogWireModel>;
};

export type AssistantCatalogValidationFailure =
  | "model"
  | "run_controls"
  | "search"
  | "tools";

export type AssistantCatalogConfiguration = {
  mcpServerIds: readonly string[];
  providerModelId: string;
  runControls: AssistantRunControls;
  searchPlan: SearchPlan;
};

/**
 * Validates an Assistant configuration against the same runner-filtered model
 * projection used by the Composer. This is deliberately pure so create,
 * revise, duplicate, and availability cannot drift into different capability
 * interpretations.
 */
export function validateAssistantConfigurationAgainstCatalog(
  configuration: AssistantCatalogConfiguration,
  view: AssistantCatalogView,
  options: { requireRunnableMcp: boolean }
): AssistantCatalogValidationFailure | null {
  const model = view.modelById.get(configuration.providerModelId);
  if (!model) return "model";

  if (!assistantRunControlsSupported(configuration.runControls, model.parameterControls)) {
    return "run_controls";
  }

  const searchOptions = configuration.searchPlan.optionIds.map((optionId) => {
    if (!view.entitledSearchOptionIds.has(optionId)) return null;
    const compatibility = model.searchOptionCompatibility?.[optionId];
    if (!compatibility || !model.searchStrategyIds.includes(optionId)) return null;
    return {
      executionModes: compatibility.executionModes,
      kind: "web_search" as const,
      strategyId: optionId
    };
  });
  if (
    searchOptions.some((option) => option === null) ||
    !isSearchCombinationCompatible(
      configuration.searchPlan.optionIds,
      searchOptions.filter((option) => option !== null),
      configuration.searchPlan.mode
    )
  ) {
    return "search";
  }

  if (configuration.searchPlan.optionIds.length > 1) {
    const optionsWithoutClientRoute = configuration.searchPlan.optionIds.filter(
      (optionId) =>
        model.searchOptionCompatibility?.[optionId]?.clientToolCompatible !== true
    ).length;
    const maximumHostedRoutes = configuration.searchPlan.mode === "model_choice" ? 1 : 0;
    if (optionsWithoutClientRoute > maximumHostedRoutes) return "search";
  }

  // Run admission forces Search onto a client route whenever MCP tools are
  // selected. The ordinary catalog exposes only this route-existence bit, not
  // the technical route/model identity. Requiring it for every selected
  // source also proves a complete all-client assignment for multi-source
  // plans; the mode check above proves that assignment supports the mode.
  if (
    configuration.mcpServerIds.length > 0 &&
    configuration.searchPlan.optionIds.some((optionId) =>
      model.searchOptionCompatibility?.[optionId]?.clientToolCompatible !== true
    )
  ) {
    return "search";
  }

  const selectedMcpRecords = configuration.mcpServerIds.map((serverId) =>
    view.mcpRunPlan.recordsByServerId.get(serverId)
  );

  if (
    configuration.mcpServerIds.some(
      (serverId) => !view.accessibleMcpServerIds.has(serverId)
    ) ||
    (configuration.mcpServerIds.length > 0 && !model.capabilities.toolCalling) ||
    (options.requireRunnableMcp &&
      (selectedMcpRecords.some((record) => !record) ||
        !buildMcpRunPlan(
          selectedMcpRecords.filter(
            (record): record is McpRunPlanRecord => Boolean(record)
          ),
          view.mcpRunPlan.now,
          view.mcpRunPlan.isGenerationLive
        ).ok))
  ) {
    return "tools";
  }

  return null;
}
