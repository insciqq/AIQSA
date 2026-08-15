import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memory";
import { memorySettingsFixture } from "@/tests/support/memoryFixtures";
import {
  ChatLifecycleApiError,
  loadChatMemoryState,
  patchChatMemoryMode,
  resolveChatSource
} from "./chatLifecycleApi";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("chat lifecycle client", () => {
  it("sends Resume disclosure and both exact stale-write fences", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      chatId: "chat-1",
      memoryGeneration: 9,
      memoryRevision: 13,
      mode: "NORMAL",
      sourceRevision: 5
    }));
    vi.stubGlobal("fetch", fetchMock);

    await patchChatMemoryMode({
      chatId: "chat-1",
      expectedChatRevision: 4,
      mode: "NORMAL",
      settings: memorySettingsFixture({ settings: { memoryRevision: 12 } })
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/me/chats/chat-1/memory-mode");
    expect(JSON.parse(String(init?.body))).toEqual({
      expectedChatRevision: 4,
      expectedMemoryRevision: 12,
      mode: "NORMAL",
      resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
    });
  });

  it("fails closed on malformed Temporary state and resolves archived sources explicitly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/memory-mode")) {
        return Response.json({
          chat: {
            archived: false,
            chatId: "chat-temp",
            mode: "TEMPORARY",
            sourceRevision: 1,
            temporaryRetentionDeadline: null,
            temporaryRetentionPolicyVersion: "temporary-24h-v1",
            updatedAt: "2026-08-10T08:00:00.000Z"
          }
        });
      }
      return Response.json({
        source: {
          chatId: "chat-archived",
          location: "ARCHIVED_PREVIEW",
          memoryMode: "EXCLUDED",
          sourceRevision: 4,
          updatedAt: "2026-08-10T08:00:00.000Z"
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadChatMemoryState("chat-temp")).rejects.toEqual(
      expect.objectContaining<Partial<ChatLifecycleApiError>>({
        code: "chat_lifecycle_response_invalid",
        status: 502
      })
    );
    await expect(resolveChatSource("chat-archived")).resolves.toMatchObject({
      source: { location: "ARCHIVED_PREVIEW", memoryMode: "EXCLUDED" }
    });
  });
});
