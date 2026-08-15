import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryMutationAuthorizationInput
} from "../../../contracts/memory";
import { textFromContentBlocks } from "../../../domain/modelRunEvents";
import { prisma } from "../../prisma";
import { memoryPersistenceFailure } from "./errors";
import { memorySha256 } from "./lexical";
import {
  type MemoryTransaction,
  withLockedMemoryTransaction
} from "./transaction";

export const MEMORY_MUTATION_AUTHORIZATION_TTL_MS = 5 * 60 * 1_000;

type MemoryMutationAction = MemoryMutationAuthorizationInput["action"];

export type MemoryMutationAuthorizationUse = Readonly<{
  action: MemoryMutationAction;
  authorizationId: string;
  authorizedPayloadHash: string;
  expectedTargetVersionId?: string | null;
  targetFactId?: string | null;
}>;

export type MemoryMutationAuthorizationMint = Readonly<{
  action: MemoryMutationAction;
  authorizedPayloadHash: string;
  confirmationCopyVersion: typeof MEMORY_CONFIRMATION_COPY_VERSION;
  expectedTargetVersionId?: string | null;
  expiresAt: Date;
  exactSourceEnd?: number | null;
  exactSourceStart?: number | null;
  modelRunId?: string | null;
  nonceHash: string;
  persistedToolCallId?: string | null;
  requestId: string;
  sourceChatId?: string | null;
  sourceMessageId?: string | null;
  targetFactId?: string | null;
}>;

export type MemoryMutationAuthorizationSnapshot = Readonly<{
  action: MemoryMutationAction;
  authorizedPayloadHash: string;
  confirmationCopyVersion: string;
  consumedAt: Date | null;
  createdAt: Date;
  expectedTargetVersionId: string | null;
  expiresAt: Date;
  exactSourceEnd: number | null;
  exactSourceStart: number | null;
  id: string;
  modelRunId: string | null;
  nonceHash: string;
  persistedToolCallId: string | null;
  requestId: string;
  sourceChatId: string | null;
  sourceMessageId: string | null;
  targetFactId: string | null;
}>;

export type MemoryMutationToolAuthorizationMint = Readonly<{
  action: MemoryMutationAction;
  authorizedPayloadHash: string;
  chatId: string;
  expectedTargetVersionId?: string | null;
  modelRunId: string;
  persistedToolCallId: string;
  sourceText: string;
  targetFactId?: string | null;
  toolName: string;
}>;

const authorizationSelect = {
  action: true,
  authorizedPayloadHash: true,
  confirmationCopyVersion: true,
  consumedAt: true,
  createdAt: true,
  expectedTargetVersionId: true,
  expiresAt: true,
  exactSourceEnd: true,
  exactSourceStart: true,
  id: true,
  modelRunId: true,
  nonceHash: true,
  persistedToolCallId: true,
  requestId: true,
  sourceChatId: true,
  sourceMessageId: true,
  targetFactId: true
} satisfies Prisma.MemoryMutationAuthorizationSelect;

function bounded(value: string, maxLength: number): boolean {
  return value.trim() === value && value.length > 0 && value.length <= maxLength &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function targetAction(action: MemoryMutationAction): boolean {
  return action === "EDIT" || action === "FORGET" || action === "MOVE_SCOPE";
}

function validTargetShape(input: Readonly<{
  action: MemoryMutationAction;
  expectedTargetVersionId?: string | null;
  targetFactId?: string | null;
}>): boolean {
  const hasTarget = input.targetFactId != null || input.expectedTargetVersionId != null;
  return targetAction(input.action)
    ? input.targetFactId != null && input.expectedTargetVersionId != null
    : !hasTarget;
}

function validateMint(input: MemoryMutationAuthorizationMint, now: Date): void {
  const provenanceValues = [
    input.modelRunId,
    input.sourceChatId,
    input.sourceMessageId,
    input.exactSourceStart,
    input.exactSourceEnd
  ];
  const hasProvenance = provenanceValues.some((value) => value !== undefined && value !== null);
  const validProvenance = !hasProvenance || (
    typeof input.modelRunId === "string" && bounded(input.modelRunId, 256) &&
    typeof input.sourceChatId === "string" && bounded(input.sourceChatId, 256) &&
    typeof input.sourceMessageId === "string" && bounded(input.sourceMessageId, 256) &&
    Number.isSafeInteger(input.exactSourceStart) && input.exactSourceStart! >= 0 &&
    Number.isSafeInteger(input.exactSourceEnd) && input.exactSourceEnd! > input.exactSourceStart!
  );
  if (
    !bounded(input.authorizedPayloadHash, 128) ||
    input.confirmationCopyVersion !== MEMORY_CONFIRMATION_COPY_VERSION ||
    !bounded(input.nonceHash, 128) ||
    !bounded(input.requestId, 256) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt <= now ||
    input.expiresAt.getTime() - now.getTime() > MEMORY_MUTATION_AUTHORIZATION_TTL_MS ||
    !validTargetShape(input) ||
    !validProvenance ||
    (input.persistedToolCallId != null && !bounded(input.persistedToolCallId, 256)) ||
    (input.targetFactId != null && !bounded(input.targetFactId, 256)) ||
    (input.expectedTargetVersionId != null &&
      !bounded(input.expectedTargetVersionId, 256))
  ) {
    return memoryPersistenceFailure("memory_input_invalid");
  }
}

function matchesUse(
  row: MemoryMutationAuthorizationSnapshot,
  input: MemoryMutationAuthorizationUse,
  requestId?: string
): boolean {
  return row.action === input.action &&
    row.authorizedPayloadHash === input.authorizedPayloadHash &&
    row.confirmationCopyVersion === MEMORY_CONFIRMATION_COPY_VERSION &&
    row.targetFactId === (input.targetFactId ?? null) &&
    row.expectedTargetVersionId === (input.expectedTargetVersionId ?? null) &&
    (requestId === undefined || row.requestId === requestId);
}

async function requireCurrentTarget(
  tx: MemoryTransaction,
  userId: string,
  input: MemoryMutationAuthorizationMint
): Promise<void> {
  if (!targetAction(input.action)) return;
  const fact = await tx.memoryFact.findFirst({
    select: { currentVersionId: true, state: true },
    where: { id: input.targetFactId!, userId }
  });
  if (!fact) return memoryPersistenceFailure("memory_fact_not_found");
  if (fact.state === "ACTIVE" && fact.currentVersionId === input.expectedTargetVersionId) {
    return;
  }
  if ((input.action === "EDIT" || input.action === "FORGET") &&
    fact.state === "CONFLICTED") {
    const claim = await tx.memoryFactVersion.findFirst({
      select: { id: true },
      where: {
        factId: input.targetFactId!,
        id: input.expectedTargetVersionId!,
        state: "CONFLICTING",
        userId
      }
    });
    if (claim) return;
  }
  if (input.action !== "EDIT" && fact.state === "ORPHANED") {
    const latest = await tx.memoryFactVersion.findFirst({
      orderBy: [{ systemFrom: "desc" }, { id: "desc" }],
      select: { id: true },
      where: {
        factId: input.targetFactId!,
        sourceMode: "EXPLICIT",
        state: "ORPHANED",
        userId
      }
    });
    if (latest?.id === input.expectedTargetVersionId) return;
  }
  return memoryPersistenceFailure("memory_fact_version_stale");
}

export function memoryMutationNonceHash(userId: string, requestNonce: string): string {
  return memorySha256({
    domain: "aiqsa.memory.mutation-authorization.nonce",
    requestNonce,
    userId,
    version: "v1"
  });
}

export function memoryTargetAuthorizationPayloadHash(input: Readonly<{
  action: Exclude<MemoryMutationAction, "SAVE">;
  expectedMemoryRevision?: number;
  expectedSettingsRevision?: number;
  expectedTargetVersionId?: string;
  operation?: string;
  targetFactId?: string;
}>): string {
  return memorySha256({
    action: input.action,
    domain: "aiqsa.memory.mutation-authorization.payload",
    expectedMemoryRevision: input.expectedMemoryRevision ?? null,
    expectedSettingsRevision: input.expectedSettingsRevision ?? null,
    expectedTargetVersionId: input.expectedTargetVersionId ?? null,
    operation: input.operation ?? null,
    targetFactId: input.targetFactId ?? null,
    version: "v1"
  });
}

export async function consumeMemoryMutationAuthorization(
  tx: MemoryTransaction,
  userId: string,
  input: MemoryMutationAuthorizationUse & Readonly<{ requestId: string }>,
  now = new Date()
): Promise<void> {
  const row = await tx.memoryMutationAuthorization.findFirst({
    select: authorizationSelect,
    where: { id: input.authorizationId, userId }
  });
  if (
    !row ||
    !matchesUse(row, input, input.requestId) ||
    row.consumedAt !== null ||
    row.expiresAt <= now
  ) {
    return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  }
  // Wall clocks can move backwards between mint and consume. Keep the durable
  // timestamp monotonic with the authorization row while retaining the caller's
  // clock for the expiry decision above.
  const consumedAt = now < row.createdAt ? row.createdAt : now;
  const consumed = await tx.memoryMutationAuthorization.updateMany({
    data: { consumedAt },
    where: {
      consumedAt: null,
      expiresAt: { gt: now },
      id: input.authorizationId,
      userId
    }
  });
  if (consumed.count !== 1) {
    return memoryPersistenceFailure("memory_mutation_authorization_invalid");
  }
}

export function createPrismaMemoryMutationAuthorizationRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async mint(
      userId: string,
      input: MemoryMutationAuthorizationMint,
      now = new Date()
    ): Promise<MemoryMutationAuthorizationSnapshot> {
      validateMint(input, now);
      return withLockedMemoryTransaction(client, userId, async (tx) => {
        await requireCurrentTarget(tx, userId, input);
        const existing = await tx.memoryMutationAuthorization.findUnique({
          select: authorizationSelect,
          where: {
            userId_nonceHash: { nonceHash: input.nonceHash, userId }
          }
        });
        if (existing) {
          if (
            !matchesUse(existing, {
              action: input.action,
              authorizationId: existing.id,
              authorizedPayloadHash: input.authorizedPayloadHash,
              expectedTargetVersionId: input.expectedTargetVersionId,
              targetFactId: input.targetFactId
            }) ||
            existing.consumedAt !== null ||
            existing.expiresAt <= now
          ) {
            return memoryPersistenceFailure("memory_mutation_authorization_invalid");
          }
          return existing;
        }
        return tx.memoryMutationAuthorization.create({
          data: {
            action: input.action,
            authorizedPayloadHash: input.authorizedPayloadHash,
            confirmationCopyVersion: input.confirmationCopyVersion,
            createdAt: now,
            expectedTargetVersionId: input.expectedTargetVersionId,
            expiresAt: input.expiresAt,
            exactSourceEnd: input.exactSourceEnd,
            exactSourceStart: input.exactSourceStart,
            id: randomUUID(),
            modelRunId: input.modelRunId,
            nonceHash: input.nonceHash,
            persistedToolCallId: input.persistedToolCallId,
            requestId: input.requestId,
            sourceChatId: input.sourceChatId,
            sourceMessageId: input.sourceMessageId,
            targetFactId: input.targetFactId,
            userId
          },
          select: authorizationSelect
        });
      });
    },

    async resolveForUse(
      userId: string,
      input: MemoryMutationAuthorizationUse
    ): Promise<Readonly<{ confirmedAt: Date; requestId: string }>> {
      const row = await client.memoryMutationAuthorization.findFirst({
        select: authorizationSelect,
        where: { id: input.authorizationId, userId }
      });
      if (
        !row ||
        !matchesUse(row, input) ||
        (row.consumedAt === null && row.expiresAt <= new Date())
      ) {
        return memoryPersistenceFailure("memory_mutation_authorization_invalid");
      }
      return { confirmedAt: row.createdAt, requestId: row.requestId };
    },

    async mintForTool(
      userId: string,
      input: MemoryMutationToolAuthorizationMint,
      now = new Date()
    ): Promise<MemoryMutationAuthorizationSnapshot> {
      if (
        !bounded(userId, 256) || !bounded(input.chatId, 256) ||
        !bounded(input.modelRunId, 256) || !bounded(input.persistedToolCallId, 256) ||
        !bounded(input.toolName, 128) || !input.sourceText ||
        input.sourceText.length > 2_000 || input.sourceText.includes("\u0000")
      ) return memoryPersistenceFailure("memory_input_invalid");
      const run = await client.modelRun.findFirst({
        select: {
          chatId: true,
          userMessageId: true,
          userMessage: { select: { content: true, role: true } }
        },
        where: {
          chatId: input.chatId,
          id: input.modelRunId,
          toolCalls: {
            some: { id: input.persistedToolCallId, toolName: input.toolName }
          },
          userId
        }
      });
      const stored = run?.userMessage.content;
      const blocks = stored && typeof stored === "object" && !Array.isArray(stored) &&
        Array.isArray((stored as { blocks?: unknown }).blocks)
        ? (stored as { blocks: unknown[] }).blocks
        : null;
      const exactText = blocks ? textFromContentBlocks({ blocks }) : null;
      if (
        !run || run.chatId !== input.chatId || run.userMessage.role !== "user" ||
        exactText === null || exactText !== input.sourceText
      ) return memoryPersistenceFailure("memory_mutation_authorization_invalid");
      return createPrismaMemoryMutationAuthorizationRepository(client).mint(userId, {
        action: input.action,
        authorizedPayloadHash: input.authorizedPayloadHash,
        confirmationCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION,
        exactSourceEnd: exactText.length,
        exactSourceStart: 0,
        expectedTargetVersionId: input.expectedTargetVersionId,
        expiresAt: new Date(now.getTime() + MEMORY_MUTATION_AUTHORIZATION_TTL_MS),
        modelRunId: input.modelRunId,
        nonceHash: memoryMutationNonceHash(
          userId,
          `tool:${input.modelRunId}:${input.persistedToolCallId}:${input.action}`
        ),
        persistedToolCallId: input.persistedToolCallId,
        requestId: randomUUID(),
        sourceChatId: input.chatId,
        sourceMessageId: run.userMessageId,
        targetFactId: input.targetFactId
      }, now);
    }
  });
}
