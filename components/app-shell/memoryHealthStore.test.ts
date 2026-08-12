import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryHealthFixture } from "./memoryTestFixtures";
import {
  activateMemoryHealthAccount,
  deactivateMemoryHealthAccount,
  resetMemoryHealthStoreForTest,
  useMemoryHealthStore
} from "./memoryHealthStore";

function json(health: unknown): Response {
  return Response.json({ health });
}

describe("Memory health store", () => {
  beforeEach(() => resetMemoryHealthStoreForTest());
  afterEach(() => {
    resetMemoryHealthStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("clears old status and ignores a late response after account switch", async () => {
    const firstHealth = memoryHealthFixture({
      indexing: { state: "FTS_ONLY" },
      state: "FTS_ONLY"
    });
    const secondHealth = memoryHealthFixture({ state: "UP_TO_DATE" });
    let resolveFirst!: (response: Response) => void;
    const fetcher = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      }))
      .mockResolvedValueOnce(json(secondHealth));
    vi.stubGlobal("fetch", fetcher);

    const first = activateMemoryHealthAccount("account-a");
    expect(useMemoryHealthStore.getState()).toMatchObject({
      accountId: "account-a",
      data: null,
      loadState: "loading"
    });
    const second = activateMemoryHealthAccount("account-b");
    await expect(second).resolves.toEqual(secondHealth);
    expect(useMemoryHealthStore.getState()).toMatchObject({
      accountId: "account-b",
      data: secondHealth,
      loadState: "ready"
    });

    resolveFirst(json(firstHealth));
    await expect(first).resolves.toEqual(firstHealth);
    expect(useMemoryHealthStore.getState()).toMatchObject({
      accountId: "account-b",
      data: secondHealth
    });
  });

  it("clears owner state on deactivation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json(memoryHealthFixture())));
    await activateMemoryHealthAccount("account-a");
    deactivateMemoryHealthAccount("account-a");
    expect(useMemoryHealthStore.getState()).toEqual({
      accountId: null,
      data: null,
      error: null,
      loadState: "idle"
    });
  });

  it("rejects malformed health before state mutation", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({
      ...memoryHealthFixture(),
      sourceText: "private"
    })));
    await expect(activateMemoryHealthAccount("account-a"))
      .rejects.toThrow("memory_response_invalid");
    expect(useMemoryHealthStore.getState()).toMatchObject({
      accountId: "account-a",
      data: null,
      error: "memory_response_invalid",
      loadState: "error"
    });
  });
});
