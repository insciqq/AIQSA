import { ARTIFACT_LIMITS } from "@/lib/contracts/artifacts";
import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { ARTIFACT_NOTE_LIMITS, type ArtifactBundleNotes } from "./bundle";
import { ARTIFACT_UNPACK_SKIPPED_FILES, type ArtifactUnpackReport } from "./unpack";

/** Paths of an unpacked site listed in its tool result; `more_paths` counts the rest. */
export const ARTIFACT_RESULT_PATHS = 100;
const NOTE_CHARACTERS = 256;
const ARCHIVE_PATH_CHARACTERS = 512;
const INVALID_PAGES_HINT = "Each page in invalid_pages failed validation with the given error code and shows that error when opened; fix it with edits.";
const MISSING_LINKS_HINT = "Each link in missing_links points to a file this artifact does not hold; add the file or correct the href with edits.";
const UNVALIDATED_PAGES_HINT = "unvalidated_pages counts pages not checked at creation, since the pages checked first used up the site's validation budget; each is checked when opened and shows any error then.";

/**
 * Render findings that never block a version: service links removed from pages, local links
 * to missing files, pages other than the entry page that fail validation and pages left for
 * validation when opened.
 */
export type ArtifactRenderNotes = Omit<ArtifactBundleNotes, "pages">;

/**
 * Findings of a version's creation, stored in its private manifest so that a
 * recovered receipt equals the original one.
 */
export type ArtifactVersionReport = Readonly<{
  unpacked?: ArtifactUnpackReport;
  renderNotes?: ArtifactRenderNotes;
}>;

/** The build's notes worth reporting, or nothing for a clean build. */
export function artifactRenderNotes(notes: ArtifactBundleNotes): ArtifactRenderNotes | undefined {
  const { removedLinks, missingLinks, invalidPages, omitted, unvalidatedPages } = notes;
  return removedLinks.length || missingLinks.length || invalidPages.length || omitted || unvalidatedPages
    ? { removedLinks, missingLinks, invalidPages, omitted, unvalidatedPages } : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const boundedText = (value: unknown, max: number): value is string => typeof value === "string" && value.length <= max;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

function decodeUnpacked(value: unknown): ArtifactUnpackReport | undefined {
  if (!isRecord(value) || value.rootFolder !== null && !boundedText(value.rootFolder, ARCHIVE_PATH_CHARACTERS) || !isCount(value.skippedEntries) ||
    !Array.isArray(value.skippedFiles) || value.skippedFiles.length > ARTIFACT_UNPACK_SKIPPED_FILES ||
    !value.skippedFiles.every(path => boundedText(path, ARCHIVE_PATH_CHARACTERS))) return undefined;
  return { rootFolder: value.rootFolder as string | null, skippedEntries: value.skippedEntries, skippedFiles: value.skippedFiles as string[] };
}

function decodeNotes<T extends string>(value: unknown, keys: readonly T[]): Array<Record<T, string>> | undefined {
  if (!Array.isArray(value) || value.length > ARTIFACT_NOTE_LIMITS.maxEntries) return undefined;
  const notes = value.map(note => isRecord(note) && keys.every(key => boundedText(note[key], NOTE_CHARACTERS))
    ? Object.fromEntries(keys.map(key => [key, note[key]])) as Record<T, string> : null);
  return notes.every(note => note !== null) ? notes as Array<Record<T, string>> : undefined;
}

function decodeRenderNotes(value: unknown): ArtifactRenderNotes | undefined {
  if (!isRecord(value) || !isCount(value.omitted)) return undefined;
  // Notes stored before the validation budget have no unvalidated pages.
  const unvalidatedPages = value.unvalidatedPages ?? 0;
  if (!isCount(unvalidatedPages) || unvalidatedPages > ARTIFACT_LIMITS.maxBundleFiles) return undefined;
  const removedLinks = decodeNotes(value.removedLinks, ["page", "rel", "href"] as const);
  const missingLinks = decodeNotes(value.missingLinks, ["page", "href", "path"] as const);
  const invalidPages = decodeNotes(value.invalidPages, ["page", "code"] as const);
  return removedLinks && missingLinks && invalidPages ? { removedLinks, missingLinks, invalidPages, omitted: value.omitted, unvalidatedPages } : undefined;
}

/** The validated report of a stored private manifest, if it has one. */
export function decodeArtifactVersionReport(manifest: unknown): ArtifactVersionReport | undefined {
  if (!isRecord(manifest) || !isRecord(manifest.report)) return undefined;
  const unpacked = decodeUnpacked(manifest.report.unpacked);
  const renderNotes = decodeRenderNotes(manifest.report.renderNotes);
  return unpacked || renderNotes ? { ...(unpacked ? { unpacked } : {}), ...(renderNotes ? { renderNotes } : {}) } : undefined;
}

/** Non-empty lists only, with one hint line for the findings the model can repair. */
function renderNotesValue(notes: ArtifactRenderNotes) {
  const hint = [notes.invalidPages.length ? INVALID_PAGES_HINT : "", notes.missingLinks.length ? MISSING_LINKS_HINT : "",
    notes.unvalidatedPages ? UNVALIDATED_PAGES_HINT : ""].filter(Boolean).join(" ");
  return {
    ...(notes.removedLinks.length ? { removed_links: notes.removedLinks } : {}),
    ...(notes.missingLinks.length ? { missing_links: notes.missingLinks } : {}),
    ...(notes.invalidPages.length ? { invalid_pages: notes.invalidPages } : {}),
    ...(notes.omitted ? { omitted: notes.omitted } : {}),
    ...(notes.unvalidatedPages ? { unvalidated_pages: notes.unvalidatedPages } : {}),
    ...(hint ? { hint } : {})
  };
}

/** The same exact-version receipt is used by execution and crash recovery. */
export function artifactToolResult(call: Pick<ModelToolCall, "id" | "name">, version: {
  artifactId: string; id: string; versionNumber: number; kind: string; title: string; entrypoint: string | null;
  manifest: { files: ReadonlyArray<{ byteSize: number; path: string; group?: "authored" | "vendored" }> };
  report?: ArtifactVersionReport;
}): ToolExecutionResult {
  const payload = { artifact_id: version.artifactId, version_id: version.id, version_number: version.versionNumber,
    kind: version.kind, title: version.title, entrypoint: version.entrypoint,
    byte_size: version.manifest.files.reduce((sum, file) => sum + file.byteSize, 0) };
  const unpacked = version.report?.unpacked;
  const notes = version.report?.renderNotes;
  const paths = unpacked ? version.manifest.files.filter(file => file.group !== "vendored").map(file => file.path).sort() : [];
  // The model learns what an archive became; the conversation card keeps the compact payload.
  const value = {
    ...payload,
    ...(unpacked ? { unpacked: {
      root_folder: unpacked.rootFolder,
      skipped_entries: unpacked.skippedEntries,
      ...(unpacked.skippedFiles.length ? { skipped_files: unpacked.skippedFiles } : {}),
      file_count: paths.length,
      paths: paths.slice(0, ARTIFACT_RESULT_PATHS),
      ...(paths.length > ARTIFACT_RESULT_PATHS ? { more_paths: paths.length - ARTIFACT_RESULT_PATHS } : {})
    } } : {}),
    ...(notes ? { render_notes: renderNotesValue(notes) } : {})
  };
  return { callId: call.id, name: call.name, status: "complete", content: [{ type: "json", value }],
    artifacts: [{ type: "artifact", data: { artifactType: "generated_artifact", payload } }] };
}
