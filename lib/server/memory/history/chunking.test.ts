import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { memorySha256 } from "../persistence/lexical";
import {
  chunkMemoryRecallProjection,
  MemoryHistoryChunkingError
} from "./chunking";
import {
  buildMemorySafeSourceSnapshot,
  type MemoryHistorySourceMessageInput,
  type MemorySafeSourceSnapshot
} from "./sourceProjection";

const SOURCE_HASH = "b".repeat(64);

function multiTurnSnapshot(
  count: number,
  textFor?: (role: "assistant" | "user", ordinal: number) => string
): MemorySafeSourceSnapshot {
  const messages: MemoryHistorySourceMessageInput[] = [];
  let parentMessageId: string | null = null;
  for (let ordinal = 0; ordinal < count; ordinal += 1) {
    const userId = `user-${ordinal}`;
    const assistantId = `assistant-${ordinal}`;
    const userTime = new Date(Date.UTC(2026, 7, 10, 10, ordinal * 2)).toISOString();
    const assistantTime = new Date(Date.UTC(2026, 7, 10, 10, ordinal * 2 + 1))
      .toISOString();
    messages.push({
      chatId: "chat-chunks",
      content: textMessageContent(textFor?.("user", ordinal) ??
        `Поворот ${ordinal}: не менять дату 10.08.2026, данные данные данные.`),
      createdAt: userTime,
      id: userId,
      parentMessageId,
      provenance: {
        complete: true,
        influencedByMessageIds: [],
        modelRunId: null,
        origin: "DIRECT_USER",
        taintSources: []
      },
      role: "user",
      status: "complete",
      updatedAt: userTime
    });
    messages.push({
      chatId: "chat-chunks",
      content: textMessageContent(textFor?.("assistant", ordinal) ??
        `Ответ ${ordinal}: дату 10.08.2026 не меняю, контекст сохранён.`),
      createdAt: assistantTime,
      id: assistantId,
      parentMessageId: userId,
      provenance: {
        complete: true,
        influencedByMessageIds: [userId],
        modelRunId: `run-${ordinal}`,
        origin: "VISIBLE_ASSISTANT",
        taintSources: []
      },
      role: "assistant",
      status: "complete",
      updatedAt: assistantTime
    });
    parentMessageId = assistantId;
  }
  return buildMemorySafeSourceSnapshot({
    activeLeafMessageId: parentMessageId,
    branchGeneration: 7,
    chatId: "chat-chunks",
    folderId: "folder-chunks",
    messages,
    mode: "NORMAL",
    sourceContentHash: SOURCE_HASH,
    sourceRevision: 11,
    timeZone: "Europe/Moscow",
    userId: "user-owner"
  });
}

describe("Memory history recall chunking", () => {
  it("uses deterministic whole-turn overlap with exact message joins", () => {
    const snapshot = multiTurnSnapshot(4);
    const options = {
      maxApproxTokens: 512,
      maxCharacters: 350,
      maxMessagesPerChunk: 4,
      maxTurnGroupsPerChunk: 2,
      overlapTurnGroups: 1
    };

    const first = chunkMemoryRecallProjection(snapshot, options);
    const second = chunkMemoryRecallProjection(snapshot, options);
    const groupIds = snapshot.recallEpisodeProjection.turnGroups.map((group) => group.id);

    expect(first).toEqual(second);
    expect(first.map((chunk) => chunk.turnGroupIds)).toEqual([
      [groupIds[0], groupIds[1]],
      [groupIds[1], groupIds[2]],
      [groupIds[2], groupIds[3]]
    ]);
    expect(first.map((chunk) => chunk.overlapFromPreviousTurnGroupIds)).toEqual([
      [],
      [groupIds[1]],
      [groupIds[2]]
    ]);
    for (const chunk of first) {
      expect(chunk.safeProjectedText.length).toBeLessThanOrEqual(350);
      expect(chunk.approxTokens).toBeLessThanOrEqual(512);
      expect(chunk.providerSafeText).toBe(chunk.safeProjectedText);
      expect(chunk.contentHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(chunk.branchGeneration).toBe(7);
      expect(chunk.sourceRevision).toBe(11);
      expect(chunk.messageJoins).toHaveLength(4);
      expect(chunk.messageJoins.map((join) => join.ordinal)).toEqual([0, 1, 2, 3]);
      for (const join of chunk.messageJoins) {
        const sourceMessage = snapshot.recallEpisodeProjection.turnGroups
          .flatMap((group) => group.messages)
          .find((message) => message.id === join.messageId);
        expect(sourceMessage).toBeDefined();
        expect(join.startOffset).toBe(0);
        expect(join.endOffset).toBe(sourceMessage?.safeText.length);
        expect(join.safeTextHash).toBe(sourceMessage?.safeTextHash);
      }
    }
  });

  it("splits oversized multilingual turns within both character and token bounds", () => {
    const snapshot = multiTurnSnapshot(1, (role) => role === "user"
      ? "😀Привет без изменения смысла. ".repeat(80)
      : "Не удаляй дату 10.08.2026 и отрицание. ".repeat(40));
    const chunks = chunkMemoryRecallProjection(snapshot, {
      maxApproxTokens: 64,
      maxCharacters: 256,
      maxMessagesPerChunk: 2,
      maxTurnGroupsPerChunk: 1,
      overlapTurnGroups: 0
    });
    const messages = new Map(
      snapshot.recallEpisodeProjection.turnGroups[0]?.messages.map((message) =>
        [message.id, message.safeText]) ?? []
    );

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.some((chunk) => chunk.safeProjectedText.includes("10.08.2026")))
      .toBe(true);
    for (const chunk of chunks) {
      expect(chunk.safeProjectedText.length).toBeLessThanOrEqual(256);
      expect(chunk.approxTokens).toBeLessThanOrEqual(64);
      expect(chunk.turnGroupIds).toHaveLength(1);
      for (const join of chunk.messageJoins) {
        const sourceText = messages.get(join.messageId);
        if (!sourceText) throw new Error("missing source message fixture");
        const firstCodeUnit = sourceText.charCodeAt(join.startOffset);
        const lastCodeUnit = sourceText.charCodeAt(join.endOffset - 1);
        expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
        expect(lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff).toBe(false);
      }
    }

    for (const [messageId, sourceText] of messages) {
      const joins = chunks.flatMap((chunk) => chunk.messageJoins)
        .filter((join) => join.messageId === messageId)
        .sort((left, right) => left.startOffset - right.startOffset);
      expect(joins[0]?.startOffset).toBe(0);
      expect(joins.at(-1)?.endOffset).toBe(sourceText.length);
      for (let index = 1; index < joins.length; index += 1) {
        expect(joins[index]?.startOffset).toBe(joins[index - 1]?.endOffset);
      }
    }
  });

  it("re-screens a forged secret-bearing safe projection before any provider text exists", () => {
    const snapshot = multiTurnSnapshot(1);
    const group = snapshot.recallEpisodeProjection.turnGroups[0];
    if (!group) throw new Error("missing turn group fixture");
    const secret = "api key: sk-forgedHistorySecret123456";
    const forgedUser = {
      ...group.messages[0],
      languageCode: "en" as const,
      providerSafeText: secret,
      safeText: secret,
      safeTextHash: memorySha256(secret)
    };
    const combined = `${secret}\n\n${group.messages[1].safeText}`;
    const forgedGroup = {
      ...group,
      messages: [forgedUser, group.messages[1]] as const,
      safeTextHash: memorySha256(combined)
    };
    const forgedSnapshot: MemorySafeSourceSnapshot = {
      ...snapshot,
      recallEpisodeProjection: {
        projectionHash: memorySha256([forgedGroup]),
        turnGroups: [forgedGroup]
      }
    };

    const chunks = chunkMemoryRecallProjection(forgedSnapshot);

    expect(chunks).toEqual([]);
    expect(JSON.stringify(chunks)).not.toContain("forgedHistorySecret");
  });

  it("drops a chunk when a secret assignment appears only across safe turn groups", () => {
    const snapshot = multiTurnSnapshot(2, (role, ordinal) => {
      if (ordinal === 0) return role === "user" ? "Store a label." : "The password:";
      return role === "user" ? "correct-horse-battery" : "Acknowledged.";
    });

    expect(snapshot.recallEpisodeProjection.turnGroups).toHaveLength(2);
    expect(chunkMemoryRecallProjection(snapshot)).toEqual([]);
  });

  it("rejects unbounded or overlap-only chunking configurations", () => {
    const snapshot = multiTurnSnapshot(1);

    expect(() => chunkMemoryRecallProjection(snapshot, { maxCharacters: 4_001 }))
      .toThrowError(new MemoryHistoryChunkingError(
        "memory_history_chunking_options_invalid"
      ));
    expect(() => chunkMemoryRecallProjection(snapshot, {
      maxTurnGroupsPerChunk: 1,
      overlapTurnGroups: 1
    })).toThrowError(new MemoryHistoryChunkingError(
      "memory_history_chunking_options_invalid"
    ));
  });
});
