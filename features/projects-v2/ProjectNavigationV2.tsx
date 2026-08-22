"use client";

import {
  UiV2Icon,
  UiV2IconButton,
  UiV2MenuItem,
  UiV2MenuSurface
} from "@/components/ui-v2";
import { useMenuDismissalV2 } from "@/components/ui-v2/useMenuDismissalV2";
import { useState } from "react";
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
  onDelete(): void;
  onRename(): void;
}>) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const { menuRef, triggerRef } = useMenuDismissalV2({ onClose: close, open });
  if (!canCreateChat && !canManage) return null;

  return (
    <span className="v2-project-folder-actions">
      <UiV2IconButton
        aria-expanded={open}
        aria-haspopup="menu"
        className="v2-project-folder-menu-trigger"
        disabled={busy}
        icon="more"
        label={`Folder actions: ${folderName}`}
        ref={triggerRef}
        onClick={() => (open ? close() : setOpen(true))}
      />
      {open ? (
        <UiV2MenuSurface
          className="v2-project-folder-menu"
          label={`Folder actions: ${folderName}`}
          ref={menuRef}
        >
          {canCreateChat ? (
            <UiV2MenuItem onClick={() => { close(); onCreateChat(); }}>
              New chat in folder
            </UiV2MenuItem>
          ) : null}
          {canManage ? (
            <>
              <UiV2MenuItem onClick={() => { close(); onRename(); }}>
                Rename folder
              </UiV2MenuItem>
              <UiV2MenuItem onClick={() => { close(); onDelete(); }}>
                Delete folder…
              </UiV2MenuItem>
            </>
          ) : null}
        </UiV2MenuSurface>
      ) : null}
    </span>
  );
}

export function ProjectNavigationV2({
  activeChatId,
  controller,
  onNavigate
}: Readonly<{
  activeChatId: string | null;
  controller: ProjectWorkspaceController;
  onNavigate(): void;
}>) {
  const selected = controller.detail;
  const chats = (controller.workspace?.chats ?? []).filter((chat) => !chat.archived);
  const projectFolders = controller.workspace?.folders ?? [];
  const folders = new Map(projectFolders.map((folder) => [folder.id, folder.name]));
  const [folderDialog, setFolderDialog] = useState<null | { mode: "create" | "rename"; folderId?: string; initial: string }>(null);
  const [folderName, setFolderName] = useState("");
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const canStartChat = Boolean(
    selected?.status === "ACTIVE" && selected.capabilities.mutateChats &&
    selected.readiness !== "SETUP_REQUIRED"
  );
  const unfiledChats = chats.filter((chat) => !chat.folderId);
  const renderChat = (chat: (typeof chats)[number]) => (
    <div className="v2-project-chat-row-wrap" key={chat.id}>
      <button
        className="v2-project-chat-row v2-focusable"
        data-selected={chat.id === activeChatId}
        title={chat.createdByDisplayName ? `Started by ${chat.createdByDisplayName}` : undefined}
        type="button"
        onClick={() => {
          void controller.actions.selectChat(chat.id);
          onNavigate();
        }}
      >
        {chat.activeRun ? <span className="v2-chat-pulse" aria-label="Answer in progress" /> : <UiV2Icon name="branch" />}
        <span className="v2-project-chat-copy">
          <span className="v2-chat-title">{chat.title}</span>
          <span>{chat.folderId ? folders.get(chat.folderId) ?? "Folder" : chat.createdByDisplayName}</span>
        </span>
      </button>
      {selected?.status === "ACTIVE" && selected.capabilities.manageProject ? (
        <select
          aria-label={`Move ${chat.title}`}
          disabled={controller.busy}
          value={chat.folderId ?? ""}
          onChange={(event) => void controller.actions.moveChat(chat.id, event.target.value || null)}
        >
          <option value="">Project root</option>
          {projectFolders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
        </select>
      ) : null}
    </div>
  );

  return (
    <section className="v2-project-navigation" aria-label="Shared projects">
      <div className="v2-project-navigation-heading">
        <span>Projects</span>
        <UiV2IconButton
          icon="plus"
          label="Create project"
          onClick={controller.actions.openCreate}
        />
      </div>

      {controller.listLoading && controller.projects.length === 0 ? (
        <p className="v2-project-navigation-note">Loading shared workspaces…</p>
      ) : controller.listError && controller.projects.length === 0 ? (
        <div className="v2-project-navigation-note">
          <span>Projects are unavailable.</span>
          <button type="button" onClick={() => void controller.actions.refreshList()}>Retry</button>
        </div>
      ) : controller.projects.length === 0 ? (
        <p className="v2-project-navigation-note">Create a project for shared chats and files.</p>
      ) : (
        <div className="v2-project-list">
          {[...controller.projects.filter((project) => project.status === "ACTIVE"), ...controller.projects.filter((project) => project.status !== "ACTIVE")].map((project) => (
            <button
              aria-current={project.id === controller.selectedProjectId ? "page" : undefined}
              className="v2-project-row v2-focusable"
              data-selected={project.id === controller.selectedProjectId}
              key={project.id}
              type="button"
              onClick={() => {
                void controller.actions.selectProject(project.id);
              }}
            >
              <span className="v2-project-mark" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
              <span className="v2-project-row-copy">
                <span className="v2-chat-title">{project.name}</span>
                <span>{project.audienceCount} active members · {project.effectiveRole.toLowerCase()}</span>
              </span>
              {project.status !== "ACTIVE" ? <span className="v2-project-state">Archived</span> : null}
            </button>
          ))}
        </div>
      )}

      {controller.selectedProjectId ? (
        <div className="v2-project-desk">
          <div className="v2-project-desk-heading">
            <span>{selected?.name ?? "Opening project…"}</span>
            {selected ? (
              <UiV2IconButton
                icon="settings"
                label={`Open ${selected.name} details`}
                onClick={() => controller.actions.openSettings()}
              />
            ) : null}
          </div>
          {controller.actionError ? <p className="v2-project-inline-error">{controller.actionError}</p> : null}
          {controller.syncWarning ? (
            <p className="v2-project-sync-warning" role="status">
              {controller.syncWarning}{" "}
              <button type="button" onClick={() => void controller.actions.retrySync()}>
                Retry sync
              </button>
            </p>
          ) : null}
          {selected?.status === "ACTIVE" && selected.capabilities.mutateChats ? (
            <div className="v2-project-create-actions">
              <button
                className="v2-project-new-chat v2-focusable"
                disabled={controller.busy || !canStartChat}
                title={!canStartChat ? "Project setup is required before starting a shared chat." : undefined}
                type="button"
                onClick={() => {
                  void controller.actions.createChat();
                }}
              >
                <UiV2Icon name="plus" /> New shared chat
              </button>
              <button
                className="v2-project-folder-create v2-focusable"
                disabled={controller.busy}
                type="button"
                onClick={() => { setFolderDialog({ mode: "create", initial: "" }); setFolderName(""); }}
              >
                New folder
              </button>
            </div>
          ) : null}
          {!controller.workspace && controller.syncState !== "error" ? (
            <p className="v2-project-navigation-note">Opening the shared desk…</p>
          ) : controller.syncState === "error" && !controller.workspace ? (
            <div className="v2-project-navigation-note">
              <span>Could not open this project.</span>
              <button type="button" onClick={() => void controller.actions.refresh()}>Retry</button>
            </div>
          ) : chats.length === 0 && projectFolders.length === 0 ? (
            <p className="v2-project-navigation-note">
              {selected?.readiness === "SETUP_REQUIRED"
                ? "Project setup is required before the first shared chat."
                : selected?.capabilities.mutateChats ? "Start the first shared chat." : "No shared chats yet."}
            </p>
          ) : (
            <div className="v2-project-chat-list">
              {projectFolders.map((folder) => {
                const folderChats = chats.filter((chat) => chat.folderId === folder.id);
                return (
                  <section className="v2-project-folder" key={folder.id}>
                    <div className="v2-project-folder-heading">
                      <span>{folder.name}</span>
                      <ProjectFolderActions
                        busy={controller.busy}
                        canCreateChat={canStartChat}
                        canManage={selected?.status === "ACTIVE" && selected.capabilities.manageProject}
                        folderName={folder.name}
                        onCreateChat={() => void controller.actions.createChat(folder.id)}
                        onDelete={() => setDeleteFolderId(folder.id)}
                        onRename={() => {
                          setFolderDialog({
                            mode: "rename",
                            folderId: folder.id,
                            initial: folder.name
                          });
                          setFolderName(folder.name);
                        }}
                      />
                    </div>
                    {folderChats.length > 0 ? folderChats.map(renderChat) : <p className="v2-project-folder-empty">No chats</p>}
                  </section>
                );
              })}
              {unfiledChats.map(renderChat)}
            </div>
          )}
        </div>
      ) : null}
      {folderDialog ? (
        <div className="v2-project-inline-dialog" role="dialog" aria-label={folderDialog.mode === "create" ? "Create folder" : "Rename folder"}>
          <form onSubmit={(event) => {
            event.preventDefault();
            const value = folderName.trim();
            if (!value) return;
            const action = folderDialog.mode === "create"
              ? controller.actions.createFolder(value)
              : controller.actions.updateFolder(folderDialog.folderId!, { name: value });
            void Promise.resolve(action).then((saved) => { if (saved !== false) setFolderDialog(null); });
          }}>
            <label>{folderDialog.mode === "create" ? "Folder name" : "New folder name"}<input autoFocus maxLength={80} value={folderName} onChange={(event) => setFolderName(event.target.value)} /></label>
            <button type="submit" disabled={controller.busy || !folderName.trim()}>Save</button>
            <button type="button" onClick={() => setFolderDialog(null)}>Cancel</button>
          </form>
        </div>
      ) : null}
      {deleteFolderId ? (
        <div className="v2-project-inline-dialog" role="alertdialog" aria-label="Delete folder">
          <p>Delete this folder? Its chats and child folders move to the parent.</p>
          <button type="button" onClick={() => setDeleteFolderId(null)}>Cancel</button>
          <button type="button" disabled={controller.busy} onClick={() => { const id = deleteFolderId; setDeleteFolderId(null); void controller.actions.deleteFolder(id); }}>Delete folder</button>
        </div>
      ) : null}
    </section>
  );
}
