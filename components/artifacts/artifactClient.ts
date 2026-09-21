import { decodeArtifactDetail, decodeArtifactVersionPage, decodeArtifactPublicationPage } from "@/lib/contracts/artifacts";

export class ArtifactRequestError extends Error {
  constructor(message: string, readonly status: number, readonly code: string | null) { super(message); }
}

export async function artifactRequest(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(path, { cache: "no-store", ...init });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const code = body && typeof body === "object" && "error" in body ? body.error : null;
    throw new ArtifactRequestError(code === "artifact_version_conflict" ? "A newer version exists. Open the current version and try again."
      : response.status === 409 ? "This link changed elsewhere. Review its current versions before trying again."
      : response.status === 401 ? "Sign in again to open this artifact."
      : response.status === 404 ? "This artifact is no longer available."
      : "The request could not finish. Try again.", response.status, typeof code === "string" ? code : null);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("The response could not be read. Try again.");
  return body as Record<string, unknown>;
}

export async function loadArtifactDetail(artifactId: string, signal?: AbortSignal, versionId?: string) {
  const body = await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}`, { signal });
  const detail = decodeArtifactDetail(body.artifact);
  if (!detail || detail.id !== artifactId) throw new Error("The version history could not be read. Try again.");
  // At most two anchors preserve historical selection and a restored current version
  // without walking the full history before opening the viewer or its edit intent.
  const missing = [...new Set([versionId, detail.currentVersionId].filter((id): id is string => Boolean(id)))]
    .filter(id => !detail.versions.some(version => version.id === id));
  if (!missing.length) return detail;
  const pages = await Promise.all(missing.map(versionId => loadArtifactVersionPage(artifactId, { versionId }, signal)));
  return { ...detail, versions: [...detail.versions, ...pages.flatMap(page => page.versions)] };
}

export async function loadArtifactVersionPage(artifactId: string, selection: { cursor: string } | { versionId: string }, signal?: AbortSignal) {
  const query = new URLSearchParams(selection);
  const body = await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/versions?${query}`, { signal });
  const page = decodeArtifactVersionPage(body);
  if (!page || "versionId" in selection && (page.versions.length !== 1 || page.versions[0]?.id !== selection.versionId)) {
    throw new Error("The version history could not be read. Try again.");
  }
  return page;
}

export async function loadArtifactPublicationPage(artifactId: string, cursor: string, signal?: AbortSignal) {
  const body = await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/publications?${new URLSearchParams({ cursor })}`, { signal });
  const page = decodeArtifactPublicationPage(body);
  if (!page) throw new Error("The published links could not be read. Try again.");
  return page;
}

export async function prepareArtifactEdit(artifactId: string, versionId: string, chatId?: string) {
  const body = await artifactRequest(`/api/artifacts/${encodeURIComponent(artifactId)}/edit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ versionId, ...(chatId ? { chatId } : {}) })
  });
  if (typeof body.chatId !== "string") throw new Error("The chat could not be opened. Try again.");
  return body.chatId;
}
