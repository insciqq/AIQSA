import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import {
  cleanupQualificationDatabase,
  cleanupQualificationFixtureSchema,
  freshCleanupQualificationOwner,
  MEMORY_CLEANUP_LIFECYCLE_CORPUS,
  MEMORY_CLEANUP_SYNTHETIC_CORPUS,
  memoryCleanupLifecycleSpan,
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
      useMemoryFacts: true, learnAutomatically: true, referenceChatHistory: false,
      createdAt: observedAt
    } });
    const settings = await tx.userMemorySettings.findUniqueOrThrow({ where: { userId } });
    const scope = await tx.memoryScope.create({ data: { userId, scopeType: "GLOBAL_USER" } });
    /** One automatic or explicit version with its event and one evidence span. */
    async function version(input: Readonly<{
      factId: string; versionId: string; statement: string; language: string; sourceMode: "AUTOMATIC" | "EXPLICIT";
      chatId: string; messageId: string; messageText: string; start: number; end: number; at: Date;
      state?: "ACTIVE" | "SUPERSEDED"; usefulness?: "DURABLE" | "ONGOING" | "EPISODIC"; remembered?: boolean; dated?: boolean;
    }>): Promise<void> {
      const eventId = randomUUID();
      const automatic = input.sourceMode === "AUTOMATIC";
      await tx.memoryEvent.create({ data: { id: eventId, userId, factId: input.factId, factVersionId: input.versionId,
        operation: automatic ? "PROMOTE" : "EXPLICIT_SAVE", actorType: automatic ? "JOB" : "USER",
        actorUserId: automatic ? null : userId, sourceChatId: input.chatId, sourceGeneration: settings.memoryGeneration,
        metadata: { qualificationFixture: true, paidExtraction: false }, createdAt: input.at } });
      const sourceHash = memorySha256(input.messageText);
      await tx.memoryFactVersion.create({ data: {
        id: input.versionId, userId, factId: input.factId, createdByEventId: eventId, category: "other",
        displayText: input.statement, normalizedSearchText: normalizeMemorySearchText(input.statement),
        structuredValue: { statement: input.statement }, languageCode: input.language, modality: "STATE",
        sourceMode: input.sourceMode, directness: "DIRECT", confidence: 1, importance: 0.5,
        sensitivityClass: "NORMAL", observedAt: input.at, createdAt: input.at, systemFrom: input.at,
        state: input.state ?? "ACTIVE", systemTo: input.state === "SUPERSEDED" ? new Date(input.at.getTime() + 500) : null,
        usefulness: input.usefulness ?? null,
        ...(input.remembered ? { semanticFrame: { memoryDirective: "EXPLICIT_REMEMBER" } } : {}),
        ...(input.dated ? { occurredAt: input.at, rawTemporalExpression: input.language === "ru" ? "сегодня утром" : "this morning",
          sourceTimezone: "UTC", temporalResolverVersion: "memory-cleanup-qualification-temporal-v1",
          temporalResolutionEvidence: { qualificationFixture: true } } : {}),
        pipelineVersion: automatic ? extraction.MEMORY_FACT_EXTRACTION_PIPELINE_VERSION : "memory-explicit-api-v1",
        ingestionFingerprint: automatic ? memorySha256({ runId, versionId: input.versionId, messageId: input.messageId }) : null,
        ...memorySafetyLiteFactClassification(input.at)
      } });
      await tx.memoryEvidence.create({ data: {
        userId, factVersionId: input.versionId, stance: "SUPPORTS", sourceType: "MESSAGE", sourceRole: "user",
        chatId: input.chatId, messageId: input.messageId, branchGeneration: 0,
        safeExcerpt: input.messageText.slice(input.start, input.end),
        sourceStartOffset: input.start, sourceEndOffset: input.end, sourceMessageContentHash: sourceHash,
        safeSourceHash: sourceHash, sourceProjectionVersion: extraction.MEMORY_FACT_SOURCE_PROJECTION_VERSION,
        evidenceFingerprint: memorySha256({ domain: "memory-cleanup-synthetic-evidence", messageId: input.messageId, versionId: input.versionId }),
        safetyClass: "NORMAL", observedAt: input.at, createdAt: input.at
      } });
    }
    for (const item of MEMORY_CLEANUP_SYNTHETIC_CORPUS) {
      const factId = randomUUID();
      const versionId = randomUUID();
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
      await version({ factId, versionId, statement: item.text, language: item.language, sourceMode: item.sourceMode,
        chatId: chat.id, messageId: message.id, messageText: item.text, start: 0, end: item.text.length, at: observedAt });
      const manuallyEdited = "manuallyEdited" in item && item.manuallyEdited;
      if (manuallyEdited) await tx.memoryEvent.create({ data: {
        userId, factId, factVersionId: versionId, operation: "EDIT", actorType: "USER",
        actorUserId: userId, sourceGeneration: settings.memoryGeneration,
        metadata: { qualificationFixture: true, paidExtraction: false }, createdAt: observedAt
      } });
      assertions.push({ id: item.id, factIds: [factId], expected: item.expected,
        protected: item.sourceMode === "EXPLICIT" || item.pinned || manuallyEdited });
    }
    // A settled v2 decision that kept an episode: v3 must review it again.
    const priorJob = await tx.memoryJob.create({ data: { userId, kind: "SYNTHESIZE_MEMORIES",
      pipelineVersion: "memory-maintenance-v1", state: "SUCCEEDED", completedAt: observedAt,
      idempotencyFingerprint: memorySha256({ domain: "memory-cleanup-qualification-prior-v2", runId }),
      memoryGenerationSnapshot: settings.memoryGeneration, memoryRevisionSnapshot: settings.memoryRevision, createdAt: observedAt } });
    for (const scenario of MEMORY_CLEANUP_LIFECYCLE_CORPUS) {
      const chat = await tx.chat.create({ data: { userId, title: "Synthetic cleanup fixture", createdAt: observedAt } });
      const messages: Array<{ id: string; text: string; at: Date }> = [];
      for (const [index, text] of scenario.messages.entries()) {
        const at = new Date(observedAt.getTime() + index * 60_000);
        const created: { id: string } = await tx.message.create({ data: { chatId: chat.id, role: "user", status: "complete",
          content: textMessageContent(text), parentMessageId: messages.at(-1)?.id ?? null, createdAt: at, updatedAt: at } });
        messages.push({ id: created.id, text, at });
      }
      await tx.chat.update({ where: { id: chat.id }, data: { activeLeafMessageId: messages.at(-1)!.id, memorySourceRevision: 1 } });
      for (const fact of scenario.facts) {
        const factId = randomUUID();
        const versionIds = fact.versions.map(() => randomUUID());
        await tx.memoryFact.create({ data: { id: factId, userId, scopeId: scope.id, canonicalKey: `qualification:${fact.id}`,
          category: "other", currentVersionId: versionIds.at(-1)!, pinned: false, createdAt: observedAt, updatedAt: observedAt } });
        for (const [index, seed] of fact.versions.entries()) {
          const span = memoryCleanupLifecycleSpan(scenario, seed);
          const source = messages[seed.message]!;
          await version({ factId, versionId: versionIds[index]!, statement: seed.statement, language: scenario.language,
            sourceMode: "AUTOMATIC", chatId: chat.id, messageId: source.id, messageText: span.text, start: span.start, end: span.end,
            at: source.at, state: index === fact.versions.length - 1 ? "ACTIVE" : "SUPERSEDED", usefulness: seed.usefulness,
            remembered: seed.remembered, dated: fact.dated });
        }
        if (fact.priorKeep) {
          await tx.memoryMaintenanceReview.create({ data: { userId, factVersionId: versionIds.at(-1)!, memoryJobId: priorJob.id,
            policyVersion: "memory-maintenance-policy-v2", disposition: "KEEP", usefulness: "EPISODIC",
            sourceSnapshotHash: memorySha256({ domain: "memory-cleanup-qualification-prior-v2", factId }),
            evidenceThrough: messages[fact.versions.at(-1)!.message]!.at, reviewedAt: observedAt } });
        }
        assertions.push({ id: fact.id, factIds: [factId], expected: fact.expected,
          protected: fact.versions.some(({ remembered }) => remembered === true), ...(fact.dated ? { dated: true } : {}) });
      }
    }
  }, { timeout: 60_000 });
  return cleanupQualificationFixtureSchema.parse({ version: 1, runId, corpus: "SYNTHETIC", userId, assertions });
}
