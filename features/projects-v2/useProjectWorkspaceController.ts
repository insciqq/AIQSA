"use client";

import {
  addProjectGrant,
  addProjectResource,
  createProject,
  createProjectFolder,
  deleteProjectFolder,
  deleteProject,
  editProjectMemoryFact,
  forgetProjectMemoryFact,
  loadProject,
  loadProjectActivity,
  leaveProject,
  loadProjects,
  moveProjectChat,
  loadProjectWorkspace,
  previewProjectResourceChange,
  previewProjectGrantRemoval,
  ProjectApiError,
  projectChatSummaryFromApi,
  removeProjectGrant,
  removeProjectResource,
  reviewProjectMemoryProposal,
  saveProjectMemoryText,
  setProjectChatArchived,
  updateProjectFolder,
  updateProject,
  updateProjectGrant
} from "@/components/app-shell/projectWorkspaceApi";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import {
  composerSessionKey,
  useComposerSessionStore,
  type ComposerSessionKey
} from "@/components/app-shell/composerSessionStore";
import type { Notice, WorkspaceChatSummary } from "@/components/app-shell/types";
import { sortChatsByFavoriteThenUpdatedAt, useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import { mergeWorkspaceProjectDrafts } from "@/components/app-shell/workspaceProjectDraftMerge";
import type {
  ProjectActivityResponseWire,
  ProjectChatSummaryWire,
  ProjectDetailWire,
  ProjectMemoryResponseWire,
  ProjectGrantRemovalPreviewWire,
  ProjectResourceChangePreviewWire,
  ProjectSummaryWire,
  ProjectWorkspaceResponseWire,
  UpdateProjectRequestWire
} from "@/lib/contracts/projects";
import { decodeProjectChat } from "@/lib/contracts/projects";
import type { ProjectRole } from "@/lib/domain/projects";
import { useEffect, useRef, useState } from "react";

const PROJECT_ACTIVE_FALLBACK_INTERVAL_MS = 1_500;
const PROJECT_IDLE_FALLBACK_INTERVAL_MS = 7_500;
const PROJECT_LIST_SYNC_INTERVAL_MS = 25_000;
const PROJECT_SYNC_WARNING = "Change saved, but this Project view is not synchronized yet.";

export type ProjectWorkspaceController = Readonly<{
  actionError: string | null;
  activity: ProjectActivityResponseWire | null;
  activityError: string | null;
  busy: boolean;
  createOpen: boolean;
  detail: ProjectDetailWire | null;
  lastSyncedAt: number | null;
  listError: string | null;
  listLoading: boolean;
  memory: ProjectMemoryResponseWire | null;
  projects: readonly ProjectSummaryWire[];
  selectedProjectId: string | null;
  settingsOpen: boolean;
  settingsInitialTab: "activity" | "general" | "members" | "memory" | "resources";
  syncState: "error" | "idle" | "syncing";
  syncWarning: string | null;
  workspace: ProjectWorkspaceResponseWire | null;
  actions: Readonly<{
    addGrant(input: { groupId?: string; role: ProjectRole; userId?: string }): Promise<boolean>;
    addResource(input: { expectedPolicyRevision?: number; resourceId: string; revisionId?: string; type: "assistant" | "knowledge" | "mcp" | "model" | "search" | "skill" }): Promise<boolean>;
    archiveChat(chatId: string, archived: boolean): Promise<boolean>;
    closeCreate(): void;
    closeSettings(): void;
    create(name: string, description?: string): Promise<boolean>;
    createChat(folderId?: string | null): Promise<boolean>;
    /** Creates and activates a shared chat for the first-send path. */
    createChatForSend(
      folderId?: string | null,
      sourceSessionKey?: ComposerSessionKey
    ): Promise<WorkspaceChatSummary | null>;
    createFolder(name: string): Promise<boolean>;
    deleteFolder(folderId: string): Promise<boolean>;
    deleteProject(): Promise<boolean>;
    editMemoryFact(factId: string, text: string, validUntil?: string | null): Promise<boolean>;
    forgetMemoryFact(factId: string): Promise<boolean>;
    /** Leave the selected Project workspace without changing membership. */
    leave(): void;
    /** Remove the current member's direct Project grant after confirmation. */
    leaveProject(): Promise<boolean>;
    openCreate(): void;
    openSettings(tab?: "activity" | "general" | "members" | "memory" | "resources"): void;
    refresh(): Promise<boolean>;
    retrySync(): Promise<boolean>;
    refreshList(): Promise<boolean>;
    loadActivity?(): Promise<boolean>;
    loadMoreActivity?(): Promise<boolean>;
    previewGrantRemoval(grantId: string): Promise<ProjectGrantRemovalPreviewWire | null>;
    removeGrant(grantId: string, expectedAccessRevision?: number): Promise<boolean>;
    previewResourceAdd(resourceId: string): Promise<ProjectResourceChangePreviewWire | null>;
    previewResourceRemoval(bindingId: string): Promise<ProjectResourceChangePreviewWire | null>;
    removeResource(bindingId: string, expectedPolicyRevision?: number): Promise<boolean>;
    moveChat(chatId: string, folderId: string | null): Promise<boolean>;
    reviewMemoryProposal(proposalId: string, approve: boolean): Promise<boolean>;
    saveMemory(text: string, direct: boolean, sourceMessageId?: string, validUntil?: string | null): Promise<boolean>;
    selectChat(chatId: string): Promise<boolean>;
    selectProject(projectId: string): Promise<boolean>;
    updateGrant(grantId: string, role: ProjectRole): Promise<boolean>;
    updateFolder(folderId: string, patch: { name: string }): Promise<boolean>;
    updateProject(patch: UpdateProjectRequestWire): Promise<boolean>;
  }>;
}>;

type ControllerInput = Readonly<{
  accountId: string;
  activeChatId: string | null;
  activateBlankWorkspace(): void;
  activateProjectBlankWorkspace(projectId: string): void;
  activateChat(
    chat: WorkspaceChatSummary,
    options?: { preserveControls?: boolean; resumeRuns?: boolean }
  ): Promise<unknown> | unknown;
  applyProjectDefaults(project: ProjectDetailWire, chat: WorkspaceChatSummary): void;
  isLocallyStreaming(chatId: string): boolean;
  onProjectContextEntered(): void;
  onProjectContextLeft(): void;
  onProjectAccessLost(chatIds: readonly string[]): void;
  preferredModelId?: string;
  refreshActiveChat(
    chatId: string,
    options?: { forceDetail?: boolean; preserveControls?: boolean; resumeRuns?: boolean }
  ): Promise<unknown>;
  setNotice(notice: Notice): void;
}>;

function projectError(error: unknown): string {
  const code = error instanceof Error ? error.message : "project_request_failed";
  const known: Record<string, string> = {
    grant_role_not_permitted: "Your role cannot make that membership change.",
    last_owner_required: "A project must keep at least one direct owner.",
    project_archived: "Archived projects are read-only.",
    project_memory_disabled: "Project Memory is disabled.",
    project_group_not_found: "That group is no longer available.",
    project_user_not_found: "That person is no longer available.",
    project_not_found: "This project is no longer available.",
    project_model_unavailable: "That model is not available for Projects.",
    project_search_unavailable: "That Search option is not available for Projects.",
    project_skill_unavailable: "That Skill can no longer be published here.",
    project_mcp_unavailable: "That MCP server is not available for Projects.",
    project_mcp_shared_configuration_required: "That MCP server needs shared or no-auth configuration.",
    project_knowledge_unavailable: "That Knowledge Base can no longer be published here.",
    project_assistant_unavailable: "That Assistant can no longer be published here.",
    project_assistant_dependency_unavailable: "That Assistant has a dependency that cannot be published to this Project.",
    project_resource_not_found: "That Project resource is no longer linked.",
    project_grant_not_found: "That access grant is no longer present.",
    project_direct_access_not_found: "Your access comes only from groups and cannot be removed here.",
    project_owner_cannot_leave: "Project owners must transfer ownership before removing their direct access.",
    instructions_revision_conflict: "Project instructions changed elsewhere. Review the preserved draft and try again.",
    memory_revision_conflict: "Project Memory settings changed elsewhere. Review the preserved draft and try again.",
    policy_revision_conflict: "Project resources changed elsewhere. Review the current values and try again.",
    access_revision_conflict: "Project membership changed elsewhere. Review the current values and try again.",
    project_update_conflict: "The Project changed elsewhere. Review the preserved draft and try again.",
    project_default_resource_unavailable: "A selected Project default changed elsewhere and is no longer available. Review the current resources and try again.",
    project_external_tools_disabled: "Search and MCP defaults must be off while external tools are disabled.",
    project_folder_conflict: "That folder changed elsewhere. Review the current folders and try again.",
    project_folder_not_found: "That folder is no longer available.",
    owner_role_required: "Only a Project Owner can change lifecycle or public-sharing settings.",
    resource_binding_conflict: "That resource is already linked or no longer available."
  };
  return known[code] ?? "Could not update the project. Try again.";
}

function summaryFromDetail(project: ProjectDetailWire): ProjectSummaryWire {
  const {
    capabilities: _capabilities,
    composer: _composer,
    createdAt: _createdAt,
    defaults: _defaults,
    fileCount: _fileCount,
    grants: _grants,
    instructions: _instructions,
    instructionsRevision: _instructionsRevision,
    memoryEnabled: _memoryEnabled,
    memoryRevision: _memoryRevision,
    policy: _policy,
    policyRevision: _policyRevision,
    publicSharingEnabled: _publicSharingEnabled,
    readiness: _readiness,
    resources: _resources,
    setupReasons: _setupReasons,
    ...summary
  } = project;
  return summary;
}

export function useProjectWorkspaceController(input: ControllerInput): ProjectWorkspaceController {
  const [projects, setProjects] = useState<readonly ProjectSummaryWire[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [detail, setDetail] = useState<ProjectDetailWire | null>(null);
  const [workspace, setWorkspace] = useState<ProjectWorkspaceResponseWire | null>(null);
  const [memory, setMemory] = useState<ProjectMemoryResponseWire | null>(null);
  const [activity, setActivity] = useState<ProjectActivityResponseWire | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    "activity" | "general" | "members" | "memory" | "resources"
  >("general");
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<"error" | "idle" | "syncing">("idle");
  const [syncWarning, setSyncWarning] = useState<string | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [realtimeConnected, setRealtimeConnected] = useState(false);
  const selectedRef = useRef<string | null>(null);
  const settingsOpenRef = useRef(false);
  const refreshPromiseRef = useRef<{ projectId: string; promise: Promise<boolean> } | null>(null);
  const settingsRefreshPromiseRef = useRef<{ projectId: string; promise: Promise<void> } | null>(null);
  const settingsRefreshQueuedRef = useRef(false);
  const realtimeChatRevisionsRef = useRef(new Map<string, bigint>());

  const removeProjectCache = useEventCallback((projectId: string) => {
    const store = useWorkspaceStore.getState();
    const chatIds = store.chats
      .filter((chat) => chat.projectId === projectId)
      .map((chat) => chat.id);
    store.updateChats((current) => current.filter((chat) => chat.projectId !== projectId));
    input.onProjectAccessLost(chatIds);
    if (store.activeChatId && chatIds.includes(store.activeChatId)) input.activateBlankWorkspace();
  });

  const reconcileWorkspace = useEventCallback((
    projectId: string,
    next: ProjectWorkspaceResponseWire
  ): ProjectWorkspaceResponseWire => {
    const summaries = next.chats.map(projectChatSummaryFromApi);
    const store = useWorkspaceStore.getState();
    const merged = mergeWorkspaceProjectDrafts({
      currentChats: store.chats,
      currentProjectChats: workspace?.chats,
      incomingChats: summaries,
      incomingProjectChats: next.chats,
      projectId
    });
    store.setChats(merged.chats);
    return { ...next, chats: merged.projectChats ?? next.chats };
  });

  const mergeRealtimeChat = useEventCallback((
    projectId: string,
    chat: ProjectChatSummaryWire,
    revision: string
  ): boolean => {
    if (selectedRef.current !== projectId || chat.projectId !== projectId || !/^\d+$/u.test(revision)) {
      return false;
    }
    const cursor = BigInt(revision);
    const previous = realtimeChatRevisionsRef.current.get(chat.id);
    if (previous !== undefined && cursor <= previous) return false;
    realtimeChatRevisionsRef.current.set(chat.id, cursor);
    setWorkspace((current) => current && selectedRef.current === projectId
      ? {
          ...current,
          chats: [chat, ...current.chats.filter((candidate) => candidate.id !== chat.id)].sort(
            (left, right) => Number(left.archived) - Number(right.archived) ||
              right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id)
          )
        }
      : current);
    const summary = projectChatSummaryFromApi(chat);
    useWorkspaceStore.getState().updateChats((current) => {
      const existing = current.find((candidate) => candidate.id === chat.id);
      return sortChatsByFavoriteThenUpdatedAt([
        ...current.filter((candidate) => candidate.id !== chat.id),
        { ...existing, ...summary, pendingProjectDraft: undefined }
      ]);
    });
    return true;
  });

  const refreshRealtimeChat = useEventCallback((chatId: string): void => {
    if (input.isLocallyStreaming(chatId)) return;
    void input.refreshActiveChat(chatId, {
      forceDetail: true,
      preserveControls: true,
      resumeRuns: false
    });
  });

  const handleLostAccess = useEventCallback(async (projectId: string, notify = true) => {
    removeProjectCache(projectId);
    realtimeChatRevisionsRef.current.clear();
    setProjects((current) => current.filter((project) => project.id !== projectId));
    if (selectedRef.current === projectId) {
      selectedRef.current = null;
      setSelectedProjectId(null);
      setDetail(null);
      setWorkspace(null);
      setMemory(null);
      setActivity(null);
      setActivityError(null);
      settingsOpenRef.current = false;
      setSettingsOpen(false);
      input.activateBlankWorkspace();
      // Blank personal activation may resolve catalog defaults when no
      // Assistant is selected. Restore the exact pre-Project controls last.
      input.onProjectContextLeft();
      if (notify) {
        input.setNotice({ kind: "error", text: "Project access changed. The shared workspace was closed." });
      }
    }
    setSyncWarning(null);
  });

  const confirmProjectAccessLost = useEventCallback(async (projectId: string): Promise<boolean> => {
    try {
      await loadProject(projectId);
      return false;
    } catch (error) {
      return error instanceof ProjectApiError && error.code === "project_not_found";
    }
  });

  const refreshList = useEventCallback(async (quiet = false): Promise<boolean> => {
    if (!quiet) setListLoading(true);
    try {
      const next = await loadProjects();
      const accessibleProjectIds = new Set(next.map((project) => project.id));
      const cachedProjectIds = new Set(
        useWorkspaceStore.getState().chats.flatMap((chat) => chat.projectId ? [chat.projectId] : [])
      );
      const selected = selectedRef.current;
      for (const projectId of cachedProjectIds) {
        if (
          !accessibleProjectIds.has(projectId) && projectId !== selected &&
          await confirmProjectAccessLost(projectId)
        ) {
          removeProjectCache(projectId);
        }
      }
      setProjects(next);
      setListError(null);
      if (selected && !next.some((project) => project.id === selected)) {
        if (await confirmProjectAccessLost(selected)) await handleLostAccess(selected);
      }
      return true;
    } catch (error) {
      if (!quiet) setListError(projectError(error));
      return false;
    } finally {
      if (!quiet) setListLoading(false);
    }
  });

  const refreshWorkspaceOnly = useEventCallback(async (projectId: string): Promise<boolean> => {
    try {
      const nextWorkspace = await loadProjectWorkspace(projectId);
      if (selectedRef.current !== projectId) return false;
      const mergedWorkspace = reconcileWorkspace(projectId, nextWorkspace);
      setWorkspace(mergedWorkspace);
      setLastSyncedAt(Date.now());
      setSyncState("idle");
      const activeChatId = useWorkspaceStore.getState().activeChatId;
      const active = nextWorkspace.chats.find((chat) => chat.id === activeChatId);
      if (active && !input.isLocallyStreaming(active.id)) {
        await input.refreshActiveChat(active.id, {
          forceDetail: true,
          preserveControls: true,
          resumeRuns: false
        });
      }
      return true;
    } catch (error) {
      if (error instanceof ProjectApiError && error.code === "project_not_found") {
        if (await confirmProjectAccessLost(projectId)) await handleLostAccess(projectId);
        else if (selectedRef.current === projectId) setSyncState("error");
      } else if (selectedRef.current === projectId) {
        setSyncState("error");
      }
      return false;
    }
  });

  const refresh = useEventCallback(async (quiet = false): Promise<boolean> => {
    const projectId = selectedRef.current;
    if (!projectId) return false;
    if (refreshPromiseRef.current?.projectId === projectId) {
      return refreshPromiseRef.current.promise;
    }
    const request = (async () => {
      if (!quiet) setSyncState("syncing");
      try {
        const [nextDetail, nextWorkspace] = await Promise.all([
          loadProject(projectId),
          loadProjectWorkspace(projectId)
        ]);
        if (selectedRef.current !== projectId) return false;
        setDetail(nextDetail);
        const mergedWorkspace = reconcileWorkspace(projectId, nextWorkspace);
        setWorkspace(mergedWorkspace);
        setProjects((current) => current.map((project) =>
          project.id === projectId ? summaryFromDetail(nextDetail) : project
        ));
        setLastSyncedAt(Date.now());
        setSyncState("idle");
        setSyncWarning(null);

        const activeChatId = useWorkspaceStore.getState().activeChatId;
        const active = nextWorkspace.chats.find((chat) => chat.id === activeChatId);
        if (active && !input.isLocallyStreaming(active.id)) {
          const summary = projectChatSummaryFromApi(active);
          await input.refreshActiveChat(active.id, {
            forceDetail: true,
            preserveControls: true,
            resumeRuns: false
          });
          if (selectedRef.current === projectId && useWorkspaceStore.getState().activeChatId === active.id) {
            await input.activateChat(summary, { preserveControls: true, resumeRuns: true });
          }
        }
        return true;
      } catch (error) {
        if (error instanceof ProjectApiError && error.code === "project_not_found") {
          if (await confirmProjectAccessLost(projectId)) await handleLostAccess(projectId);
          else if (selectedRef.current === projectId) setSyncState("error");
        } else if (selectedRef.current === projectId) {
          setSyncState("error");
          if (!quiet) setActionError(projectError(error));
        }
        return false;
      }
    })();
    refreshPromiseRef.current = { projectId, promise: request };
    try {
      return await request;
    } finally {
      if (refreshPromiseRef.current?.promise === request) refreshPromiseRef.current = null;
    }
  });

  const refreshSettingsData = useEventCallback(async (): Promise<void> => {
    const projectId = selectedRef.current;
    if (!projectId) return;
    if (settingsRefreshPromiseRef.current?.projectId === projectId) {
      settingsRefreshQueuedRef.current = true;
      return settingsRefreshPromiseRef.current.promise;
    }
    do {
      settingsRefreshQueuedRef.current = false;
      const request = (async () => {
        // Project Memory remains available only for retained compatibility
        // routes. Settings must not turn that dormant data into a hidden read.
        const activityResult = await Promise.allSettled([loadProjectActivity(projectId)]).then(
          ([result]) => result
        );
        if (selectedRef.current !== projectId) return;
        if (activityResult.status === "fulfilled") {
          setActivity(activityResult.value);
          setActivityError(null);
        } else {
          setActivityError(projectError(activityResult.reason));
        }
        const failure = activityResult.status === "rejected" ? activityResult.reason : null;
        if (failure) throw failure;
      })();
      settingsRefreshPromiseRef.current = { projectId, promise: request };
      try {
        await request;
      } finally {
        if (settingsRefreshPromiseRef.current?.promise === request) {
          settingsRefreshPromiseRef.current = null;
        }
      }
    } while (settingsRefreshQueuedRef.current && selectedRef.current === projectId);
  });

  const loadActivity = useEventCallback(async (): Promise<boolean> => {
    try {
      await refreshSettingsData();
      return true;
    } catch {
      return false;
    }
  });

  const runMutation = useEventCallback(async (
    mutation: (projectId: string) => Promise<void>,
    options: { closeAfter?: boolean; refreshMemory?: boolean; skipRefresh?: boolean } = {}
  ): Promise<boolean> => {
    const projectId = selectedRef.current;
    if (!projectId || busy) return false;
    setBusy(true);
    setActionError(null);
    try {
      await mutation(projectId);
      if (options.closeAfter) {
        settingsOpenRef.current = false;
        setSettingsOpen(false);
      }
      if (!options.skipRefresh && !(await refresh(true))) {
        if (selectedRef.current === projectId) setSyncWarning(PROJECT_SYNC_WARNING);
        return true;
      }
      if (!options.skipRefresh && (options.refreshMemory || settingsOpenRef.current)) {
        try {
          await refreshSettingsData();
        } catch {
          if (selectedRef.current === projectId) setSyncWarning(PROJECT_SYNC_WARNING);
          return true;
        }
      }
      setSyncWarning(null);
      return true;
    } catch (error) {
      // A target/resource 404 is an inline mutation error, not evidence that
      // Project access disappeared. Only the explicit aggregate code closes
      // the workspace; typed target codes preserve Settings and local drafts.
      if (error instanceof ProjectApiError && error.code === "project_not_found") {
        try {
          await loadProject(projectId);
          setActionError(projectError(error));
        } catch (revalidationError) {
          if (revalidationError instanceof ProjectApiError && revalidationError.code === "project_not_found") {
            await handleLostAccess(projectId);
          } else {
            setActionError(projectError(error));
          }
        }
      } else setActionError(projectError(error));
      return false;
    } finally {
      setBusy(false);
    }
  });

  const createProjectChatForSend = useEventCallback(async (
    folderId: string | null = null,
    sourceSessionKey?: ComposerSessionKey
  ): Promise<WorkspaceChatSummary | null> => {
    const projectId = selectedRef.current;
    if (!projectId || !detail?.capabilities.mutateChats || busy) return null;
    setBusy(true);
    setActionError(null);
    try {
      const now = new Date().toISOString();
      const defaultResource = detail.resources.find((resource) =>
        resource.type === "model" && resource.available &&
        resource.resourceId === detail.defaults.providerModelId
      );
      if (detail.readiness === "SETUP_REQUIRED") {
        setActionError(detail.setupReasons?.includes("shared_model_unavailable")
          ? "Add an answer model with an active shared installation credential before starting a chat."
          : "Choose one of the linked Project models as the default before starting a chat.");
        return null;
      }
      if (!defaultResource?.provider || !defaultResource.modelId) {
        setActionError("Add an available Project model before starting a chat.");
        return null;
      }
      const chat = {
        activeLeafMessageId: null,
        activeRun: false,
        archived: false,
        createdAt: now,
        createdByDisplayName: "You",
        createdByUserId: input.accountId,
        defaultKnowledgePlan: detail.defaults.knowledgePlan,
        defaultModelId: defaultResource.modelId,
        defaultProvider: defaultResource.provider,
        folderId,
        id: crypto.randomUUID(),
        messageCount: 0,
        pinned: false,
        projectId,
        title: "New Chat",
        updatedAt: now
      } satisfies ProjectWorkspaceResponseWire["chats"][number];
      const next = {
        chats: [chat, ...(workspace?.chats ?? []).filter((candidate) => candidate.id !== chat.id)],
        folders: workspace?.folders ?? []
      };
      const summary: WorkspaceChatSummary = {
        ...projectChatSummaryFromApi(chat),
        pendingProjectDraft: { folderId, projectId },
        workspace: undefined
      };
      if (
        sourceSessionKey &&
        !useComposerSessionStore.getState().transferSession(
          sourceSessionKey,
          composerSessionKey(summary.id)
        )
      ) {
        setActionError("Wait for files to finish uploading before starting the shared chat.");
        return null;
      }
      setWorkspace(reconcileWorkspace(projectId, next));
      useWorkspaceStore.getState().updateChats((current) =>
        current.map((candidate) => candidate.id === summary.id ? summary : candidate)
      );
      // A first send already owns an exact user-selected control snapshot.
      // Keep it through local-chat activation; only an explicit New shared chat
      // starts from the Project defaults.
      if (!sourceSessionKey) input.applyProjectDefaults(detail, summary);
      await input.activateChat(summary, { preserveControls: true });
      return summary;
    } catch (error) {
      setActionError(projectError(error));
      return null;
    } finally {
      setBusy(false);
    }
  });

  useEffect(() => {
    let stale = false;
    queueMicrotask(() => {
      if (stale) return;
      const cachedProjectIds = new Set(
        useWorkspaceStore.getState().chats.flatMap((chat) => chat.projectId ? [chat.projectId] : [])
      );
      for (const projectId of cachedProjectIds) removeProjectCache(projectId);
      selectedRef.current = null;
      realtimeChatRevisionsRef.current.clear();
      setSelectedProjectId(null);
      setDetail(null);
      setWorkspace(null);
      setMemory(null);
      setActivity(null);
      setActivityError(null);
      settingsOpenRef.current = false;
      setSettingsOpen(false);
      void refreshList(false);
    });
    return () => {
      stale = true;
    };
  }, [input.accountId, refreshList, removeProjectCache]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshList(true);
    }, PROJECT_LIST_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refreshList]);

  useEffect(() => {
    if (!selectedProjectId) return;
    if (typeof EventSource === "undefined") {
      return;
    }
    const stream = new EventSource(
      `/api/projects/${encodeURIComponent(selectedProjectId)}/events`,
      { withCredentials: true }
    );
    const changed = (event: Event) => {
      let category = "project_changed";
      let chatId: string | null = null;
      let chat: ProjectChatSummaryWire | null = null;
      let revision = "";
      if (event instanceof MessageEvent) {
        try {
          const value = JSON.parse(String(event.data)) as {
            category?: unknown;
            chat?: unknown;
            chatId?: unknown;
            revision?: unknown;
          };
          if (typeof value.category === "string") category = value.category;
          if (typeof value.chatId === "string") chatId = value.chatId;
          if (typeof value.revision === "string") revision = value.revision;
          chat = decodeProjectChat(value.chat);
        } catch { /* canonical refresh below is safe for malformed events */ }
      }
      if (chat) {
        const merged = mergeRealtimeChat(selectedProjectId, chat, revision);
        const activeChatId = useWorkspaceStore.getState().activeChatId;
        if (merged && activeChatId === chat.id) refreshRealtimeChat(chat.id);
      } else if (chatId && useWorkspaceStore.getState().activeChatId === chatId &&
        ["run_changed", "message_changed"].includes(category)) {
        refreshRealtimeChat(chatId);
      } else if (["run_changed", "message_changed", "chat_changed", "folder_changed", "attachment_changed"].includes(category)) {
        void refreshWorkspaceOnly(selectedProjectId);
      } else {
        void refresh(true);
      }
      if (
        settingsOpenRef.current &&
        !["run_changed", "message_changed", "attachment_changed"].includes(category)
      ) {
        void refreshSettingsData().catch((error) => setActivityError(projectError(error)));
      }
    };
    const resync = () => {
      void refresh(false).then(() => {
        if (settingsOpenRef.current) {
          return refreshSettingsData().catch((error) => setActivityError(projectError(error)));
        }
      });
    };
    const accessLost = () => { void handleLostAccess(selectedProjectId); };
    stream.addEventListener("project_changed", changed);
    stream.addEventListener("resync_required", resync);
    stream.addEventListener("access_lost", accessLost);
    stream.onopen = () => setRealtimeConnected(true);
    stream.onerror = () => setRealtimeConnected(false);
    return () => {
      setRealtimeConnected(false);
      stream.removeEventListener("project_changed", changed);
      stream.removeEventListener("resync_required", resync);
      stream.removeEventListener("access_lost", accessLost);
      stream.close();
    };
  }, [handleLostAccess, mergeRealtimeChat, refresh, refreshRealtimeChat, refreshSettingsData, refreshWorkspaceOnly, selectedProjectId]);

  useEffect(() => {
    if (!selectedProjectId || realtimeConnected) return;
    const activeRun = workspace?.chats.some((chat) => chat.activeRun) ?? false;
    // Browsers without native EventSource (and deterministic hermetic tests)
    // have no healthy realtime transport to wait for.  A short fallback keeps
    // access/revocation semantics observable; supported browsers retain the
    // slower 5–10 second idle cadence required by the product contract.
    const noEventSource = typeof EventSource === "undefined";
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, noEventSource
      ? PROJECT_ACTIVE_FALLBACK_INTERVAL_MS
      : activeRun ? PROJECT_ACTIVE_FALLBACK_INTERVAL_MS : PROJECT_IDLE_FALLBACK_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [realtimeConnected, refresh, selectedProjectId, workspace]);

  useEffect(() => {
    const resume = () => {
      if (document.visibilityState === "visible") {
        void refreshList(true);
        if (selectedRef.current) {
          void refresh(true);
          if (settingsOpenRef.current) {
            void refreshSettingsData().catch((error) => setActivityError(projectError(error)));
          }
        }
      }
    };
    window.addEventListener("focus", resume);
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    return () => {
      window.removeEventListener("focus", resume);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
    };
  }, [refresh, refreshList, refreshSettingsData]);

  return {
    actionError,
    activity,
    activityError,
    busy,
    createOpen,
    detail,
    lastSyncedAt,
    listError,
    listLoading,
    memory,
    projects,
    selectedProjectId,
    settingsOpen,
    settingsInitialTab,
    syncState,
    syncWarning,
    workspace,
    actions: {
      addGrant: (grant) => detail
        ? runMutation((projectId) => addProjectGrant(projectId, {
            ...grant,
            expectedAccessRevision: detail.accessRevision
          }))
        : Promise.resolve(false),
      addResource: (resource) => detail
        ? runMutation((projectId) => {
            const { expectedPolicyRevision, ...selection } = resource;
            return addProjectResource(projectId, {
              ...selection,
              expectedPolicyRevision: expectedPolicyRevision ?? detail.policyRevision
            });
          })
        : Promise.resolve(false),
      archiveChat: (chatId, archived) => detail?.capabilities.archiveChats
        ? runMutation((projectId) => setProjectChatArchived(projectId, chatId, archived))
        : Promise.resolve(false),
      closeCreate: () => setCreateOpen(false),
      closeSettings: () => {
        setActionError(null);
        settingsOpenRef.current = false;
        setSettingsOpen(false);
      },
      create: async (name, description) => {
        if (busy) return false;
        setBusy(true);
        setActionError(null);
        try {
          const created = await createProject({
            description,
            name,
            ...(input.preferredModelId ? { preferredModelId: input.preferredModelId } : {})
          });
          setProjects((current) => [summaryFromDetail(created), ...current]);
          selectedRef.current = created.id;
          setSelectedProjectId(created.id);
          setDetail(created);
          setWorkspace({ chats: [], folders: [] });
          setMemory(null);
          setActivity(null);
          setActivityError(null);
          input.onProjectContextEntered();
          input.activateProjectBlankWorkspace(created.id);
          setCreateOpen(false);
          setLastSyncedAt(Date.now());
          return true;
        } catch (error) {
          setActionError(projectError(error));
          return false;
        } finally {
          setBusy(false);
        }
      },
      createChat: async (folderId = null) => {
        return Boolean(await createProjectChatForSend(folderId));
      },
      createChatForSend: createProjectChatForSend,
      createFolder: (name) => detail?.capabilities.manageProject
        ? runMutation(async (projectId) => {
            await createProjectFolder(projectId, { name, parentId: null });
          })
        : Promise.resolve(false),
      deleteFolder: (folderId) => detail?.capabilities.manageProject
        ? runMutation((projectId) => deleteProjectFolder(projectId, folderId))
        : Promise.resolve(false),
      deleteProject: () => runMutation(async (projectId) => {
        await deleteProject(projectId);
        await handleLostAccess(projectId, false);
        input.setNotice({ kind: "success", text: "Project deleted." });
      }, { closeAfter: true, skipRefresh: true }),
      editMemoryFact: (factId, text, validUntil) => runMutation(
        (projectId) => editProjectMemoryFact(projectId, factId, text, validUntil),
        { refreshMemory: true }
      ),
      forgetMemoryFact: (factId) => runMutation(
        (projectId) => forgetProjectMemoryFact(projectId, factId),
        { refreshMemory: true }
      ),
      leave: () => {
        const projectId = selectedRef.current;
        const store = useWorkspaceStore.getState();
        const activeChat = store.activeChatId
          ? store.chats.find((chat) => chat.id === store.activeChatId) ?? null
          : null;
        if (projectId && activeChat?.projectId === projectId) input.activateBlankWorkspace();
        input.onProjectContextLeft();
        selectedRef.current = null;
        realtimeChatRevisionsRef.current.clear();
        setSelectedProjectId(null);
        setDetail(null);
        setWorkspace(null);
        setMemory(null);
        setActivity(null);
        setActivityError(null);
        setActionError(null);
        settingsOpenRef.current = false;
        setSettingsOpen(false);
      },
      leaveProject: async () => {
        const projectId = selectedRef.current;
        if (!projectId || !detail || busy) return false;
        setBusy(true);
        setActionError(null);
        try {
          const result = await leaveProject(projectId, detail.accessRevision);
          if (result.accessRemaining) {
            if (!(await refresh(false)) && selectedRef.current === projectId) {
              setSyncWarning(PROJECT_SYNC_WARNING);
            }
            input.setNotice({
              kind: "success",
              text: "Direct Project access removed. Group access remains."
            });
          } else {
            await handleLostAccess(projectId, false);
            input.setNotice({ kind: "success", text: "You left the Project." });
          }
          return true;
        } catch (error) {
          setActionError(projectError(error));
          return false;
        } finally {
          setBusy(false);
        }
      },
      openCreate: () => {
        setActionError(null);
        setCreateOpen(true);
      },
      openSettings: (tab = "general") => {
        setActionError(null);
        setSettingsInitialTab(tab);
        settingsOpenRef.current = true;
        setSettingsOpen(true);
        void refreshSettingsData().catch((error) => setActionError(projectError(error)));
      },
      refresh: () => refresh(false),
      retrySync: async () => {
        if (!(await refresh(false))) return false;
        if (settingsOpenRef.current) {
          try {
            await refreshSettingsData();
          } catch {
            setSyncWarning(PROJECT_SYNC_WARNING);
            return false;
          }
        }
        setSyncWarning(null);
        return true;
      },
      refreshList: () => refreshList(false),
      loadActivity,
      loadMoreActivity: async () => {
        const projectId = selectedRef.current;
        const cursor = activity?.nextCursor;
        if (!projectId || !cursor) return false;
        try {
          const next = await loadProjectActivity(projectId, cursor);
          if (selectedRef.current !== projectId) return false;
          setActivity((current) => current ? {
            events: [...current.events, ...next.events],
            nextCursor: next.nextCursor
          } : next);
          setActivityError(null);
          return true;
        } catch (error) {
          setActivityError(projectError(error));
          setActionError(projectError(error));
          return false;
        }
      },
      previewGrantRemoval: async (grantId) => {
        const projectId = selectedRef.current;
        if (!projectId || !detail || busy) return null;
        setBusy(true);
        setActionError(null);
        try {
          return await previewProjectGrantRemoval(
            projectId,
            grantId,
            detail.accessRevision
          );
        } catch (error) {
          setActionError(projectError(error));
          return null;
        } finally {
          setBusy(false);
        }
      },
      removeGrant: (grantId, expectedAccessRevision) => detail
        ? runMutation((projectId) => removeProjectGrant(
            projectId,
            grantId,
            expectedAccessRevision ?? detail.accessRevision
          ))
        : Promise.resolve(false),
      previewResourceAdd: async (resourceId) => {
        const projectId = selectedRef.current;
        if (!projectId || !detail || busy) return null;
        setBusy(true);
        setActionError(null);
        try {
          return await previewProjectResourceChange(projectId, {
            action: "add",
            expectedPolicyRevision: detail.policyRevision,
            resourceId,
            type: "assistant"
          });
        } catch (error) {
          setActionError(projectError(error));
          return null;
        } finally {
          setBusy(false);
        }
      },
      previewResourceRemoval: async (bindingId) => {
        const projectId = selectedRef.current;
        if (!projectId || !detail || busy) return null;
        setBusy(true);
        setActionError(null);
        try {
          return await previewProjectResourceChange(projectId, {
            action: "remove",
            bindingId,
            expectedPolicyRevision: detail.policyRevision
          });
        } catch (error) {
          setActionError(projectError(error));
          return null;
        } finally {
          setBusy(false);
        }
      },
      removeResource: (bindingId, expectedPolicyRevision) => detail
        ? runMutation((projectId) => removeProjectResource(
            projectId,
            bindingId,
            expectedPolicyRevision ?? detail.policyRevision
          ))
        : Promise.resolve(false),
      moveChat: (chatId, folderId) => detail?.capabilities.manageProject
        ? runMutation(() => moveProjectChat(chatId, folderId))
        : Promise.resolve(false),
      reviewMemoryProposal: (proposalId, approve) => runMutation(
        (projectId) => reviewProjectMemoryProposal(projectId, proposalId, approve),
        { refreshMemory: true }
      ),
      saveMemory: async (text, direct, sourceMessageId, validUntil) => {
        const saved = await runMutation(
          (projectId) => saveProjectMemoryText(
            projectId,
            {
              ...(sourceMessageId ? { sourceMessageId } : {}),
              text,
              ...(validUntil !== undefined ? { validUntil } : {})
            },
            direct
          ),
          { refreshMemory: true }
        );
        if (saved) {
          input.setNotice({
            kind: "success",
            text: direct ? "Added to Project Memory." : "Project Memory proposal created."
          });
        }
        return saved;
      },
      selectChat: async (chatId) => {
        const chat = workspace?.chats.find((candidate) => candidate.id === chatId);
        if (!chat || !detail) return false;
        const summary = projectChatSummaryFromApi(chat);
        input.applyProjectDefaults(detail, summary);
        await input.activateChat(summary, { preserveControls: true });
        return true;
      },
      selectProject: async (projectId) => {
        input.onProjectContextEntered();
        selectedRef.current = projectId;
        realtimeChatRevisionsRef.current.clear();
        setSelectedProjectId(projectId);
        setDetail(null);
        setWorkspace(null);
        setMemory(null);
        setActivity(null);
        setActivityError(null);
        setActionError(null);
        input.activateProjectBlankWorkspace(projectId);
        return refresh(false);
      },
      updateGrant: (grantId, role) => detail
        ? runMutation(
            (projectId) => updateProjectGrant(projectId, grantId, role, detail.accessRevision)
          )
        : Promise.resolve(false),
      updateFolder: (folderId, patch) => detail?.capabilities.manageProject
        ? runMutation(async (projectId) => {
            await updateProjectFolder(projectId, folderId, { name: patch.name });
          })
        : Promise.resolve(false),
      updateProject: (patch) => runMutation(async (projectId) => {
        await updateProject(projectId, patch);
      })
    }
  };
}
