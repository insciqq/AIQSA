import sharp from "sharp";
import { extractImageMetadata } from "../uploads/imageMetadata";
import { convertRasterForProvider, ProviderRasterConversionError, providerRasterNeedsConversion } from "../uploads/providerRasterConversion";
import { StaticRasterError, validateStaticRaster } from "../uploads/staticRaster";
import { DEFAULT_PREVIEW_FIT } from "../workspace/directImageView";
import { transformStaticImage, WorkspaceImageError, WORKSPACE_IMAGE_LIMITS } from "../workspace/imageCapture";
import { ImageInputError } from "./inputError";

export type RasterPreview = Readonly<{
  /** The preview, PNG, fitted to `DEFAULT_PREVIEW_FIT`. */
  bytes: Buffer;
  width: number;
  height: number;
  mimeType: "image/png";
  /** The decoded image's own size. */
  source: Readonly<{ width: number; height: number }>;
}>;

/**
 * A bounded preview of a static raster for a model to see: BMP and TIFF converted to PNG, a GIF's single frame (an
 * animated one refused), PNG, JPEG or WebP validated under `WORKSPACE_IMAGE_LIMITS`, then fitted to
 * `DEFAULT_PREVIEW_FIT`. Bytes that are not the declared type's or break a bound fail with
 * `ImageInputError("image_reference_unsupported")`; the caller bounds the source's size and the time (`signal`).
 */
export async function rasterPreview(bytes: Buffer, mimeType: string, signal: AbortSignal): Promise<RasterPreview> {
  try {
    let decoded = providerRasterNeedsConversion(mimeType)
      ? await convertRasterForProvider(bytes, mimeType, WORKSPACE_IMAGE_LIMITS, signal) : bytes;
    if (mimeType === "image/gif") {
      const gif = extractImageMetadata(decoded, mimeType);
      if (gif.animated || gif.width * gif.height > WORKSPACE_IMAGE_LIMITS.maxPixels ||
        Math.max(gif.width, gif.height) > WORKSPACE_IMAGE_LIMITS.maxDimension) throw new ImageInputError("image_reference_unsupported");
      decoded = await sharp(decoded, { limitInputPixels: WORKSPACE_IMAGE_LIMITS.maxPixels, failOn: "warning" }).timeout({ seconds: 8 }).png().toBuffer();
    }
    const metadata = await validateStaticRaster(decoded, { ...WORKSPACE_IMAGE_LIMITS, mimeTypes: ["image/png", "image/jpeg", "image/webp"] },
      { signal });
    const preview = await transformStaticImage(decoded, metadata, DEFAULT_PREVIEW_FIT, signal);
    signal.throwIfAborted();
    return { bytes: preview.output, height: preview.dimensions.height, mimeType: "image/png",
      source: { height: metadata.height, width: metadata.width }, width: preview.dimensions.width };
  } catch (error) {
    if (error instanceof StaticRasterError || error instanceof WorkspaceImageError || error instanceof ProviderRasterConversionError) {
      throw new ImageInputError("image_reference_unsupported");
    }
    throw error;
  }
}
