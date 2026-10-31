import sharp from "sharp";

/**
 * The most an image may measure when it goes to a chat model: OpenAI's patch
 * models refuse more than 30000 patches of 32 px, which rejects a 50 MP phone
 * photo outright (`invalid_value`). One limit for every model keeps one behaviour
 * (operator decision 2026-10-31): the others scale such an image down themselves
 * or have no use for more. The stored file is never changed.
 */
export const PROVIDER_IMAGE_MAX_PATCHES = 30_000;
const PATCH_PX = 32;
const QUALITY = 90;

function patches(width: number, height: number): number {
  return Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX);
}

/** The size to send an image at, or null when it fits as it is. */
export function providerImageTargetSize(width: number, height: number): Readonly<{ height: number; width: number }> | null {
  const measured = patches(width, height);
  if (measured <= PROVIDER_IMAGE_MAX_PATCHES) return null;
  let scale = Math.sqrt(PROVIDER_IMAGE_MAX_PATCHES / measured);
  const scaled = () => ({ height: Math.max(1, Math.floor(height * scale)), width: Math.max(1, Math.floor(width * scale)) });
  // Each side rounds up to a whole patch, so the first guess can land just over.
  while (patches(scaled().width, scaled().height) > PROVIDER_IMAGE_MAX_PATCHES) scale *= 0.995;
  return scaled();
}

const ENCODED_TYPES = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as const;

export type FittedProviderImage = Readonly<{ bytes: Buffer; height: number; mimeType: string; width: number }>;

/**
 * A copy within the limit, keeping the format and the way the photo is turned.
 * Null for an image that fits, or whose header cannot be read: that one goes as
 * it always did, and the provider's answer stands. Throws when an image over
 * the limit cannot be resized.
 */
export async function fitImageForProvider(bytes: Buffer, signal?: AbortSignal): Promise<FittedProviderImage | null> {
  const metadata = await sharp(bytes, { failOn: "none" }).metadata().catch(() => null);
  if (!metadata?.width || !metadata.height || !(metadata.format in ENCODED_TYPES)) return null;
  const format = metadata.format as keyof typeof ENCODED_TYPES;
  // Orientations 5 to 8 lie on their side: the sent copy is upright, so its sides swap.
  const sideways = (metadata.orientation ?? 1) >= 5;
  const target = sideways ? providerImageTargetSize(metadata.height, metadata.width)
    : providerImageTargetSize(metadata.width, metadata.height);
  if (!target) return null;
  signal?.throwIfAborted();
  const resized = sharp(bytes, { failOn: "none" }).rotate().timeout({ seconds: 30 })
    .resize({ fit: "fill", height: target.height, width: target.width });
  const encoded = format === "jpeg" ? resized.jpeg({ quality: QUALITY })
    : format === "webp" ? resized.webp({ quality: QUALITY }) : resized.png();
  const output = await encoded.toBuffer();
  signal?.throwIfAborted();
  return { bytes: output, height: target.height, mimeType: ENCODED_TYPES[format], width: target.width };
}
