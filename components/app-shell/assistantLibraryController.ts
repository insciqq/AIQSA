import {
  createAssistant,
  duplicateAssistant,
  fetchAssistantDetail,
  fetchAssistantList,
  fetchAssistantRevision,
  fetchAssistantRevisions,
  publishAssistant,
  reviseAssistant,
  revokeAssistantPublication,
  setAssistantArchived,
  setAssistantPinned
} from "@/components/assistants/assistantsApi";
import {
  assistantDraftFromEditorState,
  editorStateFromRevision,
  type AssistantEditorDraftState,
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
import type { AssistantDetail } from "@/lib/contracts/assistants";

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
    assistant_archived: "This assistant is archived. Restore it before saving a revision.",
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
    assistant_knowledge_bases_invalid: "The Knowledge selection is invalid.",
    assistant_starter_prompts_invalid: "Starter prompts must be short, non-empty lines.",
    assistant_system_prompt_invalid: "Shorten the system prompt.",
    assistant_tools_not_available: "One selected MCP server is not available to you.",
    assistant_version_conflict:
      "This assistant changed in another session. Reload Assistants and reapply your edit."
  };
  return known[code] ?? message;
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
    backgroundMode: false,
    category: null,
    description: "",
    developerPrompt: "",
    knowledgeBaseIds: [],
    maxOutputTokens: "",
    mcpServerIds: [],
    name: "",
    providerModelId: null,
    reasoningEffort: "",
    reasoningMode: "",
    searchOptionIds: [],
    searchPlanMode: "all_selected",
    starterPrompts: [],
    streamMode: false,
    systemPrompt: "",
    temperature: "",
    ...prefill
  };
}

export type AssistantLibraryControllerInput = {
  activateBlankWorkspace(): void;
  applyAssistantToComposer(input: {
    assistant: {
      avatar: import("@/lib/contracts/assistants").AssistantAvatarRecipe;
      description: string;
      id: string;
      name: string;
      promptCharacterCount: number;
      starterPrompts: string[];
    };
    revision: import("@/lib/contracts/assistants").AssistantRevisionContent;
  }): boolean;
  catalog: Catalog | null;
  catalogError: string | null;
  knowledgeBases: { available: boolean; id: string; name: string }[];
  knowledgeDataError: string | null;
  knowledgeDataState: "error" | "loading" | "ready";
  retryCatalog(): void;
  retryKnowledge(): void;
  setShellNotice(notice: { kind: "error"; text: string }): void;
};

export function createAssistantLibraryActions(input: AssistantLibraryControllerInput) {
  const store = () => useAssistantLibraryStore.getState();

  function beginBusyOperation(): number | null {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving || snapshot.history?.restoring) {
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

  function ownsHistoryRequest(requestId: number, assistantId: string): boolean {
    const snapshot = store();
    return (
      snapshot.historyRequestId === requestId &&
      snapshot.task === "history" &&
      snapshot.history?.assistantId === assistantId
    );
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
    try {
      const servers = await loadUserMcpServers();
      store().patch({
        mcpOptions: servers
          .map((server) => ({ id: server.id, name: server.name }))
          .sort((left, right) => left.name.localeCompare(right.name))
      });
    } catch {
      // The editor simply lists no MCP options until a later successful load.
    }
  }

  function openLibrary(mode: "discover" | "yours" = "discover") {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving || snapshot.history?.restoring) return;
    store().patch({
      editor: null,
      history: null,
      mode,
      notice: null,
      open: true,
      task: "list"
    });
    void refreshList();
    void refreshMcpOptions();
  }

  function closeLibrary() {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving || snapshot.history?.restoring) return;
    store().patch({ editor: null, history: null, notice: null, open: false, task: "list" });
  }

  function openNewAssistantEditor(prefill?: Partial<AssistantEditorDraftState>) {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving || snapshot.history?.restoring) return;
    const draft = blankEditorDraft(prefill);
    const editor: AssistantLibraryEditorState = {
      assistantId: null,
      baseline: draftBaseline(draft),
      createdAssistantId: null,
      draft,
      error: null,
      expectedVersion: null,
      publications: null,
      revisionNumber: null,
      saving: false
    };
    store().patch({ editor, history: null, notice: null, open: true, task: "editor" });
    void refreshList();
    void refreshMcpOptions();
  }

  /** `Create from current setup` prefills the editor from the manual controls. */
  function openNewAssistantFromCurrentSetup() {
    const controls = useComposerControlStore.getState();
    openNewAssistantEditor({
      backgroundMode: controls.backgroundMode,
      knowledgeBaseIds: [...controls.selectedKnowledgeBaseIds],
      maxOutputTokens: controls.maxOutputTokens,
      providerModelId: controls.selectedModelId || null,
      reasoningEffort: controls.reasoningEffort,
      reasoningMode: controls.reasoningMode,
      searchOptionIds: [...controls.selectedSearchOptionIds],
      searchPlanMode: controls.searchPlanMode,
      streamMode: controls.streamMode,
      temperature: controls.temperature
    });
  }

  function editorFromDetail(detail: AssistantDetail): AssistantLibraryEditorState {
    const fallback = {
      backgroundMode: false,
      maxOutputTokens: "",
      reasoningEffort: "",
      reasoningMode: "",
      streamMode: false,
      temperature: ""
    };
    const draft = editorStateFromRevision(detail.revision, fallback);
    return {
      assistantId: detail.id,
      baseline: draftBaseline(draft),
      createdAssistantId: null,
      draft,
      error: null,
      expectedVersion: detail.version ?? null,
      publications: detail.publications ?? null,
      revisionNumber: detail.revision.revisionNumber,
      saving: false
    };
  }

  async function openAssistantEditor(assistantId: string) {
    const requestId = beginBusyOperation();
    if (requestId === null) return;
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
    finishBusyOperation(requestId, {
      editor: editorFromDetail(result.data),
      history: null,
      notice: null,
      task: "editor"
    });
  }

  async function saveEditor() {
    const snapshot = store();
    const editor = snapshot.editor;
    if (!editor || editor.saving || snapshot.busy) return;
    const controls = modelControlsFor(input.catalog, editor.draft.providerModelId);
    const draft = assistantDraftFromEditorState(editor.draft, controls);
    if (!draft) {
      store().patchEditor({
        error: { code: "assistant_model_invalid", text: "Choose a model from your catalog." }
      });
      return;
    }
    store().patchEditor({ error: null, saving: true });
    const result = editor.assistantId && editor.expectedVersion !== null
      ? await reviseAssistant(editor.assistantId, editor.expectedVersion, draft)
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
      store().patchEditor({
        error: { code: result.code, text: editorErrorText(result.code, result.message) },
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
          ? `Saved revision ${detail.revision.revisionNumber}. Existing runs keep the setup they used.`
          : "Assistant created. It stays private until you share it."
      }
    });
    void refreshList();
  }

  function closeEditor() {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving || snapshot.history?.restoring) return;
    store().patch({ editor: null, task: "list" });
  }

  async function openHistory(
    assistantId: string,
    options: { assistantName?: string; preserveNotice?: boolean } = {}
  ) {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving || snapshot.history?.restoring) return;
    const requestId = snapshot.historyRequestId + 1;
    const name = options.assistantName ??
      snapshot.data?.assistants.find((assistant) => assistant.id === assistantId)?.name ??
      "Assistant";
    snapshot.patch({
      history: {
        assistantId,
        assistantName: name,
        entries: [],
        loading: true,
        restoring: false,
        viewedRevision: null
      },
      historyRequestId: requestId,
      ...(options.preserveNotice ? {} : { notice: null }),
      open: true,
      task: "history"
    });
    const result = await fetchAssistantRevisions(assistantId);
    if (!ownsHistoryRequest(requestId, assistantId)) return;
    if (!result.ok) {
      store().patch({ history: null, notice: { kind: "error", text: result.message }, task: "list" });
      return;
    }
    store().patchHistory({ entries: result.data, loading: false });
  }

  async function viewHistoryRevision(revisionNumber: number) {
    const snapshot = store();
    const history = snapshot.history;
    if (!history || history.loading || history.restoring || snapshot.busy) return;
    const requestId = snapshot.historyRequestId + 1;
    snapshot.patch({ historyRequestId: requestId });
    const result = await fetchAssistantRevision(history.assistantId, revisionNumber);
    if (!ownsHistoryRequest(requestId, history.assistantId)) return;
    if (!result.ok) {
      store().patch({ notice: { kind: "error", text: result.message } });
      return;
    }
    store().patchHistory({ viewedRevision: result.data });
  }

  /** Restore never rewrites history: it saves the old content as a new revision. */
  async function restoreHistoryRevision(revisionNumber: number) {
    const snapshot = store();
    const history = snapshot.history;
    if (!history || history.loading || history.restoring || snapshot.busy) return;
    const requestId = snapshot.historyRequestId + 1;
    snapshot.patch({ historyRequestId: requestId });
    store().patchHistory({ restoring: true });
    const [revisionResult, detailResult] = await Promise.all([
      fetchAssistantRevision(history.assistantId, revisionNumber),
      fetchAssistantDetail(history.assistantId)
    ]);
    if (!ownsHistoryRequest(requestId, history.assistantId)) return;
    if (!revisionResult.ok || !detailResult.ok || detailResult.data.version === undefined) {
      store().patchHistory({ restoring: false });
      store().patch({
        notice: {
          kind: "error",
          text: revisionResult.ok
            ? detailResult.ok
              ? "Only the owner can restore a revision."
              : detailResult.message
            : revisionResult.message
        }
      });
      return;
    }
    const fallback = {
      backgroundMode: false,
      maxOutputTokens: "",
      reasoningEffort: "",
      reasoningMode: "",
      streamMode: false,
      temperature: ""
    };
    const draftState = editorStateFromRevision(revisionResult.data, fallback);
    const controls = modelControlsFor(input.catalog, draftState.providerModelId);
    const draft = assistantDraftFromEditorState(draftState, controls);
    if (!draft) {
      store().patchHistory({ restoring: false });
      store().patch({
        notice: { kind: "error", text: "This revision's model is no longer in your catalog." }
      });
      return;
    }
    const result = await reviseAssistant(history.assistantId, detailResult.data.version, draft);
    if (!ownsHistoryRequest(requestId, history.assistantId)) return;
    if (!result.ok) {
      store().patchHistory({ restoring: false });
      store().patch({
        notice: { kind: "error", text: editorErrorText(result.code, result.message) }
      });
      return;
    }
    store().patchHistory({ restoring: false });
    store().patch({
      notice: {
        kind: "success",
        text: `Restored as revision ${result.data.revision.revisionNumber}.`
      }
    });
    void refreshList();
    void openHistory(history.assistantId, {
      assistantName: result.data.revision.name,
      preserveNotice: true
    });
  }

  async function togglePinned(assistantId: string, pinned: boolean) {
    const requestId = beginBusyOperation();
    if (requestId === null) return;
    const result = await setAssistantPinned(assistantId, pinned);
    if (!ownsBusyOperation(requestId)) return;
    if (!result.ok) {
      finishBusyOperation(requestId, { notice: { kind: "error", text: result.message } });
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
      mode: "yours",
      notice: { kind: "success", text: `Duplicated as ${result.data.revision.name}. The copy is private.` }
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
        text: "Published this exact revision. Later saves stay private until you publish an update."
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
   * Applies the currently authorized revision to the composer. Selection is
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
      finishBusyOperation(requestId);
      input.setShellNotice({ kind: "error", text: result.message });
      return false;
    }
    const detail = result.data;
    if (!detail.availability.ok || detail.archived) {
      finishBusyOperation(requestId);
      input.setShellNotice({
        kind: "error",
        text: "This assistant needs access you do not currently have."
      });
      return false;
    }
    if (options.navigate) {
      input.activateBlankWorkspace();
    }
    const applied = input.applyAssistantToComposer({
      assistant: {
        avatar: detail.revision.avatar,
        description: detail.revision.description,
        id: detail.id,
        name: detail.revision.name,
        promptCharacterCount:
          detail.revision.systemPrompt.length + (detail.revision.developerPrompt?.length ?? 0),
        starterPrompts: detail.revision.starterPrompts
      },
      revision: detail.revision
    });
    if (!applied) {
      finishBusyOperation(requestId);
      input.setShellNotice({
        kind: "error",
        text: "This assistant's model is not available to you right now."
      });
      return false;
    }
    rememberRecentAssistant(assistantId);
    finishBusyOperation(requestId, {
      editor: null,
      history: null,
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
    openHistory,
    openLibrary,
    openNewAssistantEditor,
    openNewAssistantFromCurrentSetup,
    publish,
    refreshList,
    restoreHistoryRevision,
    revokePublicationById,
    saveEditor,
    toggleArchived,
    togglePinned,
    useAssistant,
    viewHistoryRevision
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
    controls: model.parameterControls,
    id: model.modelId,
    label: model.displayName,
    providerLabel: providerNames.get(model.provider) ?? model.provider,
    supportsTools: model.capabilities.toolCalling
  }));
  const searchOptions = (catalog?.searchStrategies ?? [])
    .filter((strategy) => strategy.kind !== "none")
    .map((strategy) => ({ id: strategy.strategyId, label: strategy.displayName }));

  const editor = snapshot.editor;
  const history = snapshot.history;

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
          canPublishInstallation: snapshot.data?.viewer.canPublishInstallation ?? false,
          dirty: draftBaseline(editor.draft) !== editor.baseline,
          draft: editor.draft,
          error: editor.error,
          mode: editor.assistantId ? "edit" : "create",
          onCancel: actions.closeEditor,
          onChange(update) {
            useAssistantLibraryStore.getState().patchEditor({
              draft: { ...useAssistantLibraryStore.getState().editor!.draft, ...update }
            });
          },
          onGenerateAvatar() {
            useAssistantLibraryStore.getState().patchEditor({
              draft: {
                ...useAssistantLibraryStore.getState().editor!.draft,
                avatar: generateAssistantAvatarRecipe()
              }
            });
          },
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
          onUseInChat: editor.createdAssistantId
            ? () => {
                void actions.useAssistant(editor.createdAssistantId!, { navigate: true });
              }
            : null,
          options: {
            knowledgeBases: input.knowledgeBases,
            knowledgeDataError: input.knowledgeDataError,
            knowledgeDataState: input.knowledgeDataState,
            mcpServers: snapshot.mcpOptions,
            models: editorModels,
            onRetryKnowledge: input.retryKnowledge,
            searchOptions
          },
          publications: editor.publications,
          publishableGroups: snapshot.data?.publishableGroups ?? [],
          revisionNumber: editor.revisionNumber,
          saving: editor.saving
        }
      : null,
    history: history
      ? {
          assistantName: history.assistantName,
          entries: history.entries,
          loading: history.loading,
          onBack() {
            const current = useAssistantLibraryStore.getState();
            if (
              current.busy ||
              current.history?.restoring ||
              current.task !== "history" ||
              current.history?.assistantId !== history.assistantId
            ) {
              return;
            }
            current.patch({ history: null, task: "list" });
          },
          onRestore(revisionNumber) {
            void actions.restoreHistoryRevision(revisionNumber);
          },
          onView(revisionNumber) {
            void actions.viewHistoryRevision(revisionNumber);
          },
          restoring: history.restoring,
          viewedRevision: history.viewedRevision
        }
      : null,
    list: {
      assistants: snapshot.data?.assistants ?? [],
      category: snapshot.category,
      filter: snapshot.filter,
      mode: snapshot.mode,
      onArchiveToggle(assistantId, archived) {
        void actions.toggleArchived(assistantId, archived);
      },
      onCategoryChange(category) {
        const current = useAssistantLibraryStore.getState();
        if (current.busy || current.editor?.saving || current.history?.restoring) return;
        current.patch({ category });
      },
      onDuplicate(assistantId) {
        void actions.duplicateById(assistantId);
      },
      onEdit(assistantId) {
        void actions.openAssistantEditor(assistantId);
      },
      onFilterChange(filter) {
        const current = useAssistantLibraryStore.getState();
        if (current.busy || current.editor?.saving || current.history?.restoring) return;
        current.patch({ filter });
      },
      onModeChange(mode) {
        const current = useAssistantLibraryStore.getState();
        if (current.busy || current.editor?.saving || current.history?.restoring) return;
        current.patch({ filter: "all", mode });
      },
      onNewAssistant() {
        actions.openNewAssistantEditor();
      },
      onOpenHistory(assistantId) {
        void actions.openHistory(assistantId);
      },
      onPinToggle(assistantId, pinned) {
        void actions.togglePinned(assistantId, pinned);
      },
      onQueryChange(query) {
        const current = useAssistantLibraryStore.getState();
        if (current.busy || current.editor?.saving || current.history?.restoring) return;
        current.patch({ query });
      },
      onUse(assistantId) {
        void actions.useAssistant(assistantId, { navigate: true });
      },
      query: snapshot.query
    },
    notice: snapshot.notice,
    onBackToChat: actions.closeLibrary,
    onDismissNotice() {
      useAssistantLibraryStore.getState().patch({ notice: null });
    },
    onRetryCatalog() {
      const current = useAssistantLibraryStore.getState();
      if (current.busy || current.editor?.saving || current.history?.restoring) return;
      input.retryCatalog();
      void actions.refreshList();
    },
    task: snapshot.task
  };
}
