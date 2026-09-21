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
          receivedChatUpdate = applyChatUpdate(event, chatId) || receivedChatUpdate;
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
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

      try {
        while (!done) {
          const result = await reader.read();
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
        reader.releaseLock();
        if (isCurrent()) onStreamEnded?.(chatId, terminalStatus ?? "interrupted");
      }
    },
    [appendRunEventView, appendSseParseWarningOnce, applyChatUpdate, onStreamEnded]
  );
}
