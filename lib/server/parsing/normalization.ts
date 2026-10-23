import { parse, type DefaultTreeAdapterMap } from "parse5";
import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import { DocumentParserError } from "./errors";
import { parsedTableText, portionParsedTable } from "./tableLimits";
import type {
  ParsedBoundingBox,
  ParsedDocument,
  ParsedDocumentAsset,
  ParsedDocumentBlock,
  ParsedDocumentBlockType,
  ParsedDocumentWarningCode,
  ParsedTable,
  ParsedTableCell,
  SidecarParserEngine
} from "./types";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlParentNode = DefaultTreeAdapterMap["parentNode"];
type HtmlElement = DefaultTreeAdapterMap["element"];

type MutableBlock = {
  assetIds?: string[];
  boundingBoxes?: ParsedBoundingBox[];
  headingPath: string[];
  isTable: boolean;
  page: number;
  pageEnd?: number;
  table?: ParsedTable | null;
  text: string;
  type?: ParsedDocumentBlockType;
};

const MAX_NORMALIZED_BLOCKS = 100_000;
/** HTML clamps: https://html.spec.whatwg.org/#attr-tdth-colspan */
const HTML_MAX_COLUMN_SPAN = 1_000;
const HTML_MAX_ROW_SPAN = 65_534;

function invalid(engine: SidecarParserEngine): never {
  throw new DocumentParserError("parser_invalid_output", engine);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\r\n?/gu, "\n").replace(/[\f\v ]+/gu, " ").replace(/ *\n */gu, "\n").trim()
    : "";
}

function addBlock(blocks: MutableBlock[], block: MutableBlock, engine: SidecarParserEngine): void {
  const text = normalizedText(block.text);
  if (!text && !(block.type === "image" && (block.assetIds?.length ?? 0) > 0)) return;
  if (blocks.length >= MAX_NORMALIZED_BLOCKS) invalid(engine);
  blocks.push({
    headingPath: [...block.headingPath],
    isTable: block.isTable,
    page: block.page,
    ...(block.assetIds ? { assetIds: [...block.assetIds] } : {}),
    ...(block.boundingBoxes ? { boundingBoxes: [...block.boundingBoxes] } : {}),
    ...(block.pageEnd ? { pageEnd: block.pageEnd } : {}),
    ...(block.table !== undefined ? { table: block.table } : {}),
    ...(block.type ? { type: block.type } : {}),
    text
  });
}

function finalizedDocument(input: Readonly<{
  assets?: ParsedDocumentAsset[];
  blocks: MutableBlock[];
  engine: SidecarParserEngine;
  mediaType: string;
  pageCount: number;
  status: "complete" | "partial";
  warnings?: readonly ParsedDocumentWarningCode[];
}>): ParsedDocument {
  const blocks: ParsedDocumentBlock[] = input.blocks.map((block, index) => Object.freeze({
    assetIds: Object.freeze([...(block.assetIds ?? [])]),
    boundingBoxes: Object.freeze([...(block.boundingBoxes ?? [])]),
    headingPath: Object.freeze([...block.headingPath]),
    index,
    isTable: block.isTable,
    languageHints: parsedLanguageHints(block.text),
    page: block.page,
    pageEnd: block.pageEnd ?? block.page,
    readingOrder: index,
    table: block.table ?? null,
    text: block.text,
    type: block.type ?? (block.isTable ? "table" : "paragraph")
  }));
  let pageCount = Math.max(1, input.pageCount);
  for (const block of blocks) pageCount = Math.max(pageCount, block.pageEnd);

  return finalizeParsedDocument({
    assets: input.assets ?? [],
    blocks,
    engine: input.engine,
    mediaType: input.mediaType,
    pageCount,
    status: input.status,
    warnings: input.warnings ?? []
  });
}

type NormalizedTableBlocks = Readonly<{
  degraded: boolean;
  parts: readonly Readonly<{ table: ParsedTable | null; text: string }>[];
}>;

/** Applies the shared table bounds: lossless row portions, or unstructured
 * text for a table wider than the column bound. Both are reported. */
function tableBlocks(
  cells: readonly ParsedTableCell[],
  rowCount: number,
  columnCount: number
): NormalizedTableBlocks {
  const portioning = portionParsedTable({ cells, columnCount, rowCount });
  if (!portioning) return { degraded: false, parts: [] };
  if (portioning.kind === "text_only") {
    return {
      degraded: portioning.text !== "",
      parts: [{ table: null, text: portioning.text }]
    };
  }
  return {
    degraded: portioning.portions.length > 1,
    parts: portioning.portions.map((table) => ({ table, text: parsedTableText(table) }))
  };
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}

function childNodes(node: HtmlNode): HtmlNode[] {
  return "childNodes" in node ? node.childNodes : [];
}

function attribute(element: HtmlElement, name: string): string | undefined {
  return element.attrs.find((item) => item.name.toLowerCase() === name)?.value;
}

function htmlText(node: HtmlNode): string {
  if ("value" in node) return node.value;
  if (isElement(node) && ["script", "style"].includes(node.tagName)) return "";
  const separator = isElement(node) && ["br", "div", "li", "p", "tr"].includes(node.tagName)
    ? "\n"
    : " ";
  return childNodes(node).map(htmlText).join(separator);
}

function findFirstElement(node: HtmlNode, tagName: string): HtmlElement | undefined {
  if (isElement(node) && node.tagName === tagName) return node;
  for (const child of childNodes(node)) {
    const match = findFirstElement(child, tagName);
    if (match) return match;
  }
  return undefined;
}

function pageElements(node: HtmlNode, result: HtmlElement[] = []): HtmlElement[] {
  if (isElement(node)) {
    const classes = attribute(node, "class")?.split(/\s+/u) ?? [];
    if (node.tagName === "div" && classes.includes("page")) {
      result.push(node);
      return result;
    }
  }
  for (const child of childNodes(node)) pageElements(child, result);
  return result;
}

function descendants(element: HtmlElement, tagName: string): HtmlElement[] {
  const result: HtmlElement[] = [];
  function visit(node: HtmlNode): void {
    if (isElement(node) && node.tagName === tagName) result.push(node);
    for (const child of childNodes(node)) visit(child);
  }
  visit(element);
  return result;
}

function htmlSpan(value: string | undefined, maximum: number): number {
  const parsed = Number(value ?? "1");
  return Number.isSafeInteger(parsed) && parsed >= 1 ? Math.min(parsed, maximum) : 1;
}

function tikaTable(table: HtmlElement): NormalizedTableBlocks {
  const rows = descendants(table, "tr");
  let columnCount = 0;
  const values: ParsedTableCell[] = [];
  rows.forEach((row, rowIndex) => {
    const cells = childNodes(row).filter((node): node is HtmlElement =>
      isElement(node) && (node.tagName === "td" || node.tagName === "th")
    );
    let column = 0;
    for (const cell of cells) {
      const columnSpan = htmlSpan(attribute(cell, "colspan"), HTML_MAX_COLUMN_SPAN);
      values.push({
        column,
        columnSpan,
        row: rowIndex,
        rowSpan: htmlSpan(attribute(cell, "rowspan"), HTML_MAX_ROW_SPAN),
        text: normalizedText(htmlText(cell))
      });
      column += columnSpan;
    }
    columnCount = Math.max(columnCount, column);
  });
  return tableBlocks(values, rows.length, columnCount);
}

function tikaBlocksForPage(
  root: HtmlParentNode | HtmlElement,
  page: number,
  headingPath: string[],
  blocks: MutableBlock[],
  assets: ParsedDocumentAsset[],
  tables: { degraded: boolean }
): void {
  let emitted = false;

  function visit(node: HtmlNode): void {
    if (!isElement(node)) {
      return;
    }
    if (["head", "script", "style"].includes(node.tagName)) return;

    const heading = /^h([1-6])$/u.exec(node.tagName);
    if (heading) {
      const text = normalizedText(htmlText(node));
      if (text) {
        const index = Number(heading[1]) - 1;
        headingPath.splice(index, headingPath.length - index, text);
        addBlock(blocks, { headingPath, isTable: false, page, text, type: "heading" }, "tika");
        emitted = true;
      }
      return;
    }

    if (node.tagName === "table") {
      const normalized = tikaTable(node);
      tables.degraded ||= normalized.degraded;
      for (const { table, text } of normalized.parts) {
        if (!text) continue;
        addBlock(blocks, { headingPath, isTable: true, page, table, text, type: "table" }, "tika");
        emitted = true;
      }
      return;
    }

    if (node.tagName === "img") {
      const id = `tika-image-${assets.length}`;
      const caption = normalizedText(attribute(node, "alt"));
      assets.push(Object.freeze({
        boundingBoxes: Object.freeze([]),
        caption: caption || null,
        id,
        kind: "image",
        page
      }));
      addBlock(blocks, {
        assetIds: [id],
        headingPath,
        isTable: false,
        page,
        text: caption,
        type: "image"
      }, "tika");
      emitted = true;
      return;
    }

    if (["blockquote", "figcaption", "li", "p", "pre"].includes(node.tagName)) {
      const text = normalizedText(htmlText(node));
      if (text) {
        addBlock(blocks, {
          headingPath,
          isTable: false,
          page,
          text,
          type: node.tagName === "li"
            ? "list_item"
            : node.tagName === "pre"
              ? "code"
              : node.tagName === "figcaption"
                ? "caption"
                : "paragraph"
        }, "tika");
        emitted = true;
      }
      return;
    }

    for (const child of childNodes(node)) visit(child);
  }

  for (const child of childNodes(root)) visit(child);
  if (!emitted) {
    addBlock(blocks, {
      headingPath,
      isTable: false,
      page,
      text: normalizedText(htmlText(root))
    }, "tika");
  }
}

export function normalizeTikaResponse(value: unknown, mediaType: string): ParsedDocument {
  if (!Array.isArray(value) || !isRecord(value[0])) invalid("tika");
  const content = value[0]["X-TIKA:content"];
  if (typeof content !== "string") invalid("tika");

  const document = parse(content);
  const pages = pageElements(document);
  const roots: Array<HtmlParentNode | HtmlElement> = pages.length > 0
    ? pages
    : [findFirstElement(document, "body") ?? document];
  const blocks: MutableBlock[] = [];
  const assets: ParsedDocumentAsset[] = [];
  const headingPath: string[] = [];
  const tables = { degraded: false };

  roots.forEach((root, index) => tikaBlocksForPage(
    root,
    index + 1,
    headingPath,
    blocks,
    assets,
    tables
  ));

  return finalizedDocument({
    assets,
    blocks,
    engine: "tika",
    mediaType,
    pageCount: roots.length,
    status: "complete",
    warnings: tables.degraded ? ["table_extraction_degraded"] : []
  });
}
