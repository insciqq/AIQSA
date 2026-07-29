import type { PromptPreset } from "@/components/app-shell/types";
import type { SavedControlDraft } from "@/components/app-shell/powerAppShellData";
import type { SearchPlanMode } from "@/lib/domain/search";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);
type ControlDefaults = Required<Omit<SavedControlDraft, "searchStrategyId">>;

export type ComposerModelSelection = {
  controlDefaults: ControlDefaults;
  modelId: string;
  provider: string;
  searchStrategyId: string;
  searchOptionIds?: readonly string[];
  searchPlanMode?: SearchPlanMode;
};

export type ComposerControlSnapshot = {
  backgroundMode: boolean;
  developerPrompt: string;
  maxOutputTokens: string;
  reasoningEffort: string;
  reasoningMode: string;
  selectedModelId: string;
  selectedPromptId: string | null;
  selectedProvider: string;
  selectedSearchOptionIds: string[];
  searchPlanMode: SearchPlanMode;
  selectedSearchStrategy: string;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
  streamMode: boolean;
  systemPrompt: string;
  temperature: string;
};

export type ComposerControlStore = ComposerControlSnapshot & {
  applyControlDefaults(defaults: ControlDefaults): void;
  applyModelSelection(selection: ComposerModelSelection): void;
  applyPrompt(prompt: PromptPreset | null): void;
  setBackgroundMode(value: boolean): void;
  setDeveloperPrompt(value: string): void;
  setMaxOutputTokens(value: string): void;
  setReasoningEffort(value: string): void;
  setReasoningMode(value: string): void;
  setSelectedModelId(value: string): void;
  setSelectedPromptId(value: string | null): void;
  setSelectedProvider(value: string): void;
  setSelectedSearchPlan(optionIds: readonly string[], mode: SearchPlanMode): void;
  setSelectedSearchStrategy(value: string): void;
  setShowCitations(update: StateUpdate<boolean>): void;
  setShowReasoningBlocks(update: StateUpdate<boolean>): void;
  setShowToolActivity(update: StateUpdate<boolean>): void;
  setStreamMode(value: boolean): void;
  setSystemPrompt(value: string): void;
  setTemperature(value: string): void;
};

export const initialComposerControlSnapshot: ComposerControlSnapshot = {
  backgroundMode: true,
  developerPrompt: "",
  maxOutputTokens: "128000",
  reasoningEffort: "medium",
  reasoningMode: "standard",
  selectedModelId: "gpt-5.5",
  selectedPromptId: null,
  selectedProvider: "openai",
  selectedSearchOptionIds: ["openai-native-web-search"],
  searchPlanMode: "all_selected",
  selectedSearchStrategy: "openai-native-web-search",
  showCitations: true,
  showReasoningBlocks: false,
  showToolActivity: true,
  streamMode: false,
  systemPrompt: "",
  temperature: "1"
};

function applyUpdate<T>(current: T, update: StateUpdate<T>): T {
  return typeof update === "function" ? (update as (value: T) => T)(current) : update;
}

export const useComposerControlStore = create<ComposerControlStore>((set) => ({
  ...initialComposerControlSnapshot,
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
  applyModelSelection({
    controlDefaults,
    modelId,
    provider,
    searchOptionIds,
    searchPlanMode,
    searchStrategyId
  }) {
    const optionIds = searchOptionIds
      ? [...searchOptionIds]
      : searchStrategyId === "search-disabled"
        ? []
        : [searchStrategyId];
    set({
      backgroundMode: controlDefaults.backgroundMode,
      maxOutputTokens: controlDefaults.maxOutputTokens,
      reasoningEffort: controlDefaults.reasoningEffort,
      reasoningMode: controlDefaults.reasoningMode,
      selectedModelId: modelId,
      selectedProvider: provider,
      selectedSearchOptionIds: optionIds,
      searchPlanMode: searchPlanMode ?? "all_selected",
      selectedSearchStrategy: searchStrategyId,
      streamMode: controlDefaults.streamMode,
      temperature: controlDefaults.temperature
    });
  },
  applyPrompt(prompt) {
    set({
      developerPrompt: prompt?.developerPrompt ?? "",
      selectedPromptId: prompt?.id ?? null,
      systemPrompt: prompt?.systemPrompt ?? ""
    });
  },
  setBackgroundMode(value) {
    set({ backgroundMode: value });
  },
  setDeveloperPrompt(value) {
    set({ developerPrompt: value });
  },
  setMaxOutputTokens(value) {
    set({ maxOutputTokens: value });
  },
  setReasoningEffort(value) {
    set({ reasoningEffort: value });
  },
  setReasoningMode(value) {
    set({ reasoningMode: value });
  },
  setSelectedModelId(value) {
    set({ selectedModelId: value });
  },
  setSelectedPromptId(value) {
    set({ selectedPromptId: value });
  },
  setSelectedProvider(value) {
    set({ selectedProvider: value });
  },
  setSelectedSearchPlan(optionIds, mode) {
    const selectedSearchOptionIds = [...optionIds];
    set({
      searchPlanMode: mode,
      selectedSearchOptionIds,
      selectedSearchStrategy: selectedSearchOptionIds[0] ?? "search-disabled"
    });
  },
  setSelectedSearchStrategy(value) {
    set({
      searchPlanMode: "all_selected",
      selectedSearchOptionIds: value === "search-disabled" ? [] : [value],
      selectedSearchStrategy: value
    });
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
    set({ streamMode: value });
  },
  setSystemPrompt(value) {
    set({ systemPrompt: value });
  },
  setTemperature(value) {
    set({ temperature: value });
  }
}));

export function resetComposerControlStoreForTest() {
  useComposerControlStore.setState(initialComposerControlSnapshot);
}
