import { defaultParameterControls } from "@/components/app-shell/controlDefaults";
import {
  boundComposerAssistant,
  COMPOSER_ASSISTANT_ROW_FIELDS,
  type ComposerAssistantRow,
  type ComposerAssistantRowReset,
  type ComposerAssistantRows,
  type ComposerAssistantSkill,
  type ComposerAssistantState,
  type ComposerBoundAssistant,
  type ComposerControlSnapshot,
  type ComposerKnowledgePlanSource
} from "@/components/app-shell/composerControlStore";
import { resolvePreferredSearchPlan, type SavedControlDraft } from "@/components/app-shell/powerAppShellData";
import type { Catalog, CatalogModel } from "@/components/app-shell/types";
import {
  ASSISTANT_MAX_OUTPUT_TOKENS_CEILING,
  ASSISTANT_ROW_KEYS,
  assistantSkillModeForDelivery,
  type AssistantAvailability,
  type AssistantAvatarRecipe,
  type AssistantDetail,
  type AssistantRowAvailability,
  type AssistantRowDeviationKey,
  type AssistantRowKey,
  type AssistantRowProvenance,
  type AssistantRows,
  type AssistantRowValues,
  type AssistantRunControls
} from "@/lib/contracts/assistants";
import type {
  ChatAssistantOverrideValues,
  ChatAssistantProjection,
  ChatAssistantRowValues
} from "@/lib/contracts/chats";
import {
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  inheritedKnowledgeSelection,
  KNOWLEDGE_SELECTION_VERSION,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import type { SkillsMode } from "@/lib/contracts/skills";
import type { SearchPlanMode } from "@/lib/domain/search";

type ControlDefaults = Required<SavedControlDraft>;
type RowSlice = Partial<ComposerControlSnapshot>;

const SEARCH_DISABLED_OPTION_ID = "search-disabled";

/** Where an Assistant's rows are resolved: the personal or the Project catalog. */
export type ComposerAssistantContext = {
  /** The user's saved (or the Project's) parameters for a model over its built-ins. */
  controlDefaults(model: CatalogModel): ControlDefaults;
  models: readonly CatalogModel[];
  skill(skillId: string): Readonly<{ instructionApproxTokens?: number; name: string }> | null;
};

/** The values inherit and fallback rows take: the user's Chat defaults, or the Project's. */
export type ComposerAssistantDefaults = {
  knowledge: { selection: KnowledgeSelection; source: Exclude<ComposerKnowledgePlanSource, "assistant"> };
  model: { modelId: string; provider: string } | null;
  search: { mode: SearchPlanMode; optionIds: string[] };
  skillsMode: SkillsMode;
  tools: McpRunSelection;
};

/** An Assistant definition as the composer chooses it before a chat binds it. */
export type ComposerAssistantDefinition = {
  availability: AssistantAvailability;
  avatar: AssistantAvatarRecipe;
  description: string;
  id: string;
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  promptCharacterCount: number | null;
  rowAvailability: AssistantRowAvailability;
  rows: AssistantRows;
  starterPrompts: string[];
};

export type ComposerAssistantApplication = {
  assistant: ComposerAssistantState;
  controls: RowSlice;
};

export function personalComposerAssistantDefaults(
  catalog: Catalog | null,
  knowledge: KnowledgeSelection | null = catalog?.defaults.knowledgePlan ?? null
): ComposerAssistantDefaults {
  const model = catalog?.models.find((candidate) =>
    candidate.provider === catalog.defaults.provider && candidate.modelId === catalog.defaults.modelId
  );
  const search = resolvePreferredSearchPlan(catalog?.defaults.searchPlan, catalog?.searchStrategies);
  return {
    knowledge: knowledge && knowledge.mode !== "none"
      ? { selection: knowledge, source: "explicit" }
      : { selection: EMPTY_KNOWLEDGE_SELECTION, source: "off" },
    model: model ? { modelId: model.modelId, provider: model.provider } : null,
    search: { mode: search.mode, optionIds: [...search.optionIds] },
    skillsMode: catalog?.defaults.skillsMode ?? "auto",
    tools: { mode: catalog?.defaults.mcpMode ?? "auto" }
  };
}

export function composerAssistantDefinitionFromDetail(
  detail: AssistantDetail,
  promptCharacterCount: number | null = detail.content.systemPrompt.length
): ComposerAssistantDefinition {
  return {
    availability: detail.availability,
    avatar: detail.content.avatar,
    description: detail.content.description,
    id: detail.id,
    name: detail.content.name,
    owned: detail.owned,
    ownerDisplayName: detail.ownerDisplayName,
    promptCharacterCount,
    rowAvailability: detail.rowAvailability,
    rows: detail.content.rows,
    starterPrompts: [...detail.content.starterPrompts]
  };
}

function modelById(context: ComposerAssistantContext, modelId: string | null): CatalogModel | undefined {
  return modelId ? context.models.find((model) => model.modelId === modelId) : undefined;
}

function modelFor(
  context: ComposerAssistantContext,
  slice: RowSlice
): CatalogModel | undefined {
  return context.models.find((model) =>
    model.provider === slice.selectedProvider && model.modelId === slice.selectedModelId
  );
}

function controlsSlice(
  context: ComposerAssistantContext,
  model: CatalogModel | undefined,
  controls: AssistantRunControls | null
): RowSlice {
  if (!model) return {};
  const base = context.controlDefaults(model);
  if (!controls) return { ...base };
  return {
    backgroundMode: controls.backgroundMode ?? base.backgroundMode,
    maxOutputTokens: controls.maxOutputTokens !== undefined ? String(controls.maxOutputTokens) : base.maxOutputTokens,
    reasoningEffort: controls.reasoningEffort ?? base.reasoningEffort,
    reasoningMode: controls.reasoningMode ?? base.reasoningMode,
    streamMode: controls.streamMode ?? base.streamMode,
    temperature: controls.temperature !== undefined ? String(controls.temperature) : base.temperature
  };
}

function knowledgeSlice(
  value: ChatAssistantRowValues["knowledge"],
  origin: AssistantRowProvenance
): RowSlice {
  let selection: KnowledgeSelection;
  if (value.mode === "none") {
    selection = EMPTY_KNOWLEDGE_SELECTION;
  } else if (value.mode === "all_my_knowledge") {
    selection = { baseIds: [], mode: "all_my_knowledge", sourceIds: [], version: KNOWLEDGE_SELECTION_VERSION };
  } else if ((value.hiddenCount ?? 0) > 0) {
    // Resources the viewer cannot see are only counted; the composer never
    // turns the visible part into an explicit plan of its own.
    selection = inheritedKnowledgeSelection("assistant");
  } else {
    selection = explicitKnowledgeSelection({ baseIds: value.baseIds, sourceIds: value.sourceIds });
  }
  return {
    knowledgePlanSource: selection.mode === "none"
      ? "off"
      : origin === "assistant" ? "assistant" : "explicit",
    knowledgeSelection: selection,
    selectedKnowledgeBaseIds: [...selection.baseIds]
  };
}

/** The composer fields for an effective row value in the chat vocabulary. */
function effectiveRowSlice<Key extends AssistantRowKey>(
  key: Key,
  value: ChatAssistantRowValues[Key],
  origin: AssistantRowProvenance,
  context: ComposerAssistantContext
): RowSlice {
  switch (key) {
    case "model": {
      const modelValue = value as ChatAssistantRowValues["model"];
      const model = modelById(context, modelValue.modelId);
      return { selectedModelId: model?.modelId ?? modelValue.modelId ?? "", selectedProvider: model?.provider ?? "" };
    }
    case "search": {
      const search = value as ChatAssistantRowValues["search"];
      return search.mode === "off"
        ? { searchPlanMode: "all_selected", selectedSearchOptionIds: [] }
        : { searchPlanMode: search.mode, selectedSearchOptionIds: [...search.optionIds] };
    }
    case "tools": {
      const tools = value as ChatAssistantRowValues["tools"];
      return {
        mcpSelection: tools.mode === "exact"
          ? {
              ...(tools.hiddenCount ? { hiddenCount: tools.hiddenCount } : {}),
              mode: "exact",
              serverIds: [...tools.serverIds]
            }
          : { mode: tools.mode }
      };
    }
    case "knowledge":
      return knowledgeSlice(value as ChatAssistantRowValues["knowledge"], origin);
    case "skills":
      return { skillsMode: (value as ChatAssistantRowValues["skills"]).mode };
    default:
      return {};
  }
}

function defaultRowSlice(key: AssistantRowKey, defaults: ComposerAssistantDefaults): RowSlice {
  switch (key) {
    case "model":
      return {
        selectedModelId: defaults.model?.modelId ?? "",
        selectedProvider: defaults.model?.provider ?? ""
      };
    case "search":
      return { searchPlanMode: defaults.search.mode, selectedSearchOptionIds: [...defaults.search.optionIds] };
    case "tools":
      return { mcpSelection: { ...defaults.tools } };
    case "knowledge":
      return {
        knowledgePlanSource: defaults.knowledge.source,
        knowledgeSelection: defaults.knowledge.selection,
        selectedKnowledgeBaseIds: [...defaults.knowledge.selection.baseIds]
      };
    case "skills":
      return { skillsMode: defaults.skillsMode };
    default:
      return {};
  }
}

function rowFields(slice: RowSlice, key: AssistantRowKey): RowSlice {
  return Object.fromEntries(COMPOSER_ASSISTANT_ROW_FIELDS[key]
    .filter((field) => field in slice)
    .map((field) => [field, structuredClone(slice[field])])) as RowSlice;
}

function includedSkills(
  rows: { skills: { assistantValue: AssistantRowValues["skills"] } },
  context: ComposerAssistantContext
): ComposerAssistantSkill[] {
  return rows.skills.assistantValue.links.map((link) => {
    const skill = context.skill(link.skillId);
    return {
      id: link.skillId,
      ...(skill?.instructionApproxTokens !== undefined
        ? { instructionApproxTokens: skill.instructionApproxTokens }
        : {}),
      mode: assistantSkillModeForDelivery(link.delivery),
      name: skill?.name ?? "Assistant Skill"
    };
  });
}

function deviationFor(
  rowAvailability: AssistantRowAvailability,
  key: AssistantRowKey
): ComposerAssistantRow["deviation"] {
  return key === "controls" || key === "skills"
    ? null
    : rowAvailability[key as AssistantRowDeviationKey] ?? null;
}

function inherits(value: AssistantRowValues[AssistantRowKey]): boolean {
  return "mode" in value && value.mode === "inherit";
}

/**
 * Resolves a chosen Assistant for a chat that does not exist yet, the way
 * admission resolves it: the Assistant's value, the defaults for inherit and
 * for an adjustable value the user cannot use. Returns null when a value the
 * Assistant sets is not in the catalog; nothing is substituted for it.
 */
export function composerAssistantFromDefinition(
  definition: ComposerAssistantDefinition,
  context: ComposerAssistantContext,
  defaults: ComposerAssistantDefaults
): { assistant: ComposerBoundAssistant; controls: RowSlice } | null {
  const rows: Partial<Record<AssistantRowKey, ComposerAssistantRow>> = {};
  const slices: Partial<Record<AssistantRowKey, RowSlice>> = {};
  for (const key of ASSISTANT_ROW_KEYS) {
    if (key === "controls") continue;
    const row = definition.rows[key];
    const deviation = deviationFor(definition.rowAvailability, key);
    const origin: AssistantRowProvenance = deviation
      ? row.policy === "fixed" ? "assistant" : "fallback"
      : inherits(row.value) ? "default" : "assistant";
    rows[key] = { assistantValue: row.value, deviation: origin === "fallback" ? deviation : null, origin, policy: row.policy };
    if (origin !== "assistant") {
      slices[key] = defaultRowSlice(key, defaults);
      continue;
    }
    if (key === "model") {
      const modelValue = row.value as AssistantRowValues["model"];
      if (modelValue.mode !== "model" || !modelById(context, modelValue.modelId)) return null;
    }
    slices[key] = effectiveRowSlice(key, row.value as ChatAssistantRowValues[typeof key], origin, context);
  }
  const model = modelFor(context, slices.model ?? {});
  const assistantModel = definition.rows.model.value;
  const governs = rows.model?.origin === "assistant" && assistantModel.mode === "model" &&
    model?.modelId === assistantModel.modelId;
  const controlsValue = definition.rows.controls.value;
  const controlsOrigin: AssistantRowProvenance = governs && Object.keys(controlsValue).length > 0
    ? "assistant"
    : "default";
  rows.controls = {
    assistantValue: controlsValue,
    deviation: null,
    origin: controlsOrigin,
    policy: definition.rows.controls.policy
  };
  slices.controls = controlsSlice(context, model, controlsOrigin === "assistant" ? controlsValue : null);

  const composerRows = rows as ComposerAssistantRows;
  const resets = Object.fromEntries(ASSISTANT_ROW_KEYS.map((key) => [key, {
    controls: rowFields(slices[key] ?? {}, key),
    origin: composerRows[key].origin
  } satisfies ComposerAssistantRowReset]));
  return {
    assistant: {
      availability: definition.availability,
      avatar: definition.avatar,
      description: definition.description,
      id: definition.id,
      includedSkills: includedSkills(composerRows, context),
      name: definition.name,
      owned: definition.owned,
      ownerDisplayName: definition.ownerDisplayName,
      promptCharacterCount: definition.promptCharacterCount,
      resets,
      rows: composerRows,
      starterPrompts: [...definition.starterPrompts],
      state: "bound",
      unsyncedRows: []
    },
    controls: Object.assign({}, ...ASSISTANT_ROW_KEYS.map((key) => slices[key] ?? {})) as RowSlice
  };
}

/**
 * Restores a chat's Assistant from its server projection: the rows, their
 * origins and the effective values exactly as the server describes them.
 */
export function composerAssistantFromProjection(
  projection: ChatAssistantProjection,
  context: ComposerAssistantContext,
  known: Readonly<{ description?: string; promptCharacterCount?: number; starterPrompts?: string[] }> = {}
): ComposerAssistantApplication {
  if (projection.state !== "bound") {
    return { assistant: { ...projection }, controls: {} };
  }
  const slices: Partial<Record<AssistantRowKey, RowSlice>> = {};
  for (const key of ASSISTANT_ROW_KEYS) {
    if (key === "controls") continue;
    const row = projection.rows[key];
    slices[key] = effectiveRowSlice(key, row.value, row.provenance, context);
  }
  const model = modelFor(context, slices.model ?? {});
  slices.controls = controlsSlice(context, model, projection.rows.controls.value);
  const rows = Object.fromEntries(ASSISTANT_ROW_KEYS.map((key) => {
    const row = projection.rows[key];
    return [key, {
      assistantValue: row.assistantValue,
      deviation: row.deviation,
      origin: row.provenance,
      policy: row.policy
    }];
  })) as ComposerAssistantRows;
  // A row changed for the chat returns through a chat update; the others
  // keep their current value as the local baseline.
  const resets = Object.fromEntries(ASSISTANT_ROW_KEYS
    .filter((key) => rows[key].origin !== "chat")
    .map((key) => [key, { controls: rowFields(slices[key] ?? {}, key), origin: rows[key].origin }]));
  return {
    assistant: {
      availability: projection.availability,
      avatar: projection.avatar,
      description: known.description ?? null,
      id: projection.id,
      includedSkills: includedSkills(rows, context),
      name: projection.name,
      owned: projection.owned,
      ownerDisplayName: projection.ownerDisplayName,
      promptCharacterCount: known.promptCharacterCount ?? null,
      resets,
      rows,
      starterPrompts: known.starterPrompts ? [...known.starterPrompts] : null,
      state: "bound",
      unsyncedRows: []
    },
    controls: Object.assign({}, ...ASSISTANT_ROW_KEYS.map((key) => slices[key] ?? {})) as RowSlice
  };
}

function boundedToken(value: string): boolean {
  return value.trim().length > 0 && value.length <= 64;
}

/** The composer's parameters in the Assistant vocabulary, limited to what the model accepts. */
export function composerRunControls(
  state: ComposerControlSnapshot,
  model: CatalogModel | undefined
): AssistantRunControls {
  const controls = defaultParameterControls(model);
  const maxOutputTokens = Number(state.maxOutputTokens);
  const temperature = Number(state.temperature);
  return {
    ...(controls.background.supported ? { backgroundMode: state.backgroundMode } : {}),
    ...(Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1 &&
      maxOutputTokens <= ASSISTANT_MAX_OUTPUT_TOKENS_CEILING
      ? { maxOutputTokens }
      : {}),
    ...(controls.reasoningEffort.supported && boundedToken(state.reasoningEffort)
      ? { reasoningEffort: state.reasoningEffort }
      : {}),
    ...(controls.reasoningMode?.supported && boundedToken(state.reasoningMode)
      ? { reasoningMode: state.reasoningMode }
      : {}),
    ...(controls.stream.supported ? { streamMode: state.streamMode } : {}),
    ...(controls.temperature.supported && state.temperature.trim() !== "" &&
      Number.isFinite(temperature) && temperature >= -10 && temperature <= 10
      ? { temperature }
      : {})
  };
}

function searchValue(state: ComposerControlSnapshot): ChatAssistantOverrideValues["search"] {
  const optionIds = state.selectedSearchOptionIds.filter((id) => id !== SEARCH_DISABLED_OPTION_ID);
  return optionIds.length === 0 ? { mode: "off" } : { mode: state.searchPlanMode, optionIds };
}

/**
 * A row's effective value, read from the composer fields it owns, in the
 * vocabulary of the chat projection.
 */
export function composerAssistantRowValue<Key extends AssistantRowKey>(
  state: ComposerControlSnapshot,
  key: Key,
  model: CatalogModel | undefined
): ChatAssistantRowValues[Key] {
  const assistant = boundComposerAssistant(state);
  let value: ChatAssistantRowValues[AssistantRowKey];
  switch (key) {
    case "model":
      value = { mode: "model", modelId: state.selectedModelId || null };
      break;
    case "controls":
      value = composerRunControls(state, model);
      break;
    case "search":
      value = searchValue(state);
      break;
    case "tools":
      value = structuredClone(state.mcpSelection);
      break;
    case "knowledge": {
      const selection = state.knowledgeSelection;
      const assistantKnowledge = assistant?.rows.knowledge.assistantValue;
      value = selection.mode === "inherited"
        ? assistantKnowledge && assistantKnowledge.mode === "explicit"
          ? structuredClone(assistantKnowledge)
          : { mode: "none" }
        : selection.mode === "explicit"
          ? { baseIds: [...selection.baseIds], mode: "explicit", sourceIds: [...selection.sourceIds] }
          : { mode: selection.mode };
      break;
    }
    default: {
      const skills = assistant?.rows.skills.assistantValue;
      value = {
        ...(skills?.hiddenCount ? { hiddenCount: skills.hiddenCount } : {}),
        links: skills?.links.map((link) => ({ ...link })) ?? [],
        mode: state.skillsMode
      };
    }
  }
  return value as ChatAssistantRowValues[Key];
}

/**
 * A row's current value as a chat override, or null when the composer holds
 * a value only the Assistant can express (an exact MCP list, a hidden plan).
 */
export function composerAssistantOverride<Key extends AssistantRowKey>(
  state: ComposerControlSnapshot,
  key: Key,
  model: CatalogModel | undefined
): ChatAssistantOverrideValues[Key] | null {
  let value: ChatAssistantOverrideValues[AssistantRowKey] | null;
  switch (key) {
    case "model":
      value = state.selectedModelId ? { mode: "model", modelId: state.selectedModelId } : null;
      break;
    case "controls":
      value = composerRunControls(state, model);
      break;
    case "search":
      value = searchValue(state);
      break;
    case "tools":
      value = state.mcpSelection.mode === "exact" ? null : { mode: state.mcpSelection.mode };
      break;
    case "knowledge": {
      const selection = state.knowledgeSelection;
      value = selection.mode === "inherited"
        ? null
        : selection.mode === "explicit"
          ? { baseIds: [...selection.baseIds], mode: "explicit", sourceIds: [...selection.sourceIds] }
          : { mode: selection.mode };
      break;
    }
    default:
      value = { mode: state.skillsMode };
  }
  return value as ChatAssistantOverrideValues[Key] | null;
}

/** Rows the user changed for this chat, in row order. */
export function composerAssistantChangedRows(state: Pick<ComposerControlSnapshot, "assistant">): AssistantRowKey[] {
  const assistant = boundComposerAssistant(state);
  return assistant ? ASSISTANT_ROW_KEYS.filter((key) => assistant.rows[key].origin === "chat") : [];
}

/**
 * Why the chat's Assistant blocks sending, or null. An unavailable, archived
 * or deleted Assistant is never replaced silently; the user chooses.
 */
export function composerAssistantSendBlockReason(
  state: Pick<ComposerControlSnapshot, "assistant">
): string | null {
  const assistant = state.assistant;
  if (!assistant) return null;
  if (assistant.state === "deleted") {
    return "This Assistant was deleted. Choose another or continue without the Assistant.";
  }
  if (assistant.state === "unavailable") {
    return assistant.reason === "archived"
      ? "This Assistant was archived by its owner. Choose another or continue without the Assistant."
      : "This Assistant isn't available to you right now. Choose another or continue without the Assistant.";
  }
  if (assistant.availability.ok) return null;
  return assistant.availability.reason === "archived"
    ? assistant.owned
      ? "You archived this Assistant. Restore it, choose another or continue without the Assistant."
      : "This Assistant was archived by its owner. Choose another or continue without the Assistant."
    : "This Assistant isn't available to you right now. Choose another or continue without the Assistant.";
}
