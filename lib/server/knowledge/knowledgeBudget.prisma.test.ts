import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { prisma } from "../prisma";

describe("Knowledge operation ordinal structural ceiling", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("accepts representative persisted ordinals through 256 but rejects 257", async () => {
    const suffix = randomUUID();
    const userId = `knowledge-ordinal-owner-${suffix}`;
    await prisma.user.create({
      data: { displayName: "Knowledge ordinal owner", id: userId, status: "active" }
    });
    const chat = await prisma.chat.create({
      data: { title: "Knowledge ordinal boundary", userId },
      select: { id: true }
    });
    const message = await prisma.message.create({
      data: {
        chatId: chat.id,
        content: { blocks: [{ text: "ordinal boundary", type: "text" }] },
        role: "user"
      },
      select: { id: true }
    });
    const run = await prisma.modelRun.create({
      data: {
        chatId: chat.id,
        modelId: "knowledge-ordinal-test",
        normalizedRequest: {},
        provider: "test",
        status: "complete",
        userId,
        userMessageId: message.id
      },
      select: { id: true }
    });

    try {
      const acceptedOrdinals = [4, 8, 14, 15, 256] as const;
      for (const [toolOrdinal, invocationOrdinal] of acceptedOrdinals.entries()) {
        const call = await prisma.modelRunToolCall.create({
          data: {
            arguments: { query: "ordinal boundary" },
            completedAt: new Date(),
            modelRunId: run.id,
            ordinal: toolOrdinal,
            providerCallId: `knowledge-ordinal-${invocationOrdinal}-${suffix}`,
            result: {},
            roundIndex: 0,
            startedAt: new Date(),
            state: "complete",
            toolName: "retrieve_knowledge"
          },
          select: { id: true }
        });
        await expect(prisma.knowledgeRun.create({
          data: {
            baseEvidence: [{}],
            candidateCount: 0,
            candidateLimit: 1,
            durationMs: 0,
            embeddingUsage: [],
            fusion: "rrf_k60",
            invocationOrdinal,
            modelRunId: run.id,
            modelRunToolCallId: call.id,
            operation: "automatic_search",
            outcome: "base_empty",
            providerText: "Knowledge retrieval returned no indexed passages.",
            query: "ordinal boundary",
            resultLimit: 1,
            results: [],
            threshold: 0
          },
          select: { invocationOrdinal: true }
        })).resolves.toEqual({ invocationOrdinal });
      }

      const rejectedCall = await prisma.modelRunToolCall.create({
        data: {
          arguments: { query: "ordinal boundary" },
          completedAt: new Date(),
          modelRunId: run.id,
          ordinal: acceptedOrdinals.length,
          providerCallId: `knowledge-ordinal-257-${suffix}`,
          result: {},
          roundIndex: 0,
          startedAt: new Date(),
          state: "complete",
          toolName: "retrieve_knowledge"
        },
        select: { id: true }
      });
      await expect(prisma.knowledgeRun.create({
        data: {
          baseEvidence: [{}],
          candidateCount: 0,
          candidateLimit: 1,
          durationMs: 0,
          embeddingUsage: [],
          fusion: "rrf_k60",
          invocationOrdinal: 257,
          modelRunId: run.id,
          modelRunToolCallId: rejectedCall.id,
          operation: "automatic_search",
          outcome: "base_empty",
          providerText: "Knowledge retrieval returned no indexed passages.",
          query: "ordinal boundary",
          resultLimit: 1,
          results: [],
          threshold: 0
        }
      })).rejects.toThrow();

      await expect(prisma.knowledgeRun.findMany({
        orderBy: { invocationOrdinal: "asc" },
        select: { invocationOrdinal: true },
        where: { modelRunId: run.id }
      })).resolves.toEqual(acceptedOrdinals.map((invocationOrdinal) => ({
        invocationOrdinal
      })));
    } finally {
      await prisma.chat.deleteMany({ where: { id: chat.id, userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
