import { describe, expect, it } from "vitest";
import {
  PAST_CHATS_LIMITS,
  PAST_CHATS_TOOL_ERROR_CODES,
  clipPastChatLine,
  clipPastChatText,
  decodePastChatSource,
  foldPastChatSources,
  pastChatPath,
  pastChatSearchMode,
  readPastChatInputSchema,
  readPastChatResultSchema,
  searchPastChatsInputSchema,
  searchPastChatsResultSchema
} from "./pastChats";

const ok = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const excerpt = { chatId: "chat-1", chatTitle: "Trip to Rome", date: "2026-10-03T08:15:00.000Z", messageId: "msg-1",
  excerpt: "We booked the hotel near Termini." };
const message = { messageId: "msg-1", role: "user", date: "2026-10-03T08:15:00.000Z", text: "Which hotel did we pick?", clipped: false,
  attachments: ["itinerary.pdf"], generatedFiles: [], tools: [] };

describe("search_past_chats arguments", () => {
  it("searches by relevance with a query and lists recent chats without one", () => {
    expect(searchPastChatsInputSchema.parse({})).toEqual({});
    expect(pastChatSearchMode({ query: "hotel in Rome" })).toBe("relevance");
    expect(pastChatSearchMode({})).toBe("recent");
    expect(pastChatSearchMode({ query: null })).toBe("recent");
    expect(pastChatSearchMode({ query: "   " })).toBe("recent");
  });

  it("takes null as absent and refuses unknown keys, bad days and bounds", () => {
    expect(ok(searchPastChatsInputSchema, { query: null, after: null, before: null, limit: null })).toBe(true);
    expect(ok(searchPastChatsInputSchema, { query: "x", after: "2026-10-01", before: "2026-11-01", limit: 20 })).toBe(true);
    expect(ok(searchPastChatsInputSchema, { q: "x" })).toBe(false);
    expect(ok(searchPastChatsInputSchema, { after: "2026-02-30" })).toBe(false);
    expect(ok(searchPastChatsInputSchema, { after: "2026-10-01T00:00:00Z" })).toBe(false);
    expect(ok(searchPastChatsInputSchema, { after: "2026-11-01", before: "2026-11-01" })).toBe(false);
    expect(ok(searchPastChatsInputSchema, { after: "2026-11-02", before: "2026-11-01" })).toBe(false);
    expect(ok(searchPastChatsInputSchema, { limit: 0 })).toBe(false);
    expect(ok(searchPastChatsInputSchema, { limit: PAST_CHATS_LIMITS.searchResultsMax + 1 })).toBe(false);
    expect(ok(searchPastChatsInputSchema, { limit: 2.5 })).toBe(false);
    expect(ok(searchPastChatsInputSchema, { query: "x".repeat(PAST_CHATS_LIMITS.queryChars + 1) })).toBe(false);
  });
});

describe("read_past_chat arguments", () => {
  it("reads around, before or after one message, or the chat's beginning", () => {
    expect(ok(readPastChatInputSchema, { chat_id: "chat-1" })).toBe(true);
    expect(ok(readPastChatInputSchema, { chat_id: "chat-1", around_message_id: "msg-1" })).toBe(true);
    expect(ok(readPastChatInputSchema, { chat_id: "chat-1", before_message_id: "msg-1", around_message_id: null })).toBe(true);
    expect(ok(readPastChatInputSchema, { chat_id: "chat-1", before_message_id: "msg-1", after_message_id: "msg-2" })).toBe(false);
    expect(ok(readPastChatInputSchema, { around_message_id: "msg-1" })).toBe(false);
    expect(ok(readPastChatInputSchema, { chat_id: "chat 1" })).toBe(false);
    expect(ok(readPastChatInputSchema, { chat_id: "chat-1", page: 2 })).toBe(false);
  });
});

describe("past-chat results", () => {
  it("decodes ranked excerpts without scores, each turn once", () => {
    expect(searchPastChatsResultSchema.parse({ mode: "relevance", results: [excerpt] })).toEqual({ mode: "relevance", results: [excerpt] });
    expect(ok(searchPastChatsResultSchema, { mode: "relevance", results: [{ ...excerpt, score: 0.9 }] })).toBe(false);
    expect(ok(searchPastChatsResultSchema, { mode: "relevance", results: [excerpt, excerpt] })).toBe(false);
    expect(ok(searchPastChatsResultSchema, { mode: "relevance", results: [excerpt, { ...excerpt, messageId: "msg-3" }] })).toBe(true);
    expect(ok(searchPastChatsResultSchema, { mode: "recent", results: [excerpt, { ...excerpt, messageId: "msg-3" }] })).toBe(false);
    expect(ok(searchPastChatsResultSchema, { mode: "relevance", results: [excerpt], total: 1 })).toBe(false);
    const many = Array.from({ length: PAST_CHATS_LIMITS.searchResultsMax + 1 }, (_, index) => ({ ...excerpt, messageId: `m${index}` }));
    expect(ok(searchPastChatsResultSchema, { mode: "relevance", results: many })).toBe(false);
  });

  it("bounds every result's title and excerpt", () => {
    expect(ok(searchPastChatsResultSchema, { mode: "recent", results: [{ ...excerpt, excerpt: "" }] })).toBe(false);
    expect(ok(searchPastChatsResultSchema, { mode: "recent", results: [{ ...excerpt, excerpt: "x".repeat(PAST_CHATS_LIMITS.excerptChars + 1) }] }))
      .toBe(false);
    expect(ok(searchPastChatsResultSchema, { mode: "recent", results: [{ ...excerpt, chatTitle: "two\nlines" }] })).toBe(false);
    expect(ok(searchPastChatsResultSchema, { mode: "recent", results: [{ ...excerpt, date: "2026-10-03" }] })).toBe(false);
  });

  it("decodes a read window with names only and bounds it", () => {
    const window = { chatId: "chat-1", chatTitle: "Trip to Rome", messages: [message, { ...message, messageId: "msg-2", role: "assistant",
      text: "", attachments: [], generatedFiles: ["plan.md"], tools: ["web_search"] }], hasEarlier: false, hasLater: true };
    expect(readPastChatResultSchema.parse(window)).toEqual(window);
    expect(ok(readPastChatResultSchema, { ...window, messages: [message, message] })).toBe(false);
    expect(ok(readPastChatResultSchema, { ...window, messages: [{ ...message, tools: [{ name: "web_search", arguments: {} }] }] })).toBe(false);
    expect(ok(readPastChatResultSchema, { ...window, messages: [{ ...message, role: "tool" }] })).toBe(false);
    expect(ok(readPastChatResultSchema, { ...window, messages: [{ ...message, text: "x".repeat(PAST_CHATS_LIMITS.readMessageChars + 1) }] }))
      .toBe(false);
    const full = Array.from({ length: 5 }, (_, index) => ({ ...message, messageId: `m${index}`, text: "x".repeat(PAST_CHATS_LIMITS.readMessageChars),
      clipped: true }));
    expect(ok(readPastChatResultSchema, { ...window, messages: full })).toBe(false);
    expect(ok(readPastChatResultSchema, { ...window, messages: full.slice(0, 4) })).toBe(true);
  });
});

describe("past-chat sources", () => {
  it("shows each turn once, in order and bounded, and drops what does not decode", () => {
    expect(decodePastChatSource(excerpt)).toEqual(excerpt);
    expect(decodePastChatSource({ ...excerpt, userId: "u1" })).toBeNull();
    const second = { ...excerpt, chatId: "chat-2" };
    expect(foldPastChatSources([excerpt, { bad: true }, second, excerpt])).toEqual([excerpt, second]);
    const many = Array.from({ length: 30 }, (_, index) => ({ ...excerpt, messageId: `m${index}` }));
    expect(foldPastChatSources(many)).toHaveLength(PAST_CHATS_LIMITS.sourcesPerAnswer);
  });

  it("clips between code points and opens the chat's page", () => {
    expect(clipPastChatText("short", 10)).toBe("short");
    const clipped = clipPastChatText("ab😀cd", 4);
    expect(clipped).toBe("ab…");
    expect(clipped.length).toBeLessThanOrEqual(4);
    expect(pastChatPath("chat/1")).toBe("/c/chat%2F1");
    const title = clipPastChatLine("  Trip\tto\n\nRome  ", PAST_CHATS_LIMITS.titleChars);
    expect(title).toBe("Trip to Rome");
    expect(ok(searchPastChatsResultSchema, { mode: "recent", results: [{ ...excerpt, chatTitle: title }] })).toBe(true);
    expect(clipPastChatLine("x".repeat(400), PAST_CHATS_LIMITS.titleChars)).toHaveLength(PAST_CHATS_LIMITS.titleChars);
  });
});

describe("past-chat tool refusals", () => {
  it("name the answer's used-up call budget apart from the other refusals", () => {
    expect(PAST_CHATS_TOOL_ERROR_CODES).toEqual(["past_chats_disabled", "past_chats_arguments_invalid", "past_chat_not_found",
      "past_chats_unavailable", "past_chats_call_limit"]);
  });
});
