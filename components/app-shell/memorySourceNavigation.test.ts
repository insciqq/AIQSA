import { describe, expect, it, vi } from "vitest";
import { navigateMemorySource } from "./memorySourceNavigation";
import type { WorkspaceChatSummary } from "./types";

const chat: WorkspaceChatSummary = {
  activeLeafMessageId: null,
  createdAt: "2026-08-10T08:00:00.000Z",
  defaultModelId: "model",
  defaultProvider: "provider",
  folderId: null,
  id: "chat-source",
  memoryMode: "NORMAL",
  messageCount: 1,
  title: "Source",
  updatedAt: "2026-08-10T08:00:00.000Z"
};

describe("Memory source navigation", () => {
  it("resolves first, then closes Settings and opens owner-only archived preview", async () => {
    const order: string[] = [];
    const activateChat = vi.fn();
    const refreshWorkspace = vi.fn();

    await expect(navigateMemorySource(chat.id, {
      activateChat,
      closeResolvedOverlay: () => { order.push("close-settings"); },
      findActiveChat: () => null,
      openArchivedPreview: async () => { order.push("open-archived-preview"); },
      refreshWorkspace,
      resolveSource: async () => {
        order.push("resolve-owner-location");
        return {
          source: {
            chatId: chat.id,
            location: "ARCHIVED_PREVIEW",
            memoryMode: "NORMAL",
            sourceRevision: 4,
            updatedAt: "2026-08-10T08:00:00.000Z"
          }
        };
      }
    })).resolves.toBe("ARCHIVED_PREVIEW");

    expect(order).toEqual([
      "resolve-owner-location",
      "close-settings",
      "open-archived-preview"
    ]);
    expect(activateChat).not.toHaveBeenCalled();
    expect(refreshWorkspace).not.toHaveBeenCalled();
  });

  it("activates a resolved live source without refreshing the workspace", async () => {
    const activateChat = vi.fn();
    const refreshWorkspace = vi.fn();
    await navigateMemorySource(chat.id, {
      activateChat,
      findActiveChat: () => chat,
      openArchivedPreview: vi.fn(),
      refreshWorkspace,
      resolveSource: async () => ({
        source: {
          chatId: chat.id,
          location: "ACTIVE_CHAT",
          memoryMode: "NORMAL",
          sourceRevision: 2,
          updatedAt: "2026-08-10T08:00:00.000Z"
        }
      })
    });

    expect(activateChat).toHaveBeenCalledWith(chat);
    expect(refreshWorkspace).not.toHaveBeenCalled();
  });
});
