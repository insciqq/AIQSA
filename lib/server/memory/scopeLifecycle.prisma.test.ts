import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "../../contracts/memory";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaExplicitMemoryRepository } from "./explicit/repository";
import {
  createPrismaMemoryMutationAuthorizationRepository,
  memoryMutationNonceHash
} from "./persistence/authorizations";
import {
  createPrismaMemoryFactRepository,
  type MemoryFactSaveInput
} from "./persistence/facts";
import { memorySha256 } from "./persistence/lexical";
import { createPrismaMemoryScopeRepository } from "./persistence/scopes";
import { applyMemoryScopeTargetDeletion } from "./scopeLifecycle";
import { MemorySuppressionKeyring } from "./suppressionKeyring";

const keyBytes = Buffer.from(Array.from({ length: 32 }, (_, index) => index + 113));
const keyring = MemorySuppressionKeyring.parse(
  `current=scopes-v1,scopes-v1=${keyBytes.toString("base64")}`
);

async function createUser(): Promise<string> {
  const id = randomUUID();
  await prisma.user.create({
    data: {
      displayName: "Memory dormant scopes",
      email: `memory-dormant-scopes-${id}@example.test`,
      id,
      status: "active"
    }
  });
  return id;
}

function automaticFactInput(
  scopeId: string,
  chatId: string,
  messageId: string,
  label: string
): MemoryFactSaveInput {
  const statement = `Dormant ${label} scoped preference.`;
  return {
    evidence: {
      branchGeneration: 0,
      chatId,
      kind: "MESSAGE",
      messageId,
      observedAt: new Date("2026-08-21T08:00:00.000Z"),
      safeExcerpt: statement,
      safeSourceHash: memorySha256(statement),
      safetyClass: "NORMAL",
      sourceProjectionVersion: "memory-dormant-scope-test-v1",
      sourceRole: "user"
    },
    explicitSuppressionOverride: false,
    idempotencyFingerprint: `dormant-${label}-${randomUUID()}`,
    requestId: `dormant-request-${randomUUID()}`,
    scopeId,
    value: {
      canonicalKey: `legacy.${label.toLowerCase()}.${randomUUID()}`,
      category: "preference",
      confidence: 1,
      directness: "DIRECT",
      displayText: statement,
      importance: 0.8,
      languageCode: "en",
      modality: "PREFERENCE",
      pipelineVersion: "memory-dormant-scope-test-v1",
      secretTaintedSourceWindow: false,
      sensitivityClass: "NORMAL",
      sourceMode: "AUTOMATIC",
      structuredValue: { statement }
    }
  };
}

describe("Memory scoped-target lifecycle", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("preserves legacy Folder, Assistant, and Chat facts while keeping them dormant", async () => {
    const userId = await createUser();
    let assistantId: string | null = null;
    try {
      const folder = await prisma.folder.create({
        data: { name: "Dormant folder", userId }
      });
      const assistant = await prisma.assistantDefinition.create({
        data: { ownerUserId: userId }
      });
      assistantId = assistant.id;
      const chat = await prisma.chat.create({
        data: { folderId: folder.id, title: "Dormant Chat scope", userId }
      });
      const message = await prisma.message.create({
        data: {
          chatId: chat.id,
          content: textMessageContent("Dormant legacy scope evidence."),
          role: "user",
          status: "complete"
        }
      });
      const scopeRepository = createPrismaMemoryScopeRepository(prisma);
      const scopes = await Promise.all([
        scopeRepository.ensure(userId, { targetId: folder.id, type: "FOLDER" }),
        scopeRepository.ensure(userId, { targetId: assistant.id, type: "ASSISTANT" }),
        scopeRepository.ensure(userId, { targetId: chat.id, type: "CHAT" })
      ]);
      const factRepository = createPrismaMemoryFactRepository(keyring, prisma);
      const facts = await Promise.all(scopes.map((scope, index) =>
        factRepository.save(userId, automaticFactInput(
          scope.id,
          chat.id,
          message.id,
          ["folder", "assistant", "chat"][index]!
        ))));

      const readRepository = createPrismaExplicitMemoryRepository(prisma);
      for (const [index, selection] of [
        { targetId: folder.id, type: "FOLDER" as const },
        { targetId: assistant.id, type: "ASSISTANT" as const },
        { targetId: chat.id, type: "CHAT" as const }
      ].entries()) {
        await expect(readRepository.get(userId, facts[index]!.factId)).resolves.toBeNull();
        await expect(readRepository.list(userId, { scope: selection }))
          .resolves.toEqual({ memories: [], nextCursor: null });
        await expect(readRepository.search(userId, {
          query: "dormant scoped preference",
          scope: selection
        })).resolves.toEqual({ memories: [], nextCursor: null });
      }

      const authorizations = createPrismaMemoryMutationAuthorizationRepository(prisma);
      const now = new Date("2026-08-21T08:01:00.000Z");
      for (const fact of facts) {
        const requestId = `legacy-edit-${randomUUID()}`;
        await expect(authorizations.mint(userId, {
          action: "EDIT",
          authorizedPayloadHash: memorySha256({ factId: fact.factId }),
          confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
          expectedTargetVersionId: fact.versionId,
          expiresAt: new Date(now.getTime() + 60_000),
          nonceHash: memoryMutationNonceHash(userId, requestId),
          requestId,
          targetFactId: fact.factId
        }, now)).rejects.toMatchObject({ code: "memory_fact_not_found" });
      }

      await expect(prisma.memoryFact.count({ where: { userId } })).resolves.toBe(3);
      await expect(prisma.memoryFactVersion.count({
        where: { state: "ACTIVE", userId }
      })).resolves.toBe(3);
    } finally {
      if (assistantId) {
        await prisma.$transaction((tx) => applyMemoryScopeTargetDeletion(tx, {
          scopeType: "ASSISTANT",
          targetId: assistantId!,
          userId
        }));
        await prisma.assistantDefinition.deleteMany({ where: { id: assistantId } });
      }
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
