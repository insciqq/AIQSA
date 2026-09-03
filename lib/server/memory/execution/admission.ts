import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "../../prisma";
import {
  withLockedMemoryTransaction,
  type MemoryTransaction
} from "../persistence/transaction";
import {
  memoryExecutionNow,
  reauthorizeStoredMemoryExecution,
  resolveCurrentMemoryExecutionAuthority,
  type MemoryExecutionAuthorityDependencies
} from "./authority";
import { canonicalMemoryExecutionJson } from "./canonical";
import { memoryExecutionFailure } from "./errors";
import {
  isValidMemoryExecutionIdentifier,
  memoryExecutionOwnerData,
  memoryExecutionOwnerWhere,
  storedMemoryExecutionOwner,
  type MemoryExecutionOwner
} from "./owner";
import type { MemoryExecutionVersions } from "./compatibility";
import { isMemoryExecutionRole, type MemoryExecutionRole } from "./roles";
import {
  createMemoryExecutionSnapshot,
  parseMemoryExecutionSnapshot,
  type MemorySecretFreeExecutionSnapshot
} from "./snapshot";

const sha256 = /^[a-f0-9]{64}$/u;

export const memoryExecutionBindingSelect = {
  acceptedOutputHash: true,
  completedAt: true,
  connectionId: true,
  createdAt: true,
  credentialId: true,
  credentialVersionId: true,
  destinationFingerprint: true,
  errorCode: true,
  id: true,
  inboundMcpRequestId: true,
  inputHash: true,
  inputTokens: true,
  logicalRole: true,
  memoryJobId: true,
  modelRunId: true,
  modelRunToolCallId: true,
  mutationAuthorizationId: true,
  ordinal: true,
  outputTokens: true,
  ownerType: true,
  pipelineVersion: true,
  policyVersion: true,
  promptVersion: true,
  providerId: true,
  providerModelId: true,
  providerResponseId: true,
  recoverableUntil: true,
  relationsDetachedAt: true,
  retrievalAttemptId: true,
  reasoningTokens: true,
  schemaVersion: true,
  secretFreeExecutionSnapshot: true,
  startedAt: true,
  state: true,
  totalTokens: true,
  usageCompleteness: true,
  cachedInputTokens: true,
  estimatedCostMicros: true,
  userId: true
} satisfies Prisma.MemoryExecutionBindingSelect;

export type MemoryExecutionBindingRecord = Prisma.MemoryExecutionBindingGetPayload<{
  select: typeof memoryExecutionBindingSelect;
}>;

export type MemoryExecutionBindingView = Readonly<{
  createdAt: Date;
  id: string;
  inputHash: string;
  logicalRole: MemoryExecutionRole;
  ordinal: number;
  owner: MemoryExecutionOwner;
  replayed: boolean;
  state: MemoryExecutionBindingRecord["state"];
}>;

export type StartedMemoryExecution = Readonly<{
  bindingId: string;
  owner: MemoryExecutionOwner;
  snapshot: MemorySecretFreeExecutionSnapshot;
  startedAt: Date;
}>;

export type MemoryExecutionBindingLink = Readonly<{
  sourceBindingId: string;
}>;

export type BindMemoryExecutionInput = Readonly<{
  inputHash: string;
  ordinal: number;
  owner: MemoryExecutionOwner;
  role: MemoryExecutionRole;
  targetProviderModelId?: string;
  versions: MemoryExecutionVersions;
}>;

function validOrdinal(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000;
}

async function assertActiveExecutionOwner(
  tx: MemoryTransaction,
  userId: string,
  owner: MemoryExecutionOwner,
  now: Date
): Promise<void> {
  if (owner.type === "JOB" || owner.type === "MODEL_RUN_TOOL_CALL" ||
    owner.type === "INBOUND_MCP_REQUEST") return;
  const rows = owner.type === "RETRIEVAL_ATTEMPT"
    ? await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "MemoryRetrievalAttempt"
        WHERE "id" = ${owner.retrievalAttemptId}
          AND "userId" = ${userId}
          AND "state" = 'EXECUTING'::"MemoryRetrievalAttemptState"
          AND "expiresAt" > ${now}
        FOR SHARE
      `)
    : await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT "id"
        FROM "MemoryMutationAuthorization"
        WHERE "id" = ${owner.mutationAuthorizationId}
          AND "userId" = ${userId}
          AND "consumedAt" IS NULL
          AND "expiresAt" > ${now}
        FOR SHARE
      `);
  if (!rows[0]) return memoryExecutionFailure("memory_execution_state_conflict");
}

function bindingView(
  record: MemoryExecutionBindingRecord,
  replayed: boolean
): MemoryExecutionBindingView {
  if (!isMemoryExecutionRole(record.logicalRole)) {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
  return {
    createdAt: record.createdAt,
    id: record.id,
    inputHash: record.inputHash,
    logicalRole: record.logicalRole,
    ordinal: record.ordinal,
    owner: storedMemoryExecutionOwner(record),
    replayed,
    state: record.state
  };
}

export function assertMemoryExecutionBindingLineage(
  binding: MemoryExecutionBindingRecord,
  snapshot: MemorySecretFreeExecutionSnapshot
): void {
  const provider = snapshot.providerExecutionSnapshot;
  if (
    binding.logicalRole !== snapshot.logicalRole ||
    binding.destinationFingerprint !== snapshot.destinationFingerprint ||
    binding.connectionId !== provider.connectionId ||
    binding.providerId !== provider.providerFamily ||
    binding.providerModelId !== provider.providerModelId ||
    binding.credentialId !== provider.credentialId ||
    binding.credentialVersionId !== provider.credentialVersionId ||
    binding.policyVersion !== snapshot.compatibilityRequirement.policyVersion ||
    binding.promptVersion !== snapshot.compatibilityRequirement.promptVersion ||
    binding.schemaVersion !== snapshot.compatibilityRequirement.schemaVersion ||
    binding.pipelineVersion !== snapshot.compatibilityRequirement.pipelineVersion ||
    binding.relationsDetachedAt !== null
  ) {
    return memoryExecutionFailure("memory_execution_snapshot_invalid");
  }
}

export function assertMemoryExecutionBindingLink(
  binding: MemoryExecutionBindingRecord,
  snapshot: MemorySecretFreeExecutionSnapshot,
  source: MemoryExecutionBindingRecord,
  sourceSnapshot: MemorySecretFreeExecutionSnapshot
): void {
  if (
    binding.id === source.id ||
    binding.userId !== source.userId ||
    binding.logicalRole !== source.logicalRole ||
    binding.ordinal <= source.ordinal ||
    source.state !== "SUCCEEDED" ||
    source.acceptedOutputHash === null ||
    source.relationsDetachedAt !== null ||
    canonicalMemoryExecutionJson(storedMemoryExecutionOwner(binding)) !==
      canonicalMemoryExecutionJson(storedMemoryExecutionOwner(source))
  ) {
    return memoryExecutionFailure("memory_execution_state_conflict");
  }
  if (
    binding.destinationFingerprint !== source.destinationFingerprint ||
    snapshot.acceptedUtilityEgressFingerprint !==
      sourceSnapshot.acceptedUtilityEgressFingerprint ||
    snapshot.destinationFingerprint !== sourceSnapshot.destinationFingerprint ||
    snapshot.executionTargetFingerprint !== sourceSnapshot.executionTargetFingerprint ||
    snapshot.utilityPolicyVersion !== sourceSnapshot.utilityPolicyVersion
  ) {
    return memoryExecutionFailure("memory_execution_policy_drift");
  }
}

function samePendingBinding(
  binding: MemoryExecutionBindingRecord,
  input: BindMemoryExecutionInput,
  expectedSnapshot: MemorySecretFreeExecutionSnapshot
): boolean {
  return binding.inputHash === input.inputHash &&
    binding.logicalRole === input.role &&
    binding.ordinal === input.ordinal &&
    binding.destinationFingerprint === expectedSnapshot.destinationFingerprint &&
    binding.policyVersion === input.versions.policyVersion &&
    binding.promptVersion === input.versions.promptVersion &&
    binding.schemaVersion === input.versions.schemaVersion &&
    binding.pipelineVersion === input.versions.pipelineVersion &&
    canonicalMemoryExecutionJson(binding.secretFreeExecutionSnapshot) ===
      canonicalMemoryExecutionJson(expectedSnapshot);
}

export async function loadMemoryExecutionBinding(
  tx: MemoryTransaction,
  userId: string,
  bindingId: string
): Promise<MemoryExecutionBindingRecord> {
  const binding = await tx.memoryExecutionBinding.findFirst({
    select: memoryExecutionBindingSelect,
    where: { id: bindingId, userId }
  });
  return binding ?? memoryExecutionFailure("memory_execution_binding_not_found");
}

export function createPrismaMemoryExecutionAdmission(
  dependencies: MemoryExecutionAuthorityDependencies,
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async bind(
      userId: string,
      input: BindMemoryExecutionInput
    ): Promise<MemoryExecutionBindingView> {
      if (
        !isValidMemoryExecutionIdentifier(userId) ||
        !sha256.test(input.inputHash) ||
        !validOrdinal(input.ordinal) ||
        !isMemoryExecutionRole(input.role) ||
        (input.targetProviderModelId !== undefined && (
          input.role !== "MEMORY_RERANK" ||
          !isValidMemoryExecutionIdentifier(input.targetProviderModelId)
        ))
      ) {
        return memoryExecutionFailure("memory_execution_input_invalid");
      }
      const ownerData = memoryExecutionOwnerData(input.owner);
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const now = memoryExecutionNow(dependencies);
        await assertActiveExecutionOwner(tx, userId, input.owner, now);
        const authority = await resolveCurrentMemoryExecutionAuthority(tx, settings, {
          dependencies,
          now,
          role: input.role,
          ...(input.targetProviderModelId
            ? { targetProviderModelId: input.targetProviderModelId }
            : {}),
          userId,
          versions: input.versions
        });
        const snapshot = createMemoryExecutionSnapshot({
          acceptedUtilityEgressFingerprint: authority.policy.fingerprint,
          compatibilityId: authority.compatibility.compatibilityId,
          compatibilityRequirement: authority.compatibility.requirement,
          requiresStrictStructuredOutput:
            authority.compatibility.requiresStrictStructuredOutput,
          role: input.role,
          target: authority.target,
          utilityPolicyVersion: authority.policy.policyVersion
        });
        const existing = await tx.memoryExecutionBinding.findFirst({
          select: memoryExecutionBindingSelect,
          where: {
            ...memoryExecutionOwnerWhere(userId, input.owner),
            logicalRole: input.role,
            ordinal: input.ordinal
          }
        });
        if (existing) {
          if (!samePendingBinding(existing, input, snapshot)) {
            return memoryExecutionFailure("memory_execution_binding_conflict");
          }
          return bindingView(existing, true);
        }

        const provider = authority.target.snapshot;
        if (!provider.credentialId || !provider.credentialVersionId) {
          return memoryExecutionFailure("memory_execution_target_unavailable");
        }
        const created = await tx.memoryExecutionBinding.create({
          data: {
            ...ownerData,
            connectionId: provider.connectionId,
            createdAt: now,
            credentialId: provider.credentialId,
            credentialVersionId: provider.credentialVersionId,
            destinationFingerprint: authority.target.destinationFingerprint,
            inputHash: input.inputHash,
            logicalRole: input.role,
            ordinal: input.ordinal,
            pipelineVersion: input.versions.pipelineVersion,
            policyVersion: input.versions.policyVersion,
            promptVersion: input.versions.promptVersion,
            providerId: provider.providerFamily,
            providerModelId: provider.providerModelId,
            schemaVersion: input.versions.schemaVersion,
            secretFreeExecutionSnapshot: snapshot as unknown as Prisma.InputJsonValue,
            userId
          },
          select: memoryExecutionBindingSelect
        });
        return bindingView(created, false);
      });
    },

    async start(
      userId: string,
      bindingId: string,
      link?: MemoryExecutionBindingLink
    ): Promise<StartedMemoryExecution> {
      if (
        !isValidMemoryExecutionIdentifier(userId) ||
        !isValidMemoryExecutionIdentifier(bindingId) ||
        (link !== undefined && !isValidMemoryExecutionIdentifier(link.sourceBindingId))
      ) {
        return memoryExecutionFailure("memory_execution_input_invalid");
      }
      return withLockedMemoryTransaction(client, userId, async (tx, settings) => {
        const now = memoryExecutionNow(dependencies);
        const binding = await loadMemoryExecutionBinding(tx, userId, bindingId);
        if (binding.state !== "PENDING") {
          return memoryExecutionFailure("memory_execution_state_conflict");
        }
        await assertActiveExecutionOwner(
          tx,
          userId,
          storedMemoryExecutionOwner(binding),
          now
        );
        const snapshot = parseMemoryExecutionSnapshot(binding.secretFreeExecutionSnapshot);
        assertMemoryExecutionBindingLineage(binding, snapshot);
        await reauthorizeStoredMemoryExecution(tx, settings, {
          dependencies,
          now,
          snapshot,
          userId
        });
        if (link) {
          const source = await loadMemoryExecutionBinding(
            tx,
            userId,
            link.sourceBindingId
          );
          const sourceSnapshot = parseMemoryExecutionSnapshot(
            source.secretFreeExecutionSnapshot
          );
          assertMemoryExecutionBindingLineage(source, sourceSnapshot);
          await reauthorizeStoredMemoryExecution(tx, settings, {
            dependencies,
            now,
            snapshot: sourceSnapshot,
            userId
          });
          assertMemoryExecutionBindingLink(binding, snapshot, source, sourceSnapshot);
        }
        // Wall clocks can step backwards by a few milliseconds while many
        // provider calls are completing. Preserve the durable state-machine
        // ordering instead of letting harmless clock skew violate the DB
        // shape constraint.
        const startedAt = new Date(Math.max(
          now.getTime(),
          binding.createdAt.getTime()
        ));
        const started = await tx.memoryExecutionBinding.updateMany({
          data: { startedAt, state: "RUNNING" },
          where: {
            id: binding.id,
            relationsDetachedAt: null,
            state: "PENDING",
            userId
          }
        });
        if (started.count !== 1) {
          return memoryExecutionFailure("memory_execution_state_conflict");
        }
        return {
          bindingId: binding.id,
          owner: storedMemoryExecutionOwner(binding),
          snapshot,
          startedAt
        };
      });
    }
  });
}

export type MemoryExecutionAdmission = ReturnType<
  typeof createPrismaMemoryExecutionAdmission
>;
