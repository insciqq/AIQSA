import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../../prisma";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { createPrismaMemoryDeletionRepository } from "./deletion";
import { MemoryPersistenceError } from "./errors";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactSaveInput,
  type MemoryFactValueInput
} from "./facts";
import { createPrismaMemoryJobRepository } from "./jobs";
import { createPrismaMemoryScopeRepository } from "./scopes";
import { createPrismaMemorySettingsRepository } from "./settings";
import { createPrismaMemorySuppressionRepository } from "./suppressions";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 1));
const suppressionKeyring = MemorySuppressionKeyring.parse(
  `current=test-v1,test-v1=${keyBytes.toString("base64")}`
);

async function createActiveUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: `Memory ${label}`,
      email: `memory-${label}-${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

async function cleanupUser(userId: string): Promise<void> {
  await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
  await prisma.user.deleteMany({ where: { id: userId } });
}

function factValue(
  canonicalKey: string,
  displayText: string,
  structuredValue: string
): MemoryFactValueInput {
  return {
    canonicalKey,
    category: "profile",
    confidence: 1,
    directness: "DIRECT",
    displayText,
    importance: 0.8,
    languageCode: "en",
    modality: "STATE",
    pipelineVersion: "memory-persistence-test-v1",
    secretTaintedSourceWindow: false,
    sensitivityClass: "NORMAL",
    sourceMode: "EXPLICIT",
    structuredValue: { value: structuredValue }
  };
}

function saveInput(
  scopeId: string,
  idempotencyFingerprint: string,
  value: MemoryFactValueInput
): MemoryFactSaveInput {
  return {
    evidence: {
      kind: "EXPLICIT_ACTION",
      observedAt: new Date("2026-08-10T10:00:00.000Z"),
      safeExcerpt: value.displayText,
      safeSourceHash: "a".repeat(64),
      safetyClass: value.sensitivityClass,
      sourceProjectionVersion: "memory-test-projection-v1"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint,
    requestId: `request-${idempotencyFingerprint}`,
    scopeId,
    value
  };
}

function expectRejectedCode(
  result: PromiseSettledResult<unknown>,
  code: MemoryPersistenceError["code"]
): void {
  expect(result.status).toBe("rejected");
  if (result.status !== "rejected") return;
  expect(result.reason).toBeInstanceOf(MemoryPersistenceError);
  expect((result.reason as MemoryPersistenceError).code).toBe(code);
}

describe("Prisma Memory persistence", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("serializes settings CAS and bootstraps one settled lexical generation", async () => {
    const userId = await createActiveUser("settings-cas");
    const repository = createPrismaMemorySettingsRepository(prisma);
    try {
      const results = await Promise.allSettled([
        repository.patch(userId, {
          expectedMemoryRevision: 0,
          expectedSettingsRevision: 0,
          useMemoryFacts: true
        }),
        repository.patch(userId, {
          expectedMemoryRevision: 0,
          expectedSettingsRevision: 0,
          referenceChatHistory: true
        })
      ]);
      const fulfilled = results.filter((result) => result.status === "fulfilled");
      const rejected = results.filter((result) => result.status === "rejected");
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expectRejectedCode(rejected[0]!, "memory_settings_conflict");

      const [settings, generations] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryIndexGeneration.findMany({ where: { userId } })
      ]);
      expect(settings).toMatchObject({
        memoryGeneration: 0,
        memoryRevision: 1,
        settingsRevision: 1
      });
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        id: settings.activeIndexGenerationId,
        indexMode: "LEXICAL_ONLY",
        indexedThroughMemoryRevision: 1,
        state: "ACTIVE",
        targetMemoryRevision: 1
      });
    } finally {
      await cleanupUser(userId);
    }
  });

  it("deduplicates fact retries and permits exactly one edit for an exact version", async () => {
    const userId = await createActiveUser("fact-cas");
    try {
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const repository = createPrismaMemoryFactRepository(suppressionKeyring, prisma);
      const initial = saveInput(
        scope.id,
        "save-favorite-color-v1",
        factValue("profile.favorite_color", "My favorite color is red.", "red")
      );
      const saves = await Promise.all([
        repository.save(userId, initial),
        repository.save(userId, initial)
      ]);
      expect(new Set(saves.map((result) => result.factId))).toHaveLength(1);
      expect(new Set(saves.map((result) => result.versionId))).toHaveLength(1);
      expect(saves.map((result) => result.replayed).sort()).toEqual([false, true]);

      const original = saves[0]!;
      const editBase = {
        evidence: {
          kind: "EXPLICIT_ACTION" as const,
          observedAt: new Date("2026-08-10T10:05:00.000Z"),
          safeSourceHash: "b".repeat(64),
          safetyClass: "NORMAL" as const,
          sourceProjectionVersion: "memory-test-projection-v1"
        },
        expectedVersionId: original.versionId,
        explicitSuppressionOverride: false,
        factId: original.factId,
        scopeId: scope.id
      };
      const edits = await Promise.allSettled([
        repository.edit(userId, {
          ...editBase,
          evidence: { ...editBase.evidence, safeExcerpt: "My favorite color is blue." },
          idempotencyFingerprint: "edit-favorite-color-blue-v1",
          requestId: "request-edit-blue",
          value: factValue(
            "profile.favorite_color",
            "My favorite color is blue.",
            "blue"
          )
        }),
        repository.edit(userId, {
          ...editBase,
          evidence: { ...editBase.evidence, safeExcerpt: "My favorite color is green." },
          idempotencyFingerprint: "edit-favorite-color-green-v1",
          requestId: "request-edit-green",
          value: factValue(
            "profile.favorite_color",
            "My favorite color is green.",
            "green"
          )
        })
      ]);
      const applied = edits.filter((result) => result.status === "fulfilled");
      const stale = edits.filter((result) => result.status === "rejected");
      expect(applied).toHaveLength(1);
      expect(stale).toHaveLength(1);
      expectRejectedCode(stale[0]!, "memory_fact_version_stale");

      const [settings, generations, counts, currentFact, activeSearchEntries] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryIndexGeneration.findMany({ where: { userId } }),
        Promise.all([
          prisma.memoryFact.count({ where: { userId } }),
          prisma.memoryFactVersion.count({ where: { userId } }),
          prisma.memoryEvent.count({ where: { userId } }),
          prisma.memoryEvidence.count({ where: { userId } }),
          prisma.memoryOperationReceipt.count({ where: { userId } })
        ]),
        prisma.memoryFact.findUniqueOrThrow({ where: { id: original.factId } }),
        prisma.memorySearchEntry.findMany({ where: { userId } })
      ]);
      expect(settings).toMatchObject({ memoryGeneration: 0, memoryRevision: 2 });
      expect(generations).toHaveLength(1);
      expect(generations[0]).toMatchObject({
        indexedThroughMemoryRevision: 2,
        targetMemoryRevision: 1
      });
      expect(counts).toEqual([1, 2, 2, 2, 2]);
      expect(activeSearchEntries).toHaveLength(1);
      expect(activeSearchEntries[0]?.factVersionId).toBe(currentFact.currentVersionId);
      expect(currentFact.currentVersionId).toBe(
        applied[0]?.status === "fulfilled" ? applied[0].value.versionId : "unreachable"
      );
    } finally {
      await cleanupUser(userId);
    }
  });

  it("rejects foreign and absent scopes without leaving mutation effects", async () => {
    const ownerUserId = await createActiveUser("scope-owner");
    const foreignUserId = await createActiveUser("scope-foreign");
    try {
      const foreignScope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(foreignUserId);
      const repository = createPrismaMemoryFactRepository(suppressionKeyring, prisma);
      await Promise.all([
        expect(repository.save(ownerUserId, saveInput(
          foreignScope.id,
          "save-foreign-scope-v1",
          factValue("profile.city", "I live in Moscow.", "Moscow")
        ))).rejects.toMatchObject({ code: "memory_scope_unavailable" }),
        expect(repository.save(ownerUserId, saveInput(
          randomUUID(),
          "save-absent-scope-v1",
          factValue("profile.city", "I live in Moscow.", "Moscow")
        ))).rejects.toMatchObject({ code: "memory_scope_unavailable" })
      ]);
      await expect(prisma.userMemorySettings.findUniqueOrThrow({ where: { userId: ownerUserId } }))
        .resolves.toMatchObject({
          activeIndexGenerationId: null,
          memoryGeneration: 0,
          memoryRevision: 0
        });
      await expect(prisma.memoryFact.count({ where: { userId: ownerUserId } })).resolves.toBe(0);
    } finally {
      await cleanupUser(ownerUserId);
      await cleanupUser(foreignUserId);
    }
  });

  it("records suppressions idempotently and requires an allowed explicit override", async () => {
    const userId = await createActiveUser("suppression");
    try {
      const scope = await createPrismaMemoryScopeRepository(prisma).ensureGlobal(userId);
      const suppressions = createPrismaMemorySuppressionRepository(suppressionKeyring, prisma);
      const facts = createPrismaMemoryFactRepository(suppressionKeyring, prisma);
      const blockedInput = {
        canonicalKey: "profile.favorite_color",
        explicitOverrideAllowed: false,
        scope: "FACT" as const,
        suppressionId: randomUUID()
      };
      const first = await suppressions.create(userId, blockedInput);
      const replay = await suppressions.create(userId, blockedInput);
      expect(first).toMatchObject({ created: true, deletionGeneration: 1 });
      expect(replay).toMatchObject({ created: false, id: first.id });

      const blockedSave = saveInput(
        scope.id,
        "save-suppressed-color-v1",
        factValue("profile.favorite_color", "My favorite color is red.", "red")
      );
      await expect(facts.save(userId, blockedSave)).rejects.toMatchObject({
        code: "memory_fact_suppressed"
      });
      await expect(facts.save(userId, {
        ...blockedSave,
        explicitSuppressionOverride: true,
        idempotencyFingerprint: "save-suppressed-color-override-v1",
        requestId: "request-suppressed-color-override"
      })).rejects.toMatchObject({ code: "memory_fact_suppressed" });

      await suppressions.create(userId, {
        canonicalKey: "profile.pet",
        explicitOverrideAllowed: true,
        scope: "FACT",
        suppressionId: randomUUID()
      });
      const allowed = saveInput(
        scope.id,
        "save-suppressed-pet-override-v1",
        factValue("profile.pet", "My pet is named Ada.", "Ada")
      );
      await expect(facts.save(userId, {
        ...allowed,
        explicitSuppressionOverride: true
      })).resolves.toMatchObject({ outcome: "CREATED" });

      const [settings, suppressionCount, factCount] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memorySuppression.count({ where: { userId } }),
        prisma.memoryFact.count({ where: { userId } })
      ]);
      expect(settings).toMatchObject({ memoryGeneration: 2, memoryRevision: 3 });
      expect(suppressionCount).toBe(2);
      expect(factCount).toBe(1);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("deduplicates global jobs and destructive deletion obligations", async () => {
    const userId = await createActiveUser("work-queues");
    try {
      const jobs = createPrismaMemoryJobRepository(prisma);
      const deletion = createPrismaMemoryDeletionRepository(prisma);
      const jobInput = {
        idempotencyFingerprint: "memory-global-dream-test-v1",
        kind: "GLOBAL_DREAM" as const,
        pipelineVersion: "memory-persistence-test-v1"
      };
      const firstJob = await jobs.enqueue(userId, jobInput);
      const replayedJob = await jobs.enqueue(userId, jobInput);
      expect(firstJob).toMatchObject({ created: true, state: "QUEUED" });
      expect(replayedJob).toMatchObject({ created: false, id: firstJob.id });

      const deletionInput = {
        operation: "BULK_CLEAR" as const,
        targetId: "all-reusable-memory",
        targetType: "USER_MEMORY"
      };
      const firstDeletion = await deletion.enqueueDestructive(userId, deletionInput);
      const replayedDeletion = await deletion.enqueueDestructive(userId, deletionInput);
      expect(firstDeletion).toMatchObject({
        created: true,
        memoryGeneration: 1,
        state: "PENDING"
      });
      expect(replayedDeletion).toMatchObject({ created: false, id: firstDeletion.id });

      const [settings, jobCount, deletionCount] = await Promise.all([
        prisma.userMemorySettings.findUniqueOrThrow({ where: { userId } }),
        prisma.memoryJob.count({ where: { userId } }),
        prisma.memoryDeletionOutbox.count({ where: { userId } })
      ]);
      expect(settings).toMatchObject({ memoryGeneration: 1, memoryRevision: 1 });
      expect(jobCount).toBe(1);
      expect(deletionCount).toBe(1);
    } finally {
      await cleanupUser(userId);
    }
  });
});
