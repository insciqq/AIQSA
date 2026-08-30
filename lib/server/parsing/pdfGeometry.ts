import type {
  ParsedBoundingBox,
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedDocumentParserAttempt
} from "./types";
import type { NativePdfGeometry } from "./nativePdf";
import { finalizeParsedDocument } from "./assessment";

const MAX_GEOMETRY_BOXES_PER_BLOCK = 256;
const MAX_PARSER_ATTEMPTS = 4;
const MAX_NATIVE_CORRECTION_TOKENS = 96;
const MIN_NATIVE_CORRECTION_WORD_CHARACTERS = 8;
const MIN_NATIVE_CORRECTION_WORDS = 2;
/** First immutable model-PDF parser profile that may add visible native-text
 * rows omitted by System Model Vision. Earlier profiles remain geometry-only. */
export const MODEL_PDF_NATIVE_TEXT_COLLABORATION_PROFILE_VERSION = 10 as const;
/** First immutable model-PDF parser profile where a clean visible native row
 * may replace one uniquely aligned Vision paragraph whose normalized token
 * sequence differs only in numeric tokens. */
export const MODEL_PDF_NATIVE_TEXT_CORRECTION_PROFILE_VERSION = 11 as const;

export type ModelPdfNativeTextMergeResult = Readonly<{
  addedBlockCount: number;
  correctedBlockCount: number;
  document: ParsedDocument;
  outcome: "augmented" | "rejected" | "unchanged";
}>;

type ModelPdfNativeTextMergeOptions = Readonly<{
  allowTextCorrections: boolean;
  maxBlocks: number;
  maxCharacters: number;
}>;

type GeometryMatchPlan = Readonly<{
  blockIndexByGeometryIndex: ReadonlyMap<number, number>;
  blocks: readonly ParsedDocumentBlock[];
  consumedGeometryIndexes: ReadonlySet<number>;
}>;

function textKey(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("und")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function modelKeys(block: ParsedDocumentBlock): readonly string[] {
  const lines = block.text.split(/\r?\n/gu).map(textKey).filter(Boolean);
  const whole = textKey(block.text);
  return Object.freeze([...new Set([whole, ...lines].filter(Boolean))]);
}

function exactGeometryMatch(
  model: readonly string[],
  geometry: string
): boolean {
  if (geometry.length < 4) return false;
  return model.some((candidate) => candidate === geometry ||
    Math.min(candidate.length, geometry.length) >= 12 &&
      (candidate.includes(geometry) || geometry.includes(candidate)));
}

function boxKey(box: ParsedBoundingBox): string {
  return [
    box.page,
    box.coordinateOrigin,
    box.left,
    box.top,
    box.right,
    box.bottom
  ].join(":");
}

function geometryMatchPlan(
  document: ParsedDocument,
  geometry: NativePdfGeometry
): GeometryMatchPlan {
  if (geometry.pageCount !== document.pageCount || geometry.blocks.length < 1) {
    return Object.freeze({
      blockIndexByGeometryIndex: new Map<number, number>(),
      blocks: document.blocks,
      consumedGeometryIndexes: new Set<number>()
    });
  }
  const consumed = new Set<number>();
  const blockIndexByGeometryIndex = new Map<number, number>();
  const blocks = document.blocks.map((block, blockIndex) => {
    if (block.boundingBoxes.length > 0) return block;
    const keys = modelKeys(block);
    const boxes: ParsedBoundingBox[] = [];
    for (const [index, candidate] of geometry.blocks.entries()) {
      if (consumed.has(index) || candidate.page < block.page || candidate.page > block.pageEnd ||
        !exactGeometryMatch(keys, textKey(candidate.text))) continue;
      consumed.add(index);
      blockIndexByGeometryIndex.set(index, blockIndex);
      boxes.push(...candidate.boundingBoxes);
    }
    const deduplicated = [...new Map(boxes.map((box) => [boxKey(box), box])).values()]
      .slice(0, MAX_GEOMETRY_BOXES_PER_BLOCK);
    return deduplicated.length < 1
      ? block
      : Object.freeze({ ...block, boundingBoxes: Object.freeze(deduplicated) });
  });
  return Object.freeze({
    blockIndexByGeometryIndex,
    blocks: Object.freeze(blocks),
    consumedGeometryIndexes: consumed
  });
}

/** Adds only conservatively matched native PDF coordinates. Model-authored
 * text, structure, ordering, and quality remain authoritative and unchanged. */
export function enrichModelPdfGeometry(
  document: ParsedDocument,
  geometry: NativePdfGeometry
): ParsedDocument {
  const { blocks } = geometryMatchPlan(document, geometry);
  if (blocks.every((block, index) => block === document.blocks[index])) return document;
  return Object.freeze({ ...document, blocks: Object.freeze(blocks) });
}

function normalizedTokenSequence(value: string): readonly string[] {
  return (value.normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll("ё", "е")
    .match(/[\p{L}\p{M}]+|[-+]?(?:\p{N}{1,3}(?:[ \u00a0\u202f]\p{N}{3})+|\p{N}+)(?:[.,]\p{N}+)?(?:%|‰)?/gu) ?? [])
    .map((token) => token.replace(/[ \u00a0\u202f]/gu, "").replace(",", "."));
}

function numericConflictMatch(modelText: string, nativeText: string): boolean {
  if (/\r|\n/u.test(modelText) || /\r|\n/u.test(nativeText)) return false;
  const model = normalizedTokenSequence(modelText);
  const native = normalizedTokenSequence(nativeText);
  if (model.length !== native.length || model.length > MAX_NATIVE_CORRECTION_TOKENS) {
    return false;
  }
  let changedNumericToken = false;
  let numericTokenCount = 0;
  let wordCharacterCount = 0;
  let wordCount = 0;
  for (let index = 0; index < model.length; index += 1) {
    const modelToken = model[index]!;
    const nativeToken = native[index]!;
    const modelNumeric = /\p{N}/u.test(modelToken);
    const nativeNumeric = /\p{N}/u.test(nativeToken);
    if (modelNumeric !== nativeNumeric) return false;
    if (modelNumeric) {
      numericTokenCount += 1;
      if (modelToken !== nativeToken) changedNumericToken = true;
      continue;
    }
    if (modelToken !== nativeToken) return false;
    wordCount += 1;
    wordCharacterCount += [...modelToken].length;
  }
  return changedNumericToken && numericTokenCount > 0 &&
    wordCount >= MIN_NATIVE_CORRECTION_WORDS &&
    wordCharacterCount >= MIN_NATIVE_CORRECTION_WORD_CHARACTERS;
}

function associationWindows(tokens: readonly string[]): readonly string[] {
  if (tokens.length < 2) return Object.freeze([]);
  const windows: string[] = [];
  for (let width = 2; width <= Math.min(3, tokens.length); width += 1) {
    for (let index = 0; index <= tokens.length - width; index += 1) {
      windows.push(tokens.slice(index, index + width).join("\u0001"));
    }
  }
  return Object.freeze(windows);
}

type PageTextEvidence = Readonly<{
  associations: ReadonlySet<string>;
  tokens: ReadonlySet<string>;
}>;

function modelPageEvidence(blocks: readonly ParsedDocumentBlock[]): ReadonlyMap<number, PageTextEvidence> {
  const pages = new Map<number, { associations: Set<string>; tokens: Set<string> }>();
  for (const block of blocks) {
    for (let page = block.page; page <= block.pageEnd; page += 1) {
      const evidence = pages.get(page) ?? {
        associations: new Set<string>(),
        tokens: new Set<string>()
      };
      const sequence = normalizedTokenSequence(block.text);
      for (const token of sequence) evidence.tokens.add(token);
      for (const association of associationWindows(sequence)) {
        evidence.associations.add(association);
      }
      pages.set(page, evidence);
    }
  }
  return pages;
}

function materiallyNovelNativeText(
  block: ParsedDocumentBlock,
  evidenceByPage: ReadonlyMap<number, PageTextEvidence>
): boolean {
  const primaryAssociations = new Set<string>();
  const primaryTokens = new Set<string>();
  for (let page = block.page; page <= block.pageEnd; page += 1) {
    const evidence = evidenceByPage.get(page);
    for (const token of evidence?.tokens ?? []) primaryTokens.add(token);
    for (const association of evidence?.associations ?? []) {
      primaryAssociations.add(association);
    }
  }
  const sequence = normalizedTokenSequence(block.text);
  const nativeTokens = new Set(sequence);
  if (nativeTokens.size === 0) return false;
  const novel = [...nativeTokens].filter((token) => !primaryTokens.has(token));
  if (novel.some((token) => /\p{N}/u.test(token))) return true;
  const novelWords = novel.filter((token) => /\p{L}/u.test(token) && [...token].length >= 2);
  if (novelWords.length >= 2 || novelWords.some((token) => [...token].length >= 8)) return true;
  const novelAssociations = associationWindows(sequence).filter((association) =>
    !primaryAssociations.has(association));
  return novelAssociations.some((association) => /\p{N}/u.test(association)) ||
    novelAssociations.length >= 2;
}

function boxArea(box: ParsedBoundingBox): number {
  return Math.max(0, box.right - box.left) * Math.max(0, box.top - box.bottom);
}

function overlapFraction(left: ParsedBoundingBox, right: ParsedBoundingBox): number {
  if (left.page !== right.page || left.coordinateOrigin !== right.coordinateOrigin) return 0;
  const width = Math.max(0, Math.min(left.right, right.right) - Math.max(left.left, right.left));
  const height = Math.max(0, Math.min(left.top, right.top) - Math.max(left.bottom, right.bottom));
  return width * height / Math.max(1, Math.min(boxArea(left), boxArea(right)));
}

function spatialConflict(
  candidate: ParsedDocumentBlock,
  modelBlocks: readonly ParsedDocumentBlock[]
): boolean {
  return candidate.boundingBoxes.some((candidateBox) => modelBlocks.some((block) =>
    block.boundingBoxes.some((modelBox) => overlapFraction(candidateBox, modelBox) >= 0.2)));
}

function unlocatedConflict(
  candidate: ParsedDocumentBlock,
  modelBlocks: readonly ParsedDocumentBlock[]
): boolean {
  const candidateKey = textKey(candidate.text);
  const candidateSkeleton = candidateKey.replace(/\p{N}+(?:[.,]\p{N}+)?/gu, "#");
  if (!candidateSkeleton.includes("#")) return false;
  return modelBlocks.some((block) => block.boundingBoxes.length === 0 &&
    block.page <= candidate.page && block.pageEnd >= candidate.page &&
    modelKeys(block).some((key) => key !== candidateKey &&
      key.replace(/\p{N}+(?:[.,]\p{N}+)?/gu, "#") === candidateSkeleton));
}

function safeNativePage(geometry: NativePdfGeometry, page: number): boolean {
  const metrics = geometry.quality.pages[page - 1];
  return geometry.quality.visualGroupOverflow === false && metrics?.page === page &&
    metrics.characterCount > 0 && metrics.rowCount > 0 &&
    metrics.invalidCharacterCount === 0 && metrics.invisibleText === false;
}

type NativeTextCorrectionPlan = Readonly<{
  blocks: readonly ParsedDocumentBlock[];
  characterDelta: number;
  correctedBlockCount: number;
  nativeBlocks: readonly ParsedDocumentBlock[];
}>;

function nativeTextCorrectionPlan(
  document: ParsedDocument,
  geometry: NativePdfGeometry
): NativeTextCorrectionPlan {
  const candidates: Array<Readonly<{
    modelIndex: number;
    nativeIndex: number;
  }>> = [];
  for (const [nativeIndex, nativeBlock] of geometry.blocks.entries()) {
    if (!safeNativePage(geometry, nativeBlock.page)) continue;
    for (const [modelIndex, modelBlock] of document.blocks.entries()) {
      if (modelBlock.isTable || modelBlock.table || modelBlock.type === "table" ||
        modelBlock.page > nativeBlock.page || modelBlock.pageEnd < nativeBlock.page ||
        !numericConflictMatch(modelBlock.text, nativeBlock.text)) continue;
      if (modelBlock.boundingBoxes.length > 0 && !nativeBlock.boundingBoxes.some((nativeBox) =>
        modelBlock.boundingBoxes.some((modelBox) =>
          overlapFraction(nativeBox, modelBox) >= 0.2))) continue;
      candidates.push(Object.freeze({ modelIndex, nativeIndex }));
    }
  }
  const modelCandidateCounts = new Map<number, number>();
  const nativeCandidateCounts = new Map<number, number>();
  for (const candidate of candidates) {
    modelCandidateCounts.set(candidate.modelIndex,
      (modelCandidateCounts.get(candidate.modelIndex) ?? 0) + 1);
    nativeCandidateCounts.set(candidate.nativeIndex,
      (nativeCandidateCounts.get(candidate.nativeIndex) ?? 0) + 1);
  }
  const accepted = candidates.filter((candidate) =>
    modelCandidateCounts.get(candidate.modelIndex) === 1 &&
    nativeCandidateCounts.get(candidate.nativeIndex) === 1);
  if (accepted.length < 1) return Object.freeze({
    blocks: document.blocks,
    characterDelta: 0,
    correctedBlockCount: 0,
    nativeBlocks: Object.freeze([])
  });
  const nativeByModelIndex = new Map(accepted.map((candidate) => [
    candidate.modelIndex,
    geometry.blocks[candidate.nativeIndex]!
  ]));
  let characterDelta = 0;
  const usedNativeBlocks: ParsedDocumentBlock[] = [];
  const blocks = document.blocks.map((block, index) => {
    const nativeBlock = nativeByModelIndex.get(index);
    if (!nativeBlock) return block;
    characterDelta += nativeBlock.text.length - block.text.length;
    usedNativeBlocks.push(nativeBlock);
    return Object.freeze({ ...block, text: nativeBlock.text });
  });
  return Object.freeze({
    blocks: Object.freeze(blocks),
    characterDelta,
    correctedBlockCount: usedNativeBlocks.length,
    nativeBlocks: Object.freeze(usedNativeBlocks)
  });
}

function fallbackInsertionIndex(
  candidate: ParsedDocumentBlock,
  blocks: readonly ParsedDocumentBlock[]
): number {
  const nextPage = blocks.findIndex((block) => block.page > candidate.page);
  if (nextPage >= 0) return nextPage;
  let lastSamePage = -1;
  for (const [index, block] of blocks.entries()) {
    if (block.page <= candidate.page && block.pageEnd >= candidate.page) lastSamePage = index;
  }
  return lastSamePage >= 0 ? lastSamePage + 1 : blocks.length;
}

function insertionIndexForGeometry(
  geometryIndex: number,
  candidate: ParsedDocumentBlock,
  plan: GeometryMatchPlan
): number {
  let previous: Readonly<{ geometryIndex: number; modelIndex: number }> | null = null;
  let next: Readonly<{ geometryIndex: number; modelIndex: number }> | null = null;
  for (const [matchedGeometryIndex, modelIndex] of plan.blockIndexByGeometryIndex) {
    if (matchedGeometryIndex < geometryIndex &&
      (!previous || matchedGeometryIndex > previous.geometryIndex)) {
      previous = { geometryIndex: matchedGeometryIndex, modelIndex };
    }
    if (matchedGeometryIndex > geometryIndex &&
      (!next || matchedGeometryIndex < next.geometryIndex)) {
      next = { geometryIndex: matchedGeometryIndex, modelIndex };
    }
  }
  if (previous && next && previous.modelIndex <= next.modelIndex) {
    return previous.modelIndex === next.modelIndex ? previous.modelIndex + 1 : next.modelIndex;
  }
  if (previous) return previous.modelIndex + 1;
  if (next) return next.modelIndex;
  return fallbackInsertionIndex(candidate, plan.blocks);
}

function reindexBlock(block: ParsedDocumentBlock, index: number): ParsedDocumentBlock {
  return block.index === index && block.readingOrder === index
    ? block
    : Object.freeze({ ...block, index, readingOrder: index });
}

function nativeAttempt(attempts: readonly ParsedDocumentParserAttempt[]): readonly ParsedDocumentParserAttempt[] {
  return attempts.some((attempt) => attempt.engine === "native_pdf")
    ? attempts
    : Object.freeze([...attempts, Object.freeze({
        engine: "native_pdf" as const,
        errorCode: null,
        outcome: "complete" as const
      })]);
}

/** Vision remains the structure owner. Clean visible native PDF rows are used
 * as a bounded collaboration channel: exact matches attach coordinates,
 * omitted non-conflicting rows may be added, and an explicitly enabled newer
 * profile may replace a uniquely aligned paragraph whose normalized token
 * sequence differs only in numeric tokens.
 * Invisible/clip-only pages are excluded and changes are all-or-nothing under
 * the parser bounds. */
export function mergeModelPdfWithNativeText(
  document: ParsedDocument,
  geometry: NativePdfGeometry,
  options: ModelPdfNativeTextMergeOptions
): ModelPdfNativeTextMergeResult {
  const baselinePlan = geometryMatchPlan(document, geometry);
  const baselineEnriched = baselinePlan.blocks.every((block, index) =>
    block === document.blocks[index])
    ? document
    : Object.freeze({ ...document, blocks: baselinePlan.blocks });
  if (geometry.pageCount !== document.pageCount || geometry.blocks.length < 1 ||
    !Number.isSafeInteger(options.maxBlocks) || options.maxBlocks < 1 ||
    !Number.isSafeInteger(options.maxCharacters) || options.maxCharacters < 1) {
    return Object.freeze({
      addedBlockCount: 0,
      correctedBlockCount: 0,
      document: baselineEnriched,
      outcome: "rejected"
    });
  }
  const corrections = options.allowTextCorrections
    ? nativeTextCorrectionPlan(document, geometry)
    : Object.freeze({
        blocks: document.blocks,
        characterDelta: 0,
        correctedBlockCount: 0,
        nativeBlocks: Object.freeze([])
      });
  const correctedDocument = corrections.correctedBlockCount < 1
    ? document
    : Object.freeze({ ...document, blocks: corrections.blocks });
  const plan = geometryMatchPlan(correctedDocument, geometry);
  const enriched = plan.blocks.every((block, index) =>
    block === correctedDocument.blocks[index])
    ? correctedDocument
    : Object.freeze({ ...correctedDocument, blocks: plan.blocks });
  const evidenceByPage = modelPageEvidence(plan.blocks);
  const additions = geometry.blocks.flatMap((candidate, geometryIndex) => {
    if (plan.consumedGeometryIndexes.has(geometryIndex) ||
      !safeNativePage(geometry, candidate.page) ||
      !materiallyNovelNativeText(candidate, evidenceByPage) ||
      spatialConflict(candidate, plan.blocks) ||
      unlocatedConflict(candidate, plan.blocks)) return [];
    return [Object.freeze({
      block: candidate,
      geometryIndex,
      insertionIndex: insertionIndexForGeometry(geometryIndex, candidate, plan)
    })];
  });
  if (additions.length < 1 && corrections.correctedBlockCount < 1) {
    return Object.freeze({
      addedBlockCount: 0,
      correctedBlockCount: 0,
      document: enriched,
      outcome: "unchanged"
    });
  }
  const addedCharacters = additions.reduce((total, addition) =>
    total + addition.block.text.length, 0);
  if (plan.blocks.length + additions.length > options.maxBlocks ||
    document.quality.characterCount + corrections.characterDelta + addedCharacters >
      options.maxCharacters ||
    document.attempts.length >= MAX_PARSER_ATTEMPTS &&
      !document.attempts.some((attempt) => attempt.engine === "native_pdf")) {
    return Object.freeze({
      addedBlockCount: 0,
      correctedBlockCount: 0,
      document: baselineEnriched,
      outcome: "rejected"
    });
  }
  const additionsByIndex = new Map<number, typeof additions>();
  for (const addition of additions) {
    const values = additionsByIndex.get(addition.insertionIndex) ?? [];
    values.push(addition);
    additionsByIndex.set(addition.insertionIndex, values);
  }
  const merged: ParsedDocumentBlock[] = [];
  for (let index = 0; index <= plan.blocks.length; index += 1) {
    const nativeRows = additionsByIndex.get(index) ?? [];
    nativeRows.sort((left, right) => left.geometryIndex - right.geometryIndex);
    merged.push(...nativeRows.map(({ block }) => block));
    const modelBlock = plan.blocks[index];
    if (modelBlock) merged.push(modelBlock);
  }
  const blocks = Object.freeze(merged.map(reindexBlock));
  const languages = Object.freeze([...new Set([
    ...document.languages,
    ...additions.flatMap(({ block }) => block.languageHints),
    ...corrections.nativeBlocks.flatMap((block) => block.languageHints)
  ])]);
  const augmented = finalizeParsedDocument({
    assets: document.assets,
    attempts: nativeAttempt(document.attempts),
    blocks,
    engine: document.engine,
    fieldGroups: document.fieldGroups,
    languages,
    mediaType: document.mediaType,
    ocrConfidence: document.quality.ocrConfidence,
    pageCount: document.pageCount,
    status: document.status,
    warnings: document.warnings,
    workbook: document.workbook
  });
  return Object.freeze({
    addedBlockCount: additions.length,
    correctedBlockCount: corrections.correctedBlockCount,
    document: augmented,
    outcome: "augmented"
  });
}
