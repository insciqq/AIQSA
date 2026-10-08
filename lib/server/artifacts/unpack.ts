import type { Buffer } from "node:buffer";
import { ARTIFACT_LIMITS, isArtifactTextMime, isReservedArtifactPath, normalizedArtifactPath, type NormalizedArtifactFile } from "@/lib/contracts/artifacts";
import { ArtifactToolError } from "./errors";
import { artifactTextFromBytes } from "./referencedFiles";
import { ARTIFACT_ZIP_LIMITS, ARTIFACT_ZIP_PATH_LIMITS, ArtifactZipError, readZipArchive, type ArtifactZipErrorCode } from "./zipReader";

const MIB = 1024 * 1024;
/** Skipped files named in a report; `skippedEntries` counts every one. */
export const ARTIFACT_UNPACK_SKIPPED_FILES = 20;

// Types follow the extension; content is never sniffed. Text types are checked
// as UTF-8 and stay editable; every other type is opaque bytes.
const EXTENSION_TYPES = new Map<string, string>([
  ["html", "text/html"], ["htm", "text/html"], ["css", "text/css"],
  ["js", "text/javascript"], ["mjs", "text/javascript"], ["cjs", "text/javascript"],
  ["json", "application/json"], ["txt", "text/plain"], ["md", "text/markdown"], ["csv", "text/csv"],
  ["svg", "image/svg+xml"], ["png", "image/png"], ["jpg", "image/jpeg"], ["jpeg", "image/jpeg"], ["webp", "image/webp"],
  ["gif", "image/gif"], ["ico", "image/x-icon"], ["avif", "image/avif"], ["bmp", "image/bmp"],
  ["woff", "font/woff"], ["woff2", "font/woff2"], ["ttf", "font/ttf"], ["otf", "font/otf"],
  ["mp3", "audio/mpeg"], ["wav", "audio/wav"], ["ogg", "audio/ogg"], ["m4a", "audio/mp4"],
  ["mp4", "video/mp4"], ["webm", "video/webm"], ["pdf", "application/pdf"],
  // Stored as bytes: the viewer's policy does not run WebAssembly.
  ["wasm", "application/wasm"], ["xml", "application/xml"]
]);

/** The type an unpacked file gets from its extension; an unknown one is opaque bytes. */
export function artifactMimeForPath(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? EXTENSION_TYPES.get(name.slice(dot + 1).toLowerCase()) : undefined) ?? "application/octet-stream";
}

const REZIP = "Create the archive again in the Workspace (zip -r site.zip . inside the site folder) and reference the new file.";
const ZIP_HINTS: ReadonlyMap<ArtifactZipErrorCode, string> = new Map<ArtifactZipErrorCode, string>([
  ["artifact_zip_invalid", `The file is not a readable ZIP archive or it is damaged. ${REZIP}`],
  ["artifact_zip_zip64_unsupported", `ZIP64 archives are unsupported. ${REZIP}`],
  ["artifact_zip_multidisk_unsupported", `Split (multi-part) archives are unsupported. ${REZIP}`],
  ["artifact_zip_empty", "The archive holds no site files (folders, macOS metadata, hidden files and empty binary files are skipped); zip the site's files themselves."],
  ["artifact_zip_compression_unsupported", `Only stored and deflate entries are supported. ${REZIP}`],
  ["artifact_zip_encrypted", `Encrypted archives are unsupported; zip the site again without a password. ${REZIP}`],
  ["artifact_zip_entry_limit_exceeded", `An unpacked site holds at most ${ARTIFACT_ZIP_LIMITS.maxEntries} files. Leave out what the pages do not use (sources, node_modules, .git, docs) or bundle scripts with esbuild in the Workspace, then zip the site again.`],
  ["artifact_zip_entry_too_large", `Each unpacked file may be at most ${ARTIFACT_ZIP_LIMITS.maxEntryBytes / MIB} MiB; compress it in the Workspace (ffmpeg for media) or leave it out, then zip the site again.`],
  ["artifact_zip_total_too_large", `Unpacked files may total at most ${ARTIFACT_ZIP_LIMITS.maxTotalBytes / MIB} MiB; compress or leave out large files, then zip the site again.`],
  ["artifact_zip_compression_ratio_exceeded", `This entry expands more than ${ARTIFACT_ZIP_LIMITS.maxCompressionRatio} times and is refused as a possible ZIP bomb; zip the site again without it.`],
  ["artifact_zip_size_mismatch", `The archive's declared sizes do not match its contents; it is damaged. ${REZIP}`],
  ["artifact_zip_crc_mismatch", `The archive's checksums do not match its contents; it is damaged. ${REZIP}`],
  ["artifact_zip_path_invalid", `The archive has an unsafe or malformed path (.., an absolute or drive path, a backslash or a control character). ${REZIP}`],
  ["artifact_zip_path_too_long", `Archive paths may take at most ${ARTIFACT_ZIP_PATH_LIMITS.maxNameBytes} bytes and ${ARTIFACT_ZIP_PATH_LIMITS.maxSegments} folder levels; ` +
    "leave out deep folders the pages do not use (node_modules, .git) or shorten the names, then zip the site again."],
  ["artifact_zip_symlink", "Symbolic links are unsupported; replace the link with the file itself and zip the site again (zip -r without -y)."],
  ["artifact_zip_duplicate_path", "The archive holds the same path twice, counting letter case and a file named like a folder; rename one and zip the site again."]
]);
const PATH_HINT = "Pages can reference only paths of ASCII letters, digits, '.', '_', '-' and '/' that start with a letter, digit or '_' and take at most " +
  `${ARTIFACT_LIMITS.maxPathBytes} bytes; names with spaces, '%', '#' or non-ASCII characters cannot be referenced. Rename the file and its references in the Workspace, then zip the site again.`;
const RESERVED_HINT = "_vendor is reserved for resources the server downloads; rename that folder and its references in the Workspace, then zip the site again.";
const TEXT_HINT = "This text file of the archive is not valid UTF-8. Convert it to UTF-8 in the Workspace (for example with iconv), then zip the site again.";

export type ArtifactUnpackReport = Readonly<{
  /** The single top-level folder removed from every path, if any. */
  rootFolder: string | null;
  /** Entries not unpacked: folders, macOS metadata, hidden files and empty binary files. */
  skippedEntries: number;
  /** Archive paths of the first skipped hidden or empty files. */
  skippedFiles: readonly string[];
}>;

export type UnpackedArtifactArchive = Readonly<{
  /** The archive's layer of the bundle: a reference per file, inline text for an empty text file. */
  files: readonly NormalizedArtifactFile[];
  /** Verified bytes behind each reference of `files`. */
  assets: ReadonlyMap<string, Readonly<{ bytes: Buffer; mimeType: string }>>;
  report: ArtifactUnpackReport;
}>;

/** A reader refusal as a tool error with a repair hint, naming the entry or else the archive's `label`; anything else is returned unchanged. */
export function artifactZipToolError(error: unknown, label: string): unknown {
  const hint = error instanceof ArtifactZipError ? ZIP_HINTS.get(error.code) : undefined;
  return hint ? new ArtifactToolError((error as ArtifactZipError).code, { path: (error as ArtifactZipError).path ?? label, hint }) : error;
}

/**
 * Unpack a verified archive into artifact files at the bundle root. The reader
 * bounds and checks the archive itself; this applies the artifact's own rules:
 * path grammar, the reserved namespace, types by extension and UTF-8 text.
 * Errors name the path inside the archive, or `label` for the whole archive.
 */
export async function unpackArtifactArchive(archive: Uint8Array, label: string, signal?: AbortSignal): Promise<UnpackedArtifactArchive> {
  let read: Awaited<ReturnType<typeof readZipArchive>>;
  try { read = await readZipArchive(archive, ARTIFACT_ZIP_LIMITS, signal); }
  catch (error) {
    // A stopped run ends like any other cancelled tool call, not as a model-visible refusal.
    if (error instanceof ArtifactZipError && error.code === "artifact_zip_aborted") signal?.throwIfAborted();
    throw artifactZipToolError(error, label);
  }
  const files: NormalizedArtifactFile[] = [];
  const assets = new Map<string, { bytes: Buffer; mimeType: string }>();
  const skippedFiles: string[] = [];
  let skippedEntries = read.skipped;
  const retained: Array<{ archivePath: string; path: string; bytes: Buffer; mimeType: string }> = [];
  for (const entry of read.entries) {
    const archivePath = read.strippedRoot === null ? entry.path : `${read.strippedRoot}/${entry.path}`;
    const mimeType = artifactMimeForPath(entry.path);
    // Hidden files and folders (.htaccess, .git, .nojekyll) are tooling metadata
    // no page shows; an empty file can be kept only as text.
    if (entry.path.split("/").some(part => part.startsWith(".")) || !entry.bytes.byteLength && !isArtifactTextMime(mimeType)) {
      skippedEntries++;
      if (skippedFiles.length < ARTIFACT_UNPACK_SKIPPED_FILES) skippedFiles.push(archivePath);
      continue;
    }
    retained.push({ archivePath, path: entry.path, bytes: entry.bytes, mimeType });
  }
  // A skipped file beside the site's folder (a root .gitignore) does not keep that folder.
  let rootFolder = read.strippedRoot;
  const first = retained[0]?.path.split("/")[0];
  if (rootFolder === null && first !== undefined && retained.every(entry => entry.path.startsWith(`${first}/`))) {
    rootFolder = first;
    for (const entry of retained) entry.path = entry.path.slice(first.length + 1);
  }
  for (const { archivePath, path, bytes, mimeType } of retained) {
    if (normalizedArtifactPath(path) !== path) throw new ArtifactToolError("artifact_zip_path_unsupported", { path: archivePath, hint: PATH_HINT });
    if (isReservedArtifactPath(path)) throw new ArtifactToolError("artifact_zip_path_unsupported", { path: archivePath, hint: RESERVED_HINT });
    if (isArtifactTextMime(mimeType)) {
      try { artifactTextFromBytes(bytes, path); }
      catch (error) {
        if (error instanceof ArtifactToolError) throw new ArtifactToolError(error.code, { path: archivePath, hint: TEXT_HINT });
        throw error;
      }
    }
    if (!bytes.byteLength) { files.push({ path, mimeType, text: "", byteSize: 0 }); continue; }
    // Local keys of this operation: the bytes are already verified and read.
    const assetRef = `archive:${assets.size}`;
    assets.set(assetRef, { bytes, mimeType });
    files.push({ assetRef, byteSize: 0, mimeType, path });
  }
  if (!files.length) throw new ArtifactToolError("artifact_zip_empty", { path: label, hint: ZIP_HINTS.get("artifact_zip_empty")! });
  return { files, assets, report: { rootFolder, skippedEntries, skippedFiles } };
}
