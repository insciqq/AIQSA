import { Composer, type ComposerAttachment } from "@/components/chat/Composer";
import { attachmentPolicyForModel } from "@/components/app-shell/attachmentCapabilities";
import { ComposerControls } from "@/components/app-shell/ComposerControls";
import { McpComposerSummary } from "@/components/app-shell/McpComposerSummary";
import { ComposerRunProfiles } from "@/components/app-shell/ComposerRunProfiles";
import { useCompactComposerReadingMode } from "@/components/app-shell/useCompactComposerReadingMode";
import { ThreadMessageRow } from "@/components/app-shell/ThreadMessageRow";
import type { PipelineSnapshot } from "@/components/app-shell/runState";
import { resolveRunProfiles, type RunProfileId } from "@/components/app-shell/runProfiles";
import type { InspectorTabId } from "@/components/inspector/InspectorTabs";
import type {
  Catalog,
  CatalogModel,
  CatalogSearchStrategy,
  ChatUsageStats,
  ModelParameterControls,
  PromptPreset,
  ThreadArtifactSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import { ArrowDown, CircleAlert, Copy, GitBranch, LoaderCircle, RotateCcw } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useMemo } from "react";

const noRunWarnings: string[] = [];

export type RunWarning = {
  runId: string;
  text: string;
};

export type MainThreadPaneComposerActions = {
  cancelMessageEdit(): void;
  changeDraft(value: string): void;
  rejectAttachments(fileNames: readonly string[]): void;
  removeAttachment(attachmentId: string): void;
};

export type MainThreadPaneProps = {
  activeChatDetailError: string | null;
  activeChatDetailLoading: boolean;
  activeChatId: string | null;
  activeChatStreaming: boolean;
  attachments: ComposerAttachment[];
  backgroundMode: boolean;
  catalog: Catalog | null;
  catalogError: string | null;
  changeBackgroundMode(value: boolean): void;
  changeMaxOutputTokens(value: string): void;
  changeReasoningEffort(value: string): void;
  changeReasoningMode(value: string): void;
  changeStreamMode(value: boolean): void;
  changeTemperature(value: string): void;
  composerContextLine: string | null;
  composerDisabledHint: string | null;
  composerSessionKey: string;
  composerActions: MainThreadPaneComposerActions;
  composerUsageStats: ChatUsageStats | null;
  copyVisibleThread(): Promise<void> | void;
  creatingChat: boolean;
  currentModel: CatalogModel | undefined;
  currentParameterControls: ModelParameterControls;
  currentPrompt: PromptPreset | null;
  currentRunId: string | null;
  draft: string;
  editingMessageId: string | null;
  editingMessagePending: boolean;
  flushPendingModelControlDefaults(): void;
  handleBranchFromMessage(messageId: string): void;
  handleCopyMessage(message: ThreadMessage): void;
  handleDeleteMessage(messageId: string): void;
  handleEditMessage(message: ThreadMessage): void;
  handleRegenerateMessage(messageId: string): void;
  handleThreadScroll(): void;
  jumpToLatest(): void;
  liveArtifactSummary: ThreadArtifactSummary | null;
  maxOutputTokens: string;
  notificationSoundEnabled: boolean;
  operationError: string | null;
  openDetails(tab?: InspectorTabId): void;
  openMcpSettings?(): void;
  openSettings(): void;
  pipeline?: PipelineSnapshot | null;
  reasoningEffort: string;
  reasoningMode: string;
  retryActiveChatDetail(): void;
  retryCatalog(): void;
  retryWorkspace(): void;
  runWarnings?: RunWarning[];
  searchOptions: CatalogSearchStrategy[];
  selectModel(model: CatalogModel): void;
  selectPrompt(promptId: string): void;
  selectRunProfile(profileId: RunProfileId): void;
  selectSearchStrategy(strategyId: string): void;
  selectedModelId: string;
  selectedPromptId: string | null;
  selectedProvider: string;
  selectedProviderName: string;
  selectedSearchStrategy: string;
  showCitations: boolean;
  showJumpToLatest: boolean;
  showReasoningBlocks: boolean;
  showToolActivity: boolean;
  stopCurrentRun(): Promise<void> | void;
  streamMode: boolean;
  submitComposer(): Promise<void> | void;
  temperature: string;
  threadScrollRef: RefObject<HTMLDivElement | null>;
  noticeSlot?: ReactNode;
  toggleCitationsVisibility(): void;
  toggleNotificationSound(): void;
  toggleReasoningBlockVisibility(): void;
  toggleToolActivityVisibility(): void;
  uploadFiles(files: FileList | readonly File[]): Promise<void> | void;
  uploading: boolean;
  visibleMessages: ThreadMessage[];
  workspaceError: string | null;
  workspaceLoading: boolean;
  workspaceReady: boolean;
};

export function MainThreadPane({
  activeChatDetailError,
  activeChatDetailLoading,
  activeChatId,
  activeChatStreaming,
  attachments,
  backgroundMode,
  catalog,
  catalogError,
  changeBackgroundMode,
  changeMaxOutputTokens,
  changeReasoningEffort,
  changeReasoningMode,
  changeStreamMode,
  changeTemperature,
  composerContextLine,
  composerDisabledHint,
  composerSessionKey,
  composerActions,
  composerUsageStats,
  copyVisibleThread,
  creatingChat,
  currentModel,
  currentParameterControls,
  currentPrompt,
  currentRunId,
  draft,
  editingMessageId,
  editingMessagePending,
  flushPendingModelControlDefaults,
  handleBranchFromMessage,
  handleCopyMessage,
  handleDeleteMessage,
  handleEditMessage,
  handleRegenerateMessage,
  handleThreadScroll,
  jumpToLatest,
  liveArtifactSummary,
  maxOutputTokens,
  notificationSoundEnabled,
  operationError,
  openDetails,
  openMcpSettings,
  openSettings,
  pipeline = null,
  reasoningEffort,
  reasoningMode,
  retryActiveChatDetail,
  retryCatalog,
  retryWorkspace,
  runWarnings = [],
  searchOptions,
  selectModel,
  selectPrompt,
  selectRunProfile,
  selectSearchStrategy,
  selectedModelId,
  selectedPromptId,
  selectedProvider,
  selectedProviderName,
  selectedSearchStrategy,
  showCitations,
  showJumpToLatest,
  showReasoningBlocks,
  showToolActivity,
  stopCurrentRun,
  streamMode,
  submitComposer,
  temperature,
  threadScrollRef,
  noticeSlot,
  toggleCitationsVisibility,
  toggleNotificationSound,
  toggleReasoningBlockVisibility,
  toggleToolActivityVisibility,
  uploadFiles,
  uploading,
  visibleMessages,
  workspaceError,
  workspaceLoading,
  workspaceReady
}: MainThreadPaneProps) {
  const modelLabels = useMemo(
    () => {
      const providerLabels = new Map(
        (catalog?.providers ?? []).map((provider) => [provider.id, provider.name])
      );
      const labels = new Map<string, string>();
      const runtimeLabels = new Map<string, string | null>();

      for (const model of catalog?.models ?? []) {
        const label = `${providerLabels.get(model.provider) ?? "Provider"} / ${model.displayName}`;
        labels.set(`${model.provider}:${model.modelId}`, label);
        if (model.providerFamily && model.upstreamModelId) {
          const key = `${model.providerFamily}:${model.upstreamModelId}`;
          const existing = runtimeLabels.get(key);
          runtimeLabels.set(key, !runtimeLabels.has(key) || existing === label ? label : null);
        }
      }

      for (const [key, label] of runtimeLabels) {
        labels.set(key, label ?? "Model unavailable");
      }

      return labels;
    },
    [catalog]
  );
  const attachmentPolicy = useMemo(
    () => attachmentPolicyForModel(currentModel),
    [currentModel]
  );
  const compactRunProfilesAvailable = useMemo(
    () => resolveRunProfiles(catalog).some((profile) => profile.available),
    [catalog]
  );
  const runWarningsByRunId = useMemo(() => {
    const warnings = new Map<string, string[]>();
    for (const warning of runWarnings) {
      const current = warnings.get(warning.runId) ?? [];
      current.push(warning.text);
      warnings.set(warning.runId, current);
    }
    return warnings;
  }, [runWarnings]);

  const activeDisabledHint = creatingChat
    ? "Creating chat…"
    : catalogError
      ? "Models unavailable. Retry loading before sending."
      : !catalog
        ? "Loading models…"
        : !workspaceReady
          ? workspaceError
            ? "Workspace unavailable. Retry loading before sending."
            : "Loading workspace…"
          : activeChatDetailLoading
            ? "Loading conversation…"
            : activeChatDetailError
              ? "Conversation unavailable. Retry loading before sending."
              : composerDisabledHint;

  const composerUnavailable =
    creatingChat ||
    activeChatDetailLoading ||
    Boolean(activeChatDetailError) ||
    Boolean(catalogError) ||
    !catalog ||
    !workspaceReady ||
    !currentModel;
  const composerReadingForceExpanded =
    composerUnavailable ||
    Boolean(activeDisabledHint) ||
    draft.length > 0 ||
    attachments.length > 0 ||
    Boolean(editingMessageId) ||
    editingMessagePending ||
    uploading ||
    Boolean(operationError) ||
    (activeChatStreaming && !currentRunId);
  const {
    collapsed: composerReadingCollapsed,
    expand: expandComposerReadingMode,
    handleScroll: handleComposerReadingScroll,
    noteScrollIntent: noteComposerReadingScrollIntent
  } = useCompactComposerReadingMode({
    forceExpanded: composerReadingForceExpanded,
    resetKey: composerSessionKey
  });

  return (
    <section className="flex min-h-0 min-w-0 flex-col" data-testid="main-thread-pane">
      <div
        className="hidden h-10 shrink-0 items-center justify-end gap-1.5 border-b border-separator-subtle bg-surface-thread pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] lg:flex"
        aria-label="Chat actions"
        role="toolbar"
      >
          <button
            className="grid size-9 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 max-lg:size-11 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
            type="button"
            aria-label="Copy thread"
            title="Copy thread"
            onClick={() => void copyVisibleThread()}
          >
            <Copy className="size-3.5" aria-hidden="true" />
          </button>
          <button
            className="grid size-9 place-items-center rounded-control text-content-muted hover:bg-surface-hover hover:text-content-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-cyan/55 max-lg:size-11 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
            type="button"
            aria-label="Branch tree"
            title="Branch tree"
            onClick={() => openDetails("branch")}
          >
            <GitBranch className="size-3.5" aria-hidden="true" />
          </button>
      </div>

      {noticeSlot}

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={threadScrollRef}
          className="min-h-0 flex-1 overflow-y-auto overscroll-contain [overflow-anchor:none]"
          data-testid="thread"
          onScroll={(event) => {
            handleThreadScroll();
            handleComposerReadingScroll(event.currentTarget);
          }}
          onTouchMove={noteComposerReadingScrollIntent}
          onWheel={(event) => {
            if (event.deltaY !== 0) {
              noteComposerReadingScrollIntent();
            }
          }}
        >
          {catalogError ? (
            <div className="grid min-h-[260px] place-items-center px-4 py-10" data-testid="catalog-error-state" role="alert">
              <div className="w-full max-w-sm text-center">
                <div className="mx-auto grid size-10 place-items-center rounded-control bg-accent-rose/10 text-accent-rose">
                  <CircleAlert className="size-5" aria-hidden="true" />
                </div>
                <h2 className="mt-3 text-base font-semibold text-content-primary">Models didn&apos;t load</h2>
                <p className="mt-1 break-words text-sm leading-6 text-content-secondary [overflow-wrap:anywhere]">
                  {catalogError}
                </p>
                <button
                  className="mt-4 inline-flex h-touch items-center gap-2 rounded-control bg-surface-raised px-4 text-sm font-medium text-content-primary outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                  type="button"
                  aria-label="Retry loading models"
                  onClick={retryCatalog}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  Retry
                </button>
              </div>
            </div>
          ) : null}
          {workspaceError && !workspaceReady && !catalogError ? (
            <div className="grid min-h-[260px] place-items-center px-4 py-10" data-testid="workspace-error-state" role="alert">
              <div className="w-full max-w-sm text-center">
                <div className="mx-auto grid size-10 place-items-center rounded-control bg-accent-rose/10 text-accent-rose">
                  <CircleAlert className="size-5" aria-hidden="true" />
                </div>
                <h2 className="mt-3 text-base font-semibold text-content-primary">Workspace didn&apos;t load</h2>
                <p className="mt-1 break-words text-sm leading-6 text-content-secondary [overflow-wrap:anywhere]">
                  {workspaceError}
                </p>
                <button
                  className="mt-4 inline-flex h-touch items-center gap-2 rounded-control bg-surface-raised px-4 text-sm font-medium text-content-primary outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-cyan/55 disabled:cursor-not-allowed disabled:opacity-60 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                  type="button"
                  aria-label="Retry loading workspace"
                  disabled={workspaceLoading}
                  onClick={retryWorkspace}
                >
                  <RotateCcw className={`size-3.5 ${workspaceLoading ? "animate-spin" : ""}`} aria-hidden="true" />
                  {workspaceLoading ? "Retrying…" : "Retry"}
                </button>
              </div>
            </div>
          ) : null}
          {!catalog && !catalogError ? (
            <div className="grid min-h-[260px] place-items-center px-4 py-10 text-center" data-testid="catalog-loading-state" role="status">
              <div>
                <LoaderCircle className="mx-auto size-6 animate-spin text-accent-cyan" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-content-secondary">Loading models and prompts…</p>
              </div>
            </div>
          ) : null}
          {catalog && !workspaceReady && workspaceLoading && !workspaceError && !catalogError ? (
            <div className="grid min-h-[260px] place-items-center px-4 py-10 text-center" data-testid="workspace-loading-state" role="status">
              <div>
                <LoaderCircle className="mx-auto size-6 animate-spin text-accent-cyan" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-content-secondary">Loading workspace…</p>
              </div>
            </div>
          ) : null}
          {catalog && activeChatDetailLoading && workspaceReady && !catalogError && !workspaceError ? (
            <div
              aria-label="Loading chat"
              className="px-2 py-8 sm:px-4"
              data-testid="thread-loading-skeleton"
              role="status"
            >
              <div className="mx-auto w-full max-w-reading space-y-8">
                {[0, 1].map((turn) => (
                  <div className="space-y-5" key={turn}>
                    <div className="skeleton-block ml-auto h-12 w-3/5 rounded-bubble" />
                    <div className="space-y-2.5">
                      <div className="skeleton-block h-3 w-28" />
                      <div className="skeleton-block h-3.5 w-full" />
                      <div className="skeleton-block h-3.5 w-11/12" />
                      <div className="skeleton-block h-3.5 w-3/5" />
                    </div>
                  </div>
                ))}
              </div>
              <span className="sr-only">Loading chat</span>
            </div>
          ) : null}
          {catalog && workspaceReady && activeChatDetailError && !activeChatDetailLoading && !catalogError && !workspaceError ? (
            <div className="grid min-h-[260px] place-items-center px-4 py-10" data-testid="thread-detail-error" role="alert">
              <div className="w-full max-w-sm text-center">
                <div className="mx-auto grid size-10 place-items-center rounded-control bg-accent-rose/10 text-accent-rose">
                  <CircleAlert className="size-5" aria-hidden="true" />
                </div>
                <h2 className="mt-3 text-base font-semibold text-content-primary">This conversation didn&apos;t load</h2>
                <p className="mt-1 break-words text-sm leading-6 text-content-secondary [overflow-wrap:anywhere]">
                  {activeChatDetailError}
                </p>
                <button
                  className="mt-4 inline-flex h-touch items-center gap-2 rounded-control bg-surface-raised px-4 text-sm font-medium text-content-primary outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                  type="button"
                  aria-label="Retry loading chat"
                  onClick={retryActiveChatDetail}
                >
                  <RotateCcw className="size-3.5" aria-hidden="true" />
                  Retry
                </button>
              </div>
            </div>
          ) : null}
          {visibleMessages.length === 0 &&
          Boolean(catalog) &&
          workspaceReady &&
          !activeChatDetailLoading &&
          !activeChatDetailError &&
          !catalogError &&
          !workspaceError ? (
            <div className="grid min-h-[300px] place-items-center px-4 py-10" data-testid="thread-empty-state">
              {catalog && catalog.models.length === 0 ? (
                <div className="w-full max-w-reading" data-testid="no-model-empty-state">
                  <p className="text-xs font-medium text-content-muted">Model access required</p>
                  <h2 className="mt-2 max-w-xl text-xl font-semibold leading-8 text-content-primary">
                    This workspace has no models available yet.
                  </h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-content-secondary">
                    An administrator needs to grant model access before you can send a question. Your chats,
                    folders, Settings, and Appearance remain available.
                  </p>
                </div>
              ) : (
                <div className="w-full max-w-reading">
                  <p className="text-xs font-medium text-content-muted">Start a conversation</p>
                  <h2 className="mt-2 max-w-xl text-xl font-semibold leading-8 text-content-primary">
                    Ask anything.
                  </h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-content-secondary">
                    Choose the model and search strategy below. Each run remains inspectable in Details.
                  </p>
                  <div
                    className="mt-5 flex flex-wrap items-center gap-2 text-xs text-content-muted"
                    aria-label="Question, optional Search, Answer"
                  >
                    <span className="font-medium text-content-primary">Question</span>
                    <span aria-hidden="true">→</span>
                    <span>Search when enabled</span>
                    <span aria-hidden="true">→</span>
                    <span className="font-medium text-content-primary">Answer</span>
                  </div>
                </div>
              )}
            </div>
          ) : null}
          {catalog &&
          workspaceReady &&
          !activeChatDetailLoading &&
          !activeChatDetailError &&
          !catalogError &&
          !workspaceError
            ? visibleMessages.map((message) => {
            const liveSummary =
              message.role === "assistant" && message.runId && message.runId === currentRunId
                ? liveArtifactSummary
                : null;
            const artifactSummary = liveSummary ?? message.artifactSummary;
            const answerModelLabel =
              message.role === "assistant" && (message.provider || message.modelId)
                ? modelLabels.get(`${message.provider ?? ""}:${message.modelId ?? ""}`) ?? "Model unavailable"
                : null;

            const justCompleted =
              message.role === "assistant" &&
              message.status === "complete" &&
              Boolean(currentRunId) &&
              message.runId === currentRunId;
            const isRunTail = message.role === "assistant" && message.id === visibleMessages.at(-1)?.id;
            const messageRunWarnings = message.runId
              ? runWarningsByRunId.get(message.runId) ?? noRunWarnings
              : noRunWarnings;
            const visibleRunActivity =
              isRunTail &&
              pipeline &&
              (activeChatStreaming || (pipeline.phase === "error" && message.status === "error"))
                ? pipeline
                : null;

            return (
              <ThreadMessageRow
                answerModelLabel={answerModelLabel}
                artifactSummary={artifactSummary}
                editPending={editingMessagePending}
                justCompleted={justCompleted}
                key={message.id}
                message={message}
                runActivity={visibleRunActivity}
                runWarnings={messageRunWarnings}
                showCitations={showCitations}
                showReasoningBlocks={showReasoningBlocks}
                showToolActivity={showToolActivity}
                streaming={activeChatStreaming}
                onBranchFromMessage={handleBranchFromMessage}
                onCopyMessage={handleCopyMessage}
                onDeleteMessage={handleDeleteMessage}
                onEditMessage={handleEditMessage}
                onRegenerateMessage={handleRegenerateMessage}
              />
            );
              })
            : null}
          {visibleMessages.at(-1)?.role === "assistant" && visibleMessages.at(-1)?.status === "streaming" ? (
            <div
              aria-hidden="true"
              data-thread-reading-spacer="true"
              data-testid="thread-reading-spacer"
            />
          ) : null}
          {catalog &&
          workspaceReady &&
          !activeChatDetailLoading &&
          !activeChatDetailError &&
          !catalogError &&
          !workspaceError &&
          visibleMessages.at(-1)?.role === "assistant" &&
          visibleMessages.at(-1)?.status !== "streaming" ? (
            <div
              className={
                visibleMessages.at(-1)?.status === "complete"
                  ? "h-24 sm:h-32 [@media(max-height:32rem)]:!h-0"
                  : "h-16 sm:h-24 [@media(max-height:32rem)]:!h-0"
              }
              aria-hidden="true"
              data-status={visibleMessages.at(-1)?.status}
              data-testid={
                visibleMessages.at(-1)?.status === "complete"
                  ? "thread-complete-answer-spacer"
                  : "thread-terminal-answer-spacer"
              }
            />
          ) : null}
        </div>
        {showJumpToLatest ? (
          <div
            className="pointer-events-none flex shrink-0 justify-center bg-surface-thread px-4 py-1.5"
            data-testid="jump-to-latest-region"
          >
            <button
              className="pointer-events-auto inline-flex h-touch items-center gap-2 rounded-pill border border-separator-subtle bg-surface-overlay px-4 text-xs font-medium text-content-primary shadow-float outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-accent-cyan/55 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
              type="button"
              aria-label="Jump to latest message"
              data-testid="jump-to-latest"
              onClick={() => {
                expandComposerReadingMode();
                jumpToLatest();
              }}
            >
              <ArrowDown className="size-3.5 text-accent-cyan" aria-hidden="true" />
              Latest
            </button>
          </div>
        ) : null}
      </div>

      <Composer
        attachmentPolicy={attachmentPolicy}
        attachments={attachments}
        compactProfileControls={
          compactRunProfilesAvailable ? (
            <ComposerRunProfiles
              catalog={catalog}
              disabled={composerUnavailable || activeChatStreaming}
              reasoningEffort={reasoningEffort}
              reasoningMode={reasoningMode}
              selectedModelId={selectedModelId}
              selectedProvider={selectedProvider}
              variant="compact-footer"
              onSelect={selectRunProfile}
            />
          ) : null
        }
        controls={
          <>
            <ComposerControls
            backgroundMode={backgroundMode}
            catalog={catalog}
            catalogUnavailable={Boolean(catalogError)}
            currentModel={currentModel}
            currentParameterControls={currentParameterControls}
            currentPrompt={currentPrompt}
            disabled={composerUnavailable}
            maxOutputTokens={maxOutputTokens}
            reasoningEffort={reasoningEffort}
            reasoningMode={reasoningMode}
            searchOptions={searchOptions}
            selectedModelId={selectedModelId}
            selectedPromptId={selectedPromptId}
            selectedProvider={selectedProvider}
            selectedProviderName={selectedProviderName}
            selectedSearchStrategy={selectedSearchStrategy}
            showCitations={showCitations}
            showReasoningBlocks={showReasoningBlocks}
            showToolActivity={showToolActivity}
            streamMode={streamMode}
            streaming={activeChatStreaming}
            onBackgroundModeChange={changeBackgroundMode}
            onMaxOutputTokensChange={changeMaxOutputTokens}
            onMaxOutputTokensCommit={flushPendingModelControlDefaults}
            onOpenPromptSettings={() => openSettings()}
            onPromptChange={(promptId) => selectPrompt(promptId)}
            onReasoningEffortChange={changeReasoningEffort}
            onReasoningModeChange={changeReasoningMode}
            onRunProfileChange={selectRunProfile}
            onSearchStrategyChange={selectSearchStrategy}
            onSelectModel={selectModel}
            onStreamModeChange={changeStreamMode}
            onTemperatureChange={changeTemperature}
            onTemperatureCommit={flushPendingModelControlDefaults}
            onToggleNotificationSound={toggleNotificationSound}
            onToggleCitations={toggleCitationsVisibility}
            onToggleReasoningBlocks={toggleReasoningBlockVisibility}
            onToggleToolActivity={toggleToolActivityVisibility}
            notificationSoundEnabled={notificationSoundEnabled}
            temperature={temperature}
            />
            <McpComposerSummary onOpenSettings={openMcpSettings ?? openSettings} />
          </>
        }
        disabled={composerUnavailable}
        disabledHint={activeDisabledHint}
        disabledHintLive={
          !catalogError &&
          Boolean(catalog) &&
          workspaceReady &&
          !activeChatDetailLoading &&
          !activeChatDetailError
        }
        editing={Boolean(editingMessageId)}
        editPending={editingMessagePending}
        operationError={operationError}
        readingCollapsed={composerReadingCollapsed}
        onChange={composerActions.changeDraft}
        onCancelEdit={composerActions.cancelMessageEdit}
        onRemoveAttachment={composerActions.removeAttachment}
        onRejectedFiles={(files) =>
          composerActions.rejectAttachments(files.map((file) => file.name))
        }
        onSend={submitComposer}
        onStop={() => void stopCurrentRun()}
        onUploadFiles={uploadFiles}
        sendDisabled={activeChatStreaming || uploading || creatingChat || editingMessagePending}
        stopDisabled={!currentRunId}
        streaming={activeChatStreaming}
        uploading={uploading}
        contextLine={composerContextLine}
        usageStats={composerUsageStats}
        value={draft}
        onRequestExpanded={expandComposerReadingMode}
      />
    </section>
  );
}
