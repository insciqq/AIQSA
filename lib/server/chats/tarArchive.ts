import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { skillTarPath } from "@/lib/domain/skillBundlePaths";

export type TarEntry = Readonly<{
  content: Uint8Array | string;
  mtime: Date;
  path: string;
  mode?: 0o644 | 0o755;
}>;

const BLOCK = 512;
const encoder = new TextEncoder();

function writeField(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  if (bytes.length > length) throw new Error("tar_field_invalid");
  header.set(bytes, offset);
}

function octal(value: number, length: number): string {
  return `${Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0")}\0`;
}

/** Lossless UTF-8 ustar paths only; never silently retarget an archive entry. */
function splitPath(path: string): readonly [string, string] {
  const result = skillTarPath(path);
  if (!result || new TextDecoder("utf-8", { fatal: true }).decode(encoder.encode(path)) !== path) throw new Error("tar_path_invalid");
  return result;
}

/** One 512-byte ustar header for a regular file. */
export function tarHeader(path: string, size: number, mtime: Date, mode: 0o644 | 0o755 = 0o644): Uint8Array {
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtime.getTime()) || (mode !== 0o644 && mode !== 0o755)) throw new Error("tar_field_invalid");
  const header = new Uint8Array(BLOCK);
  const [prefix, name] = splitPath(path);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, octal(mode, 8));
  writeField(header, 108, 8, octal(0, 8));
  writeField(header, 116, 8, octal(0, 8));
  writeField(header, 124, 12, octal(size, 12));
  writeField(header, 136, 12, octal(Math.floor(mtime.getTime() / 1000), 12));
  header.fill(0x20, 148, 156);
  writeField(header, 156, 1, "0");
  writeField(header, 257, 6, "ustar\0");
  writeField(header, 263, 2, "00");
  writeField(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeField(header, 148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  return header;
}

function padding(size: number): Uint8Array {
  const remainder = size % BLOCK;
  return new Uint8Array(remainder === 0 ? 0 : BLOCK - remainder);
}

/** Header, content, and block padding for one entry. */
export function tarEntryBlocks(entry: TarEntry): Uint8Array[] {
  const content = typeof entry.content === "string" ? encoder.encode(entry.content) : entry.content;
  return [tarHeader(entry.path, content.length, entry.mtime, entry.mode), content, padding(content.length)];
}

/** Two zero blocks mark the end of the archive. */
export function tarEndBlocks(): Uint8Array {
  return new Uint8Array(BLOCK * 2);
}

/**
 * Streams a gzip-compressed tar archive of the given entries; entries are
 * pulled lazily so a large export never materializes in memory.
 */
export function tarGzipStream(entries: AsyncIterable<TarEntry>): ReadableStream<Uint8Array> {
  const source = Readable.from((async function* blocks() {
    for await (const entry of entries) {
      for (const block of tarEntryBlocks(entry)) {
        if (block.length > 0) yield block;
      }
    }
    yield tarEndBlocks();
  })());
  const gzip = createGzip();
  source.on("error", (error) => gzip.destroy(error));
  source.pipe(gzip);
  return Readable.toWeb(gzip) as ReadableStream<Uint8Array>;
}
