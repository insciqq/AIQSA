import { IMAGE_MAX_BYTES, IMAGE_MIME_TYPES } from "@/lib/contracts/imageGeneration";
import type { AttachmentPreviewKind } from "@/lib/contracts/uploads";
import { UPLOAD_FORMAT_REGISTRY } from "./uploadFormats";

export const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
/** The viewer's refusal before parsing; the same as the hard upload ceiling, so it only ever stops an unusual file. */
export const PDF_PREVIEW_MAX_BYTES = 67_108_864;
export const PREVIEW_MAX_FRAMES = 600;
export const PREVIEW_THUMB_SIZE = 160;
/** Inline and viewer previews of larger static images are downscaled to fit this box; Download serves the original. */
export const PREVIEW_IMAGE_MAX_SIZE = 2560;

const imageMimeTypes: ReadonlySet<string> = new Set([...IMAGE_MIME_TYPES, "image/gif"]);
const textFormats = new Set(["text", "markdown", "html", "json", "csv"]);
const textExtensions: ReadonlySet<string> = new Set([
  ...UPLOAD_FORMAT_REGISTRY.filter(format => textFormats.has(format.id)).flatMap(format => format.extensions),
  ".xml", ".yaml", ".yml", ".toml", ".ini", ".log", ".py", ".js", ".mjs", ".cjs",
  ".ts", ".tsx", ".jsx", ".css", ".scss", ".sh", ".sql", ".svg"
]);

/** A file name the text preview can serve, size and readiness aside. */
export function isTextPreviewFileName(fileName: string): boolean {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 && textExtensions.has(fileName.slice(dot).toLowerCase());
}

export function isPdfFileName(fileName: string): boolean {
  return fileName.length > 4 && fileName.toLowerCase().endsWith(".pdf");
}

/** Eligibility is a projection, never read authority or a substitute for validating original bytes. */
export function attachmentPreviewKind(input: Readonly<{
  byteSize: number;
  fileName: string;
  mimeType: string;
  status: string;
}>): AttachmentPreviewKind {
  if (input.status !== "ready" || !Number.isSafeInteger(input.byteSize) || input.byteSize < 1) return null;
  if (imageMimeTypes.has(input.mimeType)) return input.byteSize <= IMAGE_MAX_BYTES ? "image" : null;
  if (input.mimeType === "application/pdf" || isPdfFileName(input.fileName)) return input.byteSize <= PDF_PREVIEW_MAX_BYTES ? "pdf" : null;
  return input.byteSize <= TEXT_PREVIEW_MAX_BYTES && isTextPreviewFileName(input.fileName) ? "text" : null;
}
