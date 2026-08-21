import { afterEach, describe, expect, it, vi } from "vitest";
import { MEMORY_CONFIRMATION_COPY_VERSION } from "@/lib/contracts/memoryClient";
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
  it("forwards caller-confirmed Resume disclosure without inventing an attestation", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      allowedActions: ["EXCLUDE"],
      archived: false,
      mode: "NORMAL",
      temporaryRetentionDeadline: null
    }));
    vi.stubGlobal("fetch", fetchMock);

    await patchChatMemoryMode({
      chatId: "chat-1",
      mode: "NORMAL",
      resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/me/chats/chat-1/memory-mode");
    expect(JSON.parse(String(init?.body))).toEqual({
      mode: "NORMAL",
      resumeDisclosureCopyVersion: MEMORY_CONFIRMATION_COPY_VERSION
    });
  });

  it("keeps Exclude free of Resume disclosure fields", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({
      allowedActions: ["RESUME"],
      archived: false,
      mode: "EXCLUDED",
      temporaryRetentionDeadline: null
    }));
    vi.stubGlobal("fetch", fetchMock);

    await patchChatMemoryMode({ chatId: "chat-1", mode: "EXCLUDED" });

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({ mode: "EXCLUDED" });
  });

  it("fails closed on malformed Temporary state and resolves archived sources explicitly", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path.endsWith("/memory-mode")) {
        return Response.json({
          allowedActions: [],
          archived: false,
          mode: "TEMPORARY",
          temporaryRetentionDeadline: null
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

  it("rejects Memory-mode responses enriched with server revisions", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({
      allowedActions: ["EXCLUDE"],
      archived: false,
      mode: "NORMAL",
      sourceRevision: 4,
      temporaryRetentionDeadline: null
    })));

    await expect(loadChatMemoryState("chat-1")).rejects.toEqual(
      expect.objectContaining<Partial<ChatLifecycleApiError>>({
        code: "chat_lifecycle_response_invalid",
        status: 502
      })
    );
  });
});
