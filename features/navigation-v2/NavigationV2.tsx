"use client";

import {
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuItem,
  UiV2MenuSurface,
  UiV2Skeleton
} from "@/components/ui-v2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import {
  clearChatNavigationSearch,
  loadChatNavigation,
  loadChatNavigationSearch
} from "@/components/app-shell/chatNavigationActions";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import type {
  ChatNavigationFolderWire,
  ChatNavigationSummaryWire
} from "@/lib/contracts/chats";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";

type SidebarCompositionV2 = "compact" | "desktop" | "mobile";

function currentSidebarCompositionV2(): SidebarCompositionV2 {
  if (typeof window === "undefined") return "desktop";
  if (window.matchMedia?.("(max-width: 899px)").matches) return "mobile";
  if (window.matchMedia?.("(max-width: 1023px)").matches) return "compact";
  if (!window.matchMedia && window.innerWidth < 900) return "mobile";
  if (!window.matchMedia && window.innerWidth < 1024) return "compact";
  return "desktop";
}

export type NewChatMode = "EXCLUDED" | "NORMAL" | "TEMPORARY";

export type NavigationChatRowState = Readonly<{
  favorite: boolean;
  memoryMode: "EXCLUDED" | "NORMAL" | "TEMPORARY";
}>;

export type NavigationSidebarProps = Readonly<{
  accountLabel?: string | null;
  activeChatId: string | null;
  /**
   * Optional current per-chat state (favourite, retained Memory mode) so the
   * row menu can show what is active; unknown chats simply render stateless.
   */
  chatStateFor?(chat: ChatNavigationSummaryWire): NavigationChatRowState | null;
  chats: readonly ChatNavigationSummaryWire[];
  /** Marks the mode the current session is in inside the New-chat mode menu. */
  currentNewChatMode?: NewChatMode;
  error: string | null;
  folders: readonly ChatNavigationFolderWire[];
  hasMore: boolean;
  loading: boolean;
  now?: Date;
  onArchive?(chat: ChatNavigationSummaryWire): void;
  onArchivedChats?(): void;
  onCancelChatRename?(): void;
  onCancelFolderRename?(): void;
  onChangeChatRename?(value: string): void;
  onChangeFolderRename?(value: string): void;
  onClose(): void;
  onCreateFolder?(parentId: string | null, name: string): Promise<unknown> | unknown;
  /**
   * Direct permanent-deletion entry. Provided only while the server-verified
   * `permanentChatDeletionAvailable` capability holds; it opens the existing
   * confirm surface and never deletes by itself.
   */
  onDelete?(chat: ChatNavigationSummaryWire): void;
  onDeleteFolder?(folder: ChatNavigationFolderWire): void;
  onExport?(chat: ChatNavigationSummaryWire): void;
  onFavorite?(chat: ChatNavigationSummaryWire): void;
  onFolderProjectSettings?(folder: ChatNavigationFolderWire): void;
  onLibrary?(): void;
  onLoadMore(): void;
  onMemoryMode?(chat: ChatNavigationSummaryWire, mode: "EXCLUDED" | "NORMAL"): void;
  onMove?(chat: ChatNavigationSummaryWire, folderId: string | null): void;
  onMoveFolder?(folder: ChatNavigationFolderWire, folderId: string | null): void;
  onNewChat(mode: NewChatMode): void;
  /** Opens the single shell command palette from the quiet "Search ⌘K" row. */
  onOpenSearch?(): void;
  onRenameChat?(chat: ChatNavigationSummaryWire): void;
  onRenameFolder?(folder: ChatNavigationFolderWire): void;
  onSaveChatRename?(chat: ChatNavigationSummaryWire): Promise<unknown> | unknown;
  onSaveFolderRename?(folder: ChatNavigationFolderWire): Promise<unknown> | unknown;
  onRetry(): void;
  onSelectChat(chat: ChatNavigationSummaryWire): void;
  onShare?(chat: ChatNavigationSummaryWire): void;
  onSettings?(): void;
  onSearch(value: string): void;
  /** Shared-workspace navigation rendered before the personal chat tree. */
  projectsSlot?: ReactNode | ((onNavigate: () => void) => ReactNode);
  ready: boolean;
  searchError: string | null;
  searchLoading: boolean;
  searchQuery: string;
  editingChatId?: string | null;
  editingChatTitle?: string;
  editingFolderId?: string | null;
  editingFolderName?: string;
}>;

type DateGroup = "earlier" | "last-seven" | "today" | "yesterday";

const dateLabels: Record<DateGroup, string> = {
  earlier: "Earlier",
  "last-seven": "Previous 7 days",
  today: "Today",
  yesterday: "Yesterday"
};

function dateGroup(updatedAt: string, now = new Date()): DateGroup {
  const day = new Date(updatedAt);
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const target = new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime();
  const delta = Math.floor((start - target) / 86_400_000);
  if (delta <= 0) return "today";
  if (delta === 1) return "yesterday";
  if (delta <= 7) return "last-seven";
  return "earlier";
}

export type FlattenedFolder<Folder> = Readonly<{ depth: number; folder: Folder }>;

/**
 * Depth-first flattening of the folder tree for move pickers: every folder —
 * nested ones included — appears once with its depth for indentation. Passing
 * `excludeId` removes that folder and its entire subtree (a folder can never
 * be moved into itself or a descendant). Folders whose parent is not part of
 * the projection are treated as roots so no destination silently disappears.
 */
export function flattenFolderTree<
  Folder extends Readonly<{ id: string; name: string; parentId: string | null }>
>(
  folders: readonly Folder[],
  excludeId?: string | null
): readonly FlattenedFolder<Folder>[] {
  const ids = new Set(folders.map((folder) => folder.id));
  const result: FlattenedFolder<Folder>[] = [];
  const visit = (parentId: string | null, depth: number) => {
    for (const folder of folders) {
      const effectiveParent =
        folder.parentId !== null && ids.has(folder.parentId) ? folder.parentId : null;
      if (effectiveParent !== parentId || folder.id === excludeId) continue;
      result.push({ depth, folder });
      visit(folder.id, depth + 1);
    }
  };
  visit(null, 0);
  return result;
}

function ChatRow({
  active,
  chat,
  chatStateFor,
  depth = 0,
  editing,
  editingTitle,
  folders,
  onArchive,
  onCancelRename,
  onChangeRename,
  onDelete,
  onExport,
  onFavorite,
  onMemoryMode,
  onMove,
  onRename,
  onSaveRename,
  onShare,
  onSelect
}: {
  active: boolean;
  chat: ChatNavigationSummaryWire;
  chatStateFor?(chat: ChatNavigationSummaryWire): NavigationChatRowState | null;
  depth?: number;
  editing?: boolean;
  editingTitle?: string;
  folders: readonly ChatNavigationFolderWire[];
  onArchive?(chat: ChatNavigationSummaryWire): void;
  onCancelRename?(): void;
  onChangeRename?(value: string): void;
  onDelete?(chat: ChatNavigationSummaryWire): void;
  onExport?(chat: ChatNavigationSummaryWire): void;
  onFavorite?(chat: ChatNavigationSummaryWire): void;
  onMemoryMode?(chat: ChatNavigationSummaryWire, mode: "EXCLUDED" | "NORMAL"): void;
  onMove?(chat: ChatNavigationSummaryWire, folderId: string | null): void;
  onRename?(chat: ChatNavigationSummaryWire): void;
  onSaveRename?(chat: ChatNavigationSummaryWire): Promise<unknown> | unknown;
  onShare?(chat: ChatNavigationSummaryWire): void;
  onSelect(chat: ChatNavigationSummaryWire): void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const closeMenu = () => {
    setMenuOpen(false);
    setMoveOpen(false);
  };
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: closeMenu, open: menuOpen });
  const rowState = chatStateFor?.(chat) ?? null;
  const memoryUsed = (rowState?.memoryMode ?? "NORMAL") !== "EXCLUDED";
  if (editing) {
    return (
      <form
        className="v2-chat-rename"
        style={{ marginLeft: `${Math.min(depth, 3) * 0.75}rem` }}
        onSubmit={(event) => {
          event.preventDefault();
          void onSaveRename?.(chat);
        }}
      >
        <input
          autoFocus
          aria-label={`New title: ${chat.title}`}
          maxLength={120}
          value={editingTitle ?? chat.title}
          onChange={(event) => onChangeRename?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onCancelRename?.();
            }
          }}
        />
        <UiV2IconButton icon="check" label="Save title" type="submit" />
        <UiV2IconButton icon="close" label="Cancel rename" onClick={onCancelRename} />
      </form>
    );
  }
  return (
    <div className="v2-chat-row-wrap" style={{ paddingLeft: `${Math.min(depth, 3) * 0.75}rem` }}>
      <button
        className="v2-chat-row v2-focusable"
        data-selected={active || undefined}
        title={chat.title}
        type="button"
        onClick={() => onSelect(chat)}
      >
        {chat.activeRun ? (
          <span className="v2-chat-pulse" aria-label="Answer in progress" />
        ) : <span aria-hidden="true" />}
        <span className="v2-chat-title">{chat.title}</span>
      </button>
      <UiV2IconButton
        className="v2-chat-menu-trigger"
        icon="more"
        label={`Actions: ${chat.title}`}
        aria-expanded={menuOpen}
        ref={triggerRef}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
      />
      {menuOpen ? (
        <UiV2MenuSurface
          className="v2-chat-menu"
          label={`Chat actions: ${chat.title}`}
          ref={menuRef}
        >
          <UiV2MenuItem onClick={() => { closeMenu(); onRename?.(chat); }}>Rename</UiV2MenuItem>
          <UiV2MenuItem aria-expanded={moveOpen} onClick={() => setMoveOpen((open) => !open)}>
            Move to…
          </UiV2MenuItem>
          {moveOpen ? (
            <div className="v2-chat-move-options" aria-label="Choose a folder">
              <UiV2MenuItem onClick={() => { closeMenu(); onMove?.(chat, null); }}>No folder</UiV2MenuItem>
              {flattenFolderTree(folders).map(({ depth: folderDepth, folder }) => (
                <UiV2MenuItem
                  key={folder.id}
                  style={{ paddingLeft: `${0.5 + folderDepth * 0.75}rem` }}
                  onClick={() => { closeMenu(); onMove?.(chat, folder.id); }}
                >
                  {folder.name}
                </UiV2MenuItem>
              ))}
            </div>
          ) : null}
          <UiV2MenuItem
            selected={rowState?.favorite ?? false}
            onClick={() => { closeMenu(); onFavorite?.(chat); }}
          >
            Favorite
          </UiV2MenuItem>
          <UiV2MenuItem
            selected={memoryUsed}
            onClick={() => {
              closeMenu();
              onMemoryMode?.(chat, memoryUsed ? "EXCLUDED" : "NORMAL");
            }}
          >
            Use memory
          </UiV2MenuItem>
          <UiV2MenuItem onClick={() => { closeMenu(); onShare?.(chat); }}>Share</UiV2MenuItem>
          <UiV2MenuItem onClick={() => { closeMenu(); onExport?.(chat); }}>Export</UiV2MenuItem>
          <UiV2MenuItem
            disabled={chat.activeRun}
            onClick={() => {
              closeMenu();
              onArchive?.(chat);
            }}
          >
            Archive
          </UiV2MenuItem>
          {onDelete ? (
            <UiV2MenuItem
              disabled={chat.activeRun}
              onClick={() => {
                closeMenu();
                onDelete(chat);
              }}
            >
              Delete…
            </UiV2MenuItem>
          ) : null}
        </UiV2MenuSurface>
      ) : null}
    </div>
  );
}

function FolderGroup({
  activeChatId,
  chats,
  depth,
  folder,
  folders,
  props,
}: {
  activeChatId: string | null;
  chats: readonly ChatNavigationSummaryWire[];
  depth: number;
  folder: ChatNavigationFolderWire;
  folders: readonly ChatNavigationFolderWire[];
  props: NavigationSidebarProps;
}) {
  const [open, setOpen] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [subfolderOpen, setSubfolderOpen] = useState(false);
  const [subfolderName, setSubfolderName] = useState("");
  const closeMenu = () => {
    setMenuOpen(false);
    setMoveOpen(false);
  };
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: closeMenu, open: menuOpen });
  const directChats = chats.filter((chat) => chat.folderId === folder.id);
  const children = folders.filter((candidate) => candidate.parentId === folder.id);
  const editing = props.editingFolderId === folder.id;
  return (
    <div className="v2-navigation-group" data-folder-id={folder.id}>
      <div className="v2-folder-row" style={{ paddingLeft: `${Math.min(depth, 3) * 0.75}rem` }}>
        {editing ? (
          <form className="v2-folder-rename" onSubmit={(event) => {
            event.preventDefault();
            void props.onSaveFolderRename?.(folder);
          }}>
            <input
              autoFocus
              aria-label={`New folder name: ${folder.name}`}
              maxLength={80}
              value={props.editingFolderName ?? folder.name}
              onChange={(event) => props.onChangeFolderRename?.(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") props.onCancelFolderRename?.();
              }}
            />
            <UiV2IconButton icon="check" label="Save folder" type="submit" />
            <UiV2IconButton icon="close" label="Cancel" onClick={props.onCancelFolderRename} />
          </form>
        ) : (
          <>
            <button
              className="v2-folder-toggle v2-focusable"
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <UiV2Icon name={open ? "chevron-down" : "chevron-right"} />
              <UiV2Icon name="folder" />
              <span className="v2-chat-title">{folder.name}</span>
            </button>
            <UiV2IconButton
              className="v2-folder-menu-trigger"
              icon="more"
              label={`Folder actions: ${folder.name}`}
              aria-expanded={menuOpen}
              ref={triggerRef}
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            />
            {menuOpen ? (
              <UiV2MenuSurface
                className="v2-folder-menu"
                label={`Folder actions: ${folder.name}`}
                ref={menuRef}
              >
                <UiV2MenuItem onClick={() => { closeMenu(); props.onRenameFolder?.(folder); }}>
                  Rename
                </UiV2MenuItem>
                <UiV2MenuItem onClick={() => { closeMenu(); setSubfolderOpen(true); setOpen(true); }}>
                  New subfolder
                </UiV2MenuItem>
                <UiV2MenuItem aria-expanded={moveOpen} onClick={() => setMoveOpen((value) => !value)}>
                  Move to…
                </UiV2MenuItem>
                {moveOpen ? (
                  <div className="v2-chat-move-options" aria-label="Move folder">
                    <UiV2MenuItem onClick={() => { closeMenu(); props.onMoveFolder?.(folder, null); }}>Top level</UiV2MenuItem>
                    {flattenFolderTree(folders, folder.id).map(({ depth: folderDepth, folder: candidate }) => (
                      <UiV2MenuItem
                        key={candidate.id}
                        style={{ paddingLeft: `${0.5 + folderDepth * 0.75}rem` }}
                        onClick={() => { closeMenu(); props.onMoveFolder?.(folder, candidate.id); }}
                      >
                        {candidate.name}
                      </UiV2MenuItem>
                    ))}
                  </div>
                ) : null}
                <UiV2MenuItem onClick={() => { closeMenu(); props.onFolderProjectSettings?.(folder); }}>
                  Project settings
                </UiV2MenuItem>
                <UiV2MenuItem onClick={() => { closeMenu(); props.onDeleteFolder?.(folder); }}>
                  Delete folder
                </UiV2MenuItem>
              </UiV2MenuSurface>
            ) : null}
          </>
        )}
      </div>
      {open ? (
        <>
          {subfolderOpen ? (
            <form className="v2-new-folder-inline" onSubmit={(event) => {
              event.preventDefault();
              if (!subfolderName.trim()) return;
              void Promise.resolve(props.onCreateFolder?.(folder.id, subfolderName.trim())).then(() => {
                setSubfolderName("");
                setSubfolderOpen(false);
              });
            }}>
              <input
                autoFocus
                aria-label={`Subfolder name in ${folder.name}`}
                maxLength={80}
                placeholder="Subfolder name"
                value={subfolderName}
                onChange={(event) => setSubfolderName(event.target.value)}
              />
              <UiV2IconButton icon="check" label="Create subfolder" type="submit" />
              <UiV2IconButton icon="close" label="Cancel" onClick={() => setSubfolderOpen(false)} />
            </form>
          ) : null}
          {directChats.map((chat) => (
            <ChatRow
              active={chat.id === activeChatId}
              chat={chat}
              chatStateFor={props.chatStateFor}
              depth={depth + 1}
              editing={props.editingChatId === chat.id}
              editingTitle={props.editingChatTitle}
              folders={folders}
              key={chat.id}
              onArchive={props.onArchive}
              onCancelRename={props.onCancelChatRename}
              onChangeRename={props.onChangeChatRename}
              onDelete={props.onDelete}
              onExport={props.onExport}
              onFavorite={props.onFavorite}
              onMemoryMode={props.onMemoryMode}
              onMove={props.onMove}
              onRename={props.onRenameChat}
              onSaveRename={props.onSaveChatRename}
              onShare={props.onShare}
              onSelect={props.onSelectChat}
            />
          ))}
          {children.map((child) => (
            <FolderGroup
              activeChatId={activeChatId}
              chats={chats}
              depth={depth + 1}
              folder={child}
              folders={folders}
              key={child.id}
              props={props}
            />
          ))}
        </>
      ) : null}
    </div>
  );
}

export function NavigationSidebar(props: NavigationSidebarProps) {
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  const {
    menuRef: newChatMenuRef,
    triggerRef: newChatTriggerRef
  } = useMenuDismissalV2({
    onClose: () => setNewChatMenuOpen(false),
    open: newChatMenuOpen
  });
  const currentMode = props.currentNewChatMode ?? "NORMAL";
  // Navigating away from search results resets the query so no stale
  // results view survives chat selection.
  const selectChat = (chat: ChatNavigationSummaryWire) => {
    if (props.searchQuery) props.onSearch("");
    props.onSelectChat(chat);
  };
  const rowProps: NavigationSidebarProps = { ...props, onSelectChat: selectChat };
  const unfiled = props.chats.filter((chat) => chat.folderId === null);
  const roots = props.folders.filter((folder) => folder.parentId === null);
  const dateGroups = (["today", "yesterday", "last-seven", "earlier"] as const)
    .map((id) => ({
      chats: unfiled.filter((chat) => dateGroup(chat.updatedAt, props.now) === id),
      id
    }))
    .filter((group) => group.chats.length > 0);

  return (
    <aside className="v2-navigation" aria-label="Chat navigation">
      <div className="v2-navigation-header">
        <div className="v2-navigation-brand">
          <span className="v2-navigation-wordmark">
            <span className="v2-navigation-mark" aria-hidden="true">A</span>
            AIQSA
          </span>
          <UiV2IconButton icon="close" label="Close sidebar" onClick={props.onClose} />
        </div>
        <div className="v2-new-chat-wrap">
          <button
            className="v2-new-chat-main v2-focusable"
            type="button"
            onClick={() => props.onNewChat("NORMAL")}
          >
            <UiV2Icon name="plus" />
            New chat
          </button>
          <button
            className="v2-new-chat-menu-trigger v2-focusable"
            type="button"
            aria-expanded={newChatMenuOpen}
            aria-label="New chat mode"
            ref={newChatTriggerRef}
            onClick={() => setNewChatMenuOpen((open) => !open)}
          >
            <UiV2Icon name="chevron-down" />
          </button>
          {newChatMenuOpen ? (
            <UiV2MenuSurface
              className="v2-new-chat-menu"
              label="New chat mode"
              ref={newChatMenuRef}
            >
              <UiV2MenuItem
                selected={currentMode === "NORMAL"}
                sub="Normal memory and history"
                onClick={() => { setNewChatMenuOpen(false); props.onNewChat("NORMAL"); }}
              >
                Normal
              </UiV2MenuItem>
              <UiV2MenuItem
                selected={currentMode === "EXCLUDED"}
                sub="Memory is neither used nor updated"
                onClick={() => { setNewChatMenuOpen(false); props.onNewChat("EXCLUDED"); }}
              >
                Memory off
              </UiV2MenuItem>
              <UiV2MenuItem
                selected={currentMode === "TEMPORARY"}
                sub="Deleted automatically after 24 hours"
                onClick={() => { setNewChatMenuOpen(false); props.onNewChat("TEMPORARY"); }}
              >
                Temporary chat
              </UiV2MenuItem>
              {props.onCreateFolder ? (
                <>
                  <div aria-hidden="true" className="v2-menu-separator" />
                  <UiV2MenuItem
                    onClick={() => { setNewChatMenuOpen(false); setNewFolderOpen(true); }}
                  >
                    New folder
                  </UiV2MenuItem>
                </>
              ) : null}
            </UiV2MenuSurface>
          ) : null}
        </div>
        {props.onOpenSearch ? (
          <button
            className="v2-navigation-search-row v2-focusable"
            type="button"
            onClick={props.onOpenSearch}
          >
            <UiV2Icon name="search" />
            <span>Search</span>
            <kbd aria-hidden="true" className="v2-navigation-kbd">⌘K</kbd>
          </button>
        ) : null}
        {props.onCreateFolder && newFolderOpen ? (
          <form className="v2-new-folder-inline" onSubmit={(event) => {
            event.preventDefault();
            if (!newFolderName.trim()) return;
            void Promise.resolve(props.onCreateFolder?.(null, newFolderName.trim())).then(() => {
              setNewFolderName("");
              setNewFolderOpen(false);
            });
          }}>
            <input
              autoFocus
              aria-label="New folder name"
              maxLength={80}
              placeholder="Folder name"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
            />
            <UiV2IconButton icon="check" label="Create folder" type="submit" />
            <UiV2IconButton icon="close" label="Cancel" onClick={() => setNewFolderOpen(false)} />
          </form>
        ) : null}
      </div>

      <div className="v2-navigation-scroll" aria-live="polite">
        {typeof props.projectsSlot === "function"
          ? props.projectsSlot(props.onClose)
          : props.projectsSlot}
        {!props.ready && props.loading ? (
          <div className="v2-navigation-skeletons" aria-label="Loading chats">
            {[0, 1, 2, 3, 4].map((index) => (
              <UiV2Skeleton className="block" key={index} />
            ))}
          </div>
        ) : props.error && !props.ready ? (
          <div className="v2-navigation-status">
            <span>Could not load chats</span>
            <button className="v2-navigation-retry v2-focusable" type="button" onClick={props.onRetry}>
              Retry
            </button>
          </div>
        ) : props.searchQuery && props.searchLoading && props.chats.length === 0 ? (
          <div className="v2-navigation-status">Searching chats…</div>
        ) : props.searchQuery && props.searchError && props.chats.length === 0 ? (
          <div className="v2-navigation-status">
            <span>Search is unavailable</span>
            <button className="v2-navigation-retry v2-focusable" type="button" onClick={props.onRetry}>
              Retry
            </button>
          </div>
        ) : props.chats.length === 0 ? (
          <div className="v2-navigation-status">
            {props.searchQuery ? "Nothing found" : "Start your first chat"}
          </div>
        ) : props.searchQuery ? (
          <div className="v2-navigation-group">
            <div className="v2-navigation-group-label">Results</div>
            {props.chats.map((chat) => (
              <ChatRow
                active={chat.id === props.activeChatId}
                chat={chat}
                chatStateFor={props.chatStateFor}
                editing={props.editingChatId === chat.id}
                editingTitle={props.editingChatTitle}
                folders={props.folders}
                key={chat.id}
                onArchive={props.onArchive}
                onCancelRename={props.onCancelChatRename}
                onChangeRename={props.onChangeChatRename}
                onDelete={props.onDelete}
                onExport={props.onExport}
                onFavorite={props.onFavorite}
                onMemoryMode={props.onMemoryMode}
                onMove={props.onMove}
                onRename={props.onRenameChat}
                onSaveRename={props.onSaveChatRename}
                onShare={props.onShare}
                onSelect={selectChat}
              />
            ))}
          </div>
        ) : (
          <>
            {roots.map((folder) => (
              <FolderGroup
                activeChatId={props.activeChatId}
                chats={props.chats}
                depth={0}
                folder={folder}
                folders={props.folders}
                key={folder.id}
                props={rowProps}
              />
            ))}
            {dateGroups.map((group) => (
              <div className="v2-navigation-group" key={group.id}>
                <div className="v2-navigation-group-label">{dateLabels[group.id]}</div>
                {group.chats.map((chat) => (
                  <ChatRow
                    active={chat.id === props.activeChatId}
                    chat={chat}
                    chatStateFor={props.chatStateFor}
                    editing={props.editingChatId === chat.id}
                    editingTitle={props.editingChatTitle}
                    folders={props.folders}
                    key={chat.id}
                    onArchive={props.onArchive}
                    onCancelRename={props.onCancelChatRename}
                    onChangeRename={props.onChangeChatRename}
                    onDelete={props.onDelete}
                    onExport={props.onExport}
                    onFavorite={props.onFavorite}
                    onMemoryMode={props.onMemoryMode}
                    onMove={props.onMove}
                    onRename={props.onRenameChat}
                    onSaveRename={props.onSaveChatRename}
                    onShare={props.onShare}
                    onSelect={selectChat}
                  />
                ))}
              </div>
            ))}
          </>
        )}
        {props.hasMore ? (
          <button
            className="v2-navigation-load-more v2-focusable"
            disabled={props.loading || props.searchLoading}
            type="button"
            onClick={props.onLoadMore}
          >
            Show earlier
          </button>
        ) : null}
      </div>

      <div className="v2-navigation-footer">
        {props.onArchivedChats ? (
          <button className="v2-navigation-destination v2-focusable" type="button" onClick={props.onArchivedChats}>
            <UiV2Icon name="archive" /> Archived chats
          </button>
        ) : null}
        <button className="v2-navigation-destination v2-focusable" type="button" onClick={props.onLibrary}>
          <UiV2Icon name="library" />
          Library
        </button>
        <button className="v2-navigation-destination v2-focusable" type="button" onClick={props.onSettings}>
          <UiV2Icon name="settings" />
          <span className="v2-chat-title">{props.accountLabel || "Settings"}</span>
        </button>
      </div>
    </aside>
  );
}

export function NavigationSidebarContainer(ownerProps: Omit<NavigationSidebarProps,
  | "activeChatId" | "chats" | "error" | "folders" | "hasMore" | "loading"
  | "onLoadMore" | "onRetry" | "onSearch" | "ready" | "searchError"
  | "searchLoading" | "searchQuery"
>) {
  const activeChatId = useWorkspaceStore((state) => state.activeChatId);
  const chats = useWorkspaceStore((state) => state.navigationChats);
  const error = useWorkspaceStore((state) => state.navigationError);
  const folders = useWorkspaceStore((state) => state.navigationFolders);
  const loading = useWorkspaceStore((state) => state.navigationLoading);
  const nextCursor = useWorkspaceStore((state) => state.navigationNextCursor);
  const ready = useWorkspaceStore((state) => state.navigationReady);
  const searchChats = useWorkspaceStore((state) => state.navigationSearchChats);
  const searchError = useWorkspaceStore((state) => state.navigationSearchError);
  const searchLoading = useWorkspaceStore((state) => state.navigationSearchLoading);
  const searchNextCursor = useWorkspaceStore((state) => state.navigationSearchNextCursor);
  const searchQuery = useWorkspaceStore((state) => state.navigationSearchQuery);
  const activeRunIdsKey = useRunLifecycleStore((state) =>
    Object.keys(state.activeStreams).sort().join("\0")
  );
  const activeRunIds = useMemo(
    () => new Set(activeRunIdsKey ? activeRunIdsKey.split("\0") : []),
    [activeRunIdsKey]
  );
  const previousActiveRunIdsRef = useRef<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const workspace = useWorkspaceStore.getState();
    for (const chatId of activeRunIds) {
      workspace.setNavigationChatActiveRun(chatId, true);
    }
    for (const chatId of previousActiveRunIdsRef.current) {
      if (!activeRunIds.has(chatId)) workspace.setNavigationChatActiveRun(chatId, false);
    }
    previousActiveRunIdsRef.current = activeRunIds;
  }, [activeRunIds]);

  const visibleChats = (searchQuery ? searchChats : chats).map((chat) =>
    activeRunIds.has(chat.id) && !chat.activeRun ? { ...chat, activeRun: true } : chat
  );

  useEffect(() => {
    if (!ready && !loading) void loadChatNavigation();
  }, [loading, ready]);

  return (
    <NavigationSidebar
      {...ownerProps}
      activeChatId={activeChatId}
      chats={visibleChats}
      error={error}
      folders={folders}
      hasMore={Boolean(searchQuery ? searchNextCursor : nextCursor)}
      loading={loading}
      onLoadMore={() => {
        if (searchQuery) void loadChatNavigationSearch({ append: true, query: searchQuery });
        else void loadChatNavigation({ append: true });
      }}
      onRetry={() => {
        if (searchQuery) void loadChatNavigationSearch({ query: searchQuery });
        else void loadChatNavigation();
      }}
      onSearch={(value) => {
        if (value) useWorkspaceStore.getState().setNavigationSearchQuery(value);
        else clearChatNavigationSearch();
      }}
      ready={ready}
      searchError={searchError}
      searchLoading={searchLoading}
      searchQuery={searchQuery}
    />
  );
}

type ReadingRoomShellV2Props = Omit<NavigationSidebarProps,
  | "activeChatId" | "chats" | "error" | "folders" | "hasMore" | "loading"
  | "now" | "onClose" | "onLoadMore" | "onRetry" | "onSearch" | "ready"
  | "searchError" | "searchLoading" | "searchQuery"
> & {
  children: ReactNode;
  sidebar?: ReactNode | ((onClose: () => void) => ReactNode);
};

export function ReadingRoomShellV2({
  children,
  sidebar,
  ...navigationOwnerProps
}: ReadingRoomShellV2Props) {
  const { onNewChat } = navigationOwnerProps;
  const [composition, setComposition] = useState<SidebarCompositionV2>("desktop");
  const [compactExpanded, setCompactExpanded] = useState(false);
  const [desktopCollapsed, setDesktopCollapsed] = useState(false);
  const [focusRequest, setFocusRequest] = useState<Readonly<{
    id: number;
    target: "open" | "sidebar";
  }> | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const compositionRef = useRef<SidebarCompositionV2>("desktop");
  const focusBeforeCompactRef = useRef<HTMLElement | null>(null);
  const handledFocusRequestRef = useRef(0);
  const lastNavigationFocusRef = useRef<HTMLElement | null>(null);
  const previousCompositionRef = useRef<SidebarCompositionV2>("desktop");
  const previousMobileOpenRef = useRef(false);
  const searchQuery = useWorkspaceStore((state) => state.navigationSearchQuery);
  const collapsed = composition === "compact" ? !compactExpanded : desktopCollapsed;

  useLayoutEffect(() => {
    const update = () => {
      const next = currentSidebarCompositionV2();
      if (next === compositionRef.current) return;
      compositionRef.current = next;
      if (next !== "mobile") setMobileOpen(false);
      if (next === "compact") setCompactExpanded(false);
      setComposition(next);
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  useLayoutEffect(() => {
    const previous = previousCompositionRef.current;
    previousCompositionRef.current = composition;
    if (previous === composition) return;
    const navigation = document.querySelector<HTMLElement>(".v2-navigation");
    const active = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const enteringCollapsedComposition = composition === "mobile" || composition === "compact";
    const navigationSource = active && navigation?.contains(active)
      ? active
      : lastNavigationFocusRef.current;
    if (
      enteringCollapsedComposition &&
      navigationSource?.isConnected &&
      (previous === "desktop" || !focusBeforeCompactRef.current)
    ) {
      focusBeforeCompactRef.current = navigationSource;
      openButtonRef.current?.focus();
    } else if (enteringCollapsedComposition && focusBeforeCompactRef.current) {
      openButtonRef.current?.focus();
    }
    if (
      composition === "desktop" &&
      !desktopCollapsed &&
      active === openButtonRef.current &&
      focusBeforeCompactRef.current?.isConnected
    ) {
      focusBeforeCompactRef.current.focus();
      focusBeforeCompactRef.current = null;
    }
  }, [composition, desktopCollapsed]);

  useLayoutEffect(() => {
    if (!focusRequest || focusRequest.id === handledFocusRequestRef.current) return;
    const sidebarPresented = composition === "mobile" ? mobileOpen : !collapsed;
    if (focusRequest.target === "open" && !sidebarPresented) {
      openButtonRef.current?.focus();
      handledFocusRequestRef.current = focusRequest.id;
    } else if (focusRequest.target === "sidebar" && sidebarPresented) {
      document.querySelector<HTMLElement>(
        ".v2-navigation button:not([disabled])"
      )?.focus();
      handledFocusRequestRef.current = focusRequest.id;
    }
  }, [collapsed, composition, focusRequest, mobileOpen]);

  useEffect(() => {
    if (!searchQuery) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void loadChatNavigationSearch({ query: searchQuery, signal: controller.signal });
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [searchQuery]);

  // Ctrl/Cmd+K stays owned by the single shell command-palette controller
  // (`useShellOverlayController`); this shell adds no second global listener.
  useEffect(() => {
    if (!mobileOpen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [mobileOpen]);

  useEffect(() => {
    if (!mobileOpen) return;
    const navigationElement = document.querySelector<HTMLElement>(".v2-navigation");
    if (!navigationElement) return;
    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "a[href]",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const focusable = () => [...navigationElement.querySelectorAll<HTMLElement>(focusableSelector)]
      .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true");
    focusable()[0]?.focus();
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = focusable();
      const first = items[0];
      const last = items.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", trapFocus);
    return () => window.removeEventListener("keydown", trapFocus);
  }, [mobileOpen]);

  useEffect(() => {
    const wasMobileOpen = previousMobileOpenRef.current;
    previousMobileOpenRef.current = mobileOpen;
    if (wasMobileOpen && !mobileOpen) openButtonRef.current?.focus();
  }, [mobileOpen]);

  const closeSidebar = () => {
    setFocusRequest((current) => ({ id: (current?.id ?? 0) + 1, target: "open" }));
    if (composition === "mobile") setMobileOpen(false);
    else if (composition === "compact") setCompactExpanded(false);
    else setDesktopCollapsed(true);
  };
  const projectSlot = navigationOwnerProps.projectsSlot;
  const navigationProjectsSlot = typeof projectSlot === "function"
    ? () => projectSlot(() => {
        if (composition !== "desktop") closeSidebar();
      })
    : projectSlot;
  const navigation = typeof sidebar === "function" ? sidebar(closeSidebar) : sidebar ?? (
    <NavigationSidebarContainer
      {...navigationOwnerProps}
      projectsSlot={navigationProjectsSlot}
      onClose={closeSidebar}
      onSelectChat={(chat) => { navigationOwnerProps.onSelectChat(chat); setMobileOpen(false); }}
    />
  );

  return (
    <div
      className="v2-workspace-shell"
      data-mobile-sidebar={mobileOpen || undefined}
      data-sidebar-collapsed={collapsed || undefined}
      data-sidebar-compact-expanded={composition === "compact" && compactExpanded || undefined}
      data-sidebar-composition={composition}
      onFocusCapture={(event) => {
        const target = event.target;
        if (!(target instanceof HTMLElement)) return;
        if (target.closest(".v2-navigation")) lastNavigationFocusRef.current = target;
        else if (!target.closest(".v2-sidebar-floats")) lastNavigationFocusRef.current = null;
      }}
    >
      <UiV2IconSprite />
      <button
        className="v2-navigation-scrim"
        type="button"
        aria-label="Close navigation"
        onClick={() => setMobileOpen(false)}
      />
      {navigation}
      <div
        className="v2-sidebar-floats"
        aria-label="Navigation"
        inert={mobileOpen ? true : undefined}
      >
        <UiV2IconButton
          ref={openButtonRef}
          icon="menu"
          label="Open sidebar"
          aria-expanded={composition === "mobile" ? mobileOpen : !collapsed}
          onClick={() => {
            setFocusRequest((current) => ({ id: (current?.id ?? 0) + 1, target: "sidebar" }));
            if (composition === "mobile") setMobileOpen(true);
            else if (composition === "compact") setCompactExpanded(true);
            else setDesktopCollapsed(false);
          }}
        />
        <UiV2IconButton icon="plus" label="New chat" onClick={() => onNewChat("NORMAL")} />
      </div>
      <div className="v2-workspace-content" inert={mobileOpen ? true : undefined}>{children}</div>
    </div>
  );
}
