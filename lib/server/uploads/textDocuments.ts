import { ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS } from "../../contracts/uploads";
import { takeUtf16SafePrefix } from "../../domain/utf16";

export type TextDocumentKind = "csv" | "html" | "json" | "markdown" | "text";

export type TextDocumentExtractionResult = {
  kind: TextDocumentKind;
  text: string;
  truncated: boolean;
};

export const DEFAULT_EXTRACTED_TEXT_MAX_CHARS = ATTACHMENT_EXTRACTED_TEXT_MAX_CHARS;
/** Synchronous HTML work is bounded in UTF-16 units; a longer source is partial. */
export const HTML_TEXT_MAX_INPUT_CHARS = 16 * 1_024 * 1_024;

const htmlBlockTagNames: ReadonlySet<string> = new Set([
  "address", "article", "aside", "blockquote", "br", "dd", "div", "dl", "dt", "fieldset",
  "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header",
  "hr", "li", "main", "nav", "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot",
  "th", "thead", "tr", "ul"
]);
const MAX_CODE_POINT = 0x10ffff;

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
      return parsed <= MAX_CODE_POINT ? String.fromCodePoint(parsed) : match;
    }

    if (normalized.startsWith("#")) {
      const parsed = Number.parseInt(normalized.slice(1), 10);
      return parsed <= MAX_CODE_POINT ? String.fromCodePoint(parsed) : match;
    }

    return named[normalized] ?? match;
  });
}

function isTagNameCharacter(code: number): boolean {
  return code >= 0x30 && code <= 0x39 || code >= 0x41 && code <= 0x5a ||
    code >= 0x61 && code <= 0x7a || code === 0x5f;
}

/** Returns the index after a raw-text element's end tag, or -1 when unclosed. */
function rawTextEnd(shadow: string, name: string, from: number): number {
  const marker = `</${name}`;
  let search = from;
  for (;;) {
    const found = shadow.indexOf(marker, search);
    if (found < 0) return -1;
    const after = found + marker.length;
    if (!isTagNameCharacter(shadow.charCodeAt(after))) {
      const close = shadow.indexOf(">", after);
      return close < 0 ? -1 : close + 1;
    }
    search = found + 1;
  }
}

/**
 * One forward pass: every indexOf starts after the previous match, so hostile
 * unclosed markup cannot cause backtracking. The shadow lowercases ASCII only
 * and therefore keeps the source offsets.
 */
function htmlToText(value: string): string {
  const shadow = value.replace(/[A-Z]+/gu, (letters) => letters.toLowerCase());
  const parts: string[] = [];
  let cursor = 0;
  while (cursor < value.length) {
    const open = value.indexOf("<", cursor);
    if (open < 0) break;
    const close = value.indexOf(">", open + 1);
    // An unclosed tag leaves the remainder as text.
    if (close < 0) break;
    parts.push(value.slice(cursor, open));
    if (close === open + 1) {
      parts.push("<");
      cursor = close;
      continue;
    }
    const closing = value.charCodeAt(open + 1) === 0x2f;
    const nameStart = open + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < close && isTagNameCharacter(shadow.charCodeAt(nameEnd))) nameEnd += 1;
    const name = shadow.slice(nameStart, nameEnd);
    if (!closing && (name === "script" || name === "style")) {
      parts.push(" ");
      // An unclosed script or style discards the remainder once.
      cursor = rawTextEnd(shadow, name, close + 1);
      if (cursor < 0) cursor = value.length;
      continue;
    }
    parts.push(htmlBlockTagNames.has(name) ? "\n" : " ");
    cursor = close + 1;
  }
  parts.push(value.slice(cursor));

  return compactLines(decodeHtmlEntities(parts.join("")));
}

function boundedHtmlSource(value: string): Readonly<{ html: string; truncated: boolean }> {
  if (value.length <= HTML_TEXT_MAX_INPUT_CHARS) return { html: value, truncated: false };
  const prefix = takeUtf16SafePrefix(value, HTML_TEXT_MAX_INPUT_CHARS);
  const open = prefix.lastIndexOf("<");
  return {
    html: open > prefix.lastIndexOf(">") ? prefix.slice(0, open) : prefix,
    truncated: true
  };
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
    const source = boundedHtmlSource(decoded);
    const extracted = capText(htmlToText(source.html));
    return source.truncated ? { ...extracted, truncated: true } : extracted;
  }

  return capText(decoded);
}
