import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  chatIdFromComposerSessionKey,
  folderIdFromComposerSessionKey,
  selectComposerSession,
  useComposerSessionStore,
  type ComposerSessionKey
} from "@/components/app-shell/composerSessionStore";
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
  CatalogModel,
  ChatDetail,
  ChatSummary,
  ThreadMessage
} from "@/components/app-shell/types";
import type { SavedControlDraft } from "@/components/app-shell/powerAppShellData";
import type { RunStreamTokenBuffer } from "@/components/app-shell/useRunStream";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { renderLocalPromptTemplate } from "@/lib/domain/promptTemplates";

type MutableRef<T> = { current: T };

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
  persistActiveLeaf(chatId: string, messageId: string | null): Promise<unknown>;
  primeAnswerSound(): Promise<void>;
  refreshActiveChat(
    chatId: string | null,
    options?: { forceDetail?: boolean; preserveControls?: boolean; resumeRuns?: boolean }
  ): Promise<ChatDetail | null>;
  resetThreadToLatest(): void;
  setNotice(input: { kind: "error"; text: string }): void;
  activeChatStreaming: boolean;
};

function toolsOverride(model: CatalogModel | undefined): { tools: "none" } | Record<string, never> {
  return model && !model.capabilities.toolCalling ? { tools: "none" } : {};
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
  persistActiveLeaf,
  primeAnswerSound,
  refreshActiveChat,
  resetThreadToLatest,
  setNotice
}: MessageRunActionsInput) {
  async function editMessageBranch() {
    const sourceSessionKey = useComposerSessionStore.getState().activeSessionKey;
    const sourceChatId = chatIdFromComposerSessionKey(sourceSessionKey);
    if (!sourceChatId || sourceChatId !== activeChatId) {
      return;
    }

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

    await startEditedBranchRun(sourceChatId, committed.id);
  }

  async function startEditedBranchRun(chatId: string, editedUserMessageId: string) {
    if (useRunLifecycleStore.getState().activeStreams[chatId]) {
      return;
    }

    const {
      developerPrompt,
      selectedModelId,
      selectedPromptId,
      selectedProvider,
      selectedSearchStrategy,
      systemPrompt
    } = useComposerControlStore.getState();
    const assistantId = `assistant-${Date.now()}`;
    const assistantMessage: ThreadMessage = {
      content: "",
      id: assistantId,
      modelId: selectedModelId,
      parentMessageId: editedUserMessageId,
      provider: selectedProvider,
      role: "assistant",
      status: "streaming"
    };

    mergeStreamChatMessages(chatId, [assistantMessage]);
    updateStreamChatActiveLeaf(chatId, assistantId);
    if (activeChatIdRef.current === chatId) {
      resetThreadToLatest();
    }

    await executeMessageRunLifecycle({
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
            modelId: selectedModelId,
            controlDefaults: buildControlDraft(),
            params: buildParams(),
            prompt: {
              developer: renderLocalPromptTemplate(developerPrompt),
              presetId: selectedPromptId,
              system: renderLocalPromptTemplate(systemPrompt)
            },
            provider: selectedProvider,
            searchStrategy: selectedSearchStrategy,
            ...toolsOverride(currentModel)
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
    const {
      developerPrompt,
      selectedModelId,
      selectedPromptId,
      selectedProvider,
      selectedSearchStrategy,
      systemPrompt
    } = useComposerControlStore.getState();
    if (
      (!sourceSession.draft.trim() && sourceSession.attachments.length === 0) ||
      !currentModel ||
      activeChatDetailLoading
    ) {
      return;
    }
    const controlDefaultsForSend = buildControlDraft();
    const paramsForSend = buildParams();
    const sourceComposerChatId = chatIdFromComposerSessionKey(sourceSessionKey);
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

    let sendOutcome: "cancelled" | "failed" | "succeeded" = "failed";
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
        modelId: selectedModelId,
        parentMessageId: parentLeafForSend,
        provider: selectedProvider,
        role: "user",
        status: "complete"
      };
      const assistantId = `assistant-${Date.now()}`;
      const assistantMessage: ThreadMessage = {
        content: "",
        id: assistantId,
        modelId: selectedModelId,
        parentMessageId: userMessage.id,
        provider: selectedProvider,
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
              controlDefaults: controlDefaultsForSend,
              expectedActiveLeafId: parentLeafForSend,
              modelId: selectedModelId,
              params: paramsForSend,
              prompt: {
                developer: renderLocalPromptTemplate(developerPrompt),
                presetId: selectedPromptId,
                system: renderLocalPromptTemplate(systemPrompt)
              },
              provider: selectedProvider,
              searchStrategy: selectedSearchStrategy,
              ...toolsOverride(currentModel)
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
            }
            return;
          }

          await reconcileAmbiguousRun(chatIdForSend);
        }
      });
      sendOutcome = result.cancelled ? "cancelled" : result.failed ? "failed" : "succeeded";
    } catch (error) {
      setNotice({
        kind: "error",
        text: errorMessage(error)
      });
    } finally {
      useComposerSessionStore.getState().finishSend(
        sendToken,
        sendOutcome,
        sendOutcome === "failed" ? "Send failed. Your draft was preserved." : null
      );
    }
  }

  async function regenerateMessage(messageId: string) {
    const {
      developerPrompt,
      selectedModelId,
      selectedPromptId,
      selectedProvider,
      selectedSearchStrategy,
      systemPrompt
    } = useComposerControlStore.getState();
    const chatIdForRegenerate = activeChatId;
    if (!chatIdForRegenerate) {
      return;
    }

    if (useRunLifecycleStore.getState().activeStreams[chatIdForRegenerate]) {
      return;
    }
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

    const assistantId = `assistant-regen-${Date.now()}`;
    const assistantMessage: ThreadMessage = {
      content: "",
      id: assistantId,
      modelId: selectedModelId,
      parentMessageId: regenerationParentMessageId,
      provider: selectedProvider,
      role: "assistant",
      status: "streaming"
    };

    mergeStreamChatMessages(chatIdForRegenerate, [assistantMessage]);
    updateStreamChatActiveLeaf(chatIdForRegenerate, assistantId);
    resetThreadToLatest();

    await executeMessageRunLifecycle({
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
            modelId: selectedModelId,
            controlDefaults: buildControlDraft(),
            params: buildParams(),
            prompt: {
              developer: renderLocalPromptTemplate(developerPrompt),
              presetId: selectedPromptId,
              system: renderLocalPromptTemplate(systemPrompt)
            },
            provider: selectedProvider,
            searchStrategy: selectedSearchStrategy,
            ...toolsOverride(currentModel)
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
  }

  return {
    regenerateMessage,
    submitComposer
  };
}
