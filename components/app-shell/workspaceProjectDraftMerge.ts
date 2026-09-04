import type { WorkspaceChatSummary } from "@/components/app-shell/types";
import type { ProjectChatSummaryWire } from "@/lib/contracts/projects";
import { sortChatsByFavoriteThenUpdatedAt } from "@/components/app-shell/workspaceStore";

function validPendingProjectDraft(
  chat: WorkspaceChatSummary,
  projectId?: string
): boolean {
  const draft = chat.pendingProjectDraft;
  return Boolean(
    draft && chat.projectId === draft.projectId &&
    (projectId === undefined || draft.projectId === projectId)
  );
}

function validPendingPersonalDraft(chat: WorkspaceChatSummary): boolean {
  return Boolean(chat.pendingPersonalDraft && !chat.projectId);
}

function sortProjectChats(chats: readonly ProjectChatSummaryWire[]): ProjectChatSummaryWire[] {
  return [...chats].sort((left, right) =>
    Number(left.archived) - Number(right.archived) ||
    right.updatedAt.localeCompare(left.updatedAt) ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Reconciles server-owned chat summaries while retaining valid local
 * first-send reservations. A persisted row with the same id always promotes
 * the draft and clears its local reservation marker.
 */
export function mergeWorkspaceProjectDrafts(input: Readonly<{
  currentChats: readonly WorkspaceChatSummary[];
  currentProjectChats?: readonly ProjectChatSummaryWire[];
  incomingChats: readonly WorkspaceChatSummary[];
  incomingProjectChats?: readonly ProjectChatSummaryWire[];
  projectId?: string;
}>): Readonly<{
  chats: WorkspaceChatSummary[];
  projectChats?: ProjectChatSummaryWire[];
}> {
  const incoming = input.projectId === undefined
    ? [...input.incomingChats]
    : input.incomingChats.filter((chat) => chat.projectId === input.projectId);
  const incomingIds = new Set(incoming.map((chat) => chat.id));
  const currentById = new Map(input.currentChats.map((chat) => [chat.id, chat]));
  const pending = input.currentChats.filter((chat) => {
    if (incomingIds.has(chat.id)) return false;
    return input.projectId === undefined
      ? validPendingProjectDraft(chat) || validPendingPersonalDraft(chat)
      : validPendingProjectDraft(chat, input.projectId);
  });
  const outsideScope = input.projectId === undefined
    ? []
    : input.currentChats.filter((chat) => chat.projectId !== input.projectId);
  const chats = sortChatsByFavoriteThenUpdatedAt([
    ...outsideScope,
    ...pending,
    ...incoming.map((chat) => ({
      ...currentById.get(chat.id),
      ...chat,
      pendingPersonalDraft: undefined,
      pendingProjectDraft: undefined
    }))
  ]);

  if (!input.incomingProjectChats) return { chats };
  const projectWireIds = new Set(input.incomingProjectChats.map((chat) => chat.id));
  const pendingIds = new Set(pending.map((chat) => chat.id));
  const retainedProjectDrafts = (input.currentProjectChats ?? []).filter((chat) =>
    chat.projectId === input.projectId && pendingIds.has(chat.id) && !projectWireIds.has(chat.id)
  );
  return {
    chats,
    projectChats: sortProjectChats([
      ...input.incomingProjectChats,
      ...retainedProjectDrafts
    ])
  };
}
