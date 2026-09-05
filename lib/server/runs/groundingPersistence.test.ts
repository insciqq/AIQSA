import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { conversationMessagesFromPathRows } from "./prismaRepository";

describe("grounded conversation persistence", () => {
  it("retains grounded assistant text in later branch context", () => {
    const messages = conversationMessagesFromPathRows([
      {
        chatId: "chat-1",
        messageContent: textMessageContent("Question"),
        messageId: "user-1",
        messageRole: "user",
        messageStatus: "complete"
      },
      {
        chatId: "chat-1",
        messageContent: textMessageContent("grounded-result-secret"),
        messageId: "assistant-1",
        messageRole: "assistant",
        messageStatus: "complete"
      }
    ]);

    expect(messages).toEqual([
      {
        content: textMessageContent("Question"),
        id: "user-1",
        role: "user"
      },
      {
        content: textMessageContent("grounded-result-secret"),
        id: "assistant-1",
        role: "assistant"
      }
    ]);
    expect(JSON.stringify(messages)).toContain("grounded-result-secret");
  });

  it("omits a failed zero-answer turn from later provider context without deleting its audit rows", () => {
    const messages = conversationMessagesFromPathRows([
      {
        chatId: "chat-1",
        messageContent: textMessageContent("Earlier question"),
        messageId: "user-1",
        messageParentId: null,
        messageRole: "user",
        messageStatus: "complete"
      },
      {
        chatId: "chat-1",
        messageContent: textMessageContent("Earlier answer"),
        messageId: "assistant-1",
        messageParentId: "user-1",
        messageRole: "assistant",
        messageStatus: "complete"
      },
      {
        chatId: "chat-1",
        messageContent: textMessageContent("Question that failed"),
        messageId: "user-failed",
        messageParentId: "assistant-1",
        messageRole: "user",
        messageStatus: "complete"
      },
      {
        chatId: "chat-1",
        messageContent: textMessageContent(""),
        messageId: "assistant-failed",
        messageParentId: "user-failed",
        messageRole: "assistant",
        messageStatus: "error"
      }
    ]);

    expect(messages).toEqual([
      { content: textMessageContent("Earlier question"), id: "user-1", role: "user" },
      { content: textMessageContent("Earlier answer"), id: "assistant-1", role: "assistant" }
    ]);
  });

  it("keeps the question when a failed assistant had already produced partial text", () => {
    const messages = conversationMessagesFromPathRows([
      {
        chatId: "chat-1",
        messageContent: textMessageContent("Question with a partial answer"),
        messageId: "user-1",
        messageParentId: null,
        messageRole: "user",
        messageStatus: "complete"
      },
      {
        chatId: "chat-1",
        messageContent: textMessageContent("Partial answer"),
        messageId: "assistant-1",
        messageParentId: "user-1",
        messageRole: "assistant",
        messageStatus: "error"
      }
    ]);

    expect(messages).toEqual([
      {
        content: textMessageContent("Question with a partial answer"),
        id: "user-1",
        role: "user"
      }
    ]);
  });
});
