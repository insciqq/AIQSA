import type {
  ChatGroup,
  WorkspaceChatSummary,
  FolderSummary
} from "@/components/app-shell/types";

function chatSearchText(chat: WorkspaceChatSummary): string {
  return [chat.title, chat.defaultProvider, chat.defaultModelId].join(" ").toLowerCase();
}

function chatMatchesQuery(
  chat: WorkspaceChatSummary,
  query: string,
  contentMatchIds?: ReadonlySet<string>
): boolean {
  return !query || chatSearchText(chat).includes(query) || Boolean(contentMatchIds?.has(chat.id));
}

export function buildChatGroups(
  folders: FolderSummary[],
  chats: WorkspaceChatSummary[],
  rawQuery: string,
  contentMatchIds?: ReadonlySet<string>
): ChatGroup[] {
  const query = rawQuery.trim().toLowerCase();
  const childrenByParent = new Map<string | null, FolderSummary[]>();
  for (const folder of folders) {
    const parentId =
      folder.parentId && folders.some((candidate) => candidate.id === folder.parentId)
        ? folder.parentId
        : null;
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), folder]);
  }

  for (const children of childrenByParent.values()) {
    children.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  }

  const groups: ChatGroup[] = [];
  const visited = new Set<string>();
  function visit(parentId: string | null, depth: number): ChatGroup[] {
    const branch: ChatGroup[] = [];

    for (const folder of childrenByParent.get(parentId) ?? []) {
      if (visited.has(folder.id)) {
        continue;
      }

      visited.add(folder.id);
      const folderMatches = !query || folder.name.toLowerCase().includes(query);
      const folderChats = chats.filter((chat) => chat.folderId === folder.id);
      const matchingChats = folderMatches
        ? folderChats
        : folderChats.filter((chat) => chatMatchesQuery(chat, query, contentMatchIds));
      const childGroups = visit(folder.id, depth + 1);

      if (!query || folderMatches || matchingChats.length > 0 || childGroups.length > 0) {
        branch.push({
          chats: matchingChats,
          depth,
          folder,
          name: folder.name
        });
        branch.push(...childGroups);
      }
    }

    return branch;
  }

  groups.push(...visit(null, 0));
  const unfiledChats = chats.filter((chat) => !chat.folderId);
  const matchingUnfiledChats = unfiledChats.filter((chat) =>
    chatMatchesQuery(chat, query, contentMatchIds)
  );
  if (matchingUnfiledChats.length > 0 || (!query && unfiledChats.length > 0)) {
    groups.push({
      chats: query ? matchingUnfiledChats : unfiledChats,
      depth: 0,
      folder: null,
      name: "No folder"
    });
  }

  return groups;
}
