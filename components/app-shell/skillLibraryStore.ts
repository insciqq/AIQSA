import { shellFetch } from "@/components/app-shell/shellApi";
import type {
  SkillAudience,
  SkillDetail,
  SkillDraft,
  SkillListResponse,
  SkillSummary
} from "@/lib/contracts/skills";
import { create } from "zustand";

type SkillLibraryLoadState = "error" | "idle" | "loading" | "ready";

type SkillLibraryStore = {
  data: SkillListResponse | null;
  error: string | null;
  loadingMore: boolean;
  loadState: SkillLibraryLoadState;
  moreError: string | null;
  query: string;
};

export const useSkillLibraryStore = create<SkillLibraryStore>(() => ({
  data: null,
  error: null,
  loadingMore: false,
  loadState: "idle",
  moreError: null,
  query: ""
}));

let refreshGeneration = 0;
let loadPromise: Readonly<{
  promise: Promise<SkillListResponse>;
  query: string;
}> | null = null;
let loadMorePromise: Promise<SkillListResponse> | null = null;

export function resetSkillLibraryStoreForTest(): void {
  refreshGeneration = 0;
  loadPromise = null;
  loadMorePromise = null;
  useSkillLibraryStore.setState({
    data: null,
    error: null,
    loadingMore: false,
    loadState: "idle",
    moreError: null,
    query: ""
  }, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSkill(value: unknown): SkillSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
    typeof value.description !== "string" || typeof value.instructionCharacterCount !== "number" ||
    !Number.isSafeInteger(value.instructionCharacterCount) || value.instructionCharacterCount < 0 ||
    typeof value.owned !== "boolean" || typeof value.archived !== "boolean" ||
    typeof value.ownerDisplayName !== "string" || !Number.isSafeInteger(value.version) ||
    typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
    !isRecord(value.scope) ||
    !["owner", "workspace", "installation"].includes(String(value.scope.kind))) {
    return null;
  }
  const scope = value.scope.kind === "workspace"
    ? Array.isArray(value.scope.workspaceNames) &&
      value.scope.workspaceNames.every((name) => typeof name === "string")
      ? {
          kind: "workspace" as const,
          workspaceNames: [...value.scope.workspaceNames] as string[]
        }
      : null
    : value.scope.kind === "owner"
      ? { kind: "owner" as const }
      : { kind: "installation" as const };
  if (!scope) return null;
  return {
    archived: value.archived,
    description: value.description,
    id: value.id,
    instructionCharacterCount: value.instructionCharacterCount,
    name: value.name,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    scope,
    updatedAt: value.updatedAt,
    version: Number(value.version)
  };
}

function parseAudience(value: unknown): SkillAudience | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") {
    return null;
  }
  if (value.kind === "everyone" && value.name === "Everyone") {
    return { id: value.id, kind: "everyone", name: "Everyone" };
  }
  if (value.kind === "project" && value.name === "Project publication") {
    return { id: value.id, kind: "project", name: "Project publication" };
  }
  return value.kind === "workspace" && typeof value.workspaceId === "string"
    ? {
        id: value.id,
        kind: "workspace",
        name: value.name,
        workspaceId: value.workspaceId
      }
    : null;
}

function parseDetail(value: unknown): SkillDetail | null {
  if (!isRecord(value)) return null;
  const skill = parseSkill(value);
  if (!skill || typeof value.instructions !== "string" || !isRecord(value.owner) ||
    typeof value.owner.displayName !== "string" || !Array.isArray(value.audiences) ||
    typeof value.canDelete !== "boolean" || typeof value.canEdit !== "boolean" ||
    typeof value.canPublish !== "boolean" || typeof value.canUnshare !== "boolean" ||
    !Number.isSafeInteger(value.assistantUsageCount) || Number(value.assistantUsageCount) < 0 ||
    !Number.isSafeInteger(value.workspaceUsageCount) || Number(value.workspaceUsageCount) < 0) {
    return null;
  }
  const audiences = value.audiences.map(parseAudience);
  if (audiences.some((audience) => !audience)) return null;
  return {
    ...skill,
    assistantUsageCount: Number(value.assistantUsageCount),
    audiences: audiences as SkillAudience[],
    canDelete: value.canDelete,
    canEdit: value.canEdit,
    canPublish: value.canPublish,
    canUnshare: value.canUnshare,
    instructions: value.instructions,
    owner: { displayName: value.owner.displayName },
    workspaceUsageCount: Number(value.workspaceUsageCount)
  };
}

function parseList(value: unknown): SkillListResponse | null {
  if (!isRecord(value) || !Array.isArray(value.skills) ||
    !Array.isArray(value.publishableWorkspaces) || !isRecord(value.viewer) ||
    typeof value.viewer.canPublishInstallation !== "boolean" ||
    (value.nextCursor !== null && typeof value.nextCursor !== "string")) return null;
  const skills = value.skills.map(parseSkill);
  if (skills.some((skill) => !skill)) return null;
  const publishableWorkspaces = value.publishableWorkspaces.flatMap((workspace) =>
    isRecord(workspace) && typeof workspace.id === "string" && typeof workspace.name === "string"
      ? [{ id: workspace.id, name: workspace.name }]
      : []
  );
  if (publishableWorkspaces.length !== value.publishableWorkspaces.length) return null;
  return {
    nextCursor: value.nextCursor,
    publishableWorkspaces,
    skills: skills as SkillSummary[],
    viewer: { canPublishInstallation: value.viewer.canPublishInstallation }
  };
}

async function responseJson(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

async function request(input: string, init?: RequestInit): Promise<unknown> {
  const response = await shellFetch(input, init);
  const value = await responseJson(response);
  if (!response.ok) {
    throw new Error(isRecord(value) && typeof value.error === "string"
      ? value.error
      : "skill_request_failed");
  }
  return value;
}

export async function fetchSkillPage(input: Readonly<{
  cursor?: string;
  limit?: number;
  query?: string;
}> = {}): Promise<SkillListResponse> {
  const parameters = new URLSearchParams();
  if (input.cursor) parameters.set("cursor", input.cursor);
  if (input.limit !== undefined) parameters.set("limit", String(input.limit));
  if (input.query?.trim()) parameters.set("q", input.query.trim());
  const value = await request(`/api/me/skills${parameters.size ? `?${parameters}` : ""}`);
  const data = parseList(value);
  if (!data) throw new Error("skill_response_invalid");
  return data;
}

export async function refreshSkillLibrary(
  force = false,
  query = ""
): Promise<SkillListResponse> {
  const normalizedQuery = query.trim();
  const current = useSkillLibraryStore.getState();
  if (
    !force &&
    current.loadState === "ready" &&
    current.data &&
    current.query === normalizedQuery
  ) {
    return current.data;
  }
  if (loadPromise?.query === normalizedQuery) return loadPromise.promise;
  const generation = ++refreshGeneration;
  loadMorePromise = null;
  useSkillLibraryStore.setState({
    error: null,
    loadingMore: false,
    loadState: "loading",
    moreError: null,
    query: normalizedQuery
  });
  const promise = fetchSkillPage({ query: normalizedQuery }).then((data) => {
    if (generation === refreshGeneration) {
      useSkillLibraryStore.setState({ data, error: null, loadState: "ready" });
    }
    return data;
  }).catch((error: unknown) => {
    if (generation === refreshGeneration) {
      useSkillLibraryStore.setState({
        error: error instanceof Error ? error.message : "skill_request_failed",
        loadState: "error"
      });
    }
    throw error;
  }).finally(() => {
    if (loadPromise?.promise === promise) loadPromise = null;
  });
  loadPromise = { promise, query: normalizedQuery };
  return promise;
}

export async function loadMoreSkillLibrary(): Promise<SkillListResponse> {
  const current = useSkillLibraryStore.getState();
  const cursor = current.data?.nextCursor;
  if (!current.data || !cursor) return current.data ?? refreshSkillLibrary();
  if (loadMorePromise) return loadMorePromise;
  const generation = refreshGeneration;
  const query = current.query;
  useSkillLibraryStore.setState({ loadingMore: true, moreError: null });
  const promise = fetchSkillPage({ cursor, query }).then((page) => {
    if (generation === refreshGeneration && useSkillLibraryStore.getState().query === query) {
      const latest = useSkillLibraryStore.getState().data;
      const seen = new Set(latest?.skills.map((skill) => skill.id) ?? []);
      useSkillLibraryStore.setState({
        data: {
          nextCursor: page.nextCursor,
          publishableWorkspaces: page.publishableWorkspaces,
          skills: [
            ...(latest?.skills ?? []),
            ...page.skills.filter((skill) => !seen.has(skill.id))
          ],
          viewer: page.viewer
        },
        loadingMore: false,
        moreError: null
      });
    }
    return page;
  }).catch((error: unknown) => {
    if (generation === refreshGeneration) {
      useSkillLibraryStore.setState({
        loadingMore: false,
        moreError: error instanceof Error ? error.message : "skill_request_failed"
      });
    }
    throw error;
  }).finally(() => {
    if (loadMorePromise === promise) loadMorePromise = null;
  });
  loadMorePromise = promise;
  return promise;
}

async function refreshCurrentSkillLibrary(): Promise<SkillListResponse> {
  return refreshSkillLibrary(true, useSkillLibraryStore.getState().query);
}

export async function loadSkillDetail(skillId: string): Promise<SkillDetail> {
  const value = await request(`/api/me/skills/${encodeURIComponent(skillId)}`);
  const detailValue = isRecord(value) ? parseDetail(value.skill) : null;
  if (!detailValue) throw new Error("skill_response_invalid");
  return detailValue;
}

export async function createSkill(draft: SkillDraft): Promise<void> {
  await request("/api/me/skills", {
    body: JSON.stringify(draft),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  await refreshCurrentSkillLibrary();
}

export async function reviseSkill(skill: SkillSummary, draft: SkillDraft): Promise<void> {
  await request(`/api/me/skills/${encodeURIComponent(skill.id)}`, {
    body: JSON.stringify({ expectedVersion: skill.version, revision: draft }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
  await refreshCurrentSkillLibrary();
}

export async function setSkillArchived(skill: SkillSummary, archived: boolean): Promise<void> {
  await request(`/api/me/skills/${encodeURIComponent(skill.id)}`, {
    body: JSON.stringify({ archived, expectedVersion: skill.version }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
  await refreshCurrentSkillLibrary();
}

export async function publishSkill(
  skillId: string,
  publication:
    | { scope: "installation" }
    | { scope: "workspace"; workspaceId: string }
): Promise<void> {
  await request(`/api/me/skills/${encodeURIComponent(skillId)}/publications`, {
    body: JSON.stringify(publication),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  await refreshCurrentSkillLibrary();
}

export async function unshareSkill(skillId: string, publicationId: string): Promise<void> {
  await request(
    `/api/me/skills/${encodeURIComponent(skillId)}/publications/${encodeURIComponent(publicationId)}`,
    { method: "DELETE" }
  );
  await refreshCurrentSkillLibrary();
}

export async function deleteSkill(skillId: string): Promise<void> {
  await request(`/api/me/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
  await refreshCurrentSkillLibrary();
}
