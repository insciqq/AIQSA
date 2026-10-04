import { Readability } from "@mozilla/readability";
import { DOMParser } from "linkedom";
import { parse as parse5, serialize } from "parse5";

/**
 * Turns one fetched body into bounded, Markdown-like page text: HTML main
 * content through Readability (headings, lists, links, code and tables kept),
 * plain text, Markdown and JSON as text. Nothing is executed: the DOM has no
 * script engine, network or resource loading. Pure and synchronous over an
 * already bounded body.
 */
export const PAGE_TEXT_MAX_CHARACTERS = 24_000;
/** Readability refuses documents beyond this many elements; the plain body walk takes over. */
const READABILITY_MAX_ELEMENTS = 60_000;
const MAX_RENDER_DEPTH = 256;
const TITLE_MAX_CHARACTERS = 300;
const SNIFF_BYTES = 4_096;

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
  const head = bytes.subarray(0, SNIFF_BYTES);
  if (head.includes(0)) return null;
  const start = Buffer.from(head).toString("latin1").trimStart().toLowerCase();
  if (/^(?:﻿)?(?:<!doctype html|<html|<head|<body|<!--)/u.test(start)) return "html";
  if (start.startsWith("{") || start.startsWith("[")) return "json";
  return "text";
}

function decoder(label: string | null | undefined, fatal = false): TextDecoder | null {
  if (!label) return null;
  try {
    return new TextDecoder(label.trim(), { fatal });
  } catch {
    return null;
  }
}

function bomEncoding(bytes: Uint8Array): string | null {
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  return null;
}

function headerCharset(contentType: string | null): string | null {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/iu.exec(contentType ?? "");
  return match?.[1] ?? null;
}

/** `<meta charset>` or `<meta http-equiv content="...charset=...">` within the first bytes. */
function metaCharset(bytes: Uint8Array): string | null {
  const head = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("latin1");
  const match = /<meta[^>]*?charset\s*=\s*["']?\s*([a-z0-9_:.+-]+)/iu.exec(head);
  return match?.[1] ?? null;
}

/**
 * The page's text under its charset: a byte order mark, then the header's
 * charset, then (HTML) a meta declaration; otherwise UTF-8 when the bytes are
 * valid UTF-8, else windows-1252. Unknown labels fall through; a meta
 * declaration of UTF-16 means UTF-8, as in browsers.
 */
export function decodePageBytes(bytes: Uint8Array, contentType: string | null, kind: PageContentKind): string {
  const bom = bomEncoding(bytes);
  const declared = [bom, headerCharset(contentType)];
  if (kind === "html") {
    const meta = metaCharset(bytes);
    declared.push(meta && /^utf-?16/iu.test(meta) ? "utf-8" : meta);
  }
  for (const label of declared) {
    const chosen = decoder(label);
    if (chosen) return chosen.decode(bytes);
  }
  const utf8 = decoder("utf-8", true)!;
  try {
    return utf8.decode(bytes);
  } catch {
    return decoder("windows-1252")!.decode(bytes);
  }
}

function cleanText(text: string): string {
  return text.replace(/\r\n?/gu, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
}

function collapseTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.replace(/\s+/gu, " ").trim();
  return title ? title.slice(0, TITLE_MAX_CHARACTERS) : null;
}

const SKIPPED = new Set(["AREA", "AUDIO", "BUTTON", "CANVAS", "EMBED", "FRAME", "FRAMESET", "HEAD", "IFRAME", "IMG", "INPUT",
  "LINK", "MAP", "META", "NOSCRIPT", "OBJECT", "OPTION", "PICTURE", "SCRIPT", "SELECT", "SOURCE", "STYLE", "SVG", "TEMPLATE",
  "TEXTAREA", "TRACK", "VIDEO"]);
const BLOCKS = new Set(["ADDRESS", "ARTICLE", "ASIDE", "BODY", "CAPTION", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT", "FIELDSET",
  "FIGCAPTION", "FIGURE", "FOOTER", "FORM", "HEADER", "HGROUP", "LEGEND", "MAIN", "NAV", "P", "SECTION", "SUMMARY"]);

type DomNode = Readonly<{
  nodeType: number;
  nodeName: string;
  textContent: string | null;
  childNodes: ArrayLike<DomNode>;
  getAttribute?(name: string): string | null;
}>;

type RenderContext = { base: URL | null; budget: number; produced: number };

function children(node: DomNode): DomNode[] {
  return Array.from(node.childNodes);
}

function fence(code: string): string {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/gu), (match) => match[0].length));
  return "`".repeat(longest + 1);
}

function link(href: string | null, base: URL | null): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, base ?? undefined);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function renderChildren(node: DomNode, context: RenderContext, depth: number, preformatted: boolean): string {
  let output = "";
  for (const child of children(node)) {
    if (context.produced > context.budget) break;
    output += render(child, context, depth + 1, preformatted);
  }
  return output;
}

function listItems(node: DomNode, context: RenderContext, depth: number, ordered: boolean): string {
  let index = 0;
  const items: string[] = [];
  for (const child of children(node)) {
    if (context.produced > context.budget) break;
    if (child.nodeType !== 1) continue;
    const body = child.nodeName === "LI" ? renderChildren(child, context, depth, false) : render(child, context, depth + 1, false);
    const text = body.replace(/\n{3,}/gu, "\n\n").trim();
    if (!text) continue;
    index += 1;
    const marker = ordered ? `${index}. ` : "- ";
    items.push(marker + text.replace(/\n/gu, `\n${" ".repeat(marker.length)}`));
  }
  return items.length ? `\n\n${items.join("\n")}\n\n` : "";
}

function table(node: DomNode, context: RenderContext, depth: number): string {
  const rows: string[] = [];
  const visit = (current: DomNode, level: number) => {
    for (const child of children(current)) {
      if (child.nodeType !== 1 || level > 8) continue;
      if (child.nodeName === "TR") {
        const cells = children(child).filter((cell) => cell.nodeType === 1 && (cell.nodeName === "TD" || cell.nodeName === "TH"))
          .map((cell) => renderChildren(cell, context, depth + level, false).replace(/\s+/gu, " ").trim());
        if (cells.some(Boolean)) rows.push(`| ${cells.join(" | ")} |`);
      } else if (child.nodeName !== "TABLE") {
        visit(child, level + 1);
      }
    }
  };
  visit(node, 1);
  return rows.length ? `\n\n${rows.join("\n")}\n\n` : "";
}

function render(node: DomNode, context: RenderContext, depth: number, preformatted: boolean): string {
  if (context.produced > context.budget) return "";
  if (node.nodeType === 3) {
    const text = preformatted ? node.textContent ?? "" : (node.textContent ?? "").replace(/\s+/gu, " ");
    context.produced += text.length;
    return text;
  }
  if (node.nodeType !== 1 && node.nodeType !== 9 && node.nodeType !== 11) return "";
  const name = node.nodeName.toUpperCase();
  if (SKIPPED.has(name)) return "";
  if (depth > MAX_RENDER_DEPTH) {
    const text = (node.textContent ?? "").replace(/\s+/gu, " ");
    context.produced += text.length;
    return ` ${text} `;
  }
  switch (name) {
    case "BR": return "\n";
    case "HR": return "\n\n---\n\n";
    case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": {
      const text = renderChildren(node, context, depth, false).replace(/\s+/gu, " ").trim();
      return text ? `\n\n${"#".repeat(Number(name[1]))} ${text}\n\n` : "";
    }
    case "PRE": {
      const code = (node.textContent ?? "").replace(/\n+$/u, "");
      context.produced += code.length;
      const marker = fence(code);
      return code.trim() ? `\n\n${marker}\n${code}\n${marker}\n\n` : "";
    }
    case "CODE": {
      if (preformatted) return renderChildren(node, context, depth, true);
      const code = (node.textContent ?? "").replace(/\s+/gu, " ").trim();
      context.produced += code.length;
      if (!code) return "";
      const marker = code.includes("`") ? "``" : "`";
      return `${marker}${code}${marker}`;
    }
    case "A": {
      const text = renderChildren(node, context, depth, preformatted).replace(/\s+/gu, " ").trim();
      const href = link(node.getAttribute?.("href") ?? null, context.base);
      if (!text) return "";
      const target = href?.replace(/\(/gu, "%28").replace(/\)/gu, "%29");
      return target && href !== text ? `[${text.replace(/[[\]]/gu, "")}](${target})` : text;
    }
    case "UL": case "OL": case "MENU":
      return listItems(node, context, depth, name === "OL");
    case "LI":
      return `\n- ${renderChildren(node, context, depth, false).trim()}\n`;
    case "BLOCKQUOTE": {
      const text = renderChildren(node, context, depth, false).replace(/\n{3,}/gu, "\n\n").trim();
      return text ? `\n\n${text.split("\n").map((line) => `> ${line}`.trimEnd()).join("\n")}\n\n` : "";
    }
    case "TABLE":
      return table(node, context, depth);
    default: {
      const text = renderChildren(node, context, depth, preformatted);
      return BLOCKS.has(name) ? `\n\n${text}\n\n` : text;
    }
  }
}

function tidy(markdown: string): string {
  return cleanText(markdown)
    .split("\n").map((line) => line.replace(/[ \t]+$/u, "")).join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

/** Cuts at a paragraph, line or word boundary near the bound, never inside a surrogate pair. */
export function truncatePageText(text: string, maxCharacters: number): Readonly<{ text: string; truncated: boolean }> {
  if (text.length <= maxCharacters) return { text, truncated: false };
  const floor = Math.floor(maxCharacters * 0.7);
  let cut = [text.lastIndexOf("\n\n", maxCharacters), text.lastIndexOf("\n", maxCharacters), text.lastIndexOf(" ", maxCharacters)]
    .find((index) => index >= floor) ?? maxCharacters;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
  return { text: text.slice(0, cut).trimEnd(), truncated: true };
}

function baseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function htmlText(html: string, finalUrl: string, budget: number): Readonly<{ text: string; title: string | null; stopped: boolean }> {
  // linkedom keeps only what an explicit <body> holds; parse5 builds the tree
  // as browsers do (implied html/head/body, foster parenting) and serializes
  // it complete, so a fragment or a page without those tags reads the same.
  const document5 = serialize(parse5(html));
  const parse = () => new DOMParser().parseFromString(document5, "text/html") as unknown as Document;
  const document = parse();
  const documentTitle = collapseTitle(document.title);
  const context: RenderContext = { base: baseUrl(finalUrl), budget, produced: 0 };
  let root: DomNode | null = null;
  let title = documentTitle;
  try {
    const article = new Readability(document, {
      maxElemsToParse: READABILITY_MAX_ELEMENTS,
      serializer: (element: Node) => element
    }).parse() as { content?: unknown; title?: unknown } | null;
    if (article?.content && typeof article.content === "object") {
      root = article.content as DomNode;
      title = collapseTitle(article.title) ?? documentTitle;
    }
  } catch {
    // Too large or unusual for Readability: the plain body walk below reads it.
  }
  let text = root ? tidy(render(root, context, 0, false)) : "";
  if (!text) {
    // Readability changes the document it reads, so the fallback reads a fresh parse.
    context.produced = 0;
    const body = parse().body as unknown as DomNode | null;
    text = body ? tidy(render(body, context, 0, false)) : "";
  }
  return { stopped: context.produced > budget, text, title };
}

function jsonText(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * The bounded page text of one fetched body. Null when the body is not one of
 * the accepted kinds (a missing media type is sniffed: HTML markers, JSON, or
 * text without NUL bytes).
 */
export function extractPage(input: Readonly<{
  body: Uint8Array;
  contentType: string | null;
  finalUrl: string;
  maxCharacters?: number;
}>): ExtractedPage | null {
  const declared = declaredPageContentKind(input.contentType);
  const kind = declared === "sniff" ? sniffedKind(input.body) : declared;
  if (kind === null) return null;
  const maxCharacters = input.maxCharacters ?? PAGE_TEXT_MAX_CHARACTERS;
  const decoded = decodePageBytes(input.body, input.contentType, kind);
  if (kind === "html") {
    const page = htmlText(decoded, input.finalUrl, Math.ceil(maxCharacters * 1.25));
    const bounded = truncatePageText(page.text, maxCharacters);
    return { kind, text: bounded.text, title: page.title, truncated: bounded.truncated || page.stopped };
  }
  const text = tidy(kind === "json" ? jsonText(decoded) : decoded);
  const bounded = truncatePageText(text, maxCharacters);
  return { kind, text: bounded.text, title: null, truncated: bounded.truncated };
}
