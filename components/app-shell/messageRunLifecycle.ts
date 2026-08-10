import {
  errorMessage,
  responseErrorMessageDetails
} from "@/components/app-shell/shellFormatting";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import { useThreadStore } from "@/components/app-shell/threadStore";
import type { ThreadMessage } from "@/components/app-shell/types";
import type { RunStreamMessageIds, RunStreamTokenBuffer } from "@/components/app-shell/useRunStream";

type MutableRef<T> = { current: T };

export type ConsumeMessageRunStream = (input: {
  chatId: string;
  failurePrefix: string;
  onMessageIds(messageIds: RunStreamMessageIds, currentRunId: string | null): void;
  onRunId(runId: string): void;
  response: Response;
  tokenBuffer: RunStreamTokenBuffer;
}) => Promise<{ failed: boolean; receivedChatUpdate: boolean; runId: string | null }>;

type ReconcileMessageIdsInput = {
  assistantMessageId: string;
  currentRunId: string | null;
  messageIds: RunStreamMessageIds;
  optimisticAssistantMessageId: string;
};

type SettleMessageRunFailureInput = {
  assistantMessageId: string;
  kind: "ambiguous" | "rejected";
  optimisticAssistantMessageId: string;
  runId: string | null;
};

type ExecuteMessageRunLifecycleInput = {
  activeChatIdRef: MutableRef<string | null>;
  activeStreamAbortRef: MutableRef<Map<string, AbortController>>;
  chatId: string;
  consumeRunStream: ConsumeMessageRunStream;
  createStreamTokenBuffer(input: {
    chatId: string;
    getAssistantMessageId(): string;
  }): RunStreamTokenBuffer;
  failurePrefix: string;
  fetchRun(runId: string, chatId: string): Promise<unknown>;
  notifyAnswerReady(): Promise<void>;
  optimisticAssistantMessageId: string;
  primeAnswerSound(): Promise<void>;
  reconcileMessageIds(input: ReconcileMessageIdsInput): void;
  refreshActiveChat(
    chatId: string | null,
    options?: { forceDetail?: boolean; preserveControls?: boolean; resumeRuns?: boolean }
  ): Promise<unknown>;
  request(signal: AbortSignal): Promise<Response>;
  settleFailedRunState?(input: SettleMessageRunFailureInput): Promise<void> | void;
};

export type MessageRunLifecycleResult = {
  assistantMessageId: string;
  cancelled: boolean;
  failed: boolean;
  failureCode?: string;
  failureMessage?: string;
  receivedChatUpdate: boolean;
  runId: string | null;
};

function updateStreamChatMessages(
  chatId: string,
  updater: (messages: ThreadMessage[]) => ThreadMessage[]
) {
  useThreadStore.getState().updateMessages(chatId, updater);
}

function recordStreamFailure(input: {
  assistantMessageId: string;
  cancelled: boolean;
  chatId: string;
  message: string;
  runId: string | null;
}) {
  useRunSurfaceStore.getState().appendEvent(
    input.chatId,
    input.cancelled
      ? {
          data: {
            runId: input.runId,
            status: "cancelled"
          },
          type: "done"
        }
      : {
          data: {
            message: input.message
          },
          type: "error"
        }
  );

  updateStreamChatMessages(input.chatId, (current) =>
    current.map((candidate) =>
      candidate.id === input.assistantMessageId
        ? {
            ...candidate,
            content: input.cancelled ? candidate.content || "Stopped." : input.message,
            status: input.cancelled ? "cancelled" : "error"
          }
        : candidate
    )
  );
}

function finishStream(input: {
  abortController: AbortController;
  activeStreamAbortRef: MutableRef<Map<string, AbortController>>;
  assistantMessageId: string;
  cancelled: boolean;
  chatId: string;
  failed: boolean;
}) {
  const ownsAbortController =
    input.activeStreamAbortRef.current.get(input.chatId) === input.abortController;

  if (ownsAbortController) {
    input.activeStreamAbortRef.current.delete(input.chatId);
    useRunLifecycleStore.getState().streamFinished({
      chatId: input.chatId
    });
  }

  updateStreamChatMessages(input.chatId, (current) =>
    current.map((candidate) =>
      candidate.id === input.assistantMessageId && candidate.status === "streaming"
        ? {
            ...candidate,
            status: input.cancelled ? "cancelled" : input.failed ? "error" : "complete"
          }
        : candidate
    )
  );
}

export async function executeMessageRunLifecycle({
  activeChatIdRef,
  activeStreamAbortRef,
  chatId,
  consumeRunStream,
  createStreamTokenBuffer,
  failurePrefix,
  fetchRun,
  notifyAnswerReady,
  optimisticAssistantMessageId,
  primeAnswerSound,
  reconcileMessageIds,
  refreshActiveChat,
  request,
  settleFailedRunState
}: ExecuteMessageRunLifecycleInput): Promise<MessageRunLifecycleResult> {
  let assistantMessageId = optimisticAssistantMessageId;
  let cancelled = false;
  let failed = false;
  let failureMessage: string | null = null;
  let failureCode: string | null = null;
  let receivedChatUpdate = false;
  let runId: string | null = null;
  let serverRejectedRequest = false;
  let userFacingFailureMessage: string | null = null;
  const abortController = new AbortController();

  useRunSurfaceStore.getState().resetSurface(chatId);
  useRunLifecycleStore.getState().streamStarted({
    assistantMessageId: optimisticAssistantMessageId,
    chatId
  });
  void primeAnswerSound();
  activeStreamAbortRef.current.set(chatId, abortController);

  const tokenBuffer = createStreamTokenBuffer({
    chatId,
    getAssistantMessageId: () => assistantMessageId
  });

  try {
    const response = await request(abortController.signal);
    if (!response.ok) {
      serverRejectedRequest = true;
      const details = await responseErrorMessageDetails(
        response,
        `${failurePrefix}_${response.status}`
      );
      failureCode = details.code ?? null;
      userFacingFailureMessage = details.preserveForComposer ? details.message : null;
      throw new Error(details.message);
    }

    const streamResult = await consumeRunStream({
      chatId,
      failurePrefix,
      onMessageIds(messageIds, currentRunId) {
        const reconciledAssistantMessageId =
          messageIds.assistantMessageId ?? assistantMessageId;

        reconcileMessageIds({
          assistantMessageId: reconciledAssistantMessageId,
          currentRunId,
          messageIds,
          optimisticAssistantMessageId
        });

        if (messageIds.assistantMessageId) {
          assistantMessageId = reconciledAssistantMessageId;
          useRunLifecycleStore.getState().tokensApplied({
            assistantMessageId,
            chatId
          });
        }
      },
      onRunId(nextRunId) {
        runId = nextRunId;
        useRunLifecycleStore.getState().runIdReceived({ chatId, runId: nextRunId });
        updateStreamChatMessages(chatId, (current) =>
          current.map((message) =>
            message.id === assistantMessageId ? { ...message, runId: nextRunId } : message
          )
        );
      },
      response,
      tokenBuffer
    });

    failed = streamResult.failed;
    receivedChatUpdate = streamResult.receivedChatUpdate;
    runId = streamResult.runId;
    if (runId) {
      useRunLifecycleStore.getState().runIdReceived({ chatId, runId });
    }

    if (runId) {
      await fetchRun(runId, chatId);
    }

    if (!receivedChatUpdate) {
      const refreshed = await refreshActiveChat(chatId, {
        forceDetail: true,
        preserveControls: true
      });
      if (refreshed == null && useThreadStore.getState().threadsByChatId[chatId]) {
        useThreadStore.getState().mergeMessages(chatId, [], {
          sourceUpdatedAt: null
        });
      }
    }
    if (!failed) {
      void notifyAnswerReady();
    }
  } catch (error) {
    tokenBuffer.flush();
    cancelled = abortController.signal.aborted;
    failed = !cancelled;
    failureMessage = cancelled ? null : userFacingFailureMessage;
    if (activeStreamAbortRef.current.get(chatId) === abortController) {
      recordStreamFailure({
        assistantMessageId,
        cancelled,
        chatId,
        message: errorMessage(error),
        runId
      });
      if (!cancelled) {
        await settleFailedRunState?.({
          assistantMessageId,
          kind: serverRejectedRequest ? "rejected" : "ambiguous",
          optimisticAssistantMessageId,
          runId
        });
      }
    }
  } finally {
    finishStream({
      abortController,
      activeStreamAbortRef,
      assistantMessageId,
      cancelled,
      chatId,
      failed
    });
  }

  return {
    assistantMessageId,
    cancelled,
    failed,
    ...(failureCode ? { failureCode } : {}),
    ...(failureMessage ? { failureMessage } : {}),
    receivedChatUpdate,
    runId
  };
}
