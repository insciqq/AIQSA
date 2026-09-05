import {
  createAssistant,
  duplicateAssistant,
  fetchAssistantDetail,
  fetchAssistantList,
  publishAssistant,
  updateAssistant,
  revokeAssistantPublication,
  setAssistantArchived,
  setAssistantPinned
} from "@/components/assistants/assistantsApi";
import {
  assistantDraftFromEditorState,
  editorStateFromContent,
  reconcileDraftForModel,
  type AssistantEditorDraftState,
  type AssistantEditorFieldErrors,
  type AssistantLibraryView
} from "@/components/assistants/libraryViewContracts";
import { generateAssistantAvatarRecipe } from "@/components/assistants/avatarGeneration";
import {
  useAssistantLibraryStore,
  type AssistantLibraryEditorState,
  type AssistantLibrarySnapshot
} from "@/components/app-shell/assistantLibraryStore";
import { loadUserMcpServers } from "@/components/app-shell/mcpSettingsApi";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import type { Catalog, CatalogModel } from "@/components/app-shell/types";
import type {
  AssistantDetail,
  AssistantRunControlField
} from "@/lib/contracts/assistants";
import {
  EMPTY_KNOWLEDGE_SELECTION,
  explicitKnowledgeSelection
} from "@/lib/contracts/knowledge";
import { isMcpReadinessStartable } from "@/lib/contracts/mcp";

const RECENT_ASSISTANTS_KEY = "aiqsa.assistants.recent";
const RECENT_ASSISTANTS_LIMIT = 5;

export function readRecentAssistantIds(): string[] {
  try {
    const raw = window.localStorage.getItem(RECENT_ASSISTANTS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((id): id is string => typeof id === "string").slice(0, RECENT_ASSISTANTS_LIMIT)
      : [];
  } catch {
    return [];
  }
}

function rememberRecentAssistant(assistantId: string) {
  try {
    const next = [assistantId, ...readRecentAssistantIds().filter((id) => id !== assistantId)]
      .slice(0, RECENT_ASSISTANTS_LIMIT);
    window.localStorage.setItem(RECENT_ASSISTANTS_KEY, JSON.stringify(next));
  } catch {
    // Recents are best-effort browser-local state.
  }
}

function editorErrorText(code: string, message: string): string {
  const known: Record<string, string> = {
    assistant_archived: "This assistant is archived. Restore it before saving changes.",
    assistant_avatar_invalid: "The avatar could not be saved. Generate another and retry.",
    assistant_category_invalid: "Choose one of the listed categories.",
    assistant_description_invalid: "Shorten the description to 400 characters.",
    assistant_developer_prompt_invalid: "Shorten the developer prompt.",
    assistant_mcp_servers_invalid: "The MCP tool selection is invalid.",
    assistant_model_invalid: "Choose a model from your catalog.",
    assistant_model_not_available: "Choose a model from your catalog.",
    assistant_name_invalid: "Give the assistant a name of up to 80 characters.",
    assistant_run_controls_invalid: "The run controls are outside the model's supported range.",
    assistant_search_option_not_available: "One selected Search source is not available to you.",
    assistant_search_plan_invalid: "The Search selection is invalid.",
    assistant_skill_audience_mismatch:
      "Share every included Skill with this audience before publishing the Assistant.",
    assistant_skills_invalid: "The Skill selection is invalid.",
    assistant_skills_not_available: "One selected Skill is no longer available to you.",
    assistant_knowledge_bases_invalid: "The Knowledge selection is invalid.",
    assistant_starter_prompts_invalid: "Starter prompts must be short, non-empty lines.",
    assistant_system_prompt_invalid: "Shorten the system prompt.",
    assistant_tools_not_available: "One selected MCP server is not available to you.",
    assistant_version_conflict:
      "This assistant changed in another session. Reload Assistants and reapply your edit."
  };
  return known[code] ?? message;
}

const runControlLabels: Record<AssistantRunControlField, string> = {
  backgroundMode: "Background",
  maxOutputTokens: "Max answer length",
  reasoningEffort: "Reasoning effort",
  reasoningMode: "Reasoning mode",
  streamMode: "Stream",
  temperature: "Temperature"
};

function resetNotice(fields: readonly AssistantRunControlField[]): string | null {
  const labels = fields.map((field) => runControlLabels[field]);
  if (labels.length === 0) return null;
  if (labels.length === 1) {
    return `${labels[0]} reset to the model default.`;
  }
  const last = labels.at(-1);
  return `${labels.slice(0, -1).join(", ")} and ${last} reset to the model defaults.`;
}

function serverFieldErrorText(
  field: AssistantRunControlField,
  limit: number | undefined,
  controls: ReturnType<typeof modelControlsFor>
): string {
  if (field === "maxOutputTokens") {
    return limit === undefined
      ? "Enter a valid whole-number answer length."
      : `Enter a whole number no greater than ${limit}.`;
  }
  if (field === "temperature") {
    return controls?.temperature.supported
      ? `Enter a temperature from ${controls.temperature.minValue} to ${controls.temperature.maxValue}.`
      : "This model does not accept that Temperature value.";
  }
  return `${runControlLabels[field]} is not supported by the selected model.`;
}

function firstFieldError(fieldErrors: AssistantEditorFieldErrors): string {
  return Object.values(fieldErrors).find((message): message is string => Boolean(message)) ??
    "Review the highlighted setup fields.";
}

function draftBaseline(draft: AssistantEditorDraftState): string {
  return JSON.stringify(draft);
}

function modelControlsFor(catalog: Catalog | null, providerModelId: string | null) {
  if (!providerModelId || !catalog) return null;
  return (
    catalog.models.find((model) => model.modelId === providerModelId)?.parameterControls ?? null
  );
}

function blankEditorDraft(prefill?: Partial<AssistantEditorDraftState>): AssistantEditorDraftState {
  return {
    avatar: generateAssistantAvatarRecipe(),
    backgroundMode: null,
    category: null,
    description: "",
    developerPrompt: "",
    knowledgeSelection: EMPTY_KNOWLEDGE_SELECTION,
    maxOutputTokens: "",
    mcpServerIds: [],
    name: "",
    providerModelId: null,
    reasoningEffort: "",
    reasoningMode: "",
    searchOptionIds: [],
    searchPlanMode: "all_selected",
    skillIds: [],
    starterPrompts: [],
    streamMode: null,
    systemPrompt: "",
    temperature: "",
    ...prefill
  };
}

function mcpSelectionError(
  draft: AssistantEditorDraftState,
  catalog: Catalog | null,
  options: AssistantLibrarySnapshot["mcpOptions"]
): string | null {
  if (draft.mcpServerIds.length === 0) return null;
  const model = catalog?.models.find((entry) => entry.modelId === draft.providerModelId);
  if (model && !model.capabilities.toolCalling) {
    return "Choose a model that can call tools, or remove the MCP tools.";
  }
  const optionById = new Map(options.map((option) => [option.id, option]));
  const unavailable = draft.mcpServerIds.some((serverId) => {
    const option = optionById.get(serverId);
    return !option || !option.enabled || !isMcpReadinessStartable(option.readiness);
  });
  return unavailable
    ? "Remove MCP servers that are disabled or need attention before saving."
    : null;
}

export type AssistantLibraryControllerInput = {
  activateBlankWorkspace(): void;
  applyAssistantToComposer(input: {
    assistant: {
      avatar: import("@/lib/contracts/assistants").AssistantAvatarRecipe;
      description: string;
      id: string;
      includedSkills: { id: string; name: string }[];
      knowledgeLabel?: string | null;
      knowledgeResourceCount?: number;
      name: string;
      promptCharacterCount: number;
      starterPrompts: string[];
    };
    content: import("@/lib/contracts/assistants").AssistantContent;
  }): boolean;
  catalog: Catalog | null;
  catalogError: string | null;
  knowledgeBases: { available: boolean; id: string; name: string }[];
  knowledgeSources: { available: boolean; id: string; name: string }[];
  knowledgeDataError: string | null;
  knowledgeDataState: "error" | "loading" | "ready";
  openMcpSettings(): void;
  retryCatalog(): void;
  retryKnowledge(): void;
  retrySkills(): void;
  setShellNotice(notice: { kind: "error"; text: string }): void;
  skillDataError: string | null;
  skillDataState: "error" | "loading" | "ready";
  skills: import("@/lib/contracts/skills").SkillSummary[];
};

export function createAssistantLibraryActions(input: AssistantLibraryControllerInput) {
  const store = () => useAssistantLibraryStore.getState();

  function beginBusyOperation(): number | null {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) {
      return null;
    }
    const requestId = snapshot.busyRequestId + 1;
    snapshot.patch({ busy: true, busyRequestId: requestId });
    return requestId;
  }

  function ownsBusyOperation(requestId: number): boolean {
    const snapshot = store();
    return snapshot.busy && snapshot.busyRequestId === requestId;
  }

  function finishBusyOperation(
    requestId: number,
    update: Partial<AssistantLibrarySnapshot> = {}
  ): boolean {
    const snapshot = store();
    if (!snapshot.busy || snapshot.busyRequestId !== requestId) {
      return false;
    }
    snapshot.patch({ ...update, busy: false });
    return true;
  }

  async function refreshList() {
    const snapshot = store();
    const requestId = snapshot.listRequestId + 1;
    snapshot.patch({
      dataError: null,
      dataState: snapshot.data ? "ready" : "loading",
      listRequestId: requestId
    });
    const result = await fetchAssistantList();
    if (store().listRequestId !== requestId) {
      return;
    }
    if (!result.ok) {
      const current = store();
      if (current.data) {
        current.patch({ notice: { kind: "error", text: result.message } });
      } else {
        current.patch({ dataError: result.message, dataState: "error" });
      }
      return;
    }
    store().patch({ data: result.data, dataError: null, dataState: "ready" });
  }

  async function refreshMcpOptions() {
    const snapshot = store();
    const requestId = snapshot.mcpOptionsRequestId + 1;
    // A previous successful response is not proof that the dependency remains
    // runnable. Clear it while revalidating so save fails closed.
    snapshot.patch({ mcpOptions: [], mcpOptionsRequestId: requestId });
    try {
      const servers = await loadUserMcpServers();
      const current = store();
      if (!current.open || current.mcpOptionsRequestId !== requestId) return;
      current.patch({
        mcpOptions: servers
          .map((server) => ({
            enabled: server.enabled,
            id: server.id,
            name: server.name,
            readiness: server.readiness
          }))
          .sort((left, right) => left.name.localeCompare(right.name))
      });
    } catch {
      // The request-start reset is the safe failure state. A later refresh may
      // repopulate it, but stale runnable choices are never retained.
    }
  }

  function openLibrary(_mode: "discover" | "yours" = "discover") {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    store().patch({
      editor: null,
      notice: null,
      open: true,
      task: "list"
    });
    void refreshList();
    void refreshMcpOptions();
  }

  function closeLibrary() {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    store().patch({
      editor: null,
      mcpOptions: [],
      mcpOptionsRequestId: snapshot.mcpOptionsRequestId + 1,
      notice: null,
      open: false,
      task: "list"
    });
  }

  function openNewAssistantEditor(prefill?: Partial<AssistantEditorDraftState>) {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    const initialDraft = blankEditorDraft(prefill);
    const controls = modelControlsFor(input.catalog, initialDraft.providerModelId);
    const reconciliation = controls
      ? reconcileDraftForModel(initialDraft, controls)
      : { draft: initialDraft, resetFields: [] };
    const draft = reconciliation.draft;
    const reconciliationNotice = resetNotice(reconciliation.resetFields);
    const editor: AssistantLibraryEditorState = {
      assistantId: null,
      archived: false,
      availability: null,
      baseline: draftBaseline(draft),
      createdAssistantId: null,
      draft,
      error: null,
      fieldErrors: null,
      expectedVersion: null,
      publications: null,
      saving: false
    };
    store().patch({
      editor,
      notice: reconciliationNotice
        ? { kind: "success", text: reconciliationNotice }
        : null,
      open: true,
      task: "editor"
    });
    void refreshList();
    void refreshMcpOptions();
    input.retrySkills();
  }

  /** `Create from current setup` prefills the editor from the manual controls. */
  function openNewAssistantFromCurrentSetup() {
    const controls = useComposerControlStore.getState();
    openNewAssistantEditor({
      backgroundMode: controls.backgroundMode,
      knowledgeSelection: explicitKnowledgeSelection({
        baseIds: controls.selectedKnowledgeBaseIds
      }),
      maxOutputTokens: controls.maxOutputTokens,
      providerModelId: controls.selectedModelId || null,
      reasoningEffort: controls.reasoningEffort,
      reasoningMode: controls.reasoningMode,
      searchOptionIds: [...controls.selectedSearchOptionIds],
      searchPlanMode: controls.searchPlanMode,
      skillIds: controls.selectedSkills.map((skill) => skill.id),
      streamMode: controls.streamMode,
      temperature: controls.temperature
    });
  }

  function editorFromDetail(detail: AssistantDetail): AssistantLibraryEditorState {
    const draft = editorStateFromContent(detail.content);
    return {
      assistantId: detail.id,
      archived: detail.archived,
      availability: detail.availability,
      baseline: draftBaseline(draft),
      createdAssistantId: null,
      draft,
      error: null,
      fieldErrors: null,
      expectedVersion: detail.version ?? null,
      publications: detail.publications ?? null,
      saving: false
    };
  }

  async function openAssistantEditor(assistantId: string) {
    const requestId = beginBusyOperation();
    if (requestId === null) return;
    input.retrySkills();
    const result = await fetchAssistantDetail(assistantId);
    if (!ownsBusyOperation(requestId)) return;
    if (!result.ok || !result.data.owned) {
      finishBusyOperation(requestId, {
        notice: {
          kind: "error",
          text: result.ok ? "Only the owner can edit this assistant." : result.message
        }
      });
      return;
    }
    const editor = editorFromDetail(result.data);
    const controls = modelControlsFor(input.catalog, editor.draft.providerModelId);
    const reconciliation = controls
      ? reconcileDraftForModel(editor.draft, controls)
      : { draft: editor.draft, resetFields: [] };
    const reconciliationNotice = resetNotice(reconciliation.resetFields);
    finishBusyOperation(requestId, {
      editor: { ...editor, draft: reconciliation.draft },
      notice: reconciliationNotice
        ? { kind: "success", text: reconciliationNotice }
        : null,
      task: "editor"
    });
  }

  async function saveEditor() {
    const snapshot = store();
    const editor = snapshot.editor;
    if (!editor || editor.saving || snapshot.busy) return;
    const controls = modelControlsFor(input.catalog, editor.draft.providerModelId);
    const draftResult = assistantDraftFromEditorState(editor.draft, controls);
    const fieldErrors: AssistantEditorFieldErrors = "fieldErrors" in draftResult
      ? { ...draftResult.fieldErrors }
      : {};
    const toolsError = mcpSelectionError(editor.draft, input.catalog, snapshot.mcpOptions);
    if (toolsError) fieldErrors.mcpServerIds = toolsError;
    if (Object.keys(fieldErrors).length > 0 || !("draft" in draftResult)) {
      store().patchEditor({
        error: {
          code: "assistant_editor_invalid",
          text: firstFieldError(fieldErrors)
        },
        fieldErrors
      });
      return;
    }
    const draft = draftResult.draft;
    store().patchEditor({ error: null, fieldErrors: null, saving: true });
    const result = editor.assistantId && editor.expectedVersion !== null
      ? await updateAssistant(editor.assistantId, editor.expectedVersion, draft)
      : await createAssistant(draft);
    const currentEditor = store().editor;
    if (
      !currentEditor?.saving ||
      currentEditor.assistantId !== editor.assistantId ||
      currentEditor.expectedVersion !== editor.expectedVersion
    ) {
      return;
    }
    if (!result.ok) {
      const resultFieldErrors = result.field
        ? { [result.field]: serverFieldErrorText(result.field, result.limit, controls) }
        : null;
      store().patchEditor({
        error: { code: result.code, text: editorErrorText(result.code, result.message) },
        fieldErrors: resultFieldErrors,
        saving: false
      });
      return;
    }
    const detail = result.data;
    store().patch({
      editor: {
        ...editorFromDetail(detail),
        createdAssistantId: editor.createdAssistantId ?? (editor.assistantId ? null : detail.id)
      },
      notice: {
        kind: "success",
        text: editor.assistantId
          ? "Saved. Future runs use these changes."
          : "Assistant created. It stays private until you share it."
      }
    });
    void refreshList();
  }

  function closeEditor() {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    store().patch({ editor: null, task: "list" });
  }

  async function togglePinned(assistantId: string, pinned: boolean) {
    const requestId = beginBusyOperation();
    if (requestId === null) return;
    const result = await setAssistantPinned(assistantId, pinned);
    if (!ownsBusyOperation(requestId)) return;
    if (!result.ok) {
      finishBusyOperation(requestId, {
        notice: { kind: "error", text: editorErrorText(result.code, result.message) }
      });
      return;
    }
    const data = store().data;
    finishBusyOperation(requestId, data
      ? {
          data: {
            ...data,
            assistants: data.assistants.map((assistant) =>
              assistant.id === assistantId ? { ...assistant, pinned } : assistant
            )
          }
        }
      : {});
  }

  async function duplicateById(assistantId: string) {
    const requestId = beginBusyOperation();
    if (requestId === null) return;
    const result = await duplicateAssistant(assistantId);
    if (!ownsBusyOperation(requestId)) return;
    if (!result.ok) {
      finishBusyOperation(requestId, { notice: { kind: "error", text: result.message } });
      return;
    }
    finishBusyOperation(requestId, {
      notice: { kind: "success", text: `Duplicated as ${result.data.content.name}. The copy is private.` }
    });
    void refreshList();
  }

  async function toggleArchived(assistantId: string, archived: boolean) {
    const requestId = beginBusyOperation();
    if (requestId === null) return;
    const detail = await fetchAssistantDetail(assistantId);
    if (!ownsBusyOperation(requestId)) return;
    if (!detail.ok || detail.data.version === undefined) {
      finishBusyOperation(requestId, {
        notice: {
          kind: "error",
          text: detail.ok ? "Only the owner can archive this assistant." : detail.message
        }
      });
      return;
    }
    const result = await setAssistantArchived(assistantId, detail.data.version, archived);
    if (!ownsBusyOperation(requestId)) return;
    if (!result.ok) {
      finishBusyOperation(requestId, {
        notice: { kind: "error", text: editorErrorText(result.code, result.message) }
      });
      return;
    }
    finishBusyOperation(requestId, {
      notice: {
        kind: "success",
        text: archived
          ? "Archived. Publications and past runs are unchanged; restore it any time."
          : "Restored from archive."
      }
    });
    void refreshList();
  }

  async function publish(assistantId: string, request: { groupId?: string; scope: "group" | "installation" }) {
    const requestId = beginBusyOperation();
    if (requestId === null) return;
    const result = await publishAssistant(assistantId, request);
    if (!ownsBusyOperation(requestId)) return;
    if (!result.ok) {
      finishBusyOperation(requestId, { notice: { kind: "error", text: result.message } });
      return;
    }
    const shouldReconcileEditor = store().editor?.assistantId === assistantId;
    const detail = shouldReconcileEditor ? await fetchAssistantDetail(assistantId) : null;
    if (!ownsBusyOperation(requestId)) return;
    const current = store();
    const editor =
      detail?.ok && detail.data.owned && current.editor?.assistantId === assistantId
        ? {
            ...current.editor,
            expectedVersion: detail.data.version ?? null,
            publications: detail.data.publications ?? null
          }
        : current.editor;
    finishBusyOperation(requestId, {
      ...(editor ? { editor } : {}),
      notice: {
        kind: "success",
        text: "Shared. Future runs use the current Assistant."
      }
    });
    void refreshList();
  }

  async function revokePublicationById(assistantId: string, publicationId: string) {
    const requestId = beginBusyOperation();
    if (requestId === null) return;
    const result = await revokeAssistantPublication(assistantId, publicationId);
    if (!ownsBusyOperation(requestId)) return;
    if (!result.ok) {
      finishBusyOperation(requestId, { notice: { kind: "error", text: result.message } });
      return;
    }
    const shouldReconcileEditor = store().editor?.assistantId === assistantId;
    const detail = shouldReconcileEditor ? await fetchAssistantDetail(assistantId) : null;
    if (!ownsBusyOperation(requestId)) return;
    const current = store();
    const editor =
      detail?.ok && detail.data.owned && current.editor?.assistantId === assistantId
        ? {
            ...current.editor,
            expectedVersion: detail.data.version ?? null,
            publications: detail.data.publications ?? null
          }
        : current.editor;
    finishBusyOperation(requestId, {
      ...(editor ? { editor } : {}),
      notice: { kind: "success", text: "Publication revoked. The assistant itself is unchanged." }
    });
    void refreshList();
  }

  /**
   * Applies the currently authorized definition to the composer. Selection is
   * atomic in the composer state owner and never creates a chat; from the
   * Library it also navigates to the blank workspace first.
   */
  async function useAssistant(assistantId: string, options: { navigate: boolean }) {
    const snapshot = store();
    if (
      snapshot.editor &&
      draftBaseline(snapshot.editor.draft) !== snapshot.editor.baseline
    ) {
      return false;
    }
    const requestId = beginBusyOperation();
    if (requestId === null) return false;
    const result = await fetchAssistantDetail(assistantId);
    if (!ownsBusyOperation(requestId)) return false;
    if (!result.ok) {
      const notice = { kind: "error" as const, text: result.message };
      const libraryOpen = store().open;
      finishBusyOperation(requestId, libraryOpen ? { notice } : {});
      if (!libraryOpen) input.setShellNotice(notice);
      return false;
    }
    const detail = result.data;
    if (!detail.availability.ok || detail.archived) {
      const notice = {
        kind: "error",
        text: "This assistant needs access you do not currently have."
      } as const;
      const libraryOpen = store().open;
      finishBusyOperation(requestId, libraryOpen ? { notice } : {});
      if (!libraryOpen) input.setShellNotice(notice);
      return false;
    }
    if (options.navigate) {
      input.activateBlankWorkspace();
    }
    const skillSummaries = new Map(
      input.skills.map((skill) => [skill.id, { id: skill.id, name: skill.name }] as const)
    );
    for (const skill of detail.skills ?? []) skillSummaries.set(skill.id, skill);
    const applied = input.applyAssistantToComposer({
      assistant: {
        avatar: detail.content.avatar,
        description: detail.content.description,
        id: detail.id,
        includedSkills: detail.content.skillIds.map((id) =>
          skillSummaries.get(id) ?? { id, name: "Unavailable Skill" }
        ),
        knowledgeLabel: snapshot.data?.assistants.find((assistant) =>
          assistant.id === assistantId
        )?.fingerprint.knowledgeLabel ?? null,
        knowledgeResourceCount: snapshot.data?.assistants.find((assistant) =>
          assistant.id === assistantId
        )?.fingerprint.knowledgeResourceCount ?? 0,
        name: detail.content.name,
        promptCharacterCount:
          detail.content.systemPrompt.length + (detail.content.developerPrompt?.length ?? 0),
        starterPrompts: detail.content.starterPrompts
      },
      content: detail.content
    });
    if (!applied) {
      const notice = {
        kind: "error",
        text: "This assistant's model is not available to you right now."
      } as const;
      const libraryOpen = store().open;
      finishBusyOperation(requestId, libraryOpen ? { notice } : {});
      if (!libraryOpen) input.setShellNotice(notice);
      return false;
    }
    rememberRecentAssistant(assistantId);
    const currentMcpRequestId = store().mcpOptionsRequestId;
    finishBusyOperation(requestId, {
      editor: null,
      mcpOptions: [],
      mcpOptionsRequestId: currentMcpRequestId + 1,
      notice: null,
      open: false,
      task: "list"
    });
    return true;
  }

  return {
    closeEditor,
    closeLibrary,
    duplicateById,
    openAssistantEditor,
    openLibrary,
    openNewAssistantEditor,
    openNewAssistantFromCurrentSetup,
    publish,
    refreshList,
    revokePublicationById,
    saveEditor,
    toggleArchived,
    togglePinned,
    useAssistant,
  };
}

export type AssistantLibraryActions = ReturnType<typeof createAssistantLibraryActions>;

export function buildAssistantLibraryView(
  input: AssistantLibraryControllerInput,
  actions: AssistantLibraryActions,
  snapshot: ReturnType<typeof useAssistantLibraryStore.getState>
): AssistantLibraryView | null {
  if (!snapshot.open) return null;

  const catalog = input.catalog;
  const providerNames = new Map(
    (catalog?.providers ?? []).map((provider) => [provider.id, provider.name])
  );
  const editorModels = (catalog?.models ?? []).map((model: CatalogModel) => ({
    capabilities: {
      documentInputMode: model.capabilities.documentInputMode,
      imageInput: model.capabilities.imageInput,
      reasoning: model.capabilities.reasoning,
      toolCalling: model.capabilities.toolCalling
    },
    controls: model.parameterControls,
    id: model.modelId,
    label: model.displayName,
    providerFamily: model.providerFamily,
    providerLabel: providerNames.get(model.provider) ?? model.provider,
    supportsTools: model.capabilities.toolCalling
  }));
  const searchOptions = (catalog?.searchStrategies ?? [])
    .filter((strategy) => strategy.kind !== "none")
    .map((strategy) => ({ id: strategy.strategyId, label: strategy.displayName }));

  const editor = snapshot.editor;
  const editorMcpOptions = editor
    ? [
        ...snapshot.mcpOptions,
        ...editor.draft.mcpServerIds
          .filter((serverId) => !snapshot.mcpOptions.some((option) => option.id === serverId))
          .map((serverId) => ({
            enabled: false,
            id: serverId,
            name: "Unavailable MCP server",
            readiness: "unavailable" as const
          }))
      ]
    : snapshot.mcpOptions;
  const editorClean = editor !== null && draftBaseline(editor.draft) === editor.baseline;

  return {
    busy: snapshot.busy,
    catalogError: snapshot.dataState === "error" ? snapshot.dataError : input.catalogError,
    catalogState:
      snapshot.dataState === "error" || input.catalogError
        ? "error"
        : !catalog || snapshot.dataState === "loading"
          ? "loading"
          : "ready",
    editor: editor
      ? {
          availability: editor.availability,
          canPublishInstallation: snapshot.data?.viewer.canPublishInstallation ?? false,
          dirty: !editorClean,
          draft: editor.draft,
          error: editor.error,
          fieldErrors: editor.fieldErrors,
          justCreated:
            editor.createdAssistantId !== null &&
            snapshot.notice?.kind === "success" &&
            snapshot.notice.text.startsWith("Assistant created."),
          mode: editor.assistantId ? "edit" : "create",
          onCancel: actions.closeEditor,
          onChange(update) {
            const current = useAssistantLibraryStore.getState();
            if (!current.editor) return;
            let draft = { ...current.editor.draft, ...update };
            let resetText: string | null = null;
            if (Object.prototype.hasOwnProperty.call(update, "providerModelId")) {
              const reconciliation = reconcileDraftForModel(
                draft,
                modelControlsFor(input.catalog, draft.providerModelId)
              );
              draft = reconciliation.draft;
              resetText = resetNotice(reconciliation.resetFields);
            }
            current.patchEditor({
              draft,
              error: null,
              fieldErrors: null
            });
            if (resetText) {
              current.patch({ notice: { kind: "success", text: resetText } });
            }
          },
          onGenerateAvatar() {
            useAssistantLibraryStore.getState().patchEditor({
              draft: {
                ...useAssistantLibraryStore.getState().editor!.draft,
                avatar: generateAssistantAvatarRecipe()
              }
            });
          },
          onOpenMcpSettings: input.openMcpSettings,
          onPublish(request) {
            const current = useAssistantLibraryStore.getState().editor;
            if (current?.assistantId) {
              void actions.publish(current.assistantId, request);
            }
          },
          onRevokePublication(publicationId) {
            const current = useAssistantLibraryStore.getState().editor;
            if (current?.assistantId) {
              void actions.revokePublicationById(current.assistantId, publicationId);
            }
          },
          onSave() {
            void actions.saveEditor();
          },
          onUseInChat:
            editorClean &&
            !editor.archived &&
            editor.availability?.ok === true &&
            (editor.assistantId ?? editor.createdAssistantId)
            ? () => {
                void actions.useAssistant(
                  (editor.assistantId ?? editor.createdAssistantId)!,
                  { navigate: true }
                );
              }
            : null,
          options: {
            knowledgeBases: input.knowledgeBases,
            knowledgeSources: input.knowledgeSources,
            knowledgeDataError: input.knowledgeDataError,
            knowledgeDataState: input.knowledgeDataState,
            mcpServers: editorMcpOptions,
            models: editorModels,
            onRetryKnowledge: input.retryKnowledge,
            onRetrySkills: input.retrySkills,
            searchOptions,
            skillDataError: input.skillDataError,
            skillDataState: input.skillDataState,
            skills: input.skills
          },
          publications: editor.publications,
          publishableGroups: snapshot.data?.publishableGroups ?? [],
          saving: editor.saving
        }
      : null,
    list: {
      assistants: snapshot.data?.assistants ?? [],
      onArchiveToggle(assistantId, archived) {
        void actions.toggleArchived(assistantId, archived);
      },
      onDuplicate(assistantId) {
        void actions.duplicateById(assistantId);
      },
      onEdit(assistantId) {
        void actions.openAssistantEditor(assistantId);
      },
      onNewAssistant() {
        actions.openNewAssistantEditor();
      },
      onPinToggle(assistantId, pinned) {
        void actions.togglePinned(assistantId, pinned);
      },
      onUse(assistantId) {
        void actions.useAssistant(assistantId, { navigate: true });
      }
    },
    notice: snapshot.notice,
    onBackToChat: actions.closeLibrary,
    onDismissNotice() {
      useAssistantLibraryStore.getState().patch({ notice: null });
    },
    onRetryCatalog() {
      const current = useAssistantLibraryStore.getState();
      if (current.busy || current.editor?.saving) return;
      input.retryCatalog();
      void actions.refreshList();
    },
    task: snapshot.task
  };
}
