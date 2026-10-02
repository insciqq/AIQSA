// Synthetic, owner-scoped automatic Memory fixtures for maintenance tests.
// Facts carry exact current vNext evidence unless a version is marked legacy.
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { textMessageContent } from "@/lib/domain/content";
import { prisma } from "@/lib/server/prisma";
import { createPrismaMemoryCoordinatorRepository } from "@/lib/server/memory/coordinator/prismaRepository";
import type { MemoryJobClaim } from "@/lib/server/memory/coordinator/types";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_SOURCE_PROJECTION_VERSION
} from "@/lib/server/memory/learning/extraction/contract";
import type { MemoryMaintenanceDecision } from "@/lib/server/memory/maintenance/contract";
import { MEMORY_MAINTENANCE_PIPELINE_VERSION, MEMORY_MAINTENANCE_POLICY_VERSION } from "@/lib/server/memory/maintenance/policy";
import { memoryMaintenanceInputHash, memoryMaintenanceOutputHash } from "@/lib/server/memory/maintenance/provider";
import { createPrismaMemoryMaintenanceRepository } from "@/lib/server/memory/maintenance/repository";
import { memorySha256, normalizeMemorySearchText } from "@/lib/server/memory/persistence/lexical";
import { withLockedMemoryTransaction } from "@/lib/server/memory/persistence/transaction";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS } from "@/lib/server/memory/purge/contract";
import { registerMemoryDeletionContributors } from "@/lib/server/memory/purge/leaves";
import { MemoryDeletionContributorRegistry } from "@/lib/server/memory/purge/registry";
import { memorySafetyLiteFactClassification } from "@/lib/server/memory/safetyLite";

/** Older than the maintenance quiet period. */
export function maintenanceFixtureTime(): Date {
  return new Date(Date.now() - 2 * 60 * 60_000);
}

export type MaintenanceFixtureMessage = Readonly<{ chatId: string; messageId: string; text: string }>;

export async function createMaintenanceOwner(prefix: string): Promise<string> {
  const userId = `${prefix}-${randomUUID()}`;
  await prisma.user.create({ data: { id: userId, email: `${userId}@example.test`, displayName: "Maintenance fixture", status: "active" } });
  await prisma.memoryScope.create({ data: { userId, scopeType: "GLOBAL_USER" } });
  return userId;
}

export async function deleteMaintenanceOwner(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

/** A completed message that becomes its chat's active leaf. */
export async function createMaintenanceMessage(userId: string, text: string, options: Readonly<{
  parent?: MaintenanceFixtureMessage; at?: Date; role?: "user" | "assistant";
}> = {}): Promise<MaintenanceFixtureMessage> {
  const at = options.at ?? maintenanceFixtureTime();
  const chatId = options.parent?.chatId ?? (await prisma.chat.create({ data: { userId, title: "Synthetic maintenance" } })).id;
  const message = await prisma.message.create({ data: { chatId, content: textMessageContent(text), role: options.role ?? "user",
    status: "complete", parentMessageId: options.parent?.messageId ?? null, createdAt: at, updatedAt: at } });
  await prisma.chat.update({ where: { id: chatId }, data: { activeLeafMessageId: message.id, memorySourceRevision: 1 } });
  return { chatId, messageId: message.id, text };
}

export type MaintenanceVersionSeed = Readonly<{
  statement: string;
  source: MaintenanceFixtureMessage;
  /** Exact evidence span; the whole message by default. */
  start?: number;
  end?: number;
  /** The last version is current by default; earlier ones are superseded. */
  state?: "ACTIVE" | "SUPERSEDED" | "PENDING_RELATION";
  /** A legacy version whose evidence has no exact offsets. */
  legacy?: boolean;
  frame?: Prisma.InputJsonValue;
  dated?: boolean;
  usefulness?: "DURABLE" | "ONGOING" | "EPISODIC";
}>;

export async function createAutomaticMaintenanceFact(userId: string, versions: readonly MaintenanceVersionSeed[],
  options: Readonly<{ pinned?: boolean }> = {}): Promise<Readonly<{ factId: string; versionIds: readonly string[]; currentVersionId: string }>> {
  const base = maintenanceFixtureTime();
  const factId = randomUUID();
  const versionIds = versions.map(() => randomUUID());
  const states = versions.map((version, index) => version.state ?? (index === versions.length - 1 ? "ACTIVE" : "SUPERSEDED"));
  const currentVersionId = versionIds[states.indexOf("ACTIVE")]!;
  const scope = await prisma.memoryScope.findFirstOrThrow({ where: { userId, scopeType: "GLOBAL_USER" } });
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id, category: "other",
      canonicalKey: `prop:v2:${memorySha256({ factId })}`, state: "ORPHANED", pinned: options.pinned ?? false,
      identityKind: "PROPOSITION", identityVersion: "proposition-v2" } });
    for (const [index, version] of versions.entries()) {
      const id = versionIds[index]!;
      const eventId = randomUUID();
      const createdAt = new Date(base.getTime() + index * 1_000);
      const start = version.start ?? 0;
      const end = version.end ?? version.source.text.length;
      const excerpt = version.source.text.slice(start, end);
      await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: id, operation: "AUTO_PROPOSE", actorType: "JOB" } });
      await tx.memoryFactVersion.create({ data: { id, factId, userId, createdByEventId: eventId, category: "other",
        displayText: version.statement, normalizedSearchText: normalizeMemorySearchText(version.statement),
        structuredValue: { kind: "statement", value: version.statement }, languageCode: "en", modality: "STATE",
        sourceMode: "AUTOMATIC", confidence: 0.6, importance: 0.4, directness: "DIRECT", sensitivityClass: "NORMAL",
        ...memorySafetyLiteFactClassification(base),
        pipelineVersion: version.legacy ? "memory-maintenance-legacy-fixture-v1" : MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        ingestionFingerprint: version.legacy ? null : memorySha256({ factId, id }),
        observedAt: createdAt, createdAt, systemFrom: createdAt, state: states[index]!,
        systemTo: states[index] === "SUPERSEDED" ? new Date(createdAt.getTime() + 500) : null,
        usefulness: version.usefulness ?? null,
        ...(version.frame ? { semanticFrame: version.frame } : {}),
        ...(version.dated ? { occurredAt: createdAt, rawTemporalExpression: "this morning", sourceTimezone: "UTC",
          temporalResolverVersion: "memory-temporal-test-v1", temporalResolutionEvidence: { grounded: true } } : {}) } });
      await tx.memoryEvidence.create({ data: { userId, factVersionId: id, chatId: version.source.chatId,
        messageId: version.source.messageId, stance: "SUPPORTS", sourceType: "MESSAGE", sourceRole: "user", branchGeneration: 0,
        observedAt: createdAt, createdAt, safeExcerpt: excerpt, safetyClass: "NORMAL",
        ...(version.legacy
          ? { safeSourceHash: memorySha256(excerpt), sourceProjectionVersion: "memory-maintenance-legacy-fixture-v1" }
          : { safeSourceHash: memorySha256(version.source.text), sourceMessageContentHash: memorySha256(version.source.text),
            sourceStartOffset: start, sourceEndOffset: end, sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION,
            evidenceFingerprint: memorySha256({ id, start, end }) }) } });
    }
    await tx.memoryFact.update({ where: { id: factId }, data: { state: "ACTIVE", currentVersionId } });
  });
  return { factId, versionIds, currentVersionId };
}

export type MaintenanceFixtureDecision = "KEEP" | "REMOVE" | "REJECT";

/** Claims the owner's queued maintenance job and settles it with synthetic
 * governed decisions through the production repository apply. */
export async function settleMaintenanceJob(userId: string,
  decide: (factId: string) => MaintenanceFixtureDecision = () => "REMOVE", now = new Date()) {
  const job = await prisma.memoryJob.findFirstOrThrow({ where: { userId, pipelineVersion: MEMORY_MAINTENANCE_PIPELINE_VERSION,
    kind: "SYNTHESIZE_MEMORIES", state: "QUEUED" } });
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  await prisma.memoryJob.update({ where: { id: job.id }, data: { state: "CLAIMED", leaseToken: claimToken, leaseExpiresAt } });
  const claim = { ...job, claimToken, recoveredLease: false, leaseExpiresAt } as MemoryJobClaim;
  const repository = createPrismaMemoryMaintenanceRepository(prisma);
  const snapshot = await repository.snapshot(claim);
  if (!snapshot?.plan) throw new Error("maintenance_fixture_plan_missing");
  const inputHash = memoryMaintenanceInputHash(snapshot);
  const output = { decisions: snapshot.plan.sources.map(({ ref, factId }): MemoryMaintenanceDecision => decide(factId) === "KEEP"
    ? { sourceRef: ref, action: "KEEP", scopeBasis: "general_personal", usefulness: "DURABLE", reason: "useful_personal_context" }
    : { sourceRef: ref, action: "REMOVE_TRANSIENT", scopeBasis: "single_episode", usefulness: null, reason: "episode" }) };
  const review = { inputHash, output, acceptedOutputHash: memoryMaintenanceOutputHash(inputHash, output),
    executionId: "synthetic-review", providerId: "synthetic", modelId: "synthetic", policyVersion: MEMORY_MAINTENANCE_POLICY_VERSION };
  const verification = { ...review, output: { decisions: snapshot.plan.sources.filter(({ factId }) => decide(factId) !== "KEEP")
    .map(({ ref, factId }) => ({ sourceRef: ref, approve: decide(factId) === "REMOVE" })) } };
  const outcome = await withLockedMemoryTransaction(prisma, userId, (tx) =>
    repository.apply(tx, claim, snapshot, review, verification, now));
  await prisma.memoryJob.update({ where: { id: job.id }, data: { state: "SUCCEEDED", completedAt: now, leaseToken: null, leaseExpiresAt: null } });
  return { jobId: job.id, outcome, factIds: snapshot.plan.sources.map(({ factId }) => factId) };
}

/** Runs the owner's pending fact purges through the production handler. */
export async function drainMaintenanceForgetPurges(userId: string): Promise<number> {
  const registry = new MemoryDeletionContributorRegistry({ operation: "FORGET_PURGE", requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS });
  registerMemoryDeletionContributors(registry);
  const coordinator = createPrismaMemoryCoordinatorRepository(prisma);
  const pending = await prisma.memoryDeletionOutbox.findMany({ where: { userId, operation: "FORGET_PURGE", state: "PENDING" },
    select: { id: true }, orderBy: { id: "asc" } });
  for (const { id } of pending) {
    const now = new Date();
    const claimToken = randomUUID();
    const leaseExpiresAt = new Date(now.getTime() + 60_000);
    const claimed = await prisma.memoryDeletionOutbox.updateMany({ where: { id, userId, state: "PENDING" }, data: {
      attemptCount: { increment: 1 }, errorCode: null, leaseExpiresAt, leaseToken: claimToken, nextAttemptAt: null,
      state: "RUNNING", updatedAt: now } });
    if (claimed.count !== 1) throw new Error("maintenance_fixture_purge_claim_failed");
    const row = await prisma.memoryDeletionOutbox.findUniqueOrThrow({ where: { id } });
    const claim = { admissionAuthorizationId: row.admissionAuthorizationId, admittedActiveLeafMessageId: row.admittedActiveLeafMessageId,
      admittedChatSourceRevision: row.admittedChatSourceRevision, alsoForgetOriginMemories: row.alsoForgetOriginMemories,
      attemptCount: row.attemptCount, claimToken, id, leaseExpiresAt, memoryGeneration: row.memoryGeneration,
      operation: row.operation, recoveredLease: false, resumedFromBlocked: false, targetId: row.targetId,
      targetType: row.targetType, userId };
    const execution = await registry.handler().execute(claim, { now: () => now, signal: new AbortController().signal });
    if (!await coordinator.commitDeletionSuccess({ apply: execution.apply, claim, now })) {
      throw new Error("maintenance_fixture_purge_commit_rejected");
    }
  }
  return pending.length;
}
