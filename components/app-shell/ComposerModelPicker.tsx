import { useComposerPickerSession } from "@/components/app-shell/composerPicker";
import {
  modelCapabilityDescription,
  modelCapabilityLabel,
  modelCapabilityLabels,
  modelDifferentiatingCapabilityLabels
} from "@/components/app-shell/shellFormatting";
import type { Catalog, CatalogModel } from "@/components/app-shell/types";
import { ArrowLeft, Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

const modelPickerScrollMargins = {};

type ModelGroup = {
  id: string;
  models: CatalogModel[];
  name: string;
};

type ModelPickerAction = { kind: "model"; model: CatalogModel; provider: ModelGroup };

export function ComposerModelPicker({
  catalog,
  catalogUnavailable,
  currentModel,
  disabled,
  nestedInRunSetup = false,
  onOpenChange,
  onSelectModel,
  open,
  selectedModelId,
  selectedProvider,
  selectedProviderName,
  streaming
}: {
  catalog: Catalog | null;
  catalogUnavailable: boolean;
  currentModel?: CatalogModel;
  disabled: boolean;
  nestedInRunSetup?: boolean;
  onOpenChange(open: boolean): void;
  onSelectModel(model: CatalogModel): void;
  open: boolean;
  selectedModelId: string;
  selectedProvider: string;
  selectedProviderName: string;
  streaming: boolean;
}) {
  const [query, setQuery] = useState("");
  const selectionKey = `${selectedProvider}\u0000${selectedModelId}`;
  const previousSelectionKeyRef = useRef(selectionKey);
  const hasEntitledModels = Boolean(catalog?.models.length);
  const filteredModelGroups = useMemo<ModelGroup[]>(() => {
    if (!catalog) {
      return [];
    }

    const normalizedQuery = query.trim().toLocaleLowerCase();
    return catalog.providers
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        models: catalog.models.filter((candidate) => {
          if (candidate.provider !== provider.id) {
            return false;
          }
          if (!normalizedQuery) {
            return true;
          }

          return [
            provider.family ?? provider.id,
            provider.name,
            candidate.providerFamily ?? "",
            candidate.modelId,
            candidate.upstreamModelId ?? "",
            candidate.displayName,
            modelCapabilityLabel(candidate),
            modelCapabilityDescription(candidate)
          ]
            .join(" ")
            .toLocaleLowerCase()
            .includes(normalizedQuery);
        })
      }))
      .filter((provider) => provider.models.length > 0);
  }, [catalog, query]);
  const actions = useMemo<ModelPickerAction[]>(
    () =>
      filteredModelGroups.flatMap((provider) =>
        provider.models.map((candidate) => ({
          kind: "model" as const,
          model: candidate,
          provider
        }))
      ),
    [filteredModelGroups]
  );
  const selectedActionIndex = actions.findIndex(
    (action) =>
      action.model.provider === selectedProvider && action.model.modelId === selectedModelId
  );
  const fullModelSummary = (() => {
    if (currentModel) {
      return `${selectedProviderName} / ${currentModel.displayName}`;
    }
    if (catalogUnavailable) {
      return "Models unavailable";
    }
    if (!catalog) {
      return "Loading models…";
    }
    return hasEntitledModels ? "Select a model" : "No models available";
  })();
  const modelSummary = currentModel?.displayName ?? fullModelSummary;
  const pickerDisabled = disabled || !catalog || streaming || !hasEntitledModels;

  useEffect(() => {
    const selectionChanged = previousSelectionKeyRef.current !== selectionKey;
    previousSelectionKeyRef.current = selectionKey;
    if (selectionChanged && open) {
      onOpenChange(false);
    }
  }, [onOpenChange, open, selectionKey]);

  const {
    boundaryProps,
    boundaryRef,
    close,
    dialogProps,
    dialogRef,
    getItemProps,
    handleSearchKeyDown,
    navigableIndex,
    open: pickerOpen,
    resultsRef,
    searchRef,
    setActiveIndex,
    toggle,
    triggerProps,
    triggerRef
  } = useComposerPickerSession({
    dialogId: "model-picker-dialog",
    disabled: pickerDisabled,
    initialFocus: "search",
    itemFocusPreventScroll: true,
    items: actions,
    onClose: () => setQuery(""),
    onOpenChange,
    onSelect: (action) => onSelectModel(action.model),
    open,
    scrollMargins: modelPickerScrollMargins,
    selectedIndex: selectedActionIndex
  });

  return (
    <div {...boundaryProps} ref={boundaryRef} className="relative col-span-3 min-w-0 sm:col-span-1">
      <button
        {...triggerProps}
        ref={triggerRef}
        className="flex h-touch w-full min-w-0 items-center justify-between gap-2 rounded-control bg-surface-hover px-3 text-left text-xs text-content-primary outline-none hover:bg-surface-active focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
        type="button"
        aria-label="Select model"
        aria-describedby="composer-model-current-description"
        disabled={pickerDisabled}
        title={fullModelSummary}
        onClick={toggle}
      >
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="shrink-0 text-[11px] font-medium text-content-muted">Model</span>
          <span
            className="truncate text-sm font-semibold text-content-primary"
            id="composer-model-current-value"
          >
            {modelSummary}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-content-muted" aria-hidden="true" />
      </button>
      <span className="sr-only" id="composer-model-current-description">
        {fullModelSummary}
      </span>
      {pickerOpen ? (
        <>
          {nestedInRunSetup ? (
            <div
              className="fixed inset-0 z-[80] bg-scrim/55 backdrop-blur-sm"
              data-testid="model-picker-backdrop"
              role="presentation"
              aria-hidden="true"
              onMouseDown={(event) => {
                event.stopPropagation();
                close();
              }}
            />
          ) : null}
          <div
            {...dialogProps}
            ref={dialogRef}
            className={[
              "pop-enter absolute bottom-11 left-0 flex max-h-[min(34rem,calc(100dvh-6rem))] w-[min(42rem,calc(100vw-2rem))] flex-col overflow-hidden rounded-panel border bg-surface-overlay p-3 shadow-overlay max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[min(78dvh,40rem)] max-sm:w-full max-sm:rounded-b-none max-sm:border-x-0 max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))] [@media(max-height:32rem)]:fixed [@media(max-height:32rem)]:!bottom-0 [@media(max-height:32rem)]:!left-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!right-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!max-h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] [@media(max-height:32rem)]:!w-auto [@media(max-height:32rem)]:rounded-b-none [@media(max-height:32rem)]:pb-[calc(.75rem+env(safe-area-inset-bottom))]",
              nestedInRunSetup
                ? "z-[90] border-separator-strong"
                : "z-50 border-separator-subtle"
            ].join(" ")}
            data-testid="model-picker"
            aria-label="Choose a model"
          >
            <div className="mb-3">
              {nestedInRunSetup ? (
                <button
                  className="mb-1 inline-flex h-touch items-center gap-2 rounded-control px-2 text-xs font-medium text-content-secondary outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55"
                  type="button"
                  onClick={close}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Back to Run setup
                </button>
              ) : null}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-content-primary">Choose a model</h2>
                  <p className="mt-0.5 text-xs text-content-muted">
                    Search entitled models grouped by provider.
                  </p>
                </div>
                {!nestedInRunSetup ? (
                  <button
                    className="grid size-11 shrink-0 place-items-center rounded-control text-content-muted outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 lg:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
                    type="button"
                    aria-label="Close model picker"
                    onClick={close}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          <div className="mb-2 flex min-h-touch items-center gap-2 rounded-control border border-separator-subtle bg-surface-thread px-3 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch">
            <Search className="size-4 shrink-0 text-content-muted" aria-hidden="true" />
            <input
              ref={searchRef}
              className="min-w-0 flex-1 bg-transparent text-sm text-content-primary outline-none placeholder:text-content-muted focus-visible:ring-0"
              type="search"
              aria-label="Search models"
              placeholder="Search provider, model, capability"
              value={query}
              onChange={(event) => {
                setActiveIndex(0);
                setQuery(event.target.value);
              }}
              onKeyDown={handleSearchKeyDown}
            />
          </div>
          <p className="sr-only" aria-live="polite">
            {actions[navigableIndex]
              ? `${actions[navigableIndex].model.displayName}, ${navigableIndex + 1} of ${actions.length}`
              : "No matching models"}
          </p>
          <div
            ref={resultsRef}
            className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1"
            id="model-picker-results"
            role="group"
            aria-label="Available providers and models"
          >
            {filteredModelGroups.length === 0 ? (
              <div className="rounded-control bg-surface-thread px-4 py-6 text-center" role="status">
                <p className="text-sm font-medium text-content-primary">No models match {query.trim() ? `“${query.trim()}”` : "this search"}.</p>
                <p className="mt-1 text-xs text-content-muted">Try a provider, model name, or capability.</p>
              </div>
            ) : null}
            {filteredModelGroups.map((provider, providerIndex) => {
              const currentProvider = provider.id === selectedProvider;
              const providerHeadingId = `model-picker-provider-${providerIndex}`;
              const comparisonModels = catalog?.models.filter(
                (candidate) => candidate.provider === provider.id
              ) ?? [];

              return (
                <section key={provider.id} aria-labelledby={providerHeadingId}>
                  <header className="mb-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-control bg-surface-raised px-3 py-2">
                    <span className="min-w-0">
                      <span
                        className="block text-[11px] font-medium leading-4 text-content-muted"
                        aria-hidden="true"
                      >
                        Provider
                      </span>
                      <h3 className="truncate text-sm font-semibold text-content-primary" id={providerHeadingId}>{provider.name}</h3>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-content-muted">
                      <span>
                        {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
                      </span>
                      {currentProvider ? <span>Current group</span> : null}
                    </span>
                  </header>
                  <div className="space-y-1">
                    {provider.models.map((model) => {
                      const active = model.provider === selectedProvider && model.modelId === selectedModelId;
                      const isDefault = model.provider === catalog?.defaults.provider && model.modelId === catalog.defaults.modelId;
                      const capabilityLabels = modelCapabilityLabels(model);
                      const differentiatingLabels = modelDifferentiatingCapabilityLabels(
                        model,
                        comparisonModels
                      );
                      const remainingLabels = capabilityLabels.filter(
                        (label) => !differentiatingLabels.includes(label)
                      );
                      const actionIndex = actions.findIndex(
                        (action) =>
                          action.kind === "model" &&
                          action.model.provider === model.provider &&
                          action.model.modelId === model.modelId
                      );

                      return (
                        <button
                          key={`${model.provider}:${model.modelId}`}
                          {...getItemProps(actionIndex)}
                          className={[
                            "flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2.5 text-left outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-cyan/55",
                            active ? "bg-surface-selected text-content-primary" : "text-content-secondary"
                          ].join(" ")}
                          id={`model-picker-action-${actionIndex}`}
                          type="button"
                          aria-current={active ? "true" : undefined}
                          aria-label={`Select model ${provider.name} ${model.displayName}`}
                          aria-describedby={[
                            `model-picker-model-${actionIndex}-capabilities`,
                            active ? `model-picker-model-${actionIndex}-current` : null,
                            isDefault ? `model-picker-model-${actionIndex}-default` : null
                          ]
                            .filter((id): id is string => Boolean(id))
                            .join(" ")}
                          title={`${provider.name} / ${model.displayName}\n${modelCapabilityDescription(model)}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-sm font-semibold leading-5 text-content-primary [overflow-wrap:anywhere]">
                              {model.displayName}
                            </span>
                            <span
                              className="mt-0.5 block text-xs leading-5"
                              id={`model-picker-model-${actionIndex}-capabilities`}
                            >
                              {differentiatingLabels.length > 0 ? (
                                <span className="font-medium text-content-secondary">
                                  {differentiatingLabels.join(" · ")}
                                </span>
                              ) : null}
                              {differentiatingLabels.length > 0 && remainingLabels.length > 0
                                ? " · "
                                : null}
                              {remainingLabels.length > 0 ? (
                                <span className="text-content-muted">
                                  {remainingLabels.join(" · ")}
                                </span>
                              ) : null}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5 text-xs">
                            {active ? (
                              <span
                                className="text-accent-cyan"
                                id={`model-picker-model-${actionIndex}-current`}
                              >
                                Current
                              </span>
                            ) : null}
                            {isDefault ? (
                              <span
                                className="text-content-muted"
                                id={`model-picker-model-${actionIndex}-default`}
                              >
                                Default
                              </span>
                            ) : null}
                            {active ? <Check className="size-4 text-accent-cyan" aria-hidden="true" /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
        </div>
        </>
      ) : null}
    </div>
  );
}
