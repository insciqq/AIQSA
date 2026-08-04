import { ComposerOptionPicker } from "@/components/app-shell/ComposerOptionPicker";
import { isImeCompositionEvent } from "@/components/keyboard";
import type { ChatGroup, ChatSummary, FolderSummary } from "@/components/app-shell/types";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  LoaderCircle,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Plus,
  Search,
  Settings,
  Share2,
  Star,
  Trash2,
  X
} from "lucide-react";
import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type Ref
} from "react";

type LeftChatPaneProps = {
  activeChatId: string | null;
  activeRunChatIds: ReadonlySet<string>;
  availableChatModelKeys: ReadonlySet<string> | null;
  chatModelLabels: ReadonlyMap<string, string> | null;
  chatActionId: string | null;
  chatContentMatchIds: ReadonlySet<string>;
  chatContentSearchError: string | null;
  chatContentSearchLoading: boolean;
  chatGroups: ChatGroup[];
  chatQuery: string;
  collapsedFolderIds: ReadonlySet<string>;
  creatingChat: boolean;
  creatingFolder: boolean;
  editingChatId: string | null;
  editingChatTitle: string;
  editingFolderId: string | null;
  editingFolderName: string;
  folderActionId: string | null;
  folderMenuId: string | null;
  folders: FolderSummary[];
  footer?: ReactNode;
  layout?: "desktop" | "mobile";
  newFolderName: string;
  onActivateChat(chat: ChatSummary): void;
  onCancelChatEdit(): void;
  onCancelFolderEdit(): void;
  onCancelSubfolder(): void;
  onChatActionToggle(chatId: string): void;
  onCloseMenus(): void;
  onChatQueryChange(value: string): void;
  onCreateChat(folderId?: string | null): void;
  onCreateFolder(parentId?: string | null, nameOverride?: string): Promise<void> | void;
  onDeleteChat(chat: ChatSummary): void;
  onDeleteFolder(folder: FolderSummary): void;
  onEditChatTitleChange(value: string): void;
  onEditFolderNameChange(value: string): void;
  onExportChat(chat: ChatSummary): void;
  onFolderMenuToggle(folderId: string): void;
  onHideWorkspace?(): void;
  onMoveChat(chatId: string, folderId: string | null): void;
  onMoveFolder(folder: FolderSummary, folderId: string | null): void;
  onNewFolderNameChange(value: string): void;
  onOpenProjectSettings(folder: FolderSummary): void;
  onRetryWorkspace(): void;
  onSaveChatTitle(chat: ChatSummary): void;
  onSaveFolder(folder: FolderSummary): void;
  onShareChat(chat: ChatSummary): void;
  onStartChatEdit(chat: ChatSummary): void;
  onStartFolderEdit(folder: FolderSummary): void;
  onStartSubfolder(folder: FolderSummary): void;
  onSubfolderNameChange(value: string): void;
  onToggleChatFavorite(chat: ChatSummary): void;
  onToggleFolderCollapsed(folderId: string): void;
  scrollTopRef?: { current: number | undefined };
  subfolderName: string;
  subfolderParentId: string | null;
  workspaceError: string | null;
  workspaceLoading: boolean;
  workspaceReady: boolean;
  workspaceToggleRef?: Ref<HTMLButtonElement>;
};

const focusRing =
  "outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-2 focus-visible:ring-offset-workspace-rail";

const menuSurface =
  "pop-enter relative z-20 my-1 max-h-[min(25rem,calc(100dvh-12rem))] overflow-y-auto overscroll-contain rounded-panel border border-trace-subtle bg-overlay-surface p-1.5 text-sm text-ink-secondary shadow-overlay";

function chatModelKey(chat: ChatSummary): string {
  return `${chat.defaultProvider}:${chat.defaultModelId}`;
}

function normalizedTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function formatChatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Unknown date";
  }

  return new Intl.DateTimeFormat("en", { day: "numeric", month: "short" }).format(date);
}

function folderPath(folder: FolderSummary, foldersById: ReadonlyMap<string, FolderSummary>): string {
  const names = [folder.name];
  const visited = new Set([folder.id]);
  let parentId = folder.parentId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = foldersById.get(parentId);
    if (!parent) {
      break;
    }
    names.unshift(parent.name);
    parentId = parent.parentId;
  }

  return names.join(" / ");
}

function folderDepth(folder: FolderSummary, foldersById: ReadonlyMap<string, FolderSummary>): number {
  const visited = new Set([folder.id]);
  let depth = 0;
  let parentId = folder.parentId;

  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const parent = foldersById.get(parentId);
    if (!parent) {
      break;
    }
    depth += 1;
    parentId = parent.parentId;
  }

  return Math.min(depth, 5);
}

function folderDestinationOption(
  folder: FolderSummary,
  foldersById: ReadonlyMap<string, FolderSummary>
) {
  const path = folderPath(folder, foldersById);

  return {
    description: path === folder.name ? undefined : path,
    indent: folderDepth(folder, foldersById),
    label: folder.name,
    value: folder.id
  };
}

function folderIsDescendant(
  candidate: FolderSummary,
  ancestorId: string,
  foldersById: ReadonlyMap<string, FolderSummary>
): boolean {
  const visited = new Set<string>();
  let parentId = candidate.parentId;

  while (parentId && !visited.has(parentId)) {
    if (parentId === ancestorId) {
      return true;
    }
    visited.add(parentId);
    parentId = foldersById.get(parentId)?.parentId ?? null;
  }

  return false;
}

function LeftChatPaneComponent({
  activeChatId,
  activeRunChatIds,
  availableChatModelKeys,
  chatModelLabels,
  chatActionId,
  chatContentMatchIds,
  chatContentSearchError,
  chatContentSearchLoading,
  chatGroups,
  chatQuery,
  collapsedFolderIds,
  creatingChat,
  creatingFolder,
  editingChatId,
  editingChatTitle,
  editingFolderId,
  editingFolderName,
  folderActionId,
  folderMenuId,
  folders,
  footer,
  layout = "desktop",
  newFolderName,
  onActivateChat,
  onCancelChatEdit,
  onCancelFolderEdit,
  onCancelSubfolder,
  onChatActionToggle,
  onChatQueryChange,
  onCloseMenus,
  onCreateChat,
  onCreateFolder,
  onDeleteChat,
  onDeleteFolder,
  onEditChatTitleChange,
  onEditFolderNameChange,
  onExportChat,
  onFolderMenuToggle,
  onHideWorkspace,
  onMoveChat,
  onMoveFolder,
  onNewFolderNameChange,
  onOpenProjectSettings,
  onRetryWorkspace,
  onSaveChatTitle,
  onSaveFolder,
  onShareChat,
  onStartChatEdit,
  onStartFolderEdit,
  onStartSubfolder,
  onSubfolderNameChange,
  onToggleChatFavorite,
  onToggleFolderCollapsed,
  scrollTopRef,
  subfolderName,
  subfolderParentId,
  workspaceError,
  workspaceLoading,
  workspaceReady,
  workspaceToggleRef
}: LeftChatPaneProps) {
  const idPrefix = layout === "mobile" ? "mobile-" : "";
  const touchTarget =
    layout === "mobile"
      ? "min-h-touch"
      : "min-h-10 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
  const toolbarTarget =
    layout === "mobile"
      ? "min-h-touch"
      : "h-control [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch";
  const toolbarIconTarget =
    layout === "mobile"
      ? "size-11"
      : "size-10 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11";
  const searchClearTarget =
    layout === "mobile"
      ? "size-11"
      : "size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11";
  const inlineControlTarget =
    layout === "mobile"
      ? "min-h-touch"
      : "h-9 [@media(hover:none)]:!h-touch [@media(pointer:coarse)]:!h-touch";
  const inlineIconTarget =
    layout === "mobile"
      ? "size-11"
      : "size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11";
  const menuActionTarget =
    layout === "mobile"
      ? "min-h-touch"
      : "min-h-10 [@media(hover:none)]:!min-h-touch [@media(pointer:coarse)]:!min-h-touch";
  const chatOverflowTarget =
    layout === "mobile"
      ? "min-h-touch w-11"
      : "w-9 [@media(hover:none)]:!w-11 [@media(pointer:coarse)]:!w-11";
  const query = chatQuery.trim().toLocaleLowerCase();
  const queryActive = Boolean(query);
  const [folderComposerOpen, setFolderComposerOpen] = useState(false);
  const activeRowRefs = useRef(new Map<string, HTMLDivElement>());
  const folderComposerTriggerRef = useRef<HTMLButtonElement>(null);
  const lastMenuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const menuSurfaceRefs = useRef(new Map<string, HTMLDivElement>());
  const navigationRef = useRef<HTMLElement>(null);
  const newChatTriggerRef = useRef<HTMLButtonElement>(null);
  const previousMenuKeyRef = useRef<string | null>(null);
  const skipInitialActiveScrollRef = useRef(false);
  const subfolderInputRef = useRef<HTMLInputElement>(null);
  const subfolderTriggerRef = useRef<HTMLButtonElement>(null);

  function cancelSubfolder() {
    onCancelSubfolder();
    window.setTimeout(() => subfolderTriggerRef.current?.focus({ preventScroll: true }), 0);
  }

  async function submitSubfolder(folderId: string) {
    await onCreateFolder(folderId, subfolderName);
    window.setTimeout(() => {
      if (!subfolderInputRef.current?.isConnected) {
        (subfolderTriggerRef.current ?? lastMenuTriggerRef.current)?.focus({ preventScroll: true });
      }
    }, 0);
  }

  const foldersById = useMemo(() => new Map(folders.map((folder) => [folder.id, folder])), [folders]);
  const folderGroupsById = useMemo(
    () =>
      new Map(
        chatGroups
          .filter((group): group is ChatGroup & { folder: FolderSummary } => Boolean(group.folder))
          .map((group) => [group.folder.id, group])
      ),
    [chatGroups]
  );
  const childrenByFolderId = useMemo(() => {
    const children = new Map<string, FolderSummary[]>();
    for (const folder of folders) {
      if (!folder.parentId) {
        continue;
      }
      children.set(folder.parentId, [...(children.get(folder.parentId) ?? []), folder]);
    }
    return children;
  }, [folders]);
  const descendantChatCounts = useMemo(() => {
    const counts = new Map<string, number>();

    function count(folderId: string, visiting: Set<string>): number {
      if (counts.has(folderId)) {
        return counts.get(folderId) ?? 0;
      }
      if (visiting.has(folderId)) {
        return 0;
      }

      const nextVisiting = new Set(visiting).add(folderId);
      const directCount = folderGroupsById.get(folderId)?.chats.length ?? 0;
      const childCount = (childrenByFolderId.get(folderId) ?? []).reduce(
        (total, child) => total + count(child.id, nextVisiting),
        0
      );
      const total = directCount + childCount;
      counts.set(folderId, total);
      return total;
    }

    for (const folder of folders) {
      count(folder.id, new Set());
    }
    return counts;
  }, [childrenByFolderId, folderGroupsById, folders]);
  const activeFolderTrail = useMemo(() => {
    const activeGroup = chatGroups.find((group) => group.chats.some((chat) => chat.id === activeChatId));
    const trail = new Set<string>();
    let folderId = activeGroup?.folder?.id ?? null;

    while (folderId && !trail.has(folderId)) {
      trail.add(folderId);
      folderId = foldersById.get(folderId)?.parentId ?? null;
    }

    return trail;
  }, [activeChatId, chatGroups, foldersById]);
  const visibleGroups = useMemo(
    () =>
      chatGroups.filter((group) => {
        if (queryActive || !group.folder) {
          return true;
        }

        const visited = new Set<string>();
        let parentId = group.folder.parentId;
        while (parentId && !visited.has(parentId)) {
          if (collapsedFolderIds.has(parentId)) {
            return false;
          }
          visited.add(parentId);
          parentId = foldersById.get(parentId)?.parentId ?? null;
        }
        return true;
      }),
    [chatGroups, collapsedFolderIds, foldersById, queryActive]
  );
  const duplicateTitleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const group of chatGroups) {
      for (const chat of group.chats) {
        const title = normalizedTitle(chat.title);
        counts.set(title, (counts.get(title) ?? 0) + 1);
      }
    }
    return counts;
  }, [chatGroups]);
  const resultCount = useMemo(
    () => chatGroups.reduce((total, group) => total + group.chats.length, 0),
    [chatGroups]
  );
  const contentResultCount = useMemo(
    () =>
      chatGroups.reduce(
        (total, group) => total + group.chats.filter((chat) => chatContentMatchIds.has(chat.id)).length,
        0
      ),
    [chatContentMatchIds, chatGroups]
  );

  useLayoutEffect(() => {
    const initialScrollTop = scrollTopRef?.current;
    if (initialScrollTop !== undefined && navigationRef.current) {
      navigationRef.current.scrollTop = initialScrollTop;
      skipInitialActiveScrollRef.current = true;
    }
  }, [scrollTopRef]);

  useEffect(() => {
    if (!chatActionId && !folderMenuId) {
      return;
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("[data-left-pane-menu], [data-left-pane-menu-trigger]")) {
        return;
      }
      onCloseMenus();
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (isImeCompositionEvent(event)) {
        return;
      }

      if (event.key === "Escape") {
        event.preventDefault();
        onCloseMenus();
        lastMenuTriggerRef.current?.focus({ preventScroll: true });
      }
    }

    window.addEventListener("pointerdown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [chatActionId, folderMenuId, onCloseMenus]);

  useEffect(() => {
    const menuKey = chatActionId ? `chat:${chatActionId}` : folderMenuId ? `folder:${folderMenuId}` : null;
    const previousMenuKey = previousMenuKeyRef.current;
    previousMenuKeyRef.current = menuKey;
    if (previousMenuKey && !menuKey) {
      window.setTimeout(() => {
        const activeElement = document.activeElement;
        const focusTarget = lastMenuTriggerRef.current?.isConnected
          ? lastMenuTriggerRef.current
          : newChatTriggerRef.current;
        if (
          focusTarget?.isConnected &&
          (!(activeElement instanceof HTMLElement) ||
            activeElement === document.body ||
            !activeElement.isConnected)
        ) {
          focusTarget.focus({ preventScroll: true });
        }
      }, 0);
    }
    const surface = menuKey ? menuSurfaceRefs.current.get(menuKey) : null;
    if (surface && typeof surface.scrollIntoView === "function") {
      surface.scrollIntoView({ block: "nearest" });
    }
    const firstControl = surface?.querySelector<HTMLElement>("[data-menu-initial-focus]");
    firstControl?.focus({ preventScroll: true });
  }, [chatActionId, folderMenuId]);

  useEffect(() => {
    if (skipInitialActiveScrollRef.current) {
      skipInitialActiveScrollRef.current = false;
      return;
    }
    if (!activeChatId || queryActive) {
      return;
    }

    const row = activeRowRefs.current.get(activeChatId);
    if (row && typeof row.scrollIntoView === "function") {
      row.scrollIntoView({ block: "nearest" });
    }
  }, [activeChatId, chatGroups, collapsedFolderIds, queryActive]);

  return (
    <aside
      className={
        layout === "mobile"
          ? "flex h-full min-h-0 min-w-0 w-full flex-col overflow-hidden bg-workspace-rail text-ink"
          : "hidden h-full min-h-0 min-w-0 w-full overflow-hidden border-r border-trace-subtle bg-workspace-rail text-ink min-[1281px]:flex min-[1281px]:flex-col"
      }
      data-testid={layout === "mobile" ? "left-chat-pane-mobile" : "left-chat-pane"}
    >
      {layout === "desktop" ? (
        <div className="flex h-16 shrink-0 items-center justify-between gap-3 px-3" data-testid="workspace-identity">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold tracking-[-0.01em] text-ink">AIQSA</p>
            <p className="truncate text-xs text-ink-muted">Workspace</p>
          </div>
          {onHideWorkspace ? (
            <button
              ref={workspaceToggleRef}
              className={`grid size-9 shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11 ${focusRing}`}
              type="button"
              aria-label="Hide workspace"
              title="Hide workspace"
              onClick={onHideWorkspace}
            >
              <PanelLeftClose className="size-4" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="shrink-0 px-3 pb-3">
        <div className="flex items-center gap-1">
          <button
            ref={newChatTriggerRef}
            className={`group flex ${toolbarTarget} min-w-0 flex-1 items-center gap-2 rounded-control px-2 text-left text-sm font-medium text-ink hover:bg-control-hover disabled:cursor-not-allowed disabled:text-ink-disabled ${focusRing}`}
            type="button"
            aria-label="Start new chat"
            disabled={creatingChat || !workspaceReady}
            onClick={() => onCreateChat()}
          >
            <span className="grid size-7 shrink-0 place-items-center rounded-control border border-trace-strong/70 bg-answer-paper text-proof group-hover:border-proof/45">
              {creatingChat ? (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              ) : (
                <Plus className="size-3.5" aria-hidden="true" />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate">New chat</span>
          </button>
          <button
            ref={folderComposerTriggerRef}
            className={`grid ${toolbarIconTarget} shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink disabled:cursor-not-allowed disabled:text-ink-disabled ${focusRing} ${
              folderComposerOpen ? "bg-control-pressed text-proof" : ""
            }`}
            type="button"
            aria-label="New folder"
            aria-expanded={folderComposerOpen}
            disabled={!workspaceReady}
            title="New folder"
            onClick={() => setFolderComposerOpen((open) => !open)}
          >
            <FolderPlus className="size-4" aria-hidden="true" />
          </button>
        </div>
        {folderComposerOpen ? (
          <div
            className="mt-1 flex items-center gap-1 rounded-control bg-control-selected p-1"
            data-testid="new-folder-form"
          >
            <label className="sr-only" htmlFor={`${idPrefix}new-folder-name`}>
              Folder name
            </label>
            <input
              autoFocus
              className={`${toolbarTarget} min-w-0 flex-1 rounded-control border border-control-boundary bg-answer-paper px-3 text-sm text-ink placeholder:text-ink-muted disabled:cursor-not-allowed disabled:border-trace-subtle disabled:text-ink-disabled ${focusRing}`}
              id={`${idPrefix}new-folder-name`}
              placeholder="Folder name"
              value={newFolderName}
              disabled={!workspaceReady}
              onChange={(event) => onNewFolderNameChange(event.target.value)}
              onKeyDown={(event) => {
                if (isImeCompositionEvent(event)) {
                  event.stopPropagation();
                  return;
                }

                if (event.key === "Enter" && newFolderName.trim() && !creatingFolder) {
                  event.preventDefault();
                  onCreateFolder();
                  setFolderComposerOpen(false);
                }
                if (event.key === "Escape") {
                  event.preventDefault();
                  onNewFolderNameChange("");
                  setFolderComposerOpen(false);
                  folderComposerTriggerRef.current?.focus({ preventScroll: true });
                }
              }}
            />
            <button
              className={`grid ${toolbarIconTarget} place-items-center rounded-control text-ink-secondary hover:bg-control-hover hover:text-proof disabled:cursor-not-allowed disabled:text-ink-disabled ${focusRing}`}
              type="button"
              aria-label="Create folder"
              title="Create folder"
              disabled={!workspaceReady || creatingFolder || !newFolderName.trim()}
              onClick={() => {
                onCreateFolder();
                setFolderComposerOpen(false);
              }}
            >
              {creatingFolder ? (
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
              ) : (
                <Check className="size-4" aria-hidden="true" />
              )}
            </button>
          </div>
        ) : null}
        <div
          className={`mt-2 flex ${toolbarTarget} items-center gap-2 rounded-control bg-control-surface px-3 ring-1 focus-within:bg-answer-paper focus-within:ring-2 focus-within:ring-focus ${workspaceReady ? "ring-control-boundary" : "ring-trace-subtle opacity-60"}`}
          data-testid="chat-search-control"
        >
          <Search className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
          <label className="sr-only" htmlFor={`${idPrefix}chat-search`}>
            Search chats
          </label>
          <input
            className={`${toolbarTarget} min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-ink-muted disabled:cursor-not-allowed disabled:text-ink-disabled`}
            id={`${idPrefix}chat-search`}
            aria-label="Search chats"
            aria-describedby={queryActive ? `${idPrefix}chat-search-status` : undefined}
            placeholder="Search chats"
            value={chatQuery}
            disabled={!workspaceReady}
            onChange={(event) => onChatQueryChange(event.target.value)}
            onKeyDown={(event) => {
              if (isImeCompositionEvent(event)) {
                event.stopPropagation();
                return;
              }

              if (event.key === "Escape" && chatQuery) {
                event.preventDefault();
                event.stopPropagation();
                onChatQueryChange("");
              }
            }}
          />
          {chatQuery ? (
            <button
              className={`-mr-2 grid ${searchClearTarget} shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
              type="button"
              aria-label="Clear chat search"
              title="Clear search"
              onClick={() => onChatQueryChange("")}
            >
              <X className="size-3.5" aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </div>

      <nav
        ref={navigationRef}
        className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto px-2 pb-3"
        aria-label="Workspace chats and folders"
        onScroll={(event) => {
          if (scrollTopRef) {
            scrollTopRef.current = event.currentTarget.scrollTop;
          }
        }}
      >
        <div className="flex min-h-8 items-center justify-between gap-3 px-2 pb-1">
          <span className="text-xs font-medium text-ink-muted">
            {queryActive ? "Search results" : "History"}
          </span>
          {!queryActive && workspaceReady ? (
            <span className="text-xs tabular-nums text-ink-muted">
              {resultCount} {resultCount === 1 ? "chat" : "chats"}
            </span>
          ) : null}
        </div>
        {workspaceLoading && !workspaceReady ? (
          <div className="space-y-2 px-2 py-2" data-testid="workspace-loading-state">
            <div className="flex items-center gap-2 text-xs text-ink-muted">
              <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" />
              Loading workspace…
            </div>
            <div className="space-y-2" aria-hidden="true">
              <div className="skeleton-block h-9 w-full" />
              <div className="skeleton-block h-9 w-5/6" />
              <div className="skeleton-block h-9 w-[92%]" />
            </div>
          </div>
        ) : null}
        {workspaceError && !workspaceReady ? (
          <div
            className="mx-2 border-l-2 border-critical px-3 py-1.5 text-xs leading-5 text-critical"
            data-testid="left-workspace-unavailable"
          >
            <p>Chats unavailable.</p>
            <button
              className={`mt-2 inline-flex min-h-control-sm items-center rounded-control border border-critical/25 px-2.5 font-medium hover:bg-critical/10 min-[1281px]:hidden ${focusRing}`}
              onClick={onRetryWorkspace}
              type="button"
            >
              Retry workspace
            </button>
          </div>
        ) : null}
        {queryActive ? (
          <div
            className={`px-2 pb-2 text-xs ${chatContentSearchError ? "text-caution" : "text-ink-muted"}`}
            id={`${idPrefix}chat-search-status`}
            data-testid="chat-search-status"
            role="status"
            aria-live="polite"
            title={chatContentSearchError ?? undefined}
          >
            {chatContentSearchLoading
              ? "Searching message content…"
              : chatContentSearchError
                ? "Message search unavailable. Showing title and model matches."
                : `${resultCount} ${resultCount === 1 ? "chat" : "chats"} found${
                    contentResultCount > 0 ? ` · ${contentResultCount} message ${contentResultCount === 1 ? "match" : "matches"}` : ""
                  }`}
          </div>
        ) : null}

        {visibleGroups.map((group) => {
          const folderKey = group.folder?.id ?? "unfiled";
          const collapsed = Boolean(group.folder && !queryActive && collapsedFolderIds.has(folderKey));
          const editingThisFolder = Boolean(group.folder && editingFolderId === group.folder.id);
          const folderChatCount = group.folder ? descendantChatCounts.get(group.folder.id) ?? group.chats.length : 0;
          const containsActiveChat = Boolean(group.folder && activeFolderTrail.has(group.folder.id));
          const folderIndent = group.folder ? Math.min(group.depth, 5) * 10 : 0;
          const chatIndent = group.folder ? folderIndent + 14 : 0;
          const menuId = group.folder ? `${idPrefix}folder-menu-${group.folder.id}` : undefined;

          return (
            <section className="relative space-y-0.5" key={folderKey}>
              {group.folder ? (
                editingThisFolder ? (
                  <div
                    className="flex min-w-0 items-center gap-1 rounded-control bg-control-selected p-1"
                    style={{ marginLeft: folderIndent }}
                    data-testid="folder-rename-form"
                  >
                    <label className="sr-only" htmlFor={`${idPrefix}rename-folder-${group.folder.id}`}>
                      Rename folder {group.name}
                    </label>
                    <input
                      autoFocus
                      className={`${inlineControlTarget} min-w-0 flex-1 rounded-control border border-control-boundary bg-answer-paper px-2 text-sm text-ink ${focusRing}`}
                      id={`${idPrefix}rename-folder-${group.folder.id}`}
                      aria-label={`Rename folder ${group.name}`}
                      value={editingFolderName}
                      onChange={(event) => onEditFolderNameChange(event.target.value)}
                      onKeyDown={(event) => {
                        if (isImeCompositionEvent(event)) {
                          event.stopPropagation();
                          return;
                        }

                        if (event.key === "Enter" && editingFolderName.trim()) {
                          event.preventDefault();
                          onSaveFolder(group.folder!);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          onCancelFolderEdit();
                        }
                      }}
                    />
                    <button
                      className={`grid ${inlineIconTarget} place-items-center rounded-control text-ink-secondary hover:bg-control-hover hover:text-proof disabled:text-ink-disabled ${focusRing}`}
                      type="button"
                      aria-label={`Save folder ${group.name}`}
                      title={`Save folder ${group.name}`}
                      disabled={folderActionId === group.folder.id || !editingFolderName.trim()}
                      onClick={() => onSaveFolder(group.folder!)}
                    >
                      <Check className="size-3.5" aria-hidden="true" />
                    </button>
                    <button
                      className={`grid ${inlineIconTarget} place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
                      type="button"
                      aria-label={`Cancel renaming folder ${group.name}`}
                      onClick={onCancelFolderEdit}
                    >
                      <X className="size-3.5" aria-hidden="true" />
                    </button>
                  </div>
                ) : (
                  <div
                    className={`group/folder relative flex min-w-0 items-center rounded-control hover:bg-control-hover focus-within:bg-control-hover ${
                      containsActiveChat ? "text-ink" : "text-ink-secondary"
                    }`}
                    style={{ marginLeft: folderIndent }}
                    data-testid="folder-row"
                    data-active-descendant={containsActiveChat || undefined}
                  >
                    <button
                      className={`flex ${touchTarget} min-w-0 flex-1 items-center gap-1.5 rounded-control px-1.5 text-left hover:text-ink ${focusRing}`}
                      type="button"
                      aria-expanded={!collapsed}
                      aria-label={`${collapsed ? "Expand" : "Collapse"} folder ${group.name}, ${folderChatCount} ${folderChatCount === 1 ? "chat" : "chats"}${group.folder.projectMemory.trim() ? ", project memory configured" : ""}${containsActiveChat ? ", contains active chat" : ""}`}
                      title={folderPath(group.folder, foldersById)}
                      onClick={() => onToggleFolderCollapsed(folderKey)}
                    >
                      {collapsed ? (
                        <ChevronRight className="size-3.5 shrink-0" aria-hidden="true" />
                      ) : (
                        <ChevronDown className="size-3.5 shrink-0" aria-hidden="true" />
                      )}
                      <Folder
                        className={`size-3.5 shrink-0 ${containsActiveChat ? "text-proof" : "text-ink-muted"}`}
                        aria-hidden="true"
                      />
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium" title={group.name}>
                        {group.name}
                      </span>
                      {group.folder.projectMemory.trim() ? (
                        <span className="size-1.5 shrink-0 rounded-pill bg-positive" title="Project memory configured" />
                      ) : null}
                      <span className="shrink-0 text-xs tabular-nums text-ink-muted" aria-hidden="true">
                        {folderChatCount}
                      </span>
                    </button>
                    <button
                      ref={(element) => {
                        if (folderMenuId === group.folder!.id && element) {
                          lastMenuTriggerRef.current = element;
                        }
                      }}
                      className={`grid ${layout === "mobile" ? "size-11" : "size-9 [@media(hover:none)]:!size-11 [@media(pointer:coarse)]:!size-11"} shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-pressed hover:text-ink ${focusRing}`}
                      type="button"
                      aria-label={`Folder actions ${group.name}`}
                      aria-expanded={folderMenuId === group.folder.id}
                      aria-controls={menuId}
                      title={`Folder actions for ${group.name}`}
                      data-left-pane-menu-trigger="true"
                      onClick={(event) => {
                        lastMenuTriggerRef.current = event.currentTarget;
                        onFolderMenuToggle(group.folder!.id);
                      }}
                    >
                      <MoreHorizontal className="size-4" aria-hidden="true" />
                    </button>
                  </div>
                )
              ) : null}

              {group.folder && folderMenuId === group.folder.id ? (
                <div
                  ref={(element) => {
                    const key = `folder:${group.folder!.id}`;
                    if (element) {
                      menuSurfaceRefs.current.set(key, element);
                    } else {
                      menuSurfaceRefs.current.delete(key);
                    }
                  }}
                  className={menuSurface}
                  id={menuId}
                  role="dialog"
                  aria-label={`Folder actions for ${group.name}`}
                  aria-modal="false"
                  data-left-pane-menu="true"
                >
                  <div className="mb-1 border-b border-trace-subtle px-2 pb-2 pt-1">
                    <div className="truncate text-sm font-medium text-ink" title={group.name}>
                      {group.name}
                    </div>
                    <div className="mt-0.5 text-xs text-ink-muted">
                      {group.folder.projectMemory.trim() ? "Project memory configured" : "No project memory"}
                    </div>
                  </div>
                  <button
                    className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`}
                    type="button"
                    data-menu-initial-focus="true"
                    onClick={() => {
                      onCloseMenus();
                      onCreateChat(group.folder?.id ?? null);
                    }}
                  >
                    <Plus className="size-4 text-ink-muted" aria-hidden="true" />
                    New chat
                  </button>
                  <button
                    ref={subfolderTriggerRef}
                    className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`}
                    type="button"
                    onClick={() => onStartSubfolder(group.folder!)}
                  >
                    <FolderPlus className="size-4 text-ink-muted" aria-hidden="true" />
                    New subfolder
                  </button>
                  {subfolderParentId === group.folder.id ? (
                    <div className="my-1 flex items-center gap-1 rounded-control bg-control-selected p-1">
                      <label className="sr-only" htmlFor={`${idPrefix}subfolder-name-${group.folder.id}`}>
                        Subfolder name
                      </label>
                      <input
                        autoFocus
                        ref={subfolderInputRef}
                        className={`${inlineControlTarget} min-w-0 flex-1 rounded-control border border-control-boundary bg-answer-paper px-2 text-sm text-ink ${focusRing}`}
                        id={`${idPrefix}subfolder-name-${group.folder.id}`}
                        aria-label={`Subfolder name for ${group.name}`}
                        placeholder="Subfolder name"
                        value={subfolderName}
                        onChange={(event) => onSubfolderNameChange(event.target.value)}
                        onKeyDown={(event) => {
                          if (isImeCompositionEvent(event)) {
                            event.stopPropagation();
                            return;
                          }

                          if (event.key === "Enter" && subfolderName.trim() && !creatingFolder) {
                            event.preventDefault();
                            void submitSubfolder(group.folder!.id);
                          } else if (event.key === "Escape") {
                            event.preventDefault();
                            event.stopPropagation();
                            cancelSubfolder();
                          }
                        }}
                      />
                      <button
                        className={`grid ${inlineIconTarget} place-items-center rounded-control text-ink-secondary hover:bg-control-hover hover:text-proof disabled:text-ink-disabled ${focusRing}`}
                        type="button"
                        aria-label={`Create subfolder in ${group.name}`}
                        disabled={!subfolderName.trim() || creatingFolder}
                        onClick={() => void submitSubfolder(group.folder!.id)}
                      >
                        <Check className="size-3.5" aria-hidden="true" />
                      </button>
                      <button
                        className={`grid ${inlineIconTarget} place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
                        type="button"
                        aria-label={`Cancel subfolder in ${group.name}`}
                        onClick={cancelSubfolder}
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </div>
                  ) : null}
                  <button
                    className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`}
                    type="button"
                    onClick={() => onOpenProjectSettings(group.folder!)}
                  >
                    <Settings className="size-4 text-ink-muted" aria-hidden="true" />
                    Project settings
                  </button>
                  <button
                    className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`}
                    type="button"
                    onClick={() => onStartFolderEdit(group.folder!)}
                  >
                    <Pencil className="size-4 text-ink-muted" aria-hidden="true" />
                    Rename
                  </button>
                  <div className="mt-1 space-y-1 px-2 py-1 text-xs text-ink-muted">
                    <span className="block">Move to folder</span>
                    <ComposerOptionPicker
                      className="w-full"
                      disabled={folderActionId === group.folder.id}
                      embeddedInMenu
                      id={`${idPrefix}move-folder-${group.folder.id}`}
                      label={`Move folder ${group.name} to folder`}
                      onChange={(value) => {
                        if (value !== (group.folder!.parentId ?? "")) {
                          onMoveFolder(group.folder!, value || null);
                        }
                      }}
                      options={[
                        {
                          description: "Place this folder at the workspace root.",
                          label: "Top level",
                          value: ""
                        },
                        ...folders
                          .filter(
                            (folder) =>
                              folder.id !== group.folder!.id &&
                              !folderIsDescendant(folder, group.folder!.id, foldersById)
                          )
                          .map((folder) => folderDestinationOption(folder, foldersById))
                      ]}
                      pickerDescription="Choose a destination. The move applies immediately."
                      pickerTitle="Move to folder"
                      placement="below"
                      summaryLabel={
                        group.folder.parentId
                          ? folderPath(foldersById.get(group.folder.parentId)!, foldersById)
                          : "Top level"
                      }
                      value={group.folder.parentId ?? ""}
                    />
                  </div>
                  <div className="mt-1 border-t border-trace-subtle pt-1">
                    <button
                      className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-critical hover:bg-critical/10 disabled:cursor-not-allowed disabled:text-ink-disabled ${focusRing}`}
                      type="button"
                      disabled={folderActionId === group.folder.id}
                      onClick={() => onDeleteFolder(group.folder!)}
                    >
                      <Trash2 className="size-4" aria-hidden="true" />
                      Delete folder
                    </button>
                  </div>
                </div>
              ) : null}

              {collapsed ? null : (
                <div className="space-y-0.5" style={{ paddingLeft: chatIndent }}>
                  {group.chats.map((chat) => {
                    const editingThisChat = editingChatId === chat.id;
                    const active = activeChatId === chat.id;
                    const running = activeRunChatIds.has(chat.id);
                    const favorite = Boolean(chat.pinned);
                    const contentMatched = chatContentMatchIds.has(chat.id);
                    const titleMatched = queryActive && normalizedTitle(chat.title).includes(query);
                    const modelKey = chatModelKey(chat);
                    const modelMetadata = [
                      chat.defaultProvider,
                      chat.defaultModelId,
                      chatModelLabels?.get(modelKey) ?? ""
                    ].join(" ").toLocaleLowerCase();
                    const modelMatched = queryActive && !titleMatched && modelMetadata.includes(query);
                    const matchLabel = titleMatched
                      ? "Title match"
                      : modelMatched
                        ? "Model match"
                        : contentMatched
                          ? "Message match"
                          : null;
                    const duplicate = (duplicateTitleCounts.get(normalizedTitle(chat.title)) ?? 0) > 1;
                    const unavailable =
                      availableChatModelKeys !== null && !availableChatModelKeys.has(modelKey);
                    const showMetadata = duplicate || modelMatched || unavailable;
                    const providerModel = chatModelLabels?.get(modelKey) ?? "Unavailable model";
                    const updated = formatChatDate(chat.updatedAt);
                    const activationLabel = duplicate
                      ? `${chat.title}, ${providerModel}, updated ${updated}`
                      : chat.title;
                    const chatMenuId = `${idPrefix}chat-menu-${chat.id}`;
                    const rowStatusId = `${idPrefix}chat-status-${chat.id}`;
                    const rowStatus = [
                      favorite ? "Favorite" : null,
                      running ? "Response running" : null,
                      unavailable ? "Model unavailable for new runs" : null,
                      matchLabel
                    ]
                      .filter((status): status is string => Boolean(status))
                      .join(". ");

                    return (
                      <div
                        ref={(element) => {
                          if (element) {
                            activeRowRefs.current.set(chat.id, element);
                          } else {
                            activeRowRefs.current.delete(chat.id);
                          }
                        }}
                        className="relative"
                        key={chat.id}
                        data-chat-id={chat.id}
                      >
                        {editingThisChat ? (
                          <div
                            className="flex items-center gap-1 rounded-control bg-control-selected p-1"
                            data-testid="chat-rename-form"
                          >
                            <label className="sr-only" htmlFor={`${idPrefix}rename-chat-${chat.id}`}>
                              Edit title {chat.title}
                            </label>
                            <input
                              autoFocus
                              className={`${inlineControlTarget} min-w-0 flex-1 rounded-control border border-control-boundary bg-answer-paper px-2 text-sm text-ink ${focusRing}`}
                              id={`${idPrefix}rename-chat-${chat.id}`}
                              aria-label={`Edit title ${chat.title}`}
                              value={editingChatTitle}
                              onChange={(event) => onEditChatTitleChange(event.target.value)}
                              onKeyDown={(event) => {
                                if (isImeCompositionEvent(event)) {
                                  event.stopPropagation();
                                  return;
                                }

                                if (event.key === "Enter" && editingChatTitle.trim()) {
                                  event.preventDefault();
                                  onSaveChatTitle(chat);
                                }
                                if (event.key === "Escape") {
                                  event.preventDefault();
                                  onCancelChatEdit();
                                }
                              }}
                            />
                            <button
                              className={`grid ${inlineIconTarget} place-items-center rounded-control text-ink-secondary hover:bg-control-hover hover:text-proof disabled:text-ink-disabled ${focusRing}`}
                              type="button"
                              aria-label={`Save title ${chat.title}`}
                              disabled={!editingChatTitle.trim()}
                              onClick={() => onSaveChatTitle(chat)}
                            >
                              <Check className="size-3.5" aria-hidden="true" />
                            </button>
                            <button
                              className={`grid ${inlineIconTarget} place-items-center rounded-control text-ink-muted hover:bg-control-hover hover:text-ink ${focusRing}`}
                              type="button"
                              aria-label={`Cancel renaming ${chat.title}`}
                              onClick={onCancelChatEdit}
                            >
                              <X className="size-3.5" aria-hidden="true" />
                            </button>
                          </div>
                        ) : (
                          <div
                            className={`group/chat relative flex min-w-0 items-stretch rounded-control ${
                              active
                                ? "bg-control-selected text-ink"
                                : "text-ink-secondary hover:bg-control-hover hover:text-ink focus-within:bg-control-hover"
                            }`}
                            data-testid="chat-row"
                            data-active={active || undefined}
                            data-favorite={favorite || undefined}
                            data-unavailable={unavailable || undefined}
                          >
                            {active ? (
                              <span
                                className="absolute bottom-2 left-0 top-2 w-0.5 rounded-pill bg-proof"
                                data-testid="active-chat-marker"
                              />
                            ) : null}
                            <button
                              className={`flex ${touchTarget} min-w-0 flex-1 flex-col justify-center rounded-control px-2 py-1 text-left ${focusRing}`}
                              type="button"
                              aria-current={active ? "page" : undefined}
                              aria-describedby={rowStatus ? rowStatusId : undefined}
                              aria-label={activationLabel}
                              title={chat.title}
                              onClick={() => onActivateChat(chat)}
                            >
                              <span className="flex min-w-0 items-center gap-1.5">
                                {running ? (
                                  <LoaderCircle
                                    className="size-3 shrink-0 animate-spin text-proof"
                                    aria-hidden="true"
                                  />
                                ) : null}
                                <span className="min-w-0 flex-1 truncate text-[13px] leading-5 text-ink">
                                  {chat.title}
                                </span>
                                {favorite ? (
                                  <span title="Favorite">
                                    <Star className="size-3 shrink-0 fill-current text-proof" aria-hidden="true" />
                                  </span>
                                ) : null}
                              </span>
                              {showMetadata || matchLabel ? (
                                <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-ink-muted">
                                  {showMetadata ? (
                                    <span className="min-w-0 truncate" title={`${providerModel} · Updated ${updated}`}>
                                      {providerModel}
                                      {duplicate ? ` · ${updated}` : ""}
                                    </span>
                                  ) : null}
                                  {unavailable && providerModel !== "Unavailable model" ? (
                                    <span
                                      className={`shrink-0 ${active ? "text-ink-secondary" : "text-caution"}`}
                                      title="Unavailable for new runs"
                                      aria-hidden="true"
                                    >
                                      Unavailable
                                    </span>
                                  ) : null}
                                  {matchLabel ? (
                                    <span className="shrink-0 text-proof" aria-hidden="true">
                                      {matchLabel}
                                    </span>
                                  ) : null}
                                </span>
                              ) : null}
                            </button>
                            {rowStatus ? (
                              <span className="sr-only" id={rowStatusId} role={running ? "status" : undefined}>
                                {rowStatus}
                              </span>
                            ) : null}
                            <div
                              className={`flex shrink-0 items-stretch transition-opacity duration-100 ${
                                chatActionId === chat.id
                                  ? "opacity-100"
                                  : "opacity-100 min-[1281px]:opacity-0 min-[1281px]:group-hover/chat:opacity-100 min-[1281px]:group-focus-within/chat:opacity-100 [@media(hover:none)]:opacity-100 [@media(pointer:coarse)]:opacity-100"
                              }`}
                              data-testid="chat-row-actions"
                            >
                              <button
                                ref={(element) => {
                                  if (chatActionId === chat.id && element) {
                                    lastMenuTriggerRef.current = element;
                                  }
                                }}
                                className={`grid ${chatOverflowTarget} shrink-0 place-items-center rounded-control text-ink-muted hover:bg-control-pressed hover:text-ink ${focusRing}`}
                                type="button"
                                aria-label={`Chat actions ${chat.title}`}
                                aria-expanded={chatActionId === chat.id}
                                aria-controls={chatMenuId}
                                title={`Actions for ${chat.title}`}
                                data-left-pane-menu-trigger="true"
                                onClick={(event) => {
                                  lastMenuTriggerRef.current = event.currentTarget;
                                  onChatActionToggle(chat.id);
                                }}
                              >
                                <MoreHorizontal className="size-4" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        )}

                        {chatActionId === chat.id ? (
                          <div
                            ref={(element) => {
                              const key = `chat:${chat.id}`;
                              if (element) {
                                menuSurfaceRefs.current.set(key, element);
                              } else {
                                menuSurfaceRefs.current.delete(key);
                              }
                            }}
                            className={menuSurface}
                            id={chatMenuId}
                            role="dialog"
                            aria-label={`Actions for ${chat.title}`}
                            aria-modal="false"
                            data-left-pane-menu="true"
                          >
                            <div className="mb-1 border-b border-trace-subtle px-2 pb-2 pt-1">
                              <div className="truncate text-sm font-medium text-ink" title={chat.title}>
                                {chat.title}
                              </div>
                              <div className="mt-0.5 truncate text-xs text-ink-muted" title={providerModel}>
                                {providerModel}
                                {running ? " · Response running" : unavailable ? " · Unavailable for new runs" : ""}
                              </div>
                            </div>
                            <button
                              className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`}
                              type="button"
                              aria-pressed={favorite}
                              data-menu-initial-focus="true"
                              onClick={() => onToggleChatFavorite(chat)}
                            >
                              <Star
                                className={`size-4 text-ink-muted ${favorite ? "fill-current text-proof" : ""}`}
                                aria-hidden="true"
                              />
                              {favorite ? "Remove from favorites" : "Add to favorites"}
                            </button>
                            <button
                              className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`}
                              type="button"
                              onClick={() => onStartChatEdit(chat)}
                            >
                              <Pencil className="size-4 text-ink-muted" aria-hidden="true" />
                              Rename
                            </button>
                            <div className="mt-1 space-y-1 px-2 py-1 text-xs text-ink-muted">
                              <span className="block">Move to folder</span>
                              <ComposerOptionPicker
                                className="w-full"
                                disabled={false}
                                embeddedInMenu
                                id={`${idPrefix}move-chat-${chat.id}`}
                                label={`Move chat ${chat.title} to folder`}
                                onChange={(value) => {
                                  if (value !== (chat.folderId ?? "")) {
                                    onMoveChat(chat.id, value || null);
                                  }
                                }}
                                options={[
                                  {
                                    description: "Keep this chat outside folders.",
                                    label: "No folder",
                                    value: ""
                                  },
                                  ...folders.map((folder) =>
                                    folderDestinationOption(folder, foldersById)
                                  )
                                ]}
                                pickerDescription="Choose a destination. The move applies immediately."
                                pickerTitle="Move to folder"
                                placement="below"
                                summaryLabel={
                                  chat.folderId && foldersById.has(chat.folderId)
                                    ? folderPath(foldersById.get(chat.folderId)!, foldersById)
                                    : "No folder"
                                }
                                value={chat.folderId ?? ""}
                              />
                            </div>
                            <button
                              className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-ink-secondary hover:bg-control-hover hover:text-ink disabled:text-ink-disabled ${focusRing}`}
                              type="button"
                              onClick={() => onShareChat(chat)}
                            >
                              <Share2 className="size-4 text-ink-muted" aria-hidden="true" />
                              Share
                            </button>
                            <button
                              className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-ink-secondary hover:bg-control-hover hover:text-ink ${focusRing}`}
                              type="button"
                              onClick={() => onExportChat(chat)}
                            >
                              <Download className="size-4 text-ink-muted" aria-hidden="true" />
                              Export
                            </button>
                            <div className="mt-1 border-t border-trace-subtle pt-1">
                              <button
                                className={`flex ${menuActionTarget} w-full items-center gap-2 rounded-control px-2 text-left text-critical hover:bg-critical/10 ${focusRing}`}
                                type="button"
                                onClick={() => onDeleteChat(chat)}
                              >
                                <Trash2 className="size-4" aria-hidden="true" />
                                Delete chat
                              </button>
                            </div>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          );
        })}

        {chatGroups.length === 0 && workspaceReady && !workspaceLoading && !chatContentSearchLoading ? (
          <div className="px-5 py-10 text-center" data-testid="workspace-empty-state">
            <p className="text-sm font-medium text-ink-secondary">
              {queryActive ? "No chats match this search" : "No chats yet"}
            </p>
            <p className="mt-1 text-xs leading-5 text-ink-muted">
              {queryActive ? "Try a different title, model, or phrase." : "New conversations will appear here."}
            </p>
          </div>
        ) : null}
      </nav>
      {footer ? (
        <footer
          className={`relative shrink-0 border-t border-trace-subtle px-3 pt-2 ${
            layout === "mobile" ? "pb-2" : "pb-[max(0.5rem,env(safe-area-inset-bottom))]"
          }`}
          data-testid="workspace-account-footer"
        >
          {footer}
        </footer>
      ) : null}
    </aside>
  );
}

function sameLeftPaneData(prev: LeftChatPaneProps, next: LeftChatPaneProps): boolean {
  return (
    prev.activeChatId === next.activeChatId &&
    prev.activeRunChatIds === next.activeRunChatIds &&
    prev.availableChatModelKeys === next.availableChatModelKeys &&
    prev.chatModelLabels === next.chatModelLabels &&
    prev.chatActionId === next.chatActionId &&
    prev.chatContentMatchIds === next.chatContentMatchIds &&
    prev.chatContentSearchError === next.chatContentSearchError &&
    prev.chatContentSearchLoading === next.chatContentSearchLoading &&
    prev.chatGroups === next.chatGroups &&
    prev.chatQuery === next.chatQuery &&
    prev.collapsedFolderIds === next.collapsedFolderIds &&
    prev.creatingChat === next.creatingChat &&
    prev.creatingFolder === next.creatingFolder &&
    prev.editingChatId === next.editingChatId &&
    prev.editingChatTitle === next.editingChatTitle &&
    prev.editingFolderId === next.editingFolderId &&
    prev.editingFolderName === next.editingFolderName &&
    prev.folderActionId === next.folderActionId &&
    prev.folderMenuId === next.folderMenuId &&
    prev.folders === next.folders &&
    prev.footer === next.footer &&
    prev.layout === next.layout &&
    prev.newFolderName === next.newFolderName &&
    prev.scrollTopRef === next.scrollTopRef &&
    prev.subfolderName === next.subfolderName &&
    prev.subfolderParentId === next.subfolderParentId &&
    prev.workspaceError === next.workspaceError &&
    prev.workspaceLoading === next.workspaceLoading &&
    prev.workspaceReady === next.workspaceReady
  );
}

export const LeftChatPane = memo(LeftChatPaneComponent, sameLeftPaneData);
