import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../providers/runtimeFactory";
import { canonicalMemoryExecutionJson } from "./canonical";
import { memoryExecutionFailure } from "./errors";
import type { ResolvedMemoryExecutionTarget } from "./policy";
import type { MemoryExecutionCompatibilityRequirement } from "./compatibility";
import { isMemoryExecutionRole, type MemoryExecutionRole } from "./roles";

const MAX_EXECUTION_SNAPSHOT_BYTES = 128 * 1024;
const sha256 = /^[a-f0-9]{64}$/u;
const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,299}$/u;

type SnapshotBase = Readonly<{
  acceptedUtilityEgressFingerprint: string;
  credentialSource: "default" | "group" | "user";
  destinationFingerprint: string;
  executionTargetFingerprint: string;
  logicalRole: MemoryExecutionRole;
  policyRevision: number | null;
  providerExecutionSnapshot: ProviderExecutionSnapshot;
  compatibilityId: string;
  requiresStrictStructuredOutput: boolean;
  utilityPolicyVersion: string;
}>;

export type MemorySecretFreeExecutionSnapshot = SnapshotBase & Readonly<{
  compatibilityRequirement: MemoryExecutionCompatibilityRequirement;
  version: 2;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validSnapshotSize(value: unknown): boolean {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8") <= MAX_EXECUTION_SNAPSHOT_BYTES;
  } catch {
    return false;
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return keys.length === sorted.length && keys.every((key, index) => key === sorted[index]);
}

function validFingerprintFields(value: Record<string, unknown>): boolean {
  return [
    value.configFingerprint,
    value.deploymentFingerprint,
    value.modelFingerprint,
    value.providerFingerprint
  ].every((entry) => typeof entry === "string" && sha256.test(entry)) &&
    (value.vectorSpaceFingerprint === null ||
      typeof value.vectorSpaceFingerprint === "string" &&
      sha256.test(value.vectorSpaceFingerprint));
}

function validCommonRequirement(
  value: Record<string, unknown>,
  logicalRole: MemoryExecutionRole
): boolean {
  return value.role === logicalRole && validFingerprintFields(value) && [
    value.pipelineVersion,
    value.policyVersion,
    value.promptVersion,
    value.retrievalConfigFingerprint,
    value.schemaVersion
  ].every((entry) => typeof entry === "string" && safeToken.test(entry));
}

function validCompatibilityRequirement(
  value: Record<string, unknown>,
  logicalRole: MemoryExecutionRole
): boolean {
  return exactKeys(value, [
    "compatibilityVersion", "configFingerprint", "deploymentFingerprint",
    "modelFingerprint", "pipelineVersion", "policyVersion", "promptVersion",
    "providerFingerprint", "retrievalConfigFingerprint", "role", "schemaVersion",
    "vectorSpaceFingerprint"
  ]) && value.compatibilityVersion === "memory-runtime-compatibility-v2" &&
    validCommonRequirement(value, logicalRole);
}

export function createMemoryExecutionSnapshot(input: Readonly<{
  acceptedUtilityEgressFingerprint: string;
  compatibilityId: string;
  compatibilityRequirement: MemoryExecutionCompatibilityRequirement;
  requiresStrictStructuredOutput: boolean;
  role: MemoryExecutionRole;
  target: ResolvedMemoryExecutionTarget;
  utilityPolicyVersion: string;
}>): MemorySecretFreeExecutionSnapshot {
  const snapshot = {
    acceptedUtilityEgressFingerprint: input.acceptedUtilityEgressFingerprint,
    credentialSource: input.target.credentialSource,
    destinationFingerprint: input.target.destinationFingerprint,
    executionTargetFingerprint: input.target.executionTargetFingerprint,
    logicalRole: input.role,
    policyRevision: input.target.policyRevision,
    providerExecutionSnapshot: input.target.snapshot,
    compatibilityId: input.compatibilityId,
    compatibilityRequirement: input.compatibilityRequirement,
    requiresStrictStructuredOutput: input.requiresStrictStructuredOutput,
    utilityPolicyVersion: input.utilityPolicyVersion,
    version: 2 as const
  } as MemorySecretFreeExecutionSnapshot;
  if (!validSnapshotSize(snapshot)) {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
  return parseMemoryExecutionSnapshot(snapshot);
}

export function parseMemoryExecutionSnapshot(value: unknown): MemorySecretFreeExecutionSnapshot {
  if (
    !isRecord(value) || value.version !== 2 ||
    !validSnapshotSize(value) ||
    typeof value.acceptedUtilityEgressFingerprint !== "string" ||
    !sha256.test(value.acceptedUtilityEgressFingerprint) ||
    typeof value.destinationFingerprint !== "string" ||
    !sha256.test(value.destinationFingerprint) ||
    typeof value.executionTargetFingerprint !== "string" ||
    !sha256.test(value.executionTargetFingerprint) ||
    !isMemoryExecutionRole(value.logicalRole) ||
    (value.credentialSource !== "default" && value.credentialSource !== "group" &&
      value.credentialSource !== "user") ||
    (value.policyRevision !== null &&
      (!Number.isSafeInteger(value.policyRevision) || Number(value.policyRevision) < 1)) ||
    typeof value.requiresStrictStructuredOutput !== "boolean" ||
    typeof value.compatibilityId !== "string" || !safeToken.test(value.compatibilityId) ||
    typeof value.utilityPolicyVersion !== "string" || !safeToken.test(value.utilityPolicyVersion) ||
    !isRecord(value.compatibilityRequirement) ||
    !validCompatibilityRequirement(value.compatibilityRequirement, value.logicalRole)
  ) return memoryExecutionFailure("memory_execution_snapshot_invalid");

  let providerExecutionSnapshot: ProviderExecutionSnapshot;
  try {
    providerExecutionSnapshot = normalizeProviderExecutionSnapshot(value.providerExecutionSnapshot);
    canonicalMemoryExecutionJson(value.compatibilityRequirement);
  } catch {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
  const base = {
    acceptedUtilityEgressFingerprint: value.acceptedUtilityEgressFingerprint,
    credentialSource: value.credentialSource,
    destinationFingerprint: value.destinationFingerprint,
    executionTargetFingerprint: value.executionTargetFingerprint,
    logicalRole: value.logicalRole,
    policyRevision: value.policyRevision as number | null,
    providerExecutionSnapshot,
    compatibilityId: value.compatibilityId,
    compatibilityRequirement:
      value.compatibilityRequirement as unknown as MemoryExecutionCompatibilityRequirement,
    requiresStrictStructuredOutput: value.requiresStrictStructuredOutput,
    utilityPolicyVersion: value.utilityPolicyVersion
  } as const;
  return Object.freeze({ ...base, version: 2 as const });
}
