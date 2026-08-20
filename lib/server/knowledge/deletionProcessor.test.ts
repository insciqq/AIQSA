import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import {
  buildKnowledgeStrategyExecutionPurgeMutation,
  buildKnowledgeStrategyMapOutputPurgeMutation,
  buildKnowledgeStrategyStepPurgeMutation
} from "./deletionProcessor";

describe("Knowledge strategy permanent-purge projection", () => {
  it("removes private execution payloads while retaining content-free accounting", () => {
    const purgedAt = new Date("2026-08-20T12:00:00.000Z");
    const execution = buildKnowledgeStrategyExecutionPurgeMutation(purgedAt);

    expect(execution).toEqual({
      coverageReceipt: Prisma.DbNull,
      coverageReceiptHash: null,
      dispatchManifestHash: null,
      dispatchSetHash: null,
      executionHash: null,
      executionRequest: Prisma.DbNull,
      includedSetHash: null,
      planHash: null,
      processedSetHash: null,
      purgedAt,
      sourceSetHash: null
    });
    for (const retainedField of [
      "coverageStatus",
      "dispatchedPassageCount",
      "expectedPassageCount",
      "expectedSourceCount",
      "includedPassageCount",
      "processedPassageCount",
      "processedSourceCount",
      "state",
      "strategy"
    ]) {
      expect(execution).not.toHaveProperty(retainedField);
    }
  });

  it("unlinks every private step authority but keeps content-free counters", () => {
    const purgedAt = new Date("2026-08-20T12:00:00.000Z");
    const step = buildKnowledgeStrategyStepPurgeMutation(purgedAt);

    expect(step).toEqual({
      comparisonDimensionHash: null,
      cursor: Prisma.DbNull,
      cursorHash: null,
      evidenceInputHash: null,
      failureCode: null,
      idempotencyKey: null,
      inputHash: null,
      leaseExpiresAt: null,
      leaseToken: null,
      materializedAt: null,
      modelRunToolCallId: null,
      processedItemsHash: null,
      providerAttemptId: null,
      purgedAt,
      request: Prisma.DbNull,
      requestHash: null,
      result: Prisma.DbNull,
      resultHash: null,
      sourceBindingId: null,
      sourceSetHash: null,
      state: "purged",
      stateVersion: { increment: 1 },
      streamId: null,
      templateHash: null
    });
    for (const retainedField of [
      "attemptCount",
      "includedPassageCount",
      "irreversibleDispatch",
      "kind",
      "ordinal",
      "processedPassageCount",
      "processedSourceCount"
    ]) {
      expect(step).not.toHaveProperty(retainedField);
    }
  });

  it("scrubs map summaries and lineage while retaining only aggregate counts", () => {
    const purgedAt = new Date("2026-08-20T12:00:00.000Z");
    const mapOutput = buildKnowledgeStrategyMapOutputPurgeMutation(purgedAt);

    expect(mapOutput).toEqual({
      inputPageReceiptsHash: null,
      inputPassageItemsHash: null,
      inputSectionHashesHash: null,
      mapInputHash: null,
      output: Prisma.DbNull,
      outputHash: null,
      purgedAt,
      receipt: Prisma.DbNull,
      receiptHash: null,
      sourceBindingId: null,
      state: "purged",
      summaryItemsHash: null
    });
    for (const retainedField of [
      "inputPageReceiptCount",
      "inputPassageCount",
      "inputSectionCount",
      "processedPassageCount",
      "sourceOrdinal",
      "summaryItemCount",
      "terminalStepId"
    ]) {
      expect(mapOutput).not.toHaveProperty(retainedField);
    }
  });
});
