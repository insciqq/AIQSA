import type { Prisma } from "@prisma/client";
import { memoryExecutionFailure } from "./errors";
import { memoryExecutionSha256 } from "./canonical";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  type ResolvedMemoryExecutionTarget,
  type ResolvedMemoryUtilityPolicy
} from "./policy";
import {
  isMemoryExecutionRole,
  type MemoryExecutionRole
} from "./roles";

export const MEMORY_ADMIN_ACCEPTED_DESTINATIONS_MAX = 8_192;

export type MemoryAdminAcceptedDestination = Readonly<{
  destinationFingerprint: string;
  role: MemoryExecutionRole;
}>;

type MemoryAdminConsentPrisma = Pick<
  Prisma.TransactionClient,
  "memoryEgressAdminPolicy"
>;

const sha256 = /^[a-f0-9]{64}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareDestinations(
  left: MemoryAdminAcceptedDestination,
  right: MemoryAdminAcceptedDestination
): number {
  return left.role.localeCompare(right.role) ||
    left.destinationFingerprint.localeCompare(right.destinationFingerprint);
}

export function canonicalMemoryAdminDestinations(
  destinations: readonly MemoryAdminAcceptedDestination[]
): MemoryAdminAcceptedDestination[] {
  const unique = new Map<string, MemoryAdminAcceptedDestination>();
  for (const destination of destinations) {
    if (
      !isMemoryExecutionRole(destination.role) ||
      !sha256.test(destination.destinationFingerprint)
    ) {
      throw new Error("memory_admin_egress_destination_invalid");
    }
    unique.set(
      `${destination.role}:${destination.destinationFingerprint}`,
      Object.freeze({
        destinationFingerprint: destination.destinationFingerprint,
        role: destination.role
      })
    );
  }
  if (unique.size > MEMORY_ADMIN_ACCEPTED_DESTINATIONS_MAX) {
    throw new Error("memory_admin_egress_policy_too_large");
  }
  return [...unique.values()].sort(compareDestinations);
}

export function currentMemoryAdminDestinations(
  policies: readonly ResolvedMemoryUtilityPolicy[]
): MemoryAdminAcceptedDestination[] {
  return canonicalMemoryAdminDestinations(policies.flatMap((policy) => [
    ...policy.destinations.flatMap((destination) => destination.kind === "AVAILABLE"
      ? [{
          destinationFingerprint: destination.target.destinationFingerprint,
          role: destination.role
        }]
      : []),
    ...(policy.rerankerTargets ?? []).map((target) => ({
      destinationFingerprint: target.destinationFingerprint,
      role: "MEMORY_RERANK" as const
    }))
  ]));
}

export function decodeMemoryAdminDestinations(
  value: unknown
): MemoryAdminAcceptedDestination[] | null {
  if (!Array.isArray(value) || value.length > MEMORY_ADMIN_ACCEPTED_DESTINATIONS_MAX) {
    return null;
  }
  const decoded: MemoryAdminAcceptedDestination[] = [];
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).sort().join(",") !== "destinationFingerprint,role" ||
      !isMemoryExecutionRole(entry.role) ||
      typeof entry.destinationFingerprint !== "string" ||
      !sha256.test(entry.destinationFingerprint)
    ) {
      return null;
    }
    decoded.push({
      destinationFingerprint: entry.destinationFingerprint,
      role: entry.role
    });
  }
  try {
    return canonicalMemoryAdminDestinations(decoded);
  } catch {
    return null;
  }
}

export function memoryAdminDestinationsFingerprint(
  destinations: readonly MemoryAdminAcceptedDestination[]
): string {
  return memoryExecutionSha256({
    destinations: canonicalMemoryAdminDestinations(destinations),
    policyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION
  });
}

export async function requireAdminAcceptedMemoryDestination(
  tx: MemoryAdminConsentPrisma,
  input: Readonly<{
    role: MemoryExecutionRole;
    target: ResolvedMemoryExecutionTarget;
  }>
): Promise<void> {
  const accepted = await tx.memoryEgressAdminPolicy.findUnique({
    select: {
      acceptedAt: true,
      acceptedDestinations: true,
      acceptedPolicyVersion: true
    },
    where: { id: "installation" }
  });
  const destinations = decodeMemoryAdminDestinations(accepted?.acceptedDestinations);
  if (
    !accepted?.acceptedAt ||
    accepted.acceptedPolicyVersion !== MEMORY_UTILITY_EGRESS_POLICY_VERSION ||
    !destinations?.some((destination) =>
      destination.role === input.role &&
      destination.destinationFingerprint === input.target.destinationFingerprint)
  ) {
    return memoryExecutionFailure("memory_execution_egress_consent_required");
  }
}
