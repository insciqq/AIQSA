import { randomUUID } from "node:crypto";
import {
  AIQSA_OPENSEARCH_VERSION,
  KNOWLEDGE_SEARCH_BULK_MAX_BYTES,
  KNOWLEDGE_SEARCH_BULK_MAX_DOCUMENTS,
  KNOWLEDGE_SEARCH_FIELD_WEIGHTS,
  KNOWLEDGE_SEARCH_INDEX_DEFINITION,
  KNOWLEDGE_SEARCH_INDEX_NAME,
  KNOWLEDGE_SEARCH_MAPPING_VERSION,
  KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS,
  KNOWLEDGE_SEARCH_MAX_HITS_PER_VARIANT,
  KNOWLEDGE_SEARCH_MAX_QUERY_VARIANTS,
  knowledgeSearchDocumentId,
  type KnowledgeBm25VariantHit,
  type KnowledgeSearchDocument
} from "./contract";
import {
  BoundedOpenSearchCoreTransport,
  OpenSearchTransportError,
  type BoundedOpenSearchRequest
} from "./coreTransport";

export { OpenSearchTransportError, type OpenSearchFailureCode } from
  "./coreTransport";

const HEALTH_TIMEOUT_MS = 3_000;
const SEARCH_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;
const SMALL_RESPONSE_MAX_BYTES = 1024 * 1024;
const BULK_RESPONSE_MAX_BYTES = 5 * 1024 * 1024;
const KNOWLEDGE_INTEGRITY_PAGE_SIZE = 1_000;
const KNOWLEDGE_REBUILD_COUNT_MAX_ARTIFACTS = 256;

export type AiqsaOpenSearchNamespace = "knowledge" | "memory";

export type KnowledgeOpenSearchResult = Readonly<{
  durationMs: number;
  opaqueId: string | null;
  variants: readonly (readonly KnowledgeBm25VariantHit[])[];
}>;

export type KnowledgeOpenSearchInventory = Readonly<{
  artifactCounts: readonly Readonly<{
    count: number;
    indexArtifactId: string;
  }>[];
  currentMappingDocumentCount: number;
  staleMappingDocumentCount: number;
}>;

type KnowledgeArtifactCount = KnowledgeOpenSearchInventory["artifactCounts"][number];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactJson(value: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return Array.isArray(value) && value.length === expected.length &&
      expected.every((entry, index) => exactJson(value[index], entry));
  }
  if (record(expected)) {
    if (!record(value)) return false;
    const expectedKeys = Object.keys(expected).sort();
    const actualKeys = Object.keys(value).sort();
    return actualKeys.length === expectedKeys.length &&
      actualKeys.every((key, index) => key === expectedKeys[index]) &&
      expectedKeys.every((key) => exactJson(value[key], expected[key]));
  }
  return value === expected;
}

function exactPropertyMapping(value: unknown): boolean {
  return exactJson(value, KNOWLEDGE_SEARCH_INDEX_DEFINITION.mappings);
}

function exactKnowledgeIndexSettings(value: unknown): boolean {
  if (!record(value) || Object.keys(value).length !== 1 || !record(value.index)) return false;
  const index = value.index;
  const expectedKeys = [
    "creation_date",
    "max_result_window",
    "number_of_replicas",
    "number_of_shards",
    "provided_name",
    "replication",
    "similarity",
    "uuid",
    "version"
  ];
  if (Object.keys(index).sort().some((key, position) => key !== expectedKeys[position]) ||
    Object.keys(index).length !== expectedKeys.length ||
    !/^\d+$/u.test(String(index.creation_date)) ||
    index.provided_name !== KNOWLEDGE_SEARCH_INDEX_NAME ||
    typeof index.uuid !== "string" || index.uuid.length < 1 || index.uuid.length > 128 ||
    !record(index.replication) || !exactJson(index.replication, { type: "DOCUMENT" }) ||
    !record(index.version) || Object.keys(index.version).length !== 1 ||
    !/^\d+$/u.test(String(index.version.created))) return false;
  if (!record(index.similarity) || Object.keys(index.similarity).length !== 1 ||
    !record(index.similarity.default) ||
    Object.keys(index.similarity.default).sort().join(",") !== "b,k1,type") return false;
  const similarity = index.similarity.default;
  return Number(index.max_result_window) ===
      KNOWLEDGE_SEARCH_INDEX_DEFINITION.settings.index.max_result_window &&
    Number(index.number_of_shards) ===
      KNOWLEDGE_SEARCH_INDEX_DEFINITION.settings.index.number_of_shards &&
    Number(index.number_of_replicas) ===
      KNOWLEDGE_SEARCH_INDEX_DEFINITION.settings.index.number_of_replicas &&
    similarity.type === "BM25" &&
    Number(similarity.k1) ===
      KNOWLEDGE_SEARCH_INDEX_DEFINITION.settings.index.similarity.default.k1 &&
    Number(similarity.b) ===
      KNOWLEDGE_SEARCH_INDEX_DEFINITION.settings.index.similarity.default.b;
}

function singleField(fields: unknown, key: string): string | null {
  if (!record(fields) || !Array.isArray(fields[key]) || fields[key].length !== 1) return null;
  const value = fields[key][0];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function decodeCompositeArtifactBuckets(
  value: unknown,
  maximum: number
): Readonly<{
  after: string | null;
  counts: readonly KnowledgeArtifactCount[];
}> {
  if (!record(value) || !Array.isArray(value.buckets) ||
    value.buckets.length > maximum) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  const counts = value.buckets.map((bucket) => {
    if (!record(bucket) || !record(bucket.key) ||
      Object.keys(bucket.key).length !== 1 ||
      typeof bucket.key.artifact !== "string" ||
      bucket.key.artifact.length < 1 || bucket.key.artifact.length > 512 ||
      !Number.isSafeInteger(bucket.doc_count) || Number(bucket.doc_count) < 1) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    return Object.freeze({
      count: Number(bucket.doc_count),
      indexArtifactId: bucket.key.artifact
    });
  });
  if (new Set(counts.map(({ indexArtifactId }) => indexArtifactId)).size !== counts.length) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  let after: string | null = null;
  if (value.after_key !== undefined) {
    if (!record(value.after_key) || Object.keys(value.after_key).length !== 1 ||
      typeof value.after_key.artifact !== "string" ||
      value.after_key.artifact.length < 1 || value.after_key.artifact.length > 512) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    after = value.after_key.artifact;
  }
  return Object.freeze({ after, counts: Object.freeze(counts) });
}

function decodeVariantHits(value: unknown): readonly KnowledgeBm25VariantHit[] {
  if (!record(value) || !record(value._shards) || value._shards.failed !== 0 ||
    !record(value.hits) || !Array.isArray(value.hits.hits) ||
    value.hits.hits.length > KNOWLEDGE_SEARCH_MAX_HITS_PER_VARIANT) {
    throw new OpenSearchTransportError("opensearch_response_invalid");
  }
  return Object.freeze(value.hits.hits.map((candidate, index) => {
    if (!record(candidate) || typeof candidate._id !== "string" ||
      typeof candidate._score !== "number" || !Number.isFinite(candidate._score) ||
      candidate._score < 0 || candidate._source !== undefined) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const contentHash = singleField(candidate.fields, "content_hash");
    const indexArtifactId = singleField(candidate.fields, "index_artifact_id");
    const mappingVersion = singleField(candidate.fields, "mapping_version");
    const passageId = singleField(candidate.fields, "passage_id");
    const sourceVersionId = singleField(candidate.fields, "source_version_id");
    if (!contentHash || !/^[0-9a-f]{64}$/u.test(contentHash) || !indexArtifactId ||
      mappingVersion !== String(KNOWLEDGE_SEARCH_MAPPING_VERSION) || !passageId ||
      !sourceVersionId || candidate._id !== knowledgeSearchDocumentId({
        contentHash,
        indexArtifactId,
        passageId,
        sourceVersionId
      })) throw new OpenSearchTransportError("opensearch_response_invalid");
    return Object.freeze({
      contentHash,
      indexArtifactId,
      passageId,
      rank: index + 1,
      score: candidate._score,
      sourceVersionId
    });
  }));
}

export class AiqsaOpenSearchTransport {
  readonly #core: BoundedOpenSearchCoreTransport;
  readonly #namespace: AiqsaOpenSearchNamespace;

  constructor(input: Readonly<{
    env?: NodeJS.ProcessEnv;
    namespace: AiqsaOpenSearchNamespace;
  }>) {
    this.#core = new BoundedOpenSearchCoreTransport(input);
    this.#namespace = input.namespace;
  }

  #request(input: BoundedOpenSearchRequest) {
    return this.#core.request(input);
  }

  async #validateKnowledgeIndexDefinition(): Promise<void> {
    const definition = await this.#request({
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
      method: "GET",
      path: KNOWLEDGE_SEARCH_INDEX_NAME,
      timeoutMs: HEALTH_TIMEOUT_MS
    });
    if (!record(definition.body) || !record(definition.body[KNOWLEDGE_SEARCH_INDEX_NAME]) ||
      !exactPropertyMapping(definition.body[KNOWLEDGE_SEARCH_INDEX_NAME].mappings) ||
      !exactKnowledgeIndexSettings(definition.body[KNOWLEDGE_SEARCH_INDEX_NAME].settings)) {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
  }

  /** Read-only liveness and exact-index-contract check for operation preflight
   * and the administrator health projection. */
  async checkKnowledgeIndex(): Promise<void> {
    if (this.#namespace !== "knowledge") {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
    await this.#ensureServerVersion();
    await this.#validateKnowledgeIndexDefinition();
  }

  async ensureKnowledgeIndex(): Promise<void> {
    if (this.#namespace !== "knowledge") {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
    await this.#ensureServerVersion();
    const head = await this.#request({
      acceptedStatuses: [200, 404],
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: 0,
      method: "HEAD",
      path: KNOWLEDGE_SEARCH_INDEX_NAME,
      timeoutMs: HEALTH_TIMEOUT_MS
    });
    if (head.status === 404) {
      await this.#request({
        body: JSON.stringify(KNOWLEDGE_SEARCH_INDEX_DEFINITION),
        indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
        maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
        method: "PUT",
        path: KNOWLEDGE_SEARCH_INDEX_NAME,
        timeoutMs: WRITE_TIMEOUT_MS
      });
    }
    await this.#validateKnowledgeIndexDefinition();
  }

  async #ensureServerVersion(): Promise<void> {
    await this.#core.ensureServerVersion(AIQSA_OPENSEARCH_VERSION);
  }

  /** Guarded operator boundary: only the code-owned physical Knowledge index
   * can be removed, and it is recreated and revalidated before returning. */
  async recreateKnowledgeIndex(): Promise<void> {
    if (this.#namespace !== "knowledge") {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
    await this.#ensureServerVersion();
    await this.#request({
      acceptedStatuses: [200, 404],
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
      method: "DELETE",
      path: KNOWLEDGE_SEARCH_INDEX_NAME,
      timeoutMs: WRITE_TIMEOUT_MS
    });
    await this.ensureKnowledgeIndex();
  }

  async bulkUpsertKnowledgeDocuments(
    documents: readonly KnowledgeSearchDocument[]
  ): Promise<void> {
    if (this.#namespace !== "knowledge" || documents.length < 1 ||
      documents.length > KNOWLEDGE_SEARCH_BULK_MAX_DOCUMENTS) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const lines = documents.flatMap((document) => [
      JSON.stringify({ index: { _id: knowledgeSearchDocumentId(document) } }),
      JSON.stringify({
        body: document.body,
        content_hash: document.contentHash,
        heading: document.heading,
        index_artifact_id: document.indexArtifactId,
        layout_kind: document.layoutKind,
        mapping_version: String(KNOWLEDGE_SEARCH_MAPPING_VERSION),
        owner_user_id: document.ownerUserId,
        passage_id: document.passageId,
        source_version_id: document.sourceVersionId,
        table_context: document.tableContext
      })
    ]);
    const body = `${lines.join("\n")}\n`;
    if (Buffer.byteLength(body, "utf8") > KNOWLEDGE_SEARCH_BULK_MAX_BYTES) {
      throw new OpenSearchTransportError("opensearch_response_too_large");
    }
    const response = await this.#request({
      body,
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: BULK_RESPONSE_MAX_BYTES,
      method: "POST",
      path: `${KNOWLEDGE_SEARCH_INDEX_NAME}/_bulk`,
      timeoutMs: WRITE_TIMEOUT_MS
    });
    if (!record(response.body) || response.body.errors !== false ||
      !Array.isArray(response.body.items) || response.body.items.length !== documents.length ||
      response.body.items.some((item) => !record(item) || !record(item.index) ||
        typeof item.index.status !== "number" || item.index.status < 200 ||
        item.index.status >= 300 || item.index.error !== undefined)) {
      throw new OpenSearchTransportError("opensearch_bulk_item_failed");
    }
  }

  async refreshKnowledgeIndex(): Promise<void> {
    await this.#request({
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
      method: "POST",
      path: `${KNOWLEDGE_SEARCH_INDEX_NAME}/_refresh`,
      timeoutMs: WRITE_TIMEOUT_MS
    });
  }

  async countKnowledgeArtifact(indexArtifactId: string): Promise<number> {
    const response = await this.#request({
      body: JSON.stringify({ query: { bool: { filter: [
        { term: { index_artifact_id: indexArtifactId } },
        { term: { mapping_version: String(KNOWLEDGE_SEARCH_MAPPING_VERSION) } }
      ] } } }),
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
      method: "POST",
      path: `${KNOWLEDGE_SEARCH_INDEX_NAME}/_count`,
      timeoutMs: HEALTH_TIMEOUT_MS
    });
    if (!record(response.body) || !Number.isSafeInteger(response.body.count) ||
      Number(response.body.count) < 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    return Number(response.body.count);
  }

  /** Bounded multi-artifact count used to settle an operator rebuild without
   * one refresh/count round trip per tiny canonical artifact. */
  async countKnowledgeArtifacts(
    indexArtifactIds: readonly string[]
  ): Promise<readonly KnowledgeArtifactCount[]> {
    const uniqueIds = [...new Set(indexArtifactIds)];
    if (this.#namespace !== "knowledge" || uniqueIds.length !== indexArtifactIds.length ||
      uniqueIds.length < 1 || uniqueIds.length > KNOWLEDGE_REBUILD_COUNT_MAX_ARTIFACTS ||
      uniqueIds.some((id) => id.length < 1 || id.length > 512)) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const response = await this.#request({
      body: JSON.stringify({
        aggs: {
          artifacts: {
            composite: {
              size: uniqueIds.length,
              sources: [{ artifact: { terms: { field: "index_artifact_id" } } }]
            }
          }
        },
        query: {
          bool: {
            filter: [
              { terms: { index_artifact_id: uniqueIds } },
              { term: { mapping_version: String(KNOWLEDGE_SEARCH_MAPPING_VERSION) } }
            ]
          }
        },
        size: 0,
        track_total_hits: true
      }),
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
      method: "POST",
      path: `${KNOWLEDGE_SEARCH_INDEX_NAME}/_search`,
      timeoutMs: HEALTH_TIMEOUT_MS
    });
    if (!record(response.body) || !record(response.body._shards) ||
      response.body._shards.failed !== 0 || !record(response.body.aggregations) ||
      !record(response.body.hits) || !record(response.body.hits.total) ||
      response.body.hits.total.relation !== "eq" ||
      !Number.isSafeInteger(response.body.hits.total.value) ||
      Number(response.body.hits.total.value) < 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const decoded = decodeCompositeArtifactBuckets(
      response.body.aggregations.artifacts,
      uniqueIds.length
    );
    const allowed = new Set(uniqueIds);
    if (decoded.counts.some(({ indexArtifactId }) => !allowed.has(indexArtifactId)) ||
      decoded.counts.reduce((sum, entry) => sum + entry.count, 0) !==
        Number(response.body.hits.total.value)) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    return decoded.counts;
  }

  async inspectKnowledgeIndex(): Promise<KnowledgeOpenSearchInventory> {
    if (this.#namespace !== "knowledge") {
      throw new OpenSearchTransportError("opensearch_index_incompatible");
    }
    const staleResponse = await this.#request({
      body: JSON.stringify({
        query: {
          bool: {
            must_not: [{
              term: { mapping_version: String(KNOWLEDGE_SEARCH_MAPPING_VERSION) }
            }]
          }
        }
      }),
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
      method: "POST",
      path: `${KNOWLEDGE_SEARCH_INDEX_NAME}/_count`,
      timeoutMs: HEALTH_TIMEOUT_MS
    });
    if (!record(staleResponse.body) || !record(staleResponse.body._shards) ||
      staleResponse.body._shards.failed !== 0 ||
      !Number.isSafeInteger(staleResponse.body.count) ||
      Number(staleResponse.body.count) < 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const artifactCounts: KnowledgeArtifactCount[] = [];
    let after: string | null = null;
    let currentMappingDocumentCount: number | null = null;
    const staleMappingDocumentCount = Number(staleResponse.body.count);
    const maximumPages = Math.ceil(
      KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS / KNOWLEDGE_INTEGRITY_PAGE_SIZE
    ) + 1;
    for (let page = 0; page < maximumPages; page += 1) {
      const response = await this.#request({
        body: JSON.stringify({
          aggs: {
            artifacts: {
              composite: {
                ...(after ? { after: { artifact: after } } : {}),
                size: KNOWLEDGE_INTEGRITY_PAGE_SIZE,
                sources: [{ artifact: { terms: { field: "index_artifact_id" } } }]
              }
            }
          },
          query: {
            term: { mapping_version: String(KNOWLEDGE_SEARCH_MAPPING_VERSION) }
          },
          size: 0,
          track_total_hits: true
        }),
        indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
        maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
        method: "POST",
        path: `${KNOWLEDGE_SEARCH_INDEX_NAME}/_search`,
        timeoutMs: HEALTH_TIMEOUT_MS
      });
      if (!record(response.body) || !record(response.body._shards) ||
        response.body._shards.failed !== 0 || !record(response.body.aggregations) ||
        !record(response.body.hits) || !record(response.body.hits.total) ||
        response.body.hits.total.relation !== "eq" ||
        !Number.isSafeInteger(response.body.hits.total.value) ||
        Number(response.body.hits.total.value) < 0) {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
      const currentCount = Number(response.body.hits.total.value);
      if (currentMappingDocumentCount === null) {
        currentMappingDocumentCount = currentCount;
      } else if (currentMappingDocumentCount !== currentCount) {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
      const decoded = decodeCompositeArtifactBuckets(
        response.body.aggregations.artifacts,
        KNOWLEDGE_INTEGRITY_PAGE_SIZE
      );
      artifactCounts.push(...decoded.counts);
      if (artifactCounts.length > KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS) {
        throw new OpenSearchTransportError("opensearch_scope_too_large");
      }
      if (decoded.counts.length < KNOWLEDGE_INTEGRITY_PAGE_SIZE) break;
      if (!decoded.after || decoded.after === after) {
        throw new OpenSearchTransportError("opensearch_response_invalid");
      }
      after = decoded.after;
      if (page === maximumPages - 1) {
        throw new OpenSearchTransportError("opensearch_scope_too_large");
      }
    }
    if (currentMappingDocumentCount === null ||
      new Set(artifactCounts.map(({ indexArtifactId }) => indexArtifactId)).size !==
        artifactCounts.length ||
      artifactCounts.reduce((sum, entry) => sum + entry.count, 0) !==
        currentMappingDocumentCount) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    return Object.freeze({
      artifactCounts: Object.freeze(artifactCounts),
      currentMappingDocumentCount,
      staleMappingDocumentCount
    });
  }

  async deleteKnowledgeArtifact(indexArtifactId: string): Promise<void> {
    const response = await this.#request({
      body: JSON.stringify({ query: { term: { index_artifact_id: indexArtifactId } } }),
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
      method: "POST",
      path: `${KNOWLEDGE_SEARCH_INDEX_NAME}/_delete_by_query?refresh=true&scroll_size=${
        KNOWLEDGE_SEARCH_MAX_HITS_PER_VARIANT
      }`,
      timeoutMs: WRITE_TIMEOUT_MS
    });
    if (!record(response.body) || response.body.timed_out !== false ||
      response.body.version_conflicts !== 0 ||
      !Array.isArray(response.body.failures) || response.body.failures.length !== 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const remaining = await this.#request({
      body: JSON.stringify({ query: { term: { index_artifact_id: indexArtifactId } } }),
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: SMALL_RESPONSE_MAX_BYTES,
      method: "POST",
      path: `${KNOWLEDGE_SEARCH_INDEX_NAME}/_count`,
      timeoutMs: HEALTH_TIMEOUT_MS
    });
    if (!record(remaining.body) || !record(remaining.body._shards) ||
      remaining.body._shards.failed !== 0 || remaining.body.count !== 0) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
  }

  async searchKnowledgePassages(input: Readonly<{
    indexArtifactIds: readonly string[];
    ownerUserId: string;
    queryVariants: readonly string[];
    signal?: AbortSignal;
  }>): Promise<KnowledgeOpenSearchResult> {
    if (this.#namespace !== "knowledge" || input.indexArtifactIds.length < 1 ||
      input.indexArtifactIds.length > KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS) {
      throw new OpenSearchTransportError("opensearch_scope_too_large");
    }
    const variants = [...new Set(input.queryVariants.map((query) => query.trim()))]
      .filter(Boolean);
    if (variants.length < 1 || variants.length > KNOWLEDGE_SEARCH_MAX_QUERY_VARIANTS) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    const lines = variants.flatMap((query) => [
      JSON.stringify({ index: KNOWLEDGE_SEARCH_INDEX_NAME }),
      JSON.stringify({
        _source: false,
        docvalue_fields: [
          "content_hash",
          "index_artifact_id",
          "mapping_version",
          "passage_id",
          "source_version_id"
        ],
        query: {
          bool: {
            filter: [
              { term: { owner_user_id: input.ownerUserId } },
              { terms: { index_artifact_id: input.indexArtifactIds } },
              { term: { mapping_version: String(KNOWLEDGE_SEARCH_MAPPING_VERSION) } }
            ],
            must: [{
              multi_match: {
                fields: [
                  `body^${KNOWLEDGE_SEARCH_FIELD_WEIGHTS.body}`,
                  `heading^${KNOWLEDGE_SEARCH_FIELD_WEIGHTS.heading}`,
                  `table_context^${KNOWLEDGE_SEARCH_FIELD_WEIGHTS.tableContext}`
                ],
                operator: "or",
                query,
                type: "best_fields"
              }
            }]
          }
        },
        size: KNOWLEDGE_SEARCH_MAX_HITS_PER_VARIANT,
        timeout: `${SEARCH_TIMEOUT_MS}ms`,
        track_total_hits: false
      })
    ]);
    const body = `${lines.join("\n")}\n`;
    if (Buffer.byteLength(body, "utf8") > KNOWLEDGE_SEARCH_BULK_MAX_BYTES) {
      throw new OpenSearchTransportError("opensearch_scope_too_large");
    }
    const opaqueId = `aiqsa-knowledge-${randomUUID()}`;
    const startedAt = performance.now();
    const response = await this.#request({
      body,
      indexName: KNOWLEDGE_SEARCH_INDEX_NAME,
      maximumResponseBytes: BULK_RESPONSE_MAX_BYTES,
      method: "POST",
      opaqueId,
      path: "_msearch",
      ...(input.signal ? { signal: input.signal } : {}),
      timeoutMs: SEARCH_TIMEOUT_MS
    });
    if (!record(response.body) || !Array.isArray(response.body.responses) ||
      response.body.responses.length !== variants.length) {
      throw new OpenSearchTransportError("opensearch_response_invalid");
    }
    return Object.freeze({
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      opaqueId: response.opaqueId ?? opaqueId,
      variants: Object.freeze(response.body.responses.map(decodeVariantHits))
    });
  }
}

export function createKnowledgeOpenSearchTransport(
  env: NodeJS.ProcessEnv = process.env
): AiqsaOpenSearchTransport {
  return new AiqsaOpenSearchTransport({ env, namespace: "knowledge" });
}
