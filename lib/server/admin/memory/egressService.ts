import { Prisma, type PrismaClient } from "@prisma/client";
import type {
  AdminMemoryDestinationId,
  AdminMemoryDestinationRow,
  AdminMemoryEgressAcknowledgeInput,
  AdminMemoryEgressSettings
} from "../../../contracts/adminMemory";
import {
  canonicalMemoryAdminDestinations,
  currentMemoryAdminDestinations,
  decodeMemoryAdminDestinations,
  memoryAdminDestinationsFingerprint,
  type MemoryAdminAcceptedDestination
} from "../../memory/execution/adminConsent";
import { resolveMemoryEgressConsentMode } from "../../memory/execution/consentMode";
import {
  MEMORY_UTILITY_EGRESS_POLICY_VERSION,
  resolveCurrentMemoryUtilityPolicy,
  type ResolvedMemoryUtilityPolicy
} from "../../memory/execution/policy";
import {
  isMemoryEmbeddingRole,
  type MemoryExecutionRole
} from "../../memory/execution/roles";

export type AdminMemoryEgressServiceErrorCode =
  | "memory_admin_egress_per_user_mode"
  | "memory_admin_egress_policy_changed"
  | "memory_admin_egress_policy_missing"
  | "memory_admin_egress_stale";

export class AdminMemoryEgressServiceError extends Error {
  constructor(readonly code: AdminMemoryEgressServiceErrorCode) {
    super(code);
    this.name = "AdminMemoryEgressServiceError";
  }
}

type OwnerSettings = Readonly<{
  embeddingProviderModelId: string | null;
  userId: string;
}>;

type PolicyResolver = (
  tx: Prisma.TransactionClient,
  userId: string,
  settings: Pick<OwnerSettings, "embeddingProviderModelId">
) => Promise<ResolvedMemoryUtilityPolicy>;

type CurrentSnapshot = Readonly<{
  destinations: readonly MemoryAdminAcceptedDestination[];
  fingerprint: string;
  policies: readonly ResolvedMemoryUtilityPolicy[];
}>;

const SYSTEM_ROLES = new Set<MemoryExecutionRole>([
  "MEMORY_CONSOLIDATE",
  "MEMORY_EPISODE_EXTRACT",
  "MEMORY_FACT_EXTRACT",
  "MEMORY_PROFILE",
  "MEMORY_QUERY_EXPAND",
  "MEMORY_VERIFY"
]);

function boundedLabel(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "Configured destination";
  const candidate = trimmed.slice(0, 256);
  return /[\uD800-\uDBFF]$/u.test(candidate) ? candidate.slice(0, -1) : candidate;
}

function targetLabel(policy: ResolvedMemoryUtilityPolicy, role: MemoryExecutionRole): string | null {
  const target = policy.targets.get(role);
  if (!target) return null;
  return boundedLabel(
    `${target.snapshot.connectionDisplayName} / ${target.snapshot.modelDisplayName}`
  );
}

function acceptedKey(destination: MemoryAdminAcceptedDestination): string {
  return `${destination.role}:${destination.destinationFingerprint}`;
}

function groupedRow(
  id: AdminMemoryDestinationId,
  policies: readonly ResolvedMemoryUtilityPolicy[],
  accepted: ReadonlySet<string>,
  include: (role: MemoryExecutionRole) => boolean,
  consentMode: "ADMIN" | "PER_USER"
): AdminMemoryDestinationRow {
  const labels = new Set<string>();
  let reviewRequired = false;
  for (const policy of policies) {
    for (const destination of policy.destinations) {
      if (destination.kind !== "AVAILABLE" || !include(destination.role)) continue;
      const label = targetLabel(policy, destination.role);
      if (label) labels.add(label);
      if (!accepted.has(acceptedKey({
        destinationFingerprint: destination.target.destinationFingerprint,
        role: destination.role
      }))) {
        reviewRequired = true;
      }
    }
  }
  return {
    destinations: [...labels].sort((left, right) => left.localeCompare(right)).slice(0, 128),
    id,
    reviewRequired: consentMode === "ADMIN" && reviewRequired,
    state: labels.size > 0 ? "AVAILABLE" : "UNAVAILABLE"
  };
}

async function currentSnapshot(
  tx: Prisma.TransactionClient,
  resolveOwnerPolicy: PolicyResolver
): Promise<CurrentSnapshot> {
  const owners = await tx.user.findMany({
    orderBy: { id: "asc" },
    select: { id: true },
    where: { status: "active" }
  });
  const settings = owners.length === 0
    ? []
    : await tx.userMemorySettings.findMany({
        orderBy: { userId: "asc" },
        select: { embeddingProviderModelId: true, userId: true },
        where: { userId: { in: owners.map(({ id }) => id) } }
      });
  const policies: ResolvedMemoryUtilityPolicy[] = [];
  for (const owner of settings) {
    policies.push(await resolveOwnerPolicy(tx, owner.userId, owner));
  }
  const destinations = currentMemoryAdminDestinations(policies);
  return {
    destinations,
    fingerprint: memoryAdminDestinationsFingerprint(destinations),
    policies
  };
}

function project(
  policy: Readonly<{
    acceptedAt: Date | null;
    acceptedBy: { displayName: string; id: string } | null;
    acceptedDestinations: Prisma.JsonValue;
    acceptedFingerprint: string | null;
    acceptedPolicyVersion: string | null;
    version: number;
  }>,
  snapshot: CurrentSnapshot,
  waitingJobCount: number,
  consentMode: "ADMIN" | "PER_USER"
): AdminMemoryEgressSettings {
  const acceptedDestinations = decodeMemoryAdminDestinations(policy.acceptedDestinations) ?? [];
  const accepted = new Set(acceptedDestinations.map(acceptedKey));
  const reviewRequired = consentMode === "ADMIN" && (
    policy.acceptedFingerprint !== snapshot.fingerprint ||
    policy.acceptedPolicyVersion !== MEMORY_UTILITY_EGRESS_POLICY_VERSION ||
    decodeMemoryAdminDestinations(policy.acceptedDestinations) === null
  );
  return {
    acceptedAt: policy.acceptedAt?.toISOString() ?? null,
    acceptedBy: policy.acceptedBy
      ? {
          displayName: boundedLabel(policy.acceptedBy.displayName).slice(0, 200),
          id: policy.acceptedBy.id
        }
      : null,
    acceptedFingerprint: policy.acceptedFingerprint,
    acceptedPolicyVersion: policy.acceptedPolicyVersion,
    consentMode,
    currentFingerprint: snapshot.fingerprint,
    currentPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
    destinations: [
      {
        destinations: ["Selected and bound for each accepted run"],
        id: "answer_provider",
        reviewRequired: false,
        state: "BOUND_PER_RUN"
      },
      groupedRow(
        "system_model",
        snapshot.policies,
        accepted,
        (role) => SYSTEM_ROLES.has(role),
        consentMode
      ),
      groupedRow(
        "embedding",
        snapshot.policies,
        accepted,
        isMemoryEmbeddingRole,
        consentMode
      ),
      groupedRow(
        "remote_reranker",
        snapshot.policies,
        accepted,
        (role) => role === "MEMORY_RERANK",
        consentMode
      )
    ],
    reviewRequired,
    version: policy.version,
    waitingJobCount
  };
}

export function createAdminMemoryEgressService(
  client: PrismaClient,
  options: Readonly<{
    consentMode?: "ADMIN" | "PER_USER";
    onAcknowledged?: () => void;
    resolveOwnerPolicy?: PolicyResolver;
  }> = {}
) {
  const consentMode = options.consentMode ?? resolveMemoryEgressConsentMode();
  const resolveOwnerPolicy = options.resolveOwnerPolicy ?? resolveCurrentMemoryUtilityPolicy;

  async function read(tx: Prisma.TransactionClient): Promise<AdminMemoryEgressSettings> {
    const [policy, snapshot, waitingJobCount] = await Promise.all([
      tx.memoryEgressAdminPolicy.findUnique({
        include: { acceptedBy: { select: { displayName: true, id: true } } },
        where: { id: "installation" }
      }),
      currentSnapshot(tx, resolveOwnerPolicy),
      tx.memoryJob.count({ where: { state: "WAITING_FOR_EGRESS_CONSENT" } })
    ]);
    if (!policy) {
      throw new AdminMemoryEgressServiceError("memory_admin_egress_policy_missing");
    }
    return project(policy, snapshot, waitingJobCount, consentMode);
  }

  return Object.freeze({
    async acknowledge(
      adminUserId: string,
      input: AdminMemoryEgressAcknowledgeInput
    ): Promise<AdminMemoryEgressSettings> {
      if (consentMode !== "ADMIN") {
        throw new AdminMemoryEgressServiceError("memory_admin_egress_per_user_mode");
      }
      await client.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
          SELECT "id" FROM "MemoryEgressAdminPolicy"
          WHERE "id" = 'installation'
          FOR UPDATE
        `);
        const current = await tx.memoryEgressAdminPolicy.findUnique({
          select: { version: true },
          where: { id: "installation" }
        });
        if (!current) {
          throw new AdminMemoryEgressServiceError("memory_admin_egress_policy_missing");
        }
        if (current.version !== input.expectedVersion) {
          throw new AdminMemoryEgressServiceError("memory_admin_egress_stale");
        }
        const snapshot = await currentSnapshot(tx, resolveOwnerPolicy);
        if (snapshot.fingerprint !== input.currentFingerprint) {
          throw new AdminMemoryEgressServiceError("memory_admin_egress_policy_changed");
        }
        const destinations = canonicalMemoryAdminDestinations(snapshot.destinations);
        const updated = await tx.memoryEgressAdminPolicy.updateMany({
          data: {
            acceptedAt: new Date(),
            acceptedByUserId: adminUserId,
            acceptedDestinations: destinations as Prisma.InputJsonValue,
            acceptedFingerprint: snapshot.fingerprint,
            acceptedPolicyVersion: MEMORY_UTILITY_EGRESS_POLICY_VERSION,
            version: { increment: 1 }
          },
          where: { id: "installation", version: input.expectedVersion }
        });
        if (updated.count !== 1) {
          throw new AdminMemoryEgressServiceError("memory_admin_egress_stale");
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      options.onAcknowledged?.();
      return client.$transaction((tx) => read(tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    },

    async get(): Promise<AdminMemoryEgressSettings> {
      return client.$transaction((tx) => read(tx), {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead
      });
    }
  });
}
