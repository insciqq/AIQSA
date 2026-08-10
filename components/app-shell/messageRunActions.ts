import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import { firstBlockingAttachmentWarning } from "@/components/app-shell/attachmentCapabilities";
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
import { projectSearchPlanCompatibility } from "@/components/app-shell/searchPlanCompatibility";
import { effectiveActiveLeafId } from "@/components/app-shell/threadPath";
import { selectThreadSnapshot, useThreadStore } from "@/components/app-shell/threadStore";
import type {
  Catalog,
  CatalogModel,
  ChatDetail,
  ChatSummary,
  Notice,
  ThreadMessage
} from "@/components/app-shell/types";
import {
  refreshMemorySettings,
  useMemorySettingsStore
} from "@/components/app-shell/memorySettingsStore";
import { memoryUiCopy } from "@/components/app-shell/memoryUiCopy";
import type { SavedControlDraft } from "@/components/app-shell/powerAppShellData";
import type { RunStreamTokenBuffer } from "@/components/app-shell/useRunStream";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type { SearchPlanMode } from "@/lib/domain/search";
import type { ComposerKnowledgePlanSource } from "@/components/app-shell/composerControlStore";
import { MEMORY_TEMPORARY_RETENTION_POLICY_VERSION } from "@/lib/contracts/memory";

type MutableRef<T> = { current: T };

type MessageRunControlSnapshot = {
  assistantId: string | null;
  controlDefaults: SavedControlDraft;
  model: CatalogModel | undefined;
  modelId: string;
  knowledgeBaseIds: string[];
  knowledgePlanSource: ComposerKnowledgePlanSource;
  params: Record<string, unknown>;
  provider: string;
  searchPreferencePlan: {
    mode: SearchPlanMode;
    optionIds: string[];
  };
  searchPreferenceSource: Catalog["defaults"]["searchPreferenceSource"];
  searchOptions: Catalog["searchStrategies"];
  toolsOverride: { tools: "none" } | Record<string, never>;
};

type MessageRunActionsInput = {
  activeChat: ChatSummary | null;
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
  ): Promise<ChatSummary | null>;
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
  modelId: string
): CatalogModel | undefined {
  if (renderedModel?.provider === provider && renderedModel.modelId === modelId) {
    return renderedModel;
  }

  return useWorkspaceStore
    .getState()
    .catalog?.models.find((model) => model.provider === provider && model.modelId === modelId);
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
  resetThreadToLatest,
  setNotice
}: MessageRunActionsInput) {
  async function showMemoryTargetSelection(): Promise<void> {
    let locale = useMemorySettingsStore.getState().data?.settings.memoryUiLocale ?? "RU";
    try {
      locale = (await refreshMemorySettings()).settings.memoryUiLocale;
    } catch {
      // The feature contract defaults to a complete RU surface when the
      // account preference cannot be refreshed; never mix per-key fallbacks.
    }
    setNotice({
      action: {
        label: memoryUiCopy(locale, "action.manage"),
        onClick: openMemorySettings
      },
      kind: "error",
      persistent: true,
      text: memoryUiCopy(locale, "action.ambiguous")
    });
  }

  function captureRunControlSnapshot(): MessageRunControlSnapshot {
    const {
      selectedAssistant,
      selectedKnowledgeBaseIds,
      selectedModelId,
      selectedProvider,
      selectedSearchOptionIds,
      searchPlanMode,
      knowledgePlanSource
    } = useComposerControlStore.getState();
    const catalog = useWorkspaceStore.getState().catalog;
    const selectedModel = modelForCurrentSelection(
      currentModel,
      selectedProvider,
      selectedModelId
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
      knowledgeBaseIds: [...selectedKnowledgeBaseIds],
      knowledgePlanSource,
      model,
      modelId: selectedModelId,
      params: { ...buildParams() },
      provider: selectedProvider,
      searchPreferencePlan: {
        mode: searchPlanMode,
        optionIds: searchPreferenceOptionIds
      },
      searchPreferenceSource:
        catalog?.defaults.searchPreferenceSource,
      searchOptions: (catalog?.searchStrategies ?? []).map((option) => ({
        ...option,
        ...(option.executionModes
          ? { executionModes: [...option.executionModes] }
          : {})
      })),
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
              memoryMode: response.chat.mode,
              memorySourceRevision: response.chat.sourceRevision,
              pendingInitialMemoryMode: response.chat.mode === "TEMPORARY"
                ? undefined
                : chat.pendingInitialMemoryMode,
              temporaryRetentionDeadline: response.chat.temporaryRetentionDeadline
            }
          : chat
      ));
    } catch {
      // Keep the pending intent on ambiguous transport failures. A retry then
      // repeats the exact reviewed admission payload instead of silently downgrading.
    }
  }

  function runControlPayload(snapshot: MessageRunControlSnapshot) {
    if (snapshot.assistantId) {
      // The server resolves the currently authorized revision at admission;
      // the request carries only the Assistant identity plus user content and
      // never an expanded client copy of the governed controls.
      return { assistantId: snapshot.assistantId };
    }

    const effectiveSearchPlan = projectSearchPlanCompatibility({
      mode: snapshot.searchPreferencePlan.mode,
      model: snapshot.model,
      searchOptions: snapshot.searchOptions,
      selectedOptionIds: snapshot.searchPreferencePlan.optionIds
    }).effectivePlan;
    const timeZone = clientTimeZone();

    return {
      controlDefaults: snapshot.controlDefaults,
      modelId: snapshot.modelId,
      ...(snapshot.knowledgePlanSource === "explicit"
        ? { knowledgePlan: { baseIds: [...snapshot.knowledgeBaseIds] } }
        : {}),
      params: snapshot.params,
      provider: snapshot.provider,
      searchPlan: effectiveSearchPlan,
      ...(snapshot.searchPreferenceSource
        ? {
            searchPreferencePlan: snapshot.searchPreferencePlan,
            searchPreferenceSource: snapshot.searchPreferenceSource
          }
        : {}),
      searchStrategy:
        effectiveSearchPlan.optionIds[0] ?? "search-disabled",
      ...(timeZone ? { timeZone } : {}),
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
            ...runControlPayload(runControlSnapshot)
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

  async function reconcileAmbiguousRun(chatId: string) {
    await refreshActiveChat(chatId, {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    });
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
    const unsettledAttachment = sourceSession.attachments.find(
      (attachment) => attachment.status !== undefined && attachment.status !== "ready"
    );
    if (unsettledAttachment) {
      setNotice({
        kind: "error",
        text: unsettledAttachment.status === "failed"
          ? attachmentRetryAvailable(unsettledAttachment)
            ? `Remove or retry ${unsettledAttachment.fileName} before sending.`
            : `Remove ${unsettledAttachment.fileName} before sending.`
          : `Wait for ${unsettledAttachment.fileName} to finish processing before sending.`
      });
      return;
    }
    const runControlSnapshot = captureRunControlSnapshot();
    const modelForSend = runControlSnapshot.model;
    if (!modelForSend) {
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
      useWorkspaceStore.getState().catalog?.attachmentLimits
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
    const startedFromBlankWorkspace = sourceComposerChatId === null;
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

    const sendToken = useComposerSessionStore.getState().beginSend(sourceSessionKey);
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
    const sendControlPayload = runControlPayload(runControlSnapshot);

    let sendOutcome: "cancelled" | "failed" | "succeeded" = "failed";
    let sendFailureMessage: string | null = null;
    let sendFailureLive = true;
    try {
      let chatIdForSend = sourceComposerChatId;
      const thread = selectThreadSnapshot(useThreadStore.getState(), chatIdForSend);
      const currentChatSummary = chatIdForSend
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
        parentLeafForSend = chat.activeLeafMessageId;
      }

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
        request(signal) {
          return shellFetch(`/api/chats/${chatIdForSend}/messages`, {
            body: JSON.stringify({
              content: {
                blocks: contentBlocks
              },
              expectedActiveLeafId: parentLeafForSend,
              ...initialMemoryPayload,
              ...sendControlPayload
            }),
            headers: {
              "content-type": "application/json"
            },
            method: "POST",
            signal
          });
        },
        async settleFailedRunState({ kind }) {
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

          await reconcileAmbiguousRun(chatIdForSend);
          if (
            activeChatIdRef.current === chatIdForSend &&
            selectThreadSnapshot(useThreadStore.getState(), chatIdForSend).messages.length === 0
          ) {
            sendFailureLive = true;
          }
        }
      });
      if (result.failureCode === "memory_intent_confirmation_required") {
        await showMemoryTargetSelection();
      }
      if (temporaryRun) {
        await reconcileTemporaryAdmission(chatIdForSend);
      }
      sendOutcome = result.cancelled ? "cancelled" : result.failed ? "failed" : "succeeded";
      sendFailureMessage = result.failureMessage ?? null;
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
    const starterControlPayload = runControlPayload(runControlSnapshot);

    try {
      let chatIdForSend = sourceComposerChatId;
      const thread = selectThreadSnapshot(useThreadStore.getState(), chatIdForSend);
      const currentChatSummary = chatIdForSend
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
        parentLeafForSend = chat.activeLeafMessageId;
      }

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
        request(signal) {
          return shellFetch(`/api/chats/${chatIdForSend}/messages`, {
            body: JSON.stringify({
              content: { blocks: contentBlocks },
              expectedActiveLeafId: parentLeafForSend,
              ...initialMemoryPayload,
              ...starterControlPayload
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal
          });
        },
        async settleFailedRunState({ kind }) {
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

          await reconcileAmbiguousRun(chatIdForSend);
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
    const regenerateControlPayload = runControlPayload(runControlSnapshot);

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
      async settleFailedRunState({ kind }) {
        if (kind === "rejected") {
          rollbackOptimisticRun({
            chatId: chatIdForRegenerate,
            expectedParentMessageId: regenerationParentMessageId,
            optimisticAssistantMessageId: assistantId,
            previousLeafId: threadBeforeRegenerate.activeLeafId
          });
          return;
        }

        await reconcileAmbiguousRun(chatIdForRegenerate);
      }
    });
    if (result.failureCode === "memory_intent_confirmation_required") {
      await showMemoryTargetSelection();
    }
  }

  return {
    regenerateMessage,
    sendStarterPrompt,
    submitComposer
  };
}
