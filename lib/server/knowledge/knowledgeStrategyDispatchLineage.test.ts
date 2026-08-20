import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKnowledgeStrategyDependencyV1,
  createKnowledgeStrategyStepRequestV1,
  deriveKnowledgeStrategyDependencyEvidenceInputV1,
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeStrategyDependencyEvidenceInputV1,
  sealKnowledgeStrategyExecutionRequestV1,
  sealKnowledgeStrategyStepEvidenceV1,
  type KnowledgeAcceptedSourceTupleV1,
  type KnowledgeMeasuredStrategy,
  type KnowledgeStrategyDependencyV1,
  type KnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyStepReceiptV1,
  type KnowledgeStrategyStepRequestV1
} from "./knowledgeStrategyExecution";
import {
  verifyKnowledgeStrategyDispatchLineageV1,
  type KnowledgeStrategyDispatchLineageSourceV1
} from "./knowledgeStrategyDispatchLineage";
import {
  knowledgeStrategyEvidenceStepReceiptV1,
  knowledgeStrategyPassageStepReceiptV1
} from "./knowledgeStrategyRuntime";
import type {
  KnowledgeHybridPassage,
  KnowledgeRetrievalEvidence,
  KnowledgeRetrievedPassageEvidence,
  KnowledgeStrategyPassagePage
} from "./retrievalTypes";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function source(ordinal: number, passageCount: number): KnowledgeAcceptedSourceTupleV1 {
  return Object.freeze({
    bindingId: `binding-${ordinal}`,
    hierarchicalArtifactId: `hierarchy-${ordinal}`,
    hierarchicalChecksum: digest(`hierarchy-${ordinal}`),
    ordinal,
    passageCount,
    sourceAlias: `S${ordinal + 1}`,
    sourceArtifactId: `artifact-${ordinal}`,
    sourceId: `source-${ordinal}`,
    sourceVersionId: `source-version-${ordinal}`,
    sourceVersionNumber: 1,
    version: 1
  });
}

function execution(
  strategy: "corpus_summary" | "exhaustive" | "full_context",
  sources: readonly KnowledgeAcceptedSourceTupleV1[]
): KnowledgeStrategyExecutionRequestV1 {
  const expectedPassageCount = sources.reduce((sum, entry) => sum + entry.passageCount, 0);
  const sourceSetHash = hashKnowledgeAcceptedSourceSetV1(sources);
  const base = {
    executionId: `execution-${strategy}`,
    modelRunId: `run-${strategy}`,
    plannerVersion: 2,
    sourceSet: sources,
    sourceSetHash,
    strategy,
    version: 1
  } as const;
  if (strategy === "full_context") {
    return sealKnowledgeStrategyExecutionRequestV1({
      ...base,
      config: { expectedPassageCount, fallback: "corpus_summary", kind: strategy }
    });
  }
  if (strategy === "exhaustive") {
    return sealKnowledgeStrategyExecutionRequestV1({
      ...base,
      config: { expectedPassageCount, kind: strategy, queryHash: digest("query") }
    });
  }
  return sealKnowledgeStrategyExecutionRequestV1({
    ...base,
    config: {
      expectedPassageCount,
      kind: strategy,
      mapInputHash: digest("map-input"),
      reduceInputHash: digest("reduce-input")
    }
  });
}

function pageStep(
  frozen: KnowledgeStrategyExecutionRequestV1,
  sourceValue: KnowledgeAcceptedSourceTupleV1,
  ordinal: number
): KnowledgeStrategyStepRequestV1 {
  const strategy = frozen.strategy as Exclude<KnowledgeMeasuredStrategy,
    "comparison" | "multi_hop">;
  const kind = strategy === "full_context"
    ? "full_context_page" as const
    : strategy === "exhaustive" ? "exhaustive_page" as const : "corpus_summary_map" as const;
  const inputHash = frozen.config.kind === "exhaustive"
    ? frozen.config.queryHash
    : frozen.config.kind === "corpus_summary"
      ? frozen.config.mapInputHash
      : digest("full-context-input");
  return createKnowledgeStrategyStepRequestV1({
    comparisonDimensionHash: null,
    cursor: null,
    evidenceInputHash: null,
    executionId: frozen.executionId,
    inputHash,
    kind,
    ordinal,
    pageOrdinal: 0,
    phaseOrdinal: 0,
    required: true,
    sourceBindingId: sourceValue.bindingId,
    sourceSetHash: frozen.sourceSetHash,
    stepId: `step-${ordinal}`,
    strategy,
    streamId: `stream-${ordinal}`,
    targetOrdinal: null,
    version: 1
  });
}

function page(
  frozen: KnowledgeStrategyExecutionRequestV1,
  step: KnowledgeStrategyStepRequestV1,
  sourceValue: KnowledgeAcceptedSourceTupleV1
): KnowledgeStrategyPassagePage {
  const items = Object.freeze(Array.from({ length: sourceValue.passageCount }, (_, ordinal) => ({
    contentHash: digest(`content-${sourceValue.ordinal}-${ordinal}`),
    passageId: `passage-${sourceValue.ordinal}-${ordinal}`,
    passageOrdinal: ordinal,
    sourceArtifactId: sourceValue.sourceArtifactId,
    sourceBindingId: sourceValue.bindingId,
    sourceOrdinal: sourceValue.ordinal,
    version: 1 as const
  })));
  const passages = Object.freeze(items.map((item): KnowledgeHybridPassage => ({
    annRank: null,
    baseName: "Pinned profile",
    bindingOrdinal: sourceValue.ordinal,
    chunkId: item.passageId,
    chunkIndex: item.passageOrdinal,
    contentHash: item.contentHash,
    documentId: sourceValue.sourceId,
    documentVersionId: sourceValue.sourceVersionId,
    documentVersionNumber: sourceValue.sourceVersionNumber,
    fileName: `source-${sourceValue.ordinal}.txt`,
    ftsRank: null,
    ftsScore: null,
    fusedScore: 0,
    headingPath: ["Root"],
    knowledgeBaseId: `profile-${sourceValue.ordinal}`,
    page: 1,
    sectionId: `section-${sourceValue.ordinal}`,
    sourceArtifactId: sourceValue.sourceArtifactId,
    sourceName: `Source ${sourceValue.ordinal}`,
    text: `Exact passage ${sourceValue.ordinal}.${item.passageOrdinal}`,
    vectorDistance: null,
    vectorScore: null
  })));
  expect(step.executionId).toBe(frozen.executionId);
  return Object.freeze({ complete: true, items, nextCursor: null, passages, source: sourceValue });
}

function resultFromPassage(
  pageValue: KnowledgeStrategyPassagePage,
  passageOrdinal: number,
  evidenceOrdinal: number
): KnowledgeRetrievedPassageEvidence {
  const passage = pageValue.passages[passageOrdinal]!;
  const { text, ...identity } = passage;
  const bytes = Buffer.byteLength(text, "utf8");
  return Object.freeze({
    ...identity,
    handle: `K${evidenceOrdinal + 1}`,
    includedText: text,
    includedTextBytes: bytes,
    sourceAlias: pageValue.source.sourceAlias,
    sourceTextBytes: bytes,
    textTruncated: false
  });
}

function evidence(
  results: readonly KnowledgeRetrievedPassageEvidence[],
  marker?: KnowledgeRetrievalEvidence["strategyStepEvidence"]
): KnowledgeRetrievalEvidence {
  return {
    results,
    ...(marker ? { strategyStepEvidence: marker } : {})
  } as unknown as KnowledgeRetrievalEvidence;
}

type LineageFixture = Readonly<{
  dependencies: readonly KnowledgeStrategyDependencyV1[];
  evidence: KnowledgeRetrievalEvidence;
  execution: KnowledgeStrategyExecutionRequestV1;
  lineage: KnowledgeStrategyDispatchLineageSourceV1;
  pages: readonly KnowledgeStrategyPassagePage[];
  receipts: readonly KnowledgeStrategyStepReceiptV1[];
  steps: readonly KnowledgeStrategyStepRequestV1[];
}>;

function extractiveFixture(input: Readonly<{
  passageCount: number;
  sourceCount: number;
  strategy: "exhaustive" | "full_context";
}>): LineageFixture {
  const sources = Object.freeze(Array.from({ length: input.sourceCount }, (_, ordinal) =>
    source(ordinal, input.passageCount)));
  const frozen = execution(input.strategy, sources);
  const steps = Object.freeze(sources.map((entry, ordinal) => pageStep(frozen, entry, ordinal)));
  const pages = Object.freeze(steps.map((step, ordinal) =>
    page(frozen, step, sources[ordinal]!)));
  const receipts = Object.freeze(steps.map((step, ordinal) =>
    knowledgeStrategyPassageStepReceiptV1(step, pages[ordinal]!)));
  const results = pages.flatMap((pageValue) => pageValue.passages.map((_, ordinal) =>
    resultFromPassage(pageValue, ordinal, 0)))
    .map((result, ordinal) => ({ ...result, handle: `K${ordinal + 1}` }));
  const marker = sealKnowledgeStrategyStepEvidenceV1(steps[0], receipts[0]);
  const emitted = evidence(results, marker);
  const lineage: KnowledgeStrategyDispatchLineageSourceV1 = {
    dependencies: [],
    execution: frozen,
    kind: "explicit",
    stepReceipts: receipts,
    stepRequests: steps
  };
  return Object.freeze({
    dependencies: [],
    evidence: emitted,
    execution: frozen,
    lineage,
    pages,
    receipts,
    steps
  });
}

function corpusFixture(input: Readonly<{
  compressed?: boolean;
  passageCount: number;
  sourceCount: number;
}>): LineageFixture {
  const sources = Object.freeze(Array.from({ length: input.sourceCount }, (_, ordinal) =>
    source(ordinal, input.passageCount)));
  const frozen = execution("corpus_summary", sources);
  const mapSteps = Object.freeze(sources.map((entry, ordinal) => pageStep(frozen, entry, ordinal)));
  const pages = Object.freeze(mapSteps.map((step, ordinal) =>
    page(frozen, step, sources[ordinal]!)));
  const mapReceipts = Object.freeze(mapSteps.map((step, ordinal) =>
    knowledgeStrategyPassageStepReceiptV1(step, pages[ordinal]!)));
  const reduceStepId = "step-reduce";
  const dependencies = Object.freeze(mapSteps.map((step) => createKnowledgeStrategyDependencyV1({
    dependentStepId: reduceStepId,
    executionId: frozen.executionId,
    prerequisiteStepId: step.stepId,
    version: 1
  })));
  const dependencyEvidence = deriveKnowledgeStrategyDependencyEvidenceInputV1(
    frozen.executionId,
    reduceStepId,
    dependencies,
    mapReceipts
  )!;
  expect(frozen.config.kind).toBe("corpus_summary");
  const reduce = createKnowledgeStrategyStepRequestV1({
    comparisonDimensionHash: null,
    cursor: null,
    evidenceInputHash: hashKnowledgeStrategyDependencyEvidenceInputV1(dependencyEvidence),
    executionId: frozen.executionId,
    inputHash: frozen.config.kind === "corpus_summary"
      ? frozen.config.reduceInputHash
      : digest("unreachable"),
    kind: "corpus_summary_reduce",
    ordinal: mapSteps.length,
    pageOrdinal: 0,
    phaseOrdinal: 0,
    required: true,
    sourceBindingId: null,
    sourceSetHash: frozen.sourceSetHash,
    stepId: reduceStepId,
    strategy: "corpus_summary",
    streamId: "stream-reduce",
    targetOrdinal: null,
    version: 1
  });
  const exactResults = pages.flatMap((pageValue) => pageValue.passages.map((_, ordinal) =>
    resultFromPassage(pageValue, ordinal, 0)))
    .map((result, ordinal) => ({ ...result, handle: `K${ordinal + 1}` }));
  const results = input.compressed
    ? pages.map((pageValue, ordinal) => {
        const first = resultFromPassage(pageValue, 0, ordinal);
        const includedText = `Compressed output ${ordinal}`;
        const bytes = Buffer.byteLength(includedText, "utf8");
        return Object.freeze({
          ...first,
          includedText,
          includedTextBytes: bytes,
          sourceTextBytes: bytes,
          textTruncated: false
        });
      })
    : exactResults;
  const draft = evidence(results);
  const reduceReceipt = knowledgeStrategyEvidenceStepReceiptV1(reduce, draft);
  const emitted = evidence(results, sealKnowledgeStrategyStepEvidenceV1(reduce, reduceReceipt));
  const steps = Object.freeze([...mapSteps, reduce]);
  const receipts = Object.freeze([...mapReceipts, reduceReceipt]);
  const lineage: KnowledgeStrategyDispatchLineageSourceV1 = {
    dependencies,
    execution: frozen,
    kind: "explicit",
    stepReceipts: receipts,
    stepRequests: steps
  };
  return Object.freeze({
    dependencies,
    evidence: emitted,
    execution: frozen,
    lineage,
    pages,
    receipts,
    steps
  });
}

describe("Knowledge strategy dispatch lineage v1", () => {
  it("verifies eight exact full-context passages through explicit and stored inputs", () => {
    const fixture = extractiveFixture({ passageCount: 8, sourceCount: 1, strategy: "full_context" });
    const explicit = verifyKnowledgeStrategyDispatchLineageV1(fixture);
    const stored = verifyKnowledgeStrategyDispatchLineageV1({
      evidence: fixture.evidence,
      lineage: {
        execution: {
          dependencies: fixture.dependencies,
          execution: fixture.execution,
          purgedAt: null,
          steps: fixture.steps.map((request, index) => ({
            receipt: fixture.receipts[index],
            request
          }))
        } as unknown as import("./knowledgeStrategyRepository").StoredKnowledgeStrategyExecution,
        kind: "stored"
      },
      pages: fixture.pages
    });

    expect(explicit).toMatchObject({
      emittedPassageCount: 8,
      processedPassageCount: 8,
      reasonCodes: [],
      verified: true
    });
    expect(stored).toEqual(explicit);
    expect(explicit.lineageHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("rejects an emitted passage with a changed content hash", () => {
    const fixture = extractiveFixture({ passageCount: 8, sourceCount: 1, strategy: "full_context" });
    const changedEvidence = {
      ...fixture.evidence,
      results: fixture.evidence.results.map((result, index) => index === 3
        ? { ...result, contentHash: digest("changed-content") }
        : result)
    } as KnowledgeRetrievalEvidence;
    const changed = verifyKnowledgeStrategyDispatchLineageV1({
      ...fixture,
      evidence: changedEvidence
    });

    expect(changed.verified).toBe(false);
    expect(changed.reasonCodes).toContain("lineage_emitted_identity_mismatch");
    expect(changed.lineageHash).not.toBe(
      verifyKnowledgeStrategyDispatchLineageV1(fixture).lineageHash
    );
  });

  it("rejects an exhaustive dispatch of 101 otherwise exact passages", () => {
    const fixture = extractiveFixture({ passageCount: 1, sourceCount: 101, strategy: "exhaustive" });
    const result = verifyKnowledgeStrategyDispatchLineageV1(fixture);

    expect(result).toMatchObject({
      emittedPassageCount: 101,
      processedPassageCount: 101,
      verified: false
    });
    expect(result.reasonCodes).toContain("lineage_emitted_limit_exceeded");
  });

  it("verifies 50 one-passage corpus maps, reduce binding, and exact output", () => {
    const fixture = corpusFixture({ passageCount: 1, sourceCount: 50 });
    const result = verifyKnowledgeStrategyDispatchLineageV1(fixture);

    expect(result).toMatchObject({
      emittedPassageCount: 50,
      processedPassageCount: 50,
      reasonCodes: [],
      verified: true
    });
  });

  it("rejects a missing corpus map page", () => {
    const fixture = corpusFixture({ passageCount: 1, sourceCount: 50 });
    const result = verifyKnowledgeStrategyDispatchLineageV1({
      ...fixture,
      pages: fixture.pages.slice(0, -1)
    });

    expect(result.verified).toBe(false);
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "lineage_page_count_mismatch",
      "lineage_source_coverage_mismatch"
    ]));
  });

  it("rejects a corpus map whose passage content hash changed after settlement", () => {
    const fixture = corpusFixture({ passageCount: 1, sourceCount: 50 });
    const original = fixture.pages[20]!;
    const contentHash = digest("changed-map-content");
    const changedPage = {
      ...original,
      items: [{ ...original.items[0]!, contentHash }],
      passages: [{ ...original.passages[0]!, contentHash }]
    } as KnowledgeStrategyPassagePage;
    const result = verifyKnowledgeStrategyDispatchLineageV1({
      ...fixture,
      pages: fixture.pages.map((pageValue, index) => index === 20 ? changedPage : pageValue)
    });

    expect(result.verified).toBe(false);
    expect(result.reasonCodes).toEqual(expect.arrayContaining([
      "lineage_emitted_identity_mismatch",
      "lineage_page_receipt_mismatch"
    ]));
  });

  it("rejects a same-count corpus reduce output with a self-consistent changed content hash", () => {
    const fixture = corpusFixture({ passageCount: 1, sourceCount: 50 });
    const reduce = fixture.steps.at(-1)!;
    const changedResults = fixture.evidence.results.map((result, index) => index === 12
      ? { ...result, contentHash: digest("changed-reduce-content") }
      : result);
    const changedDraft = evidence(changedResults);
    const changedReceipt = knowledgeStrategyEvidenceStepReceiptV1(reduce, changedDraft);
    const changedEvidence = evidence(
      changedResults,
      sealKnowledgeStrategyStepEvidenceV1(reduce, changedReceipt)
    );
    const changedReceipts = [...fixture.receipts.slice(0, -1), changedReceipt];
    const result = verifyKnowledgeStrategyDispatchLineageV1({
      evidence: changedEvidence,
      lineage: {
        dependencies: fixture.dependencies,
        execution: fixture.execution,
        kind: "explicit",
        stepReceipts: changedReceipts,
        stepRequests: fixture.steps
      },
      pages: fixture.pages
    });

    expect(result).toMatchObject({ emittedPassageCount: 50, verified: false });
    expect(result.reasonCodes).toContain("lineage_emitted_identity_mismatch");
    expect(result.reasonCodes).not.toContain("lineage_reduce_receipt_mismatch");
  });

  it("rejects 50 compressed outputs over 50 three-passage maps as non-extractive v1", () => {
    const fixture = corpusFixture({ compressed: true, passageCount: 3, sourceCount: 50 });
    const result = verifyKnowledgeStrategyDispatchLineageV1(fixture);

    expect(result).toMatchObject({
      emittedPassageCount: 50,
      processedPassageCount: 150,
      verified: false
    });
    expect(result.reasonCodes).toContain("corpus_summary_non_extractive_output");
  });
});
