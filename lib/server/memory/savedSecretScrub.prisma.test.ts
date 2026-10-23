import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createWorkspaceSecretStore } from "../workspace/secrets/store";
import { createPrismaMemoryCoordinatorRepository } from "./coordinator/prismaRepository";
import type { MemoryDeletionClaim, MemoryDeletionHandler, MemoryJobClaim } from "./coordinator/types";
import { seedMemoryHistoryBackfill } from "./history/backfill";
import { MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION } from "./history/contract";
import { createPrismaMemoryHistoryIndexHandler } from "./history/handler";
import { MEMORY_HISTORY_SOURCE_TARGET_TYPE, memoryHistorySourceDeletionHandler } from "./history/purge";
import { MEMORY_FACT_SOURCE_PROJECTION_VERSION } from "./learning/extraction/contract";
import { loadPersonalEligibleFactVersionIds } from "./persistence/eligibility";
import { createPrismaMemoryFactRepository, type MemoryFactValueInput } from "./persistence/facts";
import { memorySha256 } from "./persistence/lexical";
import { MEMORY_SAVED_SECRET_MARKER } from "./persistence/savedSecretMatching";
import { createPrismaMemoryScopeRepository } from "./persistence/scopes";
import { withLockedMemoryTransaction } from "./persistence/transaction";
import { MEMORY_PURGE_REQUIRED_CONTRIBUTORS, memoryPurgeTargetType } from "./purge/contract";
import { registerMemoryDeletionContributors } from "./purge/leaves";
import { MemoryDeletionContributorRegistry } from "./purge/registry";
import {
  createMemorySavedSecretScrubBackfill,
  createMemorySavedSecretScrubDeletionHandler,
  MEMORY_SAVED_SECRET_BACKFILL_TARGET_ID
} from "./savedSecretScrub";
import { MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE } from "./savedSecretScrubRequest";
import { defaultMemorySourceMutationHooks } from "./sourceHooks";
import { applyMemorySourceMutations, lockMemorySourceChat } from "./sourceState";
import { MemorySuppressionKeyring } from "./suppressionKeyring";

const TOKEN = "tok_demo_7f3a9c21b8e4";
const encryptionKey = randomBytes(32);
const keyring = MemorySuppressionKeyring.parse(
  `current=scrub-v1,scrub-v1=${Buffer.from(Array.from({ length: 32 }, (_, index) => index + 91)).toString("base64")}`
);
const scrubHandler = () => createMemorySavedSecretScrubDeletionHandler(prisma, {
  keyring: () => ({ keyring, status: "ready" })
});
const owners: string[] = [];

async function createOwner(): Promise<string> {
  const userId = `memory-saved-secret-${randomUUID()}`;
  await prisma.user.create({ data: {
    displayName: "Saved secret scrub", email: `${userId}@example.test`, id: userId, status: "active"
  } });
  await prisma.userMemorySettings.update({
    data: { learnAutomatically: false, referenceChatHistory: true },
    where: { userId }
  });
  owners.push(userId);
  return userId;
}

async function saveSecret(userId: string, text: string, name = "DEMO_API_TOKEN"): Promise<void> {
  await createWorkspaceSecretStore(prisma).mutate(userId, {
    action: "create", description: "", name, value: { kind: "text", text }
  });
}

async function scrubObligation(userId: string) {
  return prisma.memoryDeletionOutbox.findFirst({
    where: { targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE, userId }
  });
}

/** Claims one obligation the way the coordinator does and commits its handler's result. */
async function runDeletion(userId: string, deletionId: string, handler: MemoryDeletionHandler): Promise<void> {
  const now = new Date();
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(now.getTime() + 60_000);
  const row = await prisma.memoryDeletionOutbox.update({
    data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken: claimToken, nextAttemptAt: null, state: "RUNNING" },
    where: { id: deletionId }
  });
  const claim: MemoryDeletionClaim = {
    admissionAuthorizationId: row.admissionAuthorizationId,
    admittedActiveLeafMessageId: row.admittedActiveLeafMessageId,
    admittedChatSourceRevision: row.admittedChatSourceRevision,
    alsoForgetOriginMemories: row.alsoForgetOriginMemories,
    attemptCount: row.attemptCount,
    claimToken,
    id: row.id,
    leaseExpiresAt,
    memoryGeneration: row.memoryGeneration,
    operation: row.operation,
    recoveredLease: false,
    resumedFromBlocked: false,
    targetId: row.targetId,
    targetType: row.targetType,
    userId
  };
  const execution = await handler.execute(claim, { now: () => now, signal: new AbortController().signal });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitDeletionSuccess({
    apply: execution.apply, claim, now
  })).resolves.toBe(true);
}

async function createSettledTurn(userId: string, chatId: string, userText: string, assistantText: string) {
  const createdAt = new Date("2026-10-23T09:00:00.000Z");
  const userMessage = await prisma.message.create({ data: {
    chatId, content: textMessageContent(userText), createdAt, role: "user", status: "complete", updatedAt: createdAt
  } });
  const answeredAt = new Date(createdAt.getTime() + 1_000);
  const assistantMessage = await prisma.message.create({ data: {
    chatId, content: textMessageContent(assistantText), createdAt: answeredAt, modelId: "scrub-test-model",
    parentMessageId: userMessage.id, provider: "scrub-test-provider", role: "assistant", status: "complete",
    updatedAt: answeredAt
  } });
  await prisma.modelRun.create({ data: {
    assistantMessageId: assistantMessage.id, chatId, modelId: "scrub-test-model",
    normalizedRequest: { prompt: { baseline: { source: "standard_chat", timeZone: "Europe/Moscow", timeZoneSource: "client" } } },
    provider: "scrub-test-provider", status: "complete", userId, userMessageId: userMessage.id
  } });
  for (const mutation of ["NORMAL_APPEND", "TERMINAL_SETTLEMENT"] as const) {
    await prisma.$transaction(async (tx) => {
      const chat = await lockMemorySourceChat(tx, { chatId, lock: "UPDATE", userId });
      if (!chat) throw new Error("memory_saved_secret_test_chat_missing");
      await applyMemorySourceMutations(tx, mutation === "NORMAL_APPEND"
        ? { chat, hooks: defaultMemorySourceMutationHooks, mutations: [mutation],
            patch: { activeLeafMessageId: assistantMessage.id } }
        : { chat, hooks: defaultMemorySourceMutationHooks, mutations: [mutation],
            terminalSettlement: { assistantMessageId: assistantMessage.id, runId: `scrub-run-${randomUUID()}`,
              status: "complete" } });
    });
  }
}

async function indexHistory(userId: string): Promise<void> {
  const job = await prisma.memoryJob.findFirstOrThrow({
    orderBy: [{ sourceRevision: "desc" }, { createdAt: "desc" }],
    where: { kind: "INDEX_HISTORY", state: "QUEUED", userId }
  });
  const claimToken = randomUUID();
  const leaseExpiresAt = new Date(Date.now() + 60_000);
  const claimed = await prisma.memoryJob.update({
    data: { attemptCount: { increment: 1 }, leaseExpiresAt, leaseToken: claimToken, state: "CLAIMED" },
    where: { id: job.id }
  });
  const claim: MemoryJobClaim = {
    activeLeafMessageId: claimed.activeLeafMessageId, attemptCount: claimed.attemptCount,
    branchGeneration: claimed.branchGeneration, chatId: claimed.chatId, claimToken, id: claimed.id,
    idempotencyFingerprint: claimed.idempotencyFingerprint, kind: claimed.kind, leaseExpiresAt,
    memoryGenerationSnapshot: claimed.memoryGenerationSnapshot, memoryRevisionSnapshot: claimed.memoryRevisionSnapshot,
    pipelineVersion: claimed.pipelineVersion, recoveredLease: false, sourceHash: claimed.sourceHash,
    sourceMessageId: claimed.sourceMessageId, sourceRevision: claimed.sourceRevision, stage: claimed.stage,
    targetFactVersionId: claimed.targetFactVersionId, userId: claimed.userId
  };
  const handler = createPrismaMemoryHistoryIndexHandler(prisma);
  await expect(handler.preflight(claim)).resolves.toEqual({ status: "READY" });
  const now = new Date();
  const result = await handler.execute(claim, { now: () => now, setStage: async () => undefined,
    signal: new AbortController().signal });
  await expect(createPrismaMemoryCoordinatorRepository(prisma).commitJobSuccess({
    acceptedResultHash: result.acceptedResultHash, apply: result.apply, claim, now, stage: result.stage ?? null
  })).resolves.toBe(true);
}

/** Every stored history text of the owner, active or not. */
async function historyText(userId: string): Promise<string> {
  const [chunks, rounds, segments, toolEvents, entries] = await Promise.all([
    prisma.memoryRecallChunk.findMany({ select: { normalizedSafeSearchText: true, safeProjectedText: true }, where: { userId } }),
    prisma.memoryRecallRound.findMany({ select: { contextualNarrativeText: true, contextualSearchText: true, rawSafeText: true },
      where: { userId } }),
    prisma.memoryRecallRoundSegment.findMany({ select: { contextualNarrativeText: true, contextualSearchText: true,
      rawSafeText: true }, where: { userId } }),
    prisma.memoryToolEvent.findMany({ select: { safeProjectedText: true, structuredIdentifiers: true }, where: { userId } }),
    prisma.memorySearchEntry.findMany({ select: { normalizedSearchText: true }, where: { userId } })
  ]);
  return JSON.stringify({ chunks, entries, rounds, segments, toolEvents });
}

function automaticValue(canonicalKey: string, displayText: string): MemoryFactValueInput {
  return {
    canonicalKey, category: "preference", confidence: 0.9, directness: "DIRECT", displayText, importance: 0.8,
    languageCode: "en", modality: "PREFERENCE", pipelineVersion: "memory-saved-secret-scrub-test-v1",
    secretTaintedSourceWindow: false, sensitivityClass: "NORMAL", sourceMode: "AUTOMATIC",
    structuredValue: { statement: displayText }
  };
}

/** One automatic fact learned from its own user message. */
async function saveFact(userId: string, canonicalKey: string, text: string) {
  const chat = await prisma.chat.create({ data: { title: "Saved secret fact", userId } });
  const message = await prisma.message.create({ data: {
    chatId: chat.id, content: textMessageContent(text), role: "user", status: "complete"
  } });
  await prisma.chat.update({ data: { activeLeafMessageId: message.id }, where: { id: chat.id } });
  const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
  return createPrismaMemoryFactRepository(keyring, prisma).save(userId, {
    evidence: { branchGeneration: 0, chatId: chat.id, kind: "MESSAGE", messageId: message.id,
      observedAt: message.createdAt, safeExcerpt: text, safeSourceHash: memorySha256(text),
      safetyClass: "NORMAL", sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION, sourceRole: "user" },
    explicitSuppressionOverride: false, idempotencyFingerprint: randomUUID(), requestId: randomUUID(),
    scopeId: scope.id, value: automaticValue(canonicalKey, text)
  });
}

describe("saved secret scrub of existing Memory", () => {
  beforeEach(() => {
    vi.stubEnv("AIQSA_ENCRYPTION_KEY", encryptionKey.toString("base64"));
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    const userIds = owners.splice(0);
    await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("records nothing for an owner whose Memory holds nothing", async () => {
    const userId = await createOwner();
    await saveSecret(userId, TOKEN);
    expect(await scrubObligation(userId)).toBeNull();
  });

  it("removes a newly saved value from indexed history and indexes the chat again redacted", async () => {
    const userId = await createOwner();
    const chat = await prisma.chat.create({ data: { title: "Saved secret history", userId } });
    await createSettledTurn(userId, chat.id, `Сохрани мой секрет DEMO_API_TOKEN со значением ${TOKEN}`, "Секрет сохранён.");
    await indexHistory(userId);
    // Indexed before the value was a saved secret, so Safety Lite left it in.
    expect(await historyText(userId)).toContain(TOKEN);

    await saveSecret(userId, TOKEN);
    const scrub = await scrubObligation(userId);
    expect(scrub).toMatchObject({ operation: "SOURCE_PURGE", state: "PENDING" });
    expect(JSON.stringify(scrub)).not.toContain(TOKEN);
    await runDeletion(userId, scrub!.id, scrubHandler());

    expect(await prisma.memoryRecallChunk.count({ where: { chatId: chat.id, state: "ACTIVE", userId } })).toBe(0);
    expect(await prisma.memorySearchEntry.count({ where: { recallChunkId: { not: null }, userId } })).toBe(0);
    expect(await prisma.chatMemoryCheckpoint.findUniqueOrThrow({ where: { userId_chatId: { chatId: chat.id, userId } } }))
      .toMatchObject({ pipelineVersion: MEMORY_HISTORY_REBUILD_REQUIRED_CHECKPOINT_VERSION, status: "PENDING" });
    const purge = await prisma.memoryDeletionOutbox.findFirstOrThrow({
      where: { targetId: chat.id, targetType: MEMORY_HISTORY_SOURCE_TARGET_TYPE, userId }
    });
    expect(purge.state).toBe("PENDING");
    await runDeletion(userId, purge.id, memoryHistorySourceDeletionHandler);
    expect(await historyText(userId)).not.toContain(TOKEN);

    // The rebuild projects the chat again with the saved value redacted.
    await withLockedMemoryTransaction(prisma, userId, (tx, settings) => seedMemoryHistoryBackfill(tx, settings));
    await indexHistory(userId);
    const rebuilt = await prisma.memoryRecallChunk.findMany({ where: { chatId: chat.id, state: "ACTIVE", userId } });
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({ redactionState: "REDACTED" });
    expect(rebuilt[0]!.safeProjectedText).toContain(`DEMO_API_TOKEN со значением ${MEMORY_SAVED_SECRET_MARKER}`);
    expect(await historyText(userId)).not.toContain(TOKEN);

    // A second obligation finds nothing more to do.
    await saveSecret(userId, `${TOKEN}-rotated`, "DEMO_API_TOKEN_NEXT");
    const again = await prisma.memoryDeletionOutbox.findFirstOrThrow({
      where: { state: "PENDING", targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE, userId }
    });
    await runDeletion(userId, again.id, scrubHandler());
    expect(await prisma.memoryRecallChunk.count({ where: { chatId: chat.id, state: "ACTIVE", userId } })).toBe(1);
  });

  /**
   * The value and a peer fact learned from one message. `exact` gives both
   * the provenance current extraction records (fingerprint, offsets, content
   * hash), which lets a Forget keep the peer's support in the fenced message;
   * without it the evidence has the legacy shape a Forget cannot preserve.
   */
  async function scrubSharedMessage(exact: boolean) {
    const userId = await createOwner();
    const held = `My test token is ${TOKEN}.`;
    const peer = "I do not drink coffee.";
    const statement = `${held} ${peer}`;
    const chat = await prisma.chat.create({ data: { title: "Saved secret fact", userId } });
    const message = await prisma.message.create({ data: {
      chatId: chat.id, content: textMessageContent(statement), role: "user", status: "complete"
    } });
    await prisma.chat.update({ data: { activeLeafMessageId: message.id }, where: { id: chat.id } });
    const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
    const facts = createPrismaMemoryFactRepository(keyring, prisma);
    const save = async (canonicalKey: string, text: string, ordinal: number) => {
      const saved = await facts.save(userId, {
        evidence: { branchGeneration: 0, chatId: chat.id, kind: "MESSAGE", messageId: message.id,
          observedAt: message.createdAt, safeExcerpt: text, safeSourceHash: memorySha256(statement),
          safetyClass: "NORMAL", sourceProjectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION, sourceRole: "user" },
        explicitSuppressionOverride: false, idempotencyFingerprint: randomUUID(), requestId: randomUUID(),
        scopeId: scope.id, value: automaticValue(canonicalKey, text)
      });
      if (exact) {
        await prisma.memoryEvidence.updateMany({
          data: {
            evidenceFingerprint: memorySha256({ messageId: message.id, ordinal }),
            sourceEndOffset: statement.indexOf(text) + text.length,
            sourceMessageContentHash: memorySha256(statement),
            sourceStartOffset: statement.indexOf(text)
          },
          where: { factVersionId: saved.versionId, userId }
        });
      }
      return saved;
    };
    const token = await save("learned.test_token", held, 0);
    const coffee = await save("learned.coffee", peer, 1);
    expect(await loadPersonalEligibleFactVersionIds(prisma, userId, [coffee.versionId]))
      .toEqual(new Set([coffee.versionId]));

    await saveSecret(userId, TOKEN);
    const scrub = await scrubObligation(userId);
    expect(scrub).not.toBeNull();
    await runDeletion(userId, scrub!.id, scrubHandler());

    expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: token.factId } }))
      .toMatchObject({ currentVersionId: null, state: "FORGOTTEN" });
    expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: coffee.factId } }))
      .toMatchObject({ currentVersionId: coffee.versionId, state: "ACTIVE" });
    expect(await prisma.memorySearchEntry.count({ where: { factVersionId: token.versionId, userId } })).toBe(0);
    const purge = await prisma.memoryDeletionOutbox.findFirstOrThrow({
      where: { operation: "FORGET_PURGE", targetId: token.factId, targetType: memoryPurgeTargetType("MEMORY_FACT"), userId }
    });
    // A secret gets no Undo window: its purge is due at once.
    expect(purge).toMatchObject({ nextAttemptAt: null, state: "PENDING" });

    const registry = new MemoryDeletionContributorRegistry({
      operation: "FORGET_PURGE",
      requirements: MEMORY_PURGE_REQUIRED_CONTRIBUTORS
    });
    registerMemoryDeletionContributors(registry);
    await runDeletion(userId, purge.id, registry.handler());
    const [versions, evidence] = await Promise.all([
      prisma.memoryFactVersion.findMany({ where: { factId: token.factId, userId } }),
      prisma.memoryEvidence.findMany({ where: { userId } })
    ]);
    expect(JSON.stringify({ evidence, versions })).not.toContain(TOKEN);
    expect(await prisma.memoryFactVersion.findUniqueOrThrow({ where: { id: coffee.versionId } }))
      .toMatchObject({ displayText: peer, state: "ACTIVE" });
    return { coffee, userId };
  }

  it("forgets a fact holding a newly saved value, keeps its peer and purges its text at once", async () => {
    const { coffee, userId } = await scrubSharedMessage(true);
    // The peer's exact support in the fenced message is preserved, as in the user's Forget.
    expect(await loadPersonalEligibleFactVersionIds(prisma, userId, [coffee.versionId]))
      .toEqual(new Set([coffee.versionId]));
  });

  it("still forgets the fact when its peer's legacy support cannot be preserved", async () => {
    // The user's Forget refuses here; the secret must go anyway, so the
    // message is fenced as for a deleted chat and the peer loses that support.
    const { coffee, userId } = await scrubSharedMessage(false);
    expect(await loadPersonalEligibleFactVersionIds(prisma, userId, [coffee.versionId]))
      .toEqual(new Set());
  });

  it("backfills one cleanup, once, for each owner whose saved secrets predate it", async () => {
    // Saved before the cleanup existed: the Memory already holds the value and no obligation was recorded.
    const legacy = await createOwner();
    const held = await saveFact(legacy, "learned.test_token", `My test token is ${TOKEN}.`);
    await saveSecret(legacy, TOKEN);
    await prisma.memoryDeletionOutbox.deleteMany({
      where: { targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE, userId: legacy }
    });
    // Only a plain value is saved: recorded as done, nothing to clean.
    const plain = await createOwner();
    await saveFact(plain, "learned.coffee", "I do not drink coffee.");
    await saveSecret(plain, "localhost", "DB_HOST");
    // No Memory at all: nothing to backfill.
    const empty = await createOwner();
    await saveSecret(empty, TOKEN);
    const userIds = [legacy, plain, empty];
    const backfill = createMemorySavedSecretScrubBackfill(prisma);

    await expect(backfill.reconcile({ userIds })).resolves.toEqual({ enqueued: 1, settled: 1 });
    // Restarts and repeated passes find every owner done.
    await expect(backfill.reconcile({ userIds })).resolves.toEqual({ enqueued: 0, settled: 0 });
    await expect(createMemorySavedSecretScrubBackfill(prisma).reconcile({ userIds }))
      .resolves.toEqual({ enqueued: 0, settled: 0 });
    const rows = await prisma.memoryDeletionOutbox.findMany({
      where: { targetType: MEMORY_SAVED_SECRET_SCRUB_TARGET_TYPE, userId: { in: userIds } }
    });
    expect(rows).toHaveLength(2);
    const pending = rows.find(({ userId }) => userId === legacy)!;
    expect(pending).toMatchObject({
      operation: "SOURCE_PURGE", state: "PENDING", targetId: MEMORY_SAVED_SECRET_BACKFILL_TARGET_ID
    });
    expect(rows.find(({ userId }) => userId === plain)).toMatchObject({
      state: "SUCCEEDED", targetId: MEMORY_SAVED_SECRET_BACKFILL_TARGET_ID
    });
    expect(JSON.stringify(rows)).not.toContain(TOKEN);

    // The backfilled obligation removes the value like any other cleanup.
    await runDeletion(legacy, pending.id, scrubHandler());
    expect(await prisma.memoryFact.findUniqueOrThrow({ where: { id: held.factId } }))
      .toMatchObject({ state: "FORGOTTEN" });
  });
});
