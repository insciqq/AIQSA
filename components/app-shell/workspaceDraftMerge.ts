import type { WorkspaceChatSummary } from "@/components/app-shell/types";
import { sortChatsByFavoriteThenUpdatedAt } from "@/components/app-shell/workspaceStore";

/** The chat that replaces a removed active chat; `null` means the blank chat. */
export function nextChatAfterRemoval(
  chats: readonly WorkspaceChatSummary[],
  removedChatId: string
): WorkspaceChatSummary | null {
  return chats.find((chat) => chat.id !== removedChatId) ?? null;
}

/**
 * Reconciles server-owned chat summaries while retaining valid local
 * first-send reservations. A persisted row with the same id always promotes
 * the draft and clears its local reservation marker.
 */
export function mergeWorkspaceDrafts(input: Readonly<{
  currentChats: readonly WorkspaceChatSummary[];
  incomingChats: readonly WorkspaceChatSummary[];
}>): Readonly<{ chats: WorkspaceChatSummary[] }> {
  const incomingIds = new Set(input.incomingChats.map((chat) => chat.id));
  const currentById = new Map(input.currentChats.map((chat) => [chat.id, chat]));
  const pending = input.currentChats.filter((chat) => !incomingIds.has(chat.id) && Boolean(chat.pendingPersonalDraft));
  const chats = sortChatsByFavoriteThenUpdatedAt([
    ...pending,
    ...input.incomingChats.map((chat) => {
      const current = currentById.get(chat.id);
      const revisionOrder = current && !current.pendingPersonalDraft
        ? Date.parse(current.updatedAt) - Date.parse(chat.updatedAt) : -1;
      // A delayed read cannot undo an acknowledged mutation. Equal revisions
      // retain optimistic Search edits while their save is still pending.
      return {
        ...current,
        ...(revisionOrder > 0 && current ? current : chat),
        ...(revisionOrder === 0 && current?.defaultSearchPlan
          ? { defaultSearchPlan: current.defaultSearchPlan } : {}),
        pendingPersonalDraft: undefined
      };
    })
  ]);
  return { chats };
}
