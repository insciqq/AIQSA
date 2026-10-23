import type { ChatDefaultMcpMode, ChatDefaultSkillsMode } from "../../../contracts/chatDefaults";
import type { CatalogWireModel, CatalogWireSearchStrategy } from "../../../contracts/catalog";
import { reconcileModelSearchPlan } from "../../../domain/catalogMatrix";
import type { ContentBlock } from "../../../domain/content";
import type { SearchPlan } from "../../../domain/search";
import {
  assistantRunControlIssue, materializeAssistantRunParams, runControlsFromSavedValues
} from "../../assistants/runControlMaterialization";

/**
 * The send body of a Telegram message, built explicitly from the user's
 * current catalog: the server applies no saved defaults of its own (only the
 * browser does), so every value the composer would send is named here —
 * model, Search plan reconciled with the model, MCP and Skills modes, the
 * saved controls as params, Workspace and Agent from the link — plus the
 * expected leaf and, for a first message, the personal draft. In an
 * Assistant chat the Assistant governs those rows, so none of them is sent.
 * Both kinds carry the zone the user's browser last reported, as a browser
 * send carries its own; without one the run keeps the recorded UTC fallback.
 * Catalog, entitlement and every value are checked again by the send handler.
 */

/** A catalog model with the parameter dialect admission maps its controls to. */
export type TelegramCatalogModel = CatalogWireModel & Readonly<{ parameterDialect: string }>;

export type TelegramRunCatalog = Readonly<{
  models: readonly TelegramCatalogModel[];
  searchStrategies: readonly CatalogWireSearchStrategy[];
  defaults: Readonly<{
    /** Saved control values per `provider:modelId`. */
    controlValues: Readonly<Record<string, unknown>>;
    mcpMode: ChatDefaultMcpMode;
    skillsMode: ChatDefaultSkillsMode;
    /** The personal or organization default model; empty when there is none. */
    modelId: string;
    provider: string;
    /** The user's preferred Search selection. */
    searchPlan: SearchPlan;
  }>;
}>;

export type TelegramModelRef = Readonly<{ modelId: string; provider: string }>;

export type TelegramModelResolution =
  | Readonly<{ ok: true; model: TelegramCatalogModel }>
  | Readonly<{ ok: false; code: "model_unavailable" | "no_model" }>;

export function findTelegramModel(catalog: TelegramRunCatalog, ref: TelegramModelRef | null): TelegramCatalogModel | null {
  if (!ref?.modelId || !ref.provider) return null;
  return catalog.models.find((model) => model.modelId === ref.modelId && model.provider === ref.provider) ?? null;
}

/**
 * The model of an ordinary chat's next run: the link's choice (`/model`),
 * else the chat's model, else the catalog default, else the model a new web
 * chat starts with when no default is set (the first non-test model, then
 * the first). A choice that is no longer in the catalog is refused, never
 * replaced by another model.
 */
export function resolveTelegramModel(catalog: TelegramRunCatalog, input: Readonly<{
  selected: TelegramModelRef | null; chatModel: TelegramModelRef | null;
}>): TelegramModelResolution {
  const explicit = input.selected?.modelId ? input.selected : input.chatModel?.modelId ? input.chatModel : null;
  if (explicit) {
    const model = findTelegramModel(catalog, explicit);
    return model ? { model, ok: true } : { code: "model_unavailable", ok: false };
  }
  const fallback = findTelegramModel(catalog, { modelId: catalog.defaults.modelId, provider: catalog.defaults.provider }) ??
    catalog.models.find((model) => model.provider !== "fake") ?? catalog.models[0];
  return fallback ? { model: fallback, ok: true } : { code: "no_model", ok: false };
}

/**
 * Search on: the user's preferred options the model supports, else its first
 * usable option, else none (the model offers no Search, as the composer
 * shows it). Search off: no options.
 */
export function telegramSearchPlan(catalog: TelegramRunCatalog, model: TelegramCatalogModel, enabled: boolean): SearchPlan {
  const off: SearchPlan = { mode: "all_selected", optionIds: [] };
  if (!enabled) return off;
  const preferred = reconcileModelSearchPlan(model, catalog.defaults.searchPlan.optionIds, catalog.defaults.searchPlan.mode,
    catalog.searchStrategies);
  if (preferred.optionIds.length > 0) return { mode: preferred.mode, optionIds: [...preferred.optionIds] };
  const concrete = new Set(catalog.searchStrategies.filter((option) => option.kind !== "none").map((option) => option.strategyId));
  const first = model.searchStrategyIds.find((optionId) => concrete.has(optionId));
  if (!first) return off;
  const fallback = reconcileModelSearchPlan(model, [first], "all_selected", catalog.searchStrategies);
  return fallback.optionIds.length > 0 ? { mode: fallback.mode, optionIds: [...fallback.optionIds] } : off;
}

function savedControlDraft(value: unknown): Record<string, boolean | string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const saved = value as Record<string, unknown>;
  const draft: Record<string, boolean | string> = {};
  for (const key of ["backgroundMode", "streamMode"]) if (typeof saved[key] === "boolean") draft[key] = saved[key] as boolean;
  for (const key of ["maxOutputTokens", "reasoningEffort", "reasoningMode", "temperature"]) {
    if (typeof saved[key] === "string") draft[key] = saved[key] as string;
  }
  return draft;
}

/**
 * The user's saved controls for the model as run params, through the same
 * server materialization Assistants use. A saved control the
 * model no longer supports is left at the model's default, as the composer
 * shows it; null when the controls cannot be materialized at all (the
 * server then uses the model's defaults).
 */
export function telegramRunControls(catalog: TelegramRunCatalog, model: TelegramCatalogModel): Readonly<{
  params: Record<string, unknown>; controlDefaults: Record<string, boolean | string>;
}> | null {
  const draft = savedControlDraft(catalog.defaults.controlValues[`${model.provider}:${model.modelId}`]);
  const supported: Record<string, boolean | string> = {};
  for (const [key, value] of Object.entries(draft)) {
    const controls = runControlsFromSavedValues({ [key]: value });
    if (controls && assistantRunControlIssue(controls, model.parameterControls) === null) supported[key] = value;
  }
  const runControls = runControlsFromSavedValues(supported);
  if (!runControls) return null;
  const materialized = materializeAssistantRunParams({
    baseParams: { ...model.defaultParams }, controls: model.parameterControls, parameterProvider: model.parameterDialect, runControls
  });
  return materialized.ok ? { controlDefaults: supported, params: materialized.params } : null;
}

export type TelegramSendTarget =
  | Readonly<{ kind: "existing"; activeLeafMessageId: string | null; assistantBound: boolean }>
  | Readonly<{ kind: "new"; assistantId: string | null }>;

export type TelegramSendSettings = Readonly<{ agentEnabled: boolean; searchEnabled: boolean; workspaceEnabled: boolean }>;

export type TelegramSystemTurn = Readonly<{ approvalId: string; kind: "mcp_approval_continuation" }>;

export function buildTelegramSendBody(input: Readonly<{
  admissionId: string;
  catalog: TelegramRunCatalog;
  content: readonly ContentBlock[];
  /** The ordinary chat's model; ignored when an Assistant governs the chat. */
  model: TelegramCatalogModel | null;
  settings: TelegramSendSettings;
  systemTurn?: TelegramSystemTurn;
  target: TelegramSendTarget;
  /** The IANA zone the user's browser last reported; null or absent omits it. */
  timeZone?: string | null;
}>): Record<string, unknown> {
  const { settings, target } = input;
  const common: Record<string, unknown> = {
    admissionId: input.admissionId,
    content: { blocks: input.content.map((block) => ({ ...block })) },
    expectedActiveLeafId: target.kind === "existing" ? target.activeLeafMessageId : null,
    ...(target.kind === "new" ? { personalDraft: { folderId: null, memoryMode: "NORMAL" } } : {}),
    ...(input.systemTurn ? { systemTurn: { approvalId: input.systemTurn.approvalId, kind: input.systemTurn.kind } } : {}),
    ...(input.timeZone ? { timeZone: input.timeZone } : {})
  };
  const assistantChat = target.kind === "existing" ? target.assistantBound : target.assistantId !== null;
  if (assistantChat || !input.model) {
    // The Assistant's rows govern; only the Workspace switch, its binding and the time zone travel.
    return {
      ...common,
      ...(target.kind === "new" && target.assistantId ? { assistantId: target.assistantId } : {}),
      workspace: { enabled: settings.workspaceEnabled }
    };
  }
  const model = input.model;
  const toolCalling = model.capabilities.toolCalling;
  const agent = settings.agentEnabled && model.agentAvailable === true;
  const controls = telegramRunControls(input.catalog, model);
  return {
    ...common,
    modelId: model.modelId,
    provider: model.provider,
    searchPlan: telegramSearchPlan(input.catalog, model, settings.searchEnabled),
    mcp: { mode: input.catalog.defaults.mcpMode },
    skills: { mode: input.catalog.defaults.skillsMode },
    ...(controls ? { controlDefaults: controls.controlDefaults, params: controls.params } : {}),
    // Like the composer, a model without tool calling asks for no tools and has no Workspace.
    ...(toolCalling ? {} : { tools: "none" }),
    workspace: { enabled: agent || (settings.workspaceEnabled && toolCalling) },
    ...(agent ? { agentEnabled: true } : {})
  };
}
