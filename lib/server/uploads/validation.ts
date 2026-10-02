import { IMAGE_MAX_BYTES } from "../../contracts/imageGeneration";
import {
  UPLOAD_FORMAT_REGISTRY,
  isNormalizableRasterUploadFormat,
  uploadAdmissionFormatFor,
  uploadFormatFor,
  uploadFormatForExtension,
  isSafeUploadFileName,
  normalizedUploadMimeType,
  type UploadContentEvidence,
  type UploadFormatDefinition,
  type UploadFormatScope,
  type UploadKind
} from "../../domain/uploadFormats";

export type { UploadKind } from "../../domain/uploadFormats";

export type UploadValidationInput = {
  byteSize: number;
  bytes?: Buffer | Uint8Array;
  fileName: string;
  maxBytes: number;
  mimeType: string;
  scope?: UploadFormatScope;
};

export type UploadInspectionInput = Omit<UploadValidationInput, "bytes"> & Readonly<{
  foundNeedles: readonly string[];
  sample: Buffer | Uint8Array;
}>;

export type UploadValidationResult =
  | {
      kind: UploadKind;
      mimeType: string;
      ok: true;
      /**
       * Set when the content is a static raster other than the declared one:
       * the caller must fully decode it as this format before admission.
       */
      rasterCheck?: UploadFormatDefinition;
    }
  | {
      code: "file_required" | "file_too_large" | "image_limit_exceeded" | "unsupported_type";
      ok: false;
    };

export const DEFAULT_UPLOAD_MAX_BYTES = 25_000_000;
export const MAX_UPLOAD_MAX_BYTES = 67_108_864;

export const UPLOAD_CONTENT_INSPECTION_NEEDLES = Object.freeze([
  "[Content_Types].xml",
  "META-INF/container.xml",
  "META-INF/manifest.xml",
  "application/epub+zip",
  "application/vnd.oasis.opendocument.presentation",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.text",
  "content.xml",
  "mimetype",
  "ppt/",
  "word/",
  "xl/"
] as const);

function bytesStartWith(bytes: Buffer | Uint8Array, signature: readonly number[]): boolean {
  return bytes.byteLength >= signature.length &&
    signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Buffer | Uint8Array, start = 0, end = bytes.byteLength): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function textSample(bytes: Buffer | Uint8Array, partial = false): string | null {
  if (bytes.byteLength === 0) return null;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1_024));
  if (sample.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(sample, { stream: partial || bytes.byteLength > sample.byteLength }).replace(/^\uFEFF/u, "");
  } catch {
    return null;
  }
}

function zipContains(bytes: Buffer | Uint8Array, marker: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(marker, "utf8"));
}

function zipEvidence(
  bytes: Buffer | Uint8Array,
  required: readonly string[],
  forbidden: readonly string[] = []
): boolean {
  return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04]) &&
    required.every((marker) => zipContains(bytes, marker)) &&
    forbidden.every((marker) => !zipContains(bytes, marker));
}

function inspectedZipEvidence(
  sample: Buffer | Uint8Array,
  found: ReadonlySet<string>,
  required: readonly string[],
  forbidden: readonly string[] = []
): boolean {
  return bytesStartWith(sample, [0x50, 0x4b, 0x03, 0x04]) &&
    required.every((marker) => found.has(marker)) &&
    forbidden.every((marker) => !found.has(marker));
}

function matchesEvidence(
  evidence: UploadContentEvidence,
  bytes: Buffer | Uint8Array,
  partial = false
): boolean {
  const sample = evidence === "text" || evidence === "html" || evidence === "json" || evidence === "eml"
    ? textSample(bytes, partial)
    : null;

  switch (evidence) {
    case "bmp":
      return ascii(bytes, 0, 2) === "BM";
    case "eml":
      return sample !== null && /^(?:from|to|subject|date|message-id|mime-version):[^\r\n]*$/imu.test(sample);
    case "epub":
      return zipEvidence(bytes, ["mimetype", "application/epub+zip", "META-INF/container.xml"]);
    case "gif":
      return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
    case "html":
      return sample !== null && /<\s*(?:!doctype\s+html|html|head|body|article|main|p|h[1-6])\b/iu.test(sample);
    case "jpeg":
      return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
    case "json": {
      if (sample === null) return false;
      const trimmed = sample.trim();
      return trimmed.startsWith("{") || trimmed.startsWith("[");
    }
    case "ole":
      return bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "open_document_presentation":
      return zipEvidence(
        bytes,
        ["content.xml", "META-INF/manifest.xml", "application/vnd.oasis.opendocument.presentation"],
        ["application/vnd.oasis.opendocument.spreadsheet", "application/vnd.oasis.opendocument.text"]
      );
    case "open_document_spreadsheet":
      return zipEvidence(
        bytes,
        ["content.xml", "META-INF/manifest.xml", "application/vnd.oasis.opendocument.spreadsheet"],
        ["application/vnd.oasis.opendocument.presentation", "application/vnd.oasis.opendocument.text"]
      );
    case "open_document_text":
      return zipEvidence(
        bytes,
        ["content.xml", "META-INF/manifest.xml", "application/vnd.oasis.opendocument.text"],
        ["application/vnd.oasis.opendocument.presentation", "application/vnd.oasis.opendocument.spreadsheet"]
      );
    case "pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    case "png":
      return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "presentation_ooxml":
      return zipEvidence(bytes, ["[Content_Types].xml", "ppt/"], ["word/", "xl/"]);
    case "rtf":
      return ascii(bytes, 0, 5) === "{\\rtf";
    case "spreadsheet_ooxml":
      return zipEvidence(bytes, ["[Content_Types].xml", "xl/"], ["word/", "ppt/"]);
    case "text":
      return sample !== null;
    case "tiff":
      return bytesStartWith(bytes, [0x49, 0x49, 0x2a, 0x00]) ||
        bytesStartWith(bytes, [0x4d, 0x4d, 0x00, 0x2a]);
    case "webp":
      return bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    case "word_ooxml":
      return zipEvidence(bytes, ["[Content_Types].xml", "word/"], ["ppt/", "xl/"]);
  }
}

export function uploadContentMatchesFormat(
  format: UploadFormatDefinition,
  bytes: Buffer | Uint8Array
): boolean {
  return matchesEvidence(format.contentEvidence, bytes);
}

export function uploadInspectionMatchesFormat(
  format: UploadFormatDefinition,
  inspection: Readonly<{
    foundNeedles: readonly string[];
    sample: Buffer | Uint8Array;
    partial?: boolean;
  }>
): boolean {
  const found = new Set(inspection.foundNeedles);
  const sample = inspection.sample;
  switch (format.contentEvidence) {
    case "epub":
      return inspectedZipEvidence(sample, found, [
        "mimetype",
        "application/epub+zip",
        "META-INF/container.xml"
      ]);
    case "open_document_presentation":
      return inspectedZipEvidence(sample, found, [
        "content.xml",
        "META-INF/manifest.xml",
        "application/vnd.oasis.opendocument.presentation"
      ], [
        "application/vnd.oasis.opendocument.spreadsheet",
        "application/vnd.oasis.opendocument.text"
      ]);
    case "open_document_spreadsheet":
      return inspectedZipEvidence(sample, found, [
        "content.xml",
        "META-INF/manifest.xml",
        "application/vnd.oasis.opendocument.spreadsheet"
      ], [
        "application/vnd.oasis.opendocument.presentation",
        "application/vnd.oasis.opendocument.text"
      ]);
    case "open_document_text":
      return inspectedZipEvidence(sample, found, [
        "content.xml",
        "META-INF/manifest.xml",
        "application/vnd.oasis.opendocument.text"
      ], [
        "application/vnd.oasis.opendocument.presentation",
        "application/vnd.oasis.opendocument.spreadsheet"
      ]);
    case "presentation_ooxml":
      return inspectedZipEvidence(sample, found, ["[Content_Types].xml", "ppt/"], ["word/", "xl/"]);
    case "spreadsheet_ooxml":
      return inspectedZipEvidence(sample, found, ["[Content_Types].xml", "xl/"], ["word/", "ppt/"]);
    case "word_ooxml":
      return inspectedZipEvidence(sample, found, ["[Content_Types].xml", "word/"], ["ppt/", "xl/"]);
    default:
      return matchesEvidence(format.contentEvidence, sample, inspection.partial);
  }
}

export function defaultUploadMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.AIQSA_UPLOAD_MAX_BYTES);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_UPLOAD_MAX_BYTES
    ? parsed
    : DEFAULT_UPLOAD_MAX_BYTES;
}

type UploadAdmission =
  | Readonly<{ format: UploadFormatDefinition; mimeDisagrees: boolean; type: "format" }>
  | Readonly<{ result: UploadValidationResult; type: "result" }>;

function uploadAdmission(input: UploadValidationInput): UploadAdmission {
  if (!input.fileName || input.byteSize <= 0) {
    return { result: { code: "file_required", ok: false }, type: "result" };
  }
  if (!isSafeUploadFileName(input.fileName)) return { result: { code: "unsupported_type", ok: false }, type: "result" };
  if (input.byteSize > input.maxBytes) return { result: { code: "file_too_large", ok: false }, type: "result" };

  const scope = input.scope ?? "attachment";
  const format = uploadAdmissionFormatFor(input.fileName, input.mimeType, scope);
  if (!format && scope === "workspace") {
    if (uploadFormatForExtension(input.fileName, scope)) {
      return { result: { code: "unsupported_type", ok: false }, type: "result" };
    }
    return {
      result: {
        kind: "file",
        mimeType: normalizedUploadMimeType(input.mimeType) ?? "application/octet-stream",
        ok: true
      },
      type: "result"
    };
  }
  if (!format) return { result: { code: "unsupported_type", ok: false }, type: "result" };
  // Only a static-raster pair can be admitted while its MIME names another raster.
  return { format, mimeDisagrees: !uploadFormatFor(input.fileName, input.mimeType, scope), type: "format" };
}

/**
 * Admits content that matches the declared format unchanged. A static-raster
 * pair whose content is another static raster, or whose extension and MIME name
 * different rasters, is admitted only pending a full decode by the caller.
 */
function admittedContent(
  input: UploadValidationInput,
  admission: Readonly<{ format: UploadFormatDefinition; mimeDisagrees: boolean }>,
  matches: (format: UploadFormatDefinition) => boolean
): UploadValidationResult {
  const { format } = admission;
  if (!admission.mimeDisagrees && matches(format)) {
    return { kind: format.kind, mimeType: format.canonicalMimeType, ok: true };
  }
  const scope = input.scope ?? "attachment";
  const detected = isNormalizableRasterUploadFormat(format, scope)
    ? UPLOAD_FORMAT_REGISTRY.find((candidate) => isNormalizableRasterUploadFormat(candidate, scope) && matches(candidate))
    : undefined;
  if (!detected) return { code: "unsupported_type", ok: false };
  if (input.byteSize > IMAGE_MAX_BYTES) return { code: "image_limit_exceeded", ok: false };
  return { kind: detected.kind, mimeType: detected.canonicalMimeType, ok: true, rasterCheck: detected };
}

export function validateUpload(input: UploadValidationInput): UploadValidationResult {
  const admission = uploadAdmission(input);
  if (admission.type === "result") return admission.result;
  const { format, mimeDisagrees } = admission;
  if (!input.bytes) {
    // Extension and MIME naming different rasters always require a full decode.
    if (mimeDisagrees && input.byteSize > IMAGE_MAX_BYTES) return { code: "image_limit_exceeded", ok: false };
    return { kind: format.kind, mimeType: format.canonicalMimeType, ok: true };
  }
  const bytes = input.bytes;
  return admittedContent(input, admission, (candidate) => uploadContentMatchesFormat(candidate, bytes));
}

export function validateUploadInspection(input: UploadInspectionInput): UploadValidationResult {
  const admission = uploadAdmission(input);
  if (admission.type === "result") return admission.result;
  const inspection = { ...input, partial: input.byteSize > input.sample.byteLength };
  return admittedContent(input, admission, (candidate) => uploadInspectionMatchesFormat(candidate, inspection));
}
