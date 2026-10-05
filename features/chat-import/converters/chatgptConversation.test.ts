// @vitest-environment node
import { describe, expect, it } from "vitest";
import { decodeChatImportItem } from "@/lib/contracts/chatImport";
import {
  branchedConversation,
  citationsConversation,
  emptyConversation,
  legacyBranchConversation,
  legacyToolConversation,
  message,
  multimodalConversation,
  text
} from "./chatgpt.testFixtures";
import { convertChatGptConversation, type ChatGptConversion } from "./chatgptConversation";

const NOW = new Date("2026-10-05T12:00:00.000Z");
const PRIVATE_USE = /[\ue200-\ue2ff]/u;

function chatOf(conversion: ChatGptConversion) {
  if (conversion.kind !== "chat") throw new Error(`expected a chat, got ${conversion.kind}`);
  // Every converted chat passes the import item decoder and bounds the server applies.
  const decoded = decodeChatImportItem({
    document: conversion.chat.document,
    source: conversion.chat.source,
    sourceKey: conversion.chat.sourceKey,
    ...(conversion.chat.sourceModel ? { sourceModel: conversion.chat.sourceModel } : {})
  }, NOW);
  expect(decoded).toMatchObject({ ok: true });
  for (const item of conversion.chat.document.chat.messages) expect(item.text).not.toMatch(PRIVATE_USE);
  return conversion.chat;
}

function shape(conversion: ChatGptConversion) {
  return chatOf(conversion).document.chat.messages.map(({ createdAt, id, parentId, role, text: body }) => ({
    body,
    createdAt,
    id,
    parentId,
    role
  }));
}

describe("ChatGPT conversation", () => {
  it("keeps branches and an edited first prompt as two roots, merges a split answer and selects the visible branch", () => {
    const conversion = convertChatGptConversation(branchedConversation(), NOW);
    expect(shape(conversion)).toEqual([
      { body: "First question", createdAt: "2025-09-04T15:33:30.000Z", id: "m1", parentId: null, role: "user" },
      {
        body: "Answer part one ([Example article](https://example.com/article)).\n\nAnswer part two",
        createdAt: "2025-09-04T15:33:33.000Z",
        id: "m2",
        parentId: "m1",
        role: "assistant"
      },
      { body: "Follow up", createdAt: "2025-09-04T15:33:40.000Z", id: "m3", parentId: "m2", role: "user" },
      { body: "First answer to follow up", createdAt: "2025-09-04T15:33:41.000Z", id: "m4", parentId: "m3", role: "assistant" },
      { body: "Regenerated answer to follow up", createdAt: "2025-09-04T15:33:42.000Z", id: "m5", parentId: "m3", role: "assistant" },
      { body: "First question, edited", createdAt: "2025-09-04T15:35:00.000Z", id: "m6", parentId: null, role: "user" },
      { body: "Answer to the edited question", createdAt: "2025-09-04T15:35:01.000Z", id: "m7", parentId: "m6", role: "assistant" }
    ]);
    const chat = chatOf(conversion);
    expect(chat).toMatchObject({ source: "CHATGPT", sourceKey: "conv-branches", sourceModel: "gpt-synthetic" });
    // The hidden current node resolves to its nearest kept ancestor.
    expect(chat.document.chat).toMatchObject({
      activeLeafId: "m5",
      archived: false,
      createdAt: "2025-09-04T15:33:20.000Z",
      pinned: true,
      title: "Branches",
      updatedAt: "2025-09-04T15:36:40.000Z"
    });
    expect(conversion.kind === "chat" && conversion.skipped).toEqual({});
  });

  it("joins text and transcriptions, notes and counts images, audio and files, and fills missing dates and titles", () => {
    const conversion = convertChatGptConversation(multimodalConversation(), NOW);
    expect(shape(conversion)).toEqual([
      {
        body: "What is in this picture?\n\n_[Image not imported]_\n\n_[Attachment not imported: notes.pdf]_",
        // No date of its own: the conversation's.
        createdAt: "2025-09-04T15:50:00.000Z",
        id: "m1",
        parentId: null,
        role: "user"
      },
      { body: "A synthetic cat.", createdAt: "2025-09-04T15:50:10.000Z", id: "m2", parentId: "m1", role: "assistant" },
      { body: "Spoken question\n\n_[Audio recording not imported]_", createdAt: "2025-09-04T15:50:20.000Z", id: "m3", parentId: "m2", role: "user" },
      // Dated before its question: never earlier than its parent.
      { body: "Spoken answer\n\n_[Audio recording not imported]_", createdAt: "2025-09-04T15:50:20.000Z", id: "m4", parentId: "m3", role: "assistant" },
      { body: "_[Image not imported]_", createdAt: "2025-09-04T15:50:30.000Z", id: "m5", parentId: "m4", role: "user" }
    ]);
    const chat = chatOf(conversion);
    expect(chat.sourceModel).toBeUndefined();
    // No current node: the latest leaf.
    expect(chat.document.chat).toMatchObject({ activeLeafId: "m5", archived: true, pinned: true, title: "Untitled" });
    expect(conversion.kind === "chat" && conversion.skipped).toEqual({ attachment: 1, audio: 2, image: 2 });
  });

  it("turns every citation marker into links, names or nothing and leaves no private-use character", () => {
    const chat = chatOf(convertChatGptConversation(citationsConversation(), NOW));
    expect(chat.document.chat.messages[1]!.text).toBe([
      "Web ([First \\[source\\]](https://one.example/a_%28b%29), [Two](https://two.example/)).",
      "Extended ([Extended page](https://ext.example/page)).",
      "About Ada Lovelace today.",
      "From the file (report.pdf).",
      "Hidden.",
      "Products ([Synthetic kettle](https://shop.example/kettle))",
      "Navigation ([News one](https://news.example/1))",
      "Plain url ([Url title](https://url.example/)).",
      "Picture",
      "Unknown.",
      "Orphan.",
      "Stray character.",
      "",
      "Sources:",
      "- [First source](https://one.example/a_%28b%29)"
    ].join("\n"));
  });

  it("imports the legacy layout: code as a fence, execution output as a quote, tool traffic left out, generated images noted", () => {
    const conversion = convertChatGptConversation(legacyToolConversation(), NOW);
    expect(shape(conversion).map(({ body, parentId, role }) => ({ body, parentId, role }))).toEqual([
      { body: "Compute something", parentId: null, role: "user" },
      { body: "````python\nprint(\"```\")\n````\n\n> ```\n> line two\n\nDone.", parentId: "m1", role: "assistant" },
      { body: "Search the news", parentId: "m2", role: "user" },
      { body: "News ([News site](https://news.example/a)) today.", parentId: "m3", role: "assistant" },
      { body: "Draw a cat", parentId: "m4", role: "user" },
      { body: "_[Image not imported]_\n\nHere is your cat.", parentId: "m5", role: "assistant" }
    ]);
    const chat = chatOf(conversion);
    expect(chat.document.chat).toMatchObject({ activeLeafId: "m6", createdAt: "2025-09-04T16:40:00.250Z" });
    expect(chat.document.chat.messages[0]!.createdAt).toBe("2025-09-04T16:40:01.500Z");
    expect(chat).toMatchObject({ sourceKey: "legacy-tools", sourceModel: "gpt-legacy" });
    expect(conversion.kind === "chat" && conversion.skipped).toEqual({ image: 1 });
  });

  it("orders legacy branches as `children` lists them", () => {
    const chat = chatOf(convertChatGptConversation(legacyBranchConversation(), NOW));
    expect(chat.document.chat.messages.map(({ id, parentId, text: body }) => ({ body, id, parentId }))).toEqual([
      { body: "Question", id: "m1", parentId: null },
      { body: "Listed first, created later", id: "m2", parentId: "m1" },
      { body: "Listed second, created earlier", id: "m3", parentId: "m1" }
    ]);
    expect(chat.document.chat.activeLeafId).toBe("m2");
  });

  it("skips a conversation without kept messages and refuses one without a mapping or id", () => {
    expect(convertChatGptConversation(emptyConversation(), NOW)).toEqual({ kind: "empty", skipped: {} });
    expect(convertChatGptConversation({ id: "x", title: "No mapping" }, NOW))
      .toEqual({ kind: "failed", reason: "chat_export_shape_invalid", title: "No mapping" });
    expect(convertChatGptConversation({ mapping: {}, title: "" }, NOW))
      .toEqual({ kind: "failed", reason: "chat_export_shape_invalid", title: "Untitled" });
    expect(convertChatGptConversation([], NOW)).toMatchObject({ kind: "failed" });
  });

  it("survives cycles and dangling parents and drops implausible dates to the conversation date", () => {
    const conversion = convertChatGptConversation({
      create_time: 1_757_000_000,
      id: "conv-odd",
      mapping: {
        a: { id: "a", message: message("user", text("In a cycle")), parent: "b" },
        b: { id: "b", message: message("assistant", text("Also in a cycle")), parent: "a" },
        orphan: { id: "orphan", message: message("user", text("Dangling parent"), { time: 99_999_999_999 }), parent: "gone" },
        reply: { id: "reply", message: message("assistant", text("Reply"), { time: 1 }), parent: "orphan" }
      },
      title: "Odd"
    }, NOW);
    expect(shape(conversion)).toEqual([
      { body: "Dangling parent", createdAt: "2025-09-04T15:33:20.000Z", id: "m1", parentId: null, role: "user" },
      { body: "Reply", createdAt: "2025-09-04T15:33:20.000Z", id: "m2", parentId: "m1", role: "assistant" }
    ]);
  });

  it("does not merge a same-role answer across a branch point", () => {
    const conversion = convertChatGptConversation({
      create_time: 1_757_000_000,
      current_node: "a3",
      id: "conv-merge",
      mapping: {
        root: { id: "root", message: null, parent: null },
        u1: { id: "u1", message: message("user", text("Q")), parent: "root" },
        a1: { id: "a1", message: message("assistant", text("Part 1")), parent: "u1" },
        a2: { id: "a2", message: message("assistant", text("Branch A")), parent: "a1" },
        a3: { id: "a3", message: message("assistant", text("Branch B")), parent: "a1" }
      },
      title: "Merge"
    }, NOW);
    expect(shape(conversion).map(({ body, parentId }) => ({ body, parentId }))).toEqual([
      { body: "Q", parentId: null },
      { body: "Part 1", parentId: "m1" },
      { body: "Branch A", parentId: "m2" },
      { body: "Branch B", parentId: "m2" }
    ]);
    expect(chatOf(conversion).document.chat.activeLeafId).toBe("m4");
  });
});
