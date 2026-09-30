import { activationPrompts } from "./workspace-activation-prompts";
import { check, digest, projectRow, rowKey, type ActivationRow } from "./workspace-activation-support";

type Provider = ActivationRow["provider"];
type Coordinate = Pick<ActivationRow, "provider" | "model" | "reasoning" | "promptId" | "repetition">;
export type QualifiedActivationBaseline = {
  sha256: string; corpusHash: string; oracleHash: string;
  models: Record<Provider, string>; rows: ActivationRow[]; originalRows: ActivationRow[];
  excludedCoordinates: Coordinate[];
  treatmentEquivalence: { equivalent: true; evidenceHash: string };
};
const providers = ["codex-lb", "anthropic", "gemini"] as const;
const officeIds = new Set(activationPrompts.filter(prompt => prompt.office).map(prompt => prompt.id));
const noFileIds = activationPrompts.filter(prompt => prompt.class === "not_needed" && !prompt.files?.length).map(prompt => prompt.id);
const isHash = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
function object(value: unknown): Record<string, unknown> {
  check(value !== null && typeof value === "object" && !Array.isArray(value), "comparison_object_invalid");
  return value as Record<string, unknown>;
}
function array(value: unknown, maximum = 512): unknown[] {
  check(Array.isArray(value) && value.length <= maximum, "comparison_array_invalid");
  return value;
}
function hash(value: unknown): string {
  check(isHash(value), "comparison_hash_invalid");
  return value;
}
function coordinate(row: Coordinate): Coordinate {
  return { provider: row.provider, model: row.model, reasoning: row.reasoning, promptId: row.promptId, repetition: row.repetition };
}
function isLostOriginal(row: Coordinate) {
  return row.provider === "codex-lb" && row.reasoning === "low" && row.promptId === "N05" && [1, 2].includes(row.repetition);
}
function matrix(rows: ActivationRow[], models?: Record<Provider, string>, allowNotRun = false): Record<Provider, string> {
  check(rows.length === 240 && new Set(rows.map(rowKey)).size === 240, "comparison_matrix_invalid");
  const names = {} as Record<Provider, string>;
  for (const provider of providers) {
    const selected = new Set(rows.filter(row => row.provider === provider).map(row => row.model));
    check(selected.size === 1, "comparison_model_invalid");
    names[provider] = [...selected][0];
    check(!models || models[provider] === names[provider], "comparison_model_mismatch");
  }
  const keys = new Set(rows.map(rowKey));
  for (const provider of providers) for (const reasoning of provider === "codex-lb" ? ["low", "medium"] as const : ["default"] as const) {
    const repetitions = provider === "codex-lb" ? 3 : 1;
    for (const prompt of activationPrompts) for (let repetition = 1; repetition <= repetitions; repetition++) {
      check(keys.has(rowKey({ provider, model: names[provider], reasoning, promptId: prompt.id, repetition })), "comparison_matrix_invalid");
    }
  }
  for (const row of rows) {
    const prompt = activationPrompts.find(value => value.id === row.promptId)!;
    check(row.repetitions === (row.provider === "codex-lb" ? 3 : 1) && row.class === prompt.class && row.language === prompt.language,
      "comparison_prompt_mismatch");
    check(allowNotRun || row.status !== "not_run", "comparison_incomplete");
  }
  return names;
}
function requireSameCoordinates(value: unknown, expected: Coordinate[]) {
  const actual = array(value, 2).map(item => {
    const raw = object(item);
    return rowKey(raw as Coordinate);
  });
  check(actual.length === expected.length && new Set(actual).size === actual.length &&
    expected.every(row => actual.includes(rowKey(row))), "comparison_exclusions_invalid");
}

// The supplied digest pins reviewed private evidence. Only validated metrics and
// public experiment coordinates leave this boundary; input aggregates are not trusted.
export function readQualifiedActivationBaseline(bytes: Buffer, expectedHash: string): QualifiedActivationBaseline {
  check(isHash(expectedHash) && bytes.length > 0 && bytes.length <= 16 * 1024 * 1024 && digest(bytes) === expectedHash,
    "comparison_baseline_digest_mismatch");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); } catch { check(false, "comparison_baseline_json_invalid"); }
  const raw = object(parsed);
  check(raw.version === 1 && raw.reportKind === "derived_qualification", "comparison_baseline_kind_invalid");
  const corpusHash = hash(raw.corpusHash), oracleHash = hash(raw.correctedOracleHash), originalOracleHash = hash(raw.originalOracleHash);
  const equivalence = object(raw.treatmentEquivalence), flags = object(raw.flags);
  check(equivalence.equivalent === true && array(equivalence.missingFields).length === 0, "comparison_baseline_unqualified");
  check(flags.originalAcquisitionImmutable === true && flags.sameIntendedMatrix === true && flags.lostOriginalArtifacts === 2 &&
    flags.newReplacementAdmissions === 2 && flags.pairedReplayOfLostOriginals === false, "comparison_baseline_flags_invalid");
  const originals = array(raw.attempts).filter(attempt => object(attempt).acquisitionRole === "original").map(attempt => {
    const value = object(attempt), record = projectRow(object(value.record) as unknown as ActivationRow);
    check(rowKey(object(value.coordinate) as Coordinate) === rowKey(record), "comparison_coordinate_mismatch");
    return { record, attemptDigest: hash(value.attemptDigest) };
  });
  matrix(originals.map(value => value.record));
  check(new Set(originals.map(value => value.attemptDigest)).size === 240, "comparison_attempt_invalid");
  const originalByKey = new Map(originals.map(value => [rowKey(value.record), value]));
  const rows = array(raw.cohortSlots, 240).map(slot => {
    const value = object(slot), record = projectRow(object(value.record) as unknown as ActivationRow), evaluation = object(value.evaluation);
    const original = originalByKey.get(rowKey(record));
    check(original && rowKey(object(value.coordinate) as Coordinate) === rowKey(record), "comparison_coordinate_mismatch");
    check(evaluation.qualified === true && evaluation.verdict === record.oraclePassed, "comparison_evaluation_invalid");
    if (record.promptId === "N05") {
      check(evaluation.oracleHash === oracleHash && evaluation.origin === (isLostOriginal(record) ? "new_execution" : "offline_reevaluation"),
        "comparison_corrected_oracle_required");
    } else {
      check(evaluation.oracleHash === originalOracleHash && evaluation.origin === "original_unchanged", "comparison_evaluation_invalid");
    }
    check(record.class !== "needed" || typeof record.oraclePassed === "boolean", "comparison_evaluation_invalid");
    if (isLostOriginal(record)) {
      check(value.origin === "replacement" && value.replacesOriginalAttemptDigest === original.attemptDigest &&
        hash(value.selectedAttemptDigest) !== original.attemptDigest, "comparison_replacement_invalid");
    } else {
      check(value.origin === "original" && value.selectedAttemptDigest === original.attemptDigest && value.replacesOriginalAttemptDigest === null,
        "comparison_attempt_invalid");
      // Correcting the evaluator cannot silently replace activation or usage.
      check(JSON.stringify({ ...record, oraclePassed: original.record.oraclePassed }) === JSON.stringify(original.record),
        "comparison_original_changed");
    }
    return record;
  });
  const models = matrix(rows);
  const excludedCoordinates = rows.filter(isLostOriginal).map(coordinate);
  check(excludedCoordinates.length === 2, "comparison_exclusions_invalid");
  const offline = object(raw.offlineSupplement), sensitivity = object(raw.sensitivity);
  check(offline.correctedOracleHash === oracleHash && offline.providerRequests === 0, "comparison_offline_invalid");
  requireSameCoordinates(offline.unavailableOriginalCoordinates, excludedCoordinates);
  requireSameCoordinates(sensitivity.excludeFromBothBaselineAndCandidate, excludedCoordinates);
  const corrected = new Map(rows.map(row => [rowKey(row), row]));
  const originalRows = originals.map(({ record }) => ({ ...record,
    oraclePassed: isLostOriginal(record) ? null : corrected.get(rowKey(record))!.oraclePassed }));
  return { sha256: expectedHash, corpusHash, oracleHash, models, rows, originalRows, excludedCoordinates,
    treatmentEquivalence: { equivalent: true, evidenceHash: hash(equivalence.perCellEvidenceHash) } };
}

function rate(rows: ActivationRow[], success: (row: ActivationRow) => boolean) {
  const numerator = rows.filter(success).length, denominator = rows.length;
  return { numerator, denominator, fraction: denominator ? numerator / denominator : null };
}
type Rate = ReturnType<typeof rate>;
function withinDrop(candidate: Rate, baseline: Rate, points: number) {
  return candidate.denominator > 0 && baseline.denominator > 0 &&
    100 * candidate.numerator * baseline.denominator >= 100 * baseline.numerator * candidate.denominator - points * candidate.denominator * baseline.denominator;
}
function counts(rows: ActivationRow[]) {
  const needed = rows.filter(row => row.class === "needed");
  const office = rows.filter(row => officeIds.has(row.promptId));
  const neededUnknown = needed.filter(row => row.oraclePassed === null).length;
  const neededSuccess = rate(needed, row => row.status === "complete" && row.oraclePassed === true);
  return {
    rows: rows.length, notRun: rows.filter(row => row.status === "not_run").length,
    completed: rate(rows, row => row.status === "complete"), activation: rate(rows, row => row.activated),
    neededActivation: rate(needed, row => row.activated),
    neededSuccess: { ...neededSuccess, fraction: neededUnknown ? null : neededSuccess.fraction }, neededUnknown,
    notNeededActivation: rate(rows.filter(row => row.class === "not_needed"), row => row.activated),
    officeValidity: rate(office, row => row.status === "complete" && row.officeValid === true),
    borderline: activationPrompts.filter(prompt => prompt.class === "borderline").map(prompt => ({ promptId: prompt.id,
      activation: rate(rows.filter(row => row.promptId === prompt.id), row => row.activated) }))
  };
}
function pairedInputTokens(baseline: ActivationRow[], candidate: ActivationRow[]) {
  const prompts = noFileIds.map(promptId => {
    const left = baseline.filter(row => row.promptId === promptId), right = candidate.filter(row => row.promptId === promptId);
    const complete = left.length > 0 && right.length === left.length && [...left, ...right].every(row => row.inputTokens !== null);
    return { promptId, pairs: left.length, missingBaseline: left.filter(row => row.inputTokens === null).length,
      missingCandidate: right.filter(row => row.inputTokens === null).length,
      baselineMean: complete ? left.reduce((sum, row) => sum + row.inputTokens!, 0) / left.length : null,
      candidateMean: complete ? right.reduce((sum, row) => sum + row.inputTokens!, 0) / right.length : null };
  });
  const complete = prompts.every(prompt => prompt.baselineMean !== null && prompt.candidateMean !== null);
  const baselineMean = complete ? prompts.reduce((sum, prompt) => sum + prompt.baselineMean!, 0) / prompts.length : null;
  const candidateMean = complete ? prompts.reduce((sum, prompt) => sum + prompt.candidateMean!, 0) / prompts.length : null;
  return { basis: "paired_not_needed_no_file_prompt_means" as const, promptCount: prompts.length, complete, baselineMean, candidateMean,
    decreased: complete ? candidateMean! < baselineMean! : null, prompts };
}
function compareGroup(baseline: ActivationRow[], candidate: ActivationRow[], allowedDropPoints: number) {
  const left = counts(baseline), right = counts(candidate);
  const originalUpper = { ...left.neededSuccess, numerator: left.neededSuccess.numerator + left.neededUnknown,
    fraction: left.neededSuccess.denominator ? (left.neededSuccess.numerator + left.neededUnknown) / left.neededSuccess.denominator : null };
  const originalLower = { ...left.neededSuccess, fraction: left.neededSuccess.denominator ? left.neededSuccess.numerator / left.neededSuccess.denominator : null };
  const notNeeded = withinDrop(left.notNeededActivation, right.notNeededActivation, 0) &&
    (left.notNeededActivation.numerator * 10 >= left.notNeededActivation.denominator ||
      right.notNeededActivation.numerator * 10 < right.notNeededActivation.denominator);
  return { baseline: left, candidate: right, allowedDropPoints,
    originalNeededSuccessLower: originalLower, originalNeededSuccessUpper: originalUpper,
    gates: { neededActivation: withinDrop(right.neededActivation, left.neededActivation, allowedDropPoints),
      neededSuccess: withinDrop(right.neededSuccess, originalUpper, allowedDropPoints),
      notNeededActivation: notNeeded, officeValidity: right.officeValidity.denominator > 0 && right.officeValidity.numerator === right.officeValidity.denominator },
    notNeededHalfTarget: 2 * right.notNeededActivation.numerator * left.notNeededActivation.denominator <=
      left.notNeededActivation.numerator * right.notNeededActivation.denominator,
    noFileInputTokens: pairedInputTokens(baseline, candidate) };
}

export function compareActivationCandidate(input: {
  baseline: QualifiedActivationBaseline; rows: ActivationRow[]; corpusHash: string; oracleHash: string;
  treatmentEvidenceHash?: string; treatmentEquivalent?: boolean; cleanupComplete?: boolean;
}) {
  const { baseline } = input;
  check(input.corpusHash === baseline.corpusHash && input.oracleHash === baseline.oracleHash, "comparison_evaluator_mismatch");
  check(input.treatmentEvidenceHash === undefined || isHash(input.treatmentEvidenceHash), "comparison_hash_invalid");
  const rows = input.rows.map(projectRow);
  matrix(rows, baseline.models, true);
  const excluded = new Set(baseline.excludedCoordinates.map(rowKey));
  const group = (select: (row: ActivationRow) => boolean, points: number) => ({
    qualifiedCohort: compareGroup(baseline.rows.filter(select), rows.filter(select), points),
    originalAcquisition: compareGroup(baseline.originalRows.filter(select), rows.filter(select), points),
    sameSlotExclusion: compareGroup(baseline.rows.filter(row => select(row) && !excluded.has(rowKey(row))),
      rows.filter(row => select(row) && !excluded.has(rowKey(row))), points)
  });
  const codex = group(row => row.provider === "codex-lb", 5);
  const cells = [
    { provider: "codex-lb", reasoning: "low" }, { provider: "codex-lb", reasoning: "medium" },
    { provider: "anthropic", reasoning: "default" }, { provider: "gemini", reasoning: "default" }
  ].map(cell => ({ ...cell, ...group(row => row.provider === cell.provider && row.reasoning === cell.reasoning, cell.provider === "codex-lb" ? 5 : 10) }));
  const primary = [codex, ...cells.filter(cell => cell.provider !== "codex-lb")];
  const neededGates = (comparison: ReturnType<typeof compareGroup>) => comparison.gates.neededActivation && comparison.gates.neededSuccess;
  const gates = {
    needed: primary.every(value => neededGates(value.qualifiedCohort)),
    notNeeded: codex.qualifiedCohort.gates.notNeededActivation,
    office: primary.every(value => value.qualifiedCohort.gates.officeValidity),
    noFileInputTokens: codex.qualifiedCohort.noFileInputTokens.decreased === true,
    originalUpperBoundSensitivity: primary.every(value => neededGates(value.originalAcquisition))
  };
  // The original task threshold uses all 60 codex needed slots. Exclusion is a
  // separately reported robustness analysis, not a stricter 58-slot acceptance gate.
  const sensitivitySameSlotPassed = primary.every(value => neededGates(value.sameSlotExclusion));
  const treatmentQualified = input.treatmentEquivalent === true && isHash(input.treatmentEvidenceHash);
  const complete = rows.every(row => row.status !== "not_run");
  const passed = Object.values(gates).every(Boolean);
  return { version: 1, baselineSha256: baseline.sha256, corpusHash: baseline.corpusHash, oracleHash: baseline.oracleHash,
    treatmentEquivalence: { equivalent: input.treatmentEquivalent === true, evidenceHash: input.treatmentEvidenceHash ?? null },
    cleanupComplete: input.cleanupComplete === true, complete,
    nativeNotRun: cells.filter(cell => cell.provider !== "codex-lb").map(cell => ({ provider: cell.provider,
      count: cell.qualifiedCohort.candidate.notRun })),
    status: !treatmentQualified || !complete || input.cleanupComplete !== true ? "unqualified" as const : passed ? "qualified" as const : "failed" as const,
    gates, sensitivitySameSlotPassed,
    pairedNonRegressionClaim: treatmentQualified && complete && input.cleanupComplete === true && passed && sensitivitySameSlotPassed,
    codex, cells, excludedCoordinates: baseline.excludedCoordinates.map(coordinate),
    supplementalLookupIncluded: false, guideReadIncluded: false };
}
