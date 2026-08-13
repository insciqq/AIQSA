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
import {
  resolveMemoryEgressConsentMode,
  type MemoryEgressConsentMode
} from "./consentMode";
import { requireAdminAcceptedMemoryDestination } from "./adminConsent";

export type MemoryExecutionAuthorityDependencies = Readonly<{
  egressConsentMode?: MemoryEgressConsentMode;
  now?: () => Date;
  qualification?: MemoryQualificationAuthority;
  requireAdminAcceptedDestination?: typeof requireAdminAcceptedMemoryDestination;
}>;

export type CurrentMemoryExecutionAuthority = Readonly<{
  policy: ResolvedMemoryUtilityPolicy;
  qualification: QualifiedMemoryExecution;
  target: ResolvedMemoryExecutionTarget;
}>;

type AuthorityPrisma = Parameters<typeof resolveCurrentMemoryUtilityPolicy>[0] &
  Pick<Prisma.TransactionClient, "memoryEgressAdminPolicy">;

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
  const target = requireMemoryPolicyTarget(policy, input.role);
  const consentMode = input.dependencies.egressConsentMode ??
    resolveMemoryEgressConsentMode();
  if (consentMode === "ADMIN") {
    await (
      input.dependencies.requireAdminAcceptedDestination ??
      requireAdminAcceptedMemoryDestination
    )(tx, { role: input.role, target });
  } else {
    requireAcceptedMemoryUtilityPolicy(settings, policy, consentMode);
  }
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

function storedRequirementCompatible(
  snapshot: MemorySecretFreeExecutionSnapshot,
  current: QualifiedMemoryExecution
): boolean {
  if (snapshot.version === 2) {
    return snapshot.qualificationId === current.qualificationId &&
      canonicalMemoryExecutionJson(snapshot.qualificationRequirement) ===
        canonicalMemoryExecutionJson(current.requirement);
  }
  const stored = snapshot.qualificationRequirement;
  const active = current.requirement;
  return stored.configFingerprint === active.configFingerprint &&
    stored.deploymentFingerprint === active.deploymentFingerprint &&
    stored.modelFingerprint === active.modelFingerprint &&
    stored.pipelineVersion === active.pipelineVersion &&
    stored.policyVersion === active.policyVersion &&
    stored.promptVersion === active.promptVersion &&
    stored.providerFingerprint === active.providerFingerprint &&
    stored.retrievalConfigFingerprint === active.retrievalConfigFingerprint &&
    stored.role === active.role && stored.schemaVersion === active.schemaVersion &&
    stored.vectorSpaceFingerprint === active.vectorSpaceFingerprint;
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
    input.snapshot.requiresStrictStructuredOutput !==
      current.qualification.requiresStrictStructuredOutput ||
    !storedRequirementCompatible(input.snapshot, current.qualification)
  ) {
    return memoryExecutionFailure("memory_execution_policy_drift");
  }
  return current;
}

export type MemoryExecutionTransaction = Prisma.TransactionClient;
