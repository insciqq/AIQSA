import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectChatSummaryWire,
  ProjectFolderWire,
  ProjectStatusWire,
  ProjectSummaryWire
} from "@/lib/contracts/projects";
import { ProjectNavigationV2 } from "./ProjectNavigationV2";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

function projectSummary(input: Readonly<{
  id: string;
  name: string;
  status?: ProjectStatusWire;
}>): ProjectSummaryWire {
  return {
    accessRevision: 1,
    audienceCount: 2,
    chatCount: 3,
    description: `${input.name} description`,
    directRole: "MANAGER",
    effectiveRole: "MANAGER",
    grantedThrough: [],
    id: input.id,
    name: input.name,
    status: input.status ?? "ACTIVE",
    updatedAt: "2026-09-03T09:00:00.000Z"
  };
}

function projectChat(input: Readonly<{
  folderId?: string | null;
  id: string;
  title: string;
}>): ProjectChatSummaryWire {
  return {
    activeLeafMessageId: null,
    activeRun: false,
    archived: false,
    createdAt: "2026-09-03T08:00:00.000Z",
    createdByDisplayName: "Alex",
    createdByUserId: "user-1",
    defaultKnowledgePlan: null,
    defaultModelId: null,
    defaultProvider: null,
    folderId: input.folderId ?? null,
    id: input.id,
    messageCount: 2,
    pinned: false,
    projectId: "project-1",
    title: input.title,
    updatedAt: "2026-09-03T09:00:00.000Z"
  };
}

function projectController(input: Readonly<{
  chats?: readonly ProjectChatSummaryWire[];
  createChatResult?: boolean;
  folders?: readonly ProjectFolderWire[];
  manageProject?: boolean;
  mutateChats?: boolean;
  projects?: readonly ProjectSummaryWire[];
  selected?: boolean;
  selectedStatus?: ProjectStatusWire;
  selectChatResult?: boolean;
  setupRequired?: boolean;
}> = {}) {
  const selected = input.selected ?? true;
  const chats = input.chats ?? [];
  const currentSummary = projectSummary({
    id: "project-1",
    name: "Test project",
    status: input.selectedStatus
  });
  const createChat = vi.fn(async () => input.createChatResult ?? true);
  const createFolder = vi.fn(async () => true);
  const archiveChat = vi.fn(async () => true);
  const deleteFolder = vi.fn(async () => true);
  const leave = vi.fn();
  const moveChat = vi.fn(async () => true);
  const openCreate = vi.fn();
  const selectChat = vi.fn(async () => input.selectChatResult ?? true);
  const selectProject = vi.fn(async () => true);
  const updateFolder = vi.fn(async () => true);
  const controller = {
    actionError: null,
    busy: false,
    detail: selected ? {
      ...currentSummary,
      capabilities: {
        archiveChats: input.manageProject ?? true,
        manageProject: input.manageProject ?? true,
        mutateChats: input.mutateChats ?? true
      },
      name: "Test project",
      readiness: input.setupRequired ? "SETUP_REQUIRED" : "READY"
    } : null,
    listError: null,
    listLoading: false,
    projects: input.projects ?? [currentSummary],
    selectedProjectId: selected ? "project-1" : null,
    syncState: "idle",
    syncWarning: null,
    workspace: selected ? {
      chats,
      folders: input.folders ?? [{ id: "folder-1", name: "Research", parentId: null, sortOrder: 0 }]
    } : null,
    actions: {
      archiveChat,
      createChat,
      createFolder,
      deleteFolder,
      leave,
      moveChat,
      openCreate,
      openSettings: vi.fn(),
      refresh: vi.fn(async () => true),
      refreshList: vi.fn(async () => true),
      retrySync: vi.fn(async () => true),
      selectChat,
      selectProject,
      updateFolder
    }
  } as unknown as ProjectWorkspaceController;
  return {
    archiveChat,
    controller,
    createChat,
    createFolder,
    deleteFolder,
    leave,
    moveChat,
    openCreate,
    selectChat,
    selectProject,
    updateFolder
  };
}

describe("Project navigation v2", () => {
  it("renders an exclusive, locally filtered list of active Projects", () => {
    const alpha = projectSummary({ id: "alpha", name: "Alpha" });
    const beta = projectSummary({ id: "beta", name: "Beta" });
    const closed = projectSummary({ id: "closed", name: "Closed research", status: "ARCHIVED" });
    const { controller, openCreate, selectProject } = projectController({
      projects: [alpha, closed, beta],
      selected: false
    });
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} landing onNavigate={vi.fn()} />
    );

    expect(screen.queryByRole("heading", { name: "Projects" })).toBeNull();
    expect(screen.getByRole("searchbox", { name: "Filter projects" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Alpha" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Beta" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Closed research" })).toBeNull();
    expect(screen.queryByRole("group", { name: "Project status" })).toBeNull();
    expect(screen.getAllByText("3 chats")).toHaveLength(2);
    expect(screen.queryByText(/members/u)).toBeNull();
    expect(screen.queryByText("manager")).toBeNull();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter projects" }), {
      target: { value: "beta" }
    });
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Closed research" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    expect(selectProject).toHaveBeenCalledWith("beta");

    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(openCreate).toHaveBeenCalledOnce();
  });

  it("stays out of the personal Chats column when Projects does not own it", () => {
    const { controller } = projectController({ selected: false });
    const { container } = render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={vi.fn()} />
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("keeps Project creation available in the empty list state", () => {
    const { controller, openCreate } = projectController({ projects: [], selected: false });
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} landing onNavigate={vi.fn()} />
    );

    expect(screen.getByText("No projects yet. Create one to start a shared workspace.")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(openCreate).toHaveBeenCalledOnce();
  });

  it("drills into one Project with back, local chat filter, tree, and footer creation", () => {
    const chats = [
      projectChat({ folderId: "folder-2", id: "shared", title: "Shared brief" }),
      projectChat({ id: "notes", title: "Open notes" })
    ];
    const { controller, leave } = projectController({
      chats,
      folders: [
        { id: "folder-1", name: "Research", parentId: null, sortOrder: 0 },
        { id: "folder-2", name: "Specs", parentId: "folder-1", sortOrder: 0 }
      ]
    });
    render(
      <ProjectNavigationV2 activeChatId="shared" controller={controller} onNavigate={vi.fn()} />
    );

    expect(screen.queryByRole("heading", { name: "Test project" })).toBeNull();
    expect(screen.getByRole("button", { name: "All projects" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New shared chat" })).toBeEnabled();
    expect(screen.getByRole("searchbox", { name: "Filter chats" })).toBeVisible();
    const tree = screen.getByRole("tree", { name: "Test project chats" });
    expect(tree).toBeVisible();
    expect(within(tree).getByRole("treeitem", { name: "Research, 0 chats" })).toHaveAttribute(
      "aria-level",
      "1"
    );
    expect(within(tree).getByRole("treeitem", { name: "Specs, 1 chat" })).toHaveAttribute(
      "aria-level",
      "1"
    );
    expect(within(tree).getByRole("treeitem", { name: "Shared brief" })).toHaveAttribute(
      "aria-level",
      "2"
    );
    expect(within(tree).getByRole("group", { name: "Chats" })).toBeVisible();
    expect(screen.getByRole("button", { name: "New folder" })).toBeVisible();

    fireEvent.change(screen.getByRole("searchbox", { name: "Filter chats" }), {
      target: { value: "notes" }
    });
    expect(screen.getByRole("treeitem", { name: "Open notes" })).toBeVisible();
    expect(screen.queryByRole("treeitem", { name: /Research/u })).toBeNull();
    expect(screen.queryByRole("treeitem", { name: "Shared brief" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "All projects" }));
    expect(leave).toHaveBeenCalledOnce();
  });

  it("consolidates permitted folder commands and navigates only after chat creation succeeds", async () => {
    const { controller, createChat } = projectController();
    const onNavigate = vi.fn();
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={onNavigate} />
    );

    expect(screen.getByRole("button", { name: "New chat in Research" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "New chat in Research" }));
    expect(createChat).toHaveBeenCalledWith("folder-1");
    await waitFor(() => expect(onNavigate).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Folder actions: Research" }));
    expect(screen.getByRole("menuitem", { name: "New chat in folder" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Rename folder" })).toBeVisible();
    expect(screen.getByRole("menuitem", { name: "Delete folder…" })).toBeVisible();
  });

  it("shares roving tree and Shift+F10 menu access across Project folders and chats", () => {
    const chat = projectChat({ folderId: "folder-1", id: "shared", title: "Shared brief" });
    const { archiveChat, controller, moveChat } = projectController({ chats: [chat] });
    render(
      <ProjectNavigationV2 activeChatId="shared" controller={controller} onNavigate={vi.fn()} />
    );

    const tree = screen.getByRole("tree", { name: "Test project chats" });
    const folder = within(tree).getByRole("treeitem", { name: "Research, 1 chat" });
    const projectChatRow = within(tree).getByRole("treeitem", { name: "Shared brief" });
    expect(projectChatRow).toHaveAttribute("tabindex", "0");
    projectChatRow.focus();
    fireEvent.keyDown(projectChatRow, { key: "ArrowLeft" });
    expect(folder).toHaveFocus();

    fireEvent.keyDown(folder, { key: "F10", shiftKey: true });
    expect(screen.getByRole("menu", { name: "Folder actions: Research" })).toBeVisible();
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "New chat in folder" }), {
      key: "Escape"
    });

    projectChatRow.focus();
    fireEvent.keyDown(projectChatRow, { key: "ContextMenu" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Move to…" }));
    expect([...screen.getByLabelText("Move to…").querySelectorAll("[role='menuitem']")]
      .map((item) => item.textContent)).toEqual(["Project root", "Research", "New folder…"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Project root" }));
    expect(moveChat).toHaveBeenCalledWith("shared", null);

    projectChatRow.focus();
    fireEvent.keyDown(projectChatRow, { key: "ContextMenu" });
    fireEvent.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(archiveChat).toHaveBeenCalledWith("shared", true);
  });

  it("creates and renames inline, cancels with Escape, and names folder deletion", async () => {
    const { controller, createFolder, deleteFolder, updateFolder } = projectController();
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={vi.fn()} />
    );

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const cancelledCreate = screen.getByRole("textbox", { name: "New folder name" });
    fireEvent.change(cancelledCreate, { target: { value: "Discard me" } });
    fireEvent.keyDown(cancelledCreate, { key: "Escape" });
    expect(createFolder).not.toHaveBeenCalled();
    expect(screen.queryByRole("textbox", { name: "New folder name" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    const createInput = screen.getByRole("textbox", { name: "New folder name" });
    fireEvent.change(createInput, { target: { value: "  Operations  " } });
    fireEvent.keyDown(createInput, { key: "Enter" });
    await waitFor(() => expect(createFolder).toHaveBeenCalledWith("Operations"));
    await waitFor(() => expect(screen.queryByRole("textbox", { name: "New folder name" })).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Folder actions: Research" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename folder" }));
    const renameInput = screen.getByRole("textbox", { name: "Folder name" });
    expect(renameInput).toHaveValue("Research");
    fireEvent.change(renameInput, { target: { value: "  Evidence  " } });
    fireEvent.keyDown(renameInput, { key: "Enter" });
    await waitFor(() => expect(updateFolder).toHaveBeenCalledWith("folder-1", {
      name: "Evidence"
    }));

    const folderMenu = screen.getByRole("button", { name: "Folder actions: Research" });
    fireEvent.click(folderMenu);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder…" }));
    const dialog = screen.getByRole("dialog", { name: "Delete folder Research" });
    expect(within(dialog).getByRole("heading", { name: "Delete “Research”?" })).toBeVisible();
    expect(within(dialog).getByText(/move to Project root/u)).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(folderMenu).toHaveFocus());
    expect(deleteFolder).not.toHaveBeenCalled();

    fireEvent.click(folderMenu);
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete folder…" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete folder Research" }));
    await waitFor(() => expect(deleteFolder).toHaveBeenCalledWith("folder-1"));
  });

  it("navigates after successful root creation and chat selection, never after failure", async () => {
    const successful = projectController({
      chats: [projectChat({ id: "shared", title: "Shared brief" })]
    });
    const onNavigate = vi.fn();
    const { unmount } = render(
      <ProjectNavigationV2
        activeChatId={null}
        controller={successful.controller}
        onNavigate={onNavigate}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "New shared chat" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("treeitem", { name: "Shared brief" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledTimes(2));
    expect(successful.selectChat).toHaveBeenCalledWith("shared");
    unmount();

    const failed = projectController({
      chats: [projectChat({ id: "failed", title: "Failed chat" })],
      createChatResult: false,
      selectChatResult: false
    });
    const failedNavigate = vi.fn();
    render(
      <ProjectNavigationV2
        activeChatId={null}
        controller={failed.controller}
        onNavigate={failedNavigate}
      />
    );
    fireEvent.click(screen.getByRole("button", { name: "New shared chat" }));
    fireEvent.click(screen.getByRole("treeitem", { name: "Failed chat" }));
    await waitFor(() => {
      expect(failed.createChat).toHaveBeenCalledOnce();
      expect(failed.selectChat).toHaveBeenCalledOnce();
    });
    expect(failedNavigate).not.toHaveBeenCalled();
  });

  it("keeps viewer chat access visible while removing creation and management", async () => {
    const chat = projectChat({ folderId: "folder-1", id: "shared", title: "Shared brief" });
    const { controller } = projectController({
      chats: [chat],
      manageProject: false,
      mutateChats: false
    });
    const onNavigate = vi.fn();
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={onNavigate} />
    );

    expect(screen.getByRole("button", { name: "New shared chat" })).toBeDisabled();
    expect(screen.getByText("Your Project role can view shared chats but cannot start one.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Folder actions: Research" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions: Shared brief" })).toBeNull();

    fireEvent.click(screen.getByRole("treeitem", { name: "Shared brief" }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledOnce());
  });

  it("lets Contributors start chats in existing folders without exposing Manager actions", () => {
    const chat = projectChat({ folderId: "folder-1", id: "shared", title: "Shared brief" });
    const { controller, createChat } = projectController({
      chats: [chat],
      manageProject: false,
      mutateChats: true
    });
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={vi.fn()} />
    );

    expect(screen.getByRole("button", { name: "New shared chat" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "New folder" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Actions: Shared brief" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Folder actions: Research" }));
    expect(screen.getByRole("menuitem", { name: "New chat in folder" })).toBeVisible();
    expect(screen.queryByRole("menuitem", { name: "Rename folder" })).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Delete folder…" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "New chat in folder" }));
    expect(createChat).toHaveBeenCalledWith("folder-1");
  });

  it("explains setup-required chat blocking without blocking folder organization", () => {
    const { controller } = projectController({ setupRequired: true });
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={vi.fn()} />
    );

    expect(screen.getByRole("button", { name: "New shared chat" })).toBeDisabled();
    expect(screen.getByText("Project setup is required before starting a shared chat.")).toBeVisible();
    expect(screen.getByRole("button", { name: "New folder" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Folder actions: Research" }));
    expect(screen.queryByRole("menuitem", { name: "New chat in folder" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "Rename folder" })).toBeVisible();
  });
});
