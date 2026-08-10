import { describe, expect, it, vi } from "vitest";
import type {
  MemoryHistorySearchInput,
  MemoryHistorySearchResponse
} from "../../../../contracts/memory";
import type { AuthenticatedSession } from "../../../auth/requestAuth";
import {
  createMemoryHistorySearchHandler,
  type MemoryHistorySearchHandlerDeps
} from "./handlers";
import {
  MemoryHistorySearchServiceError,
  type MemoryHistorySearchService
} from "./service";

const input: MemoryHistorySearchInput = {
  chatIds: [],
  cursor: null,
  folderId: null,
  from: null,
  pageSize: 20,
  query: "где обсуждали pgvector",
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
    occurredAt: "2026-08-10T12:00:00.000Z",
    sourceChatId: "chat-1",
    sourceChatTitle: "Database notes",
    sourceFolderId: "folder-1",
    sourceFolderName: "Infrastructure",
    sourceMessageIds: ["message-1"],
    sourceState: "AVAILABLE",
    snippet: "Мы обсуждали pgvector."
  }]
};

function session(): AuthenticatedSession {
  return {
    expiresAt: new Date("2026-08-10T13:00:00.000Z"),
    id: "session-1",
    user: {
      displayName: "Owner",
      email: "owner@example.test",
      id: "user-1",
      role: "user",
      status: "active"
    },
    userId: "user-1"
  };
}

function service(
  overrides: Partial<MemoryHistorySearchService> = {}
): MemoryHistorySearchService {
  return {
    search: vi.fn(async () => response),
    ...overrides
  };
}

function deps(
  historyService = service(),
  authenticated: AuthenticatedSession | null = session()
): MemoryHistorySearchHandlerDeps {
  return {
    resolveAuth: vi.fn(async () => authenticated),
    service: historyService
  };
}

function request(body: unknown, url = "http://localhost/api/me/memory/history/search") {
  return new Request(url, {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
}

function expectPrivate(value: Response): void {
  expect(value.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  expect(value.headers.get("vary")).toBe("Cookie");
}

describe("Memory history search handler", () => {
  it("authenticates before reading the private query and returns no-store results", async () => {
    const historyService = service();
    const unauthorized = await createMemoryHistorySearchHandler(
      deps(historyService, null)
    )(new Request("http://localhost/api/me/memory/history/search", {
      body: "not-json-private-query",
      method: "POST"
    }));
    expect(unauthorized.status).toBe(401);
    expectPrivate(unauthorized);
    expect(historyService.search).not.toHaveBeenCalled();

    const result = await createMemoryHistorySearchHandler(deps(historyService))(
      request(input)
    );
    expect(result.status).toBe(200);
    expectPrivate(result);
    expect(historyService.search).toHaveBeenCalledWith("user-1", input);
    await expect(result.json()).resolves.toEqual(response);
  });

  it("rejects URL queries, non-JSON, and unknown body fields without echoing text", async () => {
    const queryInUrl = await createMemoryHistorySearchHandler(deps())(
      request(input, "http://localhost/api/me/memory/history/search?query=private")
    );
    expect(queryInUrl.status).toBe(400);
    expectPrivate(queryInUrl);
    expect(await queryInUrl.text()).not.toContain("private");

    const wrongContentType = await createMemoryHistorySearchHandler(deps())(
      new Request("http://localhost/api/me/memory/history/search", {
        body: JSON.stringify(input),
        headers: { "content-type": "text/plain" },
        method: "POST"
      })
    );
    expect(wrongContentType.status).toBe(400);
    expectPrivate(wrongContentType);

    const expanded = await createMemoryHistorySearchHandler(deps())(
      request({ ...input, ownerId: "foreign-user" })
    );
    expect(expanded.status).toBe(400);
    expectPrivate(expanded);
  });

  it("maps stale and unexpected failures to bounded query-free errors", async () => {
    const stale = await createMemoryHistorySearchHandler(deps(service({
      search: vi.fn(async () => {
        throw new MemoryHistorySearchServiceError("memory_source_stale");
      })
    })))(request(input));
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toEqual({ error: "memory_source_stale" });

    const failed = await createMemoryHistorySearchHandler(deps(service({
      search: vi.fn(async () => {
        throw new Error("private query: где обсуждали pgvector");
      })
    })))(request(input));
    expect(failed.status).toBe(500);
    expectPrivate(failed);
    expect(await failed.text()).toBe('{"error":"memory_action_failed"}');
  });
});
