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
  className,
  currentModel,
  idPrefix = "composer-model",
  disabled,
  nestedInRunSetup = false,
  onMakeCurrentDefault,
  onOpenChange,
  onSelectModel,
  onUseOrganizationDefault,
  open,
  pickerTestId = "model-picker",
  selectedModelId,
  selectedProvider,
  selectedProviderName,
  streaming,
  valueTestId
}: {
  catalog: Catalog | null;
  catalogUnavailable: boolean;
  className?: string;
  currentModel?: CatalogModel;
  disabled: boolean;
  idPrefix?: string;
  nestedInRunSetup?: boolean;
  onMakeCurrentDefault?(): void;
  onOpenChange(open: boolean): void;
  onSelectModel(model: CatalogModel): void;
  onUseOrganizationDefault?(): void;
  open: boolean;
  pickerTestId?: string;
  selectedModelId: string;
  selectedProvider: string;
  selectedProviderName: string;
  streaming: boolean;
  valueTestId?: string;
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
    dialogId: `${idPrefix}-picker-dialog`,
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
    <div
      {...boundaryProps}
      ref={boundaryRef}
      className={[
        "relative col-span-3 min-w-0",
        nestedInRunSetup ? "sm:col-span-2" : "sm:col-span-1",
        className
      ].filter(Boolean).join(" ")}
    >
      <button
        {...triggerProps}
        ref={triggerRef}
        className="flex h-touch w-full min-w-0 items-center justify-between gap-2 rounded-control bg-control-surface px-3 text-left text-xs text-ink outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
        type="button"
        aria-label="Select model"
        aria-describedby={`${idPrefix}-current-description`}
        disabled={pickerDisabled}
        title={fullModelSummary}
        onClick={toggle}
      >
        <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
          {currentModel ? (
            <>
              <span
                className="max-w-[35%] shrink-0 truncate text-xs font-medium text-ink-secondary"
                data-testid={valueTestId ? `${valueTestId}-provider` : undefined}
              >
                {selectedProviderName}
              </span>
              <span className="shrink-0 text-ink-muted" aria-hidden="true">/</span>
            </>
          ) : null}
          <span
            className="min-w-0 flex-1 truncate text-sm font-semibold text-ink"
            data-testid={valueTestId}
            id={`${idPrefix}-current-value`}
          >
            {modelSummary}
          </span>
        </span>
        <ChevronDown className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      </button>
      <span className="sr-only" id={`${idPrefix}-current-description`}>
        {fullModelSummary}
      </span>
      {pickerOpen ? (
        <>
          {nestedInRunSetup ? (
            <div
              className="fixed inset-0 z-[80] bg-scrim/55"
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
              "pop-enter flex flex-col overflow-hidden rounded-panel border bg-overlay-surface p-3 shadow-overlay",
              nestedInRunSetup
                ? "fixed inset-x-2 bottom-2 z-[90] max-h-[min(78dvh,40rem)] w-auto border-trace-strong pb-[calc(0.75rem+env(safe-area-inset-bottom))] sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[min(42rem,calc(100dvh-2rem))] sm:w-[min(42rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:pb-3"
                : "absolute bottom-11 left-0 z-50 max-h-[min(34rem,calc(100dvh-6rem))] w-[min(42rem,calc(100vw-2rem))] border-trace-subtle max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:max-h-[min(78dvh,40rem)] max-sm:w-full max-sm:rounded-b-none max-sm:border-x-0 max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom))]"
            ].join(" ")}
            data-testid={pickerTestId}
            aria-label="Choose a model"
          >
            <div className="mb-3">
              {nestedInRunSetup ? (
                <button
                  className="mb-1 inline-flex h-touch items-center gap-2 rounded-control px-2 text-xs font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus"
                  type="button"
                  onClick={close}
                >
                  <ArrowLeft className="size-4" aria-hidden="true" />
                  Back to Run setup
                </button>
              ) : null}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold text-ink">Choose a model</h2>
                  <p className="mt-0.5 text-xs text-ink-muted">
                    Search entitled models grouped by provider.
                  </p>
                </div>
                {!nestedInRunSetup ? (
                  <button
                    className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus lg:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
                    type="button"
                    aria-label="Close model picker"
                    onClick={close}
                  >
                    <X className="size-4" aria-hidden="true" />
                  </button>
                ) : null}
              </div>
            </div>
          <div className="mb-2 flex min-h-touch items-center gap-2 rounded-control border border-control-boundary bg-answer-paper px-3 focus-within:ring-2 focus-within:ring-focus sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch">
            <Search className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
            <input
              ref={searchRef}
              className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted focus-visible:ring-0"
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
            id={`${idPrefix}-picker-results`}
            role="group"
            aria-label="Available providers and models"
          >
            {filteredModelGroups.length === 0 ? (
              <div className="rounded-control bg-control-surface px-4 py-6 text-center" role="status">
                <p className="text-sm font-medium text-ink">No models match {query.trim() ? `“${query.trim()}”` : "this search"}.</p>
                <p className="mt-1 text-xs text-ink-muted">Try a provider, model name, or capability.</p>
              </div>
            ) : null}
            {filteredModelGroups.map((provider, providerIndex) => {
              const currentProvider = provider.id === selectedProvider;
              const providerHeadingId = `${idPrefix}-picker-provider-${providerIndex}`;
              const comparisonModels = catalog?.models.filter(
                (candidate) => candidate.provider === provider.id
              ) ?? [];

              return (
                <section key={provider.id} aria-labelledby={providerHeadingId}>
                  <header className="mb-1 grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 rounded-control bg-control-surface px-3 py-2">
                    <span className="min-w-0">
                      <span
                        className="block text-xs font-medium leading-4 text-ink-muted"
                        aria-hidden="true"
                      >
                        Provider
                      </span>
                      <h3 className="truncate text-sm font-semibold text-ink" id={providerHeadingId}>{provider.name}</h3>
                    </span>
                    <span className="flex shrink-0 flex-col items-end gap-0.5 text-xs text-ink-muted">
                      <span>
                        {provider.models.length} {provider.models.length === 1 ? "model" : "models"}
                      </span>
                      {currentProvider ? <span>Current group</span> : null}
                    </span>
                  </header>
                  <div className="space-y-1">
                    {provider.models.map((model) => {
                      const active = model.provider === selectedProvider && model.modelId === selectedModelId;
                      const isPersonalDefault = model.provider === catalog?.defaults.personalModelDefault?.provider &&
                        model.modelId === catalog.defaults.personalModelDefault.modelId;
                      const isOrganizationDefault = model.provider === catalog?.defaults.organizationModelDefault?.provider &&
                        model.modelId === catalog.defaults.organizationModelDefault.modelId;
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
                            "flex min-h-touch w-full items-start justify-between gap-3 rounded-control px-3 py-2.5 text-left outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus",
                            active ? "bg-control-selected text-ink" : "text-ink-secondary"
                          ].join(" ")}
                          id={`${idPrefix}-picker-action-${actionIndex}`}
                          type="button"
                          aria-current={active ? "true" : undefined}
                          aria-label={`Select model ${provider.name} ${model.displayName}`}
                          aria-describedby={[
                            `${idPrefix}-picker-model-${actionIndex}-capabilities`,
                            active ? `${idPrefix}-picker-model-${actionIndex}-current` : null,
                            isPersonalDefault ? `${idPrefix}-picker-model-${actionIndex}-personal-default` : null,
                            isOrganizationDefault ? `${idPrefix}-picker-model-${actionIndex}-organization-default` : null
                          ]
                            .filter((id): id is string => Boolean(id))
                            .join(" ")}
                          title={`${provider.name} / ${model.displayName}\n${modelCapabilityDescription(model)}`}
                        >
                          <span className="min-w-0 flex-1">
                            <span className="block break-words text-sm font-semibold leading-5 text-ink [overflow-wrap:anywhere]">
                              {model.displayName}
                            </span>
                            <span
                              className="mt-0.5 block text-xs leading-5"
                              id={`${idPrefix}-picker-model-${actionIndex}-capabilities`}
                            >
                              {differentiatingLabels.length > 0 ? (
                                <span className="font-medium text-ink-secondary">
                                  {differentiatingLabels.join(" · ")}
                                </span>
                              ) : null}
                              {differentiatingLabels.length > 0 && remainingLabels.length > 0
                                ? " · "
                                : null}
                              {remainingLabels.length > 0 ? (
                                <span className="text-ink-muted">
                                  {remainingLabels.join(" · ")}
                                </span>
                              ) : null}
                            </span>
                          </span>
                          <span className="flex shrink-0 flex-col items-end gap-1 pt-0.5 text-xs">
                            {active ? (
                              <span
                                className="text-proof"
                                id={`${idPrefix}-picker-model-${actionIndex}-current`}
                              >
                                Current
                              </span>
                            ) : null}
                            {isPersonalDefault ? (
                              <span
                                className="text-ink-muted"
                                id={`${idPrefix}-picker-model-${actionIndex}-personal-default`}
                              >
                                My default
                              </span>
                            ) : null}
                            {isOrganizationDefault ? (
                              <span
                                className="text-ink-muted"
                                id={`${idPrefix}-picker-model-${actionIndex}-organization-default`}
                              >
                                Organization default
                              </span>
                            ) : null}
                            {active ? <Check className="size-4 text-proof" aria-hidden="true" /> : null}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              );
            })}
          </div>
          {onMakeCurrentDefault || onUseOrganizationDefault ? (
            <div className="mt-3 flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-trace-subtle pt-3">
              <p className="text-xs text-ink-muted">
                Choosing a model changes only the next run.
              </p>
              <div className="flex flex-wrap items-center gap-1.5">
                {currentModel && onMakeCurrentDefault && !(
                  currentModel.provider === catalog?.defaults.personalModelDefault?.provider &&
                  currentModel.modelId === catalog.defaults.personalModelDefault.modelId
                ) ? (
                  <button
                    className="inline-flex min-h-touch items-center rounded-control px-2.5 text-xs font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus sm:min-h-control"
                    onClick={onMakeCurrentDefault}
                    type="button"
                  >
                    Make current my default
                  </button>
                ) : null}
                {catalog?.defaults.hasPersonalModelDefault && onUseOrganizationDefault ? (
                  <button
                    className="inline-flex min-h-touch items-center rounded-control px-2.5 text-xs font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-focus sm:min-h-control"
                    onClick={onUseOrganizationDefault}
                    type="button"
                  >
                    Use organization default
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
        </>
      ) : null}
    </div>
  );
}
