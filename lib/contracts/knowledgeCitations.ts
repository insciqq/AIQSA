import { decodeKnowledgeCitationHandle } from "./knowledge";

export const KNOWLEDGE_VIEWER_MAX_BLOCKS = 12;
export const KNOWLEDGE_VIEWER_MAX_BOXES = 64;
export const KNOWLEDGE_VIEWER_MAX_TABLE_CELLS = 400;
export const KNOWLEDGE_VIEWER_MAX_WORKBOOK_CELLS = 400;

export type KnowledgeViewerBoundingBox = Readonly<{
  bottom: number;
  coordinateOrigin: "bottom_left" | "top_left";
  left: number;
  page: number;
  right: number;
  top: number;
}>;

export type KnowledgeViewerTableCell = Readonly<{
  column: number;
  columnSpan: number;
  row: number;
  rowSpan: number;
  text: string;
}>;

export type KnowledgeViewerTable = Readonly<{
  cells: readonly KnowledgeViewerTableCell[];
  columnCount: number;
  rowCount: number;
  truncated: boolean;
}>;

export type KnowledgeViewerBlock = Readonly<{
  boundingBoxes: readonly KnowledgeViewerBoundingBox[];
  headingPath: readonly string[];
  pageEnd: number;
  pageStart: number;
  relation: "after" | "before" | "target";
  table: KnowledgeViewerTable | null;
  text: string;
  type:
    | "caption"
    | "code"
    | "footnote"
    | "heading"
    | "image"
    | "list_item"
    | "paragraph"
    | "table"
    | "title";
}>;

export type KnowledgeViewerSourceStatus =
  | "earlier_version"
  | "removed"
  | "trash";

export type KnowledgeViewerWorkbookCell = Readonly<{
  address: string;
  column: number;
  display: string;
  formula: string | null;
  row: number;
  type: "blank" | "boolean" | "date" | "error" | "number" | "string";
  value: boolean | number | string | null;
}>;

export type KnowledgeViewerWorkbookRange = Readonly<{
  cells: readonly KnowledgeViewerWorkbookCell[];
  range: string;
  role: "filter" | "group" | "join" | "read" | "sort" | "value";
  sheet: string;
  sheetIndex: number;
  truncated: boolean;
}>;

export type KnowledgeViewerWorkbook = Readonly<{
  operationSummary: string;
  ranges: readonly KnowledgeViewerWorkbookRange[];
  result: Readonly<{
    columns: readonly string[];
    rows: readonly (readonly (boolean | number | string | null)[])[];
  }>;
  warnings: readonly string[];
}>;

export type KnowledgeViewerVisualEvidence = Readonly<{
  caption: string | null;
  description: string | null;
  kind: "chart" | "diagram" | "image" | "table";
  label: string;
  status: "available" | "unavailable";
  warnings: readonly ("analysis_unavailable" | "original_unavailable")[];
}>;

export type KnowledgeViewerAvailable = Readonly<{
  blocks: readonly KnowledgeViewerBlock[];
  excerpt: string;
  excerptTruncated: boolean;
  headingPath: readonly string[];
  locator: Readonly<{
    boundingBoxes: readonly KnowledgeViewerBoundingBox[];
    pageEnd: number;
    pageStart: number;
  }>;
  originalKind: "image" | "pdf" | null;
  source: Readonly<{
    baseName: string | null;
    fileName: string;
    mimeType: string;
    name: string;
    statuses: readonly KnowledgeViewerSourceStatus[];
    versionNumber: number;
  }>;
  state: "available";
  visual: KnowledgeViewerVisualEvidence | null;
  workbook: KnowledgeViewerWorkbook | null;
}>;

export type KnowledgeCitationViewer =
  | (KnowledgeViewerAvailable & Readonly<{ handle: string }>)
  | Readonly<{ handle: string; state: "deleted" }>;

export type KnowledgeSourceViewer = KnowledgeViewerAvailable;

export type KnowledgeCitationViewerResponse = Readonly<{
  citation: KnowledgeCitationViewer;
}>;

export type KnowledgeSourceViewerResponse = Readonly<{
  source: KnowledgeSourceViewer;
}>;

const BLOCK_TYPES = new Set<KnowledgeViewerBlock["type"]>([
  "caption",
  "code",
  "footnote",
  "heading",
  "image",
  "list_item",
  "paragraph",
  "table",
  "title"
]);

const SOURCE_STATUSES = new Set<KnowledgeViewerSourceStatus>([
  "earlier_version",
  "removed",
  "trash"
]);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): string | null {
  return typeof value === "string" && value.length <= maximum &&
    (allowEmpty || value.length > 0) && !/\u0000/u.test(value)
    ? value
    : null;
}

function positiveInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= maximum
    ? Number(value)
    : null;
}

function nonNegativeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum
    ? Number(value)
    : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringArray(
  value: unknown,
  maximumItems: number,
  maximumLength: number
): readonly string[] | null {
  if (!Array.isArray(value) || value.length > maximumItems) return null;
  const values = value.map((item) => boundedString(item, maximumLength));
  return values.some((item) => item === null) ? null : values as string[];
}

function decodeBoundingBox(value: unknown): KnowledgeViewerBoundingBox | null {
  if (!record(value)) return null;
  const page = positiveInteger(value.page, 100_000);
  const bottom = finiteNumber(value.bottom);
  const left = finiteNumber(value.left);
  const right = finiteNumber(value.right);
  const top = finiteNumber(value.top);
  if (
    page === null || bottom === null || left === null || right === null || top === null ||
    left > right ||
    (value.coordinateOrigin !== "bottom_left" && value.coordinateOrigin !== "top_left") ||
    (value.coordinateOrigin === "top_left" && top > bottom) ||
    (value.coordinateOrigin === "bottom_left" && bottom > top)
  ) return null;
  return {
    bottom,
    coordinateOrigin: value.coordinateOrigin,
    left,
    page,
    right,
    top
  };
}

function decodeBoundingBoxes(value: unknown): readonly KnowledgeViewerBoundingBox[] | null {
  if (!Array.isArray(value) || value.length > KNOWLEDGE_VIEWER_MAX_BOXES) return null;
  const boxes = value.map(decodeBoundingBox);
  return boxes.some((box) => box === null) ? null : boxes as KnowledgeViewerBoundingBox[];
}

function decodeTable(value: unknown): KnowledgeViewerTable | null | undefined {
  if (value === null) return null;
  if (!record(value) || !Array.isArray(value.cells) ||
    value.cells.length > KNOWLEDGE_VIEWER_MAX_TABLE_CELLS ||
    typeof value.truncated !== "boolean") return undefined;
  const rowCount = positiveInteger(value.rowCount, 2_000);
  const columnCount = positiveInteger(value.columnCount, 200);
  if (rowCount === null || columnCount === null) return undefined;
  const cells = value.cells.map((candidate): KnowledgeViewerTableCell | null => {
    if (!record(candidate)) return null;
    const row = nonNegativeInteger(candidate.row, rowCount - 1);
    const column = nonNegativeInteger(candidate.column, columnCount - 1);
    const rowSpan = positiveInteger(candidate.rowSpan, rowCount);
    const columnSpan = positiveInteger(candidate.columnSpan, columnCount);
    const text = boundedString(candidate.text, 16_384, true);
    if (row === null || column === null || rowSpan === null || columnSpan === null ||
      text === null || row + rowSpan > rowCount || column + columnSpan > columnCount) return null;
    return { column, columnSpan, row, rowSpan, text };
  });
  if (cells.some((cell) => cell === null)) return undefined;
  return {
    cells: cells as KnowledgeViewerTableCell[],
    columnCount,
    rowCount,
    truncated: value.truncated
  };
}

function structuredScalar(value: unknown): value is boolean | number | string | null {
  return value === null || typeof value === "boolean" ||
    typeof value === "number" && Number.isFinite(value) ||
    typeof value === "string" && value.length <= 32_767 && !/\u0000/u.test(value);
}

function decodeA1Cell(value: string): Readonly<{ column: number; row: number }> | null {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/u.exec(value);
  if (!match?.[1] || !match[2]) return null;
  let column = 0;
  for (const character of match[1]) {
    column = column * 26 + character.charCodeAt(0) - 64;
  }
  const row = Number(match[2]);
  return column >= 1 && column <= 16_384 && Number.isSafeInteger(row) && row <= 1_048_576
    ? { column: column - 1, row: row - 1 }
    : null;
}

function decodeA1Range(value: string): Readonly<{
  columnEnd: number;
  columnStart: number;
  rowEnd: number;
  rowStart: number;
}> | null {
  const [startValue, endValue, extra] = value.split(":");
  if (!startValue || !endValue || extra !== undefined) return null;
  const start = decodeA1Cell(startValue);
  const end = decodeA1Cell(endValue);
  return start && end && start.row <= end.row && start.column <= end.column
    ? {
        columnEnd: end.column,
        columnStart: start.column,
        rowEnd: end.row,
        rowStart: start.row
      }
    : null;
}

function workbookValueMatchesType(
  type: KnowledgeViewerWorkbookCell["type"],
  value: unknown
): boolean {
  if (type === "blank") return value === null;
  if (type === "boolean") return typeof value === "boolean";
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === "string";
}

function decodeWorkbook(value: unknown): KnowledgeViewerWorkbook | null | undefined {
  if (value === null || value === undefined) return null;
  if (!record(value) || !Array.isArray(value.ranges) || !record(value.result) ||
    !Array.isArray(value.result.columns) || !Array.isArray(value.result.rows) ||
    !Array.isArray(value.warnings)) return undefined;
  const operationSummary = boundedString(value.operationSummary, 2_000);
  const columns = stringArray(value.result.columns, 64, 256);
  const warnings = stringArray(value.warnings, 32, 256);
  if (!operationSummary || !columns || !warnings ||
    value.result.rows.length > 200 || value.result.rows.some((row) =>
      !Array.isArray(row) || row.length !== columns.length || row.some((cell) => !structuredScalar(cell))) ||
    value.ranges.length < 1 || value.ranges.length > 64) return undefined;
  let cellCount = 0;
  const ranges = value.ranges.map((candidate): KnowledgeViewerWorkbookRange | null => {
    const decodedRange = record(candidate) && typeof candidate.range === "string"
      ? decodeA1Range(candidate.range)
      : null;
    if (!record(candidate) || !Array.isArray(candidate.cells) || typeof candidate.truncated !== "boolean" ||
      !decodedRange ||
      typeof candidate.sheet !== "string" || !candidate.sheet || candidate.sheet.length > 256 ||
      !Number.isSafeInteger(candidate.sheetIndex) || Number(candidate.sheetIndex) < 0 ||
      Number(candidate.sheetIndex) >= 64 ||
      !["filter", "group", "join", "read", "sort", "value"].includes(String(candidate.role))) {
      return null;
    }
    cellCount += candidate.cells.length;
    if (cellCount > KNOWLEDGE_VIEWER_MAX_WORKBOOK_CELLS) return null;
    const cells = candidate.cells.map((cell): KnowledgeViewerWorkbookCell | null => {
      const decodedCell = record(cell) && typeof cell.address === "string"
        ? decodeA1Cell(cell.address)
        : null;
      if (!record(cell) || !decodedCell ||
        !Number.isSafeInteger(cell.row) || Number(cell.row) < 0 ||
        !Number.isSafeInteger(cell.column) || Number(cell.column) < 0 ||
        decodedCell.row !== Number(cell.row) || decodedCell.column !== Number(cell.column) ||
        decodedCell.row < decodedRange.rowStart || decodedCell.row > decodedRange.rowEnd ||
        decodedCell.column < decodedRange.columnStart ||
        decodedCell.column > decodedRange.columnEnd ||
        typeof cell.display !== "string" || cell.display.length > 32_767 || /\u0000/u.test(cell.display) ||
        (cell.formula !== null && (typeof cell.formula !== "string" ||
          !cell.formula || cell.formula.length > 4_096 || /\u0000/u.test(cell.formula))) ||
        !["blank", "boolean", "date", "error", "number", "string"].includes(String(cell.type)) ||
        !structuredScalar(cell.value) || !workbookValueMatchesType(
          cell.type as KnowledgeViewerWorkbookCell["type"],
          cell.value
        )) return null;
      return {
        address: cell.address as string,
        column: Number(cell.column),
        display: cell.display,
        formula: cell.formula as string | null,
        row: Number(cell.row),
        type: cell.type as KnowledgeViewerWorkbookCell["type"],
        value: cell.value
      };
    });
    if (cells.some((cell) => cell === null) ||
      new Set((cells as KnowledgeViewerWorkbookCell[]).map((cell) => cell.address)).size !== cells.length) {
      return null;
    }
    return {
      cells: cells as KnowledgeViewerWorkbookCell[],
      range: candidate.range as string,
      role: candidate.role as KnowledgeViewerWorkbookRange["role"],
      sheet: candidate.sheet,
      sheetIndex: Number(candidate.sheetIndex),
      truncated: candidate.truncated
    };
  });
  if (ranges.some((range) => range === null)) return undefined;
  return {
    operationSummary,
    ranges: ranges as KnowledgeViewerWorkbookRange[],
    result: {
      columns,
      rows: value.result.rows as Array<Array<boolean | number | string | null>>
    },
    warnings
  };
}

function decodeBlock(value: unknown): KnowledgeViewerBlock | null {
  if (!record(value) || typeof value.type !== "string" ||
    !BLOCK_TYPES.has(value.type as KnowledgeViewerBlock["type"]) ||
    !["after", "before", "target"].includes(String(value.relation))) return null;
  const pageStart = positiveInteger(value.pageStart, 100_000);
  const pageEnd = positiveInteger(value.pageEnd, 100_000);
  const text = boundedString(value.text, 64_000, true);
  const headingPath = stringArray(value.headingPath, 16, 256);
  const boundingBoxes = decodeBoundingBoxes(value.boundingBoxes);
  const table = decodeTable(value.table);
  if (pageStart === null || pageEnd === null || pageEnd < pageStart || text === null ||
    !headingPath || !boundingBoxes || table === undefined) return null;
  return {
    boundingBoxes,
    headingPath,
    pageEnd,
    pageStart,
    relation: value.relation as KnowledgeViewerBlock["relation"],
    table,
    text,
    type: value.type as KnowledgeViewerBlock["type"]
  };
}

function decodeAvailable(value: unknown): KnowledgeViewerAvailable | null {
  if (!record(value) || value.state !== "available" || !record(value.source) ||
    !record(value.locator) || !Array.isArray(value.blocks) ||
    value.blocks.length > KNOWLEDGE_VIEWER_MAX_BLOCKS ||
    value.originalKind !== null && value.originalKind !== "image" && value.originalKind !== "pdf") {
    return null;
  }
  const blocks = value.blocks.map(decodeBlock);
  const excerpt = boundedString(value.excerpt, 64_000, true);
  const headingPath = stringArray(value.headingPath, 16, 256);
  const pageStart = positiveInteger(value.locator.pageStart, 100_000);
  const pageEnd = positiveInteger(value.locator.pageEnd, 100_000);
  const boundingBoxes = decodeBoundingBoxes(value.locator.boundingBoxes);
  const workbook = decodeWorkbook(value.workbook);
  const visual = (() => {
    if (value.visual === null) return null;
    if (!record(value.visual) ||
      !["chart", "diagram", "image", "table"].includes(String(value.visual.kind)) ||
      (value.visual.status !== "available" && value.visual.status !== "unavailable") ||
      !Array.isArray(value.visual.warnings) || value.visual.warnings.length > 2 ||
      value.visual.warnings.some((warning) => warning !== "analysis_unavailable" &&
        warning !== "original_unavailable") ||
      new Set(value.visual.warnings).size !== value.visual.warnings.length) return undefined;
    const label = boundedString(value.visual.label, 1_000);
    const caption = value.visual.caption === null
      ? null
      : boundedString(value.visual.caption, 2_000);
    const description = value.visual.description === null
      ? null
      : boundedString(value.visual.description, 4_000);
    if (!label || value.visual.caption !== null && caption === null ||
      value.visual.description !== null && description === null ||
      (value.visual.status === "available") !== (description !== null) ||
      (value.visual.status === "unavailable") !==
        value.visual.warnings.includes("analysis_unavailable")) return undefined;
    return {
      caption,
      description,
      kind: value.visual.kind as KnowledgeViewerVisualEvidence["kind"],
      label,
      status: value.visual.status as KnowledgeViewerVisualEvidence["status"],
      warnings: value.visual.warnings as KnowledgeViewerVisualEvidence["warnings"]
    };
  })();
  const decodedBaseName = value.source.baseName === null
    ? null
    : boundedString(value.source.baseName, 1_024);
  const fileName = boundedString(value.source.fileName, 1_024);
  const mimeType = boundedString(value.source.mimeType, 255);
  const name = boundedString(value.source.name, 1_024);
  const versionNumber = positiveInteger(value.source.versionNumber, 1_000_000);
  const statuses = Array.isArray(value.source.statuses) && value.source.statuses.length <= 3 &&
    value.source.statuses.every((status) => SOURCE_STATUSES.has(status as KnowledgeViewerSourceStatus)) &&
    new Set(value.source.statuses).size === value.source.statuses.length
    ? value.source.statuses as KnowledgeViewerSourceStatus[]
    : null;
  if (blocks.some((block) => block === null) || excerpt === null ||
    typeof value.excerptTruncated !== "boolean" || !headingPath || pageStart === null ||
    pageEnd === null || pageEnd < pageStart || !boundingBoxes ||
    (value.source.baseName !== null && decodedBaseName === null) ||
    !fileName || !mimeType || !name || versionNumber === null || !statuses ||
    workbook === undefined || visual === undefined) return null;
  return {
    blocks: blocks as KnowledgeViewerBlock[],
    excerpt,
    excerptTruncated: value.excerptTruncated,
    headingPath,
    locator: { boundingBoxes, pageEnd, pageStart },
    originalKind: value.originalKind,
    source: {
      baseName: decodedBaseName,
      fileName,
      mimeType,
      name,
      statuses,
      versionNumber
    },
    state: "available",
    visual,
    workbook
  };
}

export function decodeKnowledgeCitationViewer(value: unknown): KnowledgeCitationViewer | null {
  if (!record(value)) return null;
  const handle = boundedString(value.handle, 8);
  if (!handle || !decodeKnowledgeCitationHandle(handle)) return null;
  if (value.state === "deleted") {
    return Object.keys(value).length === 2 ? { handle, state: "deleted" } : null;
  }
  const available = decodeAvailable(value);
  return available ? { ...available, handle } : null;
}

export function decodeKnowledgeSourceViewer(value: unknown): KnowledgeSourceViewer | null {
  return decodeAvailable(value);
}

export function decodeKnowledgeCitationViewerResponse(
  value: unknown
): KnowledgeCitationViewerResponse | null {
  if (!record(value) || Object.keys(value).length !== 1) return null;
  const citation = decodeKnowledgeCitationViewer(value.citation);
  return citation ? { citation } : null;
}

export function decodeKnowledgeSourceViewerResponse(
  value: unknown
): KnowledgeSourceViewerResponse | null {
  if (!record(value) || Object.keys(value).length !== 1) return null;
  const source = decodeKnowledgeSourceViewer(value.source);
  return source ? { source } : null;
}
