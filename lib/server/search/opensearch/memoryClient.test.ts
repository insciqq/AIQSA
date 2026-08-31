import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_OPENSEARCH_ANALYZER_GOLDEN,
  MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
  MEMORY_OPENSEARCH_MAPPING_VERSION,
  MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
  MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
  memoryOpenSearchConfigurationFromEnv,
  memoryOpenSearchDocumentId,
  memoryOpenSearchIndexDefinition,
  memoryOpenSearchUserScope,
  type MemoryOpenSearchDocument
} from "./memoryContract";
import { StrictMemoryOpenSearchClient } from "./memoryClient";
import type { MemoryLexicalSearchRequest } from
  "../../memory/retrieval/lexical/contract";

const routingKey = Buffer.alloc(32, 9).toString("base64");
const env: NodeJS.ProcessEnv = {
  AIQSA_MEMORY_OPENSEARCH_ROUTING_KEY: routingKey,
  AIQSA_OPENSEARCH_URL: "http://search.example.test:9200",
  NODE_ENV: "test"
};

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...headers },
    status
  });
}

function client(): StrictMemoryOpenSearchClient {
  return new StrictMemoryOpenSearchClient(env);
}

function document(sequence = 17n): MemoryOpenSearchDocument {
  const config = memoryOpenSearchConfigurationFromEnv(env);
  return {
    analysisProfile: MEMORY_OPENSEARCH_ANALYSIS_PROFILE,
    generationId: "generation-1",
    itemType: "RECALL_ROUND",
    lexicalText: "safe normalized evidence",
    mappingVersion: MEMORY_OPENSEARCH_MAPPING_VERSION,
    normalizationVersion: MEMORY_OPENSEARCH_NORMALIZATION_VERSION,
    projectionSequence: sequence,
    retrievalPipelineVersion: MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION,
    safeContentHash: "a".repeat(64),
    searchEntryId: "entry-1",
    sourceChatId: "chat-1",
    userScope: memoryOpenSearchUserScope("user-1", config)
  };
}

function lexicalRequest(
  overrides: Partial<MemoryLexicalSearchRequest> = {}
): MemoryLexicalSearchRequest {
  return {
    activeGenerationId: "generation-1",
    analysisProfileVersion: "UNICODE_ICU_NGRAM_V1",
    candidateLimitPerVariant: 24,
    deadlineAtMs: Date.now() + 1_000,
    finalLimit: 12,
    itemFamily: "HISTORY",
    memoryRevisionSnapshot: 7,
    sourceChatIds: ["chat-1"],
    userId: "user-1",
    variants: [{
      logicalTerms: [
        { characterLength: 5, ordinal: 0, value: "cedar" },
        { characterLength: 4, ordinal: 1, value: "plan" }
      ],
      normalizedText: "cedar plan",
      ordinal: 0
    }],
    ...overrides
  };
}

function lexicalFields(searchEntryId: string, hashCharacter: string) {
  const config = memoryOpenSearchConfigurationFromEnv(env);
  return {
    analysis_profile: [MEMORY_OPENSEARCH_ANALYSIS_PROFILE],
    generation_id: ["generation-1"],
    item_type: ["RECALL_ROUND"],
    mapping_version: [MEMORY_OPENSEARCH_MAPPING_VERSION],
    normalization_version: [MEMORY_OPENSEARCH_NORMALIZATION_VERSION],
    retrieval_pipeline_version: [MEMORY_OPENSEARCH_RETRIEVAL_PIPELINE_VERSION],
    safe_content_hash: [hashCharacter.repeat(64)],
    search_entry_id: [searchEntryId],
    source_chat_id: ["chat-1"],
    user_scope: [memoryOpenSearchUserScope("user-1", config)]
  };
}

function lexicalHit(input: Readonly<{
  hashCharacter?: string;
  matchedQueries: readonly string[];
  score: number;
  searchEntryId: string;
}>) {
  const config = memoryOpenSearchConfigurationFromEnv(env);
  return {
    _id: memoryOpenSearchDocumentId(input.searchEntryId),
    _index: config.physicalIndexName,
    _routing: memoryOpenSearchUserScope("user-1", config),
    _score: input.score,
    fields: lexicalFields(input.searchEntryId, input.hashCharacter ?? "a"),
    matched_queries: input.matchedQueries
  };
}

function lexicalSubsearch(hits: readonly unknown[]) {
  return {
    _shards: { failed: 0, skipped: 0, successful: 1, total: 1 },
    hits: {
      hits,
      max_score: hits.length === 0 ? null : 1
    },
    status: 200,
    timed_out: false,
    took: 2
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("strict Memory OpenSearch client", () => {
  it("requires ICU, validates the golden analyzers, then atomically installs aliases", async () => {
    const config = memoryOpenSearchConfigurationFromEnv(env);
    const definition = memoryOpenSearchIndexDefinition(config);
    const canonicalMappings = JSON.parse(JSON.stringify(
      definition.mappings,
      (key, value) => key === "search_analyzer" ? undefined : value
    ));
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ version: { number: "3.8.0" } }))
      .mockResolvedValueOnce(jsonResponse([
        { component: "analysis-icu", version: "3.8.0.0" }
      ]))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: true }))
      .mockResolvedValueOnce(jsonResponse({
        [config.physicalIndexName]: {
          mappings: canonicalMappings,
          settings: {
            index: {
              analysis: definition.settings.analysis,
              number_of_replicas: "0",
              number_of_shards: "1"
            }
          }
        }
      }));
    for (const fixture of MEMORY_OPENSEARCH_ANALYZER_GOLDEN) {
      fetch.mockResolvedValueOnce(jsonResponse({
        tokens: fixture.expectedTokens.map((token, position) => ({ position, token }))
      }));
    }
    fetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "missing" }), {
        status: 404
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "missing" }), {
        status: 404
      }))
      .mockResolvedValueOnce(jsonResponse({ acknowledged: true }));
    vi.stubGlobal("fetch", fetch);

    await expect(client().ensureIndex()).resolves.toBeUndefined();

    expect(fetch).toHaveBeenCalledTimes(8 + MEMORY_OPENSEARCH_ANALYZER_GOLDEN.length);
    const aliasCall = fetch.mock.calls.at(-1)!;
    expect(aliasCall[0].toString()).toBe("http://search.example.test:9200/_aliases");
    expect(JSON.parse(aliasCall[1].body)).toEqual({ actions: [
      { add: { alias: config.readAlias, index: config.physicalIndexName } },
      { add: {
        alias: config.writeAlias,
        index: config.physicalIndexName,
        is_write_index: true
      } }
    ] });
  });

  it("builds a fresh physical index before atomically replacing both aliases", async () => {
    const replacementEnv: NodeJS.ProcessEnv = {
      ...env,
      AIQSA_MEMORY_OPENSEARCH_INDEX_BUILD_ID: "replacement"
    };
    const config = memoryOpenSearchConfigurationFromEnv(replacementEnv);
    const definition = memoryOpenSearchIndexDefinition(config);
    const oldIndex = "aiqsa-memory-lexical-v1-oldbuild";
    const indexResponse = () => jsonResponse({
      [config.physicalIndexName]: {
        mappings: definition.mappings,
        settings: {
          index: {
            analysis: definition.settings.analysis,
            number_of_replicas: "0",
            number_of_shards: "1"
          }
        }
      }
    });
    const aliasResponse = (alias: string, indexName: string, write: boolean) =>
      jsonResponse({
        [indexName]: {
          aliases: { [alias]: write ? { is_write_index: true } : {} }
        }
      });
    const pluginResponse = () => jsonResponse([
      { component: "analysis-icu", version: "3.8.0.0" }
    ]);
    const analyzerResponses = () => MEMORY_OPENSEARCH_ANALYZER_GOLDEN.map(
      (fixture) => jsonResponse({
        tokens: fixture.expectedTokens.map((token, position) => ({ position, token }))
      })
    );
    const responses: Response[] = [
      jsonResponse({ version: { number: "3.8.0" } }),
      pluginResponse(),
      aliasResponse(config.readAlias, oldIndex, false),
      aliasResponse(config.writeAlias, oldIndex, true),
      new Response(null, { status: 404 }),
      new Response(null, { status: 404 }),
      jsonResponse({ acknowledged: true }),
      indexResponse(),
      ...analyzerResponses(),
      jsonResponse({ version: { number: "3.8.0" } }),
      pluginResponse(),
      new Response(null, { status: 200 }),
      indexResponse(),
      ...analyzerResponses(),
      aliasResponse(config.readAlias, oldIndex, false),
      aliasResponse(config.writeAlias, oldIndex, true),
      jsonResponse({ acknowledged: true }),
      aliasResponse(config.readAlias, config.physicalIndexName, false),
      aliasResponse(config.writeAlias, config.physicalIndexName, true)
    ];
    const fetch = vi.fn(async (
      _url: RequestInfo | URL,
      _request?: RequestInit
    ) => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected_opensearch_request");
      return response;
    });
    vi.stubGlobal("fetch", fetch);
    const replacement = new StrictMemoryOpenSearchClient(replacementEnv);

    await replacement.prepareReplacementIndex();
    expect(fetch.mock.calls.some(([url, request]) =>
      url.toString().endsWith("/_aliases") && request?.method === "POST"
    )).toBe(false);

    await replacement.activateReplacementIndex();
    const switchCall = fetch.mock.calls.find(([url, request]) =>
      url.toString().endsWith("/_aliases") && request?.method === "POST"
    );
    expect(switchCall).toBeDefined();
    expect(JSON.parse(String(switchCall![1]?.body))).toEqual({ actions: [
      { remove: { alias: config.readAlias, index: oldIndex } },
      { remove: { alias: config.writeAlias, index: oldIndex } },
      { add: { alias: config.readAlias, index: config.physicalIndexName } },
      { add: {
        alias: config.writeAlias,
        index: config.physicalIndexName,
        is_write_index: true
      } }
    ] });
    expect(responses).toHaveLength(0);
  });

  it("refuses bootstrap when the required ICU plugin is absent", async () => {
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({ version: { number: "3.8.0" } }))
      .mockResolvedValueOnce(jsonResponse([
        { component: "opensearch-sql", version: "3.8.0.0" }
      ])));

    await expect(client().ensureIndex()).rejects.toMatchObject({
      code: "opensearch_index_incompatible"
    });
  });

  it("writes exact signed-64 external versions with routing and no raw owner ID", async () => {
    const sequence = 9_007_199_254_740_993n;
    const projected = document(sequence);
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      errors: false,
      items: [{
        index: {
          _id: memoryOpenSearchDocumentId(projected.searchEntryId),
          result: "created",
          status: 201
        }
      }]
    }, 200, { "x-opaque-id": "opaque-memory-1" }));
    vi.stubGlobal("fetch", fetch);

    await expect(client().applyMutations([{
      document: projected,
      operation: "UPSERT",
      routing: projected.userScope,
      sequence
    }], "WAIT_FOR")).resolves.toEqual({
      applied: 1,
      opaqueId: "opaque-memory-1",
      superseded: 0
    });

    const requestBody = String(fetch.mock.calls[0]![1].body);
    const [metadata, source] = requestBody.trim().split("\n");
    expect(metadata).toContain(`"version":${sequence}`);
    expect(metadata).not.toContain(`"version":"${sequence}"`);
    expect(JSON.parse(metadata!)).toMatchObject({
      index: {
        _id: memoryOpenSearchDocumentId(projected.searchEntryId),
        _index: "aiqsa-memory-lexical-v1-20260831a",
        routing: projected.userScope,
        version_type: "external_gte"
      }
    });
    expect(source).toContain(`"projection_sequence":${sequence}`);
    expect(requestBody).not.toContain("user-1");
    expect(fetch.mock.calls[0]![0].toString()).toContain("refresh=wait_for");
  });

  it("packs routed primary searches and reconstructs rank from named logical terms", async () => {
    const config = memoryOpenSearchConfigurationFromEnv(env);
    const fetch = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
      const opaqueId = (request?.headers as Headers).get("x-opaque-id")!;
      return jsonResponse({ took: 4, responses: [
        lexicalSubsearch([
          lexicalHit({
            matchedQueries: ["v0:t0:mU:l5"],
            score: 1,
            searchEntryId: "entry-b"
          }),
          lexicalHit({
            hashCharacter: "b",
            matchedQueries: ["v0:t1:mU:l4"],
            score: 3,
            searchEntryId: "entry-a"
          })
        ]),
        lexicalSubsearch([
          lexicalHit({
            matchedQueries: ["v0:t0:mF:l5", "v0:t1:mF:l4"],
            score: 2,
            searchEntryId: "entry-b"
          })
        ])
      ] }, 200, { "x-opaque-id": opaqueId });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await client().searchLexical({
      phase: "PRIMARY",
      request: lexicalRequest()
    });

    expect(result.candidates).toEqual([
      expect.objectContaining({
        backendScore: 2,
        matchedTermCount: 2,
        matchMode: "UNICODE",
        maximumMatchedTermLength: 5,
        rankWithinVariant: 1,
        searchEntryId: "entry-b"
      }),
      expect.objectContaining({
        backendScore: 3,
        matchedTermCount: 1,
        matchMode: "UNICODE",
        maximumMatchedTermLength: 4,
        rankWithinVariant: 2,
        searchEntryId: "entry-a"
      })
    ]);
    expect(result.opaqueId).toMatch(/^aiqsa-memory-search-/u);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url.toString()).toBe("http://search.example.test:9200/_msearch");
    expect((request!.headers as Headers).get("content-type"))
      .toBe("application/x-ndjson");
    const body = String(request!.body);
    expect(body.endsWith("\n")).toBe(true);
    const lines = body.trimEnd().split("\n").map((line) => JSON.parse(line));
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({
      index: config.readAlias,
      routing: memoryOpenSearchUserScope("user-1", config)
    });
    expect(lines[2]).toMatchObject({
      index: config.readAlias,
      routing: memoryOpenSearchUserScope("user-1", config)
    });
    expect(lines[1]._source).toBe(false);
    expect(lines[1].docvalue_fields).toEqual([
      "analysis_profile",
      "generation_id",
      "item_type",
      "mapping_version",
      "normalization_version",
      "retrieval_pipeline_version",
      "safe_content_hash",
      "search_entry_id",
      "source_chat_id",
      "user_scope"
    ]);
    expect(lines[1]).not.toHaveProperty("fields");
    expect(lines[1]).not.toHaveProperty("highlight");
    expect(JSON.stringify(lines[1])).toContain("v0:t0:mU:l5");
    expect(JSON.stringify(lines[3])).toContain("v0:t0:mF:l5");
    expect(body).not.toContain("user-1");
  });

  it("keeps transliteration and n-gram in separately named fallback searches", async () => {
    const fetch = vi.fn(async (_url: RequestInfo | URL, request?: RequestInit) => {
      const opaqueId = (request?.headers as Headers).get("x-opaque-id")!;
      return jsonResponse({ took: 4, responses: [
        lexicalSubsearch([lexicalHit({
          matchedQueries: ["v0:t0:mT:l5"],
          score: 1,
          searchEntryId: "entry-t"
        })]),
        lexicalSubsearch([lexicalHit({
          hashCharacter: "b",
          matchedQueries: ["v0:t1:mN:l4"],
          score: 2,
          searchEntryId: "entry-n"
        })])
      ] }, 200, { "x-opaque-id": opaqueId });
    });
    vi.stubGlobal("fetch", fetch);

    const result = await client().searchLexical({
      phase: "FALLBACK",
      request: lexicalRequest()
    });

    expect(result.candidates.map(({ matchMode, searchEntryId }) => ({
      matchMode,
      searchEntryId
    }))).toEqual([
      { matchMode: "TRANSLITERATED", searchEntryId: "entry-t" },
      { matchMode: "NGRAM", searchEntryId: "entry-n" }
    ]);
    const body = String(fetch.mock.calls[0]![1]!.body);
    expect(body).toContain("lexical_text.transliterated");
    expect(body).toContain("lexical_text.ngram");
    expect(body).not.toContain('"lexical_text"');
    const lines = body.trimEnd().split("\n").map((line) => JSON.parse(line));
    const transliterated = lines[1].query.bool.should[0].match[
      "lexical_text.transliterated"
    ];
    const ngram = lines[3].query.bool.should[0].match["lexical_text.ngram"];
    expect(transliterated).toMatchObject({ operator: "and" });
    expect(transliterated).not.toHaveProperty("minimum_should_match");
    expect(ngram).toMatchObject({
      minimum_should_match: "3<60%",
      operator: "or"
    });
  });

  it.each([
    {
      name: "duplicate named matches",
      responses: [
        lexicalSubsearch([lexicalHit({
          matchedQueries: ["v0:t0:mU:l5", "v0:t0:mU:l5"],
          score: 1,
          searchEntryId: "entry-1"
        })]),
        lexicalSubsearch([])
      ]
    },
    {
      name: "unknown named grammar",
      responses: [
        lexicalSubsearch([lexicalHit({
          matchedQueries: ["v0:t0:mX:l5"],
          score: 1,
          searchEntryId: "entry-1"
        })]),
        lexicalSubsearch([])
      ]
    },
    {
      name: "partial shard response",
      responses: [{
        ...lexicalSubsearch([]),
        _shards: { failed: 1, skipped: 0, successful: 0, total: 1 }
      }, lexicalSubsearch([])]
    }
  ])("rejects $name without accepting partial candidates", async ({ responses }) => {
    vi.stubGlobal("fetch", vi.fn(async (
      _url: RequestInfo | URL,
      request?: RequestInit
    ) => {
      const opaqueId = (request?.headers as Headers).get("x-opaque-id")!;
      return jsonResponse({ took: 4, responses }, 200, { "x-opaque-id": opaqueId });
    }));

    await expect(client().searchLexical({
      phase: "PRIMARY",
      request: lexicalRequest()
    })).rejects.toMatchObject({ code: "opensearch_response_invalid" });
  });

  it("accepts only a recognized newer external version conflict", async () => {
    const projected = document();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({
      errors: true,
      items: [{
        index: {
          _id: memoryOpenSearchDocumentId(projected.searchEntryId),
          error: { type: "version_conflict_engine_exception" },
          status: 409
        }
      }]
    })));
    await expect(client().applyMutations([{
      document: projected,
      operation: "UPSERT",
      routing: projected.userScope,
      sequence: projected.projectionSequence
    }], "NONE")).resolves.toMatchObject({ applied: 0, superseded: 1 });

    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(jsonResponse({
      errors: true,
      items: [{
        index: {
          _id: memoryOpenSearchDocumentId(projected.searchEntryId),
          error: { type: "mapper_parsing_exception" },
          status: 400
        }
      }]
    })));
    await expect(client().applyMutations([{
      document: projected,
      operation: "UPSERT",
      routing: projected.userScope,
      sequence: projected.projectionSequence
    }], "NONE")).rejects.toMatchObject({ code: "opensearch_bulk_item_failed" });
  });

  it("computes a bounded identity/hash inventory without accepting source text", async () => {
    const projected = document();
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse({
      _shards: { failed: 0 },
      hits: {
        hits: [{
          _id: memoryOpenSearchDocumentId(projected.searchEntryId),
          fields: {
            safe_content_hash: [projected.safeContentHash],
            search_entry_id: [projected.searchEntryId]
          },
          sort: [projected.searchEntryId]
        }],
        total: { relation: "eq", value: 1 }
      }
    }));
    vi.stubGlobal("fetch", fetch);

    const inventory = await client().inspectGeneration({
      generationId: projected.generationId,
      routing: projected.userScope,
      userScope: projected.userScope
    });
    expect(inventory).toEqual({
      documentCount: 1,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    const body = JSON.parse(fetch.mock.calls[0]![1].body);
    expect(body._source).toBe(false);
    expect(body.stored_fields).toEqual(["safe_content_hash", "search_entry_id"]);
    expect(JSON.stringify(body)).not.toContain(projected.lexicalText);
    expect(fetch.mock.calls[0]![0].toString()).toContain(
      `routing=${projected.userScope}`
    );
  });

  it("rejects duplicate document mutations before external I/O", async () => {
    const projected = document();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(client().applyMutations([{
      document: projected,
      operation: "UPSERT",
      routing: projected.userScope,
      sequence: projected.projectionSequence
    }, {
      operation: "DELETE",
      routing: projected.userScope,
      searchEntryId: projected.searchEntryId,
      sequence: projected.projectionSequence + 1n
    }], "WAIT_FOR")).rejects.toMatchObject({
      code: "opensearch_response_invalid"
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});
