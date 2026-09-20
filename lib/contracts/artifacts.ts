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
  maxSourceBytes: 2 * 1024 * 1024,
  maxContextArtifacts: 8,
  maxPublicationDays: 365
});

export type ArtifactReference = Readonly<{ artifactId: string; versionId: string }>;

export type ArtifactVersionSummary = Readonly<{
  id: string; title: string; kind: ArtifactKind; versionNumber: number; entrypoint: string | null;
}>;
export type ArtifactPublicationSummary = Readonly<{
  id: string; versionId: string; status: "PENDING" | "READY" | "REVOKED"; expiresAt: string | null; createdAt: string;
}>;
export type ArtifactDetail = Readonly<{
  id: string; title: string; currentVersionId: string | null; sourceChatId: string | null;
  versions: readonly ArtifactVersionSummary[]; publications: readonly ArtifactPublicationSummary[];
}>;

export function decodeArtifactDetail(value: unknown): ArtifactDetail | null {
  if (!isRecord(value) || !validId(value.id) || typeof value.title !== "string" ||
    value.currentVersionId !== null && !validId(value.currentVersionId) || value.sourceChatId !== null && !validId(value.sourceChatId) ||
    !Array.isArray(value.versions) || !Array.isArray(value.publications)) return null;
  const versions: ArtifactVersionSummary[] = [];
  for (const version of value.versions) {
    if (!isRecord(version) || !validId(version.id) || typeof version.title !== "string" || !ARTIFACT_KINDS.includes(version.kind as ArtifactKind) ||
      !Number.isSafeInteger(version.versionNumber) || Number(version.versionNumber) < 1 ||
      version.entrypoint !== null && typeof version.entrypoint !== "string") return null;
    versions.push({ id: version.id, title: version.title, kind: version.kind as ArtifactKind, versionNumber: Number(version.versionNumber), entrypoint: version.entrypoint as string | null });
  }
  const publications: ArtifactPublicationSummary[] = [];
  for (const publication of value.publications) {
    if (!isRecord(publication) || !validId(publication.id) || !validId(publication.versionId) ||
      !["PENDING", "READY", "REVOKED"].includes(String(publication.status)) || typeof publication.createdAt !== "string" ||
      publication.expiresAt !== null && typeof publication.expiresAt !== "string") return null;
    publications.push({ id: publication.id, versionId: publication.versionId, status: publication.status as ArtifactPublicationSummary["status"],
      expiresAt: publication.expiresAt as string | null, createdAt: publication.createdAt });
  }
  return { id: value.id, title: value.title, currentVersionId: value.currentVersionId as string | null,
    sourceChatId: value.sourceChatId as string | null, versions, publications };
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

export type ArtifactOperation = Readonly<{
  baseVersionId?: string;
  entrypoint?: string;
  files: readonly (ArtifactAssetRef | ArtifactTextFile)[];
  intent: "create" | "update";
  kind: ArtifactKind;
  title: string;
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
}>;

export type ArtifactManifest = Readonly<{
  entrypoint: string | null;
  files: readonly ArtifactManifestFile[];
  kind: ArtifactKind;
  title: string;
  version: 1;
}>;

export class ArtifactContractError extends Error {
  constructor(readonly code: ArtifactContractErrorCode) {
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
  | "artifact_base_version_invalid";

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

function normalizedPath(value: unknown): string | null {
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
  const path = normalizedPath(value.path);
  const mimeType = normalizedMime(value.mimeType);
  if (!path) throw new ArtifactContractError("artifact_path_invalid");
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

export function normalizeArtifactOperation(value: unknown): NormalizedArtifactOperation {
  if (!isRecord(value) || Object.keys(value).some((key) => !["baseVersionId", "entrypoint", "files", "intent", "kind", "title"].includes(key))) throw new ArtifactContractError("artifact_operation_invalid");
  const kind = normalizedKind(value.kind);
  const title = cleanString(value.title, ARTIFACT_LIMITS.maxTitleBytes);
  if (!title?.trim()) throw new ArtifactContractError("artifact_title_invalid");
  if (value.intent !== "create" && value.intent !== "update") throw new ArtifactContractError("artifact_operation_invalid");
  if (value.intent === "update" && !validId(value.baseVersionId)) throw new ArtifactContractError("artifact_base_version_invalid");
  if (value.intent === "create" && value.baseVersionId !== undefined) throw new ArtifactContractError("artifact_base_version_invalid");
  if (!Array.isArray(value.files)) throw new ArtifactContractError("artifact_files_invalid");
  if (value.files.length < 1) throw new ArtifactContractError("artifact_files_invalid");
  if (value.files.length > ARTIFACT_LIMITS.maxFiles) throw new ArtifactContractError("artifact_file_count_exceeded");
  const files = value.files.map(normalizeFile);
  const paths = new Set<string>();
  let totalBytes = 0;
  for (const file of files) {
    if (paths.has(file.path)) throw new ArtifactContractError("artifact_path_duplicate");
    paths.add(file.path);
    totalBytes += file.byteSize;
  }
  if (totalBytes > ARTIFACT_LIMITS.maxBundleBytes) throw new ArtifactContractError("artifact_bundle_limit_exceeded");
  const rawEntrypoint = value.entrypoint;
  const entrypoint = rawEntrypoint === undefined || rawEntrypoint === null ? null : normalizedPath(rawEntrypoint);
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

export function artifactContentSecurityPolicy(): string {
  return "default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
    "img-src data: blob:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; " +
    "font-src data:; connect-src 'none'; child-src 'none'; object-src 'none'; worker-src 'none'";
}

export function isArtifactTextMime(mimeType: string): boolean {
  return TEXT_MIME_TYPES.has(mimeType.toLowerCase());
}
