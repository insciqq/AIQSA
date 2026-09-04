export type UploadFormatScope = "attachment" | "knowledge" | "workspace";
export type UploadKind = "document" | "file" | "image" | "pdf";
export type InlineDocumentFormat = "csv" | "json" | "markdown" | "text";
export type StructuredDocumentFormat = "csv" | "ods" | "xls" | "xlsx";
export type SidecarParserEngine = "docling" | "tika";

export type UploadContentEvidence =
  | "bmp"
  | "eml"
  | "epub"
  | "gif"
  | "html"
  | "jpeg"
  | "json"
  | "ole"
  | "open_document_presentation"
  | "open_document_spreadsheet"
  | "open_document_text"
  | "pdf"
  | "png"
  | "presentation_ooxml"
  | "rtf"
  | "spreadsheet_ooxml"
  | "text"
  | "tiff"
  | "webp"
  | "word_ooxml";

export type UploadFormatParserRoute =
  | Readonly<{ format: InlineDocumentFormat; kind: "inline" }>
  | Readonly<{ format: StructuredDocumentFormat; kind: "spreadsheet" }>
  | Readonly<{
      engines: readonly [SidecarParserEngine, ...SidecarParserEngine[]];
      kind: "sidecar";
    }>;

export type UploadFormatDefinition = Readonly<{
  canonicalMimeType: string;
  contentEvidence: UploadContentEvidence;
  extensions: readonly [string, ...string[]];
  id: string;
  kind: UploadKind;
  label: string;
  mimeTypes: readonly string[];
  parser: UploadFormatParserRoute | null;
  scopes: readonly UploadFormatScope[];
}>;

const bothScopes = Object.freeze(["attachment", "knowledge", "workspace"] as const);
const knowledgeOnly = Object.freeze(["knowledge", "workspace"] as const);
const attachmentOnly = Object.freeze(["attachment", "workspace"] as const);

/**
 * Canonical upload-format inventory. Browser filters, server admission, content
 * evidence, parser routing, help copy, and fixture coverage derive from this
 * immutable registry rather than maintaining parallel extension/MIME lists.
 */
export const UPLOAD_FORMAT_REGISTRY: readonly UploadFormatDefinition[] = Object.freeze([
  {
    canonicalMimeType: "application/pdf",
    contentEvidence: "pdf",
    extensions: [".pdf"],
    id: "pdf",
    kind: "pdf",
    label: "PDF",
    mimeTypes: ["application/pdf"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "application/msword",
    contentEvidence: "ole",
    extensions: [".doc"],
    id: "doc",
    kind: "document",
    label: "Word (DOC)",
    mimeTypes: ["application/msword", "application/x-msword"],
    parser: { engines: ["tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    contentEvidence: "word_ooxml",
    extensions: [".docx"],
    id: "docx",
    kind: "document",
    label: "Word (DOCX)",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    contentEvidence: "presentation_ooxml",
    extensions: [".pptx"],
    id: "pptx",
    kind: "document",
    label: "PowerPoint",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "application/rtf",
    contentEvidence: "rtf",
    extensions: [".rtf"],
    id: "rtf",
    kind: "document",
    label: "RTF",
    mimeTypes: ["application/rtf", "text/rtf"],
    parser: { engines: ["tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "application/vnd.oasis.opendocument.text",
    contentEvidence: "open_document_text",
    extensions: [".odt"],
    id: "odt",
    kind: "document",
    label: "OpenDocument text",
    mimeTypes: ["application/vnd.oasis.opendocument.text"],
    parser: { engines: ["tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "text/plain",
    contentEvidence: "text",
    extensions: [".txt"],
    id: "text",
    kind: "document",
    label: "Plain text",
    mimeTypes: ["text/plain"],
    parser: { format: "text", kind: "inline" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "text/markdown",
    contentEvidence: "text",
    extensions: [".md", ".markdown"],
    id: "markdown",
    kind: "document",
    label: "Markdown",
    mimeTypes: ["text/markdown", "text/plain", "text/x-markdown"],
    parser: { format: "markdown", kind: "inline" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "text/html",
    contentEvidence: "html",
    extensions: [".html", ".htm"],
    id: "html",
    kind: "document",
    label: "HTML",
    mimeTypes: ["text/html", "application/xhtml+xml"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "application/json",
    contentEvidence: "json",
    extensions: [".json"],
    id: "json",
    kind: "document",
    label: "JSON",
    mimeTypes: ["application/json", "text/json"],
    parser: { format: "json", kind: "inline" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "text/csv",
    contentEvidence: "text",
    extensions: [".csv"],
    id: "csv",
    kind: "document",
    label: "CSV",
    mimeTypes: ["text/csv", "application/csv", "text/plain"],
    parser: { format: "csv", kind: "spreadsheet" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "application/vnd.ms-excel",
    contentEvidence: "ole",
    extensions: [".xls"],
    id: "xls",
    kind: "document",
    label: "Excel (XLS)",
    mimeTypes: ["application/vnd.ms-excel", "application/x-msexcel"],
    parser: { format: "xls", kind: "spreadsheet" },
    scopes: knowledgeOnly
  },
  {
    canonicalMimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    contentEvidence: "spreadsheet_ooxml",
    extensions: [".xlsx"],
    id: "xlsx",
    kind: "document",
    label: "Excel (XLSX)",
    mimeTypes: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
    parser: { format: "xlsx", kind: "spreadsheet" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "application/vnd.oasis.opendocument.spreadsheet",
    contentEvidence: "open_document_spreadsheet",
    extensions: [".ods"],
    id: "ods",
    kind: "document",
    label: "OpenDocument spreadsheet",
    mimeTypes: ["application/vnd.oasis.opendocument.spreadsheet"],
    parser: { format: "ods", kind: "spreadsheet" },
    scopes: knowledgeOnly
  },
  {
    canonicalMimeType: "application/vnd.oasis.opendocument.presentation",
    contentEvidence: "open_document_presentation",
    extensions: [".odp"],
    id: "odp",
    kind: "document",
    label: "OpenDocument presentation",
    mimeTypes: ["application/vnd.oasis.opendocument.presentation"],
    parser: { engines: ["tika"], kind: "sidecar" },
    scopes: knowledgeOnly
  },
  {
    canonicalMimeType: "message/rfc822",
    contentEvidence: "eml",
    extensions: [".eml"],
    id: "eml",
    kind: "document",
    label: "Email (EML)",
    mimeTypes: ["message/rfc822", "application/octet-stream"],
    parser: { engines: ["tika"], kind: "sidecar" },
    scopes: knowledgeOnly
  },
  {
    canonicalMimeType: "application/vnd.ms-outlook",
    contentEvidence: "ole",
    extensions: [".msg"],
    id: "msg",
    kind: "document",
    label: "Outlook message",
    mimeTypes: ["application/vnd.ms-outlook", "application/x-msg"],
    parser: { engines: ["tika"], kind: "sidecar" },
    scopes: knowledgeOnly
  },
  {
    canonicalMimeType: "application/epub+zip",
    contentEvidence: "epub",
    extensions: [".epub"],
    id: "epub",
    kind: "document",
    label: "EPUB",
    mimeTypes: ["application/epub+zip"],
    parser: { engines: ["tika"], kind: "sidecar" },
    scopes: knowledgeOnly
  },
  {
    canonicalMimeType: "image/png",
    contentEvidence: "png",
    extensions: [".png"],
    id: "png",
    kind: "image",
    label: "PNG",
    mimeTypes: ["image/png"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "image/jpeg",
    contentEvidence: "jpeg",
    extensions: [".jpg", ".jpeg"],
    id: "jpeg",
    kind: "image",
    label: "JPEG",
    mimeTypes: ["image/jpeg", "image/jpg"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "image/tiff",
    contentEvidence: "tiff",
    extensions: [".tif", ".tiff"],
    id: "tiff",
    kind: "image",
    label: "TIFF",
    mimeTypes: ["image/tiff", "image/x-tiff"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: knowledgeOnly
  },
  {
    canonicalMimeType: "image/webp",
    contentEvidence: "webp",
    extensions: [".webp"],
    id: "webp",
    kind: "image",
    label: "WebP",
    mimeTypes: ["image/webp"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: bothScopes
  },
  {
    canonicalMimeType: "image/bmp",
    contentEvidence: "bmp",
    extensions: [".bmp"],
    id: "bmp",
    kind: "image",
    label: "BMP",
    mimeTypes: ["image/bmp", "image/x-bmp"],
    parser: { engines: ["docling", "tika"], kind: "sidecar" },
    scopes: knowledgeOnly
  },
  {
    canonicalMimeType: "image/gif",
    contentEvidence: "gif",
    extensions: [".gif"],
    id: "gif",
    kind: "image",
    label: "GIF",
    mimeTypes: ["image/gif"],
    parser: null,
    scopes: attachmentOnly
  }
] satisfies readonly UploadFormatDefinition[]);

export function normalizedUploadMimeType(value: string): string | undefined {
  if (new TextEncoder().encode(value).byteLength > 255) return undefined;
  const mediaType = value.split(";", 1)[0]?.trim().toLowerCase();
  return mediaType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/u.test(mediaType)
    ? mediaType
    : undefined;
}

export function normalizedUploadFileExtension(fileName: string): string | undefined {
  if (!isSafeUploadFileName(fileName)) return undefined;
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(dot).toLowerCase() : undefined;
}

export function isSafeUploadFileName(fileName: string): boolean {
  return Boolean(
    fileName &&
    fileName !== "." &&
    fileName !== ".." &&
    new TextEncoder().encode(fileName).byteLength <= 255 &&
    !/[\u0000-\u001f\u007f/\\]/u.test(fileName)
  );
}

export function uploadFormatFor(
  fileName: string,
  mimeType: string,
  scope: UploadFormatScope
): UploadFormatDefinition | undefined {
  const format = uploadFormatForExtension(fileName, scope);
  if (!format) return undefined;

  const normalizedMime = normalizedUploadMimeType(mimeType);
  if (!normalizedMime || normalizedMime === "application/octet-stream") return format;
  return format.mimeTypes.includes(normalizedMime) ? format : undefined;
}

export function uploadFormatForExtension(
  fileName: string,
  scope: UploadFormatScope
): UploadFormatDefinition | undefined {
  const extension = normalizedUploadFileExtension(fileName);
  if (!extension) return undefined;
  return UPLOAD_FORMAT_REGISTRY.find((candidate) =>
    candidate.scopes.includes(scope) && candidate.extensions.includes(extension)
  );
}

export function uploadAcceptFor(input: Readonly<{
  kinds?: readonly UploadKind[];
  scope: UploadFormatScope;
}>): string {
  // An empty accept attribute intentionally means "any file". Server-side
  // Workspace admission still applies size, name, ownership, and content
  // validation for every known parser/native format.
  if (input.scope === "workspace") return "";
  const kinds = new Set(input.kinds ?? ["document", "image", "pdf"]);
  const formats = UPLOAD_FORMAT_REGISTRY.filter((format) =>
    format.scopes.includes(input.scope) && kinds.has(format.kind)
  );
  return [...new Set(formats.flatMap((format) => [
    ...format.extensions,
    format.canonicalMimeType
  ]))].join(",");
}

export const KNOWLEDGE_UPLOAD_ACCEPT = uploadAcceptFor({ scope: "knowledge" });
export const KNOWLEDGE_UPLOAD_FORMAT_LABELS = Object.freeze(
  UPLOAD_FORMAT_REGISTRY
    .filter((format) => format.scopes.includes("knowledge"))
    .map((format) => format.label)
);
