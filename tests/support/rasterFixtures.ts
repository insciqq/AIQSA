import { deflateSync } from "node:zlib";
import sharp from "sharp";

/** Synthetic static-raster fixtures; no user image is ever copied into tests. */

function pngChunk(type: string, body: Buffer): Buffer {
  const prefix = Buffer.from(type, "ascii");
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([prefix, body])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const result = Buffer.alloc(12 + body.length);
  result.writeUInt32BE(body.length);
  prefix.copy(result, 4);
  body.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

/** Independently encoded 2x2 RGBA PNG, optionally with an APNG control chunk. */
export function syntheticPng(options: Readonly<{ animated?: boolean }> = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(2);
  header.writeUInt32BE(2, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
  const animation = Buffer.alloc(8);
  animation.writeUInt32BE(1);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    ...(options.animated ? [pngChunk("acTL", animation)] : []),
    pngChunk("IDAT", deflateSync(pixels)),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

export async function syntheticJpeg(): Promise<Buffer> {
  return sharp(syntheticPng()).flatten({ background: "#ffffff" }).jpeg().toBuffer();
}

export async function syntheticWebp(): Promise<Buffer> {
  return sharp(syntheticPng()).webp({ lossless: true }).toBuffer();
}

/** A solid PNG one pixel row beyond IMAGE_MAX_PIXELS (5120 x 4096). */
export async function syntheticOversizedPng(): Promise<Buffer> {
  return sharp({ create: { width: 5120, height: 4097, channels: 3, background: "#123456" } }).png().toBuffer();
}

/** JPEG carrying an MPF APP2 segment, as multi-picture (Ultra HDR) photos do. */
export async function syntheticMpfJpeg(): Promise<Buffer> {
  const jpeg = await syntheticJpeg();
  const payload = Buffer.concat([Buffer.from("MPF\0", "binary"), Buffer.alloc(8)]);
  const segment = Buffer.alloc(4);
  segment[0] = 0xff;
  segment[1] = 0xe2;
  segment.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), segment, payload, jpeg.subarray(2)]);
}

function riffChunk(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(type, 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}

/** Single-frame animated WebP container (VP8X animation flag, ANIM and ANMF). */
export async function syntheticAnimatedWebp(): Promise<Buffer> {
  const still = await syntheticWebp();
  const frame = still.subarray(12);
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x02 | 0x10;
  vp8x.writeUIntLE(1, 4, 3);
  vp8x.writeUIntLE(1, 7, 3);
  const anim = Buffer.alloc(6);
  const anmf = Buffer.alloc(16);
  anmf.writeUIntLE(1, 6, 3);
  anmf.writeUIntLE(1, 9, 3);
  anmf.writeUIntLE(100, 12, 3);
  const body = Buffer.concat([
    Buffer.from("WEBP", "ascii"),
    riffChunk("VP8X", vp8x),
    riffChunk("ANIM", anim),
    riffChunk("ANMF", Buffer.concat([anmf, frame]))
  ]);
  const header = Buffer.alloc(8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

export type Rgb = readonly [number, number, number];

/** A bottom-up 24-bit BI_RGB Windows bitmap with a 40-byte header. */
export function bitmap24(width: number, height: number, pixel: (x: number, y: number) => Rgb): Buffer {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = Buffer.alloc(54 + stride * height);
  bytes.write("BM", 0, "ascii");
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(stride * height, 34);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const at = 54 + (height - 1 - y) * stride + x * 3;
      bytes[at] = b;
      bytes[at + 1] = g;
      bytes[at + 2] = r;
    }
  }
  return bytes;
}

/** A single-page, losslessly compressed TIFF encoded by libvips from the given pixels. */
export async function syntheticTiff(width: number, height: number, pixel: (x: number, y: number) => Rgb): Promise<Buffer> {
  const raw = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) raw.set(pixel(x, y), (y * width + x) * 3);
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).tiff({ compression: "lzw" }).toBuffer();
}

/** Decoded image facts and its pixels as RGB(A) tuples in reading order. */
export async function decodedPixels(bytes: Buffer): Promise<Readonly<{ format: string | undefined; width: number; height: number;
  channels: number; pixels: number[][] }>> {
  const metadata = await sharp(bytes).metadata();
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const pixels: number[][] = [];
  for (let at = 0; at < data.length; at += info.channels) pixels.push([...data.subarray(at, at + info.channels)]);
  return { format: metadata.format, width: info.width, height: info.height, channels: info.channels, pixels };
}
