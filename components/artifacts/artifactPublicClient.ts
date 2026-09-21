import { ARTIFACT_PUBLIC_VERSION_HEADER, decodeArtifactPublicManifest, decodeArtifactPublicVersion, type ArtifactPublicManifest } from "@/lib/contracts/artifacts";

export class ArtifactPublicRequestError extends Error {
  constructor(readonly status: number) {
    super(status === 429 ? "Too many requests. Wait a moment and try again."
      : status === 404 || status === 410 ? "This artifact is unavailable."
      : "Could not load this artifact. Try again.");
  }
}

export function artifactPublicPath(token: string): string { return `/api/artifact-public/${encodeURIComponent(token)}`; }

/** Invalid fragments are deliberately indistinguishable from unpublished versions. */
export function publicArtifactSelection(manifest: ArtifactPublicManifest, fragment: string) {
  const match = /^#v([1-9][0-9]{0,9})$/u.exec(fragment);
  const number = match ? decodeArtifactPublicVersion(match[1]!) : null;
  const requested = number === null ? undefined : manifest.versions.find(version => version.versionNumber === number);
  const selected = manifest.mode === "version_set" && requested ? requested
    : manifest.versions.find(version => version.versionNumber === manifest.defaultVersionNumber)!;
  return { selected, fallback: manifest.mode === "version_set" && fragment !== "" && !requested };
}

export async function fetchPublicArtifactManifest(token: string, signal: AbortSignal): Promise<ArtifactPublicManifest> {
  const response = await fetch(`${artifactPublicPath(token)}/manifest`, { cache: "no-store", credentials: "omit", signal });
  if (!response.ok) throw new ArtifactPublicRequestError(response.status);
  const body: unknown = await response.json();
  const manifest = decodeArtifactPublicManifest(body && typeof body === "object" && "publication" in body ? body.publication : null);
  if (!manifest) throw new Error("The published versions could not be read. Try again.");
  return manifest;
}

export async function fetchPublicArtifactVersion(token: string, versionNumber: number, signal: AbortSignal, download = false): Promise<Response> {
  const response = await fetch(`${artifactPublicPath(token)}${download ? "?download=zip" : ""}`, {
    cache: "no-store", credentials: "omit", signal, headers: { [ARTIFACT_PUBLIC_VERSION_HEADER]: String(versionNumber) }
  });
  if (!response.ok) throw new ArtifactPublicRequestError(response.status);
  if (response.headers.get(ARTIFACT_PUBLIC_VERSION_HEADER) !== String(versionNumber)) {
    throw new Error("The selected version could not be verified. Try again.");
  }
  return response;
}

export function publicArtifactDownloadName(response: Response, versionNumber: number): string {
  const header = response.headers.get("content-disposition") ?? "";
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  let name = /filename="([^"]+)"/iu.exec(header)?.[1];
  try { if (encoded) name = decodeURIComponent(encoded); } catch { /* Use the safe fallback. */ }
  return name && name.length <= 240 && !/[\\/\u0000-\u001f\u007f]/u.test(name) && name.endsWith(".zip")
    ? name : `artifact-v${versionNumber}.zip`;
}
