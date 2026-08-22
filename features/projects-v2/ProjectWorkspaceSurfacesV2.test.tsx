import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectDetailWire, ProjectWorkspaceResponseWire } from "@/lib/contracts/projects";

const apiMocks = vi.hoisted(() => ({ loadProjectCandidates: vi.fn() }));
vi.mock("@/components/app-shell/projectWorkspaceApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/app-shell/projectWorkspaceApi")>()),
  ...apiMocks
}));

import {
  CreateProjectDialogV2,
  ProjectContextRailV2,
  ProjectSettingsDialogV2
} from "./ProjectWorkspaceSurfacesV2";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

const activeChat: ProjectWorkspaceResponseWire["chats"][number] = {
  activeRun: true,
  activeLeafMessageId: "message-1",
  archived: false,
  createdAt: "2026-08-17T00:00:00.000Z",
  createdByDisplayName: "Mira",
  createdByUserId: "user-2",
  defaultKnowledgePlan: {
    baseIds: ["knowledge-1"], mode: "explicit", sourceIds: [], version: 1
  },
  defaultModelId: "model-1",
  defaultProvider: "openai",
  folderId: null,
  id: "chat-1",
  messageCount: 3,
  pinned: false,
  projectId: "project-1",
  title: "Shared launch plan",
  updatedAt: "2026-08-17T00:02:00.000Z"
};

const archivedChat: ProjectWorkspaceResponseWire["chats"][number] = {
  ...activeChat,
  activeRun: false,
  archived: true,
  id: "chat-archived",
  title: "Earlier decision"
};

function projectDetail(role: "OWNER" | "VIEWER" = "OWNER"): ProjectDetailWire {
  const owner = role === "OWNER";
  return {
    accessRevision: 3,
    audienceCount: 4,
    capabilities: {
      archiveChats: owner,
      manageMembers: owner,
      manageMemory: owner,
      manageOwners: owner,
      manageProject: owner,
      mutateChats: owner
    },
    chatCount: 2,
    createdAt: "2026-08-17T00:00:00.000Z",
    defaults: {
      assistantId: null,
      controlValues: { maxOutputTokens: "2048", reasoningEffort: "medium" },
      knowledgePlan: {
        baseIds: ["knowledge-1"], mode: "explicit", sourceIds: [], version: 1
      },
      mcpMode: "auto",
      providerModelId: "model-1",
      searchPlan: { mode: "all_selected", optionIds: ["search-1"] }
    },
    description: "A real shared working table",
    directRole: role,
    effectiveRole: role,
    grantedThrough: [],
    grants: [{
      createdAt: "2026-08-17T00:00:00.000Z",
      group: null,
      id: "grant-1",
      role: "OWNER",
      user: { displayName: "Dana", email: "dana@example.test", id: "user-1", status: "active" }
    }],
    id: "project-1",
    instructions: "Keep decisions explicit.",
    instructionsRevision: 2,
    memoryEnabled: true,
    memoryRevision: 4,
    name: "Launch room",
    policy: { externalToolsEnabled: true },
    policyRevision: 5,
    publicSharingEnabled: false,
    resources: [
      { available: true, id: "model:model-1", label: "GPT shared", reason: null, resourceId: "model-1", type: "model" },
      { available: true, id: "knowledge-binding-1", label: "Launch notes", reason: null, resourceId: "knowledge-1", type: "knowledge" },
      { available: true, id: "search:search-db-1", label: "Web", reason: null, resourceId: "search-1", type: "search" },
      { available: true, id: "mcp:mcp-1", label: "Shared tools", reason: null, resourceId: "mcp-1", type: "mcp" }
    ],
    status: "ACTIVE",
    updatedAt: "2026-08-17T00:03:00.000Z"
  };
}

function controller(role: "OWNER" | "VIEWER" = "OWNER"): ProjectWorkspaceController {
  const actions: ProjectWorkspaceController["actions"] = {
    addGrant: vi.fn().mockResolvedValue(true),
    addResource: vi.fn().mockResolvedValue(true),
    archiveChat: vi.fn().mockResolvedValue(true),
    closeCreate: vi.fn(),
    closeSettings: vi.fn(),
    create: vi.fn().mockResolvedValue(true),
    createChat: vi.fn().mockResolvedValue(true),
    createChatForSend: vi.fn().mockResolvedValue(null),
    createFolder: vi.fn().mockResolvedValue(true),
    deleteFolder: vi.fn().mockResolvedValue(true),
    deleteProject: vi.fn().mockResolvedValue(true),
    editMemoryFact: vi.fn().mockResolvedValue(true),
    forgetMemoryFact: vi.fn().mockResolvedValue(true),
    leave: vi.fn(),
    leaveProject: vi.fn().mockResolvedValue(true),
    openCreate: vi.fn(),
    openSettings: vi.fn(),
    refresh: vi.fn().mockResolvedValue(true),
    refreshList: vi.fn().mockResolvedValue(true),
    retrySync: vi.fn().mockResolvedValue(true),
    previewGrantRemoval: vi.fn().mockResolvedValue(null),
    removeGrant: vi.fn().mockResolvedValue(true),
    previewResourceAdd: vi.fn().mockResolvedValue(null),
    previewResourceRemoval: vi.fn().mockResolvedValue(null),
    removeResource: vi.fn().mockResolvedValue(true),
    moveChat: vi.fn().mockResolvedValue(true),
    reviewMemoryProposal: vi.fn().mockResolvedValue(true),
    saveMemory: vi.fn().mockResolvedValue(true),
    selectChat: vi.fn().mockResolvedValue(true),
    selectProject: vi.fn().mockResolvedValue(true),
    updateGrant: vi.fn().mockResolvedValue(true),
    updateFolder: vi.fn().mockResolvedValue(true),
    updateProject: vi.fn().mockResolvedValue(true)
  };
  const detail = projectDetail(role);
  return {
    actionError: null,
    activity: { events: [], nextCursor: null },
    activityError: null,
    actions,
    busy: false,
    createOpen: false,
    detail,
    lastSyncedAt: Date.parse("2026-08-17T00:03:00.000Z"),
    listError: null,
    listLoading: false,
    memory: { enabled: true, facts: [], proposals: [], revision: 4 },
    projects: [detail],
    selectedProjectId: detail.id,
    settingsOpen: true,
    settingsInitialTab: "general",
    syncState: "idle",
    syncWarning: null,
    workspace: { chats: [activeChat, archivedChat], folders: [] }
  };
}

describe("Project workspace surfaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.loadProjectCandidates.mockResolvedValue({ items: [], nextCursor: null });
  });

  it("keeps the application interactive while the create dialog is closed", () => {
    const application = document.createElement("main");
    document.body.appendChild(application);
    const view = render(<CreateProjectDialogV2 controller={controller()} />);

    expect(screen.queryByRole("dialog", { name: "Create project" })).toBeNull();
    expect(application.inert).not.toBe(true);
    expect(application).not.toHaveAttribute("aria-hidden");
    expect(document.body.style.overflow).toBe("");

    view.unmount();
    application.remove();
  });

  it("keeps shared audience, role, personal-memory isolation, defaults, and live state permanently visible", () => {
    render(<ProjectContextRailV2 activeChatProjectId="project-1" controller={controller()} />);

    const rail = screen.getByRole("complementary", { name: "Shared project context" });
    expect(within(rail).getByText("Launch room")).toBeVisible();
    expect(within(rail).getByText("Shared with all project members · Personal Memory is off")).toBeVisible();
    expect(within(rail).getByText("owner")).toBeVisible();
    expect(within(rail).queryByText(/Project Memory/i)).toBeNull();
    expect(within(rail).getByText("Search 1 · Knowledge 1")).toBeVisible();
    expect(within(rail).getByText("Shared desk live")).toBeVisible();
  });

  it("keeps the retired Project Memory tab and controls unreachable", async () => {
    const projectController = controller();
    const initialTabController: ProjectWorkspaceController = {
      ...projectController,
      settingsInitialTab: "memory"
    };
    render(<ProjectSettingsDialogV2 controller={initialTabController} />);
    const dialog = await screen.findByRole("dialog", { name: "Launch room settings" });

    expect(within(dialog).queryByRole("button", { name: "Memory" })).toBeNull();
    expect(within(dialog).queryByText(/Project Memory|approved facts|propose/i)).toBeNull();
    expect(within(dialog).queryByRole("checkbox", { name: /Project Memory/i })).toBeNull();
    expect(within(dialog).getByRole("heading", { name: "Shared context" })).toBeVisible();
    expect(within(dialog).queryByRole("button", { name: /Add fact|Forget|Approve|Reject|Edit/ })).toBeNull();
  });

  it("lets an owner restore shared history while keeping lifecycle controls absent for a viewer", async () => {
    const ownerController = controller();
    const { unmount } = render(<ProjectSettingsDialogV2 controller={ownerController} />);
    const ownerDialog = await screen.findByRole("dialog", { name: "Launch room settings" });

    expect(within(ownerDialog).getByRole("heading", { name: "Archived chats" })).toBeVisible();
    fireEvent.click(within(ownerDialog).getByRole("button", { name: "Members" }));
    expect(within(ownerDialog).getByText("Your owner access comes from direct owner.")).toBeVisible();
    fireEvent.click(within(ownerDialog).getByRole("button", { name: "Project" }));
    fireEvent.click(within(ownerDialog).getByRole("button", { name: "Restore" }));
    expect(ownerController.actions.archiveChat).toHaveBeenCalledWith("chat-archived", false);
    expect(within(ownerDialog).getByRole("button", { name: "Archive project" })).toBeVisible();
    expect(within(ownerDialog).getByRole("button", { name: "Delete project" })).toBeVisible();
    unmount();

    const viewerController = controller("VIEWER");
    render(<ProjectSettingsDialogV2 controller={viewerController} />);
    const viewerDialog = await screen.findByRole("dialog", { name: "Launch room settings" });
    expect(within(viewerDialog).getByRole("heading", { name: "Archived chats" })).toBeVisible();
    expect(within(viewerDialog).queryByRole("button", { name: "Restore" })).toBeNull();
    expect(within(viewerDialog).queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(within(viewerDialog).queryByRole("button", { name: "Delete project" })).toBeNull();
  });

  it("uses filtered people candidates with loading-safe disabled reasons and pagination", async () => {
    apiMocks.loadProjectCandidates
      .mockResolvedValueOnce({
        items: [
          {
            description: "member@example.test",
            disabledReason: null,
            id: "candidate-member",
            label: "Project Member",
            type: "user"
          },
          {
            description: "already@example.test",
            disabledReason: "already_has_direct_access",
            id: "candidate-existing",
            label: "Existing Member",
            type: "user"
          }
        ],
        nextCursor: "2"
      })
      .mockResolvedValueOnce({
        items: [{
          description: "later@example.test",
          disabledReason: null,
          id: "candidate-later",
          label: "Later Member",
          type: "user"
        }],
        nextCursor: null
      });
    const projectController = controller();
    render(<ProjectSettingsDialogV2 controller={projectController} />);
    const dialog = await screen.findByRole("dialog", { name: "Launch room settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Members" }));

    expect(await within(dialog).findByRole("option", { name: /Project Member/ })).toBeEnabled();
    const disabled = within(dialog).getByRole("option", { name: /Existing Member/ });
    expect(disabled).toBeDisabled();
    expect(disabled).toHaveTextContent("Already has direct access");
    expect(within(dialog).queryByLabelText(/UUID|user id|group id/i)).toBeNull();

    fireEvent.click(within(dialog).getByRole("button", { name: "Load more" }));
    const later = await within(dialog).findByRole("option", { name: /Later Member/ });
    expect(later).toBeVisible();
    const listbox = within(dialog).getByRole("listbox", { name: "People" });
    fireEvent.keyDown(listbox, { key: "ArrowUp" });
    expect(later).toHaveFocus();
    within(dialog).getByRole("textbox", { name: "Search people" }).focus();
    fireEvent.keyDown(listbox, { key: "ArrowDown" });
    expect(within(dialog).getByRole("option", { name: /Project Member/ })).toHaveFocus();
    expect(apiMocks.loadProjectCandidates).toHaveBeenLastCalledWith(
      "project-1", "user", "", "2"
    );
  });

  it("preserves the active tab and dirty fields through a background Project revision", async () => {
    const first = controller();
    const view = render(<ProjectSettingsDialogV2 controller={first} />);
    const dialog = await screen.findByRole("dialog", { name: "Launch room settings" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Unsaved local title" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Activity" }));
    expect(within(dialog).getByRole("heading", { name: "Activity" })).toBeVisible();

    const canonical = controller();
    const updated: ProjectWorkspaceController = {
      ...canonical,
      detail: {
        ...canonical.detail!,
        instructions: "Changed by another manager.",
        instructionsRevision: 3,
        policyRevision: 6,
        updatedAt: "2026-08-17T00:04:00.000Z"
      }
    };
    view.rerender(<ProjectSettingsDialogV2 controller={updated} />);

    expect(within(dialog).getByRole("heading", { name: "Activity" })).toBeVisible();
    fireEvent.click(within(dialog).getByRole("button", { name: "Project" }));
    expect(within(dialog).getByRole("textbox", { name: "Name" })).toHaveValue("Unsaved local title");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close project settings" }));
    expect(await screen.findByRole("dialog", { name: /Discard Project settings changes/i })).toBeVisible();
  });

  it("keeps a conflicting draft for review and reloads canonical values only on request", async () => {
    const base = controller();
    const refresh = vi.fn().mockResolvedValue(true);
    const projectController: ProjectWorkspaceController = {
      ...base,
      actionError: "Project resources changed elsewhere. Review the current values and try again.",
      actions: { ...base.actions, refresh }
    };
    render(<ProjectSettingsDialogV2 controller={projectController} />);
    const dialog = await screen.findByRole("dialog", { name: "Launch room settings" });
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Conflicting local title" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Review / retry" }));
    expect(name).toHaveValue("Conflicting local title");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reload current values" }));

    expect(name).toHaveValue("Launch room");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("shows post-commit synchronization separately and retries without replaying the mutation", async () => {
    const base = controller();
    const retrySync = vi.fn().mockResolvedValue(true);
    const projectController: ProjectWorkspaceController = {
      ...base,
      actions: { ...base.actions, retrySync },
      syncWarning: "Change saved, but this Project view is not synchronized yet."
    };
    render(<ProjectSettingsDialogV2 controller={projectController} />);
    const dialog = await screen.findByRole("dialog", { name: "Launch room settings" });

    expect(within(dialog).getByRole("status")).toHaveTextContent("Change saved");
    fireEvent.click(within(dialog).getByRole("button", { name: "Retry sync" }));
    expect(retrySync).toHaveBeenCalledOnce();
  });

  it("formats paginated Activity without rendering private identifiers", async () => {
    const base = controller();
    const loadMoreActivity = vi.fn().mockResolvedValue(true);
    const projectController: ProjectWorkspaceController = {
      ...base,
      actions: { ...base.actions, loadMoreActivity },
      activity: {
        events: [{
          actorDisplayName: "Dana",
          createdAt: "2026-08-17T00:05:00.000Z",
          eventType: "resource_detached",
          id: "activity-1",
          metadata: {
            affectedChatCount: 2,
            clearedDefaultCount: 1,
            dependentAssistantCount: 1,
            resourceType: "knowledge"
          }
        }],
        nextCursor: "activity-1"
      }
    };
    render(<ProjectSettingsDialogV2 controller={projectController} />);
    const dialog = await screen.findByRole("dialog", { name: "Launch room settings" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Activity" }));

    expect(within(dialog).getByText("Shared resource removed")).toBeVisible();
    expect(within(dialog).getByText(/2 chat defaults cleared/)).toBeVisible();
    expect(dialog).not.toHaveTextContent("activity-1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(loadMoreActivity).toHaveBeenCalledTimes(1));
  });
});
