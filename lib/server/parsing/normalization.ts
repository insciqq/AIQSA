import { parse, type DefaultTreeAdapterMap } from "parse5";
import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import { DocumentParserError } from "./errors";
import type {
  ParsedBoundingBox,
  ParsedDocument,
  ParsedDocumentAsset,
  ParsedDocumentBlock,
  ParsedDocumentBlockType,
  ParsedFieldCell,
  ParsedFieldCellLabel,
  ParsedFieldGroup,
  ParsedFieldLink,
  ParsedFieldLinkLabel,
  ParsedTable,
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
const MAX_FIELD_BOUNDING_BOXES = 256;
const MAX_FIELD_CELLS = 100_000;
const MAX_FIELD_CELLS_PER_GROUP = 10_000;
const MAX_FIELD_GROUPS = 10_000;
const MAX_FIELD_LINKS = 200_000;
const MAX_FIELD_LINKS_PER_GROUP = 20_000;
const MAX_FIELD_REF_LENGTH = 512;
const MAX_FIELD_TEXT_LENGTH = 32_767;
const MAX_TABLE_CELLS = 10_000;
const MAX_TABLE_COLUMNS = 200;
const MAX_TABLE_ROWS = 2_000;
const FIELD_CELL_LABELS: readonly ParsedFieldCellLabel[] = [
  "checkbox",
  "key",
  "unspecified",
  "value"
];
const FIELD_LINK_LABELS: readonly ParsedFieldLinkLabel[] = [
  "to_child",
  "to_key",
  "to_parent",
  "to_value",
  "unspecified"
];

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

function boundedConfidence(item: Record<string, unknown>): number | null {
  if (item.confidence === undefined || item.confidence === null) return null;
  if (
    typeof item.confidence !== "number" || !Number.isFinite(item.confidence) ||
    item.confidence < 0 || item.confidence > 1
  ) invalid("docling");
  return item.confidence;
}

function boundedFieldText(value: unknown): string {
  if (
    typeof value !== "string" || value.length > MAX_FIELD_TEXT_LENGTH ||
    /\u0000/u.test(value)
  ) invalid("docling");
  return value;
}

function fieldItemRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || Object.keys(value).some((key) => key !== "$ref") ||
    typeof value.$ref !== "string" || value.$ref.length > MAX_FIELD_REF_LENGTH ||
    !/^#(?:\/(?:[\w-]+)(?:\/(?:0|[1-9]\d*))?)?$/u.test(value.$ref)) {
    invalid("docling");
  }
  return value.$ref;
}

function provenanceBox(value: unknown): ParsedBoundingBox | null {
  if (!isRecord(value) || !isRecord(value.bbox)) return null;
  const page = positivePage(value.page_no);
  const { b, l, r, t } = value.bbox;
  if (value.bbox.coord_origin !== "TOPLEFT" && value.bbox.coord_origin !== "BOTTOMLEFT") {
    return null;
  }
  const coordinateOrigin = value.bbox.coord_origin === "TOPLEFT"
    ? "top_left"
    : "bottom_left";
  if (
    !page ||
    ![b, l, r, t].every((candidate) => typeof candidate === "number" && Number.isFinite(candidate)) ||
    Number(l) > Number(r) ||
    (coordinateOrigin === "top_left" ? Number(b) < Number(t) : Number(b) > Number(t))
  ) return null;
  return Object.freeze({
    bottom: Number(b),
    coordinateOrigin,
    left: Number(l),
    page,
    right: Number(r),
    top: Number(t)
  });
}

function fieldGroupProvenance(item: Record<string, unknown>): Readonly<{
  boxes: readonly ParsedBoundingBox[];
  pages: readonly number[];
}> {
  if (item.prov === undefined || item.prov === null) {
    return Object.freeze({ boxes: Object.freeze([]), pages: Object.freeze([]) });
  }
  if (!Array.isArray(item.prov) || item.prov.length > MAX_FIELD_BOUNDING_BOXES) {
    invalid("docling");
  }
  const boxes: ParsedBoundingBox[] = [];
  const pages: number[] = [];
  for (const provenance of item.prov) {
    if (!isRecord(provenance)) invalid("docling");
    const page = positivePage(provenance.page_no);
    if (!page) invalid("docling");
    pages.push(page);
    if (provenance.bbox !== undefined && provenance.bbox !== null) {
      const box = provenanceBox(provenance);
      if (!box) invalid("docling");
      boxes.push(box);
    }
  }
  return Object.freeze({
    boxes: Object.freeze(boxes),
    pages: Object.freeze(pages)
  });
}

function pageRangeOf(item: Record<string, unknown>): Readonly<{ page: number; pageEnd: number }> {
  const pages = Array.isArray(item.prov)
    ? item.prov.flatMap((value) => {
        if (!isRecord(value)) return [];
        const page = positivePage(value.page_no);
        return page ? [page] : [];
      })
    : [];
  return pages.length > 0
    ? Object.freeze({ page: Math.min(...pages), pageEnd: Math.max(...pages) })
    : Object.freeze({ page: 1, pageEnd: 1 });
}

function boundingBoxesOf(item: Record<string, unknown>): ParsedBoundingBox[] {
  if (!Array.isArray(item.prov)) return [];
  const result: ParsedBoundingBox[] = [];
  for (const provenance of item.prov) {
    const box = provenanceBox(provenance);
    if (box) result.push(box);
  }
  return result;
}

function fieldCellBoxes(item: Record<string, unknown>): readonly ParsedBoundingBox[] {
  if (item.prov === undefined || item.prov === null) return Object.freeze([]);
  const box = provenanceBox(item.prov);
  if (!box) invalid("docling");
  return Object.freeze([box]);
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
  fieldGroups?: ParsedFieldGroup[];
  mediaType: string;
  pageCount: number;
  status: "complete" | "partial";
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
  for (const group of input.fieldGroups ?? []) pageCount = Math.max(pageCount, group.pageEnd);

  return finalizeParsedDocument({
    assets: input.assets ?? [],
    blocks,
    engine: input.engine,
    fieldGroups: input.fieldGroups ?? [],
    mediaType: input.mediaType,
    pageCount,
    status: input.status
  });
}

function doclingTable(item: Record<string, unknown>): ParsedTable | null {
  if (!isRecord(item.data) || !Array.isArray(item.data.table_cells)) return null;
  const cells = item.data.table_cells;
  if (cells.length > MAX_TABLE_CELLS) invalid("docling");

  let rowCount = 0;
  let columnCount = 0;
  const values: Array<{
    column: number;
    columnSpan: number;
    row: number;
    rowSpan: number;
    text: string;
  }> = [];

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
    if (text) values.push({
      column: column as number,
      columnSpan: (endColumn as number) - (column as number),
      row: row as number,
      rowSpan: (endRow as number) - (row as number),
      text
    });
  }

  if (rowCount * columnCount > MAX_TABLE_CELLS * 4) invalid("docling");
  if (rowCount === 0 || columnCount === 0) return null;
  return Object.freeze({
    cells: Object.freeze(values.map((value) => Object.freeze(value))),
    columnCount,
    rowCount
  });
}

function tableText(table: ParsedTable | null): string {
  if (!table) return "";
  const rows = Array.from({ length: table.rowCount }, () => Array<string>(table.columnCount).fill(""));
  for (const cell of table.cells) rows[cell.row]![cell.column] = cell.text;
  return rows.map((row) => row.join("\t").trimEnd()).filter(Boolean).join("\n");
}

function doclingFieldGroup(
  item: Record<string, unknown>,
  kind: ParsedFieldGroup["kind"],
  sourceRef: string,
  readingOrder: number
): ParsedFieldGroup {
  if (
    item.self_ref !== sourceRef || !isRecord(item.graph) ||
    !Array.isArray(item.graph.cells) || !Array.isArray(item.graph.links) ||
    item.graph.cells.length > MAX_FIELD_CELLS_PER_GROUP ||
    item.graph.links.length > MAX_FIELD_LINKS_PER_GROUP
  ) invalid("docling");

  const cellIds = new Set<number>();
  const cells: ParsedFieldCell[] = item.graph.cells.map((candidate, order) => {
    if (!isRecord(candidate) || !FIELD_CELL_LABELS.includes(candidate.label as ParsedFieldCellLabel) ||
      !Number.isSafeInteger(candidate.cell_id) || Number(candidate.cell_id) < 0 ||
      cellIds.has(Number(candidate.cell_id))) invalid("docling");
    const id = Number(candidate.cell_id);
    cellIds.add(id);
    return Object.freeze({
      boundingBoxes: fieldCellBoxes(candidate),
      confidence: boundedConfidence(candidate),
      id,
      itemRef: fieldItemRef(candidate.item_ref),
      label: candidate.label as ParsedFieldCellLabel,
      order,
      originalText: boundedFieldText(candidate.orig),
      text: boundedFieldText(candidate.text)
    });
  });

  const linkKeys = new Set<string>();
  const links: ParsedFieldLink[] = item.graph.links.map((candidate, order) => {
    if (!isRecord(candidate) || !FIELD_LINK_LABELS.includes(candidate.label as ParsedFieldLinkLabel) ||
      !Number.isSafeInteger(candidate.source_cell_id) || Number(candidate.source_cell_id) < 0 ||
      !Number.isSafeInteger(candidate.target_cell_id) || Number(candidate.target_cell_id) < 0) {
      invalid("docling");
    }
    const sourceCellId = Number(candidate.source_cell_id);
    const targetCellId = Number(candidate.target_cell_id);
    if (!cellIds.has(sourceCellId) || !cellIds.has(targetCellId)) invalid("docling");
    const key = `${candidate.label}:${sourceCellId}:${targetCellId}`;
    if (linkKeys.has(key)) invalid("docling");
    linkKeys.add(key);
    return Object.freeze({
      confidence: boundedConfidence(candidate),
      label: candidate.label as ParsedFieldLinkLabel,
      order,
      sourceCellId,
      targetCellId
    });
  });
  const provenance = fieldGroupProvenance(item);
  const boundingBoxes = provenance.boxes;
  const pages = [
    ...provenance.pages,
    ...boundingBoxes.map((box) => box.page),
    ...cells.flatMap((cell) => cell.boundingBoxes.map((box) => box.page))
  ];
  if (pages.length === 0) pages.push(1);
  return Object.freeze({
    boundingBoxes,
    cells: Object.freeze(cells),
    confidence: boundedConfidence(item),
    kind,
    links: Object.freeze(links),
    page: Math.min(...pages),
    pageEnd: Math.max(...pages),
    readingOrder,
    sourceRef
  });
}

function doclingBlockType(item: Record<string, unknown>): ParsedDocumentBlockType {
  switch (item.label) {
    case "title": return "title";
    case "section_header": return "heading";
    case "list_item": return "list_item";
    case "code": return "code";
    case "caption": return "caption";
    case "footnote":
    case "page_footer": return "footnote";
    default: return "paragraph";
  }
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
  const assets: ParsedDocumentAsset[] = [];
  const fieldGroups: ParsedFieldGroup[] = [];
  const headingPath: string[] = [];
  let hasTitle = false;
  let totalFieldCells = 0;
  let totalFieldLinks = 0;
  const visitedContainers = new Set<string>();
  const visitedFieldGroups = new Set<string>();

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

    if (collectionName === "pictures") {
      const assetId = `docling-picture-${index}`;
      const boxes = boundingBoxesOf(item);
      const { page, pageEnd } = pageRangeOf(item);
      if (pageEnd !== page) invalid("docling");
      assets.push(Object.freeze({
        boundingBoxes: Object.freeze(boxes),
        caption: null,
        id: assetId,
        kind: item.label === "chart" ? "chart" : item.label === "diagram" ? "diagram" : "image",
        page
      }));
      addBlock(blocks, {
        assetIds: [assetId],
        boundingBoxes: boxes,
        headingPath,
        isTable: false,
        page,
        pageEnd,
        text: "",
        type: "image"
      }, "docling");
      return;
    }

    if (collectionName === "form_items" || collectionName === "key_value_items") {
      if (visitedFieldGroups.has(reference.$ref) || fieldGroups.length >= MAX_FIELD_GROUPS) {
        invalid("docling");
      }
      visitedFieldGroups.add(reference.$ref);
      const group = doclingFieldGroup(
        item,
        collectionName === "form_items" ? "form" : "key_value",
        reference.$ref,
        blocks.length
      );
      totalFieldCells += group.cells.length;
      totalFieldLinks += group.links.length;
      if (totalFieldCells > MAX_FIELD_CELLS || totalFieldLinks > MAX_FIELD_LINKS) invalid("docling");
      fieldGroups.push(group);
      return;
    }

    if (collectionName === "tables") {
      const table = doclingTable(item);
      const { page, pageEnd } = pageRangeOf(item);
      addBlock(blocks, {
        boundingBoxes: boundingBoxesOf(item),
        headingPath,
        isTable: true,
        page,
        pageEnd,
        table,
        text: tableText(table),
        type: "table"
      }, "docling");
      return;
    }

    const text = normalizedText(item.text);
    if (!text) return;
    updateHeading(item, text);
    const { page, pageEnd } = pageRangeOf(item);
    addBlock(blocks, {
      boundingBoxes: boundingBoxesOf(item),
      headingPath,
      isTable: false,
      page,
      pageEnd,
      text,
      type: doclingBlockType(item)
    }, "docling");
  }

  for (const child of document.body.children) visit(child);

  return finalizedDocument({
    assets,
    blocks,
    engine: "docling",
    fieldGroups,
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

function tikaTable(table: HtmlElement): ParsedTable | null {
  const rows = descendants(table, "tr").slice(0, MAX_TABLE_ROWS);
  if (rows.length === 0) return null;
  let cellCount = 0;
  let columnCount = 0;
  const values: Array<{
    column: number;
    columnSpan: number;
    row: number;
    rowSpan: number;
    text: string;
  }> = [];
  rows.forEach((row, rowIndex) => {
    const cells = childNodes(row).filter((node): node is HtmlElement =>
      isElement(node) && (node.tagName === "td" || node.tagName === "th")
    );
    cellCount += cells.length;
    if (cellCount > MAX_TABLE_CELLS || cells.length > MAX_TABLE_COLUMNS) invalid("tika");
    let column = 0;
    for (const cell of cells) {
      const parsedColumnSpan = Number(attribute(cell, "colspan") ?? "1");
      const parsedRowSpan = Number(attribute(cell, "rowspan") ?? "1");
      const columnSpan = Number.isSafeInteger(parsedColumnSpan) && parsedColumnSpan >= 1 && parsedColumnSpan <= MAX_TABLE_COLUMNS
        ? parsedColumnSpan
        : 1;
      const rowSpan = Number.isSafeInteger(parsedRowSpan) && parsedRowSpan >= 1 && parsedRowSpan <= MAX_TABLE_ROWS
        ? parsedRowSpan
        : 1;
      values.push({
        column,
        columnSpan,
        row: rowIndex,
        rowSpan,
        text: normalizedText(htmlText(cell))
      });
      column += columnSpan;
    }
    columnCount = Math.max(columnCount, column);
  });
  if (columnCount === 0) return null;
  return Object.freeze({
    cells: Object.freeze(values.map((value) => Object.freeze(value))),
    columnCount,
    rowCount: rows.length
  });
}

function tikaBlocksForPage(
  root: HtmlParentNode | HtmlElement,
  page: number,
  headingPath: string[],
  blocks: MutableBlock[],
  assets: ParsedDocumentAsset[]
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
      const table = tikaTable(node);
      const text = tableText(table);
      if (text) {
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

  roots.forEach((root, index) => tikaBlocksForPage(
    root,
    index + 1,
    headingPath,
    blocks,
    assets
  ));

  return finalizedDocument({
    assets,
    blocks,
    engine: "tika",
    mediaType,
    pageCount: roots.length,
    status: "complete"
  });
}
