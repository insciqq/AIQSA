import { DEFAULT_CHAT_MAX_OUTPUT_TOKENS } from "@/lib/domain/providerParams";
import type { SavedControlDraft } from "@/components/app-shell/powerAppShellData";
import type {
  AssistantAvailability,
  AssistantAvatarRecipe,
  AssistantRowDeviation,
  AssistantRowKey,
  AssistantRowPolicy,
  AssistantRowProvenance,
  AssistantRowValues
} from "@/lib/contracts/assistants";
import {
  decodeKnowledgePlan,
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import type { SkillsMode, AssistantSkillMode } from "@/lib/contracts/skills";
import type { SearchPlanMode } from "@/lib/domain/search";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);
type ControlDefaults = Required<SavedControlDraft>;

export type ComposerModelSelection = {
  controlDefaults: ControlDefaults;
  modelId: string;
  provider: string;
  /**
   * Search options the new model can run; selected options outside it are
   * dropped so an unavailable engine is never kept silently (A6).
   */
  searchStrategyIds?: readonly string[];
};

/**
 * "user" changes are the user's edits: with an Assistant they change an
 * adjustable row for the chat and are refused on a fixed row. "system" changes
 * (chat activation, defaults, restore) write values without touching the
 * Assistant or the rows' origins.
 */
export type ComposerControlChangeOrigin = "system" | "user";
export type ComposerKnowledgePlanSource = "assistant" | "chat" | "explicit" | "off" | "project";

/** The Assistant's exact MCP server list; only an Assistant row sets it. */
export type ComposerMcpExactSelection = { hiddenCount?: number; mode: "exact"; serverIds: string[] };
export type ComposerMcpSelection = McpRunSelection | ComposerMcpExactSelection;

export type ComposerSkillSelection = {
  description: string;
  id: string;
  name: string;
  instructionApproxTokens?: number;
  promptCharacterCount: number;
};

/**
 * One setup row of the chat's Assistant. The effective value lives in the
 * ordinary composer fields the row owns (`COMPOSER_ASSISTANT_ROW_FIELDS`), so
 * every existing control and the run request read one value.
 */
export type ComposerAssistantRow<Key extends AssistantRowKey = AssistantRowKey> = {
  /** The Assistant's own value, redacted like Assistant content. */
  assistantValue: AssistantRowValues[Key];
  /** Set when the Assistant's adjustable value is unavailable to the user. */
  deviation: AssistantRowDeviation | null;
  origin: AssistantRowProvenance;
  policy: AssistantRowPolicy;
};

export type ComposerAssistantRows = { [Key in AssistantRowKey]: ComposerAssistantRow<Key> };

export type ComposerAssistantSkill = {
  id: string;
  instructionApproxTokens?: number;
  mode: AssistantSkillMode;
  name: string;
};

/** The composer values a row returns to on a composer-only reset (blank chat). */
export type ComposerAssistantRowReset = {
  controls: Partial<ComposerControlSnapshot>;
  origin: AssistantRowProvenance;
};

export type ComposerBoundAssistant = {
  availability: AssistantAvailability;
  avatar: AssistantAvatarRecipe;
  /** Known when the Assistant was chosen from its definition; restore leaves it to the list. */
  description: string | null;
  id: string;
  includedSkills: ComposerAssistantSkill[];
  name: string;
  owned: boolean;
  ownerDisplayName: string;
  /** Approximate prompt size for the context gauge only; null when unknown. */
  promptCharacterCount: number | null;
  resets: Partial<Record<AssistantRowKey, ComposerAssistantRowReset>>;
  rows: ComposerAssistantRows;
  starterPrompts: string[] | null;
  state: "bound";
  /** Rows the user changed for an existing chat that its chat update has not taken yet. */
  unsyncedRows: AssistantRowKey[];
};

/**
 * The chat's Assistant. `unavailable` and `deleted` carry no identity and
 * block sending until the user chooses; nothing is substituted. A consumer's
 * `unavailable` says `archived` when its owner archived the Assistant.
 */
export type ComposerAssistantState =
  | ComposerBoundAssistant
  | { state: "deleted" }
  | { reason?: "archived"; state: "unavailable" };

export type ComposerControlSnapshot = {
  assistant: ComposerAssistantState | null;
  backgroundMode: boolean;
  maxOutputTokens: string;
  knowledgePlanSource: ComposerKnowledgePlanSource;
  knowledgeSelection: KnowledgeSelection;
  reasoningEffort: string;
  reasoningMode: string;
  selectedKnowledgeBaseIds: string[];
  mcpSelection: ComposerMcpSelection;
  skillsMode: SkillsMode;
  selectedModelId: string;
  selectedProvider: string;
  selectedSearchOptionIds: string[];
  selectedSkills: ComposerSkillSelection[];
  searchPlanMode: SearchPlanMode;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  streamMode: boolean;
  temperature: string;
};

/** The ordinary composer fields each Assistant row owns. */
export const COMPOSER_ASSISTANT_ROW_FIELDS = {
  controls: ["backgroundMode", "maxOutputTokens", "reasoningEffort", "reasoningMode", "streamMode", "temperature"],
  knowledge: ["knowledgePlanSource", "knowledgeSelection", "selectedKnowledgeBaseIds"],
  model: ["selectedModelId", "selectedProvider"],
  search: ["searchPlanMode", "selectedSearchOptionIds"],
  skills: ["skillsMode"],
  tools: ["mcpSelection"]
} as const satisfies Record<AssistantRowKey, readonly (keyof ComposerControlSnapshot)[]>;

export type ComposerControlStore = ComposerControlSnapshot & {
  applyAssistantState(input: {
    assistant: ComposerAssistantState;
    controls: Partial<ComposerControlSnapshot>;
  }): void;
  applyControlDefaults(defaults: ControlDefaults): void;
  applyModelSelection(
    selection: ComposerModelSelection,
    origin?: ComposerControlChangeOrigin
  ): void;
  /**
   * Removes the Assistant. Values an Assistant alone can express (an exact
   * MCP list, a hidden Knowledge plan) return to the given ordinary values.
   */
  clearAssistant(fallback?: { mcpSelection: McpRunSelection; skillsMode: SkillsMode }): void;
  /** Returns a row to the Assistant in composer state; false without a local baseline. */
  resetAssistantRow(key: AssistantRowKey): boolean;
  setBackgroundMode(value: boolean): void;
  setMaxOutputTokens(value: string): void;
  setMcpSelection(value: McpRunSelection, origin?: ComposerControlChangeOrigin): void;
  setSkillsMode(value: SkillsMode, origin?: ComposerControlChangeOrigin): void;
  setSelectedKnowledgePlan(
    selection: KnowledgeSelection | readonly string[],
    source?: Exclude<ComposerKnowledgePlanSource, "assistant">,
    origin?: ComposerControlChangeOrigin
  ): void;
  setReasoningEffort(value: string): void;
  setReasoningMode(value: string): void;
  setSelectedModelId(value: string, origin?: ComposerControlChangeOrigin): void;
  setSelectedProvider(value: string, origin?: ComposerControlChangeOrigin): void;
  setSelectedSearchPlan(
    optionIds: readonly string[],
    mode: SearchPlanMode,
    origin?: ComposerControlChangeOrigin
  ): void;
  setSelectedSkills(skills: readonly ComposerSkillSelection[]): void;
  setShowCitations(update: StateUpdate<boolean>): void;
  setShowReasoningBlocks(update: StateUpdate<boolean>): void;
  setStreamMode(value: boolean): void;
  setTemperature(value: string): void;
  /** Hands the rows changed for an existing chat to its chat update, once. */
  takeUnsyncedAssistantRows(): AssistantRowKey[];
};

export const initialComposerControlSnapshot: ComposerControlSnapshot = {
  assistant: null,
  backgroundMode: true,
  maxOutputTokens: String(DEFAULT_CHAT_MAX_OUTPUT_TOKENS),
  mcpSelection: { mode: "auto" },
  skillsMode: "auto",
  knowledgePlanSource: "off",
  knowledgeSelection: EMPTY_KNOWLEDGE_SELECTION,
  reasoningEffort: "medium",
  reasoningMode: "standard",
  selectedKnowledgeBaseIds: [],
  selectedModelId: "gpt-5.5",
  selectedProvider: "openai",
  selectedSearchOptionIds: ["openai-native-web-search"],
  selectedSkills: [],
  searchPlanMode: "all_selected",
  showCitations: true,
  showReasoningBlocks: false,
  streamMode: false,
  temperature: "1"
};

function applyUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

function cloneValue<T>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

export function boundComposerAssistant(
  state: Pick<ComposerControlSnapshot, "assistant">
): ComposerBoundAssistant | null {
  return state.assistant?.state === "bound" ? state.assistant : null;
}

/** A detached copy of the fields a row owns. */
export function composerAssistantRowControls(
  state: ComposerControlSnapshot,
  key: AssistantRowKey
): Partial<ComposerControlSnapshot> {
  return Object.fromEntries(COMPOSER_ASSISTANT_ROW_FIELDS[key].map((field) =>
    [field, cloneValue(state[field])]
  )) as Partial<ComposerControlSnapshot>;
}

/**
 * The Assistant's parameters belong to its own model: they govern the
 * controls row only while the effective model is that model. With another
 * model, parameters are ordinary chat parameters.
 */
export function assistantGovernsControls(
  state: Pick<ComposerControlSnapshot, "assistant" | "selectedModelId">
): boolean {
  const model = boundComposerAssistant(state)?.rows.model.assistantValue;
  return model?.mode === "model" && model.modelId !== null && model.modelId === state.selectedModelId;
}

function sameRowValues(
  state: ComposerControlSnapshot,
  key: AssistantRowKey,
  update: Partial<ComposerControlSnapshot>
): boolean {
  return COMPOSER_ASSISTANT_ROW_FIELDS[key].every((field) =>
    !(field in update) || JSON.stringify(update[field]) === JSON.stringify(state[field])
  );
}

/**
 * A user edit of a row. Without an Assistant it is an ordinary edit; a fixed
 * row refuses it with no side effect; an adjustable row takes it as the
 * chat's value.
 */
function rowChange(
  state: ComposerControlSnapshot,
  key: AssistantRowKey,
  update: Partial<ComposerControlSnapshot>
): Partial<ComposerControlSnapshot> {
  const assistant = boundComposerAssistant(state);
  if (!assistant) return update;
  const row = assistant.rows[key];
  if (row.policy === "fixed") return {};
  if (sameRowValues(state, key, update)) return {};
  return {
    ...update,
    assistant: {
      ...assistant,
      rows: { ...assistant.rows, [key]: { ...row, origin: "chat" } },
      unsyncedRows: assistant.unsyncedRows.includes(key)
        ? assistant.unsyncedRows
        : [...assistant.unsyncedRows, key]
    }
  };
}

function controlChange(
  state: ComposerControlSnapshot,
  update: Partial<ComposerControlSnapshot>
): Partial<ComposerControlSnapshot> {
  return assistantGovernsControls(state) ? rowChange(state, "controls", update) : update;
}

function assistantControlDefaults(
  defaults: ControlDefaults,
  controls: AssistantRowValues["controls"]
): ControlDefaults {
  return {
    backgroundMode: controls.backgroundMode ?? defaults.backgroundMode,
    maxOutputTokens: controls.maxOutputTokens !== undefined
      ? String(controls.maxOutputTokens)
      : defaults.maxOutputTokens,
    reasoningEffort: controls.reasoningEffort ?? defaults.reasoningEffort,
    reasoningMode: controls.reasoningMode ?? defaults.reasoningMode,
    streamMode: controls.streamMode ?? defaults.streamMode,
    temperature: controls.temperature !== undefined
      ? String(controls.temperature)
      : defaults.temperature
  };
}

/**
 * A user model change. With an Assistant the model row becomes the chat's
 * value; a controls override belongs to the model it was set for, so
 * the parameters follow the chosen model: the Assistant's own model gets its
 * parameters again, another model gets the user's saved values.
 */
function userModelSelection(
  state: ComposerControlSnapshot,
  { controlDefaults, modelId, provider, searchStrategyIds }: ComposerModelSelection
): Partial<ComposerControlSnapshot> {
  const assistant = boundComposerAssistant(state);
  const assistantModel = assistant?.rows.model.assistantValue;
  const governs = assistantModel?.mode === "model" && assistantModel.modelId === modelId;
  const controlsRow = assistant?.rows.controls;
  const controls = governs && controlsRow
    ? assistantControlDefaults(controlDefaults, controlsRow.assistantValue)
    : controlDefaults;
  const searchRowFree = !assistant || assistant.rows.search.origin === "chat";
  const update: Partial<ComposerControlSnapshot> = {
    ...controls,
    selectedModelId: modelId,
    selectedProvider: provider,
    ...(searchRowFree && searchStrategyIds &&
      state.selectedSearchOptionIds.some((id) => !searchStrategyIds.includes(id))
      ? {
          selectedSearchOptionIds: state.selectedSearchOptionIds.filter((id) =>
            searchStrategyIds.includes(id)
          )
        }
      : {})
  };
  if (!assistant || !controlsRow) return update;
  const changed = rowChange(state, "model", update);
  const changedAssistant = changed.assistant?.state === "bound" ? changed.assistant : null;
  if (!changedAssistant) return changed;
  const controlsOrigin: AssistantRowProvenance = governs &&
    Object.keys(controlsRow.assistantValue).length > 0 ? "assistant" : "default";
  return {
    ...changed,
    assistant: {
      ...changedAssistant,
      rows: {
        ...changedAssistant.rows,
        controls: { ...changedAssistant.rows.controls, origin: controlsOrigin }
      },
      unsyncedRows: changedAssistant.unsyncedRows.filter((row) => row !== "controls")
    }
  };
}

export const useComposerControlStore = create<ComposerControlStore>((set, get) => ({
  ...initialComposerControlSnapshot,
  applyAssistantState({ assistant, controls }) {
    set({ ...cloneValue(controls), assistant: cloneValue(assistant) });
  },
  applyControlDefaults(defaults) {
    set({
      backgroundMode: defaults.backgroundMode,
      maxOutputTokens: defaults.maxOutputTokens,
      reasoningEffort: defaults.reasoningEffort,
      reasoningMode: defaults.reasoningMode,
      streamMode: defaults.streamMode,
      temperature: defaults.temperature
    });
  },
  applyModelSelection(selection, origin = "user") {
    const { controlDefaults, modelId, provider, searchStrategyIds } = selection;
    set((state) => origin === "user"
      ? userModelSelection(state, selection)
      : {
          ...controlDefaults,
          selectedModelId: modelId,
          selectedProvider: provider,
          ...(searchStrategyIds &&
            state.selectedSearchOptionIds.some((id) => !searchStrategyIds.includes(id))
            ? {
                selectedSearchOptionIds: state.selectedSearchOptionIds.filter((id) =>
                  searchStrategyIds.includes(id)
                )
              }
            : {})
        });
  },
  clearAssistant(fallback) {
    set((state) => {
      if (!state.assistant) return {};
      // A privacy-hidden Assistant plan has no ids a browser may send back.
      const hiddenKnowledge = state.knowledgeSelection.mode === "inherited";
      return {
        assistant: null,
        ...(state.mcpSelection.mode === "exact"
          ? { mcpSelection: { ...(fallback?.mcpSelection ?? { mode: "auto" as const }) } }
          : {}),
        ...(fallback ? { skillsMode: fallback.skillsMode } : {}),
        ...(hiddenKnowledge
          ? {
              knowledgePlanSource: "off" as const,
              knowledgeSelection: EMPTY_KNOWLEDGE_SELECTION,
              selectedKnowledgeBaseIds: []
            }
          : state.knowledgePlanSource === "assistant"
            ? { knowledgePlanSource: "explicit" as const }
            : {})
      };
    });
  },
  resetAssistantRow(key) {
    const assistant = boundComposerAssistant(get());
    const reset = assistant?.resets[key];
    if (!assistant || !reset || assistant.rows[key].policy === "fixed") return false;
    // A controls override belongs to the model it was set for: the
    // Assistant's model brings back the parameters the chain gives it.
    const controlsReset = key === "model" ? assistant.resets.controls : undefined;
    set({
      ...cloneValue(reset.controls),
      ...(controlsReset ? cloneValue(controlsReset.controls) : {}),
      assistant: {
        ...assistant,
        rows: {
          ...assistant.rows,
          [key]: { ...assistant.rows[key], origin: reset.origin },
          ...(controlsReset
            ? { controls: { ...assistant.rows.controls, origin: controlsReset.origin } }
            : {})
        },
        unsyncedRows: assistant.unsyncedRows.filter((row) =>
          row !== key && !(controlsReset && row === "controls"))
      }
    });
    return true;
  },
  setBackgroundMode(value) {
    set((state) => controlChange(state, { backgroundMode: value }));
  },
  setMaxOutputTokens(value) {
    set((state) => controlChange(state, { maxOutputTokens: value }));
  },
  setMcpSelection(mcpSelection, origin = "user") {
    set((state) => origin === "user"
      ? rowChange(state, "tools", { mcpSelection: { ...mcpSelection } })
      : { mcpSelection: { ...mcpSelection } });
  },
  setSkillsMode(skillsMode, origin = "user") {
    set((state) => origin === "user" ? rowChange(state, "skills", { skillsMode }) : { skillsMode });
  },
  setSelectedKnowledgePlan(selection, source = "explicit", origin = "user") {
    const decoded = decodeKnowledgePlan(Array.isArray(selection)
      ? explicitKnowledgeSelection({ baseIds: selection })
      : selection);
    if (!decoded.ok) return;
    set((state) => {
      // A user edit is always the user's own explicit plan.
      const effectiveSource = origin === "user" && boundComposerAssistant(state) ? "explicit" : source;
      // An inherited plan contains no client-authorized ids and is valid only
      // while its server-owned source remains attached. It must never be sent
      // back as an explicit browser plan after an override/detachment.
      const knowledgeSelection = effectiveSource === "explicit" && decoded.plan.mode === "inherited"
        ? EMPTY_KNOWLEDGE_SELECTION
        : decoded.plan;
      const update: Partial<ComposerControlSnapshot> = {
        knowledgePlanSource: effectiveSource === "explicit" && knowledgeSelection.mode === "none"
          ? "off"
          : effectiveSource,
        knowledgeSelection,
        selectedKnowledgeBaseIds: [...knowledgeSelection.baseIds]
      };
      return origin === "user" ? rowChange(state, "knowledge", update) : update;
    });
  },
  setReasoningEffort(value) {
    set((state) => controlChange(state, { reasoningEffort: value }));
  },
  setReasoningMode(value) {
    set((state) => controlChange(state, { reasoningMode: value }));
  },
  setSelectedModelId(value, origin = "user") {
    set((state) => origin === "user"
      ? rowChange(state, "model", { selectedModelId: value })
      : { selectedModelId: value });
  },
  setSelectedProvider(value, origin = "user") {
    set((state) => origin === "user"
      ? rowChange(state, "model", { selectedProvider: value })
      : { selectedProvider: value });
  },
  setSelectedSearchPlan(optionIds, mode, origin = "user") {
    const update = { searchPlanMode: mode, selectedSearchOptionIds: [...optionIds] };
    set((state) => origin === "user" ? rowChange(state, "search", update) : update);
  },
  setSelectedSkills(selectedSkills) {
    set({ selectedSkills: selectedSkills.map((skill) => ({ ...skill })) });
  },
  setShowCitations(update) {
    set((state) => ({ showCitations: applyUpdate(state.showCitations, update) }));
  },
  setShowReasoningBlocks(update) {
    set((state) => ({ showReasoningBlocks: applyUpdate(state.showReasoningBlocks, update) }));
  },
  setStreamMode(value) {
    set((state) => controlChange(state, { streamMode: value }));
  },
  setTemperature(value) {
    set((state) => controlChange(state, { temperature: value }));
  },
  takeUnsyncedAssistantRows() {
    const assistant = boundComposerAssistant(get());
    if (!assistant || assistant.unsyncedRows.length === 0) return [];
    const rows = assistant.unsyncedRows;
    set({ assistant: { ...assistant, unsyncedRows: [] } });
    return rows;
  }
}));
