import type { ThreadMessage } from "@/components/app-shell/types";

export function effectiveActiveLeafId(messages: ThreadMessage[], activeLeafId: string | null): string | null {
  if (activeLeafId && messages.some((message) => message.id === activeLeafId)) {
    return activeLeafId;
  }

  return messages.at(-1)?.id ?? null;
}

export function visibleMessagePath(messages: ThreadMessage[], activeLeafId: string | null): ThreadMessage[] {
  const leafId = effectiveActiveLeafId(messages, activeLeafId);
  if (!leafId) {
    return [];
  }

  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const reversePath: ThreadMessage[] = [];
  const visited = new Set<string>();
  let current = messagesById.get(leafId);
  while (current) {
    if (visited.has(current.id)) return [];
    visited.add(current.id);
    reversePath.push(current);
    current = current.parentMessageId
      ? messagesById.get(current.parentMessageId)
      : undefined;
  }
  return reversePath.reverse();
}

export function latestResumableRunId(thread: {
  activeLeafId: string | null;
  messages: ThreadMessage[];
}): string | null {
  const visible = visibleMessagePath(thread.messages, thread.activeLeafId);
  const message = visible
    .filter(
      (candidate) =>
        candidate.role === "assistant" &&
        candidate.status === "streaming" &&
        candidate.runId
    )
    .at(-1);

  return message?.runId ?? null;
}
