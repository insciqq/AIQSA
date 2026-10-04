import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import { chatExportText } from "../../domain/chatExport";
import { textMessageContent } from "../../domain/content";
import { prisma } from "../prisma";
import { createPrismaChatNavigationRepository } from "./navigation";

// Representative persisted content documents, including the shapes the
// readable-text rule deliberately ignores.
const documents: unknown[] = [
  { blocks: [{ type: "text", text: "Hello world" }] },
  { blocks: [{ type: "text", text: "first" }, { type: "image", attachmentId: "a1" }, { type: "text", text: "second" }] },
  { blocks: [{ type: "text", text: "a" }, { type: "text", text: "" }, { type: "text", text: "b" }] },
  { blocks: [{ type: "text", text: 42 }, { type: "text", text: null }, { type: "text", text: "kept" }] },
  { blocks: [{ type: "TEXT", text: "case" }, { type: ["text"], text: "array type" }, { type: "text", text: { nested: true } }] },
  { blocks: [null, ["text"], "text", 7, { type: "text", text: "survivor" }] },
  { blocks: { type: "text", text: "not an array" } },
  "a bare string with \"quotes\" and \\ backslash",
  "",
  42,
  null,
  true,
  [{ type: "text", text: "top-level array" }],
  { blocks: [] },
  { blocks: [{ type: "text", text: "  " }, { type: "text", text: "\n" }] },
  { blocks: [{ type: "tool_use", name: "search", input: { text: "tool input" } }, { type: "text", text: "after tool" }] },
  { text: "no blocks key", type: "text" },
  { blocks: [{ type: "text", text: "Привет, мир! 東京 🚀 mixed" }] },
  { blocks: [{ type: "text", text: "100% literal_underscore \\escape\\ and 'quote'" }] },
  { blocks: [{ type: "text", text: "line one\nline two\r\nline three\ttab" }] },
  { blocks: [{ type: "text", text: "extra", cache: { ephemeral: true } }] },
  { blocks: [{ type: "file", attachmentId: "f1", fileName: "text.txt" }] },
  { blocks: [{ type: "text", text: "x".repeat(5_000) }, { type: "text", text: "tail" }] },
  { blocks: [{ text: "missing type" }, { type: "text" }] },
  { blocks: [{ type: "input_text", text: "input text block" }, { type: "output_text", text: "output text block" }] }
];

describe("Prisma message content search", () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("reads a message's text exactly as chatExportText does, behind a valid trigram index", async () => {
    const rows = await prisma.$queryRaw<Array<{ text: string }>>`
      SELECT aiqsa_message_search_text(item.document) AS "text"
      FROM jsonb_array_elements(${JSON.stringify(documents)}::jsonb) WITH ORDINALITY AS item(document, position)
      ORDER BY item.position
    `;
    expect(rows.map((row) => row.text)).toEqual(documents.map(chatExportText));

    const [index] = await prisma.$queryRaw<Array<{ definition: string; valid: boolean }>>`
      SELECT pg_get_indexdef(i.indexrelid) AS "definition", i.indisvalid AS "valid"
      FROM pg_index AS i
      INNER JOIN pg_class AS c ON c.oid = i.indexrelid
      WHERE c.relname = 'Message_searchText_trgm_idx'
    `;
    expect(index?.valid).toBe(true);
    expect(index?.definition).toMatch(/USING gin \(aiqsa_message_search_text\(content\) gin_trgm_ops\)/u);
  });

  it("finds sidebar chats by message text on any branch, newest match first, and pages them", async () => {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 10);
    const needle = `zephyrine${suffix}`;
    const ownerId = `message-search-owner-${suffix}`;
    const foreignId = `message-search-foreign-${suffix}`;
    await prisma.user.createMany({
      data: [
        { displayName: "Search owner", id: ownerId, status: "active" },
        { displayName: "Search foreign", id: foreignId, status: "active" }
      ]
    });
    try {
      const at = (minute: number) => new Date(Date.UTC(2026, 7, 13, 0, minute));
      const chat = (title: string, minute: number, userId = ownerId) => prisma.chat.create({
        data: { title, updatedAt: at(minute), userId }
      });
      const message = (chatId: string, input: {
        content?: unknown;
        minute: number;
        parentMessageId?: string | null;
        role?: "assistant" | "user";
        text?: string;
      }) => prisma.message.create({
        data: {
          chatId,
          content: (input.content ?? textMessageContent(input.text ?? "")) as never,
          createdAt: at(input.minute),
          parentMessageId: input.parentMessageId ?? null,
          role: input.role ?? "user",
          status: "complete"
        }
      });

      // Linear chat: the match sits in the middle of a long answer.
      const trip = await chat("Trip notes", 50);
      const tripQuestion = await message(trip.id, { minute: 1, text: "Where should we stay?" });
      const longAnswer = `${"Lisbon has many quiet streets and old trams. ".repeat(8)}Stay near the ${needle.toUpperCase()} district for views. ${"Bring comfortable shoes. ".repeat(6)}`;
      const tripAnswer = await message(trip.id, {
        minute: 2, parentMessageId: tripQuestion.id, role: "assistant", text: longAnswer
      });
      await prisma.chat.update({ data: { activeLeafMessageId: tripAnswer.id, updatedAt: at(50) }, where: { id: trip.id } });

      // Branched chat: the newest match is on the non-active branch.
      const branched = await chat("Branch plans", 40);
      const root = await message(branched.id, { minute: 3, text: "Plan the route" });
      const firstAnswer = await message(branched.id, {
        minute: 4, parentMessageId: root.id, role: "assistant", text: `Start at the ${needle} gate early.`
      });
      const secondAnswer = await message(branched.id, {
        minute: 5, parentMessageId: root.id, role: "assistant", text: "Start wherever you like."
      });
      const offBranch = await message(branched.id, {
        minute: 6, parentMessageId: firstAnswer.id, text: `Tell me more about ${needle}.`
      });
      await prisma.chat.update({ data: { activeLeafMessageId: secondAnswer.id, updatedAt: at(40) }, where: { id: branched.id } });

      // Escaping: a literal `100%_` must not match `100xyready`.
      const literal = await chat("Release literal", 30);
      await message(literal.id, { minute: 7, text: `${suffix} release is 100%_ready now` });
      const decoy = await chat("Release decoy", 29);
      await message(decoy.id, { minute: 8, text: `${suffix} release is 100xyready now` });

      // JSON keys and non-text blocks never match.
      const picture = await chat("Picture only", 28);
      await message(picture.id, {
        content: { blocks: [{ attachmentId: "fixture", type: "image" }, { text: "Just a picture", type: "text" }] },
        minute: 9
      });

      // Every fence of the sidebar scope.
      const archived = await chat("Archived match", 60);
      await message(archived.id, { minute: 10, text: `archived ${needle}` });
      await prisma.chat.update({ data: { archived: true, updatedAt: at(60) }, where: { id: archived.id } });
      const foreign = await chat("Foreign match", 61, foreignId);
      await message(foreign.id, { minute: 11, text: `foreign ${needle}` });
      // The Temporary fence is proven with the real lifecycle in
      // temporaryRetention.prisma.test.ts.
      const deleting = await chat("Deleting match", 63);
      await message(deleting.id, { minute: 12, text: `deleting ${needle}` });
      const deletion = await prisma.memoryDeletionOutbox.create({
        data: {
          admissionAuthorizationId: randomUUID(),
          admittedChatSourceRevision: 0,
          alsoForgetOriginMemories: false,
          memoryGeneration: 0,
          operation: "SOURCE_PURGE",
          targetId: deleting.id,
          targetType: "CHAT@memory-chat-delete-v1",
          userId: ownerId
        }
      });
      await prisma.chat.update({
        data: {
          archived: true,
          memoryMode: "EXCLUDED",
          permanentDeletionAt: new Date(),
          permanentDeletionOperationId: deletion.id,
          updatedAt: at(63)
        },
        where: { id: deleting.id }
      });

      const repository = createPrismaChatNavigationRepository(prisma);
      const search = (query: string, limit = 30) =>
        repository.searchPage({ cursor: null, limit, query, userId: ownerId });

      const first = await search(needle);
      if (first.kind !== "ok") throw new Error("message_search_missing");
      expect(first.page.chats).toEqual([]);
      const matches = first.page.messageMatches?.matches ?? [];
      expect(matches.map((match) => match.chatId)).toEqual([trip.id, branched.id]);
      for (const excluded of [archived.id, foreign.id, deleting.id]) {
        expect(JSON.stringify(first)).not.toContain(excluded);
      }
      expect(matches[0]).toMatchObject({
        createdAt: at(2).toISOString(),
        matchCount: 1,
        messageId: tripAnswer.id,
        title: "Trip notes"
      });
      // Readable text around the first match, never the JSON document.
      expect(matches[0]?.snippet.toLowerCase()).toContain(needle);
      expect(matches[0]?.snippet.startsWith("…")).toBe(true);
      expect(matches[0]?.snippet).not.toMatch(/blocks|"type"|\{/u);
      expect(Array.from(matches[0]!.snippet).length).toBeLessThanOrEqual(80 * 2 + needle.length + 2);
      expect(matches[1]).toMatchObject({ matchCount: 2, messageId: offBranch.id, title: "Branch plans" });

      // One chat per page; the cursor continues exactly where the page ended.
      const paged = await search(needle, 1);
      if (paged.kind !== "ok" || !paged.page.messageMatches) throw new Error("message_page_missing");
      expect(paged.page.messageMatches.matches.map((match) => match.chatId)).toEqual([trip.id]);
      const cursor = paged.page.messageMatches.nextCursor;
      expect(cursor).toEqual(expect.any(String));
      expect(Buffer.from(cursor ?? "", "base64url").toString("utf8")).not.toMatch(new RegExp(`${needle}|${ownerId}`, "u"));
      await expect(repository.searchMessagesPage({ cursor, limit: 1, query: needle, userId: ownerId }))
        .resolves.toEqual({ kind: "ok", page: { matches: [matches[1]], nextCursor: null } });
      await expect(repository.searchMessagesPage({ cursor, limit: 1, query: "different", userId: ownerId }))
        .resolves.toEqual({ kind: "cursor_invalid" });
      await expect(repository.searchMessagesPage({ cursor, limit: 1, query: needle, userId: foreignId }))
        .resolves.toEqual({ kind: "cursor_invalid" });
      // A message cursor never continues the title results.
      await expect(repository.searchPage({ cursor, limit: 1, query: needle, userId: ownerId }))
        .resolves.toEqual({ kind: "cursor_invalid" });

      // Title continuation pages and short queries carry no message page.
      const titles = await search("release", 1);
      if (titles.kind !== "ok") throw new Error("title_search_missing");
      expect(titles.page.chats.map((row) => row.id)).toEqual([literal.id]);
      await expect(repository.searchMessagesPage({
        cursor: titles.page.nextCursor, limit: 1, query: "release", userId: ownerId
      })).resolves.toEqual({ kind: "cursor_invalid" });
      await expect(repository.searchPage({
        cursor: titles.page.nextCursor, limit: 1, query: "release", userId: ownerId
      })).resolves.toMatchObject({ kind: "ok", page: { chats: [{ id: decoy.id }], messageMatches: null } });
      await expect(search("ze")).resolves.toMatchObject({ kind: "ok", page: { messageMatches: null } });

      // `%` and `_` are literal; a JSON key or block type is not text.
      const escaped = await search("100%_");
      expect(escaped.kind === "ok" ? escaped.page.messageMatches?.matches.map((match) => match.chatId) : null)
        .toEqual([literal.id]);
      for (const query of ["type", "image", "attachmentId", "blocks"]) {
        const result = await search(query);
        expect(result.kind === "ok" ? result.page.messageMatches?.matches.map((match) => match.chatId) : null)
          .not.toContain(picture.id);
      }
      await expect(search("just a picture")).resolves.toMatchObject({
        kind: "ok", page: { messageMatches: { matches: [{ chatId: picture.id }] } }
      });
    } finally {
      // A chat pending permanent deletion goes before its deletion obligation,
      // and the obligation before its owner.
      await prisma.chat.deleteMany({ where: { userId: { in: [ownerId, foreignId] } } });
      await prisma.memoryDeletionOutbox.deleteMany({ where: { userId: { in: [ownerId, foreignId] } } });
      await prisma.user.deleteMany({ where: { id: { in: [ownerId, foreignId] } } });
    }
  });
});
