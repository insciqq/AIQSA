// @vitest-environment node
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { prepareWorkspaceImages, WORKSPACE_IMAGE_LIMITS, type WorkspaceImageSource } from "./imageCapture";

function chunk(type: string, body: Buffer): Buffer {
  const prefix = Buffer.from(type);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([prefix, body])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  const result = Buffer.alloc(12 + body.length);
  result.writeUInt32BE(body.length); prefix.copy(result, 4); body.copy(result, 8);
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}

// Independent tiny PNG encoder: red/green in row one, blue/white in row two.
function fixture(options: { animation?: boolean; width?: number; corrupt?: boolean } = {}): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(options.width ?? 2); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]);
  const animation = Buffer.alloc(8); animation.writeUInt32BE(2);
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", header),
    ...(options.animation ? [chunk("acTL", animation)] : []),
    chunk("IDAT", options.corrupt ? Buffer.from([1, 2, 3]) : deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function source(bytes = fixture(), overrides: Partial<WorkspaceImageSource> = {}) {
  return {
    captureId: "a".repeat(32), relativePath: "project/проверка.png", byteSize: bytes.length, checksum: hash(bytes),
    assertAccess: vi.fn(async () => undefined),
    open: vi.fn(async () => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } })),
    ...overrides
  };
}
const read = async (image: { open(signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> }) =>
  Buffer.from(await new Response(await image.open()).arrayBuffer());

describe("immutable Workspace image evidence", () => {
  it("validates exact pixels and returns only serializable metadata plus a private authorized reader", async () => {
    const input = source();
    const [image] = await prepareWorkspaceImages([{ source: input }]);
    expect(image!.descriptor).toMatchObject({ mimeType: "image/png", width: 2, height: 2, frames: 1, transform: null,
      checksum: input.checksum, source: { captureId: input.captureId, checksum: input.checksum } });
    expect(image!.descriptor.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(await read(image!)).toEqual(fixture());
    expect(Object.keys(image!.descriptor)).not.toContain("bytes");
    expect(JSON.stringify(image!.descriptor)).not.toContain(fixture().toString("base64"));
    expect(input.assertAccess).toHaveBeenCalled();
    image!.dispose();
    await expect(image!.open()).rejects.toThrow("workspace_image_unavailable");
  });

  it("keeps capture identities and ordering for equal filenames with different bytes", async () => {
    const jpeg = await sharp(fixture()).jpeg().toBuffer();
    const images = await prepareWorkspaceImages([{ source: source() }, { source: source(jpeg, { captureId: "b".repeat(32) }) }]);
    expect(images.map(image => image.descriptor.mimeType)).toEqual(["image/png", "image/jpeg"]);
    expect(images[0]!.descriptor.id).not.toBe(images[1]!.descriptor.id);
    expect(await read(images[1]!)).toEqual(jpeg);
    for (const image of images) image.dispose();
  });

  it("records crop/resize identity and original dimensions, with an independent blue-pixel oracle", async () => {
    const input = source();
    const transform = { crop: { left: 0, top: 1, width: 1, height: 1 }, resize: { width: 1, height: 1 } };
    const [original, cropped] = await prepareWorkspaceImages([{ source: input }, { source: input, transform }]);
    expect(cropped!.descriptor).toMatchObject({ width: 1, height: 1, transform, source: { width: 2, height: 2, checksum: input.checksum } });
    expect(cropped!.descriptor.id).not.toBe(original!.descriptor.id);
    expect(cropped!.descriptor.checksum).not.toBe(original!.descriptor.checksum);
    const pixels = await sharp(await read(cropped!)).ensureAlpha().raw().toBuffer();
    expect([...pixels]).toEqual([0, 0, 255, 255]);
    const [recovered] = await prepareWorkspaceImages([{ source: input, transform }]);
    expect(recovered!.descriptor).toEqual(cropped!.descriptor);
    original!.dispose(); cropped!.dispose(); recovered!.dispose();
  });

  it("bounds selection and declared sizes before reading any bytes", async () => {
    const input = source();
    await expect(prepareWorkspaceImages(Array.from({ length: 9 }, () => ({ source: input })))).rejects.toThrow("workspace_image_limit_exceeded");
    await expect(prepareWorkspaceImages([{ source: { ...input, byteSize: WORKSPACE_IMAGE_LIMITS.maxBytes + 1 } }])).rejects.toThrow("workspace_image_limit_exceeded");
    await expect(prepareWorkspaceImages(Array.from({ length: 3 }, () => ({ source: { ...input, byteSize: WORKSPACE_IMAGE_LIMITS.maxBytes } })))).rejects.toThrow("workspace_image_limit_exceeded");
    expect(input.open).not.toHaveBeenCalled();
  });

  it.each([
    ["APNG", fixture({ animation: true }), "workspace_image_unsupported"],
    ["truncated", fixture().subarray(0, 40), "workspace_image_invalid"],
    ["bad compressed pixels", fixture({ corrupt: true }), "workspace_image_invalid"],
    ["oversized dimensions", fixture({ width: 100_000_000 }), "workspace_image_invalid"],
    ["SVG", Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), "workspace_image_unsupported"],
    ["PSD", Buffer.from("8BPS synthetic"), "workspace_image_unsupported"]
  ])("rejects %s despite a PNG filename and matching checksum", async (_label, bytes, code) => {
    await expect(prepareWorkspaceImages([{ source: source(bytes as Buffer) }])).rejects.toThrow(code as string);
  });

  it("does not silently enable WebP for the initial Workspace consumer", async () => {
    const bytes = await sharp(fixture()).webp().toBuffer();
    await expect(prepareWorkspaceImages([{ source: source(bytes) }])).rejects.toThrow("workspace_image_unsupported");
  });

  it("rejects corrupted captured bytes and stream size lies before accepting an image", async () => {
    await expect(prepareWorkspaceImages([{ source: source(fixture(), { checksum: "f".repeat(64) }) }])).rejects.toThrow("workspace_image_invalid");
    await expect(prepareWorkspaceImages([{ source: source(fixture(), { byteSize: 8 }) }])).rejects.toThrow("workspace_image_invalid");
  });

  it("cancels a stalled source, releases the reader and does not accept late bytes", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const input = source(fixture(), { open: async () => new ReadableStream({ pull() { controller.abort(); }, cancel }) });
    await expect(prepareWorkspaceImages([{ source: input }], controller.signal)).rejects.toThrow("workspace_image_cancelled");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects stale authority before byte reads and rechecks it before private delivery", async () => {
    const input = source();
    vi.mocked(input.assertAccess).mockRejectedValueOnce(new Error("workspace_operation_stale"));
    await expect(prepareWorkspaceImages([{ source: input }])).rejects.toThrow("workspace_operation_stale");
    expect(input.open).not.toHaveBeenCalled();
    const [image] = await prepareWorkspaceImages([{ source: input }]);
    vi.mocked(input.assertAccess).mockRejectedValueOnce(new Error("workspace_operation_stale"));
    await expect(image!.open()).rejects.toThrow("workspace_operation_stale");
    image!.dispose();
  });

  it("rechecks access when prepared evidence is read after revocation", async () => {
    const input = source();
    const [image] = await prepareWorkspaceImages([{ source: input }]);
    const stream = await image!.open();
    vi.mocked(input.assertAccess).mockRejectedValue(new Error("workspace_operation_stale"));
    await expect(new Response(stream).arrayBuffer()).rejects.toThrow("workspace_operation_stale");
    image!.dispose();
  });

  it("rejects out-of-bounds transforms and does not mutate later deliveries through a consumed buffer", async () => {
    await expect(prepareWorkspaceImages([{ source: source(), transform: { crop: { left: 1, top: 0, width: 2, height: 2 } } }]))
      .rejects.toThrow("workspace_image_invalid");
    const [image] = await prepareWorkspaceImages([{ source: source() }]);
    const reader = (await image!.open()).getReader();
    const first = await reader.read(); first.value!.fill(0); await reader.cancel();
    expect(await read(image!)).toEqual(fixture());
    image!.dispose();
  });
});
