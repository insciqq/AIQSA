import { Readable } from "node:stream";
import { createGzip } from "node:zlib";

export type TarEntry = Readonly<{
  content: Uint8Array | string;
  mtime: Date;
  path: string;
}>;

const BLOCK = 512;
const encoder = new TextEncoder();

function writeField(header: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = encoder.encode(value);
  header.set(bytes.subarray(0, length), offset);
}

function octal(value: number, length: number): string {
  return `${Math.max(0, Math.floor(value)).toString(8).padStart(length - 1, "0")}\0`;
}

/** Splits a path into the ustar prefix/name pair; long names are truncated at a separator. */
function splitPath(path: string): readonly [string, string] {
  const normalized = path.replace(/^\/+/, "");
  if (encoder.encode(normalized).length <= 100) {
    return ["", normalized];
  }
  const segments = normalized.split("/");
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const prefix = segments.slice(0, index).join("/");
    const name = segments.slice(index).join("/");
    if (encoder.encode(prefix).length <= 155 && encoder.encode(name).length <= 100) {
      return [prefix, name];
    }
  }
  return ["", normalized.slice(-100)];
}

/** One 512-byte ustar header for a regular file. */
export function tarHeader(path: string, size: number, mtime: Date): Uint8Array {
  const header = new Uint8Array(BLOCK);
  const [prefix, name] = splitPath(path);
  writeField(header, 0, 100, name);
  writeField(header, 100, 8, octal(0o644, 8));
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
  return [tarHeader(entry.path, content.length, entry.mtime), content, padding(content.length)];
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
