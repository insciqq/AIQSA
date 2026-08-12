import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { prisma } from "../../prisma";
import type { MemoryJobClaim, MemoryJobDescriptor } from "../coordinator/types";
import { defaultMemoryExecutionAuthority } from "../execution/defaultAuthority";
import {
  memoryFactConsolidationOutputHash,
  type MemoryFactConsolidationPlan
} from "../learning/consolidation/contract";
import {
  MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
  MEMORY_FACT_EXTRACTION_POLICY_VERSION,
  MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
  MEMORY_FACT_EXTRACTION_SCHEMA_VERSION
} from "../learning/extraction/contract";
import { enqueueMemoryJob } from "../persistence/jobs";
import { memorySha256, normalizeMemorySearchText } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";
import { loadMemorySourceSnapshot } from "../sourceState";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import {
  MEMORY_GLOBAL_DREAM_PIPELINE_VERSION,
  memoryGlobalDreamJobFingerprint,
  type MemoryGlobalDreamSelection
} from "./contract";
import { prepareGlobalDreamDeferredSelection } from "./deferred";
import {
  applyAuthorizedGlobalDreamPairSelection,
  createPrismaMemoryGlobalDreamRepository,
  reconcileGlobalDreamJobs
} from "./repository";
import {
  prepareGlobalDreamLocalSelection,
  prepareGlobalDreamPairSelection
} from "./selection";

const now = new Date("2026-08-11T12:00:00.000Z");
const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 41));
const keyring = MemorySuppressionKeyring.parse(
  `current=global-dream-v1,global-dream-v1=${keyBytes.toString("base64")}`
);

type SourceFixture = Readonly<{
  activeLeafMessageId: string;
  branchGeneration: number;
  chatId: string;
  messageId: string;
  observedAt: Date;
  sourceHash: string;
  sourceProjectionVersion: string;
  sourceRevision: number;
  text: string;
}>;

async function createOwner(label: string): Promise<Readonly<{
  scopeId: string;
  userId: string;
}>> {
  const suffix = randomUUID();
  const userId = `global-dream-${label}-${suffix}`;
  await prisma.user.create({
    data: {
      displayName: "Global Dream test",
      email: `${userId}@example.test`,
      id: userId,
      status: "active"
    }
  });
  await prisma.userMemorySettings.update({
    data: {
      learnAutomatically: true,
      referenceChatHistory: false,
      useMemoryFacts: true
    },
    where: { userId }
  });
  const scope = await prisma.memoryScope.create({
    data: {
      scopeType: "GLOBAL_USER",
      state: "ACTIVE",
      userId
    }
  });
  return { scopeId: scope.id, userId };
}

async function createSource(
  userId: string,
  text: string,
  observedAt: Date
): Promise<SourceFixture> {
  const chat = await prisma.chat.create({
    data: { title: `Global Dream source ${randomUUID()}`, userId }
  });
  const userMessage = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent(text),
      createdAt: observedAt,
      role: "user",
      status: "complete",
      updatedAt: observedAt
    }
  });
  const assistantAt = new Date(observedAt.getTime() + 1_000);
  const assistant = await prisma.message.create({
    data: {
      chatId: chat.id,
      content: textMessageContent("Понял."),
      createdAt: assistantAt,
      modelId: "global-dream-test-model",
      parentMessageId: userMessage.id,
      provider: "global-dream-test-provider",
      role: "assistant",
      status: "complete",
      updatedAt: assistantAt
    }
  });
  await prisma.chat.update({
    data: { activeLeafMessageId: assistant.id },
    where: { id: chat.id }
  });
  const snapshot = await prisma.$transaction((tx) => loadMemorySourceSnapshot(tx, {
    chatId: chat.id,
    lock: "SHARE",
    userId
  }));
  if (!snapshot) throw new Error("global_dream_test_source_missing");
  return {
    activeLeafMessageId: assistant.id,
    branchGeneration: snapshot.memoryBranchGeneration,
    chatId: chat.id,
    messageId: userMessage.id,
    observedAt,
    sourceHash: snapshot.sourceHash,
    sourceProjectionVersion: "memory-fact-source-projection-v1",
    sourceRevision: snapshot.memorySourceRevision,
    text
  };
}

async function createFact(input: Readonly<{
  canonicalKey: string;
  scopeId: string;
  source?: SourceFixture;
  sourceMode?: "AUTOMATIC" | "EXPLICIT";
  statement: string;
  userId: string;
  validTo?: Date | null;
}>): Promise<Readonly<{ factId: string; versionId: string }>> {
  const eventId = randomUUID();
  const factId = randomUUID();
  const versionId = randomUUID();
  const sourceMode = input.sourceMode ?? "AUTOMATIC";
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.memoryFact.create({
      data: {
        canonicalKey: input.canonicalKey,
        category: "preference",
        currentVersionId: versionId,
        id: factId,
        lastConfirmedAt: input.source?.observedAt ?? now,
        scopeId: input.scopeId,
        state: "ACTIVE",
        userId: input.userId
      }
    });
    await tx.memoryEvent.create({
      data: {
        actorType: "JOB",
        factId,
        factVersionId: versionId,
        id: eventId,
        metadata: { fixture: true },
        operation: "PROMOTE",
        sourceChatId: input.source?.chatId,
        sourceGeneration: input.source?.branchGeneration,
        userId: input.userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: "preference",
        confidence: 0.95,
        createdByEventId: eventId,
        directness: "DIRECT",
        displayText: input.statement,
        factId,
        id: versionId,
        importance: 0.4,
        languageCode: /[А-Яа-яЁё]/u.test(input.statement) ? "ru" : "en",
        modality: "PREFERENCE",
        normalizedSearchText: normalizeMemorySearchText(input.statement),
        pipelineVersion: "memory-fact-consolidation-v1",
        sensitivityClass: "NORMAL",
        sourceMode,
        sourceTimezone: "UTC",
        state: "ACTIVE",
        structuredValue: { statement: input.statement },
        systemFrom: new Date("2026-08-10T08:00:00.000Z"),
        userId: input.userId,
        validTo: input.validTo ?? null
      }
    });
    if (input.source) {
      await tx.memoryEvidence.create({
        data: {
          branchGeneration: input.source.branchGeneration,
          chatId: input.source.chatId,
          factVersionId: versionId,
          messageId: input.source.messageId,
          observedAt: input.source.observedAt,
          safeExcerpt: input.source.text,
          safeSourceHash: memorySha256(input.source.text),
          safetyClass: "NORMAL",
          sourceProjectionVersion: input.source.sourceProjectionVersion,
          sourceRole: "user",
          sourceType: "MESSAGE",
          stance: "SUPPORTS",
          userId: input.userId
        }
      });
    }
  });
  return { factId, versionId };
}

async function createDeferredCandidate(input: Readonly<{
  canonicalKey: string;
  createdAt: Date;
  source: SourceFixture;
  statement: string;
  userId: string;
}>): Promise<string> {
  const job = await withLockedMemoryTransaction(prisma, input.userId, (tx, settings) =>
    enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: `extract-facts:${memorySha256({
        sourceHash: input.source.sourceHash,
        test: randomUUID()
      })}`,
      kind: "EXTRACT_FACTS",
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      source: {
        activeLeafMessageId: input.source.activeLeafMessageId,
        branchGeneration: input.source.branchGeneration,
        chatId: input.source.chatId,
        sourceHash: input.source.sourceHash,
        sourceRevision: input.source.sourceRevision
      }
    }));
  await prisma.memoryJob.update({
    data: { completedAt: input.createdAt, state: "SUCCEEDED" },
    where: { id: job.id }
  });
  const bindingId = `global-dream-extract-${randomUUID()}`;
  await prisma.memoryExecutionBinding.create({
    data: {
      acceptedOutputHash: "1".repeat(64),
      completedAt: input.createdAt,
      createdAt: new Date(input.createdAt.getTime() - 1_000),
      destinationFingerprint: "2".repeat(64),
      id: bindingId,
      inputHash: "3".repeat(64),
      logicalRole: "MEMORY_FACT_EXTRACT",
      memoryJobId: job.id,
      ordinal: 0,
      ownerType: "JOB",
      pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
      policyVersion: MEMORY_FACT_EXTRACTION_POLICY_VERSION,
      promptVersion: MEMORY_FACT_EXTRACTION_PROMPT_VERSION,
      providerId: "openai_compatible",
      recoverableUntil: input.createdAt,
      relationsDetachedAt: input.createdAt,
      schemaVersion: MEMORY_FACT_EXTRACTION_SCHEMA_VERSION,
      secretFreeExecutionSnapshot: {},
      startedAt: new Date(input.createdAt.getTime() - 500),
      state: "SUCCEEDED",
      userId: input.userId
    }
  });
  const candidateId = memorySha256({
    canonicalKey: input.canonicalKey,
    sourceHash: input.source.sourceHash,
    statement: input.statement,
    test: randomUUID()
  });
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SET CONSTRAINTS ALL DEFERRED`;
    await tx.memoryCandidate.create({
      data: {
        branchGeneration: input.source.branchGeneration,
        chatId: input.source.chatId,
        confidence: 0.65,
        createdAt: input.createdAt,
        createdByExecutionId: bindingId,
        id: candidateId,
        importance: 0.4,
        jobId: job.id,
        languageCode: "en",
        negated: false,
        pipelineVersion: MEMORY_FACT_EXTRACTION_PIPELINE_VERSION,
        proposedCanonicalKey: input.canonicalKey,
        proposedCategory: "preference",
        proposedDirectness: "DIRECT",
        proposedDisplayText: input.statement,
        proposedModality: "PREFERENCE",
        proposedScope: { target_id: null, type: "GLOBAL_USER" },
        proposedSensitivity: "NORMAL",
        proposedValue: { statement: input.statement },
        reasonCode: "low_confidence",
        sourceHash: input.source.sourceHash,
        sourceProjectionHash: "4".repeat(64),
        sourceProjectionVersion: input.source.sourceProjectionVersion,
        sourceRevision: input.source.sourceRevision,
        sourceTimezone: "UTC",
        state: "DEFERRED",
        userId: input.userId
      }
    });
    await tx.memoryCandidateMessage.create({
      data: {
        candidateId,
        chatId: input.source.chatId,
        endOffset: input.statement.length,
        messageId: input.source.messageId,
        ordinal: 0,
        sourceTextHash: memorySha256(input.statement),
        startOffset: 0,
        userId: input.userId
      }
    });
  });
  return candidateId;
}

async function enqueueSelection(
  userId: string,
  selection: MemoryGlobalDreamSelection
): Promise<MemoryJobDescriptor> {
  const identity = selection.kind === "RECONCILE_PAIR" ? {
        kind: selection.kind,
        snapshotHash: selection.snapshotHash,
        sourceFactId: selection.sourceFactId,
        targetFactId: selection.targetFactId
      } : selection.kind === "REVISIT_DEFERRED" ? {
        candidateId: selection.input.candidate.id,
        kind: selection.kind,
        snapshotHash: selection.snapshotHash
      } : {
        factId: selection.factId,
        kind: selection.kind,
        snapshotHash: selection.snapshotHash
      };
  const result = await withLockedMemoryTransaction(prisma, userId, (tx, settings) =>
    enqueueMemoryJob(tx, settings, {
      idempotencyFingerprint: memoryGlobalDreamJobFingerprint(identity),
      kind: "GLOBAL_DREAM",
      pipelineVersion: MEMORY_GLOBAL_DREAM_PIPELINE_VERSION
    }));
  const job = await prisma.memoryJob.findUniqueOrThrow({ where: { id: result.id } });
  return job;
}

function claim(job: MemoryJobDescriptor): MemoryJobClaim {
  return {
    ...job,
    claimToken: randomUUID(),
    leaseExpiresAt: new Date(now.getTime() + 60_000),
    recoveredLease: false
  };
}

function pairPlan(
  selection: Extract<MemoryGlobalDreamSelection, { kind: "RECONCILE_PAIR" }>,
  operation: "CONFLICT" | "REINFORCE"
): MemoryFactConsolidationPlan {
  const withoutHash: Omit<MemoryFactConsolidationPlan, "outputHash"> = {
    candidateId: selection.input.candidate.id,
    effectiveFrom: null,
    evidenceIds: selection.input.candidate.evidence.map(({ messageId }) => messageId),
    operation,
    reasonCode: operation === "REINFORCE"
      ? "same_current_value"
      : "simultaneous_contradiction",
    targetFactId: selection.targetFactId,
    targetVersionId: selection.targetVersionId
  };
  return {
    ...withoutHash,
    outputHash: memoryFactConsolidationOutputHash(selection.input, withoutHash)
  };
}

afterAll(async () => {
  await prisma.user.deleteMany({
    where: { id: { startsWith: "global-dream-" } }
  });
});

describe("Global Dream Prisma repository", () => {
  it("ignores unrelated additive revision but applies the exact invalid-evidence item", async () => {
    const owner = await createOwner("additive");
    const fact = await createFact({
      canonicalKey: "user.preference.additive",
      scopeId: owner.scopeId,
      statement: "I prefer concise answers.",
      userId: owner.userId
    });
    const selection = await withLockedMemoryTransaction(
      prisma,
      owner.userId,
      (tx, settings) => prepareGlobalDreamLocalSelection(tx, keyring, settings, {
        factId: fact.factId,
        kind: "RETRACT_INVALID",
        now
      })
    );
    expect(selection).not.toBeNull();
    const job = await enqueueSelection(owner.userId, selection!);
    await prisma.userMemorySettings.update({
      data: { memoryRevision: { increment: 1 } },
      where: { userId: owner.userId }
    });
    const repository = createPrismaMemoryGlobalDreamRepository(
      defaultMemoryExecutionAuthority,
      prisma,
      { keyring: () => keyring, now: () => new Date(now) }
    );
    await expect(repository.preflight(job)).resolves.toEqual({ status: "READY" });
    await prisma.$transaction((tx) => repository.apply(
      tx,
      claim(job),
      selection!,
      null,
      null,
      now
    ));
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: fact.factId } }))
      .resolves.toMatchObject({ currentVersionId: null, state: "RETRACTED" });
  });

  it("blocks disable, generation, and exact-item races before authoritative apply", async () => {
    const owner = await createOwner("races");
    const repository = createPrismaMemoryGlobalDreamRepository(
      defaultMemoryExecutionAuthority,
      prisma,
      { keyring: () => keyring, now: () => new Date(now) }
    );
    for (const race of ["disable", "generation", "item"] as const) {
      const fact = await createFact({
        canonicalKey: `user.preference.race_${race}`,
        scopeId: owner.scopeId,
        statement: `Race ${race}`,
        userId: owner.userId
      });
      const selection = await withLockedMemoryTransaction(
        prisma,
        owner.userId,
        (tx, settings) => prepareGlobalDreamLocalSelection(tx, keyring, settings, {
          factId: fact.factId,
          kind: "RETRACT_INVALID",
          now
        })
      );
      expect(selection).not.toBeNull();
      const job = await enqueueSelection(owner.userId, selection!);
      if (race === "disable") {
        await prisma.userMemorySettings.update({
          data: { learnAutomatically: false },
          where: { userId: owner.userId }
        });
        await expect(repository.preflight(job)).resolves.toMatchObject({
          status: "CANCELLED"
        });
      } else if (race === "generation") {
        await prisma.userMemorySettings.update({
          data: { memoryGeneration: { increment: 1 } },
          where: { userId: owner.userId }
        });
        await expect(repository.preflight(job)).resolves.toMatchObject({ status: "STALE" });
      } else {
        await prisma.memoryFact.update({
          data: { pinned: true },
          where: { id: fact.factId }
        });
        await expect(repository.preflight(job)).resolves.toMatchObject({ status: "STALE" });
      }
      await prisma.$transaction((tx) => repository.apply(
        tx,
        claim(job),
        selection!,
        null,
        null,
        now
      ));
      await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: fact.factId } }))
        .resolves.toMatchObject({ currentVersionId: fact.versionId, state: "ACTIVE" });
      await prisma.userMemorySettings.update({
        data: { learnAutomatically: true },
        where: { userId: owner.userId }
      });
    }
  });

  it("expires only an elapsed explicit validTo backed by current user evidence", async () => {
    const owner = await createOwner("temporal");
    const source = await createSource(
      owner.userId,
      "I prefer English summaries until noon.",
      new Date("2026-08-10T09:00:00.000Z")
    );
    const fact = await createFact({
      canonicalKey: "user.preference.temporary_language",
      scopeId: owner.scopeId,
      source,
      statement: source.text,
      userId: owner.userId,
      validTo: new Date("2026-08-11T11:00:00.000Z")
    });
    const selection = await withLockedMemoryTransaction(
      prisma,
      owner.userId,
      (tx, settings) => prepareGlobalDreamLocalSelection(tx, keyring, settings, {
        factId: fact.factId,
        kind: "EXPIRE_TEMPORAL",
        now
      })
    );
    expect(selection?.kind).toBe("EXPIRE_TEMPORAL");
    const job = await enqueueSelection(owner.userId, selection!);
    const repository = createPrismaMemoryGlobalDreamRepository(
      defaultMemoryExecutionAuthority,
      prisma,
      { keyring: () => keyring, now: () => new Date(now) }
    );
    await prisma.$transaction((tx) => repository.apply(
      tx,
      claim(job),
      selection!,
      null,
      null,
      now
    ));
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: fact.factId } }))
      .resolves.toMatchObject({ currentVersionId: null, state: "EXPIRED" });
  });

  it("revisits a deferred candidate only after newer exact automatic evidence exists", async () => {
    const owner = await createOwner("deferred");
    const statement = "I prefer compact code reviews.";
    const candidateSource = await createSource(
      owner.userId,
      statement,
      new Date("2026-08-08T09:00:00.000Z")
    );
    const candidateId = await createDeferredCandidate({
      canonicalKey: "user.preference.compact_reviews",
      createdAt: new Date("2026-08-09T09:00:00.000Z"),
      source: candidateSource,
      statement,
      userId: owner.userId
    });
    const targetSource = await createSource(
      owner.userId,
      statement,
      new Date("2026-08-10T09:00:00.000Z")
    );
    const target = await createFact({
      canonicalKey: "user.preference.compact_reviews",
      scopeId: owner.scopeId,
      source: targetSource,
      statement,
      userId: owner.userId
    });
    const selected = await withLockedMemoryTransaction(
      prisma,
      owner.userId,
      (tx, settings) => prepareGlobalDreamDeferredSelection(
        tx,
        keyring,
        settings,
        { candidateId, now }
      )
    );
    expect(selected).toMatchObject({
      kind: "REVISIT_DEFERRED",
      scopeChanged: true,
      targetFactId: target.factId,
      targetVersionId: target.versionId
    });
    await prisma.chat.update({
      data: { memorySourceRevision: { increment: 1 } },
      where: { id: candidateSource.chatId }
    });
    await expect(withLockedMemoryTransaction(
      prisma,
      owner.userId,
      (tx, settings) => prepareGlobalDreamDeferredSelection(
        tx,
        keyring,
        settings,
        { candidateId, now }
      )
    )).resolves.toBeNull();
  });

  it("transactionally reinforces a grounded RU pair and rejects explicit authority", async () => {
    const owner = await createOwner("pair");
    const statement = "Я предпочитаю краткие технические ответы.";
    const targetSource = await createSource(
      owner.userId,
      statement,
      new Date("2026-08-09T09:00:00.000Z")
    );
    const sourceSource = await createSource(
      owner.userId,
      statement,
      new Date("2026-08-10T09:00:00.000Z")
    );
    const target = await createFact({
      canonicalKey: "user.preference.concise_technical",
      scopeId: owner.scopeId,
      source: targetSource,
      statement,
      userId: owner.userId
    });
    const source = await createFact({
      canonicalKey: "user.preference.short_answers",
      scopeId: owner.scopeId,
      source: sourceSource,
      statement,
      userId: owner.userId
    });
    const selection = await withLockedMemoryTransaction(
      prisma,
      owner.userId,
      (tx, settings) => prepareGlobalDreamPairSelection(tx, keyring, settings, {
        now,
        sourceFactId: source.factId,
        targetFactId: target.factId
      })
    );
    expect(selection).toMatchObject({
      kind: "RECONCILE_PAIR",
      sourceFactId: source.factId,
      targetFactId: target.factId
    });
    const pairSelection = selection as Extract<
      MemoryGlobalDreamSelection,
      { kind: "RECONCILE_PAIR" }
    >;
    const pairJob = await enqueueSelection(owner.userId, pairSelection);
    await withLockedMemoryTransaction(prisma, owner.userId, (tx, settings) =>
      applyAuthorizedGlobalDreamPairSelection(
        tx,
        settings,
        claim(pairJob),
        pairSelection,
        pairPlan(pairSelection, "REINFORCE"),
        "global-dream-test-consolidation",
        null,
        now
      ));
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: source.factId } }))
      .resolves.toMatchObject({
        currentVersionId: null,
        movedToFactId: target.factId,
        state: "RETRACTED"
      });
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: target.factId } }))
      .resolves.toMatchObject({
        currentVersionId: target.versionId,
        state: "ACTIVE"
      });
    await expect(prisma.memoryEvidence.count({
      where: { factVersionId: target.versionId, userId: owner.userId }
    })).resolves.toBe(2);

    const explicit = await createFact({
      canonicalKey: "user.preference.explicit",
      scopeId: owner.scopeId,
      sourceMode: "EXPLICIT",
      statement: "Всегда отвечай подробно.",
      userId: owner.userId
    });
    await expect(withLockedMemoryTransaction(
      prisma,
      owner.userId,
      (tx, settings) => prepareGlobalDreamLocalSelection(tx, keyring, settings, {
        factId: explicit.factId,
        kind: "RETRACT_INVALID",
        now
      })
    )).resolves.toBeNull();
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: explicit.factId } }))
      .resolves.toMatchObject({ currentVersionId: explicit.versionId, state: "ACTIVE" });
  });

  it("retains both evidence branches and the move pointer for a RU conflict", async () => {
    const owner = await createOwner("conflict");
    const targetSource = await createSource(
      owner.userId,
      "Я предпочитаю краткие технические ответы.",
      new Date("2026-08-09T09:00:00.000Z")
    );
    const sourceSource = await createSource(
      owner.userId,
      "Я не предпочитаю краткие технические ответы.",
      new Date("2026-08-10T09:00:00.000Z")
    );
    const target = await createFact({
      canonicalKey: "user.preference.concise_conflict",
      scopeId: owner.scopeId,
      source: targetSource,
      statement: targetSource.text,
      userId: owner.userId
    });
    const source = await createFact({
      canonicalKey: "user.preference.not_concise_conflict",
      scopeId: owner.scopeId,
      source: sourceSource,
      statement: sourceSource.text,
      userId: owner.userId
    });
    const selection = await withLockedMemoryTransaction(
      prisma,
      owner.userId,
      (tx, settings) => prepareGlobalDreamPairSelection(tx, keyring, settings, {
        now,
        sourceFactId: source.factId,
        targetFactId: target.factId
      })
    ) as Extract<MemoryGlobalDreamSelection, { kind: "RECONCILE_PAIR" }> | null;
    expect(selection).not.toBeNull();
    const job = await enqueueSelection(owner.userId, selection!);
    await withLockedMemoryTransaction(prisma, owner.userId, (tx, settings) =>
      applyAuthorizedGlobalDreamPairSelection(
        tx,
        settings,
        claim(job),
        selection!,
        pairPlan(selection!, "CONFLICT"),
        "global-dream-test-consolidation",
        "global-dream-test-verification",
        now
      ));
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: target.factId } }))
      .resolves.toMatchObject({ currentVersionId: null, state: "CONFLICTED" });
    await expect(prisma.memoryFact.findUniqueOrThrow({ where: { id: source.factId } }))
      .resolves.toMatchObject({
        currentVersionId: null,
        movedToFactId: target.factId,
        state: "RETRACTED"
      });
    const conflicting = await prisma.memoryFactVersion.findMany({
      orderBy: { createdAt: "asc" },
      select: { id: true, movedFromVersionId: true, state: true },
      where: { factId: target.factId, userId: owner.userId }
    });
    expect(conflicting).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: target.versionId, state: "CONFLICTING" }),
      expect.objectContaining({
        movedFromVersionId: source.versionId,
        state: "CONFLICTING"
      })
    ]));
    await expect(prisma.memoryEvidence.count({
      where: {
        factVersionId: { in: conflicting.map(({ id }) => id) },
        userId: owner.userId
      }
    })).resolves.toBe(2);
  });

  it("discovers bounded local work once per low-frequency owner window", async () => {
    const owner = await createOwner("discovery");
    await prisma.userMemorySettings.updateMany({
      data: { learnAutomatically: false },
      where: {
        userId: { not: owner.userId, startsWith: "global-dream-" }
      }
    });
    await createFact({
      canonicalKey: "user.preference.discovery_one",
      scopeId: owner.scopeId,
      statement: "I prefer concise plans.",
      userId: owner.userId
    });
    await createFact({
      canonicalKey: "user.preference.discovery_two",
      scopeId: owner.scopeId,
      statement: "I prefer explicit checks.",
      userId: owner.userId
    });
    await expect(reconcileGlobalDreamJobs(prisma, {
      keyring: () => keyring,
      limit: 1,
      now
    })).resolves.toBe(2);
    await expect(prisma.memoryJob.count({
      where: { kind: "GLOBAL_DREAM", userId: owner.userId }
    })).resolves.toBe(2);
    await expect(reconcileGlobalDreamJobs(prisma, {
      keyring: () => keyring,
      limit: 1,
      now: new Date(now.getTime() + 60 * 60 * 1_000)
    })).resolves.toBe(0);
    await expect(reconcileGlobalDreamJobs(prisma, {
      keyring: () => keyring,
      limit: 0,
      now
    })).rejects.toThrow("memory_global_dream_limit_invalid");
  });
});
