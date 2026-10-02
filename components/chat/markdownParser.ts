import MarkdownIt from "markdown-it";
import type { StateBlock, StateInline, Token } from "markdown-it";

/**
 * Client-safe Markdown adapter for chat rendering. It never produces HTML: it
 * returns a bounded, typed tree that `MarkdownMessage` turns into React text and
 * the reviewed Shiki/KaTeX components.
 *
 * Dialect: CommonMark + GFM tables + GFM `~~strikethrough~~`. Raw HTML, angle
 * autolinks, bare-URL autolinks, setext headings, indented code, images, link
 * reference definitions/references, task lists and footnotes are disabled at the
 * tokenizer, so their source stays literal text.
 */

/** Container (block quote + list) nesting cap; deeper content renders as literal text. */
export const MAX_NESTING_DEPTH = 32;
/** Emphasis/link nesting cap inside one inline run; deeper markup renders literally. */
export const MAX_INLINE_DEPTH = 32;
/** Input above this many characters is parsed only up to the last newline at or before it. */
export const MAX_INPUT_CHARACTERS = 600_000;
/** Rendering stops before the top-level block that would exceed this many tree nodes. */
export const MAX_TREE_NODES = 50_000;

export type MarkdownInline =
  | { type: "text"; value: string }
  | { type: "break" }
  | { type: "strong" | "emphasis" | "delete"; children: MarkdownInline[] }
  | { type: "inlineCode"; value: string }
  | { type: "link"; url: string; source: string; children: MarkdownInline[] }
  | { type: "citation"; handle: string; source: string }
  | { type: "inlineMath"; source: string; raw: string };

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "heading"; level: number; children: MarkdownInline[] }
  | { type: "thematicBreak" }
  | { type: "blockquote"; children: MarkdownBlock[] }
  | { type: "list"; ordered: boolean; start: number | null; loose: boolean; items: MarkdownBlock[][] }
  | { type: "code"; language: string; code: string; closed: boolean; opening: string }
  | { type: "math"; source: string; raw: string }
  | { type: "table"; header: MarkdownInline[][]; rows: MarkdownInline[][][] }
  | { type: "literal"; value: string };

export type MarkdownDocument = {
  blocks: MarkdownBlock[];
  /** Source the bounds left unparsed; renders as one pre-wrap text paragraph. */
  overflow: string | null;
};

type ParseContext = {
  depth: number;
  /** Marker indentation of each enclosing list item; -1 for a block quote. */
  items: number[];
  closeLines: Map<string, Int32Array>;
  mathFailure: { blkIndent: number; from: number; until: number } | null;
  parenFailures: WeakMap<StateInline, { posMax: number; until: number }>;
};

type BlockRule = (state: StateBlock, startLine: number, endLine: number, silent: boolean) => boolean;
type InlineRule = (state: StateInline, silent: boolean) => boolean;

const contexts = new WeakMap<object, ParseContext>();

function contextOf(env: object): ParseContext {
  let context = contexts.get(env);
  if (!context) {
    context = { closeLines: new Map(), depth: 0, items: [], mathFailure: null, parenFailures: new WeakMap() };
    contexts.set(env, context);
  }
  return context;
}

function originalRule<Rule>(rules: Array<{ name: string; fn: unknown; alt: string[] }>, name: string) {
  const rule = rules.find((candidate) => candidate.name === name);
  if (!rule) throw new Error(`markdown-it rule ${name} is missing`);
  return { alt: rule.alt.slice(), fn: rule.fn as Rule };
}

function lineText(state: StateBlock, line: number): string {
  return state.src.slice(state.bMarks[line] + state.tShift[line], state.eMarks[line]);
}

/** Column of the first non-space character from the container's line start (tabs to multiples of 4). */
function lineIndent(state: StateBlock, line: number): number {
  let column = 0;
  for (let position = state.bMarks[line]; position < state.eMarks[line]; position++) {
    const char = state.src.charCodeAt(position);
    if (char === 0x09) column += 4 - ((column + state.bsCount[line]) % 4);
    else if (char === 0x20) column += 1;
    else break;
  }
  return column;
}

const LIST_MARKER = /^(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/u;
const NON_EMPTY_ORDERED_MARKER = /^\d{1,9}[.)][ \t]+\S/u;

// GFM row split: a `|` after an odd number of backslashes is cell text, and only
// that one backslash is removed before inline parsing (code spans and math too).
function tableRowCells(line: string): string[] {
  const row = line.trim();
  const cells: string[] = [];
  let cell = "";
  let backslashes = 0;
  let endsWithBoundary = false;

  for (const char of row) {
    endsWithBoundary = false;
    if (char === "|" && backslashes % 2 === 1) {
      cell = `${cell.slice(0, -1)}|`;
    } else if (char === "|") {
      cells.push(cell);
      cell = "";
      endsWithBoundary = true;
    } else {
      cell += char;
    }
    backslashes = char === "\\" ? backslashes + 1 : 0;
  }
  cells.push(cell);

  if (row.startsWith("|")) cells.shift();
  if (endsWithBoundary && row.length > 1) cells.pop();
  return cells.map((value) => value.trim());
}

function displayMathDelimiter(text: string): { close: string; open: string } | null {
  if (text.startsWith("\\[")) return { close: "\\]", open: "\\[" };
  return text.startsWith("$$") && !text.startsWith("$$$") ? { close: "$$", open: "$$" } : null;
}

/** First line at or after `from` whose end (ignoring trailing whitespace) is `close`; -1 if none. */
function nextClosingLine(state: StateBlock, context: ParseContext, close: string, from: number): number {
  let lines = context.closeLines.get(close);
  if (!lines) {
    lines = new Int32Array(state.lineMax + 1).fill(-1);
    for (let line = state.lineMax - 1; line >= 0; line--) {
      // Line ends are container independent, so one table serves every container.
      let end = state.eMarks[line];
      while (end > 0 && (state.src.charCodeAt(end - 1) === 0x20 || state.src.charCodeAt(end - 1) === 0x09)) end--;
      lines[line] = state.src.startsWith(close, end - close.length) && end - close.length >= 0 ? line : lines[line + 1];
    }
    context.closeLines.set(close, lines);
  }
  return from < state.lineMax ? lines[from] : -1;
}

/** `\[ … \]` and `$$ … $$` blocks; an unclosed opener stays paragraph text. */
function displayMathRule(state: StateBlock, startLine: number, endLine: number, silent: boolean): boolean {
  const first = lineText(state, startLine);
  const delimiter = displayMathDelimiter(first);
  if (!delimiter) return false;

  const context = contextOf(state.env);
  const rest = first.slice(delimiter.open.length).trimEnd();
  let closeLine = rest.endsWith(delimiter.close) ? startLine : nextClosingLine(state, context, delimiter.close, startLine + 1);
  if (closeLine < 0 || closeLine >= endLine) return false;

  // Every line up to the closer must still belong to this container.
  const failure = context.mathFailure;
  if (failure && failure.blkIndent === state.blkIndent && startLine > failure.from && closeLine > failure.until && startLine < failure.until) {
    return false;
  }
  for (let line = startLine + 1; line <= closeLine; line++) {
    if (!state.isEmpty(line) && state.sCount[line] < state.blkIndent) {
      context.mathFailure = { blkIndent: state.blkIndent, from: startLine, until: line };
      closeLine = -1;
      break;
    }
  }
  if (closeLine < 0) return false;

  const lines = state.getLines(startLine, closeLine + 1, state.blkIndent, false).split("\n");
  const sourceLines = lines.map((line, index) => {
    let candidate = index === 0 ? line.trim().slice(delimiter.open.length) : line;
    if (index === lines.length - 1) candidate = candidate.slice(0, candidate.lastIndexOf(delimiter.close));
    return candidate;
  });
  const source = sourceLines.join("\n").trim();
  if (!source) return false;
  if (silent) return true;

  const token = state.push("aiqsa_math_block", "", 0);
  token.content = source;
  token.info = lines.join("\n");
  token.map = [startLine, closeLine + 1];
  state.line = closeLine + 1;
  return true;
}

/** Over-depth containers keep their lines as literal text instead of nesting further. */
function guardContainer(rule: BlockRule): BlockRule {
  return (state, startLine, endLine, silent) => {
    if (contextOf(state.env).depth < MAX_NESTING_DEPTH) return rule(state, startLine, endLine, silent);
    if (!rule(state, startLine, endLine, true)) return false;
    if (silent) return true;

    // Like a paragraph, the literal also absorbs lazy lines (negative sCount); otherwise every
    // enclosing quote would end and restart at each lazy line.
    let line = startLine + 1;
    while (line < endLine && !state.isEmpty(line) && (state.sCount[line] >= state.blkIndent || state.sCount[line] < 0)) line++;
    const token = state.push("aiqsa_literal", "", 0);
    token.content = Array.from({ length: line - startLine }, (_, index) =>
      state.src.slice(state.bMarks[startLine + index], state.eMarks[startLine + index])).join("\n");
    token.map = [startLine, line];
    state.line = line;
    return true;
  };
}

/**
 * Lenient nesting: inside a list item, an ordered item whose marker is indented
 * more than the item's own marker may interrupt the item's paragraph.
 */
function lenientList(rule: BlockRule): BlockRule {
  return (state, startLine, endLine, silent) => {
    const marker = contextOf(state.env).items.at(-1) ?? -1;
    if (
      silent &&
      state.parentType === "paragraph" &&
      marker >= 0 &&
      state.sCount[startLine] > marker &&
      NON_EMPTY_ORDERED_MARKER.test(lineText(state, startLine))
    ) {
      state.parentType = "list";
      try {
        return rule(state, startLine, endLine, silent);
      } finally {
        state.parentType = "paragraph";
      }
    }
    return rule(state, startLine, endLine, silent);
  };
}

function closedFence(rule: BlockRule): BlockRule {
  return (state, startLine, endLine, silent) => {
    const tokenCount = state.tokens.length;
    const matched = rule(state, startLine, endLine, silent);
    if (!matched || silent) return matched;
    const token = state.tokens.slice(tokenCount).find((candidate) => candidate.type === "fence");
    if (token?.map) {
      const last = token.map[1] - 1;
      const text = last > startLine ? lineText(state, last) : "";
      const closing = /^(`{3,}|~{3,})[ \t]*$/u.exec(text);
      token.meta = {
        closed: Boolean(
          closing &&
          closing[1][0] === token.markup[0] &&
          closing[1].length >= token.markup.length &&
          state.sCount[last] - state.blkIndent < 4
        ),
        opening: lineText(state, startLine)
      };
    }
    return true;
  };
}

function oddBackslashTableCells(rule: BlockRule): BlockRule {
  return (state, startLine, endLine, silent) => {
    const tokenCount = state.tokens.length;
    if (!rule(state, startLine, endLine, silent)) return false;
    if (silent) return true;
    let cells: string[] = [];
    let cellIndex = 0;
    for (let index = tokenCount; index < state.tokens.length; index++) {
      const token = state.tokens[index];
      if (token.type === "tr_open" && token.map) {
        cells = tableRowCells(lineText(state, token.map[0]));
        cellIndex = 0;
      } else if (token.type === "inline") {
        token.content = cells[cellIndex] ?? "";
        cellIndex += 1;
      }
    }
    return true;
  };
}

const CITATION = /\[(K[1-9]\d{0,3}(?:\.[1-9]\d?)?)\]/uy;

/** Known Knowledge citation handles; escaped, coded or entity-encoded brackets never reach this rule. */
function citationRule(state: StateInline, silent: boolean): boolean {
  // Inside link-label scanning a citation must stay plain brackets, or `[[K1]](url)` stops being a link.
  if (silent || state.src.charCodeAt(state.pos) !== 0x5b) return false;
  CITATION.lastIndex = state.pos;
  const match = CITATION.exec(state.src);
  if (!match || match.index !== state.pos) return false;
  const token = state.push("aiqsa_citation", "", 0);
  token.content = match[1];
  token.markup = match[0];
  state.pos += match[0].length;
  return true;
}

function pushInlineMath(state: StateInline, silent: boolean, end: number, source: string) {
  if (!silent) {
    const token = state.push("aiqsa_math_inline", "", 0);
    token.content = source;
    token.markup = state.src.slice(state.pos, end);
  }
  state.pos = end;
  return true;
}

/** `\( … \)` on one line, with no backticks; `\\(` is an escaped backslash first. */
function parenMathRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x5c || state.src.charCodeAt(start + 1) !== 0x28) return false;
  // A failed scan from an earlier opener proves every opener before its stop fails too.
  const failures = contextOf(state.env).parenFailures;
  const failure = failures.get(state);
  if (failure && failure.posMax === state.posMax && start < failure.until) return false;
  for (let index = start + 2; index < state.posMax; index++) {
    const char = state.src.charCodeAt(index);
    if (char === 0x0a || char === 0x60) {
      failures.set(state, { posMax: state.posMax, until: index });
      return false;
    }
    if (char === 0x5c) {
      if (state.src.charCodeAt(index + 1) === 0x29 && index + 1 < state.posMax) {
        return pushInlineMath(state, silent, index + 2, state.src.slice(start + 2, index));
      }
    }
  }
  failures.set(state, { posMax: state.posMax, until: state.posMax });
  return false;
}

function isWhitespace(char: number) {
  return char === 0x20 || char === 0x09 || char === 0x0a || char === 0x0d || char === 0x0c || char === 0x0b ||
    char === 0xa0 || char === 0x1680 || (char >= 0x2000 && char <= 0x200a) || char === 0x2028 ||
    char === 0x2029 || char === 0x202f || char === 0x205f || char === 0x3000 || char === 0xfeff;
}

/** `$…$` on one line: no whitespace inside either delimiter, and a closer never precedes a digit (prices stay text). */
function dollarMathRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  if (state.src.charCodeAt(start) !== 0x24) return false;
  const first = state.src.charCodeAt(start + 1);
  if (start + 1 >= state.posMax || first === 0x24 || isWhitespace(first)) return false;
  for (let index = start + 1; index < state.posMax; index++) {
    const char = state.src.charCodeAt(index);
    if (char === 0x5c) {
      if (index + 1 >= state.posMax || state.src.charCodeAt(index + 1) === 0x0a) return false;
      index += 1;
    } else if (char === 0x0a || char === 0x60) {
      return false;
    } else if (char === 0x24) {
      const before = state.src.charCodeAt(index - 1);
      const after = state.src.charCodeAt(index + 1);
      if (isWhitespace(before) || before === 0x5c || (index + 1 < state.posMax && after >= 0x30 && after <= 0x39)) return false;
      return pushInlineMath(state, silent, index + 1, state.src.slice(start + 1, index));
    }
  }
  return false;
}

/** Links keep their exact source so an unsafe destination can render literally. */
function linkSource(rule: InlineRule): InlineRule {
  return (state, silent) => {
    const start = state.pos;
    const tokenCount = state.tokens.length;
    if (!rule(state, silent)) return false;
    if (!silent) {
      const open = state.tokens.slice(tokenCount).find((token) => token.type === "link_open");
      if (open) open.meta = { source: state.src.slice(start, state.pos) };
    }
    return true;
  };
}

function createParser() {
  const md = new MarkdownIt("commonmark", { html: false, linkify: false, typographer: false });
  // Block nesting must exceed the container cap (a list adds two levels), while inline
  // link-label scanning keeps markdown-it's CommonMark default, which bounds its recursion.
  md.core.ruler.before("block", "aiqsa_block_nesting", () => {
    md.options.maxNesting = 2 * MAX_NESTING_DEPTH + 8;
  });
  md.core.ruler.before("inline", "aiqsa_inline_nesting", () => {
    md.options.maxNesting = 20;
  });
  md.enable(["table", "strikethrough"]);
  md.disable(["code", "html_block", "html_inline", "autolink", "lheading", "reference", "image"]);
  // Link policy belongs to the renderer: every destination is kept verbatim.
  md.validateLink = () => true;
  md.normalizeLink = (url) => url;
  md.normalizeLinkText = (text) => text;

  const blockRules = md.block.ruler.__rules__;
  const list = originalRule<BlockRule>(blockRules, "list");
  const blockquote = originalRule<BlockRule>(blockRules, "blockquote");
  const fence = originalRule<BlockRule>(blockRules, "fence");
  const table = originalRule<BlockRule>(blockRules, "table");
  md.block.ruler.at("list", guardContainer(lenientList(list.fn)), { alt: list.alt });
  md.block.ruler.at("blockquote", guardContainer(blockquote.fn), { alt: blockquote.alt });
  md.block.ruler.at("fence", closedFence(fence.fn), { alt: fence.alt });
  md.block.ruler.at("table", oddBackslashTableCells(table.fn), { alt: table.alt });
  md.block.ruler.after("fence", "aiqsa_math_block", displayMathRule, { alt: ["paragraph", "reference", "blockquote", "list"] });

  const link = originalRule<InlineRule>(md.inline.ruler.__rules__, "link");
  md.inline.ruler.at("link", linkSource(link.fn), { alt: link.alt });
  md.inline.ruler.after("link", "aiqsa_citation", citationRule);
  md.inline.ruler.before("escape", "aiqsa_math_paren", parenMathRule);
  md.inline.ruler.before("escape", "aiqsa_math_dollar", dollarMathRule);

  const tokenize = md.block.tokenize.bind(md.block);
  md.block.tokenize = (state, startLine, endLine) => {
    const parentType = state.parentType;
    if (parentType !== "list" && parentType !== "blockquote") {
      tokenize(state, startLine, endLine);
      return;
    }
    const context = contextOf(state.env);
    const marker = parentType === "list" ? lineIndent(state, startLine) : -1;
    context.depth += 1;
    context.items.push(marker);
    try {
      tokenize(state, startLine, endLine);
      if (parentType !== "list") return;
      // A marker indented past this item's marker but short of its content column still nests here.
      let tight = state.tight;
      let line = state.line;
      while (
        line < endLine &&
        !state.isEmpty(line) &&
        state.sCount[line] > marker &&
        state.sCount[line] < state.blkIndent &&
        LIST_MARKER.test(lineText(state, line))
      ) {
        const separated = state.isEmpty(line - 1);
        const blkIndent = state.blkIndent;
        state.blkIndent = state.sCount[line];
        try {
          tokenize(state, line, endLine);
        } finally {
          state.blkIndent = blkIndent;
        }
        tight = tight && state.tight && !separated;
        if (state.line <= line) break;
        line = state.line;
      }
      state.tight = tight;
    } finally {
      context.depth -= 1;
      context.items.pop();
    }
  };
  return md;
}

let parser: ReturnType<typeof createParser> | null = null;

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let index = source.indexOf("\n"); index >= 0; index = source.indexOf("\n", index + 1)) starts.push(index + 1);
  return starts;
}

type Cursor = { index: number; nodes: number };

function closingIndex(tokens: Token[], index: number): number {
  let level = 0;
  for (let position = index; position < tokens.length; position++) {
    level += tokens[position].nesting;
    if (level === 0) return position;
  }
  return tokens.length - 1;
}

/** Source-like text of an inline token range, used past the inline nesting cap. */
function literalInline(tokens: Token[], start: number, end: number): string {
  let text = "";
  for (let index = start; index <= end; index++) {
    const token = tokens[index];
    if (token.type === "link_open") {
      const source = (token.meta as { source?: string } | null)?.source;
      if (source) {
        text += source;
        index = closingIndex(tokens, index);
        continue;
      }
    }
    if (token.type === "softbreak" || token.type === "hardbreak") text += "\n";
    else if (token.type === "aiqsa_citation" || token.type === "aiqsa_math_inline") text += token.markup;
    else if (token.type === "code_inline") text += `${token.markup}${token.content}${token.markup}`;
    else if (token.nesting !== 0) text += token.markup;
    else text += token.content;
  }
  return text;
}

function buildInline(tokens: Token[], cursor: Cursor, depth: number, endType: string | null): MarkdownInline[] {
  const nodes: MarkdownInline[] = [];
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index];
    if (endType && token.type === endType) {
      cursor.index += 1;
      return nodes;
    }
    cursor.nodes += 1;
    if (token.nesting === 1 && depth >= MAX_INLINE_DEPTH) {
      const end = closingIndex(tokens, cursor.index);
      nodes.push({ type: "text", value: literalInline(tokens, cursor.index, end) });
      cursor.index = end + 1;
      continue;
    }
    cursor.index += 1;
    switch (token.type) {
      case "text":
        nodes.push({ type: "text", value: token.content });
        break;
      case "softbreak":
      case "hardbreak":
        nodes.push({ type: "break" });
        break;
      case "code_inline":
        nodes.push({ type: "inlineCode", value: token.content });
        break;
      case "aiqsa_citation":
        nodes.push({ handle: token.content, source: token.markup, type: "citation" });
        break;
      case "aiqsa_math_inline":
        nodes.push({ raw: token.markup, source: token.content, type: "inlineMath" });
        break;
      case "strong_open":
        nodes.push({ children: buildInline(tokens, cursor, depth + 1, "strong_close"), type: "strong" });
        break;
      case "em_open":
        nodes.push({ children: buildInline(tokens, cursor, depth + 1, "em_close"), type: "emphasis" });
        break;
      case "s_open":
        nodes.push({ children: buildInline(tokens, cursor, depth + 1, "s_close"), type: "delete" });
        break;
      case "link_open": {
        const meta = token.meta as { source?: string } | null;
        nodes.push({
          children: buildInline(tokens, cursor, depth + 1, "link_close"),
          source: meta?.source ?? "",
          type: "link",
          url: String(token.attrGet("href") ?? "")
        });
        break;
      }
      default:
        // Every other inline token (none are enabled) stays inert text.
        if (token.content) nodes.push({ type: "text", value: token.content });
    }
  }
  return nodes;
}

function buildInlineCounted(token: Token | undefined, cursor: Cursor): MarkdownInline[] {
  const inline: Cursor = { index: 0, nodes: 0 };
  const nodes = buildInline(token?.children ?? [], inline, 0, null);
  cursor.nodes += inline.nodes;
  return nodes;
}

function buildBlocks(tokens: Token[], cursor: Cursor, endType: string | null): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  while (cursor.index < tokens.length) {
    const token = tokens[cursor.index];
    if (endType && token.type === endType) {
      cursor.index += 1;
      return blocks;
    }
    const block = buildBlock(tokens, cursor);
    if (block) blocks.push(block);
  }
  return blocks;
}

function buildBlock(tokens: Token[], cursor: Cursor): MarkdownBlock | null {
  const token = tokens[cursor.index];
  cursor.index += 1;
  cursor.nodes += 1;
  switch (token.type) {
    case "paragraph_open": {
      const children = buildInlineCounted(tokens[cursor.index], cursor);
      cursor.index = closingIndex(tokens, cursor.index - 1) + 1;
      return { children, type: "paragraph" };
    }
    case "heading_open": {
      const children = buildInlineCounted(tokens[cursor.index], cursor);
      cursor.index = closingIndex(tokens, cursor.index - 1) + 1;
      return { children, level: Number(token.tag.slice(1)), type: "heading" };
    }
    case "hr":
      return { type: "thematicBreak" };
    case "blockquote_open":
      return { children: buildBlocks(tokens, cursor, "blockquote_close"), type: "blockquote" };
    case "bullet_list_open":
    case "ordered_list_open": {
      const ordered = token.type === "ordered_list_open";
      const closeType = ordered ? "ordered_list_close" : "bullet_list_close";
      const items: MarkdownBlock[][] = [];
      let start: number | null = null;
      let loose = false;
      while (cursor.index < tokens.length && tokens[cursor.index].type !== closeType) {
        const item = tokens[cursor.index];
        cursor.index += 1;
        cursor.nodes += 1;
        if (item.type !== "list_item_open") continue;
        if (ordered && start === null) start = Number.parseInt(item.info, 10);
        const first = tokens[cursor.index];
        if (first?.type === "paragraph_open" && !first.hidden) loose = true;
        items.push(buildBlocks(tokens, cursor, "list_item_close"));
      }
      cursor.index += 1;
      return { items, loose, ordered, start: ordered ? start ?? 1 : null, type: "list" };
    }
    case "fence": {
      const meta = token.meta as { closed?: boolean; opening?: string } | null;
      return {
        closed: meta?.closed ?? true,
        code: token.content && !token.content.endsWith("\n") ? `${token.content}\n` : token.content,
        language: token.info.trim().split(/[ \t]+/u, 1)[0] ?? "",
        opening: meta?.opening ?? token.markup,
        type: "code"
      };
    }
    case "aiqsa_math_block":
      return { raw: token.info, source: token.content, type: "math" };
    case "aiqsa_literal":
      return { type: "literal", value: token.content };
    case "table_open": {
      const header: MarkdownInline[][] = [];
      const rows: MarkdownInline[][][] = [];
      let row: MarkdownInline[][] | null = null;
      let inHead = false;
      while (cursor.index < tokens.length && tokens[cursor.index].type !== "table_close") {
        const part = tokens[cursor.index];
        cursor.index += 1;
        if (part.type === "thead_open") inHead = true;
        else if (part.type === "thead_close") inHead = false;
        else if (part.type === "tr_open") row = [];
        else if (part.type === "tr_close" && row) {
          if (inHead) header.push(...row);
          else rows.push(row);
          row = null;
        } else if (part.type === "inline" && row) {
          cursor.nodes += 1;
          row.push(buildInlineCounted(part, cursor));
        }
      }
      cursor.index += 1;
      return { header, rows, type: "table" };
    }
    default:
      // Disabled constructs never produce tokens; anything unexpected stays literal.
      if (token.nesting === 1) cursor.index = closingIndex(tokens, cursor.index - 1) + 1;
      return token.content ? { type: "literal", value: token.content } : null;
  }
}

// While streaming, a last line holding only a block marker could still become
// ordinary text (`-5`, `1.5`, `#tag`); keep it literal until its content arrives.
const PENDING_MARKER_LINE = /^([ \t>]*)([-*+]|\d{1,9}[.)]|#{1,6})[ \t]*$/u;

function holdPendingMarker(source: string): string {
  const lineStart = source.lastIndexOf("\n") + 1;
  const match = PENDING_MARKER_LINE.exec(source.slice(lineStart));
  if (!match) return source;
  const markerStart = lineStart + match[1].length;
  const escapeAt = /\d/u.test(match[2][0]) ? markerStart + match[2].length - 1 : markerStart;
  return `${source.slice(0, escapeAt)}\\${source.slice(escapeAt)}`;
}

/**
 * Parses chat Markdown into a bounded tree. Never throws: an internal failure
 * returns `null`, and the caller renders the content as plain text.
 */
export function parseMarkdown(content: string, options: { streaming?: boolean } = {}): MarkdownDocument | null {
  try {
    let source = content.replace(/\r\n?/gu, "\n").replace(/\0/gu, "\uFFFD");
    let overflow: string | null = null;
    if (source.length > MAX_INPUT_CHARACTERS) {
      const cut = source.lastIndexOf("\n", MAX_INPUT_CHARACTERS);
      overflow = source.slice(cut + 1);
      source = cut > 0 ? source.slice(0, cut) : "";
    }
    if (options.streaming && overflow === null) source = holdPendingMarker(source);

    parser ??= createParser();
    const tokens = parser.parse(source, {});
    const starts = lineStarts(source);
    const blocks: MarkdownBlock[] = [];
    const cursor: Cursor = { index: 0, nodes: 0 };
    while (cursor.index < tokens.length) {
      const first = tokens[cursor.index];
      const before = cursor.nodes;
      const block = buildBlock(tokens, cursor);
      if (cursor.nodes > MAX_TREE_NODES) {
        const offset = first.map ? starts[first.map[0]] ?? source.length : source.length;
        const rest = source.slice(offset);
        overflow = overflow === null ? rest : `${rest}\n${overflow}`;
        cursor.nodes = before;
        break;
      }
      if (block) blocks.push(block);
    }
    return { blocks, overflow: overflow || null };
  } catch {
    return null;
  }
}
