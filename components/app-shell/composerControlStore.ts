import type { SavedControlDraft } from "@/components/app-shell/powerAppShellData";
import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
import type { SearchPlanMode } from "@/lib/domain/search";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);
type ControlDefaults = Required<Omit<SavedControlDraft, "searchStrategyId">>;

export type ComposerModelSelection = {
  controlDefaults: ControlDefaults;
  modelId: string;
  provider: string;
};

/**
 * "user" changes are manual edits of an Assistant-governed control and remove
 * the selected Assistant identity with a non-blocking notice (strict identity).
 * "system" changes (chat activation, defaults recovery) rewrite the governed
 * tuple wholesale and clear any selection silently. "assistant" changes are the
 * atomic application of a selected revision and keep the identity.
 */
export type ComposerControlChangeOrigin = "assistant" | "system" | "user";

export type ComposerAssistantSelection = {
  avatar: AssistantAvatarRecipe;
  description: string;
  id: string;
  name: string;
  /** Approximate prompt size for the context gauge only; text stays server-side. */
  promptCharacterCount: number;
  starterPrompts: string[];
};

export type ComposerManualDraftBackup = {
  backgroundMode: boolean;
  maxOutputTokens: string;
  reasoningEffort: string;
  reasoningMode: string;
  searchPlanMode: SearchPlanMode;
  selectedModelId: string;
  selectedProvider: string;
  selectedSearchOptionIds: string[];
  selectedSearchStrategy: string;
  streamMode: boolean;
  temperature: string;
};

export type ComposerControlSnapshot = {
  assistantManualBackup: ComposerManualDraftBackup | null;
  assistantRemovedNotice: boolean;
  backgroundMode: boolean;
  maxOutputTokens: string;
  reasoningEffort: string;
  reasoningMode: string;
  selectedAssistant: ComposerAssistantSelection | null;
  selectedModelId: string;
  selectedProvider: string;
  selectedSearchOptionIds: string[];
  searchPlanMode: SearchPlanMode;
  selectedSearchStrategy: string;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
  streamMode: boolean;
  temperature: string;
};

export type ComposerControlStore = ComposerControlSnapshot & {
  applyAssistantSelection(input: {
    assistant: ComposerAssistantSelection;
    controlDefaults: ControlDefaults;
    modelId: string;
    provider: string;
    searchOptionIds: readonly string[];
    searchPlanMode: SearchPlanMode;
  }): void;
  applyControlDefaults(defaults: ControlDefaults): void;
  applyModelSelection(
    selection: ComposerModelSelection,
    origin?: ComposerControlChangeOrigin
  ): void;
  clearAssistantRemovedNotice(): void;
  removeAssistant(): void;
  setBackgroundMode(value: boolean): void;
  setMaxOutputTokens(value: string): void;
  setReasoningEffort(value: string): void;
  setReasoningMode(value: string): void;
  setSelectedModelId(value: string, origin?: ComposerControlChangeOrigin): void;
  setSelectedProvider(value: string, origin?: ComposerControlChangeOrigin): void;
  setSelectedSearchPlan(
    optionIds: readonly string[],
    mode: SearchPlanMode,
    origin?: ComposerControlChangeOrigin
  ): void;
  setSelectedSearchStrategy(value: string): void;
  setShowCitations(update: StateUpdate<boolean>): void;
  setShowReasoningBlocks(update: StateUpdate<boolean>): void;
  setShowToolActivity(update: StateUpdate<boolean>): void;
  setStreamMode(value: boolean): void;
  setTemperature(value: string): void;
};

export const initialComposerControlSnapshot: ComposerControlSnapshot = {
  assistantManualBackup: null,
  assistantRemovedNotice: false,
  backgroundMode: true,
  maxOutputTokens: "128000",
  reasoningEffort: "medium",
  reasoningMode: "standard",
  selectedAssistant: null,
  selectedModelId: "gpt-5.5",
  selectedProvider: "openai",
  selectedSearchOptionIds: ["openai-native-web-search"],
  searchPlanMode: "all_selected",
  selectedSearchStrategy: "openai-native-web-search",
  showCitations: true,
  showReasoningBlocks: false,
  showToolActivity: true,
  streamMode: false,
  temperature: "1"
};

function applyUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

function manualBackupFrom(state: ComposerControlSnapshot): ComposerManualDraftBackup {
  return {
    backgroundMode: state.backgroundMode,
    maxOutputTokens: state.maxOutputTokens,
    reasoningEffort: state.reasoningEffort,
    reasoningMode: state.reasoningMode,
    searchPlanMode: state.searchPlanMode,
    selectedModelId: state.selectedModelId,
    selectedProvider: state.selectedProvider,
    selectedSearchOptionIds: [...state.selectedSearchOptionIds],
    selectedSearchStrategy: state.selectedSearchStrategy,
    streamMode: state.streamMode,
    temperature: state.temperature
  };
}

/**
 * Strict identity: a manual change to a governed control removes the Assistant
 * and keeps the resolved values as the ordinary unnamed draft, with the notice
 * flag driving one non-blocking indication. System rewrites clear silently.
 */
function droppedAssistantIdentity(
  state: ComposerControlSnapshot,
  origin: ComposerControlChangeOrigin
): Partial<ComposerControlSnapshot> {
  if (origin === "assistant" || !state.selectedAssistant) {
    return {};
  }
  return {
    assistantManualBackup: null,
    assistantRemovedNotice: origin === "user",
    selectedAssistant: null
  };
}

export const useComposerControlStore = create<ComposerControlStore>((set) => ({
  ...initialComposerControlSnapshot,
  applyAssistantSelection({
    assistant,
    controlDefaults,
    modelId,
    provider,
    searchOptionIds,
    searchPlanMode
  }) {
    set((state) => ({
      assistantManualBackup: state.selectedAssistant
        ? state.assistantManualBackup
        : manualBackupFrom(state),
      assistantRemovedNotice: false,
      backgroundMode: controlDefaults.backgroundMode,
      maxOutputTokens: controlDefaults.maxOutputTokens,
      reasoningEffort: controlDefaults.reasoningEffort,
      reasoningMode: controlDefaults.reasoningMode,
      selectedAssistant: {
        ...assistant,
        starterPrompts: [...assistant.starterPrompts]
      },
      selectedModelId: modelId,
      selectedProvider: provider,
      selectedSearchOptionIds: [...searchOptionIds],
      searchPlanMode,
      selectedSearchStrategy: searchOptionIds[0] ?? "search-disabled",
      streamMode: controlDefaults.streamMode,
      temperature: controlDefaults.temperature
    }));
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
  applyModelSelection({ controlDefaults, modelId, provider }, origin = "user") {
    set((state) => ({
      ...droppedAssistantIdentity(state, origin),
      backgroundMode: controlDefaults.backgroundMode,
      maxOutputTokens: controlDefaults.maxOutputTokens,
      reasoningEffort: controlDefaults.reasoningEffort,
      reasoningMode: controlDefaults.reasoningMode,
      selectedModelId: modelId,
      selectedProvider: provider,
      streamMode: controlDefaults.streamMode,
      temperature: controlDefaults.temperature
    }));
  },
  clearAssistantRemovedNotice() {
    set({ assistantRemovedNotice: false });
  },
  removeAssistant() {
    set((state) => {
      if (!state.selectedAssistant) {
        return {};
      }
      const backup = state.assistantManualBackup;
      return {
        assistantManualBackup: null,
        assistantRemovedNotice: false,
        selectedAssistant: null,
        ...(backup
          ? {
              backgroundMode: backup.backgroundMode,
              maxOutputTokens: backup.maxOutputTokens,
              reasoningEffort: backup.reasoningEffort,
              reasoningMode: backup.reasoningMode,
              searchPlanMode: backup.searchPlanMode,
              selectedModelId: backup.selectedModelId,
              selectedProvider: backup.selectedProvider,
              selectedSearchOptionIds: [...backup.selectedSearchOptionIds],
              selectedSearchStrategy: backup.selectedSearchStrategy,
              streamMode: backup.streamMode,
              temperature: backup.temperature
            }
          : {})
      };
    });
  },
  setBackgroundMode(value) {
    set((state) => ({ ...droppedAssistantIdentity(state, "user"), backgroundMode: value }));
  },
  setMaxOutputTokens(value) {
    set((state) => ({ ...droppedAssistantIdentity(state, "user"), maxOutputTokens: value }));
  },
  setReasoningEffort(value) {
    set((state) => ({ ...droppedAssistantIdentity(state, "user"), reasoningEffort: value }));
  },
  setReasoningMode(value) {
    set((state) => ({ ...droppedAssistantIdentity(state, "user"), reasoningMode: value }));
  },
  setSelectedModelId(value, origin = "user") {
    set((state) => ({ ...droppedAssistantIdentity(state, origin), selectedModelId: value }));
  },
  setSelectedProvider(value, origin = "user") {
    set((state) => ({ ...droppedAssistantIdentity(state, origin), selectedProvider: value }));
  },
  setSelectedSearchPlan(optionIds, mode, origin = "user") {
    const selectedSearchOptionIds = [...optionIds];
    set((state) => ({
      ...droppedAssistantIdentity(state, origin),
      searchPlanMode: mode,
      selectedSearchOptionIds,
      selectedSearchStrategy: selectedSearchOptionIds[0] ?? "search-disabled"
    }));
  },
  setSelectedSearchStrategy(value) {
    set((state) => ({
      ...droppedAssistantIdentity(state, "user"),
      searchPlanMode: "all_selected",
      selectedSearchOptionIds: value === "search-disabled" ? [] : [value],
      selectedSearchStrategy: value
    }));
  },
  setShowCitations(update) {
    set((state) => ({ showCitations: applyUpdate(state.showCitations, update) }));
  },
  setShowReasoningBlocks(update) {
    set((state) => ({ showReasoningBlocks: applyUpdate(state.showReasoningBlocks, update) }));
  },
  setShowToolActivity(update) {
    set((state) => ({ showToolActivity: applyUpdate(state.showToolActivity, update) }));
  },
  setStreamMode(value) {
    set((state) => ({ ...droppedAssistantIdentity(state, "user"), streamMode: value }));
  },
  setTemperature(value) {
    set((state) => ({ ...droppedAssistantIdentity(state, "user"), temperature: value }));
  }
}));

export function resetComposerControlStoreForTest() {
  useComposerControlStore.setState(initialComposerControlSnapshot);
}
