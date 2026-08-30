import { finalizeParsedDocument, parsedLanguageHints } from "./assessment";
import {
  adaptiveNativeTextLexicallyValid,
  type AdaptivePdfPlan
} from "./adaptivePdf";
import { DocumentParserError } from "./errors";
import type { NativePdfGeometry } from "./nativePdf";
import type {
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedDocumentParserAttempt,
  ParsedTable,
  ParsedTableCell
} from "./types";

const MAX_ALIGNMENT_TOKENS = 96;

// Vision is intentionally run only for the pages rejected by the strict
// native-only gate. Its intermediate ParsedDocument therefore measures page
// coverage and repeated furniture against the full source page count even
// though native-only pages are absent by design. Recompute these quality
// warnings after the ordered merge instead of leaking subset-local warnings
// into the final artifact.
const INTERMEDIATE_SUBSET_QUALITY_WARNINGS = new Set([
  "low_page_coverage",
  "low_text_density",
  "repeated_header_footer",
  "unreadable_pages"
]);

function normalizedText(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function tokens(value: string): readonly string[] {
  return (value.normalize("NFKC").toLocaleLowerCase("und").replaceAll("ё", "е")
    .match(/[\p{L}\p{M}]+|[-+]?\p{N}+(?:[.,]\p{N}+)?(?:%|‰)?/gu) ?? [])
    .map((token) => token.replace(",", "."));
}

function editDistanceAtMostTwo(left: string, right: string): boolean {
  if (Math.abs(left.length - right.length) > 2) return false;
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = current[0]!;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const value = Math.min(
        current[rightIndex - 1]! + 1,
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! +
          (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      current.push(value);
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > 2) return false;
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length]! <= 2;
}

/** A bounded alignment admits numeric disagreement or one plausible OCR typo,
 * but never uses fuzzy matching to associate unrelated rows. */
function alignedRow(modelText: string, nativeText: string): boolean {
  const model = tokens(modelText);
  const native = tokens(nativeText);
  if (model.length < 2 || model.length !== native.length ||
    model.length > MAX_ALIGNMENT_TOKENS) return false;
  let exactWords = 0;
  let changedWords = 0;
  let wordCount = 0;
  let changed = false;
  for (let index = 0; index < model.length; index += 1) {
    const modelToken = model[index]!;
    const nativeToken = native[index]!;
    const modelNumeric = /\p{N}/u.test(modelToken);
    const nativeNumeric = /\p{N}/u.test(nativeToken);
    if (modelNumeric !== nativeNumeric) return false;
    if (modelToken === nativeToken) {
      if (!modelNumeric) exactWords += 1;
      continue;
    }
    changed = true;
    if (modelNumeric) continue;
    wordCount += 1;
    changedWords += 1;
    if (Math.min(modelToken.length, nativeToken.length) < 4 ||
      !editDistanceAtMostTwo(modelToken, nativeToken)) return false;
  }
  wordCount += exactWords;
  return changed && changedWords <= 1 && exactWords >= 1 && wordCount >= 2;
}

function lexicalNativePage(geometry: NativePdfGeometry, page: number): boolean {
  const metric = geometry.quality.pages[page - 1];
  return metric?.page === page && adaptiveNativeTextLexicallyValid(metric);
}

type Alignment = Readonly<{ modelIndex: number; nativeIndex: number }>;

function uniqueAlignments(
  modelRows: readonly Readonly<{ page: number; text: string }>[],
  nativeRows: readonly ParsedDocumentBlock[]
): readonly Alignment[] {
  const candidates: Alignment[] = [];
  for (const [modelIndex, model] of modelRows.entries()) {
    for (const [nativeIndex, native] of nativeRows.entries()) {
      if (model.page === native.page && alignedRow(model.text, native.text)) {
        candidates.push(Object.freeze({ modelIndex, nativeIndex }));
      }
    }
  }
  const modelCounts = new Map<number, number>();
  const nativeCounts = new Map<number, number>();
  for (const candidate of candidates) {
    modelCounts.set(candidate.modelIndex, (modelCounts.get(candidate.modelIndex) ?? 0) + 1);
    nativeCounts.set(candidate.nativeIndex, (nativeCounts.get(candidate.nativeIndex) ?? 0) + 1);
  }
  return Object.freeze(candidates.filter((candidate) =>
    modelCounts.get(candidate.modelIndex) === 1 && nativeCounts.get(candidate.nativeIndex) === 1));
}

function tableRows(table: ParsedTable): readonly string[] {
  const rows = Array.from({ length: table.rowCount }, () =>
    Array<string>(table.columnCount).fill(""));
  for (const cell of table.cells) {
    for (let row = cell.row; row < cell.row + cell.rowSpan; row += 1) {
      rows[row]![cell.column] = cell.text;
    }
  }
  return Object.freeze(rows.map((row) => row.join("\t").trimEnd()));
}

function tableText(table: ParsedTable): string {
  return tableRows(table).filter(Boolean).join("\n");
}

function correctedParagraphs(
  document: ParsedDocument,
  geometry: NativePdfGeometry,
  visionPages: ReadonlySet<number>
): readonly ParsedDocumentBlock[] {
  const nativeRows = geometry.blocks.filter((candidate) =>
    visionPages.has(candidate.page) && lexicalNativePage(geometry, candidate.page) &&
    !candidate.isTable && candidate.table === null && !candidate.text.includes("\t"));
  const modelRows = document.blocks.flatMap((candidate, modelIndex) =>
    visionPages.has(candidate.page) && candidate.page === candidate.pageEnd &&
      !candidate.isTable && candidate.table === null && !/[\r\n\t]/u.test(candidate.text)
      ? [Object.freeze({ modelIndex, page: candidate.page, text: candidate.text })]
      : []);
  const alignments = uniqueAlignments(modelRows, nativeRows);
  const nativeByBlock = new Map(alignments.map((alignment) => [
    modelRows[alignment.modelIndex]!.modelIndex,
    nativeRows[alignment.nativeIndex]!
  ]));
  return Object.freeze(document.blocks.map((candidate, index) => {
    const native = nativeByBlock.get(index);
    return native
      ? Object.freeze({
          ...candidate,
          boundingBoxes: native.boundingBoxes,
          languageHints: parsedLanguageHints(native.text),
          text: native.text
        })
      : candidate;
  }));
}

function correctedTables(
  blocks: readonly ParsedDocumentBlock[],
  geometry: NativePdfGeometry,
  visionPages: ReadonlySet<number>
): readonly ParsedDocumentBlock[] {
  return Object.freeze(blocks.map((block) => {
    if (!visionPages.has(block.page) || block.page !== block.pageEnd || !block.table ||
      !lexicalNativePage(geometry, block.page) || block.table.cells.some((cell) =>
        cell.columnSpan !== 1 || cell.rowSpan !== 1)) return block;
    const nativeRows = geometry.blocks.filter((candidate) =>
      candidate.page === block.page && candidate.table?.rowCount === 1 &&
      candidate.table.columnCount === block.table?.columnCount);
    const modelRows = tableRows(block.table).map((text) => ({ page: block.page, text }));
    const alignments = uniqueAlignments(modelRows, nativeRows);
    if (alignments.length < 1) return block;
    const nativeByRow = new Map(alignments.map((alignment) => [
      alignment.modelIndex,
      nativeRows[alignment.nativeIndex]!
    ]));
    const cells: ParsedTableCell[] = block.table.cells.map((cell) => {
      const native = nativeByRow.get(cell.row)?.table?.cells.find((candidate) =>
        candidate.column === cell.column);
      return native ? Object.freeze({ ...cell, text: native.text }) : cell;
    });
    const table = Object.freeze({ ...block.table, cells: Object.freeze(cells) });
    const boxes = [...new Map([
      ...block.boundingBoxes,
      ...[...nativeByRow.values()].flatMap((native) => native.boundingBoxes)
    ].map((candidate) => [JSON.stringify(candidate), candidate])).values()];
    return Object.freeze({
      ...block,
      boundingBoxes: Object.freeze(boxes),
      languageHints: parsedLanguageHints(tableText(table)),
      table,
      text: tableText(table)
    });
  }));
}

function doclingGeometry(
  blocks: readonly ParsedDocumentBlock[],
  docling: ParsedDocument | null
): readonly ParsedDocumentBlock[] {
  if (!docling) return blocks;
  return Object.freeze(blocks.map((block) => {
    if (block.boundingBoxes.length > 0) return block;
    const key = normalizedText(block.text);
    if (!key) return block;
    const matches = docling.blocks.filter((candidate) =>
      candidate.page === block.page && candidate.pageEnd === block.pageEnd &&
      candidate.isTable === block.isTable && normalizedText(candidate.text) === key &&
      candidate.boundingBoxes.length > 0);
    return matches.length === 1
      ? Object.freeze({ ...block, boundingBoxes: matches[0]!.boundingBoxes })
      : block;
  }));
}

function reindex(block: ParsedDocumentBlock, index: number): ParsedDocumentBlock {
  return Object.freeze({ ...block, index, readingOrder: index });
}

function attempts(input: Readonly<{
  docling: ParsedDocument | null;
  vision: ParsedDocument | null;
}>): readonly ParsedDocumentParserAttempt[] {
  const values: ParsedDocumentParserAttempt[] = [Object.freeze({
    engine: "native_pdf",
    errorCode: null,
    outcome: "complete"
  })];
  if (input.docling) values.push(Object.freeze({
    engine: "docling",
    errorCode: null,
    outcome: input.docling.status === "complete" ? "complete" : "partial"
  }));
  if (input.vision) values.push(...input.vision.attempts);
  return Object.freeze([...new Map(values.map((attempt) => [attempt.engine, attempt])).values()]);
}

export function mergeAdaptivePdfDocument(input: Readonly<{
  docling: ParsedDocument | null;
  geometry: NativePdfGeometry;
  maxBlocks: number;
  maxCharacters: number;
  plan: AdaptivePdfPlan;
  vision: ParsedDocument | null;
}>): ParsedDocument {
  const visionPages = new Set(input.plan.pages.filter((page) =>
    page.route === "vision_required").map((page) => page.page));
  if (visionPages.size > 0 && !input.vision) {
    throw new DocumentParserError("parser_invalid_output", "system_model_vision");
  }
  const visionBlocks = input.vision
    ? doclingGeometry(correctedTables(
        correctedParagraphs(input.vision, input.geometry, visionPages),
        input.geometry,
        visionPages
      ), input.docling)
    : Object.freeze([]);
  const blocks = input.plan.pages.flatMap((page) => {
    if (page.route === "native_only") {
      return input.geometry.blocks.filter((block) => block.page === page.page);
    }
    const primary = visionBlocks.filter((block) =>
      block.page <= page.page && block.pageEnd >= page.page);
    if (!lexicalNativePage(input.geometry, page.page)) return primary;
    const primaryText = normalizedText(primary.map((block) => block.text).join("\n"));
    const preserved = input.geometry.blocks.filter((block) => {
      if (block.page !== page.page) return false;
      const key = normalizedText(block.text);
      return key.length > 0 && !primaryText.includes(key);
    });
    return [...primary, ...preserved];
  });
  const deduplicated = [...new Map(blocks.map((block) => [
    `${block.page}:${block.pageEnd}:${block.type}:${normalizedText(block.text)}`,
    block
  ])).values()].map(reindex);
  const characterCount = deduplicated.reduce((total, block) => total + block.text.length, 0);
  if (deduplicated.length < 1 || deduplicated.length > input.maxBlocks ||
    characterCount > input.maxCharacters) {
    throw new DocumentParserError(
      deduplicated.length > input.maxBlocks || characterCount > input.maxCharacters
        ? "parser_output_too_large"
        : "parser_invalid_output",
      visionPages.size > 0 ? "system_model_vision" : "native_pdf"
    );
  }
  const assets = input.docling?.assets.filter((asset) => visionPages.has(asset.page)) ?? [];
  const retainedVisionWarnings = input.vision?.warnings.filter((warning) =>
    !INTERMEDIATE_SUBSET_QUALITY_WARNINGS.has(warning)) ?? [];
  return finalizeParsedDocument({
    assets,
    attempts: attempts({ docling: input.docling, vision: input.vision }),
    blocks: deduplicated,
    engine: visionPages.size > 0 ? "system_model_vision" : "native_pdf",
    mediaType: "application/pdf",
    pageCount: input.geometry.pageCount,
    status: "complete",
    warnings: retainedVisionWarnings
  });
}
