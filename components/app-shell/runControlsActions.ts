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
  type SettingsNoticeScope
} from "@/components/app-shell/settingsMutationCoordinator";
import type { Catalog, CatalogModel, Notice } from "@/components/app-shell/types";
import {
  modelControlKey,
  resolveModelControlDefaults,
  resolveModelSearchStrategy,
  savedControlDraft,
  type SavedControlDraft
} from "@/components/app-shell/powerAppShellData";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  resolveRunProfiles,
  type RunProfileId
} from "@/components/app-shell/runProfiles";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { resolveSearchStrategyId } from "@/lib/domain/catalogMatrix";

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
  pendingControlDefaultsRef: MutableRef<PendingControlDefaults | null>;
  pendingControlDefaultsTimerRef: MutableRef<number | null>;
  settingsMutationCoordinatorRef: MutableRef<SettingsMutationCoordinator | null>;
  setCatalog(update: (current: Catalog | null) => Catalog | null): void;
  setNotice(notice: Notice): void;
  setSettingsNotice(notice: Notice): void;
};

export function useRunControlsActions({
  catalog,
  currentModel,
  pendingControlDefaultsRef,
  pendingControlDefaultsTimerRef,
  settingsMutationCoordinatorRef,
  setCatalog,
  setNotice,
  setSettingsNotice
}: RunControlsActionsInput) {
  function currentCatalogFromStore() {
    return useWorkspaceStore.getState().catalog ?? catalog;
  }

  function selectedModelFromStore() {
    const { selectedModelId, selectedProvider } = useComposerControlStore.getState();
    const liveCatalog = currentCatalogFromStore();

    return (
      liveCatalog?.models.find((model) => model.provider === selectedProvider && model.modelId === selectedModelId) ??
      currentModel
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

    if (selectedProvider === "openai") {
      const reasoning: Record<string, unknown> = {
        ...recordValue(baseParams.reasoning),
        effort
      };
      if (controls.reasoningMode?.supported) {
        reasoning.mode = mode;
      } else {
        delete reasoning.mode;
      }

      return {
        ...baseParams,
        background: controls.background.supported ? backgroundMode : false,
        maxOutputTokens: maxTokens,
        reasoning,
        stream: controls.stream.supported ? streamMode : Boolean(baseParams.stream),
        temperature: temp
      };
    }

    if (selectedProvider === "anthropic") {
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

      return params;
    }

    if (selectedProvider === "openrouter") {
      const usesVerbosityEffort = typeof baseParams.verbosity === "string";
      const params: Record<string, unknown> = {
        ...baseParams,
        maxTokens,
        reasoning: {
          ...recordValue(baseParams.reasoning),
          enabled: controls.reasoningEffort.supported && effort !== "none",
          ...(usesVerbosityEffort || effort === "none" ? {} : { effort })
        },
        stream: controls.stream.supported ? streamMode : Boolean(baseParams.stream)
      };

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
      selectedSearchStrategy,
      streamMode,
      temperature
    } = useComposerControlStore.getState();

    return {
      backgroundMode,
      maxOutputTokens,
      reasoningEffort,
      ...(defaultParameterControls(model).reasoningMode?.supported ? { reasoningMode } : {}),
      searchStrategyId: selectedSearchStrategy,
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

  function mergedCurrentControlDraft(model: CatalogModel, override: SavedControlDraft = {}): SavedControlDraft {
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
    setCatalog((current) =>
      current
        ? {
            ...current,
            defaults: applySettingsDefaultsReconciliation(
              current.defaults,
              update,
              replaceControlValueKeys
            ),
            promptPresets:
              "promptPresetId" in update
                ? current.promptPresets.map((prompt) => ({
                    ...prompt,
                    isDefault: prompt.id === update.promptPresetId
                  })).sort(
                    (left, right) =>
                      Number(right.isDefault) - Number(left.isDefault) || left.name.localeCompare(right.name)
                  )
                : current.promptPresets
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
    update: Partial<Catalog["defaults"]>,
    options: { noticeScope?: SettingsNoticeScope } = {}
  ) {
    updateLocalCatalogDefaults(update);
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

  function scheduleCurrentModelControlDefaults(model: CatalogModel, override: SavedControlDraft = {}) {
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
    const selectedSearchStrategy = useComposerControlStore.getState().selectedSearchStrategy;
    const nextSearchStrategy = resolveModelSearchStrategy(
      model,
      currentCatalog?.defaults.controlValues,
      selectedSearchStrategy
    );
    const controlDefaults = resolveModelControlDefaults(model, currentCatalog?.defaults.controlValues);
    useComposerControlStore.getState().applyModelSelection({
      controlDefaults,
      modelId: model.modelId,
      provider: model.provider,
      searchStrategyId: nextSearchStrategy
    });
    void persistUserDefaults({
      modelId: model.modelId,
      provider: model.provider,
      searchStrategyId: nextSearchStrategy
    });
  }

  function selectRunProfile(profileId: RunProfileId): boolean {
    const currentCatalog = currentCatalogFromStore();
    const resolvedProfile = resolveRunProfiles(currentCatalog).find((profile) => profile.id === profileId);
    if (!currentCatalog || !resolvedProfile?.available || !resolvedProfile.model) {
      return false;
    }

    const model = resolvedProfile.model;
    const store = useComposerControlStore.getState();
    const selectedModel = selectedModelFromStore();
    const sameModel = selectedModel ? modelControlKey(selectedModel) === modelControlKey(model) : false;
    const nextSearchStrategy = resolveModelSearchStrategy(
      model,
      currentCatalog.defaults.controlValues,
      store.selectedSearchStrategy
    );
    const targetDraft = {
      ...storedDraftForModel(model),
      ...(sameModel ? currentControlDraft({}, model) : {}),
      ...pendingDraftForModel(model),
      reasoningEffort: resolvedProfile.reasoningEffort,
      reasoningMode: resolvedProfile.reasoningMode,
      searchStrategyId: nextSearchStrategy
    } satisfies SavedControlDraft;
    const controlDefaults = resolveModelControlDefaults(model, {
      [modelControlKey(model)]: targetDraft
    });
    const completeDraft = {
      ...controlDefaults,
      searchStrategyId: nextSearchStrategy
    } satisfies SavedControlDraft;

    clearPendingModelControlDefaults(model);
    store.applyModelSelection({
      controlDefaults,
      modelId: model.modelId,
      provider: model.provider,
      searchStrategyId: nextSearchStrategy
    });
    void persistUserDefaults({
      controlValues: {
        [modelControlKey(model)]: completeDraft
      },
      modelId: model.modelId,
      provider: model.provider,
      searchStrategyId: nextSearchStrategy
    });

    return true;
  }

  function selectSearchStrategy(strategyId: string) {
    const nextSearchStrategy = resolveSearchStrategyId(currentModel, strategyId);
    useComposerControlStore.getState().setSelectedSearchStrategy(nextSearchStrategy);
    if (currentModel) {
      persistCurrentModelControlDefaultsWithPending(currentModel, { searchStrategyId: nextSearchStrategy });
      return;
    }

    void persistUserDefaults({
      searchStrategyId: nextSearchStrategy
    });
  }

  function changeReasoningEffort(value: string) {
    useComposerControlStore.getState().setReasoningEffort(value);
    if (currentModel) {
      persistCurrentModelControlDefaultsWithPending(currentModel, { reasoningEffort: value });
    }
  }

  function changeReasoningMode(value: string) {
    useComposerControlStore.getState().setReasoningMode(value);
    if (currentModel) {
      persistCurrentModelControlDefaultsWithPending(currentModel, { reasoningMode: value });
    }
  }

  function changeBackgroundMode(value: boolean) {
    useComposerControlStore.getState().setBackgroundMode(value);
    if (currentModel) {
      persistCurrentModelControlDefaultsWithPending(currentModel, { backgroundMode: value });
    }
  }

  function changeStreamMode(value: boolean) {
    useComposerControlStore.getState().setStreamMode(value);
    if (currentModel) {
      persistCurrentModelControlDefaultsWithPending(currentModel, { streamMode: value });
    }
  }

  function changeMaxOutputTokens(value: string) {
    useComposerControlStore.getState().setMaxOutputTokens(value);
    if (currentModel) {
      scheduleCurrentModelControlDefaults(currentModel, { maxOutputTokens: value });
    }
  }

  function changeTemperature(value: string) {
    useComposerControlStore.getState().setTemperature(value);
    if (currentModel) {
      scheduleCurrentModelControlDefaults(currentModel, { temperature: value });
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
    persistUserDefaults,
    selectModel,
    selectRunProfile,
    selectSearchStrategy,
    toggleCitationsVisibility,
    toggleReasoningBlockVisibility
  };
}
