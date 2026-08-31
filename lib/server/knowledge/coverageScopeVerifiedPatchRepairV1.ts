import {
  knowledgeAnswerCanonicalJson,
  knowledgeAnswerHash
} from "./answerGroundingV5";
import {
  KNOWLEDGE_COVERAGE_SCOPE_REPAIR_TASK_REMINDER_V6,
  KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6,
  KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS,
  KNOWLEDGE_COVERAGE_SCOPE_V6_PAYLOAD_VERSION,
  KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1,
  decodeKnowledgeCoverageScopeFailureV6,
  type KnowledgeCoverageEvidenceV6,
  type KnowledgeCoverageScopeFailureReasonV6,
  type KnowledgeCoverageScopeOutputV6,
  type KnowledgeCoverageScopeV6,
  type KnowledgeCoverageScopeValidationFailureReasonV6,
  isKnowledgeCoverageScopeValidationFailureReasonV6
} from "./coverageScopeV6";
import type { KnowledgeCoverageEvidenceAtomIndexVersion } from "./coverageScopeV4";
import {
  KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1,
  decodeKnowledgeCoverageScopePromptV6RepairFeedbackV1,
  decodeKnowledgeCoverageScopeRepairDiagnosticV1,
  knowledgeCoverageScopePromptV6RepairFeedbackV1,
  validateKnowledgeCoverageScopeV6RepairFeedbackV1,
  type KnowledgeCoverageScopeRepairDiagnosticV1
} from "./coverageScopeRepairFeedbackV1";

export const KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_VERSION = 1 as const;
export const KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_LIMIT = 32 as const;
export const KNOWLEDGE_COVERAGE_SCOPE_LOCAL_PROVENANCE_REJECTION_VERSION = 1 as const;

export const KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_PROTOCOL_V1 = Object.freeze({
  mergeMode: "validator_directed_json_pointer",
  preserveMode: "all_undirected_fields",
  validationMode: "after_each_patch",
  version: KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_VERSION
} as const);

/**
 * A foreign atom is never remapped or guessed.  The complete local finding is
 * discarded and the remaining Scope is independently revalidated.  This keeps
 * one model-selected provenance error from granting authority to another
 * evidence unit or invalidating unrelated, already-valid findings.
 */
export const KNOWLEDGE_COVERAGE_SCOPE_LOCAL_PROVENANCE_REJECTION_PROTOCOL_V1 =
  Object.freeze({
    action: "drop_entire_finding",
    authority: "server_validator_only",
    revalidation: "whole_scope_after_each_drop",
    trigger: "foreign_evidence_atom",
    version: KNOWLEDGE_COVERAGE_SCOPE_LOCAL_PROVENANCE_REJECTION_VERSION
  } as const);

export type KnowledgeCoverageScopeRepairCandidateV1 = KnowledgeCoverageScopeOutputV6;

export type KnowledgeCoverageScopeVerifiedPatchFailureV1 = Readonly<{
  diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1 | null;
  kind: "coverage_scope_failed";
  reason: KnowledgeCoverageScopeFailureReasonV6;
  repairBaseHash: string | null;
  version: typeof KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_VERSION;
}>;

export type KnowledgeCoverageScopeVerifiedPatchValidationV1 =
  | Readonly<{
      kind: "accepted";
      output: KnowledgeCoverageScopeRepairCandidateV1;
      value: KnowledgeCoverageScopeV6;
    }>
  | Readonly<{
      diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1;
      kind: "rejected";
      reason: KnowledgeCoverageScopeValidationFailureReasonV6;
      repairBase: KnowledgeCoverageScopeRepairCandidateV1 | null;
    }>;

export type KnowledgeCoverageScopeVerifiedPatchMergeV1 =
  | Readonly<{
      kind: "accepted";
      output: KnowledgeCoverageScopeRepairCandidateV1;
      patchedPaths: readonly string[];
      value: KnowledgeCoverageScopeV6;
    }>
  | Readonly<{
      diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1;
      kind: "rejected";
      reason: KnowledgeCoverageScopeValidationFailureReasonV6;
    }>;

export type KnowledgeCoverageScopeLocalProvenanceRejectionV1 = Readonly<{
  droppedFindingPaths: readonly string[];
  validation: KnowledgeCoverageScopeVerifiedPatchValidationV1;
}>;

const handlePattern = /^K[1-9]\d{0,3}$/u;
const atomIdPattern = /^A[1-9]\d{0,3}$/u;
const hashPattern = /^[0-9a-f]{64}$/u;
const controlCharacterPattern = /\p{Cc}/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validPrivateText(value: unknown, maximumCodePoints: number): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    [...value].length <= maximumCodePoints && !controlCharacterPattern.test(value);
}

function decodeFinding(value: unknown): KnowledgeCoverageScopeRepairCandidateV1[
  "jointFindings"
][number] | null {
  if (!record(value) || !exactKeys(value, [
    "description",
    "evidenceAtomIds",
    "requestAnchor"
  ]) || !validPrivateText(
    value.description,
    KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDescriptionCodePoints
  ) || !validPrivateText(
    value.requestAnchor,
    KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAnchorCodePoints
  ) || !Array.isArray(value.evidenceAtomIds) || value.evidenceAtomIds.length < 1 ||
    value.evidenceAtomIds.length >
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAtomsPerDimension ||
    !value.evidenceAtomIds.every((id): id is string =>
      typeof id === "string" && atomIdPattern.test(id)) ||
    new Set(value.evidenceAtomIds).size !== value.evidenceAtomIds.length) return null;
  return Object.freeze({
    description: value.description,
    evidenceAtomIds: Object.freeze([...value.evidenceAtomIds]),
    requestAnchor: value.requestAnchor
  });
}

function decodeUnsupportedDimension(value: unknown): KnowledgeCoverageScopeRepairCandidateV1[
  "unsupportedDimensions"
][number] | null {
  if (!record(value) || !exactKeys(value, ["description", "requestAnchor"]) ||
    !validPrivateText(
      value.description,
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDescriptionCodePoints
    ) || !validPrivateText(
      value.requestAnchor,
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAnchorCodePoints
    )) return null;
  return Object.freeze({
    description: value.description,
    requestAnchor: value.requestAnchor
  });
}

export function decodeKnowledgeCoverageScopeRepairCandidateV1(
  value: unknown
): KnowledgeCoverageScopeRepairCandidateV1 | null {
  if (!record(value) || !exactKeys(value, [
    "evidenceUnits",
    "jointFindings",
    "unsupportedDimensions",
    "version"
  ]) || value.version !== KNOWLEDGE_COVERAGE_SCOPE_V6_PAYLOAD_VERSION ||
    !Array.isArray(value.evidenceUnits) || value.evidenceUnits.length < 1 ||
    value.evidenceUnits.length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceItems ||
    !Array.isArray(value.jointFindings) ||
    value.jointFindings.length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions ||
    !Array.isArray(value.unsupportedDimensions) ||
    value.unsupportedDimensions.length >
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions) return null;
  const evidenceUnits = [];
  for (const unit of value.evidenceUnits) {
    if (!record(unit) || !exactKeys(unit, ["findings", "handle"]) ||
      typeof unit.handle !== "string" || !handlePattern.test(unit.handle) ||
      !Array.isArray(unit.findings) ||
      unit.findings.length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions) return null;
    const findings = unit.findings.map(decodeFinding);
    if (findings.some((finding) => finding === null)) return null;
    evidenceUnits.push(Object.freeze({
      findings: Object.freeze(findings as NonNullable<typeof findings[number]>[]),
      handle: unit.handle
    }));
  }
  const jointFindings = value.jointFindings.map(decodeFinding);
  const unsupportedDimensions = value.unsupportedDimensions.map(decodeUnsupportedDimension);
  if (jointFindings.some((finding) => finding === null) ||
    unsupportedDimensions.some((dimension) => dimension === null)) return null;
  return Object.freeze({
    evidenceUnits: Object.freeze(evidenceUnits),
    jointFindings: Object.freeze(
      jointFindings as NonNullable<typeof jointFindings[number]>[]
    ),
    unsupportedDimensions: Object.freeze(
      unsupportedDimensions as NonNullable<typeof unsupportedDimensions[number]>[]
    ),
    version: KNOWLEDGE_COVERAGE_SCOPE_V6_PAYLOAD_VERSION
  });
}

export function validateKnowledgeCoverageScopeV6VerifiedPatchV1(
  value: unknown,
  input: Readonly<{
    atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
    evidence: readonly KnowledgeCoverageEvidenceV6[];
    request: string;
  }>
): KnowledgeCoverageScopeVerifiedPatchValidationV1 {
  const validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1(value, input);
  if (validation.kind === "accepted") {
    const output = decodeKnowledgeCoverageScopeRepairCandidateV1(value);
    if (!output) throw new Error("knowledge_coverage_scope_verified_patch_invalid");
    return Object.freeze({ kind: "accepted", output, value: validation.value });
  }
  return Object.freeze({
    diagnostic: validation.diagnostic,
    kind: "rejected",
    reason: validation.reason,
    repairBase: decodeKnowledgeCoverageScopeRepairCandidateV1(value)
  });
}

export function knowledgeCoverageScopeVerifiedPatchFailureV1(
  reason: KnowledgeCoverageScopeFailureReasonV6,
  diagnosticValue: KnowledgeCoverageScopeRepairDiagnosticV1 | null = null,
  repairBaseHash: string | null = null
): KnowledgeCoverageScopeVerifiedPatchFailureV1 {
  const baseFailure = decodeKnowledgeCoverageScopeFailureV6({
    kind: "coverage_scope_failed",
    reason
  });
  const diagnostic = diagnosticValue === null
    ? null
    : decodeKnowledgeCoverageScopeRepairDiagnosticV1(diagnosticValue);
  if (!baseFailure || diagnosticValue !== null && !diagnostic ||
    repairBaseHash !== null && !hashPattern.test(repairBaseHash) ||
    isKnowledgeCoverageScopeValidationFailureReasonV6(reason) !== (diagnostic !== null) ||
    !isKnowledgeCoverageScopeValidationFailureReasonV6(reason) &&
      repairBaseHash !== null) {
    throw new Error("knowledge_coverage_scope_verified_patch_failure_invalid");
  }
  return Object.freeze({
    diagnostic,
    kind: "coverage_scope_failed",
    reason: baseFailure.reason,
    repairBaseHash,
    version: KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_VERSION
  });
}

export function decodeKnowledgeCoverageScopeVerifiedPatchFailureV1(
  value: unknown
): KnowledgeCoverageScopeVerifiedPatchFailureV1 | null {
  if (!record(value) || !exactKeys(value, [
    "diagnostic",
    "kind",
    "reason",
    "repairBaseHash",
    "version"
  ]) || value.kind !== "coverage_scope_failed" ||
    value.version !== KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_VERSION ||
    typeof value.reason !== "string") return null;
  try {
    return knowledgeCoverageScopeVerifiedPatchFailureV1(
      value.reason as KnowledgeCoverageScopeFailureReasonV6,
      value.diagnostic === null
        ? null
        : value.diagnostic as KnowledgeCoverageScopeRepairDiagnosticV1,
      value.repairBaseHash === null
        ? null
        : value.repairBaseHash as string
    );
  } catch {
    return null;
  }
}

export const KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1 = [
  KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1,
  '<aiqsa_knowledge_coverage_scope_verified_patch_contract version="1">',
  "The rejected Scope candidate remains transient and is never persisted or supplied here. repairBaseHash is only its content-free fingerprint; recovery without the transient base fails closed before repair.",
  "Return one complete candidate payload over the unchanged request and evidence index. Correct the diagnosed JSON path and keep unrelated semantics and ordering stable.",
  "The server applies replacement values only at JSON paths that its independent validator proves invalid, revalidates after every replacement, and preserves every undirected field byte-for-byte. A repair candidate cannot overwrite an already-valid field.",
  "If validation reveals another independent violation after the first replacement, the same bounded verifier-directed merge may consume the corresponding path from this candidate. There is no model-selected patch path and no unverified whole-payload replacement when a repair base is available.",
  "Do not use benchmark metadata, reference answers, or external knowledge.",
  "</aiqsa_knowledge_coverage_scope_verified_patch_contract>"
].join("\n");

export const KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_TASK_REMINDER_V1 =
  "Return one complete Scope candidate; correct the diagnosed path and keep unrelated fields stable because the server applies only independently verified JSON-pointer patches.";

export function knowledgeCoverageScopePromptV6VerifiedPatchV1(input: Readonly<{
  atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
  evidence: readonly KnowledgeCoverageEvidenceV6[];
  evidenceManifest: string;
  repairBaseHash: string | null;
  repairDiagnostic?: KnowledgeCoverageScopeRepairDiagnosticV1;
  repairReason?: KnowledgeCoverageScopeValidationFailureReasonV6;
  request: string;
  scopePass: "initial" | "repair";
}>): Readonly<{ systemPrompt: string; userPrompt: string }> {
  if (input.scopePass === "initial" && input.repairBaseHash !== null ||
    input.scopePass === "repair" && input.repairBaseHash !== null &&
      !hashPattern.test(input.repairBaseHash)) {
    throw new Error("knowledge_coverage_scope_verified_patch_prompt_invalid");
  }
  const base = knowledgeCoverageScopePromptV6RepairFeedbackV1({
    ...(input.atomIndexVersion !== undefined
      ? { atomIndexVersion: input.atomIndexVersion }
      : {}),
    evidence: input.evidence,
    evidenceManifest: input.evidenceManifest,
    ...(input.repairDiagnostic && input.repairReason ? {
      repairDiagnostic: input.repairDiagnostic,
      repairReason: input.repairReason
    } : {}),
    request: input.request,
    scopePass: input.scopePass
  });
  const payload = JSON.parse(base.userPrompt) as Record<string, unknown>;
  return Object.freeze({
    systemPrompt: input.atomIndexVersion === 2
      ? `${KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1}\n\n` +
        KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1
      : KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1,
    userPrompt: knowledgeAnswerCanonicalJson({
      ...payload,
      repairBaseHash: input.repairBaseHash,
      taskReminder: input.scopePass === "repair"
        ? KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_TASK_REMINDER_V1
        : KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6,
      verifiedPatchProtocol: KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_PROTOCOL_V1
    })
  });
}

export function decodeKnowledgeCoverageScopePromptV6VerifiedPatchV1(input: Readonly<{
  atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
  evidence: readonly KnowledgeCoverageEvidenceV6[];
  evidenceManifest: string;
  request: string;
  systemPrompt: string;
  userPrompt: string;
}>): Readonly<{
  repairBaseHash: string | null;
  repairDiagnostic: KnowledgeCoverageScopeRepairDiagnosticV1 | null;
  repairReason: KnowledgeCoverageScopeValidationFailureReasonV6 | null;
  scopePass: "initial" | "repair";
}> | null {
  const expectedSystemPrompt = input.atomIndexVersion === 2
    ? `${KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1}\n\n` +
      KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1
    : KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1;
  if (input.systemPrompt !== expectedSystemPrompt) return null;
  let value: unknown;
  try {
    value = JSON.parse(input.userPrompt) as unknown;
  } catch {
    return null;
  }
  if (!record(value) || typeof value.scopePass !== "string" ||
    value.scopePass !== "initial" && value.scopePass !== "repair" ||
    value.repairBaseHash !== null &&
      (typeof value.repairBaseHash !== "string" || !hashPattern.test(value.repairBaseHash))) {
    return null;
  }
  const basePayload = { ...value };
  delete basePayload.repairBaseHash;
  delete basePayload.verifiedPatchProtocol;
  basePayload.taskReminder = value.scopePass === "repair"
    ? KNOWLEDGE_COVERAGE_SCOPE_REPAIR_TASK_REMINDER_V6
    : KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6;
  const base = decodeKnowledgeCoverageScopePromptV6RepairFeedbackV1({
    ...(input.atomIndexVersion !== undefined
      ? { atomIndexVersion: input.atomIndexVersion }
      : {}),
    evidence: input.evidence,
    evidenceManifest: input.evidenceManifest,
    request: input.request,
    systemPrompt: input.atomIndexVersion === 2
      ? `${KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1}\n\n` +
        KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1
      : KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_CONTRACT_V1,
    userPrompt: knowledgeAnswerCanonicalJson(basePayload)
  });
  if (!base || value.scopePass === "initial" && value.repairBaseHash !== null ||
    knowledgeAnswerCanonicalJson(value.verifiedPatchProtocol) !==
      knowledgeAnswerCanonicalJson(KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_PROTOCOL_V1) ||
    value.taskReminder !== (value.scopePass === "repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_TASK_REMINDER_V1
      : KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6)) return null;
  const expected = knowledgeCoverageScopePromptV6VerifiedPatchV1({
    ...(input.atomIndexVersion !== undefined
      ? { atomIndexVersion: input.atomIndexVersion }
      : {}),
    evidence: input.evidence,
    evidenceManifest: input.evidenceManifest,
    repairBaseHash: value.repairBaseHash as string | null,
    ...(base.repairDiagnostic && base.repairReason ? {
      repairDiagnostic: base.repairDiagnostic,
      repairReason: base.repairReason
    } : {}),
    request: input.request,
    scopePass: base.scopePass
  });
  if (expected.systemPrompt !== input.systemPrompt || expected.userPrompt !== input.userPrompt) {
    return null;
  }
  return Object.freeze({
    repairBaseHash: value.repairBaseHash as string | null,
    repairDiagnostic: base.repairDiagnostic,
    repairReason: base.repairReason,
    scopePass: base.scopePass
  });
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(knowledgeAnswerCanonicalJson(value)) as unknown;
}

function pathSegments(path: string): readonly string[] {
  return path === "/" ? [] : path.slice(1).split("/");
}

function valueAtPath(
  root: unknown,
  segments: readonly string[]
): Readonly<{ found: boolean; value: unknown }> {
  let current = root;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isSafeInteger(index) || index < 0 || index >= current.length) {
        return Object.freeze({ found: false, value: null });
      }
      current = current[index];
    } else if (record(current) && Object.hasOwn(current, segment)) {
      current = current[segment];
    } else {
      return Object.freeze({ found: false, value: null });
    }
  }
  return Object.freeze({ found: true, value: current });
}

function replaceAtPath(
  base: KnowledgeCoverageScopeRepairCandidateV1,
  replacementSource: KnowledgeCoverageScopeRepairCandidateV1,
  path: string
): KnowledgeCoverageScopeRepairCandidateV1 | null {
  const segments = pathSegments(path);
  const replacement = valueAtPath(replacementSource, segments);
  if (!replacement.found) return null;
  if (segments.length === 0) {
    return decodeKnowledgeCoverageScopeRepairCandidateV1(replacement.value);
  }
  const candidate = cloneJson(base);
  let parent = candidate;
  for (const segment of segments.slice(0, -1)) {
    const next = valueAtPath(parent, [segment]);
    if (!next.found) return null;
    parent = next.value;
  }
  const leaf = segments.at(-1)!;
  if (Array.isArray(parent)) {
    const index = Number(leaf);
    if (!Number.isSafeInteger(index) || index < 0 || index >= parent.length) return null;
    parent[index] = cloneJson(replacement.value);
  } else if (record(parent) && Object.hasOwn(parent, leaf)) {
    parent[leaf] = cloneJson(replacement.value);
  } else {
    return null;
  }
  return decodeKnowledgeCoverageScopeRepairCandidateV1(candidate);
}

export function mergeKnowledgeCoverageScopeVerifiedPatchesV1(input: Readonly<{
  atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
  base: KnowledgeCoverageScopeRepairCandidateV1;
  diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1;
  evidence: readonly KnowledgeCoverageEvidenceV6[];
  rejectForeignLocalFindings?: true;
  repair: unknown;
  request: string;
}>): KnowledgeCoverageScopeVerifiedPatchMergeV1 {
  const base = decodeKnowledgeCoverageScopeRepairCandidateV1(input.base);
  const expectedDiagnostic = decodeKnowledgeCoverageScopeRepairDiagnosticV1(
    input.diagnostic
  );
  const repair = decodeKnowledgeCoverageScopeRepairCandidateV1(input.repair);
  if (!base || !expectedDiagnostic || !repair) {
    throw new Error("knowledge_coverage_scope_verified_patch_merge_invalid");
  }
  let candidate = base;
  let validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1(candidate, {
    ...(input.atomIndexVersion !== undefined
      ? { atomIndexVersion: input.atomIndexVersion }
      : {}),
    evidence: input.evidence,
    request: input.request
  });
  if (validation.kind !== "rejected" ||
    knowledgeAnswerCanonicalJson(validation.diagnostic) !==
      knowledgeAnswerCanonicalJson(expectedDiagnostic)) {
    throw new Error("knowledge_coverage_scope_verified_patch_base_invalid");
  }
  const patchedPaths: string[] = [];
  for (let index = 0; index < KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_LIMIT;
    index += 1) {
    if (validation.kind === "accepted") {
      return Object.freeze({
        kind: "accepted",
        output: candidate,
        patchedPaths: Object.freeze([...patchedPaths]),
        value: validation.value
      });
    }
    if (input.rejectForeignLocalFindings === true) {
      const rejection = dropForeignLocalFindingV1(candidate, validation.diagnostic);
      if (rejection) {
        candidate = rejection.candidate;
        validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1(candidate, {
          ...(input.atomIndexVersion !== undefined
            ? { atomIndexVersion: input.atomIndexVersion }
            : {}),
          evidence: input.evidence,
          request: input.request
        });
        continue;
      }
    }
    const path = validation.diagnostic.path;
    if (patchedPaths.includes(path)) {
      return Object.freeze({
        diagnostic: validation.diagnostic,
        kind: "rejected",
        reason: validation.reason
      });
    }
    const patched = replaceAtPath(candidate, repair, path);
    if (!patched || knowledgeAnswerCanonicalJson(patched) ===
      knowledgeAnswerCanonicalJson(candidate)) {
      return Object.freeze({
        diagnostic: validation.diagnostic,
        kind: "rejected",
        reason: validation.reason
      });
    }
    candidate = patched;
    patchedPaths.push(path);
    validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1(candidate, {
      ...(input.atomIndexVersion !== undefined
        ? { atomIndexVersion: input.atomIndexVersion }
        : {}),
      evidence: input.evidence,
      request: input.request
    });
  }
  if (validation.kind === "accepted") {
    return Object.freeze({
      kind: "accepted",
      output: candidate,
      patchedPaths: Object.freeze([...patchedPaths]),
      value: validation.value
    });
  }
  return Object.freeze({
    diagnostic: validation.diagnostic,
    kind: "rejected",
    reason: validation.reason
  });
}

export function knowledgeCoverageScopeRepairBaseHashV1(
  value: KnowledgeCoverageScopeRepairCandidateV1 | null
): string | null {
  return value === null ? null : knowledgeAnswerHash(value);
}

const localFindingAtomPathPattern =
  /^\/evidenceUnits\/(0|[1-9]\d{0,3})\/findings\/(0|[1-9]\d{0,3})\/evidenceAtomIds$/u;

function dropForeignLocalFindingV1(
  candidate: KnowledgeCoverageScopeRepairCandidateV1,
  diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1
): Readonly<{
  candidate: KnowledgeCoverageScopeRepairCandidateV1;
  findingPath: string;
}> | null {
  if (diagnostic.code !== "finding_atom_provenance") return null;
  const match = localFindingAtomPathPattern.exec(diagnostic.path);
  if (!match || diagnostic.expectedHandle === null) return null;
  const unitIndex = Number(match[1]);
  const findingIndex = Number(match[2]);
  const unit = candidate.evidenceUnits[unitIndex];
  if (!unit || unit.handle !== diagnostic.expectedHandle ||
    findingIndex >= unit.findings.length) return null;

  const mutable = cloneJson(candidate);
  if (!record(mutable) || !Array.isArray(mutable.evidenceUnits)) return null;
  const mutableUnit = mutable.evidenceUnits[unitIndex];
  if (!record(mutableUnit) || !Array.isArray(mutableUnit.findings)) return null;
  mutableUnit.findings.splice(findingIndex, 1);
  const next = decodeKnowledgeCoverageScopeRepairCandidateV1(mutable);
  return next
    ? Object.freeze({
        candidate: next,
        findingPath: `/evidenceUnits/${unitIndex}/findings/${findingIndex}`
      })
    : null;
}

/**
 * Fail-closed normalization for the one validation class whose safe recovery
 * is fully deterministic.  A finding that cites an atom from a different
 * evidence unit is removed as a whole; its text is never retained with guessed
 * or filtered provenance.  Any other validation error remains eligible for
 * the bounded verified-patch repair path.
 */
export function rejectKnowledgeCoverageScopeForeignLocalFindingsV1(
  value: unknown,
  input: Readonly<{
    atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
    evidence: readonly KnowledgeCoverageEvidenceV6[];
    request: string;
  }>
): KnowledgeCoverageScopeLocalProvenanceRejectionV1 {
  let candidate = decodeKnowledgeCoverageScopeRepairCandidateV1(value);
  let validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(value, input);
  const droppedFindingPaths: string[] = [];
  if (!candidate) {
    return Object.freeze({
      droppedFindingPaths: Object.freeze([]),
      validation
    });
  }

  for (let removalCount = 0;
    removalCount < KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions;
    removalCount += 1) {
    if (validation.kind === "accepted") break;
    const rejection = dropForeignLocalFindingV1(candidate, validation.diagnostic);
    if (!rejection) break;
    candidate = rejection.candidate;
    droppedFindingPaths.push(rejection.findingPath);
    validation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(candidate, input);
  }

  return Object.freeze({
    droppedFindingPaths: Object.freeze([...droppedFindingPaths]),
    validation
  });
}
