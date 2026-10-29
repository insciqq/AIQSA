import type { CatalogWireModel } from "../../../contracts/catalog";
import { SUBAGENT_ERROR_CODES, SUBAGENT_LIMITS, type SubagentBindingSource } from "../../../contracts/subagents";

/**
 * The models a run may give its sub-agents (integrator decision 2026-10-30):
 * admission freezes the user's tool-calling chat models from the same
 * server-filtered catalog that admits the answer model, so a `model` a
 * `call_subagent` names is checked against the entitlement the run was
 * admitted with, never against current settings or a model's claim. The
 * execution snapshot of a model other than the parent's is built at its first
 * use (`modelRoutes.ts`); one no longer resolvable is refused, never
 * substituted. Pure: admission and the engine both read this module.
 */

/** Models one run freezes for its sub-agents; the user's catalog bounds it first. */
export const SUBAGENT_MODEL_CATALOG_LIMIT = 64;

const EFFORT_OPTIONS_LIMIT = 16;
const TEXT_LIMIT = 256;

/** One model admission froze for sub-agents, by its catalog identity (`CatalogWireModel`). */
export type SubagentModelEntry = Readonly<{
  /** The catalog's provider: the connection that serves the model. */
  connectionId: string;
  contextWindow: number | null;
  /** Null: the model has no reasoning control, or its default is its own. */
  defaultEffort: string | null;
  displayName: string;
  imageInput: boolean;
  providerFamily: string;
  /** The catalog's model id (`ProviderModel.id`), what admission binds. */
  providerModelId: string;
  /** Efforts the model's reasoning control offers; empty without one. */
  reasoningEfforts: readonly string[];
  /** The upstream model id, what the main agent names in `call_subagent`. */
  upstreamModelId: string;
}>;

export type FrozenSubagentModels = Readonly<{ models: readonly SubagentModelEntry[]; version: 1 }>;

const text = (value: unknown, max = TEXT_LIMIT): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/u.test(value);

/** The user's tool-calling chat models, in catalog order and bounded, as admission freezes them. */
export function freezeSubagentModels(models: readonly CatalogWireModel[]): FrozenSubagentModels {
  const frozen: SubagentModelEntry[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    if (frozen.length >= SUBAGENT_MODEL_CATALOG_LIMIT) break;
    if (model.capabilities.toolCalling !== true || !text(model.provider) || !text(model.modelId)) continue;
    const key = `${model.provider}\n${model.modelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const control = model.parameterControls.reasoningEffort;
    const efforts = control.supported
      ? [...new Set(control.options.filter((option) => text(option, SUBAGENT_LIMITS.effortCharacters)))].slice(0, EFFORT_OPTIONS_LIMIT)
      : [];
    frozen.push({
      connectionId: model.provider,
      contextWindow: Number.isSafeInteger(model.contextWindow) && Number(model.contextWindow) > 0 ? model.contextWindow : null,
      defaultEffort: control.supported && efforts.includes(control.defaultValue) ? control.defaultValue : null,
      displayName: text(model.displayName) ? model.displayName : model.modelId,
      imageInput: model.capabilities.imageInput === true,
      providerFamily: text(model.providerFamily) ? model.providerFamily : "unknown",
      providerModelId: model.modelId,
      reasoningEfforts: efforts,
      upstreamModelId: text(model.upstreamModelId) ? model.upstreamModelId : model.modelId
    });
  }
  return { models: frozen, version: 1 };
}

function decodeEntry(value: unknown): SubagentModelEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const efforts = entry.reasoningEfforts;
  if (!text(entry.connectionId) || !text(entry.providerModelId) || !text(entry.displayName) || !text(entry.providerFamily) ||
    !text(entry.upstreamModelId) || typeof entry.imageInput !== "boolean" ||
    !(entry.contextWindow === null || Number.isSafeInteger(entry.contextWindow) && Number(entry.contextWindow) > 0) ||
    !Array.isArray(efforts) || efforts.length > EFFORT_OPTIONS_LIMIT ||
    !efforts.every((effort) => text(effort, SUBAGENT_LIMITS.effortCharacters)) ||
    !(entry.defaultEffort === null || typeof entry.defaultEffort === "string" && efforts.includes(entry.defaultEffort))) return null;
  return {
    connectionId: entry.connectionId, contextWindow: entry.contextWindow as number | null,
    defaultEffort: entry.defaultEffort as string | null, displayName: entry.displayName, imageInput: entry.imageInput,
    providerFamily: entry.providerFamily, providerModelId: entry.providerModelId, reasoningEfforts: [...efforts as string[]],
    upstreamModelId: entry.upstreamModelId
  };
}

/** The frozen list of an accepted request (`NormalizedRunRequest.subagentModels`); null when absent or malformed. */
export function decodeSubagentModels(value: unknown): FrozenSubagentModels | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || !Array.isArray(record.models) || record.models.length > SUBAGENT_MODEL_CATALOG_LIMIT) return null;
  const models = record.models.map(decodeEntry);
  return models.every((entry): entry is SubagentModelEntry => entry !== null) ? { models, version: 1 } : null;
}

/** The parent run's own binding, as the sub-agent default inherits it. */
export type SubagentParentModel = Readonly<{
  connectionId: string;
  /** The effort the parent run admitted (`NormalizedRunRequest.reasoningEffort`); null for the model's default. */
  effort: string | null;
  /** Efforts the parent's model offers: its frozen entry's, else its admitted capabilities'. */
  efforts: readonly string[];
  providerModelId: string;
  upstreamModelId: string;
}>;

/** What a turn's binding may carry over from the thread's latest turn (`SubagentTurn`). */
export type SubagentPreviousBinding = Readonly<{
  connectionId: string;
  effort: string | null;
  effortSource: SubagentBindingSource;
  modelSource: SubagentBindingSource;
  providerModelId: string | null;
}>;

/** A model and effort chosen for a turn: the parent's own route, or a frozen catalog entry. */
export type SubagentModelChoice = Readonly<{
  effort: string | null;
  effortSource: SubagentBindingSource;
  /** Null: the parent's model. */
  entry: SubagentModelEntry | null;
  modelSource: SubagentBindingSource;
}>;

export type SubagentModelChoiceResult =
  | Readonly<{ choice: SubagentModelChoice; ok: true }>
  | Readonly<{ code: typeof SUBAGENT_ERROR_CODES.effortUnsupported | typeof SUBAGENT_ERROR_CODES.modelUnavailable;
    message: string; ok: false }>;

/** A requested model, by the names the context lists: the catalog id exactly, else one upstream id or display name. */
export function findSubagentModel(catalog: FrozenSubagentModels | null, requested: string): SubagentModelEntry | null | "ambiguous" {
  const models = catalog?.models ?? [];
  const exact = models.find((entry) => entry.providerModelId === requested);
  if (exact) return exact;
  const wanted = requested.trim().toLowerCase();
  const matches = models.filter((entry) => entry.upstreamModelId.toLowerCase() === wanted ||
    entry.displayName.toLowerCase() === wanted);
  if (matches.length > 1) return "ambiguous";
  return matches[0] ?? null;
}

const sameModel = (entry: SubagentModelEntry, parent: SubagentParentModel) =>
  entry.providerModelId === parent.providerModelId && entry.connectionId === parent.connectionId;

/** Whether the turn runs on the model the thread's previous turn ran on. */
function sameModelAsPrevious(chosen: SubagentModelEntry | null, previous: SubagentPreviousBinding, parent: SubagentParentModel): boolean {
  const model = chosen ?? { connectionId: parent.connectionId, providerModelId: parent.providerModelId };
  return previous.providerModelId === model.providerModelId && previous.connectionId === model.connectionId;
}

/**
 * The model and effort of one turn. Precedence (Claude Code's Agent tool is
 * the reference): the call's `model` and `effort`, then the custom
 * sub-agent's, then what a continued thread chose before (a model or effort
 * from a call or a type stays), then the parent run's binding. A model must
 * be in the frozen list (or be the parent's), and an effort one that model
 * offers; anything else is refused with its stable code, never substituted.
 * This is also how the profiles task resolves a type's model and effort.
 */
export function chooseSubagentModel(input: Readonly<{
  call: Readonly<{ effort?: string; model?: string }>;
  catalog: FrozenSubagentModels | null;
  parent: SubagentParentModel;
  previous?: SubagentPreviousBinding | null;
  type?: Readonly<{ providerModelId: string | null; reasoningEffort: string | null }> | null;
}>): SubagentModelChoiceResult {
  const unavailable = (message: string) => ({ code: SUBAGENT_ERROR_CODES.modelUnavailable, message, ok: false as const });
  let entry: SubagentModelEntry | null = null;
  let modelSource: SubagentBindingSource = "parent";
  const pick = (requested: string, source: SubagentBindingSource): SubagentModelChoiceResult | null => {
    const found = findSubagentModel(input.catalog, requested);
    const parentNamed = requested === input.parent.providerModelId || requested.trim().toLowerCase() ===
      input.parent.upstreamModelId.toLowerCase();
    if (found === "ambiguous") return unavailable(`Several of the user's models are named ${JSON.stringify(requested)}; name one by its id from the list.`);
    if (!found && !parentNamed) {
      return unavailable(`${JSON.stringify(requested)} is not one of the user's models for sub-agents; pick one from the list or omit model.`);
    }
    entry = found && !sameModel(found, input.parent) ? found : null;
    modelSource = source;
    return null;
  };
  const previous = input.previous ?? null;
  if (input.call.model !== undefined) {
    const refused = pick(input.call.model, "call");
    if (refused) return refused;
  } else if (input.type?.providerModelId) {
    const refused = pick(input.type.providerModelId, "type");
    if (refused) return refused;
  } else if (previous && previous.modelSource !== "parent" && previous.providerModelId) {
    const found = (input.catalog?.models ?? []).find((candidate) => candidate.providerModelId === previous.providerModelId &&
      candidate.connectionId === previous.connectionId);
    const parentModel = previous.providerModelId === input.parent.providerModelId && previous.connectionId === input.parent.connectionId;
    if (!found && !parentModel) return unavailable("The model this sub-agent ran on is no longer one of the user's models; pass model to choose another.");
    entry = found && !parentModel ? found : null;
    modelSource = previous.modelSource;
  }
  const chosen = entry as SubagentModelEntry | null;
  const efforts = chosen ? chosen.reasoningEfforts : input.parent.efforts;
  let effort: string | null;
  let effortSource: SubagentBindingSource;
  if (input.call.effort !== undefined) {
    effort = input.call.effort;
    effortSource = "call";
  } else if (input.type?.reasoningEffort) {
    effort = input.type.reasoningEffort;
    effortSource = "type";
  } else if (previous && previous.effortSource !== "parent" && sameModelAsPrevious(chosen, previous, input.parent)) {
    // An effort a call or a type chose stays with the thread while it runs on that same model.
    effort = previous.effort;
    effortSource = previous.effortSource;
  } else {
    effort = chosen ? chosen.defaultEffort : input.parent.effort;
    effortSource = "parent";
  }
  if (effort !== null && !efforts.includes(effort)) {
    return { code: SUBAGENT_ERROR_CODES.effortUnsupported, ok: false,
      message: efforts.length > 0
        ? `${JSON.stringify(effort)} is not an effort this model supports; use one of ${efforts.join(", ")} or omit effort.`
        : "This model has no reasoning effort to choose; omit effort." };
  }
  return { choice: { effort, effortSource, entry: chosen, modelSource }, ok: true };
}
