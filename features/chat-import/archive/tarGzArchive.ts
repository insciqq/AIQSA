import {
  ArchiveByteBudget,
  decompressionStream,
  DEFAULT_IMPORT_ARCHIVE_LIMITS,
  ImportArchiveError,
  normalizeArchivePath,
  type ImportArchive,
  type ImportArchiveEntry,
  type ImportArchiveLimits,
  type ImportEntrySelector
} from "./archiveTypes";

const BLOCK = 512;
/** Extended-header and long-name records are metadata, never content. */
const MAX_METADATA_BYTES = 1_024 * 1_024;
const utf8 = new TextDecoder("utf-8");

/**
 * Pulls exact byte counts out of the decompressed tar stream while
 * enforcing the uncompressed budget and the compression-ratio guard against
 * the compressed bytes consumed so far.
 */
class TarStreamReader {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private buffered: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private decompressed = 0;

  constructor(
    stream: ReadableStream<Uint8Array>,
    private readonly compressed: () => number,
    private readonly limits: ImportArchiveLimits,
    private readonly budget: ArchiveByteBudget
  ) {
    this.reader = stream.getReader();
  }

  /** Replaces the consumed buffer with the next chunk; false at the end of the stream. */
  private async fill(): Promise<boolean> {
    let next: ReadableStreamReadResult<Uint8Array>;
    try {
      next = await this.reader.read();
    } catch {
      throw new ImportArchiveError("archive_entry_damaged");
    }
    if (next.done) return false;
    this.decompressed += next.value.byteLength;
    this.budget.add(next.value.byteLength);
    if (this.decompressed > this.limits.ratioGraceBytes &&
      this.decompressed > Math.max(1, this.compressed()) * this.limits.maxRatio) {
      throw new ImportArchiveError("archive_ratio_exceeded");
    }
    this.buffered = next.value;
    this.offset = 0;
    return true;
  }

  /** Exactly `length` bytes, or null at a clean end of stream before any of them. */
  async take(length: number): Promise<Uint8Array | null> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      if (this.offset >= this.buffered.byteLength && !(await this.fill())) {
        if (written === 0) return null;
        throw new ImportArchiveError("archive_entry_damaged");
      }
      const count = Math.min(length - written, this.buffered.byteLength - this.offset);
      output.set(this.buffered.subarray(this.offset, this.offset + count), written);
      this.offset += count;
      written += count;
    }
    return output;
  }

  /** Discards `length` bytes without keeping them. */
  async skip(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (this.offset >= this.buffered.byteLength && !(await this.fill())) {
        throw new ImportArchiveError("archive_entry_damaged");
      }
      const count = Math.min(remaining, this.buffered.byteLength - this.offset);
      this.offset += count;
      remaining -= count;
    }
  }

  async cancel(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }
}

function padded(size: number): number {
  return Math.ceil(size / BLOCK) * BLOCK;
}

function field(header: Uint8Array, start: number, length: number): string {
  const bytes = header.subarray(start, start + length);
  const end = bytes.indexOf(0);
  return utf8.decode(end < 0 ? bytes : bytes.subarray(0, end));
}

/** Octal, or GNU base-256 for large values. */
function numeric(header: Uint8Array, start: number, length: number): number {
  const bytes = header.subarray(start, start + length);
  if (bytes[0]! & 0x80) {
    let value = bytes[0]! & 0x7f;
    for (let index = 1; index < bytes.length; index += 1) {
      value = value * 256 + bytes[index]!;
      if (!Number.isSafeInteger(value)) throw new ImportArchiveError("archive_invalid");
    }
    return value;
  }
  const text = field(header, start, length).trim();
  if (!/^[0-7]*$/u.test(text)) throw new ImportArchiveError("archive_invalid");
  const value = text ? Number.parseInt(text, 8) : 0;
  if (!Number.isSafeInteger(value)) throw new ImportArchiveError("archive_invalid");
  return value;
}

function checksumValid(header: Uint8Array): boolean {
  const recorded = numeric(header, 148, 8);
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 0x20 : header[index]!;
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  return recorded === unsigned || recorded === signed;
}

/** The `path` record of a pax extended header, if any. */
function paxPath(data: Uint8Array): string | null {
  const text = utf8.decode(data);
  let path: string | null = null;
  let cursor = 0;
  while (cursor < text.length) {
    const space = text.indexOf(" ", cursor);
    if (space < 0) break;
    const length = Number.parseInt(text.slice(cursor, space), 10);
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = text.slice(space + 1, cursor + length - 1);
    const equals = record.indexOf("=");
    if (equals > 0 && record.slice(0, equals) === "path") path = record.slice(equals + 1);
    cursor += length;
  }
  return path;
}

async function* tarEntries(
  blob: Blob,
  select: ImportEntrySelector,
  limits: ImportArchiveLimits,
  budget: ArchiveByteBudget
): AsyncGenerator<ImportArchiveEntry> {
  let compressed = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      compressed += chunk.byteLength;
      controller.enqueue(chunk);
    }
  });
  const stream = blob.stream().pipeThrough(counter).pipeThrough(decompressionStream("gzip"));
  const reader = new TarStreamReader(stream, () => compressed, limits, budget);
  let headers = 0;
  let nextPath: string | null = null;
  try {
    for (;;) {
      const header = await reader.take(BLOCK);
      // A stream that ends on a block boundary without the end marker is still a whole archive.
      if (!header || header.every((byte) => byte === 0)) return;
      headers += 1;
      if (headers > limits.maxEntries) throw new ImportArchiveError("archive_too_many_entries");
      if (!checksumValid(header)) throw new ImportArchiveError("archive_invalid");
      const size = numeric(header, 124, 12);
      const type = String.fromCharCode(header[156]!);
      if (type === "x" || type === "L") {
        if (size > MAX_METADATA_BYTES) throw new ImportArchiveError("archive_invalid");
        const data = await reader.take(padded(size));
        if (!data) throw new ImportArchiveError("archive_entry_damaged");
        const value = type === "x" ? paxPath(data.subarray(0, size)) : field(data, 0, size);
        if (value !== null) nextPath = value;
        continue;
      }
      const prefix = field(header, 345, 155);
      const name = field(header, 0, 100);
      const path = normalizeArchivePath(nextPath ?? (prefix ? `${prefix}/${name}` : name));
      nextPath = null;
      // Regular files only; directories, links, devices and global headers are skipped unread.
      const regular = type === "0" || type === "\0" || type === "7";
      const read = regular && path && !path.endsWith("/") ? select({ path, size }) : null;
      if (!read) {
        await reader.skip(padded(size));
        continue;
      }
      if (!read.prefix && size > read.maxBytes) {
        await reader.skip(padded(size));
        yield { kind: "too_large", path, size };
        continue;
      }
      const wanted = Math.min(size, read.maxBytes);
      const bytes = wanted > 0 ? await reader.take(wanted) : new Uint8Array(0);
      if (!bytes) throw new ImportArchiveError("archive_entry_damaged");
      await reader.skip(padded(size) - wanted);
      yield { bytes, kind: "data", path, size, truncated: wanted < size };
    }
  } finally {
    await reader.cancel();
  }
}

/**
 * Opens a gzip-compressed tar for streaming reads. Each `entries` call
 * decompresses the stream from the start in one pass and keeps only the
 * selected entries; every decompressed byte counts against the budget and
 * the compression ratio is checked as the stream advances.
 */
export function openTarGzArchive(
  blob: Blob,
  limits: ImportArchiveLimits = DEFAULT_IMPORT_ARCHIVE_LIMITS
): ImportArchive {
  const budget = new ArchiveByteBudget(limits);
  return {
    format: "tar.gz",
    entries: (select) => tarEntries(blob, select, limits, budget)
  };
}
