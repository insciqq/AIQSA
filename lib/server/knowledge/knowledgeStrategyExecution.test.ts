import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  applyKnowledgeStrategyStepCasTransitionV1,
  canonicalKnowledgeStrategyExecutionRequestV1,
  containsKnowledgeNegativeUniversalClaimV1,
  createKnowledgeStrategyCoverageRequestV1,
  createKnowledgeStrategyDependencyV1,
  createKnowledgeStrategyExecutionRequestV1,
  createKnowledgeStrategyNextCursorV1,
  createKnowledgeStrategyStepReceiptV1,
  createKnowledgeStrategyStepRequestV1,
  createKnowledgeStrategyStepTemplateV1,
  decodeKnowledgeAcceptedSourceSetV1,
  decodeKnowledgeAcceptedSourceTupleV1,
  decodeKnowledgeStrategyCoverageReceiptV1,
  decodeKnowledgeStrategyCursorV1,
  decodeKnowledgeStrategyExecutionRequestV1,
  decodeKnowledgeStrategyStepEvidenceV1,
  decodeKnowledgeStrategyStepLifecycleV1,
  decodeKnowledgeStrategyStepRequestV1,
  deriveKnowledgeStrategyCoverageReceiptV1,
  deriveKnowledgeStrategyDependencyEvidenceInputV1,
  deriveKnowledgeStrategyMapOutputDependencyHashV2,
  detectKnowledgeUniversalClaimsV1,
  eligibleKnowledgeStrategyStepIdsV1,
  gateKnowledgeUniversalClaimsV1,
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeAcceptedSourceTupleV1,
  hashKnowledgeStrategyExecutionRequestV1,
  hashKnowledgeStrategyDependencyEvidenceInputV1,
  hashKnowledgeStrategyPassageItemV1,
  hashKnowledgeStrategyPassageItemsV1,
  hashKnowledgeStrategyStepRequestV1,
  hashKnowledgeStrategyStepReceiptV1,
  hashKnowledgeStrategySummaryEvidenceSetV2,
  hashKnowledgeStrategyStepTemplateV1,
  hashKnowledgeStrategySourceProcessedItemsV1,
  hashKnowledgeStrategyTargetEvidenceItemsV1,
  hashKnowledgeStrategyTargetSetV1,
  knowledgeStrategyInvariantReasonCodesV1,
  knowledgeStrategyTemplateInvariantReasonCodesV1,
  materializeKnowledgeStrategyStepRequestV1,
  sealKnowledgeStrategyExecutionRequestV1,
  sealKnowledgeStrategyCoverageReceiptV1,
  sealKnowledgeStrategyStepEvidenceV1,
  validateKnowledgeStrategyStepMaterializationV1,
  validateKnowledgeStrategyDagV1,
  KNOWLEDGE_STRATEGY_EXECUTION_VERSION,
  KNOWLEDGE_STRATEGY_MAX_PAGE_ORDINAL,
  KNOWLEDGE_STRATEGY_MAX_SOURCES,
  type KnowledgeAcceptedSourceTupleV1,
  type KnowledgeMeasuredStrategy,
  type KnowledgeStrategyCoverageRequestV1,
  type KnowledgeStrategyDependencyV1,
  type KnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyPassageItemV1,
  type KnowledgeStrategySourceOutcomeV1,
  type KnowledgeStrategyStepLifecycleV1,
  type KnowledgeStrategyStepReceiptV1,
  type KnowledgeStrategyStepRequestV1,
  type KnowledgeStrategyTargetOutcomeV1
} from "./knowledgeStrategyExecution";

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalFixtureJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" ||
    typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalFixtureJson).join(",")}]`;
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalFixtureJson(record[key])}`).join(",")}}`;
  }
  throw new Error("canonical_fixture_invalid");
}

function canonicalDigest(value: unknown): string {
  return digest(canonicalFixtureJson(value));
}

function source(
  ordinal: number,
  passageCount = 2
): KnowledgeAcceptedSourceTupleV1 {
  const value = {
    bindingId: `binding-${ordinal}`,
    hierarchicalArtifactId: `hierarchical-${ordinal}`,
    hierarchicalChecksum: digest(`hierarchical-${ordinal}`),
    ordinal,
    passageCount,
    sourceAlias: `S${ordinal + 1}`,
    sourceArtifactId: `artifact-${ordinal}`,
    sourceId: `source-${ordinal}`,
    sourceVersionId: `version-${ordinal}`,
    sourceVersionNumber: ordinal + 1,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  };
  const decoded = decodeKnowledgeAcceptedSourceTupleV1(value);
  if (!decoded) throw new Error("source_fixture_invalid");
  return decoded;
}

function sourceSet(
  values: readonly KnowledgeAcceptedSourceTupleV1[] = [source(0), source(1)]
): readonly KnowledgeAcceptedSourceTupleV1[] {
  const decoded = decodeKnowledgeAcceptedSourceSetV1(values);
  if (!decoded) throw new Error("source_set_fixture_invalid");
  return decoded;
}

function fullContextExecution(
  sources = sourceSet()
): KnowledgeStrategyExecutionRequestV1 {
  return sealKnowledgeStrategyExecutionRequestV1({
    config: {
      expectedPassageCount: sources.reduce((sum, entry) => sum + entry.passageCount, 0),
      fallback: "corpus_summary",
      kind: "full_context"
    },
    executionId: "execution-1",
    modelRunId: "run-1",
    plannerVersion: 3,
    sourceSet: sources,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sources),
    strategy: "full_context",
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

function exhaustiveExecution(
  sources = sourceSet()
): KnowledgeStrategyExecutionRequestV1 {
  return sealKnowledgeStrategyExecutionRequestV1({
    config: {
      expectedPassageCount: sources.reduce((sum, entry) => sum + entry.passageCount, 0),
      kind: "exhaustive",
      queryHash: digest("exhaustive-query")
    },
    executionId: "execution-exhaustive",
    modelRunId: "run-1",
    plannerVersion: 3,
    sourceSet: sources,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sources),
    strategy: "exhaustive",
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

function comparisonExecution(
  sources = sourceSet()
): KnowledgeStrategyExecutionRequestV1 {
  const targets = sources.map((entry, ordinal) => ({
    admission: "resolved" as const,
    ordinal,
    referenceHash: digest(`target-${ordinal}`),
    sourceBindingId: entry.bindingId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  }));
  return sealKnowledgeStrategyExecutionRequestV1({
    config: {
      dimensionHash: digest("same-comparison-dimensions"),
      kind: "comparison",
      targetSetHash: hashKnowledgeStrategyTargetSetV1(targets),
      targets
    },
    executionId: "execution-comparison",
    modelRunId: "run-1",
    plannerVersion: 3,
    sourceSet: sources,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sources),
    strategy: "comparison",
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

function corpusSummaryExecution(
  sources = sourceSet()
): KnowledgeStrategyExecutionRequestV1 {
  return sealKnowledgeStrategyExecutionRequestV1({
    config: {
      expectedPassageCount: sources.reduce((sum, entry) => sum + entry.passageCount, 0),
      kind: "corpus_summary",
      mapInputHash: digest("summary-map"),
      reduceInputHash: digest("summary-reduce")
    },
    executionId: "execution-summary",
    modelRunId: "run-1",
    plannerVersion: 3,
    sourceSet: sources,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sources),
    strategy: "corpus_summary",
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

function multiHopExecution(
  sources = sourceSet()
): KnowledgeStrategyExecutionRequestV1 {
  return sealKnowledgeStrategyExecutionRequestV1({
    config: {
      atomicQuestionHashes: [digest("atomic-a"), digest("atomic-b")],
      kind: "multi_hop"
    },
    executionId: "execution-hop",
    modelRunId: "run-1",
    plannerVersion: 3,
    sourceSet: sources,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sources),
    strategy: "multi_hop",
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

function strategyKind(strategy: KnowledgeMeasuredStrategy) {
  return ({
    comparison: "comparison_target",
    corpus_summary: "corpus_summary_map",
    exhaustive: "exhaustive_page",
    full_context: "full_context_page",
    multi_hop: "multi_hop_root"
  } as const)[strategy];
}

function step(
  execution: KnowledgeStrategyExecutionRequestV1,
  overrides: Partial<KnowledgeStrategyStepRequestV1> = {}
): KnowledgeStrategyStepRequestV1 {
  const kind = overrides.kind ?? strategyKind(execution.strategy);
  const sourceBindingId = overrides.sourceBindingId ??
    (kind === "corpus_summary_reduce" || kind === "multi_hop_root" ||
      kind === "multi_hop_follow_up" ? null : execution.sourceSet[0]!.bindingId);
  const targetOrdinal = kind === "comparison_target"
    ? (overrides.targetOrdinal ?? 0)
    : null;
  const comparisonDimensionHash = kind === "comparison_target" &&
    execution.config.kind === "comparison"
    ? execution.config.dimensionHash
    : null;
  const evidenceInputHash = kind === "multi_hop_follow_up" ||
    kind === "corpus_summary_reduce"
    ? digest("resolved-evidence-input")
    : null;
  const defaultInputHash = execution.config.kind === "exhaustive"
    ? execution.config.queryHash
    : execution.config.kind === "corpus_summary"
      ? kind === "corpus_summary_reduce"
        ? execution.config.reduceInputHash
        : execution.config.mapInputHash
      : execution.config.kind === "multi_hop"
        ? execution.config.atomicQuestionHashes[0]!
        : digest(`${kind}-input`);
  return createKnowledgeStrategyStepRequestV1({
    comparisonDimensionHash,
    cursor: null,
    evidenceInputHash,
    executionId: execution.executionId,
    inputHash: defaultInputHash,
    kind,
    ordinal: 0,
    pageOrdinal: 0,
    phaseOrdinal: 0,
    required: true,
    sourceBindingId,
    sourceSetHash: execution.sourceSetHash,
    stepId: `${execution.executionId}-step-0`,
    strategy: execution.strategy,
    streamId: `${execution.executionId}-stream-0`,
    targetOrdinal,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION,
    ...overrides
  });
}

function passageItem(
  sourceValue: KnowledgeAcceptedSourceTupleV1,
  passageOrdinal: number
): KnowledgeStrategyPassageItemV1 {
  return {
    contentHash: digest(`content-${sourceValue.bindingId}-${passageOrdinal}`),
    passageId: `passage-${sourceValue.ordinal}-${passageOrdinal}`,
    passageOrdinal,
    sourceArtifactId: sourceValue.sourceArtifactId,
    sourceBindingId: sourceValue.bindingId,
    sourceOrdinal: sourceValue.ordinal,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  };
}

function receipt(
  stepValue: KnowledgeStrategyStepRequestV1,
  overrides: Partial<KnowledgeStrategyStepReceiptV1> = {}
): KnowledgeStrategyStepReceiptV1 {
  return createKnowledgeStrategyStepReceiptV1({
    cursorExhausted: true,
    executionId: stepValue.executionId,
    lastItemHash: digest(`${stepValue.stepId}-last-item`),
    nextCursor: null,
    processedItemCount: 1,
    processedItemsHash: digest(`${stepValue.stepId}-processed-items`),
    reasonCode: null,
    requestHash: hashKnowledgeStrategyStepRequestV1(stepValue),
    status: "succeeded",
    stepId: stepValue.stepId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION,
    ...overrides
  });
}

function sourceOutcome(
  sourceValue: KnowledgeAcceptedSourceTupleV1,
  overrides: Partial<KnowledgeStrategySourceOutcomeV1> = {}
): KnowledgeStrategySourceOutcomeV1 {
  return {
    cursorExhausted: true,
    expectedPassageCount: sourceValue.passageCount,
    processedItemsHash: digest(`${sourceValue.bindingId}-processed-items`),
    processedPassageCount: sourceValue.passageCount,
    reasonCode: null,
    sourceBindingId: sourceValue.bindingId,
    status: "covered",
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION,
    ...overrides
  };
}

function exactDispatch(itemCount = 2) {
  const itemsHash = digest(`dispatch-${itemCount}`);
  return {
    excludedItemCount: 0,
    expectedItemCount: itemCount,
    expectedItemsHash: itemsHash,
    includedItemCount: itemCount,
    includedItemsHash: itemsHash,
    manifestHash: digest("manifest"),
    shortenedItemCount: 0,
    unavailableItemCount: 0,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  };
}

function coverageRequest(
  execution: KnowledgeStrategyExecutionRequestV1,
  steps: readonly KnowledgeStrategyStepRequestV1[],
  overrides: Partial<KnowledgeStrategyCoverageRequestV1> = {}
): KnowledgeStrategyCoverageRequestV1 {
  const {
    sourceOutcomes: sourceOutcomeOverrides,
    stepReceipts: stepReceiptOverrides,
    targetOutcomes: targetOutcomeOverrides,
    ...remainingOverrides
  } = overrides;
  const stepReceipts = stepReceiptOverrides ?? steps.map((entry) => receipt(entry));
  const sourceOutcomes = (sourceOutcomeOverrides ??
    execution.sourceSet.map((entry) => sourceOutcome(entry))).map((outcome) => ({
      ...outcome,
      processedItemsHash: hashKnowledgeStrategySourceProcessedItemsV1(
        outcome.sourceBindingId,
        steps,
        stepReceipts
      )
    }));
  const targetOutcomes = (targetOutcomeOverrides ?? []).map((outcome) => ({
    ...outcome,
    evidenceItemsHash: hashKnowledgeStrategyTargetEvidenceItemsV1(
      outcome.ordinal,
      steps,
      stepReceipts
    )
  }));
  const defaultDispatchItemCount = execution.strategy === "full_context" ||
    execution.strategy === "exhaustive"
    ? execution.sourceSet.reduce((sum, entry) => sum + entry.passageCount, 0)
    : execution.strategy === "corpus_summary"
      ? execution.sourceSet.reduce((sum, entry) => sum + entry.passageCount, 0)
      : execution.strategy === "comparison" && execution.config.kind === "comparison"
        ? execution.config.targets.length
        : steps.filter(({ kind }) => kind === "multi_hop_root").length;
  return createKnowledgeStrategyCoverageRequestV1({
    dependencies: [],
    dispatch: exactDispatch(defaultDispatchItemCount),
    executionHash: hashKnowledgeStrategyExecutionRequestV1(execution),
    mapOutputReceipts: [],
    observedSourceSet: execution.sourceSet,
    observedSourceSetHash: execution.sourceSetHash,
    sourceOutcomes,
    stepReceipts,
    steps,
    summaryDispatchBindings: [],
    targetOutcomes,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION,
    ...remainingOverrides
  });
}

describe("Knowledge strategy frozen identities", () => {
  it("accepts exactly the 999-Source admission boundary and rejects S1000", () => {
    const maximumSourceSet = Array.from(
      { length: KNOWLEDGE_STRATEGY_MAX_SOURCES },
      (_, ordinal) => source(ordinal, 0)
    );
    const lastSource = maximumSourceSet.at(-1)!;
    const overflowSource = {
      ...lastSource,
      bindingId: "binding-overflow",
      hierarchicalArtifactId: "hierarchical-overflow",
      hierarchicalChecksum: digest("hierarchical-overflow"),
      ordinal: KNOWLEDGE_STRATEGY_MAX_SOURCES,
      sourceAlias: `S${KNOWLEDGE_STRATEGY_MAX_SOURCES + 1}`,
      sourceArtifactId: "artifact-overflow",
      sourceId: "source-overflow",
      sourceVersionId: "version-overflow"
    };

    expect(KNOWLEDGE_STRATEGY_MAX_SOURCES).toBe(999);
    expect(decodeKnowledgeAcceptedSourceSetV1(maximumSourceSet)?.at(-1)).toEqual(lastSource);
    expect(lastSource).toMatchObject({ ordinal: 998, sourceAlias: "S999" });
    expect(decodeKnowledgeAcceptedSourceTupleV1(overflowSource)).toBeNull();
    expect(decodeKnowledgeAcceptedSourceSetV1([...maximumSourceSet, overflowSource]))
      .toBeNull();
  });

  it("hashes accepted Sources canonically while preserving ready-set ordinal gaps", () => {
    const gapped = [source(2), source(0)];
    const decoded = decodeKnowledgeAcceptedSourceSetV1(gapped);

    expect(decoded?.map(({ ordinal, sourceAlias }) => [ordinal, sourceAlias])).toEqual([
      [0, "S1"],
      [2, "S3"]
    ]);
    expect(hashKnowledgeAcceptedSourceSetV1(gapped))
      .toBe(hashKnowledgeAcceptedSourceSetV1([...gapped].reverse()));
    expect(hashKnowledgeAcceptedSourceTupleV1(source(0))).toMatch(/^[0-9a-f]{64}$/u);
    expect(decodeKnowledgeAcceptedSourceSetV1([source(0), source(0)])).toBeNull();
    expect(decodeKnowledgeAcceptedSourceSetV1([
      source(0, 5_000_001),
      source(1, 5_000_001)
    ])).toBeNull();
    expect(decodeKnowledgeAcceptedSourceTupleV1({ ...source(0), unknown: true })).toBeNull();
  });

  it("binds passage ordering, content identity, and the next cursor", () => {
    const execution = fullContextExecution(sourceSet([source(0, 3)]));
    const firstStep = step(execution);
    const first = passageItem(execution.sourceSet[0]!, 0);
    const second = passageItem(execution.sourceSet[0]!, 1);
    const cursor = createKnowledgeStrategyNextCursorV1(firstStep, second);

    expect(hashKnowledgeStrategyPassageItemV1(first)).not
      .toBe(hashKnowledgeStrategyPassageItemV1(second));
    expect(hashKnowledgeStrategyPassageItemsV1([first, second])).toMatch(/^[0-9a-f]{64}$/u);
    expect(() => hashKnowledgeStrategyPassageItemsV1([second, first]))
      .toThrow("knowledge_strategy_passage_items_not_stable");
    expect(cursor).toEqual({
      executionId: execution.executionId,
      nextPassageOrdinal: 2,
      pageOrdinal: 1,
      previousItemHash: hashKnowledgeStrategyPassageItemV1(second),
      sourceBindingId: execution.sourceSet[0]!.bindingId,
      sourceOrdinal: 0,
      streamId: firstStep.streamId,
      version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
    });
    expect(decodeKnowledgeStrategyCursorV1({ ...cursor, extra: true })).toBeNull();

    const lastPageStep = step(execution, {
      cursor: {
        ...cursor,
        pageOrdinal: KNOWLEDGE_STRATEGY_MAX_PAGE_ORDINAL
      },
      pageOrdinal: KNOWLEDGE_STRATEGY_MAX_PAGE_ORDINAL
    });
    expect(() => createKnowledgeStrategyNextCursorV1(lastPageStep, second))
      .toThrow("knowledge_strategy_cursor_boundary_mismatch");
  });
});

describe("Knowledge strategy execution and step codecs", () => {
  it("seals one immutable canonical plan and rejects drift or unknown keys", () => {
    const execution = fullContextExecution();
    const reversed = {
      ...execution,
      sourceSet: [...execution.sourceSet].reverse()
    };

    expect(createKnowledgeStrategyExecutionRequestV1(reversed)).toEqual(execution);
    expect(canonicalKnowledgeStrategyExecutionRequestV1(reversed))
      .toBe(canonicalKnowledgeStrategyExecutionRequestV1(execution));
    expect(Object.isFrozen(execution)).toBe(true);
    expect(Object.isFrozen(execution.sourceSet)).toBe(true);
    expect(decodeKnowledgeStrategyExecutionRequestV1({
      ...execution,
      planHash: digest("wrong")
    })).toBeNull();
    expect(decodeKnowledgeStrategyExecutionRequestV1({ ...execution, rawQuery: "private" }))
      .toBeNull();
  });

  it("keeps embedding-free result evidence small, strict, and independently decodable", () => {
    const execution = fullContextExecution();
    const request = step(execution);
    const result = receipt(request);
    const evidence = sealKnowledgeStrategyStepEvidenceV1(request, result);

    expect(decodeKnowledgeStrategyStepEvidenceV1(evidence)).toEqual(evidence);
    expect(decodeKnowledgeStrategyStepEvidenceV1({ ...evidence, resultHash: "bad" })).toBeNull();
    expect(() => sealKnowledgeStrategyStepEvidenceV1(request, {
      ...result,
      requestHash: digest("different-request")
    })).toThrow("knowledge_strategy_step_evidence_binding_mismatch");
    expect(decodeKnowledgeStrategyStepRequestV1({ ...request, embedding: "required" }))
      .toBeNull();
  });
});

describe("Knowledge strategy one-time step materialization", () => {
  it("materializes a continuation cursor only from its settled direct predecessor", () => {
    const execution = fullContextExecution(sourceSet([source(0, 2)]));
    const first = step(execution, { stepId: "materialize-page-0", streamId: "page-stream" });
    const lastItem = passageItem(execution.sourceSet[0]!, 0);
    const nextCursor = createKnowledgeStrategyNextCursorV1(first, lastItem);
    const firstReceipt = receipt(first, {
      cursorExhausted: false,
      lastItemHash: nextCursor.previousItemHash,
      nextCursor
    });
    const template = createKnowledgeStrategyStepTemplateV1({
      ...first,
      cursor: null,
      materializationMode: "cursor_from_predecessor",
      ordinal: 1,
      pageOrdinal: 1,
      stepId: "materialize-page-1"
    });
    const dependencies = [dependency(execution.executionId, first.stepId, template.stepId)];
    const prerequisites = [{ receipt: firstReceipt, request: first }];
    const firstTemplate = createKnowledgeStrategyStepTemplateV1({
      ...first,
      materializationMode: "complete"
    });
    const materialized = materializeKnowledgeStrategyStepRequestV1(
      template,
      dependencies,
      prerequisites
    );

    expect(materialized?.cursor).toEqual(nextCursor);
    expect(knowledgeStrategyTemplateInvariantReasonCodesV1(
      execution,
      [firstTemplate, template],
      dependencies
    )).toEqual([]);
    expect(hashKnowledgeStrategyStepTemplateV1(template)).toMatch(/^[0-9a-f]{64}$/u);
    expect(validateKnowledgeStrategyStepMaterializationV1(
      template,
      materialized,
      dependencies,
      prerequisites
    )).toBe(true);
    expect(materializeKnowledgeStrategyStepRequestV1(template, dependencies, [])).toBeNull();
    expect(validateKnowledgeStrategyStepMaterializationV1(
      template,
      { ...materialized, inputHash: digest("replanned-input") },
      dependencies,
      prerequisites
    )).toBe(false);
  });

  it("derives each follow-up evidence hash from its settled predecessor", () => {
    const execution = multiHopExecution();
    if (execution.config.kind !== "multi_hop") throw new Error("multi_hop_fixture_invalid");
    const root = step(execution, {
      inputHash: execution.config.atomicQuestionHashes[0],
      ordinal: 0,
      stepId: "materialize-root-0",
      streamId: "materialize-root-stream-0"
    });
    const provisional = step(execution, {
      inputHash: execution.config.atomicQuestionHashes[1],
      kind: "multi_hop_follow_up",
      ordinal: 1,
      stepId: "materialize-follow-up",
      streamId: "materialize-follow-up-stream"
    });
    const template = createKnowledgeStrategyStepTemplateV1({
      ...provisional,
      evidenceInputHash: null,
      materializationMode: "evidence_from_prerequisites"
    });
    const dependencies = [dependency(execution.executionId, root.stepId, template.stepId)];
    const prerequisites = [{
      receipt: receipt(root),
      request: root
    }];
    const rootTemplate = createKnowledgeStrategyStepTemplateV1({
      ...root,
      materializationMode: "complete"
    });
    const expectedEvidence = deriveKnowledgeStrategyDependencyEvidenceInputV1(
      execution.executionId,
      template.stepId,
      dependencies,
      prerequisites.map(({ receipt: prerequisiteReceipt }) => prerequisiteReceipt)
    );
    const materialized = materializeKnowledgeStrategyStepRequestV1(
      template,
      dependencies,
      prerequisites
    );

    expect(expectedEvidence).not.toBeNull();
    expect(knowledgeStrategyTemplateInvariantReasonCodesV1(
      execution,
      [rootTemplate, template],
      dependencies
    )).toEqual([]);
    expect(materialized?.evidenceInputHash).toBe(
      hashKnowledgeStrategyDependencyEvidenceInputV1(expectedEvidence)
    );
    expect(validateKnowledgeStrategyStepMaterializationV1(
      template,
      materialized,
      dependencies,
      prerequisites
    )).toBe(true);
    expect(materializeKnowledgeStrategyStepRequestV1(
      template,
      dependencies,
      []
    )).toBeNull();
    expect(() => createKnowledgeStrategyStepTemplateV1({
      ...template,
      evidenceInputHash: digest("fabricated-at-plan-time")
    })).toThrow("knowledge_strategy_step_template_invalid");
  });
});

function dependency(
  executionId: string,
  prerequisiteStepId: string,
  dependentStepId: string
): KnowledgeStrategyDependencyV1 {
  return createKnowledgeStrategyDependencyV1({
    dependentStepId,
    executionId,
    prerequisiteStepId,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
}

describe("Knowledge strategy DAG and eligibility", () => {
  it("returns a stable topological order and only dependency-settled pending steps", () => {
    const execution = fullContextExecution();
    const first = step(execution, {
      sourceBindingId: execution.sourceSet[0]!.bindingId,
      stepId: "dag-first",
      streamId: "dag-stream-first"
    });
    const second = step(execution, {
      ordinal: 1,
      sourceBindingId: execution.sourceSet[1]!.bindingId,
      stepId: "dag-second",
      streamId: "dag-stream-second"
    });
    const edge = dependency(execution.executionId, first.stepId, second.stepId);

    expect(validateKnowledgeStrategyDagV1(execution.executionId, [second, first], [edge]))
      .toEqual({ topologicalStepIds: [first.stepId, second.stepId], valid: true });
    expect(eligibleKnowledgeStrategyStepIdsV1(
      execution.executionId,
      [first, second],
      [edge],
      [
        {
          executionId: execution.executionId,
          resultStatus: "succeeded",
          state: "settled",
          stepId: first.stepId,
          version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
        },
        {
          executionId: execution.executionId,
          resultStatus: null,
          state: "pending",
          stepId: second.stepId,
          version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
        }
      ]
    )).toEqual([second.stepId]);
  });

  it.each([
    ["self_dependency", (execution: KnowledgeStrategyExecutionRequestV1,
      first: KnowledgeStrategyStepRequestV1) => [
      dependency(execution.executionId, first.stepId, first.stepId)
    ]],
    ["missing_step", (execution: KnowledgeStrategyExecutionRequestV1,
      first: KnowledgeStrategyStepRequestV1) => [
      dependency(execution.executionId, first.stepId, "unknown-step")
    ]],
    ["cross_execution", (_execution: KnowledgeStrategyExecutionRequestV1,
      first: KnowledgeStrategyStepRequestV1) => [
      dependency("other-execution", first.stepId, "second-step")
    ]]
  ])("rejects %s DAG edges", (reason, edgeFactory) => {
    const execution = fullContextExecution();
    const first = step(execution, { stepId: "first-step" });
    const second = step(execution, {
      ordinal: 1,
      sourceBindingId: execution.sourceSet[1]!.bindingId,
      stepId: "second-step",
      streamId: "second-stream"
    });

    expect(validateKnowledgeStrategyDagV1(
      execution.executionId,
      [first, second],
      edgeFactory(execution, first)
    )).toEqual({ reason, valid: false });
  });

  it("rejects a cycle and duplicate dependency without scheduling work", () => {
    const execution = fullContextExecution();
    const first = step(execution, { stepId: "cycle-first" });
    const second = step(execution, {
      ordinal: 1,
      sourceBindingId: execution.sourceSet[1]!.bindingId,
      stepId: "cycle-second",
      streamId: "cycle-stream-second"
    });
    const forward = dependency(execution.executionId, first.stepId, second.stepId);
    const backward = dependency(execution.executionId, second.stepId, first.stepId);

    expect(validateKnowledgeStrategyDagV1(
      execution.executionId,
      [first, second],
      [forward, backward]
    )).toEqual({ reason: "cycle", valid: false });
    expect(validateKnowledgeStrategyDagV1(
      execution.executionId,
      [first, second],
      [forward, forward]
    )).toEqual({ reason: "duplicate_dependency", valid: false });
    expect(eligibleKnowledgeStrategyStepIdsV1(
      execution.executionId,
      [first, second],
      [forward, backward],
      []
    )).toEqual([]);
  });
});

function pendingLifecycle(): KnowledgeStrategyStepLifecycleV1 {
  const value = decodeKnowledgeStrategyStepLifecycleV1({
    attemptCount: 0,
    executionId: "lifecycle-execution",
    failureCode: null,
    irreversibleDispatch: false,
    leaseExpiresAt: null,
    leaseToken: null,
    receiptHash: null,
    state: "pending",
    stateVersion: 0,
    stepId: "lifecycle-step",
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  });
  if (!value) throw new Error("lifecycle_fixture_invalid");
  return value;
}

describe("Knowledge strategy step lifecycle CAS", () => {
  it("claims, fences irreversible dispatch, marks ambiguity, and scrubs purge state", () => {
    const claimed = applyKnowledgeStrategyStepCasTransitionV1(pendingLifecycle(), {
      action: "claim",
      at: "2026-08-20T00:00:00.000Z",
      expectedLeaseToken: null,
      expectedState: "pending",
      expectedStateVersion: 0,
      failureCode: null,
      leaseExpiresAt: "2026-08-20T00:15:00.000Z",
      leaseToken: "lease-1",
      receiptHash: null
    });
    expect(claimed).toMatchObject({
      kind: "transitioned",
      value: { attemptCount: 1, leaseToken: "lease-1", state: "running", stateVersion: 1 }
    });
    if (claimed.kind !== "transitioned") throw new Error("claim_failed");

    const dispatched = applyKnowledgeStrategyStepCasTransitionV1(claimed.value, {
      action: "mark_dispatched",
      at: "2026-08-20T00:01:00.000Z",
      expectedLeaseToken: "lease-1",
      expectedState: "running",
      expectedStateVersion: 1,
      failureCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      receiptHash: null
    });
    expect(dispatched).toMatchObject({
      kind: "transitioned",
      value: { irreversibleDispatch: true, state: "running", stateVersion: 2 }
    });
    if (dispatched.kind !== "transitioned") throw new Error("dispatch_failed");

    expect(applyKnowledgeStrategyStepCasTransitionV1(dispatched.value, {
      action: "release",
      at: "2026-08-20T00:02:00.000Z",
      expectedLeaseToken: "lease-1",
      expectedState: "running",
      expectedStateVersion: 2,
      failureCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      receiptHash: null
    })).toEqual({ kind: "illegal_transition" });

    const ambiguous = applyKnowledgeStrategyStepCasTransitionV1(dispatched.value, {
      action: "mark_ambiguous",
      at: "2026-08-20T00:03:00.000Z",
      expectedLeaseToken: "lease-1",
      expectedState: "running",
      expectedStateVersion: 2,
      failureCode: "provider_outcome_unknown",
      leaseExpiresAt: null,
      leaseToken: null,
      receiptHash: null
    });
    expect(ambiguous).toMatchObject({
      kind: "transitioned",
      value: { failureCode: "provider_outcome_unknown", state: "ambiguous" }
    });
    if (ambiguous.kind !== "transitioned") throw new Error("ambiguity_failed");

    expect(applyKnowledgeStrategyStepCasTransitionV1(ambiguous.value, {
      action: "purge",
      at: "2026-08-20T01:00:00.000Z",
      expectedLeaseToken: null,
      expectedState: "ambiguous",
      expectedStateVersion: 3,
      failureCode: null,
      leaseExpiresAt: null,
      leaseToken: null,
      receiptHash: null
    })).toMatchObject({
      kind: "transitioned",
      value: {
        failureCode: null,
        irreversibleDispatch: true,
        receiptHash: null,
        state: "purged"
      }
    });
  });

  it("rejects stale CAS and settles only with a content hash", () => {
    expect(applyKnowledgeStrategyStepCasTransitionV1(pendingLifecycle(), {
      action: "claim",
      at: "2026-08-20T00:00:00.000Z",
      expectedLeaseToken: null,
      expectedState: "pending",
      expectedStateVersion: 7,
      failureCode: null,
      leaseExpiresAt: "2026-08-20T00:15:00.000Z",
      leaseToken: "lease-1",
      receiptHash: null
    })).toEqual({ kind: "cas_mismatch" });
    expect(applyKnowledgeStrategyStepCasTransitionV1(pendingLifecycle(), {
      action: "claim",
      at: "2026-08-20T00:15:00.000Z",
      expectedLeaseToken: null,
      expectedState: "pending",
      expectedStateVersion: 0,
      failureCode: null,
      leaseExpiresAt: "2026-08-20T00:15:00.000Z",
      leaseToken: "expired-lease",
      receiptHash: null
    })).toEqual({ kind: "illegal_transition" });
    expect(decodeKnowledgeStrategyStepLifecycleV1({
      ...pendingLifecycle(),
      state: "running"
    })).toBeNull();
  });
});

function oneStepPerSource(
  execution: KnowledgeStrategyExecutionRequestV1,
  kind = strategyKind(execution.strategy)
): readonly KnowledgeStrategyStepRequestV1[] {
  return execution.sourceSet.map((entry, ordinal) => step(execution, {
    kind,
    ordinal,
    sourceBindingId: entry.bindingId,
    stepId: `${execution.executionId}-step-${ordinal}`,
    streamId: `${execution.executionId}-stream-${ordinal}`,
    targetOrdinal: kind === "comparison_target" ? ordinal : null
  }));
}

function completeReceipts(
  steps: readonly KnowledgeStrategyStepRequestV1[],
  execution: KnowledgeStrategyExecutionRequestV1
): readonly KnowledgeStrategyStepReceiptV1[] {
  const sources = new Map(execution.sourceSet.map((entry) => [entry.bindingId, entry]));
  return steps.map((entry) => {
    const count = entry.sourceBindingId === null
      ? 1
      : sources.get(entry.sourceBindingId)?.passageCount ?? 1;
    return receipt(entry, {
      lastItemHash: count === 0 ? null : digest(`${entry.stepId}-last-${count}`),
      processedItemCount: count
    });
  });
}

function targetOutcome(
  execution: KnowledgeStrategyExecutionRequestV1,
  ordinal: number,
  status: "covered" | "not_found" = "covered"
): KnowledgeStrategyTargetOutcomeV1 {
  if (execution.config.kind !== "comparison") throw new Error("comparison_fixture_required");
  const target = execution.config.targets[ordinal]!;
  return {
    evidenceItemCount: status === "covered" ? 1 : 0,
    evidenceItemsHash: digest(`${target.referenceHash}-${status}`),
    ordinal,
    reasonCode: null,
    referenceHash: target.referenceHash,
    sourceBindingId: target.sourceBindingId,
    status,
    version: KNOWLEDGE_STRATEGY_EXECUTION_VERSION
  };
}

describe("Knowledge measured-strategy invariants", () => {
  it("requires one source-local branch with identical dimensions per comparison target", () => {
    const execution = comparisonExecution();
    const steps = oneStepPerSource(execution, "comparison_target");

    expect(knowledgeStrategyInvariantReasonCodesV1(execution, steps, [])).toEqual([]);
    const drifted = steps.map((entry, index) => index === 1
      ? step(execution, {
          ...entry,
          comparisonDimensionHash: digest("different-dimensions")
        })
      : entry);
    expect(knowledgeStrategyInvariantReasonCodesV1(execution, drifted, []))
      .toContain("comparison_dimension_mismatch");
  });

  it("requires every corpus map leaf before its single reduce", () => {
    const execution = corpusSummaryExecution();
    const maps = oneStepPerSource(execution, "corpus_summary_map");
    const reduce = step(execution, {
      kind: "corpus_summary_reduce",
      ordinal: maps.length,
      sourceBindingId: null,
      stepId: "summary-reduce",
      streamId: "summary-reduce-stream"
    });
    const dependencies = maps.map((entry) =>
      dependency(execution.executionId, entry.stepId, reduce.stepId));

    expect(knowledgeStrategyInvariantReasonCodesV1(
      execution,
      [...maps, reduce],
      dependencies
    )).toEqual([]);
    expect(knowledgeStrategyInvariantReasonCodesV1(
      execution,
      [...maps, reduce],
      dependencies.slice(0, 1)
    )).toContain("corpus_summary_reduce_dependency_missing");
  });

  it("requires one atomic root and a linear evidence-fed multi-hop chain", () => {
    const execution = multiHopExecution();
    if (execution.config.kind !== "multi_hop") throw new Error("multi_hop_fixture_invalid");
    const root = step(execution, {
      inputHash: execution.config.atomicQuestionHashes[0],
      ordinal: 0,
      stepId: "hop-root-0",
      streamId: "hop-root-stream-0"
    });
    const followUp = step(execution, {
      inputHash: execution.config.atomicQuestionHashes[1],
      kind: "multi_hop_follow_up",
      ordinal: 1,
      stepId: "hop-follow-up",
      streamId: "hop-follow-up-stream"
    });
    const dependencies = [dependency(execution.executionId, root.stepId, followUp.stepId)];

    expect(knowledgeStrategyInvariantReasonCodesV1(
      execution,
      [root, followUp],
      dependencies
    )).toEqual([]);
    expect(knowledgeStrategyInvariantReasonCodesV1(
      execution,
      [root, followUp],
      []
    )).toContain("multi_hop_follow_up_dependency_missing");
    const syntheticFollowUp = step(execution, {
      inputHash: digest("synthetic-combined-input"),
      kind: "multi_hop_follow_up",
      ordinal: 1,
      stepId: followUp.stepId,
      streamId: followUp.streamId
    });
    expect(knowledgeStrategyInvariantReasonCodesV1(
      execution,
      [root, syntheticFollowUp],
      dependencies
    )).toContain("multi_hop_follow_up_input_mismatch");
  });
});

describe("Knowledge strategy coverage truth table", () => {
  it("verifies full context only for the exact frozen set, completed steps, and exact dispatch", () => {
    const execution = fullContextExecution();
    const steps = oneStepPerSource(execution);
    const request = coverageRequest(execution, steps, {
      stepReceipts: completeReceipts(steps, execution)
    });
    const coverage = deriveKnowledgeStrategyCoverageReceiptV1(execution, request);

    expect(coverage).toMatchObject({
      dispatchManifestHash: request.dispatch.manifestHash,
      processedPassageCount: 4,
      processedSourceCount: 2,
      reasonCodes: [],
      requiredStepCount: 2,
      status: "verified",
      terminalRequiredStepCount: 2,
      totalPassageCount: 4,
      totalSourceCount: 2
    });
    expect(decodeKnowledgeStrategyCoverageReceiptV1(coverage)).toEqual(coverage);
    const { receiptHash: _receiptHash, ...coverageBody } = coverage;
    expect(() => sealKnowledgeStrategyCoverageReceiptV1({
      ...coverageBody,
      processedPassageCount: 0
    })).toThrow("knowledge_strategy_coverage_receipt_body_invalid");
    expect(decodeKnowledgeStrategyCoverageReceiptV1({
      ...coverage,
      dispatchManifestHash: digest("another-manifest")
    })).toBeNull();
  });

  it("follows an exact cursor chain and stays partial while its successor is pending", () => {
    const execution = fullContextExecution(sourceSet([source(0, 2)]));
    const firstStep = step(execution, { stepId: "page-0", streamId: "page-stream" });
    const firstItem = passageItem(execution.sourceSet[0]!, 0);
    const nextCursor = createKnowledgeStrategyNextCursorV1(firstStep, firstItem);
    const secondStep = step(execution, {
      cursor: nextCursor,
      ordinal: 1,
      pageOrdinal: 1,
      stepId: "page-1",
      streamId: "page-stream"
    });
    const edge = dependency(execution.executionId, firstStep.stepId, secondStep.stepId);
    const firstReceipt = receipt(firstStep, {
      cursorExhausted: false,
      lastItemHash: nextCursor.previousItemHash,
      nextCursor,
      processedItemCount: 1
    });
    const secondItem = passageItem(execution.sourceSet[0]!, 1);
    const secondReceipt = receipt(secondStep, {
      lastItemHash: hashKnowledgeStrategyPassageItemV1(secondItem),
      processedItemCount: 1
    });
    const base = {
      dependencies: [edge],
      sourceOutcomes: [sourceOutcome(execution.sourceSet[0]!)],
      stepReceipts: [firstReceipt, secondReceipt]
    };

    expect(deriveKnowledgeStrategyCoverageReceiptV1(
      execution,
      coverageRequest(execution, [firstStep, secondStep], base)
    ).status).toBe("verified");
    const partial = deriveKnowledgeStrategyCoverageReceiptV1(
      execution,
      coverageRequest(execution, [firstStep, secondStep], {
        dependencies: [edge],
        sourceOutcomes: [],
        stepReceipts: [firstReceipt]
      })
    );
    expect(partial.status).toBe("partial");
    expect(partial.reasonCodes).toEqual(expect.arrayContaining([
      "cursor_successor_pending",
      "required_step_pending",
      "source_outcome_pending"
    ]));
  });

  it("degrades failure, unavailable evidence, shortening, and frozen-set drift", () => {
    const execution = fullContextExecution();
    const steps = oneStepPerSource(execution);
    const successfulReceipts = completeReceipts(steps, execution);
    const failedReceipt = receipt(steps[0]!, {
      cursorExhausted: false,
      lastItemHash: digest("failed-last"),
      nextCursor: null,
      processedItemCount: 1,
      reasonCode: "enumeration_failed",
      status: "failed"
    });
    const failed = deriveKnowledgeStrategyCoverageReceiptV1(execution, coverageRequest(
      execution,
      steps,
      {
        sourceOutcomes: [
          sourceOutcome(execution.sourceSet[0]!, {
            cursorExhausted: false,
            processedPassageCount: 1,
            reasonCode: "enumeration_failed",
            status: "failed"
          }),
          sourceOutcome(execution.sourceSet[1]!)
        ],
        stepReceipts: [failedReceipt, successfulReceipts[1]!]
      }
    ));
    expect(failed.status).toBe("degraded");
    expect(failed.reasonCodes).toEqual(expect.arrayContaining([
      "source_failed",
      "step_failed"
    ]));

    const shortenedDispatch = {
      ...exactDispatch(steps.length),
      shortenedItemCount: 1
    };
    const shortened = deriveKnowledgeStrategyCoverageReceiptV1(execution, coverageRequest(
      execution,
      steps,
      { dispatch: shortenedDispatch, stepReceipts: successfulReceipts }
    ));
    expect(shortened).toMatchObject({
      reasonCodes: expect.arrayContaining(["dispatch_evidence_incomplete"]),
      status: "degraded"
    });

    const exactRequest = coverageRequest(execution, steps, {
      stepReceipts: successfulReceipts
    });
    const forgedSourceHashRequest = createKnowledgeStrategyCoverageRequestV1({
      ...exactRequest,
      sourceOutcomes: exactRequest.sourceOutcomes.map((outcome, index) => index === 0
        ? { ...outcome, processedItemsHash: digest("forged-source-items") }
        : outcome)
    });
    expect(deriveKnowledgeStrategyCoverageReceiptV1(
      execution,
      forgedSourceHashRequest
    ).reasonCodes).toContain("source_processed_items_hash_mismatch");

    const observed = sourceSet([execution.sourceSet[0]!]);
    const drifted = deriveKnowledgeStrategyCoverageReceiptV1(execution, coverageRequest(
      execution,
      steps,
      {
        observedSourceSet: observed,
        observedSourceSetHash: hashKnowledgeAcceptedSourceSetV1(observed),
        stepReceipts: successfulReceipts
      }
    ));
    expect(drifted).toMatchObject({
      reasonCodes: expect.arrayContaining(["source_set_mismatch"]),
      status: "degraded"
    });
  });

  it("verifies comparison, exhaustive, summary, and multi-hop with strategy-local invariants", () => {
    const comparison = comparisonExecution();
    const comparisonSteps = oneStepPerSource(comparison, "comparison_target");
    const comparisonCoverage = deriveKnowledgeStrategyCoverageReceiptV1(
      comparison,
      coverageRequest(comparison, comparisonSteps, {
        sourceOutcomes: comparison.sourceSet.map((entry) => sourceOutcome(entry, {
          processedPassageCount: 1
        })),
        targetOutcomes: [
          targetOutcome(comparison, 0),
          targetOutcome(comparison, 1, "not_found")
        ]
      })
    );
    expect(comparisonCoverage.status).toBe("verified");
    const comparisonRequest = coverageRequest(comparison, comparisonSteps, {
      sourceOutcomes: comparison.sourceSet.map((entry) => sourceOutcome(entry, {
        processedPassageCount: 1
      })),
      targetOutcomes: [targetOutcome(comparison, 0), targetOutcome(comparison, 1, "not_found")]
    });
    const forgedTargetHashRequest = createKnowledgeStrategyCoverageRequestV1({
      ...comparisonRequest,
      targetOutcomes: comparisonRequest.targetOutcomes.map((outcome, index) => index === 0
        ? { ...outcome, evidenceItemsHash: digest("forged-target-items") }
        : outcome)
    });
    expect(deriveKnowledgeStrategyCoverageReceiptV1(
      comparison,
      forgedTargetHashRequest
    ).reasonCodes).toContain("target_evidence_items_hash_mismatch");

    const exhaustive = exhaustiveExecution();
    const exhaustiveSteps = oneStepPerSource(exhaustive, "exhaustive_page");
    expect(deriveKnowledgeStrategyCoverageReceiptV1(
      exhaustive,
      coverageRequest(exhaustive, exhaustiveSteps, {
        stepReceipts: completeReceipts(exhaustiveSteps, exhaustive)
      })
    ).status).toBe("verified");

    const summary = corpusSummaryExecution();
    const maps = oneStepPerSource(summary, "corpus_summary_map");
    const mapReceipts = completeReceipts(maps, summary);
    const mapOutputReceipts = maps.map((map, sourceOrdinal) => {
      const sourceValue = summary.sourceSet[sourceOrdinal]!;
      const pageReceipt = mapReceipts[sourceOrdinal]!;
      const pageReceiptBindings = [{
        pageOrdinal: 0,
        processedItemCount: pageReceipt.processedItemCount,
        processedItemsHash: pageReceipt.processedItemsHash,
        receiptHash: hashKnowledgeStrategyStepReceiptV1(pageReceipt),
        requestHash: hashKnowledgeStrategyStepRequestV1(map),
        stepId: map.stepId,
        version: 2
      }];
      const body = {
        executionId: summary.executionId,
        inputPageReceiptCount: 1,
        inputPageReceiptsHash: canonicalDigest(pageReceiptBindings),
        inputPassageCount: sourceValue.passageCount,
        inputPassageItemsHash: digest(`map-passages-${sourceOrdinal}`),
        inputSectionCount: 1,
        inputSectionHashesHash: digest(`map-sections-${sourceOrdinal}`),
        mapInputHash: digest(`map-input-${sourceOrdinal}`),
        outputHash: digest(`map-output-${sourceOrdinal}`),
        processedPassageCount: sourceValue.passageCount,
        sourceBindingId: sourceValue.bindingId,
        sourceOrdinal,
        summaryItemCount: 1,
        summaryItemsHash: digest(`map-summary-items-${sourceOrdinal}`),
        terminalStepId: map.stepId,
        version: 2 as const
      };
      return { ...body, receiptHash: canonicalDigest(body) };
    });
    const provisionalReduce = step(summary, {
      kind: "corpus_summary_reduce",
      ordinal: maps.length,
      sourceBindingId: null,
      stepId: "coverage-summary-reduce",
      streamId: "coverage-summary-reduce-stream"
    });
    const summaryDependencies = maps.map((entry) =>
      dependency(summary.executionId, entry.stepId, provisionalReduce.stepId));
    const reduceEvidenceInputHash = deriveKnowledgeStrategyMapOutputDependencyHashV2({
      dependentStepId: provisionalReduce.stepId,
      executionId: summary.executionId,
      receipts: mapOutputReceipts,
      sourceSetHash: summary.sourceSetHash
    });
    const reduce = step(summary, {
      evidenceInputHash: reduceEvidenceInputHash,
      kind: "corpus_summary_reduce",
      ordinal: maps.length,
      sourceBindingId: null,
      stepId: provisionalReduce.stepId,
      streamId: provisionalReduce.streamId
    });
    const summaryDispatchBindings = mapOutputReceipts.map((mapReceipt, sourceOrdinal) => ({
      evidenceHash: digest(`summary-evidence-${sourceOrdinal}`),
      evidenceId: `summary-result:${sourceOrdinal + 1}`,
      itemHash: digest(`summary-item-${sourceOrdinal}`),
      outputHash: mapReceipt.outputHash,
      sourceBindingId: mapReceipt.sourceBindingId,
      sourceOrdinal,
      version: 2 as const
    }));
    const reduceReceipt = receipt(reduce, {
      lastItemHash: digest("coverage-summary-reduce-last-item"),
      processedItemCount: summaryDispatchBindings.length,
      processedItemsHash: hashKnowledgeStrategySummaryEvidenceSetV2(summaryDispatchBindings)
    });
    const summarySteps = [...maps, reduce];
    const dispatchProjection = summaryDispatchBindings.map(({ evidenceId, itemHash }) => ({
      evidenceId,
      itemHash
    }));
    const dispatchHash = canonicalDigest(dispatchProjection);
    const summaryCoverage = deriveKnowledgeStrategyCoverageReceiptV1(
      summary,
      coverageRequest(summary, summarySteps, {
        dependencies: summaryDependencies,
        dispatch: {
          ...exactDispatch(summary.sourceSet.length),
          expectedItemsHash: dispatchHash,
          includedItemsHash: dispatchHash
        },
        mapOutputReceipts,
        stepReceipts: [...mapReceipts, reduceReceipt],
        summaryDispatchBindings
      })
    );
    expect(summaryCoverage).toMatchObject({ reasonCodes: [], status: "verified" });
    const missingSummaryCoverage = deriveKnowledgeStrategyCoverageReceiptV1(
      summary,
      coverageRequest(summary, summarySteps, {
        dependencies: summaryDependencies,
        dispatch: {
          ...exactDispatch(1),
          expectedItemsHash: canonicalDigest(dispatchProjection.slice(0, 1)),
          includedItemsHash: canonicalDigest(dispatchProjection.slice(0, 1))
        },
        mapOutputReceipts,
        stepReceipts: [...mapReceipts, reduceReceipt],
        summaryDispatchBindings: summaryDispatchBindings.slice(0, 1)
      })
    );
    expect(missingSummaryCoverage).toMatchObject({
      reasonCodes: expect.arrayContaining([
        "corpus_summary_dispatch_incomplete",
        "corpus_summary_summary_dispatch_pending"
      ]),
      status: "degraded"
    });
    const forgedSummaryCoverage = deriveKnowledgeStrategyCoverageReceiptV1(
      summary,
      coverageRequest(summary, summarySteps, {
        dependencies: summaryDependencies,
        dispatch: {
          ...exactDispatch(summary.sourceSet.length),
          expectedItemsHash: dispatchHash,
          includedItemsHash: dispatchHash
        },
        mapOutputReceipts,
        stepReceipts: [...mapReceipts, reduceReceipt],
        summaryDispatchBindings: summaryDispatchBindings.map((binding, index) => index === 0
          ? { ...binding, outputHash: digest("forged-map-output") }
          : binding)
      })
    );
    expect(forgedSummaryCoverage).toMatchObject({
      reasonCodes: expect.arrayContaining(["corpus_summary_summary_dispatch_mismatch"]),
      status: "degraded"
    });

    const hop = multiHopExecution();
    if (hop.config.kind !== "multi_hop") throw new Error("multi_hop_fixture_invalid");
    const root = step(hop, {
      inputHash: hop.config.atomicQuestionHashes[0],
      ordinal: 0,
      stepId: "coverage-hop-root-0",
      streamId: "coverage-hop-root-stream-0"
    });
    const rootReceipt = receipt(root);
    const followUpId = "coverage-hop-follow";
    const hopDependencies = [dependency(hop.executionId, root.stepId, followUpId)];
    const dependencyEvidence = deriveKnowledgeStrategyDependencyEvidenceInputV1(
      hop.executionId,
      followUpId,
      hopDependencies,
      [rootReceipt]
    );
    if (!dependencyEvidence) throw new Error("dependency_evidence_fixture_invalid");
    const followUp = step(hop, {
      evidenceInputHash: hashKnowledgeStrategyDependencyEvidenceInputV1(dependencyEvidence),
      inputHash: hop.config.atomicQuestionHashes[1],
      kind: "multi_hop_follow_up",
      ordinal: 1,
      stepId: followUpId,
      streamId: "coverage-hop-follow-stream"
    });
    const hopSteps = [root, followUp];
    const followUpReceipt = receipt(followUp);
    const followUpEvidenceInputHash = followUp.evidenceInputHash;
    if (!followUpEvidenceInputHash) throw new Error("follow_up_evidence_fixture_invalid");
    expect(deriveKnowledgeStrategyCoverageReceiptV1(
      hop,
      coverageRequest(hop, hopSteps, {
        dependencies: hopDependencies,
        dispatch: exactDispatch(hopSteps.length),
        sourceOutcomes: [],
        stepReceipts: [rootReceipt, followUpReceipt]
      })
    ).status).toBe("verified");
    const syntheticReceipt = receipt(followUp, {
      lastItemHash: followUpEvidenceInputHash,
      processedItemsHash: followUpEvidenceInputHash
    });
    expect(deriveKnowledgeStrategyCoverageReceiptV1(
      hop,
      coverageRequest(hop, hopSteps, {
        dependencies: hopDependencies,
        dispatch: exactDispatch(hopSteps.length),
        sourceOutcomes: [],
        stepReceipts: [rootReceipt, syntheticReceipt]
      })
    )).toMatchObject({
      reasonCodes: expect.arrayContaining(["multi_hop_follow_up_evidence_missing"]),
      status: "degraded"
    });
    const forgedFollowUp = step(hop, {
      evidenceInputHash: digest("fabricated-before-prerequisites-settled"),
      inputHash: hop.config.atomicQuestionHashes[1],
      kind: "multi_hop_follow_up",
      ordinal: 1,
      stepId: followUpId,
      streamId: "coverage-hop-follow-stream"
    });
    expect(deriveKnowledgeStrategyCoverageReceiptV1(
      hop,
      coverageRequest(hop, [root, forgedFollowUp], {
        dependencies: hopDependencies,
        dispatch: exactDispatch(hopSteps.length),
        sourceOutcomes: [],
        stepReceipts: [rootReceipt, receipt(forgedFollowUp)]
      })
    )).toMatchObject({
      reasonCodes: expect.arrayContaining(["multi_hop_evidence_input_mismatch"]),
      status: "degraded"
    });
  });
});

describe("Knowledge universal-claim detector and gate", () => {
  it("detects English and Russian positive and negative corpus-wide claims", () => {
    const matches = detectKnowledgeUniversalClaimsV1(
      "No documents mention it. Во всех источниках это есть. Ни в одном файле этого нет. " +
      "Nothing was found across the selected corpus. Весь корпус проверен без исключений. " +
      "All selected documents agree. None of the selected files and no selected sources do."
    );

    expect(matches.map(({ kind, language }) => [kind, language])).toEqual([
      ["negative_none", "en"],
      ["positive_all", "ru"],
      ["negative_none", "ru"],
      ["negative_none", "en"],
      ["positive_all", "ru"],
      ["positive_all", "ru"],
      ["positive_all", "en"],
      ["negative_none", "en"],
      ["negative_none", "en"]
    ]);
    expect(containsKnowledgeNegativeUniversalClaimV1("None of the sources mention it."))
      .toBe(true);
    expect(detectKnowledgeUniversalClaimsV1("The source discusses every option.")).toEqual([]);
  });

  it("allows universal wording only for an exact verified strategy and final manifest", () => {
    const execution = fullContextExecution();
    const steps = oneStepPerSource(execution);
    const request = coverageRequest(execution, steps, {
      stepReceipts: completeReceipts(steps, execution)
    });
    const verified = deriveKnowledgeStrategyCoverageReceiptV1(execution, request);

    expect(gateKnowledgeUniversalClaimsV1(
      "No documents contain another value.",
      verified,
      request.dispatch.manifestHash
    )).toMatchObject({ allowed: true, reasonCodes: [] });
    expect(gateKnowledgeUniversalClaimsV1(
      "Ни в одном выбранном документе этого значения нет.",
      verified,
      request.dispatch.manifestHash
    )).toMatchObject({ allowed: true, reasonCodes: [] });
    expect(gateKnowledgeUniversalClaimsV1(
      "No documents contain another value.",
      verified,
      digest("wrong-manifest")
    )).toMatchObject({
      allowed: false,
      reasonCodes: ["dispatch_manifest_mismatch"]
    });
    expect(gateKnowledgeUniversalClaimsV1(
      "No documents contain another value.",
      verified
    )).toMatchObject({
      allowed: false,
      reasonCodes: ["dispatch_manifest_missing"]
    });

    const partial = deriveKnowledgeStrategyCoverageReceiptV1(execution, coverageRequest(
      execution,
      steps,
      { sourceOutcomes: [], stepReceipts: [] }
    ));
    expect(gateKnowledgeUniversalClaimsV1("All sources agree.", partial)).toMatchObject({
      allowed: false,
      reasonCodes: expect.arrayContaining(["coverage_not_verified", "corpus_not_exhausted"])
    });
    expect(gateKnowledgeUniversalClaimsV1("A cited source reports a value.", null))
      .toMatchObject({ allowed: true, claims: [] });
  });
});
