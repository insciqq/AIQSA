import { parsedLanguageHints } from "./assessment";
import type {
  ParsedDocumentBlock,
  ParsedDocumentBlockType,
  ParsedTable
} from "./types";

const INLINE_MARKDOWN_MAX_BLOCKS = 100_000;

function normalizedCell(value: string): string {
  return value.replace(/\\\|/gu, "|").replace(/\s+/gu, " ").trim();
}

function markdownCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const cells: string[] = [];
  let current = "";
  let separators = 0;
  for (let index = 0; index < trimmed.length; index += 1) {
    const character = trimmed[index]!;
    if (character !== "|") {
      current += character;
      continue;
    }
    let precedingBackslashes = 0;
    for (let offset = current.length - 1; offset >= 0 && current[offset] === "\\"; offset -= 1) {
      precedingBackslashes += 1;
    }
    if (precedingBackslashes % 2 === 1) {
      current = `${current.slice(0, -1)}|`;
      continue;
    }
    cells.push(normalizedCell(current));
    current = "";
    separators += 1;
  }
  cells.push(normalizedCell(current));
  if (separators === 0) return null;
  if (cells[0] === "") cells.shift();
  if (cells.at(-1) === "") cells.pop();
  return cells.length > 1 ? cells : null;
}

function delimiterRow(cells: readonly string[]): boolean {
  return cells.length > 1 && cells.every((cell) =>
    /^:?-{3,}:?$/u.test(cell.replace(/\s+/gu, ""))
  );
}

function parsedTable(rows: readonly (readonly string[])[]): ParsedTable {
  const columnCount = Math.max(...rows.map((row) => row.length));
  return Object.freeze({
    cells: Object.freeze(rows.flatMap((row, rowIndex) =>
      Array.from({ length: columnCount }, (_, column) => Object.freeze({
        column,
        columnSpan: 1,
        row: rowIndex,
        rowSpan: 1,
        text: row[column] ?? ""
      })))),
    columnCount,
    rowCount: rows.length
  });
}

function tableText(rows: readonly (readonly string[])[]): string {
  const columnCount = Math.max(...rows.map((row) => row.length));
  return rows.map((row) => Array.from(
    { length: columnCount },
    (_, column) => row[column] ?? ""
  ).join("\t").trimEnd()).join("\n");
}

type PendingBlock = Readonly<{
  headingPath: readonly string[];
  table?: ParsedTable | null;
  text: string;
  type: ParsedDocumentBlockType;
}>;

function completeBlock(input: PendingBlock, index: number): ParsedDocumentBlock {
  return Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: Object.freeze([]),
    headingPath: Object.freeze([...input.headingPath]),
    index,
    isTable: input.type === "table",
    languageHints: parsedLanguageHints(input.text),
    page: 1,
    pageEnd: 1,
    readingOrder: index,
    table: input.table ?? null,
    text: input.text,
    type: input.type
  });
}

/**
 * Bounded structure extraction for trusted-local inline Markdown parsing.
 * It deliberately implements only durable block semantics needed by the
 * Knowledge pipeline: headings, fenced code, list items, paragraphs, and GFM
 * pipe tables with an explicit delimiter row. Inline formatting remains text.
 */
export function parseInlineMarkdownBlocks(text: string): readonly ParsedDocumentBlock[] {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const pending: PendingBlock[] = [];
  const headings: Array<Readonly<{ level: number; text: string }>> = [];
  let paragraph: string[] = [];

  const headingPath = (): readonly string[] => headings.map(({ text: value }) => value);

  const push = (block: PendingBlock): void => {
    if (pending.length >= INLINE_MARKDOWN_MAX_BLOCKS) {
      throw new Error("inline_markdown_block_limit_exceeded");
    }
    pending.push(block);
  };
  const flushParagraph = (): void => {
    const value = paragraph.join("\n").trim();
    paragraph = [];
    if (value) push({ headingPath: headingPath(), text: value, type: "paragraph" });
  };

  let index = 0;
  while (index < lines.length) {
    const rawLine = lines[index]!;
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      index += 1;
      continue;
    }

    const fence = /^(`{3,}|~{3,})/u.exec(line);
    if (fence) {
      flushParagraph();
      const marker = fence[1]![0]!;
      const markerLength = fence[1]!.length;
      const closingFence = new RegExp(
        `^\\s{0,3}${marker === "`" ? "`" : "~"}{${markerLength},}\\s*$`,
        "u"
      );
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !closingFence.test(lines[index]!)) {
        code.push(lines[index]!);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const value = code.join("\n").trim();
      if (value) push({ headingPath: headingPath(), text: value, type: "code" });
      continue;
    }

    const header = markdownCells(rawLine);
    const delimiter = index + 1 < lines.length ? markdownCells(lines[index + 1]!) : null;
    if (header && delimiter && delimiter.length === header.length && delimiterRow(delimiter)) {
      flushParagraph();
      const rows: string[][] = [header];
      index += 2;
      while (index < lines.length) {
        const row = markdownCells(lines[index]!);
        if (!row || delimiterRow(row)) break;
        rows.push(row);
        index += 1;
      }
      const table = parsedTable(rows);
      push({
        headingPath: headingPath(),
        table,
        text: tableText(rows),
        type: "table"
      });
      continue;
    }

    const heading = /^(#{1,6})\s+(.+)$/u.exec(line);
    if (heading) {
      flushParagraph();
      const level = heading[1]!.length;
      const value = heading[2]!.trim();
      while (headings.at(-1) && headings.at(-1)!.level >= level) headings.pop();
      push({
        headingPath: headingPath(),
        text: value,
        type: level === 1 ? "title" : "heading"
      });
      headings.push({ level, text: value });
      index += 1;
      continue;
    }

    if (/^(?:[-+*]|\d+[.)])\s+/u.test(line)) {
      flushParagraph();
      push({ headingPath: headingPath(), text: line, type: "list_item" });
      index += 1;
      continue;
    }

    paragraph.push(line);
    index += 1;
  }
  flushParagraph();
  return Object.freeze(pending.map(completeBlock));
}
