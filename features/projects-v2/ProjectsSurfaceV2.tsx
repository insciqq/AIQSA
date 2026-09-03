"use client";

import { UiV2Button, UiV2Icon, UiV2IconButton, UiV2Skeleton } from "@/components/ui-v2";
import type { ProjectDetailWire, ProjectSummaryWire } from "@/lib/contracts/projects";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  formatProjectDate,
  projectActivityDetail,
  projectActivityLabel
} from "./projectPresentation";
import type { ProjectWorkspaceController } from "./useProjectWorkspaceController";

type ProjectFilter = "all" | "archived" | "shared" | "yours";

const filterLabels: Readonly<Record<ProjectFilter, string>> = {
  all: "All",
  archived: "Archived",
  shared: "Shared",
  yours: "Yours"
};

function roleLabel(role: ProjectSummaryWire["effectiveRole"]): string {
  return `${role.slice(0, 1)}${role.slice(1).toLowerCase()}`;
}

function filterProjects(
  projects: readonly ProjectSummaryWire[],
  filter: ProjectFilter
): readonly ProjectSummaryWire[] {
  return projects.filter((project) => {
    return filter === "archived"
      ? project.status !== "ACTIVE"
      : project.status === "ACTIVE" && (
          filter === "all" ||
          (filter === "yours" && project.effectiveRole === "OWNER") ||
          (filter === "shared" && project.effectiveRole !== "OWNER")
        );
  });
}

function ProjectsLocation({
  current,
  onBackToChat
}: Readonly<{ current?: string; onBackToChat(): void }>) {
  return (
    <header className="v2-project-page-topbar">
      <nav aria-label="Projects location">
        <span>Projects</span>
        {current ? <><UiV2Icon name="chevron-right" /><span>{current}</span></> : null}
      </nav>
      <UiV2Button aria-label="Back to chat" icon="arrow-left" onClick={onBackToChat}>
        Back to chat
      </UiV2Button>
    </header>
  );
}

export function ProjectsLandingPageV2({
  controller,
  onBackToChat
}: Readonly<{
  controller: ProjectWorkspaceController;
  onBackToChat(): void;
}>) {
  const [filter, setFilter] = useState<ProjectFilter>("all");
  const counts = useMemo(() => ({
    all: controller.projects.filter((project) => project.status === "ACTIVE").length,
    archived: controller.projects.filter((project) => project.status !== "ACTIVE").length,
    shared: controller.projects.filter(
      (project) => project.status === "ACTIVE" && project.effectiveRole !== "OWNER"
    ).length,
    yours: controller.projects.filter(
      (project) => project.status === "ACTIVE" && project.effectiveRole === "OWNER"
    ).length
  }), [controller.projects]);
  const visibleProjects = useMemo(
    () => filterProjects(controller.projects, filter),
    [controller.projects, filter]
  );
  const openProjectDetails = async (projectId: string): Promise<void> => {
    if (await controller.actions.selectProject(projectId)) {
      controller.actions.openSettings("general");
    }
  };

  return (
    <section className="v2-project-page" data-testid="projects-landing-page">
      <ProjectsLocation onBackToChat={onBackToChat} />
      <div className="v2-project-page-scroll">
        <div className="v2-project-page-intro">
          <h1>Projects</h1>
          <p>
            A project is a shared space: its chats, folders and setup belong to the whole team,
            not to one person. Personal chats stay in Chats.
          </p>
        </div>

        {controller.listLoading && controller.projects.length === 0 ? (
          <div aria-label="Loading projects" className="v2-project-card-grid">
            {[0, 1, 2, 3].map((index) => <UiV2Skeleton className="v2-project-card-skeleton" key={index} />)}
          </div>
        ) : controller.listError && controller.projects.length === 0 ? (
          <div className="v2-project-page-state" role="alert">
            <UiV2Icon name="alert" />
            <h2>Projects are unavailable</h2>
            <p>{controller.listError}</p>
            <UiV2Button onClick={() => void controller.actions.refreshList()}>Try again</UiV2Button>
          </div>
        ) : controller.projects.length === 0 ? (
          <div className="v2-project-page-state">
            <UiV2Icon name="layers" />
            <h2>No projects yet</h2>
            <p>
              Create a shared space now. If no shared model is available, you can finish its setup
              after creation.
            </p>
            <UiV2Button icon="plus" onClick={controller.actions.openCreate}>New project</UiV2Button>
          </div>
        ) : (
          <>
            <div aria-label="Project filters" className="v2-project-filters" role="group">
              {(Object.keys(filterLabels) as ProjectFilter[]).map((id) => (
                <button
                  aria-pressed={filter === id}
                  className="v2-project-filter v2-focusable"
                  key={id}
                  type="button"
                  onClick={() => setFilter(id)}
                >
                  {filterLabels[id]} <span>{counts[id]}</span>
                </button>
              ))}
            </div>
            {visibleProjects.length === 0 ? (
              <p className="v2-project-page-empty">No projects match this view.</p>
            ) : (
              <div className="v2-project-card-grid">
                {visibleProjects.map((project) => (
                  <div className="v2-project-card-wrap" key={project.id}>
                    <button
                      aria-label={`Open ${project.name}`}
                      className="v2-project-card v2-focusable"
                      data-testid={`project-card-${project.id}`}
                      type="button"
                      onClick={() => void controller.actions.selectProject(project.id)}
                    >
                      <span className="v2-project-card-head">
                        <span className="v2-project-mark" aria-hidden="true">
                          {project.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          <strong>{project.name}</strong>
                          <small>{roleLabel(project.effectiveRole)} · {project.audienceCount} {project.audienceCount === 1 ? "member" : "members"}</small>
                        </span>
                        {project.status !== "ACTIVE" ? (
                          <em>{project.status === "DELETING" ? "Deleting" : "Archived"}</em>
                        ) : null}
                      </span>
                      <span className="v2-project-card-description">
                        {project.description || "No description yet."}
                      </span>
                      <span className="v2-project-card-meta">
                        <span><UiV2Icon name="chat" />{project.chatCount} {project.chatCount === 1 ? "chat" : "chats"}</span>
                        <span>Updated {formatProjectDate(project.updatedAt)}</span>
                      </span>
                    </button>
                    <UiV2IconButton
                      icon="more"
                      label={`Open details for ${project.name}`}
                      onClick={() => void openProjectDetails(project.id)}
                    />
                  </div>
                ))}
              </div>
            )}
            <p className="v2-project-page-note">
              <UiV2Icon name="alert" />
              Project chats never appear in your personal Chats list, and Memory stays personal.
            </p>
          </>
        )}
      </div>
    </section>
  );
}

function setupRows(project: ProjectDetailWire): readonly Readonly<{
  icon: "book" | "chat" | "globe" | "tool";
  label: string;
  meta: string;
  state?: "ready" | "unavailable";
}>[] {
  const unavailableDefaults = new Set(project.unavailableDefaults ?? []);
  const defaultModel = project.resources.find((resource) =>
    resource.type === "model" && resource.resourceId === project.defaults.providerModelId
  );
  const knowledgeIds = new Set([
    ...project.defaults.knowledgePlan.baseIds,
    ...project.defaults.knowledgePlan.sourceIds
  ]);
  const knowledge = project.resources.filter(
    (resource) => resource.type === "knowledge" && knowledgeIds.has(resource.resourceId)
  );
  const externalToolsEnabled = project.policy.externalToolsEnabled;
  const mcpEnabled = externalToolsEnabled && project.defaults.mcpMode !== "off";
  const mcp = !mcpEnabled
    ? []
    : project.resources.filter((resource) => resource.type === "mcp");
  const searchIds = new Set(project.defaults.searchPlan.optionIds);
  const search = project.resources.filter(
    (resource) => resource.type === "search" && searchIds.has(resource.resourceId)
  );
  const knowledgeAvailable = knowledge.length > 0 && knowledge.every((resource) => resource.available);
  const mcpAvailable = mcp.length > 0 && mcp.every((resource) => resource.available);
  const searchAvailable = search.length > 0 && search.every((resource) => resource.available);

  return [
    {
      icon: "chat",
      label: unavailableDefaults.has("model")
        ? "Default model unavailable"
        : defaultModel?.label ?? "No default model",
      meta: unavailableDefaults.has("model")
        ? "The configured model is no longer usable; choose an available shared model"
        : defaultModel?.available
        ? "Model every member runs in this project"
        : "Choose an available shared model before the first answer",
      state: defaultModel?.available && !unavailableDefaults.has("model") ? "ready" : "unavailable"
    },
    {
      icon: "book",
      label: unavailableDefaults.has("knowledge")
        ? "Knowledge unavailable"
        : knowledge.length === 0
        ? "No Knowledge"
        : knowledge.length === 1 ? knowledge[0]!.label : `${knowledge.length} Knowledge resources`,
      meta: unavailableDefaults.has("knowledge")
        ? "The configured Project Knowledge selection needs review"
        : knowledge.length === 0
        ? "No Knowledge is selected for this Project"
        : `${knowledge.length} shared ${knowledge.length === 1 ? "resource" : "resources"}`,
      ...(unavailableDefaults.has("knowledge")
        ? { state: "unavailable" as const }
        : knowledge.length > 0
          ? { state: knowledgeAvailable ? "ready" as const : "unavailable" as const }
          : {})
    },
    {
      icon: "tool",
      label: !externalToolsEnabled
        ? "MCP off"
        : unavailableDefaults.has("mcp")
          ? "MCP unavailable"
        : project.defaults.mcpMode === "off"
          ? "MCP off"
        : mcp.length === 0
          ? "No shared MCP servers"
          : mcp.length === 1 ? mcp[0]!.label : `${mcp.length} shared MCP servers`,
      meta: !externalToolsEnabled
        ? "Off — external tools are disabled for this Project"
        : unavailableDefaults.has("mcp")
          ? "The configured shared MCP setup needs review"
        : project.defaults.mcpMode === "off"
        ? "External MCP tools are off for this Project"
        : mcp.length === 0
          ? "No MCP server is linked to this Project"
          : project.defaults.mcpMode === "auto" ? "Automatic selection from shared servers" : "All shared servers load",
      ...(!externalToolsEnabled
        ? {}
        : unavailableDefaults.has("mcp")
          ? { state: "unavailable" as const }
          : project.defaults.mcpMode === "off"
            ? {}
          : mcp.length > 0
            ? { state: mcpAvailable ? "ready" as const : "unavailable" as const }
            : {})
    },
    {
      icon: "globe",
      label: !externalToolsEnabled || search.length === 0 && !unavailableDefaults.has("search")
        ? "Web search"
        : unavailableDefaults.has("search")
          ? "Web search unavailable"
        : search.map((resource) => resource.label).join(", "),
      meta: !externalToolsEnabled
        ? "Off — external tools are disabled for this Project"
        : unavailableDefaults.has("search")
          ? "The configured Project Search selection needs review"
        : search.length === 0 ? "Off for this Project" : "Available to every member",
      ...(externalToolsEnabled && unavailableDefaults.has("search")
        ? { state: "unavailable" as const }
        : externalToolsEnabled && search.length > 0
          ? { state: searchAvailable ? "ready" as const : "unavailable" as const }
          : {})
    }
  ];
}

export function ProjectOverviewPageV2({
  composerSlot = null,
  controller,
  mobileNavigationSlot = null,
  onBackToChat,
  onStartChat
}: Readonly<{
  composerSlot?: ReactNode;
  controller: ProjectWorkspaceController;
  mobileNavigationSlot?: ReactNode;
  onBackToChat(): void;
  onStartChat(): void;
}>) {
  const project = controller.detail;
  const projectId = controller.selectedProjectId;
  const loadActivity = controller.actions.loadActivity;

  useEffect(() => {
    if (projectId && loadActivity) void loadActivity();
  }, [loadActivity, projectId]);

  if (!project) {
    return (
      <section className="v2-project-page" data-testid="project-overview-page">
        <ProjectsLocation onBackToChat={onBackToChat} />
        <div className="v2-project-page-state" role={controller.syncState === "error" ? "alert" : undefined}>
          {controller.syncState === "error" ? (
            <>
              <UiV2Icon name="alert" />
              <h2>Could not open this Project</h2>
              <p>{controller.actionError ?? "The shared workspace is unavailable."}</p>
              <UiV2Button onClick={() => void controller.actions.refresh()}>Try again</UiV2Button>
            </>
          ) : (
            <>
              <UiV2Skeleton className="v2-project-overview-skeleton" />
              <span className="v2-sr-only">Opening Project…</span>
            </>
          )}
        </div>
      </section>
    );
  }

  const canStart = project.status === "ACTIVE" &&
    project.capabilities.mutateChats && project.readiness !== "SETUP_REQUIRED";
  const startBlockedReason = project.status === "DELETING"
    ? "Permanent deletion is in progress. This Project is read-only and cannot start new chats."
    : project.status === "ARCHIVED"
      ? "Archived Projects are read-only. An owner or manager must restore this Project before new shared chats can start."
      : !project.capabilities.mutateChats
        ? "Contributor access is required to start a shared chat."
        : project.readiness === "SETUP_REQUIRED"
          ? "Project setup is required before starting a shared chat."
          : controller.busy
            ? "Another Project action is still finishing."
            : null;
  const rows = setupRows(project);

  return (
    <section className="v2-project-page" data-testid="project-overview-page">
      <ProjectsLocation current={project.name} onBackToChat={onBackToChat} />
      <div className="v2-project-page-scroll">
        <header className="v2-project-page-head">
          <span className="v2-project-page-mark" aria-hidden="true">
            {project.name.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <h1>{project.name}</h1>
            <p>
              {roleLabel(project.effectiveRole)} · {project.audienceCount} {project.audienceCount === 1 ? "member" : "members"} · {project.chatCount} {project.chatCount === 1 ? "chat" : "chats"} · updated {formatProjectDate(project.updatedAt)}
            </p>
          </div>
          <div className="v2-project-page-head-actions">
            <UiV2Button
              aria-describedby={startBlockedReason ? "v2-project-start-reason" : undefined}
              disabled={!canStart || controller.busy}
              icon="plus"
              title={startBlockedReason ?? undefined}
              tone="primary"
              onClick={onStartChat}
            >
              Start shared chat
            </UiV2Button>
            <UiV2IconButton
              icon="more"
              label={`${project.name} details`}
              onClick={() => controller.actions.openSettings("general")}
            />
            {startBlockedReason ? (
              <span className="v2-sr-only" id="v2-project-start-reason">{startBlockedReason}</span>
            ) : null}
          </div>
          {project.description ? <p className="v2-project-page-description">{project.description}</p> : null}
        </header>

        {project.status !== "ACTIVE" ? (
          <div className="v2-project-setup-warning" role="status">
            <UiV2Icon name="alert" />
            <span>
              <strong>{project.status === "DELETING" ? "Deletion in progress" : "Archived Project"}</strong>
              <small>
                {project.status === "DELETING"
                  ? "Permanent deletion is in progress. This Project cannot be changed or used for new chats."
                  : "This Project is read-only. An owner or manager must restore it before new shared chats can start."}
              </small>
            </span>
          </div>
        ) : project.readiness === "SETUP_REQUIRED" ? (
          <div className="v2-project-setup-warning" role="status">
            <UiV2Icon name="alert" />
            <span>
              <strong>Setup required</strong>
              <small>
                {project.setupReasons?.includes("shared_model_unavailable")
                  ? "Add a model with an active shared installation credential before the first answer."
                  : "Choose an available linked model before the first answer."}
              </small>
            </span>
            {project.capabilities.manageProject ? (
              <UiV2Button onClick={() => controller.actions.openSettings("resources")}>Finish setup</UiV2Button>
            ) : null}
          </div>
        ) : null}

        {mobileNavigationSlot}

        <div className="v2-project-overview-grid">
          <div className="v2-project-overview-primary">
            <section className="v2-project-overview-section">
              <header>
                <h2>Shared setup</h2>
                {project.status === "ACTIVE" && project.capabilities.manageProject ? (
                  <button type="button" onClick={() => controller.actions.openSettings("resources")}>
                    <UiV2Icon name="edit" /> Change
                  </button>
                ) : (
                  <span>
                    <UiV2Icon name="lock" />
                    {project.status === "ACTIVE" ? "Owners and managers" : "Read-only"}
                  </span>
                )}
              </header>
              <div className="v2-project-setup-list">
                {rows.map((row) => (
                  <div className="v2-project-setup-row" key={`${row.icon}:${row.label}`}>
                    <span className="v2-project-setup-icon"><UiV2Icon name={row.icon} /></span>
                    <span><strong>{row.label}</strong><small>{row.meta}</small></span>
                    {row.state ? <em data-state={row.state}>{row.state === "ready" ? "Ready" : "Unavailable"}</em> : null}
                  </div>
                ))}
              </div>
            </section>

            <section className="v2-project-overview-section">
              <header><h2>Recent activity</h2></header>
              {controller.activityError && !controller.activity ? (
                <div className="v2-project-overview-empty" role="alert">
                  <span>Activity is unavailable.</span>
                  {loadActivity ? (
                    <button type="button" onClick={() => void loadActivity()}>Try again</button>
                  ) : null}
                </div>
              ) : !controller.activity ? (
                <p className="v2-project-overview-empty">Loading activity…</p>
              ) : controller.activity.events.length === 0 ? (
                <p className="v2-project-overview-empty">No Project activity yet.</p>
              ) : (
                <div className="v2-project-recent-activity">
                  {controller.activity.events.slice(0, 4).map((event) => {
                    const detail = projectActivityDetail(event);
                    return (
                      <div key={event.id}>
                        <span className="v2-project-activity-mark" aria-hidden="true">
                          {event.actorDisplayName.slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          <strong>{event.actorDisplayName} · {projectActivityLabel(event.eventType)}</strong>
                          <small>
                            {detail ? <>{detail} </> : null}
                            <time dateTime={event.createdAt}>{formatProjectDate(event.createdAt)}</time>
                          </small>
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>

          <section className="v2-project-overview-section v2-project-access">
            <header>
              <h2>Access</h2>
              {project.status === "ACTIVE" && project.capabilities.manageMembers ? (
                <button type="button" onClick={() => controller.actions.openSettings("members")}>
                  <UiV2Icon name="share" /> Manage
                </button>
              ) : null}
            </header>
            <div className="v2-project-member-list">
              {project.grants.length === 0 ? (
                <p className="v2-project-overview-empty">No direct people or groups are listed.</p>
              ) : project.grants.map((grant) => {
                const inactiveLabel = grant.user && grant.user.status !== "active"
                  ? "Inactive account"
                  : grant.group?.archived
                    ? "Archived group"
                    : !grant.user && !grant.group
                      ? "Unavailable"
                      : null;
                return (
                  <div className="v2-project-member-row" key={grant.id}>
                    <span className="v2-project-activity-mark" aria-hidden="true">
                      {(grant.user?.displayName ?? grant.group?.name ?? "Access").slice(0, 1).toUpperCase()}
                    </span>
                    <strong>{grant.user?.displayName ?? grant.group?.name ?? "Unavailable principal"}</strong>
                    <span>
                      {roleLabel(grant.role)}{inactiveLabel ? ` · ${inactiveLabel}` : ""}
                    </span>
                  </div>
                );
              })}
            </div>
            <p className="v2-project-access-note">
              <UiV2Icon name="lock" />
              <span>
                {project.effectiveRole === "VIEWER"
                  ? "You can read this Project and its chats. Writing needs Contributor access; setup and access changes need Manager access."
                  : "Everything here is shared. Personal Memory is never used in Project chats, and Project chats stay out of personal history."}
                {project.grantedThrough.length > 0
                  ? " Group access may include additional members not listed above."
                  : ""}
              </span>
            </p>
          </section>
        </div>
        {canStart && composerSlot ? <div className="v2-project-page-composer">{composerSlot}</div> : null}
      </div>
    </section>
  );
}

export function ProjectsSurfaceV2({
  composerSlot,
  controller,
  mobileNavigationSlot,
  onBackToChat,
  onStartChat
}: Readonly<{
  composerSlot?: ReactNode;
  controller: ProjectWorkspaceController;
  mobileNavigationSlot?: ReactNode;
  onBackToChat(): void;
  onStartChat(): void;
}>) {
  return controller.selectedProjectId ? (
    <ProjectOverviewPageV2
      composerSlot={composerSlot}
      controller={controller}
      mobileNavigationSlot={mobileNavigationSlot}
      onBackToChat={onBackToChat}
      onStartChat={onStartChat}
    />
  ) : (
    <ProjectsLandingPageV2 controller={controller} onBackToChat={onBackToChat} />
  );
}
