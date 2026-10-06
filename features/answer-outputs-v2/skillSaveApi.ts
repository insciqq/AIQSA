import { decodeSkillSaveUndoState, type SkillSaveUndoState } from "@/lib/contracts/skillSaves";

/** A failed card request: the server's stable code when it sent one. */
export class SkillSaveApiError extends Error {
  constructor(readonly code: string | null, readonly status: number) {
    super(code ?? `skill_save_http_${status}`);
    this.name = "SkillSaveApiError";
  }
}

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const response = await fetch(path, { ...init, cache: "no-store", credentials: "same-origin" });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === "object" && !Array.isArray(body) &&
      typeof (body as { error?: unknown }).error === "string" ? (body as { error: string }).error : null;
    throw new SkillSaveApiError(code, response.status);
  }
  return body;
}

const undoPath = (skillId: string, saveId: string) =>
  `/api/me/skills/${encodeURIComponent(skillId)}/saves/${encodeURIComponent(saveId)}/undo`;

function undoState(body: unknown): SkillSaveUndoState {
  const state = decodeSkillSaveUndoState(body);
  if (!state) throw new SkillSaveApiError(null, 200);
  return state;
}

export async function readSkillSaveUndoState(skillId: string, saveId: string, signal?: AbortSignal): Promise<SkillSaveUndoState> {
  return undoState(await request(undoPath(skillId, saveId), { signal }));
}

export async function undoSkillSave(skillId: string, saveId: string): Promise<SkillSaveUndoState> {
  return undoState(await request(undoPath(skillId, saveId), { method: "POST" }));
}

/** The immutable text of one file of the revision a save made. */
export async function readSavedSkillFile(skillId: string, revisionId: string, path: string, signal?: AbortSignal): Promise<string> {
  const body = await request(`/api/me/skills/${encodeURIComponent(skillId)}/revisions/${encodeURIComponent(revisionId)}/file?${
    new URLSearchParams({ path })}`, { signal });
  const content = body && typeof body === "object" && !Array.isArray(body) ? (body as { content?: unknown }).content : null;
  if (typeof content !== "string") throw new SkillSaveApiError(null, 200);
  return content;
}
