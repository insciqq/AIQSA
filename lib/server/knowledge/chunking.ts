import { KNOWLEDGE_CHUNKING_PROFILE_VERSION } from "./indexProfile";

export const KNOWLEDGE_CHUNK_MAX_CHARS = 1_600;
export const KNOWLEDGE_CHUNK_OVERLAP_CHARS = 200;
export const KNOWLEDGE_EMBEDDING_BATCH_SIZE = 64;

export type KnowledgeNormalizedBlock = Readonly<{
  headingPath: readonly string[];
  page: number;
  text: string;
}>;

export type KnowledgeChunkPlanEntry = Readonly<{
  headingPath: readonly string[];
  index: number;
  page: number;
  text: string;
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

function sameHeading(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function splitText(text: string): string[] {
  const chunks: string[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    let end = Math.min(text.length, cursor + KNOWLEDGE_CHUNK_MAX_CHARS);
    if (end < text.length) {
      const minimumBreak = cursor + Math.floor(KNOWLEDGE_CHUNK_MAX_CHARS * 0.6);
      for (let index = end; index >= minimumBreak; index -= 1) {
        if (/\s/u.test(text[index - 1] ?? "")) {
          end = index;
          break;
        }
      }
    }

    const value = text.slice(cursor, end).trim();
    if (value) chunks.push(value);
    if (end >= text.length) break;

    const next = Math.max(cursor + 1, end - KNOWLEDGE_CHUNK_OVERLAP_CHARS);
    cursor = next;
    while (cursor < end && /\s/u.test(text[cursor] ?? "")) cursor += 1;
  }

  return chunks;
}

export function chunkKnowledgeDocument(input: Readonly<{
  blocks: readonly KnowledgeNormalizedBlock[];
  maxChunks: number;
  profileVersion: number;
}>): KnowledgeChunkPlanEntry[] {
  if (
    input.profileVersion !== KNOWLEDGE_CHUNKING_PROFILE_VERSION ||
    !Number.isSafeInteger(input.maxChunks) ||
    input.maxChunks < 1
  ) {
    throw new KnowledgeChunkingError("chunking_failed");
  }

  const groups: Array<{ headingPath: readonly string[]; page: number; texts: string[] }> = [];
  for (const block of input.blocks) {
    if (
      !Number.isSafeInteger(block.page) ||
      block.page < 1 ||
      typeof block.text !== "string" ||
      !block.text.trim() ||
      block.headingPath.length > 16
    ) {
      throw new KnowledgeChunkingError("chunking_failed");
    }
    const previous = groups.at(-1);
    if (previous && previous.page === block.page && sameHeading(previous.headingPath, block.headingPath)) {
      previous.texts.push(block.text.trim());
    } else {
      groups.push({ headingPath: block.headingPath, page: block.page, texts: [block.text.trim()] });
    }
  }

  const result: KnowledgeChunkPlanEntry[] = [];
  for (const group of groups) {
    for (const text of splitText(group.texts.join("\n\n"))) {
      if (result.length >= input.maxChunks) {
        throw new KnowledgeChunkingError("knowledge_chunk_limit_exceeded");
      }
      result.push(Object.freeze({
        headingPath: Object.freeze([...group.headingPath]),
        index: result.length,
        page: group.page,
        text
      }));
    }
  }

  if (result.length === 0) throw new KnowledgeChunkingError("chunking_failed");
  return result;
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
