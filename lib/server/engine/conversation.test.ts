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

  // Regression: a native answer's delivered follow-ups and the text before them entered later runs twice, once as the
  // context's follow-up messages and once from the run's own items.
  describe("follow-ups of an earlier answer", () => {
    const branch = () => conversationMessagesFromPathRows([
      { chatId: "chat", messageContent: textMessageContent("Write a poem"), messageId: "user-1", messageRole: "user",
        messageStatus: "complete" },
      { chatId: "chat", messageContent: textMessageContent("Roses are red, violets are blue."), messageId: "answer-1",
        messageParentId: "user-1", messageRole: "assistant", messageStatus: "complete", followups: [
          { delivered: true, id: "f1", ordinal: 1, precedingText: "Roses are red", text: "Make it rhyme" },
          { delivered: false, id: "f2", ordinal: 2, precedingText: null, text: "Add a title" }
        ] },
      { chatId: "chat", messageContent: textMessageContent("Shorter"), messageId: "current-user-message", messageRole: "user",
        messageStatus: "complete" }
    ]);
    const answered: TranscriptItem[] = [
      { id: "a1", kind: "assistant_text", text: "Roses are red" },
      { followup: true, id: "u1", kind: "user", text: "Make it rhyme" },
      { id: "a2", kind: "assistant_text", text: "Roses are red, violets are blue." }
    ];
    const texts = (items: readonly TranscriptItem[]) => items.map((item) => "text" in item ? item.text : "");

    it("enters a native answer's delivered follow-ups once, from its items, and keeps the undelivered one", () => {
      const conversation = buildRunConversation({ continuationTurns: new Set(), current: { messageId: "user-2", mode: "input" },
        messages: branch(), nativeAnswers: new Map([["answer-1", answered]]) });
      expect(conversation.items).toEqual([
        { id: "msg-user-1", kind: "user", text: "Write a poem" },
        { id: "msg-f2", kind: "user", text: "Follow-up not delivered to the previous answer:\nAdd a title" },
        ...answered,
        { id: "msg-user-2", kind: "user", text: "Shorter" }
      ]);
      expect(texts(conversation.items).filter((text) => text.includes("Make it rhyme"))).toHaveLength(1);
      expect(texts(conversation.items).some((text) => text.includes("Partial answer before follow-up"))).toBe(false);
    });

    it("keeps an old-core answer's follow-ups as text, as before", () => {
      const conversation = buildRunConversation({ continuationTurns: new Set(), current: { messageId: "user-2", mode: "input" },
        messages: branch(), nativeAnswers: new Map() });
      expect(conversation.items).toEqual([
        { id: "msg-user-1", kind: "user", text: "Write a poem" },
        { id: "msg-f1-partial", kind: "assistant_text", text: "Partial answer before follow-up:\nRoses are red" },
        { id: "msg-f1", kind: "user", text: "Follow-up:\nMake it rhyme" },
        { id: "msg-f2", kind: "user", text: "Follow-up not delivered to the previous answer:\nAdd a title" },
        { id: "msg-answer-1", kind: "assistant_text", text: "Roses are red, violets are blue." },
        { id: "msg-user-2", kind: "user", text: "Shorter" }
      ]);
    });

    it("leaves out a delivered follow-up of a native answer that stopped without text once it is back on the branch", () => {
      const messages = conversationMessagesFromPathRows([
        { chatId: "chat", messageContent: textMessageContent("Write a poem"), messageId: "user-1", messageRole: "user",
          messageStatus: "complete" },
        { chatId: "chat", messageContent: textMessageContent(""), messageId: "answer-1", messageParentId: "user-1",
          messageRole: "assistant", messageStatus: "error",
          followups: [{ delivered: true, id: "f1", ordinal: 1, precedingText: "Roses are red", text: "Make it rhyme" }] },
        { chatId: "chat", messageContent: textMessageContent("Continue"), messageId: "current-user-message", messageRole: "user",
          messageStatus: "complete" }
      ]);
      const placed = withStoppedNativeAnswers(messages, [{ assistantMessageId: "answer-1", nextUserMessageId: "current-user-message" }]);
      expect(placed.map((entry) => entry.id)).toEqual(["user-1", "f1-partial", "f1", "answer-1", "current-user-message"]);
      const stopped = answered.slice(0, 2);
      expect(buildRunConversation({ continuationTurns: new Set(), current: { messageId: "user-2", mode: "input" }, messages: placed,
        nativeAnswers: new Map([["answer-1", stopped]]) }).items.map((item) => item.id)).toEqual(["msg-user-1", "a1", "u1", "msg-user-2"]);
      // A run with nothing recorded keeps the context's copies.
      expect(buildRunConversation({ continuationTurns: new Set(), current: { messageId: "user-2", mode: "input" }, messages: placed,
        nativeAnswers: new Map([["answer-1", []]]) }).items.map((item) => item.id))
        .toEqual(["msg-user-1", "msg-f1-partial", "msg-f1", "msg-user-2"]);
    });

    it("still drops an approval turn whose native answer took follow-ups", () => {
      const messages = conversationMessagesFromPathRows([
        { chatId: "chat", messageContent: textMessageContent("Create the issue"), messageId: "user-1", messageRole: "user",
          messageStatus: "complete" },
        { chatId: "chat", messageContent: textMessageContent("I need approval."), messageId: "answer-1", messageParentId: "user-1",
          messageRole: "assistant", messageStatus: "complete" },
        { chatId: "chat", messageContent: textMessageContent("The user approved `create` on `Jira`. Continue the task."),
          messageId: "turn-native", messageParentId: "answer-1", messageRole: "user", messageStatus: "complete" },
        { chatId: "chat", messageContent: textMessageContent("Roses are red, violets are blue."), messageId: "answer-2",
          messageParentId: "turn-native", messageRole: "assistant", messageStatus: "complete",
          followups: [{ delivered: true, id: "f1", ordinal: 1, precedingText: "Roses are red", text: "Make it rhyme" }] },
        { chatId: "chat", messageContent: textMessageContent("Thanks"), messageId: "current-user-message", messageRole: "user",
          messageStatus: "complete" }
      ]);
      expect(buildRunConversation({ continuationTurns: new Set(["turn-native"]), current: { messageId: "user-3", mode: "input" },
        messages, nativeAnswers: new Map([["answer-1", nativeTurn], ["answer-2", answered]]) }).items.map((item) => item.id))
        .toEqual(["msg-user-1", "n1", "n2", "a1", "u1", "a2", "msg-user-3"]);
    });
  });

  it("requires the run's own user message last", () => {
    expect(() => buildRunConversation({
      continuationTurns: new Set(), current: { messageId: "x", mode: "input" },
      messages: [message("answer-1", "assistant", "Hello")], nativeAnswers: new Map()
    })).toThrow("conversation_current_message_missing");
  });
});
