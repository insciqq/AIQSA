import {
  knowledgeAnswerCanonicalJson
} from "./answerGroundingV5";
import {
  knowledgeCoverageEvidenceAtomIndex,
  type KnowledgeCoverageEvidenceAtomIndexVersion
} from "./coverageScopeV4";
import { knowledgeCoverageEvidenceUnitIndex } from "./coverageScopeV5";
import {
  KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6,
  KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS,
  KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1,
  type KnowledgeCoverageEvidenceV6,
  type KnowledgeCoverageScopeValidationFailureReasonV6
} from "./coverageScopeV6";
import {
  KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION,
  decodeKnowledgeCoverageScopeRepairDiagnosticV1,
  type KnowledgeCoverageScopeRepairDiagnosticCodeV1,
  type KnowledgeCoverageScopeRepairDiagnosticV1
} from "./coverageScopeRepairFeedbackV1";
import {
  KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1,
  KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_TASK_REMINDER_V1,
  decodeKnowledgeCoverageScopePromptV6VerifiedPatchV1,
  decodeKnowledgeCoverageScopeRepairCandidateV1,
  knowledgeCoverageScopePromptV6VerifiedPatchV1,
  validateKnowledgeCoverageScopeV6VerifiedPatchV1,
  type KnowledgeCoverageScopeRepairCandidateV1
} from "./coverageScopeVerifiedPatchRepairV1";

export const KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_VERSION = 1 as const;
export const KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_LIMIT = 32 as const;

export const KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_PROTOCOL_V1 = Object.freeze({
  diagnosticOrder: "validator_traversal",
  maximumDiagnostics: KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_LIMIT,
  rejectedPayloadDisclosure: "none",
  repairCalls: 1,
  version: KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_VERSION
} as const);

const controlCharacterPattern = /\p{Cc}/u;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function validPrivateText(value: string, maximumCodePoints: number): boolean {
  return value.trim().length > 0 && [...value].length <= maximumCodePoints &&
    !controlCharacterPattern.test(value);
}

function diagnostic(input: Readonly<{
  actualCount?: number;
  code: KnowledgeCoverageScopeRepairDiagnosticCodeV1;
  expectedHandle?: string;
  maximumCount?: number;
  path: string;
}>): KnowledgeCoverageScopeRepairDiagnosticV1 {
  const decoded = decodeKnowledgeCoverageScopeRepairDiagnosticV1({
    actualCount: input.actualCount ?? null,
    code: input.code,
    expectedHandle: input.expectedHandle ?? null,
    maximumCount: input.maximumCount ?? null,
    path: input.path,
    version: KNOWLEDGE_COVERAGE_SCOPE_REPAIR_FEEDBACK_VERSION
  });
  if (!decoded) throw new Error("knowledge_coverage_scope_multi_diagnostic_invalid");
  return decoded;
}

function sameDiagnostic(
  left: KnowledgeCoverageScopeRepairDiagnosticV1,
  right: KnowledgeCoverageScopeRepairDiagnosticV1
): boolean {
  return knowledgeAnswerCanonicalJson(left) === knowledgeAnswerCanonicalJson(right);
}

/**
 * Enumerates only violations whose JSON-pointer locations remain stable while
 * sibling fields are repaired. Container/key-set failures fall back to the
 * validator's first diagnostic because repairing them can invalidate every
 * descendant path.
 */
export function collectKnowledgeCoverageScopeRepairDiagnosticsV1(input: Readonly<{
  atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
  base: KnowledgeCoverageScopeRepairCandidateV1 | null;
  evidence: readonly KnowledgeCoverageEvidenceV6[];
  initialDiagnostic: KnowledgeCoverageScopeRepairDiagnosticV1;
  request: string;
}>): readonly KnowledgeCoverageScopeRepairDiagnosticV1[] {
  const initialDiagnostic = decodeKnowledgeCoverageScopeRepairDiagnosticV1(
    input.initialDiagnostic
  );
  if (!initialDiagnostic) {
    throw new Error("knowledge_coverage_scope_multi_diagnostic_invalid");
  }
  const base = decodeKnowledgeCoverageScopeRepairCandidateV1(input.base);
  if (!base) return Object.freeze([initialDiagnostic]);
  const initialValidation = validateKnowledgeCoverageScopeV6VerifiedPatchV1(base, {
    ...(input.atomIndexVersion !== undefined
      ? { atomIndexVersion: input.atomIndexVersion }
      : {}),
    evidence: input.evidence,
    request: input.request
  });
  if (initialValidation.kind !== "rejected" ||
    !sameDiagnostic(initialValidation.diagnostic, initialDiagnostic)) {
    throw new Error("knowledge_coverage_scope_multi_diagnostic_base_invalid");
  }

  let unitIndex: ReturnType<typeof knowledgeCoverageEvidenceUnitIndex>;
  let atomIndex: ReturnType<typeof knowledgeCoverageEvidenceAtomIndex>;
  try {
    const atomIndexVersion = input.atomIndexVersion ?? 1;
    unitIndex = knowledgeCoverageEvidenceUnitIndex(input.evidence, atomIndexVersion);
    atomIndex = knowledgeCoverageEvidenceAtomIndex(input.evidence, atomIndexVersion);
  } catch {
    return Object.freeze([initialDiagnostic]);
  }
  const suppliedUnits = new Map(base.evidenceUnits.map((unit, index) =>
    [unit.handle, Object.freeze({ index, unit })] as const));
  if (base.evidenceUnits.length !== unitIndex.units.length ||
    suppliedUnits.size !== base.evidenceUnits.length ||
    unitIndex.units.some(({ handle }) => !suppliedUnits.has(handle))) {
    return Object.freeze([initialDiagnostic]);
  }

  const atomById = new Map(atomIndex.items.map((atom) => [atom.id, atom] as const));
  const descriptions = new Set<string>();
  const diagnostics: KnowledgeCoverageScopeRepairDiagnosticV1[] = [];
  const append = (value: KnowledgeCoverageScopeRepairDiagnosticV1) => {
    if (diagnostics.some((item) => sameDiagnostic(item, value))) return;
    diagnostics.push(value);
  };
  const inspectText = (candidate: Readonly<{
    description: string;
    requestAnchor: string;
  }>, path: string) => {
    if (!validPrivateText(
      candidate.description,
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDescriptionCodePoints
    )) {
      append(diagnostic({ code: "description_invalid", path: `${path}/description` }));
    } else {
      const descriptionKey = candidate.description.normalize("NFC");
      if (descriptions.has(descriptionKey)) {
        append(diagnostic({ code: "description_duplicate", path: `${path}/description` }));
      } else {
        descriptions.add(descriptionKey);
      }
    }
    if (!validPrivateText(
      candidate.requestAnchor,
      KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxAnchorCodePoints
    ) || !input.request.includes(candidate.requestAnchor)) {
      append(diagnostic({ code: "anchor_invalid", path: `${path}/requestAnchor` }));
    }
  };
  const inspectFinding = (
    candidate: KnowledgeCoverageScopeRepairCandidateV1["jointFindings"][number],
    expectedHandle: string | null,
    path: string
  ) => {
    inspectText(candidate, path);
    if (!candidate.evidenceAtomIds.every((id) => atomById.has(id))) {
      append(diagnostic({ code: "atom_id_invalid", path: `${path}/evidenceAtomIds` }));
      return;
    }
    const handles = [...new Set(candidate.evidenceAtomIds.map((id) =>
      atomById.get(id)!.handle))];
    if (expectedHandle !== null &&
      (handles.length !== 1 || handles[0] !== expectedHandle)) {
      append(diagnostic({
        actualCount: handles.length,
        code: "finding_atom_provenance",
        expectedHandle,
        maximumCount: 1,
        path: `${path}/evidenceAtomIds`
      }));
    } else if (expectedHandle === null && (handles.length < 2 ||
      handles.length > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceHandles)) {
      append(diagnostic({
        actualCount: handles.length,
        code: "joint_handle_count",
        maximumCount: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxEvidenceHandles,
        path: `${path}/evidenceAtomIds`
      }));
    }
  };

  for (const unit of unitIndex.units) {
    const supplied = suppliedUnits.get(unit.handle)!;
    for (const [findingIndex, finding] of supplied.unit.findings.entries()) {
      inspectFinding(
        finding,
        unit.handle,
        `/evidenceUnits/${supplied.index}/findings/${findingIndex}`
      );
    }
  }
  for (const [index, finding] of base.jointFindings.entries()) {
    inspectFinding(finding, null, `/jointFindings/${index}`);
  }
  for (const [index, dimension] of base.unsupportedDimensions.entries()) {
    inspectText(dimension, `/unsupportedDimensions/${index}`);
  }
  const dimensionCount = base.evidenceUnits.reduce(
    (total, unit) => total + unit.findings.length,
    base.jointFindings.length + base.unsupportedDimensions.length
  );
  if (dimensionCount < 1 ||
    dimensionCount > KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions) {
    append(diagnostic({
      actualCount: dimensionCount,
      code: "dimension_count",
      maximumCount: KNOWLEDGE_COVERAGE_SCOPE_V6_LIMITS.maxDimensions,
      path: "/"
    }));
  }

  if (diagnostics.length < 1 || diagnostics.length >
      KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_LIMIT ||
    !sameDiagnostic(diagnostics[0]!, initialDiagnostic)) {
    return Object.freeze([initialDiagnostic]);
  }
  return Object.freeze([...diagnostics]);
}

function decodeDiagnostics(
  value: unknown
): readonly KnowledgeCoverageScopeRepairDiagnosticV1[] | null {
  if (!Array.isArray(value) ||
    value.length > KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_LIMIT) return null;
  const diagnostics = value.map(decodeKnowledgeCoverageScopeRepairDiagnosticV1);
  if (diagnostics.some((item) => item === null)) return null;
  const decoded = diagnostics as KnowledgeCoverageScopeRepairDiagnosticV1[];
  if (new Set(decoded.map((item) => item.path)).size !== decoded.length) return null;
  return Object.freeze([...decoded]);
}

export const KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_CONTRACT_V1 = [
  KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1,
  '<aiqsa_knowledge_coverage_scope_multi_diagnostic_repair_contract version="1">',
  "On repair, repairDiagnostics is the bounded validator-ordered set of independently detectable structural violations in the transient candidate. Its first item equals repairDiagnostic. Neither field contains rejected payload content.",
  "Correct every listed JSON path in one fresh complete candidate over the unchanged request and evidence index. Do not infer additional patch paths from benchmark metadata, reference answers, or external knowledge.",
  "The server still applies only replacement values at paths independently rejected during revalidation. Unlisted or already-valid fields in this candidate grant no overwrite authority.",
  "There is one repair call. Do not quote, continue, or rely on the rejected candidate; reconstruct the complete payload from the unchanged trusted inputs and the content-free diagnostics.",
  "</aiqsa_knowledge_coverage_scope_multi_diagnostic_repair_contract>"
].join("\n");

export const KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_TASK_REMINDER_V1 =
  "Return one fresh complete Scope candidate and correct every path in repairDiagnostics; the server applies only independently verified JSON-pointer replacements.";

export function knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1(
  input: Readonly<{
    atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
    evidence: readonly KnowledgeCoverageEvidenceV6[];
    evidenceManifest: string;
    repairBaseHash: string | null;
    repairDiagnostics?: readonly KnowledgeCoverageScopeRepairDiagnosticV1[];
    repairReason?: KnowledgeCoverageScopeValidationFailureReasonV6;
    request: string;
    scopePass: "initial" | "repair";
  }>
): Readonly<{ systemPrompt: string; userPrompt: string }> {
  const diagnostics = decodeDiagnostics(input.repairDiagnostics ?? []);
  if (!diagnostics || (input.scopePass === "repair") !== (diagnostics.length > 0) ||
    (input.scopePass === "repair") !== (input.repairReason !== undefined)) {
    throw new Error("knowledge_coverage_scope_multi_diagnostic_prompt_invalid");
  }
  const base = knowledgeCoverageScopePromptV6VerifiedPatchV1({
    ...(input.atomIndexVersion !== undefined
      ? { atomIndexVersion: input.atomIndexVersion }
      : {}),
    evidence: input.evidence,
    evidenceManifest: input.evidenceManifest,
    repairBaseHash: input.repairBaseHash,
    ...(diagnostics.length > 0 && input.repairReason !== undefined ? {
      repairDiagnostic: diagnostics[0]!,
      repairReason: input.repairReason
    } : {}),
    request: input.request,
    scopePass: input.scopePass
  });
  if (input.scopePass === "initial") return base;
  const payload = JSON.parse(base.userPrompt) as Record<string, unknown>;
  return Object.freeze({
    systemPrompt: input.atomIndexVersion === 2
      ? `${KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_CONTRACT_V1}\n\n` +
        KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1
      : KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_CONTRACT_V1,
    userPrompt: knowledgeAnswerCanonicalJson({
      ...payload,
      multiDiagnosticRepairProtocol:
        KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_PROTOCOL_V1,
      repairDiagnostics: diagnostics,
      taskReminder: input.scopePass === "repair"
        ? KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_TASK_REMINDER_V1
        : KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6
    })
  });
}

export function decodeKnowledgeCoverageScopePromptV6MultiDiagnosticRepairV1(
  input: Readonly<{
    atomIndexVersion?: KnowledgeCoverageEvidenceAtomIndexVersion;
    evidence: readonly KnowledgeCoverageEvidenceV6[];
    evidenceManifest: string;
    request: string;
    systemPrompt: string;
    userPrompt: string;
  }>
): Readonly<{
  repairBaseHash: string | null;
  repairDiagnostics: readonly KnowledgeCoverageScopeRepairDiagnosticV1[];
  repairReason: KnowledgeCoverageScopeValidationFailureReasonV6 | null;
  scopePass: "initial" | "repair";
}> | null {
  const initial = decodeKnowledgeCoverageScopePromptV6VerifiedPatchV1(input);
  if (initial?.scopePass === "initial") {
    return Object.freeze({
      repairBaseHash: initial.repairBaseHash,
      repairDiagnostics: Object.freeze([]),
      repairReason: initial.repairReason,
      scopePass: initial.scopePass
    });
  }
  const expectedSystemPrompt = input.atomIndexVersion === 2
    ? `${KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_CONTRACT_V1}\n\n` +
      KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1
    : KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_CONTRACT_V1;
  if (input.systemPrompt !== expectedSystemPrompt) return null;
  let value: unknown;
  try {
    value = JSON.parse(input.userPrompt) as unknown;
  } catch {
    return null;
  }
  if (!record(value) || !exactKeys(value, [
    ...(input.atomIndexVersion === 2 ? ["atomProjection"] : []),
    "evidenceContext",
    "evidenceManifestHash",
    "evidenceUnitIndex",
    "multiDiagnosticRepairProtocol",
    "payloadVersion",
    "repairBaseHash",
    "repairDiagnostic",
    "repairDiagnostics",
    "repairFeedbackVersion",
    "repairReason",
    "request",
    "scopePass",
    "taskReminder",
    "validationLimits",
    "verifiedPatchProtocol"
  ])) return null;
  const diagnostics = decodeDiagnostics(value.repairDiagnostics);
  if (!diagnostics || knowledgeAnswerCanonicalJson(value.multiDiagnosticRepairProtocol) !==
      knowledgeAnswerCanonicalJson(KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_PROTOCOL_V1)) {
    return null;
  }
  const basePayload = { ...value };
  delete basePayload.multiDiagnosticRepairProtocol;
  delete basePayload.repairDiagnostics;
  basePayload.taskReminder = value.scopePass === "repair"
    ? KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_TASK_REMINDER_V1
    : KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6;
  const base = decodeKnowledgeCoverageScopePromptV6VerifiedPatchV1({
    ...(input.atomIndexVersion !== undefined
      ? { atomIndexVersion: input.atomIndexVersion }
      : {}),
    evidence: input.evidence,
    evidenceManifest: input.evidenceManifest,
    request: input.request,
    systemPrompt: input.atomIndexVersion === 2
      ? `${KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1}\n\n` +
        KNOWLEDGE_COVERAGE_SOURCE_ORDERED_CONTEXT_CONTRACT_V1
      : KNOWLEDGE_COVERAGE_SCOPE_VERIFIED_PATCH_REPAIR_CONTRACT_V1,
    userPrompt: knowledgeAnswerCanonicalJson(basePayload)
  });
  if (!base || (base.scopePass === "repair") !== (diagnostics.length > 0) ||
    diagnostics.length > 0 && (!base.repairDiagnostic ||
      !sameDiagnostic(diagnostics[0]!, base.repairDiagnostic)) ||
    diagnostics.length === 0 && base.repairDiagnostic !== null ||
    value.taskReminder !== (base.scopePass === "repair"
      ? KNOWLEDGE_COVERAGE_SCOPE_MULTI_DIAGNOSTIC_REPAIR_TASK_REMINDER_V1
      : KNOWLEDGE_COVERAGE_SCOPE_TASK_REMINDER_V6)) return null;
  const expected = knowledgeCoverageScopePromptV6MultiDiagnosticRepairV1({
    ...(input.atomIndexVersion !== undefined
      ? { atomIndexVersion: input.atomIndexVersion }
      : {}),
    evidence: input.evidence,
    evidenceManifest: input.evidenceManifest,
    repairBaseHash: base.repairBaseHash,
    ...(diagnostics.length > 0 && base.repairReason ? {
      repairDiagnostics: diagnostics,
      repairReason: base.repairReason
    } : {}),
    request: input.request,
    scopePass: base.scopePass
  });
  if (expected.systemPrompt !== input.systemPrompt || expected.userPrompt !== input.userPrompt) {
    return null;
  }
  return Object.freeze({
    repairBaseHash: base.repairBaseHash,
    repairDiagnostics: diagnostics,
    repairReason: base.repairReason,
    scopePass: base.scopePass
  });
}
