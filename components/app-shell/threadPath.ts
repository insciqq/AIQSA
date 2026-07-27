import type { ThreadMessage } from "@/components/app-shell/types";
import { textFromThreadContent } from "@/components/app-shell/threadContent";
import { getVisibleMessagePath } from "@/lib/domain/branching";

export type BranchTreeNode = {
  active: boolean;
  activePath: boolean;
  checkoutLeafId: string;
  childCount: number;
  depth: number;
  forkChoice: boolean;
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
  if (messages.filter((message) => !message.parentMessageId).length > 1) {
    return true;
  }

  const childCountById = childCounts(messages);
  return Array.from(childCountById.values()).some((count) => count > 1);
}

export function branchTreeNodes(messages: ThreadMessage[], activeLeafId: string | null): BranchTreeNode[] {
  const childCountById = childCounts(messages);
  const rootCount = messages.filter((message) => !message.parentMessageId).length;
  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const childrenByParentId = new Map<string, ThreadMessage[]>();
  for (const message of messages) {
    if (message.parentMessageId) {
      const siblings = childrenByParentId.get(message.parentMessageId) ?? [];
      siblings.push(message);
      childrenByParentId.set(message.parentMessageId, siblings);
    }
  }
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

  function deepestBranchLeafId(message: ThreadMessage): string {
    let current = message;
    const visited = new Set<string>();
    while (!visited.has(current.id)) {
      visited.add(current.id);
      const nextChild = childrenByParentId.get(current.id)?.at(-1);
      if (!nextChild) {
        break;
      }
      current = nextChild;
    }
    return current.id;
  }

  return messages.map((message) => ({
    active: message.id === leafId,
    activePath: activePathIds.has(message.id),
    checkoutLeafId: deepestBranchLeafId(message),
    childCount: childCountById.get(message.id) ?? 0,
    depth: depthFor(message),
    forkChoice: message.parentMessageId
      ? (childCountById.get(message.parentMessageId) ?? 0) > 1
      : rootCount > 1,
    message,
    preview: plainTextPreview(textFromThreadContent(message.content)) || message.status,
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

function plainTextPreview(value: string): string {
  const firstContentLine = value
    .trim()
    .split(/\r?\n/)
    .find((line) => line.trim())?.trim() ?? "";

  return firstContentLine
    .replace(/^\s{0,3}>\s*/, "")
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}(?:[-+*]|\d+[.)])\s+/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/(^|[\s([{])\*([^*\n]+)\*(?=$|[\s.,!?:;)\]}])/g, "$1$2")
    .replace(/(^|[\s([{])_([^_\n]+)_(?=$|[\s.,!?:;)\]}])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}
