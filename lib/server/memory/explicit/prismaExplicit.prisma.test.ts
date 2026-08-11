import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryCreateInput
} from "../../../contracts/memory";
import { prisma } from "../../prisma";
import { createPrismaMemoryMutationAuthorizationRepository } from "../persistence/authorizations";
import { createPrismaMemoryFactRepository } from "../persistence/facts";
import { memorySha256 } from "../persistence/lexical";
import { createPrismaMemoryScopeRepository } from "../persistence/scopes";
import { MemorySuppressionKeyring } from "../suppressionKeyring";
import { createPrismaExplicitMemoryRepository } from "./repository";
import {
  createExplicitMemoryService,
  ExplicitMemoryServiceError
} from "./service";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 33));
const keyring = MemorySuppressionKeyring.parse(
  `current=explicit-v1,explicit-v1=${keyBytes.toString("base64")}`
);

async function createActiveUser(label: string): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: `Explicit ${label}`,
      email: `explicit-${label}-${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

async function cleanupUser(userId: string): Promise<void> {
  await prisma.user.deleteMany({ where: { id: userId } });
}

function service(clock?: () => Date) {
  return createExplicitMemoryService({
    authorizationRepository: createPrismaMemoryMutationAuthorizationRepository(prisma),
    clock,
    factRepository: createPrismaMemoryFactRepository(keyring, prisma),
    readRepository: createPrismaExplicitMemoryRepository(prisma),
    scopeRepository: createPrismaMemoryScopeRepository(prisma)
  });
}

async function saveAuthorization(
  memoryService: ReturnType<typeof service>,
  userId: string,
  statement: string,
  nonce: string = randomUUID()
) {
  return memoryService.mintAuthorization(userId, {
    action: "SAVE",
    confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
    exactStatementHash: memorySha256(statement),
    requestNonce: nonce
  });
}

async function createMemory(
  memoryService: ReturnType<typeof service>,
  userId: string,
  statement: string,
  nonce: string = randomUUID(),
  overrides: Partial<MemoryCreateInput> = {}
) {
  const authorization = await saveAuthorization(
    memoryService,
    userId,
    statement,
    nonce
  );
  const input: MemoryCreateInput = {
    category: "preference",
    modality: "PREFERENCE",
    mutationAuthorizationId: authorization.mutationAuthorizationId,
    scope: { type: "GLOBAL_USER" },
    statement,
    validFrom: null,
    validTo: null,
    ...overrides
  };
  return {
    authorization,
    input,
    response: await memoryService.create(userId, input)
  };
}

describe("Prisma explicit Memory API", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("commits exact Russian text and all lexical profiles without worker or provider", async () => {
    const userId = await createActiveUser("lexical");
    const memoryService = service();
    const russian = "  Я предпочитаю ответы о ёлках на русском языке.  ";
    try {
      const initialSettings = await prisma.userMemorySettings.findUniqueOrThrow({
        where: { userId }
      });
      expect(initialSettings).toMatchObject({
        learnAutomatically: false,
        referenceChatHistory: true,
        useMemoryFacts: true
      });

      const pendingAuthorization = await saveAuthorization(
        memoryService,
        userId,
        russian,
        "nonce-russian"
      );
      const repeatedAuthorization = await saveAuthorization(
        memoryService,
        userId,
        russian,
        "nonce-russian"
      );
      expect(repeatedAuthorization).toEqual(pendingAuthorization);
      const created = await createMemory(memoryService, userId, russian, "nonce-russian");
      expect(created.authorization).toEqual(pendingAuthorization);
      expect(created.response.memory).toMatchObject({
        displayText: russian,
        indexingState: "LEXICAL_READY",
        sourceMode: "EXPLICIT"
      });
      const factId = created.response.memory.id;
      const versionId = created.response.memory.currentVersionId!;
      await expect(memoryService.search(userId, {
        query: "русский",
        scope: { type: "GLOBAL_USER" }
      })).resolves.toMatchObject({ memories: [{ id: factId }] });
      await expect(memoryService.search(userId, {
        query: "елках",
        scope: { type: "GLOBAL_USER" }
      })).resolves.toMatchObject({ memories: [{ id: factId }] });

      const [searchShape] = await prisma.$queryRaw<Array<{
        englishReady: boolean;
        russianReady: boolean;
        simpleReady: boolean;
      }>>`
        SELECT
          "searchVectorEnglish" IS NOT NULL AS "englishReady",
          "searchVectorRussian" IS NOT NULL AS "russianReady",
          "searchVectorSimple" IS NOT NULL AS "simpleReady"
        FROM "MemorySearchEntry"
        WHERE "userId" = ${userId} AND "factVersionId" = ${versionId}
      `;
      expect(searchShape).toEqual({
        englishReady: true,
        russianReady: true,
        simpleReady: true
      });
      await expect(prisma.memoryExecutionBinding.count({ where: { userId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryJob.findMany({
        select: { kind: true, state: true },
        where: { userId }
      })).resolves.toEqual([{
        kind: "RECALCULATE_WORKING_SET",
        state: "QUEUED"
      }]);

      const replay = await memoryService.create(userId, created.input);
      expect(replay.memory).toMatchObject({ id: factId, currentVersionId: versionId });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(1);
      await expect(prisma.memoryFactVersion.count({ where: { userId } })).resolves.toBe(1);
      await expect(memoryService.create(userId, {
        ...created.input,
        category: "changed"
      })).rejects.toEqual(
        new ExplicitMemoryServiceError("memory_intent_confirmation_required")
      );

      const second = await createMemory(
        memoryService,
        userId,
        "For work travel, I prefer hotels in quiet cities.",
        "nonce-english"
      );
      await expect(memoryService.search(userId, {
        query: "city",
        scope: { type: "GLOBAL_USER" }
      })).resolves.toMatchObject({ memories: [{ id: second.response.memory.id }] });
      const firstPage = await memoryService.list(userId, {
        pageSize: 1,
        scope: { type: "GLOBAL_USER" },
        sourceMode: "EXPLICIT"
      });
      expect(firstPage.memories).toHaveLength(1);
      expect(firstPage.nextCursor).not.toBeNull();
      await expect(memoryService.list(userId, {
        cursor: firstPage.nextCursor,
        pageSize: 1,
        scope: { type: "GLOBAL_USER" }
      })).rejects.toEqual(new ExplicitMemoryServiceError("memory_contract_invalid"));
      const secondPage = await memoryService.list(userId, {
        cursor: firstPage.nextCursor,
        pageSize: 1,
        scope: { type: "GLOBAL_USER" },
        sourceMode: "EXPLICIT"
      });
      expect(new Set([
        firstPage.memories[0]?.id,
        secondPage.memories[0]?.id
      ])).toEqual(new Set([factId, second.response.memory.id]));

      const evidence = await memoryService.evidence(userId, factId, null);
      expect(evidence).toMatchObject({
        evidence: [{
          factVersionId: versionId,
          safeExcerpt: russian,
          sourceChatId: null,
          sourceMessageId: null,
          sourceRole: null,
          sourceType: "EXPLICIT_ACTION"
        }],
        nextCursor: null
      });

      const secret = "API key: sk-abcdefghijklmnopqrstuvwxyz123456";
      const secretAuthorization = await saveAuthorization(
        memoryService,
        userId,
        secret,
        "nonce-secret"
      );
      await expect(memoryService.create(userId, {
        mutationAuthorizationId: secretAuthorization.mutationAuthorizationId,
        scope: { type: "GLOBAL_USER" },
        statement: secret
      })).rejects.toEqual(new ExplicitMemoryServiceError("memory_secret_rejected"));
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: secretAuthorization.mutationAuthorizationId }
      })).resolves.toMatchObject({ consumedAt: null });
      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(2);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("appends edits, fences stale concurrent versions, and keeps one current lexical entry", async () => {
    const userId = await createActiveUser("edit-cas");
    const memoryService = service();
    try {
      const created = await createMemory(
        memoryService,
        userId,
        "My preferred editor is Emacs.",
        "nonce-editor"
      );
      const factId = created.response.memory.id;
      const originalVersionId = created.response.memory.currentVersionId!;
      const editAuthorization = await memoryService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: originalVersionId,
        requestNonce: "nonce-edit-neovim",
        targetFactId: factId
      });
      const editInput = {
        expectedVersionId: originalVersionId,
        mutationAuthorizationId: editAuthorization.mutationAuthorizationId,
        pinned: true,
        statement: "My preferred editor is Neovim."
      } as const;
      const edited = await memoryService.update(userId, factId, editInput);
      expect(edited.memory).toMatchObject({
        displayText: "My preferred editor is Neovim.",
        pinned: true
      });
      const editedVersionId = edited.memory.currentVersionId!;
      const versions = await prisma.memoryFactVersion.findMany({
        orderBy: { systemFrom: "asc" },
        where: { factId, userId }
      });
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({
        id: originalVersionId,
        state: "SUPERSEDED"
      });
      expect(versions[0]?.systemTo).not.toBeNull();
      expect(versions[1]).toMatchObject({ id: editedVersionId, state: "ACTIVE" });
      await expect(memoryService.update(userId, factId, editInput)).resolves.toEqual(edited);
      await expect(prisma.memoryFactVersion.count({ where: { factId, userId } }))
        .resolves.toBe(2);
      await expect(memoryService.update(userId, factId, {
        ...editInput,
        statement: "A changed replay must not apply."
      })).rejects.toEqual(
        new ExplicitMemoryServiceError("memory_intent_confirmation_required")
      );
      await expect(prisma.memoryFactVersion.count({ where: { factId, userId } }))
        .resolves.toBe(2);
      await expect(memoryService.search(userId, { query: "Emacs" }))
        .resolves.toMatchObject({ memories: [] });
      await expect(memoryService.search(userId, { query: "Neovim" }))
        .resolves.toMatchObject({ memories: [{ id: factId }] });
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(1);

      await expect(memoryService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: originalVersionId,
        requestNonce: "nonce-stale-edit",
        targetFactId: factId
      })).rejects.toEqual(new ExplicitMemoryServiceError("memory_version_stale"));

      const authorizationA = await memoryService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: editedVersionId,
        requestNonce: "nonce-edit-a",
        targetFactId: factId
      });
      const authorizationB = await memoryService.mintAuthorization(userId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: editedVersionId,
        requestNonce: "nonce-edit-b",
        targetFactId: factId
      });
      const concurrent = await Promise.allSettled([
        memoryService.update(userId, factId, {
          expectedVersionId: editedVersionId,
          mutationAuthorizationId: authorizationA.mutationAuthorizationId,
          statement: "My preferred editor is Helix."
        }),
        memoryService.update(userId, factId, {
          expectedVersionId: editedVersionId,
          mutationAuthorizationId: authorizationB.mutationAuthorizationId,
          statement: "My preferred editor is Zed."
        })
      ]);
      expect(concurrent.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejected = concurrent.find((result) => result.status === "rejected");
      expect(rejected?.status === "rejected" ? rejected.reason : null).toEqual(
        new ExplicitMemoryServiceError("memory_version_stale")
      );
      await expect(prisma.memoryFactVersion.count({ where: { factId, userId } }))
        .resolves.toBe(3);
      await expect(prisma.memoryFactVersion.count({
        where: { factId, state: "ACTIVE", userId }
      })).resolves.toBe(1);
      await expect(prisma.memorySearchEntry.count({ where: { userId } }))
        .resolves.toBe(1);
      const evidence = await memoryService.evidence(userId, factId, null);
      expect(evidence.evidence).toHaveLength(3);
    } finally {
      await cleanupUser(userId);
    }
  });

  it("keeps foreign targets indistinguishable and rejects expired grants without rows", async () => {
    const ownerUserId = await createActiveUser("owner");
    const foreignUserId = await createActiveUser("foreign");
    const currentService = service();
    try {
      const created = await createMemory(
        currentService,
        ownerUserId,
        "I prefer concise status reports.",
        "nonce-owner"
      );
      const factId = created.response.memory.id;
      const versionId = created.response.memory.currentVersionId!;
      await expect(currentService.get(foreignUserId, factId)).rejects.toEqual(
        new ExplicitMemoryServiceError("memory_not_found")
      );
      await expect(currentService.mintAuthorization(foreignUserId, {
        action: "EDIT",
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        expectedTargetVersionId: versionId,
        requestNonce: "nonce-foreign-target",
        targetFactId: factId
      })).rejects.toEqual(new ExplicitMemoryServiceError("memory_not_found"));
      await expect(currentService.search(foreignUserId, { query: "concise" }))
        .resolves.toEqual({ memories: [], nextCursor: null });

      const past = new Date(Date.now() - 10 * 60 * 1_000);
      const expiredService = service(() => past);
      const expiredStatement = "I prefer expired grants to fail closed.";
      const expiredAuthorization = await saveAuthorization(
        expiredService,
        foreignUserId,
        expiredStatement,
        "nonce-expired"
      );
      await expect(expiredService.create(foreignUserId, {
        mutationAuthorizationId: expiredAuthorization.mutationAuthorizationId,
        scope: { type: "GLOBAL_USER" },
        statement: expiredStatement
      })).rejects.toEqual(
        new ExplicitMemoryServiceError("memory_intent_confirmation_required")
      );
      await expect(prisma.memoryFact.count({ where: { userId: ownerUserId } }))
        .resolves.toBe(1);
      await expect(prisma.memoryFact.count({ where: { userId: foreignUserId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryScope.count({ where: { userId: foreignUserId } }))
        .resolves.toBe(0);
      await expect(prisma.memoryMutationAuthorization.findUniqueOrThrow({
        where: { id: expiredAuthorization.mutationAuthorizationId }
      })).resolves.toMatchObject({ consumedAt: null });
    } finally {
      await cleanupUser(ownerUserId);
      await cleanupUser(foreignUserId);
    }
  });
});
