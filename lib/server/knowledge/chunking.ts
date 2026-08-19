import { createHash } from "node:crypto";
import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";
import type {
  KnowledgeNormalizedBlock,
  StoredKnowledgeNormalizedDocument
} from "./normalizedDocument";

export const KNOWLEDGE_CHUNK_MAX_TOKENS = 400;
export const KNOWLEDGE_CHUNK_OVERLAP_TOKENS = 48;
/** Hard defensive ceiling; v2 admission is token-oriented. */
export const KNOWLEDGE_CHUNK_MAX_CHARS = 12_000;
/** Legacy profile-1 character overlap retained for old immutable revisions. */
export const KNOWLEDGE_CHUNK_OVERLAP_CHARS = 200;
export const KNOWLEDGE_EMBEDDING_BATCH_SIZE = 64;

export type KnowledgeChunkPlanEntry = Readonly<{
  contentHash: string;
  contextPrefix: string;
  embeddingText: string;
  embeddingTextHash: string;
  headingPath: readonly string[];
  index: number;
  page: number;
  pageEnd: number;
  sourceBlockEnd: number;
  sourceBlockIds: readonly string[];
  sourceBlockStart: number;
  text: string;
  tokenCount: number;
}>;

export type KnowledgeChunkingErrorCode =
  | "chunking_failed"
  | "knowledge_chunk_limit_exceeded";

export class KnowledgeChunkingError extends Error {
  constructor(readonly code: KnowledgeChunkingErrorCode) {
    super(code);
    this.name = "KnowledgeChunkingError";
  }
}

type Segment = Readonly<{
  blockEnd: number;
  blockIds: readonly string[];
  blockStart: number;
  headingPath: readonly string[];
  pageEnd: number;
  pageStart: number;
  text: string;
  tokenCount: number;
  type: KnowledgeNormalizedBlock["type"];
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameHeading(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizedContextValue(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
}

export function approximateKnowledgeTokenCount(text: string): number {
  const lexical = text.match(/[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu)?.length ?? 0;
  return Math.max(1, lexical);
}

function tokenBoundaries(text: string): Array<{ end: number; start: number }> {
  return [...text.matchAll(/[\p{L}\p{M}\p{N}_]+|[^\s\p{L}\p{M}\p{N}_]/gu)].map((match) => ({
    end: (match.index ?? 0) + match[0].length,
    start: match.index ?? 0
  }));
}

function codePointSafeEnd(text: string, end: number): number {
  if (
    end > 0 && end < text.length &&
    /[\uD800-\uDBFF]/u.test(text[end - 1] ?? "") &&
    /[\uDC00-\uDFFF]/u.test(text[end] ?? "")
  ) return end - 1;
  return end;
}

function splitTextByTokens(text: string): Array<{ text: string; tokenCount: number }> {
  if (!text.trim()) return [];
  const result: Array<{ text: string; tokenCount: number }> = [];
  let start = 0;
  while (start < text.length) {
    while (start < text.length && /\s/u.test(text[start] ?? "")) start += 1;
    if (start >= text.length) break;

    let low = start + 1;
    let high = Math.min(text.length, start + KNOWLEDGE_CHUNK_MAX_CHARS);
    let acceptedEnd = start;
    while (low <= high) {
      const midpoint = codePointSafeEnd(text, Math.floor((low + high) / 2));
      if (midpoint <= start) {
        low += 1;
        continue;
      }
      const candidate = text.slice(start, midpoint);
      if (approximateKnowledgeTokenCount(candidate) <= KNOWLEDGE_CHUNK_MAX_TOKENS) {
        acceptedEnd = midpoint;
        low = midpoint + 1;
      } else {
        high = midpoint - 1;
      }
    }
    if (acceptedEnd <= start) throw new KnowledgeChunkingError("chunking_failed");

    if (acceptedEnd < text.length) {
      const minimumSemanticBreak = start + Math.floor((acceptedEnd - start) * 0.6);
      for (let index = acceptedEnd; index > minimumSemanticBreak; index -= 1) {
        if (/\s/u.test(text[index - 1] ?? "")) {
          acceptedEnd = index;
          break;
        }
      }
    }

    const value = text.slice(start, acceptedEnd).trim();
    if (!value) throw new KnowledgeChunkingError("chunking_failed");
    const tokenCount = approximateKnowledgeTokenCount(value);
    if (tokenCount > KNOWLEDGE_CHUNK_MAX_TOKENS || value.length > KNOWLEDGE_CHUNK_MAX_CHARS) {
      throw new KnowledgeChunkingError("chunking_failed");
    }
    result.push({ text: value, tokenCount });
    if (acceptedEnd >= text.length) break;

    const boundaries = tokenBoundaries(text.slice(start, acceptedEnd));
    const overlapBoundary = boundaries.length > 1
      ? boundaries[Math.max(1, boundaries.length - KNOWLEDGE_CHUNK_OVERLAP_TOKENS)]
      : undefined;
    const next = overlapBoundary ? start + overlapBoundary.start : acceptedEnd;
    start = next > start ? next : acceptedEnd;
  }
  return result;
}

function tableRows(block: KnowledgeNormalizedBlock): string[] {
  if (!block.table) return block.text ? [block.text] : [];
  const rows = Array.from(
    { length: block.table.rowCount },
    () => Array<string>(block.table!.columnCount).fill("")
  );
  for (const cell of block.table.cells) rows[cell.row]![cell.column] = cell.text;
  return rows.map((row) => row.join("\t").trimEnd()).filter(Boolean);
}

function tableSegments(block: KnowledgeNormalizedBlock): Segment[] {
  const rows = tableRows(block);
  if (rows.length === 0) return [];
  const header = rows[0]!;
  const result: Segment[] = [];
  let current: string[] = [];

  const flush = () => {
    if (current.length === 0) return;
    const text = current.join("\n");
    for (const split of splitTextByTokens(text)) {
      result.push(Object.freeze({
        blockEnd: block.order,
        blockIds: Object.freeze([block.id]),
        blockStart: block.order,
        headingPath: block.headingPath,
        pageEnd: block.locator.pageEnd,
        pageStart: block.locator.pageStart,
        text: split.text,
        tokenCount: split.tokenCount,
        type: block.type
      }));
    }
    current = [];
  };

  for (const [index, row] of rows.entries()) {
    const candidateRows = current.length === 0
      ? index === 0 ? [row] : [header, row]
      : [...current, row];
    const candidate = candidateRows.join("\n");
    if (
      current.length > 0 &&
      (approximateKnowledgeTokenCount(candidate) > KNOWLEDGE_CHUNK_MAX_TOKENS ||
        candidate.length > KNOWLEDGE_CHUNK_MAX_CHARS)
    ) {
      flush();
      current = index === 0 ? [row] : [header, row];
    } else {
      current = candidateRows;
    }
  }
  flush();
  return result;
}

function furnitureKey(block: KnowledgeNormalizedBlock): string {
  return sha256(block.text.replace(/\s+/gu, " ").trim().toLowerCase());
}

function repeatedFurniture(blocks: readonly KnowledgeNormalizedBlock[]): Set<string> {
  const pagesByKey = new Map<string, Set<number>>();
  for (const block of blocks) {
    if (!block.text || block.text.length > 240 || block.type === "title" || block.type === "heading") continue;
    const key = furnitureKey(block);
    const pages = pagesByKey.get(key) ?? new Set<number>();
    pages.add(block.locator.pageStart);
    pagesByKey.set(key, pages);
  }
  return new Set([...pagesByKey].filter(([, pages]) => pages.size >= 3).map(([key]) => key));
}

function structuralSegments(blocks: readonly KnowledgeNormalizedBlock[]): Segment[] {
  const excluded = repeatedFurniture(blocks);
  const result: Segment[] = [];
  for (const block of blocks) {
    if (!block.text || excluded.has(furnitureKey(block)) || block.type === "image") continue;
    if (block.type === "table") {
      result.push(...tableSegments(block));
      continue;
    }
    for (const split of splitTextByTokens(block.text)) {
      result.push(Object.freeze({
        blockEnd: block.order,
        blockIds: Object.freeze([block.id]),
        blockStart: block.order,
        headingPath: block.headingPath,
        pageEnd: block.locator.pageEnd,
        pageStart: block.locator.pageStart,
        text: split.text,
        tokenCount: split.tokenCount,
        type: block.type
      }));
    }
  }
  return result;
}

function mergeStructuralSegments(segments: readonly Segment[]): Segment[] {
  const result: Segment[] = [];
  let current: Segment | null = null;
  const cannotMerge = new Set<KnowledgeNormalizedBlock["type"]>(["code", "table"]);

  for (const segment of segments) {
    if (!current) {
      current = segment;
      continue;
    }
    const candidateText: string = `${current.text}\n\n${segment.text}`;
    const canMerge =
      sameHeading(current.headingPath, segment.headingPath) &&
      !cannotMerge.has(current.type) && !cannotMerge.has(segment.type) &&
      approximateKnowledgeTokenCount(candidateText) <= KNOWLEDGE_CHUNK_MAX_TOKENS &&
      candidateText.length <= KNOWLEDGE_CHUNK_MAX_CHARS;
    if (canMerge) {
      current = Object.freeze({
        blockEnd: segment.blockEnd,
        blockIds: Object.freeze([...current.blockIds, ...segment.blockIds]),
        blockStart: current.blockStart,
        headingPath: current.headingPath,
        pageEnd: Math.max(current.pageEnd, segment.pageEnd),
        pageStart: Math.min(current.pageStart, segment.pageStart),
        text: candidateText,
        tokenCount: approximateKnowledgeTokenCount(candidateText),
        type: current.type
      });
    } else {
      result.push(current);
      current = segment;
    }
  }
  if (current) result.push(current);
  return result;
}

function contextPrefix(document: StoredKnowledgeNormalizedDocument, segment: Segment): string {
  const parts = [
    document.source.displayName
      ? `Source: ${normalizedContextValue(document.source.displayName)}`
      : null,
    document.title ? `Title: ${normalizedContextValue(document.title)}` : null,
    segment.headingPath.length > 0
      ? `Section: ${segment.headingPath.map(normalizedContextValue).join(" › ")}`
      : null,
    `Location: ${segment.pageStart === segment.pageEnd
      ? `page ${segment.pageStart}`
      : `pages ${segment.pageStart}–${segment.pageEnd}`}`
  ].filter((value): value is string => Boolean(value));
  return parts.join("\n").slice(0, 1_024);
}

function planEntry(
  document: StoredKnowledgeNormalizedDocument,
  segment: Segment,
  index: number,
  withContext: boolean
): KnowledgeChunkPlanEntry {
  const prefix = withContext ? contextPrefix(document, segment) : "";
  const embeddingText = prefix ? `${prefix}\n\n${segment.text}` : segment.text;
  return Object.freeze({
    contentHash: sha256(JSON.stringify({
      blockIds: segment.blockIds,
      headingPath: segment.headingPath,
      text: segment.text
    })),
    contextPrefix: prefix,
    embeddingText,
    embeddingTextHash: sha256(embeddingText),
    headingPath: Object.freeze([...segment.headingPath]),
    index,
    page: segment.pageStart,
    pageEnd: segment.pageEnd,
    sourceBlockEnd: segment.blockEnd,
    sourceBlockIds: Object.freeze([...segment.blockIds]),
    sourceBlockStart: segment.blockStart,
    text: segment.text,
    tokenCount: segment.tokenCount
  });
}

function legacyCharacterSegments(document: StoredKnowledgeNormalizedDocument): Segment[] {
  const groups: Array<{
    blockEnd: number;
    blockIds: string[];
    blockStart: number;
    headingPath: readonly string[];
    page: number;
    texts: string[];
  }> = [];
  for (const block of document.blocks) {
    if (!block.text) continue;
    const page = block.locator.pageStart;
    const previous = groups.at(-1);
    if (previous && previous.page === page && sameHeading(previous.headingPath, block.headingPath)) {
      previous.blockEnd = block.order;
      previous.blockIds.push(block.id);
      previous.texts.push(block.text);
    } else {
      groups.push({
        blockEnd: block.order,
        blockIds: [block.id],
        blockStart: block.order,
        headingPath: block.headingPath,
        page,
        texts: [block.text]
      });
    }
  }
  const result: Segment[] = [];
  for (const group of groups) {
    const text = group.texts.join("\n\n");
    let cursor = 0;
    while (cursor < text.length) {
      let end = Math.min(text.length, cursor + 1_600);
      if (end < text.length) {
        const minimumBreak = cursor + 960;
        for (let index = end; index >= minimumBreak; index -= 1) {
          if (/\s/u.test(text[index - 1] ?? "")) {
            end = index;
            break;
          }
        }
      }
      const value = text.slice(cursor, end).trim();
      if (value) result.push(Object.freeze({
        blockEnd: group.blockEnd,
        blockIds: Object.freeze([...group.blockIds]),
        blockStart: group.blockStart,
        headingPath: group.headingPath,
        pageEnd: group.page,
        pageStart: group.page,
        text: value,
        tokenCount: approximateKnowledgeTokenCount(value),
        type: "paragraph"
      }));
      if (end >= text.length) break;
      cursor = Math.max(cursor + 1, end - KNOWLEDGE_CHUNK_OVERLAP_CHARS);
      while (cursor < end && /\s/u.test(text[cursor] ?? "")) cursor += 1;
    }
  }
  return result;
}

export function chunkKnowledgeDocument(input: Readonly<{
  document: StoredKnowledgeNormalizedDocument;
  maxChunks: number;
  profileVersion: number;
}>): KnowledgeChunkPlanEntry[] {
  if (
    ![1, KNOWLEDGE_CHUNKING_PROFILE_VERSION].includes(input.profileVersion) ||
    !Number.isSafeInteger(input.maxChunks) || input.maxChunks < 1
  ) throw new KnowledgeChunkingError("chunking_failed");

  const segments = input.profileVersion === 1
    ? legacyCharacterSegments(input.document)
    : mergeStructuralSegments(structuralSegments(input.document.blocks));
  if (segments.length === 0) throw new KnowledgeChunkingError("chunking_failed");
  if (segments.length > input.maxChunks) {
    throw new KnowledgeChunkingError("knowledge_chunk_limit_exceeded");
  }
  return segments.map((segment, index) => planEntry(
    input.document,
    segment,
    index,
    input.profileVersion === KNOWLEDGE_CHUNKING_PROFILE_VERSION
  ));
}

export function knowledgeEmbeddingBatches(
  chunks: readonly KnowledgeChunkPlanEntry[]
): Array<Readonly<{ batchIndex: number; chunks: readonly KnowledgeChunkPlanEntry[] }>> {
  const batches: Array<Readonly<{ batchIndex: number; chunks: readonly KnowledgeChunkPlanEntry[] }>> = [];
  for (let offset = 0; offset < chunks.length; offset += KNOWLEDGE_EMBEDDING_BATCH_SIZE) {
    batches.push(Object.freeze({
      batchIndex: Math.floor(offset / KNOWLEDGE_EMBEDDING_BATCH_SIZE),
      chunks: Object.freeze(chunks.slice(offset, offset + KNOWLEDGE_EMBEDDING_BATCH_SIZE))
    }));
  }
  return batches;
}
