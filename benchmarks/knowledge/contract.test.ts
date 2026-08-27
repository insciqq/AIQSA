import { describe, expect, it } from "vitest";
import {
  KNOWLEDGE_BENCHMARK_ACK_ENV,
  KNOWLEDGE_BENCHMARK_ACK_VALUE,
  KNOWLEDGE_BENCHMARK_APP_PORT,
  KNOWLEDGE_BENCHMARK_DOC_FORMAT_VERSION,
  KNOWLEDGE_BENCHMARK_SUMMARY_SCHEMA_VERSION,
  aggregateKnowledgeSuiteMetrics,
  assertComparableKnowledgeRuns,
  assertKnowledgeBenchmarkAck,
  assertKnowledgeBenchmarkBaseUrl,
  assertKnowledgeBenchmarkDatabaseUrl,
  assertSingleGlobalRankingProfile,
  compareKnowledgeRuns,
  decodeConvFinQaCorpus,
  decodeConvFinQaQueries,
  decodeKnowledgeBenchmarkManifest,
  decodeKnowledgeFrozenRunManifest,
  decodeKnowledgeRunSummary,
  decodeRusScifactCorpus,
  decodeRusScifactQueries,
  exactRelevantDocumentHit,
  expandRankedDocuments,
  knowledgeCorpusContentSha256,
  knowledgeDatasetFingerprint,
  knowledgeRunManifestFingerprint,
  macroKnowledgeAggregate,
  mapConcurrentOrdered,
  mrrAtK,
  ndcgAtK,
  parseJsonLines,
  parseQrelsTsv,
  percentile,
  projectDocumentRanking,
  queryEmbeddingCacheKey,
  recallAtK,
  resolveKnowledgeBenchmarkOutputDirectory,
  type KnowledgeFrozenRunManifest,
  type KnowledgeQueryOutcome,
  type KnowledgeRunSummary,
  type KnowledgeSuiteMetrics,
  normalizeRusScifactCorpusRow,
  sanitizeBenchmarkText
} from "./contract";

const hex40 = "a".repeat(40);
const hex64 = "b".repeat(64);

function manifestFixture(): Record<string, unknown> {
  return {
    formatVersion: 1,
    suites: {
      "rusbeir-rus-scifact": {
        dataset: "rus-SciFact",
        expectedCorpusDocumentCount: 2,
        expectedQueryCount: 1,
        family: "RusBEIR",
        licenseNote: "synthetic",
        querySplit: "test",
        resultLabel: "RusBEIR / rus-SciFact / test",
        sources: [{
          datasetId: "example/corpus",
          files: [{ bytes: 10, path: "corpus.jsonl", sha256: hex64 }],
          revision: hex40
        }]
      },
      "t2ragbench-convfinqa": {
        dataset: "ConvFinQA",
        expectedCorpusDocumentCount: null,
        expectedQueryCount: 2,
        family: "T2-RAGBench",
        licenseNote: "synthetic",
        querySplit: "turn_0",
        resultLabel: "T2-RAGBench / ConvFinQA / turn_0",
        sources: [{
          datasetId: "example/t2",
          files: [{ bytes: 10, path: "data/x.jsonl", sha256: hex64 }],
          revision: hex40
        }]
      }
    }
  };
}

function frozenManifestFixture(
  overrides: Partial<KnowledgeFrozenRunManifest> = {}
): KnowledgeFrozenRunManifest {
  return decodeKnowledgeFrozenRunManifest({
    candidateLimits: { final: 16, lexical: 64, vector: 64 },
    chunkingProfile: "chunk-v1",
    configLabel: "A",
    corpusContentSha256: hex64,
    datasetSources: [{ datasetId: "example/corpus", revision: hex40 }],
    docFormatVersion: KNOWLEDGE_BENCHMARK_DOC_FORMAT_VERSION,
    embeddingDimension: 1024,
    embeddingFormatterVersion: "fmt-v1",
    embeddingModelId: "embed-model",
    indexProfile: "index-v1",
    queryInstructionVersion: "qi-v1",
    querySplit: "test",
    rankingProfile: "weighted_rrf_v2:v=2:k=60",
    rerankerModelId: null,
    suiteId: "rusbeir-rus-scifact",
    tokenizerFingerprint: "tok-v1",
    ...overrides
  });
}

function metricsFixture(
  overrides: Partial<KnowledgeSuiteMetrics> = {}
): KnowledgeSuiteMetrics {
  return {
    exactRelevantHitRate: 1,
    meanCandidatesAfterRerank: 10,
    meanCandidatesBeforeRerank: 20,
    mrr10: 0.5,
    ndcg10: 0.5,
    queryCount: 2,
    recall10: 0.5,
    recall50: 0.6,
    rerankFallbackRate: 0,
    rerankMsP50: null,
    rerankMsP95: null,
    retrievalMsP50: 100,
    retrievalMsP95: 200,
    usage: {
      embedding: { costMicros: null, requests: 2, tokens: 40 },
      reranker: { costMicros: null, requests: 0, tokens: 0 }
    },
    ...overrides
  };
}

function summaryFixture(
  manifest: KnowledgeFrozenRunManifest,
  metrics: KnowledgeSuiteMetrics
): KnowledgeRunSummary {
  return {
    configLabel: manifest.configLabel,
    createdAt: "2026-08-27T00:00:00.000Z",
    datasetFingerprint: knowledgeDatasetFingerprint(manifest),
    manifest,
    manifestFingerprint: knowledgeRunManifestFingerprint(manifest),
    metrics,
    resultLabel: "synthetic",
    runId: "run-1",
    schemaVersion: KNOWLEDGE_BENCHMARK_SUMMARY_SCHEMA_VERSION
  };
}

describe("dataset manifest", () => {
  it("decodes a fully pinned manifest", () => {
    const manifest = decodeKnowledgeBenchmarkManifest(manifestFixture());
    expect(manifest.suites["rusbeir-rus-scifact"].querySplit).toBe("test");
    expect(manifest.suites["t2ragbench-convfinqa"].expectedCorpusDocumentCount)
      .toBeNull();
  });

  it("refuses PIN_ME checksum placeholders", () => {
    const fixture = manifestFixture();
    const suite = (fixture.suites as Record<string, {
      sources: { files: { sha256: string }[] }[];
    }>)["rusbeir-rus-scifact"]!;
    suite.sources[0]!.files[0]!.sha256 = "PIN_ME";
    expect(() => decodeKnowledgeBenchmarkManifest(fixture))
      .toThrow(/sha256_unpinned/u);
  });

  it("refuses unpinned revisions such as branch names", () => {
    const fixture = manifestFixture();
    const suite = (fixture.suites as Record<string, {
      sources: { revision: string }[];
    }>)["t2ragbench-convfinqa"]!;
    suite.sources[0]!.revision = "main";
    expect(() => decodeKnowledgeBenchmarkManifest(fixture))
      .toThrow(/revision_unpinned/u);
  });

  it("refuses a manifest missing one of the two suites", () => {
    const fixture = manifestFixture();
    delete (fixture.suites as Record<string, unknown>)["t2ragbench-convfinqa"];
    expect(() => decodeKnowledgeBenchmarkManifest(fixture))
      .toThrow("knowledge_benchmark_manifest_suites_invalid");
  });
});

describe("rus-SciFact normalization", () => {
  const rows = [
    { _id: "20", text: "Вторая строка корпуса.", title: "Второй документ" },
    { _id: "4", text: "Первая строка корпуса.", title: "Первый документ" }
  ];

  it("produces deterministic Markdown documents sorted by official id", () => {
    const corpus = decodeRusScifactCorpus(rows);
    expect(corpus.map(({ officialId }) => officialId)).toEqual(["20", "4"]);
    expect(corpus[1]).toMatchObject({
      fileName: "scifact-4.md",
      markdown: "# Первый документ\n\nПервая строка корпуса.\n",
      officialId: "4"
    });
    expect(decodeRusScifactCorpus([...rows].reverse())).toEqual(corpus);
  });

  it("keeps an untitled document as plain body text", () => {
    const [document] = decodeRusScifactCorpus([
      { _id: "9", text: "Только текст.", title: "" }
    ]);
    expect(document?.markdown).toBe("Только текст.\n");
  });

  it("rejects duplicate ids and hidden control characters", () => {
    expect(() => decodeRusScifactCorpus([rows[0]!, rows[0]!]))
      .toThrow("knowledge_benchmark_scifact_corpus_duplicate_id");
    expect(() => decodeRusScifactCorpus([
      { _id: "1", text: "bad\u0000text", title: "t" }
    ])).toThrow("knowledge_benchmark_scifact_corpus_row_invalid");
  });

  it("selects exactly the official test queries through qrels", () => {
    const qrels = parseQrelsTsv(
      "query-id\tcorpus-id\tscore\n1\t4\t1\n1\t20\t1\n"
    );
    const queries = decodeRusScifactQueries([
      { _id: "1", text: "Тестовый запрос." },
      { _id: "2", text: "Запрос без qrels." }
    ], qrels);
    expect(queries).toEqual([
      { officialId: "1", relevant: { "20": 1, "4": 1 }, text: "Тестовый запрос." }
    ]);
    expect(() => decodeRusScifactQueries([{ _id: "2", text: "x" }], qrels))
      .toThrow("knowledge_benchmark_scifact_query_missing");
  });

  it("rejects malformed qrels", () => {
    expect(() => parseQrelsTsv("wrong\theader\nrow"))
      .toThrow("knowledge_benchmark_qrels_invalid");
    expect(() => parseQrelsTsv("query-id\tcorpus-id\tscore\n1\t4\t0\n"))
      .toThrow("knowledge_benchmark_qrels_invalid");
  });
});

describe("ConvFinQA normalization", () => {
  const rows = [
    {
      context: "Intro text.\n| a | b |\n| --- | --- |\n| 1 | 2 |\nAfter text.",
      context_id: "ctx_2",
      id: "q_1",
      question: "What is the value of a?"
    },
    {
      context: "Intro text.\n| a | b |\n| --- | --- |\n| 1 | 2 |\nAfter text.",
      context_id: "ctx_2",
      id: "q_2",
      question: "What is the value of b?"
    },
    {
      context: "Second synthetic context.",
      context_id: "ctx_1",
      id: "q_3",
      question: "Which context is second?"
    }
  ];

  it("dedupes the corpus by official context_id only", () => {
    const corpus = decodeConvFinQaCorpus(rows);
    expect(corpus.map(({ officialId }) => officialId)).toEqual(["ctx_1", "ctx_2"]);
    expect(corpus[1]).toMatchObject({
      fileName: "convfinqa-ctx_2.md",
      markdown:
        "Intro text.\n| a | b |\n| --- | --- |\n| 1 | 2 |\nAfter text.\n"
    });
  });

  it("is deterministic across input order", () => {
    expect(decodeConvFinQaCorpus([...rows].reverse()))
      .toEqual(decodeConvFinQaCorpus(rows));
  });

  it("refuses conflicting context text under one context_id", () => {
    expect(() => decodeConvFinQaCorpus([
      rows[0]!,
      { ...rows[1]!, context: "Different text." }
    ])).toThrow("knowledge_benchmark_convfinqa_context_conflict");
  });

  it("maps every query to its official context document", () => {
    const queries = decodeConvFinQaQueries(rows);
    expect(queries).toHaveLength(3);
    expect(queries[0]).toEqual({
      officialId: "q_1",
      relevant: { ctx_2: 1 },
      text: "What is the value of a?"
    });
    expect(() => decodeConvFinQaQueries([rows[0]!, rows[0]!]))
      .toThrow("knowledge_benchmark_convfinqa_query_duplicate_id");
  });

  it("parses JSON lines and rejects broken lines", () => {
    expect(parseJsonLines('{"a":1}\n{"b":2}\n', "code")).toEqual([
      { a: 1 },
      { b: 2 }
    ]);
    expect(() => parseJsonLines("not json\n", "code")).toThrow("code");
  });
});

describe("corpus content hash", () => {
  it("is order independent and content sensitive", () => {
    const corpus = decodeConvFinQaCorpus([
      { context: "One.", context_id: "c_1", id: "q_1", question: "?" },
      { context: "Two.", context_id: "c_2", id: "q_2", question: "?" }
    ]);
    expect(knowledgeCorpusContentSha256([...corpus].reverse()))
      .toBe(knowledgeCorpusContentSha256(corpus));
    const changed = decodeConvFinQaCorpus([
      { context: "One!", context_id: "c_1", id: "q_1", question: "?" },
      { context: "Two.", context_id: "c_2", id: "q_2", question: "?" }
    ]);
    expect(knowledgeCorpusContentSha256(changed))
      .not.toBe(knowledgeCorpusContentSha256(corpus));
  });
});

describe("retrieval metrics", () => {
  it("computes nDCG@10 with the standard log2 discount", () => {
    // DCG = 1/log2(2) + 1/log2(4) = 1.5
    // IDCG = 1/log2(2) + 1/log2(3) = 1.63092975...
    expect(ndcgAtK(["d1", "d2", "d3"], { d1: 1, d3: 1 }, 10))
      .toBeCloseTo(0.9197207891481876, 12);
  });

  it("honors graded gains in DCG and ideal DCG", () => {
    // DCG = 1/log2(2) + 2/log2(3) = 2.2618595071429146
    // IDCG = 2/log2(2) + 1/log2(3) = 2.6309297535714573
    expect(ndcgAtK(["d2", "d1"], { d1: 2, d2: 1 }, 10))
      .toBeCloseTo(2.2618595071429146 / 2.6309297535714573, 12);
  });

  it("handles nDCG edge cases", () => {
    expect(ndcgAtK(["d1"], {}, 10)).toBe(0);
    expect(ndcgAtK([], { d1: 1 }, 10)).toBe(0);
    expect(ndcgAtK(["d9", "d8"], { d1: 1 }, 10)).toBe(0);
    const beyondCut = [...Array.from({ length: 10 }, (_, i) => `f${i}`), "d1"];
    expect(ndcgAtK(beyondCut, { d1: 1 }, 10)).toBe(0);
    expect(ndcgAtK(["d1"], { d1: 1 }, 10)).toBe(1);
    expect(() => ndcgAtK(["d1"], { d1: 1 }, 0))
      .toThrow("knowledge_benchmark_metric_k_invalid");
  });

  it("computes Recall@k and MRR@k", () => {
    const ranked = ["x", "d1", "y", "d2"];
    const relevant = { d1: 1, d2: 1, d3: 1 };
    expect(recallAtK(ranked, relevant, 10)).toBeCloseTo(2 / 3, 12);
    expect(recallAtK(ranked, relevant, 2)).toBeCloseTo(1 / 3, 12);
    expect(recallAtK(ranked, {}, 50)).toBe(0);
    expect(mrrAtK(ranked, relevant, 10)).toBe(1 / 2);
    expect(mrrAtK(["a", "b"], relevant, 10)).toBe(0);
  });

  it("requires every relevant document for an exact hit", () => {
    expect(exactRelevantDocumentHit(["d1", "x", "d2"], { d1: 1, d2: 1 }))
      .toBe(true);
    expect(exactRelevantDocumentHit(["d1"], { d1: 1, d2: 1 })).toBe(false);
    expect(exactRelevantDocumentHit(["d1"], {})).toBe(false);
  });

  it("uses nearest-rank percentiles", () => {
    expect(percentile([40, 10, 30, 20], 50)).toBe(20);
    expect(percentile([40, 10, 30, 20], 95)).toBe(40);
    expect(percentile([7], 50)).toBe(7);
    expect(() => percentile([], 50))
      .toThrow("knowledge_benchmark_percentile_invalid");
  });

  it("aggregates per-suite metrics from query outcomes", () => {
    const usage = { costMicros: null, requests: 1, tokens: 10 };
    const outcomes: KnowledgeQueryOutcome[] = [
      {
        candidatesAfterRerank: 10,
        candidatesBeforeRerank: 30,
        embeddingUsage: usage,
        queryId: "q1",
        rankedDocumentIds: ["d1"],
        relevant: { d1: 1 },
        rerankApplied: false,
        rerankFallback: false,
        rerankMs: null,
        rerankerUsage: { costMicros: null, requests: 0, tokens: 0 },
        retrievalMs: 100
      },
      {
        candidatesAfterRerank: 20,
        candidatesBeforeRerank: 50,
        embeddingUsage: { costMicros: 5, requests: 1, tokens: 30 },
        queryId: "q2",
        rankedDocumentIds: ["x"],
        relevant: { d2: 1 },
        rerankApplied: false,
        rerankFallback: true,
        rerankMs: null,
        rerankerUsage: { costMicros: null, requests: 0, tokens: 0 },
        retrievalMs: 300
      }
    ];
    const metrics = aggregateKnowledgeSuiteMetrics(outcomes);
    expect(metrics).toMatchObject({
      exactRelevantHitRate: 0.5,
      meanCandidatesAfterRerank: 15,
      meanCandidatesBeforeRerank: 40,
      mrr10: 0.5,
      ndcg10: 0.5,
      queryCount: 2,
      recall10: 0.5,
      recall50: 0.5,
      rerankFallbackRate: 0.5,
      rerankMsP50: null,
      retrievalMsP50: 100,
      retrievalMsP95: 300
    });
    expect(metrics.usage.embedding).toEqual({
      costMicros: 5,
      requests: 2,
      tokens: 40
    });
    expect(() => aggregateKnowledgeSuiteMetrics([outcomes[0]!, outcomes[0]!]))
      .toThrow("knowledge_benchmark_query_outcomes_duplicate");
    expect(() => aggregateKnowledgeSuiteMetrics([]))
      .toThrow("knowledge_benchmark_no_query_outcomes");
  });

  it("macro-aggregates two suites as an unweighted mean", () => {
    const macro = macroKnowledgeAggregate([
      metricsFixture({ ndcg10: 0.4, recall50: 0.5 }),
      metricsFixture({ ndcg10: 0.8, recall50: 0.7 })
    ]);
    expect(macro.ndcg10).toBeCloseTo(0.6, 12);
    expect(macro.recall50).toBeCloseTo(0.6, 12);
    expect(macro.usage.embedding.tokens).toBe(80);
    expect(() => macroKnowledgeAggregate([metricsFixture()]))
      .toThrow("knowledge_benchmark_macro_requires_two_suites");
  });
});

describe("document-level ranking projection", () => {
  it("keeps the best passage per document with deterministic tie-breaks", () => {
    expect(projectDocumentRanking([
      { documentId: "docB", passageId: "p1", score: 0.9 },
      { documentId: "docA", passageId: "p2", score: 0.9 },
      { documentId: "docB", passageId: "p3", score: 0.2 },
      { documentId: "docC", passageId: "p4", score: 0.95 }
    ])).toEqual(["docC", "docA", "docB"]);
    expect(() => projectDocumentRanking([
      { documentId: "d", passageId: "p", score: Number.NaN }
    ])).toThrow("knowledge_benchmark_passage_score_invalid");
  });

  it("expands reused sources to their sorted official ids exactly once", () => {
    expect(expandRankedDocuments(["s2", "s1"], {
      s1: ["10"],
      s2: ["7", "3"]
    })).toEqual(["3", "7", "10"]);
    expect(() => expandRankedDocuments(["s3"], {}))
      .toThrow("knowledge_benchmark_source_mapping_missing");
    expect(() => expandRankedDocuments(["s1", "s2"], {
      s1: ["1"],
      s2: ["1"]
    })).toThrow("knowledge_benchmark_source_mapping_duplicate");
  });
});

describe("frozen manifest and comparison guard", () => {
  it("keeps the dataset fingerprint independent of the configuration", () => {
    const baseline = frozenManifestFixture();
    const candidate = frozenManifestFixture({
      chunkingProfile: "chunk-v2",
      configLabel: "C",
      rerankerModelId: "reranker-model"
    });
    expect(knowledgeDatasetFingerprint(baseline))
      .toBe(knowledgeDatasetFingerprint(candidate));
    expect(knowledgeRunManifestFingerprint(baseline))
      .not.toBe(knowledgeRunManifestFingerprint(candidate));
    expect(() => assertComparableKnowledgeRuns(baseline, candidate))
      .not.toThrow();
  });

  it("refuses comparing runs from different frozen datasets", () => {
    const baseline = frozenManifestFixture();
    const otherCorpus = frozenManifestFixture({
      configLabel: "C",
      corpusContentSha256: "c".repeat(64)
    });
    expect(() => assertComparableKnowledgeRuns(baseline, otherCorpus))
      .toThrow("knowledge_benchmark_runs_not_comparable");
    expect(() => assertComparableKnowledgeRuns(baseline, frozenManifestFixture()))
      .toThrow("knowledge_benchmark_runs_same_config");
    expect(() => assertComparableKnowledgeRuns(
      baseline,
      frozenManifestFixture({ rankingProfile: "other" })
    )).toThrow("knowledge_benchmark_config_label_ambiguous");
  });

  it("requires one global ranking profile across the two suites", () => {
    const left = frozenManifestFixture();
    const right = frozenManifestFixture({
      corpusContentSha256: "d".repeat(64),
      querySplit: "turn_0",
      suiteId: "t2ragbench-convfinqa"
    });
    expect(() => assertSingleGlobalRankingProfile(left, right)).not.toThrow();
    expect(() => assertSingleGlobalRankingProfile(left, left))
      .toThrow("knowledge_benchmark_macro_same_suite");
    expect(() => assertSingleGlobalRankingProfile(
      left,
      frozenManifestFixture({
        rankingProfile: "tuned-for-one-dataset",
        suiteId: "t2ragbench-convfinqa"
      })
    )).toThrow("knowledge_benchmark_ranking_profile_not_global");
  });

  it("round-trips a run summary and refuses tampered fingerprints", () => {
    const manifest = frozenManifestFixture();
    const summary = summaryFixture(manifest, metricsFixture());
    const decoded = decodeKnowledgeRunSummary(
      JSON.parse(JSON.stringify(summary)) as unknown
    );
    expect(decoded.manifestFingerprint).toBe(summary.manifestFingerprint);
    const tampered = JSON.parse(JSON.stringify(summary)) as {
      datasetFingerprint: string;
    };
    tampered.datasetFingerprint = "e".repeat(64);
    expect(() => decodeKnowledgeRunSummary(tampered))
      .toThrow("knowledge_benchmark_summary_fingerprint_mismatch");
  });

  it("compares baseline and candidate configs with §14.1 gate arithmetic", () => {
    const scifactBaseline = frozenManifestFixture();
    const convfinqaBaseline = frozenManifestFixture({
      corpusContentSha256: "d".repeat(64),
      querySplit: "turn_0",
      suiteId: "t2ragbench-convfinqa"
    });
    const candidateConfig: Partial<KnowledgeFrozenRunManifest> = {
      configLabel: "C",
      rerankerModelId: "reranker-model"
    };
    const comparison = compareKnowledgeRuns(
      [
        summaryFixture(scifactBaseline, metricsFixture({ ndcg10: 0.5, recall50: 0.6 })),
        summaryFixture(convfinqaBaseline, metricsFixture({ ndcg10: 0.7, recall50: 0.8 }))
      ],
      [
        summaryFixture(
          frozenManifestFixture(candidateConfig),
          metricsFixture({ ndcg10: 0.56, recall50: 0.595 })
        ),
        summaryFixture(
          frozenManifestFixture({
            ...candidateConfig,
            corpusContentSha256: "d".repeat(64),
            querySplit: "turn_0",
            suiteId: "t2ragbench-convfinqa"
          }),
          metricsFixture({ ndcg10: 0.72, recall50: 0.81 })
        )
      ]
    );
    expect(comparison.baselineConfig).toBe("A");
    expect(comparison.candidateConfig).toBe("C");
    expect(comparison.macro?.baselineNdcg10).toBeCloseTo(0.6, 12);
    expect(comparison.macro?.candidateNdcg10).toBeCloseTo(0.64, 12);
    expect(comparison.macro?.relativeDelta).toBeCloseTo(0.0666666, 5);
    expect(comparison.gate).toEqual({
      macroNdcg10ImprovedAtLeast5PercentRelative: true,
      noSuiteNdcg10RegressionOver1Pp: true,
      noSuiteRecall50RegressionOver1Pp: true
    });
    const scifact = comparison.suites.find(
      ({ suiteId }) => suiteId === "rusbeir-rus-scifact"
    );
    expect(scifact?.deltaPp.ndcg10).toBeCloseTo(6, 10);
    expect(scifact?.deltaPp.recall50).toBeCloseTo(-0.5, 10);
    expect(scifact?.recall50RegressionWithinBound).toBe(true);
  });

  it("flags a candidate that breaches the per-suite regression bounds", () => {
    const baseline = summaryFixture(
      frozenManifestFixture(),
      metricsFixture({ ndcg10: 0.5, recall50: 0.6 })
    );
    const candidate = summaryFixture(
      frozenManifestFixture({ configLabel: "B" }),
      metricsFixture({ ndcg10: 0.48, recall50: 0.58 })
    );
    const comparison = compareKnowledgeRuns([baseline], [candidate]);
    expect(comparison.macro).toBeNull();
    expect(comparison.gate.macroNdcg10ImprovedAtLeast5PercentRelative).toBeNull();
    expect(comparison.gate.noSuiteNdcg10RegressionOver1Pp).toBe(false);
    expect(comparison.gate.noSuiteRecall50RegressionOver1Pp).toBe(false);
  });

  it("refuses mixed or duplicate comparison inputs", () => {
    const a = summaryFixture(frozenManifestFixture(), metricsFixture());
    const b = summaryFixture(
      frozenManifestFixture({ configLabel: "B" }),
      metricsFixture()
    );
    expect(() => compareKnowledgeRuns([], [b]))
      .toThrow("knowledge_benchmark_comparison_empty");
    expect(() => compareKnowledgeRuns([a, b], [b]))
      .toThrow("knowledge_benchmark_comparison_mixed_config");
    expect(() => compareKnowledgeRuns([a, a], [b]))
      .toThrow("knowledge_benchmark_comparison_duplicate_suite");
  });
});

describe("caching keys", () => {
  it("never places query text into the key and stays stable", () => {
    const manifest = frozenManifestFixture();
    const key = queryEmbeddingCacheKey(manifest, "Тайный текст запроса?");
    expect(key).toMatch(/^[0-9a-f]{64}$/u);
    expect(key).toBe(queryEmbeddingCacheKey(manifest, "Тайный текст запроса?"));
    expect(key).not.toBe(queryEmbeddingCacheKey(manifest, "Другой запрос"));
    expect(key).not.toBe(queryEmbeddingCacheKey(
      frozenManifestFixture({ queryInstructionVersion: "qi-v2" }),
      "Тайный текст запроса?"
    ));
    // The configuration label and candidate limits do not fragment the cache.
    expect(key).toBe(queryEmbeddingCacheKey(
      frozenManifestFixture({ configLabel: "C" }),
      "Тайный текст запроса?"
    ));
  });
});

describe("runner utilities", () => {
  it("preserves order under bounded concurrency and fails closed", async () => {
    const seen: number[] = [];
    const result = await mapConcurrentOrdered([3, 1, 2], 2, async (item) => {
      seen.push(item);
      return item * 10;
    });
    expect(result).toEqual([30, 10, 20]);
    expect(seen).toHaveLength(3);
    await expect(mapConcurrentOrdered([1], 99, async () => 1))
      .rejects.toThrow("knowledge_benchmark_concurrency_invalid");
    await expect(mapConcurrentOrdered([1, 2], 1, async (item) => {
      if (item === 2) throw new Error("boom");
      return item;
    })).rejects.toThrow("boom");
  });

  it("requires the explicit paid acknowledgement", () => {
    expect(() => assertKnowledgeBenchmarkAck({}))
      .toThrow("knowledge_benchmark_ack_required");
    expect(() => assertKnowledgeBenchmarkAck({
      [KNOWLEDGE_BENCHMARK_ACK_ENV]: "yes"
    })).toThrow("knowledge_benchmark_ack_required");
    expect(() => assertKnowledgeBenchmarkAck({
      [KNOWLEDGE_BENCHMARK_ACK_ENV]: KNOWLEDGE_BENCHMARK_ACK_VALUE
    })).not.toThrow();
  });

  it("only accepts the isolated loopback app URL", () => {
    expect(assertKnowledgeBenchmarkBaseUrl(
      `http://127.0.0.1:${KNOWLEDGE_BENCHMARK_APP_PORT}/`,
      KNOWLEDGE_BENCHMARK_APP_PORT
    ).port).toBe("3147");
    expect(() => assertKnowledgeBenchmarkBaseUrl("http://127.0.0.1:3000/", 3000))
      .toThrow("knowledge_benchmark_base_url_not_isolated");
    expect(() => assertKnowledgeBenchmarkBaseUrl(
      "http://example.com:3147/",
      KNOWLEDGE_BENCHMARK_APP_PORT
    )).toThrow("knowledge_benchmark_base_url_not_isolated");
  });

  it("only accepts the isolated benchmark database identities", () => {
    const loopback = "postgresql://aiqsa_benchmark:aiqsa-knowledge-benchmark-" +
      "dev-password@127.0.0.1:55447/aiqsa_knowledge_benchmark?schema=public";
    expect(assertKnowledgeBenchmarkDatabaseUrl(loopback).port).toBe("55447");
    const container = "postgresql://aiqsa_benchmark:aiqsa-knowledge-benchmark-" +
      "dev-password@postgres:5432/aiqsa_knowledge_benchmark?schema=public";
    expect(() => assertKnowledgeBenchmarkDatabaseUrl(container))
      .toThrow("knowledge_benchmark_database_url_not_isolated");
    expect(assertKnowledgeBenchmarkDatabaseUrl(container, {
      allowContainerHost: true
    }).hostname).toBe("postgres");
    expect(() => assertKnowledgeBenchmarkDatabaseUrl(
      "postgresql://aiqsa_dev:aiqsa-knowledge-benchmark-dev-password" +
        "@127.0.0.1:55447/aiqsa_dev?schema=public"
    )).toThrow("knowledge_benchmark_database_url_not_isolated");
  });

  it("confines run outputs to the ignored results directory", () => {
    expect(resolveKnowledgeBenchmarkOutputDirectory("/tmp/bench", "results/run-1"))
      .toBe("/tmp/bench/results/run-1");
    expect(() => resolveKnowledgeBenchmarkOutputDirectory("/tmp/bench", "results"))
      .toThrow("knowledge_benchmark_output_directory_not_isolated");
    expect(() => resolveKnowledgeBenchmarkOutputDirectory("/tmp/bench", "../x"))
      .toThrow("knowledge_benchmark_output_directory_not_isolated");
  });
});

describe("sanitizeBenchmarkText", () => {
  it("replaces U+FFFD replacement characters with spaces", () => {
    expect(sanitizeBenchmarkText("a�b")).toBe("a b");
    expect(sanitizeBenchmarkText("clean")).toBe("clean");
  });

  it("keeps scifact documents with mojibake ingestable", () => {
    const document = normalizeRusScifactCorpusRow({
      _id: "11616424",
      text: "body � text",
      title: "title � 1996"
    });
    expect(document.markdown.includes("�")).toBe(false);
  });
});
