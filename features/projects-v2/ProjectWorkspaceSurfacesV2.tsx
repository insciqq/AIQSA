"use client";

import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import { DiscardChangesConfirmationDialog } from "@/components/app-shell/ConfirmationDialog";
import { loadProjectCandidates } from "@/components/app-shell/projectWorkspaceApi";
import { useEventCallback } from "@/components/app-shell/useEventCallback";
import type {
  ProjectAuditEventWire,
  ProjectCandidateWire,
  ProjectGrantRemovalPreviewWire,
  ProjectResourceChangePreviewWire,
  ProjectResourceTypeWire
} from "@/lib/contracts/projects";
import type { ProjectRole } from "@/lib/domain/projects";
import { createPortal } from "react-dom";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

const roles: readonly ProjectRole[] = ["VIEWER", "CONTRIBUTOR", "MANAGER", "OWNER"];

const activityLabels: Record<string, string> = {
  deletion_requested: "Project deletion requested",
  defaults_updated: "Project defaults updated",
  group_grant_added: "Group access added",
  group_grant_changed: "Group role changed",
  group_grant_removed: "Group access removed",
  instructions_updated: "Project instructions updated",
  memory_policy_updated: "Project Memory policy changed",
  memory_fact_created: "Project Memory fact added",
  memory_fact_edited: "Project Memory fact updated",
  memory_fact_forgotten: "Project Memory fact forgotten",
  memory_proposal_approved: "Memory proposal approved",
  memory_proposal_created: "Memory proposal created",
  memory_proposal_rejected: "Memory proposal rejected",
  policy_updated: "Project policy updated",
  project_archived: "Project archived",
  project_chat_archived: "Shared chat archived",
  project_chat_created: "Shared chat created",
  project_chat_restored: "Shared chat restored",
  project_created: "Project created",
  project_description_updated: "Project description updated",
  project_folder_created: "Folder created",
  project_folder_deleted: "Folder removed",
  project_folder_updated: "Folder updated",
  project_renamed: "Project renamed",
  project_restored: "Project restored",
  public_sharing_disabled: "Public sharing disabled",
  public_sharing_enabled: "Public sharing enabled",
  public_snapshot_created: "Public snapshot created",
  public_snapshot_revoked: "Public snapshot revoked",
  resource_attached: "Shared resource added",
  resource_detached: "Shared resource removed",
  resource_owner_revoked: "Resource owner revoked Project publication",
  resource_revision_updated: "Shared resource revision updated",
  user_grant_added: "Member access added",
  user_grant_changed: "Member role changed",
  user_grant_removed: "Member access removed",
  user_left_project: "Member left the Project"
};

function activityDetail(event: ProjectAuditEventWire): string | null {
  const metadata = event.metadata;
  const details: string[] = [];
  const fromRole = typeof metadata.fromRole === "string" ? metadata.fromRole.toLowerCase() : null;
  const toRole = typeof metadata.toRole === "string" ? metadata.toRole.toLowerCase() : null;
  const role = typeof metadata.role === "string" ? metadata.role.toLowerCase() : null;
  const resourceType = typeof metadata.resourceType === "string" ? metadata.resourceType : null;
  if (fromRole && toRole) details.push(`Role changed from ${fromRole} to ${toRole}.`);
  else if (role) details.push(`${role[0]?.toUpperCase()}${role.slice(1)} access.`);
  if (resourceType) details.push(`${resourceType === "mcp" ? "MCP" : resourceType} resource.`);
  const affectedChats = typeof metadata.affectedChatCount === "number" ? metadata.affectedChatCount : 0;
  const dependentAssistants = typeof metadata.dependentAssistantCount === "number"
    ? metadata.dependentAssistantCount
    : 0;
  const clearedDefaults = typeof metadata.clearedDefaultCount === "number" ? metadata.clearedDefaultCount : 0;
  if (affectedChats > 0) details.push(`${affectedChats} chat default${affectedChats === 1 ? "" : "s"} cleared.`);
  if (dependentAssistants > 0) {
    details.push(`${dependentAssistants} dependent Assistant${dependentAssistants === 1 ? "" : "s"} removed.`);
  }
  if (clearedDefaults > 0) details.push(`${clearedDefaults} Project default${clearedDefaults === 1 ? "" : "s"} cleared.`);
  if (typeof metadata.enabled === "boolean") {
    details.push(metadata.enabled ? "Enabled for future use." : "Disabled for future use.");
  }
  return details.length > 0 ? details.join(" ") : null;
}

function candidateDisabledLabel(reason: string | null): string | null {
  if (!reason) return null;
  return {
    already_has_direct_access: "Already has direct access",
    already_has_group_access: "Group already has access",
    already_linked_to_project: "Already linked to this Project",
    shared_configuration_required: "Shared or no-auth configuration required",
    shared_embedding_required: "Shared embedding configuration required"
  }[reason] ?? "Unavailable for this Project";
}

export function ProjectContextRailV2({
  activeChatProjectId,
  controller
}: Readonly<{
  activeChatProjectId: string | null;
  controller: ProjectWorkspaceController;
}>) {
  const project = controller.detail;
  if (!project || activeChatProjectId !== project.id) return null;
  const defaultModel = project.resources.find((resource) =>
    resource.type === "model" && resource.resourceId === project.defaults.providerModelId
  );
  const searchCount = project.defaults.searchPlan.optionIds.length;
  const knowledgeCount = project.defaults.knowledgePlan.baseIds.length;
  return (
    <aside className="v2-project-context" aria-label="Shared project context">
      <span className="v2-project-context-mark" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
      <span className="v2-project-context-primary">
        <strong>{project.name}</strong>
        <span>Shared with all project members · Personal Memory is off</span>
      </span>
      <span className="v2-project-context-facts">
        <span>{project.effectiveRole.toLowerCase()}</span>
        <span>Project Memory {project.memoryEnabled ? "on" : "off"}</span>
        <span>{defaultModel?.label ?? "No default model"}</span>
        <span>Search {searchCount > 0 ? searchCount : "off"} · Knowledge {knowledgeCount}</span>
        <span data-sync={controller.syncState}>
          {controller.syncState === "syncing" ? "Syncing" : controller.syncState === "error" ? "Sync paused" : "Shared desk live"}
        </span>
      </span>
      <UiV2IconButton icon="settings" label={`Open ${project.name} details`} onClick={() => controller.actions.openSettings()} />
    </aside>
  );
}

export function ProjectBlankOrientationV2({
  activeChat,
  controller
}: Readonly<{ activeChat: boolean; controller: ProjectWorkspaceController }>) {
  const project = controller.detail;
  if (!project) return null;
  const needsModel = project.readiness === "SETUP_REQUIRED";
  const missingSharedModel = project.setupReasons?.includes("shared_model_unavailable") ?? false;
  return (
    <div className="v2-project-blank" data-testid="project-blank-orientation">
      <span className="v2-project-blank-mark" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
      <p>Shared project</p>
      <h1>{project.name}</h1>
      <span>
        Messages and files here are visible to project members. Personal Memory is never used in shared chats.
      </span>
      {project.description ? <small>{project.description}</small> : null}
      {needsModel ? (
        <>
          <small>{missingSharedModel
            ? "This Project needs an answer model with an active shared installation credential before its first run."
            : "Choose one of the linked Project models as the default before the first run."}</small>
          {project.capabilities.manageProject ? (
            <UiV2Button disabled={controller.busy} onClick={() => controller.actions.openSettings(missingSharedModel ? "resources" : "general")}>
              {missingSharedModel ? "Add a model" : "Choose default model"}
            </UiV2Button>
          ) : null}
        </>
      ) : !activeChat && project.status === "ACTIVE" && project.capabilities.mutateChats ? (
        <UiV2Button disabled={controller.busy} onClick={() => void controller.actions.createChat()}>
          Start shared chat
        </UiV2Button>
      ) : activeChat ? (
        <small>This shared chat is ready. Everyone in the project will see new messages and files.</small>
      ) : (
        <small>{project.status === "ARCHIVED" ? "This project is archived and read-only." : "Choose a shared chat from the sidebar."}</small>
      )}
    </div>
  );
}

export function CreateProjectDialogV2({ controller }: Readonly<{ controller: ProjectWorkspaceController }>) {
  if (!controller.createOpen) return null;
  return <CreateProjectDialogContentV2 controller={controller} />;
}

function CreateProjectDialogContentV2({
  controller
}: Readonly<{ controller: ProjectWorkspaceController }>) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({
    closeBlocked: controller.busy,
    onClose: controller.actions.closeCreate
  });
  if (!portalReady) return null;
  return createPortal(
    <div className="v2-project-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) controller.actions.closeCreate();
    }}>
      <section
        aria-busy={controller.busy || undefined}
        aria-label="Create project"
        aria-modal="true"
        className="v2-project-create-dialog"
        ref={dialogRef}
        role="dialog"
        onKeyDown={onDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header>
          <div><small>Shared workspace</small><h1>Create project</h1></div>
          <UiV2IconButton ref={initialFocusRef} disabled={controller.busy} icon="close" label="Close" onClick={controller.actions.closeCreate} />
        </header>
        <form onSubmit={(event) => {
          event.preventDefault();
          if (!name.trim()) return;
          void controller.actions.create(name.trim(), description.trim());
        }}>
          <label>
            Name
            <input autoFocus maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Description <span>Optional</span>
            <textarea maxLength={2000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} />
          </label>
          <p>Every chat and file in this project is shared with its members. Personal Memory stays separate.</p>
          {controller.actionError ? <p className="v2-project-form-error" role="alert">{controller.actionError}</p> : null}
          <footer>
            <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={controller.actions.closeCreate}>Cancel</UiV2Button>
            <UiV2Button disabled={controller.busy || !name.trim()} tone="primary" type="submit">Create project</UiV2Button>
          </footer>
        </form>
      </section>
    </div>,
    document.body
  );
}

type ProjectSettingsTab = "activity" | "general" | "members" | "memory" | "resources";

export function ProjectSettingsDialogV2({ controller }: Readonly<{ controller: ProjectWorkspaceController }>) {
  const project = controller.detail;
  if (!controller.settingsOpen || !project) return null;
  return <ProjectSettingsDialogContentV2 controller={controller} project={project} />;
}

function ProjectSettingsDialogContentV2({
  controller,
  project
}: Readonly<{
  controller: ProjectWorkspaceController;
  project: NonNullable<ProjectWorkspaceController["detail"]>;
}>) {
  const [tab, setTab] = useState<ProjectSettingsTab>(controller.settingsInitialTab);
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description);
  const [instructions, setInstructions] = useState(project.instructions);
  const [memoryEnabled, setMemoryEnabled] = useState(project.memoryEnabled);
  const [publicSharingEnabled, setPublicSharingEnabled] = useState(project.publicSharingEnabled);
  const [defaultModelId, setDefaultModelId] = useState(project.defaults.providerModelId ?? "");
  const [defaultAssistantId, setDefaultAssistantId] = useState(project.defaults.assistantId ?? "");
  const [defaultKnowledgeIds, setDefaultKnowledgeIds] = useState<string[]>([...project.defaults.knowledgePlan.baseIds]);
  const [defaultSearchIds, setDefaultSearchIds] = useState<string[]>([...project.defaults.searchPlan.optionIds]);
  const [mcpMode, setMcpMode] = useState<"auto" | "load_all" | "off">(project.defaults.mcpMode);
  const [externalToolsEnabled, setExternalToolsEnabled] = useState(project.policy.externalToolsEnabled);
  const [maxOutputTokens, setMaxOutputTokens] = useState(
    typeof project.defaults.controlValues.maxOutputTokens === "string"
      ? project.defaults.controlValues.maxOutputTokens
      : ""
  );
  const [temperature, setTemperature] = useState(
    typeof project.defaults.controlValues.temperature === "string"
      ? project.defaults.controlValues.temperature
      : ""
  );
  const [reasoningEffort, setReasoningEffort] = useState(
    typeof project.defaults.controlValues.reasoningEffort === "string"
      ? project.defaults.controlValues.reasoningEffort
      : ""
  );
  const [grantKind, setGrantKind] = useState<"group" | "user">("user");
  const [grantId, setGrantId] = useState("");
  const [grantRole, setGrantRole] = useState<ProjectRole>("CONTRIBUTOR");
  const [resourceType, setResourceType] = useState<"assistant" | "knowledge" | "mcp" | "model" | "search" | "skill">("model");
  const [resourceId, setResourceId] = useState("");
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidates, setCandidates] = useState<readonly ProjectCandidateWire[]>([]);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateNextCursor, setCandidateNextCursor] = useState<string | null>(null);
  const [candidateReload, setCandidateReload] = useState(0);
  const [grantAddConfirmation, setGrantAddConfirmation] = useState<null | Readonly<{
    candidate: ProjectCandidateWire;
    kind: "group" | "user";
    role: ProjectRole;
  }>>(null);
  const [grantRemovalConfirmation, setGrantRemovalConfirmation] = useState<null | Readonly<{
    grantId: string;
    preview: ProjectGrantRemovalPreviewWire;
  }>>(null);
  const [leaveConfirmation, setLeaveConfirmation] = useState(false);
  const [resourceConfirmation, setResourceConfirmation] = useState<null | Readonly<{
    bindingId?: string;
    expectedPolicyRevision: number;
    kind: "add" | "remove";
    label: string;
    preview?: ProjectResourceChangePreviewWire;
    resourceId?: string;
    type: ProjectResourceTypeWire;
  }>>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [deleteProjectName, setDeleteProjectName] = useState("");
  const [editingFactId, setEditingFactId] = useState<string | null>(null);
  const [editingFactText, setEditingFactText] = useState("");
  const [forgetFactId, setForgetFactId] = useState<string | null>(null);
  const [memoryText, setMemoryText] = useState("");
  const [memoryValidUntil, setMemoryValidUntil] = useState("");
  const [discardOpen, setDiscardOpen] = useState(false);
  const previousProjectRef = useRef(project);
  const generalDirty = name !== project.name ||
    description !== project.description ||
    instructions !== project.instructions ||
    memoryEnabled !== project.memoryEnabled ||
    publicSharingEnabled !== project.publicSharingEnabled ||
    defaultModelId !== (project.defaults.providerModelId ?? "") ||
    defaultAssistantId !== (project.defaults.assistantId ?? "") ||
    JSON.stringify(defaultKnowledgeIds) !== JSON.stringify(project.defaults.knowledgePlan.baseIds) ||
    JSON.stringify(defaultSearchIds) !== JSON.stringify(project.defaults.searchPlan.optionIds) ||
    mcpMode !== project.defaults.mcpMode ||
    externalToolsEnabled !== project.policy.externalToolsEnabled ||
    maxOutputTokens !== (typeof project.defaults.controlValues.maxOutputTokens === "string"
      ? project.defaults.controlValues.maxOutputTokens
      : "") ||
    temperature !== (typeof project.defaults.controlValues.temperature === "string"
      ? project.defaults.controlValues.temperature
      : "") ||
    reasoningEffort !== (typeof project.defaults.controlValues.reasoningEffort === "string"
      ? project.defaults.controlValues.reasoningEffort
      : "");
  const dirty = generalDirty || Boolean(memoryText.trim()) || Boolean(editingFactId);
  const requestClose = () => {
    if (controller.busy) return;
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    controller.actions.closeSettings();
  };
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({
    closeBlocked: controller.busy || discardOpen,
    onClose: requestClose
  });

  // Realtime updates refresh untouched fields without replacing local edits.
  // The previous canonical snapshot is the baseline that distinguishes the
  // two, so revisions never remount the dialog or silently erase a draft.
  const reconcileProject = useEventCallback((nextProject: typeof project) => {
    const previous = previousProjectRef.current;
    if (name === previous.name) setName(nextProject.name);
    if (description === previous.description) setDescription(nextProject.description);
    if (instructions === previous.instructions) setInstructions(nextProject.instructions);
    if (memoryEnabled === previous.memoryEnabled) setMemoryEnabled(nextProject.memoryEnabled);
    if (publicSharingEnabled === previous.publicSharingEnabled) {
      setPublicSharingEnabled(nextProject.publicSharingEnabled);
    }
    if (defaultModelId === (previous.defaults.providerModelId ?? "")) {
      setDefaultModelId(nextProject.defaults.providerModelId ?? "");
    }
    if (defaultAssistantId === (previous.defaults.assistantId ?? "")) {
      setDefaultAssistantId(nextProject.defaults.assistantId ?? "");
    }
    if (JSON.stringify(defaultKnowledgeIds) === JSON.stringify(previous.defaults.knowledgePlan.baseIds)) {
      setDefaultKnowledgeIds([...nextProject.defaults.knowledgePlan.baseIds]);
    }
    if (JSON.stringify(defaultSearchIds) === JSON.stringify(previous.defaults.searchPlan.optionIds)) {
      setDefaultSearchIds([...nextProject.defaults.searchPlan.optionIds]);
    }
    if (mcpMode === previous.defaults.mcpMode) setMcpMode(nextProject.defaults.mcpMode);
    if (externalToolsEnabled === previous.policy.externalToolsEnabled) {
      setExternalToolsEnabled(nextProject.policy.externalToolsEnabled);
    }
    const previousMax = typeof previous.defaults.controlValues.maxOutputTokens === "string"
      ? previous.defaults.controlValues.maxOutputTokens
      : "";
    const nextMax = typeof nextProject.defaults.controlValues.maxOutputTokens === "string"
      ? nextProject.defaults.controlValues.maxOutputTokens
      : "";
    if (maxOutputTokens === previousMax) setMaxOutputTokens(nextMax);
    const previousTemperature = typeof previous.defaults.controlValues.temperature === "string"
      ? previous.defaults.controlValues.temperature
      : "";
    const nextTemperature = typeof nextProject.defaults.controlValues.temperature === "string"
      ? nextProject.defaults.controlValues.temperature
      : "";
    if (temperature === previousTemperature) setTemperature(nextTemperature);
    const previousReasoning = typeof previous.defaults.controlValues.reasoningEffort === "string"
      ? previous.defaults.controlValues.reasoningEffort
      : "";
    const nextReasoning = typeof nextProject.defaults.controlValues.reasoningEffort === "string"
      ? nextProject.defaults.controlValues.reasoningEffort
      : "";
    if (reasoningEffort === previousReasoning) setReasoningEffort(nextReasoning);
    previousProjectRef.current = nextProject;
  });
  useEffect(() => {
    let stale = false;
    queueMicrotask(() => {
      if (!stale) reconcileProject(project);
    });
    return () => {
      stale = true;
    };
  }, [project, reconcileProject]);

  const candidateType = tab === "members" ? grantKind : resourceType;
  useEffect(() => {
    if (!controller.settingsOpen || (tab !== "members" && tab !== "resources")) return;
    let stale = false;
    const timer = window.setTimeout(() => {
      setCandidates([]);
      setCandidateNextCursor(null);
      setCandidateError(null);
      setCandidateLoading(true);
      void loadProjectCandidates(project.id, candidateType, candidateQuery).then((page) => {
        if (!stale) {
          setCandidates(page.items);
          setCandidateNextCursor(page.nextCursor);
          setCandidateError(null);
        }
      }).catch(() => {
        if (!stale) {
          setCandidates([]);
          setCandidateNextCursor(null);
          setCandidateError("Could not load directory candidates.");
        }
      }).finally(() => {
        if (!stale) setCandidateLoading(false);
      });
    }, 180);
    return () => {
      stale = true;
      window.clearTimeout(timer);
    };
  }, [candidateQuery, candidateReload, candidateType, controller.settingsOpen, project.id, tab]);

  if (!portalReady) return null;
  const owner = project.effectiveRole === "OWNER";
  const manager = project.status === "ACTIVE" && project.capabilities.manageProject;
  const modelResources = project.resources.filter((resource) => resource.type === "model");
  const assistantResources = project.resources.filter((resource) => resource.type === "assistant");
  const knowledgeResources = project.resources.filter((resource) => resource.type === "knowledge");
  const searchResources = project.resources.filter((resource) => resource.type === "search");
  const mcpResources = project.resources.filter((resource) => resource.type === "mcp");
  const skillResources = project.resources.filter((resource) => resource.type === "skill");
  const resourceTypes = ["model", "search", "knowledge", "assistant", "skill", "mcp"] as const;
  const resourceIsDefault = (resource: (typeof project.resources)[number]) =>
    resource.type === "model" && project.defaults.providerModelId === resource.resourceId ||
    resource.type === "assistant" && project.defaults.assistantId === resource.resourceId ||
    resource.type === "knowledge" && project.defaults.knowledgePlan.baseIds.includes(resource.resourceId) ||
    resource.type === "search" && project.defaults.searchPlan.optionIds.includes(resource.resourceId) ||
    resource.type === "mcp" && project.defaults.mcpMode !== "off";
  const archivedChats = (controller.workspace?.chats ?? []).filter((chat) => chat.archived);
  const accessSources = [
    ...(project.directRole ? [`direct ${project.directRole.toLowerCase()}`] : []),
    ...project.grantedThrough.map((grant) =>
      `${grant.groupName} (${grant.role.toLowerCase()})`
    )
  ];
  const resetDraftToCanonical = () => {
    previousProjectRef.current = project;
    setName(project.name);
    setDescription(project.description);
    setInstructions(project.instructions);
    setMemoryEnabled(project.memoryEnabled);
    setPublicSharingEnabled(project.publicSharingEnabled);
    setDefaultModelId(project.defaults.providerModelId ?? "");
    setDefaultAssistantId(project.defaults.assistantId ?? "");
    setDefaultKnowledgeIds([...project.defaults.knowledgePlan.baseIds]);
    setDefaultSearchIds([...project.defaults.searchPlan.optionIds]);
    setMcpMode(project.defaults.mcpMode);
    setExternalToolsEnabled(project.policy.externalToolsEnabled);
    setMaxOutputTokens(typeof project.defaults.controlValues.maxOutputTokens === "string"
      ? project.defaults.controlValues.maxOutputTokens
      : "");
    setTemperature(typeof project.defaults.controlValues.temperature === "string"
      ? project.defaults.controlValues.temperature
      : "");
    setReasoningEffort(typeof project.defaults.controlValues.reasoningEffort === "string"
      ? project.defaults.controlValues.reasoningEffort
      : "");
    void controller.actions.refresh();
  };
  const requestResourceAdd = async () => {
    if (!resourceId) return;
    const candidate = candidates.find((entry) => entry.id === resourceId);
    if (!candidate || candidate.disabledReason) return;
    if (resourceType === "assistant") {
      const preview = await controller.actions.previewResourceAdd(resourceId);
      if (!preview) return;
      setResourceConfirmation({
        expectedPolicyRevision: preview.policyRevision,
        kind: "add",
        label: preview.resource.label,
        preview,
        resourceId,
        type: "assistant"
      });
      return;
    }
    setResourceConfirmation({
      expectedPolicyRevision: project.policyRevision,
      kind: "add",
      label: candidate.label,
      resourceId,
      type: resourceType
    });
  };
  const requestGrantRemoval = async (grantId: string) => {
    const preview = await controller.actions.previewGrantRemoval(grantId);
    if (preview) setGrantRemovalConfirmation({ grantId, preview });
  };
  const commitGrantAdd = async () => {
    const pending = grantAddConfirmation;
    if (!pending) return;
    const saved = await controller.actions.addGrant({
      ...(pending.kind === "user"
        ? { userId: pending.candidate.id }
        : { groupId: pending.candidate.id }),
      role: pending.role
    });
    if (!saved) return;
    setGrantAddConfirmation(null);
    setGrantId("");
    setCandidateQuery("");
  };
  const commitGrantRemoval = async () => {
    const pending = grantRemovalConfirmation;
    if (!pending) return;
    const saved = await controller.actions.removeGrant(
      pending.grantId,
      pending.preview.accessRevision
    );
    if (saved) setGrantRemovalConfirmation(null);
  };
  const requestResourceRemoval = async (bindingId: string) => {
    const preview = await controller.actions.previewResourceRemoval(bindingId);
    if (!preview) return;
    setResourceConfirmation({
      bindingId,
      expectedPolicyRevision: preview.policyRevision,
      kind: "remove",
      label: preview.resource.label,
      preview,
      type: preview.resource.type
    });
  };
  const commitResourceChange = async () => {
    const pending = resourceConfirmation;
    if (!pending) return;
    const saved = pending.kind === "add" && pending.resourceId
      ? await controller.actions.addResource({
          expectedPolicyRevision: pending.expectedPolicyRevision,
          resourceId: pending.resourceId,
          ...(pending.preview?.revisionId ? { revisionId: pending.preview.revisionId } : {}),
          type: pending.type
        })
      : pending.kind === "remove" && pending.bindingId
        ? await controller.actions.removeResource(
            pending.bindingId,
            pending.expectedPolicyRevision
          )
        : false;
    if (!saved) return;
    setResourceConfirmation(null);
    if (pending.kind === "add") {
      setResourceId("");
      setCandidateQuery("");
    }
  };
  const movePickerFocus = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const options = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="option"]:not(:disabled)'
    )];
    if (options.length === 0) return;
    const current = options.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === "ArrowDown"
      ? options[(current + 1 + options.length) % options.length]
      : options[(current - 1 + options.length) % options.length];
    event.preventDefault();
    next?.focus();
  };
  const loadMoreCandidates = async () => {
    if (!candidateNextCursor || candidateLoading) return;
    setCandidateLoading(true);
    setCandidateError(null);
    try {
      const page = await loadProjectCandidates(
        project.id,
        candidateType,
        candidateQuery,
        candidateNextCursor
      );
      setCandidates((current) => [
        ...current,
        ...page.items.filter((candidate) => !current.some((entry) => entry.id === candidate.id))
      ]);
      setCandidateNextCursor(page.nextCursor);
    } catch {
      setCandidateError("Could not load more directory candidates.");
    } finally {
      setCandidateLoading(false);
    }
  };
  const tabs: readonly { id: ProjectSettingsTab; icon: "history" | "memory" | "settings" | "tool" | "assistant"; label: string }[] = [
    { id: "general", icon: "settings", label: "Project" },
    { id: "members", icon: "assistant", label: "Members" },
    { id: "resources", icon: "tool", label: "Resources" },
    { id: "memory", icon: "memory", label: "Memory" },
    { id: "activity", icon: "history", label: "Activity" }
  ];

  return createPortal(
    <div className="v2-project-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) requestClose();
    }}>
      <section
        aria-busy={controller.busy || undefined}
        aria-label={`${project.name} settings`}
        aria-modal="true"
        className="v2-project-settings-dialog"
        ref={dialogRef}
        role="dialog"
        onKeyDown={onDialogKeyDown}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="v2-project-settings-header">
          <div><small>Shared project · {project.effectiveRole.toLowerCase()}</small><h1>{project.name}</h1></div>
          <UiV2IconButton ref={initialFocusRef} disabled={controller.busy} icon="close" label="Close project settings" onClick={requestClose} />
        </header>
        <nav className="v2-project-settings-nav" aria-label="Project settings sections">
          {tabs.map((item) => (
            <button
              aria-current={tab === item.id ? "page" : undefined}
              className="v2-focusable"
              data-selected={tab === item.id}
              key={item.id}
              type="button"
              onClick={() => setTab(item.id)}
            ><UiV2Icon name={item.icon} /> {item.label}</button>
          ))}
        </nav>
        {controller.actionError ? (
          <div className="v2-project-settings-error" role="alert">
            <span>{controller.actionError}</span>
            {controller.actionError.includes("changed elsewhere") ? (
              <span>
                <UiV2Button tone="ghost" type="button" onClick={() => setTab("general")}>
                  Review / retry
                </UiV2Button>
                <UiV2Button tone="ghost" type="button" onClick={resetDraftToCanonical}>
                  Reload current values
                </UiV2Button>
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="v2-project-settings-scroll">
          {tab === "general" ? (
            <form className="v2-project-settings-section" onSubmit={(event) => {
              event.preventDefault();
              const controlValues = { ...project.defaults.controlValues } as Record<string, boolean | string>;
              if (maxOutputTokens.trim()) controlValues.maxOutputTokens = maxOutputTokens.trim();
              else delete controlValues.maxOutputTokens;
              if (temperature.trim()) controlValues.temperature = temperature.trim();
              else delete controlValues.temperature;
              if (reasoningEffort) controlValues.reasoningEffort = reasoningEffort;
              else delete controlValues.reasoningEffort;
              void controller.actions.updateProject({
                defaults: {
                  ...project.defaults,
                  assistantId: defaultAssistantId || null,
                  controlValues,
                  knowledgePlan: { baseIds: defaultKnowledgeIds },
                  mcpMode,
                  providerModelId: defaultModelId || null,
                  searchPlan: {
                    mode: project.defaults.searchPlan.mode,
                    optionIds: defaultSearchIds
                  }
                },
                description,
                expectedInstructionsRevision: project.instructionsRevision,
                expectedMemoryRevision: project.memoryRevision,
                expectedPolicyRevision: project.policyRevision,
                instructions,
                memoryEnabled,
                name,
                policy: { externalToolsEnabled },
                ...(owner ? { publicSharingEnabled } : {})
              });
            }}>
              <div className="v2-project-section-heading"><h2>Shared context</h2><p>These values affect future chats and runs. Defaults never grant runtime access.</p></div>
              {project.readiness === "SETUP_REQUIRED" ? (
                <div className="v2-project-confirmation" role="status">
                  <strong>Default model required</strong>
                  <p>{project.setupReasons?.includes("shared_model_unavailable")
                    ? "Add an answer model that an administrator made available to Projects with an active shared credential."
                    : "Select a linked answer model below and save it as the Project default."}</p>
                  {manager && project.setupReasons?.includes("shared_model_unavailable") ? <UiV2Button type="button" onClick={() => { setResourceType("model"); setTab("resources"); }}>Add a model</UiV2Button> : null}
                </div>
              ) : null}
              {project.resources.length === 0 && manager ? (
                <div className="v2-project-confirmation">
                  <strong>No shared resources yet</strong>
                  <p>Models, Search, Knowledge, Assistants, Skills and MCP are added explicitly for this Project.</p>
                  <UiV2Button type="button" onClick={() => setTab("resources")}>Open Resources</UiV2Button>
                </div>
              ) : null}
              <label>Name<input disabled={!manager} maxLength={120} required value={name} onChange={(event) => setName(event.target.value)} /></label>
              <label>Description<textarea disabled={!manager} maxLength={2000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
              <label>Project Instructions<textarea disabled={!manager} maxLength={32000} rows={7} value={instructions} onChange={(event) => setInstructions(event.target.value)} /></label>
              <label>Default model<select disabled={!manager} value={defaultModelId} onChange={(event) => setDefaultModelId(event.target.value)}><option value="">No project default</option>{modelResources.map((resource) => <option disabled={!resource.available} key={resource.id} value={resource.resourceId}>{resource.label}{resource.available ? "" : " (unavailable)"}</option>)}</select></label>
              <label>Default Assistant<select disabled={!manager} value={defaultAssistantId} onChange={(event) => setDefaultAssistantId(event.target.value)}><option value="">No project default</option>{assistantResources.map((resource) => <option disabled={!resource.available} key={resource.id} value={resource.resourceId}>{resource.label}{resource.available ? "" : " (unavailable)"}</option>)}</select></label>
              <fieldset className="v2-project-options" disabled={!manager}>
                <legend>Default Knowledge</legend>
                {knowledgeResources.length === 0 ? <small>Link a Knowledge Base to make it available.</small> : knowledgeResources.map((resource) => (
                  <label className="v2-project-check" key={resource.id}><input checked={defaultKnowledgeIds.includes(resource.resourceId)} disabled={!resource.available} type="checkbox" onChange={(event) => setDefaultKnowledgeIds((current) => event.target.checked ? [...new Set([...current, resource.resourceId])] : current.filter((id) => id !== resource.resourceId))} /><span><strong>{resource.label}</strong><small>{resource.available ? "Included in new chats" : resource.reason ?? "Unavailable"}</small></span></label>
                ))}
              </fieldset>
              <fieldset className="v2-project-options" disabled={!manager || !externalToolsEnabled}>
                <legend>Default Search</legend>
                {searchResources.length === 0 ? <small>Link Search sources to make them available.</small> : searchResources.map((resource) => (
                  <label className="v2-project-check" key={resource.id}><input checked={defaultSearchIds.includes(resource.resourceId)} disabled={!resource.available} type="checkbox" onChange={(event) => setDefaultSearchIds((current) => event.target.checked ? [...new Set([...current, resource.resourceId])] : current.filter((id) => id !== resource.resourceId))} /><span><strong>{resource.label}</strong><small>{resource.available ? "Available to all project contributors" : resource.reason ?? "Unavailable"}</small></span></label>
                ))}
              </fieldset>
              <label>Default MCP mode<select disabled={!manager || !externalToolsEnabled || mcpResources.length === 0} value={mcpMode} onChange={(event) => setMcpMode(event.target.value as typeof mcpMode)}><option value="off">Off</option><option value="auto">Use linked shared tools</option><option value="load_all">Load all linked tools</option></select><small>{mcpResources.length} linked MCP server{mcpResources.length === 1 ? "" : "s"}; personal OAuth is always blocked.</small></label>
              <fieldset className="v2-project-options" disabled={!manager}>
                <legend>Default run controls</legend>
                <label>Max output tokens<input inputMode="numeric" placeholder="Model default" value={maxOutputTokens} onChange={(event) => setMaxOutputTokens(event.target.value)} /></label>
                <label>Temperature<input inputMode="decimal" placeholder="Model default" value={temperature} onChange={(event) => setTemperature(event.target.value)} /></label>
                <label>Reasoning effort<select value={reasoningEffort} onChange={(event) => setReasoningEffort(event.target.value)}><option value="">Model default</option><option value="none">None</option><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
              </fieldset>
              <label className="v2-project-check"><input checked={externalToolsEnabled} disabled={!manager} type="checkbox" onChange={(event) => {
                setExternalToolsEnabled(event.target.checked);
                if (!event.target.checked) { setDefaultSearchIds([]); setMcpMode("off"); }
              }} /><span><strong>External tools</strong><small>Allow linked Search and shared/no-auth MCP destinations in future runs.</small></span></label>
              <label className="v2-project-check"><input checked={memoryEnabled} disabled={!manager} type="checkbox" onChange={(event) => setMemoryEnabled(event.target.checked)} /><span><strong>Project Memory</strong><small>Explicit approved facts can be used in future project runs.</small></span></label>
              {owner ? <label className="v2-project-check"><input checked={publicSharingEnabled} disabled={!manager} type="checkbox" onChange={(event) => setPublicSharingEnabled(event.target.checked)} /><span><strong>Public sharing</strong><small>Allow explicit project chat snapshots when the sharing route supports them.</small></span></label> : null}
              {manager ? <div className="v2-project-actions"><UiV2Button disabled={controller.busy} type="submit">Save changes</UiV2Button></div> : null}
              {archivedChats.length > 0 ? (
                <section className="v2-project-archived-chats" aria-labelledby="project-archived-chats-heading">
                  <div className="v2-project-section-heading">
                    <h2 id="project-archived-chats-heading">Archived chats</h2>
                    <p>Archived shared history stays in the Project. Managers can restore a chat to the shared desk.</p>
                  </div>
                  <div className="v2-project-list-table">
                    {archivedChats.map((chat) => (
                      <div className="v2-project-list-row" key={chat.id}>
                        <span><strong>{chat.title}</strong><small>Started by {chat.createdByDisplayName}</small></span>
                        <small>{new Date(chat.updatedAt).toLocaleDateString()}</small>
                        {project.capabilities.archiveChats ? (
                          <UiV2Button
                            disabled={controller.busy || project.status !== "ACTIVE"}
                            type="button"
                            onClick={() => void controller.actions.archiveChat(chat.id, false)}
                          >Restore</UiV2Button>
                        ) : <span />}
                      </div>
                    ))}
                  </div>
                </section>
              ) : null}
              {owner ? (
                <div className="v2-project-danger">
                  <div><strong>Project lifecycle</strong><span>Archive keeps content readable. Delete removes project-owned content and cannot be undone.</span></div>
                  <div>
                    <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => project.status === "ARCHIVED" ? void controller.actions.updateProject({ expectedAccessRevision: project.accessRevision, status: "ACTIVE" }) : setConfirmArchive(true)}>{project.status === "ARCHIVED" ? "Restore project" : "Archive project"}</UiV2Button>
                    <UiV2Button disabled={controller.busy} tone="destructive" type="button" onClick={() => { setDeleteProjectName(""); setConfirmDelete(true); }}>Delete project</UiV2Button>
                  </div>
                </div>
              ) : null}
              {confirmArchive ? (
                <div className="v2-project-confirmation" role="alertdialog" aria-label="Confirm Project archive">
                  <strong>Archive {project.name}?</strong>
                  <p>All {project.chatCount} shared chats become read-only for every member. Owners can restore the Project later.</p>
                  <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => setConfirmArchive(false)}>Cancel</UiV2Button>
                  <UiV2Button disabled={controller.busy} type="button" onClick={() => void controller.actions.updateProject({ expectedAccessRevision: project.accessRevision, status: "ARCHIVED" }).then((saved) => { if (saved) setConfirmArchive(false); })}>Archive project</UiV2Button>
                </div>
              ) : null}
              {confirmDelete ? (
                <div className="v2-project-confirmation" role="alertdialog" aria-label="Confirm project deletion">
                  <strong>Delete {project.name}?</strong>
                  <p>
                    Permanently removes {project.chatCount} chat{project.chatCount === 1 ? "" : "s"}, {project.fileCount ?? 0} file{(project.fileCount ?? 0) === 1 ? "" : "s"}, shared Memory, and access for {project.audienceCount} member{project.audienceCount === 1 ? "" : "s"}. This cannot be undone.
                  </p>
                  <label>
                    Type <strong>{project.name}</strong> to confirm
                    <input autoComplete="off" value={deleteProjectName} onChange={(event) => setDeleteProjectName(event.target.value)} />
                  </label>
                  <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => { setConfirmDelete(false); setDeleteProjectName(""); }}>Cancel</UiV2Button>
                  <UiV2Button disabled={controller.busy || deleteProjectName !== project.name} tone="destructive" type="button" onClick={() => void controller.actions.deleteProject()}>Delete permanently</UiV2Button>
                </div>
              ) : null}
            </form>
          ) : null}

          {tab === "members" ? (
            <section className="v2-project-settings-section">
              <div className="v2-project-section-heading"><h2>Members and groups</h2><p>Project roles govern shared content and every resource explicitly published here; personal grants are not required.</p></div>
              <p className="v2-project-empty">Viewer reads · Contributor chats and uploads · Manager administers shared content · Owner controls lifecycle and ownership.</p>
              <p className="v2-project-empty">Your {project.effectiveRole.toLowerCase()} access comes from {accessSources.join(" and ")}.</p>
              <div className="v2-project-list-table">
                {project.grants.map((grant) => {
                  const mutable = manager && (owner || (
                    project.capabilities.manageMembers && grant.role !== "OWNER" && grant.role !== "MANAGER"
                  ));
                  const allowedRoles = mutable
                    ? roles.filter((role) =>
                        (!grant.group || role !== "OWNER") &&
                        (owner || (role !== "OWNER" && role !== "MANAGER"))
                      )
                    : [grant.role];
                  return (
                    <div className="v2-project-list-row" key={grant.id}>
                      <span><strong>{grant.user?.displayName ?? grant.group?.name ?? "Unavailable principal"}</strong><small>{grant.user?.email ?? (grant.group ? "Group" : "Access revoked")}</small></span>
                      <select disabled={controller.busy || !mutable} aria-label={`Role for ${grant.user?.displayName ?? grant.group?.name}`} value={grant.role} onChange={(event) => void controller.actions.updateGrant(grant.id, event.target.value as ProjectRole)}>
                        {allowedRoles.map((role) => <option key={role} value={role}>{role.toLowerCase()}</option>)}
                      </select>
                      {manager ? <UiV2IconButton disabled={controller.busy || !mutable} icon="close" label="Remove access" onClick={() => void requestGrantRemoval(grant.id)} /> : null}
                    </div>
                  );
                })}
              </div>
              {manager ? (
                <form className="v2-project-inline-form" onSubmit={(event) => {
                  event.preventDefault();
                  if (!grantId) return;
                  const candidate = candidates.find((entry) => entry.id === grantId);
                  if (candidate && !candidate.disabledReason) {
                    setGrantAddConfirmation({ candidate, kind: grantKind, role: grantRole });
                  }
                }}>
                  <select aria-label="Principal type" value={grantKind} onChange={(event) => {
                    const kind = event.target.value as "group" | "user";
                    setGrantKind(kind);
                    setGrantId("");
                    setCandidateQuery("");
                    if (kind === "group" && grantRole === "OWNER") setGrantRole("CONTRIBUTOR");
                  }}><option value="user">Person</option><option value="group">Group</option></select>
                  <input aria-label={grantKind === "user" ? "Search people" : "Search groups"} placeholder={grantKind === "user" ? "Search by name or email" : "Search groups"} value={candidateQuery} onChange={(event) => { setCandidateQuery(event.target.value); setGrantId(""); }} />
                  <div className="v2-project-picker" role="listbox" aria-label={grantKind === "user" ? "People" : "Groups"} onKeyDown={movePickerFocus}>
                    {candidateLoading && candidates.length === 0 ? <small>Searching…</small> : candidateError && candidates.length === 0 ? <small role="alert">{candidateError}</small> : candidates.length === 0 ? <small>No matching active {grantKind === "user" ? "people" : "groups"}.</small> : candidates.map((candidate) => (
                      <button
                        aria-selected={grantId === candidate.id}
                        className="v2-focusable"
                        disabled={Boolean(candidate.disabledReason)}
                        key={candidate.id}
                        role="option"
                        type="button"
                        onClick={() => setGrantId(candidate.id)}
                      ><strong>{candidate.label}</strong>{candidate.description ? <small>{candidate.description}</small> : null}{candidate.disabledReason ? <small>{candidateDisabledLabel(candidate.disabledReason)}</small> : null}</button>
                    ))}
                  </div>
                  <small aria-live="polite" role="status">{candidateLoading ? "Searching" : candidateError ? candidateError : `${candidates.length} result${candidates.length === 1 ? "" : "s"}`}</small>
                  {candidateError ? <UiV2Button tone="ghost" type="button" onClick={() => setCandidateReload((value) => value + 1)}>Try again</UiV2Button> : null}
                  {candidateNextCursor ? <UiV2Button disabled={candidateLoading} tone="ghost" type="button" onClick={() => void loadMoreCandidates()}>Load more</UiV2Button> : null}
                  {grantId ? <small>Selected: {candidates.find((candidate) => candidate.id === grantId)?.label ?? "principal"}</small> : null}
                  <select aria-label="Project role" value={grantRole} onChange={(event) => setGrantRole(event.target.value as ProjectRole)}>{roles.filter((role) =>
                    (grantKind !== "group" || role !== "OWNER") &&
                    (owner || (role !== "OWNER" && role !== "MANAGER"))
                  ).map((role) => <option key={role} value={role}>{role.toLowerCase()}</option>)}</select>
                  <UiV2Button disabled={controller.busy || !grantId} type="submit">Add access</UiV2Button>
                </form>
              ) : null}
              {grantAddConfirmation ? (
                <div className="v2-project-confirmation" role="alertdialog" aria-label="Confirm Project access">
                  <strong>Add {grantAddConfirmation.candidate.label}?</strong>
                  <p>{grantAddConfirmation.candidate.description ?? "Active directory principal"}</p>
                  <p>
                    Grants {grantAddConfirmation.role.toLowerCase()} access to this shared Project.
                    {grantAddConfirmation.kind === "group" ? " Every active group member receives an effective role at least this high." : " Existing group-derived access remains in effect."}
                  </p>
                  <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => setGrantAddConfirmation(null)}>Cancel</UiV2Button>
                  <UiV2Button disabled={controller.busy} type="button" onClick={() => void commitGrantAdd()}>Add access</UiV2Button>
                </div>
              ) : null}
              {grantRemovalConfirmation ? (
                <div className="v2-project-confirmation" role="alertdialog" aria-label="Confirm Project access removal">
                  <strong>Remove {grantRemovalConfirmation.preview.grant.label}?</strong>
                  <p>
                    {grantRemovalConfirmation.preview.losesAccessCount} active {grantRemovalConfirmation.preview.losesAccessCount === 1 ? "person loses" : "people lose"} Project access.
                    {grantRemovalConfirmation.preview.roleChangeCount > 0
                      ? ` ${grantRemovalConfirmation.preview.roleChangeCount} ${grantRemovalConfirmation.preview.roleChangeCount === 1 ? "person keeps access with a different role" : "people keep access with different roles"}.`
                      : ""}
                  </p>
                  {grantRemovalConfirmation.preview.reason === "last_owner_required" ? (
                    <p>A Project must keep at least one direct active Owner.</p>
                  ) : null}
                  <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => setGrantRemovalConfirmation(null)}>Cancel</UiV2Button>
                  <UiV2Button
                    disabled={controller.busy || !grantRemovalConfirmation.preview.canCommit}
                    tone="destructive"
                    type="button"
                    onClick={() => void commitGrantRemoval()}
                  >Remove access</UiV2Button>
                </div>
              ) : null}
              <div className="v2-project-danger">
                <div>
                  <strong>Your access</strong>
                  <span>
                    {project.directRole === "OWNER"
                      ? "Owners must assign another Owner and remove their Owner grant before leaving."
                      : project.directRole
                        ? project.grantedThrough.length > 0
                          ? `Removing direct access keeps this Project available through ${project.grantedThrough.map((grant) => grant.groupName).join(", ")}.`
                          : "Leaving removes your direct access to this Project."
                        : `Your access is managed by ${project.grantedThrough.map((grant) => grant.groupName).join(", ")}; group-only access cannot be removed here.`}
                  </span>
                </div>
                {project.directRole && project.directRole !== "OWNER" ? (
                  <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => setLeaveConfirmation(true)}>
                    {project.grantedThrough.length > 0 ? "Remove my direct access" : "Leave project"}
                  </UiV2Button>
                ) : null}
              </div>
              {leaveConfirmation ? (
                <div className="v2-project-confirmation" role="alertdialog" aria-label="Confirm leaving Project">
                  <strong>{project.grantedThrough.length > 0 ? "Remove your direct access?" : `Leave ${project.name}?`}</strong>
                  <p>
                    {project.grantedThrough.length > 0
                      ? `You will keep ${project.effectiveRole.toLowerCase()} access through ${project.grantedThrough.map((grant) => grant.groupName).join(", ")}.`
                      : "The Project disappears from your workspace. Shared content remains for its other members."}
                  </p>
                  <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => setLeaveConfirmation(false)}>Cancel</UiV2Button>
                  <UiV2Button disabled={controller.busy} tone="destructive" type="button" onClick={() => void controller.actions.leaveProject().then((left) => { if (left) setLeaveConfirmation(false); })}>
                    {project.grantedThrough.length > 0 ? "Remove direct access" : "Leave project"}
                  </UiV2Button>
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === "resources" ? (
            <section className="v2-project-settings-section">
              <div className="v2-project-section-heading"><h2>Linked resources</h2><p>Active linked resources are available to every Contributor, Manager and Owner in this Project.</p></div>
              <div className="v2-project-list-table">
                {project.resources.length === 0 ? <p className="v2-project-empty">No resources linked.</p> : resourceTypes.map((type) => {
                  const resources = project.resources.filter((resource) => resource.type === type);
                  if (resources.length === 0) return null;
                  return <section key={type} aria-label={`${type} resources`}>
                    <h3>{type === "mcp" ? "MCP" : type.slice(0, 1).toUpperCase() + type.slice(1)}</h3>
                    {resources.map((resource) => (
                      <div className="v2-project-list-row" key={resource.id}>
                        <span>
                          <strong>{resource.label}</strong>
                          <small>{resourceIsDefault(resource) ? "Project default" : "Attached/published"} · {resource.available ? "available" : resource.reason ?? "unavailable"}</small>
                          {resource.description ? <small>{resource.description}</small> : null}
                        </span>
                        {manager ? <UiV2IconButton disabled={controller.busy} icon="close" label={`Unlink ${resource.label}`} onClick={() => void requestResourceRemoval(resource.id)} /> : null}
                      </div>
                    ))}
                  </section>;
                })}
              </div>
              {manager ? (
                <form className="v2-project-inline-form" onSubmit={(event) => {
                  event.preventDefault();
                  void requestResourceAdd();
                }}>
                  <select aria-label="Resource type" value={resourceType} onChange={(event) => { setResourceType(event.target.value as typeof resourceType); setResourceId(""); setCandidateQuery(""); setResourceConfirmation(null); }}><option value="model">Model</option><option value="search">Search</option><option value="knowledge">Knowledge</option><option value="assistant">Assistant</option><option value="skill">Skill</option><option value="mcp">MCP</option></select>
                  <input aria-label="Search resources" placeholder={`Search ${resourceType}s`} value={candidateQuery} onChange={(event) => { setCandidateQuery(event.target.value); setResourceId(""); }} />
                  <div className="v2-project-picker" role="listbox" aria-label={`${resourceType} candidates`} onKeyDown={movePickerFocus}>
                    {candidateLoading && candidates.length === 0 ? <small>Searching…</small> : candidateError && candidates.length === 0 ? <small role="alert">{candidateError}</small> : candidates.length === 0 ? <small>No matching Project-safe resources.</small> : candidates.map((candidate) => (
                      <button
                        aria-selected={resourceId === candidate.id}
                        className="v2-focusable"
                        disabled={Boolean(candidate.disabledReason)}
                        key={candidate.id}
                        role="option"
                        type="button"
                        onClick={() => setResourceId(candidate.id)}
                      ><strong>{candidate.label}</strong>{candidate.description ? <small>{candidate.description}</small> : null}{candidate.disabledReason ? <small>{candidateDisabledLabel(candidate.disabledReason)}</small> : null}</button>
                    ))}
                  </div>
                  <small aria-live="polite" role="status">{candidateLoading ? "Searching" : candidateError ? candidateError : `${candidates.length} result${candidates.length === 1 ? "" : "s"}`}</small>
                  {candidateError ? <UiV2Button tone="ghost" type="button" onClick={() => setCandidateReload((value) => value + 1)}>Try again</UiV2Button> : null}
                  {candidateNextCursor ? <UiV2Button disabled={candidateLoading} tone="ghost" type="button" onClick={() => void loadMoreCandidates()}>Load more</UiV2Button> : null}
                  {resourceId ? <small>Selected: {candidates.find((candidate) => candidate.id === resourceId)?.label ?? "resource"}</small> : null}
                  <UiV2Button disabled={controller.busy || !resourceId} type="submit">Add to Project</UiV2Button>
                </form>
              ) : null}
              {resourceConfirmation ? (
                <div className="v2-project-confirmation" role="alertdialog" aria-label={resourceConfirmation.kind === "add" ? "Confirm Project resource publication" : "Confirm Project resource unlink"}>
                  <strong>
                    {resourceConfirmation.kind === "add"
                      ? `Add ${resourceConfirmation.label} to this Project?`
                      : `Unlink ${resourceConfirmation.label}?`}
                  </strong>
                  {resourceConfirmation.kind === "add" ? (
                    <p>
                      It becomes available to all current and future Contributors, Managers and Owners in this Project. It does not change anyone&apos;s personal catalog.
                    </p>
                  ) : (
                    <p>Future Project runs stop using this resource immediately after the atomic cleanup.</p>
                  )}
                  {resourceConfirmation.preview?.dependencies.length ? (
                    <div>
                      <strong>Assistant dependencies</strong>
                      <ul>
                        {resourceConfirmation.preview.dependencies.map((dependency, index) => (
                          <li key={`${dependency.type}:${dependency.label}:${index}`}>
                            <span>{dependency.label} · {dependency.type}</span>
                            <small>
                              {dependency.state === "active"
                                ? "Already active in this Project"
                                : dependency.state === "will_add"
                                  ? "Will be added atomically"
                                  : dependency.reason ?? "Unavailable"}
                            </small>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  {resourceConfirmation.preview?.consequences.clearedDefaults.length ? (
                    <p>Clears: {resourceConfirmation.preview.consequences.clearedDefaults.join(", ")}.</p>
                  ) : null}
                  {resourceConfirmation.preview?.consequences.dependentAssistants.length ? (
                    <p>
                      Also unpublishes dependent Assistants: {resourceConfirmation.preview.consequences.dependentAssistants.join(", ")}.
                    </p>
                  ) : null}
                  {resourceConfirmation.preview?.consequences.affectedChatCount ? (
                    <p>
                      Cleans defaults in {resourceConfirmation.preview.consequences.affectedChatCount} shared chat{resourceConfirmation.preview.consequences.affectedChatCount === 1 ? "" : "s"}.
                    </p>
                  ) : null}
                  <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => setResourceConfirmation(null)}>Cancel</UiV2Button>
                  <UiV2Button
                    disabled={controller.busy || resourceConfirmation.preview?.canCommit === false}
                    tone={resourceConfirmation.kind === "remove" ? "destructive" : "primary"}
                    type="button"
                    onClick={() => void commitResourceChange()}
                  >
                    {resourceConfirmation.kind === "add"
                      ? resourceConfirmation.type === "assistant" ? "Add Assistant and dependencies" : "Add to Project"
                      : "Unlink and clean up"}
                  </UiV2Button>
                </div>
              ) : null}
            </section>
          ) : null}

          {tab === "memory" ? (
            <section className="v2-project-settings-section">
              <div className="v2-project-section-heading"><h2>Project Memory</h2><p>Only explicit facts live here. Pending proposals are never added to model context.</p></div>
              {!controller.memory ? <p className="v2-project-empty">Loading memory…</p> : (
                <>
                  <div className="v2-project-memory-list">
                    {controller.memory.facts.length === 0 ? <p className="v2-project-empty">No approved facts.</p> : controller.memory.facts.map((fact) => (
                      <div key={fact.factId}>
                        <span>{fact.text}</span>
                        <small>v{fact.versionNumber} · {fact.createdByDisplayName}{fact.validUntil ? ` · valid until ${new Date(fact.validUntil).toLocaleString()}` : ""}</small>
                        {manager && project.capabilities.manageMemory ? <span className="v2-project-memory-actions">
                          <button type="button" onClick={() => { setEditingFactId(fact.factId); setEditingFactText(fact.text); }}>Edit</button>
                          <button type="button" onClick={() => setForgetFactId(fact.factId)}>Forget</button>
                        </span> : null}
                        {editingFactId === fact.factId ? <form onSubmit={(event) => { event.preventDefault(); if (!editingFactText.trim()) return; void controller.actions.editMemoryFact(fact.factId, editingFactText.trim()).then((saved) => { if (saved) setEditingFactId(null); }); }}>
                          <textarea aria-label="Edit project fact" maxLength={4000} rows={2} value={editingFactText} onChange={(event) => setEditingFactText(event.target.value)} />
                          <button type="submit" disabled={controller.busy || !editingFactText.trim()}>Save</button>
                          <button type="button" onClick={() => setEditingFactId(null)}>Cancel</button>
                        </form> : null}
                        {forgetFactId === fact.factId ? <div className="v2-project-confirmation" role="alertdialog" aria-label="Confirm forgetting fact"><span>Forget this shared fact for everyone? It will no longer be used in future Project runs; existing chat output is unchanged.</span><button type="button" onClick={() => setForgetFactId(null)}>Cancel</button><button type="button" disabled={controller.busy} onClick={() => { setForgetFactId(null); void controller.actions.forgetMemoryFact(fact.factId); }}>Forget</button></div> : null}
                      </div>
                    ))}
                  </div>
                  {controller.memory.proposals.length > 0 ? <h3>Pending proposals</h3> : null}
                  <div className="v2-project-memory-list">
                    {controller.memory.proposals.map((proposal) => <div key={proposal.id}><span>{proposal.proposedText}</span><small>Proposed by {proposal.proposedByDisplayName}</small>{proposal.source ? <small>Evidence from {proposal.source.authorDisplayName ?? "project member"}: “{proposal.source.text}”</small> : null}{manager && project.capabilities.manageMemory ? <span className="v2-project-memory-actions"><button type="button" onClick={() => void controller.actions.reviewMemoryProposal(proposal.id, true)}>Approve</button><button type="button" onClick={() => void controller.actions.reviewMemoryProposal(proposal.id, false)}>Reject</button></span> : null}</div>)}
                  </div>
                </>
              )}
              {project.status === "ACTIVE" && project.capabilities.manageMemory && project.memoryEnabled ? (
                <form className="v2-project-memory-form" onSubmit={(event) => {
                  event.preventDefault();
                  if (!memoryText.trim()) return;
                  const validUntil = memoryValidUntil
                    ? new Date(memoryValidUntil).toISOString()
                    : null;
                  void controller.actions.saveMemory(memoryText.trim(), true, undefined, validUntil).then((saved) => { if (saved) { setMemoryText(""); setMemoryValidUntil(""); } });
                }}><textarea maxLength={4000} rows={3} placeholder="Add an approved project fact" value={memoryText} onChange={(event) => setMemoryText(event.target.value)} /><label>Valid until <span>Optional</span><input type="datetime-local" value={memoryValidUntil} onChange={(event) => setMemoryValidUntil(event.target.value)} /></label><UiV2Button disabled={controller.busy || !memoryText.trim()} type="submit">Add fact</UiV2Button></form>
              ) : project.status === "ACTIVE" && project.capabilities.mutateChats && project.memoryEnabled ? (
                <p className="v2-project-empty">Select a user message in a shared chat to propose it for Project Memory.</p>
              ) : null}
            </section>
          ) : null}

          {tab === "activity" ? (
            <section className="v2-project-settings-section">
              <div className="v2-project-section-heading"><h2>Activity</h2><p>Administrative project changes without conversation content or tool payloads.</p></div>
              <div className="v2-project-activity">
                {controller.activityError && !controller.activity ? (
                  <div className="v2-project-activity-state" role="alert">
                    <p>Activity could not be loaded. {controller.activityError}</p>
                    <UiV2Button tone="ghost" type="button" onClick={() => controller.actions.openSettings("activity")}>Try again</UiV2Button>
                  </div>
                ) : !controller.activity ? (
                  <p className="v2-project-empty">Loading activity…</p>
                ) : controller.activity.events.length === 0 ? (
                  <p className="v2-project-empty">No Project activity yet.</p>
                ) : controller.activity.events.map((event) => {
                  const detail = activityDetail(event);
                  return <div key={event.id}>
                    <span className="v2-project-activity-copy">{activityLabels[event.eventType] ?? "Project activity"}{detail ? <small>{detail}</small> : null}</span>
                    <strong>{event.actorDisplayName}</strong>
                    <time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time>
                  </div>;
                })}
                {controller.activity?.nextCursor ? <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => void controller.actions.loadMoreActivity?.()}>Load more</UiV2Button> : null}
                {controller.activity && controller.activity.events.length > 0 && !controller.activity.nextCursor ? <p className="v2-project-activity-end">End of activity</p> : null}
              </div>
            </section>
          ) : null}
        </div>
      </section>
      {discardOpen ? <DiscardChangesConfirmationDialog label="Project settings" onCancel={() => setDiscardOpen(false)} onConfirm={() => { setDiscardOpen(false); controller.actions.closeSettings(); }} /> : null}
    </div>,
    document.body
  );
}
