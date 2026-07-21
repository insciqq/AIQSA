import {
  isSseParseError,
  sseParseWarningEvent
} from "@/components/app-shell/shellApi";
import { appendAssistantDelta } from "@/components/app-shell/runState";
import { useRunSurfaceStore } from "@/components/app-shell/runSurfaceStore";
import type { RunEventView } from "@/components/app-shell/types";
import { useRunStream } from "@/components/app-shell/useRunStream";
import { useThreadStore } from "@/components/app-shell/threadStore";

type RunStreamingInput = {
  applyChatUpdate(event: RunEventView, expectedChatId: string | null): boolean;
};

export function useRunStreaming({ applyChatUpdate }: RunStreamingInput) {
  function appendRunEventView(event: RunEventView, chatId: string) {
    if (event.type !== "chat_update") {
      useRunSurfaceStore.getState().appendEvent(chatId, event);
    }
  }

  function appendSseParseWarningOnce(event: RunEventView, chatId: string, warningLogged: boolean): boolean {
    if (!isSseParseError(event)) {
      return warningLogged;
    }

    if (!warningLogged) {
      appendRunEventView(sseParseWarningEvent(event), chatId);
    }

    return true;
  }

  function createStreamTokenBuffer({
    chatId,
    getAssistantMessageId
  }: {
    chatId: string;
    getAssistantMessageId(): string;
  }) {
    let bufferedDelta = "";
    let bufferedChunkCount = 0;
    let timer: number | null = null;

    const flush = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }

      if (!bufferedDelta) {
        return;
      }

      const delta = bufferedDelta;
      const chunkCount = bufferedChunkCount;
      bufferedDelta = "";
      bufferedChunkCount = 0;
      const assistantMessageId = getAssistantMessageId();
      appendRunEventView(
        {
          data: {
            chunkCount,
            delta
          },
          type: "token"
        },
        chatId
      );

      useThreadStore.getState().updateMessages(chatId, (current) =>
        appendAssistantDelta(current, assistantMessageId, delta)
      );
    };

    return {
      flush,
      push(delta: string) {
        bufferedDelta += delta;
        bufferedChunkCount += 1;
        if (timer === null) {
          timer = window.setTimeout(flush, 50);
        }
      }
    };
  }

  const consumeRunStream = useRunStream({
    appendRunEventView,
    appendSseParseWarningOnce,
    applyChatUpdate
  });

  return {
    consumeRunStream,
    createStreamTokenBuffer
  };
}
