import { describe, expect, it, vi } from "vitest";
import { textMessageContent } from "../../domain/content";
import { getAuthConfig } from "../auth/config";
import { createTestAuth } from "@/tests/support/auth";
import {
  ActiveMessageMutationConflictError,
  createBranchChatFromMessageHandler,
  createDeleteMessageHandler,
  createEditMessageBranchHandler,
  type BranchChatRecord,
  type BranchMessageRecord,
  type MessageBranchRepository
} from "./handlers";

const config = getAuthConfig({
  AIQSA_BOOTSTRAP_AUTH_TOKEN: "token",
  AIQSA_AUTH_SESSION_SECRET: "secret"
});
const auth = createTestAuth({
  user: {
    id: config.bootstrapUserId
  }
});

function authCookie() {
  return auth.cookie;
}

function createMemoryRepository() {
  const messages = new Map<string, BranchMessageRecord>([
    [
      "user-1",
      {
        chatId: "chat-1",
        content: textMessageContent("Original question"),
        id: "user-1",
        modelId: "fake-qsa",
        parentMessageId: null,
        provider: "fake",
        role: "user",
        status: "complete"
      }
    ],
    [
      "assistant-1",
      {
        chatId: "chat-1",
        content: textMessageContent("Original answer"),
        id: "assistant-1",
        modelId: "fake-qsa",
        parentMessageId: "user-1",
        provider: "fake",
        role: "assistant",
        status: "complete"
      }
    ]
  ]);
  const state = {
    activeLeafMessageId: "assistant-1" as string | null,
    branchedChat: null as BranchChatRecord | null
  };
  const repository: MessageBranchRepository = {
    createChatBranchFromMessage: async ({ sourceMessageId }) => {
      const source = messages.get(sourceMessageId);
      if (!source) {
        return null;
      }

      const path = source.id === "assistant-1" ? [messages.get("user-1")!, source] : [source];
      const clonedMessages = path.map((message, index) => ({
        ...message,
        chatId: "chat-branch-1",
        id: `branch-message-${index + 1}`,
        parentMessageId: index === 0 ? null : `branch-message-${index}`
      }));
      state.branchedChat = {
        activeLeafMessageId: clonedMessages.at(-1)?.id ?? null,
        createdAt: "2026-06-07T09:00:00.000Z",
        defaultModelId: "fake-qsa",
        defaultProvider: "fake",
        folderId: null,
        id: "chat-branch-1",
        messageCount: clonedMessages.length,
        pinned: false,
        title: "Branch: Source chat",
        updatedAt: "2026-06-07T09:00:01.000Z"
      };

      return state.branchedChat;
    },
    createEditedMessageBranch: async ({ content, originalMessageId }) => {
      const original = messages.get(originalMessageId);
      if (!original || (original.role !== "user" && original.role !== "assistant")) {
        return null;
      }

      const message: BranchMessageRecord = {
        ...original,
        content,
        id: original.role === "assistant" ? "assistant-2" : "user-2",
        parentMessageId: original.parentMessageId
      };
      messages.set(message.id, message);
      state.activeLeafMessageId = message.id;

      return message;
    },
    deleteMessageSubtree: async ({ messageId }) => {
      const root = messages.get(messageId);
      if (!root) {
        return null;
      }

      const deletedMessageIds = [messageId];
      for (const message of messages.values()) {
        if (message.parentMessageId === messageId) {
          deletedMessageIds.push(message.id);
        }
      }

      for (const id of deletedMessageIds) {
        messages.delete(id);
      }
      state.activeLeafMessageId = deletedMessageIds.includes(state.activeLeafMessageId ?? "")
        ? root.parentMessageId
        : state.activeLeafMessageId;

      return {
        activeLeafMessageId: state.activeLeafMessageId,
        chatId: root.chatId,
        deletedMessageIds
      };
    }
  };

  return {
    messages,
    repository,
    state
  };
}

describe("message branch route handlers", () => {
  it("returns the shared 413 response before message validation or mutation", async () => {
    const previousLimit = process.env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES;
    process.env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES = "32";
    try {
      const { repository } = createMemoryRepository();
      const mutate = vi.spyOn(repository, "createEditedMessageBranch");
      const PATCH = createEditMessageBranchHandler({
        repository,
        resolveAuth: auth.resolveAuth
      });
      const response = await PATCH(
        new Request("http://app.local/api/messages/user-1", {
          body: JSON.stringify({ text: "x".repeat(64) }),
          headers: { cookie: authCookie() },
          method: "PATCH"
        }),
        { params: { messageId: "user-1" } }
      );

      expect(response.status).toBe(413);
      await expect(response.json()).resolves.toMatchObject({
        error: "request_body_too_large",
        limit: 32
      });
      expect(mutate).not.toHaveBeenCalled();
    } finally {
      if (previousLimit === undefined) {
        delete process.env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES;
      } else {
        process.env.AIQSA_JSON_REQUEST_BODY_MAX_BYTES = previousLimit;
      }
    }
  });

  it("edits a user message by creating a sibling branch and moving active leaf", async () => {
    const { repository, state } = createMemoryRepository();
    const PATCH = createEditMessageBranchHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await PATCH(
      new Request("http://app.local/api/messages/user-1", {
        body: JSON.stringify({
          text: "Edited question"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      }),
      {
        params: {
          messageId: "user-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      message: {
        content: {
          blocks: [{ text: "Edited question", type: "text" }]
        },
        id: "user-2",
        parentMessageId: null,
        role: "user"
      }
    });
    expect(state.activeLeafMessageId).toBe("user-2");
  });

  it("edits an assistant message by creating a sibling replacement branch", async () => {
    const { messages, repository, state } = createMemoryRepository();
    messages.set("assistant-child", {
      chatId: "chat-1",
      content: textMessageContent("Descendant answer"),
      id: "assistant-child",
      modelId: "fake-qsa",
      parentMessageId: "assistant-1",
      provider: "fake",
      role: "assistant",
      status: "complete"
    });
    const PATCH = createEditMessageBranchHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await PATCH(
      new Request("http://app.local/api/messages/assistant-1", {
        body: JSON.stringify({
          text: "Edited answer"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      }),
      {
        params: {
          messageId: "assistant-1"
        }
      }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      message: {
        content: {
          blocks: [{ text: "Edited answer", type: "text" }]
        },
        id: "assistant-2",
        parentMessageId: "user-1",
        role: "assistant"
      }
    });
    expect(state.activeLeafMessageId).toBe("assistant-2");
    expect(messages.get("assistant-child")?.parentMessageId).toBe("assistant-1");
  });

  it("rejects edit forks when the source chat is archived or unavailable", async () => {
    const { repository } = createMemoryRepository();
    repository.createEditedMessageBranch = async () => null;
    const PATCH = createEditMessageBranchHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await PATCH(
      new Request("http://app.local/api/messages/user-archived", {
        body: JSON.stringify({
          text: "Edited archived question"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      }),
      {
        params: {
          messageId: "user-archived"
        }
      }
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({
      error: "message_not_found_or_not_editable"
    });
  });

  it("returns a conflict when editing while the source chat has an active run", async () => {
    const { repository } = createMemoryRepository();
    repository.createEditedMessageBranch = async () => {
      throw new ActiveMessageMutationConflictError({
        id: "run-active",
        status: "streaming"
      });
    };
    const PATCH = createEditMessageBranchHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await PATCH(
      new Request("http://app.local/api/messages/user-1", {
        body: JSON.stringify({
          text: "Edited question"
        }),
        headers: {
          cookie: authCookie()
        },
        method: "PATCH"
      }),
      {
        params: {
          messageId: "user-1"
        }
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "active_run_in_progress",
      run: {
        id: "run-active",
        status: "streaming"
      }
    });
  });

  it("creates a new chat branch from a selected message path", async () => {
    const { repository, state } = createMemoryRepository();
    const POST = createBranchChatFromMessageHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-1/branch-chat", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "assistant-1"
        }
      }
    );

    expect(response.status).toBe(201);
    expect(state.branchedChat?.activeLeafMessageId).toBe("branch-message-2");
    const body = await response.json();
    expect(body).toMatchObject({
      chat: {
        activeLeafMessageId: "branch-message-2",
        id: "chat-branch-1",
        messageCount: 2,
        pinned: false,
        title: "Branch: Source chat"
      }
    });
    expect(body.chat).not.toHaveProperty("messages");
    expect(body.chat).not.toHaveProperty("usageStats");
  });

  it("returns a conflict when branching while the source chat has an active run", async () => {
    const { repository } = createMemoryRepository();
    repository.createChatBranchFromMessage = async () => {
      throw new ActiveMessageMutationConflictError({
        id: "run-active",
        status: "queued"
      });
    };
    const POST = createBranchChatFromMessageHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await POST(
      new Request("http://app.local/api/messages/assistant-1/branch-chat", {
        headers: {
          cookie: authCookie()
        },
        method: "POST"
      }),
      {
        params: {
          messageId: "assistant-1"
        }
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "active_run_in_progress",
      run: {
        id: "run-active",
        status: "queued"
      }
    });
  });

  it("deletes a message subtree and returns the next active leaf", async () => {
    const { messages, repository, state } = createMemoryRepository();
    const DELETE = createDeleteMessageHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await DELETE(
      new Request("http://app.local/api/messages/user-1", {
        headers: {
          cookie: authCookie()
        },
        method: "DELETE"
      }),
      {
        params: {
          messageId: "user-1"
        }
      }
    );

    expect(response.status).toBe(200);
    expect(messages.has("user-1")).toBe(false);
    expect(messages.has("assistant-1")).toBe(false);
    expect(state.activeLeafMessageId).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      message: {
        activeLeafMessageId: null,
        chatId: "chat-1",
        deleted: true,
        deletedMessageIds: ["user-1", "assistant-1"],
        id: "user-1"
      }
    });
  });

  it("returns a conflict when deleting while the source chat has an active run", async () => {
    const { repository } = createMemoryRepository();
    repository.deleteMessageSubtree = async () => {
      throw new ActiveMessageMutationConflictError({
        id: "run-active",
        status: "in_progress"
      });
    };
    const DELETE = createDeleteMessageHandler({
      repository,
      resolveAuth: auth.resolveAuth
    });
    const response = await DELETE(
      new Request("http://app.local/api/messages/user-1", {
        headers: {
          cookie: authCookie()
        },
        method: "DELETE"
      }),
      {
        params: {
          messageId: "user-1"
        }
      }
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "active_run_in_progress",
      run: {
        id: "run-active",
        status: "in_progress"
      }
    });
  });
});
