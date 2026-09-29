import { decodePreparingRunAdmission } from "@/lib/contracts/runs";
import {
  errorMessage,
  responseErrorMessageDetails
} from "@/components/app-shell/shellFormatting";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import { useThreadStore } from "@/components/app-shell/threadStore";
import type { ThreadMessage } from "@/components/app-shell/types";
import { observeRunTransport, waitForRunTransport } from "./runTransportLifecycle";
import type {
  RunStreamMessageIds,
  RunStreamTerminalStatus,
  RunStreamTokenBuffer
} from "@/components/app-shell/useRunStream";

type MutableRef<T> = { current: T };

export type ConsumeMessageRunStream = (input: {
  chatId: string;
  failurePrefix: string;
  isCurrent?(): boolean;
  onAnswerComplete?(input: { assistantMessageId: string; runId: string }): void;
  onMessageIds(messageIds: RunStreamMessageIds, currentRunId: string | null): void;
  onRunId(runId: string): void;
  response: Response;
  signal?: AbortSignal;
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
  contextConfigurationKey?: string;
  createStreamTokenBuffer(input: {
    chatId: string;
    getAssistantMessageId(): string;
  }): RunStreamTokenBuffer;
  failurePrefix: string;
  /** `producer` lets the fetch confirm only the record this stream still owns. */
  fetchRun(runId: string, chatId: string, options?: { producer?: string }): Promise<unknown>;
  notifyAnswerReady(): Promise<void>;
  onAnswerPublished?(runId: string): void;
  onRunAdmitted?(runId: string): void;
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

let producerSerial = 0;

/** A page-unique token naming one foreground stream producer. */
function nextStreamProducer(): string {
  producerSerial += 1;
  return `stream-producer-${producerSerial}`;
}

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
  producer: string;
}) {
  const ownsAbortController =
    input.activeStreamAbortRef.current.get(input.chatId) === input.abortController;

  if (ownsAbortController) {
    input.activeStreamAbortRef.current.delete(input.chatId);
    useRunLifecycleStore.getState().streamFinished({
      chatId: input.chatId, producer: input.producer
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
  contextConfigurationKey,
  createStreamTokenBuffer,
  failurePrefix,
  fetchRun,
  notifyAnswerReady,
  onAnswerPublished,
  onRunAdmitted,
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
  let answerPublished = false;
  let admissionNotified = false;
  let failureMessage: string | null = null;
  let failureCode: string | null = null;
  let receivedChatUpdate = false;
  let rejectionMessage: string | null = null;
  let runId: string | null = null;
  let serverRejectedRequest = false;
  let userFacingFailureMessage: string | null = null;
  const abortController = new AbortController();
  const producer = nextStreamProducer();
  const ownsStream = () => activeStreamAbortRef.current.get(chatId) === abortController;
  const notifyAdmission = (acceptedRunId: string) => {
    if (admissionNotified) return;
    admissionNotified = true;
    onRunAdmitted?.(acceptedRunId);
  };

  useRunSurfaceStore.getState().resetSurface(chatId, contextConfigurationKey, optimisticAssistantMessageId);
  useRunLifecycleStore.getState().streamStarted({
    assistantMessageId: optimisticAssistantMessageId,
    chatId,
    producer
  });
  void primeAnswerSound();
  activeStreamAbortRef.current.set(chatId, abortController);
  const transport = observeRunTransport(abortController.signal);
  const acceptsTransport = () => ownsStream() && !transport.signal.aborted;

  const tokenBuffer = createStreamTokenBuffer({
    chatId,
    getAssistantMessageId: () => assistantMessageId
  });

  try {
    const response = await waitForRunTransport(request(transport.signal).then((value) => {
      if (transport.signal.aborted) {
        void value.body?.cancel().catch(() => undefined);
        transport.signal.throwIfAborted();
      }
      return value;
    }), transport.signal);
    if (!response.ok) {
      const details = await waitForRunTransport(responseErrorMessageDetails(
        response,
        `${failurePrefix}_${response.status}`
      ), transport.signal);
      // An unread refusal can describe a stale branch after an earlier accepted
      // send. Preserve reconciliation until its complete reason is available.
      serverRejectedRequest = true;
      failureCode = details.code ?? null;
      rejectionMessage = details.message;
      userFacingFailureMessage = details.preserveForComposer ? details.message : null;
      throw new Error(details.message);
    }

    if (response.status === 202) {
      const admitted = decodePreparingRunAdmission(await waitForRunTransport(response.json(), transport.signal));
      if (!admitted) throw new Error("run_admission_malformed");
      runId = admitted.run.id;
      useRunSurfaceStore.getState().bindContextMessage(chatId, assistantMessageId, admitted.assistantMessageId);
      assistantMessageId = admitted.assistantMessageId;
      reconcileMessageIds({ assistantMessageId, currentRunId: runId,
        messageIds: { assistantMessageId, userMessageId: admitted.userMessageId }, optimisticAssistantMessageId });
      useRunLifecycleStore.getState().runIdReceived({ chatId, producer, runId });
      notifyAdmission(runId);
      updateStreamChatMessages(chatId, (messages) => messages.map((message) => message.id === assistantMessageId
        ? { ...message, runId, ...(admitted.run.workspacePreparation ? { workspacePreparation: true } : {}),
            ...(admitted.run.pdfPreparation ? { pdfPreparation: admitted.run.pdfPreparation } : {}) }
        : message));
      deferred = true;
    } else {
    const streamResult = await waitForRunTransport(consumeRunStream({
      chatId,
      failurePrefix,
      isCurrent: acceptsTransport,
      onAnswerComplete(published) {
        if (!acceptsTransport()) return;
        if (published.runId !== runId || published.assistantMessageId !== assistantMessageId) return;
        answerPublished = true;
        updateStreamChatMessages(chatId, (messages) => messages.map((message) => message.id === assistantMessageId
          ? { ...message, status: "complete", workspaceSettling: true } : message));
        useRunLifecycleStore.getState().answerCompleted({ chatId, producer, runId: published.runId });
        onAnswerPublished?.(published.runId);
        void notifyAnswerReady();
      },
      onMessageIds(messageIds, currentRunId) {
        if (!acceptsTransport()) return;
        const reconciledAssistantMessageId =
          messageIds.assistantMessageId ?? assistantMessageId;
        useRunSurfaceStore.getState().bindContextMessage(chatId, assistantMessageId, reconciledAssistantMessageId);

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
        if (!acceptsTransport()) return;
        runId = nextRunId;
        useRunLifecycleStore.getState().runIdReceived({ chatId, producer, runId: nextRunId });
        notifyAdmission(nextRunId);
        updateStreamChatMessages(chatId, (current) =>
          current.map((message) =>
            message.id === assistantMessageId ? { ...message, runId: nextRunId } : message
          )
        );
      },
      response,
      signal: transport.signal,
      tokenBuffer
    }), transport.signal);

    receivedChatUpdate = streamResult.receivedChatUpdate;
    runId = streamResult.runId;
    cancelled = !answerPublished && (
      streamResult.terminalStatus === "cancelled" ||
      runWasCancelled(abortController, runId));
    failed = !answerPublished && streamResult.failed && !cancelled;
    if (runId && ownsStream()) {
      useRunLifecycleStore.getState().runIdReceived({ chatId, producer, runId });
    }

    if (runId) {
      // After answer_complete a successor may already own this chat's record
      // without a run id; the producer token keeps this late fetch from
      // binding its run to that successor.
      await fetchRun(runId, chatId, { producer });
    }

    if (!receivedChatUpdate && ownsStream()) {
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
    if (!failed && !cancelled && !answerPublished) {
      void notifyAnswerReady();
    }
    }
  } catch (error) {
    tokenBuffer.flush();
    cancelled = !answerPublished && runWasCancelled(abortController, runId);
    failed = !answerPublished && !cancelled;
    failureMessage = cancelled ? null : userFacingFailureMessage;
    if (!answerPublished && ownsStream()) {
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
    transport.dispose();
    if (transport.signal.aborted && ownsStream()) {
      useRunSurfaceStore.getState().endArtifactStream(chatId, cancelled ? "cancelled" : "interrupted");
    }
    finishStream({
      abortController,
      activeStreamAbortRef,
      assistantMessageId,
      cancelled,
      chatId,
      failed,
      deferred,
      producer
    });
    if ((deferred || answerPublished) && !failed && !cancelled &&
      !activeStreamAbortRef.current.has(chatId)) {
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
