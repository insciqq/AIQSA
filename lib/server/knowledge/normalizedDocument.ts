import { createHash } from "node:crypto";
import type { ParsedDocument } from "../parsing";
import type { KnowledgeExtractionConfig } from "./knowledgeExtractionConfig";
import type { KnowledgeNormalizedBlock } from "./chunking";

export type StoredKnowledgeNormalizedDocument = Readonly<{
  blocks: readonly KnowledgeNormalizedBlock[];
  pageCount: number;
  parserEngine: "docling" | "inline" | "tika";
  schemaVersion: 1;
}>;

export type EncodedKnowledgeNormalizedDocument = Readonly<{
  body: Buffer;
  checksum: string;
  document: StoredKnowledgeNormalizedDocument;
}>;

export type KnowledgeNormalizedDocumentErrorCode =
  | "knowledge_page_limit_exceeded"
  | "knowledge_text_limit_exceeded"
  | "parser_rejected";

export class KnowledgeNormalizedDocumentError extends Error {
  constructor(readonly code: KnowledgeNormalizedDocumentErrorCode) {
    super(code);
    this.name = "KnowledgeNormalizedDocumentError";
  }
}

function normalizedHeadingPath(values: readonly string[]): readonly string[] {
  return Object.freeze(values.slice(0, 16).map((value) =>
    value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 256)
  ).filter(Boolean));
}

function checksum(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizedBlock(value: unknown): KnowledgeNormalizedBlock | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.headingPath) ||
    value.headingPath.some((item) => typeof item !== "string") ||
    !Number.isSafeInteger(value.page) ||
    Number(value.page) < 1 ||
    typeof value.text !== "string"
  ) {
    return null;
  }
  const text = value.text.replace(/\r\n?/gu, "\n").trim();
  if (!text || /\u0000/u.test(text)) return null;
  return Object.freeze({
    headingPath: normalizedHeadingPath(value.headingPath as string[]),
    page: Number(value.page),
    text
  });
}

function assertWithinLimits(
  document: StoredKnowledgeNormalizedDocument,
  config: KnowledgeExtractionConfig
): void {
  if (document.pageCount > config.maxPages) {
    throw new KnowledgeNormalizedDocumentError("knowledge_page_limit_exceeded");
  }
  if (document.blocks.length === 0) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  if (document.blocks.some((block) => block.page > document.pageCount)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const characterCount = document.blocks.reduce((total, block) => total + block.text.length, 0);
  if (
    characterCount > config.maxNormalizedChars ||
    document.blocks.length > config.maxChunksPerDocument * 4
  ) {
    throw new KnowledgeNormalizedDocumentError("knowledge_text_limit_exceeded");
  }
}

export function encodeKnowledgeNormalizedDocument(
  parsed: ParsedDocument,
  config: KnowledgeExtractionConfig
): EncodedKnowledgeNormalizedDocument {
  if (parsed.status !== "complete" || !Number.isSafeInteger(parsed.pageCount) || parsed.pageCount < 1) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const blocks = parsed.blocks.map((block) => normalizedBlock(block));
  if (blocks.some((block) => block === null)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const document = Object.freeze({
    blocks: Object.freeze(blocks as KnowledgeNormalizedBlock[]),
    pageCount: parsed.pageCount,
    parserEngine: parsed.engine,
    schemaVersion: 1 as const
  });
  assertWithinLimits(document, config);
  const body = Buffer.from(JSON.stringify(document), "utf8");
  if (body.byteLength > config.maxNormalizedObjectBytes) {
    throw new KnowledgeNormalizedDocumentError("knowledge_text_limit_exceeded");
  }
  return { body, checksum: checksum(body), document };
}

export function decodeKnowledgeNormalizedDocument(
  body: Buffer,
  config: KnowledgeExtractionConfig
): StoredKnowledgeNormalizedDocument {
  if (body.byteLength < 1 || body.byteLength > config.maxNormalizedObjectBytes) {
    throw new KnowledgeNormalizedDocumentError("knowledge_text_limit_exceeded");
  }
  let value: unknown;
  try {
    value = JSON.parse(body.toString("utf8")) as unknown;
  } catch {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !["docling", "inline", "tika"].includes(String(value.parserEngine)) ||
    !Number.isSafeInteger(value.pageCount) ||
    Number(value.pageCount) < 1 ||
    !Array.isArray(value.blocks)
  ) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const blocks = value.blocks.map(normalizedBlock);
  if (blocks.some((block) => block === null)) {
    throw new KnowledgeNormalizedDocumentError("parser_rejected");
  }
  const document = Object.freeze({
    blocks: Object.freeze(blocks as KnowledgeNormalizedBlock[]),
    pageCount: Number(value.pageCount),
    parserEngine: value.parserEngine as StoredKnowledgeNormalizedDocument["parserEngine"],
    schemaVersion: 1 as const
  });
  assertWithinLimits(document, config);
  return document;
}
