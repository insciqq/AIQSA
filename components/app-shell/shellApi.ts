import { isRecord } from "@/components/app-shell/shellValues";
import { textFromPersistedContent } from "@/components/app-shell/threadContent";
import type {
  ChatDetail,
  ChatSummary,
  RunEventView,
  ThreadMessage
} from "@/components/app-shell/types";
import type {
  ChatDetailWire,
  ChatMessageWire,
  WorkspaceChatSummaryWire
} from "@/lib/contracts/chats";

export function parseSseBlock(block: string): RunEventView | null {
  const lines = block.split("\n");
  const fieldValue = (line: string, field: string): string | null => {
    if (!line.startsWith(`${field}:`)) {
      return null;
    }

    const value = line.slice(field.length + 1);
    return value.startsWith(" ") ? value.slice(1) : value;
  };
  const type = lines
    .map((line) => fieldValue(line, "event"))
    .find((value): value is string => value !== null);
  const dataLines = lines
    .map((line) => fieldValue(line, "data"))
    .filter((value): value is string => value !== null);

  if (!type) {
    return null;
  }

  if (dataLines.length === 0) {
    return {
      data: null,
      type
    };
  }

  const data = dataLines.join("\n");
  try {
    return {
      data: JSON.parse(data) as unknown,
      type
    };
  } catch {
    return {
      data: {
        eventType: type,
        message: "Skipped malformed stream frame",
        raw: data.slice(0, 240)
      },
      type: "parse_error"
    };
  }
}

export function isSseParseError(event: RunEventView): boolean {
  return event.type === "parse_error";
}

export function sseParseWarningEvent(event: RunEventView): RunEventView {
  return {
    data: {
      eventType:
        isRecord(event.data) && typeof event.data.eventType === "string"
          ? event.data.eventType
          : undefined,
      message: "Skipped malformed stream frame"
    },
    type: "warning"
  };
}

export function runIdFromEvent(event: RunEventView): string | null {
  return isRecord(event.data) && typeof event.data.runId === "string"
    ? event.data.runId
    : null;
}

export function messageIdsFromEvent(
  event: RunEventView
): { assistantMessageId?: string; userMessageId?: string } | null {
  if (event.type !== "message_start" || !isRecord(event.data)) {
    return null;
  }

  return {
    assistantMessageId:
      typeof event.data.assistantMessageId === "string"
        ? event.data.assistantMessageId
        : undefined,
    userMessageId:
      typeof event.data.userMessageId === "string"
        ? event.data.userMessageId
        : undefined
  };
}

export function tokenDeltaFromEvent(event: RunEventView): string | null {
  return event.type === "token" &&
    isRecord(event.data) &&
    typeof event.data.delta === "string"
    ? event.data.delta
    : null;
}

export function normalizeThreadStatus(status: string): ThreadMessage["status"] {
  return status === "queued" || status === "streaming"
    ? "streaming"
    : status === "error" || status === "cancelled"
    ? status
    : "complete";
}

export function messageFromApi(message: ChatMessageWire): ThreadMessage {
  const persistedText = textFromPersistedContent(message.content);
  const artifactSummary = message.artifactSummary
    ? {
        ...message.artifactSummary,
        citations: message.artifactSummary.citations ?? [],
        searchDetails: message.artifactSummary.searchDetails ?? []
      }
    : null;

  return {
    artifactSummary,
    content:
      message.status === "error"
        ? persistedText || message.errorMessage || ""
        : message.status === "cancelled"
          ? persistedText || "Stopped."
          : message.content,
    id: message.id,
    modelId: message.modelId ?? undefined,
    parentMessageId: message.parentMessageId,
    provider: message.provider ?? undefined,
    role: message.role === "assistant" ? "assistant" : "user",
    runId: message.modelRunId ?? null,
    status: normalizeThreadStatus(message.status)
  };
}

export function chatSummaryFromApi(chat: WorkspaceChatSummaryWire): ChatSummary {
  return {
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: chat.createdAt,
    defaultModelId: chat.defaultModelId ?? "",
    defaultPromptPresetId: chat.defaultPromptPresetId,
    defaultProvider: chat.defaultProvider ?? "",
    folderId: chat.folderId,
    id: chat.id,
    messageCount: chat.messageCount,
    pinned: chat.pinned,
    title: chat.title,
    updatedAt: chat.updatedAt
  };
}

export function chatDetailFromApi(chat: ChatDetailWire): ChatDetail {
  return {
    ...chatSummaryFromApi(chat),
    messages: chat.messages.map(messageFromApi),
    usageStats: chat.usageStats
  };
}
