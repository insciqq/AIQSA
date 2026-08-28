import { describe, expect, it } from "vitest";
import {
  runDreamQualification,
  DREAM_QUALIFICATION_FIXED_SEED
} from "../../../../benchmarks/aiqsa-memory-dream-qualification/contract";
import {
  collectDreamLiveProviderAudit,
  evaluateDreamLiveAudit,
  type DreamLiveAuditRecord
} from "../../../../benchmarks/aiqsa-memory-dream-qualification/live";

function reviewedRecord(index: number): DreamLiveAuditRecord {
  return {
    caseId: `positive-case-${index % 8}`,
    distinctEvidenceRootCount: 3,
    distinctFactRootCount: 3,
    executionId: `execution-${index}`,
    expectedOutcome: "ACTIVE",
    failureTaxonomy: [],
    language: index % 3 === 0 ? "ru" : index % 3 === 1 ? "mixed" : "en",
    modelId: "qualification-model",
    observedDates: [
      "2026-08-01T00:01:00.000Z",
      "2026-08-01T00:02:00.000Z",
      "2026-08-01T00:03:00.000Z"
    ],
    patternStatement: `The user tends to follow reviewed routine ${index}.`,
    providerId: "qualification-provider",
    reasonCode: "repeated_habit_pattern",
    reviewerVerdict: "SUPPORTED",
    sourceChatCount: 3,
    sourceRefs: ["S1", "S2", "S3"],
    state: "ACTIVE",
    trial: Math.floor(index / 8) + 1
  };
}

describe("Dream/PATTERN qualification", () => {
  it("covers every fixed positive/adversarial case with zero deterministic violations", () => {
    const report = runDreamQualification();

    expect(report.corpus).toEqual({
      caseCount: 24,
      fixedSeed: DREAM_QUALIFICATION_FIXED_SEED,
      languageCounts: { en: 12, mixed: 6, ru: 6 },
      negativeCount: 16,
      positiveCount: 8
    });
    expect(report.graph.map(({ caseId }) => caseId)).toEqual(expect.arrayContaining([
      "positive-preference-three-chats",
      "positive-workflow-surface-variants",
      "positive-repeated-constraint",
      "positive-repeated-habit",
      "positive-event-tendency",
      "positive-russian-english-pattern",
      "positive-explicit-relationship-context",
      "positive-incremental-fourth-source",
      "negative-similar-independent-events",
      "negative-category-without-predicate",
      "negative-two-support-one-contradiction",
      "negative-one-fact-repeated-three-times",
      "negative-three-facts-one-message",
      "negative-stale-preference-changed",
      "negative-new-direct-contradiction",
      "negative-support-deleted-below-three",
      "negative-all-supports-deleted",
      "negative-conflicting-candidate-patterns",
      "negative-pattern-as-source",
      "negative-assistant-only-source",
      "negative-tool-event-source",
      "negative-sensitive-broad-inference",
      "negative-temporal-coincidence",
      "negative-cross-tenant-source"
    ]));
    expect(report.targetEvidence).toEqual({
      activePatternBelowThreeSupportsIsZero: true,
      deterministicInvariantViolations: 0,
      missingDirectSupportInContextIsZero: true,
      patternOnlyExactAnswerContextIsZero: true,
      patternSourcedFromPatternIsZero: true,
      staleCurrentPatternAfterReconciliationIsZero: true,
      unsupportedGeneralizationDeterministicIsZero: true
    });
    expect(report.metrics).toMatchObject({
      patternCrossTenantViolationCount: 0,
      patternDepthViolationCount: 0,
      patternDistinctSupportRootMinimum: 3,
      patternFalsePositiveRate: 0,
      patternInvalidatedAfterSourceChangeCount: 4,
      patternMissingSupportInContextCount: 0,
      patternOnlyContextCount: 0,
      patternStaleAdmissionCount: 0,
      patternUnsupportedGeneralizationRate: 0,
      synthesisPatternCreatedCount: 8
    });
    expect(report.decision).toEqual({
      productQualification: "GUARDED_LIVE_EVIDENCE_REQUIRED",
      reason: "DETERMINISTIC_PASS_LIVE_30_PROPOSAL_AUDIT_NOT_RUN"
    });
    expect(report.audits.every((audit) =>
      audit.sourceRefs.length >= 3 && audit.observedDates.length >= 3 &&
      audit.patternStatement.length > 0 && audit.failureTaxonomy.length <= 1))
      .toBe(true);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("directly confirmed recurring observation");
    expect(serialized).not.toContain("ingestionFingerprint");
    expect(serialized).not.toContain("sourceMessageIds");
  });

  it("keeps insufficient or weak live audits guarded and qualifies only the full gate", () => {
    expect(evaluateDreamLiveAudit(Array.from({ length: 29 }, (_, index) =>
      reviewedRecord(index))).gate.status).toBe("GUARDED_INSUFFICIENT_VOLUME");

    const qualified = evaluateDreamLiveAudit(Array.from({ length: 30 }, (_, index) =>
      reviewedRecord(index)));
    expect(qualified.gate).toMatchObject({
      enoughVolume: true,
      qualityPass: true,
      status: "QUALIFIED"
    });
    expect(qualified.metrics).toMatchObject({
      nonEmptyProposalCount: 30,
      pendingReviewCount: 0,
      precision: 1,
      unsupportedGeneralizationCount: 0,
      unsupportedGeneralizationRate: 0
    });

    const weak = Array.from({ length: 30 }, (_, index) => index < 2
      ? {
          ...reviewedRecord(index),
          expectedOutcome: "NO_PATTERN" as const,
          failureTaxonomy: ["UNSUPPORTED_GENERALIZATION" as const],
          reviewerVerdict: "UNSUPPORTED" as const
        }
      : reviewedRecord(index));
    expect(evaluateDreamLiveAudit(weak).gate.status).toBe("GUARDED_QUALITY");
  });

  it("supports an explicit governed-provider collector without treating pending output as pass", async () => {
    const records = await collectDreamLiveProviderAudit({
      consent: "EXPLICIT_PAID_PROVIDER_RUN",
      provider: {
        async generate({ caseId, plan, trial }) {
          const cluster = plan.clusters[0]!;
          return {
            executionId: `${caseId}-execution-${trial}`,
            modelId: "fake-governed-model",
            output: {
              patterns: caseId.startsWith("positive-") ? [{
                confidence_band: "HIGH",
                entity_refs: [],
                reason_code: caseId.includes("workflow") || caseId.includes("incremental")
                  ? "repeated_workflow_pattern"
                  : caseId.includes("constraint")
                    ? "repeated_constraint_pattern"
                    : caseId.includes("habit")
                      ? "repeated_habit_pattern"
                      : caseId.includes("event")
                        ? "repeated_event_pattern"
                        : caseId.includes("preference")
                          ? "repeated_preference_pattern"
                          : "cross_context_pattern",
                source_refs: cluster.sources.map(({ ref }) => ref),
                statement: "The user tends to follow a safely audited recurring routine."
              }] : []
            },
            providerId: "fake-governed-provider"
          };
        }
      },
      signal: new AbortController().signal
    });

    expect(records).toHaveLength(32);
    expect(records.every(({ reviewerVerdict }) => reviewerVerdict === "PENDING"))
      .toBe(true);
    expect(evaluateDreamLiveAudit(records).gate.status).toBe("GUARDED_QUALITY");
  });
});
