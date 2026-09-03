import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectDetailWire, ProjectSummaryWire } from "@/lib/contracts/projects";
import { ProjectOverviewPageV2, ProjectsLandingPageV2 } from "./ProjectsSurfaceV2";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

function summary(overrides: Partial<ProjectSummaryWire> = {}): ProjectSummaryWire {
  return {
    accessRevision: 1,
    audienceCount: 4,
    chatCount: 12,
    description: "Shared ingest decisions",
    directRole: "OWNER",
    effectiveRole: "OWNER",
    grantedThrough: [],
    id: "project-1",
    name: "Ingest pipeline",
    status: "ACTIVE",
    updatedAt: "2026-09-03T10:00:00.000Z",
    ...overrides
  };
}

function detail(overrides: Partial<ProjectDetailWire> = {}): ProjectDetailWire {
  return {
    ...summary(),
    capabilities: {
      archiveChats: true,
      manageMembers: true,
      manageMemory: true,
      manageOwners: true,
      manageProject: true,
      mutateChats: true
    },
    createdAt: "2026-09-01T10:00:00.000Z",
    defaults: {
      assistantId: null,
      controlValues: {},
      knowledgePlan: { baseIds: ["knowledge-1"], mode: "explicit", sourceIds: [], version: 1 },
      mcpMode: "auto",
      providerModelId: "model-1",
      searchPlan: { mode: "all_selected", optionIds: [] }
    },
    grants: [{
      createdAt: "2026-09-01T10:00:00.000Z",
      group: null,
      id: "grant-1",
      role: "OWNER",
      user: { displayName: "Maria K.", email: null, id: "user-1", status: "active" }
    }],
    instructions: "Keep decisions explicit.",
    instructionsRevision: 1,
    memoryEnabled: false,
    memoryRevision: 1,
    policy: { externalToolsEnabled: false },
    policyRevision: 1,
    publicSharingEnabled: false,
    readiness: "READY",
    resources: [
      {
        available: true,
        id: "model-binding",
        label: "GPT-5.6 Luna",
        modelId: "gpt-5.6-luna",
        provider: "openai-work",
        reason: null,
        resourceId: "model-1",
        type: "model"
      },
      {
        available: true,
        id: "knowledge-binding",
        label: "Ingest docs",
        reason: null,
        resourceId: "knowledge-1",
        type: "knowledge"
      }
    ],
    setupReasons: [],
    ...overrides
  };
}

function controller(input: Readonly<{
  activity?: ProjectWorkspaceController["activity"];
  detail?: ProjectDetailWire | null;
  listError?: string | null;
  listLoading?: boolean;
  projects?: readonly ProjectSummaryWire[];
  selectedProjectId?: string | null;
}> = {}): ProjectWorkspaceController {
  const project = input.detail === undefined ? detail() : input.detail;
  return {
    actionError: null,
    activity: input.activity === undefined ? {
      events: [{
        actorDisplayName: "Maria",
        createdAt: "2026-09-03T09:00:00.000Z",
        eventType: "project_folder_created",
        id: "event-1",
        metadata: {}
      }],
      nextCursor: null
    } : input.activity,
    activityError: null,
    busy: false,
    createOpen: false,
    detail: project,
    lastSyncedAt: null,
    listError: input.listError ?? null,
    listLoading: input.listLoading ?? false,
    memory: null,
    projects: input.projects ?? (project ? [project] : []),
    selectedProjectId: input.selectedProjectId === undefined ? project?.id ?? null : input.selectedProjectId,
    settingsInitialTab: "general",
    settingsOpen: false,
    syncState: input.listError ? "error" : "idle",
    syncWarning: null,
    workspace: { chats: [], folders: [] },
    actions: {
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
      loadActivity: vi.fn().mockResolvedValue(true),
      loadMoreActivity: vi.fn().mockResolvedValue(true),
      moveChat: vi.fn().mockResolvedValue(true),
      openCreate: vi.fn(),
      openSettings: vi.fn(),
      previewGrantRemoval: vi.fn().mockResolvedValue(null),
      previewResourceAdd: vi.fn().mockResolvedValue(null),
      previewResourceRemoval: vi.fn().mockResolvedValue(null),
      refresh: vi.fn().mockResolvedValue(true),
      refreshList: vi.fn().mockResolvedValue(true),
      removeGrant: vi.fn().mockResolvedValue(true),
      removeResource: vi.fn().mockResolvedValue(true),
      retrySync: vi.fn().mockResolvedValue(true),
      reviewMemoryProposal: vi.fn().mockResolvedValue(true),
      saveMemory: vi.fn().mockResolvedValue(true),
      selectChat: vi.fn().mockResolvedValue(true),
      selectProject: vi.fn().mockResolvedValue(true),
      updateFolder: vi.fn().mockResolvedValue(true),
      updateGrant: vi.fn().mockResolvedValue(true),
      updateProject: vi.fn().mockResolvedValue(true)
    }
  };
}

describe("Projects reading surfaces", () => {
  it("filters the truthful Project catalog and opens the selected card", () => {
    const projects = [
      summary(),
      summary({ effectiveRole: "CONTRIBUTOR", id: "project-2", name: "Support desk" }),
      summary({ id: "project-3", name: "Old launch", status: "ARCHIVED" })
    ];
    const projectController = controller({ detail: null, projects, selectedProjectId: null });
    render(<ProjectsLandingPageV2 controller={projectController} onBackToChat={vi.fn()} />);

    const filters = screen.getByRole("group", { name: "Project filters" });
    expect(within(filters).getByRole("button", { name: "All 2" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(within(filters).getByRole("button", { name: "Shared 1" }));
    expect(screen.getByTestId("project-card-project-2")).toBeVisible();
    expect(screen.queryByTestId("project-card-project-1")).toBeNull();

    fireEvent.click(screen.getByTestId("project-card-project-2"));
    expect(projectController.actions.selectProject).toHaveBeenCalledWith("project-2");

    fireEvent.click(within(filters).getByRole("button", { name: "Archived 1" }));
    expect(screen.getByTestId("project-card-project-3")).toBeVisible();
    expect(screen.queryByTestId("project-card-project-2")).toBeNull();
    expect(screen.queryByRole("searchbox", { name: "Search projects" })).toBeNull();
  });

  it("keeps the primary card action separate from its always-visible details action", async () => {
    const projectController = controller({ detail: null, projects: [summary()], selectedProjectId: null });
    render(<ProjectsLandingPageV2 controller={projectController} onBackToChat={vi.fn()} />);

    const primaryAction = screen.getByRole("button", { name: "Open Ingest pipeline" });
    const detailsAction = screen.getByRole("button", { name: "Open details for Ingest pipeline" });
    expect(primaryAction).not.toContainElement(detailsAction);

    fireEvent.click(detailsAction);
    await waitFor(() => {
      expect(projectController.actions.selectProject).toHaveBeenCalledWith("project-1");
      expect(projectController.actions.openSettings).toHaveBeenCalledWith("general");
    });
    expect(vi.mocked(projectController.actions.selectProject).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(projectController.actions.openSettings).mock.invocationCallOrder[0]!);
  });

  it("distinguishes a Project being deleted from an archived Project", () => {
    const projectController = controller({
      detail: null,
      projects: [
        summary({ id: "project-archived", name: "Archived room", status: "ARCHIVED" }),
        summary({ id: "project-deleting", name: "Deleting room", status: "DELETING" })
      ],
      selectedProjectId: null
    });
    render(<ProjectsLandingPageV2 controller={projectController} onBackToChat={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "Archived 2" }));
    expect(within(screen.getByTestId("project-card-project-archived")).getByText("Archived"))
      .toBeVisible();
    expect(within(screen.getByTestId("project-card-project-deleting")).getByText("Deleting"))
      .toBeVisible();
  });

  it("keeps project creation available in a genuinely empty installation", () => {
    const projectController = controller({ detail: null, projects: [], selectedProjectId: null });
    render(<ProjectsLandingPageV2 controller={projectController} onBackToChat={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "No projects yet" })).toBeVisible();
    const create = screen.getByRole("button", { name: "New project" });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(projectController.actions.openCreate).toHaveBeenCalledOnce();
    expect(screen.getByText(/finish its setup after creation/iu)).toBeVisible();
  });

  it("shows shared setup, direct access and observed activity with role-aware actions", async () => {
    const projectController = controller();
    const onStartChat = vi.fn();
    render(
      <ProjectOverviewPageV2
        composerSlot={<div>Project composer</div>}
        controller={projectController}
        onBackToChat={vi.fn()}
        onStartChat={onStartChat}
      />
    );

    expect(screen.getByRole("heading", { name: "Ingest pipeline" })).toBeVisible();
    expect(screen.getByText("GPT-5.6 Luna")).toBeVisible();
    expect(screen.getByText("Ingest docs")).toBeVisible();
    expect(screen.getByText("Maria K.")).toBeVisible();
    expect(screen.getByText(/Maria · Folder created/)).toBeVisible();
    expect(screen.getByText("Project composer")).toBeVisible();
    await waitFor(() => expect(projectController.actions.loadActivity).toHaveBeenCalledOnce());

    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(projectController.actions.openSettings).toHaveBeenCalledWith("resources");
    fireEvent.click(screen.getByRole("button", { name: "Manage" }));
    expect(projectController.actions.openSettings).toHaveBeenCalledWith("members");
    fireEvent.click(screen.getByRole("button", { name: "Start shared chat" }));
    expect(onStartChat).toHaveBeenCalledOnce();
  });

  it("does not present linked MCP or Search resources as ready when external tools are disabled", () => {
    const project = detail({
      defaults: {
        ...detail().defaults,
        mcpMode: "auto",
        searchPlan: { mode: "all_selected", optionIds: ["search-1"] }
      },
      policy: { externalToolsEnabled: false },
      resources: [
        ...detail().resources,
        {
          available: true,
          id: "mcp-binding",
          label: "GitHub · read-only",
          reason: null,
          resourceId: "mcp-1",
          type: "mcp"
        },
        {
          available: true,
          id: "search-binding",
          label: "Internet search",
          reason: null,
          resourceId: "search-1",
          type: "search"
        }
      ]
    });
    render(
      <ProjectOverviewPageV2
        controller={controller({ detail: project })}
        onBackToChat={vi.fn()}
        onStartChat={vi.fn()}
      />
    );

    const mcpRow = screen.getByText("MCP off").closest(".v2-project-setup-row");
    const searchRow = screen.getByText("Web search").closest(".v2-project-setup-row");
    expect(mcpRow).not.toBeNull();
    expect(searchRow).not.toBeNull();
    expect(within(mcpRow as HTMLElement).getByText(/external tools are disabled/iu)).toBeVisible();
    expect(within(mcpRow as HTMLElement).queryByText("Ready")).toBeNull();
    expect(within(searchRow as HTMLElement).getByText(/external tools are disabled/iu)).toBeVisible();
    expect(within(searchRow as HTMLElement).queryByText("Ready")).toBeNull();
  });

  it("does not collapse configured but hidden Project defaults into Off", () => {
    const project = detail({
      defaults: {
        ...detail().defaults,
        knowledgePlan: { baseIds: [], mode: "none", sourceIds: [], version: 1 },
        mcpMode: "off",
        providerModelId: null,
        searchPlan: { mode: "all_selected", optionIds: [] }
      },
      policy: { externalToolsEnabled: true },
      resources: [],
      unavailableDefaults: ["knowledge", "mcp", "model", "search"]
    });
    render(
      <ProjectOverviewPageV2
        controller={controller({ detail: project })}
        onBackToChat={vi.fn()}
        onStartChat={vi.fn()}
      />
    );

    for (const label of [
      "Default model unavailable",
      "Knowledge unavailable",
      "MCP unavailable",
      "Web search unavailable"
    ]) {
      const row = screen.getByText(label).closest(".v2-project-setup-row");
      expect(row).not.toBeNull();
      expect(within(row as HTMLElement).getByText("Unavailable")).toBeVisible();
    }
    expect(screen.queryByText("MCP off")).toBeNull();
    expect(screen.queryByText("Off for this Project")).toBeNull();
  });

  it("renders activity metadata and marks inactive access principals truthfully", () => {
    const project = detail({
      grants: [{
        createdAt: "2026-09-01T10:00:00.000Z",
        group: null,
        id: "grant-inactive-user",
        role: "VIEWER",
        user: { displayName: "Former member", email: null, id: "user-former", status: "inactive" }
      }, {
        createdAt: "2026-09-01T10:00:00.000Z",
        group: { archived: true, id: "group-old", name: "Former team" },
        id: "grant-archived-group",
        role: "CONTRIBUTOR",
        user: null
      }]
    });
    const activity: NonNullable<ProjectWorkspaceController["activity"]> = {
      events: [{
        actorDisplayName: "Maria",
        createdAt: "2026-09-03T09:00:00.000Z",
        eventType: "memory_policy_updated",
        id: "event-memory-policy",
        metadata: { enabled: false }
      }],
      nextCursor: null
    };
    render(
      <ProjectOverviewPageV2
        controller={controller({ activity, detail: project })}
        onBackToChat={vi.fn()}
        onStartChat={vi.fn()}
      />
    );

    expect(screen.getByText("Maria · Project Memory updated")).toBeVisible();
    expect(screen.getByText(/Disabled for future use/iu)).toBeVisible();
    expect(screen.getByText("Viewer · Inactive account")).toBeVisible();
    expect(screen.getByText("Contributor · Archived group")).toBeVisible();
  });

  it.each([
    {
      heading: "Archived Project",
      reason: /Archived Projects are read-only/iu,
      status: "ARCHIVED" as const
    },
    {
      heading: "Deletion in progress",
      reason: /Permanent deletion is in progress/iu,
      status: "DELETING" as const
    }
  ])("makes $status explicitly read-only with an assistive reason", ({ heading, reason, status }) => {
    render(
      <ProjectOverviewPageV2
        composerSlot={<div>Project composer</div>}
        controller={controller({ detail: detail({ status }) })}
        onBackToChat={vi.fn()}
        onStartChat={vi.fn()}
      />
    );

    const start = screen.getByRole("button", { name: "Start shared chat" });
    const reasonId = start.getAttribute("aria-describedby");
    expect(start).toBeDisabled();
    expect(reasonId).not.toBeNull();
    expect(document.getElementById(reasonId!)).toHaveTextContent(reason);
    expect(within(screen.getByRole("status")).getByText(heading)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
    expect(screen.queryByText("Project composer")).toBeNull();
  });

  it("keeps a Viewer useful without exposing write or management actions", () => {
    const viewer = detail({
      capabilities: {
        archiveChats: false,
        manageMembers: false,
        manageMemory: false,
        manageOwners: false,
        manageProject: false,
        mutateChats: false
      },
      directRole: "VIEWER",
      effectiveRole: "VIEWER"
    });
    render(
      <ProjectOverviewPageV2
        composerSlot={<div>Project composer</div>}
        controller={controller({ detail: viewer })}
        onBackToChat={vi.fn()}
        onStartChat={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Start shared chat" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Manage" })).toBeNull();
    expect(screen.queryByText("Project composer")).toBeNull();
    expect(screen.getByText(/Writing needs Contributor access/)).toBeVisible();
  });

  it("explains setup-required creation and routes an owner to its existing settings", () => {
    const setupRequired = detail({
      readiness: "SETUP_REQUIRED",
      setupReasons: ["shared_model_unavailable"]
    });
    const projectController = controller({ detail: setupRequired });
    render(
      <ProjectOverviewPageV2
        composerSlot={<div>Project composer</div>}
        controller={projectController}
        onBackToChat={vi.fn()}
        onStartChat={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "Start shared chat" })).toBeDisabled();
    expect(screen.queryByText("Project composer")).toBeNull();
    expect(screen.getByText(/active shared installation credential/)).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Finish setup" }));
    expect(projectController.actions.openSettings).toHaveBeenCalledWith("resources");
  });
});
