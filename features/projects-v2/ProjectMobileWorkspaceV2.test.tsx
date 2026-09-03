import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";
import { ProjectMobileWorkspaceV2 } from "./ProjectMobileWorkspaceV2";

function controller(selectResult = true): ProjectWorkspaceController {
  return {
    actionError: null,
    activity: null,
    activityError: null,
    busy: false,
    createOpen: false,
    detail: null,
    lastSyncedAt: null,
    listError: null,
    listLoading: false,
    memory: null,
    projects: [],
    selectedProjectId: "project-1",
    settingsInitialTab: "general",
    settingsOpen: false,
    syncState: "idle",
    syncWarning: null,
    workspace: {
      chats: [{
        activeLeafMessageId: null,
        activeRun: false,
        archived: false,
        createdAt: "2026-09-01T10:00:00.000Z",
        createdByDisplayName: "Maria",
        createdByUserId: "user-1",
        defaultKnowledgePlan: null,
        defaultModelId: null,
        defaultProvider: null,
        folderId: "folder-1",
        id: "chat-folder",
        messageCount: 4,
        pinned: false,
        projectId: "project-1",
        title: "Retry policy",
        updatedAt: "2026-09-03T09:00:00.000Z"
      }, {
        activeLeafMessageId: null,
        activeRun: false,
        archived: false,
        createdAt: "2026-09-01T10:00:00.000Z",
        createdByDisplayName: "Alex",
        createdByUserId: "user-2",
        defaultKnowledgePlan: null,
        defaultModelId: null,
        defaultProvider: null,
        folderId: null,
        id: "chat-root",
        messageCount: 2,
        pinned: false,
        projectId: "project-1",
        title: "Parser metrics",
        updatedAt: "2026-09-02T09:00:00.000Z"
      }],
      folders: [{ id: "folder-1", name: "Specs", parentId: null, sortOrder: 0 }]
    },
    actions: {
      refresh: vi.fn(async () => true),
      selectChat: vi.fn(async () => selectResult)
    }
  } as unknown as ProjectWorkspaceController;
}

describe("Project mobile workspace v2", () => {
  it("shows folder counts, unfiled chats, filtering, and successful navigation", async () => {
    const project = controller();
    const onNavigate = vi.fn();
    render(
      <ProjectMobileWorkspaceV2
        activeChatId={null}
        controller={project}
        onNavigate={onNavigate}
      />
    );

    expect(screen.getByRole("heading", { level: 2, name: "Chats" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Specs, 1 chat" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /Parser metrics/u })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: "Specs, 1 chat" }));
    fireEvent.click(screen.getByRole("button", { name: /Retry policy/u }));
    await waitFor(() => expect(onNavigate).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    const filter = screen.getByRole("searchbox", { name: "Filter project chats" });
    fireEvent.change(filter, { target: { value: "retry" } });
    expect(screen.getByRole("button", { name: /Retry policy/u })).toBeVisible();
    expect(screen.queryByRole("button", { name: /Parser metrics/u })).toBeNull();
    expect(screen.getByText("1 matching chats")).toBeInTheDocument();
    fireEvent.keyDown(filter, { key: "Escape" });
    expect(filter).toHaveValue("");
  });

  it("does not leave the overview when chat selection fails", async () => {
    const onNavigate = vi.fn();
    render(
      <ProjectMobileWorkspaceV2
        activeChatId={null}
        controller={controller(false)}
        onNavigate={onNavigate}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /Parser metrics/u }));
    await waitFor(() => {
      expect(onNavigate).not.toHaveBeenCalled();
    });
  });

  it("keeps loading, failure, and empty states distinct", () => {
    const loading = { ...controller(), workspace: null, syncState: "syncing" as const };
    const { rerender } = render(
      <ProjectMobileWorkspaceV2 activeChatId={null} controller={loading} onNavigate={vi.fn()} />
    );
    expect(screen.getByText("Opening shared chats…")).toBeVisible();

    const error = { ...loading, syncState: "error" as const };
    rerender(<ProjectMobileWorkspaceV2 activeChatId={null} controller={error} onNavigate={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Shared chats are unavailable.");

    const empty = { ...controller(), workspace: { chats: [], folders: [] } };
    rerender(<ProjectMobileWorkspaceV2 activeChatId={null} controller={empty} onNavigate={vi.fn()} />);
    expect(screen.getByText("No shared chats yet.")).toBeVisible();
    expect(within(screen.getByRole("region", { name: "Chats" })).queryByRole("list")).toBeNull();
  });
});
