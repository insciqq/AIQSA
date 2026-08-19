import type {
  AssistantAvatarRecipe,
  AssistantCategory,
  AssistantDraft,
  AssistantPublicationView,
  AssistantPublishableGroup,
  AssistantRevisionContent,
  AssistantRevisionHistoryEntry,
  AssistantRunControls,
  AssistantSummary
} from "@/lib/contracts/assistants";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import type { SearchPlanMode } from "@/lib/domain/search";
import type { SkillSummary } from "@/lib/contracts/skills";
import {
  EMPTY_KNOWLEDGE_SELECTION,
  type KnowledgeSelection
} from "@/lib/contracts/knowledge";

export type LibraryNotice = {
  kind: "error" | "success";
  text: string;
};

/** Discover shows shared items; Yours shows owned items. */
export type LibraryMode = "discover" | "yours";

export type LibraryFilter =
  | "all"
  | "archived"
  | "groups"
  | "installation"
  | "pinned"
  | "unavailable";

/**
 * Editor draft state: field values exactly as edited. Numeric run controls are
 * kept as strings while editing; the controller converts them to the bounded
 * wire draft on save.
 */
export type AssistantEditorDraftState = {
  avatar: AssistantAvatarRecipe;
  category: AssistantCategory | null;
  description: string;
  developerPrompt: string;
  knowledgeSelection: KnowledgeSelection;
  maxOutputTokens: string;
  mcpServerIds: string[];
  name: string;
  providerModelId: string | null;
  reasoningEffort: string;
  reasoningMode: string;
  searchOptionIds: string[];
  searchPlanMode: SearchPlanMode;
  skillIds: string[];
  starterPrompts: string[];
  streamMode: boolean;
  backgroundMode: boolean;
  systemPrompt: string;
  temperature: string;
};

export type AssistantEditorModelOption = {
  controls: ModelParameterControls;
  id: string;
  label: string;
  providerLabel: string;
  supportsTools: boolean;
};

export type AssistantEditorOptions = {
  knowledgeBases: { available: boolean; id: string; name: string }[];
  knowledgeSources: { available: boolean; id: string; name: string }[];
  knowledgeDataError: string | null;
  knowledgeDataState: "error" | "loading" | "ready";
  mcpServers: { id: string; name: string }[];
  models: AssistantEditorModelOption[];
  onRetryKnowledge(): void;
  onRetrySkills(): void;
  searchOptions: { id: string; label: string }[];
  skillDataError: string | null;
  skillDataState: "error" | "loading" | "ready";
  skills: SkillSummary[];
};

export type AssistantEditorView = {
  /** Stable field-scoped error code from the failed save, if any. */
  error: { code: string; text: string } | null;
  dirty: boolean;
  draft: AssistantEditorDraftState;
  mode: "create" | "edit";
  onCancel(): void;
  onChange(update: Partial<AssistantEditorDraftState>): void;
  onGenerateAvatar(): void;
  onPublish(input: { groupId?: string; scope: "group" | "installation" }): void;
  onRevokePublication(publicationId: string): void;
  onSave(): void;
  onUseInChat: (() => void) | null;
  options: AssistantEditorOptions;
  publications: AssistantPublicationView[] | null;
  publishableGroups: AssistantPublishableGroup[];
  canPublishInstallation: boolean;
  /** Header shows `Draft` before creation and `Revision N` afterward. */
  revisionNumber: number | null;
  saving: boolean;
};

export type AssistantHistoryView = {
  assistantName: string;
  entries: AssistantRevisionHistoryEntry[];
  loading: boolean;
  onBack(): void;
  onRestore(revisionNumber: number): void;
  onView(revisionNumber: number): void;
  restoring: boolean;
  /** Read-only content of the currently viewed revision, when one is open. */
  viewedRevision: AssistantRevisionContent | null;
};

export type AssistantLibraryListView = {
  assistants: AssistantSummary[];
  filter: LibraryFilter;
  category: AssistantCategory | null;
  mode: LibraryMode;
  onArchiveToggle(assistantId: string, archived: boolean): void;
  onCategoryChange(category: AssistantCategory | null): void;
  onDuplicate(assistantId: string): void;
  onEdit(assistantId: string): void;
  onFilterChange(filter: LibraryFilter): void;
  onModeChange(mode: LibraryMode): void;
  onNewAssistant(): void;
  onOpenHistory(assistantId: string): void;
  onPinToggle(assistantId: string, pinned: boolean): void;
  onQueryChange(query: string): void;
  onUse(assistantId: string): void;
  query: string;
};

export type AssistantLibraryView = {
  busy: boolean;
  catalogError: string | null;
  catalogState: "error" | "loading" | "ready";
  editor: AssistantEditorView | null;
  history: AssistantHistoryView | null;
  list: AssistantLibraryListView;
  notice: LibraryNotice | null;
  onBackToChat(): void;
  onDismissNotice(): void;
  onRetryCatalog(): void;
  /** Which full-screen task is visible; editor/history are non-null when active. */
  task: "editor" | "history" | "list";
};

export function assistantDraftFromEditorState(
  state: AssistantEditorDraftState,
  modelControls: ModelParameterControls | null
): AssistantDraft | null {
  if (!state.providerModelId) {
    return null;
  }
  const runControls: AssistantRunControls = {};
  if (modelControls) {
    if (modelControls.background.supported) {
      runControls.backgroundMode = state.backgroundMode;
    }
    if (modelControls.stream.supported) {
      runControls.streamMode = state.streamMode;
    }
    if (modelControls.reasoningEffort.supported && state.reasoningEffort) {
      runControls.reasoningEffort = state.reasoningEffort;
    }
    if (modelControls.reasoningMode?.supported && state.reasoningMode) {
      runControls.reasoningMode = state.reasoningMode;
    }
    const maxOutputTokens = Number.parseInt(state.maxOutputTokens, 10);
    if (Number.isInteger(maxOutputTokens) && maxOutputTokens >= 1) {
      runControls.maxOutputTokens = maxOutputTokens;
    }
    if (modelControls.temperature.supported) {
      const temperature = Number.parseFloat(state.temperature);
      if (Number.isFinite(temperature)) {
        runControls.temperature = temperature;
      }
    }
  }

  return {
    avatar: state.avatar,
    category: state.category,
    description: state.description.trim(),
    developerPrompt: state.developerPrompt.trim() ? state.developerPrompt : null,
    knowledgeSelection: state.knowledgeSelection,
    mcpServerIds: [...state.mcpServerIds],
    name: state.name.trim(),
    providerModelId: state.providerModelId,
    runControls,
    searchPlan: {
      mode: state.searchPlanMode,
      optionIds: [...state.searchOptionIds]
    },
    skillIds: [...state.skillIds],
    starterPrompts: state.starterPrompts
      .map((starter) => starter.trim())
      .filter((starter) => starter.length > 0),
    systemPrompt: state.systemPrompt
  };
}

export function editorStateFromRevision(
  revision: AssistantRevisionContent,
  fallbackControls: {
    backgroundMode: boolean;
    maxOutputTokens: string;
    reasoningEffort: string;
    reasoningMode: string;
    streamMode: boolean;
    temperature: string;
  }
): AssistantEditorDraftState {
  const controls = revision.runControls;
  return {
    avatar: revision.avatar,
    backgroundMode: controls.backgroundMode ?? fallbackControls.backgroundMode,
    category: revision.category,
    description: revision.description,
    developerPrompt: revision.developerPrompt ?? "",
    knowledgeSelection: revision.knowledgeSelection.mode === "inherited"
      ? EMPTY_KNOWLEDGE_SELECTION
      : revision.knowledgeSelection,
    maxOutputTokens:
      controls.maxOutputTokens !== undefined
        ? String(controls.maxOutputTokens)
        : fallbackControls.maxOutputTokens,
    mcpServerIds: [...revision.mcpServerIds],
    name: revision.name,
    providerModelId: revision.providerModelId,
    reasoningEffort: controls.reasoningEffort ?? fallbackControls.reasoningEffort,
    reasoningMode: controls.reasoningMode ?? fallbackControls.reasoningMode,
    searchOptionIds: [...revision.searchPlan.optionIds],
    searchPlanMode: revision.searchPlan.mode,
    skillIds: [...revision.skillIds],
    starterPrompts: [...revision.starterPrompts],
    streamMode: controls.streamMode ?? fallbackControls.streamMode,
    systemPrompt: revision.systemPrompt,
    temperature:
      controls.temperature !== undefined
        ? String(controls.temperature)
        : fallbackControls.temperature
  };
}
