import { inflateRaw } from "node:zlib";
import { crc32 } from "../../domain/crc32";

export type ZipReadLimits = {
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalBytes: number;
  maxCompressionRatio: number;
  ratioFloorBytes: number;
};

export const ARTIFACT_ZIP_LIMITS: ZipReadLimits = Object.freeze({
  maxEntries: 500,
  maxEntryBytes: 24 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioFloorBytes: 1024 * 1024
});

export type ZipEntry = { path: string; bytes: Buffer };
export type ArtifactZipErrorCode =
  | "artifact_zip_invalid"
  | "artifact_zip_zip64_unsupported"
  | "artifact_zip_multidisk_unsupported"
  | "artifact_zip_empty"
  | "artifact_zip_compression_unsupported"
  | "artifact_zip_encrypted"
  | "artifact_zip_entry_limit_exceeded"
  | "artifact_zip_entry_too_large"
  | "artifact_zip_total_too_large"
  | "artifact_zip_compression_ratio_exceeded"
  | "artifact_zip_size_mismatch"
  | "artifact_zip_crc_mismatch"
  | "artifact_zip_path_invalid"
  | "artifact_zip_symlink"
  | "artifact_zip_duplicate_path"
  | "artifact_zip_aborted"
  | "artifact_zip_limits_invalid";

/** Messages contain only stable codes; paths are separate, untrusted metadata. */
export class ArtifactZipError extends Error {
  constructor(readonly code: ArtifactZipErrorCode, readonly path?: string) {
    super(code);
    this.name = "ArtifactZipError";
  }
}

function refuse(code: ArtifactZipErrorCode = "artifact_zip_invalid", path?: string): never {
  throw new ArtifactZipError(code, path);
}

function checkAbort(signal?: AbortSignal, path?: string): void {
  if (signal?.aborted) refuse("artifact_zip_aborted", path);
}

function checkLimits(limits: ZipReadLimits): void {
  for (const value of [limits.maxEntries, limits.maxEntryBytes, limits.maxTotalBytes, limits.ratioFloorBytes]) {
    if (!Number.isSafeInteger(value) || value < 0) refuse("artifact_zip_limits_invalid");
  }
  if (limits.maxEntries < 1 || !Number.isFinite(limits.maxCompressionRatio) || limits.maxCompressionRatio <= 0) {
    refuse("artifact_zip_limits_invalid");
  }
}

function checkExtra(bytes: Buffer, path: string): void {
  for (let cursor = 0; cursor < bytes.length;) {
    if (cursor + 4 > bytes.length) refuse("artifact_zip_invalid", path);
    const id = bytes.readUInt16LE(cursor);
    const length = bytes.readUInt16LE(cursor + 2);
    if (id === 0x0001) refuse("artifact_zip_zip64_unsupported", path);
    cursor += 4 + length;
    if (cursor > bytes.length) refuse("artifact_zip_invalid", path);
  }
}

function decodePath(bytes: Buffer, flags: number): string {
  if (bytes.length === 0 || bytes.length > 512) refuse("artifact_zip_path_invalid");
  let path: string;
  if (flags & 0x0800) {
    try {
      path = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      refuse("artifact_zip_path_invalid");
    }
  } else {
    if (bytes.some(byte => byte < 0x20 || byte > 0x7e)) refuse("artifact_zip_path_invalid");
    path = bytes.toString("ascii");
  }
  const parts = (path.endsWith("/") ? path.slice(0, -1) : path).split("/");
  // Check every segment so stripping a wrapper folder cannot expose a drive path.
  if (path.includes("\\") || [...path].some(char => {
    const code = char.codePointAt(0)!;
    return code < 0x20 || (code >= 0x7f && code <= 0x9f);
  }) || parts.some(part => !part || part === "." || part === ".." || /^[a-z]:/iu.test(part))) {
    refuse("artifact_zip_path_invalid", path);
  }
  return path;
}

type DeclaredEntry = {
  path: string;
  method: number;
  crc: number;
  packed: number;
  unpacked: number;
  dataStart: number;
};

function inflateEntry(data: Buffer, entry: DeclaredEntry): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    inflateRaw(data, { maxOutputLength: entry.unpacked + 1 }, (error, bytes) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code === "ERR_BUFFER_TOO_LARGE"
          ? "artifact_zip_size_mismatch" : "artifact_zip_invalid";
        reject(new ArtifactZipError(code, entry.path));
      } else resolve(bytes);
    });
  });
}

/** In-memory ZIP validation only. Callers own upload bounds and artifact-specific policy. */
export async function readZipArchive(
  archive: Uint8Array,
  limits: ZipReadLimits = ARTIFACT_ZIP_LIMITS,
  signal?: AbortSignal
): Promise<{ entries: ZipEntry[]; strippedRoot: string | null; skipped: number }> {
  checkAbort(signal);
  checkLimits(limits);
  const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
  let end = -1;
  for (let cursor = bytes.length - 22; cursor >= Math.max(0, bytes.length - 65_557); cursor--) {
    if (bytes.readUInt32LE(cursor) === 0x06054b50 && cursor + 22 + bytes.readUInt16LE(cursor + 20) === bytes.length) {
      end = cursor;
      break;
    }
  }
  if (end < 0) refuse();
  const disk = bytes.readUInt16LE(end + 4);
  const directoryDisk = bytes.readUInt16LE(end + 6);
  const diskCount = bytes.readUInt16LE(end + 8);
  const count = bytes.readUInt16LE(end + 10);
  const directorySize = bytes.readUInt32LE(end + 12);
  const directoryStart = bytes.readUInt32LE(end + 16);
  if ([disk, directoryDisk, diskCount, count].includes(0xffff) || directorySize === 0xffffffff || directoryStart === 0xffffffff ||
    (end >= 20 && bytes.readUInt32LE(end - 20) === 0x07064b50)) refuse("artifact_zip_zip64_unsupported");
  if (disk !== 0 || directoryDisk !== 0 || diskCount !== count) refuse("artifact_zip_multidisk_unsupported");
  if (directoryStart + directorySize !== end) refuse();
  if (count > limits.maxEntries * 4) refuse("artifact_zip_entry_limit_exceeded");

  const declared: DeclaredEntry[] = [];
  const ranges: { start: number; end: number; path: string }[] = [];
  const seen = new Set<string>();
  const files = new Set<string>();
  const directories = new Set<string>();
  let cursor = directoryStart;
  let total = 0;
  let skipped = 0;
  for (let index = 0; index < count; index++) {
    checkAbort(signal);
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) refuse();
    const host = bytes.readUInt16LE(cursor + 4) >>> 8;
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const crc = bytes.readUInt32LE(cursor + 16);
    const packed = bytes.readUInt32LE(cursor + 20);
    const unpacked = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const entryDisk = bytes.readUInt16LE(cursor + 34);
    const attributes = bytes.readUInt32LE(cursor + 38);
    const local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end) refuse();
    const name = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    const path = decodePath(name, flags);
    if (packed === 0xffffffff || unpacked === 0xffffffff || local === 0xffffffff || entryDisk === 0xffff) {
      refuse("artifact_zip_zip64_unsupported", path);
    }
    if (entryDisk !== 0) refuse("artifact_zip_multidisk_unsupported", path);
    if (flags & (1 | 0x40 | 0x2000)) refuse("artifact_zip_encrypted", path);
    if (method !== 0 && method !== 8) refuse("artifact_zip_compression_unsupported", path);
    if (host === 3 && ((attributes >>> 16) & 0xf000) === 0xa000) refuse("artifact_zip_symlink", path);
    checkExtra(bytes.subarray(cursor + 46 + nameLength, next - commentLength), path);
    cursor = next;

    if (local + 30 > directoryStart || bytes.readUInt32LE(local) !== 0x04034b50) refuse("artifact_zip_invalid", path);
    if (bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 26) !== nameLength) refuse("artifact_zip_invalid", path);
    const dataStart = local + 30 + nameLength + bytes.readUInt16LE(local + 28);
    const dataEnd = dataStart + packed;
    if (dataEnd > directoryStart || !bytes.subarray(local + 30, local + 30 + nameLength).equals(name)) {
      refuse("artifact_zip_invalid", path);
    }
    if (bytes.readUInt32LE(local + 18) === 0xffffffff || bytes.readUInt32LE(local + 22) === 0xffffffff) {
      refuse("artifact_zip_zip64_unsupported", path);
    }
    checkExtra(bytes.subarray(local + 30 + nameLength, dataStart), path);
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== crc || bytes.readUInt32LE(local + 18) !== packed ||
      bytes.readUInt32LE(local + 22) !== unpacked)) refuse("artifact_zip_invalid", path);
    let rangeEnd = dataEnd;
    if (flags & 8) {
      // Descriptors have an optional signature. Compare both forms, including the
      // rare case where a signatureless descriptor's CRC equals that signature.
      const descriptor = [dataEnd, dataEnd + 4].find(start => start + 12 <= directoryStart &&
        (start === dataEnd || bytes.readUInt32LE(dataEnd) === 0x08074b50) &&
        bytes.readUInt32LE(start) === crc && bytes.readUInt32LE(start + 4) === packed && bytes.readUInt32LE(start + 8) === unpacked);
      if (descriptor === undefined) refuse("artifact_zip_invalid", path);
      rangeEnd = descriptor + 12;
    }
    ranges.push({ start: local, end: rangeEnd, path });
    if (method === 0 && packed !== unpacked) refuse("artifact_zip_size_mismatch", path);

    const directory = path.endsWith("/");
    const parts = (directory ? path.slice(0, -1) : path).split("/");
    const folded = parts.join("/").toLowerCase();
    if (seen.has(folded) || (!directory && directories.has(folded))) refuse("artifact_zip_duplicate_path", path);
    for (let depth = 1; depth < parts.length; depth++) {
      const prefix = parts.slice(0, depth).join("/").toLowerCase();
      if (files.has(prefix)) refuse("artifact_zip_duplicate_path", path);
      directories.add(prefix);
    }
    seen.add(folded);
    (directory ? directories : files).add(folded);
    const basename = parts[parts.length - 1]!;
    if (directory || parts.slice(0, -1).includes("__MACOSX") || basename === ".DS_Store" || basename.startsWith("._")) {
      skipped++;
      continue;
    }
    if (declared.length >= limits.maxEntries) refuse("artifact_zip_entry_limit_exceeded", path);
    if (unpacked > limits.maxEntryBytes) refuse("artifact_zip_entry_too_large", path);
    total += unpacked;
    if (total > limits.maxTotalBytes) refuse("artifact_zip_total_too_large", path);
    if (unpacked > limits.ratioFloorBytes && (packed === 0 || unpacked / packed > limits.maxCompressionRatio)) {
      refuse("artifact_zip_compression_ratio_exceeded", path);
    }
    declared.push({ path, method, crc, packed, unpacked, dataStart });
  }
  if (cursor !== end) refuse();
  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index++) {
    if (ranges[index - 1]!.end > ranges[index]!.start) refuse("artifact_zip_invalid", ranges[index]!.path);
  }
  if (declared.length === 0) refuse("artifact_zip_empty");
  const firstRoot = declared[0]!.path.split("/")[0]!;
  const strippedRoot = declared.every(entry => entry.path.startsWith(`${firstRoot}/`)) ? firstRoot : null;
  const entries: ZipEntry[] = [];
  for (const entry of declared) {
    checkAbort(signal, entry.path);
    const data = bytes.subarray(entry.dataStart, entry.dataStart + entry.packed);
    const content = entry.method === 0 ? Buffer.from(data) : await inflateEntry(data, entry);
    checkAbort(signal, entry.path);
    if (content.length !== entry.unpacked) refuse("artifact_zip_size_mismatch", entry.path);
    if (crc32(content) !== entry.crc) refuse("artifact_zip_crc_mismatch", entry.path);
    entries.push({ path: strippedRoot === null ? entry.path : entry.path.slice(strippedRoot.length + 1), bytes: content });
  }
  entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  return { entries, strippedRoot, skipped };
}
