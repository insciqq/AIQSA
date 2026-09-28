import {
  createAssistant,
  fetchAssistantDetail,
  updateAssistant,
  type AssistantApiResult
} from "@/components/assistants/assistantsApi";
import {
  assistantDraftFromEditor,
  assistantNameErrorText,
  defaultAssistantDraftRows,
  draftModelId,
  draftRowsFromChatSetup,
  editorDraftFromContent,
  reconcileControlsForModel,
  type AssistantChatSetup,
  type AssistantDraftRow,
  type AssistantEditorDraft,
  type AssistantEditorDraftUpdate,
  type AssistantEditorErrors,
  type AssistantEditorPrefill,
  type AssistantEditorView,
  type AssistantNewAssistantView,
  type AssistantTemplatePrefill
} from "@/components/assistants/libraryViewContracts";
import { generateAssistantAvatarRecipe } from "@/components/assistants/avatarGeneration";
import {
  useAssistantLibraryStore,
  type AssistantLibraryEditorState,
  type AssistantLibrarySnapshot
} from "@/components/app-shell/assistantLibraryStore";
import {
  assistantErrorText,
  draftBaseline,
  editorDirty,
  modelControlsFor,
  runControlLabels,
  type AssistantLibraryControllerInput,
  type AssistantLibraryCore
} from "@/components/app-shell/assistantLibraryCore";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useMcpSettingsStore } from "@/components/app-shell/mcpSettingsStore";
import type { CatalogModel } from "@/components/app-shell/types";
import {
  assistantSkillDelivery,
  type AssistantDetail,
  type AssistantRowKey,
  type AssistantRunControlField,
  type AssistantSkillLink
} from "@/lib/contracts/assistants";

const store = () => useAssistantLibraryStore.getState();

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

function firstError(errors: AssistantEditorErrors): string {
  return [...Object.values(errors.fields), ...Object.values(errors.rows)]
    .find((message): message is string => Boolean(message)) ?? "Review the highlighted fields.";
}

/**
 * Server errors attach to the field and row they name; a rejected name reads
 * as the client check would read the saved draft's name.
 */
function serverErrors(
  result: Extract<AssistantApiResult<unknown>, { ok: false }>,
  controls: ReturnType<typeof modelControlsFor>,
  name: string
): AssistantEditorErrors | null {
  if (result.field) {
    const text = serverFieldErrorText(result.field, result.limit, controls);
    return { fields: { [result.field]: text }, rows: { controls: text } };
  }
  if (result.row) {
    return { fields: {}, rows: { [result.row]: assistantErrorText(result.code, result.message) } };
  }
  if (result.code === "assistant_name_invalid") {
    return { fields: { name: assistantNameErrorText(name) }, rows: {} };
  }
  return null;
}

/** The composer's current setup in the vocabulary of "From current chat". */
export function currentChatSetup(): AssistantChatSetup {
  const controls = useComposerControlStore.getState();
  const assistant = controls.assistant?.state === "bound" ? controls.assistant : null;
  const selection = controls.knowledgeSelection;
  const mcp = controls.mcpSelection;
  const mcpSettings = useMcpSettingsStore.getState();
  const links: AssistantSkillLink[] = (assistant?.includedSkills ?? []).map((skill) => ({
    delivery: assistantSkillDelivery(skill.mode),
    skillId: skill.id
  }));
  for (const skill of controls.selectedSkills) {
    if (!links.some((link) => link.skillId === skill.id)) links.push({ delivery: "always", skillId: skill.id });
  }
  return {
    backgroundMode: controls.backgroundMode,
    knowledge: selection.mode === "explicit" ||
      (selection.mode === "inherited" && selection.baseIds.length + selection.sourceIds.length > 0)
      ? { baseIds: selection.baseIds, mode: "explicit", sourceIds: selection.sourceIds }
      : selection.mode === "none" ? { mode: "none" }
        : selection.mode === "all_my_knowledge" ? { mode: "all" } : { mode: "inherit" },
    maxOutputTokens: controls.maxOutputTokens,
    mcp: mcp.mode === "exact"
      ? { mode: "exact", serverIds: mcp.serverIds }
      : mcp.mode === "load_all"
        ? {
            enabledServerIds: mcpSettings.loadState === "ready"
              ? mcpSettings.servers.filter((server) => server.enabled).map((server) => server.id)
              : null,
            mode: "load_all"
          }
        : { mode: mcp.mode },
    modelId: controls.selectedModelId || null,
    reasoningEffort: controls.reasoningEffort,
    reasoningMode: controls.reasoningMode,
    search: { mode: controls.searchPlanMode, optionIds: controls.selectedSearchOptionIds },
    skills: { links, mode: controls.skillsMode },
    streamMode: controls.streamMode,
    temperature: controls.temperature
  };
}

function currentChatSkillNames(): { id: string; name: string }[] {
  const controls = useComposerControlStore.getState();
  const assistant = controls.assistant?.state === "bound" ? controls.assistant : null;
  return [...(assistant?.includedSkills ?? []), ...controls.selectedSkills]
    .map((skill) => ({ id: skill.id, name: skill.name }));
}

export function createAssistantEditorActions(
  input: AssistantLibraryControllerInput,
  core: AssistantLibraryCore
) {
  function skillNames(
    ids: readonly string[],
    known: readonly { available?: boolean; id: string; name: string }[]
  ): AssistantLibraryEditorState["selectedSkills"] {
    return ids.map((id) => {
      const selected = known.find((skill) => skill.id === id);
      if (selected) return selected;
      const skill = input.skills.find((entry) => entry.id === id);
      return skill ? { available: !skill.archived, id, name: skill.name } : { id, name: "Selected Skill" };
    });
  }

  /** Drops parameters the draft's model cannot run, visibly. Unknown models keep their values. */
  function reconciledDraft(draft: AssistantEditorDraft): { draft: AssistantEditorDraft; notice: string | null } {
    const controls = modelControlsFor(input.catalog, draftModelId(draft.rows));
    if (!controls) return { draft, notice: null };
    const reconciliation = reconcileControlsForModel(draft.rows.controls.value, controls);
    return {
      draft: {
        ...draft,
        rows: { ...draft.rows, controls: { ...draft.rows.controls, value: reconciliation.controls } }
      },
      notice: resetNotice(reconciliation.resetFields)
    };
  }

  function openNewAssistantSheet() {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    store().patch({ newAssistantOpen: true });
  }

  function closeNewAssistantSheet() {
    store().patch({ newAssistantOpen: false });
  }

  function openNewAssistantEditor(
    prefill: AssistantEditorPrefill = {},
    options: { expandedRow?: AssistantRowKey; knownSkills?: { id: string; name: string }[] } = {}
  ) {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    const { rows: prefillRows, ...fields } = prefill;
    const { draft, notice } = reconciledDraft({
      answerRules: null,
      avatar: generateAssistantAvatarRecipe(),
      category: null,
      description: "",
      name: "",
      responseReminder: "",
      starterPrompts: [],
      systemPrompt: "",
      ...fields,
      rows: { ...defaultAssistantDraftRows(), ...prefillRows }
    });
    const editor: AssistantLibraryEditorState = {
      assistantId: null,
      archived: false,
      availability: null,
      baseline: draftBaseline(draft),
      conflict: null,
      createdAssistantId: null,
      draft,
      error: null,
      errors: null,
      expectedVersion: null,
      initialExpandedRow: options.expandedRow ?? null,
      rowAvailability: {},
      selectedSkills: skillNames(
        draft.rows.skills.value.links.map((link) => link.skillId),
        options.knownSkills ?? []
      ),
      savedName: null,
      saving: false
    };
    store().patch({
      editor,
      newAssistantOpen: false,
      notice: notice ? { kind: "success", text: notice } : null,
      open: true,
      task: "editor"
    });
    void core.refreshList();
    void core.refreshMcpOptions();
  }

  /** A template prefills identity, instructions and starters; choosing saves nothing. */
  function openNewAssistantFromTemplate(
    prefill: AssistantTemplatePrefill,
    options: { expandedRow?: AssistantRowKey } = {}
  ) {
    const { answerRules, category, description, name, responseReminder, starterPrompts, systemPrompt } = prefill;
    openNewAssistantEditor({
      ...(answerRules !== undefined ? { answerRules } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(responseReminder !== undefined ? { responseReminder } : {}),
      ...(starterPrompts !== undefined ? { starterPrompts: [...starterPrompts] } : {}),
      ...(systemPrompt !== undefined ? { systemPrompt } : {})
    }, options);
  }

  /** "From current chat": the chat's setup as adjustable rows. */
  function openNewAssistantFromCurrentSetup() {
    openNewAssistantEditor(
      { rows: draftRowsFromChatSetup(currentChatSetup()) },
      { knownSkills: currentChatSkillNames() }
    );
  }

  function editorFromDetail(detail: AssistantDetail): AssistantLibraryEditorState {
    const draft = editorDraftFromContent(detail.content);
    return {
      assistantId: detail.id,
      archived: detail.archived,
      availability: detail.availability,
      baseline: draftBaseline(draft),
      conflict: null,
      createdAssistantId: null,
      draft,
      error: null,
      errors: null,
      expectedVersion: detail.version ?? null,
      initialExpandedRow: null,
      rowAvailability: detail.rowAvailability,
      selectedSkills: draft.rows.skills.value.links.map(({ skillId }) =>
        detail.skills?.find((skill) => skill.id === skillId) ??
          { available: false, id: skillId, name: "Unavailable Skill" }
      ),
      savedName: detail.content.name,
      saving: false
    };
  }

  async function openAssistantEditor(assistantId: string) {
    const requestId = core.beginBusyOperation();
    if (requestId === null) return;
    const result = await fetchAssistantDetail(assistantId);
    if (!core.ownsBusyOperation(requestId)) return;
    if (!result.ok || !result.data.owned) {
      core.finishBusyOperation(requestId, {
        notice: {
          kind: "error",
          text: result.ok ? "Only the owner can edit this assistant." : result.message
        }
      });
      return;
    }
    const editor = editorFromDetail(result.data);
    const { draft, notice } = reconciledDraft(editor.draft);
    core.finishBusyOperation(requestId, {
      detail: null,
      editor: { ...editor, draft },
      newAssistantOpen: false,
      notice: notice ? { kind: "success", text: notice } : null,
      task: "editor"
    });
  }

  function changeDraft(update: AssistantEditorDraftUpdate) {
    const editor = store().editor;
    if (!editor || editor.saving) return;
    store().patchEditor({ draft: { ...editor.draft, ...update, rows: editor.draft.rows }, error: null, errors: null });
  }

  function changeRow<Key extends AssistantRowKey>(key: Key, update: Partial<AssistantDraftRow<Key>>) {
    const editor = store().editor;
    if (!editor || editor.saving) return;
    let draft: AssistantEditorDraft = {
      ...editor.draft,
      rows: { ...editor.draft.rows, [key]: { ...editor.draft.rows[key], ...update } }
    };
    let resetText: string | null = null;
    if (key === "model" && update.value) {
      const reconciliation = reconcileControlsForModel(
        draft.rows.controls.value,
        modelControlsFor(input.catalog, draftModelId(draft.rows))
      );
      draft = {
        ...draft,
        rows: { ...draft.rows, controls: { ...draft.rows.controls, value: reconciliation.controls } }
      };
      resetText = resetNotice(reconciliation.resetFields);
    }
    store().patchEditor({
      draft,
      error: null,
      errors: null,
      ...(key === "skills"
        ? {
            selectedSkills: skillNames(
              draft.rows.skills.value.links.map((link) => link.skillId),
              editor.selectedSkills
            )
          }
        : {})
    });
    if (resetText) store().patch({ notice: { kind: "success", text: resetText } });
  }

  function generateAvatar() {
    const editor = store().editor;
    if (!editor || editor.saving) return;
    store().patchEditor({ draft: { ...editor.draft, avatar: generateAssistantAvatarRecipe() } });
  }

  function sameEditor(editor: AssistantLibraryEditorState) {
    const current = store().editor;
    return current !== null &&
      current.assistantId === editor.assistantId &&
      current.expectedVersion === editor.expectedVersion;
  }

  async function loadLatestVersion(assistantId: string) {
    const result = await fetchAssistantDetail(assistantId);
    const editor = store().editor;
    if (editor?.assistantId !== assistantId || !editor.conflict?.loading) return;
    store().patchEditor({
      conflict: {
        latest: result.ok && result.data.version !== undefined
          ? { draft: editorDraftFromContent(result.data.content), version: result.data.version }
          : null,
        loading: false
      }
    });
  }

  /** Resolves to the saved Assistant id, or null when nothing was saved. */
  async function saveEditor(): Promise<string | null> {
    const snapshot = store();
    const editor = snapshot.editor;
    if (!editor || editor.saving || snapshot.busy) return null;
    const modelId = draftModelId(editor.draft.rows);
    const model = modelId ? input.catalog?.models.find((entry: CatalogModel) => entry.modelId === modelId) : undefined;
    const controls = model?.parameterControls ?? null;
    const draftResult = assistantDraftFromEditor(editor.draft, {
      mcpServers: snapshot.mcpOptions,
      model: model ? { controls: model.parameterControls, toolCalling: model.capabilities.toolCalling } : null
    });
    if ("errors" in draftResult) {
      store().patchEditor({
        error: { code: "assistant_editor_invalid", text: firstError(draftResult.errors) },
        errors: draftResult.errors
      });
      return null;
    }
    store().patchEditor({ error: null, errors: null, saving: true });
    const result = editor.assistantId && editor.expectedVersion !== null
      ? await updateAssistant(editor.assistantId, editor.expectedVersion, draftResult.draft)
      : await createAssistant(draftResult.draft);
    if (!store().editor?.saving || !sameEditor(editor)) return null;
    if (!result.ok) {
      const conflict = result.code === "assistant_version_conflict" && editor.assistantId !== null;
      store().patchEditor({
        conflict: conflict ? { latest: null, loading: true } : store().editor?.conflict ?? null,
        error: { code: result.code, text: assistantErrorText(result.code, result.message) },
        errors: serverErrors(result, controls, editor.draft.name),
        saving: false
      });
      // The draft stays; the latest saved version is read beside it.
      if (conflict) void loadLatestVersion(editor.assistantId!);
      return null;
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
    void core.refreshList();
    return detail.id;
  }

  /**
   * "Save & try": saves when there is anything to save, then opens a
   * Temporary chat with the Assistant chosen. The header selector's "Edit
   * Assistant" returns to this editor.
   */
  async function saveAndTry(): Promise<boolean> {
    const snapshot = store();
    const editor = snapshot.editor;
    if (!editor || editor.saving || snapshot.busy) return false;
    const assistantId = editor.assistantId && !editorDirty(snapshot) && !editor.conflict
      ? editor.assistantId
      : await saveEditor();
    return assistantId ? core.useAssistant(assistantId, { navigate: true, temporary: true }) : false;
  }

  function reloadLatest() {
    const editor = store().editor;
    if (!editor?.assistantId || !editor.conflict || editor.conflict.loading) return;
    store().patchEditor({ conflict: { latest: editor.conflict.latest, loading: true } });
    void loadLatestVersion(editor.assistantId);
  }

  function replaceDraftWithLatest() {
    const editor = store().editor;
    const latest = editor?.conflict?.latest;
    if (!editor || editor.saving || !latest) return;
    store().patchEditor({
      baseline: draftBaseline(latest.draft),
      conflict: null,
      draft: latest.draft,
      error: null,
      errors: null,
      expectedVersion: latest.version,
      savedName: latest.draft.name
    });
  }

  /** The next save replaces the latest version with this draft. */
  function keepDraftOverLatest() {
    const editor = store().editor;
    const latest = editor?.conflict?.latest;
    if (!editor || editor.saving || !latest) return;
    store().patchEditor({
      conflict: null,
      error: null,
      errors: null,
      expectedVersion: latest.version,
      savedName: latest.draft.name
    });
  }

  function closeEditor() {
    const snapshot = store();
    if (snapshot.busy || snapshot.editor?.saving) return;
    store().patch({ editor: null, task: "list" });
  }

  return {
    changeDraft,
    changeRow,
    closeEditor,
    closeNewAssistantSheet,
    generateAvatar,
    keepDraftOverLatest,
    openAssistantEditor,
    openNewAssistantEditor,
    openNewAssistantFromCurrentSetup,
    openNewAssistantFromTemplate,
    openNewAssistantSheet,
    reloadLatest,
    replaceDraftWithLatest,
    saveAndTry,
    saveEditor
  };
}

export type AssistantEditorActions = ReturnType<typeof createAssistantEditorActions>;

export function buildAssistantNewAssistantView(
  actions: AssistantEditorActions,
  snapshot: AssistantLibrarySnapshot
): AssistantNewAssistantView {
  return {
    onBlank() {
      actions.openNewAssistantEditor();
    },
    onClose: actions.closeNewAssistantSheet,
    onFromCurrentChat: actions.openNewAssistantFromCurrentSetup,
    onOpen: actions.openNewAssistantSheet,
    onTemplate: actions.openNewAssistantFromTemplate,
    open: snapshot.newAssistantOpen
  };
}

export function buildAssistantEditorView(
  input: AssistantLibraryControllerInput,
  actions: AssistantEditorActions,
  handlers: { onOpenSharing(assistantId: string): void; onUseInChat(assistantId: string): void },
  snapshot: AssistantLibrarySnapshot
): AssistantEditorView | null {
  const editor = snapshot.editor;
  if (!editor) return null;
  const catalog = input.catalog;
  const providerNames = new Map(
    (catalog?.providers ?? []).map((provider) => [provider.id, provider.name])
  );
  const tools = editor.draft.rows.tools.value;
  const selectedServerIds = tools.mode === "exact" ? tools.serverIds : [];
  const clean = !editorDirty(snapshot);
  const savedId = editor.assistantId ?? editor.createdAssistantId;
  const listed = editor.assistantId
    ? snapshot.data?.assistants.find((assistant) => assistant.id === editor.assistantId) ?? null
    : null;
  return {
    assistantId: editor.assistantId,
    archived: editor.archived,
    audience: listed?.audience ?? null,
    availability: editor.availability,
    conflict: editor.conflict,
    dirty: !clean,
    draft: editor.draft,
    error: editor.error,
    errors: editor.errors,
    initialExpandedRow: editor.initialExpandedRow,
    justCreated:
      editor.createdAssistantId !== null &&
      snapshot.notice?.kind === "success" &&
      snapshot.notice.text.startsWith("Assistant created."),
    mode: editor.assistantId ? "edit" : "create",
    onCancel: actions.closeEditor,
    onChange: actions.changeDraft,
    onGenerateAvatar: actions.generateAvatar,
    onKeepDraftOverLatest: actions.keepDraftOverLatest,
    onOpenMcpSettings: input.openMcpSettings,
    onOpenSharing: editor.assistantId
      ? () => handlers.onOpenSharing(editor.assistantId!)
      : null,
    onReloadLatest: actions.reloadLatest,
    onReplaceDraftWithLatest: actions.replaceDraftWithLatest,
    onRowChange: actions.changeRow,
    onSave: actions.saveEditor,
    onSaveAndTry: actions.saveAndTry,
    onUseInChat: clean && !editor.archived && editor.availability?.ok === true && savedId
      ? () => handlers.onUseInChat(savedId)
      : null,
    options: {
      knowledgeBases: input.knowledgeBases,
      knowledgeSources: input.knowledgeSources,
      knowledgeDataError: input.knowledgeDataError,
      knowledgeDataState: input.knowledgeDataState,
      mcpServers: [
        ...snapshot.mcpOptions,
        ...selectedServerIds
          .filter((serverId) => !snapshot.mcpOptions.some((option) => option.id === serverId))
          .map((serverId) => ({
            enabled: false,
            id: serverId,
            name: "Unavailable MCP server",
            readiness: "unavailable" as const
          }))
      ],
      models: (catalog?.models ?? []).map((model: CatalogModel) => ({
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
      })),
      onRetryKnowledge: input.retryKnowledge,
      searchOptions: (catalog?.searchStrategies ?? [])
        .filter((strategy) => strategy.kind !== "none")
        .map((strategy) => ({ id: strategy.strategyId, label: strategy.displayName })),
      selectedSkills: editor.selectedSkills
    },
    rowAvailability: editor.rowAvailability,
    savedName: editor.savedName,
    saving: editor.saving,
    scope: listed?.scope ?? null
  };
}
