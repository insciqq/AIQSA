import type { MemoryQualificationRequirement } from "../../../evaluation/memory/qualification";
import {
  normalizeProviderExecutionSnapshot,
  type ProviderExecutionSnapshot
} from "../../providers/runtimeFactory";
import { canonicalMemoryExecutionJson } from "./canonical";
import { memoryExecutionFailure } from "./errors";
import type { ResolvedMemoryExecutionTarget } from "./policy";
import { isMemoryExecutionRole, type MemoryExecutionRole } from "./roles";

const MAX_EXECUTION_SNAPSHOT_BYTES = 128 * 1024;
const sha256 = /^[a-f0-9]{64}$/u;
const safeToken = /^[A-Za-z0-9][A-Za-z0-9._:+@/=-]{0,299}$/u;

export type MemorySecretFreeExecutionSnapshot = Readonly<{
  acceptedUtilityEgressFingerprint: string;
  credentialSource: "default" | "group" | "user";
  destinationFingerprint: string;
  executionTargetFingerprint: string;
  logicalRole: MemoryExecutionRole;
  policyRevision: number | null;
  providerExecutionSnapshot: ProviderExecutionSnapshot;
  qualificationId: string;
  qualificationRequirement: MemoryQualificationRequirement;
  requiresStrictStructuredOutput: boolean;
  utilityPolicyVersion: string;
  version: 1;
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

function validQualificationRequirement(
  value: Record<string, unknown>,
  logicalRole: MemoryExecutionRole
): boolean {
  const exactKeys = [
    "configFingerprint",
    "corpusHash",
    "corpusVersion",
    "deploymentFingerprint",
    "language",
    "modelFingerprint",
    "pipelineVersion",
    "policyVersion",
    "promptVersion",
    "providerFingerprint",
    "retrievalConfigFingerprint",
    "role",
    "schemaVersion",
    "scorerVersion",
    "suiteVersion",
    "vectorSpaceFingerprint"
  ];
  const keys = Object.keys(value).sort();
  if (
    keys.length !== exactKeys.length ||
    !keys.every((key, index) => key === exactKeys[index]) ||
    value.role !== logicalRole ||
    (value.language !== "RU" && value.language !== "EN") ||
    ![
      value.configFingerprint,
      value.corpusHash,
      value.deploymentFingerprint,
      value.modelFingerprint,
      value.providerFingerprint
    ].every((entry) => typeof entry === "string" && sha256.test(entry)) ||
    ![
      value.corpusVersion,
      value.pipelineVersion,
      value.policyVersion,
      value.promptVersion,
      value.retrievalConfigFingerprint,
      value.schemaVersion,
      value.scorerVersion,
      value.suiteVersion
    ].every((entry) => typeof entry === "string" && safeToken.test(entry)) ||
    (value.vectorSpaceFingerprint !== null &&
      (typeof value.vectorSpaceFingerprint !== "string" ||
        !sha256.test(value.vectorSpaceFingerprint)))
  ) {
    return false;
  }
  return true;
}

export function createMemoryExecutionSnapshot(input: Readonly<{
  acceptedUtilityEgressFingerprint: string;
  qualificationId: string;
  qualificationRequirement: MemoryQualificationRequirement;
  requiresStrictStructuredOutput: boolean;
  role: MemoryExecutionRole;
  target: ResolvedMemoryExecutionTarget;
  utilityPolicyVersion: string;
}>): MemorySecretFreeExecutionSnapshot {
  const snapshot: MemorySecretFreeExecutionSnapshot = {
    acceptedUtilityEgressFingerprint: input.acceptedUtilityEgressFingerprint,
    credentialSource: input.target.credentialSource,
    destinationFingerprint: input.target.destinationFingerprint,
    executionTargetFingerprint: input.target.executionTargetFingerprint,
    logicalRole: input.role,
    policyRevision: input.target.policyRevision,
    providerExecutionSnapshot: input.target.snapshot,
    qualificationId: input.qualificationId,
    qualificationRequirement: input.qualificationRequirement,
    requiresStrictStructuredOutput: input.requiresStrictStructuredOutput,
    utilityPolicyVersion: input.utilityPolicyVersion,
    version: 1
  };
  if (!validSnapshotSize(snapshot)) {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
  return parseMemoryExecutionSnapshot(snapshot);
}

export function parseMemoryExecutionSnapshot(value: unknown): MemorySecretFreeExecutionSnapshot {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !validSnapshotSize(value) ||
    typeof value.acceptedUtilityEgressFingerprint !== "string" ||
    !sha256.test(value.acceptedUtilityEgressFingerprint) ||
    typeof value.destinationFingerprint !== "string" ||
    !sha256.test(value.destinationFingerprint) ||
    typeof value.executionTargetFingerprint !== "string" ||
    !sha256.test(value.executionTargetFingerprint) ||
    !isMemoryExecutionRole(value.logicalRole) ||
    (value.credentialSource !== "default" &&
      value.credentialSource !== "group" &&
      value.credentialSource !== "user") ||
    (value.policyRevision !== null &&
      (!Number.isSafeInteger(value.policyRevision) || Number(value.policyRevision) < 1)) ||
    typeof value.requiresStrictStructuredOutput !== "boolean" ||
    typeof value.qualificationId !== "string" ||
    !safeToken.test(value.qualificationId) ||
    typeof value.utilityPolicyVersion !== "string" ||
    !safeToken.test(value.utilityPolicyVersion) ||
    !isRecord(value.qualificationRequirement) ||
    !validQualificationRequirement(value.qualificationRequirement, value.logicalRole)
  ) {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
  let providerExecutionSnapshot: ProviderExecutionSnapshot;
  try {
    providerExecutionSnapshot = normalizeProviderExecutionSnapshot(value.providerExecutionSnapshot);
    canonicalMemoryExecutionJson(value.qualificationRequirement);
  } catch {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
  return Object.freeze({
    acceptedUtilityEgressFingerprint: value.acceptedUtilityEgressFingerprint as string,
    credentialSource: value.credentialSource,
    destinationFingerprint: value.destinationFingerprint as string,
    executionTargetFingerprint: value.executionTargetFingerprint as string,
    logicalRole: value.logicalRole,
    policyRevision: value.policyRevision as number | null,
    providerExecutionSnapshot,
    qualificationId: value.qualificationId as string,
    qualificationRequirement: value.qualificationRequirement as MemoryQualificationRequirement,
    requiresStrictStructuredOutput: value.requiresStrictStructuredOutput,
    utilityPolicyVersion: value.utilityPolicyVersion as string,
    version: 1
  });
}
