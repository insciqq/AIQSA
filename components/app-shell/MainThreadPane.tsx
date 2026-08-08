import {
  Composer,
  type ComposerAttachment,
  type ComposerHintTone
} from "@/components/chat/Composer";
import {
  formatComposerContextStats,
  type ComposerContextStats
} from "@/components/app-shell/composerContextStats";
import {
  attachmentPolicyForModel,
  attachmentWarningsForModel
} from "@/components/app-shell/attachmentCapabilities";
import { calculateAttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import { ComposerControls } from "@/components/app-shell/ComposerControls";
import { McpComposerSummary } from "@/components/app-shell/McpComposerSummary";
import { ThreadMessageRow } from "@/components/app-shell/ThreadMessageRow";
import { useCompactComposerReadingMode } from "@/components/app-shell/useCompactComposerReadingMode";
import type { PipelineSnapshot } from "@/components/app-shell/runState";
import { AssistantAvatar } from "@/components/assistants/AssistantAvatar";
import type { ShellComposerView } from "@/components/app-shell/powerAppShellViewContracts";
import type {
  Catalog,
  CatalogModel,
  CatalogSearchStrategy,
  ChatUsageStats,
  ModelParameterControls,
  PersistedRun,
  ThreadArtifactSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import { ArrowDown, CircleAlert, LoaderCircle, RotateCcw } from "lucide-react";
import Link from "next/link";
import type { ReactNode, RefObject } from "react";
import type { SearchPlanMode } from "@/lib/domain/search";
import { useCallback, useMemo, useState } from "react";

const noRunWarnings: string[] = [];

export type RunWarning = {
  runId: string;
  text: string;
};

export type MainThreadPaneComposerActions = {
  cancelMessageEdit(): void;
  changeDraft(value: string): void;
  rejectAttachmentCount(input: {
    attemptedCount: number;
    currentCount: number;
    maxCount: number;
  }): void;
  rejectAttachments(fileNames: readonly string[]): void;
  removeAttachment(attachmentId: string): void;
};

export type MainThreadPaneProps = {
  activeChatDetailError: string | null;
  activeChatDetailLoading: boolean;
  activeChatId: string | null;
  activeChatStreaming: boolean;
  adminEntryVisible?: boolean;
  assistant: ShellComposerView["assistant"];
  attachments: ComposerAttachment[];
  backgroundMode: boolean;
  compatibleSearchOptionIds?: string[];
  catalog: Catalog | null;
  catalogError: string | null;
  changeBackgroundMode(value: boolean): void;
  changeMaxOutputTokens(value: string): void;
  changeReasoningEffort(value: string): void;
  changeReasoningMode(value: string): void;
  changeStreamMode(value: boolean): void;
  changeTemperature(value: string): void;
  composerContextStats: ComposerContextStats | null;
  composerDisabledHint: string | null;
  composerActions: MainThreadPaneComposerActions;
  composerUsageStats: ChatUsageStats | null;
  creatingChat: boolean;
  currentModel: CatalogModel | undefined;
  currentParameterControls: ModelParameterControls;
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
  lastRun: PersistedRun | null;
  liveArtifactSummary: ThreadArtifactSummary | null;
  maxOutputTokens: string;
  makeCurrentModelDefault?(): void;
  notificationSoundEnabled: boolean;
  operationError: string | null;
  operationErrorLive: boolean;
  openMcpSettings(): void;
  openRunDetails(): void;
  pipeline?: PipelineSnapshot | null;
  reasoningEffort: string;
  reasoningMode: string;
  retryActiveChatDetail(): void;
  retryCatalog(): void;
  retryWorkspace(): void;
  runWarnings?: RunWarning[];
  searchOptions: CatalogSearchStrategy[];
  searchPreferenceSource?: "organization" | "personal";
  searchPlanMode: SearchPlanMode;
  selectModel(model: CatalogModel): void;
  selectSearchPlan(optionIds: readonly string[], mode: SearchPlanMode): void;
  selectSearchStrategy(strategyId: string): void;
  selectedModelId: string;
  selectedProvider: string;
  selectedProviderName: string;
  selectedSearchOptionIds: string[];
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
  useOrganizationSearchDefault?(): void;
  useOrganizationModelDefault?(): void;
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
  adminEntryVisible = false,
  assistant,
  attachments,
  backgroundMode,
  compatibleSearchOptionIds = [],
  catalog,
  catalogError,
  changeBackgroundMode,
  changeMaxOutputTokens,
  changeReasoningEffort,
  changeReasoningMode,
  changeStreamMode,
  changeTemperature,
  composerContextStats,
  composerDisabledHint,
  composerActions,
  composerUsageStats,
  creatingChat,
  currentModel,
  currentParameterControls,
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
  lastRun,
  liveArtifactSummary,
  maxOutputTokens,
  makeCurrentModelDefault,
  notificationSoundEnabled,
  operationError,
  operationErrorLive,
  openMcpSettings,
  openRunDetails,
  pipeline = null,
  reasoningEffort,
  reasoningMode,
  retryActiveChatDetail,
  retryCatalog,
  retryWorkspace,
  runWarnings = [],
  searchOptions,
  searchPreferenceSource = "personal",
  searchPlanMode,
  selectModel,
  selectSearchPlan,
  selectSearchStrategy,
  selectedModelId,
  selectedProvider,
  selectedProviderName,
  selectedSearchOptionIds,
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
  useOrganizationSearchDefault,
  useOrganizationModelDefault,
  uploadFiles,
  uploading,
  visibleMessages,
  workspaceError,
  workspaceLoading,
  workspaceReady
}: MainThreadPaneProps) {
  const [mobileControlsState, setMobileControlsState] = useState<{
    chatId: string | null;
    messageId: string | null;
  }>(() => ({ chatId: activeChatId, messageId: null }));
  const mobileControlsMessageId =
    mobileControlsState.chatId === activeChatId ? mobileControlsState.messageId : null;

  const toggleMobileMessageControls = useCallback((messageId: string) => {
    setMobileControlsState((current) => ({
      chatId: activeChatId,
      messageId:
        current.chatId === activeChatId && current.messageId === messageId ? null : messageId
    }));
  }, [activeChatId]);

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
  const attachmentWarnings = useMemo(
    () => attachmentWarningsForModel(attachments, currentModel),
    [attachments, currentModel]
  );
  const attachmentLimitUsage = useMemo(
    () => calculateAttachmentLimitUsage(
      attachments,
      currentModel,
      catalog?.attachmentLimits
    ),
    [attachments, catalog?.attachmentLimits, currentModel]
  );
  const attachmentWarningBlocksSend = attachmentWarnings.some(
    (warning) => warning.blocking
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
              : adminEntryVisible && catalog.models.length === 0
                ? "Set up a provider in Control Center before sending."
                : composerDisabledHint;
  const activeDisabledHintTone: ComposerHintTone =
    creatingChat ||
    (!catalog && !catalogError) ||
    (!workspaceReady && !workspaceError) ||
    activeChatDetailLoading
      ? "busy"
      : "caution";

  const composerUnavailable =
    creatingChat ||
    activeChatDetailLoading ||
    Boolean(activeChatDetailError) ||
    Boolean(catalogError) ||
    !catalog ||
    !workspaceReady ||
    !currentModel;
  const composerControlsUnavailable =
    creatingChat ||
    activeChatDetailLoading ||
    Boolean(activeChatDetailError) ||
    Boolean(catalogError) ||
    !catalog ||
    !workspaceReady;

  const centeredEmptyConversation =
    activeChatId === null &&
    visibleMessages.length === 0 &&
    Boolean(catalog) &&
    Boolean(catalog?.models.length) &&
    workspaceReady &&
    !creatingChat &&
    !activeChatDetailLoading &&
    !activeChatDetailError &&
    !catalogError &&
    !workspaceError;
  const composerReadingForceExpanded =
    composerUnavailable ||
    Boolean(activeDisabledHint) ||
    visibleMessages.length === 0 ||
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
    resetKey: activeChatId
  });

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-answer-paper" data-testid="main-thread-pane">
      {noticeSlot}

      <div
        className={
          centeredEmptyConversation
            ? "grid min-h-0 flex-1 content-center [@media(max-height:32rem)]:overflow-y-auto"
            : "flex min-h-0 flex-1 flex-col"
        }
        data-composer-placement={centeredEmptyConversation ? "centered" : "thread-tail"}
        data-testid="thread-composer-layout"
      >
        <div className={centeredEmptyConversation ? "relative flex shrink-0 flex-col" : "relative flex min-h-0 flex-1 flex-col"}>
          <div
            ref={threadScrollRef}
            className={
              centeredEmptyConversation
                ? "shrink-0 [overflow-anchor:none]"
                : "min-h-0 flex-1 overflow-y-auto overscroll-contain pt-[calc(3.25rem+env(safe-area-inset-top))] [overflow-anchor:none] min-[1281px]:pt-0"
            }
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
                <div className="mx-auto grid size-10 place-items-center rounded-control bg-critical/10 text-critical">
                  <CircleAlert className="size-5" aria-hidden="true" />
                </div>
                <h2 className="mt-3 text-base font-semibold text-ink">Models didn&apos;t load</h2>
                <p className="mt-1 break-words text-sm leading-6 text-ink-secondary [overflow-wrap:anywhere]">
                  {catalogError}
                </p>
                <button
                  className="mt-4 inline-flex h-touch items-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-4 text-sm font-medium text-ink hover:bg-control-hover sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
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
                <div className="mx-auto grid size-10 place-items-center rounded-control bg-critical/10 text-critical">
                  <CircleAlert className="size-5" aria-hidden="true" />
                </div>
                <h2 className="mt-3 text-base font-semibold text-ink">Workspace didn&apos;t load</h2>
                <p className="mt-1 break-words text-sm leading-6 text-ink-secondary [overflow-wrap:anywhere]">
                  {workspaceError}
                </p>
                <button
                  className="mt-4 inline-flex h-touch items-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-4 text-sm font-medium text-ink hover:bg-control-hover disabled:cursor-not-allowed disabled:opacity-60 sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
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
                <LoaderCircle className="mx-auto size-6 animate-spin text-proof" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-ink-secondary">Loading models and prompts…</p>
              </div>
            </div>
          ) : null}
          {catalog && !workspaceReady && workspaceLoading && !workspaceError && !catalogError ? (
            <div className="grid min-h-[260px] place-items-center px-4 py-10 text-center" data-testid="workspace-loading-state" role="status">
              <div>
                <LoaderCircle className="mx-auto size-6 animate-spin text-proof" aria-hidden="true" />
                <p className="mt-3 text-sm font-medium text-ink-secondary">Loading workspace…</p>
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
                <div className="mx-auto grid size-10 place-items-center rounded-control bg-critical/10 text-critical">
                  <CircleAlert className="size-5" aria-hidden="true" />
                </div>
                <h2 className="mt-3 text-base font-semibold text-ink">This conversation didn&apos;t load</h2>
                <p className="mt-1 break-words text-sm leading-6 text-ink-secondary [overflow-wrap:anywhere]">
                  {activeChatDetailError}
                </p>
                <button
                  className="mt-4 inline-flex h-touch items-center gap-2 rounded-control border border-trace-subtle bg-control-surface px-4 text-sm font-medium text-ink hover:bg-control-hover sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
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
            <div
              className={
                centeredEmptyConversation
                  ? "px-4 pb-3 pt-2 sm:pb-4 [@media(max-height:32rem)]:hidden"
                  : "grid min-h-[300px] place-items-center px-4 py-10"
              }
              data-testid="thread-empty-state"
            >
              {catalog && catalog.models.length === 0 ? (
                <div className="w-full max-w-reading" data-testid="no-model-empty-state">
                  <p className="text-xs font-medium text-ink-muted">
                    {adminEntryVisible ? "Provider setup required" : "Model access required"}
                  </p>
                  <h2 className="mt-2 max-w-xl text-2xl font-semibold leading-8 text-ink">
                    {adminEntryVisible
                      ? "Connect a provider to start chatting."
                      : "This workspace has no models available yet."}
                  </h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-ink-secondary">
                    {adminEntryVisible
                      ? "No runnable models are configured yet. Add a provider key and activate its models in Control Center."
                      : "An administrator needs to grant model access before you can send a question. Your chats, folders, Settings, and Appearance remain available."}
                  </p>
                  {adminEntryVisible ? (
                    <Link
                      className="mt-4 inline-flex h-touch items-center rounded-control bg-proof px-4 text-sm font-semibold text-proof-contrast outline-none hover:bg-proof-hover focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-answer-paper sm:h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch"
                      href="/admin"
                      aria-label="Set up providers in Control Center"
                    >
                      Set up providers
                    </Link>
                  ) : null}
                </div>
              ) : assistant.selected ? (
                <div
                  className="mx-auto w-full max-w-reading sm:text-center"
                  data-testid="assistant-blank-intro"
                >
                  <div className="flex flex-col items-start gap-3 sm:items-center">
                    <AssistantAvatar recipe={assistant.selected.avatar} size={60} />
                    <div>
                      <h2 className="text-2xl font-semibold leading-8 tracking-[-0.025em] text-ink sm:text-3xl sm:leading-9">
                        {assistant.selected.name}
                      </h2>
                      {assistant.selected.description ? (
                        <p className="mt-2 text-sm leading-6 text-ink-secondary">
                          {assistant.selected.description}
                        </p>
                      ) : null}
                    </div>
                  </div>
                  {assistant.selected.starterPrompts.length > 0 &&
                  !draft.trim() &&
                  attachments.length === 0 &&
                  !uploading ? (
                    <ul
                      className="mt-4 flex flex-wrap gap-2 sm:justify-center"
                      data-testid="assistant-starter-prompts"
                    >
                      {assistant.selected.starterPrompts.slice(0, 4).map((starter) => (
                        <li className="min-w-0" key={starter}>
                          <button
                            className="max-w-full truncate rounded-full border border-control-boundary bg-control-surface px-3 py-2 text-left text-xs font-medium text-ink-secondary hover:bg-control-hover hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:min-h-touch [@media(pointer:coarse)]:min-h-touch"
                            disabled={composerUnavailable || activeChatStreaming}
                            title={starter}
                            type="button"
                            onClick={() => assistant.sendStarter(starter)}
                          >
                            {starter}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : (
                <div className="mx-auto w-full max-w-reading sm:text-center">
                  <h2 className="text-2xl font-semibold leading-8 tracking-[-0.025em] text-ink sm:text-3xl sm:leading-9">
                    What do you want to work on?
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-ink-secondary">
                    Choose a model, add tools or web search, and start a conversation.
                  </p>
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
              message.role === "assistant" &&
              Boolean(message.runId) &&
              message.runId === currentRunId &&
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
                mobileControlsOpen={mobileControlsMessageId === message.id}
                persistedRun={message.runId && message.runId === lastRun?.id ? lastRun : null}
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
                onOpenRunDetails={openRunDetails}
                onRegenerateMessage={handleRegenerateMessage}
                onToggleMobileControls={toggleMobileMessageControls}
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
                  ? "h-24 sm:h-32 [@media(max-height:42rem)]:!h-0"
                  : "h-16 sm:h-24 [@media(max-height:42rem)]:!h-0"
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
              className="pointer-events-none absolute inset-x-0 bottom-3 z-20 flex justify-center px-4"
              data-testid="jump-to-latest-region"
            >
              <button
                className="pointer-events-auto grid size-11 place-items-center rounded-pill border border-trace-subtle bg-overlay-surface text-ink shadow-float outline-none hover:bg-control-hover focus-visible:ring-2 focus-visible:ring-focus [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"
                type="button"
                aria-label="Jump to latest message"
                data-testid="jump-to-latest"
                title="Jump to latest message"
                onClick={() => {
                  expandComposerReadingMode();
                  jumpToLatest();
                }}
              >
                <ArrowDown className="size-4 text-proof" aria-hidden="true" />
              </button>
            </div>
          ) : null}
        </div>

        <Composer
          attachmentLimitUsage={attachmentLimitUsage}
          attachmentPolicy={attachmentPolicy}
          attachmentWarnings={attachmentWarnings}
          attachments={attachments}
          controls={
            <ComposerControls
              assistant={assistant}
              backgroundMode={backgroundMode}
              compatibleSearchOptionIds={compatibleSearchOptionIds}
              catalog={catalog}
              catalogUnavailable={Boolean(catalogError)}
              compact={centeredEmptyConversation}
              contextLine={composerContextStats ? formatComposerContextStats(composerContextStats) : null}
              currentModel={currentModel}
              currentParameterControls={currentParameterControls}
              disabled={composerControlsUnavailable}
              hasAttachments={attachments.length > 0}
              maxOutputTokens={maxOutputTokens}
              reasoningEffort={reasoningEffort}
              reasoningMode={reasoningMode}
              searchOptions={searchOptions}
              searchPreferenceSource={searchPreferenceSource}
              searchPlanMode={searchPlanMode}
              selectedModelId={selectedModelId}
              selectedProvider={selectedProvider}
              selectedProviderName={selectedProviderName}
              selectedSearchOptionIds={selectedSearchOptionIds}
              selectedSearchStrategy={selectedSearchStrategy}
              showCitations={showCitations}
              showReasoningBlocks={showReasoningBlocks}
              showToolActivity={showToolActivity}
              streamMode={streamMode}
              streaming={activeChatStreaming}
              onBackgroundModeChange={changeBackgroundMode}
              onMaxOutputTokensChange={changeMaxOutputTokens}
              onMaxOutputTokensCommit={flushPendingModelControlDefaults}
              onMakeCurrentModelDefault={makeCurrentModelDefault}
              onReasoningEffortChange={changeReasoningEffort}
              onReasoningModeChange={changeReasoningMode}
              onSearchPlanChange={selectSearchPlan}
              onSearchStrategyChange={selectSearchStrategy}
              onUseOrganizationSearchDefault={useOrganizationSearchDefault}
              onUseOrganizationModelDefault={useOrganizationModelDefault}
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
              usageStats={composerUsageStats}
            />
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
          disabledHintTone={activeDisabledHintTone}
          editing={Boolean(editingMessageId)}
          editPending={editingMessagePending}
          operationError={operationError}
          operationErrorLive={operationErrorLive}
          promptFirst={centeredEmptyConversation}
          readingCollapsed={composerReadingCollapsed}
          onChange={composerActions.changeDraft}
          onAttachmentCountLimitExceeded={composerActions.rejectAttachmentCount}
          onCancelEdit={composerActions.cancelMessageEdit}
          onRemoveAttachment={composerActions.removeAttachment}
          onRejectedFiles={(files) =>
            composerActions.rejectAttachments(files.map((file) => file.name))
          }
          onSend={submitComposer}
          onStop={() => void stopCurrentRun()}
          onUploadFiles={uploadFiles}
          sendDisabled={
            activeChatStreaming ||
            uploading ||
            creatingChat ||
            editingMessagePending ||
            (!editingMessageId && (
              attachmentWarningBlocksSend || attachmentLimitUsage.blocking
            ))
          }
          stopDisabled={!currentRunId}
          streaming={activeChatStreaming}
          tools={(
            <McpComposerSummary
              onOpenSettings={openMcpSettings}
              toolCallingSupported={currentModel?.capabilities.toolCalling}
            />
          )}
          uploading={uploading}
          contextStats={composerContextStats}
          usageStats={composerUsageStats}
          value={draft}
          onRequestExpanded={expandComposerReadingMode}
        />
      </div>
    </section>
  );
}
