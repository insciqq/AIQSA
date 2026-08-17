"use client";

import {
  addProjectGrant,
  addProjectResource,
  createProject,
  createProjectChat,
  createProjectFolder,
  deleteProjectFolder,
  deleteProject,
  editProjectMemoryFact,
  forgetProjectMemoryFact,
  loadProject,
  loadProjectActivity,
  loadProjectMemory,
  loadProjects,
  moveProjectChat,
  loadProjectWorkspace,
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
import type { Notice, WorkspaceChatSummary } from "@/components/app-shell/types";
import { sortChatsByFavoriteThenUpdatedAt, useWorkspaceStore } from "@/components/app-shell/workspaceStore";
import type {
  ProjectActivityResponseWire,
  ProjectDetailWire,
  ProjectMemoryResponseWire,
  ProjectSummaryWire,
  ProjectWorkspaceResponseWire,
  UpdateProjectRequestWire
} from "@/lib/contracts/projects";
import type { ProjectRole } from "@/lib/domain/projects";
import { useEffect, useRef, useState } from "react";

const PROJECT_SYNC_INTERVAL_MS = 2_500;
const PROJECT_LIST_SYNC_INTERVAL_MS = 10_000;

export type ProjectWorkspaceController = Readonly<{
  actionError: string | null;
  activity: ProjectActivityResponseWire | null;
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
  syncState: "error" | "idle" | "syncing";
  workspace: ProjectWorkspaceResponseWire | null;
  actions: Readonly<{
    addGrant(input: { groupId?: string; role: ProjectRole; userId?: string }): Promise<boolean>;
    addResource(input: { resourceId: string; revisionId?: string; type: "assistant" | "knowledge" | "mcp" | "model" | "search" }): Promise<boolean>;
    archiveChat(chatId: string, archived: boolean): Promise<boolean>;
    closeCreate(): void;
    closeSettings(): void;
    create(name: string, description?: string): Promise<boolean>;
    createChat(folderId?: string | null): Promise<boolean>;
    createFolder(name: string, parentId?: string | null): Promise<boolean>;
    deleteFolder(folderId: string): Promise<boolean>;
    deleteProject(): Promise<boolean>;
    editMemoryFact(factId: string, text: string, validUntil?: string | null): Promise<boolean>;
    forgetMemoryFact(factId: string): Promise<boolean>;
    leave(): void;
    openCreate(): void;
    openSettings(): void;
    refresh(): Promise<boolean>;
    refreshList(): Promise<boolean>;
    removeGrant(grantId: string): Promise<boolean>;
    removeResource(bindingId: string): Promise<boolean>;
    moveChat(chatId: string, folderId: string | null): Promise<boolean>;
    reviewMemoryProposal(proposalId: string, approve: boolean): Promise<boolean>;
    saveMemory(text: string, direct: boolean, sourceMessageId?: string, validUntil?: string | null): Promise<boolean>;
    selectChat(chatId: string): Promise<boolean>;
    selectProject(projectId: string): Promise<boolean>;
    updateGrant(grantId: string, role: ProjectRole): Promise<boolean>;
    updateFolder(folderId: string, patch: { name?: string; parentId?: string | null }): Promise<boolean>;
    updateProject(patch: UpdateProjectRequestWire): Promise<boolean>;
  }>;
}>;

type ControllerInput = Readonly<{
  accountId: string;
  activeChatId: string | null;
  activateBlankWorkspace(): void;
  activateChat(
    chat: WorkspaceChatSummary,
    options?: { preserveControls?: boolean; resumeRuns?: boolean }
  ): Promise<unknown> | unknown;
  applyProjectDefaults(project: ProjectDetailWire, chat: WorkspaceChatSummary): void;
  isLocallyStreaming(chatId: string): boolean;
  onProjectAccessLost(chatIds: readonly string[]): void;
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
    project_not_found: "This project is no longer available.",
    resource_binding_conflict: "That resource is already linked or no longer available."
  };
  return known[code] ?? "Could not update the project. Try again.";
}

function summaryFromDetail(project: ProjectDetailWire): ProjectSummaryWire {
  const {
    capabilities: _capabilities,
    createdAt: _createdAt,
    defaults: _defaults,
    grants: _grants,
    instructions: _instructions,
    instructionsRevision: _instructionsRevision,
    memoryEnabled: _memoryEnabled,
    memoryRevision: _memoryRevision,
    policy: _policy,
    policyRevision: _policyRevision,
    publicSharingEnabled: _publicSharingEnabled,
    resources: _resources,
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [syncState, setSyncState] = useState<"error" | "idle" | "syncing">("idle");
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const selectedRef = useRef<string | null>(null);
  const refreshPromiseRef = useRef<{ projectId: string; promise: Promise<boolean> } | null>(null);

  const removeProjectCache = useEventCallback((projectId: string) => {
    const store = useWorkspaceStore.getState();
    const chatIds = store.chats
      .filter((chat) => chat.projectId === projectId)
      .map((chat) => chat.id);
    store.updateChats((current) => current.filter((chat) => chat.projectId !== projectId));
    input.onProjectAccessLost(chatIds);
    if (store.activeChatId && chatIds.includes(store.activeChatId)) input.activateBlankWorkspace();
  });

  const reconcileWorkspace = useEventCallback((projectId: string, next: ProjectWorkspaceResponseWire) => {
    const summaries = next.chats.map(projectChatSummaryFromApi);
    const store = useWorkspaceStore.getState();
    store.updateChats((current) => {
      const currentById = new Map(current.map((chat) => [chat.id, chat]));
      return sortChatsByFavoriteThenUpdatedAt([
        ...current.filter((chat) => chat.projectId !== projectId),
        ...summaries.map((chat) => ({ ...currentById.get(chat.id), ...chat }))
      ]);
    });
  });

  const handleLostAccess = useEventCallback(async (projectId: string, notify = true) => {
    removeProjectCache(projectId);
    setProjects((current) => current.filter((project) => project.id !== projectId));
    if (selectedRef.current === projectId) {
      selectedRef.current = null;
      setSelectedProjectId(null);
      setDetail(null);
      setWorkspace(null);
      setMemory(null);
      setActivity(null);
      setSettingsOpen(false);
      if (notify) {
        input.setNotice({ kind: "error", text: "Project access changed. The shared workspace was closed." });
      }
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
        if (!accessibleProjectIds.has(projectId) && projectId !== selected) removeProjectCache(projectId);
      }
      setProjects(next);
      setListError(null);
      if (selected && !next.some((project) => project.id === selected)) {
        await handleLostAccess(selected);
      }
      return true;
    } catch (error) {
      if (!quiet) setListError(projectError(error));
      return false;
    } finally {
      if (!quiet) setListLoading(false);
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
        setWorkspace(nextWorkspace);
        setProjects((current) => [
          summaryFromDetail(nextDetail),
          ...current.filter((project) => project.id !== projectId)
        ]);
        reconcileWorkspace(projectId, nextWorkspace);
        setLastSyncedAt(Date.now());
        setSyncState("idle");

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
        if (error instanceof ProjectApiError && error.status === 404) {
          await handleLostAccess(projectId);
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
    const [nextMemory, nextActivity] = await Promise.all([
      loadProjectMemory(projectId),
      loadProjectActivity(projectId)
    ]);
    if (selectedRef.current === projectId) {
      setMemory(nextMemory);
      setActivity(nextActivity);
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
      if (options.closeAfter) setSettingsOpen(false);
      if (!options.skipRefresh && !(await refresh(false))) return false;
      if (!options.skipRefresh && (options.refreshMemory || settingsOpen)) await refreshSettingsData();
      return true;
    } catch (error) {
      if (error instanceof ProjectApiError && error.status === 404) {
        await handleLostAccess(projectId);
      } else {
        setActionError(projectError(error));
      }
      return false;
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
      setSelectedProjectId(null);
      setDetail(null);
      setWorkspace(null);
      setMemory(null);
      setActivity(null);
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
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void refresh(true);
    }, PROJECT_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [refresh, selectedProjectId]);

  return {
    actionError,
    activity,
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
    syncState,
    workspace,
    actions: {
      addGrant: (grant) => detail
        ? runMutation((projectId) => addProjectGrant(projectId, {
            ...grant,
            expectedAccessRevision: detail.accessRevision
          }))
        : Promise.resolve(false),
      addResource: (resource) => detail
        ? runMutation((projectId) => addProjectResource(projectId, {
            ...resource,
            expectedPolicyRevision: detail.policyRevision
          }))
        : Promise.resolve(false),
      archiveChat: (chatId, archived) => runMutation(
        (projectId) => setProjectChatArchived(projectId, chatId, archived)
      ),
      closeCreate: () => setCreateOpen(false),
      closeSettings: () => {
        setActionError(null);
        setSettingsOpen(false);
      },
      create: async (name, description) => {
        if (busy) return false;
        setBusy(true);
        setActionError(null);
        try {
          const created = await createProject({ description, name });
          setProjects((current) => [summaryFromDetail(created), ...current]);
          selectedRef.current = created.id;
          setSelectedProjectId(created.id);
          setDetail(created);
          setWorkspace({ chats: [], folders: [] });
          input.activateBlankWorkspace();
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
        const projectId = selectedRef.current;
        if (!projectId || !detail?.capabilities.mutateChats || busy) return false;
        setBusy(true);
        setActionError(null);
        try {
          const chat = await createProjectChat(projectId, { folderId });
          const next = {
            chats: [chat, ...(workspace?.chats ?? []).filter((candidate) => candidate.id !== chat.id)],
            folders: workspace?.folders ?? []
          };
          setWorkspace(next);
          reconcileWorkspace(projectId, next);
          const summary = projectChatSummaryFromApi(chat);
          input.applyProjectDefaults(detail, summary);
          await input.activateChat(summary, { preserveControls: true });
          return true;
        } catch (error) {
          setActionError(projectError(error));
          return false;
        } finally {
          setBusy(false);
        }
      },
      createFolder: (name, parentId = null) => runMutation(async (projectId) => {
        await createProjectFolder(projectId, { name, parentId });
      }),
      deleteFolder: (folderId) => runMutation(
        (projectId) => deleteProjectFolder(projectId, folderId)
      ),
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
        selectedRef.current = null;
        setSelectedProjectId(null);
        setDetail(null);
        setWorkspace(null);
        setMemory(null);
        setActivity(null);
        setSettingsOpen(false);
      },
      openCreate: () => {
        setActionError(null);
        setCreateOpen(true);
      },
      openSettings: () => {
        setActionError(null);
        setSettingsOpen(true);
        void refreshSettingsData().catch((error) => setActionError(projectError(error)));
      },
      refresh: () => refresh(false),
      refreshList: () => refreshList(false),
      removeGrant: (grantId) => detail
        ? runMutation((projectId) => removeProjectGrant(projectId, grantId, detail.accessRevision))
        : Promise.resolve(false),
      removeResource: (bindingId) => detail
        ? runMutation((projectId) => removeProjectResource(projectId, bindingId, detail.policyRevision))
        : Promise.resolve(false),
      moveChat: (chatId, folderId) => runMutation(
        () => moveProjectChat(chatId, folderId)
      ),
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
        selectedRef.current = projectId;
        setSelectedProjectId(projectId);
        setDetail(null);
        setWorkspace(null);
        setMemory(null);
        setActivity(null);
        setActionError(null);
        input.activateBlankWorkspace();
        return refresh(false);
      },
      updateGrant: (grantId, role) => detail
        ? runMutation(
            (projectId) => updateProjectGrant(projectId, grantId, role, detail.accessRevision)
          )
        : Promise.resolve(false),
      updateFolder: (folderId, patch) => runMutation(async (projectId) => {
        await updateProjectFolder(projectId, folderId, patch);
      }),
      updateProject: (patch) => runMutation(async (projectId) => {
        await updateProject(projectId, patch);
      })
    }
  };
}
