import type { LockedMemorySettings } from "../persistence/transaction";
import { memoryExecutionSha256 } from "./canonical";
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

/** Kept as a dependency slot so integrations compiled against v1 do not need
 * an atomic deployment. Runtime compatibility no longer consults a signed
 * registry, language corpus, scorer, benchmark, or installation allowlist. */
export type MemoryQualificationAuthority = Readonly<{
  corpusHash?: string;
  corpusVersion?: string;
  identitiesByRole?: Readonly<Record<string, unknown>>;
  registry?: readonly unknown[];
  scorerVersion?: string;
  suiteVersion?: string;
  verifySignature?: (payload: string, signature: string) => boolean;
}>;

export type MemoryExecutionCompatibilityRequirement = Readonly<{
  compatibilityVersion: "memory-runtime-compatibility-v2";
  configFingerprint: string;
  deploymentFingerprint: string;
  modelFingerprint: string;
  pipelineVersion: string;
  policyVersion: string;
  promptVersion: string;
  providerFingerprint: string;
  retrievalConfigFingerprint: string;
  role: MemoryExecutionRole;
  schemaVersion: string;
  vectorSpaceFingerprint: string | null;
}>;

export type QualifiedMemoryExecution = Readonly<{
  qualificationId: string;
  requirement: MemoryExecutionCompatibilityRequirement;
  requiresStrictStructuredOutput: boolean;
}>;

const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,299}$/u;

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
  ) return memoryExecutionFailure("memory_execution_input_invalid");
}

/** Validates transport and vector compatibility only. Administrators own model
 * quality selection; compatible custom models are not blocked by a registry. */
export function qualifyMemoryExecution(input: Readonly<{
  authority?: MemoryQualificationAuthority;
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
  if (model.adapterKind === "fake") {
    return memoryExecutionFailure("memory_execution_capability_unavailable");
  }
  const embeddingRole = isMemoryEmbeddingRole(input.role);
  const vectorSpaceFingerprint = memoryVectorSpaceFingerprint(input.target);
  if (
    embeddingRole !== (vectorSpaceFingerprint !== null) ||
    (embeddingRole && model.modelClass !== "embedding") ||
    (!embeddingRole && model.modelClass !== "answer")
  ) return memoryExecutionFailure("memory_execution_capability_unavailable");

  const requiresStrictStructuredOutput = memoryRoleRequiresStrictOutput(input.role);
  if (requiresStrictStructuredOutput && model.capabilities.toolCalling !== true) {
    return memoryExecutionFailure("memory_execution_capability_unavailable");
  }
  const requirement: MemoryExecutionCompatibilityRequirement = {
    compatibilityVersion: "memory-runtime-compatibility-v2",
    ...input.target.qualificationFingerprints,
    pipelineVersion: input.versions.pipelineVersion,
    policyVersion: input.versions.policyVersion,
    promptVersion: input.versions.promptVersion,
    retrievalConfigFingerprint: input.versions.retrievalConfigFingerprint,
    role: input.role,
    schemaVersion: input.versions.schemaVersion,
    vectorSpaceFingerprint
  };
  return {
    qualificationId: `compat.${memoryExecutionSha256(requirement)}`,
    requirement,
    requiresStrictStructuredOutput
  };
}
