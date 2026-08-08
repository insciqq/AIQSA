import { parse, type DefaultTreeAdapterMap } from "parse5";
import { DocumentParserError } from "./errors";
import type {
  ParsedDocument,
  ParsedDocumentBlock,
  SidecarParserEngine
} from "./types";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlParentNode = DefaultTreeAdapterMap["parentNode"];
type HtmlElement = DefaultTreeAdapterMap["element"];

type MutableBlock = {
  headingPath: string[];
  isTable: boolean;
  page: number;
  text: string;
};

const MAX_NORMALIZED_BLOCKS = 100_000;
const MAX_TABLE_CELLS = 10_000;
const MAX_TABLE_COLUMNS = 200;
const MAX_TABLE_ROWS = 2_000;

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

function positivePage(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) > 0 ? value as number : undefined;
}

function pageOf(item: Record<string, unknown>): number {
  if (!Array.isArray(item.prov)) return 1;
  for (const value of item.prov) {
    if (!isRecord(value)) continue;
    const page = positivePage(value.page_no);
    if (page) return page;
  }
  return 1;
}

function addBlock(blocks: MutableBlock[], block: MutableBlock, engine: SidecarParserEngine): void {
  const text = normalizedText(block.text);
  if (!text) return;
  if (blocks.length >= MAX_NORMALIZED_BLOCKS) invalid(engine);
  blocks.push({
    headingPath: [...block.headingPath],
    isTable: block.isTable,
    page: block.page,
    text
  });
}

function finalizedDocument(input: Readonly<{
  blocks: MutableBlock[];
  engine: SidecarParserEngine;
  mediaType: string;
  pageCount: number;
  status: "complete" | "partial";
}>): ParsedDocument {
  const blocks: ParsedDocumentBlock[] = input.blocks.map((block, index) => Object.freeze({
    headingPath: Object.freeze([...block.headingPath]),
    index,
    isTable: block.isTable,
    page: block.page,
    text: block.text
  }));
  let pageCount = Math.max(1, input.pageCount);
  for (const block of blocks) pageCount = Math.max(pageCount, block.page);

  return Object.freeze({
    blocks: Object.freeze(blocks),
    engine: input.engine,
    mediaType: input.mediaType,
    pageCount,
    status: input.status,
    text: blocks.map((block) => block.text).join("\n\n")
  });
}

function doclingTableText(item: Record<string, unknown>): string {
  if (!isRecord(item.data) || !Array.isArray(item.data.table_cells)) return "";
  const cells = item.data.table_cells;
  if (cells.length > MAX_TABLE_CELLS) invalid("docling");

  let rowCount = 0;
  let columnCount = 0;
  const values: Array<{ column: number; row: number; text: string }> = [];

  for (const candidate of cells) {
    if (!isRecord(candidate)) continue;
    const row = candidate.start_row_offset_idx;
    const column = candidate.start_col_offset_idx;
    const endRow = candidate.end_row_offset_idx;
    const endColumn = candidate.end_col_offset_idx;
    if (
      !Number.isSafeInteger(row)
      || !Number.isSafeInteger(column)
      || !Number.isSafeInteger(endRow)
      || !Number.isSafeInteger(endColumn)
      || (row as number) < 0
      || (column as number) < 0
      || (endRow as number) <= (row as number)
      || (endColumn as number) <= (column as number)
      || (endRow as number) > MAX_TABLE_ROWS
      || (endColumn as number) > MAX_TABLE_COLUMNS
    ) {
      invalid("docling");
    }

    rowCount = Math.max(rowCount, endRow as number);
    columnCount = Math.max(columnCount, endColumn as number);
    const text = normalizedText(candidate.text);
    if (text) values.push({ column: column as number, row: row as number, text });
  }

  if (rowCount * columnCount > MAX_TABLE_CELLS * 4) invalid("docling");
  if (rowCount === 0 || columnCount === 0) return "";

  const rows = Array.from({ length: rowCount }, () => Array<string>(columnCount).fill(""));
  for (const value of values) {
    rows[value.row][value.column] = value.text;
  }
  return rows.map((row) => row.join("\t").trimEnd()).filter(Boolean).join("\n");
}

function doclingPageCount(document: Record<string, unknown>): number {
  let pageCount = 1;
  if (!isRecord(document.pages)) return pageCount;

  for (const [key, value] of Object.entries(document.pages)) {
    const keyPage = Number(key);
    if (positivePage(keyPage)) pageCount = Math.max(pageCount, keyPage);
    if (isRecord(value)) {
      const itemPage = positivePage(value.page_no);
      if (itemPage) pageCount = Math.max(pageCount, itemPage);
    }
  }
  return pageCount;
}

export function normalizeDoclingResponse(value: unknown, mediaType: string): ParsedDocument {
  if (!isRecord(value)) invalid("docling");
  const status = value.status;
  if (status !== "success" && status !== "partial_success") invalid("docling");
  if (!isRecord(value.document) || !isRecord(value.document.json_content)) invalid("docling");

  const document = value.document.json_content;
  if (document.schema_name !== "DoclingDocument") invalid("docling");
  if (!isRecord(document.body) || !Array.isArray(document.body.children)) invalid("docling");

  const collections = {
    field_items: Array.isArray(document.field_items) ? document.field_items : [],
    field_regions: Array.isArray(document.field_regions) ? document.field_regions : [],
    form_items: Array.isArray(document.form_items) ? document.form_items : [],
    groups: Array.isArray(document.groups) ? document.groups : [],
    key_value_items: Array.isArray(document.key_value_items) ? document.key_value_items : [],
    pictures: Array.isArray(document.pictures) ? document.pictures : [],
    tables: Array.isArray(document.tables) ? document.tables : [],
    texts: Array.isArray(document.texts) ? document.texts : []
  };
  const blocks: MutableBlock[] = [];
  const headingPath: string[] = [];
  let hasTitle = false;
  const visitedContainers = new Set<string>();

  function updateHeading(item: Record<string, unknown>, text: string): void {
    if (item.label === "title") {
      headingPath.splice(0, headingPath.length, text);
      hasTitle = true;
      return;
    }

    if (item.label !== "section_header") return;
    const level = Number.isSafeInteger(item.level) && (item.level as number) > 0
      ? Math.min(item.level as number, 32)
      : 1;
    const index = (hasTitle ? 1 : 0) + level - 1;
    headingPath.splice(index, headingPath.length - index, text);
  }

  function visit(reference: unknown): void {
    if (!isRecord(reference) || typeof reference.$ref !== "string") invalid("docling");
    const match = /^#\/(field_items|field_regions|form_items|groups|key_value_items|pictures|tables|texts)\/(0|[1-9]\d*)$/u.exec(reference.$ref);
    if (!match) invalid("docling");

    const index = Number(match[2]);
    if (!Number.isSafeInteger(index)) invalid("docling");
    const collectionName = match[1] as keyof typeof collections;
    const collection = collections[collectionName];
    const item = collection[index];
    if (!isRecord(item)) invalid("docling");
    if (item.content_layer === "furniture") return;

    if (["field_items", "field_regions", "groups"].includes(collectionName)) {
      const visitKey = `${collectionName}/${index}`;
      if (visitedContainers.has(visitKey)) return;
      visitedContainers.add(visitKey);
      if (!Array.isArray(item.children)) invalid("docling");
      for (const child of item.children) visit(child);
      return;
    }

    if (collectionName === "pictures") return;

    if (collectionName === "form_items" || collectionName === "key_value_items") {
      // Docling graph regions are valid body nodes but do not define a stable
      // linear reading order. Validate their reviewed shape and omit them from
      // the ordered text projection, as we already do for pictures.
      if (
        !isRecord(item.graph)
        || !Array.isArray(item.graph.cells)
        || !Array.isArray(item.graph.links)
      ) {
        invalid("docling");
      }
      return;
    }

    if (collectionName === "tables") {
      addBlock(blocks, {
        headingPath,
        isTable: true,
        page: pageOf(item),
        text: doclingTableText(item)
      }, "docling");
      return;
    }

    const text = normalizedText(item.text);
    if (!text) return;
    updateHeading(item, text);
    addBlock(blocks, {
      headingPath,
      isTable: false,
      page: pageOf(item),
      text
    }, "docling");
  }

  for (const child of document.body.children) visit(child);

  return finalizedDocument({
    blocks,
    engine: "docling",
    mediaType,
    pageCount: doclingPageCount(document),
    status: status === "partial_success" ? "partial" : "complete"
  });
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

function tikaTableText(table: HtmlElement): string {
  const rows = descendants(table, "tr").slice(0, MAX_TABLE_ROWS);
  if (rows.length === 0) return normalizedText(htmlText(table));
  let cellCount = 0;
  return rows.map((row) => {
    const cells = childNodes(row).filter((node): node is HtmlElement =>
      isElement(node) && (node.tagName === "td" || node.tagName === "th")
    );
    cellCount += cells.length;
    if (cellCount > MAX_TABLE_CELLS || cells.length > MAX_TABLE_COLUMNS) invalid("tika");
    return cells.map((cell) => normalizedText(htmlText(cell))).join("\t").trimEnd();
  }).filter(Boolean).join("\n");
}

function tikaBlocksForPage(
  root: HtmlParentNode | HtmlElement,
  page: number,
  headingPath: string[],
  blocks: MutableBlock[]
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
        addBlock(blocks, { headingPath, isTable: false, page, text }, "tika");
        emitted = true;
      }
      return;
    }

    if (node.tagName === "table") {
      const text = tikaTableText(node);
      if (text) {
        addBlock(blocks, { headingPath, isTable: true, page, text }, "tika");
        emitted = true;
      }
      return;
    }

    if (["blockquote", "li", "p", "pre"].includes(node.tagName)) {
      const text = normalizedText(htmlText(node));
      if (text) {
        addBlock(blocks, { headingPath, isTable: false, page, text }, "tika");
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
  const headingPath: string[] = [];

  roots.forEach((root, index) => tikaBlocksForPage(root, index + 1, headingPath, blocks));

  return finalizedDocument({
    blocks,
    engine: "tika",
    mediaType,
    pageCount: roots.length,
    status: "complete"
  });
}
