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
 * The page kind a declared media type is read as by the page parser: HTML,
 * XHTML, plain text, Markdown and JSON. `sniff` for a missing type (decided
 * from the body); null refuses everything else (PDFs are read only through
 * `fetchedContentKind` and the PDF extractor).
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

/** What a fetched body is read as: a page kind, or a PDF that only the isolated PDF extractor reads. */
export type FetchedContentKind = PageContentKind | "pdf";

/** The bounded text of one fetched body, whichever extractor read it. */
export type FetchedPage = Readonly<{
  kind: FetchedContentKind;
  text: string;
  title: string | null;
  truncated: boolean;
}>;

const PDF_SIGNATURE = Buffer.from("%PDF-", "latin1");

/** Whether a body starts with the PDF signature. */
export function hasPdfSignature(body: Uint8Array): boolean {
  return body.byteLength >= PDF_SIGNATURE.byteLength && PDF_SIGNATURE.every((byte, index) => body[index] === byte);
}

/**
 * How a response is read before its body arrives: a page kind, `pdf` for a
 * declared PDF, `sniff` for a missing type (a PDF signature, else a sniffed
 * page kind) and `pdf_sniff` for a generic binary type (only a PDF signature
 * is read). Null refuses it, images and archives included.
 */
export function declaredFetchedContentKind(contentType: string | null): PageContentKind | "pdf" | "pdf_sniff" | "sniff" | null {
  const type = mediaType(contentType);
  if (type === "application/pdf" || type === "application/x-pdf") return "pdf";
  if (type === "application/octet-stream" || type === "binary/octet-stream") return "pdf_sniff";
  return declaredPageContentKind(contentType);
}

/** The kind a fetched body reads as, or null to refuse it. A PDF never reaches the page parser. */
export function fetchedContentKind(body: Uint8Array, contentType: string | null): FetchedContentKind | null {
  const declared = declaredFetchedContentKind(contentType);
  if (declared === "pdf_sniff") return hasPdfSignature(body) ? "pdf" : null;
  if (declared === "sniff") return hasPdfSignature(body) ? "pdf" : sniffedKind(body);
  return declared;
}
