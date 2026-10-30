import type { CatalogWireModel } from "../../contracts/catalog";
import { SUBAGENT_DEFINITION_CODES, type SubagentDefinitionDraft, type SubagentModelOption } from "../../contracts/subagentDefinitions";
import { resolveCurrentUserCatalogSelection, type CatalogData } from "../catalog/currentUserCatalog";

/**
 * The models a custom sub-agent may name: the user's current, server-filtered
 * catalog of tool-calling chat models (entitlements applied), with the
 * reasoning efforts each takes. Studio and the agent's tools check a
 * definition against it when it is saved; a turn that uses the type checks
 * the model again against its run's frozen catalog and refuses it visibly
 * when it is gone (`subagent_type_unavailable`), never substituting another.
 */

/** The user's sub-agent model options, or null when the catalog cannot be read now. */
export type SubagentModelSource = (userId: string) => Promise<readonly SubagentModelOption[] | null>;

export function subagentModelOptions(models: readonly CatalogWireModel[]): SubagentModelOption[] {
  return models.filter((model) => model.capabilities.toolCalling).map((model) => {
    const effort = model.parameterControls.reasoningEffort;
    const efforts = effort.supported ? [...new Set(effort.options)].filter((option) => option.length > 0) : [];
    return {
      defaultEffort: efforts.includes(effort.defaultValue) ? effort.defaultValue : null,
      displayName: model.displayName,
      efforts,
      modelId: model.modelId
    };
  });
}

/** The production source over the catalog loader Studio uses (`createPrismaCatalogDataLoader`). */
export function catalogSubagentModelSource(loadCatalogData: (userId: string) => Promise<CatalogData | null>): SubagentModelSource {
  return async (userId) => {
    const data = await loadCatalogData(userId);
    return data ? subagentModelOptions(resolveCurrentUserCatalogSelection(data).models) : null;
  };
}

export type SubagentModelRefusal = Readonly<{ code: string; field: "effort" | "model" }>;

/**
 * Whether the draft's model and effort are the user's: a set model is one of
 * the options and an effort one it takes; an effort without a model must be
 * one at least one of the user's models takes, and a turn on a parent model
 * without it is refused at the call (`subagent_effort_unsupported`).
 */
export function subagentModelRefusal(draft: Pick<SubagentDefinitionDraft, "effort" | "modelId">,
  options: readonly SubagentModelOption[]): SubagentModelRefusal | null {
  if (draft.modelId !== null) {
    const model = options.find((option) => option.modelId === draft.modelId);
    if (!model) return { code: SUBAGENT_DEFINITION_CODES.modelUnavailable, field: "model" };
    if (draft.effort !== null && !model.efforts.includes(draft.effort)) return { code: SUBAGENT_DEFINITION_CODES.effortUnsupported, field: "effort" };
    return null;
  }
  if (draft.effort !== null && !options.some((option) => option.efforts.includes(draft.effort!))) {
    return { code: SUBAGENT_DEFINITION_CODES.effortUnsupported, field: "effort" };
  }
  return null;
}

const fold = (value: string) => value.trim().toLocaleLowerCase("en-US");

/**
 * The model a tool call names: its catalog id, or its display name when that
 * names exactly one of the user's models. Null when it names none or several.
 */
export function findSubagentModel(options: readonly SubagentModelOption[], reference: string): SubagentModelOption | null {
  const exact = options.find((option) => option.modelId === reference);
  if (exact) return exact;
  const named = options.filter((option) => fold(option.displayName) === fold(reference) || fold(option.modelId) === fold(reference));
  return named.length === 1 ? named[0]! : null;
}
