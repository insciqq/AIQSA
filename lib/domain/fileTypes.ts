import { UPLOAD_FORMAT_REGISTRY } from "./uploadFormats";

/** Types for files the server names itself (Workspace outputs, unpacked archives); never sniffed. */
const WEB_AND_MEDIA_TYPES: ReadonlyArray<readonly [string, string]> = [
  ["css", "text/css"], ["js", "text/javascript"], ["mjs", "text/javascript"], ["cjs", "text/javascript"],
  ["svg", "image/svg+xml"], ["avif", "image/avif"], ["ico", "image/x-icon"],
  ["woff", "font/woff"], ["woff2", "font/woff2"], ["ttf", "font/ttf"], ["otf", "font/otf"],
  ["mp3", "audio/mpeg"], ["wav", "audio/wav"], ["ogg", "audio/ogg"], ["m4a", "audio/mp4"], ["flac", "audio/flac"], ["aac", "audio/aac"],
  ["mp4", "video/mp4"], ["webm", "video/webm"], ["mov", "video/quicktime"],
  ["wasm", "application/wasm"], ["xml", "application/xml"],
  ["zip", "application/zip"], ["gz", "application/gzip"], ["tgz", "application/gzip"], ["tar", "application/x-tar"],
  ["sqlite", "application/vnd.sqlite3"], ["sqlite3", "application/vnd.sqlite3"], ["db", "application/vnd.sqlite3"]
];

// Upload formats keep their canonical type, so an output reads like the same file uploaded.
const EXTENSION_TYPES: ReadonlyMap<string, string> = new Map([
  ...WEB_AND_MEDIA_TYPES,
  ...UPLOAD_FORMAT_REGISTRY.flatMap(format => format.extensions.map(extension => [extension.slice(1), format.canonicalMimeType] as const))
]);

/**
 * The MIME type of a file from the extension of its last path segment, case-insensitively;
 * a name without one, or an unknown one, is opaque bytes.
 */
export function mimeTypeForFileName(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? EXTENSION_TYPES.get(name.slice(dot + 1).toLowerCase()) : undefined) ?? "application/octet-stream";
}
