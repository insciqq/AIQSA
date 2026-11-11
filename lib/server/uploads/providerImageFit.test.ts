import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { fitImageForProvider, gifStillFrameForProvider, oneResizeAtATime, PROVIDER_IMAGE_MAX_PATCHES, ProviderImageFrameError,
  ProviderImageTooLargeError, providerImageTargetSize } from "./providerImageFit";

const measured = (width: number, height: number) => Math.ceil(width / 32) * Math.ceil(height / 32);
const flat = (width: number, height: number) => sharp({ create: { background: "#808080", channels: 3, height, width } });

describe("the size of an image sent to a model", () => {
  it("leaves an image within the limit alone, up to exactly the limit", () => {
    expect(providerImageTargetSize(4000, 3000)).toBeNull();
    expect(providerImageTargetSize(6400, 4800)).toBeNull();
    expect(measured(6400, 4800)).toBe(PROVIDER_IMAGE_MAX_PATCHES);
  });

  it("fits a 50 MP photo with its proportions", () => {
    const target = providerImageTargetSize(8160, 6120)!;
    expect(measured(target.width, target.height)).toBeLessThanOrEqual(PROVIDER_IMAGE_MAX_PATCHES);
    expect(target.width * target.height).toBeGreaterThan(28_000_000);
    expect(target.width / target.height).toBeCloseTo(8160 / 6120, 2);
  });

  it("fits narrow panoramas, whose sides round up", () => {
    for (const [width, height] of [[20_000, 3_000], [3_000, 20_000], [16_383, 2_100]] as const) {
      const target = providerImageTargetSize(width, height)!;
      expect(measured(target.width, target.height)).toBeLessThanOrEqual(PROVIDER_IMAGE_MAX_PATCHES);
    }
  });
});

describe("the copy of an oversized image", () => {
  it.each([
    ["jpeg", "image/jpeg", (image: ReturnType<typeof sharp>) => image.jpeg()],
    ["png", "image/png", (image: ReturnType<typeof sharp>) => image.png()],
    ["webp", "image/webp", (image: ReturnType<typeof sharp>) => image.webp()]
  ] as const)("keeps the %s format and fits the limit", async (format, mimeType, encode) => {
    const fitted = (await fitImageForProvider(await encode(flat(6500, 4900)).toBuffer()))!;
    const copy = await sharp(fitted.bytes).metadata();
    expect(fitted.mimeType).toBe(mimeType);
    expect(copy.format).toBe(format);
    expect({ height: copy.height, width: copy.width }).toEqual({ height: fitted.height, width: fitted.width });
    expect(measured(copy.width!, copy.height!)).toBeLessThanOrEqual(PROVIDER_IMAGE_MAX_PATCHES);
    // Encoding a 6500×4900 source twice takes seconds; under a loaded full suite the webp case passed 5 s.
  }, 30_000);

  it("keeps a photo that lies on its side upright", async () => {
    // A landscape sensor image a phone held upright: orientation 6 means it shows as portrait.
    const source = await flat(6500, 4900).withMetadata({ orientation: 6 }).jpeg().toBuffer();
    const fitted = (await fitImageForProvider(source))!;
    const copy = await sharp(fitted.bytes).metadata();
    expect(copy.height!).toBeGreaterThan(copy.width!);
    expect(copy.orientation ?? 1).toBe(1);
  });

  it("does not touch an image within the limit, nor one it cannot read", async () => {
    expect(await fitImageForProvider(await flat(100, 100).jpeg().toBuffer())).toBeNull();
    expect(await fitImageForProvider(Buffer.from("not an image"))).toBeNull();
  });

  it("refuses a source too large to decode safely, however small its file", async () => {
    const source = await flat(11_000, 10_100).jpeg({ quality: 10 }).toBuffer();
    expect(source.length).toBeLessThan(5_000_000);
    await expect(fitImageForProvider(source)).rejects.toBeInstanceOf(ProviderImageTooLargeError);
  });

  it("holds a progressive source, which buffers every scan, to a lower bound", async () => {
    const big = flat(8000, 7800);
    await expect(fitImageForProvider(await big.clone().jpeg({ progressive: true, quality: 10 }).toBuffer()))
      .rejects.toBeInstanceOf(ProviderImageTooLargeError);
    expect(await fitImageForProvider(await big.clone().jpeg({ quality: 10 }).toBuffer())).not.toBeNull();
  });

  it("resizes one image at a time, and a failed one does not stop the next", async () => {
    let running = 0;
    let most = 0;
    const work = (fails: boolean) => oneResizeAtATime(async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      if (fails) throw new Error("resize failed");
      return "done";
    });
    const results = await Promise.allSettled([work(false), work(true), work(false)]);
    expect(most).toBe(1);
    expect(results.map((result) => result.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  });

  it("stops when the run was cancelled", async () => {
    const source = await flat(6500, 4900).jpeg().toBuffer();
    await expect(fitImageForProvider(source, AbortSignal.abort(new Error("stopped")))).rejects.toThrow("stopped");
  });
});

describe("the still frame of an animated GIF", () => {
  const animated = async (width: number, height: number, colors: readonly string[]) => sharp(
    await Promise.all(colors.map((background) => sharp({ create: { background, channels: 3, height, width } }).png().toBuffer())),
    { join: { animated: true } }).gif({ delay: 100 }).toBuffer();

  it("is the first frame as a single-page PNG, at its own size when it fits", async () => {
    const frame = await gifStillFrameForProvider(await animated(40, 30, ["#ff0000", "#00ff00", "#0000ff"]));
    const decoded = await sharp(frame.bytes, { animated: true }).metadata();
    expect(frame).toMatchObject({ height: 30, mimeType: "image/png", width: 40 });
    expect(decoded).toMatchObject({ format: "png", height: 30, width: 40 });
    expect(decoded.pages ?? 1).toBe(1);
    const [red, green, blue] = (await sharp(frame.bytes).stats()).channels.map((channel) => Math.round(channel.mean));
    expect({ blue, green, red }).toEqual({ blue: 0, green: 0, red: 255 });
  });

  it("fits the same patch limit as every other image", async () => {
    const frame = await gifStillFrameForProvider(await animated(6500, 4900, ["#808080", "#000000"]));
    const copy = await sharp(frame.bytes).metadata();
    expect({ format: copy.format, height: copy.height, width: copy.width })
      .toEqual({ format: "png", height: frame.height, width: frame.width });
    expect(measured(frame.width, frame.height)).toBeLessThanOrEqual(PROVIDER_IMAGE_MAX_PATCHES);
    expect(frame.width / frame.height).toBeCloseTo(6500 / 4900, 2);
  });

  it("refuses bytes that are no GIF, and stops when the run was cancelled", async () => {
    await expect(gifStillFrameForProvider(Buffer.from("GIF89a not really"))).rejects.toBeInstanceOf(ProviderImageFrameError);
    await expect(gifStillFrameForProvider(await flat(10, 10).png().toBuffer())).rejects.toBeInstanceOf(ProviderImageFrameError);
    await expect(gifStillFrameForProvider(await animated(10, 10, ["#ff0000", "#00ff00"]), AbortSignal.abort(new Error("stopped"))))
      .rejects.toThrow("stopped");
  });
});
