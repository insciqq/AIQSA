import { shellFetch } from "@/components/app-shell/shellApi";
import type { WorkspaceChatSummary } from "@/components/app-shell/types";
import {
  decodeProjectGrantRemovalPreview,
  decodeProjectResourceChangePreview,
  decodeProjectResponse,
  decodeProjectsResponse,
  decodeProjectWorkspaceResponse,
  type ProjectActivityResponseWire,
  type ProjectChatSummaryWire,
  type ProjectCandidatesResponseWire,
  type ProjectCandidateTypeWire,
  type ProjectDetailWire,
  type ProjectFolderWire,
  type ProjectGrantRemovalPreviewWire,
  type ProjectMemoryResponseWire,
  type ProjectResourceChangePreviewWire,
  type ProjectSummaryWire,
  type ProjectWorkspaceResponseWire,
  type UpdateProjectRequestWire
} from "@/lib/contracts/projects";
import type { ProjectRole } from "@/lib/domain/projects";
import { UNAVAILABLE_CHAT_WORKSPACE_STATE } from "@/lib/contracts/workspace";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function bodyOrNull(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export class ProjectApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.name = "ProjectApiError";
    this.code = code;
    this.status = status;
  }
}

async function responseValue(response: Response): Promise<unknown> {
  const value = await bodyOrNull(response);
  if (!response.ok) {
    const code = isRecord(value) && typeof value.error === "string"
      ? value.error
      : `project_request_failed_${response.status}`;
    throw new ProjectApiError(response.status, code);
  }
  return value;
}

async function jsonRequest(path: string, init?: RequestInit): Promise<unknown> {
  return responseValue(await shellFetch(path, init));
}

function jsonMutation(method: "DELETE" | "PATCH" | "POST", body?: unknown): RequestInit {
  return {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    method
  };
}

export function projectChatSummaryFromApi(chat: ProjectChatSummaryWire): WorkspaceChatSummary {
  return {
    ...(chat.hasContinuationSource ? { hasContinuationSource: true } : {}),
    activeLeafMessageId: chat.activeLeafMessageId,
    createdAt: chat.createdAt,
    defaultKnowledgePlan: chat.defaultKnowledgePlan,
    defaultModelId: chat.defaultModelId ?? "",
    defaultProvider: chat.defaultProvider ?? "",
    folderId: chat.folderId,
    id: chat.id,
    memoryMode: "EXCLUDED",
    messageCount: chat.messageCount,
    pinned: chat.pinned,
    projectId: chat.projectId,
    title: chat.title,
    updatedAt: chat.updatedAt,
    workspace: chat.workspace ?? UNAVAILABLE_CHAT_WORKSPACE_STATE
  };
}

export async function loadProjects(): Promise<readonly ProjectSummaryWire[]> {
  const decoded = decodeProjectsResponse(await jsonRequest("/api/projects"));
  if (!decoded) throw new Error("projects_malformed");
  return decoded.projects;
}

export async function loadProject(projectId: string): Promise<ProjectDetailWire> {
  const decoded = decodeProjectResponse(await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`));
  if (!decoded || decoded.project.id !== projectId) throw new Error("project_malformed");
  return decoded.project;
}

export async function loadProjectWorkspace(projectId: string): Promise<ProjectWorkspaceResponseWire> {
  const decoded = decodeProjectWorkspaceResponse(await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/chats`
  ));
  if (!decoded || decoded.chats.some((chat) => chat.projectId !== projectId)) {
    throw new Error("project_workspace_malformed");
  }
  return decoded;
}

export async function createProject(input: { description?: string; name: string; preferredModelId?: string }): Promise<ProjectDetailWire> {
  const decoded = decodeProjectResponse(await jsonRequest("/api/projects", jsonMutation("POST", input)));
  if (!decoded) throw new Error("project_malformed");
  return decoded.project;
}

export async function loadProjectCandidates(
  projectId: string,
  type: ProjectCandidateTypeWire,
  query: string,
  cursor?: string
): Promise<ProjectCandidatesResponseWire> {
  const params = new URLSearchParams({ limit: "20", q: query, type });
  if (cursor) params.set("cursor", cursor);
  const value = await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/candidates?${params.toString()}`
  );
  if (!isRecord(value) || !Array.isArray(value.items) || !nullableString(value.nextCursor) ||
    value.items.some((item) => !isRecord(item) || typeof item.id !== "string" ||
      typeof item.label !== "string" || item.type !== type || !nullableString(item.description) ||
      !nullableString(item.disabledReason))) {
    throw new Error("project_candidates_malformed");
  }
  return value as ProjectCandidatesResponseWire;
}

export async function updateProject(
  projectId: string,
  patch: UpdateProjectRequestWire
): Promise<ProjectDetailWire> {
  const decoded = decodeProjectResponse(await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}`,
    jsonMutation("PATCH", patch)
  ));
  if (!decoded || decoded.project.id !== projectId) throw new Error("project_malformed");
  return decoded.project;
}

export async function deleteProject(projectId: string): Promise<void> {
  await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}`, jsonMutation("DELETE"));
}

export async function createProjectChat(
  projectId: string,
  input: { folderId?: string | null; title?: string }
): Promise<ProjectChatSummaryWire> {
  const value = await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/chats`,
    jsonMutation("POST", input)
  );
  if (!isRecord(value) || !isRecord(value.chat)) throw new Error("project_chat_malformed");
  const workspace = decodeProjectWorkspaceResponse({ chats: [value.chat], folders: [] });
  const chat = workspace?.chats[0];
  if (!chat || chat.projectId !== projectId) throw new Error("project_chat_malformed");
  return chat;
}

export async function setProjectChatArchived(
  projectId: string,
  chatId: string,
  archived: boolean
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/chats/${encodeURIComponent(chatId)}/${archived ? "archive" : "restore"}`,
    jsonMutation("POST")
  );
}

export async function moveProjectChat(chatId: string, folderId: string | null): Promise<void> {
  await jsonRequest(
    `/api/chats/${encodeURIComponent(chatId)}`,
    jsonMutation("PATCH", { folderId })
  );
}

function projectFolderFromValue(value: unknown): ProjectFolderWire {
  const decoded = decodeProjectWorkspaceResponse({ chats: [], folders: [value] });
  const folder = decoded?.folders[0];
  if (!folder) throw new Error("project_folder_malformed");
  return folder;
}

export async function createProjectFolder(
  projectId: string,
  input: { name: string; parentId?: string | null }
): Promise<ProjectFolderWire> {
  const value = await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/folders`,
    jsonMutation("POST", input)
  );
  if (!isRecord(value)) throw new Error("project_folder_malformed");
  return projectFolderFromValue(value.folder);
}

export async function updateProjectFolder(
  projectId: string,
  folderId: string,
  patch: { name?: string; parentId?: string | null }
): Promise<ProjectFolderWire> {
  const value = await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    jsonMutation("PATCH", patch)
  );
  if (!isRecord(value)) throw new Error("project_folder_malformed");
  return projectFolderFromValue(value.folder);
}

export async function deleteProjectFolder(projectId: string, folderId: string): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/folders/${encodeURIComponent(folderId)}`,
    jsonMutation("DELETE")
  );
}

export async function addProjectGrant(
  projectId: string,
  input: { expectedAccessRevision: number; groupId?: string; role: ProjectRole; userId?: string }
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/grants`,
    jsonMutation("POST", input)
  );
}

export async function updateProjectGrant(
  projectId: string,
  grantId: string,
  role: ProjectRole,
  expectedAccessRevision: number
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/grants/${encodeURIComponent(grantId)}`,
    jsonMutation("PATCH", { expectedAccessRevision, role })
  );
}

export async function removeProjectGrant(
  projectId: string,
  grantId: string,
  expectedAccessRevision: number
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/grants/${encodeURIComponent(grantId)}?expectedAccessRevision=${expectedAccessRevision}`,
    jsonMutation("DELETE")
  );
}

export async function previewProjectGrantRemoval(
  projectId: string,
  grantId: string,
  expectedAccessRevision: number
): Promise<ProjectGrantRemovalPreviewWire> {
  const decoded = decodeProjectGrantRemovalPreview(await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/grants/${encodeURIComponent(grantId)}?expectedAccessRevision=${expectedAccessRevision}`
  ));
  if (!decoded) throw new Error("project_grant_preview_malformed");
  return decoded;
}

export async function leaveProject(
  projectId: string,
  expectedAccessRevision: number
): Promise<{ accessRemaining: boolean }> {
  const value = await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/leave`,
    jsonMutation("POST", { expectedAccessRevision })
  );
  if (!isRecord(value) || typeof value.accessRemaining !== "boolean") {
    throw new Error("project_leave_malformed");
  }
  return { accessRemaining: value.accessRemaining };
}

export async function addProjectResource(
  projectId: string,
  input: { expectedPolicyRevision: number; resourceId: string; expectedAssistantVersion?: number; type: "assistant" | "knowledge" | "mcp" | "model" | "search" | "skill" }
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/resources`,
    jsonMutation("POST", input)
  );
}

export async function previewProjectResourceChange(
  projectId: string,
  input:
    | { action: "add"; expectedPolicyRevision: number; resourceId: string; type: "assistant" }
    | { action: "remove"; bindingId: string; expectedPolicyRevision: number }
): Promise<ProjectResourceChangePreviewWire> {
  const decoded = decodeProjectResourceChangePreview(await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/resources/preview`,
    jsonMutation("POST", input)
  ));
  if (!decoded) throw new Error("project_resource_preview_malformed");
  return decoded;
}

export async function removeProjectResource(
  projectId: string,
  bindingId: string,
  expectedPolicyRevision: number
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/resources/${encodeURIComponent(bindingId)}?expectedPolicyRevision=${expectedPolicyRevision}`,
    jsonMutation("DELETE")
  );
}

function decodeProjectMemory(value: unknown): ProjectMemoryResponseWire | null {
  if (!isRecord(value) || typeof value.enabled !== "boolean" ||
    !Number.isSafeInteger(value.revision) || !Array.isArray(value.facts) ||
    !Array.isArray(value.proposals)) return null;
  return value as ProjectMemoryResponseWire;
}

export async function loadProjectMemory(projectId: string): Promise<ProjectMemoryResponseWire> {
  const value = decodeProjectMemory(await jsonRequest(`/api/projects/${encodeURIComponent(projectId)}/memory`));
  if (!value) throw new Error("project_memory_malformed");
  return value;
}

export async function saveProjectMemoryText(
  projectId: string,
  input: { sourceMessageId?: string; text: string; validUntil?: string | null },
  direct: boolean
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/memory${direct ? "" : "/proposals"}`,
    jsonMutation("POST", input)
  );
}

export async function reviewProjectMemoryProposal(
  projectId: string,
  proposalId: string,
  approve: boolean
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/memory/proposals/${encodeURIComponent(proposalId)}/${approve ? "approve" : "reject"}`,
    jsonMutation("POST")
  );
}

export async function editProjectMemoryFact(
  projectId: string,
  factId: string,
  text: string,
  validUntil?: string | null
): Promise<void> {
  await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/memory/facts/${encodeURIComponent(factId)}`,
    jsonMutation("PATCH", { text, ...(validUntil !== undefined ? { validUntil } : {}) })
  );
}

export async function forgetProjectMemoryFact(projectId: string, factId: string): Promise<void> {
  const response = await shellFetch(
    `/api/projects/${encodeURIComponent(projectId)}/memory/facts/${encodeURIComponent(factId)}`,
    jsonMutation("DELETE")
  );
  if (!response.ok) await responseValue(response);
}

export async function loadProjectActivity(projectId: string, before?: string): Promise<ProjectActivityResponseWire> {
  const value = await jsonRequest(
    `/api/projects/${encodeURIComponent(projectId)}/activity${before ? `?before=${encodeURIComponent(before)}` : ""}`
  );
  if (!isRecord(value) || !Array.isArray(value.events) || !nullableString(value.nextCursor)) {
    throw new Error("project_activity_malformed");
  }
  return value as ProjectActivityResponseWire;
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}
