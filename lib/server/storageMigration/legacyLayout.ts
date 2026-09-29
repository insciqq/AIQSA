import { lstat, opendir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import { StorageMigrationError } from "./marker";

// The bundled MinIO release pinned by every AIQSA v0.2.x Compose file stores a
// single-drive `xl-single` layout: `.minio.sys/format.json` plus one directory
// per object under the bucket directory, each holding an `xl.meta` file.
const FORMAT_FILE = [".minio.sys", "format.json"];
const IGNORED_ROOT_ENTRIES = new Set(["lost+found"]);
const FORMAT_MAX_BYTES = 64 * 1_024;

export type LegacyLayout =
  | Readonly<{ kind: "empty" }>
  | Readonly<{ kind: "minio"; hasObjects: boolean }>;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
}

async function rootEntries(root: string): Promise<string[] | null> {
  try {
    const entries: string[] = [];
    for await (const entry of await opendir(root)) {
      if (!IGNORED_ROOT_ENTRIES.has(entry.name)) entries.push(entry.name);
    }
    return entries;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function minioFormat(root: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    const path = join(root, ...FORMAT_FILE);
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size > FORMAT_MAX_BYTES) return false;
    bytes = await readFile(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw error;
  }
  try {
    const format = JSON.parse(bytes.toString("utf8")) as { format?: unknown; version?: unknown };
    return format.version === "1" && format.format === "xl-single";
  } catch {
    return false;
  }
}

/** Depth-first search for any object metadata file; stops at the first one. */
async function containsObject(directory: string, signal?: AbortSignal): Promise<boolean> {
  const pending = [directory];
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const current = pending.pop()!;
    let handle;
    try {
      handle = await opendir(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    // Leaving the loop early closes the directory handle.
    for await (const entry of handle) {
      if (entry.isFile() && entry.name === "xl.meta") return true;
      if (entry.isDirectory()) pending.push(join(current, entry.name));
    }
  }
  return false;
}

/**
 * Classifies a read-only legacy data directory. Anything that is neither
 * empty nor the known MinIO layout is refused rather than guessed.
 */
export async function inspectLegacyLayout(
  root: string,
  bucket: string,
  signal?: AbortSignal
): Promise<LegacyLayout> {
  const entries = await rootEntries(root);
  if (!entries || entries.length === 0) return { kind: "empty" };
  if (!entries.includes(".minio.sys") || !await minioFormat(root)) {
    throw new StorageMigrationError("storage_legacy_layout_unknown");
  }
  if (!entries.includes(bucket)) return { hasObjects: false, kind: "minio" };
  const bucketPath = join(root, bucket);
  const metadata = await lstat(bucketPath);
  if (!metadata.isDirectory()) throw new StorageMigrationError("storage_legacy_layout_unknown");
  return { hasObjects: await containsObject(bucketPath, signal), kind: "minio" };
}

export type LegacyUsage = Readonly<{ bytes: number; files: number }>;

/** Total apparent size of every regular file below root, without reading data. */
export async function measureLegacyUsage(root: string, signal?: AbortSignal): Promise<LegacyUsage> {
  const pending = [root];
  let bytes = 0;
  let files = 0;
  while (pending.length > 0) {
    signal?.throwIfAborted();
    const current = pending.pop()!;
    for await (const entry of await opendir(current)) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) {
        bytes += (await lstat(path)).size;
        files += 1;
      }
    }
  }
  return { bytes, files };
}

export async function availableBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}
