import { decodePreparingRunAdmission } from "@/lib/contracts/runs";
import {
  errorMessage,
  responseErrorMessageDetails
} from "@/components/app-shell/shellFormatting";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import { useThreadStore } from "@/components/app-shell/threadStore";
import type { ThreadMessage } from "@/components/app-shell/types";
import type {
  RunStreamMessageIds,
  RunStreamTerminalStatus,
  RunStreamTokenBuffer
} from "@/components/app-shell/useRunStream";

type MutableRef<T> = { current: T };

export type ConsumeMessageRunStream = (input: {
  chatId: string;
  failurePrefix: string;
  onMessageIds(messageIds: RunStreamMessageIds, currentRunId: string | null): void;
  onRunId(runId: string): void;
  response: Response;
  tokenBuffer: RunStreamTokenBuffer;
}) => Promise<{
  failed: boolean;
  receivedChatUpdate: boolean;
  runId: string | null;
  terminalStatus: RunStreamTerminalStatus;
}>;

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
  /** User-facing reason of a server-rejected request (no run was started). */
  rejectionMessage?: string;
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
  kind: "ambiguous" | "rejected";
  message: string;
  runId: string | null;
}) {
  if (input.cancelled) {
    useRunSurfaceStore.getState().appendEvent(input.chatId, {
      data: {
        runId: input.runId,
        status: "cancelled"
      },
      type: "done"
    });
  } else if (input.kind === "rejected") {
    useRunSurfaceStore.getState().appendEvent(input.chatId, {
      data: {
        message: input.message
      },
      type: "error"
    });
  }

  updateStreamChatMessages(input.chatId, (current) =>
    current.map((candidate) =>
      candidate.id === input.assistantMessageId
        ? {
            ...candidate,
            content: input.cancelled
              ? candidate.content || "Stopped."
              : input.kind === "ambiguous"
                ? candidate.content
                : candidate.content || input.message,
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
  deferred?: boolean;
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
      candidate.id === input.assistantMessageId && candidate.status === "streaming" && !input.deferred
        ? {
            ...candidate,
            status: input.cancelled ? "cancelled" : input.failed ? "error" : "complete"
          }
        : candidate
    )
  );
}

function runWasCancelled(abortController: AbortController, runId: string | null): boolean {
  return (
    abortController.signal.aborted ||
    Boolean(runId && useRunLifecycleStore.getState().cancelledRunIds.has(runId))
  );
}

export async function executeMessageRunLifecycle({
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
  let deferred = false;
  let failureMessage: string | null = null;
  let failureCode: string | null = null;
  let receivedChatUpdate = false;
  let rejectionMessage: string | null = null;
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
      rejectionMessage = details.message;
      userFacingFailureMessage = details.preserveForComposer ? details.message : null;
      throw new Error(details.message);
    }

    if (response.status === 202) {
      const admitted = decodePreparingRunAdmission(await response.json());
      if (!admitted) throw new Error("run_admission_malformed");
      runId = admitted.run.id;
      assistantMessageId = admitted.assistantMessageId;
      reconcileMessageIds({ assistantMessageId, currentRunId: runId,
        messageIds: { assistantMessageId, userMessageId: admitted.userMessageId }, optimisticAssistantMessageId });
      useRunLifecycleStore.getState().runIdReceived({ chatId, runId });
      updateStreamChatMessages(chatId, (messages) => messages.map((message) => message.id === assistantMessageId
        ? { ...message, runId, ...(admitted.run.pdfPreparation ? { pdfPreparation: admitted.run.pdfPreparation } : {}) }
        : message));
      deferred = true;
    } else {
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

    receivedChatUpdate = streamResult.receivedChatUpdate;
    runId = streamResult.runId;
    cancelled =
      streamResult.terminalStatus === "cancelled" ||
      runWasCancelled(abortController, runId);
    failed = streamResult.failed && !cancelled;
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
    if (!failed && !cancelled) {
      void notifyAnswerReady();
    }
    }
  } catch (error) {
    tokenBuffer.flush();
    cancelled = runWasCancelled(abortController, runId);
    failed = !cancelled;
    failureMessage = cancelled ? null : userFacingFailureMessage;
    if (activeStreamAbortRef.current.get(chatId) === abortController) {
      recordStreamFailure({
        assistantMessageId,
        cancelled,
        chatId,
        kind: serverRejectedRequest ? "rejected" : "ambiguous",
        message: errorMessage(error),
        runId
      });
      if (!cancelled) {
        if (!serverRejectedRequest) {
          useRunLifecycleStore.getState().streamAmbiguous({
            assistantMessageId,
            chatId,
            runId
          });
        }
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
      failed,
      deferred
    });
    if (deferred && !failed && !cancelled) {
      // Let the successful admission clear the submitted draft first. The
      // existing keyed resume owner then polls this committed background run.
      setTimeout(() => { void refreshActiveChat(chatId, { forceDetail: true, preserveControls: true }).catch(() => undefined); }, 0);
    }
  }

  return {
    assistantMessageId,
    cancelled,
    failed,
    ...(failureCode ? { failureCode } : {}),
    ...(failureMessage ? { failureMessage } : {}),
    receivedChatUpdate,
    ...(rejectionMessage && !cancelled ? { rejectionMessage } : {}),
    runId
  };
}
