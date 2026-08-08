import { ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS } from "../../contracts/uploads";
import { takeUtf16SafePrefix } from "../../domain/utf16";

export type TextDocumentKind = "csv" | "html" | "json" | "markdown" | "text";

export type TextDocumentExtractionResult = {
  kind: TextDocumentKind;
  text: string;
  truncated: boolean;
};

export const DEFAULT_EXTRACTED_TEXT_MAX_CHARS = ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS;

const htmlBlockTags =
  /<\/?(address|article|aside|blockquote|br|dd|div|dl|dt|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|li|main|nav|ol|p|pre|section|table|tbody|td|tfoot|th|thead|tr|ul)\b[^>]*>/gi;

function normalizeNewlines(value: string): string {
  return value.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
}

function compactLines(value: string): string {
  return value
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: "\""
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    const normalized = entity.toLowerCase();

    if (normalized.startsWith("#x")) {
      const parsed = Number.parseInt(normalized.slice(2), 16);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }

    if (normalized.startsWith("#")) {
      const parsed = Number.parseInt(normalized.slice(1), 10);
      return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : match;
    }

    return named[normalized] ?? match;
  });
}

function htmlToText(value: string): string {
  const withoutScripts = value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ");
  const withLineBreaks = withoutScripts.replace(htmlBlockTags, "\n");
  const withoutTags = withLineBreaks.replace(/<[^>]+>/g, " ");

  return compactLines(decodeHtmlEntities(withoutTags));
}

export function textDocumentKind(fileName: string, mimeType: string): TextDocumentKind {
  const lowerName = fileName.toLowerCase();
  const lowerMime = mimeType.toLowerCase();

  if (lowerMime === "application/json" || lowerName.endsWith(".json")) {
    return "json";
  }

  if (lowerMime === "text/html" || lowerName.endsWith(".html") || lowerName.endsWith(".htm")) {
    return "html";
  }

  if (lowerMime === "text/csv" || lowerName.endsWith(".csv")) {
    return "csv";
  }

  if (lowerMime === "text/markdown" || lowerName.endsWith(".md") || lowerName.endsWith(".markdown")) {
    return "markdown";
  }

  return "text";
}

export function extractTextDocument(
  buffer: Buffer,
  input: {
    fileName: string;
    maxChars?: number;
    mimeType: string;
  }
): TextDocumentExtractionResult {
  const kind = textDocumentKind(input.fileName, input.mimeType);
  const maxChars = Math.max(1, Math.floor(input.maxChars ?? DEFAULT_EXTRACTED_TEXT_MAX_CHARS));
  const decoded = normalizeNewlines(buffer.toString("utf8"));

  function capText(text: string): TextDocumentExtractionResult {
    return {
      kind,
      text: text.length > maxChars ? takeUtf16SafePrefix(text, maxChars) : text,
      truncated: text.length > maxChars
    };
  }

  if (kind === "json") {
    if (decoded.length > maxChars) {
      return capText(decoded);
    }

    try {
      return capText(`${JSON.stringify(JSON.parse(decoded), null, 2)}\n`);
    } catch {
      return capText(decoded);
    }
  }

  if (kind === "html") {
    return capText(htmlToText(decoded));
  }

  return capText(decoded);
}
