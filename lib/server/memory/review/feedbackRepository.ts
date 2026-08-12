import { randomUUID } from "node:crypto";
import { type PrismaClient } from "@prisma/client";
import type {
  MemoryFeedbackInput,
  MemoryFeedbackMutationResponse
} from "../../../contracts/memory";
import { prisma } from "../../prisma";
import { memoryPersistenceFailure } from "../persistence/errors";
import {
  consumeMemoryMutationAuthorization,
  type MemoryMutationAuthorizationUse
} from "../persistence/authorizations";
import { memorySha256 } from "../persistence/lexical";
import { withLockedMemoryTransaction } from "../persistence/transaction";

function response(input: Readonly<{
  createdAt: Date;
  feedbackId: string;
  feedbackType: MemoryFeedbackInput["feedbackType"];
  retractsFeedbackId: string | null;
  targetVersionId: string;
}>): MemoryFeedbackMutationResponse {
  return {
    createdAt: input.createdAt.toISOString(),
    feedbackId: input.feedbackId,
    feedbackType: input.feedbackType,
    retractedFeedbackId: input.retractsFeedbackId,
    targetVersionId: input.targetVersionId
  };
}

function sameReplay(
  row: Readonly<{
    comment: string | null;
    feedbackType: MemoryFeedbackInput["feedbackType"];
    memoryFactId: string | null;
    memoryFactVersionId: string | null;
    modelRunId: string | null;
    modelRunMemoryItemId: string | null;
    modelRunToolCallId: string | null;
    requestId: string;
    retractsFeedbackId: string | null;
  }>,
  factId: string,
  input: MemoryFeedbackInput
): boolean {
  return row.requestId === input.requestId &&
    row.feedbackType === input.feedbackType &&
    row.memoryFactId === factId &&
    row.memoryFactVersionId === input.expectedVersionId &&
    row.comment === (input.comment ?? null) &&
    row.modelRunId === (input.modelRunId ?? null) &&
    row.modelRunMemoryItemId === (input.modelRunMemoryItemId ?? null) &&
    row.modelRunToolCallId === (input.modelRunToolCallId ?? null) &&
    row.retractsFeedbackId === (input.retractsFeedbackId ?? null);
}

export function memoryFeedbackIdempotencyFingerprint(
  userId: string,
  requestId: string
): string {
  return memorySha256({
    domain: "aiqsa.memory.feedback",
    requestId,
    userId,
    version: "v1"
  });
}

export function createPrismaMemoryFeedbackRepository(
  client: PrismaClient = prisma
) {
  return Object.freeze({
    async record(
      userId: string,
      factId: string,
      input: MemoryFeedbackInput,
      authorization?: MemoryMutationAuthorizationUse & Readonly<{ requestId: string }>
    ): Promise<MemoryFeedbackMutationResponse> {
      if (input.modelRunToolCallId !== undefined && authorization === undefined) {
        return memoryPersistenceFailure("memory_input_invalid");
      }
      const fingerprint = memoryFeedbackIdempotencyFingerprint(userId, input.requestId);
      return withLockedMemoryTransaction(client, userId, async (tx) => {
        const replay = await tx.memoryFeedback.findUnique({
          select: {
            comment: true,
            createdAt: true,
            feedbackType: true,
            id: true,
            memoryFactId: true,
            memoryFactVersionId: true,
            modelRunId: true,
            modelRunMemoryItemId: true,
            modelRunToolCallId: true,
            requestId: true,
            retractsFeedbackId: true
          },
          where: {
            userId_idempotencyFingerprint: {
              idempotencyFingerprint: fingerprint,
              userId
            }
          }
        });
        if (replay) {
          if (!sameReplay(replay, factId, input) || !replay.memoryFactVersionId) {
            return memoryPersistenceFailure("memory_idempotency_conflict");
          }
          return response({
            createdAt: replay.createdAt,
            feedbackId: replay.id,
            feedbackType: replay.feedbackType,
            retractsFeedbackId: replay.retractsFeedbackId,
            targetVersionId: replay.memoryFactVersionId
          });
        }

        const version = await tx.memoryFactVersion.findFirst({
          select: {
            contentPurgedAt: true,
            factId: true,
            id: true,
            sourceMode: true,
            state: true
          },
          where: { factId, id: input.expectedVersionId, userId }
        });
        const fact = await tx.memoryFact.findFirst({
          select: { id: true, state: true },
          where: { id: factId, userId }
        });
        if (!fact || !version) return memoryPersistenceFailure("memory_fact_not_found");
        if (
          version.contentPurgedAt !== null ||
          fact.state === "FORGOTTEN" ||
          version.state === "FORGOTTEN"
        ) {
          return memoryPersistenceFailure("memory_fact_version_stale");
        }
        if (authorization) {
          await consumeMemoryMutationAuthorization(tx, userId, authorization);
        }

        let sourceChatIdSnapshot: string | null = null;
        let sourceBranchGenerationSnapshot: number | null = null;
        if (input.modelRunId && input.modelRunMemoryItemId) {
          const item = await tx.modelRunMemoryItem.findFirst({
            select: {
              bindingId: true,
              sourceBranchGenerationSnapshot: true,
              sourceChatIdSnapshot: true
            },
            where: {
              factVersionId: input.expectedVersionId,
              id: input.modelRunMemoryItemId,
              userId
            }
          });
          const binding = item
            ? await tx.modelRunMemoryBinding.findFirst({
                select: { id: true },
                where: { id: item.bindingId, modelRunId: input.modelRunId, userId }
              })
            : null;
          if (!item || !binding) {
            return memoryPersistenceFailure("memory_input_invalid");
          }
          sourceChatIdSnapshot = item.sourceChatIdSnapshot;
          sourceBranchGenerationSnapshot = item.sourceBranchGenerationSnapshot;
        } else if (input.modelRunId && input.modelRunToolCallId) {
          const toolCall = await tx.modelRunToolCall.findFirst({
            select: { id: true },
            where: {
              id: input.modelRunToolCallId,
              modelRun: { userId },
              modelRunId: input.modelRunId,
              toolName: "mark_memory_incorrect"
            }
          });
          if (!toolCall) return memoryPersistenceFailure("memory_input_invalid");
        } else {
          const evidence = await tx.memoryEvidence.findFirst({
            orderBy: [{ observedAt: "desc" }, { id: "desc" }],
            select: { branchGeneration: true, chatId: true },
            where: { factVersionId: input.expectedVersionId, userId }
          });
          sourceChatIdSnapshot = evidence?.chatId ?? null;
          sourceBranchGenerationSnapshot = evidence?.branchGeneration ?? null;
        }

        if (input.feedbackType === "RETRACT") {
          const target = await tx.memoryFeedback.findFirst({
            select: {
              contentPurgedAt: true,
              feedbackType: true,
              memoryFactId: true,
              memoryFactVersionId: true
            },
            where: { id: input.retractsFeedbackId!, userId }
          });
          if (
            !target || target.contentPurgedAt !== null ||
            target.feedbackType === "RETRACT" ||
            target.memoryFactId !== factId ||
            target.memoryFactVersionId !== input.expectedVersionId
          ) {
            return memoryPersistenceFailure("memory_input_invalid");
          }
          const alreadyRetracted = await tx.memoryFeedback.findFirst({
            select: { id: true },
            where: {
              contentPurgedAt: null,
              feedbackType: "RETRACT",
              retractsFeedbackId: input.retractsFeedbackId,
              userId
            }
          });
          if (alreadyRetracted) return memoryPersistenceFailure("memory_idempotency_conflict");
        }

        const createdAt = new Date();
        const eventId = randomUUID();
        const feedbackId = randomUUID();
        await tx.memoryEvent.create({
          data: {
            actorType: "USER",
            actorUserId: userId,
            factId,
            factVersionId: input.expectedVersionId,
            id: eventId,
            metadata: {
              feedbackId,
              feedbackType: input.feedbackType,
              schemaVersion: "memory-feedback-event-v1"
            },
            operation: "USER_FEEDBACK",
            userId
          }
        });
        await tx.memoryFeedback.create({
          data: {
            comment: input.comment,
            createdAt,
            feedbackType: input.feedbackType,
            id: feedbackId,
            idempotencyFingerprint: fingerprint,
            memoryEventId: eventId,
            memoryFactId: factId,
            memoryFactVersionId: input.expectedVersionId,
            modelRunId: input.modelRunId,
            modelRunMemoryItemId: input.modelRunMemoryItemId,
            modelRunToolCallId: input.modelRunToolCallId,
            requestId: input.requestId,
            retractsFeedbackId: input.retractsFeedbackId,
            sourceChatIdSnapshot,
            sourceBranchGenerationSnapshot,
            targetKind: "FACT_VERSION",
            userId
          }
        });
        return response({
          createdAt,
          feedbackId,
          feedbackType: input.feedbackType,
          retractsFeedbackId: input.retractsFeedbackId ?? null,
          targetVersionId: input.expectedVersionId
        });
      });
    }
  });
}
