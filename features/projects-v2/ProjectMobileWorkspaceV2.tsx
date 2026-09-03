"use client";

import { UiV2Icon } from "@/components/ui-v2";
import { chatTitleForDisplay } from "@/components/app-shell/shellFormatting";
import { useMemo, useState } from "react";
import type { ProjectChatSummaryWire, ProjectFolderWire } from "@/lib/contracts/projects";
import { formatProjectDate } from "./projectPresentation";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

function matchesProjectChat(chat: ProjectChatSummaryWire, query: string): boolean {
  const haystack = `${chatTitleForDisplay(chat.title)} ${chat.createdByDisplayName}`;
  return haystack.toLocaleLowerCase().includes(query);
}

function MobileProjectChatRow({
  active,
  chat,
  onNavigate,
  onSelect
}: Readonly<{
  active: boolean;
  chat: ProjectChatSummaryWire;
  onNavigate(): void;
  onSelect(): Promise<boolean>;
}>) {
  const title = chatTitleForDisplay(chat.title);
  return (
    <li>
      <button
        aria-current={active ? "page" : undefined}
        className="v2-project-mobile-chat v2-focusable"
        data-selected={active || undefined}
        type="button"
        onClick={() => {
          void onSelect().then((selected) => {
            if (selected) onNavigate();
          });
        }}
      >
        <span className="v2-project-mobile-row-icon" aria-hidden="true">
          <UiV2Icon name="chat" />
        </span>
        <span>
          <strong>{title}</strong>
          <small>
            {chat.createdByDisplayName || "Project member"} · updated {formatProjectDate(chat.updatedAt)}
          </small>
        </span>
      </button>
    </li>
  );
}

function visibleFolderChats(
  chats: readonly ProjectChatSummaryWire[],
  folder: ProjectFolderWire,
  query: string
): readonly ProjectChatSummaryWire[] {
  return chats.filter((chat) => chat.folderId === folder.id && (!query || matchesProjectChat(chat, query)));
}

function folderChatsForQuery(
  chats: readonly ProjectChatSummaryWire[],
  folder: ProjectFolderWire,
  query: string
): readonly ProjectChatSummaryWire[] {
  const folderMatches = Boolean(query) && folder.name.toLocaleLowerCase().includes(query);
  return visibleFolderChats(chats, folder, folderMatches ? "" : query);
}

export function ProjectMobileWorkspaceV2({
  activeChatId,
  controller,
  onNavigate
}: Readonly<{
  activeChatId: string | null;
  controller: ProjectWorkspaceController;
  onNavigate(): void;
}>) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [openFolderIds, setOpenFolderIds] = useState<ReadonlySet<string>>(new Set());
  const workspace = controller.workspace;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const chats = useMemo(
    () => (workspace?.chats ?? []).filter((chat) => !chat.archived),
    [workspace?.chats]
  );
  const folders = workspace?.folders ?? [];
  const folderIds = new Set(folders.map((folder) => folder.id));
  const visibleFolders = folders.filter((folder) => {
    if (!normalizedQuery) return true;
    return folder.name.toLocaleLowerCase().includes(normalizedQuery) ||
      folderChatsForQuery(chats, folder, normalizedQuery).length > 0;
  });
  const unfiledChats = chats.filter((chat) =>
    (!chat.folderId || !folderIds.has(chat.folderId)) &&
    (!normalizedQuery || matchesProjectChat(chat, normalizedQuery))
  );
  const visibleChatCount = visibleFolders.reduce(
    (count, folder) => count + folderChatsForQuery(chats, folder, normalizedQuery).length,
    unfiledChats.length
  );

  return (
    <section className="v2-project-mobile-workspace" aria-labelledby="v2-project-mobile-chats-heading">
      <header>
        <h2 id="v2-project-mobile-chats-heading">Chats</h2>
        <button
          aria-controls="v2-project-mobile-filter"
          aria-expanded={filterOpen}
          className="v2-project-mobile-filter-toggle v2-focusable"
          type="button"
          onClick={() => {
            setFilterOpen((open) => {
              if (open) setQuery("");
              return !open;
            });
          }}
        >
          <UiV2Icon name="search" /> Filter
        </button>
      </header>
      {filterOpen ? (
        <label className="v2-project-mobile-filter" id="v2-project-mobile-filter">
          <UiV2Icon name="search" />
          <input
            autoFocus
            aria-label="Filter project chats"
            maxLength={120}
            placeholder="Filter chats…"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.preventDefault();
              if (query) setQuery("");
              else setFilterOpen(false);
            }}
          />
        </label>
      ) : null}
      {!workspace && controller.syncState !== "error" ? (
        <p className="v2-project-mobile-state">Opening shared chats…</p>
      ) : !workspace ? (
        <div className="v2-project-mobile-state" role="alert">
          <span>Shared chats are unavailable.</span>
          <button type="button" onClick={() => void controller.actions.refresh()}>Try again</button>
        </div>
      ) : visibleFolders.length === 0 && unfiledChats.length === 0 ? (
        <p className="v2-project-mobile-state">
          {normalizedQuery ? "No Project chats or folders match this filter." : "No shared chats yet."}
        </p>
      ) : (
        <ul className="v2-project-mobile-list" aria-label="Project chats and folders">
          {visibleFolders.map((folder) => {
            const folderChats = folderChatsForQuery(chats, folder, normalizedQuery);
            const expanded = Boolean(normalizedQuery) || openFolderIds.has(folder.id);
            return (
              <li key={folder.id}>
                <button
                  aria-expanded={expanded}
                  aria-label={`${folder.name}, ${folderChats.length} ${folderChats.length === 1 ? "chat" : "chats"}`}
                  className="v2-project-mobile-folder v2-focusable"
                  type="button"
                  onClick={() => setOpenFolderIds((current) => {
                    const next = new Set(current);
                    if (next.has(folder.id)) next.delete(folder.id);
                    else next.add(folder.id);
                    return next;
                  })}
                >
                  <span className="v2-project-mobile-row-icon" aria-hidden="true">
                    <UiV2Icon name="folder" />
                  </span>
                  <span>
                    <strong>{folder.name}</strong>
                    <small>{folderChats.length} {folderChats.length === 1 ? "chat" : "chats"}</small>
                  </span>
                  <UiV2Icon name={expanded ? "chevron-down" : "chevron-right"} />
                </button>
                {expanded && folderChats.length > 0 ? (
                  <ul className="v2-project-mobile-folder-chats">
                    {folderChats.map((chat) => (
                      <MobileProjectChatRow
                        active={chat.id === activeChatId}
                        chat={chat}
                        key={chat.id}
                        onNavigate={onNavigate}
                        onSelect={() => controller.actions.selectChat(chat.id)}
                      />
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
          {unfiledChats.map((chat) => (
            <MobileProjectChatRow
              active={chat.id === activeChatId}
              chat={chat}
              key={chat.id}
              onNavigate={onNavigate}
              onSelect={() => controller.actions.selectChat(chat.id)}
            />
          ))}
        </ul>
      )}
      {normalizedQuery ? (
        <p className="v2-sr-only" aria-live="polite">{visibleChatCount} matching chats</p>
      ) : null}
    </section>
  );
}
