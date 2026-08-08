export type UploadKind = "document" | "image" | "pdf";

export type UploadValidationInput = {
  byteSize: number;
  bytes?: Buffer | Uint8Array;
  fileName: string;
  maxBytes: number;
  mimeType: string;
};

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

const allowedTypes: Record<string, { extensions: string[]; kind: UploadKind }> = {
  "application/msword": { extensions: [".doc"], kind: "document" },
  "application/rtf": { extensions: [".rtf"], kind: "document" },
  "application/vnd.oasis.opendocument.text": { extensions: [".odt"], kind: "document" },
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": {
    extensions: [".pptx"],
    kind: "document"
  },
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": {
    extensions: [".xlsx"],
    kind: "document"
  },
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": {
    extensions: [".docx"],
    kind: "document"
  },
  "application/pdf": { extensions: [".pdf"], kind: "pdf" },
  "application/json": { extensions: [".json"], kind: "document" },
  "image/gif": { extensions: [".gif"], kind: "image" },
  "image/jpeg": { extensions: [".jpg", ".jpeg"], kind: "image" },
  "image/png": { extensions: [".png"], kind: "image" },
  "image/webp": { extensions: [".webp"], kind: "image" },
  "text/csv": { extensions: [".csv"], kind: "document" },
  "text/html": { extensions: [".html", ".htm"], kind: "document" },
  "text/markdown": { extensions: [".md", ".markdown"], kind: "document" },
  "text/plain": { extensions: [".txt", ".md", ".markdown"], kind: "document" },
  "text/rtf": { extensions: [".rtf"], kind: "document" }
};

const canonicalMimeByExtension: Record<string, string> = {
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".markdown": "text/markdown",
  ".md": "text/markdown",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
};

function looksZipLike(bytes: Buffer | Uint8Array): boolean {
  return bytesStartWith(bytes, [0x50, 0x4b, 0x03, 0x04]);
}

function zipContains(bytes: Buffer | Uint8Array, marker: string): boolean {
  return Buffer.from(bytes).includes(Buffer.from(marker, "utf8"));
}

function bytesStartWith(bytes: Buffer | Uint8Array, signature: number[]): boolean {
  if (bytes.byteLength < signature.length) {
    return false;
  }

  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Buffer | Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("ascii");
}

function looksTextLike(bytes: Buffer | Uint8Array): boolean {
  if (bytes.byteLength === 0) {
    return false;
  }

  const sample = bytes.subarray(0, Math.min(bytes.byteLength, 8192));
  if (sample.includes(0)) {
    return false;
  }

  const decoded = Buffer.from(sample).toString("utf8");
  const replacementCount = (decoded.match(/\uFFFD/g) ?? []).length;

  return replacementCount <= Math.max(8, decoded.length * 0.1);
}

export function matchesDeclaredUploadType(mimeType: string, bytes: Buffer | Uint8Array): boolean {
  switch (mimeType.toLowerCase()) {
    case "application/msword":
      return bytesStartWith(bytes, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case "application/rtf":
    case "text/rtf":
      return ascii(bytes, 0, 5) === "{\\rtf";
    case "application/vnd.oasis.opendocument.text":
      return looksZipLike(bytes) &&
        (zipContains(bytes, "application/vnd.oasis.opendocument.text") ||
          (zipContains(bytes, "content.xml") && zipContains(bytes, "META-INF/manifest.xml")));
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return looksZipLike(bytes) && zipContains(bytes, "[Content_Types].xml") && zipContains(bytes, "ppt/");
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return looksZipLike(bytes) && zipContains(bytes, "[Content_Types].xml") && zipContains(bytes, "xl/");
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return looksZipLike(bytes) && zipContains(bytes, "[Content_Types].xml") && zipContains(bytes, "word/");
    case "application/pdf":
      return ascii(bytes, 0, 5) === "%PDF-";
    case "application/json":
    case "text/csv":
    case "text/html":
    case "text/markdown":
    case "text/plain":
      return looksTextLike(bytes);
    case "image/gif":
      return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
    case "image/jpeg":
      return bytesStartWith(bytes, [0xff, 0xd8, 0xff]);
    case "image/png":
      return bytesStartWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case "image/webp":
      return bytes.byteLength >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP";
    default:
      return false;
  }
}

export function defaultUploadMaxBytes(env: Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.AIQSA_UPLOAD_MAX_BYTES);

  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= MAX_UPLOAD_MAX_BYTES
    ? parsed
    : DEFAULT_UPLOAD_MAX_BYTES;
}

export function validateUpload(input: UploadValidationInput): UploadValidationResult {
  if (!input.fileName || !input.mimeType || input.byteSize <= 0) {
    return { code: "file_required", ok: false };
  }

  if (input.byteSize > input.maxBytes) {
    return { code: "file_too_large", ok: false };
  }

  const rule = allowedTypes[input.mimeType.toLowerCase()];
  const lowerName = input.fileName.toLowerCase();
  const extension = rule?.extensions.find((item) => lowerName.endsWith(item));

  if (!rule || !extension) {
    return { code: "unsupported_type", ok: false };
  }

  if (input.bytes && !matchesDeclaredUploadType(input.mimeType, input.bytes)) {
    return { code: "unsupported_type", ok: false };
  }

  return {
    kind: rule.kind,
    mimeType: canonicalMimeByExtension[extension] ?? input.mimeType.toLowerCase(),
    ok: true
  };
}
