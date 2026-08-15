import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { activateMemoryHistorySearchAccount, applyMemoryHistorySearch, cancelMemoryHistorySearch, loadMoreMemoryHistorySearch, memoryHistoryInputFromDraft, useMemoryHistorySearchStore } from "./memoryHistorySearchStore";
import type { MemoryHistorySearchResponse } from "@/lib/contracts/memory";
import { resetMemoryHistorySearchStoreForTest } from "@/tests/support/appShellStores";

function response(
  sourceChatId: string,
  nextCursor: string | null = null
): MemoryHistorySearchResponse {
  return {
    indexing: {
      degradationCode: "memory_vector_unavailable",
      lexicalState: "READY",
      vectorState: "DEGRADED"
    },
    nextCursor,
    results: [{
      indexingState: "LEXICAL_READY",
      itemType: "RECALL_CHUNK",
      occurredAt: "2026-08-09T08:00:00.000Z",
      sourceChatId,
      sourceChatTitle: `Source ${sourceChatId}`,
      sourceFolderId: null,
      sourceFolderName: null,
      sourceMessageIds: [`message-${sourceChatId}`],
      sourceState: "AVAILABLE",
      snippet: `Safe result ${sourceChatId}`
    }]
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

describe("Memory history search store", () => {
  beforeEach(() => resetMemoryHistorySearchStoreForTest());
  afterEach(() => {
    resetMemoryHistorySearchStoreForTest();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("builds a bounded half-open UTC interval", () => {
    expect(memoryHistoryInputFromDraft({
      chatId: "chat-1",
      folderId: "folder-1",
      fromDate: "2026-08-01",
      query: "  рабочее решение  ",
      throughDate: "2026-08-03"
    })).toEqual({
      input: {
        chatIds: ["chat-1"],
        folderId: "folder-1",
        from: "2026-08-01T00:00:00.000Z",
        pageSize: 20,
        query: "рабочее решение",
        to: "2026-08-04T00:00:00.000Z"
      }
    });
    expect(memoryHistoryInputFromDraft({
      chatId: null,
      folderId: null,
      fromDate: "2026-08-04",
      query: "decision",
      throughDate: "2026-08-03"
    })).toEqual({ error: "memory_history_interval_invalid" });
  });

  it("keeps pagination on the exact applied request", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(response("chat-1", "cursor-private")))
      .mockResolvedValueOnce(json(response("chat-2")));
    vi.stubGlobal("fetch", fetchMock);
    activateMemoryHistorySearchAccount("account-a");
    useMemoryHistorySearchStore.getState().setQuery("first private query");

    await applyMemoryHistorySearch();
    useMemoryHistorySearchStore.getState().setQuery("unapplied different query");
    await loadMoreMemoryHistorySearch();

    expect(useMemoryHistorySearchStore.getState()).toMatchObject({
      accountId: "account-a",
      loadState: "ready",
      nextCursor: null
    });
    expect(useMemoryHistorySearchStore.getState().results.map((item) => item.sourceChatId))
      .toEqual(["chat-1", "chat-2"]);
    const secondBody = JSON.parse(String((fetchMock.mock.calls[1]?.[1] as RequestInit).body));
    expect(secondBody).toMatchObject({
      cursor: "cursor-private",
      query: "first private query"
    });
  });

  it("aborts on cancel and discards late or cross-account private results", async () => {
    let resolveFetch!: (value: Response) => void;
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        resolveFetch = resolve;
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    activateMemoryHistorySearchAccount("account-a");
    useMemoryHistorySearchStore.getState().setQuery("account A private query");
    const pending = applyMemoryHistorySearch();
    cancelMemoryHistorySearch();
    await pending;
    expect(useMemoryHistorySearchStore.getState()).toMatchObject({
      accountId: "account-a",
      loadState: "cancelled",
      results: []
    });

    activateMemoryHistorySearchAccount("account-b");
    resolveFetch(json(response("chat-account-a")));
    await Promise.resolve();
    expect(useMemoryHistorySearchStore.getState()).toMatchObject({
      accountId: "account-b",
      loadState: "idle",
      results: []
    });
    expect(useMemoryHistorySearchStore.getState().draft.query).toBe("");
  });
});
