import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetWorkspaceStoreForTest } from "@/tests/support/appShellStores";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type {
  ProjectDetailWire,
  ProjectSummaryWire,
  ProjectWorkspaceResponseWire
} from "@/lib/contracts/projects";

const apiMocks = vi.hoisted(() => ({
  leaveProject: vi.fn(),
  loadProject: vi.fn(),
  loadProjectActivity: vi.fn(),
  loadProjectMemory: vi.fn(),
  loadProjects: vi.fn(),
  loadProjectWorkspace: vi.fn(),
  removeProjectResource: vi.fn()
}));

vi.mock("@/components/app-shell/projectWorkspaceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/app-shell/projectWorkspaceApi")>()),
  ...apiMocks
}));

import {
  ProjectApiError,
  projectChatSummaryFromApi
} from "@/components/app-shell/projectWorkspaceApi";
import { useProjectWorkspaceController } from "./useProjectWorkspaceController";

const projectSummary: ProjectSummaryWire = {
  accessRevision: 1,
  audienceCount: 2,
  chatCount: 1,
  description: "One shared desk",
  directRole: "CONTRIBUTOR",
  effectiveRole: "CONTRIBUTOR",
  grantedThrough: [],
  id: "project-1",
  name: "Launch room",
  status: "ACTIVE",
  updatedAt: "2026-08-17T00:00:00.000Z"
};

const projectDetail: ProjectDetailWire = {
  ...projectSummary,
  capabilities: {
    archiveChats: false,
    manageMembers: false,
    manageMemory: false,
    manageOwners: false,
    manageProject: false,
    mutateChats: true
  },
  createdAt: "2026-08-17T00:00:00.000Z",
  defaults: {
    assistantId: null,
    controlValues: {},
    knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
    mcpMode: "off",
    providerModelId: "model-1",
    searchPlan: { mode: "all_selected", optionIds: [] }
  },
  grants: [],
  instructions: "Work together.",
  instructionsRevision: 1,
  memoryEnabled: true,
  memoryRevision: 1,
  policy: { externalToolsEnabled: true },
  policyRevision: 1,
  publicSharingEnabled: false,
  resources: []
};

function projectChat(input: {
  activeRun?: boolean;
  id: string;
  title: string;
  updatedAt?: string;
}): ProjectWorkspaceResponseWire["chats"][number] {
  return {
    activeRun: input.activeRun ?? false,
    activeLeafMessageId: "message-1",
    archived: false,
    createdAt: "2026-08-17T00:00:00.000Z",
    createdByDisplayName: "Alex",
    createdByUserId: "user-2",
    defaultKnowledgePlan: null,
    defaultModelId: "model-1",
    defaultProvider: "openai",
    folderId: null,
    id: input.id,
    messageCount: 2,
    pinned: false,
    projectId: "project-1",
    title: input.title,
    updatedAt: input.updatedAt ?? "2026-08-17T00:01:00.000Z"
  };
}

function controllerInput() {
  const activateChat = vi.fn((chat: { id: string }) => {
    useWorkspaceStore.getState().setActiveChatId(chat.id);
  });
  return {
    accountId: "user-1",
    activeChatId: null,
    activateBlankWorkspace: vi.fn(() => useWorkspaceStore.getState().setActiveChatId(null)),
    activateChat,
    applyProjectDefaults: vi.fn(),
    isLocallyStreaming: vi.fn(() => false),
    onProjectAccessLost: vi.fn(),
    refreshActiveChat: vi.fn().mockResolvedValue(null),
    setNotice: vi.fn()
  };
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Set<EventListener>>();
  onerror: ((event: Event) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListener): void {
    const bucket = this.listeners.get(type) ?? new Set<EventListener>();
    bucket.add(listener);
    this.listeners.set(type, bucket);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, data: unknown): void {
    const event = new MessageEvent(type, { data: JSON.stringify(data) });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {}
}

describe("useProjectWorkspaceController shared-desk reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetWorkspaceStoreForTest();
    apiMocks.loadProjects.mockResolvedValue([projectSummary]);
    apiMocks.loadProject.mockResolvedValue(projectDetail);
    apiMocks.loadProjectActivity.mockResolvedValue({ events: [], nextCursor: null });
    apiMocks.loadProjectMemory.mockResolvedValue({ enabled: true, facts: [], proposals: [], revision: 1 });
    FakeEventSource.instances = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("merges a safe SSE chat delta without refetching the whole Project workspace", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    apiMocks.loadProjectWorkspace.mockResolvedValue({
      chats: [projectChat({ id: "chat-1", title: "Plan" })],
      folders: []
    });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const stream = FakeEventSource.instances.at(-1);
    expect(stream?.url).toBe("/api/projects/project-1/events");
    const teammateChat = projectChat({ id: "chat-2", title: "Created live" });

    await act(async () => {
      stream?.emit("project_changed", {
        category: "chat_changed",
        chat: teammateChat,
        chatId: teammateChat.id,
        revision: "10"
      });
      stream?.emit("project_changed", {
        category: "chat_changed",
        chat: { ...teammateChat, title: "Stale replay" },
        chatId: teammateChat.id,
        revision: "9"
      });
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(result.current.workspace?.chats.find((chat) => chat.id === "chat-2")?.title)
      .toBe("Created live");
    expect(useWorkspaceStore.getState().chats.some((chat) => chat.id === "chat-2")).toBe(true);
    expect(apiMocks.loadProjectWorkspace).toHaveBeenCalledTimes(1);
  });

  it("does not read dormant Project Memory when shared Project settings open", async () => {
    apiMocks.loadProjectWorkspace.mockResolvedValue({ chats: [], folders: [] });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      result.current.actions.openSettings("general");
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(apiMocks.loadProjectMemory).not.toHaveBeenCalled();
    expect(result.current.memory).toBeNull();
    expect(apiMocks.loadProjectActivity).toHaveBeenCalled();
  });

  it("keeps the Project open when a stale resource target returns a typed 404", async () => {
    apiMocks.loadProjectWorkspace.mockResolvedValue({ chats: [], folders: [] });
    apiMocks.removeProjectResource.mockRejectedValueOnce(
      new ProjectApiError(404, "project_resource_not_found")
    );
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      expect(await result.current.actions.removeResource("stale-binding", 1)).toBe(false);
    });

    expect(result.current.selectedProjectId).toBe("project-1");
    expect(result.current.actionError).toBe("That Project resource is no longer linked.");
    expect(input.onProjectAccessLost).not.toHaveBeenCalled();
  });

  it("keeps a committed mutation successful when its canonical refresh fails", async () => {
    apiMocks.loadProjectWorkspace
      .mockResolvedValueOnce({ chats: [], folders: [] })
      .mockRejectedValueOnce(new Error("workspace temporarily unavailable"))
      .mockResolvedValueOnce({ chats: [], folders: [] });
    apiMocks.removeProjectResource.mockResolvedValueOnce(undefined);
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      expect(await result.current.actions.removeResource("binding-1", 1)).toBe(true);
    });

    expect(result.current.actionError).toBeNull();
    expect(result.current.syncWarning).toBe(
      "Change saved, but this Project view is not synchronized yet."
    );

    await act(async () => {
      expect(await result.current.actions.retrySync()).toBe(true);
    });
    expect(result.current.syncWarning).toBeNull();
  });

  it("leaves Project navigation without removing the member grant", async () => {
    apiMocks.loadProjectWorkspace.mockResolvedValue({
      chats: [projectChat({ id: "chat-1", title: "Plan" })],
      folders: []
    });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    act(() => result.current.actions.leave());

    expect(result.current.selectedProjectId).toBeNull();
    expect(apiMocks.leaveProject).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().chats.some((chat) => chat.projectId === "project-1"))
      .toBe(true);
  });

  it("discovers another member's chat and refreshes the open run projection without a manual reload", async () => {
    const firstWorkspace = { chats: [projectChat({ id: "chat-1", title: "Plan" })], folders: [] };
    const reconciledWorkspace = {
      chats: [
        projectChat({ activeRun: true, id: "chat-1", title: "Plan", updatedAt: "2026-08-17T00:02:00.000Z" }),
        projectChat({ id: "chat-2", title: "Created by a teammate" })
      ],
      folders: []
    };
    apiMocks.loadProjectWorkspace
      .mockResolvedValueOnce(firstWorkspace)
      .mockResolvedValueOnce(reconciledWorkspace);
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      expect(await result.current.actions.selectChat("chat-1")).toBe(true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(result.current.workspace?.chats.map((chat) => chat.id)).toEqual(["chat-1", "chat-2"]);
    expect(useWorkspaceStore.getState().chats.filter((chat) => chat.projectId === "project-1").map((chat) => chat.id))
      .toEqual(["chat-1", "chat-2"]);
    expect(input.refreshActiveChat).toHaveBeenCalledWith("chat-1", {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    });
    expect(input.activateChat).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "chat-1" }),
      { preserveControls: true, resumeRuns: true }
    );
  });

  it("closes the shared desk and purges cached chats when polling observes revocation", async () => {
    const firstWorkspace = { chats: [projectChat({ id: "chat-1", title: "Plan" })], folders: [] };
    apiMocks.loadProjectWorkspace
      .mockResolvedValueOnce(firstWorkspace)
      .mockRejectedValueOnce(new ProjectApiError(404, "project_not_found"));
    apiMocks.loadProject
      .mockResolvedValueOnce(projectDetail)
      .mockResolvedValueOnce(projectDetail)
      .mockRejectedValueOnce(new ProjectApiError(404, "project_not_found"));
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(useWorkspaceStore.getState().chats.some((chat) => chat.projectId === "project-1")).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(result.current.selectedProjectId).toBeNull();
    expect(useWorkspaceStore.getState().chats.some((chat) => chat.projectId === "project-1")).toBe(false);
    expect(input.onProjectAccessLost).toHaveBeenCalledWith(["chat-1"]);
    expect(input.setNotice).toHaveBeenCalledWith(expect.objectContaining({ kind: "error" }));
  });

  it("keeps cached Project state when a transient workspace 404 is not confirmed", async () => {
    const firstWorkspace = { chats: [projectChat({ id: "chat-1", title: "Plan" })], folders: [] };
    apiMocks.loadProjectWorkspace
      .mockResolvedValueOnce(firstWorkspace)
      .mockRejectedValueOnce(new ProjectApiError(404, "project_not_found"));
    apiMocks.loadProject
      .mockResolvedValueOnce(projectDetail)
      .mockResolvedValueOnce(projectDetail)
      .mockResolvedValueOnce(projectDetail);
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

    expect(result.current.selectedProjectId).toBe("project-1");
    expect(useWorkspaceStore.getState().chats.some((chat) => chat.projectId === "project-1"))
      .toBe(true);
    expect(input.onProjectAccessLost).not.toHaveBeenCalled();
  });

  it("purges cached chats for an unselected Project removed from the accessible list", async () => {
    apiMocks.loadProjects
      .mockResolvedValueOnce([projectSummary])
      .mockResolvedValueOnce([projectSummary]);
    apiMocks.loadProject.mockImplementation(async (projectId: string) => {
      if (projectId === "project-revoked") {
        throw new ProjectApiError(404, "project_not_found");
      }
      return projectDetail;
    });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    useWorkspaceStore.getState().updateChats(() => [{
      ...projectChatSummaryFromApi(projectChat({ id: "revoked-chat", title: "Revoked workspace" })),
      projectId: "project-revoked"
    }]);

    await act(async () => {
      expect(await result.current.actions.refreshList()).toBe(true);
    });

    expect(useWorkspaceStore.getState().chats).toEqual([]);
    expect(input.onProjectAccessLost).toHaveBeenCalledWith(["revoked-chat"]);
  });
});
