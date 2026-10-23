import { describe, expect, it } from "vitest";
import type { ProviderConversationMessage } from "../providers/types";
import { buildRunConversation } from "./conversation";
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
    expect(conversation.currentInputId).toBe("user-3");
    expect(conversation.items).toEqual([
      { id: "msg-user-1", kind: "user", text: "First question" },
      { id: "msg-answer-1", kind: "assistant_text", text: "Old-core answer" },
      { id: "msg-user-2", kind: "user", text: "Second question" },
      ...nativeTurn,
      { id: "ctx-4", kind: "user", text: "Skills index" },
      { id: "user-3", kind: "user", text: "Third question" }
    ]);
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
      { id: "user-2", kind: "user", text: "Continue" }
    ]);
  });

  it("requires the run's own user message last", () => {
    expect(() => buildRunConversation({
      continuationTurns: new Set(), current: { messageId: "x", mode: "input" },
      messages: [message("answer-1", "assistant", "Hello")], nativeAnswers: new Map()
    })).toThrow("conversation_current_message_missing");
  });
});
