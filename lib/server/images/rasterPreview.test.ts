// @vitest-environment node
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { extractImageMetadata } from "../uploads/imageMetadata";
import { rasterPreview } from "./rasterPreview";

/** A GIF whose header reads but whose image data stops early, so only the decoder refuses it. */
async function truncatedGif(): Promise<Buffer> {
  const gif = await sharp({ create: { background: "red", channels: 3, height: 20, width: 20 } }).gif().toBuffer();
  return Buffer.concat([gif.subarray(0, 40), Buffer.from([0x3b])]);
}

describe("an image preview", () => {
  it("fits a static image to the preview box and keeps its own size", async () => {
    const png = await sharp({ create: { background: "#123456", channels: 3, height: 600, width: 1600 } }).png().toBuffer();
    const preview = await rasterPreview(png, "image/png", new AbortController().signal);
    expect(preview).toMatchObject({ height: 384, mimeType: "image/png", source: { height: 600, width: 1600 }, width: 1024 });
  });

  it("refuses bytes a decoder fails on as image_reference_unsupported, never as a bare decoder error", async () => {
    const gif = await truncatedGif();
    expect(extractImageMetadata(gif, "image/gif")).toMatchObject({ animated: false, height: 20, width: 20 });
    await expect(rasterPreview(gif, "image/gif", new AbortController().signal)).rejects.toMatchObject({
      code: "image_reference_unsupported", name: "ImageInputError" });
    await expect(rasterPreview(Buffer.from("not an image"), "image/png", new AbortController().signal)).rejects.toMatchObject({
      code: "image_reference_unsupported" });
    await expect(rasterPreview(Buffer.from("BMnot a bitmap"), "image/bmp", new AbortController().signal)).rejects.toMatchObject({
      code: "image_reference_unsupported" });
  });

  it("throws the caller's abort as it is", async () => {
    const stop = new AbortController();
    const reason = new Error("stopped");
    stop.abort(reason);
    const png = await sharp({ create: { background: "#123456", channels: 3, height: 10, width: 10 } }).png().toBuffer();
    const error = await rasterPreview(png, "image/png", stop.signal).then(() => null, (thrown: unknown) => thrown);
    expect(error).not.toBeNull();
    expect(error).not.toMatchObject({ code: "image_reference_unsupported" });
  });
});
