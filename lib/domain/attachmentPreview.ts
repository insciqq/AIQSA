import { IMAGE_MAX_BYTES, IMAGE_MIME_TYPES } from "@/lib/contracts/imageGeneration";
import type { AttachmentPreviewKind } from "@/lib/contracts/uploads";
import { UPLOAD_FORMAT_REGISTRY } from "./uploadFormats";

export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
export const PREVIEW_MAX_FRAMES = 600;
export const PREVIEW_THUMB_SIZE = 160;

const imageMimeTypes: ReadonlySet<string> = new Set([...IMAGE_MIME_TYPES, "image/gif"]);
const textFormats = new Set(["text", "markdown", "html", "json", "csv"]);
const textExtensions: ReadonlySet<string> = new Set([
  ...UPLOAD_FORMAT_REGISTRY.filter(format => textFormats.has(format.id)).flatMap(format => format.extensions),
  ".xml", ".yaml", ".yml", ".toml", ".ini", ".log", ".py", ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx", ".css", ".scss", ".sh", ".sql", ".svg"
]);

/** Eligibility is a projection, never read authority or a substitute for validating original bytes. */
export function attachmentPreviewKind(input: Readonly<{
  byteSize: number;
  fileName: string;
  mimeType: string;
  status: string;
}>): AttachmentPreviewKind {
  if (input.status !== "ready" || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1) return null;
  if (imageMimeTypes.has(input.mimeType)) return input.byteSize <= IMAGE_MAX_BYTES ? "image" : null;
  const dot = input.fileName.lastIndexOf(".");
  const extension = dot > 0 ? input.fileName.slice(dot).toLowerCase() : "";
  return input.byteSize <= TEXT_PREVIEW_MAX_BYTES && textExtensions.has(extension) ? "text" : null;
}
