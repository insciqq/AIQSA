import type {
  MemoryCapabilityQualification,
  MemoryQualificationRequirement,
  MemoryQualificationSignatureVerifier
} from "../../../evaluation/memory/qualification";
import { decideMemoryCapabilityQualification } from "../../../evaluation/memory/qualification";
import type { LockedMemorySettings } from "../persistence/transaction";
import { memoryExecutionFailure } from "./errors";
import {
  memoryVectorSpaceFingerprint,
  type ResolvedMemoryExecutionTarget
} from "./policy";
import {
  isMemoryEmbeddingRole,
  memoryRoleRequiresStrictOutput,
  type MemoryExecutionRole
} from "./roles";

export type MemoryExecutionVersions = Readonly<{
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  retrievalConfigFingerprint: string;
  schemaVersion: string;
}>;

export type MemoryQualificationEvidenceIdentity = Readonly<{
  corpusHash: string;
  corpusVersion: string;
  scorerVersion: string;
  suiteVersion: string;
}>;

export type MemoryQualificationAuthority = MemoryQualificationEvidenceIdentity & Readonly<{
  identitiesByRole?: Readonly<Partial<Record<
    MemoryExecutionRole,
    MemoryQualificationEvidenceIdentity
  >>>;
  registry: readonly MemoryCapabilityQualification[];
  verifySignature: MemoryQualificationSignatureVerifier;
}>;

export type QualifiedMemoryExecution = Readonly<{
  qualificationId: string;
  requirement: MemoryQualificationRequirement;
  requiresStrictStructuredOutput: boolean;
}>;

const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,299}$/u;
const sha256 = /^[a-f0-9]{64}$/u;

function validVersion(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && safeToken.test(value);
}

export function validateMemoryExecutionVersions(versions: MemoryExecutionVersions): void {
  if (
    !validVersion(versions.pipelineVersion) ||
    !validVersion(versions.policyVersion) ||
    !validVersion(versions.promptVersion) ||
    !safeToken.test(versions.retrievalConfigFingerprint) ||
    !validVersion(versions.schemaVersion)
  ) {
    return memoryExecutionFailure("memory_execution_input_invalid");
  }
}

export function qualifyMemoryExecution(input: Readonly<{
  authority: MemoryQualificationAuthority;
  now: Date;
  role: MemoryExecutionRole;
  settings: Pick<LockedMemorySettings, "memoryUiLocale">;
  target: ResolvedMemoryExecutionTarget;
  versions: MemoryExecutionVersions;
}>): QualifiedMemoryExecution {
  validateMemoryExecutionVersions(input.versions);
  if (!(input.now instanceof Date) || !Number.isFinite(input.now.getTime())) {
    return memoryExecutionFailure("memory_execution_input_invalid");
  }
  const model = input.target.snapshot.model;
  const embeddingRole = isMemoryEmbeddingRole(input.role);
  const vectorSpaceFingerprint = memoryVectorSpaceFingerprint(input.target);
  const evidenceIdentity = input.authority.identitiesByRole?.[input.role] ??
    input.authority;
  if (
    !sha256.test(evidenceIdentity.corpusHash) ||
    !safeToken.test(evidenceIdentity.corpusVersion) ||
    !safeToken.test(evidenceIdentity.scorerVersion) ||
    !safeToken.test(evidenceIdentity.suiteVersion) ||
    !Array.isArray(input.authority.registry) ||
    typeof input.authority.verifySignature !== "function" ||
    embeddingRole !== (vectorSpaceFingerprint !== null) ||
    model.adapterKind === "fake" ||
    (embeddingRole && model.modelClass !== "embedding") ||
    (!embeddingRole && model.modelClass !== "answer")
  ) {
    return memoryExecutionFailure("memory_execution_capability_unavailable");
  }

  const requiresStrictStructuredOutput = memoryRoleRequiresStrictOutput(input.role);
  if (requiresStrictStructuredOutput && model.capabilities.toolCalling !== true) {
    return memoryExecutionFailure("memory_execution_capability_unavailable");
  }

  const requirement: MemoryQualificationRequirement = {
    ...input.target.qualificationFingerprints,
    corpusHash: evidenceIdentity.corpusHash,
    corpusVersion: evidenceIdentity.corpusVersion,
    language: input.settings.memoryUiLocale,
    pipelineVersion: input.versions.pipelineVersion,
    policyVersion: input.versions.policyVersion,
    promptVersion: input.versions.promptVersion,
    retrievalConfigFingerprint: input.versions.retrievalConfigFingerprint,
    role: input.role,
    schemaVersion: input.versions.schemaVersion,
    scorerVersion: evidenceIdentity.scorerVersion,
    suiteVersion: evidenceIdentity.suiteVersion,
    vectorSpaceFingerprint
  };
  const result = decideMemoryCapabilityQualification({
    now: input.now.toISOString(),
    registry: input.authority.registry,
    requirement,
    verifySignature: input.authority.verifySignature
  });
  if (!result.qualified || !result.qualificationId) {
    return memoryExecutionFailure("memory_execution_qualification_required");
  }
  return {
    qualificationId: result.qualificationId,
    requirement,
    requiresStrictStructuredOutput
  };
}
