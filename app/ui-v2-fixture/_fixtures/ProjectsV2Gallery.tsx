"use client";

import { UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { ReadingRoomShellV2 } from "@/features/navigation-v2/NavigationV2";
import { ProjectNavigationV2 } from "@/features/projects-v2/ProjectNavigationV2";
import { ProjectMobileWorkspaceV2 } from "@/features/projects-v2/ProjectMobileWorkspaceV2";
import { ProjectsSurfaceV2 } from "@/features/projects-v2/ProjectsSurfaceV2";
import type { ProjectWorkspaceController } from "@/features/projects-v2/useProjectWorkspaceController";
import type {
  ProjectDetailWire,
  ProjectSummaryWire,
  ProjectWorkspaceResponseWire
} from "@/lib/contracts/projects";
import { useMemo, useRef, useState } from "react";

export type ProjectsGalleryStateV2 =
  | "contributor"
  | "empty"
  | "error"
  | "landing"
  | "overview"
  | "setup"
  | "viewer";

const projectSummaries: readonly ProjectSummaryWire[] = [
  {
    accessRevision: 4,
    audienceCount: 4,
    chatCount: 12,
    description: "Rewriting the document ingest path: parsers, retries and the reprocess flow.",
    directRole: "OWNER",
    effectiveRole: "OWNER",
    grantedThrough: [],
    id: "project-ingest",
    name: "Ingest pipeline",
    status: "ACTIVE",
    updatedAt: "2026-09-03T10:00:00.000Z"
  },
  {
    accessRevision: 2,
    audienceCount: 6,
    chatCount: 8,
    description: "Checklist, migration notes and the go/no-go for the December release.",
    directRole: "OWNER",
    effectiveRole: "OWNER",
    grantedThrough: [],
    id: "project-release",
    name: "Release 12.4",
    status: "ACTIVE",
    updatedAt: "2026-09-02T10:00:00.000Z"
  },
  {
    accessRevision: 3,
    audienceCount: 9,
    chatCount: 31,
    description: "Answers the support team drafts together before they go out.",
    directRole: "CONTRIBUTOR",
    effectiveRole: "CONTRIBUTOR",
    grantedThrough: [],
    id: "project-support",
    name: "Support desk",
    status: "ACTIVE",
    updatedAt: "2026-08-31T10:00:00.000Z"
  },
  {
    accessRevision: 8,
    audienceCount: 3,
    chatCount: 5,
    description: "Audits, sampling rules and the weekly quality report.",
    directRole: "CONTRIBUTOR",
    effectiveRole: "CONTRIBUTOR",
    grantedThrough: [],
    id: "project-quality",
    name: "Data quality",
    status: "ACTIVE",
    updatedAt: "2026-08-27T10:00:00.000Z"
  },
  {
    accessRevision: 1,
    audienceCount: 2,
    chatCount: 3,
    description: "An archived shared workspace.",
    directRole: "OWNER",
    effectiveRole: "OWNER",
    grantedThrough: [],
    id: "project-archive",
    name: "Legacy import",
    status: "ARCHIVED",
    updatedAt: "2026-07-03T10:00:00.000Z"
  }
];
const emptyProjectSummaries: readonly ProjectSummaryWire[] = [];

const workspace: ProjectWorkspaceResponseWire = {
  chats: [
    {
      activeRun: false,
      activeLeafMessageId: "message-1",
      archived: false,
      createdAt: "2026-09-01T10:00:00.000Z",
      createdByDisplayName: "Maria K.",
      createdByUserId: "user-maria",
      defaultKnowledgePlan: null,
      defaultModelId: "model-luna",
      defaultProvider: "openai-work",
      folderId: "folder-specs",
      id: "chat-retry",
      messageCount: 14,
      pinned: false,
      projectId: "project-ingest",
      title: "Retry policy",
      updatedAt: "2026-09-03T09:00:00.000Z"
    },
    {
      activeRun: false,
      activeLeafMessageId: "message-2",
      archived: false,
      createdAt: "2026-09-02T10:00:00.000Z",
      createdByDisplayName: "Alex",
      createdByUserId: "user-alex",
      defaultKnowledgePlan: null,
      defaultModelId: "model-luna",
      defaultProvider: "openai-work",
      folderId: null,
      id: "chat-metrics",
      messageCount: 7,
      pinned: false,
      projectId: "project-ingest",
      title: "Parser metrics",
      updatedAt: "2026-09-02T15:00:00.000Z"
    }
  ],
  folders: [{ id: "folder-specs", name: "Specs", parentId: null, sortOrder: 0 }]
};

function projectDetail(
  summary: ProjectSummaryWire,
  state: ProjectsGalleryStateV2
): ProjectDetailWire {
  const viewer = state === "viewer";
  const contributor = state === "contributor";
  const canManage = !viewer && !contributor;
  const setup = state === "setup";
  return {
    ...summary,
    capabilities: {
      archiveChats: canManage,
      manageMembers: canManage,
      manageMemory: canManage,
      manageOwners: canManage,
      manageProject: canManage,
      mutateChats: !viewer
    },
    createdAt: "2026-08-20T10:00:00.000Z",
    defaults: {
      assistantId: null,
      controlValues: {},
      knowledgePlan: { baseIds: ["knowledge-ingest"], mode: "explicit", sourceIds: [], version: 1 },
      mcpMode: "auto",
      providerModelId: setup ? null : "model-luna",
      searchPlan: { mode: "all_selected", optionIds: [] }
    },
    directRole: viewer ? "VIEWER" : contributor ? "CONTRIBUTOR" : summary.directRole,
    effectiveRole: viewer ? "VIEWER" : contributor ? "CONTRIBUTOR" : summary.effectiveRole,
    grants: [{
      createdAt: "2026-08-20T10:00:00.000Z",
      group: null,
      id: "grant-maria",
      role: "OWNER",
      user: { displayName: "Maria K.", email: null, id: "user-maria", status: "active" }
    }, {
      createdAt: "2026-08-21T10:00:00.000Z",
      group: { archived: false, id: "group-ingest", name: "Ingest team" },
      id: "grant-ingest-team",
      role: "CONTRIBUTOR",
      user: null
    }],
    instructions: "Keep migration and rollback decisions explicit.",
    instructionsRevision: 2,
    memoryEnabled: false,
    memoryRevision: 1,
    policy: { externalToolsEnabled: true },
    policyRevision: 2,
    publicSharingEnabled: false,
    readiness: setup ? "SETUP_REQUIRED" : "READY",
    resources: [
      ...(setup ? [] : [{
        available: true,
        id: "binding-model",
        label: "GPT-5.6 Luna",
        modelId: "gpt-5.6-luna",
        provider: "openai-work",
        reason: null,
        resourceId: "model-luna",
        type: "model" as const
      }]),
      {
        available: true,
        id: "binding-knowledge",
        label: "Ingest docs",
        reason: null,
        resourceId: "knowledge-ingest",
        type: "knowledge"
      },
      {
        available: true,
        id: "binding-mcp",
        label: "GitHub · read-only",
        reason: null,
        resourceId: "mcp-github",
        type: "mcp"
      }
    ],
    setupReasons: setup ? ["shared_model_unavailable"] : [],
    unavailableDefaults: setup ? ["model"] : []
  };
}

function ProjectComposerFixture() {
  const [draft, setDraft] = useState("");
  return (
    <div className="v2-composer-wrap">
      <div className="v2-composer" data-testid="project-composer-fixture">
        <label className="v2-composer-input-label" htmlFor="project-composer-fixture-input">
          Message
        </label>
        <textarea
          className="v2-composer-input"
          id="project-composer-fixture-input"
          placeholder="Message the project…"
          rows={1}
          value={draft}
          onChange={(event) => setDraft(event.currentTarget.value)}
        />
        <div className="v2-composer-controls">
          <div aria-label="Active capabilities" className="v2-composer-indicators">
            <button className="v2-composer-indicator v2-focusable" data-quiet="" type="button">
              <span aria-hidden="true" />
              Ingest docs
            </button>
            <button className="v2-composer-indicator v2-focusable" data-quiet="" type="button">
              <span aria-hidden="true" />
              Search off
            </button>
          </div>
          <span className="v2-composer-spacer" />
          <span className="v2-composer-run-action">
            <UiV2IconButton icon="arrow-up" label="Send" disabled={!draft.trim()} />
          </span>
        </div>
      </div>
    </div>
  );
}

export function ProjectsV2Gallery({ state = "landing" }: { state?: ProjectsGalleryStateV2 }) {
  const initialSelected = state === "contributor" || state === "overview" ||
    state === "setup" || state === "viewer"
    ? "project-ingest"
    : null;
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(initialSelected);
  const [activeChatId, setActiveChatId] = useState<string | null>(null);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [fixtureWorkspace, setFixtureWorkspace] = useState(workspace);
  const chatSequence = useRef(0);
  const folderSequence = useRef(0);
  const projects = state === "empty" || state === "error"
    ? emptyProjectSummaries
    : projectSummaries;
  const selectedSummary = projects.find((project) => project.id === selectedProjectId) ?? null;
  const detail = selectedSummary ? projectDetail(selectedSummary, state) : null;

  const controller = useMemo<ProjectWorkspaceController>(() => {
    const pass = async () => true;
    return {
      actionError: null,
      activity: detail ? {
        events: [{
          actorDisplayName: "Maria",
          createdAt: "2026-09-03T09:00:00.000Z",
          eventType: "project_folder_created",
          id: "event-folder",
          metadata: {}
        }, {
          actorDisplayName: "Alex",
          createdAt: "2026-09-02T15:00:00.000Z",
          eventType: "defaults_updated",
          id: "event-defaults",
          metadata: {}
        }],
        nextCursor: null
      } : null,
      activityError: null,
      busy: false,
      createOpen: false,
      detail,
      lastSyncedAt: null,
      listError: state === "error" ? "The Project catalog could not be loaded." : null,
      listLoading: false,
      memory: null,
      projects,
      selectedProjectId,
      settingsInitialTab: "general",
      settingsOpen: false,
      syncState: state === "error" ? "error" : "idle",
      syncWarning: null,
      workspace: detail ? fixtureWorkspace : null,
      actions: {
        addGrant: pass,
        addResource: pass,
        archiveChat: async (chatId, archived) => {
          setFixtureWorkspace((current) => ({
            ...current,
            chats: current.chats.map((chat) => chat.id === chatId ? { ...chat, archived } : chat)
          }));
          return true;
        },
        closeCreate: () => undefined,
        closeSettings: () => undefined,
        create: pass,
        createChat: async (folderId = null) => {
          const id = `chat-fixture-${++chatSequence.current}`;
          setFixtureWorkspace((current) => ({
            ...current,
            chats: [{
              ...workspace.chats[1]!,
              folderId,
              id,
              title: "New Chat"
            }, ...current.chats]
          }));
          setActiveChatId(id);
          return true;
        },
        createChatForSend: async () => null,
        createFolder: async (name) => {
          const id = `folder-fixture-${++folderSequence.current}`;
          setFixtureWorkspace((current) => ({
            ...current,
            folders: [...current.folders, {
              id,
              name,
              parentId: null,
              sortOrder: current.folders.length * 10 + 10
            }]
          }));
          return true;
        },
        deleteFolder: async (folderId) => {
          setFixtureWorkspace((current) => ({
            chats: current.chats.map((chat) => chat.folderId === folderId
              ? { ...chat, folderId: null }
              : chat),
            folders: current.folders.filter((folder) => folder.id !== folderId)
          }));
          return true;
        },
        deleteProject: pass,
        editMemoryFact: pass,
        forgetMemoryFact: pass,
        leave: () => {
          setSelectedProjectId(null);
          setActiveChatId(null);
        },
        leaveProject: pass,
        loadActivity: pass,
        loadMoreActivity: pass,
        moveChat: async (chatId, folderId) => {
          setFixtureWorkspace((current) => ({
            ...current,
            chats: current.chats.map((chat) => chat.id === chatId
              ? { ...chat, folderId }
              : chat)
          }));
          return true;
        },
        openCreate: () => undefined,
        openSettings: () => undefined,
        previewGrantRemoval: async () => null,
        previewResourceAdd: async () => null,
        previewResourceRemoval: async () => null,
        refresh: pass,
        refreshList: pass,
        removeGrant: pass,
        removeResource: pass,
        retrySync: pass,
        reviewMemoryProposal: pass,
        saveMemory: pass,
        selectChat: async (chatId) => {
          setActiveChatId(chatId);
          return true;
        },
        selectProject: async (projectId) => {
          setSelectedProjectId(projectId);
          setActiveChatId(null);
          return true;
        },
        updateFolder: async (folderId, patch) => {
          setFixtureWorkspace((current) => ({
            ...current,
            folders: current.folders.map((folder) => folder.id === folderId
              ? { ...folder, name: patch.name }
              : folder)
          }));
          return true;
        },
        updateGrant: pass,
        updateProject: pass
      }
    };
  }, [detail, fixtureWorkspace, projects, selectedProjectId, state]);

  return (
    <div data-state={state} data-testid="ui-v2-projects-gallery">
      <ReadingRoomShellV2
        chatActive={Boolean(activeChatId)}
        onLeaveProject={selectedProjectId ? controller.actions.leave : undefined}
        onNewChat={() => {
          controller.actions.leave();
          setProjectsOpen(false);
        }}
        onProjectsSectionChange={setProjectsOpen}
        onSelectChat={() => undefined}
        projectContextActive={Boolean(selectedProjectId)}
        projectTitle={detail ? (
          <span className="v2-project-column-identity">
            <span aria-hidden="true" className="v2-project-mark">{detail.name.slice(0, 1)}</span>
            <span>{detail.name}</span>
          </span>
        ) : "Projects"}
        projectsSectionOpen={projectsOpen}
        projectsSlot={(onNavigate, { landing }) => (
          <ProjectNavigationV2
            activeChatId={activeChatId}
            controller={controller}
            landing={landing}
            onNavigate={() => {
              onNavigate();
              setProjectsOpen(false);
            }}
          />
        )}
      >
        {projectsOpen ? (
          <ProjectsSurfaceV2
            composerSlot={<ProjectComposerFixture />}
            controller={controller}
            mobileNavigationSlot={selectedProjectId ? (
              <ProjectMobileWorkspaceV2
                activeChatId={activeChatId}
                controller={controller}
                onNavigate={() => setProjectsOpen(false)}
              />
            ) : null}
            onBackToChat={() => {
              setProjectsOpen(false);
              if (selectedProjectId && !activeChatId) controller.actions.leave();
            }}
            onStartChat={() => {
              void controller.actions.createChat().then(() => setProjectsOpen(false));
            }}
          />
        ) : (
          <main className="v2-navigation-fixture-main">
            <p className="v2-navigation-fixture-kicker">Shared conversation</p>
            <h1>{activeChatId ? "Parser metrics" : "Back in Chats"}</h1>
          </main>
        )}
      </ReadingRoomShellV2>
    </div>
  );
}
