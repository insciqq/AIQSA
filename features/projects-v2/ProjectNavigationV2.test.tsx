import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectNavigationV2 } from "./ProjectNavigationV2";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

function projectController(input: Readonly<{
  manageProject?: boolean;
  mutateChats?: boolean;
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
      selectProject: vi.fn(async () => true),
      updateFolder: vi.fn(async () => true)
    }
  } as unknown as ProjectWorkspaceController;
  return { controller, createChat };
}

describe("Project navigation v2", () => {
  it("consolidates permitted folder commands in one accessible action menu", () => {
    const { controller, createChat } = projectController();
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={vi.fn()} />
    );

    expect(screen.queryByRole("button", { name: "+ chat" })).toBeNull();
    expect(screen.queryByRole("button", { name: "rename" })).toBeNull();
    expect(screen.queryByRole("button", { name: "delete" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Folder actions: Research" }));
    expect(screen.getByRole("menu", { name: "Folder actions: Research" })).toBeVisible();
    fireEvent.click(screen.getByRole("menuitem", { name: "New chat in folder" }));
    expect(createChat).toHaveBeenCalledWith("folder-1");
  });

  it("does not expose folder mutations to a read-only Project member", () => {
    const { controller } = projectController({ manageProject: false, mutateChats: false });
    render(
      <ProjectNavigationV2 activeChatId={null} controller={controller} onNavigate={vi.fn()} />
    );

    expect(screen.queryByRole("button", { name: "Folder actions: Research" })).toBeNull();
  });
});
