/**
 * Artifacts are deliberately a small, provider-neutral file contract.  The
 * model may propose files, but it never gets to choose storage keys, URLs or
 * authority.  The server normalizes and validates this value before it can
 * become a version or a public bundle.
 */
export const ARTIFACT_KINDS = ["html", "slides", "game", "svg", "chart", "image"] as const;
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

export const ARTIFACT_LIMITS = Object.freeze({
  maxFiles: 32,
  maxPathBytes: 192,
  maxTitleBytes: 240,
  maxTextFileBytes: 512 * 1024,
  maxAssetBytes: 24 * 1024 * 1024,
  maxBundleBytes: 32 * 1024 * 1024,
  maxInlineSourceBytes: 160 * 1024,
  maxReadBytes: 256 * 1024,
  maxEdits: 64,
  maxContextArtifacts: 8,
  maxPublicationDays: 365,
  maxPublicationVersions: 100,
  maxOwnerPageSize: 100
});

export type ArtifactReference = Readonly<{ artifactId: string; versionId: string }>;

/**
 * Explicit user intent to edit one artifact version.  This is kept separate
 * from the server-owned ArtifactReference list: the browser may request a
 * target, but the run admission path must still prove that the target is
 * bound to the current chat before it becomes an accepted reference.
 */
export type ArtifactEdit = Readonly<{
  artifactId: string;
  versionId: string;
}>;

export function decodeArtifactEdit(value: unknown): ArtifactEdit | null {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "artifactId" && key !== "versionId")) {
    return null;
  }
  if (!validId(value.artifactId) || !validId(value.versionId)) return null;
  return { artifactId: value.artifactId, versionId: value.versionId };
}

export type ArtifactVersionSummary = Readonly<{
  id: string; title: string; kind: ArtifactKind; versionNumber: number; entrypoint: string | null;
  createdAt?: string;
}>;
export const ARTIFACT_PUBLIC_VERSION_HEADER = "X-AIQSA-Artifact-Version";
export const ARTIFACT_MAX_VERSION_NUMBER = 2_147_483_647;
type PublicationBase = Readonly<{
  id: string; status: "PENDING" | "READY" | "REVOKED"; expiresAt: string | null; createdAt: string;
}>;
export type ArtifactPublicationSummary = PublicationBase & (
  | Readonly<{ mode?: "single"; versionId: string; revision?: number; versionNumber?: number }>
  | Readonly<{ mode: "version_set"; revision: number; defaultVersionId: string; versions: readonly ArtifactVersionSummary[] }>
);
export type ArtifactPublicationCreate =
  | Readonly<{ mode?: "single"; versionId: string; expiresInDays?: number }>
  | Readonly<{ mode: "version_set"; versionIds: readonly string[]; defaultVersionId: string; expiresInDays?: number }>;
export type ArtifactPublicationMutation = Readonly<{ expectedRevision: number }> & (
  | Readonly<{ action: "add" | "reorder"; versionIds: readonly string[] }>
  | Readonly<{ action: "remove" | "set_default"; versionId: string }>
);
export type ArtifactPublicManifest = Readonly<{
  mode: "single" | "version_set"; title: string; kind: ArtifactKind; expiresAt: string | null;
  defaultVersionNumber: number;
  versions: readonly Readonly<{ versionNumber: number; title: string; kind: ArtifactKind }>[];
}>;
export type ArtifactVersionPage = Readonly<{ versions: readonly ArtifactVersionSummary[]; nextCursor: string | null }>;
export type ArtifactPublicationPage = Readonly<{ publications: readonly ArtifactPublicationSummary[]; nextCursor: string | null }>;
export type ArtifactDetail = Readonly<{
  id: string; title: string; currentVersionId: string | null; sourceChatId: string | null;
  versions: readonly ArtifactVersionSummary[]; publications: readonly ArtifactPublicationSummary[];
  versionsNextCursor?: string | null; publicationsNextCursor?: string | null;
}>;

function validVersionNumber(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= ARTIFACT_MAX_VERSION_NUMBER;
}
function validDate(value: unknown): value is string { return typeof value === "string" && Number.isFinite(Date.parse(value)); }
function validVersionIds(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= ARTIFACT_LIMITS.maxPublicationVersions &&
    value.every(validId) && new Set(value).size === value.length;
}
export function decodeArtifactPublicVersion(value: string | null): number | null {
  if (value === null || !/^[1-9][0-9]{0,9}$/u.test(value)) return null;
  const number = Number(value);
  return validVersionNumber(number) ? number : null;
}
export function decodeArtifactVersionSummary(value: unknown): ArtifactVersionSummary | null {
  if (!isRecord(value) || !validId(value.id) || typeof value.title !== "string" ||
    !ARTIFACT_KINDS.includes(value.kind as ArtifactKind) || !validVersionNumber(value.versionNumber) ||
    value.entrypoint !== null && typeof value.entrypoint !== "string" || value.createdAt !== undefined && !validDate(value.createdAt)) return null;
  return { id: value.id, title: value.title, kind: value.kind as ArtifactKind, versionNumber: value.versionNumber,
    entrypoint: value.entrypoint as string | null, ...(typeof value.createdAt === "string" ? { createdAt: value.createdAt } : {}) };
}
export function decodeArtifactPublicationSummary(value: unknown): ArtifactPublicationSummary | null {
  if (!isRecord(value) || !validId(value.id) || !["PENDING", "READY", "REVOKED"].includes(String(value.status)) ||
    !validDate(value.createdAt) || value.expiresAt !== null && !validDate(value.expiresAt)) return null;
  const base: PublicationBase = { id: value.id, status: value.status as PublicationBase["status"],
    expiresAt: value.expiresAt as string | null, createdAt: value.createdAt };
  if (value.mode === "version_set") {
    if (!validVersionNumber(value.revision) || !validId(value.defaultVersionId) || !Array.isArray(value.versions) ||
      value.versions.length === 0 || value.versions.length > ARTIFACT_LIMITS.maxPublicationVersions) return null;
    const versions = value.versions.map(decodeArtifactVersionSummary);
    if (versions.some(version => version === null)) return null;
    const selected = versions as ArtifactVersionSummary[];
    if (new Set(selected.map(version => version.id)).size !== selected.length ||
      new Set(selected.map(version => version.versionNumber)).size !== selected.length || !selected.some(version => version.id === value.defaultVersionId)) return null;
    return { ...base, mode: "version_set", revision: value.revision, defaultVersionId: value.defaultVersionId, versions: selected };
  }
  if (value.mode !== undefined && value.mode !== "single" || !validId(value.versionId) || value.revision !== undefined && !validVersionNumber(value.revision) || value.versionNumber !== undefined && !validVersionNumber(value.versionNumber)) return null;
  return { ...base, versionId: value.versionId, ...(value.mode === "single" ? { mode: "single" as const } : {}),
    ...(typeof value.revision === "number" ? { revision: value.revision } : {}),
    ...(typeof value.versionNumber === "number" ? { versionNumber: value.versionNumber } : {}) };
}
export function decodeArtifactPublicationCreate(value: unknown): ArtifactPublicationCreate | null {
  if (!isRecord(value) || value.expiresInDays !== undefined && (!Number.isInteger(value.expiresInDays) ||
    Number(value.expiresInDays) < 1 || Number(value.expiresInDays) > ARTIFACT_LIMITS.maxPublicationDays)) return null;
  const expiry = typeof value.expiresInDays === "number" ? { expiresInDays: value.expiresInDays } : {};
  if (value.mode === "version_set") {
    if (Object.keys(value).some(key => !["mode", "versionIds", "defaultVersionId", "expiresInDays"].includes(key)) ||
      !validVersionIds(value.versionIds) || !validId(value.defaultVersionId) || !value.versionIds.includes(value.defaultVersionId)) return null;
    return { mode: "version_set", versionIds: [...value.versionIds], defaultVersionId: value.defaultVersionId, ...expiry };
  }
  if (value.mode !== undefined && value.mode !== "single" || !validId(value.versionId) ||
    Object.keys(value).some(key => !["mode", "versionId", "expiresInDays"].includes(key))) return null;
  return { versionId: value.versionId, ...(value.mode === "single" ? { mode: "single" as const } : {}), ...expiry };
}
export function decodeArtifactPublicationMutation(value: unknown): ArtifactPublicationMutation | null {
  if (!isRecord(value) || !validVersionNumber(value.expectedRevision)) return null;
  if (value.action === "add" || value.action === "reorder") {
    if (!validVersionIds(value.versionIds) || Object.keys(value).some(key => !["action", "expectedRevision", "versionIds"].includes(key))) return null;
    return { action: value.action, expectedRevision: value.expectedRevision, versionIds: [...value.versionIds] };
  }
  if ((value.action !== "remove" && value.action !== "set_default") || !validId(value.versionId) ||
    Object.keys(value).some(key => !["action", "expectedRevision", "versionId"].includes(key))) return null;
  return { action: value.action, expectedRevision: value.expectedRevision, versionId: value.versionId };
}
export function decodeArtifactPublicationRevision(value: unknown): { expectedRevision: number } | null {
  return isRecord(value) && Object.keys(value).length === 1 && validVersionNumber(value.expectedRevision)
    ? { expectedRevision: value.expectedRevision } : null;
}
export function decodeArtifactPublicManifest(value: unknown): ArtifactPublicManifest | null {
  if (!isRecord(value) || !["single", "version_set"].includes(String(value.mode)) || typeof value.title !== "string" ||
    !ARTIFACT_KINDS.includes(value.kind as ArtifactKind) || value.expiresAt !== null && !validDate(value.expiresAt) ||
    !validVersionNumber(value.defaultVersionNumber) || !Array.isArray(value.versions) || value.versions.length === 0 ||
    value.versions.length > ARTIFACT_LIMITS.maxPublicationVersions || value.mode === "single" && value.versions.length !== 1) return null;
  const versions: Array<ArtifactPublicManifest["versions"][number]> = [];
  for (const version of value.versions) {
    if (!isRecord(version) || !validVersionNumber(version.versionNumber) || typeof version.title !== "string" || !ARTIFACT_KINDS.includes(version.kind as ArtifactKind)) return null;
    versions.push({ versionNumber: version.versionNumber, title: version.title, kind: version.kind as ArtifactKind });
  }
  if (new Set(versions.map(version => version.versionNumber)).size !== versions.length || !versions.some(version => version.versionNumber === value.defaultVersionNumber)) return null;
  return { mode: value.mode as ArtifactPublicManifest["mode"], title: value.title, kind: value.kind as ArtifactKind,
    expiresAt: value.expiresAt as string | null, defaultVersionNumber: value.defaultVersionNumber, versions };
}
export function decodeArtifactVersionPage(value: unknown): ArtifactVersionPage | null {
  if (!isRecord(value) || !Array.isArray(value.versions) || value.versions.length > ARTIFACT_LIMITS.maxOwnerPageSize || value.nextCursor !== null && !validId(value.nextCursor)) return null;
  const versions = value.versions.map(decodeArtifactVersionSummary);
  return versions.some(version => version === null) ? null : { versions: versions as ArtifactVersionSummary[], nextCursor: value.nextCursor as string | null };
}
export function decodeArtifactPublicationPage(value: unknown): ArtifactPublicationPage | null {
  if (!isRecord(value) || !Array.isArray(value.publications) || value.publications.length > ARTIFACT_LIMITS.maxOwnerPageSize || value.nextCursor !== null && !validId(value.nextCursor)) return null;
  const publications = value.publications.map(decodeArtifactPublicationSummary);
  return publications.some(publication => publication === null) ? null : { publications: publications as ArtifactPublicationSummary[], nextCursor: value.nextCursor as string | null };
}
export function decodeArtifactDetail(value: unknown): ArtifactDetail | null {
  if (!isRecord(value) || !validId(value.id) || typeof value.title !== "string" ||
    value.currentVersionId !== null && !validId(value.currentVersionId) || value.sourceChatId !== null && !validId(value.sourceChatId)) return null;
  const versions = decodeArtifactVersionPage({ versions: value.versions, nextCursor: value.versionsNextCursor ?? null });
  const publications = decodeArtifactPublicationPage({ publications: value.publications, nextCursor: value.publicationsNextCursor ?? null });
  if (!versions || !publications) return null;
  return { id: value.id, title: value.title, currentVersionId: value.currentVersionId as string | null,
    sourceChatId: value.sourceChatId as string | null, versions: versions.versions, publications: publications.publications,
    ...(value.versionsNextCursor !== undefined ? { versionsNextCursor: versions.nextCursor } : {}),
    ...(value.publicationsNextCursor !== undefined ? { publicationsNextCursor: publications.nextCursor } : {}) };
}

const TEXT_MIME_TYPES = new Set([
  "text/css", "text/html", "text/javascript", "text/markdown", "text/plain",
  "application/javascript", "application/json", "application/x-javascript",
  "image/svg+xml"
]);
const IMAGE_MIME_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const POSIX_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

export type ArtifactAssetRef = Readonly<{
  assetRef: string;
  mimeType: string;
  path: string;
}>;

export type ArtifactTextFile = Readonly<{
  mimeType: string;
  path: string;
  text: string;
}>;

export type ArtifactEditPatch = Readonly<{ path: string; old_string: string; new_string: string; replace_all?: boolean }>;
export type ArtifactOperation = Readonly<{
  baseVersionId?: string;
  entrypoint?: string | null;
  files?: readonly (ArtifactAssetRef | ArtifactTextFile)[];
  edits?: readonly ArtifactEditPatch[];
  delete_paths?: readonly string[];
  intent: "create" | "update";
  kind?: ArtifactKind;
  title?: string;
}>;

export type NormalizedArtifactFile = Readonly<{
  assetRef?: string;
  byteSize: number;
  mimeType: string;
  path: string;
  text?: string;
}>;

export type NormalizedArtifactOperation = Readonly<{
  baseVersionId?: string;
  entrypoint: string | null;
  files: readonly NormalizedArtifactFile[];
  intent: "create" | "update";
  kind: ArtifactKind;
  title: string;
  totalBytes: number;
}>;

export type ArtifactManifestFile = Readonly<{
  byteSize: number;
  mimeType: string;
  path: string;
  group?: "authored" | "vendored";
}>;

export type ArtifactSourceFile = Readonly<{
  path: string;
  mimeType: string;
  text?: string;
  binary?: true;
  group?: "authored" | "vendored";
  byteSize?: number;
}>;
export type ArtifactSource = Readonly<{ versionId: string; files: readonly ArtifactSourceFile[] }>;

export type ArtifactManifest = Readonly<{
  entrypoint: string | null;
  files: readonly ArtifactManifestFile[];
  kind: ArtifactKind;
  title: string;
  version: 1;
}>;

export class ArtifactContractError extends Error {
  constructor(readonly code: ArtifactContractErrorCode, readonly path?: string, readonly count?: number, readonly editIndex?: number) {
    super(code);
    this.name = "ArtifactContractError";
  }
}

export type ArtifactContractErrorCode =
  | "artifact_operation_invalid"
  | "artifact_title_invalid"
  | "artifact_kind_invalid"
  | "artifact_files_invalid"
  | "artifact_file_count_exceeded"
  | "artifact_path_invalid"
  | "artifact_path_duplicate"
  | "artifact_mime_invalid"
  | "artifact_text_invalid"
  | "artifact_text_limit_exceeded"
  | "artifact_asset_ref_invalid"
  | "artifact_entrypoint_invalid"
  | "artifact_entrypoint_missing"
  | "artifact_bundle_limit_exceeded"
  | "artifact_base_version_invalid"
  | "artifact_edit_not_found" | "artifact_edit_ambiguous" | "artifact_edit_path_invalid"
  | "artifact_edit_invalid" | "artifact_edit_limit_exceeded" | "artifact_delete_entrypoint";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function cleanString(value: unknown, maxBytes: number): string | null {
  if (typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value) || utf8Bytes(value.normalize("NFC")) > maxBytes) return null;
  return value.normalize("NFC");
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function normalizedArtifactPath(value: unknown): string | null {
  const path = cleanString(value, ARTIFACT_LIMITS.maxPathBytes);
  if (!path || !POSIX_PATH.test(path) || path.endsWith("/") || path.includes("//")) return null;
  if (path.split("/").some((part) => part === "" || part === "." || part === "..")) return null;
  return path;
}

function normalizedMime(value: unknown): string | null {
  if (typeof value !== "string" || value.length < 1 || value.length > 128 ||
    !/^[a-z][a-z0-9!#$&^_.+-]*\/[a-z0-9!#$&^_.+-]+$/iu.test(value)) return null;
  return value.toLowerCase();
}

function normalizedKind(value: unknown): ArtifactKind {
  if (!ARTIFACT_KINDS.includes(value as ArtifactKind)) throw new ArtifactContractError("artifact_kind_invalid");
  return value as ArtifactKind;
}

function normalizeFile(value: unknown): NormalizedArtifactFile {
  if (!isRecord(value) || Object.keys(value).some((key) => !["path", "mimeType", "text", "assetRef"].includes(key))) throw new ArtifactContractError("artifact_files_invalid");
  const path = normalizedArtifactPath(value.path);
  const mimeType = normalizedMime(value.mimeType);
  if (!path || path.split("/")[0] === "_vendor") throw new ArtifactContractError("artifact_path_invalid");
  if (!mimeType) throw new ArtifactContractError("artifact_mime_invalid");
  const text = value.text;
  const assetRef = value.assetRef;
  if (text !== undefined && assetRef !== undefined) throw new ArtifactContractError("artifact_files_invalid");
  if (text !== undefined) {
    if (!TEXT_MIME_TYPES.has(mimeType) || typeof text !== "string" || /[\uD800-\uDFFF]/u.test(text) || text.includes("\u0000")) {
      throw new ArtifactContractError("artifact_text_invalid");
    }
    const byteSize = utf8Bytes(text);
    if (byteSize > ARTIFACT_LIMITS.maxTextFileBytes) throw new ArtifactContractError("artifact_text_limit_exceeded");
    return { byteSize, mimeType, path, text };
  }
  if (!IMAGE_MIME_TYPES.has(mimeType) || !validId(assetRef)) {
    throw new ArtifactContractError("artifact_asset_ref_invalid");
  }
  return { assetRef, byteSize: 0, mimeType, path };
}

export function normalizeArtifactOperation(value: unknown, base?: Pick<NormalizedArtifactOperation, "kind" | "title" | "entrypoint" | "files">): NormalizedArtifactOperation {
  if (!isRecord(value) || Object.keys(value).some((key) => !["baseVersionId", "entrypoint", "files", "intent", "kind", "title", "edits", "delete_paths"].includes(key))) throw new ArtifactContractError("artifact_operation_invalid");
  if (value.intent !== "create" && value.intent !== "update") throw new ArtifactContractError("artifact_operation_invalid");
  if (value.intent === "update" && !validId(value.baseVersionId)) throw new ArtifactContractError("artifact_base_version_invalid");
  if (value.intent === "create" && value.baseVersionId !== undefined) throw new ArtifactContractError("artifact_base_version_invalid");
  if (value.intent === "create" && (value.edits !== undefined || value.delete_paths !== undefined)) throw new ArtifactContractError("artifact_operation_invalid");
  const kind = normalizedKind(value.kind ?? (value.intent === "update" ? base?.kind : undefined));
  const title = cleanString(value.title ?? (value.intent === "update" ? base?.title : undefined), ARTIFACT_LIMITS.maxTitleBytes);
  if (!title?.trim()) throw new ArtifactContractError("artifact_title_invalid");
  if (value.files !== undefined && !Array.isArray(value.files)) throw new ArtifactContractError("artifact_files_invalid");
  if (value.intent === "create" && (!Array.isArray(value.files) || !value.files.length)) throw new ArtifactContractError("artifact_files_invalid");
  const suppliedFiles = (value.files as unknown[] | undefined) ?? [];
  if (suppliedFiles.length > ARTIFACT_LIMITS.maxFiles) throw new ArtifactContractError("artifact_file_count_exceeded");
  const supplied = suppliedFiles.map(normalizeFile);
  if (new Set(supplied.map(file => file.path)).size !== supplied.length) throw new ArtifactContractError("artifact_path_duplicate");
  if (value.edits !== undefined && !Array.isArray(value.edits)) throw new ArtifactContractError("artifact_edit_invalid");
  if (Array.isArray(value.edits) && value.edits.length > ARTIFACT_LIMITS.maxEdits) {
    const excess = value.edits[ARTIFACT_LIMITS.maxEdits];
    throw new ArtifactContractError("artifact_edit_limit_exceeded", isRecord(excess) ? normalizedArtifactPath(excess.path) ?? undefined : undefined, undefined, ARTIFACT_LIMITS.maxEdits);
  }
  if (value.delete_paths !== undefined && (!Array.isArray(value.delete_paths) || value.delete_paths.length > ARTIFACT_LIMITS.maxFiles)) throw new ArtifactContractError("artifact_path_invalid");
  const edits = (value.edits as unknown[] | undefined) ?? [];
  const deletions = (value.delete_paths as unknown[] | undefined) ?? [];
  if (value.intent === "update" && !supplied.length && !edits.length && !deletions.length) throw new ArtifactContractError("artifact_operation_invalid");
  const merged = new Map((value.intent === "update" ? base?.files ?? [] : []).map(file => [file.path, file]));
  for (const [editIndex, edit] of edits.entries()) {
    const path = isRecord(edit) ? normalizedArtifactPath(edit.path) : null;
    if (!isRecord(edit) || Object.keys(edit).some(key => !["path", "old_string", "new_string", "replace_all"].includes(key)) ||
      typeof edit.old_string !== "string" || !edit.old_string || typeof edit.new_string !== "string" || edit.old_string === edit.new_string ||
      edit.replace_all !== undefined && typeof edit.replace_all !== "boolean") throw new ArtifactContractError("artifact_edit_invalid", path ?? undefined, undefined, editIndex);
    if (utf8Bytes(edit.old_string) > ARTIFACT_LIMITS.maxTextFileBytes || utf8Bytes(edit.new_string) > ARTIFACT_LIMITS.maxTextFileBytes) throw new ArtifactContractError("artifact_edit_limit_exceeded", path ?? undefined, undefined, editIndex);
    const file = path ? merged.get(path) : undefined;
    if (!path || !file || file.text === undefined) throw new ArtifactContractError("artifact_edit_path_invalid", path ?? undefined, undefined, editIndex);
    const count = file.text.split(edit.old_string).length - 1;
    if (!count) throw new ArtifactContractError("artifact_edit_not_found", path, undefined, editIndex);
    if (count !== 1 && edit.replace_all !== true) throw new ArtifactContractError("artifact_edit_ambiguous", path, count, editIndex);
    const text = edit.replace_all === true ? file.text.split(edit.old_string).join(edit.new_string) : file.text.replace(edit.old_string, () => edit.new_string as string);
    merged.set(path, normalizeFile({ path, mimeType: file.mimeType, text }));
  }
  const requestedEntrypoint = value.entrypoint === undefined && value.intent === "update" ? base?.entrypoint : value.entrypoint;
  for (const candidate of deletions) {
    const path = normalizedArtifactPath(candidate);
    if (!path || !merged.has(path)) throw new ArtifactContractError("artifact_edit_path_invalid", path ?? undefined);
    if (path === requestedEntrypoint || path === base?.entrypoint) throw new ArtifactContractError("artifact_delete_entrypoint", path);
    merged.delete(path);
  }
  for (const file of supplied) merged.set(file.path, file);
  const files = [...merged.values()];
  if (!files.length) throw new ArtifactContractError("artifact_files_invalid");
  if (files.length > ARTIFACT_LIMITS.maxFiles) throw new ArtifactContractError("artifact_file_count_exceeded");
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (paths.has(file.path)) throw new ArtifactContractError("artifact_path_duplicate");
    paths.add(file.path);
    totalBytes += file.byteSize;
  }
  if (totalBytes > ARTIFACT_LIMITS.maxBundleBytes) throw new ArtifactContractError("artifact_bundle_limit_exceeded");
  const rawEntrypoint = requestedEntrypoint;
  const entrypoint = rawEntrypoint === undefined || rawEntrypoint === null ? null : normalizedArtifactPath(rawEntrypoint);
  if (rawEntrypoint !== undefined && rawEntrypoint !== null && !entrypoint) throw new ArtifactContractError("artifact_entrypoint_invalid");
  if (kind !== "image") {
    if (!entrypoint || !paths.has(entrypoint)) throw new ArtifactContractError("artifact_entrypoint_missing");
    const entryFile = files.find((file) => file.path === entrypoint);
    if (!entryFile || !(kind === "svg" ? entryFile.mimeType === "image/svg+xml" : ["text/html", "image/svg+xml"].includes(entryFile.mimeType))) {
      throw new ArtifactContractError("artifact_entrypoint_invalid");
    }
  } else if (entrypoint !== null) {
    throw new ArtifactContractError("artifact_entrypoint_invalid");
  }
  if (kind === "image" && files.some((file) => !file.assetRef)) throw new ArtifactContractError("artifact_mime_invalid");
  return {
    ...(value.baseVersionId !== undefined ? { baseVersionId: String(value.baseVersionId) } : {}),
    entrypoint,
    files,
    intent: value.intent,
    kind,
    title: title.trim(),
    totalBytes
  };
}

export function artifactManifest(operation: Pick<NormalizedArtifactOperation, "entrypoint" | "files" | "kind" | "title">): ArtifactManifest {
  return {
    entrypoint: operation.entrypoint,
    files: operation.files.map(({ byteSize, mimeType, path }) => ({ byteSize, mimeType, path })),
    kind: operation.kind,
    title: operation.title,
    version: 1
  };
}

export function artifactContentSecurityPolicy(delivery: "header" | "meta" = "header"): string {
  // frame-ancestors is enforced only in a response header; browsers report it
  // as an ignored policy error in srcdoc's meta element.
  return "default-src 'none'; base-uri 'none'; form-action 'none'; " +
    (delivery === "header" ? "frame-ancestors 'none'; " : "") +
    "img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "font-src data:; connect-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'";
}

export function isArtifactTextMime(mimeType: string): boolean {
  return TEXT_MIME_TYPES.has(mimeType.toLowerCase());
}
