import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../domain/content";
import type { ProviderConversationMessage } from "../providers/types";
import { conversationMessagesFromPathRows } from "../runs/prismaRepository";
import { buildRunConversation, withStoppedNativeAnswers } from "./conversation";
import type { TranscriptItem } from "./transcript";

function message(id: string, role: "assistant" | "user", text: string, extra: Partial<ProviderConversationMessage> = {}): ProviderConversationMessage {
  return { content: { blocks: [{ text, type: "text" }] }, id, role, ...extra };
}

const nativeTurn: TranscriptItem[] = [
  { arguments: "{}", callId: "call_1", id: "n1", kind: "tool_call", name: "mcp_jira_create_issue",
    origin: { model: "gpt-6-astra", provider: "c1" } },
  { callId: "call_1", id: "n2", kind: "tool_result", name: "mcp_jira_create_issue", outcome: "error", output: "Waiting for approval." }
];

describe("native run conversation", () => {
  it("feeds old-core answers as text and native answers as their items", () => {
    const conversation = buildRunConversation({
      continuationTurns: new Set(),
      current: { messageId: "user-3", mode: "input" },
      messages: [
        message("user-1", "user", "First question"),
        message("answer-1", "assistant", "Old-core answer"),
        message("user-2", "user", "Second question"),
        message("answer-2", "assistant", ""),
        message("skills", "user", "Skills index", { purpose: "skill_catalog" }),
        message("current-user-message", "user", "Third question")
      ],
      nativeAnswers: new Map([["answer-2", nativeTurn]])
    });
    // The run's own input has the id later runs give the same message.
    expect(conversation.currentInputId).toBe("msg-user-3");
    expect(conversation.items).toEqual([
      { id: "msg-user-1", kind: "user", text: "First question" },
      { id: "msg-answer-1", kind: "assistant_text", text: "Old-core answer" },
      { id: "msg-user-2", kind: "user", text: "Second question" },
      ...nativeTurn,
      { id: "ctx-4", kind: "user", runContext: true, text: "Skills index" },
      { id: "msg-user-3", kind: "user", text: "Third question" }
    ]);
    const next = buildRunConversation({
      continuationTurns: new Set(),
      current: { messageId: "user-4", mode: "input" },
      messages: [
        message("user-1", "user", "First question"),
        message("answer-1", "assistant", "Old-core answer"),
        message("user-2", "user", "Second question"),
        message("answer-2", "assistant", ""),
        message("user-3", "user", "Third question"),
        message("answer-3", "assistant", "Third answer"),
        message("current-user-message", "user", "Fourth question")
      ],
      nativeAnswers: new Map([["answer-2", nativeTurn]])
    });
    expect(next.items.map((item) => item.id)).toContain(conversation.currentInputId);
  });

  it("drops an approval turn a native run continued, keeps an old-core one, and enters no input for a continuation", () => {
    const conversation = buildRunConversation({
      continuationTurns: new Set(["turn-old", "turn-native"]),
      current: { messageId: "turn-current", mode: "continuation" },
      messages: [
        message("user-1", "user", "Create the issue"),
        message("answer-1", "assistant", "I need approval."),
        message("turn-old", "user", "The user approved `create` on `Jira`. Continue the task."),
        message("answer-2", "assistant", "Created."),
        message("user-3", "user", "Now another"),
        message("answer-3", "assistant", ""),
        message("turn-native", "user", "The user approved `create` on `Jira`. Continue the task."),
        message("answer-4", "assistant", ""),
        message("turn-current", "user", "The user approved `create` on `Jira`. Continue the task.")
      ],
      nativeAnswers: new Map([["answer-3", nativeTurn], ["answer-4", []]])
    });
    expect(conversation.currentInputId).toBeNull();
    expect(conversation.items.map((item) => item.id)).toEqual([
      "msg-user-1", "msg-answer-1", "msg-turn-old", "msg-answer-2", "msg-user-3", "n1", "n2"
    ]);
  });

  it("feeds a native answer stopped before its first round completed as its saved text", () => {
    const conversation = buildRunConversation({
      continuationTurns: new Set(),
      current: { messageId: "user-2", mode: "input" },
      messages: [
        message("user-1", "user", "Long task"),
        message("answer-1", "assistant", "Partial answer before the restart"),
        message("current-user-message", "user", "Continue")
      ],
      nativeAnswers: new Map([["answer-1", []]])
    });
    expect(conversation.items).toEqual([
      { id: "msg-user-1", kind: "user", text: "Long task" },
      { id: "msg-answer-1", kind: "assistant_text", text: "Partial answer before the restart" },
      { id: "msg-user-2", kind: "user", text: "Continue" }
    ]);
  });

  // Regression: a native run interrupted after its tool calls but before any text left an answer the context drops, so
  // Continue lost the run's own steps and results.
  it("puts a native answer that stopped without text back before the turn that follows it", () => {
    const row = (messageId: string, messageRole: "assistant" | "user", text: string, messageStatus = "complete") =>
      ({ chatId: "chat", messageContent: textMessageContent(text), messageId, messageRole, messageStatus });
    const branch = conversationMessagesFromPathRows([
      row("user-1", "user", "Create the issue"), row("answer-1", "assistant", "", "error"),
      row("user-2", "user", "Continue"), row("answer-2", "assistant", "", "cancelled"),
      row("current-user-message", "user", "And now?")
    ]);
    // The real context path leaves both stopped answers out.
    expect(branch.map((entry) => entry.id)).toEqual(["user-1", "user-2", "current-user-message"]);
    const withSkills = [...branch.slice(0, -1), message("skills", "user", "Skills index", { purpose: "skill_catalog" }), branch.at(-1)!];
    const messages = withStoppedNativeAnswers(withSkills, [
      { assistantMessageId: "answer-1", nextUserMessageId: "user-2" },
      { assistantMessageId: "answer-2", nextUserMessageId: "current-user-message" },
      // A sibling answer or one whose next turn left the branch has no place on it.
      { assistantMessageId: "sibling", nextUserMessageId: "elsewhere" },
      // One the branch carries already stays where it is.
      { assistantMessageId: "user-1", nextUserMessageId: "user-2" }
    ]);
    expect(messages.map((entry) => entry.id)).toEqual(["user-1", "answer-1", "user-2", "answer-2", "skills", "current-user-message"]);
    const conversation = buildRunConversation({ continuationTurns: new Set(), current: { messageId: "user-3", mode: "input" }, messages,
      nativeAnswers: new Map([["answer-1", nativeTurn], ["answer-2", []]]) });
    // A stopped run with nothing recorded adds nothing.
    expect(conversation.items.map((item) => item.id)).toEqual(["msg-user-1", "n1", "n2", "msg-user-2", "ctx-4", "msg-user-3"]);
    expect(withStoppedNativeAnswers(branch, [])).toEqual(branch);
  });

  it("requires the run's own user message last", () => {
    expect(() => buildRunConversation({
      continuationTurns: new Set(), current: { messageId: "x", mode: "input" },
      messages: [message("answer-1", "assistant", "Hello")], nativeAnswers: new Map()
    })).toThrow("conversation_current_message_missing");
  });
});
