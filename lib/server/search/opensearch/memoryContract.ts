import { createHash, createHmac, createSecretKey, type KeyObject } from "node:crypto";
import type { MemorySearchItemType } from "@prisma/client";
import {
  MEMORY_LEXICAL_QUERY_ANALYSIS_VERSION
} from "../../../domain/memory/retrieval/lexical";
import { AIQSA_OPENSEARCH_VERSION } from "./contract";

export const MEMORY_OPENSEARCH_BACKEND_KIND =
  "opensearch_icu_lexical_v1" as const;
export const MEMORY_OPENSEARCH_MAPPING_VERSION =
  "memory-lexical-mapping-v1" as const;
export const MEMORY_OPENSEARCH_ANALYSIS_PROFILE =
  "memory-unicode-icu-v1" as const;
export const MEMORY_OPENSEARCH_NORMALIZATION_VERSION =
  MEMORY_LEXICAL_QUERY_ANALYSIS_VERSION;
// Projection compatibility is owned by the lexical document/query contract,
// not by the broader reader, packer, resolver, or admission pipeline. Keep the
// existing persisted wire value until one of those lexical shapes changes;
// unrelated answer-time revisions must not force a full OpenSearch rebuild.
export const MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION =
  "memory-personal-retrieval-v64" as const;
export const MEMORY_OPENSEARCH_READ_ALIAS =
  "aiqsa-memory-lexical-read" as const;
export const MEMORY_OPENSEARCH_WRITE_ALIAS =
  "aiqsa-memory-lexical-write" as const;
export const MEMORY_OPENSEARCH_DEFAULT_BUILD_ID = "20260831a" as const;
export const MEMORY_OPENSEARCH_BULK_MAX_DOCUMENTS = 100;
export const MEMORY_OPENSEARCH_BULK_MAX_BYTES = 2 * 1024 * 1024;
export const MEMORY_OPENSEARCH_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
export const MEMORY_OPENSEARCH_MAX_INTEGRITY_DOCUMENTS = 100_000;
export const MEMORY_OPENSEARCH_INTEGRITY_PAGE_SIZE = 500;

const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const aliasPattern = /^aiqsa-memory-[a-z0-9-]{1,48}$/u;
const buildIdPattern = /^[a-z0-9][a-z0-9-]{0,31}$/u;
const contentHashPattern = /^[a-f0-9]{64}$/u;
const maximumSignedInt64 = 9_223_372_036_854_775_807n;
const itemTypes = new Set<MemorySearchItemType>([
  "FACT_VERSION",
  "RECALL_CHUNK",
  "RECALL_ROUND",
  "RECALL_ROUND_SEGMENT",
  "TOOL_EVENT"
]);

export type MemoryOpenSearchConfiguration = Readonly<{
  bulkMaxBytes: number;
  bulkMaxDocuments: number;
  bulkTimeoutMs: number;
  physicalIndexName: string;
  readAlias: string;
  replicas: number;
  responseMaxBytes: number;
  routingKey: KeyObject;
  routingKeyId: string;
  searchTimeoutMs: number;
  shards: number;
  writeAlias: string;
}>;

export type MemoryOpenSearchDocument = Readonly<{
  analysisProfile: typeof MEMORY_OPENSEARCH_ANALYSIS_PROFILE;
  generationId: string;
  itemType: MemorySearchItemType;
  lexicalText: string;
  mappingVersion: typeof MEMORY_OPENSEARCH_MAPPING_VERSION;
  normalizationVersion: typeof MEMORY_OPENSEARCH_NORMALIZATION_VERSION;
  projectionSequence: bigint;
  retrievalPipelineVersion: typeof MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION;
  safeContentHash: string;
  searchEntryId: string;
  sourceChatId: string | null;
  userScope: string;
}>;

export type MemoryOpenSearchMutation =
  | Readonly<{
      document: MemoryOpenSearchDocument;
      operation: "UPSERT";
      routing: string;
      sequence: bigint;
    }>
  | Readonly<{
      operation: "DELETE";
      routing: string;
      searchEntryId: string;
      sequence: bigint;
    }>;

export type MemoryOpenSearchIntegrityEntry = Readonly<{
  safeContentHash: string;
  searchEntryId: string;
}>;

function integerFromEnvironment(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined || value === "") return fallback;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("memory_opensearch_configuration_invalid");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("memory_opensearch_configuration_invalid");
  }
  return parsed;
}

function exactBase64Key(value: string | undefined): KeyObject {
  if (!value || value.trim() !== value || !/^[A-Za-z0-9+/]{43}=$/u.test(value)) {
    throw new Error("memory_opensearch_routing_key_invalid");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.byteLength !== 32 || decoded.toString("base64") !== value) {
    throw new Error("memory_opensearch_routing_key_invalid");
  }
  return createSecretKey(decoded);
}

export function memoryOpenSearchConfigurationFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env
): MemoryOpenSearchConfiguration {
  const buildId = env.AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID?.trim() ||
    MEMORY_OPENSEARCH_DEFAULT_BUILD_ID;
  const readAlias = env.AIQSA_MEMORY_OPENSEARCH_READ_ALIAS?.trim() ||
    MEMORY_OPENSEARCH_READ_ALIAS;
  const writeAlias = env.AIQSA_MEMORY_OPENSEARCH_WRITE_ALIAS?.trim() ||
    MEMORY_OPENSEARCH_WRITE_ALIAS;
  const routingKeyId = env.AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY_ID?.trim() || "v1";
  if (!buildIdPattern.test(buildId) || !aliasPattern.test(readAlias) ||
    !aliasPattern.test(writeAlias) || readAlias === writeAlias ||
    !identifierPattern.test(routingKeyId)) {
    throw new Error("memory_opensearch_configuration_invalid");
  }
  const physicalIndexName = `aiqsa-memory-lexical-v1-${buildId}`;
  return Object.freeze({
    bulkMaxBytes: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_BULK_MAX_BYTES,
      MEMORY_OPENSEARCH_BULK_MAX_BYTES,
      64 * 1024,
      MEMORY_OPENSEARCH_BULK_MAX_BYTES
    ),
    bulkMaxDocuments: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_BULK_MAX_DOCUMENTS,
      MEMORY_OPENSEARCH_BULK_MAX_DOCUMENTS,
      1,
      MEMORY_OPENSEARCH_BULK_MAX_DOCUMENTS
    ),
    bulkTimeoutMs: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_BULK_TIMEOUT_MS,
      30_000,
      1_000,
      60_000
    ),
    physicalIndexName,
    readAlias,
    replicas: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_REPLICAS,
      0,
      0,
      4
    ),
    responseMaxBytes: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_MAX_RESPONSE_BYTES,
      MEMORY_OPENSEARCH_MAX_RESPONSE_BYTES,
      64 * 1024,
      MEMORY_OPENSEARCH_MAX_RESPONSE_BYTES
    ),
    routingKey: exactBase64Key(env.AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY),
    routingKeyId,
    searchTimeoutMs: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_SEARCH_TIMEOUT_MS,
      3_000,
      250,
      10_000
    ),
    shards: integerFromEnvironment(
      env.AIQSA_MEMORY_OPENSEARCH_SHARDS,
      1,
      1,
      32
    ),
    writeAlias
  });
}

function boundedOpaque(value: string, maximum = 512): boolean {
  return value.length >= 1 && value.length <= maximum &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

export function memoryOpenSearchIntegrityFingerprintMaterial(
  entry: MemoryOpenSearchIntegrityEntry
): string {
  if (!boundedOpaque(entry.searchEntryId) ||
    !contentHashPattern.test(entry.safeContentHash)) {
    throw new Error("memory_opensearch_integrity_entry_invalid");
  }
  return `${entry.searchEntryId}\0${entry.safeContentHash}\n`;
}

export function memoryOpenSearchUserScope(
  userId: string,
  configuration: Pick<MemoryOpenSearchConfiguration, "routingKey" | "routingKeyId">
): string {
  if (!boundedOpaque(userId)) throw new Error("memory_opensearch_identity_invalid");
  return createHmac("sha256", configuration.routingKey)
    .update("aiqsa.memory.opensearch-routing.v1\0", "utf8")
    .update(configuration.routingKeyId, "utf8")
    .update("\0", "utf8")
    .update(userId, "utf8")
    .digest("hex");
}

export function memoryOpenSearchDocumentId(searchEntryId: string): string {
  if (!boundedOpaque(searchEntryId)) {
    throw new Error("memory_opensearch_identity_invalid");
  }
  return createHash("sha256")
    .update("aiqsa.memory.lexical-document.v1\0", "utf8")
    .update(searchEntryId, "utf8")
    .digest("hex");
}

export function assertMemoryOpenSearchDocument(
  document: MemoryOpenSearchDocument
): void {
  if (!boundedOpaque(document.generationId) ||
    !boundedOpaque(document.searchEntryId) ||
    !itemTypes.has(document.itemType) ||
    !contentHashPattern.test(document.safeContentHash) ||
    !contentHashPattern.test(document.userScope) ||
    (document.sourceChatId !== null && !boundedOpaque(document.sourceChatId)) ||
    document.lexicalText.trim() !== document.lexicalText ||
    Array.from(document.lexicalText).length < 1 ||
    Array.from(document.lexicalText).length > 4_000 ||
    document.projectionSequence < 1n ||
    document.projectionSequence > maximumSignedInt64 ||
    document.mappingVersion !== MEMORY_OPENSEARCH_MAPPING_VERSION ||
    document.normalizationVersion !== MEMORY_OPENSEARCH_NORMALIZATION_VERSION ||
    document.analysisProfile !== MEMORY_OPENSEARCH_ANALYSIS_PROFILE ||
    document.retrievalPipelineVersion !==
      MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION) {
    throw new Error("memory_opensearch_document_invalid");
  }
}

export function memoryOpenSearchProjectionFingerprint(
  configuration: Pick<
    MemoryOpenSearchConfiguration,
    "physicalIndexName" | "routingKeyId" | "shards" | "replicas"
  >
): string {
  return createHash("sha256").update(JSON.stringify({
    analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
    backendKind: MEMORY_OPENSEARCH_BACKEND_KIND,
    mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
    normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
    openSearchVersion: AIQSA_OPENSEARCH_VERSION,
    physicalIndexName: configuration.physicalIndexName,
    replicas: configuration.replicas,
    retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
    routingKeyId: configuration.routingKeyId,
    shards: configuration.shards,
    version: 1
  })).digest("hex");
}

export function memoryOpenSearchIndexDefinition(
  configuration: Pick<MemoryOpenSearchConfiguration, "replicas" | "shards">
) {
  return {
    mappings: {
      _meta: {
        analysis_profile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
        mapping_version: MEMORY_OPENSEARCH_MAPPING_VERSION,
        normalization_version: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
        retrieval_pipeline_version: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION
      },
      _routing: { required: true },
      _source: { enabled: false },
      dynamic: "strict",
      properties: {
        analysis_profile: { type: "keyword" },
        generation_id: { type: "keyword" },
        item_type: { type: "keyword" },
        lexical_text: {
          analyzer: "memory_unicode",
          fields: {
            folded: {
              analyzer: "memory_folded",
              search_analyzer: "memory_folded",
              type: "text"
            },
            ngram: {
              analyzer: "memory_ngram",
              search_analyzer: "memory_ngram",
              type: "text"
            },
            transliterated: {
              analyzer: "memory_transliterated",
              search_analyzer: "memory_transliterated",
              type: "text"
            }
          },
          search_analyzer: "memory_unicode",
          type: "text"
        },
        mapping_version: { type: "keyword" },
        normalization_version: { type: "keyword" },
        projection_sequence: { store: true, type: "long" },
        retrieval_pipeline_version: { type: "keyword" },
        safe_content_hash: { store: true, type: "keyword" },
        search_entry_id: { store: true, type: "keyword" },
        source_chat_id: { store: true, type: "keyword" },
        user_scope: { type: "keyword" }
      }
    },
    settings: {
      analysis: {
        analyzer: {
          memory_folded: {
            char_filter: ["memory_nfkc_cf"],
            filter: ["icu_folding"],
            tokenizer: "icu_tokenizer",
            type: "custom"
          },
          memory_ngram: {
            char_filter: ["memory_nfkc_cf"],
            tokenizer: "memory_ngram_tokenizer",
            type: "custom"
          },
          memory_transliterated: {
            char_filter: ["memory_nfkc_cf"],
            filter: ["memory_any_latin"],
            tokenizer: "icu_tokenizer",
            type: "custom"
          },
          memory_unicode: {
            char_filter: ["memory_nfkc_cf"],
            tokenizer: "icu_tokenizer",
            type: "custom"
          }
        },
        char_filter: {
          memory_nfkc_cf: {
            mode: "compose",
            name: "nfkc_cf",
            type: "icu_normalizer"
          }
        },
        filter: {
          memory_any_latin: {
            id: "Any-Latin; NFD; [:Nonspacing Mark:] Remove; NFC; Lower",
            type: "icu_transform"
          }
        },
        tokenizer: {
          memory_ngram_tokenizer: {
            max_gram: 3,
            min_gram: 2,
            token_chars: ["letter", "digit"],
            type: "ngram"
          }
        }
      },
      index: {
        number_of_replicas: configuration.replicas,
        number_of_shards: configuration.shards,
        similarity: {
          default: { b: 0.75, k1: 1.2, type: "BM25" }
        }
      }
    }
  } as const;
}

export const MEMORY_OPENSEARCH_ANALYZER_GOLDEN = Object.freeze([
  Object.freeze({
    analyzer: "memory_unicode",
    expectedTokens: Object.freeze([
      "café", "abc", "ёлка", "東京", "مرحبا", "עולם", "नमस्ते", "สวัสดี"
    ]),
    text: "Café ＡＢＣ Ёлка 東京 مرحبا עולם नमस्ते สวัสดี"
  }),
  Object.freeze({
    analyzer: "memory_folded",
    expectedTokens: Object.freeze(["cafe", "abc"]),
    text: "Café ＡＢＣ"
  }),
  Object.freeze({
    analyzer: "memory_ngram",
    expectedTokens: Object.freeze(["ab", "abc", "bc"]),
    text: "ＡＢＣ"
  }),
  Object.freeze({
    analyzer: "memory_transliterated",
    expectedTokens: Object.freeze(["aleksandar", "beograd"]),
    text: "Александар Београд"
  })
] as const);
