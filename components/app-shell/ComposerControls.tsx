import { ComposerModelPicker } from "@/components/app-shell/ComposerModelPicker";
import { ComposerOptionPicker } from "@/components/app-shell/ComposerOptionPicker";
import { ComposerPromptPicker } from "@/components/app-shell/ComposerPromptPicker";
import { ComposerRunProfiles } from "@/components/app-shell/ComposerRunProfiles";
import {
  findActiveRunProfile,
  resolveRunProfiles,
  type RunProfileId
} from "@/components/app-shell/runProfiles";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import type {
  Catalog,
  CatalogModel,
  CatalogSearchStrategy,
  ModelParameterControls,
  PromptPreset
} from "@/components/app-shell/types";
import {
  Activity,
  Bell,
  BellOff,
  BookOpen,
  Brain,
  ChevronRight,
  MessageSquareText,
  Radio,
  ScrollText,
  Settings,
  SlidersHorizontal,
  Wrench,
  X
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode
} from "react";

const reasoningEffortLabels: Record<string, string> = {
  high: "High",
  low: "Low",
  max: "Maximum",
  medium: "Medium",
  minimal: "Minimal",
  none: "None",
  xhigh: "Extra high"
};

function reasoningEffortLabel(value: string): string {
  return reasoningEffortLabels[value] ?? value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase());
}

function compactReasoningLabel(effort: string, mode: string): string {
  const effortLabel = effort === "max" ? "Max" : effort === "xhigh" ? "X-high" : reasoningEffortLabel(effort);
  return mode === "pro" ? `Pro · ${effortLabel}` : effortLabel;
}

function compactSearchStrategyLabel(strategy: CatalogSearchStrategy | undefined): string | undefined {
  if (!strategy) {
    return undefined;
  }

  switch (strategy.kind) {
    case "none":
      return "Off";
    case "openai_native_web_search":
      return "OpenAI";
    case "perplexity_tool_search":
      return "Perplexity";
  }
}

function reasoningAccessibleDescription(effort: string, mode: string): string {
  const modeLabel = mode === "pro" ? "Pro" : mode === "standard" ? "Standard" : reasoningEffortLabel(mode);
  return `${modeLabel} mode, ${reasoningEffortLabel(effort)} effort`;
}

function searchStrategyDescription(strategy: CatalogSearchStrategy): string {
  if (strategy.kind === "none") {
    return "Answer without web lookup";
  }
  if (strategy.kind.includes("native")) {
    return "Provider-native web search";
  }
  if (strategy.kind.includes("perplexity") || strategy.kind.includes("openrouter")) {
    return "Web search through the provider";
  }

  return strategy.kind.replaceAll("_", " ");
}

function profileMeterLevel(profileId: RunProfileId | undefined): number {
  if (profileId === "fast") {
    return 1;
  }
  if (profileId === "balanced") {
    return 2;
  }
  if (profileId === "deep") {
    return 3;
  }
  return 0;
}

function reasoningMeterLevel(effort: string, supported: boolean): number {
  if (!supported || effort === "none") {
    return 0;
  }
  if (effort === "minimal" || effort === "low") {
    return 1;
  }
  if (effort === "medium") {
    return 3;
  }
  if (effort === "high") {
    return 4;
  }
  if (effort === "xhigh" || effort === "max") {
    return 5;
  }
  return 2;
}

function Meter({ level, steps }: { level: number; steps: number }) {
  return (
    <span className="inline-flex h-3.5 items-end gap-0.5" aria-hidden="true">
      {Array.from({ length: steps }, (_, index) => (
        <span
          className={[
            "w-0.5 rounded-pill",
            index < level ? "bg-accent-cyan" : "bg-separator-strong",
            index === 0 ? "h-1" : index === 1 ? "h-1.5" : index === 2 ? "h-2" : index === 3 ? "h-2.5" : "h-3"
          ].join(" ")}
          key={index}
        />
      ))}
    </span>
  );
}

export function ComposerControls({
  backgroundMode,
  catalog,
  catalogUnavailable = false,
  currentModel,
  currentParameterControls,
  currentPrompt,
  disabled = false,
  maxOutputTokens,
  onBackgroundModeChange,
  onMaxOutputTokensChange,
  onMaxOutputTokensCommit,
  onOpenPromptSettings,
  onPromptChange,
  onReasoningEffortChange,
  onReasoningModeChange,
  onRunProfileChange,
  onSearchStrategyChange,
  onSelectModel,
  onStreamModeChange,
  onTemperatureChange,
  onTemperatureCommit,
  onToggleNotificationSound,
  onToggleCitations,
  onToggleReasoningBlocks,
  onToggleToolActivity,
  notificationSoundEnabled,
  reasoningEffort,
  reasoningMode,
  searchOptions,
  selectedModelId,
  selectedPromptId,
  selectedProvider,
  selectedProviderName,
  selectedSearchStrategy,
  showCitations,
  showReasoningBlocks,
  showToolActivity,
  streamMode,
  streaming,
  temperature
}: {
  backgroundMode: boolean;
  catalog: Catalog | null;
  catalogUnavailable?: boolean;
  currentModel?: CatalogModel;
  currentParameterControls: ModelParameterControls;
  currentPrompt: PromptPreset | null;
  disabled?: boolean;
  maxOutputTokens: string;
  onBackgroundModeChange(value: boolean): void;
  onMaxOutputTokensChange(value: string): void;
  onMaxOutputTokensCommit?(): void;
  onOpenPromptSettings(): void;
  onPromptChange(promptId: string): void;
  onReasoningEffortChange(value: string): void;
  onReasoningModeChange(value: string): void;
  onRunProfileChange(profileId: RunProfileId): void;
  onSearchStrategyChange(strategyId: string): void;
  onSelectModel(model: CatalogModel): void;
  onStreamModeChange(value: boolean): void;
  onTemperatureChange(value: string): void;
  onTemperatureCommit?(): void;
  onToggleNotificationSound(): void;
  onToggleCitations(): void;
  onToggleReasoningBlocks(): void;
  onToggleToolActivity(): void;
  notificationSoundEnabled: boolean;
  reasoningEffort: string;
  reasoningMode: string;
  searchOptions: CatalogSearchStrategy[];
  selectedModelId: string;
  selectedPromptId: string | null;
  selectedProvider: string;
  selectedProviderName: string;
  selectedSearchStrategy: string;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
  streamMode: boolean;
  streaming: boolean;
  temperature: string;
}) {
  const runSettingsBoundaryRef = useRef<HTMLDivElement>(null);
  const runSettingsTriggerRef = useRef<HTMLButtonElement>(null);
  const runSetupTriggerRef = useRef<HTMLButtonElement>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [runSettingsOpen, setRunSettingsOpen] = useState(false);
  const [runSetupOpen, setRunSetupOpen] = useState(false);
  const reasoningSupported = Boolean(currentModel && currentParameterControls.reasoningEffort.supported);
  const reasoningOptions = reasoningSupported
    ? (currentParameterControls.reasoningEffort.options.length > 0
        ? currentParameterControls.reasoningEffort.options
        : [currentParameterControls.reasoningEffort.defaultValue]
      ).map((option) => ({
        description: `${reasoningEffortLabel(option)} model reasoning effort`,
        label: reasoningEffortLabel(option),
        value: option
      }))
    : [
        {
          description: "The selected model does not expose reasoning effort.",
          label: "Not supported",
          value: reasoningEffort
        }
      ];
  const currentSearchStrategy = searchOptions.find((strategy) => strategy.strategyId === selectedSearchStrategy);
  const resolvedProfiles = resolveRunProfiles(catalog);
  const activeProfile = findActiveRunProfile(resolvedProfiles, {
    modelId: selectedModelId,
    provider: selectedProvider,
    reasoningEffort,
    reasoningMode
  });
  const profileLabel = activeProfile?.label ?? (resolvedProfiles.some((profile) => profile.available) ? "Custom" : "Unavailable");
  const modelLabel = currentModel
    ? currentModel.displayName
    : catalogUnavailable
      ? "Models unavailable"
      : catalog
        ? catalog.models.length > 0
          ? "Select model"
          : "No models available"
        : "Loading models";
  const reasoningSummary = reasoningSupported
    ? compactReasoningLabel(reasoningEffort, reasoningMode)
    : "Not supported";
  const searchSummary = compactSearchStrategyLabel(currentSearchStrategy) ?? "Unavailable";
  const summaryDescription = `Open run setup. Profile ${profileLabel}. Model ${modelLabel}. Reasoning ${
    reasoningSupported ? reasoningAccessibleDescription(reasoningEffort, reasoningMode) : "not supported"
  }. Search ${searchSummary}.`;

  const commitNumericDrafts = useCallback(() => {
    onTemperatureCommit?.();
    if (onMaxOutputTokensCommit !== onTemperatureCommit) {
      onMaxOutputTokensCommit?.();
    }
  }, [onMaxOutputTokensCommit, onTemperatureCommit]);

  const closeRunSettings = useCallback(() => {
    commitNumericDrafts();
    setRunSettingsOpen(false);
  }, [commitNumericDrafts]);
  const closeRunSetup = useCallback(() => {
    commitNumericDrafts();
    setModelPickerOpen(false);
    setRunSetupOpen(false);
  }, [commitNumericDrafts]);
  const runSettingsDialogRef = useDialogFocus<HTMLDivElement>({
    active: runSettingsOpen,
    containFocus: false,
    onClose: closeRunSettings
  });
  const runSetupDialogRef = useDialogFocus<HTMLDivElement>({
    active: runSetupOpen,
    containFocus: true,
    onClose: closeRunSetup,
    restoreFocus: () => runSetupTriggerRef.current
  });

  useEffect(() => {
    if (!disabled || (!runSettingsOpen && !runSetupOpen)) {
      return;
    }
    const timer = window.setTimeout(() => {
      if (runSettingsOpen) {
        closeRunSettings();
      }
      if (runSetupOpen) {
        closeRunSetup();
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [closeRunSettings, closeRunSetup, disabled, runSettingsOpen, runSetupOpen]);

  useEffect(() => {
    if (!runSettingsOpen) {
      return;
    }

    function handlePointerDown(event: MouseEvent) {
      if (runSettingsBoundaryRef.current && !runSettingsBoundaryRef.current.contains(event.target as Node)) {
        closeRunSettings();
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [closeRunSettings, runSettingsOpen]);

  useEffect(() => {
    if ((!runSetupOpen && !runSettingsOpen) || typeof window.matchMedia !== "function") {
      return;
    }

    const desktopControls = window.matchMedia("(min-width: 640px) and (min-height: 32.001rem)");
    function closeIncompatiblePresentation(matches: boolean) {
      if (matches && runSetupOpen) {
        closeRunSetup();
      } else if (!matches && runSettingsOpen) {
        closeRunSettings();
      }
    }

    closeIncompatiblePresentation(desktopControls.matches);
    function handleChange(event: MediaQueryListEvent) {
      closeIncompatiblePresentation(event.matches);
    }
    desktopControls.addEventListener("change", handleChange);
    return () => desktopControls.removeEventListener("change", handleChange);
  }, [closeRunSettings, closeRunSetup, runSettingsOpen, runSetupOpen]);

  return (
    <div
      className="relative"
      data-layout="focused"
      data-testid="composer-control-bar"
    >
      <button
        ref={runSetupTriggerRef}
        className="grid min-h-touch w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-control bg-surface-hover px-3 py-2 text-left text-content-primary outline-none hover:bg-surface-active focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-65 sm:hidden [@media(max-height:32rem)]:!grid"
        type="button"
        aria-label={summaryDescription}
        aria-controls="composer-run-setup-panel"
        aria-expanded={runSetupOpen}
        aria-haspopup="dialog"
        data-testid="composer-run-summary"
        disabled={disabled}
        onClick={() => {
          if (runSetupOpen) {
            closeRunSetup();
            return;
          }
          if (runSettingsOpen) {
            closeRunSettings();
          }
          setRunSetupOpen(true);
        }}
      >
        <span className="min-w-0">
          <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[11px] font-medium text-content-muted">Run</span>
            <span
              className="inline-flex min-w-0 items-center gap-1.5"
              data-level={profileMeterLevel(activeProfile?.id)}
              data-testid="run-profile-summary"
            >
              <Meter level={profileMeterLevel(activeProfile?.id)} steps={3} />
              <span className="text-xs font-medium">{profileLabel}</span>
            </span>
            <span
              className="inline-flex min-w-0 items-center gap-1.5"
              data-level={reasoningMeterLevel(reasoningEffort, reasoningSupported)}
              data-testid="run-reasoning-summary"
            >
              <Brain className="size-3.5 shrink-0 text-content-muted" aria-hidden="true" />
              <Meter level={reasoningMeterLevel(reasoningEffort, reasoningSupported)} steps={5} />
              <span className="text-xs font-medium">{reasoningSummary}</span>
            </span>
          </span>
          <span className="mt-1 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-start gap-3 text-xs text-content-secondary">
            <span className="min-w-0 break-words [overflow-wrap:anywhere]" data-testid="run-model-summary" title={modelLabel}>
              {modelLabel}
            </span>
            <span className="shrink-0" data-testid="run-search-summary">
              Search: <span className="font-medium text-content-primary">{searchSummary}</span>
            </span>
          </span>
        </span>
        <ChevronRight className="size-4 shrink-0 text-content-muted" aria-hidden="true" />
      </button>

      {runSetupOpen ? (
        <div
          className="fixed inset-0 z-[60] bg-scrim/55 backdrop-blur-sm sm:hidden [@media(max-height:32rem)]:!block"
          data-testid="run-setup-backdrop"
          role="presentation"
          onMouseDown={closeRunSetup}
        />
      ) : null}

      <div
        ref={runSetupDialogRef}
        className={[
          runSetupOpen
            ? "max-sm:fixed max-sm:inset-x-0 max-sm:bottom-0 max-sm:z-[70] max-sm:flex max-sm:max-h-[calc(100dvh-max(.5rem,env(safe-area-inset-top)))] max-sm:flex-col max-sm:overflow-hidden max-sm:rounded-t-panel max-sm:border-t max-sm:border-separator-subtle max-sm:bg-surface-overlay max-sm:pb-[env(safe-area-inset-bottom)] max-sm:shadow-overlay sm:block [@media(max-height:32rem)]:!fixed [@media(max-height:32rem)]:!inset-x-0 [@media(max-height:32rem)]:!bottom-0 [@media(max-height:32rem)]:!z-[70] [@media(max-height:32rem)]:!flex [@media(max-height:32rem)]:!max-h-[calc(100dvh-max(.5rem,env(safe-area-inset-top)))] [@media(max-height:32rem)]:!flex-col [@media(max-height:32rem)]:!overflow-hidden [@media(max-height:32rem)]:!rounded-t-panel [@media(max-height:32rem)]:!border-t [@media(max-height:32rem)]:!border-separator-subtle [@media(max-height:32rem)]:!bg-surface-overlay [@media(max-height:32rem)]:!pb-[env(safe-area-inset-bottom)] [@media(max-height:32rem)]:!shadow-overlay"
            : "max-sm:hidden sm:block [@media(max-height:32rem)]:!hidden"
        ].join(" ")}
        data-testid={runSetupOpen ? "run-setup-sheet" : undefined}
        id="composer-run-setup-panel"
        role={runSetupOpen ? "dialog" : undefined}
        aria-modal={runSetupOpen ? "true" : undefined}
        aria-labelledby={runSetupOpen ? "run-setup-title" : undefined}
        onKeyDown={
          runSetupOpen
            ? (event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }
            : undefined
        }
      >
        {runSetupOpen ? (
          <header className="flex min-h-touch shrink-0 items-center justify-between gap-3 border-b border-separator-subtle px-4 sm:hidden [@media(max-height:32rem)]:!flex">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold text-content-primary" id="run-setup-title">
                Run setup
              </h2>
              <p className="mt-0.5 text-xs text-content-muted">Changes apply to the next message.</p>
            </div>
            <button
              className="grid size-11 shrink-0 place-items-center rounded-control text-content-muted outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55"
              type="button"
              aria-label="Close run setup"
              onClick={closeRunSetup}
            >
              <X className="size-4" aria-hidden="true" />
            </button>
          </header>
        ) : null}

        <div
          className={runSetupOpen ? "max-sm:min-h-0 max-sm:flex-1 max-sm:overflow-y-auto max-sm:overscroll-contain max-sm:p-4 [@media(max-height:32rem)]:min-h-0 [@media(max-height:32rem)]:flex-1 [@media(max-height:32rem)]:overflow-y-auto [@media(max-height:32rem)]:overscroll-contain [@media(max-height:32rem)]:p-4" : undefined}
          data-testid={runSetupOpen ? "run-setup-content" : undefined}
        >
          <ComposerRunProfiles
            catalog={catalog}
            disabled={disabled || streaming}
            reasoningEffort={reasoningEffort}
            reasoningMode={reasoningMode}
            selectedModelId={selectedModelId}
            selectedProvider={selectedProvider}
            onSelect={onRunProfileChange}
          />
          <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(10.5rem,11.5rem)_minmax(9rem,10rem)_auto]">
        <ComposerModelPicker
          catalog={catalog}
          catalogUnavailable={catalogUnavailable}
          currentModel={currentModel}
          disabled={disabled}
          nestedInRunSetup={runSetupOpen}
          open={modelPickerOpen}
          selectedModelId={selectedModelId}
          selectedProvider={selectedProvider}
          selectedProviderName={selectedProviderName}
          streaming={streaming}
          onOpenChange={(open) => {
            if (open && runSettingsOpen) {
              closeRunSettings();
            }
            setModelPickerOpen(open);
          }}
          onSelectModel={onSelectModel}
        />

        <ComposerOptionPicker
          accessibleDescription={
            reasoningSupported ? reasoningAccessibleDescription(reasoningEffort, reasoningMode) : undefined
          }
          align="right"
          id="composer-reasoning-effort"
          className="min-w-0"
          label="Reasoning effort"
          restingLabel="Reasoning"
          disabled={disabled || streaming || !reasoningSupported}
          options={reasoningOptions}
          defaultValue={currentParameterControls.reasoningEffort.defaultValue}
          resting
          summaryLabel={reasoningSupported ? compactReasoningLabel(reasoningEffort, reasoningMode) : undefined}
          value={reasoningEffort}
          onChange={onReasoningEffortChange}
        />

        <ComposerOptionPicker
          align="right"
          id="search-select"
          className="min-w-0"
          label="Search strategy"
          restingLabel="Search"
          disabled={disabled || !currentModel || streaming}
          options={searchOptions.map((strategy) => ({
            description: searchStrategyDescription(strategy),
            label: strategy.displayName,
            value: strategy.strategyId
          }))}
          defaultValue={catalog?.defaults.searchStrategyId}
          resting
          summaryLabel={compactSearchStrategyLabel(currentSearchStrategy)}
          value={selectedSearchStrategy}
          onChange={onSearchStrategyChange}
        />

        <div className="relative max-sm:col-span-3 [@media(max-height:32rem)]:col-span-full" ref={runSettingsBoundaryRef}>
          <button
            ref={runSettingsTriggerRef}
            className="inline-flex h-touch items-center gap-2 rounded-control px-3 text-xs font-medium text-content-secondary outline-none hover:bg-surface-hover hover:text-content-primary focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-60 max-sm:hidden sm:h-control [@media(max-height:32rem)]:!hidden [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
            type="button"
            aria-label="Run settings"
            aria-controls="run-settings-panel"
            aria-expanded={runSettingsOpen}
            aria-haspopup="dialog"
            disabled={disabled}
            onClick={() => {
              if (runSettingsOpen) {
                closeRunSettings();
                return;
              }
              if (!runSettingsOpen && modelPickerOpen) {
                setModelPickerOpen(false);
              }
              setRunSettingsOpen(true);
            }}
          >
            <SlidersHorizontal className="size-4 text-content-muted" aria-hidden="true" />
            Run settings
          </button>
          {runSettingsOpen || runSetupOpen ? (
            <div
              ref={runSettingsDialogRef}
              className={
                runSetupOpen
                  ? "mt-4 max-h-none w-auto overflow-visible bg-transparent p-0"
                  : "pop-enter absolute bottom-12 right-0 z-40 max-h-[min(36rem,calc(100dvh-13rem))] w-[min(34rem,calc(100vw-2rem))] overflow-y-auto overscroll-contain rounded-panel border border-separator-subtle bg-surface-overlay p-4 shadow-overlay [@media(max-height:32rem)]:fixed [@media(max-height:32rem)]:!bottom-[max(0rem,env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!left-[max(.5rem,env(safe-area-inset-left))] [@media(max-height:32rem)]:!right-[max(.5rem,env(safe-area-inset-right))] [@media(max-height:32rem)]:!max-h-[calc(100dvh-.5rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!w-auto [@media(max-height:32rem)]:rounded-b-none"
              }
              data-testid={runSetupOpen ? "run-setup-advanced" : "run-settings-menu"}
              id={runSettingsOpen ? "run-settings-panel" : undefined}
              role={runSettingsOpen ? "dialog" : undefined}
              aria-modal={runSettingsOpen ? "false" : undefined}
              aria-labelledby={runSettingsOpen ? "run-settings-title" : "run-advanced-title"}
            >
              {runSetupOpen ? (
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-content-primary" id="run-advanced-title">
                      Advanced settings
                    </h3>
                    <p className="mt-1 max-w-md text-xs text-content-muted">
                      Prompt and generation settings apply to the next message. Display and sound preferences apply immediately.
                    </p>
                  </div>
                  <button
                    className="inline-flex h-touch shrink-0 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-content-secondary hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55"
                    type="button"
                    onClick={() => {
                      closeRunSetup();
                      window.setTimeout(onOpenPromptSettings, 0);
                    }}
                  >
                    <Settings className="size-3.5" aria-hidden="true" />
                    Manage prompts
                  </button>
                </div>
              ) : (
                <div>
                <div className="flex items-center justify-between gap-3">
                  <h2 className="text-sm font-semibold text-content-primary" id="run-settings-title">
                    Run settings
                  </h2>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      className="inline-flex h-touch shrink-0 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-content-secondary hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                      type="button"
                      onClick={() => {
                        closeRunSettings();
                        window.setTimeout(onOpenPromptSettings, 0);
                      }}
                    >
                      <Settings className="size-3.5" aria-hidden="true" />
                      Manage prompts
                    </button>
                    <button
                      className="grid size-11 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:size-8 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
                      type="button"
                      aria-label="Close run settings"
                      onClick={closeRunSettings}
                    >
                      <X className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <p className="mt-1 max-w-md text-xs text-content-muted">
                  Request settings apply to the next message. Display and sound preferences apply immediately.
                </p>
                </div>
              )}

              <section className="mt-4 border-t border-separator-subtle pt-4" aria-labelledby="run-prompt-heading">
                <h3 className="mb-2 text-xs font-medium text-content-secondary" id="run-prompt-heading">Prompt</h3>
                <div>
                  <ComposerPromptPicker
                    currentPrompt={currentPrompt}
                    disabled={!catalog || streaming}
                    prompts={catalog?.promptPresets ?? []}
                    icon={<ScrollText className="size-4 shrink-0 text-content-muted" aria-hidden="true" />}
                    selectedPromptId={selectedPromptId}
                    onChange={onPromptChange}
                  />
                </div>
              </section>

              <section className="mt-4 border-t border-separator-subtle pt-4" aria-labelledby="run-generation-heading">
                <h3 className="mb-2 text-xs font-medium text-content-secondary" id="run-generation-heading">Generation</h3>
                <div className="grid grid-cols-2 gap-2">
                  <label className="min-w-0 text-xs text-content-secondary">
                    <span className="mb-1.5 block">Temperature</span>
                    <input
                      className="h-touch w-full min-w-0 rounded-control border border-separator-subtle bg-surface-thread px-3 text-sm text-content-primary outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                      type="number"
                      step="0.1"
                      aria-label="Temperature"
                      max={currentParameterControls.temperature.maxValue}
                      min={currentParameterControls.temperature.minValue}
                      disabled={streaming || !currentModel || !currentParameterControls.temperature.supported}
                      value={temperature}
                      onChange={(event) => onTemperatureChange(event.target.value)}
                      onBlur={onTemperatureCommit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </label>
                  <label className="min-w-0 text-xs text-content-secondary">
                    <span className="mb-1.5 block">Max output tokens</span>
                    <input
                      className="h-touch w-full min-w-0 rounded-control border border-separator-subtle bg-surface-thread px-3 text-sm text-content-primary outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                      type="number"
                      aria-label="Max output tokens"
                      disabled={streaming || !currentModel}
                      max={currentParameterControls.maxOutputTokens.maxValue}
                      min={1}
                      value={maxOutputTokens}
                      onChange={(event) => onMaxOutputTokensChange(event.target.value)}
                      onBlur={onMaxOutputTokensCommit}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                    />
                  </label>
                </div>
                {currentParameterControls.reasoningMode?.supported ? (
                  <label className="mt-3 block text-xs text-content-secondary">
                    <span className="mb-1.5 block">Reasoning mode</span>
                    <select
                      className="h-touch w-full rounded-control border border-separator-subtle bg-surface-thread px-3 text-sm text-content-primary outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                      aria-label="Reasoning mode"
                      disabled={streaming || !currentModel}
                      value={reasoningMode}
                      onChange={(event) => onReasoningModeChange(event.target.value)}
                    >
                      {currentParameterControls.reasoningMode.options.map((mode) => (
                        <option key={mode} value={mode}>
                          {mode === "pro" ? "Pro" : mode === "standard" ? "Standard" : reasoningEffortLabel(mode)}
                        </option>
                      ))}
                    </select>
                    <span className="mt-1.5 block text-content-muted">
                      Pro can spend more time and tokens to improve difficult answers.
                    </span>
                  </label>
                ) : null}
              </section>

              <section className="mt-4 border-t border-separator-subtle pt-4" aria-labelledby="run-behavior-heading">
                <h3 className="mb-2 text-xs font-medium text-content-secondary" id="run-behavior-heading">Response behavior</h3>
                <ToggleSettings
                  backgroundMode={backgroundMode}
                  backgroundSupported={currentParameterControls.background.supported}
                  notificationSoundEnabled={notificationSoundEnabled}
                  showCitations={showCitations}
                  showReasoningBlocks={showReasoningBlocks}
                  showToolActivity={showToolActivity}
                  streamMode={streamMode}
                  streamSupported={currentParameterControls.stream.supported}
                  streaming={streaming || !currentModel}
                  onBackgroundModeChange={onBackgroundModeChange}
                  onStreamModeChange={onStreamModeChange}
                  onToggleCitations={onToggleCitations}
                  onToggleNotificationSound={onToggleNotificationSound}
                  onToggleReasoningBlocks={onToggleReasoningBlocks}
                  onToggleToolActivity={onToggleToolActivity}
                />
              </section>
            </div>
          ) : null}
        </div>
      </div>
        </div>
      </div>
    </div>
  );
}

function ToggleSettings({
  backgroundMode,
  backgroundSupported,
  notificationSoundEnabled,
  onBackgroundModeChange,
  onStreamModeChange,
  onToggleCitations,
  onToggleNotificationSound,
  onToggleReasoningBlocks,
  onToggleToolActivity,
  showCitations,
  showReasoningBlocks,
  showToolActivity,
  streamMode,
  streamSupported,
  streaming
}: {
  backgroundMode: boolean;
  backgroundSupported: boolean;
  notificationSoundEnabled: boolean;
  onBackgroundModeChange(value: boolean): void;
  onStreamModeChange(value: boolean): void;
  onToggleCitations(): void;
  onToggleNotificationSound(): void;
  onToggleReasoningBlocks(): void;
  onToggleToolActivity(): void;
  showCitations: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
  streamMode: boolean;
  streamSupported: boolean;
  streaming: boolean;
}) {
  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {backgroundSupported ? (
        <ToggleSetting
          active={backgroundMode}
          disabled={streaming}
          icon={<Activity className="size-4" aria-hidden="true" />}
          label="Background mode"
          title={backgroundMode ? "Background mode on" : "Background mode off"}
          ariaLabel="Background mode"
          onClick={() => onBackgroundModeChange(!backgroundMode)}
        />
      ) : null}
      {streamSupported ? (
        <ToggleSetting
          active={streamMode}
          disabled={streaming}
          icon={<Radio className="size-4" aria-hidden="true" />}
          label="Stream response"
          title={streamMode ? "Streaming on" : "Streaming off"}
          ariaLabel="Stream response"
          onClick={() => onStreamModeChange(!streamMode)}
        />
      ) : null}
      <ToggleSetting
        active={showCitations}
        icon={<BookOpen className="size-4" aria-hidden="true" />}
        label="Show citations"
        title={showCitations ? "Hide citations" : "Show citations"}
        ariaLabel={showCitations ? "Hide citations" : "Show citations"}
        onClick={onToggleCitations}
      />
      <ToggleSetting
        active={showReasoningBlocks}
        icon={<MessageSquareText className="size-4" aria-hidden="true" />}
        label="Show reasoning"
        title={showReasoningBlocks ? "Hide reasoning blocks" : "Show reasoning blocks"}
        ariaLabel={showReasoningBlocks ? "Hide reasoning blocks" : "Show reasoning blocks"}
        onClick={onToggleReasoningBlocks}
      />
      <ToggleSetting
        active={showToolActivity}
        icon={<Wrench className="size-4" aria-hidden="true" />}
        label="Show tool activity"
        title={showToolActivity ? "Hide tool activity" : "Show tool activity"}
        ariaLabel={showToolActivity ? "Hide tool activity" : "Show tool activity"}
        onClick={onToggleToolActivity}
      />
      <ToggleSetting
        active={notificationSoundEnabled}
        icon={notificationSoundEnabled ? <Bell className="size-4" aria-hidden="true" /> : <BellOff className="size-4" aria-hidden="true" />}
        label="Answer sound"
        title={notificationSoundEnabled ? "Mute answer sound" : "Enable answer sound"}
        ariaLabel={notificationSoundEnabled ? "Mute answer sound" : "Enable answer sound"}
        onClick={onToggleNotificationSound}
      />
    </div>
  );
}

function ToggleSetting({
  active,
  ariaLabel,
  disabled = false,
  icon,
  label,
  onClick,
  title
}: {
  active: boolean;
  ariaLabel: string;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick(): void;
  title: string;
}) {
  return (
    <button
      className={[
        "flex min-h-touch items-center gap-2 rounded-control px-3 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:text-content-disabled disabled:opacity-60 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch",
        active
          ? "bg-surface-selected text-content-primary"
          : "bg-surface-thread text-content-secondary hover:bg-surface-hover hover:text-content-primary"
      ].join(" ")}
      type="button"
      aria-pressed={active}
      aria-label={ariaLabel}
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={active ? "text-accent-cyan" : "text-content-muted"}>{active ? "On" : "Off"}</span>
    </button>
  );
}
