/**
 * The readable kinds of a fetched body and the page text bounds. The
 * application imports only this light module: the HTML parsers in
 * `extract.ts` load and run only inside the disposable parser process.
 */
export const PAGE_TEXT_MAX_CHARACTERS = 24_000;
export const PAGE_TITLE_MAX_CHARACTERS = 300;
/** How much of a body sniffing and charset detection read. */
export const PAGE_SNIFF_BYTES = 4_096;

export type PageContentKind = "html" | "json" | "markdown" | "text";

export type ExtractedPage = Readonly<{
  kind: PageContentKind;
  text: string;
  title: string | null;
  truncated: boolean;
}>;

function mediaType(contentType: string | null): string | null {
  const type = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return type ? type : null;
}

/**
 * The kind a declared media type is read as: HTML, XHTML, plain text,
 * Markdown and JSON. `sniff` for a missing type (decided from the body);
 * null refuses everything else, PDFs and images included.
 */
export function declaredPageContentKind(contentType: string | null): PageContentKind | "sniff" | null {
  const type = mediaType(contentType);
  if (type === null) return "sniff";
  if (type === "text/html" || type === "application/xhtml+xml") return "html";
  if (type === "text/plain") return "text";
  if (type === "text/markdown" || type === "text/x-markdown") return "markdown";
  if (type === "application/json" || type === "text/json" || /^application\/[a-z0-9.+-]+\+json$/u.test(type)) return "json";
  return null;
}

function sniffedKind(bytes: Uint8Array): PageContentKind | null {
  const head = bytes.subarray(0, PAGE_SNIFF_BYTES);
  if (head.includes(0)) return null;
  const start = Buffer.from(head).toString("latin1").replace(/^ï»¿/u, "").trimStart().toLowerCase();
  if (/^(?:<!doctype html|<html|<head|<body|<!--)/u.test(start)) return "html";
  if (start.startsWith("{") || start.startsWith("[")) return "json";
  return "text";
}

/** The kind a body reads as: its declared media type, or for a missing one, the sniffed body. Null refuses it. */
export function pageContentKind(body: Uint8Array, contentType: string | null): PageContentKind | null {
  const declared = declaredPageContentKind(contentType);
  return declared === "sniff" ? sniffedKind(body) : declared;
}
