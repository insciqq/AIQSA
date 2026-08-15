import { afterEach, describe, expect, it } from "vitest";
import { resetThreadStoreForTest } from "@/tests/support/appShellStores";
import {
  selectThreadRenderActiveLeafId,
  selectThreadSnapshot,
  selectThreadVisibleMessages,
  threadHistoryState,
  useThreadStore
} from "./threadStore";
import { appendAssistantDelta } from "./runState";
import type { ThreadMessage } from "./types";

function message(input: Partial<ThreadMessage> & Pick<ThreadMessage, "id" | "parentMessageId" | "role">): ThreadMessage {
  return {
    content: input.content ?? input.id,
    status: "complete",
    ...input
  };
}

function thread(chatId = "chat-a") {
  return selectThreadSnapshot(useThreadStore.getState(), chatId);
}

describe("thread store", () => {
  afterEach(() => {
    resetThreadStoreForTest();
  });

  it("checks out a branch through active leaf selection", () => {
    const messages = [
      message({ id: "q1", parentMessageId: null, role: "user" }),
      message({ id: "a1", parentMessageId: "q1", role: "assistant" }),
      message({ id: "a2", parentMessageId: "q1", role: "assistant" })
    ];

    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a1",
      messages,
      usageStats: null
    });
    useThreadStore.getState().checkoutBranch("chat-a", "a2");

    expect(selectThreadRenderActiveLeafId(thread())).toBe("a2");
    expect(selectThreadVisibleMessages(thread()).map((candidate) => candidate.id)).toEqual([
      "q1",
      "a2"
    ]);
  });

  it("repairs deleted-message branches with the server-selected active leaf", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a2",
      messages: [
        message({ id: "q1", parentMessageId: null, role: "user" }),
        message({ id: "a1", parentMessageId: "q1", role: "assistant" }),
        message({ id: "a2", parentMessageId: "q1", role: "assistant" })
      ],
      usageStats: null
    });

    useThreadStore.getState().deleteMessages("chat-a", {
      activeLeafId: "a1",
      deletedIds: new Set(["a2"])
    });

    expect(thread().messages.map((candidate) => candidate.id)).toEqual(["q1", "a1"]);
    expect(thread().activeLeafId).toBe("a1");
  });

  it("activates edit forks appended from persisted messages", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a1",
      messages: [
        message({ id: "q1", parentMessageId: null, role: "user" }),
        message({ id: "a1", parentMessageId: "q1", role: "assistant" })
      ],
      usageStats: null
    });

    useThreadStore.getState().appendMessage(
      "chat-a",
      message({ content: "edited", id: "a1-edit", parentMessageId: "q1", role: "assistant" }),
      { activate: true }
    );

    expect(thread().activeLeafId).toBe("a1-edit");
    expect(selectThreadVisibleMessages(thread()).map((candidate) => candidate.id)).toEqual([
      "q1",
      "a1-edit"
    ]);
  });

  it("merges regenerate forks without dropping siblings", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a1",
      messages: [
        message({ id: "q1", parentMessageId: null, role: "user" }),
        message({ id: "a1", parentMessageId: "q1", role: "assistant" })
      ],
      usageStats: null
    });

    useThreadStore.getState().mergeMessages(
      "chat-a",
      [message({ id: "a1-regen", parentMessageId: "q1", role: "assistant", status: "streaming" })],
      { activeLeafId: "a1-regen" }
    );

    expect(thread().messages.map((candidate) => candidate.id)).toEqual(["q1", "a1", "a1-regen"]);
    expect(selectThreadVisibleMessages(thread()).map((candidate) => candidate.id)).toEqual([
      "q1",
      "a1-regen"
    ]);
  });

  it("applies explicit null patches without confusing them with omitted values", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a1",
      messages: [message({ id: "a1", parentMessageId: null, role: "assistant" })],
      usageStats: {
        activeBranchMessageCount: 1,
        cachedInputTokens: 2,
        cacheWriteInputTokens: 3,
        totalTokens: 5
      }
    });

    useThreadStore.getState().mergeMessages("chat-a", [], {
      activeLeafId: null,
      usageStats: null
    });

    expect(thread()).toMatchObject({
      activeLeafId: null,
      usageStats: null
    });
  });

  it("applies stream token patches to the active thread", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "assistant-1",
      messages: [
        message({ id: "user-1", parentMessageId: null, role: "user" }),
        message({ content: "", id: "assistant-1", parentMessageId: "user-1", role: "assistant", status: "streaming" })
      ],
      usageStats: null
    });

    useThreadStore
      .getState()
      .updateMessages("chat-a", (current) => appendAssistantDelta(current, "assistant-1", "hello"));

    expect(thread().messages.at(-1)?.content).toBe("hello");
  });

  it("isolates keyed updates and preserves the neighboring snapshot identity", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "assistant-a",
      messages: [
        message({ content: "", id: "assistant-a", parentMessageId: null, role: "assistant", status: "streaming" })
      ],
      usageStats: null
    });
    useThreadStore.getState().replaceThread("chat-b", {
      activeLeafId: "assistant-b",
      messages: [message({ content: "settled", id: "assistant-b", parentMessageId: null, role: "assistant" })],
      usageStats: null
    });
    const chatBBefore = thread("chat-b");

    useThreadStore
      .getState()
      .updateMessages("chat-a", (current) => appendAssistantDelta(current, "assistant-a", "token"));

    expect(thread("chat-a").messages[0]?.content).toBe("token");
    expect(thread("chat-b")).toBe(chatBBefore);
    expect(thread("chat-b").messages[0]?.content).toBe("settled");
  });

  it("returns one stable empty snapshot for missing and blank chat ids", () => {
    const missingBefore = selectThreadSnapshot(useThreadStore.getState(), "missing");
    const blankBefore = selectThreadSnapshot(useThreadStore.getState(), null);

    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: null,
      messages: [],
      usageStats: null
    });

    expect(selectThreadSnapshot(useThreadStore.getState(), "missing")).toBe(missingBefore);
    expect(selectThreadSnapshot(useThreadStore.getState(), null)).toBe(blankBefore);
    expect(blankBefore).toBe(missingBefore);
  });

  it("removes only the requested keyed thread", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a1",
      messages: [message({ id: "a1", parentMessageId: null, role: "assistant" })],
      usageStats: null
    });
    useThreadStore.getState().replaceThread("chat-b", {
      activeLeafId: "b1",
      messages: [message({ id: "b1", parentMessageId: null, role: "assistant" })],
      usageStats: null
    });
    const chatBBefore = thread("chat-b");

    useThreadStore.getState().removeThread("chat-a");

    expect(useThreadStore.getState().threadsByChatId).not.toHaveProperty("chat-a");
    expect(thread("chat-b")).toBe(chatBBefore);
  });

  it("prepends a fenced older page without overwriting newer message state", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a3",
      history: {
        beforeCursor: "cursor-2",
        error: null,
        hasOlder: true,
        loading: false,
        requestGeneration: 0,
        snapshotActiveLeafId: "a3",
        snapshotUpdatedAt: "2026-08-09T08:00:00.000Z"
      },
      messages: [
        message({ id: "q2", parentMessageId: "a1", role: "user" }),
        message({ content: "newer state", id: "a3", parentMessageId: "q2", role: "assistant" })
      ],
      usageStats: null
    });
    const requestGeneration = useThreadStore.getState().beginOlderPage("chat-a");

    expect(useThreadStore.getState().prependOlderPage("chat-a", {
      beforeCursor: null,
      hasOlder: false,
      messages: [
        message({ id: "q1", parentMessageId: null, role: "user" }),
        message({ id: "a1", parentMessageId: "q1", role: "assistant" }),
        message({ content: "stale duplicate", id: "a3", parentMessageId: "q2", role: "assistant" })
      ],
      requestGeneration,
      snapshotActiveLeafId: "a3",
      snapshotUpdatedAt: "2026-08-09T08:00:00.000Z"
    })).toBe(true);

    expect(thread().messages.map((candidate) => candidate.id)).toEqual(["q1", "a1", "q2", "a3"]);
    expect(thread().messages.at(-1)?.content).toBe("newer state");
    expect(threadHistoryState(thread())).toMatchObject({
      beforeCursor: null,
      error: null,
      hasOlder: false,
      loading: false,
      requestGeneration
    });
  });

  it("ignores an older page from a superseded snapshot generation", () => {
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a2",
      history: {
        beforeCursor: "old-cursor",
        error: null,
        hasOlder: true,
        loading: false,
        requestGeneration: 4,
        snapshotActiveLeafId: "a2",
        snapshotUpdatedAt: "old-snapshot"
      },
      messages: [message({ id: "a2", parentMessageId: null, role: "assistant" })],
      usageStats: null
    });
    const requestGeneration = useThreadStore.getState().beginOlderPage("chat-a");
    useThreadStore.getState().replaceThread("chat-a", {
      activeLeafId: "a3",
      history: {
        beforeCursor: "new-cursor",
        error: null,
        hasOlder: true,
        loading: false,
        requestGeneration: requestGeneration + 1,
        snapshotActiveLeafId: "a3",
        snapshotUpdatedAt: "new-snapshot"
      },
      messages: [message({ id: "a3", parentMessageId: null, role: "assistant" })],
      usageStats: null
    });

    expect(useThreadStore.getState().prependOlderPage("chat-a", {
      beforeCursor: null,
      hasOlder: false,
      messages: [message({ id: "a1", parentMessageId: null, role: "assistant" })],
      requestGeneration,
      snapshotActiveLeafId: "a2",
      snapshotUpdatedAt: "old-snapshot"
    })).toBe(false);
    expect(thread().messages.map((candidate) => candidate.id)).toEqual(["a3"]);
  });

  it("retains the active plus two recent inactive threads and explicit live exceptions", () => {
    for (const chatId of ["chat-a", "chat-b", "chat-c", "chat-d", "chat-live"]) {
      useThreadStore.getState().replaceThread(chatId, {
        activeLeafId: `${chatId}-message`,
        messages: [message({ id: `${chatId}-message`, parentMessageId: null, role: "assistant" })],
        usageStats: null
      });
      useThreadStore.getState().touchThread(chatId);
    }

    const removed = useThreadStore.getState().pruneInactiveThreads({
      activeChatId: "chat-d",
      protectedChatIds: new Set(["chat-live"])
    });

    expect(removed).toEqual(["chat-a"]);
    expect(Object.keys(useThreadStore.getState().threadsByChatId).sort()).toEqual([
      "chat-b",
      "chat-c",
      "chat-d",
      "chat-live"
    ]);
  });
});
