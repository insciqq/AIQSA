import type { ArtifactManifest } from "@/lib/contracts/artifacts";
import { ArtifactToolError } from "./errors";

/**
 * The page a content request selects, from the version's manifest and before any bundle
 * read: undefined for the entry page (also when the request names the entrypoint), else an
 * authored HTML file of the version. Any other path is `artifact_page_not_found`.
 */
export function artifactRequestedPage(manifest: ArtifactManifest, page?: string): string | undefined {
  if (page === undefined || page === manifest.entrypoint) return undefined;
  if (manifest.files.some(file => file.path === page && file.mimeType === "text/html" && file.group !== "vendored")) return page;
  throw new ArtifactToolError("artifact_page_not_found", { path: page, hint: "Open the entry page or another HTML page of this artifact." });
}

/** The bytes a render, export or SVG download of the version materializes: all of its files. */
export function artifactRenderBytes(manifest: ArtifactManifest): number {
  return manifest.files.reduce((sum, file) => sum + file.byteSize, 0);
}

/** The download extension of rendered content: an HTML page, a standalone SVG or an image. */
export function artifactRenderExtension(contentType: string): string {
  const essence = contentType.split(";")[0]!.trim().toLowerCase();
  if (essence === "image/svg+xml") return "svg";
  if (essence === "image/jpeg") return "jpg";
  return essence.startsWith("image/") ? essence.slice("image/".length) : "html";
}
