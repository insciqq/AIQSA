import { shellFetch } from "@/components/app-shell/shellApi";
import type {
  SkillAudience,
  SkillDetail,
  SkillDraft,
  SkillListResponse,
  SkillImportResponse,
  SkillFileSummary,
  SkillRevisionSummary,
  SkillSharingStatus,
  SkillSummary,
  SkillValidationError
} from "@/lib/contracts/skills";
import { SKILL_SHARE_REQUEST_STATES } from "@/lib/contracts/skills";
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
  if ([value.instructionApproxTokens, value.fileCount].some((item) => item !== undefined && (!Number.isSafeInteger(item) || Number(item) < 0)) ||
    (value.hasExecutables !== undefined && typeof value.hasExecutables !== "boolean") ||
    (value.enabled !== undefined && typeof value.enabled !== "boolean")) return null;
  return {
    archived: value.archived,
    ...(value.enabled === undefined ? {} : { enabled: value.enabled as boolean }),
    description: value.description,
    id: value.id,
    instructionCharacterCount: value.instructionCharacterCount,
    ...(value.instructionApproxTokens === undefined ? {} : { instructionApproxTokens: Number(value.instructionApproxTokens) }),
    ...(value.fileCount === undefined ? {} : { fileCount: Number(value.fileCount) }),
    ...(value.hasExecutables === undefined ? {} : { hasExecutables: value.hasExecutables as boolean }),
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

function parseRevision(value: unknown): SkillRevisionSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
    !Number.isSafeInteger(value.revisionNumber) || Number(value.revisionNumber) < 1 ||
    typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return null;
  return { id: value.id, name: value.name, revisionNumber: Number(value.revisionNumber), createdAt: value.createdAt };
}

function parseSharing(value: unknown): SkillSharingStatus | null {
  if (!isRecord(value) || typeof value.canRequest !== "boolean" || typeof value.canWithdraw !== "boolean") return null;
  const currentRevision = parseRevision(value.currentRevision);
  const sharedRevision = value.sharedRevision === null ? null : parseRevision(value.sharedRevision);
  if (!currentRevision || (value.sharedRevision !== null && !sharedRevision)) return null;
  let request: SkillSharingStatus["request"] = null;
  if (value.request !== null) {
    const candidate = value.request;
    if (!isRecord(candidate) || typeof candidate.id !== "string" || typeof candidate.revisionId !== "string" ||
      !Number.isSafeInteger(candidate.revisionNumber) || Number(candidate.revisionNumber) < 1 ||
      !SKILL_SHARE_REQUEST_STATES.includes(candidate.state as typeof SKILL_SHARE_REQUEST_STATES[number]) ||
      typeof candidate.createdAt !== "string" || !Number.isFinite(Date.parse(candidate.createdAt)) ||
      (candidate.reviewedAt !== null && (typeof candidate.reviewedAt !== "string" || !Number.isFinite(Date.parse(candidate.reviewedAt)))) ||
      (candidate.reviewNote !== null && typeof candidate.reviewNote !== "string")) return null;
    request = { id: candidate.id, revisionId: candidate.revisionId, revisionNumber: Number(candidate.revisionNumber),
      state: candidate.state as NonNullable<SkillSharingStatus["request"]>["state"], createdAt: candidate.createdAt,
      reviewedAt: candidate.reviewedAt, reviewNote: candidate.reviewNote };
  }
  return {
    currentRevision, sharedRevision, canRequest: value.canRequest, canWithdraw: value.canWithdraw,
    request
  };
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
  const files: SkillFileSummary[] = [];
  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) return null;
    for (const entry of value.files) {
      if (!isRecord(entry) || typeof entry.path !== "string" || !Number.isSafeInteger(entry.byteSize) || Number(entry.byteSize) < 0 ||
        (entry.kind !== "text" && entry.kind !== "binary") || typeof entry.executable !== "boolean") return null;
      files.push({ path: entry.path, byteSize: Number(entry.byteSize), kind: entry.kind, executable: entry.executable });
    }
  }
  if (value.bundle !== undefined && (!isRecord(value.bundle) ||
    !Number.isSafeInteger(value.bundle.fileCount) || Number(value.bundle.fileCount) < 0 ||
    !Number.isSafeInteger(value.bundle.totalBytes) || Number(value.bundle.totalBytes) < 0 ||
    typeof value.bundle.hasExecutables !== "boolean")) return null;
  const sharing = value.sharing === undefined ? undefined : parseSharing(value.sharing);
  if (sharing === null || (sharing && !skill.owned)) return null;
  return {
    ...skill,
    assistantUsageCount: Number(value.assistantUsageCount),
    audiences: audiences as SkillAudience[],
    canDelete: value.canDelete,
    canEdit: value.canEdit,
    canPublish: value.canPublish,
    canUnshare: value.canUnshare,
    instructions: value.instructions,
    ...(value.files === undefined ? {} : { files }),
    ...(value.bundle === undefined ? {} : { bundle: value.bundle as SkillDetail["bundle"] }),
    ...(sharing === undefined ? {} : { sharing }),
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

export class SkillRequestError extends Error {
  constructor(readonly issue: SkillValidationError) { super(issue.code); }
}

export function skillValidationMessage(issue: SkillValidationError): string {
  const field = issue.field ?? "Skill";
  if (issue.code === "skill_field_required") return `${field} is required.`;
  if (issue.actual !== undefined && issue.limit !== undefined) {
    return `${field}: ${issue.actual.toLocaleString()} exceeds the limit of ${issue.limit.toLocaleString()}.`;
  }
  if (issue.code === "skill_name_ambiguous") return "More than one of your Skills has this name. Rename one before importing.";
  if (issue.code === "skill_file_required") return "Choose a ZIP, SKILL.md, or a folder containing SKILL.md.";
  if (issue.code === "file_too_large") return `The upload is too large${issue.limit !== undefined ? `; the limit is ${issue.limit.toLocaleString()} bytes` : ""}.`;
  if (issue.code === "upload_busy") return "Another upload is in progress. Try importing again shortly.";
  return issue.code.replaceAll("_", " ");
}

function requestError(value: unknown, fallback: string): SkillRequestError {
  return new SkillRequestError({
    code: isRecord(value) && typeof value.error === "string" ? value.error : fallback,
    ...(isRecord(value) && typeof value.field === "string" ? { field: value.field } : {}),
    ...(isRecord(value) && Number.isSafeInteger(value.actual) && Number(value.actual) >= 0 ? { actual: Number(value.actual) } : {}),
    ...(isRecord(value) && Number.isSafeInteger(value.limit) && Number(value.limit) >= 0 ? { limit: Number(value.limit) } : {})
  });
}

async function request(input: string, init?: RequestInit): Promise<unknown> {
  const response = await shellFetch(input, init);
  const value = await responseJson(response);
  if (!response.ok) throw requestError(value, "skill_request_failed");
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

async function refreshCurrentSkillLibrary(): Promise<void> {
  // An accepted mutation supersedes any older list request. Refresh failure is
  // projected by the store and must not turn a committed import into a retry.
  loadPromise = null;
  await refreshSkillLibrary(true, useSkillLibraryStore.getState().query).catch(() => undefined);
}

export async function loadSkillDetail(skillId: string, signal?: AbortSignal): Promise<SkillDetail> {
  const value = await request(`/api/me/skills/${encodeURIComponent(skillId)}`, signal ? { signal } : undefined);
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

export async function setSkillEnabled(skillId: string, enabled: boolean): Promise<boolean> {
  const value = await request(`/api/me/skills/${encodeURIComponent(skillId)}/preference`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled })
  });
  if (!isRecord(value) || value.skillId !== skillId || typeof value.enabled !== "boolean") throw new Error("skill_response_invalid");
  useSkillLibraryStore.setState(state => ({ data: state.data ? { ...state.data,
    skills: state.data.skills.map(skill => skill.id === skillId ? { ...skill, enabled: value.enabled as boolean } : skill) } : null }));
  await refreshCurrentSkillLibrary();
  return value.enabled;
}

export async function enableAllSkills(): Promise<number> {
  const value = await request("/api/me/skills/enable-all", { method: "POST" });
  if (!isRecord(value) || !Number.isSafeInteger(value.enabledCount) || Number(value.enabledCount) < 0) throw new Error("skill_response_invalid");
  useSkillLibraryStore.setState(state => ({ data: state.data ? { ...state.data,
    skills: state.data.skills.map(skill => skill.archived ? skill : { ...skill, enabled: true }) } : null }));
  await refreshCurrentSkillLibrary();
  return Number(value.enabledCount);
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

export async function requestSkillApproval(skill: SkillSummary): Promise<SkillDetail> {
  const value = await request(`/api/me/skills/${encodeURIComponent(skill.id)}/share-requests`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ expectedVersion: skill.version })
  });
  const detail = isRecord(value) ? parseDetail(value.skill) : null;
  if (!detail) throw new Error("skill_response_invalid");
  await refreshCurrentSkillLibrary();
  return detail;
}

export async function withdrawSkillApproval(skillId: string, requestId: string): Promise<SkillDetail> {
  const value = await request(`/api/me/skills/${encodeURIComponent(skillId)}/share-requests`, {
    method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId })
  });
  const detail = isRecord(value) ? parseDetail(value.skill) : null;
  if (!detail) throw new Error("skill_response_invalid");
  await refreshCurrentSkillLibrary();
  return detail;
}

export async function deleteSkill(skillId: string): Promise<void> {
  await request(`/api/me/skills/${encodeURIComponent(skillId)}`, { method: "DELETE" });
  await refreshCurrentSkillLibrary();
}

export async function importSkills(files: readonly File[]): Promise<SkillImportResponse> {
  const form = new FormData();
  for (const file of files) form.append(file.webkitRelativePath || "file", file, file.name);
  const value = await request("/api/me/skills/import", { method: "POST", body: form });
  if (!isRecord(value) || !Array.isArray(value.results) || !Number.isSafeInteger(value.ignoredFiles) || Number(value.ignoredFiles) < 0) {
    throw new Error("skill_response_invalid");
  }
  const results: SkillImportResponse["results"] = [];
  for (const entry of value.results) {
    if (!isRecord(entry) || typeof entry.name !== "string") throw new Error("skill_response_invalid");
    if (entry.outcome === "failed" && isRecord(entry.error) && typeof entry.error.code === "string") {
      if ((entry.error.field !== undefined && typeof entry.error.field !== "string") ||
        [entry.error.actual, entry.error.limit].some((item) => item !== undefined && (!Number.isSafeInteger(item) || Number(item) < 0))) throw new Error("skill_response_invalid");
      results.push({ name: entry.name, outcome: "failed", error: { code: entry.error.code,
        ...(typeof entry.error.field === "string" ? { field: entry.error.field } : {}),
        ...(typeof entry.error.actual === "number" ? { actual: entry.error.actual } : {}),
        ...(typeof entry.error.limit === "number" ? { limit: entry.error.limit } : {}) } });
    } else if (["created", "updated", "unchanged"].includes(String(entry.outcome)) && typeof entry.skillId === "string") {
      results.push({ name: entry.name, outcome: entry.outcome as "created" | "updated" | "unchanged", skillId: entry.skillId });
    } else throw new Error("skill_response_invalid");
  }
  await refreshCurrentSkillLibrary();
  return { results, ignoredFiles: Number(value.ignoredFiles) };
}

export async function loadSkillFile(skillId: string, path: string): Promise<string> {
  const value = await request(`/api/me/skills/${encodeURIComponent(skillId)}/files?${new URLSearchParams({ path })}`);
  if (!isRecord(value) || value.path !== path || typeof value.content !== "string") throw new Error("skill_response_invalid");
  return value.content;
}

export async function exportSkills(skillId?: string): Promise<void> {
  const response = await shellFetch(`/api/me/skills/${skillId ? `${encodeURIComponent(skillId)}/` : ""}export`);
  if (!response.ok) {
    throw requestError(await responseJson(response), "skill_export_failed");
  }
  if (response.headers.get("content-type")?.split(";")[0]?.trim() !== "application/zip") throw new Error("skill_response_invalid");
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "skills.zip";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
