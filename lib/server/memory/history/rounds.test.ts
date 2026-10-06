import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { memorySha256 } from "../persistence/lexical";
import { chunkMemoryRecallProjection } from "./chunking";
import {
  boundedMemoryRecallRoundEvidenceText,
  projectMemoryRecallRounds
} from "./rounds";
import {
  buildMemorySafeSourceSnapshot,
  type MemoryHistorySourceMessageInput
} from "./sourceProjection";

function message(input: Readonly<{
  createdAt: string;
  id: string;
  influencedByMessageIds?: readonly string[];
  parentMessageId: string | null;
  role: "assistant" | "user";
  text: string;
}>): MemoryHistorySourceMessageInput {
  return {
    chatId: "chat-rounds",
    content: textMessageContent(input.text),
    createdAt: input.createdAt,
    id: input.id,
    parentMessageId: input.parentMessageId,
    provenance: input.role === "user" ? {
      assistantId: null,
      complete: true,
      influencedByMessageIds: [],
      modelRunId: null,
      origin: "DIRECT_USER",
      taintSources: []
    } : {
      assistantId: null,
      complete: true,
      influencedByMessageIds: input.influencedByMessageIds ?? [],
      modelRunId: `run-${input.id}`,
      origin: "VISIBLE_ASSISTANT",
      taintSources: []
    },
    role: input.role,
    status: "complete",
    updatedAt: input.createdAt
  };
}

function fixture() {
  const messages = [
    message({
      createdAt: "2026-08-10T10:00:00.000Z",
      id: "u1",
      parentMessageId: null,
      role: "user",
      text: "Мария забронировала стол на 12 августа 2026 года, не на 13-е."
    }),
    message({
      createdAt: "2026-08-10T10:01:00.000Z",
      id: "a1",
      influencedByMessageIds: ["u1"],
      parentMessageId: "u1",
      role: "assistant",
      text: "Понял: бронь Марии на 12 августа 2026 года."
    }),
    message({
      createdAt: "2026-08-10T10:02:00.000Z",
      id: "u2",
      parentMessageId: "a1",
      role: "user",
      text: "Она выбрала стол у окна."
    })
  ];
  const snapshot = buildMemorySafeSourceSnapshot({
    activeLeafMessageId: "u2",
    branchGeneration: 3,
    chatId: "chat-rounds",
    folderId: null,
    messages,
    mode: "NORMAL",
    sourceContentHash: "c".repeat(64),
    sourceRevision: 4,
    timeZone: "Europe/Moscow",
    userId: "owner"
  });
  const chunks = chunkMemoryRecallProjection(snapshot).map((chunk) => ({
    ...chunk,
    id: memorySha256({ chunk: chunk.contentHash })
  }));
  return { chunks, snapshot };
}

describe("recall round projection", () => {
  it("gives a new source projection its own immutable round identity", () => {
    const { chunks, snapshot } = fixture();
    const legacySnapshot = {
      ...snapshot,
      projectionVersion: "memory-history-source-projection-v5" as typeof snapshot.projectionVersion
    };
    const legacy = projectMemoryRecallRounds(legacySnapshot, chunks);
    const current = projectMemoryRecallRounds(snapshot, chunks);

    expect(current.map((round) => round.rawSafeText)).toEqual(
      legacy.map((round) => round.rawSafeText)
    );
    expect(current.map((round) => round.evidenceRootHash)).toEqual(
      legacy.map((round) => round.evidenceRootHash)
    );
    for (const [index, round] of current.entries()) {
      expect(round.contentHash).not.toBe(legacy[index]!.contentHash);
      expect(round.id).not.toBe(legacy[index]!.id);
    }
    expect(projectMemoryRecallRounds(snapshot, chunks)).toEqual(current);
  });

  it("segments paired and standalone messages with exact ordered source maps", () => {
    const { chunks, snapshot } = fixture();
    const first = projectMemoryRecallRounds(snapshot, chunks);
    const second = projectMemoryRecallRounds(snapshot, chunks);

    expect(first).toEqual(second);
    expect(first.map((round) => round.groupKind)).toEqual(["TURN", "STANDALONE"]);
    expect(first[0]?.rawSafeText).toBe(
      "User: Мария забронировала стол на 12 августа 2026 года, не на 13-е.\n\n" +
      "Assistant: Понял: бронь Марии на 12 августа 2026 года."
    );
    expect(first[0]?.messageJoins.map((join) => ({
      end: first[0]!.rawSafeText.slice(join.roundStartOffset, join.roundEndOffset),
      id: join.messageId,
      source: [join.sourceStartOffset, join.sourceEndOffset]
    }))).toEqual([
      {
        end: "Мария забронировала стол на 12 августа 2026 года, не на 13-е.",
        id: "u1",
        source: [0, 61]
      },
      {
        end: "Понял: бронь Марии на 12 августа 2026 года.",
        id: "a1",
        source: [0, 43]
      }
    ]);
    expect(first[1]?.messageJoins.map((join) => join.messageId)).toEqual(["u2"]);
    expect(first.every((round) => chunks.some((chunk) =>
      chunk.id === round.parentChunkId))).toBe(true);
    expect(new Set(first.map((round) => round.evidenceRootHash)).size).toBe(2);
  });

  it("bounds frozen raw evidence in UTF-16 without splitting non-BMP text", () => {
    const raw = `${"x".repeat(3_999)}😀tail`;
    const bounded = boundedMemoryRecallRoundEvidenceText(raw);

    expect(bounded).toBe("x".repeat(3_999));
    expect(bounded.length).toBeLessThanOrEqual(4_000);
    expect(bounded).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("does not reapply the single-message limit after adding speaker labels", () => {
    const messages = [
      message({
        createdAt: "2026-08-10T10:00:00.000Z",
        id: "large-user",
        parentMessageId: null,
        role: "user",
        text: "x".repeat(50_000)
      }),
      message({
        createdAt: "2026-08-10T10:01:00.000Z",
        id: "large-assistant",
        influencedByMessageIds: ["large-user"],
        parentMessageId: "large-user",
        role: "assistant",
        text: "y".repeat(49_998)
      })
    ];
    const snapshot = buildMemorySafeSourceSnapshot({
      activeLeafMessageId: "large-assistant",
      branchGeneration: 0,
      chatId: "chat-rounds",
      folderId: null,
      messages,
      mode: "NORMAL",
      sourceContentHash: "d".repeat(64),
      sourceRevision: 0,
      timeZone: "UTC",
      userId: "owner"
    });
    const chunks = chunkMemoryRecallProjection(snapshot).map((chunk) => ({
      ...chunk,
      id: memorySha256({ chunk: chunk.contentHash })
    }));

    const [round] = projectMemoryRecallRounds(snapshot, chunks);
    expect(round?.rawSafeText.length).toBe(100_017);
    expect(round?.messageJoins.map(({ messageId }) => messageId)).toEqual([
      "large-user",
      "large-assistant"
    ]);
  });

  it("leaves a turn beyond round capacity to its recall chunks", () => {
    const messages = [
      message({
        createdAt: "2026-08-10T10:00:00.000Z",
        id: "huge-user",
        parentMessageId: null,
        role: "user",
        text: "Long travel diary entry, day by day. ".repeat(6_800)
      }),
      message({
        createdAt: "2026-08-10T10:01:00.000Z",
        id: "huge-assistant",
        influencedByMessageIds: ["huge-user"],
        parentMessageId: "huge-user",
        role: "assistant",
        text: "Thanks for the diary."
      }),
      message({
        createdAt: "2026-08-10T10:02:00.000Z",
        id: "small-user",
        parentMessageId: "huge-assistant",
        role: "user",
        text: "I am back in Helsinki."
      })
    ];
    const snapshot = buildMemorySafeSourceSnapshot({
      activeLeafMessageId: "small-user",
      branchGeneration: 0,
      chatId: "chat-rounds",
      folderId: null,
      messages,
      mode: "NORMAL",
      sourceContentHash: "e".repeat(64),
      sourceRevision: 0,
      timeZone: "UTC",
      userId: "owner"
    });
    const chunks = chunkMemoryRecallProjection(snapshot).map((chunk) => ({
      ...chunk,
      id: memorySha256({ chunk: chunk.contentHash })
    }));
    expect(new Set(chunks.flatMap((chunk) =>
      chunk.messageJoins.map(({ messageId }) => messageId))))
      .toEqual(new Set(["huge-user", "huge-assistant", "small-user"]));

    const rounds = projectMemoryRecallRounds(snapshot, chunks);

    expect(rounds.map((round) => ({
      messageIds: round.messageJoins.map(({ messageId }) => messageId),
      ordinal: round.ordinal
    }))).toEqual([{ messageIds: ["small-user"], ordinal: 0 }]);
  });

  it("bounds two-sided search keys without splitting non-BMP text", () => {
    const marker = " memory round continuation ";
    const leftBoundary = Math.ceil((4_000 - marker.length) / 2);
    // Put the emoji's high surrogate at the final code unit of the left slice.
    const text = `${"x".repeat(leftBoundary - "User: ".length - 1)}😀${"y".repeat(2_100)}`;
    const snapshot = buildMemorySafeSourceSnapshot({
      activeLeafMessageId: "emoji-user",
      branchGeneration: 0,
      chatId: "chat-rounds",
      folderId: null,
      messages: [message({
        createdAt: "2026-08-10T10:00:00.000Z",
        id: "emoji-user",
        parentMessageId: null,
        role: "user",
        text
      })],
      mode: "NORMAL",
      sourceContentHash: "f".repeat(64),
      sourceRevision: 0,
      timeZone: "UTC",
      userId: "owner"
    });
    const chunks = chunkMemoryRecallProjection(snapshot).map((chunk) => ({
      ...chunk,
      id: memorySha256({ chunk: chunk.contentHash })
    }));

    const [round] = projectMemoryRecallRounds(snapshot, chunks);
    expect(round?.contextualKeyState).toBe("RAW_FALLBACK");
    expect(round?.contextualSearchText.length).toBeLessThanOrEqual(4_000);
    expect(round?.contextualSearchText).toContain(marker);
    expect(round?.contextualSearchText).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("keeps the reserved tool-event kind out of visible-message projections", () => {
    const { chunks, snapshot } = fixture();
    const rounds = projectMemoryRecallRounds(snapshot, chunks);
    expect(rounds.some((round) => round.groupKind === "TOOL_EVENT")).toBe(false);
    expect(JSON.stringify(rounds)).not.toContain("tool result");
  });
});
