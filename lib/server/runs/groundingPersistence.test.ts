import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { conversationMessagesFromPathRows } from "./prismaRepository";

describe("grounded conversation persistence", () => {
  it("preserves opaque source references and distinct resend IDs after an empty failure", () => {
    const originalContent = { blocks: [{ type: "text", text: "Width 1024; keep the blue layer" },
      { type: "file", attachmentId: "source-original" }] };
    const rows = [
      { chatId: "chat", messageId: "original", messageRole: "user", messageStatus: "complete", messageContent: originalContent },
      { chatId: "chat", messageId: "failed", messageParentId: "original", messageRole: "assistant", messageStatus: "error", messageContent: null },
      { chatId: "chat", messageId: "resend", messageParentId: "failed", messageRole: "user", messageStatus: "complete",
        messageContent: { blocks: [{ type: "text", text: "Width 1024; keep the blue layer" }, { type: "file", attachmentId: "source-revised" }] } }
    ];
    const before = structuredClone(rows);
    expect(conversationMessagesFromPathRows(rows).map(message => message.id)).toEqual(["original", "resend"]);
    expect(conversationMessagesFromPathRows(rows)[0].content).toEqual(originalContent);
    expect(rows).toEqual(before);
  });

  it("preserves failed image output and delivery labels in follow-up order", () => {
    const imageContent = { blocks: [{ type: "image", attachmentId: "image-result" }] };
    const projected = conversationMessagesFromPathRows([
      { chatId: "chat", messageId: "original", messageRole: "user", messageStatus: "complete", messageContent: textMessageContent("Draw") },
      { chatId: "chat", messageId: "failed", messageParentId: "original", messageRole: "assistant", messageStatus: "error", messageContent: imageContent,
        followups: [
          { id: "delivered", ordinal: 1, text: "Blue", delivered: true, precedingText: "Started drawing" },
          { id: "pending", ordinal: 2, text: "Green", delivered: false, precedingText: null }
        ] }
    ]);
    expect(projected.map(message => message.id)).toEqual(["original", "delivered-partial", "delivered", "pending", "failed"]);
    expect(projected[2]).toMatchObject({ role: "user", contextTurnId: "original", content: textMessageContent("Follow-up:\nBlue") });
    expect(projected[3]).toMatchObject({ content: textMessageContent("Follow-up not delivered to the previous answer:\nGreen") });
    expect(projected[4]).toMatchObject({ role: "assistant", content: imageContent });
  });

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

  it("retains the question of a failed zero-answer turn without inventing an answer", () => {
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
      { content: textMessageContent("Earlier answer"), id: "assistant-1", role: "assistant" },
      { content: textMessageContent("Question that failed"), id: "user-failed", role: "user" }
    ]);
  });

  it("keeps the question and partial text when the assistant failed", () => {
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
      },
      {
        content: textMessageContent("Partial answer"),
        id: "assistant-1",
        role: "assistant"
      }
    ]);
  });
});
