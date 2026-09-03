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
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { ChatDefaultMcpMode } from "@/lib/contracts/chatDefaults";
import type { KnowledgeSelection } from "@/lib/contracts/knowledge";
import { reconcileSearchPlanSelection } from "@/lib/domain/catalogMatrix";
import type { SearchPlan, SearchPlanMode } from "@/lib/domain/search";

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
  allowPersonalPersistence?(): boolean;
  pendingControlDefaultsRef: MutableRef<PendingControlDefaults | null>;
  pendingControlDefaultsTimerRef: MutableRef<number | null>;
  resolveCatalog?(): Catalog | null;
  settingsMutationCoordinatorRef: MutableRef<SettingsMutationCoordinator | null>;
  setCatalog(update: (current: Catalog | null) => Catalog | null): void;
  setNotice(notice: Notice): void;
  setSettingsNotice(notice: Notice): void;
};

export function useRunControlsActions({
  allowPersonalPersistence,
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
        reasoning: {
          ...recordValue(baseParams.reasoning),
          enabled: controls.reasoningEffort.supported && effort !== "none",
          ...(usesVerbosityEffort || effort === "none" ? {} : { effort })
        }
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
    override: SavedControlDraft = {},
    options: { excludeCurrentValues?: boolean } = {}
  ): SavedControlDraft {
    return {
      ...storedDraftForModel(model),
      ...(options.excludeCurrentValues ? {} : currentControlDraft({}, model)),
      ...pendingDraftForModel(model),
      ...override
    };
  }

  function updateLocalCatalogDefaults(
    update: Partial<Catalog["defaults"]>,
    replaceControlValueKeys: ReadonlySet<string> = new Set()
  ) {
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
    if (allowPersonalPersistence?.() === false) {
      return Promise.resolve(true);
    }
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
    defaultUpdate: Partial<Catalog["defaults"]> = {},
    options: { excludeCurrentValues?: boolean } = {}
  ) {
    const draft = mergedCurrentControlDraft(model, override, options);
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
    override: SavedControlDraft = {},
    options: { excludeCurrentValues?: boolean } = {}
  ) {
    pendingControlDefaultsRef.current = {
      draft: mergedCurrentControlDraft(model, override, options),
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
   * Atomically applies one exact Assistant revision to the composer without
   * persisting any user default: Assistant-derived values never replace the
   * user's ordinary manual draft or saved per-model control values.
   */
  function applyAssistantToComposer(input: {
    assistant: {
      avatar: import("@/lib/contracts/assistants").AssistantAvatarRecipe;
      description: string;
      id: string;
      includedSkills?: { id: string; name: string }[];
      knowledgeLabel?: string | null;
      knowledgeResourceCount?: number;
      name: string;
      promptCharacterCount: number;
      starterPrompts: string[];
    };
    revision: import("@/lib/contracts/assistants").AssistantRevisionContent;
  }): boolean {
    const currentCatalog = currentCatalogFromStore();
    const model = input.revision.providerModelId
      ? currentCatalog?.models.find(
          (candidate) => candidate.modelId === input.revision.providerModelId
        )
      : undefined;
    if (!model) {
      return false;
    }

    flushPendingModelControlDefaults();
    const controls = input.revision.runControls;
    const baseDefaults = resolveModelControlDefaults(model, {});
    const controlDefaults = {
      backgroundMode: controls.backgroundMode ?? baseDefaults.backgroundMode,
      maxOutputTokens:
        controls.maxOutputTokens !== undefined
          ? String(controls.maxOutputTokens)
          : baseDefaults.maxOutputTokens,
      reasoningEffort: controls.reasoningEffort ?? baseDefaults.reasoningEffort,
      reasoningMode: controls.reasoningMode ?? baseDefaults.reasoningMode,
      streamMode: controls.streamMode ?? baseDefaults.streamMode,
      temperature:
        controls.temperature !== undefined
          ? String(controls.temperature)
          : baseDefaults.temperature
    };
    useComposerControlStore.getState().applyAssistantSelection({
      assistant: input.assistant,
      controlDefaults,
      knowledgeSelection: input.revision.knowledgeSelection,
      modelId: model.modelId,
      provider: model.provider,
      searchOptionIds: input.revision.searchPlan.optionIds,
      searchPlanMode: input.revision.searchPlan.mode
    });
    return true;
  }

  function removeAssistantFromComposer() {
    useComposerControlStore.getState().removeAssistant();
  }

  function selectSearchStrategy(strategyId: string) {
    const nextSearchStrategy = strategyId === "search-disabled" ||
      currentCatalogFromStore()?.searchStrategies.some((strategy) =>
        strategy.strategyId === strategyId)
      ? strategyId
      : "search-disabled";
    selectSearchPlan(
      nextSearchStrategy === "search-disabled" ? [] : [nextSearchStrategy],
      "all_selected"
    );
  }

  function selectSearchPlan(optionIds: readonly string[], mode: SearchPlanMode) {
    const plan = reconcileSearchPlanSelection(
      optionIds,
      mode,
      currentCatalogFromStore()?.searchStrategies ?? []
    );
    useComposerControlStore.getState().setSelectedSearchPlan(plan.optionIds, plan.mode);
    void persistUserDefaults({
      searchPlan: plan,
      searchPreferenceSource: "personal"
    });
  }

  function useOrganizationSearchDefault() {
    const currentCatalog = currentCatalogFromStore();
    if (!currentCatalog) return;
    const plan = currentCatalog.defaults.organizationSearchPlan ?? {
      mode: "all_selected" as const,
      optionIds: []
    };
    useComposerControlStore.getState().setSelectedSearchPlan(plan.optionIds, plan.mode);
    updateLocalCatalogDefaults({
      searchPlan: plan,
      searchPreferenceSource: "organization"
    });
    void settingsMutationCoordinator.enqueue({ searchPlan: null });
  }

  /* Settings › Chat defaults: personal defaults for new chats only; the open
     chat's composer selection is left untouched. */
  function setDefaultSearchPlan(plan: SearchPlan) {
    const reconciled = reconcileSearchPlanSelection(
      plan.optionIds,
      plan.mode,
      currentCatalogFromStore()?.searchStrategies ?? []
    );
    void persistUserDefaults(
      { searchPlan: reconciled, searchPreferenceSource: "personal" },
      { noticeScope: "settings" }
    );
  }

  function setDefaultMcpMode(mode: ChatDefaultMcpMode) {
    void persistUserDefaults({ mcpMode: mode }, { noticeScope: "settings" });
  }

  function setDefaultKnowledgePlan(plan: KnowledgeSelection | null) {
    void persistUserDefaults({ knowledgePlan: plan }, { noticeScope: "settings" });
  }

  function setSendWithEnter(value: boolean) {
    void persistUserDefaults({ sendWithEnter: value }, { noticeScope: "settings" });
  }

  function changeReasoningEffort(value: string) {
    const wasAssistantSelected = Boolean(useComposerControlStore.getState().selectedAssistant);
    useComposerControlStore.getState().setReasoningEffort(value);
    const model = selectedModelFromStore();
    if (model) {
      persistCurrentModelControlDefaultsWithPending(
        model,
        { reasoningEffort: value },
        {},
        { excludeCurrentValues: wasAssistantSelected }
      );
    }
  }

  function changeReasoningMode(value: string) {
    const wasAssistantSelected = Boolean(useComposerControlStore.getState().selectedAssistant);
    useComposerControlStore.getState().setReasoningMode(value);
    const model = selectedModelFromStore();
    if (model) {
      persistCurrentModelControlDefaultsWithPending(
        model,
        { reasoningMode: value },
        {},
        { excludeCurrentValues: wasAssistantSelected }
      );
    }
  }

  function changeBackgroundMode(value: boolean) {
    const wasAssistantSelected = Boolean(useComposerControlStore.getState().selectedAssistant);
    useComposerControlStore.getState().setBackgroundMode(value);
    const model = selectedModelFromStore();
    if (model) {
      persistCurrentModelControlDefaultsWithPending(
        model,
        { backgroundMode: value },
        {},
        { excludeCurrentValues: wasAssistantSelected }
      );
    }
  }

  function changeStreamMode(value: boolean) {
    const wasAssistantSelected = Boolean(useComposerControlStore.getState().selectedAssistant);
    useComposerControlStore.getState().setStreamMode(value);
    const model = selectedModelFromStore();
    if (model) {
      persistCurrentModelControlDefaultsWithPending(
        model,
        { streamMode: value },
        {},
        { excludeCurrentValues: wasAssistantSelected }
      );
    }
  }

  function changeMaxOutputTokens(value: string) {
    const wasAssistantSelected = Boolean(useComposerControlStore.getState().selectedAssistant);
    useComposerControlStore.getState().setMaxOutputTokens(value);
    const model = selectedModelFromStore();
    if (model) {
      scheduleCurrentModelControlDefaults(
        model,
        { maxOutputTokens: value },
        { excludeCurrentValues: wasAssistantSelected }
      );
    }
  }

  function changeTemperature(value: string) {
    const wasAssistantSelected = Boolean(useComposerControlStore.getState().selectedAssistant);
    useComposerControlStore.getState().setTemperature(value);
    const model = selectedModelFromStore();
    if (model) {
      scheduleCurrentModelControlDefaults(
        model,
        { temperature: value },
        { excludeCurrentValues: wasAssistantSelected }
      );
    }
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
    applyAssistantToComposer,
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
    removeAssistantFromComposer,
    selectModel,
    selectSearchPlan,
    selectSearchStrategy,
    setDefaultKnowledgePlan,
    setDefaultMcpMode,
    setDefaultSearchPlan,
    setSendWithEnter,
    toggleCitationsVisibility,
    toggleReasoningBlockVisibility,
    useOrganizationModelDefault,
    useOrganizationSearchDefault
  };
}
