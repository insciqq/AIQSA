import type { ModelToolCall, ToolExecutionResult } from "../tools/types";
import { ARTIFACT_UNPACK_SKIPPED_FILES, type ArtifactUnpackReport } from "./unpack";

/** Paths of an unpacked site listed in its tool result; `more_paths` counts the rest. */
export const ARTIFACT_RESULT_PATHS = 100;
const NOTE_ENTRIES = 32;
const NOTE_CHARACTERS = 256;
const ARCHIVE_PATH_CHARACTERS = 512;

export type ArtifactRemovedLinkNote = Readonly<{ page: string; rel: string; href: string }>;
export type ArtifactMissingLinkNote = Readonly<{ page: string; href: string; path: string }>;
/** Render findings that never block a version: service links removed from pages, local links to missing files. */
export type ArtifactRenderNotes = Readonly<{
  removedLinks: readonly ArtifactRemovedLinkNote[];
  missingLinks: readonly ArtifactMissingLinkNote[];
  /** Further notes beyond the listed ones. */
  omitted: number;
}>;

/**
 * Findings of a version's creation, stored in its private manifest so that a
 * recovered receipt equals the original one.
 */
export type ArtifactVersionReport = Readonly<{
  unpacked?: ArtifactUnpackReport;
  /** The build's render notes, once the renderer reports them. */
  renderNotes?: ArtifactRenderNotes;
}>;

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
  if (!Array.isArray(value) || value.length > NOTE_ENTRIES) return undefined;
  const notes = value.map(note => isRecord(note) && keys.every(key => boundedText(note[key], NOTE_CHARACTERS))
    ? Object.fromEntries(keys.map(key => [key, note[key]])) as Record<T, string> : null);
  return notes.every(note => note !== null) ? notes as Array<Record<T, string>> : undefined;
}

function decodeRenderNotes(value: unknown): ArtifactRenderNotes | undefined {
  if (!isRecord(value) || !isCount(value.omitted)) return undefined;
  const removedLinks = decodeNotes(value.removedLinks, ["page", "rel", "href"] as const);
  const missingLinks = decodeNotes(value.missingLinks, ["page", "href", "path"] as const);
  return removedLinks && missingLinks ? { removedLinks, missingLinks, omitted: value.omitted } : undefined;
}

/** The validated report of a stored private manifest, if it has one. */
export function decodeArtifactVersionReport(manifest: unknown): ArtifactVersionReport | undefined {
  if (!isRecord(manifest) || !isRecord(manifest.report)) return undefined;
  const unpacked = decodeUnpacked(manifest.report.unpacked);
  const renderNotes = decodeRenderNotes(manifest.report.renderNotes);
  return unpacked || renderNotes ? { ...(unpacked ? { unpacked } : {}), ...(renderNotes ? { renderNotes } : {}) } : undefined;
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
    ...(notes ? { render_notes: { removed_links: notes.removedLinks, missing_links: notes.missingLinks,
      ...(notes.omitted ? { omitted: notes.omitted } : {}) } } : {})
  };
  return { callId: call.id, name: call.name, status: "complete", content: [{ type: "json", value }],
    artifacts: [{ type: "artifact", data: { artifactType: "generated_artifact", payload } }] };
}
