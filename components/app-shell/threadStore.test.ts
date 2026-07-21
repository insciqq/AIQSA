import { afterEach, describe, expect, it } from "vitest";
import {
  resetThreadStoreForTest,
  selectThreadRenderActiveLeafId,
  selectThreadSnapshot,
  selectThreadVisibleMessages,
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
});
