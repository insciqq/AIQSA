import {
  ArchiveByteBudget,
  crc32Update,
  decompressionStream,
  DEFAULT_IMPORT_ARCHIVE_LIMITS,
  ImportArchiveError,
  normalizeArchivePath,
  type ImportArchive,
  type ImportArchiveEntry,
  type ImportArchiveLimits,
  type ImportEntryRead,
  type ImportEntrySelector
} from "./archiveTypes";

const EOCD_SIGNATURE = 0x06054b50;
const ZIP64_LOCATOR_SIGNATURE = 0x07064b50;
const ZIP64_EOCD_SIGNATURE = 0x06064b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_BYTES = 22;
const MAX_COMMENT_BYTES = 0xffff;
const ZIP64_LOCATOR_BYTES = 20;
const ZIP64_EOCD_BYTES = 56;
const CENTRAL_HEADER_BYTES = 46;
const LOCAL_HEADER_BYTES = 30;
/** Bounds the central directory read before any entry is parsed. */
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1_024 * 1_024;
/** Encrypted, strongly encrypted or masked-header entries. */
const UNSUPPORTED_FLAGS = 0x1 | 0x40 | 0x2000;

type ZipEntry = Readonly<{
  compressedSize: number;
  crc: number;
  flags: number;
  localOffset: number;
  method: number;
  path: string;
  size: number;
}>;

function invalid(): never {
  throw new ImportArchiveError("archive_invalid");
}

async function readBytes(blob: Blob, start: number, end: number): Promise<DataView> {
  if (start < 0 || end > blob.size || start > end) invalid();
  return new DataView(await blob.slice(start, end).arrayBuffer());
}

function safeUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) invalid();
  return Number(value);
}

type CentralDirectory = Readonly<{ count: number; offset: number; size: number; end: number }>;

/** Locates the (ZIP64) end of central directory; trailing bytes after the comment are refused. */
async function centralDirectory(blob: Blob, limits: ImportArchiveLimits): Promise<CentralDirectory> {
  if (blob.size < EOCD_BYTES) invalid();
  const tailStart = Math.max(0, blob.size - EOCD_BYTES - MAX_COMMENT_BYTES);
  const tail = await readBytes(blob, tailStart, blob.size);
  let eocd = -1;
  for (let index = tail.byteLength - EOCD_BYTES; index >= 0; index -= 1) {
    if (tail.getUint32(index, true) === EOCD_SIGNATURE &&
      index + EOCD_BYTES + tail.getUint16(index + 20, true) === tail.byteLength) {
      eocd = index;
      break;
    }
  }
  if (eocd < 0) invalid();
  const eocdOffset = tailStart + eocd;
  const disk = tail.getUint16(eocd + 4, true);
  const centralDisk = tail.getUint16(eocd + 6, true);
  const diskEntries = tail.getUint16(eocd + 8, true);
  let count = tail.getUint16(eocd + 10, true);
  let size = tail.getUint32(eocd + 12, true);
  let offset = tail.getUint32(eocd + 16, true);
  let end = eocdOffset;
  const zip64 = count === 0xffff || size === 0xffffffff || offset === 0xffffffff;
  if (zip64) {
    if (eocdOffset < ZIP64_LOCATOR_BYTES) invalid();
    const locator = await readBytes(blob, eocdOffset - ZIP64_LOCATOR_BYTES, eocdOffset);
    if (locator.getUint32(0, true) !== ZIP64_LOCATOR_SIGNATURE) invalid();
    if (locator.getUint32(4, true) !== 0 || locator.getUint32(16, true) > 1) {
      throw new ImportArchiveError("archive_unsupported");
    }
    const recordOffset = safeUint64(locator, 8);
    if (recordOffset + ZIP64_EOCD_BYTES > eocdOffset - ZIP64_LOCATOR_BYTES) invalid();
    const record = await readBytes(blob, recordOffset, recordOffset + ZIP64_EOCD_BYTES);
    if (record.getUint32(0, true) !== ZIP64_EOCD_SIGNATURE) invalid();
    if (record.getUint32(16, true) !== 0 || record.getUint32(20, true) !== 0) {
      throw new ImportArchiveError("archive_unsupported");
    }
    const total = safeUint64(record, 32);
    if (safeUint64(record, 24) !== total) throw new ImportArchiveError("archive_unsupported");
    count = total;
    size = safeUint64(record, 40);
    offset = safeUint64(record, 48);
    end = recordOffset;
  } else if (disk !== 0 || centralDisk !== 0 || diskEntries !== count) {
    throw new ImportArchiveError("archive_unsupported");
  }
  if (count > limits.maxEntries) throw new ImportArchiveError("archive_too_many_entries");
  if (size > MAX_CENTRAL_DIRECTORY_BYTES) throw new ImportArchiveError("archive_too_many_entries");
  if (offset + size > end || count * CENTRAL_HEADER_BYTES > size) invalid();
  return { count, end, offset, size };
}

/** The ZIP64 extended-information fields present for the saturated fixed fields. */
function zip64Extra(
  extra: DataView,
  needs: Readonly<{ size: boolean; compressedSize: boolean; localOffset: boolean }>
): Partial<Record<"compressedSize" | "localOffset" | "size", number>> {
  for (let cursor = 0; cursor + 4 <= extra.byteLength;) {
    const id = extra.getUint16(cursor, true);
    const length = extra.getUint16(cursor + 2, true);
    if (cursor + 4 + length > extra.byteLength) invalid();
    if (id === 0x0001) {
      const values: Partial<Record<"compressedSize" | "localOffset" | "size", number>> = {};
      let field = cursor + 4;
      for (const key of ["size", "compressedSize", "localOffset"] as const) {
        if (!needs[key]) continue;
        if (field + 8 > cursor + 4 + length) invalid();
        values[key] = safeUint64(extra, field);
        field += 8;
      }
      return values;
    }
    cursor += 4 + length;
  }
  return {};
}

function parseEntries(view: DataView, directory: CentralDirectory): ZipEntry[] {
  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  let cursor = 0;
  for (let index = 0; index < directory.count; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > view.byteLength || view.getUint32(cursor, true) !== CENTRAL_SIGNATURE) invalid();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const fixedCompressed = view.getUint32(cursor + 20, true);
    const fixedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const disk = view.getUint16(cursor + 34, true);
    const fixedOffset = view.getUint32(cursor + 42, true);
    const next = cursor + CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (next > view.byteLength) invalid();
    if (disk !== 0 && disk !== 0xffff) throw new ImportArchiveError("archive_unsupported");
    const name = decoder.decode(new Uint8Array(view.buffer, view.byteOffset + cursor + CENTRAL_HEADER_BYTES, nameLength));
    const extended = zip64Extra(
      new DataView(view.buffer, view.byteOffset + cursor + CENTRAL_HEADER_BYTES + nameLength, extraLength),
      {
        compressedSize: fixedCompressed === 0xffffffff,
        localOffset: fixedOffset === 0xffffffff,
        size: fixedSize === 0xffffffff
      }
    );
    const compressedSize = fixedCompressed === 0xffffffff ? extended.compressedSize ?? invalid() : fixedCompressed;
    const size = fixedSize === 0xffffffff ? extended.size ?? invalid() : fixedSize;
    const localOffset = fixedOffset === 0xffffffff ? extended.localOffset ?? invalid() : fixedOffset;
    if (localOffset + LOCAL_HEADER_BYTES > directory.offset) invalid();
    cursor = next;
    // Directories hold no bytes and are never read.
    if (name.endsWith("/") || name.endsWith("\\")) continue;
    entries.push({ compressedSize, crc, flags, localOffset, method, path: normalizeArchivePath(name), size });
  }
  if (cursor !== directory.size) invalid();
  return entries.sort((left, right) => left.localOffset - right.localOffset);
}

async function readEntry(
  blob: Blob,
  entry: ZipEntry,
  read: ImportEntryRead,
  limits: ImportArchiveLimits,
  budget: ArchiveByteBudget,
  dataLimit: number
): Promise<ImportArchiveEntry> {
  if (entry.flags & UNSUPPORTED_FLAGS || (entry.method !== 0 && entry.method !== 8)) {
    throw new ImportArchiveError("archive_unsupported");
  }
  if (!read.prefix && entry.size > read.maxBytes) return { kind: "too_large", path: entry.path, size: entry.size };
  if (entry.method === 0 ? entry.compressedSize !== entry.size
    : entry.size > limits.ratioGraceBytes && entry.size > entry.compressedSize * limits.maxRatio) {
    throw new ImportArchiveError(entry.method === 0 ? "archive_entry_damaged" : "archive_ratio_exceeded");
  }
  const wanted = Math.min(entry.size, read.maxBytes);
  budget.ensure(wanted);
  const header = await readBytes(blob, entry.localOffset, entry.localOffset + LOCAL_HEADER_BYTES);
  if (header.getUint32(0, true) !== LOCAL_SIGNATURE) invalid();
  const dataStart = entry.localOffset + LOCAL_HEADER_BYTES + header.getUint16(26, true) + header.getUint16(28, true);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > dataLimit) invalid();
  let stream = blob.slice(dataStart, dataEnd).stream();
  if (entry.method === 8) stream = stream.pipeThrough(decompressionStream("deflate-raw"));
  const output = new Uint8Array(wanted);
  const reader = stream.getReader();
  let produced = 0;
  let crc = 0;
  let truncated = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // More output than declared: a lying header, never trusted.
      if (produced + value.byteLength > entry.size) throw new ImportArchiveError("archive_entry_damaged");
      const room = wanted - produced;
      if (value.byteLength > room) {
        output.set(value.subarray(0, room), produced);
        produced += room;
        truncated = true;
        break;
      }
      output.set(value, produced);
      produced += value.byteLength;
      crc = crc32Update(crc, value);
      if (produced === wanted && wanted < entry.size) {
        truncated = true;
        break;
      }
    }
  } catch (error) {
    if (error instanceof ImportArchiveError) throw error;
    throw new ImportArchiveError("archive_entry_damaged");
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  budget.add(produced);
  if (!truncated && (produced !== entry.size || crc !== entry.crc)) {
    throw new ImportArchiveError("archive_entry_damaged");
  }
  return { bytes: output.subarray(0, produced), kind: "data", path: entry.path, size: entry.size, truncated };
}

/**
 * Opens a zip by its central directory (ZIP64 included) through random
 * access to the Blob: listing reads no entry data, and only the entries a
 * converter selects are inflated, each checked against its declared size,
 * the compression-ratio guard and its CRC.
 */
export async function openZipArchive(
  blob: Blob,
  limits: ImportArchiveLimits = DEFAULT_IMPORT_ARCHIVE_LIMITS
): Promise<ImportArchive> {
  const directory = await centralDirectory(blob, limits);
  const view = await readBytes(blob, directory.offset, directory.offset + directory.size);
  const entries = parseEntries(view, directory);
  const budget = new ArchiveByteBudget(limits);
  return {
    format: "zip",
    async *entries(select: ImportEntrySelector) {
      for (const entry of entries) {
        const read = select({ path: entry.path, size: entry.size });
        if (!read) continue;
        yield await readEntry(blob, entry, read, limits, budget, directory.offset);
      }
    }
  };
}
