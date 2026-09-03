import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { extractImageMetadata } from "./imageMetadata";

const execFileAsync = promisify(execFile);

const oneByOnePng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64"
);

function uint16LE(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function uint32LE(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function uint24LE(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

function gifColorTablePackedByte(colorTable: Buffer | undefined): number {
  if (!colorTable) {
    return 0;
  }

  const entries = colorTable.length / 3;
  const size = Math.log2(entries) - 1;
  if (!Number.isInteger(size) || size < 0 || size > 7) {
    throw new Error("invalid_test_gif_color_table");
  }

  return 0x80 | (size << 4) | size;
}

function gifLocalColorTablePackedByte(colorTable: Buffer | undefined): number {
  return colorTable ? 0x80 | (gifColorTablePackedByte(colorTable) & 0x07) : 0;
}

function gifPreamble(input: {
  globalColorTable?: Buffer;
  height: number;
  version?: "GIF87a" | "GIF89a";
  width: number;
}): Buffer {
  return Buffer.concat([
    Buffer.from(input.version ?? "GIF89a", "ascii"),
    uint16LE(input.width),
    uint16LE(input.height),
    Buffer.from([
      gifColorTablePackedByte(input.globalColorTable),
      0,
      0
    ]),
    input.globalColorTable ?? Buffer.alloc(0)
  ]);
}

function gifSubBlocks(...payloads: Buffer[]): Buffer {
  return Buffer.concat([
    ...payloads.flatMap((payload) => {
      if (payload.length > 255) {
        throw new Error("invalid_test_gif_sub_block");
      }
      return [Buffer.from([payload.length]), payload];
    }),
    Buffer.from([0])
  ]);
}

function gifExtension(label: number, ...payloads: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([0x21, label]), gifSubBlocks(...payloads)]);
}

function gifImage(input: {
  compressedData: Buffer;
  height: number;
  localColorTable?: Buffer;
  lzwMinimumCodeSize: number;
  width: number;
}): Buffer {
  return Buffer.concat([
    Buffer.from([0x2c]),
    uint16LE(0),
    uint16LE(0),
    uint16LE(input.width),
    uint16LE(input.height),
    Buffer.from([gifLocalColorTablePackedByte(input.localColorTable)]),
    input.localColorTable ?? Buffer.alloc(0),
    Buffer.from([input.lzwMinimumCodeSize]),
    gifSubBlocks(input.compressedData)
  ]);
}

function gifFile(input: {
  blocks: Buffer[];
  globalColorTable?: Buffer;
  height: number;
  trailer?: boolean;
  version?: "GIF87a" | "GIF89a";
  width: number;
}): Buffer {
  return Buffer.concat([
    gifPreamble(input),
    ...input.blocks,
    ...(input.trailer === false ? [] : [Buffer.from([0x3b])])
  ]);
}

function packFixedWidthCodes(codes: number[], width: number): Buffer {
  const bytes: number[] = [];
  let bits = 0;
  let bitCount = 0;

  for (const code of codes) {
    bits |= code << bitCount;
    bitCount += width;
    while (bitCount >= 8) {
      bytes.push(bits & 0xff);
      bits >>>= 8;
      bitCount -= 8;
    }
  }

  if (bitCount > 0) {
    bytes.push(bits & 0xff);
  }

  return Buffer.from(bytes);
}

function webpFile(tag: string, payload: Buffer, declaredChunkSize = payload.length): Buffer {
  const paddedPayload = payload.length % 2 === 0
    ? payload
    : Buffer.concat([payload, Buffer.from([0])]);
  const riffSize = 4 + 8 + paddedPayload.length;

  return Buffer.concat([
    Buffer.from("RIFF", "ascii"),
    uint32LE(riffSize),
    Buffer.from("WEBP", "ascii"),
    Buffer.from(tag, "ascii"),
    uint32LE(declaredChunkSize),
    paddedPayload
  ]);
}

function vp8Payload(width: number, height: number, widthScale: number, heightScale: number): Buffer {
  const payload = Buffer.alloc(10);
  payload.set([0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a]);
  payload.writeUInt16LE(width | (widthScale << 14), 6);
  payload.writeUInt16LE(height | (heightScale << 14), 8);
  return payload;
}

function vp8lPayload(width: number, height: number): Buffer {
  const payload = Buffer.alloc(5);
  payload[0] = 0x2f;
  payload.writeUInt32LE((width - 1) | ((height - 1) << 14), 1);
  return payload;
}

function vp8xPayload(width: number, height: number): Buffer {
  return Buffer.concat([
    Buffer.alloc(4),
    uint24LE(width - 1),
    uint24LE(height - 1)
  ]);
}

const twoColorTable = Buffer.from([0, 0, 0, 255, 255, 255]);
const onePixelLzw = Buffer.from([0x44, 0x01]);
const malformedGifFixtures = [
  {
    name: "a global color table that extends past EOF",
    value: gifPreamble({ globalColorTable: twoColorTable, height: 1, width: 1 }).subarray(0, 15)
  },
  {
    name: "an image cut inside its declared LZW sub-block",
    value: Buffer.concat([
      gifPreamble({ globalColorTable: twoColorTable, height: 1, width: 1 }),
      gifImage({
        compressedData: onePixelLzw,
        height: 1,
        lzwMinimumCodeSize: 2,
        width: 1
      }).subarray(0, -2)
    ])
  },
  {
    name: "an extension sub-block that extends past EOF",
    value: Buffer.concat([
      gifPreamble({ height: 1, width: 1 }),
      Buffer.from([0x21, 0xfe, 0x05, 0x2c])
    ])
  },
  {
    name: "a complete frame without a trailer",
    value: gifFile({
      blocks: [
        gifImage({
          compressedData: onePixelLzw,
          height: 1,
          lzwMinimumCodeSize: 2,
          width: 1
        })
      ],
      globalColorTable: twoColorTable,
      height: 1,
      trailer: false,
      width: 1
    })
  }
];
const truncatedLogicalScreenFixtures = Array.from({ length: 7 }, (_value, index) => ({
  name: `${6 + index} total bytes`,
  value: Buffer.concat([Buffer.from("GIF89a", "ascii"), Buffer.alloc(index)])
}));

async function extractGifsInSubprocess(buffers: Buffer[]): Promise<unknown[]> {
  const moduleUrl = pathToFileURL(
    resolve(process.cwd(), "lib/server/uploads/imageMetadata.ts")
  ).href;
  const serializedBuffers = JSON.stringify(buffers.map((buffer) => buffer.toString("base64")));
  const source = `
    import * as imageMetadataModule from ${JSON.stringify(moduleUrl)};
    const extractImageMetadata =
      imageMetadataModule.extractImageMetadata ??
      imageMetadataModule.default?.extractImageMetadata;
    if (typeof extractImageMetadata !== "function") {
      throw new Error("image_metadata_export_unavailable");
    }
    const results = ${serializedBuffers}.map((value) => {
      try {
        return extractImageMetadata(Buffer.from(value, "base64"), "image/gif");
      } catch (error) {
        return { error: error instanceof Error ? error.message : "unknown_error" };
      }
    });
    process.stdout.write(JSON.stringify(results));
  `;
  const { stdout } = await execFileAsync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", source],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 64 * 1024,
      timeout: 2_000
    }
  );

  return JSON.parse(String(stdout)) as unknown[];
}

describe("image metadata", () => {
  it("extracts stable PNG dimensions", () => {
    expect(extractImageMetadata(oneByOnePng, "image/png")).toEqual({
      format: "png",
      height: 1,
      width: 1
    });
  });

  it("ignores descriptor-like bytes in a GIF87a global color table", () => {
    const grayscaleColorTable = Buffer.from(
      Array.from({ length: 256 }, (_value, index) => [index, index, index]).flat()
    );
    const gif = gifFile({
      blocks: [
        gifImage({
          compressedData: packFixedWidthCodes([256, 0, 257], 9),
          height: 1,
          lzwMinimumCodeSize: 8,
          width: 1
        })
      ],
      globalColorTable: grayscaleColorTable,
      height: 4,
      version: "GIF87a",
      width: 4
    });

    expect([...gif].filter((byte) => byte === 0x2c).length).toBeGreaterThan(1);
    expect(extractImageMetadata(gif, "image/gif")).toEqual({
      animated: false,
      format: "gif",
      height: 4,
      width: 4
    });
  });

  it("skips extensions, local color tables, and LZW sub-block payloads structurally", () => {
    const localColorTable = Buffer.alloc(16 * 3);
    localColorTable[7] = 0x2c;
    const gif = gifFile({
      blocks: [
        gifExtension(0xf9, Buffer.from([0x00, 0x2c, 0x00, 0x00])),
        gifExtension(0xfe, Buffer.from([0x2c, 0x63, 0x6f, 0x6d, 0x6d, 0x65, 0x6e, 0x74])),
        gifImage({
          compressedData: Buffer.from([0x10, 0x40, 0x00, 0x01, 0x2c, 0x11]),
          height: 1,
          localColorTable,
          lzwMinimumCodeSize: 4,
          width: 4
        })
      ],
      height: 1,
      width: 4
    });

    expect([...gif].filter((byte) => byte === 0x2c).length).toBeGreaterThan(4);
    expect(extractImageMetadata(gif, "image/gif")).toEqual({
      animated: false,
      format: "gif",
      height: 1,
      width: 4
    });
  });

  it("detects two real GIF image descriptors separated by extensions", () => {
    const frame = gifImage({
      compressedData: onePixelLzw,
      height: 1,
      lzwMinimumCodeSize: 2,
      width: 1
    });
    const control = gifExtension(0xf9, Buffer.from([0, 0, 0, 0]));
    const gif = gifFile({
      blocks: [control, frame, control, frame],
      globalColorTable: twoColorTable,
      height: 1,
      width: 1
    });

    expect(extractImageMetadata(gif, "image/gif")).toEqual({
      animated: true,
      format: "gif",
      height: 1,
      width: 1
    });
  });

  it.each(malformedGifFixtures)("returns promptly for $name", ({ value }) => {
    expect(extractImageMetadata(value, "image/gif")).toMatchObject({
      animated: false,
      format: "gif"
    });
  });

  it.each(truncatedLogicalScreenFixtures)(
    "rejects a truncated logical screen descriptor with $name",
    ({ value }) => {
      expect(() => extractImageMetadata(value, "image/gif")).toThrow("gif_unsupported_format");
    }
  );

  it("preemptively bounds every malformed GIF termination probe", async () => {
    const results = await extractGifsInSubprocess([
      ...malformedGifFixtures.map((fixture) => fixture.value),
      ...truncatedLogicalScreenFixtures.map((fixture) => fixture.value)
    ]);

    expect(results).toEqual([
      ...malformedGifFixtures.map(() => ({
        animated: false,
        format: "gif",
        height: 1,
        width: 1
      })),
      ...truncatedLogicalScreenFixtures.map(() => ({ error: "gif_unsupported_format" }))
    ]);
  }, 5_000);

  it("reads VP8 dimensions and masks the two scale bits", () => {
    expect(extractImageMetadata(webpFile("VP8 ", vp8Payload(640, 360, 3, 2)), "image/webp")).toEqual({
      format: "webp",
      height: 360,
      width: 640
    });
  });

  it("reads VP8L packed dimensions", () => {
    expect(extractImageMetadata(webpFile("VP8L", vp8lPayload(321, 123)), "image/webp")).toEqual({
      format: "webp",
      height: 123,
      width: 321
    });
  });

  it("preserves VP8X canvas dimension parsing", () => {
    expect(extractImageMetadata(webpFile("VP8X", vp8xPayload(1024, 768)), "image/webp")).toEqual({
      format: "webp",
      height: 768,
      width: 1024
    });
  });

  it("rejects a VP8 payload with the wrong start code using the stable code", () => {
    const payload = vp8Payload(640, 360, 0, 0);
    payload.set([0x00, 0x00, 0x00], 3);

    expect(() => extractImageMetadata(webpFile("VP8 ", payload), "image/webp")).toThrow(
      "webp_unsupported_format"
    );
  });

  it.each([
    { name: "an unknown chunk", value: webpFile("ALPH", Buffer.alloc(1)) },
    { name: "a missing chunk header", value: Buffer.from("RIFF\x04\x00\x00\x00WEBP", "binary") },
    { name: "a truncated VP8 payload", value: webpFile("VP8 ", Buffer.alloc(9)) },
    { name: "a truncated VP8L payload", value: webpFile("VP8L", Buffer.alloc(4)) },
    { name: "a VP8L payload with the wrong signature", value: webpFile("VP8L", Buffer.alloc(5)) },
    { name: "a truncated VP8X payload", value: webpFile("VP8X", Buffer.alloc(9)) },
    {
      name: "a chunk shorter than its declared size",
      value: webpFile("VP8L", vp8lPayload(1, 1), 10)
    }
  ])("rejects $name using the stable code", ({ value }) => {
    expect(() => extractImageMetadata(value, "image/webp")).toThrow(
      "webp_unsupported_format"
    );
  });
});
