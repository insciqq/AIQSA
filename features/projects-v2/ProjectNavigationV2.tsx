"use client";

import { UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

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
          {controller.projects.map((project) => (
            <button
              aria-current={project.id === controller.selectedProjectId ? "page" : undefined}
              className="v2-project-row v2-focusable"
              data-selected={project.id === controller.selectedProjectId}
              key={project.id}
              type="button"
              onClick={() => {
                void controller.actions.selectProject(project.id);
                onNavigate();
              }}
            >
              <span className="v2-project-mark" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
              <span className="v2-project-row-copy">
                <span className="v2-chat-title">{project.name}</span>
                <span>{project.audienceCount} grants · {project.effectiveRole.toLowerCase()}</span>
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
                onClick={controller.actions.openSettings}
              />
            ) : null}
          </div>
          {controller.actionError ? <p className="v2-project-inline-error">{controller.actionError}</p> : null}
          {selected?.status === "ACTIVE" && selected.capabilities.mutateChats ? (
            <div className="v2-project-create-actions">
              <button
                className="v2-project-new-chat v2-focusable"
                disabled={controller.busy}
                type="button"
                onClick={() => {
                  void controller.actions.createChat();
                  onNavigate();
                }}
              >
                <UiV2Icon name="plus" /> New shared chat
              </button>
              <button
                className="v2-project-folder-create v2-focusable"
                disabled={controller.busy}
                type="button"
                onClick={() => {
                  const name = window.prompt("Folder name");
                  if (name?.trim()) void controller.actions.createFolder(name.trim());
                }}
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
              {selected?.capabilities.mutateChats ? "Start the first shared chat." : "No shared chats yet."}
            </p>
          ) : (
            <div className="v2-project-chat-list">
              {projectFolders.map((folder) => {
                const folderChats = chats.filter((chat) => chat.folderId === folder.id);
                return (
                  <section className="v2-project-folder" key={folder.id}>
                    <div className="v2-project-folder-heading">
                      <span>{folder.name}</span>
                      {selected?.status === "ACTIVE" && selected.capabilities.mutateChats ? <button disabled={controller.busy} type="button" onClick={() => void controller.actions.createChat(folder.id)}>+ chat</button> : null}
                      {selected?.status === "ACTIVE" && selected.capabilities.manageProject ? <button disabled={controller.busy} type="button" onClick={() => {
                        const name = window.prompt("Rename folder", folder.name);
                        if (name?.trim() && name.trim() !== folder.name) void controller.actions.updateFolder(folder.id, { name: name.trim() });
                      }}>rename</button> : null}
                      {selected?.status === "ACTIVE" && selected.capabilities.manageProject ? <button disabled={controller.busy} type="button" onClick={() => {
                        if (window.confirm(`Delete folder ${folder.name}? Its chats will move to the project root.`)) void controller.actions.deleteFolder(folder.id);
                      }}>delete</button> : null}
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
    </section>
  );
}
