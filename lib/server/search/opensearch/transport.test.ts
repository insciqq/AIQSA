import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_SEARCH_BULK_MAX_BYTES,
  KNOWLEDGE_SEARCH_INDEX_DEFINITION,
  KNOWLEDGE_SEARCH_INDEX_NAME,
  KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS,
  KNOWLEDGE_SEARCH_QUERY_MAX_BYTES
} from "./contract";
import {
  AiqsaOpenSearchTransport,
  OpenSearchTransportError
} from "./transport";

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status
  });
}

function transport(): AiqsaOpenSearchTransport {
  return new AiqsaOpenSearchTransport({
    env: {
      AIQSA_OPENSEARCH_URL: "http://search.example.test:9200",
      NODE_ENV: "test"
    },
    namespace: "knowledge"
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("AIQSA OpenSearch transport", () => {
  it("creates and validates the exact versioned Knowledge index", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ version: { number: "3.8.0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: true }))
      .mockResolvedValueOnce(jsonResponse({
        [KNOWLEDGE_SEARCH_INDEX_NAME]: {
          mappings: KNOWLEDGE_SEARCH_INDEX_DEFINITION.mappings,
          settings: {
            index: {
              max_terms_count: String(KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS),
              number_of_replicas: "0",
              number_of_shards: "1",
              similarity: { default: { b: "0.75", k1: "1.2", type: "BM25" } }
            }
          }
        }
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(transport().ensureKnowledgeIndex()).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch.mock.calls[2]![0].toString()).toBe(
      `http://search.example.test:9200/${KNOWLEDGE_SEARCH_INDEX_NAME}`
    );
    expect(JSON.parse(fetch.mock.calls[2]![1].body)).toEqual(
      KNOWLEDGE_SEARCH_INDEX_DEFINITION
    );
  });

  it("rejects an existing index with incompatible scoring settings", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ version: { number: "3.8.0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        [KNOWLEDGE_SEARCH_INDEX_NAME]: {
          mappings: KNOWLEDGE_SEARCH_INDEX_DEFINITION.mappings,
          settings: {
            index: {
              max_terms_count: String(KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS),
              number_of_replicas: "0",
              number_of_shards: "1",
              similarity: { default: { b: "0.9", k1: "1.2", type: "BM25" } }
            }
          }
        }
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(transport().ensureKnowledgeIndex()).rejects.toMatchObject({
      code: "opensearch_index_incompatible"
    });
  });

  it("raises an existing index from the default terms-query ceiling", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ version: { number: "3.8.0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }))
      .mockResolvedValueOnce(jsonResponse({
        [KNOWLEDGE_SEARCH_INDEX_NAME]: {
          mappings: KNOWLEDGE_SEARCH_INDEX_DEFINITION.mappings,
          settings: {
            index: {
              max_terms_count: "65536",
              number_of_replicas: "0",
              number_of_shards: "1",
              similarity: { default: { b: "0.75", k1: "1.2", type: "BM25" } }
            }
          }
        }
      }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: true }))
      .mockResolvedValueOnce(jsonResponse({
        [KNOWLEDGE_SEARCH_INDEX_NAME]: {
          mappings: KNOWLEDGE_SEARCH_INDEX_DEFINITION.mappings,
          settings: {
            index: {
              max_terms_count: String(KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS),
              number_of_replicas: "0",
              number_of_shards: "1",
              similarity: { default: { b: "0.75", k1: "1.2", type: "BM25" } }
            }
          }
        }
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(transport().ensureKnowledgeIndex()).resolves.toBeUndefined();

    expect(fetch.mock.calls[3]![0].toString()).toBe(
      `http://search.example.test:9200/${KNOWLEDGE_SEARCH_INDEX_NAME}/_settings`
    );
    expect(JSON.parse(fetch.mock.calls[3]![1].body)).toEqual({
      index: { max_terms_count: KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS }
    });
  });

  it("recreates only the code-owned physical Knowledge index", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ version: { number: "3.8.0" } }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: true }))
      .mockResolvedValueOnce(jsonResponse({ version: { number: "3.8.0" } }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: true }))
      .mockResolvedValueOnce(jsonResponse({
        [KNOWLEDGE_SEARCH_INDEX_NAME]: {
          mappings: KNOWLEDGE_SEARCH_INDEX_DEFINITION.mappings,
          settings: {
            index: {
              max_terms_count: String(KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS),
              number_of_replicas: "0",
              number_of_shards: "1",
              similarity: { default: { b: "0.75", k1: "1.2", type: "BM25" } }
            }
          }
        }
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(transport().recreateKnowledgeIndex()).resolves.toBeUndefined();

    expect(fetch.mock.calls[1]![0].toString()).toBe(
      `http://search.example.test:9200/${KNOWLEDGE_SEARCH_INDEX_NAME}`
    );
    expect(fetch.mock.calls[1]![1].method).toBe("DELETE");
  });

  it("returns a bounded content-free inventory for integrity checks", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ _shards: { failed: 0 }, count: 0 }))
      .mockResolvedValueOnce(jsonResponse({
        _shards: { failed: 0 },
        aggregations: {
          artifacts: {
            buckets: [
              { doc_count: 2, key: { artifact: "hierarchy-1" } },
              { doc_count: 1, key: { artifact: "hierarchy-orphan" } }
            ]
          }
        },
        hits: { total: { relation: "eq", value: 3 } }
      })));

    await expect(transport().inspectKnowledgeIndex()).resolves.toEqual({
      artifactCounts: [
        { count: 2, indexArtifactId: "hierarchy-1" },
        { count: 1, indexArtifactId: "hierarchy-orphan" }
      ],
      currentMappingDocumentCount: 3,
      staleMappingDocumentCount: 0
    });
  });

  it("paginates content-free inventory beyond one thousand artifacts", async () => {
    const firstPage = Array.from({ length: 1_000 }, (_, index) => ({
      doc_count: 1,
      key: { artifact: `hierarchy-${String(index).padStart(4, "0")}` }
    }));
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ _shards: { failed: 0 }, count: 0 }))
      .mockResolvedValueOnce(jsonResponse({
        _shards: { failed: 0 },
        aggregations: {
          artifacts: {
            after_key: { artifact: "hierarchy-0999" },
            buckets: firstPage
          }
        },
        hits: { total: { relation: "eq", value: 1_001 } }
      }))
      .mockResolvedValueOnce(jsonResponse({
        _shards: { failed: 0 },
        aggregations: {
          artifacts: {
            buckets: [{ doc_count: 1, key: { artifact: "hierarchy-1000" } }]
          }
        },
        hits: { total: { relation: "eq", value: 1_001 } }
      }));
    vi.stubGlobal("fetch", fetch);

    const result = await transport().inspectKnowledgeIndex();

    expect(result.artifactCounts).toHaveLength(1_001);
    expect(result.currentMappingDocumentCount).toBe(1_001);
    expect(JSON.parse(fetch.mock.calls[2]![1].body))
      .toHaveProperty(
        "aggs.artifacts.composite.after.artifact",
        "hierarchy-0999"
      );
  });

  it("counts a bounded artifact batch with mapping filters", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      _shards: { failed: 0 },
      aggregations: {
        artifacts: {
          buckets: [{ doc_count: 3, key: { artifact: "hierarchy-1" } }]
        }
      },
      hits: { total: { relation: "eq", value: 3 } }
    }));
    vi.stubGlobal("fetch", fetch);

    await expect(transport().countKnowledgeArtifacts([
      "hierarchy-1",
      "hierarchy-empty"
    ])).resolves.toEqual([{ count: 3, indexArtifactId: "hierarchy-1" }]);

    expect(JSON.parse(fetch.mock.calls[0]![1].body))
      .toHaveProperty("query.bool.filter", [
        { terms: { index_artifact_id: ["hierarchy-1", "hierarchy-empty"] } },
        { term: { mapping_version: "1" } }
      ]);
    expect(JSON.parse(fetch.mock.calls[0]![1].body))
      .toHaveProperty("track_total_hits", true);
  });

  it("deletes an artifact only after proving that no projected document remains", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        failures: [],
        timed_out: false,
        version_conflicts: 0
      }))
      .mockResolvedValueOnce(jsonResponse({
        _shards: { failed: 0 },
        count: 0
      }));
    vi.stubGlobal("fetch", fetch);

    await expect(transport().deleteKnowledgeArtifact("hierarchy-1"))
      .resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[0]![0].toString()).toBe(
      `http://search.example.test:9200/${KNOWLEDGE_SEARCH_INDEX_NAME}/_delete_by_query?refresh=true`
    );
    expect(fetch.mock.calls[1]![0].toString()).toBe(
      `http://search.example.test:9200/${KNOWLEDGE_SEARCH_INDEX_NAME}/_count`
    );
  });

  it("keeps artifact deletion retryable when the postcondition is not empty", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        failures: [],
        timed_out: false,
        version_conflicts: 0
      }))
      .mockResolvedValueOnce(jsonResponse({
        _shards: { failed: 0 },
        count: 1
      })));

    await expect(transport().deleteKnowledgeArtifact("hierarchy-1"))
      .rejects.toMatchObject({ code: "opensearch_response_invalid" });
  });

  it("applies owner, artifact, and mapping filters before top-k and returns identity only", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      responses: [{
        _shards: { failed: 0 },
        hits: {
          hits: [{
            _id: "hierarchy-1:passage-1",
            _score: 2.5,
            fields: {
              content_hash: ["a".repeat(64)],
              index_artifact_id: ["hierarchy-1"],
              mapping_version: ["1"],
              passage_id: ["passage-1"],
              source_version_id: ["source-version-1"]
            }
          }]
        }
      }]
    }, 200, { "x-opaque-id": "opaque-1" }));
    vi.stubGlobal("fetch", fetch);

    const result = await transport().searchKnowledgePassages({
      indexArtifactIds: ["hierarchy-1"],
      ownerUserId: "owner-1",
      queryVariants: ["annual revenue"]
    });

    expect(result).toMatchObject({
      opaqueId: "opaque-1",
      variants: [[{
        contentHash: "a".repeat(64),
        indexArtifactId: "hierarchy-1",
        passageId: "passage-1",
        rank: 1,
        score: 2.5,
        sourceVersionId: "source-version-1"
      }]]
    });
    expect(JSON.stringify(result)).not.toContain("annual revenue");
    const lines = fetch.mock.calls[0]![1].body.trim().split("\n");
    const query = JSON.parse(lines[1]);
    expect(query.size).toBe(64);
    expect(query.timeout).toBe("10000ms");
    expect(query.query.bool.filter).toEqual([
      { term: { owner_user_id: "owner-1" } },
      { terms: { index_artifact_id: ["hierarchy-1"] } },
      { term: { mapping_version: "1" } }
    ]);
    expect(query._source).toBe(false);
    expect(query.docvalue_fields).toEqual([
      "content_hash",
      "index_artifact_id",
      "mapping_version",
      "passage_id",
      "source_version_id"
    ]);
    expect(query).not.toHaveProperty("fields");
  });

  it("accepts one 120,000-artifact search even when two variants exceed the bulk cap", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      responses: [
        { _shards: { failed: 0 }, hits: { hits: [] } },
        { _shards: { failed: 0 }, hits: { hits: [] } }
      ]
    }));
    vi.stubGlobal("fetch", fetch);
    const indexArtifactIds = Array.from(
      { length: KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS },
      (_, index) => `artifact-${String(index).padStart(35, "0")}`
    );

    await expect(transport().searchKnowledgePassages({
      indexArtifactIds,
      ownerUserId: "owner-1",
      queryVariants: ["first query", "second query"]
    })).resolves.toMatchObject({ variants: [[], []] });

    const body = String(fetch.mock.calls[0]![1].body);
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(
      KNOWLEDGE_SEARCH_BULK_MAX_BYTES
    );
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(
      KNOWLEDGE_SEARCH_QUERY_MAX_BYTES
    );
    expect(body).toContain(indexArtifactIds.at(-1));
  });

  it("rejects a search above the 120,000-artifact scope before dispatch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(transport().searchKnowledgePassages({
      indexArtifactIds: new Array(KNOWLEDGE_SEARCH_MAX_ARTIFACT_IDS + 1).fill("artifact"),
      ownerUserId: "owner-1",
      queryVariants: ["query"]
    })).rejects.toMatchObject({ code: "opensearch_scope_too_large" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects partial shard results and never returns them as a degraded candidate set", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({
      responses: [{ _shards: { failed: 1 }, hits: { hits: [] } }]
    })));

    await expect(transport().searchKnowledgePassages({
      indexArtifactIds: ["hierarchy-1"],
      ownerUserId: "owner-1",
      queryVariants: ["query"]
    })).rejects.toBeInstanceOf(OpenSearchTransportError);
  });
});
