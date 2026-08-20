import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createKnowledgeStrategyStepRequestV1,
  decodeKnowledgeStrategyMapOutputReceiptProofV2,
  deriveKnowledgeStrategyMapOutputDependencyHashV2,
  hashKnowledgeAcceptedSourceSetV1,
  KNOWLEDGE_STRATEGY_MAX_SOURCES,
  sealKnowledgeStrategyExecutionRequestV1,
  type KnowledgeAcceptedSourceTupleV1,
  type KnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyStepRequestV1
} from "./knowledgeStrategyExecution";
import {
  canonicalKnowledgeStrategyMapOutputV2,
  createKnowledgeStrategyMapOutputDependencyInputV2,
  createKnowledgeStrategyMapOutputReceiptV2,
  createKnowledgeStrategyMapOutputV2,
  createKnowledgeStrategyMapSectionSummaryV2,
  createKnowledgeStrategyMapSummaryEvidenceV2,
  decodeKnowledgeStrategyMapInputV2,
  decodeKnowledgeStrategyMapOutputDependencyEntryV2,
  decodeKnowledgeStrategyMapOutputDependencyInputV2,
  decodeKnowledgeStrategyMapOutputReceiptV2,
  decodeKnowledgeStrategyMapOutputV2,
  decodeKnowledgeStrategyMapPageReceiptBindingV2,
  decodeKnowledgeStrategyMapProviderSummaryItemV2,
  decodeKnowledgeStrategyMapSectionSummaryV2,
  decodeKnowledgeStrategyMapSupportHandleBindingV2,
  decodeKnowledgeStrategyMapSummaryEvidenceV2,
  decodeKnowledgeStrategyMapSupportingPassageV2,
  deriveKnowledgeStrategyMapInputV2,
  hashKnowledgeStrategyMapOutputDependencyInputV2,
  hashKnowledgeStrategyMapOutputReceiptV2,
  hashKnowledgeStrategyMapOutputV2,
  hashKnowledgeStrategyMapSummaryEvidenceV2,
  verifyKnowledgeStrategyMapOutputInputV2,
  verifyKnowledgeStrategyMapSummaryEvidenceV2,
  type KnowledgeStrategyMapInputV2,
  type KnowledgeStrategyMapOutputReceiptV2,
  type KnowledgeStrategyMapOutputV2,
  type KnowledgeStrategyMapSupportHandleBindingV2,
  type KnowledgeStrategyMapSummaryEvidenceV2
} from "./knowledgeStrategyMapOutput";
import { knowledgeStrategyPassageStepReceiptV1 } from "./knowledgeStrategyRuntime";
import type { KnowledgeHybridPassage, KnowledgeStrategyPassagePage } from "./retrievalTypes";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function source(ordinal: number): KnowledgeAcceptedSourceTupleV1 {
  return Object.freeze({
    bindingId: `binding-${ordinal}`,
    hierarchicalArtifactId: `hierarchy-${ordinal}`,
    hierarchicalChecksum: digest(`hierarchy-${ordinal}`),
    ordinal,
    passageCount: 2,
    sourceAlias: `S${ordinal + 1}`,
    sourceArtifactId: `artifact-${ordinal}`,
    sourceId: `source-${ordinal}`,
    sourceVersionId: `source-version-${ordinal}`,
    sourceVersionNumber: ordinal + 1,
    version: 1
  });
}

function execution(sources: readonly KnowledgeAcceptedSourceTupleV1[]):
KnowledgeStrategyExecutionRequestV1 {
  const sourceSetHash = hashKnowledgeAcceptedSourceSetV1(sources);
  return sealKnowledgeStrategyExecutionRequestV1({
    config: {
      expectedPassageCount: sources.reduce((sum, value) => sum + value.passageCount, 0),
      kind: "corpus_summary",
      mapInputHash: digest("map-input"),
      reduceInputHash: digest("reduce-input")
    },
    executionId: "execution-map-output",
    modelRunId: "run-map-output",
    plannerVersion: 2,
    sourceSet: sources,
    sourceSetHash,
    strategy: "corpus_summary",
    version: 1
  });
}

function step(
  frozen: KnowledgeStrategyExecutionRequestV1,
  sourceValue: KnowledgeAcceptedSourceTupleV1,
  ordinal: number
): KnowledgeStrategyStepRequestV1 {
  expect(frozen.config.kind).toBe("corpus_summary");
  return createKnowledgeStrategyStepRequestV1({
    comparisonDimensionHash: null,
    cursor: null,
    evidenceInputHash: null,
    executionId: frozen.executionId,
    inputHash: frozen.config.kind === "corpus_summary"
      ? frozen.config.mapInputHash
      : digest("unreachable"),
    kind: "corpus_summary_map",
    ordinal,
    pageOrdinal: 0,
    phaseOrdinal: 0,
    required: true,
    sourceBindingId: sourceValue.bindingId,
    sourceSetHash: frozen.sourceSetHash,
    stepId: `map-step-${ordinal}`,
    strategy: "corpus_summary",
    streamId: `map-stream-${ordinal}`,
    targetOrdinal: null,
    version: 1
  });
}

function page(
  sourceValue: KnowledgeAcceptedSourceTupleV1
): KnowledgeStrategyPassagePage {
  const items = Object.freeze(Array.from({ length: 2 }, (_, ordinal) => ({
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
    fileName: `document-${sourceValue.ordinal}.txt`,
    ftsRank: null,
    ftsScore: null,
    fusedScore: 0,
    headingPath: [`Section ${item.passageOrdinal + 1}`],
    knowledgeBaseId: `profile-${sourceValue.ordinal}`,
    page: item.passageOrdinal + 1,
    sectionId: `section-${sourceValue.ordinal}-${item.passageOrdinal}`,
    sourceArtifactId: sourceValue.sourceArtifactId,
    sourceName: `Source ${sourceValue.ordinal + 1}`,
    text: `Exact text ${sourceValue.ordinal}.${item.passageOrdinal}`,
    vectorDistance: null,
    vectorScore: null
  })));
  return Object.freeze({ complete: true, items, nextCursor: null, passages, source: sourceValue });
}

type SourceFixture = Readonly<{
  evidence: KnowledgeStrategyMapSummaryEvidenceV2;
  handleBindings: readonly KnowledgeStrategyMapSupportHandleBindingV2[];
  input: KnowledgeStrategyMapInputV2;
  output: KnowledgeStrategyMapOutputV2;
  page: KnowledgeStrategyPassagePage;
  receipt: KnowledgeStrategyMapOutputReceiptV2;
  step: KnowledgeStrategyStepRequestV1;
}>;

type Fixture = Readonly<{
  execution: KnowledgeStrategyExecutionRequestV1;
  sources: readonly SourceFixture[];
}>;

function fixture(): Fixture {
  const frozenSources = Object.freeze([source(0), source(1)]);
  const frozen = execution(frozenSources);
  let handleOrdinal = 1;
  const sourceFixtures = frozenSources.map((sourceValue, sourceOrdinal): SourceFixture => {
    const stepValue = step(frozen, sourceValue, sourceOrdinal);
    const pageValue = page(sourceValue);
    const pageReceipt = knowledgeStrategyPassageStepReceiptV1(stepValue, pageValue);
    const mapInput = deriveKnowledgeStrategyMapInputV2({
      execution: frozen,
      pages: [pageValue],
      source: sourceValue,
      stepReceipts: [pageReceipt],
      stepRequests: [stepValue]
    });
    const summaries = mapInput.passageItems.map((support, ordinal) =>
      createKnowledgeStrategyMapSectionSummaryV2({
        ordinal,
        sectionHash: support.sectionHash,
        summaryText: `Summary ${sourceOrdinal + 1}.${ordinal + 1}`,
        supportingPassages: [support]
      }));
    const output = createKnowledgeStrategyMapOutputV2({ mapInput, summaries });
    const receipt = createKnowledgeStrategyMapOutputReceiptV2(output);
    const handleBindings = mapInput.passageItems.map((support) => ({
      ...support,
      handle: `K${handleOrdinal++}`
    }));
    const evidence = createKnowledgeStrategyMapSummaryEvidenceV2({
      handleBindings,
      output
    });
    return Object.freeze({
      evidence,
      handleBindings,
      input: mapInput,
      output,
      page: pageValue,
      receipt,
      step: stepValue
    });
  });
  return Object.freeze({ execution: frozen, sources: Object.freeze(sourceFixtures) });
}

describe("Knowledge strategy map-output v2", () => {
  it("accepts map identity S999 and rejects source ordinal 999", () => {
    const sourceValue = source(KNOWLEDGE_STRATEGY_MAX_SOURCES - 1);
    const frozen = execution([sourceValue]);
    const stepValue = step(frozen, sourceValue, 0);
    const pageValue = page(sourceValue);
    const pageReceipt = knowledgeStrategyPassageStepReceiptV1(stepValue, pageValue);
    const mapInput = deriveKnowledgeStrategyMapInputV2({
      execution: frozen,
      pages: [pageValue],
      source: sourceValue,
      stepReceipts: [pageReceipt],
      stepRequests: [stepValue]
    });
    const summaries = mapInput.passageItems.map((support, ordinal) =>
      createKnowledgeStrategyMapSectionSummaryV2({
        ordinal,
        sectionHash: support.sectionHash,
        summaryText: `Boundary summary ${ordinal}`,
        supportingPassages: [support]
      }));
    const output = createKnowledgeStrategyMapOutputV2({ mapInput, summaries });
    const receipt = createKnowledgeStrategyMapOutputReceiptV2(output);
    const dependencyEntry = {
      outputHash: receipt.outputHash,
      receiptHash: receipt.receiptHash,
      sourceBindingId: receipt.sourceBindingId,
      sourceOrdinal: receipt.sourceOrdinal,
      summaryItemsHash: receipt.summaryItemsHash,
      terminalStepId: receipt.terminalStepId,
      version: receipt.version
    };

    expect(mapInput).toMatchObject({ sourceAlias: "S999", sourceOrdinal: 998 });
    expect(decodeKnowledgeStrategyMapInputV2(mapInput)).toEqual(mapInput);
    expect(decodeKnowledgeStrategyMapOutputV2(output)).toEqual(output);
    expect(decodeKnowledgeStrategyMapOutputReceiptV2(receipt)).toEqual(receipt);
    expect(decodeKnowledgeStrategyMapOutputDependencyEntryV2(dependencyEntry))
      .toEqual(dependencyEntry);
    expect(decodeKnowledgeStrategyMapOutputDependencyEntryV2({
      ...dependencyEntry,
      sourceOrdinal: KNOWLEDGE_STRATEGY_MAX_SOURCES
    })).toBeNull();
  });

  it("binds two Sources from exact pages through reduce input and provider-safe evidence", () => {
    const value = fixture();
    const dependency = createKnowledgeStrategyMapOutputDependencyInputV2({
      dependentStepId: "reduce-step",
      execution: value.execution,
      receipts: [...value.sources].reverse().map(({ receipt }) => receipt)
    });

    expect(decodeKnowledgeStrategyMapOutputDependencyInputV2(dependency)).toEqual(dependency);
    expect(dependency).toMatchObject({
      dependentStepId: "reduce-step",
      mapOutputCount: 2,
      sourceSetHash: value.execution.sourceSetHash
    });
    expect(dependency.mapOutputs.map(({ sourceOrdinal }) => sourceOrdinal)).toEqual([0, 1]);
    expect(hashKnowledgeStrategyMapOutputDependencyInputV2(dependency)).toMatch(
      /^[0-9a-f]{64}$/u
    );
    expect(deriveKnowledgeStrategyMapOutputDependencyHashV2({
      dependentStepId: dependency.dependentStepId,
      executionId: dependency.executionId,
      receipts: value.sources.map(({ receipt }) => receipt),
      sourceSetHash: dependency.sourceSetHash
    })).toBe(dependency.dependencyInputHash);

    for (const sourceValue of value.sources) {
      expect(decodeKnowledgeStrategyMapInputV2(sourceValue.input)).toEqual(sourceValue.input);
      expect(decodeKnowledgeStrategyMapOutputV2(sourceValue.output)).toEqual(sourceValue.output);
      expect(decodeKnowledgeStrategyMapOutputReceiptV2(sourceValue.receipt)).toEqual(
        sourceValue.receipt
      );
      expect(decodeKnowledgeStrategyMapOutputReceiptProofV2(sourceValue.receipt)).toEqual(
        sourceValue.receipt
      );
      expect(verifyKnowledgeStrategyMapOutputInputV2(
        sourceValue.input,
        sourceValue.output
      )).toBe(true);
      expect(verifyKnowledgeStrategyMapSummaryEvidenceV2({
        evidence: sourceValue.evidence,
        handleBindings: sourceValue.handleBindings,
        output: sourceValue.output
      })).toBe(true);
      expect(hashKnowledgeStrategyMapOutputReceiptV2(sourceValue.receipt)).toMatch(
        /^[0-9a-f]{64}$/u
      );
      const serializedEvidence = JSON.stringify(sourceValue.evidence);
      expect(serializedEvidence).not.toContain(sourceValue.output.sourceBindingId);
      expect(serializedEvidence).not.toContain(sourceValue.output.sourceArtifactId);
      expect(serializedEvidence).not.toContain(sourceValue.output.sourceVersionId);
    }
  });

  it("rejects a same-count supporting-passage mutation outside the exact map input", () => {
    const value = fixture().sources[0]!;
    const support = value.input.passageItems[0]!;
    const changedSupport = { ...support, contentHash: digest("mutated-support") };
    const changedSummary = createKnowledgeStrategyMapSectionSummaryV2({
      ordinal: 0,
      sectionHash: support.sectionHash,
      summaryText: "Mutated but internally sealed summary",
      supportingPassages: [changedSupport]
    });

    expect(() => createKnowledgeStrategyMapOutputV2({
      mapInput: value.input,
      summaries: [changedSummary, value.output.summaries[1]!]
    })).toThrow("knowledge_strategy_map_support_outside_input");
  });

  it("rejects page, summary, terminal receipt, dependency, and handle mutations", () => {
    const all = fixture();
    const value = all.sources[0]!;
    const changedHash = digest("changed-page");
    const changedPage = {
      ...value.page,
      items: [{ ...value.page.items[0]!, contentHash: changedHash }, value.page.items[1]!],
      passages: [{ ...value.page.passages[0]!, contentHash: changedHash }, value.page.passages[1]!]
    } as KnowledgeStrategyPassagePage;
    const pageReceipt = knowledgeStrategyPassageStepReceiptV1(value.step, value.page);
    expect(() => deriveKnowledgeStrategyMapInputV2({
      execution: all.execution,
      pages: [changedPage],
      source: value.page.source,
      stepReceipts: [pageReceipt],
      stepRequests: [value.step]
    })).toThrow("knowledge_strategy_map_page_receipt_mismatch");

    const changedOutputText = {
      ...value.output,
      summaries: value.output.summaries.map((summary, ordinal) => ordinal === 0
        ? { ...summary, summaryText: "Changed without matching hashes" }
        : summary)
    };
    expect(decodeKnowledgeStrategyMapOutputV2(changedOutputText)).toBeNull();

    const changedReceipt = { ...value.receipt, outputHash: digest("changed-output") };
    expect(decodeKnowledgeStrategyMapOutputReceiptV2(changedReceipt)).toBeNull();
    expect(() => createKnowledgeStrategyMapOutputDependencyInputV2({
      dependentStepId: "reduce-step",
      execution: all.execution,
      receipts: [changedReceipt, all.sources[1]!.receipt]
    })).toThrow("knowledge_strategy_map_dependency_receipt_invalid");

    const changedBinding = value.handleBindings.map((binding, ordinal) => ordinal === 0
      ? { ...binding, contentHash: digest("changed-binding") }
      : binding);
    expect(() => createKnowledgeStrategyMapSummaryEvidenceV2({
      handleBindings: changedBinding,
      output: value.output
    })).toThrow("knowledge_strategy_map_handle_binding_mismatch");
    const changedEvidence = {
      ...value.evidence,
      summaries: value.evidence.summaries.map((summary, ordinal) => ordinal === 0
        ? { ...summary, supportingHandles: ["K999"] }
        : summary)
    };
    expect(decodeKnowledgeStrategyMapSummaryEvidenceV2(changedEvidence)).toBeNull();
  });

  it("changes reduce and provider hashes for a fully resealed summary mutation", () => {
    const all = fixture();
    const original = all.sources[0]!;
    const changedSummary = createKnowledgeStrategyMapSectionSummaryV2({
      ordinal: 0,
      sectionHash: original.output.summaries[0]!.sectionHash,
      summaryText: "A different sealed summary",
      supportingPassages: original.output.summaries[0]!.supportingPassages
    });
    const changedOutput = createKnowledgeStrategyMapOutputV2({
      mapInput: original.input,
      summaries: [changedSummary, original.output.summaries[1]!]
    });
    const changedReceipt = createKnowledgeStrategyMapOutputReceiptV2(changedOutput);
    const originalDependency = createKnowledgeStrategyMapOutputDependencyInputV2({
      dependentStepId: "reduce-step",
      execution: all.execution,
      receipts: all.sources.map(({ receipt }) => receipt)
    });
    const changedDependency = createKnowledgeStrategyMapOutputDependencyInputV2({
      dependentStepId: "reduce-step",
      execution: all.execution,
      receipts: [changedReceipt, all.sources[1]!.receipt]
    });
    const changedEvidence = createKnowledgeStrategyMapSummaryEvidenceV2({
      handleBindings: original.handleBindings,
      output: changedOutput
    });

    expect(hashKnowledgeStrategyMapOutputV2(changedOutput)).not.toBe(
      hashKnowledgeStrategyMapOutputV2(original.output)
    );
    expect(hashKnowledgeStrategyMapOutputDependencyInputV2(changedDependency)).not.toBe(
      hashKnowledgeStrategyMapOutputDependencyInputV2(originalDependency)
    );
    expect(hashKnowledgeStrategyMapSummaryEvidenceV2(changedEvidence)).not.toBe(
      hashKnowledgeStrategyMapSummaryEvidenceV2(original.evidence)
    );
  });

  it("rejects unknown keys on every durable/provider envelope", () => {
    const all = fixture();
    const value = all.sources[0]!;
    const dependency = createKnowledgeStrategyMapOutputDependencyInputV2({
      dependentStepId: "reduce-step",
      execution: all.execution,
      receipts: all.sources.map(({ receipt }) => receipt)
    });

    expect(decodeKnowledgeStrategyMapInputV2({ ...value.input, extra: true })).toBeNull();
    expect(decodeKnowledgeStrategyMapPageReceiptBindingV2({
      ...value.input.pageReceiptBindings[0]!,
      extra: true
    })).toBeNull();
    expect(decodeKnowledgeStrategyMapSupportingPassageV2({
      ...value.input.passageItems[0]!,
      extra: true
    })).toBeNull();
    expect(decodeKnowledgeStrategyMapSectionSummaryV2({
      ...value.output.summaries[0]!,
      extra: true
    })).toBeNull();
    expect(decodeKnowledgeStrategyMapOutputV2({ ...value.output, extra: true })).toBeNull();
    expect(decodeKnowledgeStrategyMapOutputReceiptV2({
      ...value.receipt,
      extra: true
    })).toBeNull();
    expect(decodeKnowledgeStrategyMapOutputDependencyInputV2({
      ...dependency,
      extra: true
    })).toBeNull();
    expect(decodeKnowledgeStrategyMapOutputDependencyEntryV2({
      ...dependency.mapOutputs[0]!,
      extra: true
    })).toBeNull();
    expect(decodeKnowledgeStrategyMapSupportHandleBindingV2({
      ...value.handleBindings[0]!,
      extra: true
    })).toBeNull();
    expect(decodeKnowledgeStrategyMapProviderSummaryItemV2({
      ...value.evidence.summaries[0]!,
      extra: true
    })).toBeNull();
    expect(decodeKnowledgeStrategyMapSummaryEvidenceV2({
      ...value.evidence,
      extra: true
    })).toBeNull();
    expect(canonicalKnowledgeStrategyMapOutputV2(value.output)).not.toContain("extra");
  });
});
