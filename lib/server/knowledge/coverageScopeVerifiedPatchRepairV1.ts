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
export const KNOWLEDGE_COVERAGE_SCOPE_TRANSIENT_REPAIR_BASE_MAX_BYTES =
  131_072 as const;
export const KNOWLEDGE_COVERAGE_SCOPE_LOCAL_PROVENANCE_REJECTION_VERSION = 1 as const;
export const KNOWLEDGE_COVERAGE_SCOPE_INVALID_PROVENANCE_REJECTION_VERSION = 2 as const;

export const KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_PROTOCOL_V1 = Object.freeze({
  mergeMode: "validator_directed_json_pointer",
  preserveMode: "all_undirected_fields",
  validationMode: "after_each_patch",
  version: KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_VERSION
} as const);

export const KNOWLEDGE_COVERAGE_SCOPE_FAULT_ISOLATED_REPAIR_PROTOCOL_V1 =
  Object.freeze({
    localBoundary: "evidence_unit_by_handle",
    otherBoundaries: Object.freeze([
      "evidence_unit_key_set",
      "joint_findings",
      "unsupported_dimensions"
    ]),
    preserveMode: "all_unrejected_map_units",
    validationMode: "after_each_unit_replacement",
    version: 1
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

export const KNOWLEDGE_COVERAGE_SCOPE_INVALID_PROVENANCE_REJECTION_PROTOCOL_V2 =
  Object.freeze({
    action: "drop_entire_invalid_finding",
    authority: "server_validator_only",
    eligibleDiagnostics: Object.freeze([
      "finding_atom_provenance",
      "joint_handle_count"
    ]),
    revalidation: "whole_scope_after_each_drop",
    version: KNOWLEDGE_COVERAGE_SCOPE_INVALID_PROVENANCE_REJECTION_VERSION
  } as const);

export type KnowledgeCoverageScopeRepairCandidateV1 = KnowledgeCoverageScopeOutputV6;
export type KnowledgeCoverageScopeTransientRepairBaseV1 = Readonly<
  Record<string, unknown>
>;

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
      repairBase: KnowledgeCoverageScopeTransientRepairBaseV1 | null;
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

/**
 * Retains only a bounded, JSON-canonical Scope-shaped container. Leaf values
 * deliberately remain untrusted: the independent Scope validator owns their
 * semantics and the verified merge may replace only paths it rejects. Keeping
 * this transient base prevents one later malformed leaf from forcing a full
 * regeneration that can erase unrelated valid findings.
 */
export function decodeKnowledgeCoverageScopeTransientRepairBaseV1(
  value: unknown
): KnowledgeCoverageScopeTransientRepairBaseV1 | null {
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
  let canonical: string;
  try {
    canonical = knowledgeAnswerCanonicalJson(value);
  } catch {
    return null;
  }
  if (new TextEncoder().encode(canonical).byteLength >
    KNOWLEDGE_COVERAGE_SCOPE_TRANSIENT_REPAIR_BASE_MAX_BYTES) return null;
  try {
    const decoded = JSON.parse(canonical) as unknown;
    return record(decoded) ? Object.freeze(decoded) : null;
  } catch {
    return null;
  }
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
    repairBase: decodeKnowledgeCoverageScopeTransientRepairBaseV1(value)
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
  "Return one complete candidate payload over the unchanged request and evidence index. Correct the diagnosed map unit and keep unrelated semantics and ordering stable.",
  "For a missing, duplicate, malformed, or incomplete evidence-unit map, return exactly one record for every supplied K handle. The server preserves every uniquely addressed unrejected base unit and takes from this candidate only the missing or rejected handles.",
  "For a diagnostic inside one evidence unit, recompute that unit's complete findings from only its own supplied atoms. Do not empty the unit merely to silence finding_atom_provenance when its local atoms directly answer the request. The server replaces only a validator-rejected unit by matching its immutable K handle and preserves every other evidence unit.",
  "For a diagnostic inside jointFindings or unsupportedDimensions, recompute only that bounded collection. Container/key-set failures may still require a full fresh candidate because no stable map boundary exists.",
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
  base: KnowledgeCoverageScopeTransientRepairBaseV1,
  replacementSource: KnowledgeCoverageScopeTransientRepairBaseV1,
  path: string
): KnowledgeCoverageScopeTransientRepairBaseV1 | null {
  const segments = pathSegments(path);
  const replacement = valueAtPath(replacementSource, segments);
  if (!replacement.found) return null;
  if (segments.length === 0) {
    return decodeKnowledgeCoverageScopeTransientRepairBaseV1(replacement.value);
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
  return decodeKnowledgeCoverageScopeTransientRepairBaseV1(candidate);
}

const localMapDiagnosticPathPattern =
  /^\/evidenceUnits\/(0|[1-9]\d{0,3})\/findings(?:\/|$)/u;
const unitMapDiagnosticCodes = new Set<
  KnowledgeCoverageScopeRepairDiagnosticV1["code"]
>([
  "unit_map_count",
  "unit_map_duplicate_handle",
  "unit_map_handle",
  "unit_map_key_set",
  "unit_map_shape"
]);
const unitMapDiagnosticIndexPattern =
  /^\/evidenceUnits\/(0|[1-9]\d{0,3})(?:\/|$)/u;

function uniqueExpectedUnitsByHandleV1(
  value: readonly unknown[],
  expectedHandles: ReadonlySet<string>
): Map<string, unknown> {
  const candidates = new Map<string, unknown[]>();
  for (const unit of value) {
    if (!record(unit) || typeof unit.handle !== "string" ||
      !expectedHandles.has(unit.handle)) continue;
    const existing = candidates.get(unit.handle) ?? [];
    existing.push(unit);
    candidates.set(unit.handle, existing);
  }
  return new Map([...candidates].flatMap(([handle, units]) =>
    units.length === 1 ? [[handle, units[0]] as const] : []));
}

function reconcileFaultIsolatedScopeUnitMapV1(
  base: KnowledgeCoverageScopeTransientRepairBaseV1,
  replacementSource: KnowledgeCoverageScopeTransientRepairBaseV1,
  diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1,
  expectedHandles: readonly string[]
): Readonly<{
  candidate: KnowledgeCoverageScopeTransientRepairBaseV1;
  path: string;
}> | null {
  if (!unitMapDiagnosticCodes.has(diagnostic.code) ||
    !Array.isArray(base.evidenceUnits) ||
    !Array.isArray(replacementSource.evidenceUnits) ||
    expectedHandles.length < 1 ||
    new Set(expectedHandles).size !== expectedHandles.length) return null;
  const expected = new Set(expectedHandles);
  const baseUnits = uniqueExpectedUnitsByHandleV1(base.evidenceUnits, expected);
  const repairUnits = uniqueExpectedUnitsByHandleV1(
    replacementSource.evidenceUnits,
    expected
  );
  const rejectedIndexMatch = unitMapDiagnosticIndexPattern.exec(diagnostic.path);
  if (rejectedIndexMatch) {
    const rejectedUnit = base.evidenceUnits[Number(rejectedIndexMatch[1])];
    if (record(rejectedUnit) && typeof rejectedUnit.handle === "string") {
      baseUnits.delete(rejectedUnit.handle);
    }
  }
  const reconciled = expectedHandles.map((handle) =>
    baseUnits.get(handle) ?? repairUnits.get(handle));
  if (reconciled.some((unit) => unit === undefined)) return null;
  const mutable = cloneJson(base);
  if (!record(mutable)) return null;
  mutable.evidenceUnits = reconciled.map((unit) => cloneJson(unit));
  const candidate = decodeKnowledgeCoverageScopeTransientRepairBaseV1(mutable);
  return candidate
    ? Object.freeze({ candidate, path: "/evidenceUnits" })
    : null;
}

function replaceFaultIsolatedScopeMapUnitV1(
  base: KnowledgeCoverageScopeTransientRepairBaseV1,
  replacementSource: KnowledgeCoverageScopeTransientRepairBaseV1,
  diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1,
  expectedHandles: readonly string[]
): Readonly<{
  candidate: KnowledgeCoverageScopeTransientRepairBaseV1;
  path: string;
}> | null {
  const reconciled = reconcileFaultIsolatedScopeUnitMapV1(
    base,
    replacementSource,
    diagnostic,
    expectedHandles
  );
  if (reconciled) return reconciled;
  const localMatch = localMapDiagnosticPathPattern.exec(diagnostic.path);
  if (localMatch) {
    const unitIndex = Number(localMatch[1]);
    const baseUnits = base.evidenceUnits;
    const repairUnits = replacementSource.evidenceUnits;
    if (!Array.isArray(baseUnits) || !Array.isArray(repairUnits)) return null;
    const baseUnit = baseUnits[unitIndex];
    if (!record(baseUnit) || typeof baseUnit.handle !== "string") return null;
    const repairUnit = repairUnits.find((unit) => record(unit) &&
      unit.handle === baseUnit.handle);
    if (!repairUnit) return null;
    const mutable = cloneJson(base);
    if (!record(mutable) || !Array.isArray(mutable.evidenceUnits)) return null;
    mutable.evidenceUnits[unitIndex] = cloneJson(repairUnit);
    const candidate = decodeKnowledgeCoverageScopeTransientRepairBaseV1(mutable);
    return candidate
      ? Object.freeze({ candidate, path: `/evidenceUnits/${unitIndex}` })
      : null;
  }
  const path = diagnostic.path === "/jointFindings" ||
    diagnostic.path.startsWith("/jointFindings/")
    ? "/jointFindings"
    : diagnostic.path === "/unsupportedDimensions" ||
        diagnostic.path.startsWith("/unsupportedDimensions/")
      ? "/unsupportedDimensions"
      : null;
  if (!path) return null;
  const candidate = replaceAtPath(base, replacementSource, path);
  return candidate ? Object.freeze({ candidate, path }) : null;
}

export function mergeKnowledgeCoverageScopeVerifiedPatchesV1(input: Readonly<{
  atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
  base: KnowledgeCoverageScopeTransientRepairBaseV1;
  diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1;
  evidence: readonly KnowledgeCoverageEvidenceV6[];
  isolateInvalidScopeMapUnit?: true;
  rejectForeignLocalFindings?: true;
  rejectInvalidProvenanceFindings?: true;
  repair: unknown;
  request: string;
}>): KnowledgeCoverageScopeVerifiedPatchMergeV1 {
  const base = decodeKnowledgeCoverageScopeTransientRepairBaseV1(input.base);
  const expectedDiagnostic = decodeKnowledgeCoverageScopeRepairDiagnosticV1(
    input.diagnostic
  );
  const repair = decodeKnowledgeCoverageScopeTransientRepairBaseV1(input.repair);
  if (!base || !expectedDiagnostic) {
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
  const rejectCurrentInvalidProvenance = (
    diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1
  ): boolean => {
    const strictCandidate = decodeKnowledgeCoverageScopeRepairCandidateV1(candidate);
    const rejection = !strictCandidate
      ? null
      : input.rejectInvalidProvenanceFindings === true
        ? dropInvalidProvenanceFindingV2(strictCandidate, diagnostic)
        : input.rejectForeignLocalFindings === true
          ? dropForeignLocalFindingV1(strictCandidate, diagnostic)
          : null;
    if (!rejection) return false;
    candidate = rejection.candidate;
    validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1(candidate, {
      ...(input.atomIndexVersion !== undefined
        ? { atomIndexVersion: input.atomIndexVersion }
        : {}),
      evidence: input.evidence,
      request: input.request
    });
    return true;
  };
  const repairBeforeProvenanceRejection =
    input.isolateInvalidScopeMapUnit === true &&
    (input.rejectForeignLocalFindings === true ||
      input.rejectInvalidProvenanceFindings === true);
  for (let index = 0; index < KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_LIMIT;
    index += 1) {
    if (validation.kind === "accepted") {
      const output = decodeKnowledgeCoverageScopeRepairCandidateV1(candidate);
      if (!output) throw new Error("knowledge_coverage_scope_verified_patch_invalid");
      return Object.freeze({
        kind: "accepted",
        output,
        patchedPaths: Object.freeze([...patchedPaths]),
        value: validation.value
      });
    }
    if (!repairBeforeProvenanceRejection &&
      rejectCurrentInvalidProvenance(validation.diagnostic)) {
      continue;
    }
    const path = validation.diagnostic.path;
    if (input.isolateInvalidScopeMapUnit === true && repair) {
      const replacement = replaceFaultIsolatedScopeMapUnitV1(
        candidate,
        repair,
        validation.diagnostic,
        input.evidence.map(({ handle }) => handle)
      );
      if (replacement) {
        if (!patchedPaths.includes(replacement.path) &&
          knowledgeAnswerCanonicalJson(replacement.candidate) !==
            knowledgeAnswerCanonicalJson(candidate)) {
          candidate = replacement.candidate;
          patchedPaths.push(replacement.path);
          validation = validateKnowledgeCoverageScopeV6RepairFeedbackV1(candidate, {
            ...(input.atomIndexVersion !== undefined
              ? { atomIndexVersion: input.atomIndexVersion }
              : {}),
            evidence: input.evidence,
            request: input.request
          });
          continue;
        }
        if (repairBeforeProvenanceRejection &&
          rejectCurrentInvalidProvenance(validation.diagnostic)) continue;
        return Object.freeze({
          diagnostic: validation.diagnostic,
          kind: "rejected",
          reason: validation.reason
        });
      }
    }
    if (repairBeforeProvenanceRejection &&
      rejectCurrentInvalidProvenance(validation.diagnostic)) continue;
    if (patchedPaths.includes(path)) {
      return Object.freeze({
        diagnostic: validation.diagnostic,
        kind: "rejected",
        reason: validation.reason
      });
    }
    if (!repair) {
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
    const output = decodeKnowledgeCoverageScopeRepairCandidateV1(candidate);
    if (!output) throw new Error("knowledge_coverage_scope_verified_patch_invalid");
    return Object.freeze({
      kind: "accepted",
      output,
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
  value: KnowledgeCoverageScopeTransientRepairBaseV1 | null
): string | null {
  return value === null ? null : knowledgeAnswerHash(value);
}

const localFindingAtomPathPattern =
  /^\/evidenceUnits\/(0|[1-9]\d{0,3})\/findings\/(0|[1-9]\d{0,3})\/evidenceAtomIds$/u;
const jointFindingAtomPathPattern =
  /^\/jointFindings\/(0|[1-9]\d{0,3})\/evidenceAtomIds$/u;

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

function dropInvalidProvenanceFindingV2(
  candidate: KnowledgeCoverageScopeRepairCandidateV1,
  diagnostic: KnowledgeCoverageScopeRepairDiagnosticV1
): Readonly<{
  candidate: KnowledgeCoverageScopeRepairCandidateV1;
  findingPath: string;
}> | null {
  const local = dropForeignLocalFindingV1(candidate, diagnostic);
  if (local) return local;
  if (diagnostic.code !== "joint_handle_count") return null;
  const match = jointFindingAtomPathPattern.exec(diagnostic.path);
  if (!match) return null;
  const findingIndex = Number(match[1]);
  if (findingIndex >= candidate.jointFindings.length) return null;

  const mutable = cloneJson(candidate);
  if (!record(mutable) || !Array.isArray(mutable.jointFindings)) return null;
  mutable.jointFindings.splice(findingIndex, 1);
  const next = decodeKnowledgeCoverageScopeRepairCandidateV1(mutable);
  return next
    ? Object.freeze({
        candidate: next,
        findingPath: `/jointFindings/${findingIndex}`
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

/**
 * V2 extends the same fail-closed whole-item rule to a purported joint finding
 * whose atoms span fewer than two or more than the admitted handle limit. The
 * server never converts it to a local finding, filters its atoms, or transfers
 * provenance; valid siblings survive only after whole-Scope revalidation.
 */
export function rejectKnowledgeCoverageScopeInvalidProvenanceFindingsV2(
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
    const rejection = dropInvalidProvenanceFindingV2(candidate, validation.diagnostic);
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
