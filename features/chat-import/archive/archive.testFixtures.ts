import { crc32Update } from "./archiveTypes";

/** Hand-built zip and tar.gz fixtures for the import archive readers (Web APIs only). */
const encoder = new TextEncoder();

export function bytesOf(content: string | Uint8Array): Uint8Array {
  return typeof content === "string" ? encoder.encode(content) : content;
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export function compress(bytes: Uint8Array, format: "deflate-raw" | "gzip"): Promise<Uint8Array> {
  return collect(new Blob([bytes]).stream().pipeThrough(new CompressionStream(format)));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

export type ZipFixtureEntry = Readonly<{
  path: string;
  content: string | Uint8Array;
  method?: 0 | 8;
  flags?: number;
  /** Overrides of what the headers declare. */
  declaredSize?: number;
  declaredCrc?: number;
}>;

/**
 * A zip with local headers, central directory and end record. `zip64`
 * saturates the 32-bit fields and records them in ZIP64 extras and a ZIP64
 * end record, as large-archive writers do.
 */
export async function buildZip(entries: readonly ZipFixtureEntry[], options: Readonly<{ zip64?: boolean }> = {}): Promise<Blob> {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = bytesOf(entry.content);
    const method = entry.method ?? 8;
    const data = method === 8 ? await compress(raw, "deflate-raw") : raw;
    const name = encoder.encode(entry.path);
    const crc = entry.declaredCrc ?? crc32Update(0, raw);
    const size = entry.declaredSize ?? raw.byteLength;
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, entry.flags ?? 0, true);
    local.setUint16(8, method, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.byteLength, true);
    local.setUint32(22, size, true);
    local.setUint16(26, name.byteLength, true);
    locals.push(new Uint8Array(local.buffer), name, data);
    const extra = options.zip64 ? new DataView(new ArrayBuffer(28)) : null;
    if (extra) {
      extra.setUint16(0, 0x0001, true);
      extra.setUint16(2, 24, true);
      extra.setBigUint64(4, BigInt(size), true);
      extra.setBigUint64(12, BigInt(data.byteLength), true);
      extra.setBigUint64(20, BigInt(offset), true);
    }
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 20, true);
    central.setUint16(6, 20, true);
    central.setUint16(8, entry.flags ?? 0, true);
    central.setUint16(10, method, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, extra ? 0xffffffff : data.byteLength, true);
    central.setUint32(24, extra ? 0xffffffff : size, true);
    central.setUint16(28, name.byteLength, true);
    central.setUint16(30, extra ? extra.byteLength : 0, true);
    central.setUint32(42, extra ? 0xffffffff : offset, true);
    centrals.push(new Uint8Array(central.buffer), name, ...(extra ? [new Uint8Array(extra.buffer)] : []));
    offset += 30 + name.byteLength + data.byteLength;
  }
  const directory = concat(centrals);
  const tail: Uint8Array[] = [];
  if (options.zip64) {
    const record = new DataView(new ArrayBuffer(56));
    record.setUint32(0, 0x06064b50, true);
    record.setBigUint64(4, 44n, true);
    record.setUint16(12, 45, true);
    record.setUint16(14, 45, true);
    record.setBigUint64(24, BigInt(entries.length), true);
    record.setBigUint64(32, BigInt(entries.length), true);
    record.setBigUint64(40, BigInt(directory.byteLength), true);
    record.setBigUint64(48, BigInt(offset), true);
    const locator = new DataView(new ArrayBuffer(20));
    locator.setUint32(0, 0x07064b50, true);
    locator.setBigUint64(8, BigInt(offset + directory.byteLength), true);
    locator.setUint32(16, 1, true);
    tail.push(new Uint8Array(record.buffer), new Uint8Array(locator.buffer));
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, options.zip64 ? 0xffff : entries.length, true);
  end.setUint16(10, options.zip64 ? 0xffff : entries.length, true);
  end.setUint32(12, options.zip64 ? 0xffffffff : directory.byteLength, true);
  end.setUint32(16, options.zip64 ? 0xffffffff : offset, true);
  return new Blob([concat(locals), directory, ...tail, new Uint8Array(end.buffer)]);
}

export type TarFixtureEntry = Readonly<{
  path: string;
  content?: string | Uint8Array;
  /** Typeflag; regular file by default. */
  type?: string;
  /** Overrides the recorded checksum. */
  checksum?: number;
}>;

function writeText(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(encoder.encode(value).subarray(0, length), offset);
}

function tarHeader(path: string, size: number, type: string, checksum?: number): Uint8Array {
  const header = new Uint8Array(512);
  const split = path.length > 100 ? path.lastIndexOf("/", 155) : -1;
  writeText(header, 0, 100, split > 0 ? path.slice(split + 1) : path);
  writeText(header, 100, 8, "0000644\0");
  writeText(header, 108, 8, "0000000\0");
  writeText(header, 116, 8, "0000000\0");
  writeText(header, 124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  writeText(header, 136, 12, "00000000000\0");
  header.fill(0x20, 148, 156);
  writeText(header, 156, 1, type);
  writeText(header, 257, 6, "ustar\0");
  writeText(header, 263, 2, "00");
  if (split > 0) writeText(header, 345, 155, path.slice(0, split));
  const sum = checksum ?? header.reduce((total, byte) => total + byte, 0);
  writeText(header, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

export function tarBytes(entries: readonly TarFixtureEntry[], options: Readonly<{ endMarker?: boolean }> = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const data = bytesOf(entry.content ?? "");
    parts.push(tarHeader(entry.path, data.byteLength, entry.type ?? "0", entry.checksum), data,
      new Uint8Array((512 - (data.byteLength % 512)) % 512));
  }
  if (options.endMarker ?? true) parts.push(new Uint8Array(1_024));
  return concat(parts);
}

/** A pax extended header record that renames the next entry. */
export function paxPathRecord(path: string): string {
  const body = ` path=${path}\n`;
  let length = body.length + 1;
  while (`${length}${body}`.length !== length) length = `${length}${body}`.length;
  return `${length}${body}`;
}

export async function buildTarGz(entries: readonly TarFixtureEntry[], options: Readonly<{ endMarker?: boolean }> = {}): Promise<Blob> {
  return new Blob([await compress(tarBytes(entries, options), "gzip")]);
}

/** A Blob that records which byte ranges a reader sliced. */
export function recordingBlob(blob: Blob): Readonly<{ blob: Blob; slices: Array<readonly [number, number]> }> {
  const slices: Array<readonly [number, number]> = [];
  const wrapped = Object.create(blob) as Blob;
  Object.defineProperty(wrapped, "size", { value: blob.size });
  Object.defineProperty(wrapped, "slice", {
    value: (start = 0, end = blob.size) => {
      slices.push([start, end]);
      return blob.slice(start, end);
    }
  });
  return { blob: wrapped, slices };
}
