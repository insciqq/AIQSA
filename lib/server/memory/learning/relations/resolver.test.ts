import { describe, expect, it } from "vitest";
import {
  buildMemoryRelationResolverRequest,
  decodeMemoryRelationProviderDecision,
  memoryRelationAcceptedOutputHash,
  memoryRelationResolverInputHash,
  MEMORY_FACT_RELATION_SCHEMA
} from "./resolver";
import type {
  MemoryRelationSnapshot,
  MemoryRelationVersionSnapshot
} from "./policy";

function relationVersion(overrides: Partial<MemoryRelationVersionSnapshot> = {}):
MemoryRelationVersionSnapshot {
  return {
    canonicalKey: "slot.product_status.product.macbook",
    dimensionKey: "product.macbook",
    directness: "DIRECT",
    entities: [{
      canonicalKey: "product.macbook",
      entityType: "PRODUCT",
      role: "SUBJECT"
    }],
    expectedAt: null,
    expiresAt: null,
    factId: "fact-current",
    identityKind: "SLOT",
    mergedIntoVersionId: null,
    observedAt: "2026-08-24T09:00:00.000Z",
    occurredAt: null,
    predicateKey: "product_status",
    ref: "R1",
    semanticAdjudication: null,
    semanticFrame: null,
    sourceMode: "AUTOMATIC",
    state: "ACTIVE",
    structuredValue: { state: "owned" },
    subjectKey: "product.macbook",
    supersedesVersionId: null,
    systemFrom: "2026-08-24T09:00:00.000Z",
    validFrom: null,
    validTo: null,
    versionId: "version-current",
    ...overrides
  };
}

function relationSnapshot(): MemoryRelationSnapshot {
  const current = relationVersion();
  return {
    correctionTargetVersionId: current.versionId,
    current,
    dependencies: [{
      dependencyId: "dependency-internal-1",
      dependencyKind: "CORRECTION_TARGET",
      sourceFactVersionId: current.versionId,
      sourceMessageContentHash: null,
      sourceMessageId: null,
      sourceMessageUpdatedAt: null,
      sourceProjectionVersion: null
    }],
    evidence: [{
      branchGeneration: 2,
      evidenceFingerprint: "a".repeat(64),
      evidenceId: "evidence-internal-1",
      messageId: "message-internal-1",
      observedAt: "2026-08-24T09:30:00.000Z",
      safeSourceHash: "b".repeat(64),
      sourceMessageContentHash: "c".repeat(64),
      sourceProjectionVersion: "memory-source-v1"
    }],
    memoryGeneration: 3,
    memoryRevision: 9,
    pending: relationVersion({
      factId: "fact-pending",
      ref: "P0",
      state: "PENDING_RELATION",
      structuredValue: { detail: { display: "15-inch" }, state: "owned" },
      versionId: "version-pending"
    }),
    related: [current],
    relations: [],
    sourceIdentity: {
      activeLeafMessageId: "assistant-internal-1",
      branchGeneration: 2,
      chatId: "chat-internal-1",
      sourceHash: "d".repeat(64),
      sourceMessageId: "message-internal-1",
      sourceRevision: 4
    }
  };
}

describe("memory relation strict resolver", () => {
  it("accepts only the exact bounded decision shape", () => {
    expect(decodeMemoryRelationProviderDecision({
      confidence_band: "HIGH",
      operation: "MERGE_TARGET_INTO_NEW",
      reason_code: "same_truth_richer",
      target_ref: "R1"
    })).toEqual({
      confidenceBand: "HIGH",
      operation: "MERGE_TARGET_INTO_NEW",
      reasonCode: "same_truth_richer",
      targetRef: "R1"
    });
    for (const invalid of [
      {
        confidence_band: "HIGH",
        extra: true,
        operation: "MERGE_TARGET_INTO_NEW",
        reason_code: "same_truth_richer",
        target_ref: "R1"
      },
      {
        confidence_band: "HIGH",
        operation: "MERGE_TARGET_INTO_NEW",
        reason_code: "same_truth_richer",
        target_ref: "R13"
      },
      {
        confidence_band: "LOW",
        operation: "AMBIGUOUS",
        reason_code: "uncertain",
        target_ref: "R1"
      }
    ]) {
      expect(() => decodeMemoryRelationProviderDecision(invalid))
        .toThrow("memory_fact_relation_output_invalid");
    }
  });

  it("uses a forced strict closed schema", () => {
    expect(MEMORY_FACT_RELATION_SCHEMA).toMatchObject({
      additionalProperties: false,
      required: ["operation", "target_ref", "reason_code", "confidence_band"],
      type: "object"
    });
    expect(MEMORY_FACT_RELATION_SCHEMA.properties.target_ref)
      .toMatchObject({ anyOf: expect.any(Array) });
  });

  it("projects opaque refs and no repository identifiers", () => {
    const request = buildMemoryRelationResolverRequest(relationSnapshot());
    expect(request.name).toBe("memory_fact_relation_v1");
    expect(request.maxOutputTokens).toBe(128);
    expect(request.userPrompt).toContain('"current_ref":"R1"');
    expect(request.userPrompt).toContain('"correction_target_ref":"R1"');
    expect(request.userPrompt).toContain('"source_ref":"R1"');
    expect(request.userPrompt).not.toContain("version-current");
    expect(request.userPrompt).not.toContain("dependency-internal-1");
    expect(request.userPrompt).not.toContain("message-internal-1");
  });

  it("binds accepted output to the complete relation snapshot", () => {
    const snapshot = relationSnapshot();
    const decision = decodeMemoryRelationProviderDecision({
      confidence_band: "HIGH",
      operation: "MERGE_TARGET_INTO_NEW",
      reason_code: "same_truth_richer",
      target_ref: "R1"
    });
    const inputHash = memoryRelationResolverInputHash(snapshot);
    expect(inputHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(memoryRelationAcceptedOutputHash(inputHash, decision))
      .toMatch(/^[a-f0-9]{64}$/u);
    expect(memoryRelationResolverInputHash({
      ...snapshot,
      memoryRevision: snapshot.memoryRevision + 1
    })).not.toBe(inputHash);
  });
});
