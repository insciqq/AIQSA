import { ComposerModelPicker } from "@/components/app-shell/ComposerModelPicker";
import { ComposerOptionPicker } from "@/components/app-shell/ComposerOptionPicker";
import { ComposerPromptPicker } from "@/components/app-shell/ComposerPromptPicker";
import { ComposerRunProfiles } from "@/components/app-shell/ComposerRunProfiles";
import { formatTokenCount } from "@/components/app-shell/shellFormatting";
import {
  findActiveRunProfile,
  resolveRunProfiles,
  type RunProfileId
} from "@/components/app-shell/runProfiles";
import { useDialogFocus } from "@/components/app-shell/useDialogFocus";
import type { ComposerUsageStats } from "@/components/chat/Composer";
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
  MessageSquareText,
  Radio,
  ScrollText,
  Search as SearchIcon,
  SlidersHorizontal,
  Wrench,
  X
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

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
  const effortLabel = reasoningEffortLabel(effort);
  const modeLabel = mode === "pro" ? "Pro" : mode === "standard" ? "Standard" : reasoningEffortLabel(mode);
  return `${modeLabel} · ${effortLabel}`;
}

function compactSearchStrategyLabel(strategy: CatalogSearchStrategy | undefined): string | undefined {
  if (!strategy) {
    return undefined;
  }

  return strategy.kind === "none" ? "Off" : strategy.displayName;
}

function narrowSearchStrategyLabel(strategy: CatalogSearchStrategy | undefined): string | undefined {
  if (!strategy) {
    return undefined;
  }

  const labels: Record<CatalogSearchStrategy["kind"], string> = {
    gemini_google_search: "Google",
    none: "Off",
    openai_native_web_search: "Web",
    perplexity_tool_search: "Tool"
  };
  return labels[strategy.kind];
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

export function ComposerControls({
  backgroundMode,
  catalog,
  catalogUnavailable = false,
  compact = false,
  contextLine = null,
  currentModel,
  currentParameterControls,
  currentPrompt,
  disabled = false,
  maxOutputTokens,
  onBackgroundModeChange,
  onMaxOutputTokensChange,
  onMaxOutputTokensCommit,
  onOpenPromptLibrary,
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
  temperature,
  usageStats = null
}: {
  backgroundMode: boolean;
  catalog: Catalog | null;
  catalogUnavailable?: boolean;
  compact?: boolean;
  contextLine?: string | null;
  currentModel?: CatalogModel;
  currentParameterControls: ModelParameterControls;
  currentPrompt: PromptPreset | null;
  disabled?: boolean;
  maxOutputTokens: string;
  onBackgroundModeChange(value: boolean): void;
  onMaxOutputTokensChange(value: string): void;
  onMaxOutputTokensCommit?(): void;
  onOpenPromptLibrary(): void;
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
  usageStats?: ComposerUsageStats | null;
}) {
  const runSetupTriggerRef = useRef<HTMLButtonElement>(null);
  const [inlineModelPickerOpen, setInlineModelPickerOpen] = useState(false);
  const [setupModelPickerOpen, setSetupModelPickerOpen] = useState(false);
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
  const hasConfiguredProfiles = resolvedProfiles.length > 0;
  const hasAvailableProfiles = resolvedProfiles.some((profile) => profile.available);
  const activeProfile = findActiveRunProfile(resolvedProfiles, {
    modelId: selectedModelId,
    provider: selectedProvider,
    reasoningEffort,
    reasoningMode
  });
  const profileLabel = hasAvailableProfiles ? (activeProfile?.label ?? "Custom") : null;
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
  const contextStats = usageStats ?? {
    activeBranchMessageCount: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 0
  };
  const summaryDescription = [
    "Open more run settings.",
    profileLabel ? `Profile ${profileLabel}.` : null,
    `Model ${modelLabel}.`,
    `Reasoning ${
      reasoningSupported ? reasoningAccessibleDescription(reasoningEffort, reasoningMode) : "not supported"
    }.`,
    `Search ${searchSummary}.`
  ].filter((segment): segment is string => segment !== null).join(" ");

  const commitNumericDrafts = useCallback(() => {
    onTemperatureCommit?.();
    if (onMaxOutputTokensCommit !== onTemperatureCommit) {
      onMaxOutputTokensCommit?.();
    }
  }, [onMaxOutputTokensCommit, onTemperatureCommit]);

  const closeRunSetup = useCallback(() => {
    commitNumericDrafts();
    setSetupModelPickerOpen(false);
    setRunSetupOpen(false);
  }, [commitNumericDrafts]);
  const runSetupDialogRef = useDialogFocus<HTMLDivElement>({
    active: runSetupOpen,
    containFocus: true,
    onClose: closeRunSetup,
    restoreFocus: () => runSetupTriggerRef.current
  });

  useEffect(() => {
    if (!disabled || !runSetupOpen) {
      return;
    }
    const timer = window.setTimeout(closeRunSetup, 0);
    return () => window.clearTimeout(timer);
  }, [closeRunSetup, disabled, runSetupOpen]);

  return (
    <div
      className="relative flex min-w-0 flex-1 flex-wrap items-center gap-1.5"
      data-density={compact ? "prompt-first" : "thread-tail"}
      data-layout="direct"
      data-testid="composer-control-bar"
    >
      <ComposerModelPicker
        catalog={catalog}
        catalogUnavailable={catalogUnavailable}
        className="max-w-full flex-[1_1_100%] sm:flex-[0_0_20rem]"
        currentModel={currentModel}
        disabled={disabled}
        idPrefix="composer-inline-model"
        open={inlineModelPickerOpen}
        pickerTestId="composer-inline-model-picker"
        selectedModelId={selectedModelId}
        selectedProvider={selectedProvider}
        selectedProviderName={selectedProviderName}
        streaming={streaming}
        valueTestId="run-model-summary"
        onOpenChange={setInlineModelPickerOpen}
        onSelectModel={onSelectModel}
      />

      <div
        className="flex min-w-0 flex-[999_1_20rem] items-center gap-0.5 min-[430px]:gap-1"
        data-testid="composer-secondary-controls"
      >
        {hasAvailableProfiles ? (
          <ComposerRunProfiles
            catalog={catalog}
            compact
            disabled={disabled || streaming}
            reasoningEffort={reasoningEffort}
            reasoningMode={reasoningMode}
            selectedModelId={selectedModelId}
            selectedProvider={selectedProvider}
            testId="composer-inline-run-profiles"
            onSelect={onRunProfileChange}
          />
        ) : null}

        <ComposerOptionPicker
          align="right"
          className="min-w-20 max-w-[10rem] flex-[1_1_5rem] min-[430px]:min-w-[5.5rem] min-[430px]:flex-[1_1_5.5rem]"
          compactResting
          id="composer-inline-search"
          icon={<SearchIcon className="hidden size-3.5 shrink-0 text-ink-muted max-[429px]:block" aria-hidden="true" />}
          label="Search strategy"
          restingLabel="Search"
          restingLabelClassName="max-[429px]:sr-only"
          narrowSummaryLabel={narrowSearchStrategyLabel(currentSearchStrategy)}
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

        <button
          ref={runSetupTriggerRef}
          className="inline-flex min-h-touch min-w-touch shrink-0 items-center justify-center gap-1 rounded-control px-1.5 text-left text-xs font-medium text-ink-secondary outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-65 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch"
          type="button"
          aria-label={summaryDescription}
          aria-controls="composer-run-setup-panel"
          aria-expanded={runSetupOpen}
          aria-haspopup="dialog"
          data-testid="composer-run-summary"
          disabled={disabled}
          title="More run settings"
          onClick={() => {
            if (runSetupOpen) {
              closeRunSetup();
              return;
            }
            setInlineModelPickerOpen(false);
            setRunSetupOpen(true);
          }}
        >
          <SlidersHorizontal className="size-3.5 shrink-0 text-ink-muted" aria-hidden="true" />
          <span className="sr-only">
            {modelLabel}. {profileLabel ? `Profile: ${profileLabel}. ` : ""}Search: {searchSummary}.
          </span>
          <span className="hidden shrink-0 min-[430px]:inline">More</span>
          <span
            className="hidden"
            data-testid="run-reasoning-summary"
          >
            Reasoning: {reasoningSummary}
          </span>
        </button>
      </div>

      {profileLabel ? (
        <span className="sr-only" data-testid="run-profile-summary">Profile: {profileLabel}</span>
      ) : null}
      <span className="sr-only" data-testid="run-search-summary">Search: {searchSummary}</span>

      {runSetupOpen ? (
        <>
          <div
            className="fixed inset-0 z-[60] bg-scrim/55"
            data-testid="run-setup-backdrop"
            role="presentation"
            onMouseDown={closeRunSetup}
          />
          <div
            ref={runSetupDialogRef}
            className="pop-enter fixed inset-x-0 bottom-0 z-[70] flex max-h-[calc(100dvh-max(.5rem,env(safe-area-inset-top)))] flex-col overflow-hidden rounded-t-panel border-t border-trace-subtle bg-overlay-surface pb-[env(safe-area-inset-bottom)] shadow-overlay sm:inset-x-auto sm:bottom-auto sm:left-1/2 sm:top-1/2 sm:max-h-[calc(100dvh-2rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] sm:w-[min(44rem,calc(100vw-2rem))] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-panel sm:border [@media(max-height:32rem)]:!top-[max(.5rem,env(safe-area-inset-top))] [@media(max-height:32rem)]:!max-h-[calc(100dvh-1rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] [@media(max-height:32rem)]:!translate-y-0"
            data-testid="run-setup-sheet"
            id="composer-run-setup-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="run-setup-title"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            <header className="flex min-h-touch shrink-0 items-center justify-between gap-3 border-b border-trace-subtle px-4 py-2 sm:px-5">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-ink" id="run-setup-title">
                  Run setup
                </h2>
                <p className="mt-0.5 text-xs text-ink-muted">Everything for the next answer, in one place.</p>
              </div>
              <button
                className="grid size-11 shrink-0 place-items-center rounded-control text-ink-muted outline-none hover:bg-control-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-proof/55"
                type="button"
                aria-label="Close run setup"
                onClick={closeRunSetup}
              >
                <X className="size-4" aria-hidden="true" />
              </button>
            </header>

            <div
              className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4 sm:px-5"
              data-testid="run-setup-content"
            >
              {hasConfiguredProfiles ? (
                <section aria-labelledby="run-profile-heading">
                  <div className="mb-2">
                    <h3 className="text-xs font-semibold text-ink-secondary" id="run-profile-heading">Profile</h3>
                    <p className="mt-0.5 text-xs text-ink-muted">A quick starting point; every value below remains editable.</p>
                  </div>
                  <ComposerRunProfiles
                    catalog={catalog}
                    disabled={disabled || streaming}
                    reasoningEffort={reasoningEffort}
                    reasoningMode={reasoningMode}
                    selectedModelId={selectedModelId}
                    selectedProvider={selectedProvider}
                    onSelect={onRunProfileChange}
                  />
                </section>
              ) : null}

              <section
                className={hasConfiguredProfiles ? "mt-5 border-t border-trace-subtle pt-4" : undefined}
                aria-labelledby="run-essentials-heading"
              >
                <h3 className="mb-2 text-xs font-semibold text-ink-secondary" id="run-essentials-heading">Answer setup</h3>
                <div className="grid min-w-0 gap-2 sm:grid-cols-3">
                  <ComposerModelPicker
                    catalog={catalog}
                    catalogUnavailable={catalogUnavailable}
                    currentModel={currentModel}
                    disabled={disabled}
                    nestedInRunSetup
                    open={setupModelPickerOpen}
                    selectedModelId={selectedModelId}
                    selectedProvider={selectedProvider}
                    selectedProviderName={selectedProviderName}
                    streaming={streaming}
                    onOpenChange={setSetupModelPickerOpen}
                    onSelectModel={onSelectModel}
                  />

                  <ComposerOptionPicker
                    accessibleDescription={reasoningSupported ? reasoningAccessibleDescription(reasoningEffort, reasoningMode) : undefined}
                    id="composer-reasoning-effort"
                    label="Reasoning effort"
                    restingLabel="Reasoning"
                    disabled={disabled || streaming || !reasoningSupported}
                    options={reasoningOptions}
                    defaultValue={currentParameterControls.reasoningEffort.defaultValue}
                    placement="below"
                    resting
                    summaryLabel={reasoningSupported ? compactReasoningLabel(reasoningEffort, reasoningMode) : undefined}
                    value={reasoningEffort}
                    onChange={onReasoningEffortChange}
                  />

                  <ComposerOptionPicker
                    align="right"
                    id="search-select"
                    label="Search strategy"
                    restingLabel="Search"
                    disabled={disabled || !currentModel || streaming}
                    options={searchOptions.map((strategy) => ({
                      description: searchStrategyDescription(strategy),
                      label: strategy.displayName,
                      value: strategy.strategyId
                    }))}
                    defaultValue={catalog?.defaults.searchStrategyId}
                    placement="below"
                    resting
                    summaryLabel={compactSearchStrategyLabel(currentSearchStrategy)}
                    value={selectedSearchStrategy}
                    onChange={onSearchStrategyChange}
                  />
                </div>
              </section>

              <div data-testid="run-setup-advanced">
                <section className="mt-5 border-t border-trace-subtle pt-4" aria-labelledby="run-prompt-heading">
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <h3 className="text-xs font-semibold text-ink-secondary" id="run-prompt-heading">Prompt preset</h3>
                    <button
                      className="inline-flex h-touch shrink-0 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-proof/55 sm:h-control-sm [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                      type="button"
                      onClick={() => {
                        closeRunSetup();
                        window.setTimeout(onOpenPromptLibrary, 0);
                      }}
                    >
                      <ScrollText className="size-3.5" aria-hidden="true" />
                      Open library
                    </button>
                  </div>
                  <ComposerPromptPicker
                    currentPrompt={currentPrompt}
                    disabled={!catalog || streaming}
                    prompts={catalog?.promptPresets ?? []}
                    icon={<ScrollText className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />}
                    selectedPromptId={selectedPromptId}
                    onChange={onPromptChange}
                  />
                </section>

                <section className="mt-5 border-t border-trace-subtle pt-4" aria-labelledby="run-generation-heading">
                  <h3 className="mb-2 text-xs font-semibold text-ink-secondary" id="run-generation-heading">Generation</h3>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="min-w-0 text-xs text-ink-secondary">
                      <span className="mb-1.5 block">Temperature</span>
                      <input
                        className="h-touch w-full min-w-0 rounded-control border border-trace-subtle bg-answer-paper px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
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
                    <label className="min-w-0 text-xs text-ink-secondary">
                      <span className="mb-1.5 block">Max output tokens</span>
                      <input
                        className="h-touch w-full min-w-0 rounded-control border border-trace-subtle bg-answer-paper px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
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
                    <label className="mt-3 block text-xs text-ink-secondary">
                      <span className="mb-1.5 block">Reasoning mode</span>
                      <select
                        className="h-touch w-full rounded-control border border-trace-subtle bg-answer-paper px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
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
                      <span className="mt-1.5 block text-ink-muted">
                        Pro can spend more time and tokens to improve difficult answers.
                      </span>
                    </label>
                  ) : null}
                </section>

                <section className="mt-5 border-t border-trace-subtle pt-4" aria-labelledby="run-context-heading">
                  <h3 className="text-xs font-semibold text-ink-secondary" id="run-context-heading">Context and usage</h3>
                  <p className="mt-1 break-words font-mono text-xs leading-5 text-ink [overflow-wrap:anywhere]">
                    {contextLine ?? "Context estimate unavailable"}
                  </p>
                  <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-3">
                    <div className="rounded-control bg-control-surface px-3 py-2">
                      <dt className="text-ink-muted">Messages</dt>
                      <dd className="mt-1 font-mono font-medium text-ink">{contextStats.activeBranchMessageCount}</dd>
                    </div>
                    <div className="rounded-control bg-control-surface px-3 py-2">
                      <dt className="text-ink-muted">Provider-reported tokens</dt>
                      <dd className="mt-1 font-mono font-medium text-ink">{formatTokenCount(contextStats.totalTokens)}</dd>
                    </div>
                    <div className="rounded-control bg-control-surface px-3 py-2">
                      <dt className="text-ink-muted">Cached input tokens</dt>
                      <dd className="mt-1 font-mono font-medium text-ink">{formatTokenCount(contextStats.cachedInputTokens)}</dd>
                    </div>
                  </dl>
                </section>

                {currentParameterControls.background.supported || currentParameterControls.stream.supported ? (
                  <section className="mt-5 border-t border-trace-subtle pt-4" aria-labelledby="run-request-heading">
                    <h3 className="text-xs font-semibold text-ink-secondary" id="run-request-heading">Next run</h3>
                    <p className="mb-2 mt-0.5 text-xs text-ink-muted">Provider behavior applied when you send the next message.</p>
                    <div className="grid gap-2 sm:grid-cols-2">
                      {currentParameterControls.background.supported ? (
                        <ToggleSetting
                          active={backgroundMode}
                          disabled={streaming || !currentModel}
                          icon={<Activity className="size-4" aria-hidden="true" />}
                          label="Background mode"
                          title={backgroundMode ? "Background mode on" : "Background mode off"}
                          ariaLabel="Background mode"
                          onClick={() => onBackgroundModeChange(!backgroundMode)}
                        />
                      ) : null}
                      {currentParameterControls.stream.supported ? (
                        <ToggleSetting
                          active={streamMode}
                          disabled={streaming || !currentModel}
                          icon={<Radio className="size-4" aria-hidden="true" />}
                          label="Stream response"
                          title={streamMode ? "Streaming on" : "Streaming off"}
                          ariaLabel="Stream response"
                          onClick={() => onStreamModeChange(!streamMode)}
                        />
                      ) : null}
                    </div>
                  </section>
                ) : null}

                <section className="mt-5 border-t border-trace-subtle pt-4" aria-labelledby="run-display-heading">
                  <h3 className="text-xs font-semibold text-ink-secondary" id="run-display-heading">Display preferences</h3>
                  <p className="mb-2 mt-0.5 text-xs text-ink-muted">Changes how existing and future answers are presented.</p>
                  <div className="grid gap-2 sm:grid-cols-2">
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
                </section>
              </div>
            </div>
          </div>
        </>
      ) : null}
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
        "flex min-h-touch items-center gap-2 rounded-control px-3 text-left text-xs font-medium outline-none focus-visible:ring-2 focus-visible:ring-proof/55 disabled:cursor-not-allowed disabled:text-ink-disabled disabled:opacity-60 sm:min-h-control [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch",
        active
          ? "bg-control-selected text-ink"
          : "bg-control-surface text-ink-secondary hover:bg-control-hover hover:text-ink"
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
      <span className={active ? "text-proof" : "text-ink-muted"}>{active ? "On" : "Off"}</span>
    </button>
  );
}
