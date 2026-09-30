import { describe, expect, it } from "vitest";
import { activationPrompts } from "./workspace-activation-prompts";
import { digest, rowKey, type ActivationRow } from "./workspace-activation-support";
import { compareActivationCandidate, readQualifiedActivationBaseline } from "./workspace-activation-comparison";

const corpusHash = digest("synthetic corpus"), oracleHash = digest("corrected oracle"), originalOracleHash = digest("original oracle");
const treatmentEvidenceHash = digest("separately reviewed candidate treatment");
const lost = (row: ActivationRow) => row.provider === "codex-lb" && row.reasoning === "low" && row.promptId === "N05" && row.repetition < 3;
function fixture() {
  const rows: ActivationRow[] = [];
  for (const provider of ["codex-lb", "anthropic", "gemini"] as const) {
    for (const reasoning of provider === "codex-lb" ? ["low", "medium"] as const : ["default"] as const) {
      for (const prompt of activationPrompts) for (let repetition = 1; repetition <= (provider === "codex-lb" ? 3 : 1); repetition++) {
        rows.push({ provider, model: `${provider}-fixture-model`, reasoning, repetitions: provider === "codex-lb" ? 3 : 1,
          promptId: prompt.id, class: prompt.class, language: prompt.language, repetition,
          activated: prompt.class === "needed", guestExecution: prompt.class === "needed", toolCalls: 1, toolRounds: 1, skillDeliveries: 0,
          searchUsed: Boolean(prompt.search), exportedFiles: prompt.office ? 1 : 0, oraclePassed: prompt.class === "needed" ? true : null,
          officeValid: prompt.office ? true : null, inputTokens: 100, outputTokens: 10, totalTokens: 110, costMicros: 1,
          answerRequests: 1, auxiliaryRequests: 0, latencyMs: 100, paidRequests: 1, status: "complete", errorCode: null });
      }
    }
  }
  const coord = (row: ActivationRow) => ({ provider: row.provider, model: row.model, reasoning: row.reasoning, promptId: row.promptId, repetition: row.repetition });
  const originals = rows.map(row => ({ ...row, ...(row.promptId === "N05" ? { oraclePassed: false } : {}),
    ...(lost(row) ? { activated: false, inputTokens: 200, totalTokens: 210 } : {}) }));
  const originalByKey = new Map(originals.map(row => [rowKey(row), row]));
  const excluded = rows.filter(lost).map(coord);
  const raw = {
    version: 1, reportKind: "derived_qualification", corpusHash, correctedOracleHash: oracleHash, originalOracleHash,
    treatmentEquivalence: { equivalent: true, missingFields: [] as string[], perCellEvidenceHash: digest("baseline treatment") },
    flags: { originalAcquisitionImmutable: true, sameIntendedMatrix: true, lostOriginalArtifacts: 2,
      newReplacementAdmissions: 2, pairedReplayOfLostOriginals: false },
    attempts: originals.map(record => ({ acquisitionRole: "original", attemptDigest: digest(rowKey(record)), coordinate: coord(record), record })),
    cohortSlots: rows.map(record => ({ record, coordinate: coord(record), origin: lost(record) ? "replacement" : "original",
      selectedAttemptDigest: digest(`${lost(record) ? "replacement:" : ""}${rowKey(record)}`),
      replacesOriginalAttemptDigest: lost(record) ? digest(rowKey(originalByKey.get(rowKey(record))!)) : null,
      evaluation: { qualified: true, verdict: record.oraclePassed, oracleHash: record.promptId === "N05" ? oracleHash : originalOracleHash,
        origin: record.promptId !== "N05" ? "original_unchanged" : lost(record) ? "new_execution" : "offline_reevaluation" } })),
    offlineSupplement: { correctedOracleHash: oracleHash, providerRequests: 0, unavailableOriginalCoordinates: excluded },
    sensitivity: { excludeFromBothBaselineAndCandidate: excluded },
    privateContent: "must never be projected"
  };
  const load = () => {
    const bytes = Buffer.from(JSON.stringify(raw));
    return readQualifiedActivationBaseline(bytes, digest(bytes));
  };
  const candidate: ActivationRow[] = rows.map(row => ({ ...row, inputTokens: 50, totalTokens: 60 }));
  const compare = () => compareActivationCandidate({ baseline: load(), rows: candidate, corpusHash, oracleHash,
    treatmentEvidenceHash, treatmentEquivalent: true, cleanupComplete: true });
  return { raw, load, candidate, compare };
}

describe("qualified activation baseline", () => {
  it("pins exact bytes, positively projects records, and preserves the two lost original outcomes", () => {
    const value = fixture(), baseline = value.load();
    expect(baseline.rows).toHaveLength(240);
    expect(baseline.models["codex-lb"]).toBe("codex-lb-fixture-model");
    expect(baseline.originalRows.filter(row => row.class === "needed" && row.oraclePassed === null)).toHaveLength(2);
    expect(baseline.originalRows.filter(row => row.promptId === "N05" && row.oraclePassed === true)).toHaveLength(6);
    expect(JSON.stringify(baseline)).not.toContain("privateContent");
    expect(() => readQualifiedActivationBaseline(Buffer.from(JSON.stringify(value.raw)), digest("different bytes")))
      .toThrow("comparison_baseline_digest_mismatch");
  });
  it("rejects missing or duplicate coordinates and altered original activation", () => {
    const missing = fixture(); missing.raw.cohortSlots.pop();
    expect(missing.load).toThrow("comparison_matrix_invalid");
    const duplicate = fixture(); duplicate.raw.cohortSlots[1] = duplicate.raw.cohortSlots[0];
    expect(duplicate.load).toThrow("comparison_matrix_invalid");
    const changed = fixture(); changed.raw.cohortSlots[0].record.activated = true;
    expect(changed.load).toThrow("comparison_original_changed");
  });
  it("requires exactly the declared two lost slots and the corrected oracle for all N05 slots", () => {
    const exclusion = fixture(); exclusion.raw.sensitivity.excludeFromBothBaselineAndCandidate = exclusion.raw.sensitivity.excludeFromBothBaselineAndCandidate.slice(0, 1);
    expect(exclusion.load).toThrow("comparison_exclusions_invalid");
    const oracle = fixture(); oracle.raw.cohortSlots.find(row => row.record.promptId === "N05")!.evaluation.oracleHash = originalOracleHash;
    expect(oracle.load).toThrow("comparison_corrected_oracle_required");
    const unqualified = fixture(); unqualified.raw.treatmentEquivalence.equivalent = false;
    expect(unqualified.load).toThrow("comparison_baseline_unqualified");
  });
});

describe("candidate comparison", () => {
  it("reports qualified and original activation separately, with paired unweighted token means", () => {
    const report = fixture().compare();
    expect(report.status).toBe("qualified");
    expect(report.codex.qualifiedCohort.baseline.neededActivation).toMatchObject({ numerator: 60, denominator: 60 });
    expect(report.codex.originalAcquisition.baseline.neededActivation).toMatchObject({ numerator: 58, denominator: 60 });
    expect(report.codex.originalAcquisition.baseline.neededSuccess.fraction).toBeNull();
    expect(report.codex.originalAcquisition.originalNeededSuccessLower).toMatchObject({ numerator: 58, denominator: 60 });
    expect(report.codex.originalAcquisition.originalNeededSuccessUpper).toMatchObject({ numerator: 60, denominator: 60 });
    expect(report.codex.sameSlotExclusion.baseline.neededSuccess.denominator).toBe(58);
    expect(report.codex.sameSlotExclusion.candidate.neededSuccess.denominator).toBe(58);
    expect(report.codex.qualifiedCohort.noFileInputTokens).toMatchObject({ baselineMean: 100, candidateMean: 50, promptCount: 10, decreased: true });
    expect(report.cells[0].qualifiedCohort.candidate.borderline).toHaveLength(10);
  });
  it("never qualifies without explicit treatment equivalence and completed cleanup", () => {
    const value = fixture();
    const input = { baseline: value.load(), rows: value.candidate, corpusHash, oracleHash, cleanupComplete: true };
    expect(compareActivationCandidate(input).status).toBe("unqualified");
    expect(compareActivationCandidate({ ...input, treatmentEvidenceHash }).status).toBe("unqualified");
    expect(compareActivationCandidate({ ...input, treatmentEvidenceHash, treatmentEquivalent: true, cleanupComplete: false }).status).toBe("unqualified");
  });
  it("uses exact 5-point codex and 10-point native thresholds with failures in the denominator", () => {
    const value = fixture();
    const needed = value.candidate.filter(row => row.provider === "codex-lb" && row.class === "needed" && !lost(row));
    for (const row of needed.slice(0, 2)) { row.oraclePassed = false; row.status = "error"; row.activated = false; }
    expect(value.compare().gates.needed).toBe(true);
    needed[2].oraclePassed = false;
    // Three failures are exactly 5% of 60, but exceed 5% of the paired 58-slot sensitivity.
    expect(value.compare()).toMatchObject({ status: "qualified", gates: { needed: true }, sensitivitySameSlotPassed: false, pairedNonRegressionClaim: false });
    needed[3].oraclePassed = false;
    expect(value.compare().gates.needed).toBe(false);
    const native = fixture();
    const nativeNeeded = native.candidate.filter(row => row.provider === "anthropic" && row.class === "needed");
    nativeNeeded[0].oraclePassed = false;
    expect(native.compare().gates.needed).toBe(true);
    nativeNeeded[1].oraclePassed = false;
    expect(native.compare().gates.needed).toBe(false);
  });
  it("excludes the same two coordinates on both sides without dropping other candidate failures", () => {
    const value = fixture();
    for (const row of value.candidate.filter(lost)) { row.oraclePassed = false; row.status = "error"; }
    const kept = value.candidate.find(row => row.provider === "codex-lb" && row.reasoning === "medium" && row.promptId === "N01")!;
    kept.oraclePassed = false;
    const report = value.compare();
    expect(report.codex.qualifiedCohort.candidate.neededSuccess).toMatchObject({ numerator: 57, denominator: 60 });
    expect(report.codex.sameSlotExclusion.candidate.neededSuccess).toMatchObject({ numerator: 57, denominator: 58 });
    expect(report.codex.originalAcquisition.originalNeededSuccessUpper.numerator).toBe(60);
  });
  it("requires no regression from zero not-needed activations, valid Office output, and lower known tokens", () => {
    const activation = fixture(); activation.candidate[0].activated = true;
    expect(activation.compare().gates.notNeeded).toBe(false);
    const office = fixture(); office.candidate.find(row => row.promptId === "N04")!.officeValid = false;
    expect(office.compare().gates.office).toBe(false);
    const tokens = fixture(); tokens.candidate[0].inputTokens = null;
    expect(tokens.compare().codex.qualifiedCohort.noFileInputTokens).toMatchObject({ complete: false, baselineMean: null, candidateMean: null, decreased: null });
    expect(tokens.compare().gates.noFileInputTokens).toBe(false);
  });
  it("preserves not-run native coordinates and exposes an unqualified comparison", () => {
    const value = fixture();
    for (const row of value.candidate.filter(row => row.provider === "gemini")) { row.status = "not_run"; row.errorCode = "provider_unavailable"; }
    const report = value.compare();
    expect(report.status).toBe("unqualified");
    expect(report.nativeNotRun).toContainEqual({ provider: "gemini", count: 30 });
  });
  it("rejects corpus, oracle, model or matrix mismatch without demanding full configuration equality", () => {
    const value = fixture();
    const input = { baseline: value.load(), rows: value.candidate, corpusHash, oracleHash };
    expect(() => compareActivationCandidate({ ...input, corpusHash: digest("changed corpus") })).toThrow("comparison_evaluator_mismatch");
    expect(() => compareActivationCandidate({ ...input, oracleHash: originalOracleHash })).toThrow("comparison_evaluator_mismatch");
    expect(() => compareActivationCandidate({ ...input, rows: value.candidate.slice(1) })).toThrow("comparison_matrix_invalid");
    value.candidate.filter(row => row.provider === "gemini").forEach(row => { row.model = "other-model"; });
    expect(() => compareActivationCandidate(input)).toThrow("comparison_model_mismatch");
  });
});
