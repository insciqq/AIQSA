import {
  decodeKnowledgePlan,
  decodeKnowledgeSelection,
  EMPTY_KNOWLEDGE_SELECTION,
  type KnowledgePlan
} from "./knowledge";
import {
  decodeChatWorkspaceState,
  type ChatWorkspaceState
} from "./workspace";
import { decodeSearchPlan, type SearchPlan } from "./search";
import type { KnowledgePlan as StoredKnowledgePlan } from "./knowledge";
import {
  decodeAssistantContent,
  decodeAssistantSummary,
  type AssistantContent,
  type AssistantSummary
} from "./assistants";
import { decodeCatalogResponse, type Catalog } from "./catalog";
import type {
  ComposerConfigKnowledgeBase,
  ComposerConfigKnowledgeSource,
  ComposerConfigMcpServer
} from "./composerConfig";

export const PROJECT_ROLES = ["VIEWER", "CONTRIBUTOR", "MANAGER", "OWNER"] as const;
export type ProjectRole = (typeof PROJECT_ROLES)[number];

export function isProjectRole(value: unknown): value is ProjectRole {
  return typeof value === "string" && PROJECT_ROLES.includes(value as ProjectRole);
}

export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_DESCRIPTION_MAX_LENGTH = 2_000;
export const PROJECT_INSTRUCTIONS_MAX_LENGTH = 32_000;
export const PROJECT_ACTIVITY_PAGE_SIZE = 50;

export type ProjectStatusWire = "ACTIVE" | "ARCHIVED" | "DELETING";

export type ProjectDefaultsWire = Readonly<{
  assistantId: string | null;
  controlValues: Readonly<Record<string, boolean | string>>;
  knowledgePlan: KnowledgePlan;
  mcpMode: "auto" | "load_all" | "off";
  providerModelId: string | null;
  searchPlan: SearchPlan;
}>;

export type ProjectPolicyWire = Readonly<{
  externalToolsEnabled: boolean;
}>;

export type ProjectReadinessWire = Readonly<{
  readiness: "READY" | "SETUP_REQUIRED";
  setupReasons: readonly ("default_model_required" | "shared_model_unavailable")[];
}>;

export const PROJECT_DEFAULT_RESOURCE_KINDS = [
  "assistant",
  "knowledge",
  "mcp",
  "model",
  "search"
] as const;
export type ProjectDefaultResourceKindWire =
  (typeof PROJECT_DEFAULT_RESOURCE_KINDS)[number];

export const EMPTY_PROJECT_DEFAULTS: ProjectDefaultsWire = Object.freeze({
  assistantId: null,
  controlValues: Object.freeze({}),
  knowledgePlan: EMPTY_KNOWLEDGE_SELECTION,
  mcpMode: "off",
  providerModelId: null,
  searchPlan: Object.freeze({ mode: "all_selected", optionIds: [] })
});

export const DEFAULT_PROJECT_POLICY: ProjectPolicyWire = Object.freeze({
  externalToolsEnabled: true
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nullableId(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 128 ? trimmed : undefined;
}

function controlValues(value: unknown): Readonly<Record<string, boolean | string>> | null {
  if (!isRecord(value) || Object.keys(value).length > 32) return null;
  const allowed = new Set([
    "backgroundMode",
    "maxOutputTokens",
    "reasoningEffort",
    "reasoningMode",
    "streamMode",
    "temperature"
  ]);
  const entries = Object.entries(value);
  if (entries.some(([key, item]) =>
    !allowed.has(key) ||
    (typeof item !== "boolean" && (typeof item !== "string" || item.length > 256)))) {
    return null;
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, boolean | string>);
}

function decodeProjectDefaultsWith(
  value: unknown,
  strictKnowledge: boolean
): { defaults: ProjectDefaultsWire; ok: true } | { ok: false } {
  if (!isRecord(value)) return { ok: false };
  const allowed = new Set([
    "assistantId",
    "controlValues",
    "knowledgePlan",
    "mcpMode",
    "providerModelId",
    "searchPlan"
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return { ok: false };
  const assistantId = nullableId(value.assistantId ?? null);
  const providerModelId = nullableId(value.providerModelId ?? null);
  const controls = controlValues(value.controlValues ?? {});
  const knowledge = strictKnowledge
    ? decodeKnowledgeSelection(value.knowledgePlan ?? EMPTY_KNOWLEDGE_SELECTION)
    : decodeKnowledgePlan(value.knowledgePlan ?? EMPTY_KNOWLEDGE_SELECTION);
  const search = decodeSearchPlan(value.searchPlan ?? { mode: "all_selected", optionIds: [] });
  const mcpMode = value.mcpMode ?? "off";
  if (
    assistantId === undefined ||
    providerModelId === undefined ||
    !controls ||
    !knowledge.ok ||
    (strictKnowledge &&
      (knowledge.plan.mode === "all_my_knowledge" || knowledge.plan.mode === "inherited")) ||
    !search.ok ||
    (mcpMode !== "auto" && mcpMode !== "load_all" && mcpMode !== "off")
  ) return { ok: false };
  return {
    defaults: {
      assistantId,
      controlValues: controls,
      knowledgePlan: knowledge.plan,
      mcpMode,
      providerModelId,
      searchPlan: search.plan
    },
    ok: true
  };
}

/** Decoder for persisted/server response values, including legacy read compatibility. */
export function decodeProjectDefaults(
  value: unknown
): { defaults: ProjectDefaultsWire; ok: true } | { ok: false } {
  return decodeProjectDefaultsWith(value, false);
}

/** Strict decoder for new Project mutation payloads. */
export function decodeProjectDefaultsInput(
  value: unknown
): { defaults: ProjectDefaultsWire; ok: true } | { ok: false } {
  return decodeProjectDefaultsWith(value, true);
}

export function decodeProjectPolicy(
  value: unknown
): { ok: true; policy: ProjectPolicyWire } | { ok: false } {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "externalToolsEnabled")) {
    return { ok: false };
  }
  const externalToolsEnabled = value.externalToolsEnabled ?? true;
  return typeof externalToolsEnabled === "boolean"
    ? { ok: true, policy: { externalToolsEnabled } }
    : { ok: false };
}

export type ProjectGrantSourceWire = Readonly<{
  groupId: string;
  groupName: string;
  role: ProjectRole;
}>;

export type ProjectSummaryWire = Readonly<{
  accessRevision: number;
  audienceCount: number;
  chatCount: number;
  description: string;
  directRole: ProjectRole | null;
  effectiveRole: ProjectRole;
  grantedThrough: readonly ProjectGrantSourceWire[];
  id: string;
  name: string;
  status: ProjectStatusWire;
  updatedAt: string;
}>;

export type ProjectGrantWire = Readonly<{
  createdAt: string;
  group: Readonly<{ archived: boolean; id: string; name: string }> | null;
  id: string;
  role: ProjectRole;
  user: Readonly<{ displayName: string; email: string | null; id: string; status: string }> | null;
}>;

export type ProjectResourceWire = Readonly<{
  available: boolean;
  description?: string;
  id: string;
  label: string;
  modelId?: string;
  promptCharacterCount?: number;
  provider?: string;
  reason: string | null;
  resourceId: string;
  revisionId?: string;
  type: "assistant" | "knowledge" | "mcp" | "model" | "search" | "skill";
}>;

/**
 * Client-safe Project run controls. This projection is intentionally separate
 * from every personal catalog: a member can compose with resources published
 * to the Project without receiving a matching personal grant. Assistant prompt
 * text and provider/MCP credentials never enter this contract.
 */
export type ProjectComposerWire = Readonly<{
  assistants: readonly Readonly<{
    promptCharacterCount: number;
    content: AssistantContent;
    summary: AssistantSummary;
  }>[];
  catalog: Catalog;
  knowledgeBases: readonly ComposerConfigKnowledgeBase[];
  knowledgeDocumentTotal: number;
  knowledgeSources: readonly ComposerConfigKnowledgeSource[];
  mcpServers: readonly ComposerConfigMcpServer[];
}>;

export type ProjectDetailWire = ProjectSummaryWire & Readonly<{
  capabilities: Readonly<{
    archiveChats: boolean;
    manageMembers: boolean;
    manageMemory: boolean;
    manageOwners: boolean;
    manageProject: boolean;
    mutateChats: boolean;
  }>;
  createdAt: string;
  /** Present on v2 responses; optional keeps older cached/test projections readable. */
  composer?: ProjectComposerWire;
  defaults: ProjectDefaultsWire;
  /** Exact Project-owned attachment count for proportional lifecycle confirmation. */
  fileCount?: number;
  grants: readonly ProjectGrantWire[];
  instructions: string;
  instructionsRevision: number;
  memoryEnabled: boolean;
  memoryRevision: number;
  policy: ProjectPolicyWire;
  policyRevision: number;
  publicSharingEnabled: boolean;
  /** Present on v2 responses; optional keeps older in-memory clients
   * readable while the server always emits the explicit readiness state. */
  readiness?: ProjectReadinessWire["readiness"];
  resources: readonly ProjectResourceWire[];
  setupReasons?: ProjectReadinessWire["setupReasons"];
  /** Privacy-safe signal that a configured default was omitted because its
   * resource is no longer usable. Exact hidden identities stay server-only. */
  unavailableDefaults?: readonly ProjectDefaultResourceKindWire[];
}>;

export type ProjectsResponseWire = Readonly<{ projects: readonly ProjectSummaryWire[] }>;
export type ProjectResponseWire = Readonly<{ project: ProjectDetailWire }>;

export type CreateProjectRequestWire = Readonly<{
  description?: string;
  name: string;
  preferredModelId?: string;
}>;

export type UpdateProjectRequestWire = Readonly<{
  description?: string;
  defaults?: ProjectDefaultsWire;
  expectedAccessRevision?: number;
  expectedInstructionsRevision?: number;
  expectedMemoryRevision?: number;
  expectedPolicyRevision?: number;
  instructions?: string;
  memoryEnabled?: boolean;
  name?: string;
  policy?: ProjectPolicyWire;
  publicSharingEnabled?: boolean;
  status?: "ACTIVE" | "ARCHIVED";
}>;

export type ProjectGrantsResponseWire = Readonly<{
  grants: readonly ProjectGrantWire[];
}>;

export type CreateProjectGrantRequestWire = Readonly<{
  expectedAccessRevision: number;
  groupId?: string;
  role: ProjectRole;
  userId?: string;
}>;

export type UpdateProjectGrantRequestWire = Readonly<{
  expectedAccessRevision: number;
  role: ProjectRole;
}>;

export type ProjectResourcesResponseWire = Readonly<{
  resources: readonly ProjectResourceWire[];
}>;

export const PROJECT_CANDIDATE_TYPES = [
  "user", "group", "model", "search", "knowledge", "assistant", "skill", "mcp"
] as const;
export type ProjectCandidateTypeWire = (typeof PROJECT_CANDIDATE_TYPES)[number];

export type ProjectCandidateWire = Readonly<{
  description: string | null;
  disabledReason: string | null;
  id: string;
  label: string;
  type: ProjectCandidateTypeWire;
}>;

export type ProjectCandidatesResponseWire = Readonly<{
  items: readonly ProjectCandidateWire[];
  nextCursor: string | null;
}>;

export type ProjectResourceTypeWire = ProjectResourceWire["type"];

export type CreateProjectResourceRequestWire = Readonly<{
  expectedPolicyRevision: number;
  resourceId: string;
  expectedAssistantVersion?: number;
  type: ProjectResourceTypeWire;
}>;

export type ProjectResourceDependencyPreviewWire = Readonly<{
  label: string;
  reason: string | null;
  state: "active" | "ineligible" | "will_add";
  type: Exclude<ProjectResourceTypeWire, "assistant">;
}>;

export type ProjectResourceChangePreviewWire = Readonly<{
  action: "add" | "remove";
  canCommit: boolean;
  consequences: Readonly<{
    affectedChatCount: number;
    clearedDefaults: readonly string[];
    dependentAssistants: readonly string[];
  }>;
  dependencies: readonly ProjectResourceDependencyPreviewWire[];
  policyRevision: number;
  resource: Readonly<{
    label: string;
    type: ProjectResourceTypeWire;
  }>;
  assistantVersion: number | null;
}>;

export type ProjectGrantRemovalPreviewWire = Readonly<{
  accessRevision: number;
  canCommit: boolean;
  grant: Readonly<{
    label: string;
    role: ProjectRole;
    type: "group" | "user";
  }>;
  losesAccessCount: number;
  reason: string | null;
  roleChangeCount: number;
}>;

export type ProjectLeaveResponseWire = Readonly<{
  accessRemaining: boolean;
}>;

export type ProjectAuditEventWire = Readonly<{
  actorDisplayName: string;
  createdAt: string;
  eventType: string;
  id: string;
  metadata: Readonly<Record<string, boolean | number | string | null>>;
}>;

export type ProjectActivityResponseWire = Readonly<{
  events: readonly ProjectAuditEventWire[];
  nextCursor: string | null;
}>;

export type ProjectFolderWire = Readonly<{
  id: string;
  name: string;
  parentId: string | null;
  sortOrder: number;
}>;

export type ProjectChatSummaryWire = Readonly<{
  activeRun: boolean;
  activeLeafMessageId: string | null;
  archived: boolean;
  createdAt: string;
  createdByDisplayName: string;
  createdByUserId: string | null;
  defaultKnowledgePlan: StoredKnowledgePlan | null;
  defaultModelId: string | null;
  defaultProvider: string | null;
  folderId: string | null;
  id: string;
  messageCount: number;
  pinned: boolean;
  projectId: string;
  title: string;
  updatedAt: string;
  /** Present on current server responses; optional only for stale local caches. */
  workspace?: ChatWorkspaceState;
}>;

export type ProjectWorkspaceResponseWire = Readonly<{
  chats: readonly ProjectChatSummaryWire[];
  folders: readonly ProjectFolderWire[];
}>;

export type ProjectMemoryFactWire = Readonly<{
  createdAt: string;
  createdByDisplayName: string;
  factId: string;
  state: "ACTIVE" | "FORGOTTEN";
  text: string;
  updatedAt: string;
  validUntil: string | null;
  versionId: string;
  versionNumber: number;
}>;

export type ProjectMemoryProposalWire = Readonly<{
  createdAt: string;
  id: string;
  proposedByDisplayName: string;
  proposedText: string;
  resultingFactId: string | null;
  reviewedAt: string | null;
  source: Readonly<{
    authorDisplayName: string | null;
    createdAt: string;
    messageId: string;
    role: "assistant" | "user";
    text: string;
  }> | null;
  state: "PENDING" | "APPROVED" | "REJECTED";
  sourceMessageId: string | null;
}>;

export type ProjectMemoryResponseWire = Readonly<{
  enabled: boolean;
  facts: readonly ProjectMemoryFactWire[];
  proposals: readonly ProjectMemoryProposalWire[];
  revision: number;
}>;

function projectStatus(value: unknown): value is ProjectStatusWire {
  return value === "ACTIVE" || value === "ARCHIVED" || value === "DELETING";
}

function finiteRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function decodeGrantSource(value: unknown): ProjectGrantSourceWire | null {
  if (!isRecord(value) || typeof value.groupId !== "string" ||
    typeof value.groupName !== "string" || !isProjectRole(value.role)) return null;
  return { groupId: value.groupId, groupName: value.groupName, role: value.role };
}

export function decodeProjectSummary(value: unknown): ProjectSummaryWire | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
    typeof value.description !== "string" || !projectStatus(value.status) ||
    !isProjectRole(value.effectiveRole) ||
    !(value.directRole === null || isProjectRole(value.directRole)) ||
    !Array.isArray(value.grantedThrough) ||
    !finiteRevision(value.accessRevision) ||
    !finiteRevision(value.audienceCount) || !finiteRevision(value.chatCount) ||
    typeof value.updatedAt !== "string") return null;
  const grantedThrough = value.grantedThrough.map(decodeGrantSource);
  if (grantedThrough.some((entry) => entry === null)) return null;
  return {
    accessRevision: value.accessRevision,
    audienceCount: value.audienceCount,
    chatCount: value.chatCount,
    description: value.description,
    directRole: value.directRole,
    effectiveRole: value.effectiveRole,
    grantedThrough: grantedThrough as ProjectGrantSourceWire[],
    id: value.id,
    name: value.name,
    status: value.status,
    updatedAt: value.updatedAt
  };
}

export function decodeProjectsResponse(value: unknown): ProjectsResponseWire | null {
  if (!isRecord(value) || !Array.isArray(value.projects)) return null;
  const projects = value.projects.map(decodeProjectSummary);
  return projects.some((project) => project === null)
    ? null
    : { projects: projects as ProjectSummaryWire[] };
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function decodeProjectGrant(value: unknown): ProjectGrantWire | null {
  if (!isRecord(value) || typeof value.id !== "string" || !isProjectRole(value.role) ||
    typeof value.createdAt !== "string") return null;
  const user = value.user;
  const group = value.group;
  if (user !== null && (!isRecord(user) || typeof user.id !== "string" ||
    typeof user.displayName !== "string" || !nullableString(user.email) ||
    typeof user.status !== "string")) return null;
  if (group !== null && (!isRecord(group) || typeof group.id !== "string" ||
    typeof group.name !== "string" || typeof group.archived !== "boolean")) return null;
  if ((user === null) === (group === null)) return null;
  return {
    createdAt: value.createdAt,
    group: group as ProjectGrantWire["group"],
    id: value.id,
    role: value.role,
    user: user as ProjectGrantWire["user"]
  };
}

function decodeProjectResource(value: unknown): ProjectResourceWire | null {
  if (!isRecord(value) || typeof value.available !== "boolean" ||
    typeof value.id !== "string" || typeof value.label !== "string" ||
    !(value.modelId === undefined || typeof value.modelId === "string") ||
    !(value.provider === undefined || typeof value.provider === "string") ||
    !nullableString(value.reason) || typeof value.resourceId !== "string" ||
    !["assistant", "knowledge", "mcp", "model", "search", "skill"].includes(String(value.type)) ||
    !(value.revisionId === undefined || typeof value.revisionId === "string")) return null;
  return value as ProjectResourceWire;
}

function decodeProjectComposer(value: unknown): ProjectComposerWire | null {
  if (!isRecord(value) || !Array.isArray(value.assistants) ||
    !Array.isArray(value.knowledgeBases) ||
    !finiteRevision(value.knowledgeDocumentTotal) ||
    !(value.knowledgeSources === undefined || Array.isArray(value.knowledgeSources)) ||
    !Array.isArray(value.mcpServers)) return null;
  const catalog = decodeCatalogResponse({ catalog: value.catalog });
  if (!catalog) return null;
  const assistants = value.assistants.map((entry) => {
    if (!isRecord(entry) || !Number.isSafeInteger(entry.promptCharacterCount) ||
      (entry.promptCharacterCount as number) < 0) return null;
    const content = decodeAssistantContent(entry.content);
    const summary = decodeAssistantSummary(entry.summary);
    return content && summary && content.providerModelId && content.name === summary.name
      ? { promptCharacterCount: entry.promptCharacterCount as number, content, summary }
      : null;
  });
  const knowledgeBases = value.knowledgeBases.filter((base): base is ComposerConfigKnowledgeBase =>
    isRecord(base) && typeof base.archived === "boolean" &&
    (base.attentionDocumentCount === undefined || finiteRevision(base.attentionDocumentCount)) &&
    typeof base.description === "string" && typeof base.id === "string" &&
    finiteRevision(base.documentCount) && typeof base.name === "string" &&
    typeof base.owned === "boolean" &&
    (base.processingDocumentCount === undefined || finiteRevision(base.processingDocumentCount)) &&
    ["archived", "empty", "needs_attention", "processing", "ready", "trashed"]
      .includes(String(base.readinessState)) &&
    (base.readyDocumentCount === undefined || finiteRevision(base.readyDocumentCount))
  );
  const knowledgeSourceValues = value.knowledgeSources ?? [];
  const knowledgeSources = knowledgeSourceValues.filter((source): source is ComposerConfigKnowledgeSource =>
    isRecord(source) && typeof source.description === "string" &&
    typeof source.id === "string" && typeof source.name === "string" &&
    typeof source.owned === "boolean" &&
    ["needs_attention", "processing", "ready"].includes(String(source.readiness))
  );
  const readiness = new Set([
    "authorizing", "disabled", "idle", "needs_authorization", "needs_setup", "queued",
    "ready", "reauthorization_required", "restarting", "starting", "unavailable"
  ]);
  const mcpServers = value.mcpServers.filter((server): server is ComposerConfigMcpServer =>
    isRecord(server) && typeof server.description === "string" &&
    typeof server.enabled === "boolean" && typeof server.id === "string" &&
    Number.isSafeInteger(server.knownToolCount) && (server.knownToolCount as number) >= 0 &&
    typeof server.name === "string" && typeof server.readiness === "string" &&
    readiness.has(server.readiness)
  );
  return assistants.some((entry) => entry === null) ||
    knowledgeBases.length !== value.knowledgeBases.length ||
    knowledgeSources.length !== knowledgeSourceValues.length ||
    mcpServers.length !== value.mcpServers.length
    ? null
    : {
        assistants: assistants as ProjectComposerWire["assistants"],
        catalog,
        knowledgeBases,
        knowledgeDocumentTotal: value.knowledgeDocumentTotal,
        knowledgeSources,
        mcpServers
      };
}

export function decodeProjectResponse(value: unknown): ProjectResponseWire | null {
  if (!isRecord(value) || !isRecord(value.project)) return null;
  const project = value.project;
  const summary = decodeProjectSummary(project);
  const defaults = decodeProjectDefaults(project.defaults);
  const policy = decodeProjectPolicy(project.policy);
  const composer = project.composer === undefined ? undefined : decodeProjectComposer(project.composer);
  const capabilities = isRecord(project.capabilities) ? project.capabilities : null;
  if (!summary || !defaults.ok || !policy.ok || composer === null || !capabilities ||
    !Array.isArray(project.grants) || !Array.isArray(project.resources) ||
    typeof project.createdAt !== "string" || typeof project.instructions !== "string" ||
    !finiteRevision(project.instructionsRevision) || typeof project.memoryEnabled !== "boolean" ||
    !finiteRevision(project.memoryRevision) || !finiteRevision(project.policyRevision) ||
    (project.fileCount !== undefined && !finiteRevision(project.fileCount)) ||
    typeof project.publicSharingEnabled !== "boolean" ||
    (project.readiness !== undefined && project.readiness !== "READY" && project.readiness !== "SETUP_REQUIRED") ||
    (project.setupReasons !== undefined && (!Array.isArray(project.setupReasons) ||
      project.setupReasons.some((reason) => reason !== "default_model_required" && reason !== "shared_model_unavailable"))) ||
    (project.unavailableDefaults !== undefined && (!Array.isArray(project.unavailableDefaults) ||
      project.unavailableDefaults.length > PROJECT_DEFAULT_RESOURCE_KINDS.length ||
      new Set(project.unavailableDefaults).size !== project.unavailableDefaults.length ||
      project.unavailableDefaults.some((kind) =>
        !PROJECT_DEFAULT_RESOURCE_KINDS.includes(kind as ProjectDefaultResourceKindWire))))) return null;
  const capabilityKeys = [
    "archiveChats", "manageMembers", "manageMemory", "manageOwners", "manageProject", "mutateChats"
  ] as const;
  if (capabilityKeys.some((key) => typeof capabilities[key] !== "boolean")) return null;
  const grants = project.grants.map(decodeProjectGrant);
  const resources = project.resources.map(decodeProjectResource);
  if (grants.some((grant) => grant === null) || resources.some((resource) => resource === null)) {
    return null;
  }
  return {
    project: {
      ...summary,
      capabilities: Object.fromEntries(capabilityKeys.map((key) => [key, capabilities[key]])) as ProjectDetailWire["capabilities"],
      ...(composer ? { composer } : {}),
      createdAt: project.createdAt,
      defaults: defaults.defaults,
      ...(project.fileCount !== undefined ? { fileCount: project.fileCount } : {}),
      grants: grants as ProjectGrantWire[],
      instructions: project.instructions,
      instructionsRevision: project.instructionsRevision,
      memoryEnabled: project.memoryEnabled,
      memoryRevision: project.memoryRevision,
      policy: policy.policy,
      policyRevision: project.policyRevision,
      publicSharingEnabled: project.publicSharingEnabled,
      readiness: project.readiness ?? "READY",
      resources: resources as ProjectResourceWire[],
      setupReasons: (project.setupReasons ?? []) as ProjectDetailWire["setupReasons"],
      unavailableDefaults: (project.unavailableDefaults ?? []) as ProjectDetailWire["unavailableDefaults"]
    }
  };
}

export function decodeProjectResourceChangePreview(
  value: unknown
): ProjectResourceChangePreviewWire | null {
  if (!isRecord(value) || !isRecord(value.preview)) return null;
  const preview = value.preview;
  if ((preview.action !== "add" && preview.action !== "remove") ||
    typeof preview.canCommit !== "boolean" || !isRecord(preview.consequences) ||
    !Array.isArray(preview.dependencies) || !finiteRevision(preview.policyRevision) ||
    !isRecord(preview.resource) || typeof preview.resource.label !== "string" ||
    !["assistant", "knowledge", "mcp", "model", "search", "skill"].includes(
      String(preview.resource.type)
    ) || !(preview.assistantVersion === null || finiteRevision(preview.assistantVersion))) return null;
  const consequences = preview.consequences;
  if (!finiteRevision(consequences.affectedChatCount) ||
    !Array.isArray(consequences.clearedDefaults) ||
    consequences.clearedDefaults.some((entry) => typeof entry !== "string") ||
    !Array.isArray(consequences.dependentAssistants) ||
    consequences.dependentAssistants.some((entry) => typeof entry !== "string")) return null;
  const dependencies = preview.dependencies.map((entry) => {
    if (!isRecord(entry) || typeof entry.label !== "string" || !nullableString(entry.reason) ||
      !["active", "ineligible", "will_add"].includes(String(entry.state)) ||
      !["knowledge", "mcp", "model", "search", "skill"].includes(String(entry.type))) return null;
    return entry as ProjectResourceDependencyPreviewWire;
  });
  if (dependencies.some((entry) => entry === null)) return null;
  return {
    action: preview.action,
    canCommit: preview.canCommit,
    consequences: {
      affectedChatCount: consequences.affectedChatCount,
      clearedDefaults: consequences.clearedDefaults as string[],
      dependentAssistants: consequences.dependentAssistants as string[]
    },
    dependencies: dependencies as ProjectResourceDependencyPreviewWire[],
    policyRevision: preview.policyRevision,
    resource: preview.resource as ProjectResourceChangePreviewWire["resource"],
    assistantVersion: preview.assistantVersion
  };
}

export function decodeProjectGrantRemovalPreview(
  value: unknown
): ProjectGrantRemovalPreviewWire | null {
  if (!isRecord(value) || !isRecord(value.preview)) return null;
  const preview = value.preview;
  if (!finiteRevision(preview.accessRevision) || typeof preview.canCommit !== "boolean" ||
    !isRecord(preview.grant) || typeof preview.grant.label !== "string" ||
    !isProjectRole(preview.grant.role) ||
    (preview.grant.type !== "group" && preview.grant.type !== "user") ||
    !finiteRevision(preview.losesAccessCount) || !nullableString(preview.reason) ||
    !finiteRevision(preview.roleChangeCount)) return null;
  return preview as ProjectGrantRemovalPreviewWire;
}

function decodeProjectFolder(value: unknown): ProjectFolderWire | null {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" &&
    nullableString(value.parentId) && finiteRevision(value.sortOrder)
    ? { id: value.id, name: value.name, parentId: value.parentId, sortOrder: value.sortOrder }
    : null;
}

export function decodeProjectChat(value: unknown): ProjectChatSummaryWire | null {
  if (!isRecord(value) || typeof value.activeRun !== "boolean" ||
    !nullableString(value.activeLeafMessageId) || typeof value.archived !== "boolean" ||
    typeof value.createdAt !== "string" || typeof value.createdByDisplayName !== "string" ||
    !nullableString(value.createdByUserId) || !nullableString(value.defaultModelId) ||
    !nullableString(value.defaultProvider) || !nullableString(value.folderId) ||
    typeof value.id !== "string" || !finiteRevision(value.messageCount) ||
    typeof value.pinned !== "boolean" || typeof value.projectId !== "string" ||
    typeof value.title !== "string" || typeof value.updatedAt !== "string") return null;
  const workspace = value.workspace === undefined
    ? undefined
    : decodeChatWorkspaceState(value.workspace);
  if (workspace === null) return null;
  const knowledge = value.defaultKnowledgePlan === null
    ? { ok: true as const, plan: null }
    : decodeKnowledgePlan(value.defaultKnowledgePlan);
  if (!knowledge.ok) return null;
  return {
    activeRun: value.activeRun,
    activeLeafMessageId: value.activeLeafMessageId,
    archived: value.archived,
    createdAt: value.createdAt,
    createdByDisplayName: value.createdByDisplayName,
    createdByUserId: value.createdByUserId,
    defaultKnowledgePlan: knowledge.plan,
    defaultModelId: value.defaultModelId,
    defaultProvider: value.defaultProvider,
    folderId: value.folderId,
    id: value.id,
    messageCount: value.messageCount,
    pinned: value.pinned,
    projectId: value.projectId,
    title: value.title,
    updatedAt: value.updatedAt,
    ...(workspace ? { workspace } : {})
  };
}

export function decodeProjectWorkspaceResponse(value: unknown): ProjectWorkspaceResponseWire | null {
  if (!isRecord(value) || !Array.isArray(value.chats) || !Array.isArray(value.folders)) return null;
  const chats = value.chats.map(decodeProjectChat);
  const folders = value.folders.map(decodeProjectFolder);
  return chats.some((chat) => chat === null) || folders.some((folder) => folder === null)
    ? null
    : {
        chats: chats as ProjectChatSummaryWire[],
        folders: folders as ProjectFolderWire[]
      };
}
