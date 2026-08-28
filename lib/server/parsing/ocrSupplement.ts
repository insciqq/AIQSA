import { finalizeParsedDocument } from "./assessment";
import type {
  ParsedDocument,
  ParsedDocumentBlock,
  ParsedFieldGroup
} from "./types";

/** The first immutable local-PDF parser profile that may combine Docling's
 * structural output with a bounded Tika full-page OCR pass. */
export const PDF_IMAGE_OCR_SUPPLEMENT_PROFILE_VERSION = 8 as const;
/** Profile 9 keeps the profile-8 heterogeneous OCR route but admits fallback
 * text at paragraph granularity instead of copying a whole OCR page as one
 * peer passage. */
export const PDF_SEGMENTED_IMAGE_OCR_SUPPLEMENT_PROFILE_VERSION = 9 as const;

export type PdfImageOcrSupplementResult = Readonly<{
  document: ParsedDocument;
  outcome: "augmented" | "rejected" | "unchanged";
}>;

type SupplementLimits = Readonly<{
  maxBlocks: number;
  maxCharacters: number;
}>;

function normalizedTokenSequence(value: string): readonly string[] {
  return (value.normalize("NFKC")
    .toLocaleLowerCase("und")
    .replaceAll("ё", "е")
    .match(/[\p{L}\p{M}]+|[-+]?(?:\p{N}{1,3}(?:[ \u00a0\u202f]\p{N}{3})+|\p{N}+)(?:[.,]\p{N}+)?(?:%|‰)?/gu) ?? [])
    .map((token) => token
    .replace(/[ \u00a0\u202f]/gu, "")
    .replace(",", "."));
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

type PageEvidence = Readonly<{
  associations: ReadonlySet<string>;
  tokens: ReadonlySet<string>;
}>;

function pageEvidence(
  blocks: readonly ParsedDocumentBlock[],
  fieldGroups: readonly ParsedFieldGroup[]
): ReadonlyMap<number, PageEvidence> {
  const pages = new Map<number, { associations: Set<string>; tokens: Set<string> }>();
  const add = (page: number, text: string) => {
    const evidence = pages.get(page) ?? {
      associations: new Set<string>(),
      tokens: new Set<string>()
    };
    const sequence = normalizedTokenSequence(text);
    for (const token of sequence) evidence.tokens.add(token);
    for (const association of associationWindows(sequence)) {
      evidence.associations.add(association);
    }
    pages.set(page, evidence);
  };
  for (const block of blocks) {
    for (let page = block.page; page <= block.pageEnd; page += 1) add(page, block.text);
  }
  for (const group of fieldGroups) {
    const text = group.cells.flatMap((cell) => [cell.text, cell.originalText]).join(" ");
    for (let page = group.page; page <= group.pageEnd; page += 1) add(page, text);
  }
  return pages;
}

function materiallyNovel(
  block: ParsedDocumentBlock,
  primaryByPage: ReadonlyMap<number, PageEvidence>
): boolean {
  const primaryAssociations = new Set<string>();
  const primaryTokens = new Set<string>();
  for (let page = block.page; page <= block.pageEnd; page += 1) {
    const evidence = primaryByPage.get(page);
    for (const token of evidence?.tokens ?? []) primaryTokens.add(token);
    for (const association of evidence?.associations ?? []) {
      primaryAssociations.add(association);
    }
  }
  const sequence = normalizedTokenSequence(block.text);
  const fallback = new Set(sequence);
  if (fallback.size === 0) return false;
  const novel = [...fallback].filter((token) => !primaryTokens.has(token));
  if (novel.some((token) => /\p{N}/u.test(token))) return true;
  const novelWords = novel.filter((token) => /\p{L}/u.test(token) && [...token].length >= 2);
  if (novelWords.length >= 2 || novelWords.some((token) => [...token].length >= 8)) return true;
  const novelAssociations = associationWindows(sequence).filter((association) =>
    !primaryAssociations.has(association));
  return novelAssociations.some((association) => /\p{N}/u.test(association)) ||
    novelAssociations.length >= 2;
}

function supplementalBlock(
  block: ParsedDocumentBlock,
  text: string,
  index: number
): ParsedDocumentBlock {
  return Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: Object.freeze([]),
    headingPath: Object.freeze([]),
    index,
    isTable: false,
    languageHints: Object.freeze([...block.languageHints]),
    page: block.page,
    pageEnd: block.pageEnd,
    readingOrder: index,
    table: null,
    text,
    type: "paragraph"
  });
}

function supplementCandidates(
  fallback: ParsedDocument,
  segmentFallbackBlocks: boolean
): readonly Readonly<{ block: ParsedDocumentBlock; text: string }>[] {
  return Object.freeze(fallback.blocks.flatMap((block) => {
    const values = segmentFallbackBlocks
      ? block.text.split(/\n{2,}/u).map((value) => value.trim()).filter(Boolean)
      : [block.text];
    return values.map((text) => Object.freeze({ block, text }));
  }));
}

function hasSafePageAttribution(block: ParsedDocumentBlock, pageCount: number): boolean {
  return Number.isSafeInteger(block.page) && Number.isSafeInteger(block.pageEnd) &&
    block.page >= 1 && block.pageEnd >= block.page && block.pageEnd <= pageCount;
}

/** Preserve Docling-authored structure and append only materially novel,
 * page-attributed Tika OCR blocks. The merge is all-or-nothing so parser
 * limits can never yield a silently truncated OCR supplement. */
export function supplementImageHeavyPdfOcr(
  primary: ParsedDocument,
  fallback: ParsedDocument,
  limits: SupplementLimits,
  options: Readonly<{ segmentFallbackBlocks?: boolean }> = {}
): PdfImageOcrSupplementResult {
  if (
    primary.mediaType !== "application/pdf" || fallback.mediaType !== primary.mediaType ||
    primary.pageCount !== fallback.pageCount || fallback.status !== "complete" ||
    !fallback.quality.encodingValid || fallback.quality.usableBlockCount === 0
  ) {
    return Object.freeze({ document: primary, outcome: "rejected" });
  }
  if (fallback.blocks.some((block) => !hasSafePageAttribution(block, primary.pageCount))) {
    return Object.freeze({ document: primary, outcome: "rejected" });
  }

  const evidence = pageEvidence(primary.blocks, primary.fieldGroups);
  const additions = supplementCandidates(
    fallback,
    options.segmentFallbackBlocks === true
  ).filter(({ block, text }) => text.length > 0 && materiallyNovel({ ...block, text }, evidence));
  if (additions.length === 0) {
    return Object.freeze({ document: primary, outcome: "unchanged" });
  }
  const addedCharacters = additions.reduce((total, addition) => total + addition.text.length, 0);
  if (
    !Number.isSafeInteger(limits.maxBlocks) || limits.maxBlocks < 1 ||
    !Number.isSafeInteger(limits.maxCharacters) || limits.maxCharacters < 1 ||
    primary.blocks.length + additions.length > limits.maxBlocks ||
    primary.quality.characterCount + addedCharacters > limits.maxCharacters
  ) {
    return Object.freeze({ document: primary, outcome: "rejected" });
  }

  const blocks = [
    ...primary.blocks,
    ...additions.map(({ block, text }, offset) => supplementalBlock(
      block,
      text,
      primary.blocks.length + offset
    ))
  ];
  return Object.freeze({
    document: finalizeParsedDocument({
      assets: primary.assets,
      attempts: primary.attempts,
      blocks,
      engine: primary.engine,
      fieldGroups: primary.fieldGroups,
      languages: [...new Set([...primary.languages, ...fallback.languages])],
      mediaType: primary.mediaType,
      ocrConfidence: primary.quality.ocrConfidence,
      pageCount: primary.pageCount,
      status: primary.status,
      warnings: primary.warnings,
      workbook: primary.workbook
    }),
    outcome: "augmented"
  });
}
