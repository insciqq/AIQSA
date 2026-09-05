import { textFromThreadContent } from "@/components/app-shell/threadContent";
import { isRecord } from "@/components/app-shell/shellValues";
import type { RunEventView, ThreadMessage } from "@/components/app-shell/types";
import { mergeWorkspaceActivity } from "@/lib/domain/workspaceActivity";

export function mergeThreadMessages(current: ThreadMessage[], updates: ThreadMessage[]): ThreadMessage[] {
  if (updates.length === 0) {
    return current;
  }

  const updatesById = new Map(updates.map((message) => [message.id, message]));
  const merged = current.map((message) => {
    const update = updatesById.get(message.id);
    if (!update) return message;
    if (!message.runId || message.runId !== update.runId ||
      !message.workspaceActivity && !update.workspaceActivity) return update;
    return {
      ...update,
      workspaceActivity: mergeWorkspaceActivity(message.workspaceActivity, update.workspaceActivity)
    };
  });
  const currentIds = new Set(current.map((message) => message.id));
  for (const update of updates) {
    if (!currentIds.has(update.id)) {
      merged.push(update);
    }
  }

  return merged;
}

export function appendAssistantDelta(
  messages: ThreadMessage[],
  assistantMessageId: string,
  delta: string
): ThreadMessage[] {
  return messages.map((message) =>
    message.id === assistantMessageId ? { ...message, content: `${textFromThreadContent(message.content)}${delta}` } : message
  );
}

export function resetAssistantDraft(
  messages: ThreadMessage[],
  assistantMessageId: string
): ThreadMessage[] {
  return messages.map((message) =>
    message.id === assistantMessageId ? { ...message, content: "" } : message
  );
}

function numericEventField(data: unknown, key: string): number {
  if (!isRecord(data)) {
    return 0;
  }

  const value = data[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function compactTokenEvent(event: RunEventView): RunEventView {
  const delta = isRecord(event.data) && typeof event.data.delta === "string" ? event.data.delta : "";
  return {
    data: {
      characterCount: numericEventField(event.data, "characterCount") || delta.length,
      chunkCount: numericEventField(event.data, "chunkCount") || 1
    },
    type: "token"
  };
}

/** Keeps the client-side event timeline bounded during long adjacent token streams. */
export function appendCompactRunEvent(current: RunEventView[], event: RunEventView): RunEventView[] {
  if (event.type !== "token") {
    return [...current, event];
  }

  const nextToken = compactTokenEvent(event);
  const previous = current.at(-1);
  if (previous?.type !== "token") {
    return [...current, nextToken];
  }

  return [
    ...current.slice(0, -1),
    {
      data: {
        characterCount:
          numericEventField(previous.data, "characterCount") +
          numericEventField(nextToken.data, "characterCount"),
        chunkCount:
          numericEventField(previous.data, "chunkCount") +
          numericEventField(nextToken.data, "chunkCount")
      },
      type: "token"
    }
  ];
}
