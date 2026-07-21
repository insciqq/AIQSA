import type { ThreadMessage } from "@/components/app-shell/types";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import { getVisibleMessagePath } from "@/lib/domain/branching";

export type BranchTreeNode = {
  active: boolean;
  activePath: boolean;
  childCount: number;
  depth: number;
  message: ThreadMessage;
  preview: string;
  roleGlyph: "A" | "Q";
};

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

  try {
    return getVisibleMessagePath(messages, leafId);
  } catch {
    return [];
  }
}

export function latestResumableRunId(thread: {
  activeLeafId: string | null;
  messages: ThreadMessage[];
}): string | null {
  const visible = getVisibleMessagePath(thread.messages, thread.activeLeafId);
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

export function branchTreeHasForks(messages: ThreadMessage[]): boolean {
  const childCountById = childCounts(messages);
  return Array.from(childCountById.values()).some((count) => count > 1);
}

export function branchTreeNodes(messages: ThreadMessage[], activeLeafId: string | null): BranchTreeNode[] {
  const childCountById = childCounts(messages);
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const activePathIds = new Set(visibleMessagePath(messages, activeLeafId).map((message) => message.id));
  const leafId = effectiveActiveLeafId(messages, activeLeafId);
  const depthById = new Map<string, number>();

  function depthFor(message: ThreadMessage): number {
    const cached = depthById.get(message.id);
    if (cached !== undefined) {
      return cached;
    }

    const parent = message.parentMessageId ? messagesById.get(message.parentMessageId) : null;
    const depth = parent ? depthFor(parent) + ((childCountById.get(parent.id) ?? 0) > 1 ? 1 : 0) : 0;
    depthById.set(message.id, depth);
    return depth;
  }

  return messages.map((message) => ({
    active: message.id === leafId,
    activePath: activePathIds.has(message.id),
    childCount: childCountById.get(message.id) ?? 0,
    depth: depthFor(message),
    message,
    preview: firstLine(textFromThreadContent(message.content)) || message.status,
    roleGlyph: message.role === "user" ? "Q" : "A"
  }));
}

function childCounts(messages: ThreadMessage[]): Map<string, number> {
  const childCountById = new Map<string, number>();
  for (const message of messages) {
    if (message.parentMessageId) {
      childCountById.set(message.parentMessageId, (childCountById.get(message.parentMessageId) ?? 0) + 1);
    }
  }

  return childCountById;
}

function firstLine(value: string): string {
  return value
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim())?.trim()
    .slice(0, 120) ?? "";
}
