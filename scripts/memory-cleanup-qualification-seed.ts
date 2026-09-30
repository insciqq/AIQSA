import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  cleanupQualificationDatabase,
  cleanupQualificationFixtureSchema,
  freshCleanupQualificationOwner,
  MEMORY_CLEANUP_SYNTHETIC_CORPUS,
  type CleanupQualificationFixture
} from "./memory-cleanup-qualification-support";

/** Deterministic existing-fact fixtures, not claimed as paid extraction evidence.
 * No invented provider execution receipts or capability proofs are created. */
export async function materializeMemoryCleanupSyntheticFixture(
  client: PrismaClient,
  runId: string
): Promise<CleanupQualificationFixture> {
  const target = cleanupQualificationDatabase(process.env, runId);
  process.env.DATABASE_URL = target.toString();
  const [{ Prisma }, { memorySha256, normalizeMemorySearchText }, { textMessageContent },
    { memorySafetyLiteFactClassification }, { provisionActiveUser }, extraction] = await Promise.all([
    import("@prisma/client"), import("../lib/server/memory/persistence/lexical"),
    import("../lib/domain/content"), import("../lib/server/memory/safetyLite"),
    import("../lib/server/auth/provisioning"), import("../lib/server/memory/learning/extraction/contract")
  ]);
  const identity = await client.$queryRaw<Array<{ database: string; role: string }>>(Prisma.sql`
    SELECT current_database() AS database, current_user AS role
  `);
  if (identity.length !== 1 || identity[0]?.database !== target.pathname.slice(1) || identity[0].role !== target.username) {
    throw new Error("memory_cleanup_database_identity_mismatch");
  }
  if (process.env.AIQSA_MEMORY_CLEANUP_COORDINATOR_STOPPED !== "1" ||
    await client.memoryWorkerHeartbeat.count({ where: { ready: true, lastSeenAt: { gt: new Date(Date.now() - 60_000) } } })) {
    throw new Error("memory_cleanup_stopped_coordinator_required");
  }
  const userId = freshCleanupQualificationOwner(runId);
  if (await client.user.count({ where: { id: userId } })) throw new Error("memory_cleanup_fixture_already_exists");
  const group = await client.group.findUnique({ where: { systemRole: "full_access" }, select: { id: true } });
  if (!group) throw new Error("memory_cleanup_synthetic_group_missing");
  const observedAt = new Date(Date.now() - 2 * 60 * 60_000);
  const assertions: CleanupQualificationFixture["assertions"] = [];
  await client.$transaction(async (tx) => {
    await tx.user.create({ data: { id: userId, displayName: "Synthetic cleanup qualification",
      email: `${userId}@example.invalid`, role: "user", status: "active", createdAt: observedAt } });
    await provisionActiveUser(tx, { userId, groups: [{ groupId: group.id, role: "member" }] });
    await tx.userMemorySettings.update({ where: { userId }, data: {
      useMemoryFacts: true, learnAutomatically: true, synthesisEnabled: true,
      referenceChatHistory: false, synthesisEnabledAt: observedAt, createdAt: observedAt
    } });
    const settings = await tx.userMemorySettings.findUniqueOrThrow({ where: { userId } });
    const scope = await tx.memoryScope.create({ data: { userId, scopeType: "GLOBAL_USER" } });
    for (const item of MEMORY_CLEANUP_SYNTHETIC_CORPUS) {
      const factId = randomUUID();
      const versionId = randomUUID();
      const eventId = randomUUID();
      const chat = await tx.chat.create({ data: { userId, title: "Synthetic cleanup fixture", createdAt: observedAt } });
      let parentMessageId: string | null = null;
      if ("context" in item) {
        for (const [index, text] of item.context.entries()) {
          const timestamp = new Date(observedAt.getTime() - (item.context.length - index) * 60_000);
          const parent: { id: string } = await tx.message.create({ data: {
            chatId: chat.id, role: index % 2 === 0 ? "user" : "assistant", status: "complete",
            content: textMessageContent(text), parentMessageId, createdAt: timestamp, updatedAt: timestamp
          } });
          if (index % 2 === 1) {
            if (!parentMessageId) throw new Error("memory_cleanup_context_parent_missing");
            // Canonical assistant-context eligibility requires a unique completed
            // run linking this assistant message to its direct user parent.
            // This is deterministic imported fixture state, not provider evidence.
            await tx.modelRun.create({ data: {
              userId, chatId: chat.id, userMessageId: parentMessageId,
              assistantMessageId: parent.id, status: "complete",
              provider: "synthetic-qualification", modelId: "synthetic-qualification",
              normalizedRequest: { qualificationFixture: true, paidExtraction: false },
              createdAt: timestamp
            } });
          }
          parentMessageId = parent.id;
        }
      }
      const message = await tx.message.create({ data: {
        chatId: chat.id, role: "user", status: "complete", content: textMessageContent(item.text),
        createdAt: observedAt, updatedAt: observedAt, parentMessageId
      } });
      await tx.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: message.id, memorySourceRevision: 1 } });
      await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id,
        canonicalKey: `qualification:${item.id}`, category: "other", currentVersionId: versionId,
        pinned: item.pinned, createdAt: observedAt, updatedAt: observedAt } });
      await tx.memoryEvent.create({ data: { id: eventId, userId, factId, factVersionId: versionId,
        operation: item.sourceMode === "EXPLICIT" ? "EXPLICIT_SAVE" : "PROMOTE",
        actorType: item.sourceMode === "EXPLICIT" ? "USER" : "JOB",
        actorUserId: item.sourceMode === "EXPLICIT" ? userId : null,
        sourceChatId: chat.id, sourceGeneration: settings.memoryGeneration,
        metadata: { qualificationFixture: true, paidExtraction: false }, createdAt: observedAt } });
      const sourceHash = memorySha256(item.text);
      await tx.memoryFactVersion.create({ data: {
        id: versionId, userId, factId, createdByEventId: eventId, category: "other",
        displayText: item.text, normalizedSearchText: normalizeMemorySearchText(item.text),
        structuredValue: { statement: item.text }, languageCode: item.language, modality: "STATE",
        sourceMode: item.sourceMode, directness: "DIRECT", confidence: 1, importance: 0.5,
        sensitivityClass: "NORMAL", observedAt, createdAt: observedAt, systemFrom: observedAt,
        pipelineVersion: item.sourceMode === "AUTOMATIC" ? extraction.MEMORY_FACT_EXTRACTION_PIPELINE_VERSION : "memory-explicit-api-v1",
        ingestionFingerprint: item.sourceMode === "AUTOMATIC" ? memorySha256({ runId, id: item.id, messageId: message.id }) : null,
        ...memorySafetyLiteFactClassification(observedAt)
      } });
      await tx.memoryEvidence.create({ data: {
        userId, factVersionId: versionId, stance: "SUPPORTS", sourceType: "MESSAGE", sourceRole: "user",
        chatId: chat.id, messageId: message.id, branchGeneration: 0, safeExcerpt: item.text,
        sourceStartOffset: 0, sourceEndOffset: item.text.length, sourceMessageContentHash: sourceHash,
        safeSourceHash: sourceHash, sourceProjectionVersion: extraction.MEMORY_FACT_SOURCE_PROJECTION_VERSION,
        evidenceFingerprint: memorySha256({ domain: "memory-cleanup-synthetic-evidence", messageId: message.id, versionId }),
        safetyClass: "NORMAL", observedAt, createdAt: observedAt
      } });
      const manuallyEdited = "manuallyEdited" in item && item.manuallyEdited;
      if (manuallyEdited) await tx.memoryEvent.create({ data: {
        userId, factId, factVersionId: versionId, operation: "EDIT", actorType: "USER",
        actorUserId: userId, sourceGeneration: settings.memoryGeneration,
        metadata: { qualificationFixture: true, paidExtraction: false }, createdAt: observedAt
      } });
      assertions.push({ id: item.id, factIds: [factId], expected: item.expected,
        protected: item.sourceMode === "EXPLICIT" || item.pinned || manuallyEdited });
    }
  }, { timeout: 30_000 });
  return cleanupQualificationFixtureSchema.parse({ version: 1, runId, corpus: "SYNTHETIC", userId, assertions });
}
