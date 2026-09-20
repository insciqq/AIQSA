import { decodeArtifactDetail } from "@/lib/contracts/artifacts";

export const artifactButtonClass = "v2-focusable inline-flex min-h-10 items-center justify-center rounded-md border border-trace-subtle px-3 text-sm font-medium text-ink hover:border-control-accent disabled:opacity-50";

export async function artifactRequest(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === "object" && "error" in body ? body.error : null;
    throw new Error(code === "artifact_version_conflict" ? "A newer version exists. Open the current version and try again."
      : response.status === 401 ? "Sign in again to open this artifact."
      : response.status === 404 ? "This artifact is no longer available."
      : "The request could not finish. Try again.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The response could not be read. Try again.");
  return body as Record<string, unknown>;
}

export async function loadArtifactDetail(artifactId: string, signal?: AbortSignal) {
  const body = await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}`, { signal });
  const detail = decodeArtifactDetail(body.artifact);
  if (!detail || detail.id !== artifactId) throw new Error("The version history could not be read. Try again.");
  return detail;
}

export async function prepareArtifactEdit(artifactId: string, versionId: string, chatId?: string) {
  const body = await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/edit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId, ...(chatId ? { chatId } : {}) })
  });
  if (typeof body.chatId !== "string") throw new Error("The chat could not be opened. Try again.");
  return body.chatId;
}
