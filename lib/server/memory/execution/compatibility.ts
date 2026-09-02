import { memoryExecutionSha256 } from "./canonical";
import { memoryExecutionFailure } from "./errors";
import {
  memoryVectorSpaceFingerprint,
  type ResolvedMemoryExecutionTarget
} from "./policy";
import {
  isMemoryEmbeddingRole,
  memoryRoleRequiresForcedToolCall,
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

export type CompatibleMemoryExecution = Readonly<{
  compatibilityId: string;
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
 * quality selection. */
export function resolveMemoryExecutionCompatibility(input: Readonly<{
  role: MemoryExecutionRole;
  target: ResolvedMemoryExecutionTarget;
  versions: MemoryExecutionVersions;
}>): CompatibleMemoryExecution {
  validateMemoryExecutionVersions(input.versions);
  const model = input.target.snapshot.model;
  if (model.adapterKind === "fake") {
    return memoryExecutionFailure("memory_execution_capability_unavailable");
  }
  const embeddingRole = isMemoryEmbeddingRole(input.role);
  const rerankerRole = input.role === "MEMORY_RERANK";
  const vectorSpaceFingerprint = memoryVectorSpaceFingerprint(input.target);
  if (
    embeddingRole !== (vectorSpaceFingerprint !== null) ||
    (embeddingRole && model.modelClass !== "embedding") ||
    (rerankerRole && model.modelClass !== "answer" &&
      model.modelClass !== "reranker") ||
    (!embeddingRole && !rerankerRole && model.modelClass !== "answer") ||
    (model.modelClass === "reranker" && model.adapterKind !== "openrouter_rerank")
  ) return memoryExecutionFailure("memory_execution_capability_unavailable");

  const requiresStrictStructuredOutput = rerankerRole
    ? model.modelClass === "answer"
    : memoryRoleRequiresStrictOutput(input.role);
  const requiresForcedToolCall = memoryRoleRequiresForcedToolCall(input.role);
  if (requiresStrictStructuredOutput && (
    model.capabilities.toolCalling !== true ||
    (requiresForcedToolCall
      ? model.capabilities.forcedToolCalling !== true
      : model.capabilities.structuredOutput !== true)
  )) {
    return memoryExecutionFailure("memory_execution_capability_unavailable");
  }
  const requirement: MemoryExecutionCompatibilityRequirement = {
    compatibilityVersion: "memory-runtime-compatibility-v2",
    ...input.target.compatibilityFingerprints,
    pipelineVersion: input.versions.pipelineVersion,
    policyVersion: input.versions.policyVersion,
    promptVersion: input.versions.promptVersion,
    retrievalConfigFingerprint: input.versions.retrievalConfigFingerprint,
    role: input.role,
    schemaVersion: input.versions.schemaVersion,
    vectorSpaceFingerprint
  };
  return {
    compatibilityId: `compat.${memoryExecutionSha256(requirement)}`,
    requirement,
    requiresStrictStructuredOutput
  };
}
