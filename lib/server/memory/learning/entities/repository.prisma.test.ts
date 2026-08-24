import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { textMessageContent } from "../../../../domain/content";
import { prisma } from "../../../prisma";
import { memorySha256, normalizeMemorySearchText } from "../../persistence/lexical";
import {
  memoryFactDependenciesAreValid,
  persistMemoryFactDependencies
} from "../dependencies/repository";
import {
  MEMORY_FACT_SOURCE_PROJECTION_VERSION,
  type MemoryExtractedCandidate,
  type MemoryFactCandidateDependency,
  type MemoryFactCandidateEntity
} from "../extraction/contract";
import { pruneUnreferencedMemoryEntities, removeUnsupportedMemoryEntityLinks } from "./lifecycle";
import { mergeMemoryEntities, persistMemoryCandidateEntities } from "./repository";

const observedAt = new Date("2026-08-24T10:00:00.000Z");

afterAll(async () => {
  await prisma.$disconnect();
});

type FactFixture = Readonly<{
  evidenceId: string;
  factId: string;
  versionId: string;
}>;

async function createOwner(label: string): Promise<string> {
  const id = `memory-entity-${label}-${randomUUID()}`;
  await prisma.user.create({
    data: {
      displayName: "Memory entity test",
      email: `${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

async function cleanupOwner(userId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await tx.memoryFactVersionSourceDependency.deleteMany({ where: { userId } });
    await tx.memoryEntityAliasSupport.deleteMany({ where: { userId } });
    await tx.memoryFactVersionEntity.deleteMany({ where: { userId } });
    await tx.memoryEntityAlias.deleteMany({ where: { userId } });
    await pruneUnreferencedMemoryEntities(tx, userId);
    await tx.memoryDeletionOutbox.deleteMany({ where: { userId } });
    await tx.user.deleteMany({ where: { id: userId } });
  });
}

async function classificationBinding(userId: string): Promise<string> {
  const authorizationId = randomUUID();
  const bindingId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memoryMutationAuthorization.create({
      data: {
        action: "SAVE",
        authorizedPayloadHash: memorySha256({ authorizationId }),
        confirmationCopyVersion: "memory-entity-test-v1",
        consumedAt: observedAt,
        createdAt: observedAt,
        expiresAt: new Date(observedAt.getTime() + 60_000),
        id: authorizationId,
        nonceHash: memorySha256({ authorizationId, userId }),
        requestId: `memory-entity-test-${authorizationId}`,
        userId
      }
    });
    await tx.memoryExecutionBinding.create({
      data: {
        acceptedOutputHash: memorySha256({ bindingId, result: "NORMAL" }),
        completedAt: observedAt,
        createdAt: observedAt,
        destinationFingerprint: memorySha256({ destination: "fixture" }),
        id: bindingId,
        inputHash: memorySha256({ bindingId, input: "fixture" }),
        logicalRole: "MEMORY_STATEMENT_CLASSIFY",
        mutationAuthorizationId: authorizationId,
        ordinal: 0,
        ownerType: "MUTATION_AUTHORIZATION",
        pipelineVersion: "memory-entity-test-v1",
        policyVersion: "memory-entity-test-v1",
        promptVersion: "memory-entity-test-v1",
        providerId: "memory-entity-fixture",
        recoverableUntil: observedAt,
        relationsDetachedAt: observedAt,
        schemaVersion: "memory-entity-test-v1",
        secretFreeExecutionSnapshot: {},
        startedAt: observedAt,
        state: "SUCCEEDED",
        userId
      }
    });
  });
  return bindingId;
}

async function createExplicitFact(
  userId: string,
  displayText: string,
  canonicalKey = `proposition:v1:${memorySha256(displayText)}`
): Promise<FactFixture> {
  const bindingId = await classificationBinding(userId);
  const scope = await prisma.memoryScope.findFirst({
    where: { scopeType: "GLOBAL_USER", state: "ACTIVE", userId }
  }) ?? await prisma.memoryScope.create({
    data: { scopeType: "GLOBAL_USER", userId }
  });
  const event = await prisma.memoryEvent.create({
    data: {
      actorType: "USER",
      actorUserId: userId,
      operation: "EXPLICIT_SAVE",
      userId
    }
  });
  const factId = randomUUID();
  const versionId = randomUUID();
  const evidenceId = randomUUID();
  await prisma.$transaction(async (tx) => {
    await tx.memoryFact.create({
      data: {
        canonicalKey,
        category: "about_you",
        currentVersionId: versionId,
        id: factId,
        scopeId: scope.id,
        state: "ACTIVE",
        userId
      }
    });
    await tx.memoryFactVersion.create({
      data: {
        category: "about_you",
        confidence: 1,
        createdByEventId: event.id,
        directness: "DIRECT",
        displayText,
        factId,
        id: versionId,
        importance: 0.8,
        languageCode: "en",
        modality: "EVENT",
        normalizedSearchText: normalizeMemorySearchText(displayText),
        pipelineVersion: "memory-entity-test-v1",
        safetyClassificationReasonCode: "direct_fixture",
        safetyClassificationState: "CLASSIFIED",
        safetyClassifiedAt: observedAt,
        safetyClassifierExecutionId: bindingId,
        safetyClassifierModelId: "memory-entity-fixture",
        safetyClassifierPolicyVersion: "memory-entity-test-v1",
        safetyClassifierProviderId: "memory-entity-fixture",
        sensitivityClass: "NORMAL",
        sourceMode: "EXPLICIT",
        state: "ACTIVE",
        structuredValue: { statement: displayText },
        userId
      }
    });
    await tx.memoryEvidence.create({
      data: {
        factVersionId: versionId,
        id: evidenceId,
        memoryEventId: event.id,
        observedAt,
        safeExcerpt: displayText,
        safeSourceHash: memorySha256(displayText),
        safetyClass: "NORMAL",
        sourceProjectionVersion: "memory-entity-test-v1",
        sourceType: "EXPLICIT_ACTION",
        stance: "SUPPORTS",
        userId
      }
    });
  });
  return { evidenceId, factId, versionId };
}

function entityCandidate(input: Readonly<{
  aliases?: readonly string[];
  canonicalLabel?: string;
  contextEntityId?: string | null;
  entityType?: string;
  mention: string;
  model?: string;
}>): MemoryFactCandidateEntity {
  return {
    aliases: input.aliases ?? [],
    canonicalLabel: input.canonicalLabel ?? "MacBook Air",
    contextEntityId: input.contextEntityId ?? null,
    contextRef: input.contextEntityId ? "F1" : null,
    entityType: input.entityType ?? "DEVICE",
    mention: input.mention,
    qualifiers: {
      brand: "Apple",
      model: input.model ?? "MacBook Air"
    },
    role: "SUBJECT"
  };
}

function candidate(quote: string, entity: MemoryFactCandidateEntity): MemoryExtractedCandidate {
  return {
    canonicalKey: `proposition:v1:${memorySha256(quote)}`,
    category: "about_you",
    confidence: 1,
    coreEligible: false,
    coreSalience: "NONE",
    dimensionKey: null,
    directness: "DIRECT",
    displayText: quote,
    dependencies: [],
    entities: [entity],
    evidence: [],
    expectedAt: null,
    expiresAt: null,
    id: memorySha256({ quote }),
    identityKind: "PROPOSITION",
    identityVersion: "proposition-v1",
    importance: 0.8,
    languageCode: "en",
    modality: "EVENT",
    negated: false,
    occurredAt: null,
    predicateKey: null,
    proposedValue: { statement: quote },
    quote,
    rawTemporalExpression: null,
    reasonCode: null,
    scope: { targetId: null, type: "GLOBAL_USER" },
    sensitivity: "NORMAL",
    state: "PENDING",
    subjectKey: null,
    temporalResolutionEvidence: null,
    validFrom: null,
    validTo: null
  };
}

async function attach(
  userId: string,
  fact: FactFixture,
  quote: string,
  entity: MemoryFactCandidateEntity
): Promise<void> {
  await prisma.$transaction((tx) => persistMemoryCandidateEntities(tx, {
    candidate: candidate(quote, entity),
    evidenceId: fact.evidenceId,
    factVersionId: fact.versionId,
    userId
  }));
}

function factDependency(
  ref: string,
  factVersionId: string
): MemoryFactCandidateDependency {
  return {
    dependencyKind: "RELATION_CONTEXT",
    ref,
    source: {
      contentHash: null,
      factVersionId,
      messageId: null,
      messageUpdatedAt: null,
      projectionVersion: null
    }
  };
}

function messageDependency(input: Readonly<{
  contentHash: string;
  messageId: string;
  messageUpdatedAt: Date;
  ref?: string;
}>): MemoryFactCandidateDependency {
  return {
    dependencyKind: "COREFERENCE_ANTECEDENT",
    ref: input.ref ?? "M1",
    source: {
      contentHash: input.contentHash,
      factVersionId: null,
      messageId: input.messageId,
      messageUpdatedAt: input.messageUpdatedAt.toISOString(),
      projectionVersion: MEMORY_FACT_SOURCE_PROJECTION_VERSION
    }
  };
}

describe("Prisma Memory entity provenance", () => {
  it("reuses a supported cross-language context entity and never stores a pronoun alias", async () => {
    const userId = await createOwner("cross-language");
    try {
      const bought = await createExplicitFact(userId, "I bought a MacBook Air.");
      await attach(userId, bought, "I bought a MacBook Air.", entityCandidate({
        mention: "MacBook Air"
      }));
      const root = await prisma.memoryEntity.findFirstOrThrow({ where: { userId } });

      const ordered = await createExplicitFact(userId, "Я заказал макбук.");
      await attach(userId, ordered, "Я заказал макбук.", entityCandidate({
        aliases: ["макбук"],
        contextEntityId: root.id,
        mention: "макбук"
      }));
      const received = await createExplicitFact(userId, "I got it yesterday.");
      await attach(userId, received, "I got it yesterday.", entityCandidate({
        contextEntityId: root.id,
        mention: "it"
      }));

      await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersionEntity.count({
        where: { entityId: root.id, userId }
      })).resolves.toBe(3);
      const aliases = await prisma.memoryEntityAlias.findMany({
        orderBy: { normalizedAlias: "asc" },
        where: { userId }
      });
      expect(aliases.map(({ normalizedAlias }) => normalizedAlias)).toEqual([
        "macbook air",
        "макбук"
      ]);
      expect(aliases.map(({ normalizedAlias }) => normalizedAlias)).not.toContain("it");

      const planEvidence = await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SET LOCAL enable_seqscan = off`);
        const aliasPlan = await tx.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(Prisma.sql`
          EXPLAIN (FORMAT JSON)
          SELECT alias."entityId"
          FROM "MemoryEntityAlias" AS alias
          WHERE alias."userId" = ${userId}
            AND alias."normalizedAlias" = 'макбук'
        `);
        const linkPlan = await tx.$queryRaw<Array<{ "QUERY PLAN": unknown }>>(Prisma.sql`
          EXPLAIN (FORMAT JSON)
          SELECT link."factVersionId"
          FROM "MemoryFactVersionEntity" AS link
          WHERE link."userId" = ${userId}
            AND link."entityId" = ${root.id}
            AND link."role" = 'SUBJECT'::"MemoryEntityLinkRole"
        `);
        const linkIndexes = await tx.$queryRaw<Array<{ indexname: string }>>(Prisma.sql`
          SELECT indexname
          FROM pg_indexes
          WHERE schemaname = current_schema()
            AND tablename = 'MemoryFactVersionEntity'
          ORDER BY indexname
        `);
        return {
          aliasPlan: JSON.stringify(aliasPlan),
          linkIndexes: linkIndexes.map(({ indexname }) => indexname),
          linkPlan: JSON.stringify(linkPlan)
        };
      });
      expect(planEvidence.aliasPlan)
        .toContain("MemoryEntityAlias_userId_normalizedAlias_idx");
      expect(planEvidence.linkIndexes)
        .toContain("MemoryFactVersionEntity_userId_entityId_role_factVersionId_idx");
      // A tiny fixture may make PostgreSQL prefer the primary key over the
      // covering owner index. Prove both that the production index is present
      // and that the actual owner-bound query remains index-backed, without
      // pinning a cost-based choice that changes with table statistics.
      expect(planEvidence.linkPlan).toMatch(
        /"Node Type":"(?:Bitmap Heap Scan|Index Only Scan|Index Scan)"/u
      );
      expect(planEvidence.linkPlan).not.toContain('"Node Type":"Seq Scan"');
      expect(planEvidence.linkPlan).toContain(userId);
      expect(planEvidence.linkPlan).toContain(root.id);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("keeps historical links through a merge and resolves new writes to the active root", async () => {
    const userId = await createOwner("merge");
    try {
      const broadFact = await createExplicitFact(userId, "I use a MacBook Air.");
      await attach(userId, broadFact, "I use a MacBook Air.", entityCandidate({
        mention: "MacBook Air"
      }));
      const specificFact = await createExplicitFact(userId, "I use a MacBook Air M4.");
      await attach(userId, specificFact, "I use a MacBook Air M4.", entityCandidate({
        canonicalLabel: "MacBook Air M4",
        mention: "MacBook Air M4",
        model: "MacBook Air M4"
      }));
      const entities = await prisma.memoryEntity.findMany({
        orderBy: { canonicalKey: "asc" },
        where: { userId }
      });
      expect(entities).toHaveLength(2);
      const canonical = entities.find(({ displayName }) =>
        displayName === "MacBook Air")!;
      const redundant = entities.find(({ displayName }) =>
        displayName === "MacBook Air M4")!;
      await prisma.$transaction((tx) => mergeMemoryEntities(
        tx,
        userId,
        redundant.id,
        canonical.id
      ));
      await expect(prisma.memoryFactVersionEntity.findFirstOrThrow({
        where: { factVersionId: specificFact.versionId, userId }
      })).resolves.toMatchObject({ entityId: redundant.id });

      const followup = await createExplicitFact(userId, "I got it yesterday.");
      await attach(userId, followup, "I got it yesterday.", entityCandidate({
        contextEntityId: redundant.id,
        mention: "it"
      }));
      await expect(prisma.memoryFactVersionEntity.findFirstOrThrow({
        where: { factVersionId: followup.versionId, userId }
      })).resolves.toMatchObject({ entityId: canonical.id });
      await expect(prisma.memoryEntity.update({
        data: { mergedIntoId: redundant.id, state: "MERGED" },
        where: { id: canonical.id }
      })).rejects.toThrow(/merge target is cyclic or unavailable/u);
      await expect(prisma.memoryEntity.update({
        data: { mergedIntoId: null, state: "ACTIVE" },
        where: { id: redundant.id }
      })).rejects.toThrow(/merge is immutable/u);
      await expect(prisma.memoryEntity.create({
        data: {
          canonicalKey: "entity:v2:device:merge-chain-probe",
          displayName: "Merge chain probe",
          entityType: "DEVICE",
          id: randomUUID(),
          mergedIntoId: redundant.id,
          state: "MERGED",
          userId
        }
      })).rejects.toThrow(/merge target is cyclic or unavailable/u);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("retains aliases while supported, cleans zero-support derivatives, and converges a real create race", async () => {
    const userId = await createOwner("support-race");
    try {
      const first = await createExplicitFact(userId, "I bought a MacBook Air.");
      const repeatEvent = await prisma.memoryEvent.create({
        data: {
          actorType: "USER",
          actorUserId: userId,
          operation: "EXPLICIT_SAVE",
          userId
        }
      });
      const secondEvidence = await prisma.memoryEvidence.create({
        data: {
          factVersionId: first.versionId,
          memoryEventId: repeatEvent.id,
          observedAt: new Date(observedAt.getTime() + 1_000),
          safeExcerpt: "I bought a MacBook Air.",
          safeSourceHash: memorySha256({ repeat: true }),
          safetyClass: "NORMAL",
          sourceProjectionVersion: "memory-entity-test-v1",
          sourceType: "EXPLICIT_ACTION",
          stance: "SUPPORTS",
          userId
        }
      });
      const direct = entityCandidate({ mention: "MacBook Air" });
      await attach(userId, first, "I bought a MacBook Air.", direct);
      await prisma.$transaction((tx) => persistMemoryCandidateEntities(tx, {
        candidate: candidate("I bought a MacBook Air.", direct),
        evidenceId: secondEvidence.id,
        factVersionId: first.versionId,
        userId
      }));
      const alias = await prisma.memoryEntityAlias.findFirstOrThrow({ where: { userId } });
      await expect(prisma.memoryEntityAliasSupport.count({
        where: { aliasId: alias.id, userId }
      })).resolves.toBe(2);
      await expect(prisma.memoryEntityAlias.create({
        data: {
          confidence: 1,
          displayAlias: "Unsupported alias",
          entityId: alias.entityId,
          id: randomUUID(),
          normalizedAlias: "unsupported alias",
          sourceKind: "AUTOMATIC_EVIDENCE",
          userId
        }
      })).rejects.toThrow(/requires durable support/u);
      await prisma.memoryEvidence.delete({ where: { id: first.evidenceId } });
      await expect(prisma.memoryEntityAlias.findUnique({ where: { id: alias.id } }))
        .resolves.not.toBeNull();
      await prisma.memoryEvidence.delete({ where: { id: secondEvidence.id } });
      await expect(prisma.memoryEntityAlias.findUnique({ where: { id: alias.id } }))
        .resolves.toBeNull();
      await prisma.$transaction((tx) => removeUnsupportedMemoryEntityLinks(
        tx,
        userId,
        [first.versionId]
      ));
      await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(0);

      const left = await createExplicitFact(
        userId,
        "I bought a MacBook Air.",
        `proposition:v1:${memorySha256({ race: "left" })}`
      );
      const right = await createExplicitFact(
        userId,
        "Я купил MacBook Air.",
        `proposition:v1:${memorySha256({ race: "right" })}`
      );
      await Promise.all([
        prisma.$transaction((tx) => persistMemoryCandidateEntities(tx, {
          candidate: candidate("I bought a MacBook Air.", direct),
          evidenceId: left.evidenceId,
          factVersionId: left.versionId,
          userId
        })),
        prisma.$transaction((tx) => persistMemoryCandidateEntities(tx, {
          candidate: candidate("Я купил MacBook Air.", direct),
          evidenceId: right.evidenceId,
          factVersionId: right.versionId,
          userId
        }))
      ]);
      await expect(prisma.memoryEntity.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersionEntity.count({ where: { userId } }))
        .resolves.toBe(2);

      const foreignUserId = await createOwner("foreign");
      try {
        const foreign = await createExplicitFact(
          foreignUserId,
          "I bought a MacBook Air."
        );
        await attach(foreignUserId, foreign, "I bought a MacBook Air.", direct);
        const ids = await prisma.memoryEntity.findMany({
          orderBy: { userId: "asc" },
          select: { id: true, userId: true },
          where: { userId: { in: [userId, foreignUserId] } }
        });
        expect(ids).toHaveLength(2);
        expect(ids[0]!.id).not.toBe(ids[1]!.id);
        const ownerEntity = ids.find((item) => item.userId === userId)!;
        await expect(prisma.memoryFactVersionEntity.create({
          data: {
            confidence: 1,
            entityId: ownerEntity.id,
            factVersionId: foreign.versionId,
            role: "SUBJECT",
            userId: foreignUserId
          }
        })).rejects.toThrow();
      } finally {
        await cleanupOwner(foreignUserId);
      }
    } finally {
      await cleanupOwner(userId);
    }
  });
});

describe("Prisma Memory source dependencies", () => {
  it("persists immutable direct-user provenance and fences it after an edit or branch change", async () => {
    const userId = await createOwner("message-dependency");
    try {
      const chat = await prisma.chat.create({
        data: { title: "Dependency source", userId }
      });
      const sourceText = "I am considering a MacBook Air.";
      const sourceAt = new Date("2026-08-24T09:00:00.000Z");
      const source = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent(sourceText),
          createdAt: sourceAt,
          role: "user",
          status: "complete",
          updatedAt: sourceAt
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: source.id },
        where: { id: chat.id }
      });
      const target = await createExplicitFact(userId, "I finally bought it.");
      const dependency = messageDependency({
        contentHash: memorySha256(sourceText),
        messageId: source.id,
        messageUpdatedAt: sourceAt
      });
      await prisma.$transaction((tx) => persistMemoryFactDependencies(
        tx,
        userId,
        target.versionId,
        [dependency]
      ));
      const stored = await prisma.memoryFactVersionSourceDependency.findFirstOrThrow({
        where: { targetFactVersionId: target.versionId, userId }
      });
      await expect(prisma.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
        SELECT aiqsa_memory_fact_dependencies_valid(
          ${userId},
          ${target.versionId}
        ) AS valid
      `)).resolves.toEqual([{ valid: true }]);
      await expect(prisma.memoryFactVersionSourceDependency.update({
        data: { dependencyKind: "CORRECTION_TARGET" },
        where: { id: stored.id }
      })).rejects.toThrow(/dependencies are immutable/u);

      const editedAt = new Date(sourceAt.getTime() + 60_000);
      await prisma.message.update({
        data: {
          content: textMessageContent("I am considering a different laptop."),
          updatedAt: editedAt
        },
        where: { id: source.id }
      });
      await expect(prisma.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
        SELECT aiqsa_memory_fact_dependencies_valid(
          ${userId},
          ${target.versionId}
        ) AS valid
      `)).resolves.toEqual([{ valid: false }]);
      await expect(prisma.$transaction((tx) => memoryFactDependenciesAreValid(
        tx,
        userId,
        target.versionId,
        [dependency]
      ))).resolves.toBe(false);

      const replacement = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("A new branch."),
          createdAt: new Date(editedAt.getTime() + 60_000),
          role: "user",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: replacement.id },
        where: { id: chat.id }
      });
      await expect(prisma.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
        SELECT aiqsa_memory_fact_dependencies_valid(
          ${userId},
          ${target.versionId}
        ) AS valid
      `)).resolves.toEqual([{ valid: false }]);

      const assistant = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("The user owns a MacBook Air."),
          parentMessageId: replacement.id,
          role: "assistant",
          status: "complete"
        }
      });
      await prisma.chat.update({
        data: { activeLeafMessageId: assistant.id },
        where: { id: chat.id }
      });
      const otherTarget = await createExplicitFact(userId, "Assistant claim target.");
      await expect(prisma.$transaction((tx) => persistMemoryFactDependencies(
        tx,
        userId,
        otherTarget.versionId,
        [messageDependency({
          contentHash: memorySha256("The user owns a MacBook Air."),
          messageId: assistant.id,
          messageUpdatedAt: assistant.updatedAt
        })]
      ))).rejects.toThrow(/memory_dependency_source_stale/u);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("serializes concurrent dependency writes before they can form a cycle", async () => {
    const userId = await createOwner("dependency-cycle-race");
    try {
      const left = await createExplicitFact(userId, "Concurrent dependency left.");
      const right = await createExplicitFact(userId, "Concurrent dependency right.");
      const results = await Promise.allSettled([
        prisma.$transaction((tx) => persistMemoryFactDependencies(
          tx,
          userId,
          left.versionId,
          [factDependency("F1", right.versionId)]
        )),
        prisma.$transaction((tx) => persistMemoryFactDependencies(
          tx,
          userId,
          right.versionId,
          [factDependency("F1", left.versionId)]
        ))
      ]);
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      await expect(prisma.memoryFactVersionSourceDependency.count({
        where: { userId }
      })).resolves.toBe(1);
    } finally {
      await cleanupOwner(userId);
    }
  });

  it("rejects owner leaks, cycles, and chains deeper than two edges", async () => {
    const userId = await createOwner("dependency-graph");
    const foreignUserId = await createOwner("dependency-foreign");
    try {
      const a = await createExplicitFact(userId, "Dependency A.");
      const b = await createExplicitFact(userId, "Dependency B.");
      const c = await createExplicitFact(userId, "Dependency C.");
      const d = await createExplicitFact(userId, "Dependency D.");
      await prisma.$transaction((tx) => persistMemoryFactDependencies(
        tx,
        userId,
        b.versionId,
        [factDependency("F1", a.versionId)]
      ));
      await prisma.$transaction((tx) => persistMemoryFactDependencies(
        tx,
        userId,
        c.versionId,
        [factDependency("F1", b.versionId)]
      ));
      await expect(prisma.$transaction((tx) => persistMemoryFactDependencies(
        tx,
        userId,
        d.versionId,
        [factDependency("F1", c.versionId)]
      ))).rejects.toThrow(/cyclic or exceeds depth two/u);
      await expect(prisma.$transaction((tx) => persistMemoryFactDependencies(
        tx,
        userId,
        a.versionId,
        [factDependency("F1", b.versionId)]
      ))).rejects.toThrow(/cyclic or exceeds depth two/u);

      const foreign = await createExplicitFact(foreignUserId, "Foreign dependency.");
      await expect(prisma.$transaction((tx) => persistMemoryFactDependencies(
        tx,
        userId,
        d.versionId,
        [factDependency("F1", foreign.versionId)]
      ))).rejects.toThrow(/memory_dependency_source_stale/u);
      await expect(prisma.$transaction((tx) => persistMemoryFactDependencies(
        tx,
        userId,
        d.versionId,
        [factDependency("F1", d.versionId)]
      ))).rejects.toThrow(/memory_dependency_source_stale/u);

      await prisma.$transaction(async (tx) => {
        await tx.memoryFact.update({
          data: {
            currentVersionId: null,
            forgottenAt: new Date(),
            state: "FORGOTTEN"
          },
          where: { id: a.factId }
        });
        await tx.memoryFactVersion.update({
          data: { state: "FORGOTTEN", systemTo: new Date() },
          where: { id: a.versionId }
        });
      });
      await expect(prisma.$queryRaw<Array<{ valid: boolean }>>(Prisma.sql`
        SELECT aiqsa_memory_fact_dependencies_valid(
          ${userId},
          ${c.versionId}
        ) AS valid
      `)).resolves.toEqual([{ valid: false }]);
    } finally {
      await cleanupOwner(foreignUserId);
      await cleanupOwner(userId);
    }
  });
});
