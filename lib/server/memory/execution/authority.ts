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
  resolveMemoryExecutionCompatibility,
  type CompatibleMemoryExecution,
  type MemoryExecutionVersions,
} from "./compatibility";
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
  requireAdminAcceptedDestination?: typeof requireAdminAcceptedMemoryDestination;
}>;

export type CurrentMemoryExecutionAuthority = Readonly<{
  policy: ResolvedMemoryUtilityPolicy;
  compatibility: CompatibleMemoryExecution;
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
  const compatibility = resolveMemoryExecutionCompatibility({
    role: input.role,
    target,
    versions: input.versions
  });
  return { compatibility, policy, target };
}

function storedRequirementCompatible(
  snapshot: MemorySecretFreeExecutionSnapshot,
  current: CompatibleMemoryExecution
): boolean {
  return snapshot.compatibilityId === current.compatibilityId &&
    canonicalMemoryExecutionJson(snapshot.compatibilityRequirement) ===
      canonicalMemoryExecutionJson(current.requirement);
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
  const requirement = input.snapshot.compatibilityRequirement;
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
      current.compatibility.requiresStrictStructuredOutput ||
    !storedRequirementCompatible(input.snapshot, current.compatibility)
  ) {
    return memoryExecutionFailure("memory_execution_policy_drift");
  }
  return current;
}

export type MemoryExecutionTransaction = Prisma.TransactionClient;
