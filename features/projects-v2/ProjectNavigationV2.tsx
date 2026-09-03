"use client";

import {
  UiV2Button,
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuActions
} from "@/components/ui-v2";
import { ConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { UiV2ResponsiveMenu } from "@/components/ui-v2/ResponsiveMenuV2";
import { UiV2RovingTree } from "@/components/ui-v2/RovingTreeV2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { chatTitleForDisplay } from "@/components/app-shell/shellFormatting";
import { chatMenuActionsV2 } from "@/features/navigation-v2/chatMenuActions";
import { useState } from "react";
import type {
  ProjectChatSummaryWire,
  ProjectFolderWire,
  ProjectSummaryWire
} from "@/lib/contracts/projects";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

function ProjectFolderActions({
  busy,
  canCreateChat,
  canManage,
  folderName,
  onCreateChat,
  onDelete,
  onRename
}: Readonly<{
  busy: boolean;
  canCreateChat: boolean;
  canManage: boolean;
  folderName: string;
  onCreateChat(): void;
  onDelete(restoreFocus: HTMLButtonElement | null): void;
  onRename(): void;
}>) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: close, open });
  if (!canCreateChat && !canManage) return null;

  return (
    <span className="v2-project-folder-actions">
      {canCreateChat ? (
        <UiV2IconButton
          className="v2-project-folder-add"
          disabled={busy}
          icon="plus"
          label={`New chat in ${folderName}`}
          onClick={onCreateChat}
        />
      ) : null}
      <UiV2IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        className="v2-project-folder-menu-trigger"
        data-v2-row-menu-trigger="true"
        disabled={busy}
        icon="more"
        label={`Folder actions: ${folderName}`}
        ref={triggerRef}
        tabIndex={-1}
        onClick={() => (open ? close() : setOpen(true))}
      />
      {open ? (
        <UiV2ResponsiveMenu
          anchorRef={triggerRef}
          className="v2-project-folder-menu"
          label={`Folder actions: ${folderName}`}
          menuRef={menuRef}
          onClose={close}
        >
          <UiV2MenuActions
            actions={[
              ...(canCreateChat ? [{ label: "New chat in folder", onSelect: onCreateChat }] : []),
              ...(canManage ? [
                { label: "Rename folder", onSelect: onRename },
                {
                  label: "Delete folder…",
                  onSelect: () => onDelete(triggerRef.current),
                  tone: "destructive" as const
                }
              ] : [])
            ]}
            onClose={close}
          />
        </UiV2ResponsiveMenu>
      ) : null}
    </span>
  );
}

function ProjectChatRow({
  active,
  busy,
  canArchive,
  canMove,
  chat,
  folderNames,
  folders,
  level,
  onArchive,
  onCreateFolder,
  onMove,
  onNavigate,
  onSelect
}: Readonly<{
  active: boolean;
  busy: boolean;
  canArchive: boolean;
  canMove: boolean;
  chat: ProjectChatSummaryWire;
  folderNames: ReadonlyMap<string, string>;
  folders: readonly ProjectFolderWire[];
  level: number;
  onArchive(): void;
  onCreateFolder(): void;
  onMove(folderId: string | null): void;
  onNavigate(): void;
  onSelect(): Promise<boolean>;
}>) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = () => setMenuOpen(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: closeMenu, open: menuOpen });
  const title = chatTitleForDisplay(chat.title);
  return (
    <div className="v2-project-chat-row-wrap" data-v2-tree-row="true">
      <button
        aria-current={active ? "page" : undefined}
        aria-label={title}
        aria-level={level}
        aria-selected={active}
        className="v2-project-chat-row v2-focusable"
        data-selected={active || undefined}
        data-v2-tree-item="true"
        role="treeitem"
        tabIndex={-1}
        title={chat.createdByDisplayName ? `Started by ${chat.createdByDisplayName}` : undefined}
        type="button"
        onClick={() => {
          void onSelect().then((selected) => {
            if (selected) onNavigate();
          });
        }}
      >
        {chat.activeRun ? <span className="v2-chat-pulse" aria-label="Answer in progress" /> : <UiV2Icon name="branch" />}
        <span className="v2-project-chat-copy">
          <span className="v2-chat-title">{title}</span>
          <span>{chat.folderId ? folderNames.get(chat.folderId) ?? "Folder" : chat.createdByDisplayName}</span>
        </span>
      </button>
      {canMove || canArchive ? (
        <>
          <UiV2IconButton
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="v2-project-chat-menu-trigger"
            data-v2-row-menu-trigger="true"
            disabled={busy}
            icon="more"
            label={`Actions: ${title}`}
            ref={triggerRef}
            tabIndex={-1}
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
          />
          {menuOpen ? (
            <UiV2ResponsiveMenu
              anchorRef={triggerRef}
              className="v2-project-chat-menu"
              label={`Chat actions: ${title}`}
              menuRef={menuRef}
              onClose={closeMenu}
            >
              <UiV2MenuActions
                actions={chatMenuActionsV2({
                  archiveDisabled: busy || chat.activeRun,
                  folders,
                  memoryUsed: null,
                  moveDisabled: busy,
                  moveRootLabel: "Project root",
                  onArchive: canArchive ? onArchive : undefined,
                  onMove: canMove ? onMove : undefined,
                  onMoveCreateFolder: canMove ? onCreateFolder : undefined,
                  surface: "row"
                })}
                onClose={closeMenu}
              />
            </UiV2ResponsiveMenu>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function ProjectFolderInlineForm({
  busy,
  folderName,
  mode,
  onCancel,
  onChange,
  onSubmit
}: Readonly<{
  busy: boolean;
  folderName: string;
  mode: "create" | "rename";
  onCancel(): void;
  onChange(value: string): void;
  onSubmit(): void;
}>) {
  const actionLabel = mode === "create" ? "Create folder" : "Save folder name";
  return (
    <form
      className="v2-project-folder-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (folderName.trim() && !busy) onSubmit();
      }}
    >
      <input
        autoFocus
        aria-label={mode === "create" ? "New folder name" : "Folder name"}
        disabled={busy}
        maxLength={60}
        value={folderName}
        onChange={(event) => onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onCancel();
          } else if (event.key === "Enter" && folderName.trim() && !busy) {
            event.preventDefault();
            onSubmit();
          }
        }}
      />
      <UiV2IconButton
        className="v2-project-folder-form-submit"
        disabled={busy || !folderName.trim()}
        icon="check"
        label={actionLabel}
        type="submit"
      />
      <UiV2IconButton
        disabled={busy}
        icon="close"
        label="Cancel folder edit"
        onClick={onCancel}
      />
    </form>
  );
}

function ProjectFolderRow({
  activeChatId,
  busy,
  canArchive,
  canCreateChat,
  canManage,
  chats,
  editing,
  editingName,
  folder,
  folderNames,
  folders,
  onArchiveChat,
  onCancelRename,
  onChangeRename,
  onCreateChat,
  onCreateFolder,
  onDelete,
  onMoveChat,
  onNavigate,
  onRename,
  onSaveRename,
  onSelectChat
}: Readonly<{
  activeChatId: string | null;
  busy: boolean;
  canArchive: boolean;
  canCreateChat: boolean;
  canManage: boolean;
  chats: readonly ProjectChatSummaryWire[];
  editing: boolean;
  editingName: string;
  folder: ProjectFolderWire;
  folderNames: ReadonlyMap<string, string>;
  folders: readonly ProjectFolderWire[];
  onArchiveChat(chatId: string): void;
  onCancelRename(): void;
  onChangeRename(value: string): void;
  onCreateChat(folderId: string): void;
  onCreateFolder(): void;
  onDelete(folder: ProjectFolderWire, restoreFocus: HTMLButtonElement | null): void;
  onMoveChat(chatId: string, folderId: string | null): void;
  onNavigate(): void;
  onRename(folder: ProjectFolderWire): void;
  onSaveRename(): void;
  onSelectChat(chatId: string): Promise<boolean>;
}>) {
  const [open, setOpen] = useState(true);
  const directChats = chats.filter((chat) => chat.folderId === folder.id);
  const directChatLabel = `${directChats.length} ${directChats.length === 1 ? "chat" : "chats"}`;

  return (
    <section className="v2-project-folder" data-project-folder-id={folder.id} role="none">
      {editing ? (
        <ProjectFolderInlineForm
          busy={busy}
          folderName={editingName}
          mode="rename"
          onCancel={onCancelRename}
          onChange={onChangeRename}
          onSubmit={onSaveRename}
        />
      ) : (
        <div className="v2-project-folder-heading" data-v2-tree-row="true">
          <button
            aria-label={`${folder.name}, ${directChatLabel}`}
            aria-expanded={open}
            aria-level={1}
            aria-selected={false}
            className="v2-project-folder-toggle v2-focusable"
            data-v2-tree-item="true"
            role="treeitem"
            tabIndex={-1}
            type="button"
            onClick={() => setOpen((value) => !value)}
          >
            <UiV2Icon name={open ? "chevron-down" : "chevron-right"} />
            <span className="v2-project-folder-name">{folder.name}</span>
            <span aria-hidden="true" className="v2-project-folder-count">{directChats.length}</span>
          </button>
          <ProjectFolderActions
            busy={busy}
            canCreateChat={canCreateChat}
            canManage={canManage}
            folderName={folder.name}
            onCreateChat={() => onCreateChat(folder.id)}
            onDelete={(restoreFocus) => onDelete(folder, restoreFocus)}
            onRename={() => onRename(folder)}
          />
        </div>
      )}
      {open && !editing ? (
        <div className="v2-project-folder-children" role="group">
          {directChats.map((chat) => (
            <ProjectChatRow
              active={chat.id === activeChatId}
              busy={busy}
              canArchive={canArchive}
              canMove={canManage}
              chat={chat}
              folderNames={folderNames}
              folders={folders}
              key={chat.id}
              level={2}
              onArchive={() => onArchiveChat(chat.id)}
              onCreateFolder={onCreateFolder}
              onMove={(folderId) => onMoveChat(chat.id, folderId)}
              onNavigate={onNavigate}
              onSelect={() => onSelectChat(chat.id)}
            />
          ))}
          {directChats.length === 0 ? (
            <p className="v2-project-folder-empty">No chats</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

const PROJECT_FILTER_MAX_LENGTH = 120;

function matchesFilter(value: string, query: string): boolean {
  return value.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}

function ProjectLocalFilter({
  clearLabel,
  label,
  onChange,
  placeholder,
  value
}: Readonly<{
  clearLabel: string;
  label: string;
  onChange(value: string): void;
  placeholder: string;
  value: string;
}>) {
  return (
    <div className="v2-project-local-filter">
      <UiV2Icon name="search" />
      <input
        aria-label={label}
        autoComplete="off"
        maxLength={PROJECT_FILTER_MAX_LENGTH}
        placeholder={placeholder}
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          if (value) onChange("");
          else event.currentTarget.blur();
        }}
      />
      {value ? (
        <UiV2IconButton
          className="v2-project-local-filter-clear"
          icon="close"
          label={clearLabel}
          onClick={() => onChange("")}
        />
      ) : null}
    </div>
  );
}

function ProjectListMode({ controller }: { controller: ProjectWorkspaceController }) {
  const [query, setQuery] = useState("");
  const filteredProjects = controller.projects.filter((project) =>
    project.status === "ACTIVE" && (!query || matchesFilter(project.name, query))
  );
  const emptyCopy = query
    ? "No active projects match this filter."
    : controller.projects.length === 0
      ? "No projects yet. Create one to start a shared workspace."
      : "No active projects.";

  return (
    <>
      <div className="v2-project-primary-action">
        <UiV2Button icon="plus" onClick={controller.actions.openCreate}>New project</UiV2Button>
      </div>
      <ProjectLocalFilter
        clearLabel="Clear project filter"
        label="Filter projects"
        placeholder="Filter projects…"
        value={query}
        onChange={setQuery}
      />
      <div aria-live="polite" className="v2-project-mode-content">
        {controller.listLoading && controller.projects.length === 0 ? (
          <p className="v2-project-navigation-note">Loading shared workspaces…</p>
        ) : controller.listError && controller.projects.length === 0 ? (
          <div className="v2-project-navigation-note">
            <span>Projects are unavailable.</span>
            <button type="button" onClick={() => void controller.actions.refreshList()}>Retry</button>
          </div>
        ) : (
          <>
            {controller.listError ? (
              <div className="v2-project-navigation-note">
                <span>Could not refresh projects.</span>
                <button type="button" onClick={() => void controller.actions.refreshList()}>Retry</button>
              </div>
            ) : null}
            {filteredProjects.length > 0 ? (
              <div className="v2-project-list">
                {filteredProjects.map((project: ProjectSummaryWire) => (
                  <button
                    aria-label={project.name}
                    className="v2-project-row v2-focusable"
                    key={project.id}
                    type="button"
                    onClick={() => void controller.actions.selectProject(project.id)}
                  >
                    <span className="v2-project-mark" aria-hidden="true">
                      {project.name.slice(0, 1).toUpperCase()}
                    </span>
                    <span className="v2-project-row-copy">
                      <span className="v2-chat-title">{project.name}</span>
                      <span>
                        {project.chatCount} {project.chatCount === 1 ? "chat" : "chats"}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="v2-project-navigation-note">{emptyCopy}</p>
            )}
          </>
        )}
      </div>
    </>
  );
}

function newChatUnavailableReason(
  selected: ProjectWorkspaceController["detail"],
  busy: boolean
): string | null {
  if (!selected) return "Project details are still loading.";
  if (selected.status === "DELETING") return "This Project is being deleted and is read-only.";
  if (selected.status !== "ACTIVE") return "Archived Projects are read-only.";
  if (!selected.capabilities.mutateChats) {
    return "Your Project role can view shared chats but cannot start one.";
  }
  if (selected.readiness === "SETUP_REQUIRED") {
    return "Project setup is required before starting a shared chat.";
  }
  if (busy) return "Another Project action is still finishing.";
  return null;
}

function ProjectDrillIn({
  activeChatId,
  controller,
  onNavigate
}: Readonly<{
  activeChatId: string | null;
  controller: ProjectWorkspaceController;
  onNavigate(): void;
}>) {
  const selected = controller.detail;
  const [chatQuery, setChatQuery] = useState("");
  const [folderDialog, setFolderDialog] = useState<null | {
    folderId?: string;
    mode: "create" | "rename";
  }>(null);
  const [folderName, setFolderName] = useState("");
  const [deleteRequest, setDeleteRequest] = useState<null | {
    folderId: string;
    restoreFocus: HTMLButtonElement | null;
  }>(null);
  const projectFolders = controller.workspace?.folders ?? [];
  const normalizedChatQuery = chatQuery.trim();
  const matchingFolderIds = new Set(projectFolders
    .filter((folder) => normalizedChatQuery && matchesFilter(folder.name, normalizedChatQuery))
    .map((folder) => folder.id));
  const chats = (controller.workspace?.chats ?? [])
    .filter((chat) => !chat.archived)
    .filter((chat) => !normalizedChatQuery ||
      matchesFilter(chatTitleForDisplay(chat.title), normalizedChatQuery) ||
      Boolean(chat.folderId && matchingFolderIds.has(chat.folderId)));
  const folderNames = new Map(projectFolders.map((folder) => [folder.id, folder.name]));
  const allFolderIds = new Set(projectFolders.map((folder) => folder.id));
  // The product surface deliberately presents one level. Older parentId data
  // remains readable, but it never creates a nested interaction or move target.
  const flatFolders = projectFolders.map((folder) => ({ ...folder, parentId: null }));
  const visibleFolders = projectFolders.filter((folder) =>
    !normalizedChatQuery || matchingFolderIds.has(folder.id) ||
    chats.some((chat) => chat.folderId === folder.id)
  );
  const unfiledChats = chats.filter((chat) =>
    !chat.folderId || !allFolderIds.has(chat.folderId)
  );
  const chatReason = newChatUnavailableReason(selected, controller.busy);
  const canStartChat = chatReason === null;
  const canCreateChat = Boolean(
    selected?.status === "ACTIVE" && selected.capabilities.mutateChats &&
    selected.readiness !== "SETUP_REQUIRED"
  );
  const canManage = Boolean(
    selected?.status === "ACTIVE" && selected.capabilities.manageProject
  );
  const canArchive = Boolean(
    canManage && selected?.capabilities.archiveChats
  );
  const deleteFolder = deleteRequest
    ? projectFolders.find((folder) => folder.id === deleteRequest.folderId) ?? null
    : null;
  const beginCreateFolder = () => {
    setFolderDialog({ mode: "create" });
    setFolderName("");
  };
  const cancelFolderForm = () => {
    setFolderDialog(null);
    setFolderName("");
  };
  const saveFolderForm = () => {
    if (!folderDialog) return;
    const value = folderName.trim();
    if (!value) return;
    const action = folderDialog.mode === "create"
      ? controller.actions.createFolder(value)
      : controller.actions.updateFolder(folderDialog.folderId!, { name: value });
    void action.then((saved) => {
      if (saved) cancelFolderForm();
    });
  };

  return (
    <>
      <button
        className="v2-project-back v2-focusable"
        type="button"
        onClick={controller.actions.leave}
      >
        <UiV2Icon name="arrow-left" />
        All projects
      </button>
      {controller.actionError ? <p className="v2-project-inline-error">{controller.actionError}</p> : null}
      {controller.syncWarning ? (
        <p className="v2-project-sync-warning" role="status">
          {controller.syncWarning}{" "}
          <button type="button" onClick={() => void controller.actions.retrySync()}>
            Retry sync
          </button>
        </p>
      ) : null}
      <div className="v2-project-create-actions">
        <button
          aria-describedby={chatReason ? "v2-project-new-chat-reason" : undefined}
          className="v2-project-new-chat v2-focusable"
          disabled={!canStartChat}
          title={chatReason ?? undefined}
          type="button"
          onClick={() => {
            void controller.actions.createChat().then((created) => {
              if (created) onNavigate();
            });
          }}
        >
          <UiV2Icon name="plus" /> New shared chat
        </button>
        {chatReason ? (
          <p className="v2-project-action-reason" id="v2-project-new-chat-reason">
            {chatReason}
          </p>
        ) : null}
      </div>
      <ProjectLocalFilter
        clearLabel="Clear chat filter"
        label="Filter chats"
        placeholder="Filter chats…"
        value={chatQuery}
        onChange={setChatQuery}
      />
      <div aria-live="polite" className="v2-project-mode-content">
        {!controller.workspace && controller.syncState !== "error" ? (
          <p className="v2-project-navigation-note">Opening the shared workspace…</p>
        ) : controller.syncState === "error" && !controller.workspace ? (
          <div className="v2-project-navigation-note">
            <span>Could not open this Project.</span>
            <button type="button" onClick={() => void controller.actions.refresh()}>Retry</button>
          </div>
        ) : normalizedChatQuery && visibleFolders.length === 0 && unfiledChats.length === 0 && !folderDialog ? (
          <p className="v2-project-navigation-note">No project chats or folders match this filter.</p>
        ) : chats.length === 0 && projectFolders.length === 0 && !folderDialog ? (
          <p className="v2-project-navigation-note">No shared chats yet.</p>
        ) : (
          <UiV2RovingTree className="v2-project-chat-list" label={`${selected?.name ?? "Project"} chats`}>
            {visibleFolders.map((folder) => (
              <ProjectFolderRow
                activeChatId={activeChatId}
                busy={controller.busy}
                canArchive={canArchive}
                canCreateChat={canCreateChat}
                canManage={canManage}
                chats={chats}
                editing={folderDialog?.mode === "rename" && folderDialog.folderId === folder.id}
                editingName={folderName}
                folder={folder}
                folderNames={folderNames}
                folders={flatFolders}
                key={folder.id}
                onArchiveChat={(chatId) => void controller.actions.archiveChat(chatId, true)}
                onCancelRename={cancelFolderForm}
                onChangeRename={setFolderName}
                onCreateChat={(folderId) => {
                  void controller.actions.createChat(folderId).then((created) => {
                    if (created) onNavigate();
                  });
                }}
                onCreateFolder={beginCreateFolder}
                onDelete={(target, restoreFocus) => setDeleteRequest({
                  folderId: target.id,
                  restoreFocus
                })}
                onMoveChat={(chatId, folderId) => void controller.actions.moveChat(chatId, folderId)}
                onNavigate={onNavigate}
                onRename={(target) => {
                  setFolderDialog({
                    folderId: target.id,
                    mode: "rename"
                  });
                  setFolderName(target.name);
                }}
                onSaveRename={saveFolderForm}
                onSelectChat={controller.actions.selectChat}
              />
            ))}
            {folderDialog?.mode === "create" ? (
              <ProjectFolderInlineForm
                busy={controller.busy}
                folderName={folderName}
                mode="create"
                onCancel={cancelFolderForm}
                onChange={setFolderName}
                onSubmit={saveFolderForm}
              />
            ) : null}
            {unfiledChats.length > 0 ? (
              <div
                aria-labelledby="v2-project-unfiled-chats"
                className="v2-project-chat-group"
                role="group"
              >
                <div className="v2-project-group-label" id="v2-project-unfiled-chats">
                  Chats
                </div>
                {unfiledChats.map((chat) => (
                  <ProjectChatRow
                    active={chat.id === activeChatId}
                    busy={controller.busy}
                    canArchive={canArchive}
                    canMove={canManage}
                    chat={chat}
                    folderNames={folderNames}
                    folders={flatFolders}
                    key={chat.id}
                    level={1}
                    onArchive={() => void controller.actions.archiveChat(chat.id, true)}
                    onCreateFolder={beginCreateFolder}
                    onMove={(folderId) => void controller.actions.moveChat(chat.id, folderId)}
                    onNavigate={onNavigate}
                    onSelect={() => controller.actions.selectChat(chat.id)}
                  />
                ))}
              </div>
            ) : null}
          </UiV2RovingTree>
        )}
      </div>
      {canManage ? (
        <footer className="v2-project-footer">
          <button
            className="v2-project-folder-create v2-focusable"
            disabled={controller.busy}
            type="button"
            onClick={beginCreateFolder}
          >
            <UiV2Icon name="plus" /> New folder
          </button>
        </footer>
      ) : null}
      {deleteFolder && deleteRequest ? (
        <ConfirmationDialog
          busy={controller.busy}
          confirmAriaLabel={`Delete folder ${deleteFolder.name}`}
          confirmLabel="Delete folder"
          dialogLabel={`Delete folder ${deleteFolder.name}`}
          onCancel={() => setDeleteRequest(null)}
          onConfirm={() => {
            void controller.actions.deleteFolder(deleteFolder.id).then((deleted) => {
              if (deleted) setDeleteRequest(null);
            });
          }}
          restoreFocus={() => deleteRequest.restoreFocus}
          testId="project-delete-folder-confirmation"
          title={`Delete “${deleteFolder.name}”?`}
        >
          {`Its chats and child folders move to ${deleteFolder.parentId && folderNames.has(deleteFolder.parentId)
            ? `“${folderNames.get(deleteFolder.parentId)}”`
            : "Project root"}. Nothing inside the folder is deleted.`}
        </ConfirmationDialog>
      ) : null}
    </>
  );
}

export function ProjectNavigationV2({
  activeChatId,
  controller,
  landing = false,
  onNavigate
}: Readonly<{
  activeChatId: string | null;
  controller: ProjectWorkspaceController;
  /** True while the Projects rail destination owns the second column. */
  landing?: boolean;
  onNavigate(): void;
}>) {
  if (!controller.selectedProjectId && !landing) return null;
  const mode = controller.selectedProjectId ? "project" : "list";

  return (
    <section
      aria-label="Shared projects"
      className="v2-project-navigation"
      data-landing={landing || undefined}
      data-mode={mode}
    >
      {mode === "list" ? (
        <ProjectListMode controller={controller} />
      ) : (
        <ProjectDrillIn
          activeChatId={activeChatId}
          controller={controller}
          onNavigate={onNavigate}
        />
      )}
    </section>
  );
}
