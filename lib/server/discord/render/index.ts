import type { ThreadCitation } from "@/lib/contracts/chats";
import { parseMarkdown, type MarkdownBlock, type MarkdownInline } from "@/lib/domain/markdown/parser";
import { discordWorkingStatus } from "../copy";
import { redactOutgoing } from "../redaction";
import {
  citationHrefs, codeBlock, dropMarkup, escapeDiscordText, FOOTNOTE_DEFINITION, guardLineStarts, inlineCode, linkedText,
  neutralizeMentions, safeDiscordHref
} from "./text";

export { escapeDiscordText, neutralizeMentions, safeDiscordHref } from "./text";

/** Discord's message content limit. */
export const DISCORD_MESSAGE_MAX_CHARS = 2000;
/** Where a too long answer is cut, at a block boundary (PRD D-20). */
export const DISCORD_TRUNCATE_TARGET_CHARS = 1500;
/** Discord's status line bound (PRD D-19). */
export const DISCORD_STATUS_MAX_CHARS = 100;
/** Model text past this point is never shown, so it is neither redacted nor parsed. */
const MAX_RENDER_INPUT = 100_000;
const MAX_LIST_INDENT_DEPTH = 4;
const MAX_FORMAT_DEPTH = 3;
const TABLE_MAX_COLUMNS = 5;
const TABLE_MAX_WIDTH = 72;
const TABLE_CELL_PAD = 24;
const ELLIPSIS = "…";

export type DiscordAnswerInput = Readonly<{
  markdown: string;
  /** Accepts artifactSummary.citations; a `[N]` links only to its own checked `http(s)` address. */
  citations?: readonly ThreadCitation[];
  maxChars?: number;
  /** Characters the caller keeps free for its own text (a file line, a note). */
  reserve?: number;
}>;

export type DiscordRenderedAnswer = Readonly<{
  content: string;
  truncated: boolean;
  /** Secrets replaced with `[redacted]`; a count for metrics, never the text. */
  redactions: number;
}>;

type Context = Readonly<{ citations: ReadonlyMap<string, string>; quoted: boolean; listDepth: number }>;

/**
 * Model Markdown becomes the content of one Discord message (PRD D-20, D-22):
 * redacted first, then parsed into the bounded tree and written back as the
 * Discord subset (headings, lists, bold, italic, strike, code, quotes) with
 * every model character escaped. Tables become a monospace block, or bullet
 * rows when too wide; raw HTML, images and footnotes are dropped; links are
 * only checked `http(s)` addresses. An answer over `maxChars - reserve` is cut
 * at a block boundary near 1500 characters, with open code fences closed and
 * `…` appended. The caller still sends `allowed_mentions: {parse: []}`.
 */
export function renderDiscordAnswer(input: DiscordAnswerInput): DiscordRenderedAnswer {
  const limit = Math.max(0, Math.floor((input.maxChars ?? DISCORD_MESSAGE_MAX_CHARS) - (input.reserve ?? 0)));
  let markdown = typeof input.markdown === "string" ? input.markdown : "";
  let inputCut = false;
  if (markdown.length > MAX_RENDER_INPUT) {
    // Cut at a line end so no token is split; only a private key spans lines, and an unterminated one redacts to the end.
    const lineEnd = markdown.lastIndexOf("\n", MAX_RENDER_INPUT);
    markdown = markdown.slice(0, lineEnd > MAX_RENDER_INPUT / 2 ? lineEnd : MAX_RENDER_INPUT);
    inputCut = true;
  }
  const redacted = redactOutgoing(markdown);
  const context: Context = { citations: citationHrefs(input.citations), quoted: false, listDepth: 0 };
  const document = parseMarkdown(redacted.text);
  const pieces = document
    ? document.blocks.map(block => renderBlock(block, context))
    : [guardLineStarts(escapeDiscordText(dropMarkup(redacted.text)))];
  if (document?.overflow) pieces.push(guardLineStarts(escapeDiscordText(dropMarkup(document.overflow))));
  const blocks = pieces.filter(piece => piece.trim().length > 0);
  const full = blocks.join("\n\n");
  const fits = !inputCut && full.length <= limit;
  const content = boundContent(fits ? full : truncateBlocks(blocks, limit), limit);
  return { content, truncated: !fits, redactions: redacted.count };
}

export type DiscordStatusLine = Readonly<{ content: string; redactions: number }>;

/** `Working · m:ss — <activity>` within 100 characters, the activity redacted and escaped (PRD D-19, D-22). */
export function formatDiscordStatus(elapsedMs: number, activity?: string | null): DiscordStatusLine {
  const clock = discordWorkingStatus(elapsedMs);
  if (!activity?.trim()) return { content: clock, redactions: 0 };
  const label = discordInlineText(activity, DISCORD_STATUS_MAX_CHARS - clock.length - 3);
  return label.content ? { content: `${clock} — ${label.content}`, redactions: label.redactions } : { content: clock, redactions: label.redactions };
}

/**
 * One line of untrusted text for Discord (a failure reason, an activity, a
 * name in a notice): redacted, whitespace collapsed, escaped, at most
 * `maxChars` characters with `…` when cut.
 */
export function discordInlineText(value: string, maxChars: number): DiscordStatusLine {
  const redacted = redactOutgoing(String(value ?? "").replace(/\s+/gu, " ").trim());
  const escaped = escapeDiscordText(dropMarkup(redacted.text)).trim();
  return { content: cutText(escaped, Math.max(0, maxChars)), redactions: redacted.count };
}

function cutText(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 1) return "";
  return `${sliceSafe(value, maxChars - 1).trimEnd()}${ELLIPSIS}`;
}

/**
 * A prefix that never ends inside a surrogate pair, a `<url>` or `[N](<url>)`
 * link (a cut address), or an inline code span: an unclosed span would show
 * its content as markup, and inline code keeps `<`, `[` and `](` verbatim.
 */
function sliceSafe(value: string, end: number): string {
  const code = value.charCodeAt(end - 1);
  let part = value.slice(0, code >= 0xd800 && code <= 0xdbff ? end - 1 : end);
  const span = openCodeSpanStart(part);
  if (span !== null) part = part.slice(0, span);
  // Model text has no bare `<` (each one carries a zero-width space), so one here opens this renderer's link.
  const open = /(?:\[[1-9]\d{0,3}\]\(| \()?(?:<(?:h[^\s<>]*)?)?$/u.exec(part);
  return open ? part.slice(0, open.index) : part;
}

/**
 * Where an inline code span left open on the last line starts. Spans never
 * cross lines here, model backticks outside code are escaped, and fenced
 * lines are skipped.
 */
function openCodeSpanStart(part: string): number | null {
  const lines = part.split("\n");
  const last = lines.at(-1) ?? "";
  if (lines.slice(0, -1).filter(line => FENCE_LINE.test(line)).length % 2 === 1 || FENCE_LINE.test(last)) return null;
  let open = -1;
  let run = 0;
  for (let index = 0; index < last.length; index += 1) {
    if (open < 0 && last[index] === "\\") {
      index += 1;
      continue;
    }
    if (last[index] !== "`") continue;
    let end = index;
    while (last[end] === "`") end += 1;
    if (open < 0) {
      open = index;
      run = end - index;
    } else if (end - index === run) {
      open = -1;
    }
    index = end - 1;
  }
  return open < 0 ? null : part.length - last.length + open;
}

function renderInline(nodes: readonly MarkdownInline[], context: Context, inLink = false, depth = 0): string {
  let out = "";
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index]!;
    switch (node.type) {
      case "text": {
        let value = dropMarkup(node.value);
        const next = nodes[index + 1];
        // Images are off in the parser, so `![alt](src)` arrives as a `!` and a link: drop both.
        if (next?.type === "link" && value.endsWith("!")) {
          value = value.slice(0, -1);
          index += 1;
        }
        out += inLink ? escapeDiscordText(value) : linkedText(value, context.citations);
        break;
      }
      case "break": out += "\n"; break;
      case "inlineCode": out += inlineCode(node.value); break;
      case "inlineMath": out += inlineCode(node.source); break;
      case "citation": out += escapeDiscordText(node.source); break;
      case "strong": out += wrap("**", renderInline(node.children, context, inLink, depth + 1), depth); break;
      case "emphasis": out += wrap("*", renderInline(node.children, context, inLink, depth + 1), depth); break;
      case "delete": out += wrap("~~", renderInline(node.children, context, inLink, depth + 1), depth); break;
      case "link": {
        const label = renderInline(node.children, context, true, depth + 1);
        const href = inLink ? null : safeDiscordHref(node.url);
        if (!href) out += label;
        else if (!label.trim() || label === escapeDiscordText(node.url)) out += `<${href}>`;
        else out += `${label} (<${href}>)`;
        break;
      }
    }
  }
  return out;
}

function wrap(marker: string, content: string, depth: number): string {
  if (!content.trim() || depth >= MAX_FORMAT_DEPTH) return content;
  return `${marker}${content}${marker}`;
}

function plainInline(nodes: readonly MarkdownInline[]): string {
  return nodes.map((node): string => {
    switch (node.type) {
      case "text": return dropMarkup(node.value);
      case "break": return " ";
      case "inlineCode": return node.value;
      case "inlineMath": return node.source;
      case "citation": return node.source;
      case "strong": case "emphasis": case "delete": case "link": return plainInline(node.children);
    }
  }).join("").replace(/\s+/gu, " ").trim();
}

function oneLine(value: string): string {
  return value.replace(/\s*\n\s*/gu, " ").trim();
}

/** Blocks nested in a quote or a list item, one per line: a blank line would end the quote or the item. */
function renderBlocks(blocks: readonly MarkdownBlock[], context: Context): string {
  return blocks.map(block => renderBlock(block, context)).filter(piece => piece.trim().length > 0).join("\n");
}

function renderBlock(block: MarkdownBlock, context: Context): string {
  switch (block.type) {
    case "paragraph": {
      const first = block.children[0];
      if (first?.type === "text" && FOOTNOTE_DEFINITION.test(first.value)) return "";
      return guardLineStarts(renderInline(block.children, context));
    }
    case "heading": {
      const text = oneLine(renderInline(block.children, context));
      if (!text) return "";
      return block.level <= 3 ? `${"#".repeat(block.level)} ${text}` : `**${text}**`;
    }
    case "thematicBreak": return "───";
    case "literal": return guardLineStarts(escapeDiscordText(dropMarkup(block.value)));
    case "math": return codeBlock(block.source);
    case "code": return codeBlock(block.code, block.language);
    case "blockquote": {
      // Discord has one quote level: nested quotes render inside it.
      const inner = renderBlocks(block.children, { ...context, quoted: true });
      if (context.quoted || !inner.trim()) return inner;
      return inner.split("\n").map(line => `> ${line}`).join("\n");
    }
    case "list": {
      const indent = context.listDepth < MAX_LIST_INDENT_DEPTH;
      const inner: Context = { ...context, listDepth: context.listDepth + 1 };
      return block.items.map((item, index) => {
        const marker = block.ordered ? `${(block.start ?? 1) + index}. ` : "- ";
        const body = renderBlocks(item, inner);
        if (!body.trim()) return "";
        const lines = body.split("\n");
        const pad = indent ? " ".repeat(marker.length) : "";
        return [`${marker}${lines[0]}`, ...lines.slice(1).map(line => line ? `${pad}${line}` : line)].join("\n");
      }).filter(Boolean).join("\n");
    }
    case "table": return renderTable(block, context);
  }
}

function renderTable(block: Extract<MarkdownBlock, { type: "table" }>, context: Context): string {
  const plain = [block.header, ...block.rows].map(row => row.map(cell => plainInline(cell)));
  const columns = Math.max(0, ...plain.map(row => row.length));
  const widths = Array.from({ length: columns }, (_, column) =>
    Math.min(TABLE_CELL_PAD, Math.max(0, ...plain.map(row => row[column]?.length ?? 0))));
  const rowWidth = widths.reduce((sum, width) => sum + width, 0) + 3 * Math.max(0, columns - 1);
  const longest = Math.max(0, ...plain.map(row => row.join(" | ").length));
  if (columns <= TABLE_MAX_COLUMNS && Math.max(rowWidth, longest) <= TABLE_MAX_WIDTH) {
    const line = (row: string[]) => widths.map((width, column) => (row[column] ?? "").padEnd(width)).join(" | ").trimEnd();
    const [header, ...rows] = plain;
    return codeBlock([line(header ?? []), widths.map(width => "-".repeat(Math.max(1, width))).join("-|-"), ...rows.map(line)].join("\n"));
  }
  // Too wide for a phone: one bullet per row, each cell named by its header.
  const headers = block.header.map(cell => oneLine(renderInline(cell, context)));
  const rows = block.rows.length ? block.rows : [block.header];
  return rows.map(row => {
    const cells = row.map((cell, column) => {
      const value = oneLine(renderInline(cell, context));
      const header = block.rows.length ? headers[column] : "";
      return value && header ? `**${header}:** ${value}` : value;
    }).filter(Boolean);
    return cells.length ? `- ${guardLineStarts(cells.join(" · "))}` : "";
  }).filter(Boolean).join("\n");
}

/** The content up to `limit`: whole blocks up to about 1500 characters, then `…`. */
function truncateBlocks(blocks: readonly string[], limit: number): string {
  // Room for the closing "\n\n…".
  const budget = Math.max(0, Math.min(DISCORD_TRUNCATE_TARGET_CHARS, limit - 4));
  let kept = "";
  let index = 0;
  for (; index < blocks.length; index += 1) {
    const next = kept ? `${kept}\n\n${blocks[index]}` : blocks[index]!;
    if (next.length > budget) break;
    kept = next;
  }
  // Keep a fair share of a long block rather than leaving the message nearly empty.
  if (index < blocks.length && kept.length < budget * 0.6) {
    const room = budget - kept.length - (kept ? 2 : 0);
    const part = cutBlock(blocks[index]!, room);
    if (part) return `${kept ? `${kept}\n\n` : ""}${part}${part.endsWith("```") ? "\n" : " "}${ELLIPSIS}`;
  }
  return kept ? `${kept}\n\n${ELLIPSIS}` : ELLIPSIS;
}

/** A block cut at a line or word end within `room`, with an open code fence closed. */
function cutBlock(block: string, room: number): string {
  const size = Math.max(0, room - FENCE_CLOSE_RESERVE);
  if (size < 16) return "";
  let cut = block.lastIndexOf("\n", size);
  if (cut < size * 0.5) cut = block.lastIndexOf(" ", size);
  if (cut < size * 0.5) cut = size;
  return closeOpenFence(sliceSafe(block, cut).trimEnd());
}

const FENCE_LINE = /^([ ]*(?:> )?[ ]*)```/u;
/** Room for "\n" plus the widest closing fence a cut adds. */
const FENCE_CLOSE_RESERVE = 16;

/** Closes a code fence left open, with its opening line's indent and quote prefix. */
function closeOpenFence(part: string): string {
  const fences = part.split("\n").filter(line => FENCE_LINE.test(line));
  if (fences.length % 2 === 0) return part;
  return `${part}\n${FENCE_LINE.exec(fences.at(-1)!)?.[1] ?? ""}\`\`\``;
}

/** Last line of defense: mention forms broken everywhere and the limit held. */
function boundContent(content: string, limit: number): string {
  const safe = neutralizeMentions(content);
  if (safe.length <= limit) return safe;
  if (limit <= FENCE_CLOSE_RESERVE + 2) return limit >= 1 ? ELLIPSIS : "";
  return `${closeOpenFence(sliceSafe(safe, limit - FENCE_CLOSE_RESERVE - 2).trimEnd())}\n${ELLIPSIS}`;
}
