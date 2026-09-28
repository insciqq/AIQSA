import {
  ASSISTANT_ROW_KEYS,
  assistantRowPolicyViolation,
  type AssistantDuplicateReport,
  type AssistantRowKey,
  type AssistantRows,
  type AssistantRowValues
} from "../../contracts/assistants";
import type { CatalogWireModel } from "../../contracts/catalog";
import type { SearchPlanMode } from "../../contracts/search";
import { isSearchCombinationCompatible } from "../../domain/catalogMatrix";
import {
  buildMcpRunPlan,
  isMcpRunPlanRecordStartable,
  type McpRunPlanRecord
} from "../mcp/runPlan";
import {
  assistantRunControlIssue,
  type AssistantRunControlIssue
} from "./runControlMaterialization";

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
  | "search"
  | "tools"
  | ({ kind: "run_controls" } & AssistantRunControlIssue);

export type AssistantMcpRunnability = "accessible" | "exact" | "startable";

/** The rows checked against a catalog; Knowledge and Skills have their own readers. */
export type AssistantCatalogRowValues = Pick<AssistantRowValues, "controls" | "model" | "search" | "tools">;

/** Rows whose concrete value the viewer cannot use; an absent key is usable. */
export type AssistantRowCatalogFailures = {
  controls?: AssistantRunControlIssue;
  model?: true;
  search?: true;
  tools?: true;
};

function searchFails(
  search: Readonly<{ mode: SearchPlanMode; optionIds: readonly string[] }>,
  model: CatalogWireModel | undefined,
  view: AssistantCatalogView,
  withMcp: boolean
): boolean {
  if (search.optionIds.some((optionId) => !view.entitledSearchOptionIds.has(optionId))) return true;
  // Compatibility belongs to the Assistant's model; with an inherited or
  // unavailable model, admission checks it against the model actually used.
  if (!model) return false;
  const searchOptions = search.optionIds.map((optionId) => {
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
      [...search.optionIds],
      searchOptions.filter((option) => option !== null),
      search.mode
    )
  ) {
    return true;
  }

  if (search.optionIds.length > 1) {
    const optionsWithoutClientRoute = search.optionIds.filter(
      (optionId) =>
        model.searchOptionCompatibility?.[optionId]?.clientToolCompatible !== true
    ).length;
    const maximumHostedRoutes = search.mode === "model_choice" ? 1 : 0;
    if (optionsWithoutClientRoute > maximumHostedRoutes) return true;
  }

  // Run admission forces Search onto a client route whenever MCP tools are
  // selected. The ordinary catalog exposes only this route-existence bit, not
  // the technical route/model identity. Requiring it for every selected
  // source also proves a complete all-client assignment for multi-source
  // plans; the mode check above proves that assignment supports the mode.
  return withMcp && search.optionIds.some((optionId) =>
    model.searchOptionCompatibility?.[optionId]?.clientToolCompatible !== true
  );
}

function toolsFail(
  serverIds: readonly string[],
  model: CatalogWireModel | undefined,
  view: AssistantCatalogView,
  runnability: AssistantMcpRunnability
): boolean {
  const selectedMcpRecords = serverIds.map((serverId) =>
    view.mcpRunPlan.recordsByServerId.get(serverId)
  );
  return serverIds.some((serverId) => !view.accessibleMcpServerIds.has(serverId)) ||
    (model !== undefined && !model.capabilities.toolCalling) ||
    (runnability === "startable" &&
      selectedMcpRecords.some((record) => !record || !isMcpRunPlanRecordStartable(record))) ||
    (runnability === "exact" &&
      (selectedMcpRecords.some((record) => !record) ||
        !buildMcpRunPlan(
          selectedMcpRecords.filter(
            (record): record is McpRunPlanRecord => Boolean(record)
          ),
          view.mcpRunPlan.now,
          view.mcpRunPlan.isGenerationLive
        ).ok));
}

/**
 * Checks every concrete row value against the same runner-filtered model
 * projection used by the Composer, whatever the row's policy; inherit, Off and
 * None need no catalog entry. This is deliberately pure so save, duplicate,
 * and availability cannot drift into different capability interpretations.
 * Controls, Search compatibility and model tool calling are judged against
 * the Assistant's own model only while the viewer can use it.
 */
export function assistantRowCatalogFailures(
  values: AssistantCatalogRowValues,
  view: AssistantCatalogView,
  options: { mcpRunnability: AssistantMcpRunnability }
): AssistantRowCatalogFailures {
  const failures: AssistantRowCatalogFailures = {};
  const model = values.model.mode === "model" && values.model.modelId !== null
    ? view.modelById.get(values.model.modelId)
    : undefined;
  if (values.model.mode === "model" && !model) failures.model = true;
  const controlIssue = model ? assistantRunControlIssue(values.controls, model.parameterControls) : null;
  if (controlIssue) failures.controls = controlIssue;
  const serverIds = values.tools.mode === "exact" ? values.tools.serverIds : [];
  if (
    values.search.mode !== "inherit" && values.search.mode !== "off" &&
    searchFails(values.search, model, view, serverIds.length > 0)
  ) {
    failures.search = true;
  }
  if (serverIds.length > 0 && toolsFail(serverIds, model, view, options.mcpRunnability)) {
    failures.tools = true;
  }
  return failures;
}

/** The failure a writer reports first: model, then controls, Search and tools. */
export function firstAssistantCatalogFailure(
  failures: AssistantRowCatalogFailures
): AssistantCatalogValidationFailure | null {
  if (failures.model) return "model";
  if (failures.controls) return { kind: "run_controls", ...failures.controls };
  if (failures.search) return "search";
  if (failures.tools) return "tools";
  return null;
}

/** A catalog that grants nothing: no model, Search source or MCP server. */
export function emptyAssistantCatalogView(now: Date): AssistantCatalogView {
  return {
    accessibleMcpServerIds: new Set(),
    entitledSearchOptionIds: new Set(),
    mcpRunPlan: { isGenerationLive: () => false, now, recordsByServerId: new Map() },
    modelById: new Map()
  };
}

/**
 * Rows for a copy owned by `view`'s user: a row whose resources the copier
 * cannot use becomes an adjustable inherit (None for Knowledge), controls
 * reset with the model they belong to, and unusable Skill links are dropped.
 * Rows are reset one at a time, model first, because a usable model or tools
 * row can make a Search plan valid again.
 */
export function assistantRowsForCopier(
  rows: AssistantRows,
  view: AssistantCatalogView,
  usable: Readonly<{ knowledge: boolean; skillIds: ReadonlySet<string> }>
): { report: AssistantDuplicateReport; rows: AssistantRows } {
  const next: AssistantRows = { ...rows };
  const downgraded = new Set<AssistantRowKey>();
  const resetControls = () => {
    if (next.controls.policy === "adjustable" && Object.keys(next.controls.value).length === 0) return;
    next.controls = { policy: "adjustable", value: {} };
    downgraded.add("controls");
  };
  for (let attempt = 0; attempt <= ASSISTANT_ROW_KEYS.length; attempt += 1) {
    const failures = assistantRowCatalogFailures({
      controls: next.controls.value,
      model: next.model.value,
      search: next.search.value,
      tools: next.tools.value
    }, view, { mcpRunnability: "accessible" });
    if (failures.model) {
      next.model = { policy: "adjustable", value: { mode: "inherit" } };
      downgraded.add("model");
      resetControls();
    } else if (failures.tools) {
      next.tools = { policy: "adjustable", value: { mode: "inherit" } };
      downgraded.add("tools");
    } else if (failures.search) {
      next.search = { policy: "adjustable", value: { mode: "inherit" } };
      downgraded.add("search");
    } else if (failures.controls) {
      resetControls();
    } else {
      break;
    }
  }
  if (next.knowledge.value.mode === "explicit" && !usable.knowledge) {
    next.knowledge = { policy: "adjustable", value: { mode: "none" } };
    downgraded.add("knowledge");
  }
  const links = next.skills.value.links.filter((link) => usable.skillIds.has(link.skillId));
  const droppedSkillCount = next.skills.value.links.length - links.length;
  if (droppedSkillCount > 0) next.skills = { ...next.skills, value: { ...next.skills.value, links } };
  // Fixed controls need a fixed model; a reset model always resets them.
  if (assistantRowPolicyViolation(next)) throw new Error("assistant_definition_integrity_invalid");
  return {
    report: {
      downgradedRows: ASSISTANT_ROW_KEYS.filter((key) => downgraded.has(key)),
      droppedSkillCount
    },
    rows: next
  };
}
