import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  createPrismaKnowledgeStrategyRepository,
  hydrateKnowledgeStrategyExecutionRow,
  hydrateKnowledgeStrategyMapOutputRow,
  KnowledgeStrategyRepositoryError
} from "./knowledgeStrategyRepository";
import {
  hashKnowledgeAcceptedSourceSetV1,
  hashKnowledgeStrategyCursorV1,
  hashKnowledgeStrategyExecutionRequestV1,
  hashKnowledgeStrategyStepReceiptV1,
  hashKnowledgeStrategyStepRequestV1,
  hashKnowledgeStrategyStepTemplateV1,
  KNOWLEDGE_STRATEGY_MAX_SOURCES,
  materializeKnowledgeStrategyStepRequestV1,
  sealKnowledgeStrategyExecutionRequestV1,
  type KnowledgeStrategyDependencyV1,
  type KnowledgeStrategyStepReceiptV1,
  type KnowledgeStrategyStepTemplateV1
} from "./knowledgeStrategyExecution";

const NOW = new Date("2026-08-20T10:00:00.000Z");

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function fixture() {
  const source = {
    bindingId: "binding-1",
    hierarchicalArtifactId: "hierarchy-1",
    hierarchicalChecksum: digest("hierarchy"),
    ordinal: 0,
    passageCount: 2,
    sourceAlias: "S1",
    sourceArtifactId: "artifact-1",
    sourceId: "source-1",
    sourceVersionId: "source-version-1",
    sourceVersionNumber: 1,
    version: 1 as const
  };
  const sourceSet = [source];
  const execution = sealKnowledgeStrategyExecutionRequestV1({
    config: { expectedPassageCount: 2, fallback: "focused", kind: "full_context" },
    executionId: "execution-1",
    modelRunId: "model-run-1",
    plannerVersion: 1,
    sourceSet,
    sourceSetHash: hashKnowledgeAcceptedSourceSetV1(sourceSet),
    strategy: "full_context",
    version: 1
  });
  const firstTemplate: KnowledgeStrategyStepTemplateV1 = {
    comparisonDimensionHash: null,
    cursor: null,
    evidenceInputHash: null,
    executionId: execution.executionId,
    inputHash: digest("page-input"),
    kind: "full_context_page",
    materializationMode: "complete",
    ordinal: 0,
    pageOrdinal: 0,
    phaseOrdinal: 0,
    required: true,
    sourceBindingId: source.bindingId,
    sourceSetHash: execution.sourceSetHash,
    stepId: "step-1",
    strategy: "full_context",
    streamId: "stream-1",
    targetOrdinal: null,
    version: 1
  };
  const secondTemplate: KnowledgeStrategyStepTemplateV1 = {
    ...firstTemplate,
    materializationMode: "cursor_from_predecessor",
    ordinal: 1,
    pageOrdinal: 1,
    stepId: "step-2"
  };
  const dependencies: readonly KnowledgeStrategyDependencyV1[] = [{
    dependentStepId: secondTemplate.stepId,
    executionId: execution.executionId,
    prerequisiteStepId: firstTemplate.stepId,
    version: 1
  }];
  const firstRequest = materializeKnowledgeStrategyStepRequestV1(
    firstTemplate,
    dependencies,
    []
  );
  if (!firstRequest) throw new Error("strategy_fixture_request_missing");

  const step = (
    template: KnowledgeStrategyStepTemplateV1,
    request: typeof firstRequest | null,
    dependenciesForStep: readonly Readonly<{
      dependsOnStepId: string;
      executionId: string;
      stepId: string;
    }>[]
  ) => ({
    ambiguousAt: null,
    attemptCount: 0,
    cancelledAt: null,
    comparisonDimensionHash: template.comparisonDimensionHash,
    createdAt: NOW,
    cursor: null,
    cursorHash: null,
    dependencies: dependenciesForStep,
    evidenceInputHash: template.evidenceInputHash,
    executionId: template.executionId,
    failedAt: null,
    failureCode: null,
    id: template.stepId,
    idempotencyKey: hashKnowledgeStrategyStepTemplateV1(template),
    includedPassageCount: 0,
    inputHash: template.inputHash,
    ioStartedAt: null,
    irreversibleDispatch: false,
    kind: template.kind,
    leaseExpiresAt: null,
    leaseToken: null,
    materializationMode: template.materializationMode,
    materializedAt: request ? NOW : null,
    modelRunId: execution.modelRunId,
    modelRunToolCallId: template.stepId === "step-1" ? "tool-call-1" : "tool-call-2",
    ordinal: template.ordinal,
    pageOrdinal: template.pageOrdinal,
    phaseOrdinal: template.phaseOrdinal,
    processedItemsHash: null,
    processedPassageCount: 0,
    processedSourceCount: 0,
    providerAttemptId: null,
    purgedAt: null,
    request,
    requestHash: request ? hashKnowledgeStrategyStepRequestV1(request) : null,
    required: template.required,
    result: null,
    resultHash: null,
    settledAt: null,
    sourceBindingId: template.sourceBindingId,
    sourceSetHash: template.sourceSetHash,
    startedAt: null,
    state: "pending",
    stateVersion: 0,
    streamId: template.streamId,
    targetOrdinal: template.targetOrdinal,
    templateHash: hashKnowledgeStrategyStepTemplateV1(template),
    updatedAt: NOW
  });
  const row = {
    ambiguousAt: null,
    cancelledAt: null,
    coverageReceipt: null,
    coverageReceiptHash: null,
    coverageStatus: null,
    createdAt: NOW,
    dispatchManifestHash: null,
    dispatchedPassageCount: 0,
    dispatchSetHash: null,
    executionHash: hashKnowledgeStrategyExecutionRequestV1(execution),
    executionRequest: execution,
    expectedPassageCount: 2,
    expectedSourceCount: 1,
    failedAt: null,
    failureCode: null,
    id: execution.executionId,
    includedPassageCount: 0,
    includedSetHash: null,
    modelRunId: execution.modelRunId,
    planHash: execution.planHash,
    plannerVersion: execution.plannerVersion,
    processedPassageCount: 0,
    processedSetHash: null,
    processedSourceCount: 0,
    purgedAt: null,
    retrievalSessionId: "retrieval-session-1",
    settledAt: null,
    sourceSetHash: execution.sourceSetHash,
    startedAt: null,
    state: "planned",
    steps: [
      step(firstTemplate, firstRequest, []),
      step(secondTemplate, null, [{
        dependsOnStepId: firstTemplate.stepId,
        executionId: execution.executionId,
        stepId: secondTemplate.stepId
      }])
    ],
    strategy: execution.strategy,
    updatedAt: NOW,
    version: 1
  };
  return { dependencies, execution, firstRequest, row, secondTemplate };
}

function fakeClient(row: ReturnType<typeof fixture>["row"]): PrismaClient {
  const normalize = (value: unknown): unknown => value === Prisma.DbNull ? null : value;
  const apply = (target: Record<string, unknown>, data: Record<string, unknown>) => {
    for (const [key, raw] of Object.entries(data)) {
      if (raw === undefined) continue;
      if (typeof raw === "object" && raw !== null && "increment" in raw) {
        target[key] = Number(target[key]) + Number((raw as { increment: number }).increment);
      } else {
        target[key] = normalize(raw);
      }
    }
    target.updatedAt = new Date((target.updatedAt as Date).valueOf() + 1);
  };
  const matches = (candidate: Record<string, unknown>, where: Record<string, unknown>) => {
    for (const [key, expected] of Object.entries(where)) {
      if (key === "leaseExpiresAt" && typeof expected === "object" && expected !== null) {
        const actual = candidate[key] as Date | null;
        const boundary = Object.values(expected)[0] as Date;
        if (!actual || "gt" in expected && !(actual > boundary) ||
          "lte" in expected && !(actual <= boundary)) return false;
      } else if (key === "request" && typeof expected === "object" && expected !== null) {
        if (candidate.request !== null) return false;
      } else if (candidate[key] !== expected) return false;
    }
    return true;
  };
  const tx = {
    knowledgeStrategyExecution: {
      findUnique: async () => row,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        apply(row as unknown as Record<string, unknown>, data);
        return row;
      }
    },
    knowledgeStrategyStep: {
      updateMany: async ({ data, where }: {
        data: Record<string, unknown>;
        where: Record<string, unknown>;
      }) => {
        const candidate = row.steps.find(({ id }) => id === where.id);
        if (!candidate || !matches(candidate as unknown as Record<string, unknown>, where)) {
          return { count: 0 };
        }
        apply(candidate as unknown as Record<string, unknown>, data);
        return { count: 1 };
      }
    }
  };
  return {
    $transaction: async (operation: (value: typeof tx) => unknown) => operation(tx),
    knowledgeStrategyExecution: tx.knowledgeStrategyExecution
  } as unknown as PrismaClient;
}

function firstReceipt(input: Readonly<{
  requestHash: string;
}>): KnowledgeStrategyStepReceiptV1 {
  const lastItemHash = digest("page-0-last-item");
  return {
    cursorExhausted: false,
    executionId: "execution-1",
    lastItemHash,
    nextCursor: {
      executionId: "execution-1",
      nextPassageOrdinal: 1,
      pageOrdinal: 1,
      previousItemHash: lastItemHash,
      sourceBindingId: "binding-1",
      sourceOrdinal: 0,
      streamId: "stream-1",
      version: 1
    },
    processedItemCount: 1,
    processedItemsHash: digest("page-0-items"),
    reasonCode: null,
    requestHash: input.requestHash,
    status: "succeeded",
    stepId: "step-1",
    version: 1
  };
}

describe("knowledge strategy durable repository", () => {
  it("hydrates purged map rows through source ordinal 998 and rejects 999", () => {
    const row = {
      createdAt: NOW,
      executionId: "execution-boundary",
      id: "map-output-boundary",
      inputPageReceiptCount: 1,
      inputPageReceiptsHash: null,
      inputPassageCount: 1,
      inputPassageItemsHash: null,
      inputSectionCount: 1,
      inputSectionHashesHash: null,
      mapInputHash: null,
      modelRunId: "model-run-boundary",
      output: null,
      outputHash: null,
      processedPassageCount: 1,
      purgedAt: NOW,
      receipt: null,
      receiptHash: null,
      settledAt: NOW,
      sourceBindingId: null,
      sourceOrdinal: KNOWLEDGE_STRATEGY_MAX_SOURCES - 1,
      state: "purged",
      summaryItemCount: 1,
      summaryItemsHash: null,
      terminalStepId: "map-step-boundary",
      updatedAt: NOW,
      version: 2
    };

    expect(hydrateKnowledgeStrategyMapOutputRow(row as never).sourceOrdinal).toBe(998);
    expect(() => hydrateKnowledgeStrategyMapOutputRow({
      ...row,
      sourceOrdinal: KNOWLEDGE_STRATEGY_MAX_SOURCES
    } as never)).toThrow(KnowledgeStrategyRepositoryError);
  });

  it("strictly hydrates a frozen DAG with an unmaterialized continuation", () => {
    const { row } = fixture();
    const stored = hydrateKnowledgeStrategyExecutionRow(row as never);

    expect(stored.state).toBe("planned");
    expect(stored.steps[0]?.request).not.toBeNull();
    expect(stored.steps[1]?.request).toBeNull();
    expect(stored.steps[1]?.template?.materializationMode)
      .toBe("cursor_from_predecessor");

    row.steps[0]!.templateHash = digest("corrupt-template");
    expect(() => hydrateKnowledgeStrategyExecutionRow(row as never))
      .toThrow(KnowledgeStrategyRepositoryError);
  });

  it("reclaims only expired pre-I/O work, fences the old lease, and materializes from receipt", async () => {
    const { firstRequest, row } = fixture();
    const repository = createPrismaKnowledgeStrategyRepository(fakeClient(row));
    const firstClaim = await repository.claimToolCallStep({
      leaseExpiresAt: new Date("2026-08-20T10:05:00.000Z"),
      leaseToken: "lease:first-worker",
      modelRunId: "model-run-1",
      modelRunToolCallId: "tool-call-1",
      now: NOW
    });
    expect(firstClaim.kind).toBe("claimed");
    if (firstClaim.kind !== "claimed") throw new Error("first_claim_missing");

    const receipt = firstReceipt({ requestHash: hashKnowledgeStrategyStepRequestV1(firstRequest) });
    await repository.settleStep({
      at: new Date("2026-08-20T10:01:00.000Z"),
      executionId: "execution-1",
      leaseToken: firstClaim.leaseToken,
      receipt,
      stateVersion: firstClaim.step.lifecycle.stateVersion,
      stepId: "step-1"
    });
    const materialized = await repository.materializeStepRequest({
      at: new Date("2026-08-20T10:01:01.000Z"),
      executionId: "execution-1",
      stepId: "step-2"
    });
    expect(materialized.step.request?.cursor &&
      hashKnowledgeStrategyCursorV1(materialized.step.request.cursor))
      .toBe(hashKnowledgeStrategyCursorV1(receipt.nextCursor));

    const secondClaim = await repository.claimToolCallStep({
      leaseExpiresAt: new Date("2026-08-20T10:02:00.000Z"),
      leaseToken: "lease:expired-worker",
      modelRunId: "model-run-1",
      modelRunToolCallId: "tool-call-2",
      now: new Date("2026-08-20T10:01:02.000Z")
    });
    expect(secondClaim.kind).toBe("claimed");
    if (secondClaim.kind !== "claimed") throw new Error("second_claim_missing");

    const reclaimed = await repository.claimToolCallStep({
      leaseExpiresAt: new Date("2026-08-20T10:10:00.000Z"),
      leaseToken: "lease:recovery-worker",
      modelRunId: "model-run-1",
      modelRunToolCallId: "tool-call-2",
      now: new Date("2026-08-20T10:03:00.000Z")
    });
    expect(reclaimed.kind).toBe("claimed");
    if (reclaimed.kind !== "claimed") throw new Error("reclaim_missing");
    expect(reclaimed.step.lifecycle.attemptCount).toBe(2);
    expect(reclaimed.step.lifecycle.stateVersion).toBe(
      secondClaim.step.lifecycle.stateVersion + 2
    );

    const exhaustedReceipt: KnowledgeStrategyStepReceiptV1 = {
      cursorExhausted: true,
      executionId: "execution-1",
      lastItemHash: digest("page-1-last-item"),
      nextCursor: null,
      processedItemCount: 1,
      processedItemsHash: digest("page-1-items"),
      reasonCode: null,
      requestHash: hashKnowledgeStrategyStepRequestV1(reclaimed.step.request),
      status: "succeeded",
      stepId: "step-2",
      version: 1
    };
    await expect(repository.settleStep({
      at: new Date("2026-08-20T10:03:01.000Z"),
      executionId: "execution-1",
      leaseToken: secondClaim.leaseToken,
      receipt: exhaustedReceipt,
      stateVersion: secondClaim.step.lifecycle.stateVersion,
      stepId: "step-2"
    })).rejects.toMatchObject({ code: "cas_mismatch" });

    const settled = await repository.settleStep({
      at: new Date("2026-08-20T10:03:01.000Z"),
      executionId: "execution-1",
      leaseToken: reclaimed.leaseToken,
      receipt: exhaustedReceipt,
      stateVersion: reclaimed.step.lifecycle.stateVersion,
      stepId: "step-2"
    });
    expect(settled.step.lifecycle.state).toBe("settled");
    expect(hashKnowledgeStrategyStepReceiptV1(settled.step.receipt))
      .toBe(hashKnowledgeStrategyStepReceiptV1(exhaustedReceipt));
  });

  it("never reclaims dispatched work and can settle an expired fenced lease as ambiguous", async () => {
    const { firstRequest, row } = fixture();
    const repository = createPrismaKnowledgeStrategyRepository(fakeClient(row));
    const claim = await repository.claimToolCallStep({
      leaseExpiresAt: new Date("2026-08-20T10:02:00.000Z"),
      leaseToken: "lease:dispatch-owner",
      modelRunId: "model-run-1",
      modelRunToolCallId: "tool-call-1",
      now: NOW
    });
    expect(claim.kind).toBe("claimed");
    if (claim.kind !== "claimed") throw new Error("dispatch_claim_missing");
    const dispatched = await repository.markStepDispatched({
      at: new Date("2026-08-20T10:01:00.000Z"),
      executionId: "execution-1",
      leaseToken: claim.leaseToken,
      providerAttemptId: null,
      stateVersion: claim.step.lifecycle.stateVersion,
      stepId: "step-1"
    });
    const reclaim = await repository.claimToolCallStep({
      leaseExpiresAt: new Date("2026-08-20T10:10:00.000Z"),
      leaseToken: "lease:forbidden-reclaim",
      modelRunId: "model-run-1",
      modelRunToolCallId: "tool-call-1",
      now: new Date("2026-08-20T10:03:00.000Z")
    });
    expect(reclaim.kind).toBe("none");
    const ambiguousReceipt: KnowledgeStrategyStepReceiptV1 = {
      cursorExhausted: false,
      executionId: "execution-1",
      lastItemHash: null,
      nextCursor: null,
      processedItemCount: 0,
      processedItemsHash: digest("ambiguous-empty"),
      reasonCode: "provider_outcome_unknown",
      requestHash: hashKnowledgeStrategyStepRequestV1(firstRequest),
      status: "ambiguous",
      stepId: "step-1",
      version: 1
    };
    const ambiguous = await repository.markStepAmbiguous({
      at: new Date("2026-08-20T10:03:00.000Z"),
      executionId: "execution-1",
      leaseToken: claim.leaseToken,
      receipt: ambiguousReceipt,
      stateVersion: dispatched.step.lifecycle.stateVersion,
      stepId: "step-1"
    });
    expect(ambiguous.step.lifecycle).toMatchObject({
      failureCode: "provider_outcome_unknown",
      irreversibleDispatch: true,
      state: "ambiguous"
    });
  });

  it("allows the processed set to grow across pages before a source is complete", async () => {
    const { row } = fixture();
    row.state = "running";
    const repository = createPrismaKnowledgeStrategyRepository(fakeClient(row));
    const emptySetHash = digest("empty-set");

    await repository.recordCoverage({
      dispatchManifestHash: null,
      dispatchedPassageCount: 0,
      dispatchSetHash: emptySetHash,
      executionId: "execution-1",
      includedPassageCount: 0,
      includedSetHash: emptySetHash,
      processedPassageCount: 1,
      processedSetHash: digest("first-page-set"),
      processedSourceCount: 0
    });

    const secondPage = await repository.recordCoverage({
      dispatchManifestHash: null,
      dispatchedPassageCount: 0,
      dispatchSetHash: emptySetHash,
      executionId: "execution-1",
      includedPassageCount: 0,
      includedSetHash: emptySetHash,
      processedPassageCount: 2,
      processedSetHash: digest("two-page-set"),
      processedSourceCount: 0
    });

    expect(secondPage.processedPassageCount).toBe(2);
    expect(secondPage.processedSourceCount).toBe(0);
  });
});
