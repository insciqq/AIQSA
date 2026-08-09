import type { Prisma } from "@prisma/client";
import type { LockedMemorySettings } from "../persistence/transaction";
import { canonicalMemoryExecutionJson } from "./canonical";
import { memoryExecutionFailure } from "./errors";
import {
  requireAcceptedMemoryUtilityPolicy,
  requireMemoryPolicyTarget,
  resolveCurrentMemoryUtilityPolicy,
  type ResolvedMemoryExecutionTarget,
  type ResolvedMemoryUtilityPolicy
} from "./policy";
import {
  qualifyMemoryExecution,
  type MemoryExecutionVersions,
  type MemoryQualificationAuthority,
  type QualifiedMemoryExecution
} from "./qualification";
import type { MemoryExecutionRole } from "./roles";
import type { MemorySecretFreeExecutionSnapshot } from "./snapshot";

export type MemoryExecutionAuthorityDependencies = Readonly<{
  now?: () => Date;
  qualification: MemoryQualificationAuthority;
}>;

export type CurrentMemoryExecutionAuthority = Readonly<{
  policy: ResolvedMemoryUtilityPolicy;
  qualification: QualifiedMemoryExecution;
  target: ResolvedMemoryExecutionTarget;
}>;

type AuthorityPrisma = Parameters<typeof resolveCurrentMemoryUtilityPolicy>[0];

export function memoryExecutionNow(
  dependencies: MemoryExecutionAuthorityDependencies
): Date {
  const candidate = dependencies.now?.() ?? new Date();
  if (!(candidate instanceof Date) || !Number.isFinite(candidate.getTime())) {
    return memoryExecutionFailure("memory_execution_input_invalid");
  }
  return new Date(candidate.getTime());
}

export async function resolveCurrentMemoryExecutionAuthority(
  tx: AuthorityPrisma,
  settings: LockedMemorySettings,
  input: Readonly<{
    dependencies: MemoryExecutionAuthorityDependencies;
    now: Date;
    role: MemoryExecutionRole;
    userId: string;
    versions: MemoryExecutionVersions;
  }>
): Promise<CurrentMemoryExecutionAuthority> {
  const policy = await resolveCurrentMemoryUtilityPolicy(tx, input.userId, settings);
  requireAcceptedMemoryUtilityPolicy(settings, policy);
  const target = requireMemoryPolicyTarget(policy, input.role);
  const qualification = qualifyMemoryExecution({
    authority: input.dependencies.qualification,
    now: input.now,
    role: input.role,
    settings,
    target,
    versions: input.versions
  });
  return { policy, qualification, target };
}

export async function reauthorizeStoredMemoryExecution(
  tx: AuthorityPrisma,
  settings: LockedMemorySettings,
  input: Readonly<{
    dependencies: MemoryExecutionAuthorityDependencies;
    now: Date;
    snapshot: MemorySecretFreeExecutionSnapshot;
    userId: string;
  }>
): Promise<CurrentMemoryExecutionAuthority> {
  const requirement = input.snapshot.qualificationRequirement;
  const current = await resolveCurrentMemoryExecutionAuthority(tx, settings, {
    dependencies: input.dependencies,
    now: input.now,
    role: input.snapshot.logicalRole,
    userId: input.userId,
    versions: {
      pipelineVersion: requirement.pipelineVersion,
      policyVersion: requirement.policyVersion,
      promptVersion: requirement.promptVersion,
      retrievalConfigFingerprint: requirement.retrievalConfigFingerprint,
      schemaVersion: requirement.schemaVersion
    }
  });
  if (
    input.snapshot.acceptedUtilityEgressFingerprint !== current.policy.fingerprint ||
    input.snapshot.utilityPolicyVersion !== current.policy.policyVersion ||
    input.snapshot.destinationFingerprint !== current.target.destinationFingerprint ||
    input.snapshot.executionTargetFingerprint !== current.target.executionTargetFingerprint ||
    input.snapshot.qualificationId !== current.qualification.qualificationId ||
    input.snapshot.requiresStrictStructuredOutput !==
      current.qualification.requiresStrictStructuredOutput ||
    canonicalMemoryExecutionJson(input.snapshot.qualificationRequirement) !==
      canonicalMemoryExecutionJson(current.qualification.requirement)
  ) {
    return memoryExecutionFailure("memory_execution_policy_drift");
  }
  return current;
}

export type MemoryExecutionTransaction = Prisma.TransactionClient;
