import sharp from "sharp";

/**
 * BMP and TIFF reach a chat model only as PNG: no adapter but Gemini accepts
 * them, and converting for every route keeps one behaviour (they can arrive
 * only as Workspace outputs reused in a later message; direct chat uploads
 * refuse them). The stored file is never changed.
 *
 * TIFF decodes through libvips (sharp). Prebuilt libvips has no BMP loader and
 * `@napi-rs/canvas` 0.1.100 crashes the process (SIGSEGV) on a BMP Skia cannot
 * decode, so BMP is read by the bounded, in-process decoder below and only its
 * raw pixels go to sharp for PNG encoding.
 */
export type ProviderRasterConversionBounds = Readonly<{ maxPixels: number; maxDimension: number }>;

export class ProviderRasterConversionError extends Error {
  constructor(
    readonly code: "raster_conversion_invalid" | "raster_conversion_limit_exceeded",
    readonly facts: Readonly<{ width?: number; height?: number }> = {}
  ) {
    super(code);
    this.name = "ProviderRasterConversionError";
  }
}

const CONVERTED_MIME_TYPES: ReadonlyMap<string, "bmp" | "tiff"> = new Map([
  ["image/bmp", "bmp"], ["image/x-bmp", "bmp"], ["image/tiff", "tiff"], ["image/x-tiff", "tiff"]
]);

/** Whether an image of this declared type is converted to PNG before dispatch. */
export function providerRasterNeedsConversion(mimeType: string | null | undefined): boolean {
  return CONVERTED_MIME_TYPES.has((mimeType ?? "").trim().toLowerCase());
}

const invalid = () => new ProviderRasterConversionError("raster_conversion_invalid");

function checkBounds(width: number, height: number, bounds: ProviderRasterConversionBounds): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) throw invalid();
  if (width * height > bounds.maxPixels || Math.max(width, height) > bounds.maxDimension) {
    throw new ProviderRasterConversionError("raster_conversion_limit_exceeded", { width, height });
  }
}

type Mask = Readonly<{ mask: number; shift: number; max: number }>;

function channelMask(mask: number): Mask | null {
  if (mask === 0) return null;
  let shift = 0;
  while (((mask >>> shift) & 1) === 0) shift += 1;
  const value = mask >>> shift;
  // Only contiguous masks are meaningful; reject anything else as malformed.
  if ((value & (value + 1)) !== 0) throw invalid();
  return { mask, shift, max: value };
}

function scaled(pixel: number, channel: Mask | null, missing: number): number {
  if (!channel) return missing;
  const value = ((pixel & channel.mask) >>> 0) >>> channel.shift;
  return channel.max === 255 ? value : Math.round(value * 255 / channel.max);
}

export type DecodedBitmap = Readonly<{ width: number; height: number; channels: 3 | 4; data: Buffer }>;

/**
 * Decodes an uncompressed (BI_RGB) or bit-field (BI_BITFIELDS,
 * BI_ALPHABITFIELDS) Windows bitmap to raw RGB or RGBA. Every offset is
 * checked against the buffer and the pixel bounds are enforced from the header
 * before any pixel buffer is allocated. RLE and embedded JPEG/PNG bitmaps are
 * refused as invalid.
 */
export function decodeBitmap(bytes: Buffer, bounds: ProviderRasterConversionBounds): DecodedBitmap {
  if (bytes.length < 26 || bytes.toString("ascii", 0, 2) !== "BM") throw invalid();
  const pixelOffset = bytes.readUInt32LE(10);
  const headerSize = bytes.readUInt32LE(14);
  const core = headerSize === 12;
  if (!core && ![40, 52, 56, 108, 124].includes(headerSize)) throw invalid();
  if (14 + headerSize > bytes.length) throw invalid();
  const width = core ? bytes.readUInt16LE(18) : bytes.readInt32LE(18);
  const rawHeight = core ? bytes.readUInt16LE(20) : bytes.readInt32LE(22);
  const planes = core ? bytes.readUInt16LE(22) : bytes.readUInt16LE(26);
  const bitCount = core ? bytes.readUInt16LE(24) : bytes.readUInt16LE(28);
  const compression = core ? 0 : bytes.readUInt32LE(30);
  if (planes !== 1 || rawHeight === -2_147_483_648) throw invalid();
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);
  checkBounds(width, height, bounds);
  if (![1, 4, 8, 16, 24, 32].includes(bitCount)) throw invalid();
  const bitFields = compression === 3 || compression === 6;
  if (!(compression === 0 || bitFields && (bitCount === 16 || bitCount === 32))) throw invalid();

  let red: Mask | null = null;
  let green: Mask | null = null;
  let blue: Mask | null = null;
  let alpha: Mask | null = null;
  if (bitFields) {
    // A 40-byte header keeps its masks right after it; larger ones carry them inside.
    const maskOffset = 14 + 40;
    const maskCount = headerSize >= 56 || compression === 6 ? 4 : 3;
    if (maskOffset + maskCount * 4 > bytes.length || maskOffset + maskCount * 4 > pixelOffset) throw invalid();
    red = channelMask(bytes.readUInt32LE(maskOffset));
    green = channelMask(bytes.readUInt32LE(maskOffset + 4));
    blue = channelMask(bytes.readUInt32LE(maskOffset + 8));
    alpha = maskCount === 4 ? channelMask(bytes.readUInt32LE(maskOffset + 12)) : null;
  } else if (bitCount === 16) {
    red = channelMask(0x7c00);
    green = channelMask(0x03e0);
    blue = channelMask(0x001f);
  }

  let palette: Buffer | null = null;
  let paletteEntries = 0;
  const entrySize = core ? 3 : 4;
  if (bitCount <= 8) {
    const used = core ? 0 : bytes.readUInt32LE(46);
    paletteEntries = used === 0 ? 2 ** bitCount : used;
    if (paletteEntries > 2 ** bitCount) throw invalid();
    const paletteStart = 14 + headerSize;
    const paletteEnd = paletteStart + paletteEntries * entrySize;
    if (paletteEnd > bytes.length || paletteEnd > pixelOffset) throw invalid();
    palette = bytes.subarray(paletteStart, paletteEnd);
  }

  const stride = Math.floor((bitCount * width + 31) / 32) * 4;
  const rowBytes = Math.ceil(bitCount * width / 8);
  if (pixelOffset < 14 + headerSize || pixelOffset + stride * (height - 1) + rowBytes > bytes.length) throw invalid();

  // A 32-bit BI_RGB pixel's fourth byte is reserved; writers that store alpha
  // there are honoured only when some pixel actually sets it.
  const reservedAlpha = bitCount === 32 && !bitFields;
  let channels: 3 | 4 = alpha || reservedAlpha ? 4 : 3;
  const data = Buffer.alloc(width * height * channels);
  let anyReservedAlpha = false;
  for (let row = 0; row < height; row += 1) {
    const source = pixelOffset + (topDown ? row : height - 1 - row) * stride;
    let target = row * width * channels;
    for (let x = 0; x < width; x += 1) {
      let r: number;
      let g: number;
      let b: number;
      let a = 255;
      if (palette) {
        const bitOffset = x * bitCount;
        const byte = bytes[source + (bitOffset >> 3)]!;
        const index = bitCount === 8 ? byte : (byte >> (8 - bitCount - (bitOffset & 7))) & ((1 << bitCount) - 1);
        if (index >= paletteEntries) throw invalid();
        b = palette[index * entrySize]!;
        g = palette[index * entrySize + 1]!;
        r = palette[index * entrySize + 2]!;
      } else if (bitCount === 24) {
        const at = source + x * 3;
        b = bytes[at]!;
        g = bytes[at + 1]!;
        r = bytes[at + 2]!;
      } else if (reservedAlpha) {
        const at = source + x * 4;
        b = bytes[at]!;
        g = bytes[at + 1]!;
        r = bytes[at + 2]!;
        a = bytes[at + 3]!;
        if (a !== 0) anyReservedAlpha = true;
      } else {
        const pixel = bitCount === 16 ? bytes.readUInt16LE(source + x * 2) : bytes.readUInt32LE(source + x * 4);
        r = scaled(pixel, red, 0);
        g = scaled(pixel, green, 0);
        b = scaled(pixel, blue, 0);
        a = scaled(pixel, alpha, 255);
      }
      data[target] = r;
      data[target + 1] = g;
      data[target + 2] = b;
      if (channels === 4) data[target + 3] = a;
      target += channels;
    }
  }
  if (reservedAlpha && !anyReservedAlpha) {
    // An all-zero reserved byte means "unused", not "fully transparent".
    const opaque = Buffer.alloc(width * height * 3);
    for (let source = 0, target = 0; source < data.length; source += 4, target += 3) {
      opaque[target] = data[source]!;
      opaque[target + 1] = data[source + 1]!;
      opaque[target + 2] = data[source + 2]!;
    }
    channels = 3;
    return { width, height, channels, data: opaque };
  }
  return { width, height, channels, data };
}

function isTiff(bytes: Buffer): boolean {
  const magic = bytes.subarray(0, 4).toString("hex");
  // Classic and BigTIFF, little and big endian.
  return magic === "49492a00" || magic === "4d4d002a" || magic === "49492b00" || magic === "4d4d002b";
}

async function tiffToPng(bytes: Buffer, bounds: ProviderRasterConversionBounds): Promise<Buffer> {
  // libvips enforces limitInputPixels while reading the header and reports it
  // as a decode failure, so the bound is read from a header-only pass first.
  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(bytes, { limitInputPixels: false, failOn: "error" }).metadata();
  } catch {
    throw invalid();
  }
  if (metadata.format !== "tiff" || !metadata.width || !metadata.height) throw invalid();
  checkBounds(metadata.width, metadata.height, bounds);
  try {
    // The first page only, as image viewers show it; libtiff warnings about
    // private tags are common and harmless, decode errors are not.
    return await sharp(bytes, { limitInputPixels: bounds.maxPixels, failOn: "error", page: 0, pages: 1 })
      .timeout({ seconds: 8 }).png().toBuffer();
  } catch {
    throw invalid();
  }
}

/**
 * Converts a stored BMP or TIFF to PNG for a provider request. The bytes must
 * carry the declared format's signature; anything else is refused.
 */
export async function convertRasterForProvider(
  bytes: Buffer,
  mimeType: string,
  bounds: ProviderRasterConversionBounds,
  signal?: AbortSignal
): Promise<Buffer> {
  signal?.throwIfAborted();
  const format = CONVERTED_MIME_TYPES.get(mimeType.trim().toLowerCase());
  if (!format) throw invalid();
  if (format === "tiff") {
    if (!isTiff(bytes)) throw invalid();
    const png = await tiffToPng(bytes, bounds);
    signal?.throwIfAborted();
    return png;
  }
  const bitmap = decodeBitmap(bytes, bounds);
  signal?.throwIfAborted();
  try {
    const png = await sharp(bitmap.data, {
      raw: { width: bitmap.width, height: bitmap.height, channels: bitmap.channels },
      limitInputPixels: bounds.maxPixels
    }).timeout({ seconds: 8 }).png().toBuffer();
    signal?.throwIfAborted();
    return png;
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof ProviderRasterConversionError) throw error;
    throw invalid();
  }
}
