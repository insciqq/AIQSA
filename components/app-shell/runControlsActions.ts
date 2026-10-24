import { isAnswerSoundId, type AnswerSoundId } from "@/lib/contracts/answerSound";
import {
  clampedNumber,
  coerceReasoningEffort,
  coerceReasoningMode,
  defaultParameterControls
} from "@/components/app-shell/controlDefaults";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import { cloneRecord, recordValue } from "@/components/app-shell/shellValues";
import {
  applySettingsDefaultsReconciliation,
  createSettingsMutationCoordinator,
  type SettingsMutationCoordinator,
  type SettingsDefaultsPatch,
  type SettingsNoticeScope
} from "@/components/app-shell/settingsMutationCoordinator";
import type { Catalog, CatalogModel, Notice } from "@/components/app-shell/types";
import {
  modelControlKey,
  resolveModelControlDefaults,
  savedControlDraft,
  type SavedControlDraft
} from "@/components/app-shell/powerAppShellData";
import {
  assistantGovernsControls,
  boundComposerAssistant,
  useComposerControlStore
} from "@/components/app-shell/composerControlStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { AnswerReviewAutoConfig } from "@/lib/contracts/answerReviews";
import type { ChatDefaultMcpMode } from "@/lib/contracts/chatDefaults";
import type { McpRunSelection } from "@/lib/contracts/mcp";
import { isSearchCombinationCompatible, reconcileSearchPlanSelection } from "@/lib/domain/catalogMatrix";
import { SEARCH_DISABLED_STRATEGY_ID, type SearchPlan, type SearchPlanMode } from "@/lib/domain/search";

type PendingControlDefaults = {
  draft: SavedControlDraft;
  model: CatalogModel;
};

type MutableRef<T> = {
  current: T;
};

type RunControlsActionsInput = {
  catalog: Catalog | null;
  currentModel: CatalogModel | undefined;
  isSettingsSessionCurrent?(): boolean;
  pendingControlDefaultsRef: MutableRef<PendingControlDefaults | null>;
  pendingControlDefaultsTimerRef: MutableRef<number | null>;
  resolveCatalog?(): Catalog | null;
  settingsMutationCoordinatorRef: MutableRef<SettingsMutationCoordinator | null>;
  setCatalog(update: (current: Catalog | null) => Catalog | null): void;
  setNotice(notice: Notice): void;
  setSettingsNotice(notice: Notice): void;
};

/**
 * A personal Search plan as the UI writes it: every search goes to all
 * selected sources (operator decision 2026-10-24), so a source that cannot
 * join the ones before it in that mode is left out instead of switching mode.
 */
export function allSelectedSearchPlan(
  optionIds: readonly string[],
  strategies: Parameters<typeof isSearchCombinationCompatible>[1]
): SearchPlan {
  const selected: string[] = [];
  for (const optionId of optionIds) {
    if (optionId === SEARCH_DISABLED_STRATEGY_ID || selected.includes(optionId)) continue;
    if (isSearchCombinationCompatible([...selected, optionId], strategies, "all_selected")) selected.push(optionId);
  }
  return { mode: "all_selected", optionIds: selected };
}

function sameSearchPlan(left: SearchPlan | undefined, right: SearchPlan): boolean {
  return left?.mode === right.mode && left.optionIds.length === right.optionIds.length &&
    left.optionIds.every((optionId, index) => optionId === right.optionIds[index]);
}

export function useRunControlsActions({
  isSettingsSessionCurrent,
  catalog,
  currentModel,
  pendingControlDefaultsRef,
  pendingControlDefaultsTimerRef,
  resolveCatalog,
  settingsMutationCoordinatorRef,
  setCatalog,
  setNotice,
  setSettingsNotice
}: RunControlsActionsInput) {
  function currentCatalogFromStore() {
    return resolveCatalog
      ? resolveCatalog()
      : useWorkspaceStore.getState().catalog ?? catalog;
  }

  function selectedModelFromStore() {
    const { selectedModelId, selectedProvider } = useComposerControlStore.getState();
    const liveCatalog = currentCatalogFromStore();
    const renderedModelMatchesSelection =
      currentModel?.provider === selectedProvider && currentModel.modelId === selectedModelId;

    return (
      liveCatalog?.models.find((model) => model.provider === selectedProvider && model.modelId === selectedModelId) ??
      (renderedModelMatchesSelection ? currentModel : undefined)
    );
  }

  function buildParams() {
    const {
      backgroundMode,
      maxOutputTokens,
      reasoningEffort,
      reasoningMode,
      selectedProvider,
      streamMode,
      temperature
    } = useComposerControlStore.getState();
    const selectedModel = selectedModelFromStore();
    const controls = defaultParameterControls(selectedModel);
    const baseParams = cloneRecord(selectedModel?.defaultParams ?? {});
    const providerFamily = selectedModel?.providerFamily ?? selectedProvider;
    const maxTokens = Math.round(
      clampedNumber(
        maxOutputTokens,
        controls.maxOutputTokens.defaultValue,
        1,
        controls.maxOutputTokens.maxValue
      )
    );
    const temp = clampedNumber(
      temperature,
      controls.temperature.defaultValue,
      controls.temperature.minValue,
      controls.temperature.maxValue
    );
    const effort = coerceReasoningEffort(reasoningEffort, controls);
    const mode = coerceReasoningMode(reasoningMode, controls);

    if (providerFamily === "gemini") {
      const params: Record<string, unknown> = {
        ...baseParams,
        maxOutputTokens: maxTokens,
        reasoning: {
          ...recordValue(baseParams.reasoning),
          effort
        }
      };
      delete params.maxTokens;
      delete params.max_tokens;
      delete params.max_output_tokens;
      delete params.max_completion_tokens;
      if (controls.stream.supported) {
        params.stream = streamMode;
      } else {
        delete params.stream;
      }
      delete params.temperature;
      return params;
    }

    if (providerFamily === "openai" || providerFamily === "openai_compatible") {
      const reasoning: Record<string, unknown> = {
        ...recordValue(baseParams.reasoning),
        effort
      };
      if (controls.reasoningMode?.supported) {
        reasoning.mode = mode;
      } else {
        delete reasoning.mode;
      }

      const params: Record<string, unknown> = {
        ...baseParams,
        maxOutputTokens: maxTokens,
        reasoning,
        temperature: temp
      };
      if (controls.background.supported) {
        params.background = backgroundMode;
      } else {
        delete params.background;
      }
      if (controls.stream.supported) {
        params.stream = streamMode;
      } else {
        delete params.stream;
      }
      return params;
    }

    if (providerFamily === "anthropic") {
      const params: Record<string, unknown> = {
        ...baseParams,
        maxTokens,
        outputConfig: {
          ...recordValue(baseParams.outputConfig),
          effort
        },
        thinking: {
          ...recordValue(baseParams.thinking),
          budgetTokens: 0,
          enabled: controls.reasoningEffort.supported && effort !== "none",
          type: "adaptive"
        }
      };

      if (controls.temperature.supported) {
        params.temperature = temp;
      } else {
        delete params.temperature;
      }
      delete params.reasoning;

      return params;
    }

    if (providerFamily === "openrouter") {
      const usesVerbosityEffort = typeof baseParams.verbosity === "string";
      const params: Record<string, unknown> = {
        ...baseParams,
        maxTokens,
        // Without a reasoning control the run leaves reasoning unset (provider
        // default); a chosen `none` remains an explicit Off.
        ...(controls.reasoningEffort.supported
          ? {
              reasoning: {
                ...recordValue(baseParams.reasoning),
                enabled: effort !== "none",
                ...(usesVerbosityEffort || effort === "none" ? {} : { effort })
              }
            }
          : {})
      };

      if (controls.stream.supported) {
        params.stream = streamMode;
      } else {
        delete params.stream;
      }

      if (usesVerbosityEffort && effort !== "none") {
        params.verbosity = effort;
      }

      if (controls.temperature.supported) {
        params.temperature = temp;
      } else {
        delete params.temperature;
      }

      return params;
    }

    const params: Record<string, unknown> = {
      ...baseParams,
      maxOutputTokens: maxTokens,
      reasoning: {
        effort
      },
      temperature: temp
    };
    if (controls.stream.supported) {
      params.stream = streamMode;
    }

    return params;
  }

  function currentControlDraft(
    override: SavedControlDraft = {},
    model: CatalogModel | undefined = selectedModelFromStore()
  ): SavedControlDraft {
    const {
      backgroundMode,
      maxOutputTokens,
      reasoningEffort,
      reasoningMode,
      streamMode,
      temperature
    } = useComposerControlStore.getState();

    return {
      backgroundMode,
      maxOutputTokens,
      reasoningEffort,
      ...(defaultParameterControls(model).reasoningMode?.supported ? { reasoningMode } : {}),
      streamMode,
      temperature,
      ...override
    };
  }

  function pendingDraftForModel(model: CatalogModel): SavedControlDraft {
    const pending = pendingControlDefaultsRef.current;

    return pending && modelControlKey(pending.model) === modelControlKey(model) ? pending.draft : {};
  }

  function storedDraftForModel(model: CatalogModel): SavedControlDraft {
    return savedControlDraft(currentCatalogFromStore()?.defaults.controlValues[modelControlKey(model)]);
  }

  function mergedCurrentControlDraft(
    model: CatalogModel,
    override: SavedControlDraft = {}
  ): SavedControlDraft {
    return {
      ...storedDraftForModel(model),
      ...currentControlDraft({}, model),
      ...pendingDraftForModel(model),
      ...override
    };
  }

  function updateLocalCatalogDefaults(
    update: Partial<Catalog["defaults"]>,
    replaceControlValueKeys: ReadonlySet<string> = new Set()
  ) {
    if (isSettingsSessionCurrent?.() === false) return;
    setCatalog((current) =>
      current
        ? {
            ...current,
            defaults: applySettingsDefaultsReconciliation(
              current.defaults,
              update,
              replaceControlValueKeys
            ),
          }
        : current
    );
  }

  function noticeSetter(scope: SettingsNoticeScope) {
    return scope === "settings" ? setSettingsNotice : setNotice;
  }

  const settingsMutationCoordinator =
    settingsMutationCoordinatorRef.current ??
    createSettingsMutationCoordinator({
      isCurrent: isSettingsSessionCurrent,
      callbacks: {
        onFailure: () => undefined,
        onReconcile: () => undefined,
        onRecovered: () => undefined
      }
    });
  settingsMutationCoordinatorRef.current = settingsMutationCoordinator;
  settingsMutationCoordinator.configure({
    onFailure(error, retry, noticeScope) {
      const reportNotice = noticeSetter(noticeScope);
      reportNotice({
        action: {
          label: "Retry",
          onClick() {
            reportNotice({
              action: {
                disabled: true,
                label: "Retrying",
                onClick: () => undefined
              },
              kind: "error",
              persistent: true,
              ...(noticeScope === "settings" ? { scope: "settings" as const } : {}),
              text: "Retrying settings save…"
            });
            retry();
          }
        },
        kind: "error",
        persistent: true,
        ...(noticeScope === "settings" ? { scope: "settings" as const } : {}),
        text: errorMessage(error)
      });
    },
    onReconcile: updateLocalCatalogDefaults,
    onRecovered(noticeScope) {
      noticeSetter(noticeScope)({
        kind: "success",
        ...(noticeScope === "settings" ? { scope: "settings" as const } : {}),
        text: "Settings saved after retry."
      });
    }
  });

  function persistUserDefaults(
    update: SettingsDefaultsPatch,
    options: { noticeScope?: SettingsNoticeScope } = {}
  ) {
    if (isSettingsSessionCurrent?.() === false) return Promise.resolve(false);
    if (update.searchPlan !== null) {
      updateLocalCatalogDefaults(update as Partial<Catalog["defaults"]>);
    }
    return settingsMutationCoordinator.enqueue(update, options);
  }

  function persistModelControlDraft(model: CatalogModel, draft: SavedControlDraft) {
    void persistUserDefaults({
      controlValues: {
        [modelControlKey(model)]: draft
      }
    });
  }

  function flushPendingModelControlDefaults() {
    if (pendingControlDefaultsTimerRef.current !== null) {
      window.clearTimeout(pendingControlDefaultsTimerRef.current);
      pendingControlDefaultsTimerRef.current = null;
    }

    const pending = pendingControlDefaultsRef.current;
    pendingControlDefaultsRef.current = null;
    if (pending) {
      persistModelControlDraft(pending.model, pending.draft);
    }
    settingsMutationCoordinator.retry();
  }

  function clearPendingModelControlDefaults(model: CatalogModel) {
    const pending = pendingControlDefaultsRef.current;
    if (!pending || modelControlKey(pending.model) !== modelControlKey(model)) {
      return;
    }

    if (pendingControlDefaultsTimerRef.current !== null) {
      window.clearTimeout(pendingControlDefaultsTimerRef.current);
      pendingControlDefaultsTimerRef.current = null;
    }
    pendingControlDefaultsRef.current = null;
  }

  function persistCurrentModelControlDefaultsWithPending(
    model: CatalogModel,
    override: SavedControlDraft = {},
    defaultUpdate: Partial<Catalog["defaults"]> = {}
  ) {
    const draft = mergedCurrentControlDraft(model, override);
    clearPendingModelControlDefaults(model);
    void persistUserDefaults({
      ...defaultUpdate,
      controlValues: {
        [modelControlKey(model)]: draft
      }
    });
  }

  function scheduleCurrentModelControlDefaults(
    model: CatalogModel,
    override: SavedControlDraft = {}
  ) {
    pendingControlDefaultsRef.current = {
      draft: mergedCurrentControlDraft(model, override),
      model
    };

    if (pendingControlDefaultsTimerRef.current !== null) {
      window.clearTimeout(pendingControlDefaultsTimerRef.current);
    }

    pendingControlDefaultsTimerRef.current = window.setTimeout(() => {
      pendingControlDefaultsTimerRef.current = null;
      flushPendingModelControlDefaults();
    }, 500);
  }

  function applyModelControlDefaults(
    model?: CatalogModel | null,
    controlValues = currentCatalogFromStore()?.defaults.controlValues
  ) {
    if (!model) {
      return;
    }

    const defaults = resolveModelControlDefaults(model, controlValues);
    useComposerControlStore.getState().applyControlDefaults(defaults);
  }

  function selectModel(model: CatalogModel) {
    const currentCatalog = currentCatalogFromStore();
    flushPendingModelControlDefaults();
    const controlDefaults = resolveModelControlDefaults(model, currentCatalog?.defaults.controlValues);
    useComposerControlStore.getState().applyModelSelection({
      controlDefaults,
      modelId: model.modelId,
      provider: model.provider,
      searchStrategyIds: model.searchStrategyIds
    });
  }

  function makeModelDefault(requestedModel: CatalogModel) {
    const model = currentCatalogFromStore()?.models.find(
      (candidate) => candidate.provider === requestedModel.provider && candidate.modelId === requestedModel.modelId
    );
    if (!model) return;
    const personalModelDefault = {
      modelId: model.modelId,
      provider: model.provider
    };
    void persistUserDefaults({
      hasPersonalModelDefault: true,
      modelId: model.modelId,
      modelPreferenceSource: "personal",
      personalModelDefault,
      provider: model.provider
    }).then((saved) => {
      if (saved) setNotice({ kind: "success", text: "Personal default model updated." });
    });
  }

  function useOrganizationModelDefault() {
    const currentCatalog = currentCatalogFromStore();
    if (!currentCatalog) return;
    const organizationDefault = currentCatalog.defaults.organizationModelDefault;
    updateLocalCatalogDefaults({
      hasPersonalModelDefault: false,
      modelId: organizationDefault?.modelId ?? "",
      modelPreferenceSource: organizationDefault ? "organization" : "none",
      personalModelDefault: null,
      provider: organizationDefault?.provider ?? ""
    });
    void settingsMutationCoordinator.enqueue({ personalModelDefault: null }).then((saved) => {
      if (saved) {
        setNotice({
          kind: "success",
          text: organizationDefault
            ? "Using the organization default model."
            : "Personal default cleared. No organization default is available."
        });
      }
    });
  }

  /**
   * Chats keep no Search plan of their own (operator decision 2026-10-24):
   * without an Assistant the composer's sources are the user's personal
   * default, saved at once and used by every chat. The composer never turns
   * Search off; an empty choice is ignored here and belongs to Chat defaults.
   */
  function selectSearchPlan(optionIds: readonly string[], mode: SearchPlanMode) {
    const strategies = currentCatalogFromStore()?.searchStrategies ?? [];
    // With an Assistant the chat's Search is an Assistant row; its chat
    // update belongs to the composer's Assistant actions.
    if (boundComposerAssistant(useComposerControlStore.getState())) {
      const plan = reconcileSearchPlanSelection(optionIds, mode, strategies);
      useComposerControlStore.getState().setSelectedSearchPlan(plan.optionIds, plan.mode);
      return;
    }
    const plan = allSelectedSearchPlan(optionIds, strategies);
    if (!plan.optionIds.length) return;
    useComposerControlStore.getState().setSelectedSearchPlan(plan.optionIds, plan.mode);
    savePersonalSearchPlan(plan);
  }

  function savePersonalSearchPlan(plan: SearchPlan, options: { noticeScope?: SettingsNoticeScope } = {}) {
    const defaults = currentCatalogFromStore()?.defaults;
    if (defaults?.searchPreferenceSource === "personal" && sameSearchPlan(defaults.searchPlan, plan)) return;
    void persistUserDefaults({ searchPlan: plan, searchPreferenceSource: "personal" }, options);
  }

  /** The open chat follows the user's Search default unless an Assistant governs it. */
  function applySearchDefaultToOpenChat(plan: SearchPlan) {
    if (isSettingsSessionCurrent?.() === false) return;
    if (boundComposerAssistant(useComposerControlStore.getState())) return;
    useComposerControlStore.getState().setSelectedSearchPlan(plan.optionIds, plan.mode, "system");
  }

  function resetDefaultSearchPlan() {
    const plan = currentCatalogFromStore()?.defaults.organizationSearchPlan ?? { mode: "all_selected" as const, optionIds: [] };
    updateLocalCatalogDefaults({ searchPlan: plan, searchPreferenceSource: "organization" });
    applySearchDefaultToOpenChat(plan);
    void settingsMutationCoordinator.enqueue({ searchPlan: null }, { noticeScope: "settings" });
  }

  /** Chat defaults › Web search: the only place Search is turned off. */
  function setDefaultSearchPlan(plan: SearchPlan) {
    const next = allSelectedSearchPlan(plan.optionIds, currentCatalogFromStore()?.searchStrategies ?? []);
    applySearchDefaultToOpenChat(next);
    savePersonalSearchPlan(next, { noticeScope: "settings" });
  }

  function setDefaultMcpMode(mode: ChatDefaultMcpMode) {
    void persistUserDefaults({ mcpMode: mode }, { noticeScope: "settings" });
  }

  /**
   * The composer's MCP mode is also the personal default, so new chats keep
   * it. With an Assistant the choice stays this chat's override of its tools
   * row.
   */
  function selectMcpMode(selection: McpRunSelection) {
    const assistantChat = Boolean(boundComposerAssistant(useComposerControlStore.getState()));
    useComposerControlStore.getState().setMcpSelection(selection);
    if (assistantChat || currentCatalogFromStore()?.defaults.mcpMode === selection.mode) return;
    void persistUserDefaults({ mcpMode: selection.mode });
  }
  function setDefaultSkillsMode(mode: "auto" | "off") {
    void persistUserDefaults({ skillsMode: mode }, { noticeScope: "settings" });
  }

  /** The automatic answer review new personal chats start with; open chats keep their own. */
  function setDefaultAnswerReview(config: AnswerReviewAutoConfig) {
    void persistUserDefaults({ answerReview: config }, { noticeScope: "settings" });
  }

  /** Choosing or clearing the default Assistant also clears its unavailable mark. */
  function setDefaultAssistant(assistantId: string | null) {
    void persistUserDefaults({ assistantId, assistantUnavailable: false }, { noticeScope: "settings" });
  }

  // These are account presentation choices.
  function setAnswerSoundEnabled(value: boolean) {
    if (isSettingsSessionCurrent?.() === false) return;
    updateLocalCatalogDefaults({ answerSoundEnabled: value });
    void settingsMutationCoordinator.enqueue({ answerSoundEnabled: value }, { noticeScope: "settings" });
  }

  function setBrowserNotificationsEnabled(value: boolean) {
    if (isSettingsSessionCurrent?.() === false) return;
    updateLocalCatalogDefaults({ browserNotificationsEnabled: value });
    void settingsMutationCoordinator.enqueue({ browserNotificationsEnabled: value }, { noticeScope: "settings" });
  }

  function setAnswerSoundId(value: AnswerSoundId) {
    if (isSettingsSessionCurrent?.() === false || !isAnswerSoundId(value)) return;
    updateLocalCatalogDefaults({ answerSoundId: value });
    void settingsMutationCoordinator.enqueue({ answerSoundId: value }, { noticeScope: "settings" });
  }

  function setSendWithEnter(value: boolean) {
    void persistUserDefaults({ sendWithEnter: value }, { noticeScope: "settings" });
  }

  /**
   * Parameters the Assistant governs are a chat value of its controls row and
   * never write the user's saved per-model values. Without an Assistant, or
   * with a model the user chose instead of the Assistant's, parameters are
   * ordinary: they persist as the user's values for that model.
   */
  function changeRunControl(
    change: () => void,
    override: SavedControlDraft,
    persistence: "immediate" | "scheduled"
  ) {
    const governed = assistantGovernsControls(useComposerControlStore.getState());
    change();
    if (governed) return;
    const model = selectedModelFromStore();
    if (!model) return;
    if (persistence === "scheduled") scheduleCurrentModelControlDefaults(model, override);
    else persistCurrentModelControlDefaultsWithPending(model, override);
  }

  function changeReasoningEffort(value: string) {
    changeRunControl(() => useComposerControlStore.getState().setReasoningEffort(value),
      { reasoningEffort: value }, "immediate");
  }

  function changeReasoningMode(value: string) {
    changeRunControl(() => useComposerControlStore.getState().setReasoningMode(value),
      { reasoningMode: value }, "immediate");
  }

  function changeBackgroundMode(value: boolean) {
    changeRunControl(() => useComposerControlStore.getState().setBackgroundMode(value),
      { backgroundMode: value }, "immediate");
  }

  function changeStreamMode(value: boolean) {
    changeRunControl(() => useComposerControlStore.getState().setStreamMode(value),
      { streamMode: value }, "immediate");
  }

  function changeMaxOutputTokens(value: string) {
    changeRunControl(() => useComposerControlStore.getState().setMaxOutputTokens(value),
      { maxOutputTokens: value }, "scheduled");
  }

  function changeTemperature(value: string) {
    changeRunControl(() => useComposerControlStore.getState().setTemperature(value),
      { temperature: value }, "scheduled");
  }

  function toggleCitationsVisibility() {
    useComposerControlStore.getState().setShowCitations((visible) => {
      const next = !visible;
      void persistUserDefaults({
        showCitations: next
      });
      return next;
    });
  }

  function toggleReasoningBlockVisibility() {
    useComposerControlStore.getState().setShowReasoningBlocks((visible) => {
      const next = !visible;
      void persistUserDefaults({
        showReasoningBlocks: next
      });
      return next;
    });
  }

  return {
    setAnswerSoundEnabled,
    setAnswerSoundId,
    setBrowserNotificationsEnabled,
    applyModelControlDefaults,
    buildControlDraft: currentControlDraft,
    buildParams,
    changeBackgroundMode,
    changeMaxOutputTokens,
    changeReasoningEffort,
    changeReasoningMode,
    changeStreamMode,
    changeTemperature,
    flushPendingModelControlDefaults,
    makeModelDefault,
    persistUserDefaults,
    selectMcpMode,
    selectModel,
    selectSearchPlan,
    setDefaultAnswerReview,
    setDefaultAssistant,
    setDefaultMcpMode,
    setDefaultSkillsMode,
    setDefaultSearchPlan,
    resetDefaultSearchPlan,
    setSendWithEnter,
    toggleCitationsVisibility,
    toggleReasoningBlockVisibility,
    useOrganizationModelDefault
  };
}
