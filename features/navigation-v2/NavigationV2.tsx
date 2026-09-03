"use client";

import {
  UiV2Icon,
  UiV2IconButton,
  UiV2IconSprite,
  UiV2MenuActions,
  UiV2MenuItem,
  UiV2MenuLink,
  UiV2Skeleton
} from "@/components/ui-v2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { UiV2RovingTree } from "@/components/ui-v2/RovingTreeV2";
import { AccountMenuV2 } from "./AccountMenuV2";
import { chatMenuActionsV2, flattenFolderTree, type FlattenedFolder } from "./chatMenuActions";
import { RailV2, type RailSectionV2 } from "./RailV2";
import {
  clearChatNavigationSearch,
  loadChatNavigation,
  loadChatNavigationSearch
} from "@/components/app-shell/chatNavigationActions";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { useRunLifecycleStore } from "@/components/app-shell/runLifecycleStore";
import { chatTitleForDisplay } from "@/components/app-shell/shellFormatting";
import {
  CHAT_NAVIGATION_QUERY_MAX_LENGTH,
  type ChatNavigationFolderWire,
  type ChatNavigationSummaryWire
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
  if (window.matchMedia?.("(max-width: 767px)").matches) return "mobile";
  if (window.matchMedia?.("(max-width: 1023px)").matches) return "compact";
  if (!window.matchMedia && window.innerWidth < 768) return "mobile";
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
  /** Shows the Control Center link inside the account menu. */
  adminEntryVisible?: boolean;
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
  /** Row menu "Branches": the shell selects the chat and opens the Branches view. */
  onBranches?(chat: ChatNavigationSummaryWire): void;
  /** Row menu "Copy entire thread" for that chat. */
  onCopyThread?(chat: ChatNavigationSummaryWire): void;
  onExport?(chat: ChatNavigationSummaryWire, format?: "json" | "markdown"): void;
  onFavorite?(chat: ChatNavigationSummaryWire): void;
  onFolderProjectSettings?(folder: ChatNavigationFolderWire): void;
  /**
   * Rail/drawer Projects and Library are personal-workspace destinations:
   * inside a shared Project the owner leaves it first so the destination has
   * a visible answer (the Projects block or the Library column).
   */
  onLeaveProject?(): void;
  onLibrary?(): void;
  onLoadMore(): void;
  /** Rail/drawer Projects: opens the dedicated Projects section. */
  onProjects?(): void;
  /**
   * Mobile drawer only: the rail destinations (Projects, Library,
   * Settings, Control Center) and the account entry live in the drawer
   * footer because the rail is absent below 768px.
   */
  drawerDestinations?: boolean;
  onMemoryMode?(chat: ChatNavigationSummaryWire, mode: "EXCLUDED" | "NORMAL"): void;
  onMove?(chat: ChatNavigationSummaryWire, folderId: string | null): void;
  onMoveFolder?(folder: ChatNavigationFolderWire, folderId: string | null): void;
  onNewChat(mode: NewChatMode): void;
  onRenameChat?(chat: ChatNavigationSummaryWire): void;
  onRenameFolder?(folder: ChatNavigationFolderWire): void;
  onSaveChatRename?(chat: ChatNavigationSummaryWire): Promise<unknown> | unknown;
  onSaveFolderRename?(folder: ChatNavigationFolderWire): Promise<unknown> | unknown;
  onRetry(): void;
  onSelectChat(chat: ChatNavigationSummaryWire): void;
  onShare?(chat: ChatNavigationSummaryWire): void;
  onSettings?(): void;
  onSearch(value: string): void;
  /** A selected Project owns the sidebar list region; personal chats stay hidden until it is left. */
  projectContextActive?: boolean;
  /** Whether the selected Project currently exposes an enabled message composer. */
  projectComposerAvailable?: boolean;
  /** Selected Project identity rendered as the second-column heading. */
  projectTitle?: ReactNode;
  /** Shared-workspace navigation that exclusively owns the column in Projects mode. */
  projectsSlot?:
    | ReactNode
    | ((onNavigate: () => void, options: Readonly<{ landing: boolean }>) => ReactNode);
  /**
   * "projects" turns the column into the Projects landing (rail/drawer
   * destination): only the Projects block, no chat list or filter.
   */
  view?: "chats" | "projects";
  /** Legacy Projects-to-Chats route; the shell normally owns this through the rail. */
  onShowChats?(): void;
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

/**
 * Depth-first flattening of the folder tree for move pickers (shared with the
 * header menu through `chatMenuActions`): every folder — nested ones included
 * — appears once with its depth for indentation. Passing `excludeId` removes
 * that folder and its entire subtree (a folder can never be moved into itself
 * or a descendant). Folders whose parent is not part of the projection are
 * treated as roots so no destination silently disappears.
 */
export { flattenFolderTree, type FlattenedFolder };

function ChatRow({
  active,
  chat,
  chatStateFor,
  editing,
  editingTitle,
  folders,
  level,
  onArchive,
  onBranches,
  onCancelRename,
  onChangeRename,
  onCopyThread,
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
  editing?: boolean;
  editingTitle?: string;
  folders: readonly ChatNavigationFolderWire[];
  level: number;
  onArchive?(chat: ChatNavigationSummaryWire): void;
  onBranches?(chat: ChatNavigationSummaryWire): void;
  onCancelRename?(): void;
  onChangeRename?(value: string): void;
  onCopyThread?(chat: ChatNavigationSummaryWire): void;
  onDelete?(chat: ChatNavigationSummaryWire): void;
  onExport?(chat: ChatNavigationSummaryWire, format?: "json" | "markdown"): void;
  onFavorite?(chat: ChatNavigationSummaryWire): void;
  onMemoryMode?(chat: ChatNavigationSummaryWire, mode: "EXCLUDED" | "NORMAL"): void;
  onMove?(chat: ChatNavigationSummaryWire, folderId: string | null): void;
  onRename?(chat: ChatNavigationSummaryWire): void;
  onSaveRename?(chat: ChatNavigationSummaryWire): Promise<unknown> | unknown;
  onShare?(chat: ChatNavigationSummaryWire): void;
  onSelect(chat: ChatNavigationSummaryWire): void;
}) {
  const displayTitle = chatTitleForDisplay(chat.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: closeMenu, open: menuOpen });
  const rowState = chatStateFor?.(chat) ?? null;
  const memoryUsed = (rowState?.memoryMode ?? "NORMAL") !== "EXCLUDED";
  if (editing) {
    return (
      <form
        className="v2-chat-rename"
        onSubmit={(event) => {
          event.preventDefault();
          void onSaveRename?.(chat);
        }}
      >
        <input
          autoFocus
          aria-label={`New title: ${displayTitle}`}
          maxLength={120}
          value={editingTitle ?? chat.title}
          onChange={(event) => onChangeRename?.(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
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
    <div
      className="v2-chat-row-wrap"
      data-navigation-chat-id={chat.id}
      data-v2-tree-row="true"
    >
      <button
        aria-current={active ? "page" : undefined}
        aria-label={displayTitle}
        aria-level={level}
        aria-selected={active}
        className="v2-chat-row v2-focusable"
        data-selected={active || undefined}
        data-v2-tree-item="true"
        role="treeitem"
        tabIndex={-1}
        title={displayTitle}
        type="button"
        onClick={() => onSelect(chat)}
      >
        {chat.activeRun ? (
          <span className="v2-chat-pulse" aria-label="Answer in progress" />
        ) : <span aria-hidden="true" />}
        <span className="v2-chat-title">{displayTitle}</span>
      </button>
      <UiV2IconButton
        className="v2-chat-menu-trigger"
        icon="more"
        label={`Actions: ${displayTitle}`}
        aria-expanded={menuOpen}
        aria-haspopup="menu"
        data-v2-row-menu-trigger="true"
        ref={triggerRef}
        tabIndex={-1}
        onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
      />
      {menuOpen ? (
        <UiV2ResponsiveMenu
          anchorRef={triggerRef}
          className="v2-chat-menu"
          label={`Chat actions: ${displayTitle}`}
          menuRef={menuRef}
          onClose={closeMenu}
        >
          {/* Rows stay scannable: object actions first, destructive actions last. */}
          <UiV2MenuActions
            actions={chatMenuActionsV2({
              archiveDisabled: chat.activeRun,
              deleteDisabled: chat.activeRun,
              favorite: rowState?.favorite ?? false,
              folders,
              memoryUsed: onMemoryMode ? memoryUsed : null,
              onArchive: () => onArchive?.(chat),
              onBranches: onBranches ? () => onBranches(chat) : undefined,
              onCopyThread: onCopyThread ? () => onCopyThread(chat) : undefined,
              onDelete: onDelete ? () => onDelete(chat) : undefined,
              onExport: (format) => onExport?.(chat, format),
              onFavorite: () => onFavorite?.(chat),
              onMemoryMode: onMemoryMode ? (mode) => onMemoryMode(chat, mode) : undefined,
              onMove: (folderId) => onMove?.(chat, folderId),
              onRename: () => onRename?.(chat),
              onShare: () => onShare?.(chat),
              surface: "row"
            })}
            onClose={() => {
              // Activating an item returns focus to the menu button; a
              // surface the action opens (rename field, dialog) takes it next.
              closeMenu();
              triggerRef.current?.focus();
            }}
          />
        </UiV2ResponsiveMenu>
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
  // Top-level folders open; nested folders start collapsed so deep trees stay
  // scannable (UX audit F10).
  const [open, setOpen] = useState(depth === 0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [subfolderOpen, setSubfolderOpen] = useState(false);
  const [subfolderName, setSubfolderName] = useState("");
  const closeMenu = () => setMenuOpen(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: closeMenu, open: menuOpen });
  const directChats = chats.filter((chat) => chat.folderId === folder.id);
  const children = folders.filter((candidate) => candidate.parentId === folder.id);
  const editing = props.editingFolderId === folder.id;
  return (
    <div className="v2-navigation-group" data-folder-id={folder.id} role="none">
      <div className="v2-folder-row" data-v2-tree-row="true">
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
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  props.onCancelFolderRename?.();
                }
              }}
            />
            <UiV2IconButton icon="check" label="Save folder" type="submit" />
            <UiV2IconButton icon="close" label="Cancel" onClick={props.onCancelFolderRename} />
          </form>
        ) : (
          <>
            <button
              aria-level={depth + 1}
              aria-selected={false}
              className="v2-folder-toggle v2-focusable"
              data-v2-tree-item="true"
              role="treeitem"
              tabIndex={-1}
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              <UiV2Icon name={open ? "chevron-down" : "chevron-right"} />
              <span className="v2-chat-title">{folder.name}</span>
            </button>
            <UiV2IconButton
              className="v2-folder-menu-trigger"
              icon="more"
              label={`Folder actions: ${folder.name}`}
              aria-expanded={menuOpen}
              aria-haspopup="menu"
              data-v2-row-menu-trigger="true"
              ref={triggerRef}
              tabIndex={-1}
              onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            />
            {menuOpen ? (
              <UiV2ResponsiveMenu
                anchorRef={triggerRef}
                className="v2-folder-menu"
                label={`Folder actions: ${folder.name}`}
                menuRef={menuRef}
                onClose={closeMenu}
              >
                <UiV2MenuActions
                  actions={[
                    { icon: "edit", label: "Rename", onSelect: () => props.onRenameFolder?.(folder) },
                    {
                      icon: "folder-plus",
                      label: "New subfolder",
                      onSelect: () => {
                        setSubfolderOpen(true);
                        setOpen(true);
                      }
                    },
                    {
                      icon: "folder",
                      label: "Move to…",
                      submenu: [
                        { label: "Top level", onSelect: () => props.onMoveFolder?.(folder, null) },
                        ...flattenFolderTree(folders, folder.id).map(({ depth: folderDepth, folder: candidate }) => ({
                          depth: folderDepth,
                          label: candidate.name,
                          onSelect: () => props.onMoveFolder?.(folder, candidate.id)
                        }))
                      ]
                    },
                    { icon: "settings", label: "Default Knowledge…", onSelect: () => props.onFolderProjectSettings?.(folder) },
                    {
                      icon: "trash",
                      label: "Delete folder",
                      onSelect: () => props.onDeleteFolder?.(folder),
                      separatorBefore: true,
                      tone: "destructive"
                    }
                  ]}
                  onClose={closeMenu}
                />
              </UiV2ResponsiveMenu>
            ) : null}
          </>
        )}
      </div>
      {open ? (
        <div className="v2-folder-children" role="group">
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
              editing={props.editingChatId === chat.id}
              editingTitle={props.editingChatTitle}
              folders={folders}
              key={chat.id}
              level={depth + 2}
              onArchive={props.onArchive}
              onCancelRename={props.onCancelChatRename}
              onChangeRename={props.onChangeChatRename}
              onDelete={props.onDelete}
              onBranches={props.onBranches}
              onCopyThread={props.onCopyThread}
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
        </div>
      ) : null}
    </div>
  );
}

type NavigationScrollAnchor = Readonly<{ id: string; top: number }>;

/**
 * The first chat row inside the list's viewport. An earlier page may insert
 * rows above the current position (older chats that live in folders render
 * inside their folder group near the top), so the list re-anchors this row
 * after the append instead of letting the viewport jump.
 */
function firstVisibleChatAnchor(container: HTMLElement): NavigationScrollAnchor | null {
  const containerBounds = container.getBoundingClientRect();
  for (const row of container.querySelectorAll<HTMLElement>("[data-navigation-chat-id]")) {
    const bounds = row.getBoundingClientRect();
    if (bounds.bottom > containerBounds.top && bounds.top < containerBounds.bottom) {
      const id = row.dataset.navigationChatId;
      if (id) return { id, top: bounds.top };
    }
  }
  return null;
}

function findAnchoredChatRow(container: HTMLElement, id: string): HTMLElement | null {
  for (const row of container.querySelectorAll<HTMLElement>("[data-navigation-chat-id]")) {
    if (row.dataset.navigationChatId === id) return row;
  }
  return null;
}

export function NavigationSidebar(props: NavigationSidebarProps) {
  const [newChatMenuOpen, setNewChatMenuOpen] = useState(false);
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  const [newFolderName, setNewFolderName] = useState("");
  // "Filter chats…" is a sidebar-scoped lookup over the user's own chats on
  // the existing server search (the list is paginated, so a client-side
  // filter of loaded rows would miss chats). Typing is debounced; the owner's
  // `searchQuery` stays the source of truth and clears the field when it is
  // reset elsewhere (e.g. after a result is opened).
  const [filterValue, setFilterValue] = useState(props.searchQuery);
  const filterDirtyRef = useRef(false);
  const { onSearch, searchQuery } = props;
  useEffect(() => {
    if (!filterDirtyRef.current) return;
    const next = filterValue.trim();
    if (next === searchQuery) {
      filterDirtyRef.current = false;
      return;
    }
    const timer = window.setTimeout(() => {
      filterDirtyRef.current = false;
      onSearch(next);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [filterValue, onSearch, searchQuery]);
  useEffect(() => {
    if (!searchQuery && !filterDirtyRef.current) setFilterValue("");
  }, [searchQuery]);
  const clearFilter = () => {
    filterDirtyRef.current = false;
    setFilterValue("");
    if (searchQuery) onSearch("");
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLButtonElement>(null);
  const anchorRef = useRef<NavigationScrollAnchor | null>(null);
  const chatKey = useMemo(() => props.chats.map((chat) => chat.id).join("\0"), [props.chats]);
  const pageLoading = props.searchQuery ? props.searchLoading : props.loading;
  const pageError = props.searchQuery ? props.searchError : props.error;
  const { hasMore, onLoadMore } = props;
  const loadMoreBlocked = !hasMore || pageLoading || Boolean(pageError);

  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const container = scrollRef.current;
    if (!anchor || !container) return;
    anchorRef.current = null;
    const row = findAnchoredChatRow(container, anchor.id);
    if (row) container.scrollTop += row.getBoundingClientRect().top - anchor.top;
  }, [chatKey]);

  const loadEarlierChats = () => {
    if (!hasMore || pageLoading) return;
    const container = scrollRef.current;
    anchorRef.current = container ? firstVisibleChatAnchor(container) : null;
    onLoadMore();
  };

  // Reaching the end of the list loads the next page by itself; the button
  // stays as the visible, keyboard-reachable route and as the manual Retry
  // after a failed page (a failure never auto-retries in a loop).
  useEffect(() => {
    const sentinel = loadMoreRef.current;
    const container = scrollRef.current;
    if (
      !sentinel || !container || loadMoreBlocked ||
      typeof IntersectionObserver === "undefined"
    ) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      anchorRef.current = firstVisibleChatAnchor(container);
      onLoadMore();
    }, { root: container, rootMargin: "0px 0px 120px 0px" });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [chatKey, loadMoreBlocked, onLoadMore]);
  const {
    menuRef: newChatMenuRef,
    triggerRef: newChatTriggerRef
  } = useMenuDismissalV2({
    onClose: () => setNewChatMenuOpen(false),
    open: newChatMenuOpen
  });
  const currentMode = props.currentNewChatMode ?? "NORMAL";
  const projectsView = props.view === "projects";
  const projectColumn = projectsView || Boolean(props.projectContextActive);
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
  const focusMessageComposer = () => {
    if (currentSidebarCompositionV2() !== "desktop") props.onClose();
    window.setTimeout(() => {
      document.querySelector<HTMLTextAreaElement>(
        '[data-testid="composer-v2"] textarea:not(:disabled)'
      )?.focus();
    }, 0);
  };

  return (
    <aside
      className="v2-navigation"
      aria-label={projectColumn ? "Project navigation" : "Chat navigation"}
      data-project-context={props.projectContextActive || undefined}
      data-view={projectsView ? "projects" : undefined}
    >
      {!projectsView && (!props.projectContextActive || props.projectComposerAvailable) ? (
        <button
          className="v2-navigation-skip v2-focusable"
          type="button"
          onClick={focusMessageComposer}
        >
          Skip to message composer
        </button>
      ) : null}
      <div className="v2-navigation-header">
        {/* Desktop/compact: the column title plus the hide-list control; the
            mobile drawer shows the wordmark and a close cross instead. */}
        <div className="v2-navigation-brand">
          <span className="v2-navigation-wordmark">
            <span className="v2-navigation-mark" aria-hidden="true"><UiV2Icon name="brand" /></span>
            AIQSA
          </span>
          <span className="v2-navigation-column-title">
            {props.projectContextActive ? props.projectTitle ?? "Project" : projectsView ? "Projects" : "Chats"}
          </span>
          <button
            className="v2-icon-button v2-focusable v2-navigation-close"
            type="button"
            aria-label="Close sidebar"
            data-tooltip="Hide chat list"
            data-tooltip-side="left"
            onClick={props.onClose}
          >
            <UiV2Icon name="panel" />
            <UiV2Icon name="close" />
          </button>
        </div>
        {projectColumn ? null : (
        <div className="v2-new-chat-wrap">
          <button
            className="v2-new-chat-main v2-focusable"
            type="button"
            onClick={() => props.onNewChat("NORMAL")}
          >
            <UiV2Icon name="plus" />
            New chat
          </button>
          {!props.projectContextActive ? (
            <button
              className="v2-new-chat-menu-trigger v2-focusable"
              type="button"
              aria-expanded={newChatMenuOpen}
              aria-haspopup="menu"
              aria-label="New chat mode"
              ref={newChatTriggerRef}
              onClick={() => setNewChatMenuOpen((open) => !open)}
            >
              <UiV2Icon name="chevron-down" />
            </button>
          ) : null}
          {!props.projectContextActive && newChatMenuOpen ? (
            <UiV2ResponsiveMenu
              anchorRef={newChatTriggerRef}
              className="v2-new-chat-menu"
              label="New chat mode"
              menuRef={newChatMenuRef}
              onClose={() => setNewChatMenuOpen(false)}
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
            </UiV2ResponsiveMenu>
          ) : null}
        </div>
        )}
        {!projectColumn ? (
          <div className="v2-navigation-filter">
            <UiV2Icon name="search" />
            <input
              aria-label="Filter chats"
              autoComplete="off"
              maxLength={CHAT_NAVIGATION_QUERY_MAX_LENGTH}
              placeholder="Filter chats…"
              type="search"
              value={filterValue}
              onChange={(event) => {
                filterDirtyRef.current = true;
                setFilterValue(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Escape") return;
                event.preventDefault();
                // Escape clears a query first, then leaves the field (A15).
                if (filterValue) clearFilter();
                else event.currentTarget.blur();
              }}
            />
            {filterValue ? (
              <UiV2IconButton
                className="v2-navigation-filter-clear"
                icon="close"
                label="Clear filter"
                onClick={clearFilter}
              />
            ) : null}
          </div>
        ) : null}
      </div>

      <div className="v2-navigation-scroll" aria-live="polite" ref={scrollRef}>
        {projectColumn
          ? typeof props.projectsSlot === "function"
            ? props.projectsSlot(props.onClose, { landing: projectsView })
            : props.projectsSlot
          : null}
        {!projectColumn ? <>
        <UiV2RovingTree className="v2-navigation-tree" label="Personal chats">
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
        ) : props.searchQuery && props.chats.length === 0 ? (
          <div className="v2-navigation-status">Nothing found</div>
        ) : props.searchQuery ? (
          <div className="v2-navigation-group" role="group" aria-labelledby="v2-navigation-results">
            <div className="v2-navigation-group-label" id="v2-navigation-results">Results</div>
            {props.chats.map((chat) => (
              <ChatRow
                active={chat.id === props.activeChatId}
                chat={chat}
                chatStateFor={props.chatStateFor}
                editing={props.editingChatId === chat.id}
                editingTitle={props.editingChatTitle}
                folders={props.folders}
                key={chat.id}
                level={1}
                onArchive={props.onArchive}
                onCancelRename={props.onCancelChatRename}
                onChangeRename={props.onChangeChatRename}
                onDelete={props.onDelete}
                onBranches={props.onBranches}
                onCopyThread={props.onCopyThread}
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
            {props.chats.length === 0 ? (
              <div className="v2-navigation-status">Start your first chat</div>
            ) : null}
            {/* Recent unfiled chats first, then the folder tree (UX audit F10). */}
            {dateGroups.map((group) => (
              <div
                aria-labelledby={`v2-navigation-${group.id}`}
                className="v2-navigation-group"
                key={group.id}
                role="group"
              >
                <div className="v2-navigation-group-label" id={`v2-navigation-${group.id}`}>
                  {dateLabels[group.id]}
                </div>
                {group.chats.map((chat) => (
                  <ChatRow
                    active={chat.id === props.activeChatId}
                    chat={chat}
                    chatStateFor={props.chatStateFor}
                    editing={props.editingChatId === chat.id}
                    editingTitle={props.editingChatTitle}
                    folders={props.folders}
                    key={chat.id}
                    level={1}
                    onArchive={props.onArchive}
                    onCancelRename={props.onCancelChatRename}
                    onChangeRename={props.onChangeChatRename}
                    onDelete={props.onDelete}
                    onBranches={props.onBranches}
                    onCopyThread={props.onCopyThread}
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
            {roots.length > 0 || props.onCreateFolder ? (
              <div className="v2-navigation-group" role="group" aria-label="Folders">
                {/* Folder creation lives with the folders, not in the New-chat
                    mode menu (UX audit F16); the header row stays so the
                    action is reachable before the first folder exists. */}
                <div className="v2-navigation-group-head">
                  <div className="v2-navigation-group-label">Folders</div>
                  {props.onCreateFolder ? (
                    <UiV2IconButton
                      className="v2-navigation-group-action"
                      icon="plus"
                      label="New folder"
                      aria-expanded={newFolderOpen}
                      onClick={() => setNewFolderOpen((open) => !open)}
                    />
                  ) : null}
                </div>
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
              </div>
            ) : null}
          </>
        )}
        </UiV2RovingTree>
        {props.hasMore ? (
          <div className="v2-navigation-load-more-row" data-error={pageError ? "" : undefined}>
            {pageError && props.ready ? <span>Could not load earlier chats.</span> : null}
            <button
              ref={loadMoreRef}
              aria-busy={pageLoading || undefined}
              className="v2-navigation-load-more v2-focusable"
              disabled={pageLoading}
              type="button"
              onClick={loadEarlierChats}
            >
              {pageLoading ? "Loading…" : pageError && props.ready ? "Retry" : "Show earlier"}
            </button>
          </div>
        ) : null}
        </> : null}
      </div>

      {props.drawerDestinations ? (
        <div className="v2-navigation-footer">
          {/* One row of destinations (UX audit 2026-09-02 #15) so the chat
              list keeps the drawer's height; Settings and Control Center live
              in the account menu, exactly as on the rail. */}
          <div className="v2-navigation-destinations">
            <button
              className="v2-navigation-destination v2-focusable"
              type="button"
              onClick={props.onProjects}
            >
              <UiV2Icon name="layers" /><span>Projects</span>
            </button>
            {props.onLibrary ? (
              <button className="v2-navigation-destination v2-focusable" type="button" onClick={props.onLibrary}>
                <UiV2Icon name="library" /><span>Library</span>
              </button>
            ) : null}
            {props.onSettings ? (
              <button
                className="v2-navigation-destination v2-focusable"
                type="button"
                onClick={props.onSettings}
              >
                <UiV2Icon name="settings" /><span>Settings</span>
              </button>
            ) : null}
          </div>
          <AccountMenuV2
            accountLabel={props.accountLabel}
            adminEntryVisible={props.adminEntryVisible}
            onSettings={props.onSettings}
          />
        </div>
      ) : null}
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
  | "activeChatId" | "chats" | "drawerDestinations" | "error" | "folders" | "hasMore" | "loading"
  | "now" | "onClose" | "onLoadMore" | "onRetry" | "onSearch" | "ready"
  | "searchError" | "searchLoading" | "searchQuery"
> & {
  /** Marks an open chat so the mobile "+" island yields to the title pill. */
  chatActive?: boolean;
  children: ReactNode;
  /** Rail "Chats" while another section is open: returns to the chat. */
  onChats?(): void;
  /** Mirrors whether the Projects reading surface is open. */
  onProjectsSectionChange?(open: boolean): void;
  /** Optional controlled state for the Projects reading/column destination. */
  projectsSectionOpen?: boolean;
  /** Which second-column section is open; the rail marks it. */
  section?: RailSectionV2;
  sidebar?: ReactNode | ((onClose: () => void) => ReactNode);
};

/** Platform-specific hint for a Ctrl/⌘ shortcut: "shift+o" → "Ctrl+Shift+O" / "⌘⇧O". */
export function shortcutHintV2(keys: string): string {
  const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const parts = keys.split("+").map((part) => part.trim().toLowerCase());
  if (mac) {
    return `⌘${parts.map((part) => (part === "shift" ? "⇧" : part.toUpperCase())).join("")}`;
  }
  return ["Ctrl", ...parts.map((part) => (part === "shift" ? "Shift" : part.toUpperCase()))].join("+");
}

export function ReadingRoomShellV2({
  chatActive = false,
  children,
  onChats,
  onProjectsSectionChange,
  projectsSectionOpen,
  section = "chats",
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
  // Presentation-only: the second column shows the Projects landing instead
  // of the chat list until a chat is chosen or Chats is pressed.
  const [uncontrolledProjectsView, setProjectsView] = useState(false);
  const projectsView = projectsSectionOpen ?? uncontrolledProjectsView;
  const openButtonRef = useRef<HTMLButtonElement>(null);
  const compositionRef = useRef<SidebarCompositionV2>("desktop");
  const focusBeforeCompactRef = useRef<HTMLElement | null>(null);
  const handledFocusRequestRef = useRef(0);
  const lastNavigationFocusRef = useRef<HTMLElement | null>(null);
  const previousCompositionRef = useRef<SidebarCompositionV2>("desktop");
  const previousDrawerOpenRef = useRef(false);
  const searchQuery = useWorkspaceStore((state) => state.navigationSearchQuery);
  const collapsed = composition === "compact" ? !compactExpanded : desktopCollapsed;
  const drawerOpen = mobileOpen || (composition === "compact" && compactExpanded);

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
    let cancelled = false;
    let focusFrame: number | null = null;
    let focusAttemptsRemaining = 8;
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
      (active === openButtonRef.current || active === document.body) &&
      focusBeforeCompactRef.current?.isConnected
    ) {
      const restoreTarget = focusBeforeCompactRef.current;
      const restore = () => {
        if (
          cancelled ||
          compositionRef.current !== "desktop" ||
          desktopCollapsed ||
          !restoreTarget.isConnected
        ) return;
        restoreTarget.focus();
        if (document.activeElement === restoreTarget) {
          focusBeforeCompactRef.current = null;
        } else if (focusAttemptsRemaining > 0) {
          focusAttemptsRemaining -= 1;
          focusFrame = window.requestAnimationFrame(restore);
        }
      };
      restore();
    } else if (
      composition === "desktop" &&
      focusBeforeCompactRef.current &&
      active !== document.body
    ) {
      // A user may have deliberately moved into the conversation while the
      // compact navigation was closed. Resizing must not steal that focus.
      focusBeforeCompactRef.current = null;
    }
    return () => {
      cancelled = true;
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
    };
  }, [composition, desktopCollapsed]);

  useLayoutEffect(() => {
    if (!focusRequest || focusRequest.id === handledFocusRequestRef.current) return;
    const sidebarPresented = composition === "mobile" ? mobileOpen : !collapsed;
    if (focusRequest.target === "open" && !sidebarPresented) {
      openButtonRef.current?.focus();
      handledFocusRequestRef.current = focusRequest.id;
    } else if (focusRequest.target === "sidebar" && sidebarPresented) {
      document.querySelector<HTMLElement>(
        ".v2-navigation .v2-navigation-close"
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

  useEffect(() => {
    if (!drawerOpen) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      setCompactExpanded(false);
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [drawerOpen]);

  useEffect(() => {
    if (!drawerOpen) return;
    const navigationElement = document.querySelector<HTMLElement>(".v2-navigation");
    if (!navigationElement) return;
    const focusRoots = composition === "compact"
      ? [document.querySelector<HTMLElement>(".v2-rail"), navigationElement]
          .filter((element): element is HTMLElement => Boolean(element))
      : [navigationElement];
    const focusableSelector = [
      "button:not([disabled])",
      "input:not([disabled])",
      "a[href]",
      "[tabindex]:not([tabindex='-1'])"
    ].join(",");
    const focusable = () => focusRoots.flatMap((root) =>
      [...root.querySelectorAll<HTMLElement>(focusableSelector)]
        .filter((element) => !element.hidden && element.getAttribute("aria-hidden") !== "true")
    );
    let cancelled = false;
    let focusFrame: number | null = null;
    let focusAttemptsRemaining = 8;
    // Chromium can clear focus after the opener becomes inert while the drawer
    // is still visibility:hidden for the current frame. Retry for a bounded
    // set of frames until the first drawer control accepts focus; cleanup stops
    // the retry as soon as the modal closes or changes composition.
    const focusInitialControl = () => {
      if (cancelled) return;
      const target = navigationElement.querySelector<HTMLElement>(".v2-navigation-close") ??
        navigationElement.querySelector<HTMLElement>(focusableSelector);
      target?.focus();
      if (target && document.activeElement !== target && focusAttemptsRemaining > 0) {
        focusAttemptsRemaining -= 1;
        focusFrame = window.requestAnimationFrame(focusInitialControl);
      }
    };
    focusInitialControl();
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
    return () => {
      cancelled = true;
      if (focusFrame !== null) window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("keydown", trapFocus);
    };
  }, [composition, drawerOpen]);

  useEffect(() => {
    const wasDrawerOpen = previousDrawerOpenRef.current;
    previousDrawerOpenRef.current = drawerOpen;
    if (wasDrawerOpen && !drawerOpen && (composition === "mobile" || collapsed)) {
      openButtonRef.current?.focus();
    }
  }, [collapsed, composition, drawerOpen]);

  const closeDrawers = () => {
    setMobileOpen(false);
    setCompactExpanded(false);
  };
  const closeSidebar = () => {
    setFocusRequest((current) => ({ id: (current?.id ?? 0) + 1, target: "open" }));
    if (composition === "desktop") setDesktopCollapsed(true);
    else closeDrawers();
  };
  const projectSlot = navigationOwnerProps.projectsSlot;
  const navigationProjectsSlot = typeof projectSlot === "function"
    ? (_onNavigate: () => void, options: Readonly<{ landing: boolean }>) => projectSlot(() => {
        setProjectsView(false);
        onProjectsSectionChange?.(false);
        if (composition !== "desktop") closeSidebar();
      }, options)
    : projectSlot;
  const createPersonalChat = (mode: NewChatMode) => {
    navigationOwnerProps.onLeaveProject?.();
    setProjectsView(false);
    onProjectsSectionChange?.(false);
    onNewChat(mode);
    closeDrawers();
  };
  const revealList = () => {
    setFocusRequest((current) => ({ id: (current?.id ?? 0) + 1, target: "sidebar" }));
    if (composition === "mobile") setMobileOpen(true);
    else if (composition === "compact") setCompactExpanded(true);
    else setDesktopCollapsed(false);
  };
  const sidebarShown = composition === "mobile"
    ? mobileOpen
    : composition === "compact" ? compactExpanded : !desktopCollapsed;
  const toggleSidebar = () => (sidebarShown ? closeSidebar() : revealList());
  // Keyboard shortcuts as in ChatGPT: Ctrl/⌘+Shift+O starts a chat,
  // Ctrl/⌘+Shift+S toggles the sidebar and Ctrl/⌘+K jumps to the chat filter
  // (revealing the list first). They are ignored while a modal layer owns
  // the keyboard (UX audit 2026-09-02 #16).
  const shortcutsRef = useRef({ createPersonalChat, revealList, toggleSidebar });
  useEffect(() => {
    shortcutsRef.current = { createPersonalChat, revealList, toggleSidebar };
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || event.altKey || event.defaultPrevented || event.isComposing) return;
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
      const key = event.key.toLowerCase();
      if (event.shiftKey && key === "o") {
        event.preventDefault();
        shortcutsRef.current.createPersonalChat("NORMAL");
      } else if (event.shiftKey && key === "s") {
        event.preventDefault();
        shortcutsRef.current.toggleSidebar();
      } else if (!event.shiftKey && key === "k") {
        event.preventDefault();
        shortcutsRef.current.revealList();
        window.setTimeout(() => {
          document.querySelector<HTMLInputElement>('input[aria-label="Filter chats"]')?.focus();
        }, 60);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  // Projects owns the whole second column. The reading surface is mirrored to
  // the parent shell while a selected Project remains the contextual section.
  const showChats = () => {
    navigationOwnerProps.onLeaveProject?.();
    setProjectsView(false);
    onProjectsSectionChange?.(false);
    if (section !== "chats") {
      closeDrawers();
      onChats?.();
      return;
    }
    if (collapsed) revealList();
  };
  const showProjects = () => {
    if (section !== "chats") onChats?.();
    setProjectsView(true);
    onProjectsSectionChange?.(true);
    if (collapsed) revealList();
  };
  const showLibrary = navigationOwnerProps.onLibrary
    ? () => {
        setProjectsView(false);
        onProjectsSectionChange?.(false);
        navigationOwnerProps.onLeaveProject?.();
        closeDrawers();
        navigationOwnerProps.onLibrary?.();
      }
    : undefined;
  const showSettings = navigationOwnerProps.onSettings
    ? () => {
        closeDrawers();
        navigationOwnerProps.onSettings?.();
      }
    : undefined;
  const navigation = typeof sidebar === "function" ? sidebar(closeSidebar) : sidebar ?? (
    <NavigationSidebarContainer
      {...navigationOwnerProps}
      drawerDestinations={composition === "mobile"}
      projectsSlot={navigationProjectsSlot}
      onClose={closeSidebar}
      onProjects={navigationOwnerProps.projectsSlot ? showProjects : undefined}
      onShowChats={showChats}
      onLibrary={showLibrary}
      onNewChat={(mode) => {
        createPersonalChat(mode);
      }}
      onSettings={showSettings}
      onSelectChat={(chat) => {
        setProjectsView(false);
        onProjectsSectionChange?.(false);
        navigationOwnerProps.onSelectChat(chat);
        // A drawer (mobile, compact) yields to the chosen chat.
        setMobileOpen(false);
        if (composition === "compact") setCompactExpanded(false);
      }}
      view={projectsView ? "projects" : "chats"}
    />
  );

  const resolvedSection: RailSectionV2 = section === "library"
    ? "library"
    : projectsView || navigationOwnerProps.projectContextActive ? "projects" : "chats";

  return (
    <div
      className="v2-workspace-shell"
      data-chat-active={chatActive || undefined}
      data-mobile-sidebar={mobileOpen || undefined}
      data-shell-section={resolvedSection}
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
      {composition !== "mobile" ? (
        <RailV2
          accountLabel={navigationOwnerProps.accountLabel}
          active={resolvedSection}
          adminEntryVisible={navigationOwnerProps.adminEntryVisible}
          onChats={showChats}
          onLibrary={showLibrary}
          onProjects={navigationOwnerProps.projectsSlot ? showProjects : undefined}
          onSettings={showSettings}
        />
      ) : null}
      <button
        className="v2-navigation-scrim"
        type="button"
        aria-label="Close navigation"
        aria-hidden={drawerOpen ? undefined : true}
        tabIndex={-1}
        onClick={closeSidebar}
      />
      {navigation}
      <div
        className="v2-sidebar-floats"
        aria-label="Navigation"
        inert={drawerOpen ? true : undefined}
      >
        <UiV2IconButton
          ref={openButtonRef}
          icon={composition === "mobile" ? "menu" : "panel"}
          label="Open sidebar"
          tooltip={composition === "mobile" ? "Open navigation" : "Show chat list"}
          tooltipSide="right"
          aria-expanded={composition === "mobile" ? mobileOpen : !collapsed}
          onClick={revealList}
        />
        {resolvedSection === "chats" ? (
          <UiV2IconButton
            icon="plus"
            label="New chat"
            tooltip={`New chat · ${shortcutHintV2("shift+o")}`}
            onClick={() => createPersonalChat("NORMAL")}
          />
        ) : null}
      </div>
      <div className="v2-workspace-content" inert={drawerOpen ? true : undefined}>{children}</div>
    </div>
  );
}
