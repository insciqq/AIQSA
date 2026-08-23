import { createHash, randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";
import { DEFAULT_KNOWLEDGE_BUDGET_POLICY } from "./knowledgeBudget";
import {
  createPrismaKnowledgeBudgetReservationRepository,
  settleKnowledgeBudgetReservationReceipt,
  type KnowledgeBudgetOperationRequestInput,
  type ReserveKnowledgeBudgetInput
} from "./knowledgeBudgetReservationRepository";

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function embeddingExecutionSnapshot(input: Readonly<{
  connectionId: string;
  credentialId: string;
  credentialVersionId: string;
  modelId: string;
}>): Prisma.InputJsonValue {
  return json({
    connection: {
      allowPrivateNetwork: false,
      apiRoot: "https://embedding.example.test/v1",
      authenticationMode: "bearer",
      responseTimeoutMs: 30_000
    },
    connectionDisplayName: "Budget test connection",
    connectionId: input.connectionId,
    credentialId: input.credentialId,
    credentialVersionId: input.credentialVersionId,
    model: {
      adapterKind: "openai_embeddings_compatible",
      answerSelectable: false,
      capabilities: {
        contextWindow: 8_192,
        nativePdfInput: false,
        nativeSearch: false,
        pdf: false,
        reasoning: false,
        streaming: false,
        toolCalling: false,
        vision: false
      },
      defaultParams: {},
      embedding: {
        nativeDimension: 1_024,
        providerFamily: "openai_compatible",
        queryInstructionTemplate: null,
        supportsMrl: false,
        targetDimension: 1_024
      },
      modelClass: "embedding",
      upstreamModelId: "budget-embedding"
    },
    modelDisplayName: "Budget embedding model",
    providerFamily: "openai_compatible",
    providerModelId: input.modelId,
    version: 1
  });
}

describe("Knowledge budget reservation PostgreSQL serialization", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("admits only twelve of sixteen concurrent operations at the installation default", async () => {
    const suffix = randomUUID();
    const connectionId = `knowledge-budget-connection-${suffix}`;
    const credentialId = randomUUID();
    const credentialVersionId = randomUUID();
    const modelId = randomUUID();
    const profileId = `knowledge-budget-profile-${suffix}`;
    const profileRevisionId = randomUUID();
    const userId = `knowledge-budget-owner-${suffix}`;
    let chatId: string | null = null;

    try {
      await prisma.providerConnection.create({
        data: { displayName: "Budget test connection", family: "test", id: connectionId }
      });
      await prisma.providerModel.create({
        data: {
          capabilities: {},
          connectionId,
          defaultParams: {},
          displayName: "Budget embedding model",
          id: modelId,
          modelClass: "embedding",
          modelId: `budget-embedding-${suffix}`,
          provider: "test"
        }
      });
      await prisma.providerCredential.create({
        data: { connectionId, enabled: true, id: credentialId, label: "Budget credential" }
      });
      await prisma.providerCredentialVersion.create({
        data: {
          activatedAt: new Date(),
          credentialId,
          id: credentialVersionId,
          testEvidence: { authenticationMode: "none", synthetic: true },
          testedAt: new Date(),
          version: 1
        }
      });
      await prisma.knowledgeIndexProfile.create({ data: { id: profileId } });
      await prisma.knowledgeIndexProfileRevision.create({
        data: {
          activatedAt: new Date(),
          chunkingProfileVersion: 1,
          egressPolicy: {},
          embeddingConfiguration: {},
          embeddingProviderModelId: modelId,
          executionAuthority: "installation",
          id: profileRevisionId,
          preflightCheckedAt: new Date(),
          preflightStatus: "ready",
          profileConfiguration: {},
          profileId,
          revisionNumber: 1,
          targetDimension: 1_024,
          vectorSpaceFingerprint: "d".repeat(64)
        }
      });
      await prisma.user.create({
        data: { displayName: "Budget owner", id: userId, status: "active" }
      });
      const chat = await prisma.chat.create({
        data: { title: "Concurrent budget", userId },
        select: { id: true }
      });
      chatId = chat.id;
      const message = await prisma.message.create({
        data: {
          chatId,
          content: { blocks: [{ text: "Find policy sources", type: "text" }] },
          role: "user"
        },
        select: { id: true }
      });
      const run = await prisma.modelRun.create({
        data: {
          chatId,
          modelId: "budget-answer",
          normalizedRequest: {},
          provider: "test",
          status: "in_progress",
          userId,
          userMessageId: message.id
        },
        select: { id: true }
      });
      await prisma.knowledgeRunScope.create({
        data: {
          budgetPolicy: json(DEFAULT_KNOWLEDGE_BUDGET_POLICY),
          exclusions: [],
          modelRunId: run.id,
          resolvedBaseCount: 0,
          resolvedSourceCount: 0,
          selection: { baseIds: [], mode: "explicit", sourceIds: [], version: 1 }
        }
      });
      await prisma.knowledgeRunProfileBinding.create({
        data: {
          embeddingConnectionId: connectionId,
          embeddingCredentialId: credentialId,
          embeddingCredentialSource: "default",
          embeddingCredentialVersionId: credentialVersionId,
          embeddingExecutionSnapshot: embeddingExecutionSnapshot({
            connectionId,
            credentialId,
            credentialVersionId,
            modelId
          }),
          embeddingProviderModelId: modelId,
          modelRunId: run.id,
          ordinal: 0,
          profileRevisionId,
          targetDimension: 1_024,
          vectorSpaceFingerprint: "d".repeat(64)
        }
      });
      const calls = await Promise.all(Array.from({ length: 16 }, (_, ordinal) =>
        prisma.modelRunToolCall.create({
          data: {
            arguments: { query: `policy ${ordinal}` },
            modelRunId: run.id,
            ordinal,
            providerCallId: `budget-call-${ordinal}-${suffix}`,
            roundIndex: 0,
            startedAt: new Date(),
            state: "running",
            toolName: "discover_sources"
          },
          select: { id: true }
      })));
      const operationRequest: KnowledgeBudgetOperationRequestInput = {
        discovery: {
          cursor: null,
          fields: ["filename", "heading", "source_name", "tag", "title"],
          limit: 40,
          query: "Find policy sources"
        },
        operation: "discover_sources",
        profileRevisionId,
        resolvedSourceIds: [],
        sourceAliases: []
      };
      const originalQuerySha256 = createHash("sha256")
        .update("Find policy sources", "utf8")
        .digest("hex");
      const common = {
        estimate: {
          candidateCount: 1,
          costMicros: 0,
          latencyMs: 10,
          queryEmbeddingCalls: 0,
          retrievedTokens: 1
        },
        operationRequest,
        originalQuerySha256,
        runId: run.id,
        userId
      } as const;
      const inputs: readonly ReserveKnowledgeBudgetInput[] = calls.map((call, ordinal) => ({
        ...common,
        idempotencyKey: `run:${run.id}:budget:${ordinal}`,
        modelRunToolCallId: call.id
      }));
      const repository = createPrismaKnowledgeBudgetReservationRepository(prisma);

      const results = await Promise.all(inputs.map((input) => repository.reserve(input)));

      expect(results.filter((result) => result.kind === "admitted")).toHaveLength(12);
      expect(results.filter((result) =>
        result.kind === "rejected" && result.reason === "operation_budget")).toHaveLength(4);
      await expect(prisma.knowledgeBudgetReservation.count({
        where: { modelRunId: run.id }
      })).resolves.toBe(12);
      const admittedIndex = results.findIndex((result) => result.kind === "admitted");
      await expect(repository.reserve(inputs[admittedIndex]!))
        .resolves.toMatchObject({ kind: "idempotent" });
      await expect(prisma.knowledgeBudgetReservation.count({
        where: { modelRunId: run.id }
      })).resolves.toBe(12);

      const admitted = results.find((result) => result.kind === "admitted");
      if (!admitted || admitted.kind !== "admitted" || admitted.record.purgedAt !== null ||
        !admitted.record.leaseToken) throw new Error("knowledge_budget_test_admission_missing");
      const admittedCall = calls[admittedIndex]!;
      const otherCall = calls.find((_, index) => index !== admittedIndex)!;
      const dispatch = await repository.claimDispatch({
        dispatchAttemptKey: `knowledge-dispatch:${admitted.record.reservation.id}`,
        leaseToken: admitted.record.leaseToken,
        reservationId: admitted.record.reservation.id,
        runId: run.id,
        userId
      });
      expect(dispatch.kind).toBe("transitioned");

      const knowledgeRunData = {
        baseEvidence: json([{ baseName: "Synthetic budget Base", ordinal: 0 }]),
        budgetEvidence: json({}),
        budgetReservationId: admitted.record.reservation.id,
        candidateCount: 0,
        candidateLimit: 1,
        durationMs: 1,
        embeddingUsage: json([]),
        fusion: "none",
        invocationOrdinal: admitted.record.reservation.operationOrdinal,
        modelRunId: run.id,
        operation: "discover_sources",
        outcome: "base_empty" as const,
        providerText: "No admitted Source metadata matched.",
        query: "Find policy sources",
        receiptVersion: 2,
        resultLimit: 1,
        results: json([]),
      };
      await expect(prisma.knowledgeRun.create({
        data: { ...knowledgeRunData, modelRunToolCallId: otherCall.id }
      })).rejects.toThrow();
      await expect(prisma.knowledgeRun.count({
        where: { modelRunId: run.id }
      })).resolves.toBe(0);

      const receiptHash = "e".repeat(64);
      const actual = {
        candidateCount: 0,
        costMicros: 0,
        latencyMs: 3,
        queryEmbeddingCalls: 0,
        retrievedTokens: 0
      } as const;
      await expect(prisma.$transaction(async (tx) => {
        await tx.knowledgeRun.create({
          data: { ...knowledgeRunData, modelRunToolCallId: admittedCall.id }
        });
        await settleKnowledgeBudgetReservationReceipt(tx, {
          actual,
          leaseToken: "wrong-lease-token",
          modelRunToolCallId: admittedCall.id,
          operation: "discover_sources",
          operationOrdinal: admitted.record.reservation.operationOrdinal,
          receiptHash,
          reservationId: admitted.record.reservation.id,
          runId: run.id
        });
      })).rejects.toThrow("knowledge_budget_reservation_not_dispatched");
      await expect(prisma.knowledgeRun.count({
        where: { modelRunId: run.id }
      })).resolves.toBe(0);

      await prisma.$transaction(async (tx) => {
        await tx.knowledgeRun.create({
          data: { ...knowledgeRunData, modelRunToolCallId: admittedCall.id }
        });
        await settleKnowledgeBudgetReservationReceipt(tx, {
          actual,
          leaseToken: admitted.record.leaseToken!,
          modelRunToolCallId: admittedCall.id,
          operation: "discover_sources",
          operationOrdinal: admitted.record.reservation.operationOrdinal,
          receiptHash,
          reservationId: admitted.record.reservation.id,
          runId: run.id
        });
      });
      await expect(prisma.knowledgeRun.findFirst({
        select: { budgetReservationId: true, receiptVersion: true },
        where: { modelRunId: run.id }
      })).resolves.toEqual({
        budgetReservationId: admitted.record.reservation.id,
        receiptVersion: 2
      });
      await expect(prisma.knowledgeBudgetReservation.findUnique({
        select: {
          actualCandidates: true,
          actualLatencyMs: true,
          estimatedCandidates: true,
          receiptHash: true,
          state: true
        },
        where: { id: admitted.record.reservation.id }
      })).resolves.toEqual({
        actualCandidates: 0,
        actualLatencyMs: 3,
        estimatedCandidates: 1,
        receiptHash,
        state: "settled"
      });
    } finally {
      if (chatId) await prisma.chat.deleteMany({ where: { id: chatId, userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      // Profile revisions are database-immutable. The acknowledged disposable
      // database owns final cleanup for that synthetic profile/model graph.
      await prisma.providerCredentialVersion.deleteMany({ where: { id: credentialVersionId } });
      await prisma.providerCredential.deleteMany({ where: { id: credentialId } });
    }
  });
});
