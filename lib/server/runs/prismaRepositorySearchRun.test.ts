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
});
