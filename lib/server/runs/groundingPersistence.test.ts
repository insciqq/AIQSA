import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { conversationMessagesFromPathRows } from "./prismaRepository";

describe("grounded conversation persistence", () => {
  it("includes the visible stopped answer before a follow-up without changing its terminal status", () => {
    const rows = [
      {
        chatId: "chat-1", messageId: "question", messageRole: "user",
        messageStatus: "complete", messageParentId: null,
        messageContent: textMessageContent("Give three points")
      },
      {
        chatId: "chat-1", messageId: "stopped", messageRole: "assistant",
        messageStatus: "cancelled", messageParentId: "question",
        messageContent: textMessageContent("1. First point\n2. Second")
      },
      {
        chatId: "chat-1", messageId: "follow-up", messageRole: "user",
        messageStatus: "complete", messageParentId: "stopped",
        messageContent: textMessageContent("Continue from point two")
      }
    ];
    const original = structuredClone(rows);

    expect(conversationMessagesFromPathRows(rows)).toEqual([
      { id: "question", role: "user", content: rows[0].messageContent },
      { id: "stopped", role: "assistant", content: rows[1].messageContent },
      { id: "follow-up", role: "user", content: rows[2].messageContent }
    ]);
    expect(rows).toEqual(original);
  });

  it.each([null, textMessageContent(""), textMessageContent(" \n ")])(
    "omits an empty stopped answer while retaining its question (%j)", (content) => {
      expect(conversationMessagesFromPathRows([
        {
          chatId: "chat-1", messageId: "question", messageRole: "user",
          messageStatus: "complete", messageParentId: null,
          messageContent: textMessageContent("Question")
        },
        {
          chatId: "chat-1", messageId: "stopped", messageRole: "assistant",
          messageStatus: "cancelled", messageParentId: "question", messageContent: content
        }
      ])).toEqual([
        { id: "question", role: "user", content: textMessageContent("Question") }
      ]);
    }
  );

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
