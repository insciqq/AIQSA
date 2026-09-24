import sharp from "sharp";

export type StaticRasterMime = "image/png" | "image/jpeg" | "image/webp";
export type StaticRasterMetadata = Readonly<{ mimeType: StaticRasterMime; width: number; height: number }>;
export type StaticRasterLimits = Readonly<{
  maxBytes: number;
  maxPixels: number;
  maxDimension?: number;
  mimeTypes: readonly StaticRasterMime[];
}>;

export class StaticRasterError extends Error {
  constructor(readonly code: "raster_invalid" | "raster_unsupported" | "raster_limit_exceeded") {
    super(code);
    this.name = "StaticRasterError";
  }
}

const invalid = () => new StaticRasterError("raster_invalid");
const unsupported = () => new StaticRasterError("raster_unsupported");

/** libvips may decode only the PNG default image; reject APNG before decoding. */
function staticPng(bytes: Buffer): void {
  let offset = 8;
  let data = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length || offset === 8 && (type !== "IHDR" || length !== 13)) throw invalid();
    if (type === "acTL" || type === "fcTL" || type === "fdAT") throw unsupported();
    if (type === "IDAT") data = true;
    if (type === "IEND") {
      if (length !== 0 || !data || end !== bytes.length) throw invalid();
      return;
    }
    offset = end;
  }
  throw invalid();
}

function staticWebp(bytes: Buffer): void {
  if (bytes.length < 20 || bytes.readUInt32LE(4) + 8 !== bytes.length) throw invalid();
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.length) throw invalid();
    if (type === "ANIM" || type === "ANMF" || type === "VP8X" && length > 0 && (bytes[offset + 8]! & 2)) throw unsupported();
    offset = end;
  }
  if (offset !== bytes.length) throw invalid();
}

/** MPO is a multi-picture JPEG, even when a decoder exposes only its first image. */
function staticJpeg(bytes: Buffer): void {
  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) throw invalid();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xda) return; // Compressed scan validity belongs to the full decoder.
    if (marker === undefined || marker === 0 || marker === 0xd9 || offset + 2 > bytes.length) throw invalid();
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) throw invalid();
    if (marker === 0xe2 && length >= 6 && bytes.toString("ascii", offset + 2, offset + 6) === "MPF\0") throw unsupported();
    offset += length;
  }
  throw invalid();
}

/** One bounded, fully decoded static-raster boundary shared by file and provider consumers. */
export async function validateStaticRaster(bytes: Uint8Array, limits: StaticRasterLimits, options: Readonly<{
  declaredMime?: unknown;
  signal?: AbortSignal;
}> = {}): Promise<StaticRasterMetadata> {
  options.signal?.throwIfAborted();
  if (!bytes.byteLength || bytes.byteLength > limits.maxBytes) throw new StaticRasterError("raster_limit_exceeded");
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const mimeType: StaticRasterMime = buffer.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ? "image/png"
    : buffer[0] === 0xff && buffer[1] === 0xd8 ? "image/jpeg"
      : buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP" ? "image/webp"
        : (() => { throw unsupported(); })();
  if (!limits.mimeTypes.includes(mimeType)) throw unsupported();
  if (options.declaredMime !== undefined && options.declaredMime !== mimeType) throw invalid();
  if (mimeType === "image/png") staticPng(buffer);
  else if (mimeType === "image/jpeg") staticJpeg(buffer);
  else staticWebp(buffer);
  try {
    const decoder = sharp(buffer, { limitInputPixels: limits.maxPixels, failOn: "warning" }).timeout({ seconds: 8 });
    const metadata = await decoder.metadata();
    if (`image/${metadata.format}` !== mimeType || !metadata.width || !metadata.height || (metadata.pages ?? 1) !== 1) throw invalid();
    if (metadata.width * metadata.height > limits.maxPixels ||
      limits.maxDimension !== undefined && Math.max(metadata.width, metadata.height) > limits.maxDimension) {
      throw new StaticRasterError("raster_limit_exceeded");
    }
    options.signal?.throwIfAborted();
    await decoder.stats();
    options.signal?.throwIfAborted();
    return { mimeType, width: metadata.width, height: metadata.height };
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof StaticRasterError) throw error;
    throw invalid();
  }
}
