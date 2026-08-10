import { afterEach, describe, expect, it, vi } from "vitest";
import { searchMemoryHistory } from "./memoryHistorySearchApi";
import type {
  MemoryHistorySearchInput,
  MemoryHistorySearchResponse
} from "@/lib/contracts/memory";

const input: MemoryHistorySearchInput = {
  chatIds: ["chat-private"],
  cursor: null,
  folderId: null,
  from: null,
  pageSize: 20,
  query: "закрытое решение по архитектуре",
  to: null
};

const response: MemoryHistorySearchResponse = {
  indexing: {
    degradationCode: null,
    lexicalState: "READY",
    vectorState: "NOT_CONFIGURED"
  },
  nextCursor: null,
  results: [{
    indexingState: "LEXICAL_READY",
    itemType: "RECALL_CHUNK",
    occurredAt: "2026-08-09T08:00:00.000Z",
    sourceChatId: "chat-private",
    sourceChatTitle: "Architecture notes",
    sourceFolderId: null,
    sourceFolderName: null,
    sourceMessageIds: ["message-private"],
    sourceState: "AVAILABLE",
    snippet: "Safe bounded architecture decision."
  }]
};

describe("Memory history search API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps the private query in the strict POST body and forwards cancellation", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(response), {
      headers: { "content-type": "application/json" },
      status: 200
    }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    await expect(searchMemoryHistory(input, controller.signal)).resolves.toEqual(response);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe("/api/me/memory/history/search");
    expect(path).not.toContain(input.query);
    expect(init).toMatchObject({
      cache: "no-store",
      credentials: "same-origin",
      method: "POST",
      signal: controller.signal
    });
    expect(JSON.parse(String(init.body))).toEqual(input);
  });

  it("rejects extra response fields and never copies server detail into its error", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...response, privateQuery: input.query }), {
        status: 200
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        detail: input.query,
        error: "not_a_public_memory_error"
      }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchMemoryHistory(input)).rejects.toMatchObject({
      code: "memory_response_invalid",
      message: "memory_response_invalid",
      status: 502
    });
    await expect(searchMemoryHistory(input)).rejects.toMatchObject({
      code: "memory_action_failed",
      message: "memory_action_failed",
      status: 500
    });
  });
});
