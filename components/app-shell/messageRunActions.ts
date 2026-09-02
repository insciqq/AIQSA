import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  attachmentBlocksSend,
  firstBlockingAttachmentWarning
} from "@/components/app-shell/attachmentCapabilities";
import { attachmentRetryAvailable } from "@/components/app-shell/attachmentLifecycle";
import { calculateAttachmentLimitUsage } from "@/components/app-shell/attachmentLimitUsage";
import {
  chatIdFromComposerSessionKey,
  composerSessionModeFromKey,
  folderIdFromComposerSessionKey,
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "@/components/app-shell/composerSessionStore";
import { loadChatMemoryState } from "@/components/app-shell/chatLifecycleApi";
import { errorMessage } from "@/components/app-shell/shellFormatting";
import { editMessageBranchAction } from "@/components/app-shell/messageEditAction";
import { shellFetch } from "@/components/app-shell/shellApi";
import {
  executeMessageRunLifecycle,
  type ConsumeMessageRunStream
} from "@/components/app-shell/messageRunLifecycle";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import { mergeThreadMessages } from "@/components/app-shell/runState";
import { effectiveActiveLeafId } from "@/components/app-shell/threadPath";
import { selectThreadSnapshot, useThreadStore } from "@/components/app-shell/threadStore";
import type {
  Catalog,
  CatalogModel,
  ChatDetail,
  WorkspaceChatSummary,
  Notice,
  ThreadMessage
} from "@/components/app-shell/types";
import {
  refreshMemorySettings
} from "@/components/app-shell/memorySettingsStore";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import type { SavedControlDraft } from "@/components/app-shell/powerAppShellData";
import type { RunStreamTokenBuffer } from "@/components/app-shell/useRunStream";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { SearchPlanMode } from "@/lib/domain/search";
import { reconcileModelSearchPlan } from "@/lib/domain/catalogMatrix";
import type {
  ComposerKnowledgePlanSource,
  ComposerMcpSelection
} from "@/components/app-shell/composerControlStore";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "@/lib/contracts/memoryClient";
import type { KnowledgeSelection } from "@/lib/contracts/knowledge";

type MutableRef<T> = { current: T };

type MessageRunControlSnapshot = {
  assistantId: string | null;
  controlDefaults: SavedControlDraft;
  model: CatalogModel | undefined;
  modelId: string;
  knowledgeSelection: KnowledgeSelection;
  knowledgePlanSource: ComposerKnowledgePlanSource;
  mcpSelection: ComposerMcpSelection;
  params: Record<string, unknown>;
  provider: string;
  searchPreferencePlan: {
    mode: SearchPlanMode;
    optionIds: string[];
  };
  searchPreferenceSource: Catalog["defaults"]["searchPreferenceSource"];
  searchOptions: Catalog["searchStrategies"];
  skillIds: string[];
  toolsOverride: { tools: "none" } | Record<string, never>;
};

type MessageRunActionsInput = {
  activeChat: WorkspaceChatSummary | null;
  activeChatDetailLoading: boolean;
  activeChatId: string | null;
  activeChatIdRef: MutableRef<string | null>;
  activeStreamAbortRef: MutableRef<Map<string, AbortController>>;
  buildControlDraft(): SavedControlDraft;
  buildParams(): Record<string, unknown>;
  consumeRunStream: ConsumeMessageRunStream;
  createChat(
    folderId?: string | null,
    sourceSessionKey?: ComposerSessionKey
  ): Promise<WorkspaceChatSummary | null>;
  createStreamTokenBuffer(input: {
    chatId: string;
    getAssistantMessageId(): string;
  }): RunStreamTokenBuffer;
  currentModel: CatalogModel | undefined;
  fetchRun(runId: string, chatId: string): Promise<unknown>;
  notifyAnswerReady(): Promise<void>;
  openMemorySettings(): void;
  persistActiveLeaf(chatId: string, messageId: string | null): Promise<unknown>;
  primeAnswerSound(): Promise<void>;
  refreshActiveChat(
    chatId: string | null,
    options?: { forceDetail?: boolean; preserveControls?: boolean; resumeRuns?: boolean }
  ): Promise<ChatDetail | null>;
  refreshProjectWorkspace?(): Promise<boolean>;
  resolveCatalog?(): Catalog | null;
  resetThreadToLatest(): void;
  setNotice(input: Notice): void;
  activeChatStreaming: boolean;
};

function toolsOverride(model: CatalogModel | undefined): { tools: "none" } | Record<string, never> {
  return model && !model.capabilities.toolCalling ? { tools: "none" } : {};
}

function modelForCurrentSelection(
  renderedModel: CatalogModel | undefined,
  provider: string,
  modelId: string,
  catalog: Catalog | null = useWorkspaceStore.getState().catalog
): CatalogModel | undefined {
  if (renderedModel?.provider === provider && renderedModel.modelId === modelId) {
    return renderedModel;
  }

  return catalog?.models.find((model) => model.provider === provider && model.modelId === modelId);
}

export function useMessageRunActions({
  activeChat,
  activeChatDetailLoading,
  activeChatId,
  activeChatIdRef,
  activeChatStreaming,
  activeStreamAbortRef,
  buildControlDraft,
  buildParams,
  consumeRunStream,
  createChat,
  createStreamTokenBuffer,
  currentModel,
  fetchRun,
  notifyAnswerReady,
  openMemorySettings,
  persistActiveLeaf,
  primeAnswerSound,
  refreshActiveChat,
  refreshProjectWorkspace,
  resolveCatalog,
  resetThreadToLatest,
  setNotice
}: MessageRunActionsInput) {
  async function showMemoryTargetSelection(): Promise<void> {
    try {
      await refreshMemorySettings();
    } catch {
      // Copy is local and complete even when the settings refresh fails.
    }
    setNotice({
      action: {
        label: memoryUiCopy("action.manage"),
        onClick: openMemorySettings
      },
      kind: "error",
      persistent: true,
      text: memoryUiCopy("action.ambiguous")
    });
  }

  function captureRunControlSnapshot(): MessageRunControlSnapshot {
    const {
      selectedAssistant,
      knowledgeSelection,
      selectedModelId,
      selectedProvider,
      selectedSearchOptionIds,
      searchPlanMode,
      knowledgePlanSource,
      mcpSelection,
      selectedSkills
    } = useComposerControlStore.getState();
    const catalog = resolveCatalog
      ? resolveCatalog()
      : useWorkspaceStore.getState().catalog;
    const selectedModel = modelForCurrentSelection(
      currentModel,
      selectedProvider,
      selectedModelId,
      catalog
    );
    const model = selectedModel
      ? {
          ...selectedModel,
          searchOptionCompatibility: selectedModel.searchOptionCompatibility
            ? Object.fromEntries(
                Object.entries(selectedModel.searchOptionCompatibility).map(
                  ([optionId, compatibility]) => [
                    optionId,
                    {
                      ...compatibility,
                      executionModes: [...compatibility.executionModes]
                    }
                  ]
                )
              )
            : undefined,
          searchStrategyIds: [...selectedModel.searchStrategyIds]
        }
      : undefined;
    const searchPreferenceOptionIds = [...selectedSearchOptionIds];

    return {
      assistantId: selectedAssistant?.id ?? null,
      controlDefaults: { ...buildControlDraft() },
      knowledgeSelection: {
        ...knowledgeSelection,
        baseIds: [...knowledgeSelection.baseIds],
        sourceIds: [...knowledgeSelection.sourceIds]
      },
      knowledgePlanSource,
      mcpSelection: { ...mcpSelection },
      model,
      modelId: selectedModelId,
      params: { ...buildParams() },
      provider: selectedProvider,
      searchPreferencePlan: {
        mode: searchPlanMode,
        optionIds: searchPreferenceOptionIds
      },
      searchPreferenceSource: catalog?.defaults.searchPreferenceSource ?? "personal",
      searchOptions: (catalog?.searchStrategies ?? []).map((option) => ({
        ...option,
        ...(option.executionModes
          ? { executionModes: [...option.executionModes] }
          : {})
      })),
      skillIds: selectedSkills.map((skill) => skill.id),
      toolsOverride: toolsOverride(model)
    };
  }

  function clientTimeZone(): string | undefined {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
    } catch {
      return undefined;
    }
  }

  function temporaryAdmissionPayload(
    sessionKey: ComposerSessionKey,
    chatId: string | null
  ): Readonly<{
    chatMode: "TEMPORARY";
    temporaryRetentionPolicyVersion: typeof MEMORY_TEMPORARY_RETENTION_POLICY_VERSION;
  }> | Record<string, never> {
    const pending = chatId
      ? useWorkspaceStore.getState().chats.find((chat) => chat.id === chatId)
          ?.pendingInitialMemoryMode === "TEMPORARY"
      : composerSessionModeFromKey(sessionKey) === "TEMPORARY";
    return pending
      ? {
          chatMode: "TEMPORARY",
          temporaryRetentionPolicyVersion: MEMORY_TEMPORARY_RETENTION_POLICY_VERSION
        }
      : {};
  }

  async function reconcileTemporaryAdmission(chatId: string): Promise<void> {
    try {
      const response = await loadChatMemoryState(chatId);
      useWorkspaceStore.getState().updateChats((chats) => chats.map((chat) =>
        chat.id === chatId
          ? {
              ...chat,
              memoryMode: response.mode,
              pendingInitialMemoryMode: response.mode === "TEMPORARY"
                ? undefined
                : chat.pendingInitialMemoryMode,
              temporaryRetentionDeadline: response.temporaryRetentionDeadline
            }
          : chat
      ));
    } catch {
      // Keep the pending intent on ambiguous transport failures. A retry then
      // repeats the exact reviewed admission payload instead of silently downgrading.
    }
  }

  function isTemporaryChat(chatId: string): boolean {
    return useWorkspaceStore.getState().chats.some((chat) =>
      chat.id === chatId && chat.memoryMode === "TEMPORARY"
    );
  }

  function runControlPayload(snapshot: MessageRunControlSnapshot, projectScoped: boolean) {
    if (snapshot.assistantId) {
      // The server resolves the currently authorized revision at admission;
      // the request carries only the Assistant identity plus user content and
      // never an expanded client copy of the governed controls.
      return {
        assistantId: snapshot.assistantId,
        ...(snapshot.skillIds.length > 0 ? { skillIds: [...snapshot.skillIds] } : {})
      };
    }

    const effectiveSearchPlan = reconcileModelSearchPlan(
      snapshot.model,
      snapshot.searchPreferencePlan.optionIds,
      snapshot.searchPreferencePlan.mode,
      snapshot.searchOptions
    );
    const timeZone = clientTimeZone();

    return {
      controlDefaults: snapshot.controlDefaults,
      modelId: snapshot.modelId,
      ...(snapshot.knowledgePlanSource === "explicit"
        ? { knowledgePlan: snapshot.knowledgeSelection }
        : {}),
      params: snapshot.params,
      ...(snapshot.mcpSelection.mode === "auto" ? {} : { mcp: snapshot.mcpSelection }),
      provider: snapshot.provider,
      searchPlan: effectiveSearchPlan,
      ...(!projectScoped && snapshot.searchPreferenceSource
        ? {
            searchPreferencePlan: snapshot.searchPreferencePlan,
            searchPreferenceSource: snapshot.searchPreferenceSource
          }
        : {}),
      ...(timeZone ? { timeZone } : {}),
      ...(snapshot.skillIds.length > 0 ? { skillIds: [...snapshot.skillIds] } : {}),
      ...snapshot.toolsOverride
    };
  }

  async function editMessageBranch() {
    const sourceSessionKey = useComposerSessionStore.getState().activeSessionKey;
    const sourceChatId = chatIdFromComposerSessionKey(sourceSessionKey);
    if (!sourceChatId || sourceChatId !== activeChatId) {
      return;
    }
    const runControlSnapshot = captureRunControlSnapshot();

    const committed = await editMessageBranchAction({
      activeChatIdRef,
      refreshActiveChat,
      resetThreadToLatest,
      sourceChatId,
      sourceSessionKey,
      activeChatStreaming
    });
    if (!committed || committed.role !== "user") {
      return;
    }

    await startEditedBranchRun(sourceChatId, committed.id, runControlSnapshot);
  }

  async function startEditedBranchRun(
    chatId: string,
    editedUserMessageId: string,
    runControlSnapshot: MessageRunControlSnapshot
  ) {
    if (useRunLifecycleStore.getState().activeStreams[chatId]) {
      return;
    }

    const assistantId = `assistant-${Date.now()}`;
    const assistantMessage: ThreadMessage = {
      content: "",
      id: assistantId,
      modelId: runControlSnapshot.modelId,
      parentMessageId: editedUserMessageId,
      provider: runControlSnapshot.provider,
      role: "assistant",
      status: "streaming"
    };

    mergeStreamChatMessages(chatId, [assistantMessage]);
    updateStreamChatActiveLeaf(chatId, assistantId);
    if (activeChatIdRef.current === chatId) {
      resetThreadToLatest();
    }

    const result = await executeMessageRunLifecycle({
      activeChatIdRef,
      activeStreamAbortRef,
      chatId,
      consumeRunStream,
      createStreamTokenBuffer,
      failurePrefix: "edit_run_failed",
      fetchRun,
      notifyAnswerReady,
      optimisticAssistantMessageId: assistantId,
      primeAnswerSound,
      reconcileMessageIds({ currentRunId, messageIds }) {
        if (!messageIds.assistantMessageId) {
          return;
        }

        const persistedAssistantId = messageIds.assistantMessageId;
        updateStreamChatActiveLeaf(chatId, persistedAssistantId, assistantId);
        updateStreamChatMessages(chatId, (current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  id: persistedAssistantId,
                  runId: currentRunId ?? message.runId
                }
              : message
          )
        );
      },
      refreshActiveChat,
      request(signal) {
        return shellFetch(`/api/messages/${editedUserMessageId}/regenerate`, {
          body: JSON.stringify({
            ...runControlPayload(runControlSnapshot, Boolean(activeChat?.projectId))
          }),
          headers: {
            "content-type": "application/json"
          },
          method: "POST",
          signal
        });
      }
      // The committed branch keeps the readable failed tail: rollback would hide
      // the edited question again, and the stranded-leaf reconcile owns retry.
    });
    if (result.failureCode === "memory_intent_confirmation_required") {
      await showMemoryTargetSelection();
    }
    if (isTemporaryChat(chatId)) {
      await reconcileTemporaryAdmission(chatId);
    }
  }

  async function submitComposer() {
    const sourceSession = selectComposerSession(
      useComposerSessionStore.getState(),
      useComposerSessionStore.getState().activeSessionKey
    );
    if (sourceSession.editingMessageId) {
      await editMessageBranch();
      return;
    }

    await sendMessage();
  }

  function updateStreamChatMessages(chatId: string, updater: (messages: ThreadMessage[]) => ThreadMessage[]) {
    useThreadStore.getState().updateMessages(chatId, updater);
  }

  function mergeStreamChatMessages(chatId: string, updates: ThreadMessage[]) {
    updateStreamChatMessages(chatId, (current) => mergeThreadMessages(current, updates));
  }

  function updateStreamChatActiveLeaf(chatId: string, nextLeafId: string, previousLeafId?: string) {
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((chat) =>
        chat.id === chatId && (!previousLeafId || chat.activeLeafMessageId === previousLeafId)
          ? {
              ...chat,
              activeLeafMessageId: nextLeafId
            }
          : chat
      )
    );
    useThreadStore.getState().checkoutBranch(chatId, nextLeafId);
  }

  function rollbackOptimisticRun(input: {
    chatId: string;
    expectedParentMessageId: string | null;
    optimisticAssistantMessageId: string;
    optimisticUserMessageId?: string;
    previousLeafId: string | null;
  }) {
    const thread = selectThreadSnapshot(useThreadStore.getState(), input.chatId);
    const assistant = thread.messages.find(
      (message) => message.id === input.optimisticAssistantMessageId
    );
    const user = input.optimisticUserMessageId
      ? thread.messages.find((message) => message.id === input.optimisticUserMessageId)
      : null;
    const ownsOptimisticRows =
      thread.activeLeafId === input.optimisticAssistantMessageId &&
      assistant?.parentMessageId ===
        (input.optimisticUserMessageId ?? input.expectedParentMessageId) &&
      (!input.optimisticUserMessageId ||
        (user?.parentMessageId === input.expectedParentMessageId &&
          user.role === "user"));
    if (!ownsOptimisticRows) {
      return;
    }

    useThreadStore.getState().deleteMessages(input.chatId, {
      activeLeafId: input.previousLeafId,
      deletedIds: new Set(
        input.optimisticUserMessageId
          ? [input.optimisticUserMessageId, input.optimisticAssistantMessageId]
          : [input.optimisticAssistantMessageId]
      )
    });
    useWorkspaceStore.getState().updateChats((current) =>
      current.map((chat) =>
        chat.id === input.chatId &&
        chat.activeLeafMessageId === input.optimisticAssistantMessageId
          ? {
              ...chat,
              activeLeafMessageId: input.previousLeafId
            }
          : chat
      )
    );
  }

  async function refreshInterruptedRun(chatId = activeChatId): Promise<boolean> {
    const interrupted = chatId
      ? useRunLifecycleStore.getState().ambiguousFailures[chatId]
      : null;
    if (!chatId || !interrupted) {
      return false;
    }

    try {
      if (interrupted.runId) {
        await fetchRun(interrupted.runId, chatId);
      }
      const detail = await refreshActiveChat(chatId, {
        forceDetail: true,
        preserveControls: true
      });
      if (!detail) {
        return false;
      }

      useRunLifecycleStore.getState().ambiguityCleared({ chatId });
      return true;
    } catch {
      return false;
    }
  }

  function hasUnreconciledOptimisticLeaf(chatId: string): boolean {
    const thread = selectThreadSnapshot(useThreadStore.getState(), chatId);
    const leafId = effectiveActiveLeafId(thread.messages, thread.activeLeafId);
    const leaf = thread.messages.find((message) => message.id === leafId);
    return Boolean(
      leaf &&
        leaf.role === "assistant" &&
        !leaf.runId &&
        (leaf.status === "cancelled" || leaf.status === "error") &&
        /^assistant-(?:regen-)?\d+$/.test(leaf.id)
    );
  }

  async function reconcileBeforeRunMutation(chatId: string): Promise<boolean> {
    if (!hasUnreconciledOptimisticLeaf(chatId)) {
      return true;
    }

    const detail = await refreshActiveChat(chatId, {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    });
    if (detail && !hasUnreconciledOptimisticLeaf(chatId)) {
      return true;
    }

    setNotice({
      kind: "error",
      text: "The interrupted run could not be reconciled. Retry when the connection is available."
    });
    return false;
  }

  async function sendMessage() {
    const sourceSessionKey = useComposerSessionStore.getState().activeSessionKey;
    const sourceSession = selectComposerSession(
      useComposerSessionStore.getState(),
      sourceSessionKey
    );
    if (
      (!sourceSession.draft.trim() && sourceSession.attachments.length === 0) ||
      activeChatDetailLoading
    ) {
      return;
    }
    const runControlSnapshot = captureRunControlSnapshot();
    const modelForSend = runControlSnapshot.model;
    if (!modelForSend) {
      return;
    }
    // A Search engine the model cannot run is never kept silently (UX audit
    // 2026-09-02 A6): the message goes out without it, the composer choice
    // becomes Off, and a short notice says so.
    const unavailableSearchOptionId = runControlSnapshot.searchPreferencePlan.optionIds.find(
      (optionId) => optionId !== "search-disabled" && !modelForSend.searchStrategyIds.includes(optionId)
    );
    if (unavailableSearchOptionId) {
      const optionName = runControlSnapshot.searchOptions.find(
        (option) => option.strategyId === unavailableSearchOptionId
      )?.displayName ?? "The selected search engine";
      useComposerControlStore.getState().setSelectedSearchPlan(
        runControlSnapshot.searchPreferencePlan.optionIds.filter((optionId) =>
          modelForSend.searchStrategyIds.includes(optionId)
        ),
        runControlSnapshot.searchPreferencePlan.mode,
        "system"
      );
      setNotice({
        autoDismiss: true,
        kind: "error",
        text: `Sent without web search: ${optionName} is not available for ${modelForSend.displayName}.`
      });
    }
    const blockingAttachment = sourceSession.attachments.find(
      (attachment) => attachmentBlocksSend(attachment, modelForSend)
    );
    if (blockingAttachment) {
      setNotice({
        kind: "error",
        text: blockingAttachment.status === "failed"
          ? attachmentRetryAvailable(blockingAttachment)
            ? `Remove or retry ${blockingAttachment.fileName} before sending.`
            : `Remove ${blockingAttachment.fileName} before sending.`
          : blockingAttachment.processingErrorCode
            ? `Remove ${blockingAttachment.fileName} before sending.`
            : `Wait for ${blockingAttachment.fileName} to finish processing before sending.`
      });
      return;
    }
    const blockingAttachmentWarning = firstBlockingAttachmentWarning(
      sourceSession.attachments,
      modelForSend
    );
    if (blockingAttachmentWarning) {
      setNotice({
        kind: "error",
        text: blockingAttachmentWarning.message
      });
      return;
    }
    const attachmentLimitUsage = calculateAttachmentLimitUsage(
      sourceSession.attachments,
      modelForSend,
      (resolveCatalog ? resolveCatalog() : useWorkspaceStore.getState().catalog)?.attachmentLimits
    );
    if (attachmentLimitUsage.blocking && attachmentLimitUsage.feedback) {
      setNotice({
        kind: "error",
        text: attachmentLimitUsage.feedback
      });
      return;
    }
    const sourceComposerChatId = chatIdFromComposerSessionKey(sourceSessionKey);
    const initialMemoryPayload = temporaryAdmissionPayload(
      sourceSessionKey,
      sourceComposerChatId
    );
    const temporaryRun = Object.hasOwn(initialMemoryPayload, "chatMode") || Boolean(
      sourceComposerChatId && useWorkspaceStore.getState().chats.find(
        (chat) => chat.id === sourceComposerChatId
      )?.memoryMode === "TEMPORARY"
    );
    let startedFromBlankWorkspace = sourceComposerChatId === null;
    if (sourceComposerChatId !== activeChatId) {
      return;
    }
    if (
      sourceComposerChatId &&
      hasUnreconciledOptimisticLeaf(sourceComposerChatId) &&
      !(await reconcileBeforeRunMutation(sourceComposerChatId))
    ) {
      return;
    }

    const sendToken = useComposerSessionStore.getState().beginSend(sourceSessionKey, {
      attachmentBlocksSend: (attachment) => attachmentBlocksSend(attachment, modelForSend)
    });
    if (!sendToken) {
      return;
    }

    const text = sendToken.draft.trim();
    const contentBlocks = [
      ...(text
        ? [
            {
              text,
              type: "text" as const
            }
          ]
        : []),
      ...sendToken.attachments.map((attachment) =>
        attachment.kind === "image"
          ? { attachmentId: attachment.id, alt: attachment.fileName, type: "image" as const }
          : { attachmentId: attachment.id, fileName: attachment.fileName, type: "file" as const }
      )
    ];
    let sendOutcome: "cancelled" | "failed" | "succeeded" = "failed";
    let sendFailureMessage: string | null = null;
    let sendFailureLive = true;
    let sendFailedBeforeRun = false;
    let sendRejectionMessage: string | null = null;
    try {
      let chatIdForSend = sourceComposerChatId;
      const thread = selectThreadSnapshot(useThreadStore.getState(), chatIdForSend);
      let currentChatSummary = chatIdForSend
        ? useWorkspaceStore
            .getState()
            .chats.find((candidate) => candidate.id === chatIdForSend)
        : null;
      let parentLeafForSend =
        effectiveActiveLeafId(thread.messages, thread.activeLeafId) ??
        currentChatSummary?.activeLeafMessageId ??
        activeChat?.activeLeafMessageId ??
        null;
      if (!chatIdForSend) {
        const chat = await createChat(
          folderIdFromComposerSessionKey(sourceSessionKey),
          sourceSessionKey
        );
        if (!chat) {
          return;
        }

        chatIdForSend = chat.id;
        currentChatSummary = chat;
        parentLeafForSend = chat.activeLeafMessageId;
      }
      const projectDraftForSend = currentChatSummary?.pendingProjectDraft ?? null;
      startedFromBlankWorkspace = startedFromBlankWorkspace || Boolean(projectDraftForSend);
      const sendControlPayload = runControlPayload(
        runControlSnapshot,
        Boolean(currentChatSummary?.projectId)
      );

      if (useRunLifecycleStore.getState().activeStreams[chatIdForSend]) {
        return;
      }

      if (chatIdForSend && parentLeafForSend) {
        try {
          await persistActiveLeaf(chatIdForSend, parentLeafForSend);
        } catch (error) {
          setNotice({
            kind: "error",
            text: errorMessage(error)
          });
          return;
        }
      }

      const userMessage: ThreadMessage = {
        content: sendToken.attachments.length > 0 ? { blocks: contentBlocks } : text,
        id: `user-${Date.now()}`,
        modelId: runControlSnapshot.modelId,
        parentMessageId: parentLeafForSend,
        provider: runControlSnapshot.provider,
        role: "user",
        status: "complete"
      };
      const assistantId = `assistant-${Date.now()}`;
      const assistantMessage: ThreadMessage = {
        content: "",
        id: assistantId,
        modelId: runControlSnapshot.modelId,
        parentMessageId: userMessage.id,
        provider: runControlSnapshot.provider,
        role: "assistant",
        status: "streaming"
      };

      mergeStreamChatMessages(chatIdForSend, [userMessage, assistantMessage]);
      updateStreamChatActiveLeaf(chatIdForSend, assistantId);
      if (activeChatIdRef.current === chatIdForSend) {
        resetThreadToLatest();
      }

      sendFailureLive = false;
      const result = await executeMessageRunLifecycle({
        activeChatIdRef,
        activeStreamAbortRef,
        chatId: chatIdForSend,
        consumeRunStream,
        createStreamTokenBuffer,
        failurePrefix: "send_failed",
        fetchRun,
        notifyAnswerReady,
        optimisticAssistantMessageId: assistantId,
        primeAnswerSound,
        reconcileMessageIds({ currentRunId, messageIds }) {
          const persistedUserId = messageIds.userMessageId;
          const persistedAssistantId = messageIds.assistantMessageId;

          if (persistedAssistantId) {
            updateStreamChatActiveLeaf(chatIdForSend, persistedAssistantId, assistantId);
          }

          updateStreamChatMessages(chatIdForSend, (current) =>
            current.map((message) => {
              if (persistedUserId && message.id === userMessage.id) {
                return {
                  ...message,
                  id: persistedUserId
                };
              }

              if (persistedAssistantId && message.id === assistantId) {
                return {
                  ...message,
                  id: persistedAssistantId,
                  parentMessageId: persistedUserId ?? message.parentMessageId,
                  runId: currentRunId ?? message.runId
                };
              }

              if (persistedUserId && message.parentMessageId === userMessage.id) {
                return {
                  ...message,
                  parentMessageId: persistedUserId
                };
              }

              return message;
            })
          );
        },
        refreshActiveChat,
        async request(signal) {
          const response = await shellFetch(`/api/chats/${chatIdForSend}/messages`, {
            body: JSON.stringify({
              content: {
                blocks: contentBlocks
              },
              expectedActiveLeafId: parentLeafForSend,
              ...(projectDraftForSend ? { projectDraft: projectDraftForSend } : {}),
              ...initialMemoryPayload,
              ...sendControlPayload
            }),
            headers: {
              "content-type": "application/json"
            },
            method: "POST",
            signal
          });
          if (response.ok && projectDraftForSend) {
            useWorkspaceStore.getState().updateChats((current) => current.map((chat) =>
              chat.id === chatIdForSend &&
              chat.pendingProjectDraft?.projectId === projectDraftForSend.projectId &&
              chat.pendingProjectDraft.folderId === projectDraftForSend.folderId
                ? { ...chat, pendingProjectDraft: undefined }
                : chat
            ));
          }
          return response;
        },
        settleFailedRunState({ kind }) {
          if (kind === "rejected") {
            rollbackOptimisticRun({
              chatId: chatIdForSend,
              expectedParentMessageId: parentLeafForSend,
              optimisticAssistantMessageId: assistantId,
              optimisticUserMessageId: userMessage.id,
              previousLeafId: parentLeafForSend
            });
            if (startedFromBlankWorkspace) {
              useRunSurfaceStore.getState().resetSurface(chatIdForSend);
              sendFailureLive = true;
            }
            return;
          }

          // Ambiguous transport loss remains visible on the exact source chat.
          // The user-owned refresh action reconciles it with durable server state.
        }
      });
      if (
        refreshProjectWorkspace &&
        (result.failureCode === "project_setup_required" ||
          result.failureCode === "project_default_model_unavailable")
      ) {
        try {
          await refreshProjectWorkspace();
        } catch {
          // The typed admission failure remains authoritative when canonical
          // readiness resynchronization is temporarily unavailable.
        }
      }
      if (result.failureCode === "memory_intent_confirmation_required") {
        await showMemoryTargetSelection();
      }
      if (temporaryRun) {
        await reconcileTemporaryAdmission(chatIdForSend);
      }
      sendOutcome = result.cancelled ? "cancelled" : result.failed ? "failed" : "succeeded";
      sendFailureMessage = result.failureMessage ?? null;
      // The Memory-target prompt already carries its own persistent action.
      sendFailedBeforeRun = result.failed && result.runId === null &&
        result.failureCode !== "memory_intent_confirmation_required";
      sendRejectionMessage = result.rejectionMessage ?? null;
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      useComposerSessionStore.getState().finishSend(
        sendToken,
        sendOutcome,
        sendOutcome === "failed"
          ? sendFailureMessage ?? "Send failed. Your draft was preserved."
          : null,
        sendFailureLive
      );
    }
    // A send that never started a run leaves nothing in the thread, so the
    // persistent notice carries the server's reason and a Retry that resends
    // the preserved draft (UX audit 2026-09-02 A8); failures after run_start
    // keep the in-thread error card.
    if (sendOutcome === "failed" && sendFailedBeforeRun) {
      setNotice({
        action: { label: "Retry", onClick: () => void sendMessage() },
        kind: "error",
        persistent: true,
        text: sendRejectionMessage ?? sendFailureMessage ?? "Send failed. Your draft was preserved."
      });
    }
  }

  /**
   * Sends a stored starter prompt as an ordinary user message through the exact
   * normal send/admission path. It never touches the composer draft: failure
   * reports a notice instead of restoring starter text into the draft.
   */
  async function sendStarterPrompt(promptText: string) {
    const text = promptText.trim();
    if (!text || activeChatDetailLoading) {
      return;
    }
    const sourceSessionKey = useComposerSessionStore.getState().activeSessionKey;
    const sourceSession = selectComposerSession(
      useComposerSessionStore.getState(),
      sourceSessionKey
    );
    if (
      sourceSession.draft.trim() ||
      sourceSession.attachments.length > 0 ||
      sourceSession.pendingSend ||
      sourceSession.pendingUploadGenerations.length > 0
    ) {
      return;
    }
    const runControlSnapshot = captureRunControlSnapshot();
    if (!runControlSnapshot.model) {
      return;
    }
    const sourceComposerChatId = chatIdFromComposerSessionKey(sourceSessionKey);
    const initialMemoryPayload = temporaryAdmissionPayload(
      sourceSessionKey,
      sourceComposerChatId
    );
    const temporaryRun = Object.hasOwn(initialMemoryPayload, "chatMode") || Boolean(
      sourceComposerChatId && useWorkspaceStore.getState().chats.find(
        (chat) => chat.id === sourceComposerChatId
      )?.memoryMode === "TEMPORARY"
    );
    if (sourceComposerChatId !== activeChatId) {
      return;
    }
    if (
      sourceComposerChatId &&
      hasUnreconciledOptimisticLeaf(sourceComposerChatId) &&
      !(await reconcileBeforeRunMutation(sourceComposerChatId))
    ) {
      return;
    }

    const contentBlocks = [{ text, type: "text" as const }];
    try {
      let chatIdForSend = sourceComposerChatId;
      const thread = selectThreadSnapshot(useThreadStore.getState(), chatIdForSend);
      let currentChatSummary = chatIdForSend
        ? useWorkspaceStore
            .getState()
            .chats.find((candidate) => candidate.id === chatIdForSend)
        : null;
      let parentLeafForSend =
        effectiveActiveLeafId(thread.messages, thread.activeLeafId) ??
        currentChatSummary?.activeLeafMessageId ??
        activeChat?.activeLeafMessageId ??
        null;
      if (!chatIdForSend) {
        const chat = await createChat(
          folderIdFromComposerSessionKey(sourceSessionKey),
          sourceSessionKey
        );
        if (!chat) {
          return;
        }

        chatIdForSend = chat.id;
        currentChatSummary = chat;
        parentLeafForSend = chat.activeLeafMessageId;
      }
      const projectDraftForSend = currentChatSummary?.pendingProjectDraft ?? null;
      const starterControlPayload = runControlPayload(
        runControlSnapshot,
        Boolean(currentChatSummary?.projectId)
      );

      if (useRunLifecycleStore.getState().activeStreams[chatIdForSend]) {
        return;
      }

      if (chatIdForSend && parentLeafForSend) {
        try {
          await persistActiveLeaf(chatIdForSend, parentLeafForSend);
        } catch (error) {
          setNotice({ kind: "error", text: errorMessage(error) });
          return;
        }
      }

      const userMessage: ThreadMessage = {
        content: text,
        id: `user-${Date.now()}`,
        modelId: runControlSnapshot.modelId,
        parentMessageId: parentLeafForSend,
        provider: runControlSnapshot.provider,
        role: "user",
        status: "complete"
      };
      const assistantId = `assistant-${Date.now()}`;
      const assistantMessage: ThreadMessage = {
        content: "",
        id: assistantId,
        modelId: runControlSnapshot.modelId,
        parentMessageId: userMessage.id,
        provider: runControlSnapshot.provider,
        role: "assistant",
        status: "streaming"
      };

      mergeStreamChatMessages(chatIdForSend, [userMessage, assistantMessage]);
      updateStreamChatActiveLeaf(chatIdForSend, assistantId);
      if (activeChatIdRef.current === chatIdForSend) {
        resetThreadToLatest();
      }

      const result = await executeMessageRunLifecycle({
        activeChatIdRef,
        activeStreamAbortRef,
        chatId: chatIdForSend,
        consumeRunStream,
        createStreamTokenBuffer,
        failurePrefix: "send_failed",
        fetchRun,
        notifyAnswerReady,
        optimisticAssistantMessageId: assistantId,
        primeAnswerSound,
        reconcileMessageIds({ currentRunId, messageIds }) {
          const persistedUserId = messageIds.userMessageId;
          const persistedAssistantId = messageIds.assistantMessageId;

          if (persistedAssistantId) {
            updateStreamChatActiveLeaf(chatIdForSend, persistedAssistantId, assistantId);
          }

          updateStreamChatMessages(chatIdForSend, (current) =>
            current.map((message) => {
              if (persistedUserId && message.id === userMessage.id) {
                return { ...message, id: persistedUserId };
              }
              if (persistedAssistantId && message.id === assistantId) {
                return {
                  ...message,
                  id: persistedAssistantId,
                  parentMessageId: persistedUserId ?? message.parentMessageId,
                  runId: currentRunId ?? message.runId
                };
              }
              if (persistedUserId && message.parentMessageId === userMessage.id) {
                return { ...message, parentMessageId: persistedUserId };
              }
              return message;
            })
          );
        },
        refreshActiveChat,
        async request(signal) {
          const response = await shellFetch(`/api/chats/${chatIdForSend}/messages`, {
            body: JSON.stringify({
              content: { blocks: contentBlocks },
              expectedActiveLeafId: parentLeafForSend,
              ...(projectDraftForSend ? { projectDraft: projectDraftForSend } : {}),
              ...initialMemoryPayload,
              ...starterControlPayload
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal
          });
          if (response.ok && projectDraftForSend) {
            useWorkspaceStore.getState().updateChats((current) => current.map((chat) =>
              chat.id === chatIdForSend &&
              chat.pendingProjectDraft?.projectId === projectDraftForSend.projectId &&
              chat.pendingProjectDraft.folderId === projectDraftForSend.folderId
                ? { ...chat, pendingProjectDraft: undefined }
                : chat
            ));
          }
          return response;
        },
        settleFailedRunState({ kind }) {
          if (kind === "rejected") {
            rollbackOptimisticRun({
              chatId: chatIdForSend,
              expectedParentMessageId: parentLeafForSend,
              optimisticAssistantMessageId: assistantId,
              optimisticUserMessageId: userMessage.id,
              previousLeafId: parentLeafForSend
            });
            return;
          }
        }
      });
      if (result.failureCode === "memory_intent_confirmation_required") {
        await showMemoryTargetSelection();
      }
      if (temporaryRun) {
        await reconcileTemporaryAdmission(chatIdForSend);
      }
    } catch (error) {
      setNotice({ kind: "error", text: errorMessage(error) });
    }
  }

  async function regenerateMessage(messageId: string) {
    const chatIdForRegenerate = activeChatId;
    if (!chatIdForRegenerate) {
      return;
    }

    if (useRunLifecycleStore.getState().activeStreams[chatIdForRegenerate]) {
      return;
    }
    const runControlSnapshot = captureRunControlSnapshot();
    if (
      hasUnreconciledOptimisticLeaf(chatIdForRegenerate) &&
      !(await reconcileBeforeRunMutation(chatIdForRegenerate))
    ) {
      return;
    }

    const threadBeforeRegenerate = selectThreadSnapshot(
      useThreadStore.getState(),
      chatIdForRegenerate
    );
    const original = threadBeforeRegenerate.messages.find(
      (message) => message.id === messageId
    );
    if (!original) {
      return;
    }
    const regenerationParentMessageId =
      original.role === "assistant" ? original.parentMessageId : original.id;
    const regenerateControlPayload = runControlPayload(
      runControlSnapshot,
      Boolean(activeChat?.projectId)
    );

    const assistantId = `assistant-regen-${Date.now()}`;
    const assistantMessage: ThreadMessage = {
      content: "",
      id: assistantId,
      modelId: runControlSnapshot.modelId,
      parentMessageId: regenerationParentMessageId,
      provider: runControlSnapshot.provider,
      role: "assistant",
      status: "streaming"
    };

    mergeStreamChatMessages(chatIdForRegenerate, [assistantMessage]);
    updateStreamChatActiveLeaf(chatIdForRegenerate, assistantId);
    resetThreadToLatest();

    const result = await executeMessageRunLifecycle({
      activeChatIdRef,
      activeStreamAbortRef,
      chatId: chatIdForRegenerate,
      consumeRunStream,
      createStreamTokenBuffer,
      failurePrefix: "regenerate_failed",
      fetchRun,
      notifyAnswerReady,
      optimisticAssistantMessageId: assistantId,
      primeAnswerSound,
      reconcileMessageIds({ currentRunId, messageIds }) {
        if (!messageIds.assistantMessageId) {
          return;
        }

        const persistedAssistantId = messageIds.assistantMessageId;
        updateStreamChatActiveLeaf(chatIdForRegenerate, persistedAssistantId, assistantId);
        updateStreamChatMessages(chatIdForRegenerate, (current) =>
          current.map((message) =>
            message.id === assistantId
              ? {
                  ...message,
                  id: persistedAssistantId,
                  runId: currentRunId ?? message.runId
                }
              : message
          )
        );
      },
      refreshActiveChat,
      request(signal) {
        return shellFetch(`/api/messages/${messageId}/regenerate`, {
          body: JSON.stringify({
            ...regenerateControlPayload
          }),
          headers: {
            "content-type": "application/json"
          },
          method: "POST",
          signal
        });
      },
      settleFailedRunState({ kind }) {
        if (kind === "rejected") {
          rollbackOptimisticRun({
            chatId: chatIdForRegenerate,
            expectedParentMessageId: regenerationParentMessageId,
            optimisticAssistantMessageId: assistantId,
            previousLeafId: threadBeforeRegenerate.activeLeafId
          });
          return;
        }
      }
    });
    if (result.failureCode === "memory_intent_confirmation_required") {
      await showMemoryTargetSelection();
    }
    if (isTemporaryChat(chatIdForRegenerate)) {
      await reconcileTemporaryAdmission(chatIdForRegenerate);
    }
  }

  return {
    refreshInterruptedRun,
    regenerateMessage,
    sendStarterPrompt,
    submitComposer
  };
}
