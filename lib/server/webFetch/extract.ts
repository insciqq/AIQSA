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
/** Larger documents skip Readability and read as plain text (its scoring would stall the event loop). */
const READABILITY_MAX_ELEMENTS = 15_000;
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

/** Trailing spaces go, and runs of spaces after text collapse outside code fences (indentation stays). */
function tidy(markdown: string): string {
  let fenced = false;
  return cleanText(markdown)
    .split("\n").map((line) => {
      if (/^`{3,}/u.test(line)) fenced = !fenced;
      const trimmed = line.replace(/[ \t]+$/u, "");
      return fenced ? trimmed : trimmed.replace(/(\S)[ \t]{2,}/gu, "$1 ");
    }).join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
}

type Tree5Node = Readonly<{ childNodes?: readonly Tree5Node[]; nodeName: string; value?: string }>;

function children5(node: Tree5Node): readonly Tree5Node[] {
  return node.nodeName === "template" ? [] : node.childNodes ?? [];
}

/** Whether the parse5 tree is deeper or larger than the bounds, walked without recursion. */
function treeExceeds(root: Tree5Node, maxDepth: number, maxElements: number): boolean {
  let elements = 0;
  const stack: Array<readonly [Tree5Node, number]> = [[root, 0]];
  while (stack.length > 0) {
    const [node, depth] = stack.pop()!;
    if (depth > maxDepth) return true;
    if (!node.nodeName.startsWith("#") && (elements += 1) > maxElements) return true;
    for (const child of children5(node)) stack.push([child, depth + 1]);
  }
  return false;
}

/**
 * The text of a pathological tree (nesting deeper than the libraries' own
 * recursion survives), walked without recursion: block elements separate
 * paragraphs, skipped elements stay out, the bound stops the walk.
 */
function plainTreeText(root: Tree5Node, budget: number): Readonly<{ text: string; title: string | null; stopped: boolean }> {
  const parts: string[] = [];
  let produced = 0;
  let title: string | null = null;
  const stack: Array<Tree5Node | "block"> = [root];
  while (stack.length > 0 && produced <= budget) {
    const node = stack.pop()!;
    if (node === "block") {
      parts.push("\n\n");
      continue;
    }
    if (node.nodeName === "#text") {
      const text = (node.value ?? "").replace(/\s+/gu, " ");
      parts.push(text);
      produced += text.length;
      continue;
    }
    const name = node.nodeName.toUpperCase();
    if (name === "TITLE" && title === null) title = collapseTitle(children5(node).map((child) => child.value ?? "").join(""));
    if (SKIPPED.has(name) || name === "TITLE") continue;
    const block = BLOCKS.has(name) || /^H[1-6]$/u.test(name) || name === "LI" || name === "TR" || name === "PRE" || name === "BR";
    if (block) stack.push("block");
    const nodes = children5(node);
    for (let index = nodes.length - 1; index >= 0; index -= 1) stack.push(nodes[index]!);
    if (block) parts.push("\n\n");
  }
  return { stopped: produced > budget, text: tidy(parts.join("")), title };
}

/**
 * Trees beyond these bounds read as plain text: parse5's serializer and
 * Readability recurse per nesting level, and Readability's scoring is the
 * costly synchronous step (about 0.7 s for 30,000 elements).
 */
const MAX_HTML_DEPTH = 400;

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

/** Above this pre-parse nesting estimate no DOM is built: parse5's tree builder slows quadratically with depth. */
const MAX_TAG_NESTING = 1_000;
const VOID_TAGS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
/** Elements a parser closes implicitly; they never nest without bound. */
const IMPLIED_END_TAGS = new Set(["body", "caption", "colgroup", "dd", "dt", "head", "html", "li", "optgroup", "option", "p", "rb",
  "rp", "rt", "rtc", "tbody", "td", "tfoot", "th", "thead", "tr"]);
const RAW_TEXT_TAGS = new Set(["noscript", "script", "style", "template", "textarea", "title", "xmp"]);
const tagPattern = () => /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)[^>]*>/gu;

/** The end of a raw-text element's content (or the input), found without a parser. */
function rawTextEnd(lower: string, name: string, from: number): number {
  const end = lower.indexOf(`</${name}`, from);
  return end < 0 ? lower.length : end;
}

/** A linear estimate of the deepest element nesting, stopping once it passes `limit`. */
function exceedsNesting(html: string, limit: number): boolean {
  const lower = html.toLowerCase();
  let depth = 0;
  const pattern = tagPattern();
  for (let match = pattern.exec(lower); match; match = pattern.exec(lower)) {
    const name = match[2]!;
    if (match[1]) {
      if (!VOID_TAGS.has(name) && !IMPLIED_END_TAGS.has(name)) depth = Math.max(0, depth - 1);
      continue;
    }
    if (RAW_TEXT_TAGS.has(name)) {
      pattern.lastIndex = rawTextEnd(lower, name, pattern.lastIndex);
      continue;
    }
    if (VOID_TAGS.has(name) || IMPLIED_END_TAGS.has(name) || match[0].endsWith("/>")) continue;
    if ((depth += 1) > limit) return true;
  }
  return false;
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: "\"" };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,6});/giu, (entity, body: string) => {
    if (body[0] !== "#") return ENTITIES[body.toLowerCase()] ?? entity;
    const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
    return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "";
  });
}

/**
 * The text of markup too deeply nested for any DOM, in one linear pass: raw
 * text elements and skipped elements stay out, block tags break lines, every
 * other tag goes, a few entities are decoded, and the bound stops the pass.
 */
function strippedText(html: string, budget: number): Readonly<{ text: string; title: string | null; stopped: boolean }> {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  let produced = 0;
  let title: string | null = null;
  let cursor = 0;
  const pattern = tagPattern();
  for (let match = pattern.exec(lower); match && produced <= budget; match = pattern.exec(lower)) {
    const text = decodeEntities(html.slice(cursor, match.index)).replace(/\s+/gu, " ");
    parts.push(text);
    produced += text.length;
    const name = match[2]!.toUpperCase();
    cursor = pattern.lastIndex;
    if (!match[1] && (RAW_TEXT_TAGS.has(name.toLowerCase()) || name === "SVG" || name === "MATH")) {
      const end = rawTextEnd(lower, name.toLowerCase(), cursor);
      if (name === "TITLE" && title === null) title = collapseTitle(decodeEntities(html.slice(cursor, end)));
      cursor = end;
      pattern.lastIndex = end;
      continue;
    }
    if (BLOCKS.has(name) || /^H[1-6]$/u.test(name) || name === "BR" || name === "LI" || name === "TR" || name === "PRE") parts.push("\n\n");
  }
  if (produced <= budget) parts.push(decodeEntities(html.slice(cursor)).replace(/\s+/gu, " "));
  return { stopped: produced > budget, text: tidy(parts.join("")), title };
}

function htmlText(html: string, finalUrl: string, budget: number): Readonly<{ text: string; title: string | null; stopped: boolean }> {
  if (exceedsNesting(html, MAX_TAG_NESTING)) return strippedText(html, budget);
  // linkedom keeps only what an explicit <body> holds; parse5 builds the tree
  // as browsers do (implied html/head/body, foster parenting) and serializes
  // it complete, so a fragment or a page without those tags reads the same.
  const document5 = parse5(html);
  const tree = document5 as unknown as Tree5Node;
  if (treeExceeds(tree, MAX_HTML_DEPTH, READABILITY_MAX_ELEMENTS)) return plainTreeText(tree, budget);
  try {
    return readableText(serialize(document5), finalUrl, budget);
  } catch (error) {
    // A library that still runs out of stack leaves the iterative walk.
    if (error instanceof RangeError) return plainTreeText(tree, budget);
    throw error;
  }
}

function readableText(document5: string, finalUrl: string, budget: number): Readonly<{ text: string; title: string | null; stopped: boolean }> {
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
