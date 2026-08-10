import { randomUUID } from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  MEMORY_CONFIRMATION_COPY_VERSION,
  type MemoryMutationAuthorizationInput
} from "../../../contracts/memory";
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
  nonceHash: string;
  requestId: string;
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
  id: string;
  nonceHash: string;
  requestId: string;
  targetFactId: string | null;
}>;

const authorizationSelect = {
  action: true,
  authorizedPayloadHash: true,
  confirmationCopyVersion: true,
  consumedAt: true,
  createdAt: true,
  expectedTargetVersionId: true,
  expiresAt: true,
  id: true,
  nonceHash: true,
  requestId: true,
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
  if (
    !bounded(input.authorizedPayloadHash, 128) ||
    input.confirmationCopyVersion !== MEMORY_CONFIRMATION_COPY_VERSION ||
    !bounded(input.nonceHash, 128) ||
    !bounded(input.requestId, 256) ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt <= now ||
    input.expiresAt.getTime() - now.getTime() > MEMORY_MUTATION_AUTHORIZATION_TTL_MS ||
    !validTargetShape(input) ||
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
  if (
    fact.state !== "ACTIVE" ||
    fact.currentVersionId !== input.expectedTargetVersionId
  ) {
    return memoryPersistenceFailure("memory_fact_version_stale");
  }
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
  expectedTargetVersionId?: string;
  operation?: string;
  targetFactId?: string;
}>): string {
  return memorySha256({
    action: input.action,
    domain: "aiqsa.memory.mutation-authorization.payload",
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
  const consumed = await tx.memoryMutationAuthorization.updateMany({
    data: { consumedAt: now },
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
            id: randomUUID(),
            nonceHash: input.nonceHash,
            requestId: input.requestId,
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
    }
  });
}
