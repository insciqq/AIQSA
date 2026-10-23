import {
  isSseParseError,
  sseParseWarningEvent
} from "@/components/app-shell/shellApi";
import { chatUpdateFromEvent } from "@/components/app-shell/powerAppShellData";
import { appendAssistantDelta, mergeThreadMessages, resetAssistantDraft } from "@/components/app-shell/runState";
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

  /**
   * A published answer's settled projection that arrived after the next run
   * took the chat's stream. It replaces only messages the thread still holds
   * and only once the server reports the answer settled; the chat's leaf,
   * summary and stats stay with the run that now owns the chat.
   */
  function applySettledAnswerUpdate(event: RunEventView, chatId: string, assistantMessageId: string) {
    const update = chatUpdateFromEvent(event);
    if (!update || update.chat.id !== chatId) return;
    const answer = update.messages.find((message) => message.id === assistantMessageId);
    if (!answer || answer.status === "streaming") return;
    const held = new Set(useThreadStore.getState().threadsByChatId[chatId]?.messages.map((message) => message.id) ?? []);
    const settled = update.messages.filter((message) => held.has(message.id));
    if (!held.has(assistantMessageId)) return;
    useThreadStore.getState().updateMessages(chatId, (current) => mergeThreadMessages(current, settled));
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
      },
      reset() {
        if (timer !== null) {
          window.clearTimeout(timer);
          timer = null;
        }
        bufferedDelta = "";
        bufferedChunkCount = 0;
        const assistantMessageId = getAssistantMessageId();
        useThreadStore.getState().updateMessages(chatId, (current) =>
          resetAssistantDraft(current, assistantMessageId)
        );
      }
    };
  }

  const consumeRunStream = useRunStream({
    appendRunEventView,
    appendSseParseWarningOnce,
    applyChatUpdate,
    applySettledAnswerUpdate,
    onStreamEnded: (chatId, status) => useRunSurfaceStore.getState().endArtifactStream(chatId, status)
  });

  return {
    consumeRunStream,
    createStreamTokenBuffer
  };
}
