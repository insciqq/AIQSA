import {
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
    }
  | {
      code: "file_required" | "file_too_large" | "unsupported_type";
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

function textSample(bytes: Buffer | Uint8Array): string | null {
  if (bytes.byteLength === 0) return null;
  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 64 * 1_024));
  if (sample.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(sample).replace(/^\uFEFF/u, "");
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
  bytes: Buffer | Uint8Array
): boolean {
  const sample = evidence === "text" || evidence === "html" || evidence === "json" || evidence === "eml"
    ? textSample(bytes)
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
      return matchesEvidence(format.contentEvidence, sample);
  }
}

export function defaultUploadMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.AIQSA_UPLOAD_MAX_BYTES);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_UPLOAD_MAX_BYTES
    ? parsed
    : DEFAULT_UPLOAD_MAX_BYTES;
}

export function validateUpload(input: UploadValidationInput): UploadValidationResult {
  if (!input.fileName || input.byteSize <= 0) {
    return { code: "file_required", ok: false };
  }
  if (!isSafeUploadFileName(input.fileName)) return { code: "unsupported_type", ok: false };
  if (input.byteSize > input.maxBytes) {
    return { code: "file_too_large", ok: false };
  }

  const scope = input.scope ?? "attachment";
  const format = uploadFormatFor(input.fileName, input.mimeType, scope);
  if (!format && scope === "workspace") {
    if (uploadFormatForExtension(input.fileName, scope)) {
      return { code: "unsupported_type", ok: false };
    }
    return {
      kind: "file",
      mimeType: normalizedUploadMimeType(input.mimeType) ?? "application/octet-stream",
      ok: true
    };
  }
  if (!format || (input.bytes && !uploadContentMatchesFormat(format, input.bytes))) {
    return { code: "unsupported_type", ok: false };
  }

  return {
    kind: format.kind,
    mimeType: format.canonicalMimeType,
    ok: true
  };
}

export function validateUploadInspection(input: UploadInspectionInput): UploadValidationResult {
  if (!input.fileName || input.byteSize <= 0) {
    return { code: "file_required", ok: false };
  }
  if (!isSafeUploadFileName(input.fileName)) return { code: "unsupported_type", ok: false };
  if (input.byteSize > input.maxBytes) return { code: "file_too_large", ok: false };
  const scope = input.scope ?? "attachment";
  const format = uploadFormatFor(input.fileName, input.mimeType, scope);
  if (!format && scope === "workspace") {
    if (uploadFormatForExtension(input.fileName, scope)) {
      return { code: "unsupported_type", ok: false };
    }
    return {
      kind: "file",
      mimeType: normalizedUploadMimeType(input.mimeType) ?? "application/octet-stream",
      ok: true
    };
  }
  if (!format || !uploadInspectionMatchesFormat(format, input)) {
    return { code: "unsupported_type", ok: false };
  }
  return { kind: format.kind, mimeType: format.canonicalMimeType, ok: true };
}
