import sharp from "sharp";
import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS, IMAGE_MIME_TYPES } from "../../contracts/imageGeneration";
import { normalizedRasterUploadFileName, type UploadFormatDefinition } from "../../domain/uploadFormats";
import { StaticRasterError, validateStaticRaster } from "./staticRaster";

export type UploadRasterNormalization =
  | Readonly<{ fileName: string; mimeType: string; ok: true }>
  | Readonly<{ code: "image_invalid" | "image_limit_exceeded" | "unsupported_type"; ok: false; status: 400 | 413 }>;

const REFUSALS = {
  raster_invalid: { code: "image_invalid", status: 400 },
  raster_limit_exceeded: { code: "image_limit_exceeded", status: 413 },
  raster_unsupported: { code: "unsupported_type", status: 400 }
} as const;

/**
 * libvips enforces its input-pixel limit while reading the header, and the
 * shared decoder reports that as an invalid image. A header-only read without
 * the limit tells an over-limit image apart; it decodes no pixels.
 */
async function exceedsPixelLimit(bytes: Uint8Array): Promise<boolean> {
  try {
    const { width, height } = await sharp(bytes, { limitInputPixels: false }).metadata();
    return Boolean(width && height && width * height > IMAGE_MAX_PIXELS);
  } catch {
    return false;
  }
}

/**
 * Fully decodes an upload whose content is a static raster other than its
 * declared format, then names it after the decoded format. The bytes are never
 * re-encoded; only the file name and MIME change.
 */
export async function normalizeUploadRaster(
  bytes: Uint8Array,
  input: Readonly<{ fileName: string; format: UploadFormatDefinition; signal?: AbortSignal }>
): Promise<UploadRasterNormalization> {
  let decodedMime: string;
  try {
    decodedMime = (await validateStaticRaster(bytes, {
      maxBytes: IMAGE_MAX_BYTES, maxPixels: IMAGE_MAX_PIXELS, mimeTypes: IMAGE_MIME_TYPES
    }, { signal: input.signal })).mimeType;
  } catch (error) {
    // Cancellation is the caller's outcome, not a property of the image.
    if (!(error instanceof StaticRasterError)) throw error;
    if (error.code === "raster_invalid" && await exceedsPixelLimit(bytes)) {
      return { ...REFUSALS.raster_limit_exceeded, ok: false };
    }
    return { ...REFUSALS[error.code], ok: false };
  }
  if (decodedMime !== input.format.canonicalMimeType) return { ...REFUSALS.raster_invalid, ok: false };
  const fileName = normalizedRasterUploadFileName(input.fileName, input.format);
  if (!fileName) return { ...REFUSALS.raster_unsupported, ok: false };
  return { fileName, mimeType: input.format.canonicalMimeType, ok: true };
}
