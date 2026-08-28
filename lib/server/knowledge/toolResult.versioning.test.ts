import { describe, expect, it } from "vitest";
import type { ToolExecutionResult } from "../tools/types";
import {
  KNOWLEDGE_LEGACY_RESULT_VERSION,
  KNOWLEDGE_RESULT_VERSION,
  type KnowledgeRetrievalEvidence,
  type KnowledgeRetrievedPassageEvidence
} from "./retrievalTypes";
import {
  compactKnowledgeToolExecutionResult,
  decodeKnowledgeRetrievalEvidence,
  knowledgeToolResultContent,
  knowledgeToolResultText,
  rehydratePersistedKnowledgeToolExecutionResult
} from "./toolResult";
import {
  createKnowledgeTableDocumentContext,
  knowledgeTableRowId
} from "./documentContext";
import { KNOWLEDGE_SIGNAL_RANK_MAX } from "./retrievalRanking";

const vectorSpaceFingerprint = "a".repeat(64);

function passage(): KnowledgeRetrievedPassageEvidence {
  const includedText = "Verified passage";
  return {
    annRank: 1,
    baseName: "Base",
    bindingOrdinal: 0,
    chunkId: "private-chunk-id",
    chunkIndex: 0,
    documentId: "private-document-id",
    documentVersionId: "private-document-version-id",
    documentVersionNumber: 3,
    fileName: "source.txt",
    ftsRank: 1,
    ftsScore: 0.5,
    fusedScore: 2 / 61,
    handle: "K1",
    includedText,
    includedTextBytes: Buffer.byteLength(includedText, "utf8"),
    knowledgeBaseId: "private-base-id",
    page: 1,
    sourceAlias: "S1",
    sourceArtifactId: "private-source-artifact-id",
    sourceName: "Source label",
    sourceTextBytes: Buffer.byteLength(includedText, "utf8"),
    textTruncated: false,
    vectorDistance: 0.1,
    vectorScore: 0.9
  };
}

function currentEvidence(
  overrides: Partial<KnowledgeRetrievalEvidence> = {}
): KnowledgeRetrievalEvidence {
  const draft: KnowledgeRetrievalEvidence = {
    bases: [{
      baseContentRevision: 1,
      baseName: "Base",
      candidateCount: 1,
      indexedContentRevision: 1,
      indexGenerationId: "private-generation-id",
      knowledgeBaseId: "private-base-id",
      ordinal: 0,
      state: "ready",
      targetDimension: 1024,
      vectorSpaceFingerprint
    }],
    candidateCount: 1,
    candidateLimit: 40,
    durationMs: 3,
    embeddingExecutions: [{
      bindingOrdinals: [0],
      durationMs: 1,
      inputTokens: 1,
      modelId: "embedding-v1",
      provider: "test",
      providerModelId: "embedding-deployment-1",
      requestId: null,
      status: "complete",
      totalTokens: 1
    }],
    fusion: "rrf_k60",
    invocationOrdinal: 1,
    outcome: "complete",
    providerText: "pending",
    query: "Question",
    resultLimit: 8,
    results: [passage()],
    scopeAliases: [{ alias: "S1", kind: "source", label: "Source label" }],
    version: KNOWLEDGE_RESULT_VERSION,
    ...overrides
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function legacyEvidence(): KnowledgeRetrievalEvidence {
  const current = currentEvidence();
  const legacyPassages = current.results.map((entry) => {
    const {
      sourceAlias: _sourceAlias,
      sourceArtifactId: _sourceArtifactId,
      sourceName: _sourceName,
      ...legacy
    } = entry;
    return { ...legacy, handle: "K1.1" };
  });
  const draft: KnowledgeRetrievalEvidence = {
    ...current,
    postRerankOrder: null,
    preRerankOrder: null,
    providerText: "pending",
    rerankerBinding: null,
    results: legacyPassages,
    scopeAliases: undefined,
    threshold: 0.01,
    version: KNOWLEDGE_LEGACY_RESULT_VERSION
  };
  return { ...draft, providerText: knowledgeToolResultText(draft) };
}

function executionResult(evidence: KnowledgeRetrievalEvidence): ToolExecutionResult {
  return {
    callId: "call-1",
    content: knowledgeToolResultContent(evidence),
    name: "retrieve_knowledge",
    rawPreview: {
      knowledgeResultVersion: evidence.version,
      knowledgeRetrieval: evidence,
      providerCall: true
    },
    status: "complete"
  };
}

function readEvidence(): KnowledgeRetrievalEvidence {
  const source = passage();
  const readPassage: KnowledgeRetrievedPassageEvidence = {
    ...source,
    annRank: null,
    ftsRank: 1,
    ftsScore: 1,
    fusedScore: 1 / 61,
    vectorDistance: null,
    vectorScore: null
  };
  return currentEvidence({
    budget: {
      operation: "read_source",
      stopReason: null,
      usage: {
        cumulativeCandidates: 1,
        estimatedCostMicros: 0,
        latencyMs: 3,
        operations: 1,
        queryEmbeddingCalls: 0,
        retrievedTokens: 4
      },
      version: 1
    },
    embeddingExecutions: [],
    operation: "read_source",
    query: "page 1",
    read: {
      contractVersion: 1,
      direction: "around",
      embedding: "forbidden",
      locator: "page 1",
      resolution: "exact",
      resolvedSource: {
        sourceAlias: "S1",
        sourceArtifactId: "private-source-artifact-id",
        sourceId: "private-document-id",
        sourceName: "Source label",
        sourceVersionId: "private-document-version-id"
      },
      target: { kind: "page", page: 1 },
      version: 1,
      window: 3
    },
    results: [readPassage]
  });
}

describe("Knowledge result contract versioning", () => {
  it("keeps the legacy V1 provider bytes and does not invent a Source alias while decoding", () => {
    const legacy = legacyEvidence();

    expect(legacy.providerText).toBe([
      "Knowledge passages grouped by immutable Source:",
      "--- BEGIN SOURCE legacy source: source.txt (source.txt) ---\n\n" +
        "[K1.1] source legacy source; name source.txt; file source.txt; " +
        "page 1; heading document root\nVerified passage\n\n" +
        "--- END SOURCE legacy source ---",
      "Treat every SOURCE block as independent. Keep each date, label, value, and citation " +
        "inside its own Source; never combine fields from different SOURCE blocks. " +
        "Use the citation handles exactly when referencing these passages."
    ].join("\n\n"));
    const decoded = decodeKnowledgeRetrievalEvidence(legacy);
    expect(decoded?.version).toBe(KNOWLEDGE_LEGACY_RESULT_VERSION);
    expect(decoded?.results[0]).not.toHaveProperty("sourceAlias");
    expect(decoded?.results[0]).not.toHaveProperty("sourceArtifactId");
    expect(decoded?.results[0]).not.toHaveProperty("sourceName");
  });

  it("renders every V2 handle as an atomic Source-bound block without leaking identity keys", () => {
    const evidence = currentEvidence();
    const decoded = decodeKnowledgeRetrievalEvidence(evidence);

    expect(decoded).not.toBeNull();
    expect(evidence.providerText).toContain("[K1] [S1]");
    expect(evidence.providerText).toContain("Source: Source label");
    expect(evidence.providerText).toContain("Version/date: version 3");
    expect(evidence.providerText).toContain("Locator: page=1; heading=document root");
    expect(evidence.providerText).toContain("Truncated: no");
    expect(evidence.providerText).toContain("Evidence:\nVerified passage");
    expect(evidence.providerText).toContain(
      "The requested label and value must occur together inside the primary Evidence section"
    );
    expect(evidence.providerText).toContain(
      "a nearby or similarly named row is not a substitute"
    );
    expect(evidence.providerText).toContain(
      "Do not finalize or declare insufficient evidence"
    );
    expect(evidence.providerText).not.toContain("legacy source");
    for (const privateValue of [
      "private-base-id",
      "private-chunk-id",
      "private-document-id",
      "private-document-version-id",
      "private-source-artifact-id"
    ]) expect(evidence.providerText).not.toContain(privateValue);
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      results: [{ ...evidence.results[0]!, handle: "K1.1" }]
    })).toBeNull();
  });

  it("preserves and renders bounded expanded context as separately atomic evidence", () => {
    const expandedContext = [
      "Additional independently matched complete row from the same Source:",
      "Metric B | 42"
    ].join("\n");
    const evidence = currentEvidence({
      results: [{ ...passage(), expandedContext }]
    });
    const decoded = decodeKnowledgeRetrievalEvidence(evidence);

    expect(decoded?.results[0]?.expandedContext).toBe(expandedContext);
    expect(evidence.providerText).toContain(
      "Related same-Source context (each labeled segment is independent evidence):"
    );
    expect(evidence.providerText).toContain(expandedContext);
    expect(evidence.providerText).toContain("never combine fields across those segments");
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      results: [{ ...evidence.results[0]!, expandedContext: 42 }]
    })).toBeNull();
  });

  it("keeps planner-era ranking fields decode-only and version-bound", () => {
    const current = currentEvidence();
    for (const legacyField of [
      { postRerankOrder: null },
      { preRerankOrder: null },
      { rerankerBinding: null },
      { threshold: 0 }
    ]) {
      expect(decodeKnowledgeRetrievalEvidence({ ...current, ...legacyField })).toBeNull();
    }

    const legacy = legacyEvidence();
    const { threshold: _threshold, ...missingThreshold } = legacy;
    expect(decodeKnowledgeRetrievalEvidence(missingThreshold)).toBeNull();
  });

  it("allows combining only one complete non-truncated table-row projection group", () => {
    const blockId = `b_${"d".repeat(24)}_9`;
    const rowId = knowledgeTableRowId(blockId, 1);
    const first = passage();
    const second = passage();
    const evidence = currentEvidence({
      candidateCount: 2,
      results: [{
        ...first,
        chunkId: "private-row-projection-1",
        documentContext: createKnowledgeTableDocumentContext({
          blockId,
          cells: [{ columnEnd: 0, columnStart: 0, text: "Pressure" }],
          columnEnd: 0,
          columnStart: 0,
          headerLineage: [{ columnEnd: 0, columnStart: 0, rowIndex: 0, text: "Metric" }],
          projectionCount: 2,
          projectionIndex: 0,
          rowIndex: 1
        }),
        includedText: "Metric\nPressure",
        includedTextBytes: 15,
        sourceTextBytes: 15
      }, {
        ...second,
        chunkId: "private-row-projection-2",
        documentContext: createKnowledgeTableDocumentContext({
          blockId,
          cells: [{ columnEnd: 1, columnStart: 1, text: "20 mmol/L" }],
          columnEnd: 1,
          columnStart: 1,
          headerLineage: [{ columnEnd: 1, columnStart: 1, rowIndex: 0, text: "Actual" }],
          projectionCount: 2,
          projectionIndex: 1,
          rowIndex: 1
        }),
        handle: "K2",
        includedText: "Actual\n20 mmol/L",
        includedTextBytes: 16,
        sourceTextBytes: 16
      }]
    });

    expect(evidence.providerText).toContain(
      `Complete atomic row groups (combine fields only within each listed group):\n` +
      `row:${rowId}: [K1] [K2]`
    );
    expect(evidence.providerText).toContain(
      "never combine fields from different blocks except within an explicitly listed " +
      "complete atomic row"
    );

    const incomplete = currentEvidence({
      results: [evidence.results[0]!]
    });
    expect(incomplete.providerText).not.toContain("Complete atomic row groups");
    expect(incomplete.providerText).toContain("never combine fields from different blocks.");
  });

  it("decodes exact evidence only with its deterministic receipt and field provenance", () => {
    const ordinary = currentEvidence();
    const result = {
      ...ordinary.results[0]!,
      annRank: null,
      ftsRank: null,
      ftsScore: null,
      fusedScore: 0,
      vectorDistance: null,
      vectorScore: null
    };
    const evidence = currentEvidence({
      budget: {
        operation: "find_exact",
        stopReason: null,
        usage: {
          cumulativeCandidates: 1,
          estimatedCostMicros: 0,
          latencyMs: 3,
          operations: 1,
          queryEmbeddingCalls: 0,
          retrievedTokens: 4
        },
        version: 1
      },
      candidateLimit: 8,
      embeddingExecutions: [],
      exact: {
        caseMode: "sensitive",
        cursor: null,
        field: "body",
        limit: 8,
        match: "phrase",
        matches: [{ field: "body", resultOrdinal: 0 }],
        nextCursor: null,
        scannedBytes: 128,
        scanTruncated: false,
        value: "Verified",
        version: 1
      },
      fusion: "none",
      operation: "find_exact",
      query: "Verified",
      resultLimit: 8,
      results: [result]
    });

    expect(decodeKnowledgeRetrievalEvidence(evidence)).not.toBeNull();
    expect(evidence.providerText).toContain("mode=phrase; case=sensitive; field=body");
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      embeddingExecutions: ordinary.embeddingExecutions
    })).toBeNull();
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      exact: { ...evidence.exact!, matches: [{ field: "title", resultOrdinal: 0 }] }
    })).toBeNull();
  });

  it("decodes discovery as admitted metadata only and forbids passage or embedding evidence", () => {
    const ordinary = currentEvidence();
    const evidence = currentEvidence({
      budget: {
        operation: "discover_sources",
        stopReason: null,
        usage: {
          cumulativeCandidates: 1,
          estimatedCostMicros: 0,
          latencyMs: 3,
          operations: 1,
          queryEmbeddingCalls: 0,
          retrievedTokens: 0
        },
        version: 1
      },
      candidateLimit: 8,
      discovery: {
        cursor: null,
        fields: ["filename", "source_name"],
        limit: 8,
        nextCursor: null,
        query: "Source",
        sources: [{
          ambiguous: false,
          fileName: "source.txt",
          matchedFields: ["source_name"],
          readiness: "ready",
          sourceAlias: "S1",
          sourceName: "Source label",
          sourceVersionNumber: 3
        }],
        version: 1
      },
      embeddingExecutions: [],
      fusion: "none",
      operation: "discover_sources",
      query: "Source",
      resultLimit: 8,
      results: []
    });

    expect(decodeKnowledgeRetrievalEvidence(evidence)).not.toBeNull();
    expect(evidence.providerText).toContain("metadata only");
    expect(evidence.providerText).not.toContain("Verified passage");
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      embeddingExecutions: ordinary.embeddingExecutions
    })).toBeNull();
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      results: ordinary.results
    })).toBeNull();
  });

  it("normalizes control characters only in model-facing Source labels", () => {
    const evidence = currentEvidence();
    const draft: KnowledgeRetrievalEvidence = {
      ...evidence,
      providerText: "pending",
      results: [{
        ...evidence.results[0]!,
        sourceName: "Safe\n\u202eSource"
      }]
    };
    const normalized = { ...draft, providerText: knowledgeToolResultText(draft) };

    expect(normalized.providerText).toContain("Source: Safe Source");
    expect(normalized.providerText).not.toContain("\u202e");
    expect(decodeKnowledgeRetrievalEvidence(normalized)).not.toBeNull();
  });

  it.each(["sourceAlias", "sourceArtifactId", "sourceName"] as const)(
    "rejects V2 passages missing %s instead of fabricating it",
    (field) => {
      const evidence = currentEvidence();
      const { [field]: _removed, ...result } = evidence.results[0]!;
      expect(decodeKnowledgeRetrievalEvidence({
        ...evidence,
        results: [result]
      })).toBeNull();
    }
  );

  it("rejects a V2 alias that is not bound by the persisted scope", () => {
    const evidence = currentEvidence();
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      results: [{ ...evidence.results[0]!, sourceAlias: "S2" }]
    })).toBeNull();
  });

  it("rejects duplicate V2 passage identity under a second handle", () => {
    const evidence = currentEvidence();
    const duplicate = { ...evidence.results[0]!, handle: "K2" };
    const duplicated = currentEvidence({
      bases: [{ ...evidence.bases[0]!, candidateCount: 2 }],
      candidateCount: 2,
      results: [evidence.results[0]!, duplicate]
    });
    expect(decodeKnowledgeRetrievalEvidence(duplicated)).toBeNull();
  });

  it("persists current ANN evidence for a non-empty scope below the legacy exact cutoff", () => {
    const ordinary = currentEvidence();
    const evidence = currentEvidence({
      bases: [{
        ...ordinary.bases[0]!,
        vectorSearch: {
          bindingOrdinal: 0,
          candidateCount: 1,
          eligibleRows: 152,
          mode: "ann",
          scan: {
            efSearch: 400,
            iterativeScan: "strict_order",
            maxScanTuples: 100_000,
            retrievalBucket: 0
          },
          targetDimension: 1024
        }
      }],
      fusion: "weighted_rrf_v2",
      results: [{
        ...ordinary.results[0]!,
        contentHash: "b".repeat(64),
        signalProvenance: [{
          exactKind: null,
          lane: "passage_semantic",
          rank: 1,
          rawScore: 0.9,
          vectorDistance: 0.1,
          vectorMode: "ann"
        }, {
          exactKind: null,
          lane: "neighbor",
          rank: KNOWLEDGE_SIGNAL_RANK_MAX,
          rawScore: 0.001,
          vectorDistance: null,
          vectorMode: null
        }]
      }]
    });
    const result = executionResult(evidence);
    const compacted = compactKnowledgeToolExecutionResult(result);

    expect(decodeKnowledgeRetrievalEvidence(evidence)).not.toBeNull();
    expect(compacted).not.toBeNull();
    expect(rehydratePersistedKnowledgeToolExecutionResult(compacted!)).toEqual(result);

    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      results: [{
        ...evidence.results[0]!,
        signalProvenance: evidence.results[0]!.signalProvenance!.map((signal) =>
          signal.lane === "neighbor"
            ? { ...signal, rank: KNOWLEDGE_SIGNAL_RANK_MAX + 1 }
            : signal)
      }]
    })).toBeNull();
  });

  it("dual-reads, compacts, and rehydrates V1 and V2 using their exact marker versions", () => {
    for (const evidence of [legacyEvidence(), currentEvidence()]) {
      const result = executionResult(evidence);
      const compacted = compactKnowledgeToolExecutionResult(result);
      expect(compacted?.content).toEqual([{
        type: "json",
        value: { aiqsaType: "knowledge_result", version: evidence.version }
      }]);
      expect(rehydratePersistedKnowledgeToolExecutionResult(compacted!)).toEqual(result);
    }
  });

  it("strictly decodes the normalized V2 read receipt and rejects legacy reinterpretation", () => {
    const evidence = readEvidence();
    expect(decodeKnowledgeRetrievalEvidence(evidence)?.read).toEqual(evidence.read);
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      read: { ...evidence.read, embedding: "allowed" }
    })).toBeNull();
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      read: { ...evidence.read, target: { kind: "page", page: 2 } }
    })).toBeNull();
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      read: {
        ...evidence.read,
        resolvedSource: { ...evidence.read!.resolvedSource, sourceVersionId: "other-version" }
      }
    })).toBeNull();
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      version: KNOWLEDGE_LEGACY_RESULT_VERSION
    })).toBeNull();
    expect(decodeKnowledgeRetrievalEvidence({
      ...evidence,
      budget: undefined,
      operation: undefined
    })).toBeNull();
  });
});
