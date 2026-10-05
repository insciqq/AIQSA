/**
 * Browser-side archive access for chat import. Exports never pass through
 * upload limits: the import worker reads the user's own file locally and
 * keeps only the entries a converter asks for, under the bounds below.
 */
export type ImportArchiveErrorCode =
  /** Not a readable zip or tar.gz container. */
  | "archive_invalid"
  /** Encrypted, multi-disk or unsupported compression. */
  | "archive_unsupported"
  | "archive_too_many_entries"
  /** The archive's total uncompressed bytes exceed the budget. */
  | "archive_too_large"
  /** An entry or stream expands beyond the compression-ratio guard (zip bomb). */
  | "archive_ratio_exceeded"
  /** Size or checksum mismatch, truncated or corrupt compressed data. */
  | "archive_entry_damaged"
  /** This browser cannot decompress the format. */
  | "archive_browser_unsupported";

export class ImportArchiveError extends Error {
  constructor(readonly code: ImportArchiveErrorCode) {
    super(code);
    this.name = "ImportArchiveError";
  }
}

export type ImportArchiveLimits = Readonly<{
  /** Entries in a zip's central directory or headers in a tar stream. */
  maxEntries: number;
  /** Uncompressed bytes the archive may produce across all reads. */
  maxTotalBytes: number;
  /** Uncompressed to compressed size, checked past `ratioGraceBytes`. */
  maxRatio: number;
  ratioGraceBytes: number;
}>;

export const DEFAULT_IMPORT_ARCHIVE_LIMITS: ImportArchiveLimits = Object.freeze({
  maxEntries: 250_000,
  maxTotalBytes: 2 * 1_024 * 1_024 * 1_024,
  maxRatio: 200,
  ratioGraceBytes: 1_024 * 1_024
});

/** An archive entry as listed, with its declared uncompressed size. */
export type ImportArchiveEntryInfo = Readonly<{ path: string; size: number }>;

/** How much of a selected entry to read: all of it up to `maxBytes`, or only its first `maxBytes` with `prefix`. */
export type ImportEntryRead = Readonly<{ maxBytes: number; prefix?: boolean }>;

export type ImportArchiveEntry =
  | Readonly<{ kind: "data"; path: string; size: number; bytes: Uint8Array; truncated: boolean }>
  /** Selected without `prefix` but larger than its `maxBytes`; nothing was read. */
  | Readonly<{ kind: "too_large"; path: string; size: number }>;

export type ImportEntrySelector = (entry: ImportArchiveEntryInfo) => ImportEntryRead | null;

export interface ImportArchive {
  readonly format: "tar.gz" | "zip";
  /**
   * The entries `select` keeps, in archive order, reading nothing else into
   * memory. A zip inflates only the selected entries; a tar.gz decompresses
   * its stream once per call and keeps only the selected entries' bytes.
   * Leaving the loop early stops reading.
   */
  entries(select: ImportEntrySelector): AsyncIterable<ImportArchiveEntry>;
}

/** Archive paths as converters match them: forward slashes, no leading `./`. */
export function normalizeArchivePath(path: string): string {
  let normalized = path.replace(/\\/gu, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

/** Shared uncompressed-byte budget of one opened archive. */
export class ArchiveByteBudget {
  private consumed = 0;

  constructor(private readonly limits: ImportArchiveLimits) {}

  /** Refuses before a read that could pass the budget. */
  ensure(bytes: number): void {
    if (this.consumed + bytes > this.limits.maxTotalBytes) throw new ImportArchiveError("archive_too_large");
  }

  add(bytes: number): void {
    this.consumed += bytes;
    if (this.consumed > this.limits.maxTotalBytes) throw new ImportArchiveError("archive_too_large");
  }
}

/** A DecompressionStream for the format, or the browser-unsupported refusal. */
export function decompressionStream(format: "deflate-raw" | "gzip"): DecompressionStream {
  try {
    return new DecompressionStream(format);
  } catch {
    throw new ImportArchiveError("archive_browser_unsupported");
  }
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

/** Incremental ZIP CRC-32: start from 0 and feed chunks in order. */
export function crc32Update(crc: number, bytes: Uint8Array): number {
  let value = (crc ^ 0xffffffff) >>> 0;
  for (let index = 0; index < bytes.length; index += 1) {
    value = CRC_TABLE[(value ^ bytes[index]!) & 0xff]! ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}
