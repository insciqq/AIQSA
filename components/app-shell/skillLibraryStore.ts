import { shellFetch } from "@/components/app-shell/shellApi";
import type {
  SkillDraft,
  SkillListResponse,
  SkillSummary
} from "@/lib/contracts/skills";
import { create } from "zustand";

type SkillLibraryLoadState = "error" | "idle" | "loading" | "ready";

type SkillLibraryStore = {
  data: SkillListResponse | null;
  error: string | null;
  loadState: SkillLibraryLoadState;
};

export const useSkillLibraryStore = create<SkillLibraryStore>(() => ({
  data: null,
  error: null,
  loadState: "idle"
}));

let loadPromise: Promise<SkillListResponse> | null = null;

export function resetSkillLibraryStoreForTest(): void {
  loadPromise = null;
  useSkillLibraryStore.setState({
    data: null,
    error: null,
    loadState: "idle"
  }, true);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseSkill(value: unknown): SkillSummary | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" ||
    typeof value.description !== "string" || typeof value.instructions !== "string" ||
    typeof value.owned !== "boolean" || typeof value.archived !== "boolean" ||
    typeof value.ownerDisplayName !== "string" || !Number.isInteger(value.version) ||
    !isRecord(value.scope) || !["owner", "group", "installation"].includes(String(value.scope.kind))) {
    return null;
  }
  const scope = value.scope.kind === "group"
    ? Array.isArray(value.scope.groupNames) && value.scope.groupNames.every((name) => typeof name === "string")
      ? { groupNames: [...value.scope.groupNames] as string[], kind: "group" as const }
      : null
    : value.scope.kind === "owner"
      ? { kind: "owner" as const }
      : { kind: "installation" as const };
  if (!scope) return null;
  return {
    archived: value.archived,
    description: value.description,
    id: value.id,
    instructions: value.instructions,
    name: value.name,
    owned: value.owned,
    ownerDisplayName: value.ownerDisplayName,
    scope,
    version: Number(value.version)
  };
}

function parseList(value: unknown): SkillListResponse | null {
  if (!isRecord(value) || !Array.isArray(value.skills) ||
    !Array.isArray(value.publishableGroups) || !isRecord(value.viewer) ||
    typeof value.viewer.canPublishInstallation !== "boolean") return null;
  const skills = value.skills.map(parseSkill);
  if (skills.some((skill) => !skill)) return null;
  const publishableGroups = value.publishableGroups.flatMap((group) =>
    isRecord(group) && typeof group.id === "string" && typeof group.name === "string"
      ? [{ id: group.id, name: group.name }]
      : []
  );
  if (publishableGroups.length !== value.publishableGroups.length) return null;
  return {
    publishableGroups,
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

export async function refreshSkillLibrary(force = false): Promise<SkillListResponse> {
  const current = useSkillLibraryStore.getState();
  if (!force && current.loadState === "ready" && current.data) return current.data;
  if (loadPromise) return loadPromise;
  useSkillLibraryStore.setState({ error: null, loadState: "loading" });
  loadPromise = request("/api/me/skills").then((value) => {
    const data = parseList(value);
    if (!data) throw new Error("skill_response_invalid");
    useSkillLibraryStore.setState({ data, error: null, loadState: "ready" });
    return data;
  }).catch((error: unknown) => {
    useSkillLibraryStore.setState({
      error: error instanceof Error ? error.message : "skill_request_failed",
      loadState: "error"
    });
    throw error;
  }).finally(() => {
    loadPromise = null;
  });
  return loadPromise;
}

export async function createSkill(draft: SkillDraft): Promise<void> {
  await request("/api/me/skills", {
    body: JSON.stringify(draft),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  await refreshSkillLibrary(true);
}

export async function reviseSkill(skill: SkillSummary, draft: SkillDraft): Promise<void> {
  await request(`/api/me/skills/${encodeURIComponent(skill.id)}`, {
    body: JSON.stringify({ expectedVersion: skill.version, revision: draft }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
  await refreshSkillLibrary(true);
}

export async function setSkillArchived(skill: SkillSummary, archived: boolean): Promise<void> {
  await request(`/api/me/skills/${encodeURIComponent(skill.id)}`, {
    body: JSON.stringify({ archived, expectedVersion: skill.version }),
    headers: { "content-type": "application/json" },
    method: "PATCH"
  });
  await refreshSkillLibrary(true);
}

export async function publishSkill(
  skillId: string,
  publication: { groupId?: string; scope: "group" | "installation" }
): Promise<void> {
  await request(`/api/me/skills/${encodeURIComponent(skillId)}/publications`, {
    body: JSON.stringify(publication),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}
