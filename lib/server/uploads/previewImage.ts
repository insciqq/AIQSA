import sharp from "sharp";
import { IMAGE_MAX_BYTES, IMAGE_MAX_PIXELS } from "@/lib/contracts/imageGeneration";
import { PREVIEW_MAX_FRAMES, PREVIEW_THUMB_SIZE } from "@/lib/domain/attachmentPreview";
import { validateGeneratedImage } from "../providers/imageGeneration";

/** libvips repairs some truncated GIFs; require complete framing before decoding. */
function gifEnvelope(bytes: Uint8Array): { frames: number; canvasPixels: number } {
  const invalid = () => new Error("image_preview_invalid");
  if (bytes.byteLength < 14 || bytes.byteLength > IMAGE_MAX_BYTES ||
    !["GIF87a", "GIF89a"].includes(Buffer.from(bytes.subarray(0, 6)).toString("ascii"))) throw invalid();
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = header.getUint16(6, true);
  const height = header.getUint16(8, true);
  const canvasPixels = width * height;
  if (!canvasPixels || canvasPixels > IMAGE_MAX_PIXELS) throw invalid();
  let offset = 13;
  let frames = 0;
  const skip = (size: number) => {
    offset += size;
    if (offset > bytes.byteLength) throw invalid();
  };
  const colorTable = (flags: number) => { if (flags & 0x80) skip(3 * (2 ** ((flags & 7) + 1))); };
  const blocks = () => {
    for (;;) {
      if (offset >= bytes.byteLength) throw invalid();
      const size = bytes[offset++];
      if (size === 0) return;
      skip(size);
    }
  };
  colorTable(bytes[10]);
  while (offset < bytes.byteLength) {
    const marker = bytes[offset++];
    if (marker === 0x3b) {
      if (!frames || offset !== bytes.byteLength) throw invalid();
      return { frames, canvasPixels };
    }
    if (marker === 0x21) {
      skip(1); // Extension label, followed by length-prefixed data blocks.
      blocks();
    } else if (marker === 0x2c) {
      const start = offset;
      skip(9);
      const frameWidth = header.getUint16(start + 4, true);
      const frameHeight = header.getUint16(start + 6, true);
      if (!frameWidth || !frameHeight || header.getUint16(start, true) + frameWidth > width ||
        header.getUint16(start + 2, true) + frameHeight > height) throw invalid();
      frames++;
      if (frames > PREVIEW_MAX_FRAMES || frames * canvasPixels > IMAGE_MAX_PIXELS) throw invalid();
      colorTable(bytes[start + 8]);
      if (offset >= bytes.byteLength || bytes[offset] < 2 || bytes[offset] > 8) throw invalid();
      skip(1); // LZW minimum code size; compressed pixels are validated by sharp.
      blocks();
    } else throw invalid();
  }
  throw invalid();
}

/** Provider output retains its stricter single-frame boundary; only file previews admit GIF. */
export async function validatePreviewImage(bytes: Uint8Array, mimeType: string): Promise<void> {
  if (mimeType !== "image/gif") {
    await validateGeneratedImage(bytes, mimeType);
    return;
  }
  const envelope = gifEnvelope(bytes);
  const decoder = sharp(bytes, { animated: true, limitInputPixels: IMAGE_MAX_PIXELS, failOn: "warning" });
  const metadata = await decoder.metadata();
  const pages = metadata.pages ?? 1;
  if (metadata.format !== "gif" || !metadata.width || !metadata.height ||
    !Number.isSafeInteger(pages) || pages !== envelope.frames ||
    metadata.width * metadata.height > IMAGE_MAX_PIXELS ||
    envelope.canvasPixels * pages > IMAGE_MAX_PIXELS) throw new Error("image_preview_invalid");
  // animated:true makes this a full decode of all frames, including later corrupt frames.
  await decoder.stats();
}

/** Called only after the complete original passed validation; the list never animates. */
export async function createPreviewThumbnail(bytes: Uint8Array): Promise<Uint8Array> {
  return sharp(bytes, { page: 0, pages: 1, limitInputPixels: IMAGE_MAX_PIXELS, failOn: "warning" })
    .rotate()
    .resize(PREVIEW_THUMB_SIZE, PREVIEW_THUMB_SIZE, { fit: "inside", withoutEnlargement: true })
    .webp().toBuffer();
}
