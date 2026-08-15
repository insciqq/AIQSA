import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatDetailWire, ChatMessageWire } from "@/lib/contracts/chats";
import {
  chatDetailFromApi,
  chatSummaryFromApi,
  isSseParseError,
  messageIdsFromEvent,
  parseSseBlock,
  resetSessionExpiredSignalForTest,
  runIdFromEvent,
  sessionExpiredLoginHref,
  shellFetch,
  sseParseWarningEvent,
  subscribeToSessionExpired,
  tokenDeltaFromEvent
} from "./shellApi";

afterEach(() => {
  resetSessionExpiredSignalForTest();
  vi.restoreAllMocks();
});

describe("shell HTTP session handling", () => {
  it("raises one sticky session-expired signal for concurrent 401 responses", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "unauthorized" }, { status: 401 })
    );
    const firstListener = vi.fn();
    subscribeToSessionExpired(firstListener);

    const [first, second] = await Promise.all([
      shellFetch("/api/chats"),
      shellFetch("/api/me/mcp")
    ]);

    expect(first.status).toBe(401);
    expect(second.status).toBe(401);
    expect(firstListener).toHaveBeenCalledOnce();
    expect(firstListener).toHaveBeenCalledWith("session_expired");

    const lateListener = vi.fn();
    subscribeToSessionExpired(lateListener);
    expect(lateListener).toHaveBeenCalledOnce();
    expect(lateListener).toHaveBeenCalledWith("session_expired");
  });

  it("does not signal for authenticated authorization and server failures", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ error: "forbidden" }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ error: "failed" }, { status: 500 }));
    const listener = vi.fn();
    subscribeToSessionExpired(listener);

    await shellFetch("/api/admin");
    await shellFetch("/api/chats");

    expect(listener).not.toHaveBeenCalled();
  });

  it("builds a login handoff with only a safe internal destination", () => {
    expect(sessionExpiredLoginHref("/chat?settings=mcp#tools")).toBe(
      "/login?next=%2Fchat%3Fsettings%3Dmcp%23tools&reason=session_expired"
    );
    expect(sessionExpiredLoginHref("https://evil.example/steal")).toBe(
      "/login?next=%2F&reason=session_expired"
    );
  });
});

function message(overrides: Partial<ChatMessageWire> = {}): ChatMessageWire {
  return {
    artifactSummary: null,
    content: { blocks: [{ text: "Persisted text", type: "text" }] },
    createdAt: "2026-07-12T00:00:30.000Z",
    errorMessage: null,
    id: "message-1",
    modelId: "gpt-5.5",
    modelRunId: "run-1",
    parentMessageId: null,
    provider: "openai",
    role: "assistant",
    status: "complete",
    ...overrides
  };
}

describe("shell SSE protocol", () => {
  it("parses multiline data fields and fields without a trailing space", () => {
    expect(parseSseBlock('event: token\ndata: {"delta":\ndata:"hello"}')).toEqual({
      data: {
        delta: "hello"
      },
      type: "token"
    });
  });

  it("returns a parse_error event for malformed JSON instead of throwing", () => {
    const event = parseSseBlock("event: token\ndata: {not json");

    expect(isSseParseError(event!)).toBe(true);
    expect(event).toMatchObject({
      data: {
        eventType: "token",
        message: "Skipped malformed stream frame"
      },
      type: "parse_error"
    });
    expect(sseParseWarningEvent(event!)).toEqual({
      data: {
        eventType: "token",
        message: "Skipped malformed stream frame"
      },
      type: "warning"
    });
  });

  it("requires an event field and preserves an event without data", () => {
    expect(parseSseBlock('data: {"delta":"ignored"}')).toBeNull();
    expect(parseSseBlock("event: heartbeat")).toEqual({
      data: null,
      type: "heartbeat"
    });
  });

  it("extracts only exact run, message-start, and token fields", () => {
    expect(runIdFromEvent({ data: { runId: "run-1" }, type: "run_start" })).toBe(
      "run-1"
    );
    expect(
      messageIdsFromEvent({
        data: {
          assistantMessageId: "assistant-1",
          userMessageId: "user-1"
        },
        type: "message_start"
      })
    ).toEqual({
      assistantMessageId: "assistant-1",
      userMessageId: "user-1"
    });
    expect(
      messageIdsFromEvent({
        data: { assistantMessageId: "assistant-1" },
        type: "artifact"
      })
    ).toBeNull();
    expect(tokenDeltaFromEvent({ data: { delta: "answer" }, type: "token" })).toBe(
      "answer"
    );
    expect(tokenDeltaFromEvent({ data: { delta: "answer" }, type: "artifact" })).toBeNull();
  });
});

describe("chat wire mapping", () => {
  const detail: ChatDetailWire = {
    activeLeafMessageId: "message-cancelled",
    contextStats: {
      approximateActiveBranchInputTokens: 144
    },
    createdAt: "2026-07-12T00:00:00.000Z",
    defaultModelId: "gpt-5.5",
    defaultProvider: "openai",
    folderId: null,
    id: "chat-1",
    messageCount: 2,
    messages: [
      message({
        content: { blocks: [] },
        errorMessage: "Provider failed",
        id: "message-error",
        status: "error"
      }),
      message({
        content: { blocks: [] },
        id: "message-cancelled",
        parentMessageId: "message-error",
        status: "cancelled"
      })
    ],
    pageInfo: {
      activeLeafMessageId: "message-cancelled",
      beforeCursor: null,
      hasOlder: false,
      snapshotUpdatedAt: "2026-07-12T00:01:00.000Z"
    },
    pinned: false,
    title: "Mapped chat",
    updatedAt: "2026-07-12T00:01:00.000Z",
    usageStats: null
  };

  it("keeps workspace summaries message-free", () => {
    expect(chatSummaryFromApi(detail)).toEqual({
      activeLeafMessageId: "message-cancelled",
      createdAt: "2026-07-12T00:00:00.000Z",
      defaultKnowledgePlan: null,
      defaultModelId: "gpt-5.5",
      defaultProvider: "openai",
      folderId: null,
      id: "chat-1",
      messageCount: 2,
      pinned: false,
      title: "Mapped chat",
      updatedAt: "2026-07-12T00:01:00.000Z"
    });
  });

  it("preserves error and cancellation fallbacks in thread detail", () => {
    expect(chatDetailFromApi(detail).messages).toEqual([
      expect.objectContaining({
        content: "Provider failed",
        id: "message-error",
        status: "error"
      }),
      expect.objectContaining({
        content: "Stopped.",
        id: "message-cancelled",
        status: "cancelled"
      })
    ]);
  });

  it("preserves the server-owned context estimate and page fence", () => {
    expect(chatDetailFromApi(detail)).toMatchObject({
      contextStats: {
        approximateActiveBranchInputTokens: 144
      },
      pageInfo: {
        activeLeafMessageId: "message-cancelled",
        beforeCursor: null,
        hasOlder: false,
        snapshotUpdatedAt: detail.updatedAt
      }
    });
  });

  it("keeps a persisted queued message non-terminal", () => {
    expect(
      chatDetailFromApi({
        ...detail,
        activeLeafMessageId: "message-queued",
        messageCount: 1,
        messages: [message({ id: "message-queued", status: "queued" })],
        pageInfo: {
          ...detail.pageInfo,
          activeLeafMessageId: "message-queued"
        }
      }).messages[0]?.status
    ).toBe("streaming");
  });
});
