import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS } from "@/lib/contracts/imageGeneration";
import { PREVIEW_MAX_FRAMES } from "@/lib/domain/attachmentPreview";
import { createPreviewThumbnail, validatePreviewImage } from "./previewImage";

// Independent encoded GIF fixture: each frame contains one black pixel.
const gifHeader = Buffer.from("47494638396101000100800000000000ffffff", "hex");
const gifFrame = Buffer.from("21f90400010000002c0000000001000100000202440100", "hex");
function gif(frames: number) {
  return Buffer.concat([gifHeader, ...Array.from({ length: frames }, () => gifFrame), Buffer.from([0x3b])]);
}

describe("file preview image validation", () => {
  it("fully validates bounded animated GIFs and makes a static first-frame thumbnail", async () => {
    const bytes = gif(PREVIEW_MAX_FRAMES);
    expect((await sharp(bytes, { animated: true }).metadata()).pages).toBe(PREVIEW_MAX_FRAMES);
    await expect(validatePreviewImage(bytes, "image/gif")).resolves.toBeUndefined();
    const thumbnail = await createPreviewThumbnail(bytes);
    const metadata = await sharp(thumbnail).metadata();
    expect(metadata).toMatchObject({ format: "webp", width: 1, height: 1 });
    expect(metadata.pages ?? 1).toBe(1);
    expect(Buffer.from(thumbnail).equals(bytes)).toBe(false);
  });

  it("rejects excessive frames, aggregate pixels, byte overflow and corruption in a later frame", async () => {
    await expect(validatePreviewImage(gif(PREVIEW_MAX_FRAMES + 1), "image/gif")).rejects.toThrow();
    const bomb = gif(2);
    // Each frame is legal alone; their stacked pixel count exceeds the bound.
    bomb.writeUInt16LE(4096, 6);
    bomb.writeUInt16LE(2049, 8);
    expect(4096 * 2049 * 2).toBeGreaterThan(IMAGE_MAX_PIXELS);
    await expect(validatePreviewImage(bomb, "image/gif")).rejects.toThrow();
    await expect(validatePreviewImage(Buffer.alloc(IMAGE_MAX_BYTES + 1), "image/gif")).rejects.toThrow();
    const corrupt = Buffer.concat([gifHeader, gifFrame, gifFrame.subarray(0, gifFrame.length - 3), Buffer.from([0x3b])]);
    await expect(validatePreviewImage(corrupt, "image/gif")).rejects.toThrow();
  });

  it.each(["png", "jpeg", "webp"] as const)("retains the strict %s provider validator and thumbnail bounds", async format => {
    const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: "#123456" } })[format]().toBuffer();
    await expect(validatePreviewImage(bytes, `image/${format}`)).resolves.toBeUndefined();
    await expect(validatePreviewImage(bytes, "image/gif")).rejects.toThrow();
    const thumbnail = await createPreviewThumbnail(bytes);
    expect(await sharp(thumbnail).metadata()).toMatchObject({ format: "webp", width: 160, height: 100 });
    expect(Buffer.from(thumbnail).equals(bytes)).toBe(false);
  });

  it("does not admit GIF through a forged static MIME type or active SVG as an image", async () => {
    await expect(validatePreviewImage(gif(2), "image/png")).rejects.toThrow();
    await expect(validatePreviewImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>'), "image/svg+xml")).rejects.toThrow();
  });

  it("accepts encoder-produced GIF extensions and rejects truncated block envelopes", async () => {
    const encoded = await sharp({ create: { width: 8, height: 8, channels: 3, background: "blue" } }).gif().toBuffer();
    await expect(validatePreviewImage(encoded, "image/gif")).resolves.toBeUndefined();
    for (const length of [6, 13, encoded.length - 1]) {
      await expect(validatePreviewImage(encoded.subarray(0, length), "image/gif")).rejects.toThrow();
    }
    await expect(validatePreviewImage(Buffer.concat([gif(1), Buffer.from("trailing bytes")]), "image/gif")).rejects.toThrow();
  });

  it("orients a camera thumbnail like the original browser image", async () => {
    const bytes = await sharp({ create: { width: 320, height: 200, channels: 3, background: "red" } })
      .withMetadata({ orientation: 6 }).jpeg().toBuffer();
    await validatePreviewImage(bytes, "image/jpeg");
    expect(await sharp(await createPreviewThumbnail(bytes)).metadata()).toMatchObject({ width: 100, height: 160 });
  });
});
