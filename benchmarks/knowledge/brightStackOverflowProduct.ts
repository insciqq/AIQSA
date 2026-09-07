import type { ParsedDocumentBlock } from "../../lib/server/parsing";
import {
  finalizeParsedDocument,
  parsedLanguageHints
} from "../../lib/server/parsing/assessment";
import {
  chunkKnowledgeDocument,
  type KnowledgeChunkPlanEntry
} from "../../lib/server/knowledge/chunking";
import type { KnowledgeExtractionConfig } from
  "../../lib/server/knowledge/knowledgeExtractionConfig";
import {
  buildKnowledgeHierarchicalIndex,
  type KnowledgeHierarchicalIndexPlan
} from "../../lib/server/knowledge/hierarchicalIndex";
import {
  KNOWLEDGE_INLINE_REFERENCE_PROFILE_MIN_VERSION,
  KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION
} from "../../lib/server/knowledge/indexProfile";
import {
  decodeKnowledgeNormalizedDocument,
  encodeKnowledgeNormalizedDocument,
  type EncodedKnowledgeNormalizedDocument
} from "../../lib/server/knowledge/normalizedDocument";
import type { KnowledgeTokenCounter } from
  "../../lib/server/knowledge/tokenizer/types";
import {
  BRIGHT_STACKOVERFLOW_FILE_NAME,
  BRIGHT_STACKOVERFLOW_MEDIA_TYPE,
  BRIGHT_STACKOVERFLOW_SOURCE_NAME,
  type BrightPreparedDocument
} from "./brightStackOverflowContract";

export type BrightProductDocumentPlan = Readonly<{
  chunks: readonly KnowledgeChunkPlanEntry[];
  hierarchicalIndex: KnowledgeHierarchicalIndexPlan;
  normalized: EncodedKnowledgeNormalizedDocument;
}>;

/**
 * Direct normalized-text boundary for BRIGHT. This deliberately has no parser,
 * upload, PDF, OCR, or provider dependency. The resulting encoded document is
 * immediately decoded again under the ordinary product limits before it can
 * enter chunking, so the benchmark cannot create a storage-only backdoor.
 */
export function buildBrightProductDocumentPlan(input: Readonly<{
  artifactId: string;
  chunkingProfileVersion: number;
  config: KnowledgeExtractionConfig;
  document: BrightPreparedDocument;
  tokenCounter: KnowledgeTokenCounter;
}>): BrightProductDocumentPlan {
  const block: ParsedDocumentBlock = Object.freeze({
    assetIds: Object.freeze([]),
    boundingBoxes: Object.freeze([]),
    headingPath: Object.freeze([]),
    index: 0,
    isTable: false,
    languageHints: parsedLanguageHints(input.document.preparedText),
    page: 1,
    pageEnd: 1,
    readingOrder: 0,
    table: null,
    text: input.document.preparedText,
    type: "paragraph"
  });
  const parsed = finalizeParsedDocument({
    attempts: [],
    blocks: [block],
    engine: "inline",
    mediaType: BRIGHT_STACKOVERFLOW_MEDIA_TYPE,
    pageCount: 1,
    status: "complete",
    text: input.document.preparedText
  });
  const encoded = encodeKnowledgeNormalizedDocument(parsed, input.config, {
    layoutAwareInlineReferences: input.chunkingProfileVersion >=
      KNOWLEDGE_INLINE_REFERENCE_PROFILE_MIN_VERSION,
    layoutAwareTables: input.chunkingProfileVersion >=
      KNOWLEDGE_LAYOUT_AWARE_CHUNKING_PROFILE_MIN_VERSION,
    sourceDisplayName: BRIGHT_STACKOVERFLOW_FILE_NAME,
    sourceMediaType: BRIGHT_STACKOVERFLOW_MEDIA_TYPE
  });
  const validated = decodeKnowledgeNormalizedDocument(encoded.body, input.config);
  const chunks = Object.freeze(chunkKnowledgeDocument({
    document: validated,
    maxChunks: input.config.maxChunksPerDocument,
    profileVersion: input.chunkingProfileVersion,
    tokenCounter: input.tokenCounter
  }));
  const hierarchicalIndex = buildKnowledgeHierarchicalIndex({
    chunks,
    document: validated,
    fileName: BRIGHT_STACKOVERFLOW_FILE_NAME,
    mimeType: BRIGHT_STACKOVERFLOW_MEDIA_TYPE,
    sourceArtifactId: input.artifactId,
    sourceName: BRIGHT_STACKOVERFLOW_SOURCE_NAME
  });
  return Object.freeze({
    chunks,
    hierarchicalIndex,
    normalized: Object.freeze({ ...encoded, document: validated })
  });
}
