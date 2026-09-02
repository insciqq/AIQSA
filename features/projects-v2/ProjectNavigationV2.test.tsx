import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectNavigationV2 } from "./ProjectNavigationV2";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

function projectController(input: Readonly<{
  manageProject?: boolean;
  mutateChats?: boolean;
  setupRequired?: boolean;
}> = {}) {
  const createChat = vi.fn(async () => true);
  const controller = {
    actionError: null,
    busy: false,
    detail: {
      capabilities: {
        manageProject: input.manageProject ?? true,
        mutateChats: input.mutateChats ?? true
      },
      name: "Test project",
      readiness: input.setupRequired ? "SETUP_REQUIRED" : "READY",
      status: "ACTIVE"
    },
    listError: null,
    listLoading: false,
    projects: [{
      audienceCount: 2,
      effectiveRole: "MANAGER",
      id: "project-1",
      name: "Test project",
      status: "ACTIVE"
    }],
    selectedProjectId: "project-1",
    syncState: "idle",
    syncWarning: null,
    workspace: {
      chats: [],
      folders: [{ id: "folder-1", name: "Research", parentId: null }]
    },
    actions: {
      createChat,
      createFolder: vi.fn(async () => true),
      deleteFolder: vi.fn(async () => true),
      openCreate: vi.fn(),
      openSettings: vi.fn(),
      refresh: vi.fn(async () => true),
      refreshList: vi.fn(async () => true),
      retrySync: vi.fn(async () => true),
      selectProject: vi.fn(async () => true),
      updateFolder: vi.fn(async () => true)
    }
  } as unknown as ProjectWorkspaceController;
  return { controller, createChat };
}

describe("Project navigation v2", () => {
  it("consolidates permitted folder commands in one accessible action menu", () => {
    const { controller, createChat } = projectController();
    const onNavigate = vi.fn();
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={onNavigate} />
    );

    expect(screen.queryByRole("button", { name: "+ chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "delete" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Folder actions: Research" }));
    expect(screen.getByRole("menu", { name: "Folder actions: Research" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "New chat in folder" }));
    expect(createChat).toHaveBeenCalledWith("folder-1");
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("dismisses navigation after starting a root shared chat", () => {
    const { controller, createChat } = projectController();
    const onNavigate = vi.fn();
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={onNavigate} />
    );

    fireEvent.click(screen.getByRole("button", { name: "New shared chat" }));

    expect(createChat).toHaveBeenCalledWith();
    expect(onNavigate).toHaveBeenCalledOnce();
  });

  it("renders the Projects landing with an explanation, a text New project button and an empty state", () => {
    const { controller } = projectController();
    const empty = {
      ...controller,
      detail: null,
      projects: [],
      selectedProjectId: null
    } as unknown as ProjectWorkspaceController;
    render(
      <ProjectNavigationV2 activeChatId={null} controller={empty} landing onNavigate={vi.fn()} />
    );

    expect(screen.getByRole("heading", { level: 2, name: "Projects" })).toBeVisible();
    expect(screen.getByText(/A Project is a shared workspace/u)).toBeVisible();
    expect(screen.getByText("No projects yet. Your first Project appears here.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(empty.actions.openCreate).toHaveBeenCalledOnce();
  });

  it("offers one New project row when the sidebar section is empty", () => {
    const { controller } = projectController();
    const empty = {
      ...controller,
      detail: null,
      projects: [],
      selectedProjectId: null
    } as unknown as ProjectWorkspaceController;
    render(<ProjectNavigationV2 activeChatId={null} controller={empty} onNavigate={vi.fn()} />);

    expect(screen.queryByRole("heading", { level: 2 })).toBeNull();
    expect(screen.getByRole("button", { name: "Create project" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    expect(empty.actions.openCreate).toHaveBeenCalledOnce();
  });

  it("does not expose folder mutations to a read-only Project member", () => {
    const { controller } = projectController({ manageProject: false, mutateChats: false });
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={vi.fn()} />
    );

    expect(screen.queryByRole("button", { name: "Folder actions: Research" })).toBeNull();
  });

  it("blocks root and folder chat creation while Project setup is required", () => {
    const { controller, createChat } = projectController({ setupRequired: true });
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={vi.fn()} />
    );

    expect(screen.getByRole("button", { name: "New shared chat" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Folder actions: Research" }));
    expect(screen.queryByRole("menuitem", { name: "New chat in folder" })).toBeNull();
    expect(createChat).not.toHaveBeenCalled();
  });
});
