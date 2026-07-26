import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import { GROUNDED_LIVE_ONLY_PLACEHOLDER } from "../../domain/grounding";
import { conversationMessagesFromPathRows } from "./prismaRepository";

describe("grounded conversation persistence", () => {
  it("replaces grounded assistant text before branch context can be saved or sent again", () => {
    const messages = conversationMessagesFromPathRows([
      {
        chatId: "chat-1",
        messageContent: textMessageContent("Question"),
        messageGroundedAt: null,
        messageId: "user-1",
        messageRole: "user",
        messageStatus: "complete"
      },
      {
        chatId: "chat-1",
        messageContent: textMessageContent("grounded-result-secret"),
        messageGroundedAt: new Date("2026-07-26T12:00:00.000Z"),
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
        content: textMessageContent(GROUNDED_LIVE_ONLY_PLACEHOLDER),
        id: "assistant-1",
        role: "assistant"
      }
    ]);
    expect(JSON.stringify(messages)).not.toContain("grounded-result-secret");
  });
});
