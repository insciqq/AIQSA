import type { CatalogWireModel } from "../../contracts/catalog";
import { stripEndpointHostFragments } from "../../contracts/providerConnectionLabels";
import {
  SUBAGENT_DEFINITION_CODES,
  subagentModelLabel,
  subagentModelReferenceKey,
  type SubagentDefinitionDraft,
  type SubagentModelOption
} from "../../contracts/subagentDefinitions";
import { currentUserConnectionLabels, resolveCurrentUserCatalogSelection, type CatalogData } from "../catalog/currentUserCatalog";

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

/**
 * The options over the user's catalog models, each named with its connection's
 * label (`currentUserConnectionLabels`), since two connections may serve
 * models of the same name.
 */
export function subagentModelOptions(models: readonly CatalogWireModel[], connectionLabels: ReadonlyMap<string, string>): SubagentModelOption[] {
  return models.filter((model) => model.capabilities.toolCalling).map((model) => {
    const effort = model.parameterControls.reasoningEffort;
    const efforts = effort.supported ? [...new Set(effort.options)].filter((option) => option.length > 0) : [];
    return {
      // The labels cover every catalog connection; the fallback is the label ordinary UI gives a nameless one.
      connectionName: connectionLabels.get(model.provider) ?? stripEndpointHostFragments(""),
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
    if (!data) return null;
    const models = resolveCurrentUserCatalogSelection(data).models;
    return subagentModelOptions(models, currentUserConnectionLabels(data.models, models));
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

/** What a model reference names: one model, several (refused, never guessed), or none. */
export type SubagentModelMatch =
  | Readonly<{ kind: "found"; option: SubagentModelOption }>
  | Readonly<{ candidates: readonly SubagentModelOption[]; kind: "ambiguous" }>
  | Readonly<{ kind: "none" }>;

/**
 * The model a tool call names: its catalog id exactly, else the one model
 * whose id, name or labelled name ("GPT-6 Luna · Codex LB", as the lists show
 * it) it names, case- and whitespace-insensitively. A name several models
 * share is ambiguous: the refusal lists them, so the next call can be exact.
 */
export function findSubagentModel(options: readonly SubagentModelOption[], reference: string): SubagentModelMatch {
  const exact = options.find((option) => option.modelId === reference);
  if (exact) return { kind: "found", option: exact };
  const key = subagentModelReferenceKey(reference);
  if (!key) return { kind: "none" };
  const named = options.filter((option) => [option.modelId, option.displayName, subagentModelLabel(option)]
    .some((name) => subagentModelReferenceKey(name) === key));
  if (named.length === 1) return { kind: "found", option: named[0]! };
  return named.length > 1 ? { candidates: named, kind: "ambiguous" } : { kind: "none" };
}
