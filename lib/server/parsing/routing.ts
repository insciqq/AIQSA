import type { SidecarParserEngine } from "./types";

export type InlineDocumentFormat = "csv" | "json" | "markdown" | "text";

export type DocumentParserRoute =
  | Readonly<{
      extension: string;
      format: InlineDocumentFormat;
      kind: "inline";
      mediaType: string;
    }>
  | Readonly<{
      engines: readonly [SidecarParserEngine, ...SidecarParserEngine[]];
      extension: string;
      kind: "sidecar";
      mediaType: string;
    }>;

type FormatRule = Readonly<{
  engines?: readonly [SidecarParserEngine, ...SidecarParserEngine[]];
  format?: InlineDocumentFormat;
  mediaType: string;
  mimeTypes: readonly string[];
}>;

const formats = Object.freeze({
  ".bmp": { engines: ["docling", "tika"], mediaType: "image/bmp", mimeTypes: ["image/bmp", "image/x-bmp"] },
  ".csv": { format: "csv", mediaType: "text/csv", mimeTypes: ["text/csv", "application/csv", "text/plain"] },
  ".doc": { engines: ["tika"], mediaType: "application/msword", mimeTypes: ["application/msword"] },
  ".docx": {
    engines: ["docling", "tika"],
    mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"]
  },
  ".eml": { engines: ["tika"], mediaType: "message/rfc822", mimeTypes: ["message/rfc822"] },
  ".epub": { engines: ["tika"], mediaType: "application/epub+zip", mimeTypes: ["application/epub+zip"] },
  ".htm": { engines: ["docling", "tika"], mediaType: "text/html", mimeTypes: ["text/html"] },
  ".html": { engines: ["docling", "tika"], mediaType: "text/html", mimeTypes: ["text/html", "application/xhtml+xml"] },
  ".jpeg": { engines: ["docling", "tika"], mediaType: "image/jpeg", mimeTypes: ["image/jpeg"] },
  ".jpg": { engines: ["docling", "tika"], mediaType: "image/jpeg", mimeTypes: ["image/jpeg"] },
  ".json": { format: "json", mediaType: "application/json", mimeTypes: ["application/json", "text/json"] },
  ".markdown": { format: "markdown", mediaType: "text/markdown", mimeTypes: ["text/markdown", "text/plain"] },
  ".md": { format: "markdown", mediaType: "text/markdown", mimeTypes: ["text/markdown", "text/plain"] },
  ".msg": { engines: ["tika"], mediaType: "application/vnd.ms-outlook", mimeTypes: ["application/vnd.ms-outlook", "application/x-msg"] },
  ".odp": { engines: ["tika"], mediaType: "application/vnd.oasis.opendocument.presentation", mimeTypes: ["application/vnd.oasis.opendocument.presentation"] },
  ".ods": { engines: ["tika"], mediaType: "application/vnd.oasis.opendocument.spreadsheet", mimeTypes: ["application/vnd.oasis.opendocument.spreadsheet"] },
  ".odt": { engines: ["tika"], mediaType: "application/vnd.oasis.opendocument.text", mimeTypes: ["application/vnd.oasis.opendocument.text"] },
  ".pdf": { engines: ["docling", "tika"], mediaType: "application/pdf", mimeTypes: ["application/pdf"] },
  ".png": { engines: ["docling", "tika"], mediaType: "image/png", mimeTypes: ["image/png"] },
  ".pptx": {
    engines: ["docling", "tika"],
    mediaType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"]
  },
  ".rtf": { engines: ["tika"], mediaType: "application/rtf", mimeTypes: ["application/rtf", "text/rtf"] },
  ".tif": { engines: ["docling", "tika"], mediaType: "image/tiff", mimeTypes: ["image/tiff"] },
  ".tiff": { engines: ["docling", "tika"], mediaType: "image/tiff", mimeTypes: ["image/tiff"] },
  ".txt": { format: "text", mediaType: "text/plain", mimeTypes: ["text/plain"] },
  ".webp": { engines: ["docling", "tika"], mediaType: "image/webp", mimeTypes: ["image/webp"] },
  ".xlsx": {
    engines: ["docling", "tika"],
    mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"]
  }
} satisfies Record<string, FormatRule>);

function normalizedMimeType(value: string): string | undefined {
  if (Buffer.byteLength(value, "utf8") > 255) return undefined;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : undefined;
}

export function normalizedFileExtension(fileName: string): string | undefined {
  if (
    !fileName
    || Buffer.byteLength(fileName, "utf8") > 255
    || /[\0/\\\r\n]/u.test(fileName)
  ) {
    return undefined;
  }

  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : undefined;
}

export function resolveDocumentParserRoute(
  fileName: string,
  mimeType: string
): DocumentParserRoute | undefined {
  const extension = normalizedFileExtension(fileName);
  const declaredMimeType = normalizedMimeType(mimeType);
  if (!extension || !declaredMimeType) return undefined;

  const rule = formats[extension as keyof typeof formats] as FormatRule | undefined;
  if (!rule || !rule.mimeTypes.includes(declaredMimeType)) return undefined;

  if (rule.format) {
    return Object.freeze({
      extension,
      format: rule.format,
      kind: "inline" as const,
      mediaType: rule.mediaType
    });
  }

  if (!rule.engines) return undefined;
  return Object.freeze({
    engines: rule.engines,
    extension,
    kind: "sidecar" as const,
    mediaType: rule.mediaType
  });
}
