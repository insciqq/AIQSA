import { describe, expect, it, vi } from "vitest";
import { createPrismaRunRepository } from "./prismaRepository";

describe("Prisma run repository search evidence", () => {
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
