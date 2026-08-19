import type { SavedControlDraft } from "@/components/app-shell/powerAppShellData";
import type { AssistantAvatarRecipe } from "@/lib/contracts/assistants";
import {
  decodeKnowledgePlan,
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import type { SearchPlanMode } from "@/lib/domain/search";
import { create } from "zustand";

type StateUpdate<T> = T | ((current: T) => T);
type ControlDefaults = Required<SavedControlDraft>;

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
export type ComposerKnowledgePlanSource = "assistant" | "chat" | "explicit" | "off" | "project";

export type ComposerAssistantSelection = {
  avatar: AssistantAvatarRecipe;
  description: string;
  id: string;
  includedSkills?: { id: string; name: string }[];
  name: string;
  /** Approximate prompt size for the context gauge only; text stays server-side. */
  promptCharacterCount: number;
  starterPrompts: string[];
};

export type ComposerMcpSelection = McpRunSelection;

export type ComposerSkillSelection = {
  description: string;
  id: string;
  name: string;
  promptCharacterCount: number;
};

export type ComposerManualDraftBackup = {
  backgroundMode: boolean;
  maxOutputTokens: string;
  knowledgePlanSource: Exclude<ComposerKnowledgePlanSource, "assistant">;
  knowledgeSelection: KnowledgeSelection;
  reasoningEffort: string;
  reasoningMode: string;
  searchPlanMode: SearchPlanMode;
  selectedModelId: string;
  selectedKnowledgeBaseIds: string[];
  mcpSelection: ComposerMcpSelection;
  selectedProvider: string;
  selectedSearchOptionIds: string[];
  selectedSkills: ComposerSkillSelection[];
  streamMode: boolean;
  temperature: string;
};

export type ComposerControlSnapshot = {
  assistantManualBackup: ComposerManualDraftBackup | null;
  assistantRemovedNotice: boolean;
  backgroundMode: boolean;
  maxOutputTokens: string;
  knowledgePlanSource: ComposerKnowledgePlanSource;
  knowledgeSelection: KnowledgeSelection;
  reasoningEffort: string;
  reasoningMode: string;
  selectedAssistant: ComposerAssistantSelection | null;
  selectedKnowledgeBaseIds: string[];
  mcpSelection: ComposerMcpSelection;
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

export type ComposerControlStore = ComposerControlSnapshot & {
  applyAssistantSelection(input: {
    assistant: ComposerAssistantSelection;
    controlDefaults: ControlDefaults;
    modelId: string;
    knowledgeBaseIds?: readonly string[];
    knowledgeSelection?: KnowledgeSelection;
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
  setMcpSelection(value: ComposerMcpSelection): void;
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
};

export const initialComposerControlSnapshot: ComposerControlSnapshot = {
  assistantManualBackup: null,
  assistantRemovedNotice: false,
  backgroundMode: true,
  maxOutputTokens: "128000",
  mcpSelection: { mode: "auto" },
  knowledgePlanSource: "off",
  knowledgeSelection: EMPTY_KNOWLEDGE_SELECTION,
  reasoningEffort: "medium",
  reasoningMode: "standard",
  selectedAssistant: null,
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

function clonedKnowledgeSelection(selection: KnowledgeSelection): KnowledgeSelection {
  return {
    ...selection,
    baseIds: [...selection.baseIds],
    sourceIds: [...selection.sourceIds]
  };
}

function manualBackupFrom(state: ComposerControlSnapshot): ComposerManualDraftBackup {
  return {
    backgroundMode: state.backgroundMode,
    maxOutputTokens: state.maxOutputTokens,
    mcpSelection: { ...state.mcpSelection },
    knowledgeSelection: clonedKnowledgeSelection(state.knowledgeSelection),
    knowledgePlanSource: state.knowledgePlanSource === "assistant" ? "off" : state.knowledgePlanSource,
    reasoningEffort: state.reasoningEffort,
    reasoningMode: state.reasoningMode,
    searchPlanMode: state.searchPlanMode,
    selectedModelId: state.selectedModelId,
    selectedKnowledgeBaseIds: [...state.selectedKnowledgeBaseIds],
    selectedProvider: state.selectedProvider,
    selectedSearchOptionIds: [...state.selectedSearchOptionIds],
    selectedSkills: state.selectedSkills.map((skill) => ({ ...skill })),
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
    ...(state.knowledgePlanSource === "assistant" ? { knowledgePlanSource: "explicit" as const } : {}),
    selectedAssistant: null
  };
}

export const useComposerControlStore = create<ComposerControlStore>((set) => ({
  ...initialComposerControlSnapshot,
  applyAssistantSelection({
    assistant,
    controlDefaults,
    knowledgeBaseIds = [],
    knowledgeSelection,
    modelId,
    provider,
    searchOptionIds,
    searchPlanMode
  }) {
    const resolvedKnowledgeSelection = knowledgeSelection ??
      explicitKnowledgeSelection({ baseIds: knowledgeBaseIds });
    set((state) => ({
      assistantManualBackup: state.selectedAssistant
        ? state.assistantManualBackup
        : manualBackupFrom(state),
      assistantRemovedNotice: false,
      backgroundMode: controlDefaults.backgroundMode,
      maxOutputTokens: controlDefaults.maxOutputTokens,
      knowledgePlanSource: "assistant",
      knowledgeSelection: clonedKnowledgeSelection(resolvedKnowledgeSelection),
      reasoningEffort: controlDefaults.reasoningEffort,
      reasoningMode: controlDefaults.reasoningMode,
      selectedAssistant: {
        ...assistant,
        includedSkills: assistant.includedSkills?.map((skill) => ({ ...skill })) ?? [],
        starterPrompts: [...assistant.starterPrompts]
      },
      selectedKnowledgeBaseIds: [...resolvedKnowledgeSelection.baseIds],
      selectedModelId: modelId,
      selectedProvider: provider,
      selectedSearchOptionIds: [...searchOptionIds],
      selectedSkills: state.selectedSkills.map((skill) => ({ ...skill })),
      searchPlanMode,
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
              mcpSelection: { ...backup.mcpSelection },
              knowledgeSelection: clonedKnowledgeSelection(backup.knowledgeSelection),
              knowledgePlanSource: backup.knowledgePlanSource,
              reasoningEffort: backup.reasoningEffort,
              reasoningMode: backup.reasoningMode,
              searchPlanMode: backup.searchPlanMode,
              selectedModelId: backup.selectedModelId,
              selectedKnowledgeBaseIds: [...backup.selectedKnowledgeBaseIds],
              selectedProvider: backup.selectedProvider,
              selectedSearchOptionIds: [...backup.selectedSearchOptionIds],
              selectedSkills: backup.selectedSkills.map((skill) => ({ ...skill })),
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
  setMcpSelection(mcpSelection) {
    set((state) => state.selectedAssistant
      ? {}
      : {
          mcpSelection: { ...mcpSelection }
        });
  },
  setSelectedKnowledgePlan(selection, source = "explicit", origin = "user") {
    const decoded = decodeKnowledgePlan(Array.isArray(selection)
      ? explicitKnowledgeSelection({ baseIds: selection })
      : selection);
    if (!decoded.ok) return;
    const knowledgeSelection = decoded.plan;
    set((state) => ({
      ...droppedAssistantIdentity(state, origin),
      knowledgePlanSource: source,
      knowledgeSelection,
      selectedKnowledgeBaseIds: [...knowledgeSelection.baseIds]
    }));
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
      selectedSearchOptionIds
    }));
  },
  setSelectedSkills(selectedSkills) {
    set((state) => {
      const next = selectedSkills.map((skill) => ({ ...skill }));
      return {
        selectedSkills: next,
        ...(state.assistantManualBackup
          ? {
              assistantManualBackup: {
                ...state.assistantManualBackup,
                selectedSkills: next.map((skill) => ({ ...skill }))
              }
            }
          : {})
      };
    });
  },
  setShowCitations(update) {
    set((state) => ({ showCitations: applyUpdate(state.showCitations, update) }));
  },
  setShowReasoningBlocks(update) {
    set((state) => ({ showReasoningBlocks: applyUpdate(state.showReasoningBlocks, update) }));
  },
  setStreamMode(value) {
    set((state) => ({ ...droppedAssistantIdentity(state, "user"), streamMode: value }));
  },
  setTemperature(value) {
    set((state) => ({ ...droppedAssistantIdentity(state, "user"), temperature: value }));
  }
}));
