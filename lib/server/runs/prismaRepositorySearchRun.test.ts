import { describe, expect, it, vi } from "vitest";
import { createPrismaRunRepository } from "./prismaRepository";

describe("Prisma run repository search evidence", () => {
  it("persists exact revision/query attribution once per invocation", async () => {
    const findUnique = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "search-run-1" });
    const create = vi.fn().mockResolvedValue({ id: "search-run-1" });
    const repository = createPrismaRunRepository({
      searchRun: { create, findUnique }
    } as never);
    const input = {
      artifacts: { invocationId: "call-1:option-a", sources: [] },
      durationMs: 42,
      invocationId: "call-1:option-a",
      modelId: "search-model",
      modelRunId: "run-1",
      provider: "compatible",
      query: "bounded query",
      requestPreview: { queryCharacters: 13 },
      searchRevisionId: "revision-1",
      status: "complete" as const,
      strategyId: "option-a"
    };

    await repository.createSearchRun(input);
    await repository.createSearchRun(input);

    expect(findUnique).toHaveBeenCalledWith({
      select: { id: true },
      where: {
        modelRunId_invocationId: {
          invocationId: "call-1:option-a",
          modelRunId: "run-1"
        }
      }
    });
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({
      durationMs: 42,
      query: "bounded query",
      searchRevisionId: "revision-1"
    }) });
  });

  it("does not duplicate search evidence for the same durable provider call", async () => {
    const findFirst = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: "search-run-1" });
    const create = vi.fn().mockResolvedValue({ id: "search-run-1" });
    const repository = createPrismaRunRepository({
      searchRun: { create, findFirst }
    } as never);
    const input = {
      artifacts: {
        events: [],
        toolCall: { arguments: { keyword: "news" }, id: "provider-call-1", name: "search_via_perplexity" }
      },
      modelId: "perplexity-test",
      modelRunId: "run-1",
      provider: "openrouter",
      requestPreview: {},
      status: "complete" as const,
      strategyId: "perplexity-tool-search"
    };

    await repository.createSearchRun(input);
    await repository.createSearchRun(input);

    expect(create).toHaveBeenCalledOnce();
    expect(findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        artifacts: { equals: "provider-call-1", path: ["toolCall", "id"] },
        modelRunId: "run-1"
      })
    }));
  });

  it("projects terminal chat data and active-branch stats from one fenced snapshot", async () => {
    const now = new Date("2026-08-09T10:00:00.000Z");
    const directChatRead = vi.fn(() => {
      throw new Error("chat update escaped its transaction snapshot");
    });
    const transactionChatRead = vi.fn().mockResolvedValue({
      _count: { messages: 2 },
      activeLeafMessageId: "assistant-active",
      createdAt: now,
      defaultKnowledgePlan: null,
      defaultProviderModel: null,
      folderId: null,
      id: "chat-1",
      messages: [],
      pinned: false,
      title: "Atomic update",
      updatedAt: now
    });
    const transactionMessagesRead = vi.fn().mockResolvedValue([
      {
        assistantModelRuns: [],
        id: "user-root",
        parentMessageId: null,
        role: "user"
      },
      {
        assistantModelRuns: [{
          cachedInputTokens: 1,
          cacheWriteInputTokens: 2,
          inputTokens: 3,
          outputTokens: 4,
          status: "complete",
          totalTokens: 7
        }],
        id: "assistant-active",
        parentMessageId: "user-root",
        role: "assistant"
      }
    ]);
    const transactionRawRead = vi.fn().mockResolvedValue([
      {
        blockOrdinal: 1,
        blockValue: null,
        codePoint: 65,
        kind: "code_points",
        messageId: "user-root",
        occurrences: 4
      },
      {
        blockOrdinal: 1,
        blockValue: null,
        codePoint: 0x1f600,
        kind: "code_points",
        messageId: "assistant-active",
        occurrences: 1
      }
    ]);
    const tx = {
      $queryRaw: transactionRawRead,
      chat: { findFirst: transactionChatRead },
      message: { findMany: transactionMessagesRead }
    };
    const transaction = vi.fn(async (run: (client: typeof tx) => Promise<unknown>) => run(tx));
    const repository = createPrismaRunRepository({
      $transaction: transaction,
      chat: { findFirst: directChatRead }
    } as never);

    const update = await repository.getChatUpdateForRun({
      assistantMessageId: "assistant-active",
      chatId: "chat-1",
      userId: "user-1",
      userMessageId: "user-root"
    });

    expect(directChatRead).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledWith(
      expect.any(Function),
      { isolationLevel: "RepeatableRead" }
    );
    expect(transactionChatRead).toHaveBeenCalledOnce();
    expect(transactionMessagesRead).toHaveBeenCalledWith(expect.objectContaining({
      where: { chatId: "chat-1" }
    }));
    expect(update?.chat).toMatchObject({
      activeLeafMessageId: "assistant-active",
      contextStats: { approximateActiveBranchInputTokens: 3 },
      usageStats: {
        activeBranchMessageCount: 2,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 2,
        totalTokens: 7
      }
    });
  });
});
