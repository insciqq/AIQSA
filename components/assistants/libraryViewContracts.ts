import type {
  AssistantAvailability,
  AssistantAvatarRecipe,
  AssistantCategory,
  AssistantDraft,
  AssistantPublicationView,
  AssistantPublishableGroup,
  AssistantContent,
  AssistantRunControlField,
  AssistantRunControls,
  AssistantSummary
} from "@/lib/contracts/assistants";
import type { ModelParameterControls } from "@/lib/contracts/catalog";
import type { McpReadiness } from "@/lib/contracts/mcp";
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
  streamMode: boolean | null;
  backgroundMode: boolean | null;
  systemPrompt: string;
  temperature: string;
};

export type AssistantEditorField =
  | AssistantRunControlField
  | "mcpServerIds"
  | "providerModelId";

export type AssistantEditorFieldErrors = Partial<Record<AssistantEditorField, string>>;

export type AssistantEditorModelOption = {
  capabilities: {
    documentInputMode: "native_pdf" | "none" | "pdf_text_extraction";
    imageInput: boolean;
    reasoning: boolean;
    toolCalling: boolean;
  };
  controls: ModelParameterControls;
  id: string;
  label: string;
  providerFamily?: string;
  providerLabel: string;
  supportsTools: boolean;
};

export type AssistantEditorOptions = {
  knowledgeBases: { available: boolean; id: string; name: string }[];
  knowledgeSources: { available: boolean; id: string; name: string }[];
  knowledgeDataError: string | null;
  knowledgeDataState: "error" | "loading" | "ready";
  mcpServers: { enabled: boolean; id: string; name: string; readiness: McpReadiness }[];
  models: AssistantEditorModelOption[];
  onRetryKnowledge(): void;
  onRetrySkills(): void;
  searchOptions: { id: string; label: string }[];
  skillDataError: string | null;
  skillDataState: "error" | "loading" | "ready";
  skills: SkillSummary[];
};

export type AssistantEditorView = {
  availability: AssistantAvailability | null;
  /** Stable field-scoped error code from the failed save, if any. */
  error: { code: string; text: string } | null;
  fieldErrors: AssistantEditorFieldErrors | null;
  dirty: boolean;
  draft: AssistantEditorDraftState;
  /** True only immediately after an atomic create, for the actionable created banner. */
  justCreated: boolean;
  mode: "create" | "edit";
  onCancel(): void;
  onChange(update: Partial<AssistantEditorDraftState>): void;
  onGenerateAvatar(): void;
  onOpenMcpSettings(): void;
  onPublish(input: { groupId?: string; scope: "group" | "installation" }): void;
  onRevokePublication(publicationId: string): void;
  onSave(): void;
  onUseInChat: (() => void) | null;
  options: AssistantEditorOptions;
  publications: AssistantPublicationView[] | null;
  publishableGroups: AssistantPublishableGroup[];
  canPublishInstallation: boolean;
  saving: boolean;
};

export type AssistantLibraryListView = {
  assistants: AssistantSummary[];
  onArchiveToggle(assistantId: string, archived: boolean): void;
  onDuplicate(assistantId: string): void;
  onEdit(assistantId: string): void;
  onNewAssistant(): void;
  onPinToggle(assistantId: string, pinned: boolean): void;
  onUse(assistantId: string): void;
};

export type AssistantLibraryView = {
  busy: boolean;
  catalogError: string | null;
  catalogState: "error" | "loading" | "ready";
  editor: AssistantEditorView | null;
  list: AssistantLibraryListView;
  notice: LibraryNotice | null;
  onBackToChat(): void;
  onDismissNotice(): void;
  onRetryCatalog(): void;
  /** Which Library subview is visible; editor is non-null when active. */
  task: "editor" | "list";
};

export type AssistantEditorDraftResult =
  | { draft: AssistantDraft }
  | { fieldErrors: AssistantEditorFieldErrors };

function invalidRunControlMessage(
  field: AssistantRunControlField,
  controls: ModelParameterControls
): string {
  switch (field) {
    case "backgroundMode":
      return "This model does not support Background mode.";
    case "maxOutputTokens":
      return `Enter a whole number from 1 to ${controls.maxOutputTokens.maxValue}.`;
    case "reasoningEffort":
      return "Choose a reasoning effort offered by this model.";
    case "reasoningMode":
      return "Choose a reasoning mode offered by this model.";
    case "streamMode":
      return "This model does not support Stream mode.";
    case "temperature":
      return controls.temperature.supported
        ? `Enter a temperature from ${controls.temperature.minValue} to ${controls.temperature.maxValue}.`
        : "This model does not support Temperature.";
  }
}

export function assistantDraftFromEditorState(
  state: AssistantEditorDraftState,
  modelControls: ModelParameterControls | null
): AssistantEditorDraftResult {
  if (!state.providerModelId || !modelControls) {
    return {
      fieldErrors: { providerModelId: "Choose a model from your catalog." }
    };
  }

  const fieldErrors: AssistantEditorFieldErrors = {};
  const runControls: AssistantRunControls = {};

  if (state.backgroundMode !== null) {
    if (modelControls.background.supported) {
      runControls.backgroundMode = state.backgroundMode;
    } else {
      fieldErrors.backgroundMode = invalidRunControlMessage("backgroundMode", modelControls);
    }
  }
  if (state.streamMode !== null) {
    if (modelControls.stream.supported) {
      runControls.streamMode = state.streamMode;
    } else {
      fieldErrors.streamMode = invalidRunControlMessage("streamMode", modelControls);
    }
  }
  if (state.reasoningEffort) {
    if (
      modelControls.reasoningEffort.supported &&
      modelControls.reasoningEffort.options.includes(state.reasoningEffort)
    ) {
      runControls.reasoningEffort = state.reasoningEffort;
    } else {
      fieldErrors.reasoningEffort = invalidRunControlMessage("reasoningEffort", modelControls);
    }
  }
  if (state.reasoningMode) {
    if (
      modelControls.reasoningMode?.supported === true &&
      modelControls.reasoningMode.options.includes(state.reasoningMode)
    ) {
      runControls.reasoningMode = state.reasoningMode;
    } else {
      fieldErrors.reasoningMode = invalidRunControlMessage("reasoningMode", modelControls);
    }
  }

  if (state.maxOutputTokens.trim()) {
    const maxOutputTokens = Number(state.maxOutputTokens);
    if (
      Number.isInteger(maxOutputTokens) &&
      maxOutputTokens >= 1 &&
      maxOutputTokens <= modelControls.maxOutputTokens.maxValue
    ) {
      runControls.maxOutputTokens = maxOutputTokens;
    } else {
      fieldErrors.maxOutputTokens = invalidRunControlMessage("maxOutputTokens", modelControls);
    }
  }

  if (state.temperature.trim()) {
    const temperature = Number(state.temperature);
    if (
      modelControls.temperature.supported &&
      Number.isFinite(temperature) &&
      temperature >= modelControls.temperature.minValue &&
      temperature <= modelControls.temperature.maxValue
    ) {
      runControls.temperature = temperature;
    } else {
      fieldErrors.temperature = invalidRunControlMessage("temperature", modelControls);
    }
  }

  if (Object.keys(fieldErrors).length > 0) {
    return { fieldErrors };
  }

  return {
    draft: {
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
    }
  };
}

export type AssistantDraftReconciliation = {
  draft: AssistantEditorDraftState;
  resetFields: AssistantRunControlField[];
};

/**
 * Drops overrides the newly selected model cannot execute. Values are never
 * clamped or replaced with a different explicit value; callers must present
 * `resetFields` so the reset is visible to the user.
 */
export function reconcileDraftForModel(
  state: AssistantEditorDraftState,
  controls: ModelParameterControls | null
): AssistantDraftReconciliation {
  const draft = { ...state };
  const resetFields: AssistantRunControlField[] = [];
  const reset = <Field extends AssistantRunControlField>(
    field: Field,
    value: AssistantEditorDraftState[Field]
  ) => {
    if (draft[field] === value) return;
    (draft[field] as AssistantEditorDraftState[Field]) = value;
    resetFields.push(field);
  };

  if (
    draft.backgroundMode !== null &&
    (!controls || !controls.background.supported)
  ) {
    reset("backgroundMode", null);
  }
  if (draft.streamMode !== null && (!controls || !controls.stream.supported)) {
    reset("streamMode", null);
  }
  if (
    draft.maxOutputTokens.trim() &&
    (!controls ||
      !Number.isInteger(Number(draft.maxOutputTokens)) ||
      Number(draft.maxOutputTokens) < 1 ||
      Number(draft.maxOutputTokens) > controls.maxOutputTokens.maxValue)
  ) {
    reset("maxOutputTokens", "");
  }
  if (
    draft.temperature.trim() &&
    (!controls ||
      !controls.temperature.supported ||
      !Number.isFinite(Number(draft.temperature)) ||
      Number(draft.temperature) < controls.temperature.minValue ||
      Number(draft.temperature) > controls.temperature.maxValue)
  ) {
    reset("temperature", "");
  }
  if (
    draft.reasoningEffort &&
    (!controls ||
      !controls.reasoningEffort.supported ||
      !controls.reasoningEffort.options.includes(draft.reasoningEffort))
  ) {
    reset("reasoningEffort", "");
  }
  if (
    draft.reasoningMode &&
    (!controls?.reasoningMode?.supported ||
      !controls.reasoningMode.options.includes(draft.reasoningMode))
  ) {
    reset("reasoningMode", "");
  }

  return { draft, resetFields };
}

export function editorStateFromContent(
  content: AssistantContent
): AssistantEditorDraftState {
  const controls = content.runControls;
  return {
    avatar: content.avatar,
    backgroundMode: controls.backgroundMode ?? null,
    category: content.category,
    description: content.description,
    developerPrompt: content.developerPrompt ?? "",
    knowledgeSelection: content.knowledgeSelection.mode === "inherited"
      ? EMPTY_KNOWLEDGE_SELECTION
      : content.knowledgeSelection,
    maxOutputTokens:
      controls.maxOutputTokens !== undefined
        ? String(controls.maxOutputTokens)
        : "",
    mcpServerIds: [...content.mcpServerIds],
    name: content.name,
    providerModelId: content.providerModelId,
    reasoningEffort: controls.reasoningEffort ?? "",
    reasoningMode: controls.reasoningMode ?? "",
    searchOptionIds: [...content.searchPlan.optionIds],
    searchPlanMode: content.searchPlan.mode,
    skillIds: [...content.skillIds],
    starterPrompts: [...content.starterPrompts],
    streamMode: controls.streamMode ?? null,
    systemPrompt: content.systemPrompt,
    temperature:
      controls.temperature !== undefined
        ? String(controls.temperature)
        : ""
  };
}
