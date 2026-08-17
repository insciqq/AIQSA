"use client";

import { UiV2Button, UiV2Icon, UiV2IconButton } from "@/components/ui-v2";
import { useModalLayerV2 } from "@/components/ui-v2/useModalLayerV2";
import type { ProjectRole } from "@/lib/domain/projects";
import { createPortal } from "react-dom";
import { useState } from "react";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

const roles: readonly ProjectRole[] = ["VIEWER", "CONTRIBUTOR", "MANAGER", "OWNER"];

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
      <UiV2IconButton icon="settings" label={`Open ${project.name} details`} onClick={controller.actions.openSettings} />
    </aside>
  );
}

export function ProjectBlankOrientationV2({
  activeChat,
  controller
}: Readonly<{ activeChat: boolean; controller: ProjectWorkspaceController }>) {
  const project = controller.detail;
  if (!project) return null;
  return (
    <div className="v2-project-blank" data-testid="project-blank-orientation">
      <span className="v2-project-blank-mark" aria-hidden="true">{project.name.slice(0, 1).toUpperCase()}</span>
      <p>Shared project</p>
      <h1>{project.name}</h1>
      <span>
        Messages and files here are visible to project members. Personal Memory is never used in shared chats.
      </span>
      {project.description ? <small>{project.description}</small> : null}
      {!activeChat && project.status === "ACTIVE" && project.capabilities.mutateChats ? (
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
  const stateKey = [
    project.id,
    project.instructionsRevision,
    project.policyRevision,
    project.memoryRevision,
    project.status,
    project.publicSharingEnabled
  ].join(":");
  return <ProjectSettingsDialogContentV2 controller={controller} key={stateKey} project={project} />;
}

function ProjectSettingsDialogContentV2({
  controller,
  project
}: Readonly<{
  controller: ProjectWorkspaceController;
  project: NonNullable<ProjectWorkspaceController["detail"]>;
}>) {
  const [tab, setTab] = useState<ProjectSettingsTab>("general");
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
  const [resourceType, setResourceType] = useState<"assistant" | "knowledge" | "mcp" | "model" | "search">("model");
  const [resourceId, setResourceId] = useState("");
  const [revisionId, setRevisionId] = useState("");
  const [memoryText, setMemoryText] = useState("");
  const [memoryValidUntil, setMemoryValidUntil] = useState("");
  const { dialogRef, initialFocusRef, onDialogKeyDown, portalReady } = useModalLayerV2({
    closeBlocked: controller.busy,
    onClose: controller.actions.closeSettings
  });

  if (!portalReady) return null;
  const owner = project.effectiveRole === "OWNER";
  const manager = project.status === "ACTIVE" && project.capabilities.manageProject;
  const modelResources = project.resources.filter((resource) => resource.type === "model");
  const assistantResources = project.resources.filter((resource) => resource.type === "assistant");
  const knowledgeResources = project.resources.filter((resource) => resource.type === "knowledge");
  const searchResources = project.resources.filter((resource) => resource.type === "search");
  const mcpResources = project.resources.filter((resource) => resource.type === "mcp");
  const archivedChats = (controller.workspace?.chats ?? []).filter((chat) => chat.archived);
  const accessSources = [
    ...(project.directRole ? [`direct ${project.directRole.toLowerCase()}`] : []),
    ...project.grantedThrough.map((grant) =>
      `${grant.groupName} (${grant.role.toLowerCase()})`
    )
  ];
  const tabs: readonly { id: ProjectSettingsTab; icon: "history" | "memory" | "settings" | "tool" | "assistant"; label: string }[] = [
    { id: "general", icon: "settings", label: "Project" },
    { id: "members", icon: "assistant", label: "Members" },
    { id: "resources", icon: "tool", label: "Resources" },
    { id: "memory", icon: "memory", label: "Memory" },
    { id: "activity", icon: "history", label: "Activity" }
  ];

  return createPortal(
    <div className="v2-project-scrim" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) controller.actions.closeSettings();
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
          <UiV2IconButton ref={initialFocusRef} disabled={controller.busy} icon="close" label="Close project settings" onClick={controller.actions.closeSettings} />
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
        {controller.actionError ? <p className="v2-project-settings-error" role="alert">{controller.actionError}</p> : null}
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
                  <label className="v2-project-check" key={resource.id}><input checked={defaultSearchIds.includes(resource.resourceId)} disabled={!resource.available} type="checkbox" onChange={(event) => setDefaultSearchIds((current) => event.target.checked ? [...new Set([...current, resource.resourceId])] : current.filter((id) => id !== resource.resourceId))} /><span><strong>{resource.label}</strong><small>{resource.available ? "Available to entitled members" : resource.reason ?? "Unavailable"}</small></span></label>
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
                    <UiV2Button disabled={controller.busy} tone="ghost" type="button" onClick={() => void controller.actions.updateProject({ expectedAccessRevision: project.accessRevision, status: project.status === "ARCHIVED" ? "ACTIVE" : "ARCHIVED" })}>{project.status === "ARCHIVED" ? "Restore project" : "Archive project"}</UiV2Button>
                    <UiV2Button disabled={controller.busy} tone="destructive" type="button" onClick={() => {
                      if (window.confirm(`Delete ${project.name}? Project chats and files will be removed.`)) void controller.actions.deleteProject();
                    }}>Delete project</UiV2Button>
                  </div>
                </div>
              ) : null}
            </form>
          ) : null}

          {tab === "members" ? (
            <section className="v2-project-settings-section">
              <div className="v2-project-section-heading"><h2>Members and groups</h2><p>Project roles control shared content only; provider and tool entitlements remain separate.</p></div>
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
                      {manager ? <UiV2IconButton disabled={controller.busy || !mutable} icon="close" label="Remove access" onClick={() => void controller.actions.removeGrant(grant.id)} /> : null}
                    </div>
                  );
                })}
              </div>
              {manager ? (
                <form className="v2-project-inline-form" onSubmit={(event) => {
                  event.preventDefault();
                  if (!grantId.trim()) return;
                  void controller.actions.addGrant({
                    ...(grantKind === "user" ? { userId: grantId.trim() } : { groupId: grantId.trim() }),
                    role: grantRole
                  }).then((saved) => { if (saved) setGrantId(""); });
                }}>
                  <select aria-label="Principal type" value={grantKind} onChange={(event) => {
                    const kind = event.target.value as "group" | "user";
                    setGrantKind(kind);
                    if (kind === "group" && grantRole === "OWNER") setGrantRole("CONTRIBUTOR");
                  }}><option value="user">User ID</option><option value="group">Group ID</option></select>
                  <input aria-label="User or group ID" placeholder={grantKind === "user" ? "User ID" : "Group ID"} value={grantId} onChange={(event) => setGrantId(event.target.value)} />
                  <select aria-label="Project role" value={grantRole} onChange={(event) => setGrantRole(event.target.value as ProjectRole)}>{roles.filter((role) =>
                    (grantKind !== "group" || role !== "OWNER") &&
                    (owner || (role !== "OWNER" && role !== "MANAGER"))
                  ).map((role) => <option key={role} value={role}>{role.toLowerCase()}</option>)}</select>
                  <UiV2Button disabled={controller.busy || !grantId.trim()} type="submit">Add access</UiV2Button>
                </form>
              ) : null}
            </section>
          ) : null}

          {tab === "resources" ? (
            <section className="v2-project-settings-section">
              <div className="v2-project-section-heading"><h2>Linked resources</h2><p>Exact external resources are linked; each participant still needs their own entitlement.</p></div>
              <div className="v2-project-list-table">
                {project.resources.length === 0 ? <p className="v2-project-empty">No resources linked.</p> : project.resources.map((resource) => (
                  <div className="v2-project-list-row" key={resource.id}>
                    <span><strong>{resource.label}</strong><small>{resource.type} · {resource.available ? "available" : resource.reason ?? "unavailable"}</small></span>
                    <code>{resource.resourceId}</code>
                    {manager ? <UiV2IconButton disabled={controller.busy} icon="close" label={`Unlink ${resource.label}`} onClick={() => void controller.actions.removeResource(resource.id)} /> : null}
                  </div>
                ))}
              </div>
              {manager ? (
                <form className="v2-project-inline-form" onSubmit={(event) => {
                  event.preventDefault();
                  if (!resourceId.trim()) return;
                  void controller.actions.addResource({ resourceId: resourceId.trim(), ...(revisionId.trim() ? { revisionId: revisionId.trim() } : {}), type: resourceType }).then((saved) => { if (saved) { setResourceId(""); setRevisionId(""); } });
                }}>
                  <select aria-label="Resource type" value={resourceType} onChange={(event) => setResourceType(event.target.value as typeof resourceType)}><option value="model">Model</option><option value="search">Search</option><option value="knowledge">Knowledge</option><option value="assistant">Assistant</option><option value="mcp">MCP</option></select>
                  <input aria-label="Resource ID" placeholder="Resource ID" value={resourceId} onChange={(event) => setResourceId(event.target.value)} />
                  <input aria-label="Revision ID" placeholder="Revision ID (Assistant only)" value={revisionId} onChange={(event) => setRevisionId(event.target.value)} />
                  <UiV2Button disabled={controller.busy || !resourceId.trim()} type="submit">Link resource</UiV2Button>
                </form>
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
                      <div key={fact.factId}><span>{fact.text}</span><small>v{fact.versionNumber} · {fact.createdByDisplayName}{fact.validUntil ? ` · valid until ${new Date(fact.validUntil).toLocaleString()}` : ""}</small>{manager && project.capabilities.manageMemory ? <span className="v2-project-memory-actions"><button type="button" onClick={() => { const next = window.prompt("Edit project fact", fact.text); if (next?.trim()) void controller.actions.editMemoryFact(fact.factId, next.trim()); }}>Edit</button><button type="button" onClick={() => void controller.actions.forgetMemoryFact(fact.factId)}>Forget</button></span> : null}</div>
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
                {!controller.activity ? <p className="v2-project-empty">Loading activity…</p> : controller.activity.events.map((event) => <div key={event.id}><span>{event.eventType.replaceAll("_", " ")}</span><strong>{event.actorDisplayName}</strong><time dateTime={event.createdAt}>{new Date(event.createdAt).toLocaleString()}</time></div>)}
              </div>
            </section>
          ) : null}
        </div>
      </section>
    </div>,
    document.body
  );
}
