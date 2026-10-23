"use client";

import { useCallback } from "react";
import {
  isSseParseError,
  messageIdsFromEvent,
  parseSseBlock,
  runIdFromEvent,
  tokenDeltaFromEvent
} from "@/components/app-shell/shellApi";
import { isRecord } from "@/components/app-shell/shellValues";
import type { RunEventView } from "@/components/app-shell/types";
import { observeRunTransport, waitForRunTransport } from "./runTransportLifecycle";

export type RunStreamTokenBuffer = {
  flush(): void;
  push(delta: string): void;
  reset?(): void;
};

export type RunStreamMessageIds = {
  assistantMessageId?: string;
  userMessageId?: string;
};

type UseRunStreamInput = {
  appendRunEventView(event: RunEventView, chatId: string): void;
  appendSseParseWarningOnce(event: RunEventView, chatId: string, warningLogged: boolean): boolean;
  applyChatUpdate(event: RunEventView, expectedChatId: string): boolean;
  /**
   * Takes a published answer's settled projection after a successor took the
   * chat's stream: only that answer's own messages, never the chat's leaf,
   * summary, stats or live surface, which the successor owns.
   */
  applySettledAnswerUpdate?(event: RunEventView, chatId: string, assistantMessageId: string): void;
  onStreamEnded?(chatId: string, status: RunStreamTerminalStatus | "interrupted"): void;
};

type ConsumeRunStreamInput = {
  chatId: string;
  failurePrefix: string;
  isCurrent?(): boolean;
  onAnswerComplete?(input: { assistantMessageId: string; runId: string }): void;
  onMessageIds(messageIds: RunStreamMessageIds, currentRunId: string | null): void;
  onRunId(runId: string): void;
  response: Response;
  signal?: AbortSignal;
  tokenBuffer: RunStreamTokenBuffer;
};

export type RunStreamTerminalStatus = "cancelled" | "complete" | "error";

type ConsumeRunStreamResult = {
  failed: boolean;
  receivedChatUpdate: boolean;
  runId: string | null;
  terminalStatus: RunStreamTerminalStatus;
};

export function useRunStream({
  appendRunEventView,
  appendSseParseWarningOnce,
  applyChatUpdate,
  applySettledAnswerUpdate,
  onStreamEnded
}: UseRunStreamInput) {
  return useCallback(
    async function consumeRunStream({
      chatId,
      failurePrefix,
      isCurrent = () => true,
      onAnswerComplete,
      onMessageIds,
      onRunId,
      response,
      signal,
      tokenBuffer
    }: ConsumeRunStreamInput): Promise<ConsumeRunStreamResult> {
      if (!response.body) {
        throw new Error(`${failurePrefix}_${response.status}`);
      }

      let failed = false;
      let parseWarningLogged = false;
      let receivedChatUpdate = false;
      let runId: string | null = null;
      let assistantMessageId: string | null = null;
      let answerPublished = false;
      let terminalStatus: RunStreamTerminalStatus | null = null;

      const handleEvent = (event: RunEventView) => {
        if (isSseParseError(event)) {
          if (isCurrent() && !answerPublished) parseWarningLogged = appendSseParseWarningOnce(event, chatId, parseWarningLogged);
          return;
        }

        const delta = tokenDeltaFromEvent(event);
        if (delta) {
          if (!answerPublished && isCurrent()) tokenBuffer.push(delta);
          return;
        }

        tokenBuffer.flush();
        if (event.type === "answer_complete") {
          if (!isRecord(event.data) || !runId || event.data.runId !== runId ||
            !assistantMessageId || event.data.assistantMessageId !== assistantMessageId) {
            throw new Error("run_answer_completion_malformed");
          }
          if (!answerPublished) {
            answerPublished = true;
            onAnswerComplete?.({ assistantMessageId, runId });
          }
        }
        if (event.type === "message_reset") {
          if (!answerPublished && isCurrent()) tokenBuffer.reset?.();
        }
        if (isCurrent() && (!answerPublished || event.type !== "error")) {
          appendRunEventView(event, chatId);
          const applied = applyChatUpdate(event, chatId);
          // Admission and clarification delivery also publish chat updates.
          // Only a settled answer replaces the terminal detail fallback.
          if (applied && isRecord(event.data) && Array.isArray(event.data.messages)) {
            receivedChatUpdate = event.data.messages.some(message => isRecord(message) &&
              message.id === assistantMessageId && ["complete", "cancelled", "error"].includes(String(message.status))) || receivedChatUpdate;
          }
        } else if (answerPublished && assistantMessageId && event.type === "chat_update") {
          // Send is released once the answer is published, so the next run can
          // take this chat's stream and reset its live surface while this run
          // still settles (Workspace hand-off). The steps and outputs this
          // answer showed lived on that surface; its settled projection is the
          // only place they come back from.
          applySettledAnswerUpdate?.(event, chatId, assistantMessageId);
        }

        const maybeRunId = runIdFromEvent(event);
        if (maybeRunId) {
          if (runId && runId !== maybeRunId) throw new Error("run_stream_identity_mismatch");
          runId = maybeRunId;
          if (isCurrent()) onRunId(maybeRunId);
        }

        const messageIds = messageIdsFromEvent(event);
        if (messageIds?.assistantMessageId || messageIds?.userMessageId) {
          assistantMessageId = messageIds.assistantMessageId ?? assistantMessageId;
          if (isCurrent()) onMessageIds(messageIds, runId);
        }

        if (event.type === "error") {
          failed = true;
          terminalStatus = "error";
        } else if (event.type === "done" && isRecord(event.data)) {
          const status = event.data.status;
          if (status === "cancelled" || status === "complete" || status === "error") {
            terminalStatus = status;
            failed = status === "error";
          }
        }
      };

      const reader = response.body.getReader();
      const ownedTransport = signal ? null : observeRunTransport();
      const transportSignal = signal ?? ownedTransport!.signal;
      const detach = () => { void reader.cancel().catch(() => undefined); };
      transportSignal.addEventListener("abort", detach, { once: true });
      if (transportSignal.aborted) detach();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      try {
        while (!done) {
          const result = await waitForRunTransport(reader.read(), transportSignal);
          done = result.done;
          buffer += decoder.decode(result.value ?? new Uint8Array(), { stream: !done });
          const chunks = buffer.split("\n\n");
          buffer = chunks.pop() ?? "";

          for (const chunk of chunks) {
            const event = parseSseBlock(chunk);
            if (event) {
              handleEvent(event);
            }
          }
        }

        const trailing = parseSseBlock(buffer.trim());
        if (trailing) {
          handleEvent(trailing);
        }
        tokenBuffer.flush();

        if (!terminalStatus) {
          throw new Error("stream_connection_lost");
        }

        return { failed, receivedChatUpdate, runId, terminalStatus };
      } finally {
        transportSignal.removeEventListener("abort", detach);
        ownedTransport?.dispose();
        reader.releaseLock();
        if (isCurrent()) onStreamEnded?.(chatId, terminalStatus ?? "interrupted");
      }
    },
    [appendRunEventView, appendSseParseWarningOnce, applyChatUpdate, applySettledAnswerUpdate, onStreamEnded]
  );
}
