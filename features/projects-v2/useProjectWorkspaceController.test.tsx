import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetComposerControlStoreForTest,
  resetComposerSessionStoreForTest,
  resetWorkspaceStoreForTest
} from "@/tests/support/appShellStores";
import { useComposerControlStore } from "@/components/app-shell/composerControlStore";
import {
  composerSessionKey,
  projectComposerSessionKey,
  selectComposerSession,
  useComposerSessionStore
} from "@/components/app-shell/composerSessionStore";
import { useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type {
  ProjectDetailWire,
  ProjectSummaryWire,
  ProjectWorkspaceResponseWire
} from "@/lib/contracts/projects";

const apiMocks = vi.hoisted(() => ({
  createProjectFolder: vi.fn(),
  deleteProjectFolder: vi.fn(),
  leaveProject: vi.fn(),
  loadProject: vi.fn(),
  loadProjectActivity: vi.fn(),
  loadProjectMemory: vi.fn(),
  loadProjects: vi.fn(),
  loadProjectWorkspace: vi.fn(),
  moveProjectChat: vi.fn(),
  removeProjectResource: vi.fn(),
  updateProjectFolder: vi.fn()
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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
    updatedAt: input.updatedAt ?? "2026-08-17T00:01:00.000Z",
    workspace: {
      available: true,
      enabled: false,
      internetEnabled: true,
      sessionState: null
    }
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
    activateProjectBlankWorkspace: vi.fn((projectId: string) => {
      useWorkspaceStore.getState().setActiveChatId(null);
      useComposerSessionStore.getState().activateSession(projectComposerSessionKey(projectId));
    }),
    activateChat,
    applyProjectDefaults: vi.fn(),
    isLocallyStreaming: vi.fn(() => false),
    onProjectContextEntered: vi.fn(),
    onProjectContextLeft: vi.fn(),
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
    resetComposerControlStoreForTest();
    resetComposerSessionStoreForTest();
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
    resetComposerControlStoreForTest();
    resetComposerSessionStoreForTest();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("refreshes settled Project attachments through its existing invalidation source", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    apiMocks.loadProjectWorkspace.mockResolvedValue({ chats: [projectChat({ id: "chat-1", title: "Plan" })], folders: [] });
    const input = controllerInput();
    const hook = renderHook(() => useProjectWorkspaceController(input));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      await hook.result.current.actions.selectProject("project-1");
    });
    await act(async () => { await hook.result.current.actions.selectChat("chat-1"); });
    input.refreshActiveChat.mockClear();
    await act(async () => {
      FakeEventSource.instances.at(-1)?.emit("project_changed", { category: "attachment_changed", chatId: "chat-1", revision: "11" });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(input.refreshActiveChat).toHaveBeenCalledExactlyOnceWith("chat-1", { forceDetail: true, preserveControls: true, resumeRuns: false });
    hook.unmount();
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

  it("leaves Project navigation by clearing its active chat without removing the member grant", async () => {
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
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(
      projectComposerSessionKey("project-1")
    );
    await act(async () => {
      expect(await result.current.actions.selectChat("chat-1")).toBe(true);
    });
    expect(useWorkspaceStore.getState().activeChatId).toBe("chat-1");
    act(() => result.current.actions.leave());

    expect(result.current.selectedProjectId).toBeNull();
    expect(input.activateBlankWorkspace).toHaveBeenCalledOnce();
    expect(useWorkspaceStore.getState().activeChatId).toBeNull();
    expect(input.onProjectContextEntered).toHaveBeenCalledOnce();
    expect(input.onProjectContextLeft).toHaveBeenCalledOnce();
    expect(apiMocks.leaveProject).not.toHaveBeenCalled();
    expect(useWorkspaceStore.getState().chats.some((chat) => chat.projectId === "project-1"))
      .toBe(true);
  });

  it("does not dispatch Manager-only folder or movement mutations for a Contributor", async () => {
    apiMocks.loadProjectWorkspace.mockResolvedValue({
      chats: [projectChat({ id: "chat-1", title: "Plan" })],
      folders: [{ id: "folder-1", name: "Research", parentId: null, sortOrder: 0 }]
    });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      expect(await result.current.actions.createFolder("Operations")).toBe(false);
      expect(await result.current.actions.updateFolder("folder-1", { name: "Evidence" }))
        .toBe(false);
      expect(await result.current.actions.deleteFolder("folder-1")).toBe(false);
      expect(await result.current.actions.moveChat("chat-1", "folder-1")).toBe(false);
    });

    expect(apiMocks.createProjectFolder).not.toHaveBeenCalled();
    expect(apiMocks.updateProjectFolder).not.toHaveBeenCalled();
    expect(apiMocks.deleteProjectFolder).not.toHaveBeenCalled();
    expect(apiMocks.moveProjectChat).not.toHaveBeenCalled();
  });

  it("sends one-level folder and movement mutations for a Manager", async () => {
    const managerDetail: ProjectDetailWire = {
      ...projectDetail,
      capabilities: {
        ...projectDetail.capabilities,
        archiveChats: true,
        manageProject: true
      },
      directRole: "MANAGER",
      effectiveRole: "MANAGER"
    };
    apiMocks.loadProject.mockResolvedValue(managerDetail);
    apiMocks.loadProjectWorkspace.mockResolvedValue({
      chats: [projectChat({ id: "chat-1", title: "Plan" })],
      folders: [{ id: "folder-1", name: "Research", parentId: null, sortOrder: 0 }]
    });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    await act(async () => {
      expect(await result.current.actions.createFolder("Operations")).toBe(true);
    });
    await act(async () => {
      expect(await result.current.actions.updateFolder("folder-1", { name: "Evidence" }))
        .toBe(true);
    });
    await act(async () => {
      expect(await result.current.actions.moveChat("chat-1", "folder-1")).toBe(true);
    });
    await act(async () => {
      expect(await result.current.actions.deleteFolder("folder-1")).toBe(true);
    });

    expect(apiMocks.createProjectFolder).toHaveBeenCalledWith("project-1", {
      name: "Operations",
      parentId: null
    });
    expect(apiMocks.updateProjectFolder).toHaveBeenCalledWith("project-1", "folder-1", {
      name: "Evidence"
    });
    expect(apiMocks.moveProjectChat).toHaveBeenCalledWith("chat-1", "folder-1");
    expect(apiMocks.deleteProjectFolder).toHaveBeenCalledWith("project-1", "folder-1");
  });

  it("enters the isolated control boundary before personal-to-Project and Project-A-to-B loads settle", async () => {
    const projectA = deferred<ProjectDetailWire>();
    const projectB = deferred<ProjectDetailWire>();
    apiMocks.loadProject.mockImplementation((projectId: string) =>
      projectId === "project-1" ? projectA.promise : projectB.promise
    );
    apiMocks.loadProjectWorkspace.mockResolvedValue({ chats: [], folders: [] });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    let selectingA!: Promise<boolean>;
    act(() => {
      selectingA = result.current.actions.selectProject("project-1");
    });
    expect(input.onProjectContextEntered).toHaveBeenCalledOnce();
    expect(result.current.selectedProjectId).toBe("project-1");
    expect(result.current.detail).toBeNull();

    await act(async () => {
      projectA.resolve(projectDetail);
      await expect(selectingA).resolves.toBe(true);
    });

    let selectingB!: Promise<boolean>;
    act(() => {
      selectingB = result.current.actions.selectProject("project-2");
    });
    expect(input.onProjectContextEntered).toHaveBeenCalledTimes(2);
    expect(result.current.selectedProjectId).toBe("project-2");
    expect(result.current.detail).toBeNull();

    await act(async () => {
      projectB.resolve({ ...projectDetail, id: "project-2", name: "Second room" });
      await expect(selectingB).resolves.toBe(true);
    });
    expect(result.current.detail?.id).toBe("project-2");
  });

  it("activates a personal blank before restoring exact controls when Project access ends", async () => {
    apiMocks.loadProjectWorkspace.mockResolvedValue({ chats: [], folders: [] });
    apiMocks.leaveProject.mockResolvedValue({ accessRemaining: false });
    const order: string[] = [];
    const input = controllerInput();
    input.activateBlankWorkspace.mockImplementation(() => {
      order.push("blank-default-resolution");
      useWorkspaceStore.getState().setActiveChatId(null);
    });
    input.onProjectContextLeft.mockImplementation(() => {
      order.push("restore-personal-controls");
    });
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    order.length = 0;
    await act(async () => {
      expect(await result.current.actions.leaveProject()).toBe(true);
    });

    expect(order).toEqual(["blank-default-resolution", "restore-personal-controls"]);
    expect(result.current.selectedProjectId).toBeNull();
  });

  it("transfers the first-send composer token without replacing manual Project controls", async () => {
    const readyProject = {
      ...projectDetail,
      resources: [{
        available: true,
        id: "model-binding-1",
        label: "Shared model",
        modelId: "model-1",
        provider: "openai",
        reason: null,
        resourceId: "model-1",
        type: "model" as const
      }]
    };
    apiMocks.loadProject.mockResolvedValue(readyProject);
    apiMocks.loadProjectWorkspace.mockResolvedValue({ chats: [], folders: [] });
    const input = controllerInput();
    input.applyProjectDefaults.mockImplementation(() => {
      useComposerControlStore.setState({
        knowledgePlanSource: "project",
        knowledgeSelection: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        selectedAssistant: null,
        selectedKnowledgeBaseIds: [],
        selectedModelId: "model-1",
        selectedProvider: "openai",
        selectedSearchOptionIds: []
      });
    });
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });
    const sourceKey = projectComposerSessionKey("project-1");
    useComposerControlStore.setState({
      knowledgePlanSource: "explicit",
      knowledgeSelection: {
        baseIds: ["manual-base"],
        mode: "explicit",
        sourceIds: ["manual-source"],
        version: 1
      },
      selectedAssistant: {
        avatar: {
          accents: [0],
          backgroundShape: "circle",
          foregroundShape: "diamond",
          kind: "generated",
          paletteId: "ocean",
          recipeVersion: 1,
          rotations: [0, 1]
        },
        description: "Manually selected for this question",
        id: "manual-assistant",
        name: "Manual assistant",
        promptCharacterCount: 38,
        starterPrompts: []
      },
      selectedKnowledgeBaseIds: ["manual-base"],
      selectedModelId: "manual-model",
      selectedProvider: "manual-provider",
      selectedSearchOptionIds: ["manual-search"]
    });
    useComposerSessionStore.getState().setDraft("First shared question");
    const sendToken = useComposerSessionStore.getState().beginSend(sourceKey)!;

    let created: Awaited<ReturnType<typeof result.current.actions.createChatForSend>> = null;
    await act(async () => {
      created = await result.current.actions.createChatForSend(null, sourceKey);
    });

    expect(created).toMatchObject({
      pendingProjectDraft: { folderId: null, projectId: "project-1" },
      projectId: "project-1"
    });
    expect(created!.workspace).toBeUndefined();
    const targetKey = composerSessionKey(created!.id);
    expect(useComposerSessionStore.getState().activeSessionKey).toBe(targetKey);
    expect(useComposerSessionStore.getState().sessionsByKey[sourceKey]).toBeUndefined();
    expect(selectComposerSession(useComposerSessionStore.getState(), targetKey).pendingSend)
      .toMatchObject({ draft: "First shared question", generation: sendToken.generation });
    expect(input.applyProjectDefaults).not.toHaveBeenCalled();
    expect(useComposerControlStore.getState()).toMatchObject({
      knowledgeSelection: {
        baseIds: ["manual-base"],
        sourceIds: ["manual-source"]
      },
      selectedAssistant: expect.objectContaining({ id: "manual-assistant" }),
      selectedKnowledgeBaseIds: ["manual-base"],
      selectedModelId: "manual-model",
      selectedProvider: "manual-provider",
      selectedSearchOptionIds: ["manual-search"]
    });

    useComposerSessionStore.getState().finishSend(
      sendToken,
      "failed",
      "Send failed. Your draft was preserved."
    );
    expect(selectComposerSession(useComposerSessionStore.getState(), targetKey)).toMatchObject({
      draft: "First shared question",
      operationError: "Send failed. Your draft was preserved.",
      pendingSend: null
    });

    await act(async () => {
      expect(await result.current.actions.createChat()).toBe(true);
    });
    expect(input.applyProjectDefaults).toHaveBeenCalledOnce();
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

  it("refreshes the selected Project summary without reordering the Projects list", async () => {
    const earlierProject: ProjectSummaryWire = {
      ...projectSummary,
      id: "project-2",
      name: "Earlier workspace",
      updatedAt: "2026-08-16T00:00:00.000Z"
    };
    apiMocks.loadProjects.mockResolvedValue([earlierProject, projectSummary]);
    apiMocks.loadProjectWorkspace.mockResolvedValue({ chats: [], folders: [] });
    apiMocks.loadProject.mockResolvedValue({
      ...projectDetail,
      name: "Launch room refreshed",
      updatedAt: "2026-08-18T00:00:00.000Z"
    });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.projects.map((project) => project.id)).toEqual([
      "project-2",
      "project-1"
    ]);

    await act(async () => {
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });

    expect(result.current.projects.map((project) => project.id)).toEqual([
      "project-2",
      "project-1"
    ]);
    expect(result.current.projects[1]?.name).toBe("Launch room refreshed");
  });

  it("does not reinsert a selected Project missing from the authoritative list", async () => {
    const listedProject: ProjectSummaryWire = {
      ...projectSummary,
      id: "project-2",
      name: "Still accessible"
    };
    apiMocks.loadProjects.mockResolvedValue([listedProject]);
    apiMocks.loadProjectWorkspace.mockResolvedValue({ chats: [], folders: [] });
    apiMocks.loadProject.mockResolvedValue({
      ...projectDetail,
      name: "Selected but absent from list"
    });
    const input = controllerInput();
    const { result } = renderHook(() => useProjectWorkspaceController(input));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.projects.map((project) => project.id)).toEqual(["project-2"]);

    await act(async () => {
      expect(await result.current.actions.selectProject("project-1")).toBe(true);
    });

    expect(result.current.detail?.name).toBe("Selected but absent from list");
    expect(result.current.projects.map((project) => project.id)).toEqual(["project-2"]);
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
