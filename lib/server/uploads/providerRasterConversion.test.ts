import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { bitmap24, decodedPixels, syntheticTiff, type Rgb } from "@/tests/support/rasterFixtures";
import {
  convertRasterForProvider,
  decodeBitmap,
  ProviderRasterConversionError,
  providerRasterNeedsConversion
} from "./providerRasterConversion";

const bounds = { maxPixels: 64, maxDimension: 16 };
const colours: readonly Rgb[] = [[255, 0, 0], [0, 255, 0], [0, 0, 255], [10, 20, 30], [200, 100, 50], [1, 2, 3]];
const pattern = (x: number, y: number): Rgb => colours[(y * 3 + x) % colours.length]!;
const rgb = (pixels: number[][]) => pixels.map((pixel) => pixel.slice(0, 3));

/** A bitmap with a custom DIB header and pixel area, for the variants the fixture builder does not write. */
function bitmap(input: { headerSize?: number; width: number; height: number; bitCount: number; compression?: number;
  extra?: Buffer; palette?: Buffer; colorsUsed?: number; pixels: Buffer }): Buffer {
  const headerSize = input.headerSize ?? 40;
  const header = Buffer.alloc(headerSize);
  header.writeUInt32LE(headerSize, 0);
  header.writeInt32LE(input.width, 4);
  header.writeInt32LE(input.height, 8);
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(input.bitCount, 14);
  header.writeUInt32LE(input.compression ?? 0, 16);
  header.writeUInt32LE(input.colorsUsed ?? 0, 32);
  if (input.extra && headerSize > 40) input.extra.copy(header, 40);
  const afterHeader = Buffer.concat([...(input.extra && headerSize === 40 ? [input.extra] : []), input.palette ?? Buffer.alloc(0)]);
  const offset = 14 + headerSize + afterHeader.length;
  const file = Buffer.alloc(14);
  file.write("BM", 0, "ascii");
  file.writeUInt32LE(offset + input.pixels.length, 2);
  file.writeUInt32LE(offset, 10);
  return Buffer.concat([file, header, afterHeader, input.pixels]);
}

const masks = (...values: number[]) => Buffer.concat(values.map((value) => {
  const bytes = Buffer.alloc(4);
  bytes.writeUInt32LE(value >>> 0, 0);
  return bytes;
}));

async function rejection(promise: Promise<unknown>): Promise<string> {
  const error = await promise.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ProviderRasterConversionError);
  return (error as ProviderRasterConversionError).code;
}

describe("provider raster conversion", () => {
  it("converts only BMP and TIFF declarations", () => {
    for (const type of ["image/bmp", "image/x-bmp", "image/tiff", "IMAGE/X-TIFF"]) expect(providerRasterNeedsConversion(type)).toBe(true);
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "", null]) {
      expect(providerRasterNeedsConversion(type)).toBe(false);
    }
  });

  it("turns a 24-bit bitmap into a PNG with the same pixels", async () => {
    const png = await convertRasterForProvider(bitmap24(3, 2, pattern), "image/bmp", bounds);
    const decoded = await decodedPixels(png);
    expect(decoded).toMatchObject({ format: "png", width: 3, height: 2, channels: 3 });
    expect(decoded.pixels).toEqual([pattern(0, 0), pattern(1, 0), pattern(2, 0), pattern(0, 1), pattern(1, 1), pattern(2, 1)]);
  });

  it("turns a TIFF into a PNG with the same pixels", async () => {
    const tiff = await syntheticTiff(3, 2, pattern);
    expect(tiff.subarray(0, 2).toString("ascii")).toMatch(/^(II|MM)$/u);
    const decoded = await decodedPixels(await convertRasterForProvider(tiff, "image/tiff", bounds));
    expect(decoded).toMatchObject({ format: "png", width: 3, height: 2 });
    expect(rgb(decoded.pixels)).toEqual([pattern(0, 0), pattern(1, 0), pattern(2, 0), pattern(0, 1), pattern(1, 1), pattern(2, 1)]);
  });

  it("reads palette, top-down, 16-bit and bit-field bitmaps", () => {
    // 8-bit palette, top-down: rows are stored first row first.
    const palette = Buffer.from([0, 0, 255, 0, /* red */ 0, 255, 0, 0 /* green */]);
    const eightBit = bitmap({ width: 2, height: -2, bitCount: 8, colorsUsed: 2, palette,
      pixels: Buffer.from([0, 1, 0, 0, 1, 0, 0, 0]) });
    expect(rgb(pixelsOf(decodeBitmap(eightBit, bounds)))).toEqual([[255, 0, 0], [0, 255, 0], [0, 255, 0], [255, 0, 0]]);

    // 1-bit and 4-bit indexes pack several pixels into each byte.
    const oneBit = bitmap({ width: 3, height: 1, bitCount: 1, colorsUsed: 2, palette, pixels: Buffer.from([0b10100000, 0, 0, 0]) });
    expect(pixelsOf(decodeBitmap(oneBit, bounds))).toEqual([[0, 255, 0], [255, 0, 0], [0, 255, 0]]);
    const fourBit = bitmap({ width: 3, height: 1, bitCount: 4, colorsUsed: 2, palette, pixels: Buffer.from([0x10, 0x10, 0, 0]) });
    expect(pixelsOf(decodeBitmap(fourBit, bounds))).toEqual([[0, 255, 0], [255, 0, 0], [0, 255, 0]]);

    // 16-bit BI_RGB is 5-5-5.
    const sixteen = bitmap({ width: 2, height: 1, bitCount: 16, pixels: Buffer.from([0x00, 0x7c, 0x1f, 0x00]) });
    expect(pixelsOf(decodeBitmap(sixteen, bounds))).toEqual([[255, 0, 0], [0, 0, 255]]);

    // 32-bit BI_ALPHABITFIELDS keeps the alpha channel.
    const withAlpha = bitmap({ width: 1, height: 1, bitCount: 32, compression: 6,
      extra: masks(0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000), pixels: Buffer.from([3, 2, 1, 128]) });
    expect(decodeBitmap(withAlpha, bounds)).toMatchObject({ channels: 4 });
    expect(pixelsOf(decodeBitmap(withAlpha, bounds))).toEqual([[1, 2, 3, 128]]);

    // A V5 header carries its masks inside the header.
    const v5 = bitmap({ headerSize: 124, width: 1, height: 1, bitCount: 32, compression: 3,
      extra: masks(0x00ff0000, 0x0000ff00, 0x000000ff, 0), pixels: Buffer.from([3, 2, 1, 0]) });
    expect(pixelsOf(decodeBitmap(v5, bounds))).toEqual([[1, 2, 3]]);

    // An all-zero reserved byte in 32-bit BI_RGB means opaque, a set one is alpha.
    const reserved = bitmap({ width: 1, height: 1, bitCount: 32, pixels: Buffer.from([3, 2, 1, 0]) });
    expect(decodeBitmap(reserved, bounds)).toMatchObject({ channels: 3 });
    const stored = bitmap({ width: 1, height: 1, bitCount: 32, pixels: Buffer.from([3, 2, 1, 7]) });
    expect(pixelsOf(decodeBitmap(stored, bounds))).toEqual([[1, 2, 3, 7]]);
  });

  it("refuses malformed bitmaps without crashing the process", async () => {
    const valid = bitmap24(2, 2, pattern);
    const cases: Buffer[] = [
      Buffer.from("BMgarbage"),
      valid.subarray(0, valid.length - 4),
      Buffer.from(valid).fill(0x41, 0, 2),
      (() => { const copy = Buffer.from(valid); copy.writeUInt16LE(7, 28); return copy; })(),
      (() => { const copy = Buffer.from(valid); copy.writeUInt32LE(1, 30); return copy; })(), // RLE8
      (() => { const copy = Buffer.from(valid); copy.writeUInt32LE(4, 30); return copy; })(), // embedded JPEG
      (() => { const copy = Buffer.from(valid); copy.writeInt32LE(0, 18); return copy; })(),
      (() => { const copy = Buffer.from(valid); copy.writeUInt32LE(41, 14); return copy; })(),
      (() => { const copy = Buffer.from(valid); copy.writeUInt32LE(valid.length, 10); return copy; })(),
      bitmap({ width: 1, height: 1, bitCount: 8, colorsUsed: 1, palette: Buffer.alloc(4), pixels: Buffer.from([5, 0, 0, 0]) }),
      bitmap({ width: 1, height: 1, bitCount: 32, compression: 3, extra: masks(0x00f0f000, 0xff00, 0xff), pixels: Buffer.alloc(4) })
    ];
    for (const bytes of cases) {
      expect(await rejection(convertRasterForProvider(bytes, "image/bmp", bounds))).toBe("raster_conversion_invalid");
    }
  });

  it("enforces the pixel and side bounds from the header, before decoding", async () => {
    // A tiny file claiming a huge image fails on the bound, not on its missing pixels.
    const bomb = bitmap24(1, 1, pattern);
    bomb.writeInt32LE(50_000, 18);
    bomb.writeInt32LE(50_000, 22);
    const error = await convertRasterForProvider(bomb, "image/bmp", bounds).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "raster_conversion_limit_exceeded", facts: { width: 50_000, height: 50_000 } });
    expect(await rejection(convertRasterForProvider(bitmap24(17, 1, pattern), "image/bmp", bounds)))
      .toBe("raster_conversion_limit_exceeded");
    expect(await rejection(convertRasterForProvider(await syntheticTiff(9, 8, pattern), "image/tiff", bounds)))
      .toBe("raster_conversion_limit_exceeded");
  });

  it("refuses TIFF bytes that are corrupt or carry another format's signature", async () => {
    const tiff = await syntheticTiff(2, 2, pattern);
    expect(await rejection(convertRasterForProvider(tiff.subarray(0, 24), "image/tiff", bounds))).toBe("raster_conversion_invalid");
    expect(await rejection(convertRasterForProvider(bitmap24(2, 2, pattern), "image/tiff", bounds))).toBe("raster_conversion_invalid");
    expect(await rejection(convertRasterForProvider(tiff, "image/bmp", bounds))).toBe("raster_conversion_invalid");
    const png = await sharp(tiff).png().toBuffer();
    expect(await rejection(convertRasterForProvider(png, "image/tiff", bounds))).toBe("raster_conversion_invalid");
  });

  it("stops when the caller cancels", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(convertRasterForProvider(bitmap24(1, 1, pattern), "image/bmp", bounds, controller.signal)).rejects.toThrow("stopped");
  });
});

function pixelsOf(bitmap: ReturnType<typeof decodeBitmap>): number[][] {
  const pixels: number[][] = [];
  for (let at = 0; at < bitmap.data.length; at += bitmap.channels) pixels.push([...bitmap.data.subarray(at, at + bitmap.channels)]);
  return pixels;
}
