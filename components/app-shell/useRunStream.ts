"use client";

import { useCallback } from "react";
import {
  isSseParseError,
  messageIdsFromEvent,
  parseSseBlock,
  runIdFromEvent,
  tokenDeltaFromEvent
} from "@/components/app-shell/shellApi";
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
};

type ConsumeRunStreamInput = {
  chatId: string;
  failurePrefix: string;
  onMessageIds(messageIds: RunStreamMessageIds, currentRunId: string | null): void;
  onRunId(runId: string): void;
  response: Response;
  tokenBuffer: RunStreamTokenBuffer;
};

type ConsumeRunStreamResult = {
  failed: boolean;
  receivedChatUpdate: boolean;
  runId: string | null;
};

export function useRunStream({
  appendRunEventView,
  appendSseParseWarningOnce,
  applyChatUpdate
}: UseRunStreamInput) {
  return useCallback(
    async function consumeRunStream({
      chatId,
      failurePrefix,
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

      const handleEvent = (event: RunEventView) => {
        if (isSseParseError(event)) {
          parseWarningLogged = appendSseParseWarningOnce(event, chatId, parseWarningLogged);
          return;
        }

        const delta = tokenDeltaFromEvent(event);
        if (delta) {
          tokenBuffer.push(delta);
          return;
        }

        tokenBuffer.flush();
        if (event.type === "message_reset") {
          tokenBuffer.reset?.();
        }
        appendRunEventView(event, chatId);
        receivedChatUpdate = applyChatUpdate(event, chatId) || receivedChatUpdate;

        const maybeRunId = runIdFromEvent(event);
        if (maybeRunId) {
          runId = maybeRunId;
          onRunId(maybeRunId);
        }

        const messageIds = messageIdsFromEvent(event);
        if (messageIds?.assistantMessageId || messageIds?.userMessageId) {
          onMessageIds(messageIds, runId);
        }

        if (event.type === "error") {
          failed = true;
        }
      };

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let done = false;

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

      return { failed, receivedChatUpdate, runId };
    },
    [appendRunEventView, appendSseParseWarningOnce, applyChatUpdate]
  );
}
