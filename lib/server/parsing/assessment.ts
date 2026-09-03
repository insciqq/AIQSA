import { KNOWLEDGE_PROCESSING_WARNING_CODES } from "../../domain/knowledgeProcessingWarnings";
import { geometryProvenRepeatedFurniture } from "../../domain/knowledgeFurniture";
import type {
  ParsedDocument,
  ParsedDocumentAsset,
  ParsedDocumentBlock,
  ParsedDocumentParserAttempt,
  ParsedDocumentQuality,
  ParsedDocumentWarningCode,
  ParsedFieldGroup,
  ParsedWorkbook
} from "./types";

const WARNING_ORDER: readonly ParsedDocumentWarningCode[] = KNOWLEDGE_PROCESSING_WARNING_CODES;

type ParsedDocumentDraft = Readonly<{
  assets?: readonly ParsedDocumentAsset[];
  attempts?: readonly ParsedDocumentParserAttempt[];
  blocks: readonly ParsedDocumentBlock[];
  engine: ParsedDocument["engine"];
  fieldGroups?: readonly ParsedFieldGroup[];
  languages?: readonly string[];
  mediaType: string;
  ocrConfidence?: number | null;
  pageCount: number;
  status: ParsedDocument["status"];
  text?: string;
  warnings?: readonly ParsedDocumentWarningCode[];
  workbook?: ParsedWorkbook | null;
}>;

function boundedRatio(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

export function parsedLanguageHints(text: string): readonly string[] {
  const result: string[] = [];
  if (/\p{Script=Cyrillic}/u.test(text)) result.push("und-Cyrl");
  if (/\p{Script=Latin}/u.test(text)) result.push("und-Latn");
  return Object.freeze(result);
}

function qualityFor(
  blocks: readonly ParsedDocumentBlock[],
  fieldGroups: readonly ParsedFieldGroup[],
  pageCount: number,
  ocrConfidence: number | null
): ParsedDocumentQuality {
  const usable = blocks.filter((block) => block.text.trim().length > 0);
  const usableFieldGroups = fieldGroups.filter((group) =>
    group.cells.some((cell) => cell.text.trim().length > 0));
  const coveredPages = new Set<number>();
  for (const block of usable) {
    for (let page = block.page; page <= block.pageEnd; page += 1) coveredPages.add(page);
  }
  for (const group of usableFieldGroups) {
    for (let page = group.page; page <= group.pageEnd; page += 1) coveredPages.add(page);
  }

  const duplicateBlocks = geometryProvenRepeatedFurniture(usable.map((block) => ({
    boundingBoxes: block.boundingBoxes,
    id: block.index,
    order: block.readingOrder,
    pageEnd: block.pageEnd,
    pageStart: block.page,
    table: block.table,
    text: block.text,
    type: block.type
  })), pageCount, true).size;
  const characterCount = usable.reduce((total, block) => total + block.text.length, 0) +
    usableFieldGroups.reduce((total, group) => total + group.cells.reduce((cellTotal, cell) =>
      cellTotal + cell.text.length, 0), 0);
  const safePageCount = Math.max(1, pageCount);
  const pageCoverage = boundedRatio(coveredPages.size / safePageCount);

  return Object.freeze({
    characterCount,
    coveredPageCount: coveredPages.size,
    duplicateFurnitureRatio: boundedRatio(duplicateBlocks / Math.max(1, usable.length)),
    emptyPageRatio: boundedRatio(1 - pageCoverage),
    encodingValid: usable.every((block) => !/[\u0000\uFFFD]/u.test(block.text)) &&
      usableFieldGroups.every((group) => group.cells.every((cell) =>
        !/[\u0000\uFFFD]/u.test(cell.text) && !/[\u0000\uFFFD]/u.test(cell.originalText))),
    headingCount: usable.filter((block) => block.type === "heading" || block.type === "title").length,
    ocrConfidence: ocrConfidence === null ? null : boundedRatio(ocrConfidence),
    pageCoverage,
    tableCount: usable.filter((block) => block.type === "table").length,
    usableBlockCount: usable.length + usableFieldGroups.length
  });
}

function canonicalWarnings(
  requested: readonly ParsedDocumentWarningCode[],
  quality: ParsedDocumentQuality,
  status: ParsedDocument["status"]
): readonly ParsedDocumentWarningCode[] {
  const warnings = new Set(requested);
  if (status === "partial") warnings.add("partial_parse");
  if (quality.pageCoverage < 1) warnings.add("unreadable_pages");
  if (quality.pageCoverage < 0.75) warnings.add("low_page_coverage");
  if (
    quality.characterCount < 4 ||
    (quality.coveredPageCount > 1 &&
      quality.characterCount / quality.coveredPageCount < 16)
  ) {
    warnings.add("low_text_density");
  }
  if (quality.ocrConfidence !== null && quality.ocrConfidence < 0.65) {
    warnings.add("low_ocr_confidence");
  }
  if (quality.duplicateFurnitureRatio > 0) warnings.add("repeated_header_footer");
  return Object.freeze(WARNING_ORDER.filter((warning) => warnings.has(warning)));
}

export function finalizeParsedDocument(input: ParsedDocumentDraft): ParsedDocument {
  const pageCount = Math.max(1, input.pageCount);
  const fieldGroups = input.fieldGroups ?? [];
  const text = input.text ?? [
    ...input.blocks.map((block) => block.text),
    ...fieldGroups.flatMap((group) => group.cells.map((cell) => cell.text))
  ].filter(Boolean).join("\n\n");
  const quality = qualityFor(input.blocks, fieldGroups, pageCount, input.ocrConfidence ?? null);
  const languages = input.languages ?? parsedLanguageHints(text);
  const warnings = canonicalWarnings(input.warnings ?? [], quality, input.status);

  return Object.freeze({
    assets: Object.freeze([...(input.assets ?? [])]),
    attempts: Object.freeze([...(input.attempts ?? [])]),
    blocks: Object.freeze([...input.blocks]),
    engine: input.engine,
    fieldGroups: Object.freeze([...fieldGroups]),
    languages: Object.freeze([...languages]),
    mediaType: input.mediaType,
    pageCount,
    quality,
    status: input.status,
    text,
    warnings,
    workbook: input.workbook ?? null
  });
}

export function parsedDocumentNeedsFallback(document: ParsedDocument): boolean {
  return !document.quality.encodingValid ||
    document.quality.usableBlockCount === 0 ||
    document.status === "partial" ||
    document.quality.pageCoverage < 0.75 ||
    (document.pageCount > 1 &&
      document.quality.characterCount / Math.max(1, document.quality.coveredPageCount) < 16);
}

export function parsedDocumentQualityScore(document: ParsedDocument): number {
  if (!document.quality.encodingValid || document.quality.usableBlockCount === 0) return -1;
  return (document.status === "complete" ? 2_000 : 1_000) +
    Math.round(document.quality.pageCoverage * 500) +
    Math.min(1_000, document.quality.characterCount) +
    Math.min(200, document.quality.headingCount * 20 + document.quality.tableCount * 30) -
    Math.round(document.quality.duplicateFurnitureRatio * 200);
}

export function withParserEvidence(
  document: ParsedDocument,
  attempts: readonly ParsedDocumentParserAttempt[],
  input: Readonly<{
    additionalWarnings?: readonly ParsedDocumentWarningCode[];
    forcePartial?: boolean;
  }> = {}
): ParsedDocument {
  return finalizeParsedDocument({
    assets: document.assets,
    attempts,
    blocks: document.blocks,
    engine: document.engine,
    fieldGroups: document.fieldGroups,
    languages: document.languages,
    mediaType: document.mediaType,
    ocrConfidence: document.quality.ocrConfidence,
    pageCount: document.pageCount,
    status: input.forcePartial ? "partial" : document.status,
    text: document.text,
    warnings: [...document.warnings, ...(input.additionalWarnings ?? [])],
    workbook: document.workbook
  });
}
