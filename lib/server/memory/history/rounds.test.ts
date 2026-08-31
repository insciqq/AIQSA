import { describe, expect, it } from "vitest";
import { textMessageContent } from "../../../domain/content";
import { memorySha256 } from "../persistence/lexical";
import { chunkMemoryRecallProjection } from "./chunking";
import {
  buildMemoryContextualKeyRequest,
  decodeMemoryContextualKeyOutputs,
  partitionMemoryContextualKeyInputs
} from "./contextualKeys";
import {
  memoryQualificationLanguageBucket,
  normalizeMemoryLanguageCode
} from "./language";
import {
  applyMemoryRecallRoundContextualKeys,
  applyMemoryRecallRoundContextualKeysWithDiagnostics,
  boundedMemoryRecallRoundEvidenceText,
  memoryContextualRoundInputs,
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

  it("uses at most two prior groups and falls back per invalid provider item", () => {
    const { chunks, snapshot } = fixture();
    const rounds = projectMemoryRecallRounds(snapshot, chunks).map((round) => ({
      ...round,
      publicationState: "ACTIVE" as const
    }));
    const inputs = memoryContextualRoundInputs(rounds);
    expect(inputs[0]?.prior).toEqual([]);
    expect(inputs[1]?.prior.map((round) => round.id)).toEqual([rounds[0]?.id]);

    const applied = applyMemoryRecallRoundContextualKeysWithDiagnostics(rounds, [
      {
        languageCode: "ru",
        roundId: rounds[1]!.id,
        statements: [{
          sourceRoundIds: [rounds[0]!.id, rounds[1]!.id],
          text: "Мария выбрала стол у окна 12 августа 2026 года."
        }]
      },
      {
        languageCode: "ru",
        roundId: rounds[0]!.id,
        statements: [{
          sourceRoundIds: [rounds[0]!.id],
          text: "Мария забронировала стол на 14 августа 2026 года."
        }]
      }
    ], "memory-contextual-test-v1");
    const projected = applied.rounds;

    expect(applied.fallbackDiagnostics).toEqual(expect.arrayContaining([
      { reason: "UNSUPPORTED_DATE", roundId: rounds[0]!.id },
      { reason: "UNSUPPORTED_NUMBER", roundId: rounds[0]!.id }
    ]));
    expect(projected[0]?.contextualKeyState).toBe("RAW_FALLBACK");
    expect(projected[0]?.contextualSearchText).toContain("мария забронировала");
    expect(projected[1]).toMatchObject({
      contextualKeyPolicyVersion: "memory-contextual-test-v1",
      contextualKeyState: "GENERATED"
    });
    expect(projected[1]?.contextualSearchText).toContain("мария выбрала стол у окна");
    expect(projected[1]?.contextualSearchText).toContain("она выбрала стол у окна");
    expect(projected[1]?.supportingRoundIds).toEqual([rounds[0]!.id]);
  });

  it("grounds every contextual statement only in its cited raw rounds", () => {
    const { chunks, snapshot } = fixture();
    const rounds = projectMemoryRecallRounds(snapshot, chunks).map((round) => ({
      ...round,
      publicationState: "ACTIVE" as const
    }));
    const currentOnly = applyMemoryRecallRoundContextualKeysWithDiagnostics(rounds, [{
      languageCode: "ru",
      roundId: rounds[1]!.id,
      statements: [{
        sourceRoundIds: [rounds[1]!.id],
        text: "Мария выбрала стол у окна"
      }]
    }], "memory-contextual-test-v2");
    expect(currentOnly.rounds[1]?.contextualKeyState).toBe("RAW_FALLBACK");
    expect(currentOnly.fallbackDiagnostics).toContainEqual({
      reason: "UNSUPPORTED_TOKEN",
      roundId: rounds[1]!.id
    });
    expect(currentOnly.fallbackDiagnostics.some(({ roundId }) =>
      roundId === rounds[0]!.id)).toBe(false);

    const missingCurrent = applyMemoryRecallRoundContextualKeysWithDiagnostics(rounds, [{
      languageCode: "ru",
      roundId: rounds[1]!.id,
      statements: [{
        sourceRoundIds: [rounds[0]!.id],
        text: "Мария забронировала стол"
      }]
    }], "memory-contextual-test-v2");
    expect(missingCurrent.rounds[1]?.contextualKeyState).toBe("RAW_FALLBACK");
    expect(missingCurrent.fallbackDiagnostics).toContainEqual({
      reason: "SOURCE_REF_INVALID",
      roundId: rounds[1]!.id
    });
  });

  it("classifies unsupported entities and duplicate statements without relaxing grounding", () => {
    const { chunks, snapshot } = fixture();
    const rounds = projectMemoryRecallRounds(snapshot, chunks).map((round) => ({
      ...round,
      publicationState: "ACTIVE" as const
    }));
    const unsupportedEntity = applyMemoryRecallRoundContextualKeysWithDiagnostics(
      rounds,
      [{
        languageCode: "ru",
        roundId: rounds[1]!.id,
        statements: [{
          sourceRoundIds: [rounds[1]!.id],
          text: "Елена выбрала стол у окна"
        }]
      }],
      "memory-contextual-test-v3"
    );
    expect(unsupportedEntity.fallbackDiagnostics).toEqual(expect.arrayContaining([
      { reason: "UNSUPPORTED_ENTITY", roundId: rounds[1]!.id },
      { reason: "UNSUPPORTED_TOKEN", roundId: rounds[1]!.id }
    ]));

    const duplicate = applyMemoryRecallRoundContextualKeysWithDiagnostics(
      rounds,
      [{
        languageCode: "ru",
        roundId: rounds[1]!.id,
        statements: [
          {
            sourceRoundIds: [rounds[1]!.id],
            text: "Она выбрала стол у окна"
          },
          {
            sourceRoundIds: [rounds[1]!.id],
            text: "  ОНА   ВЫБРАЛА СТОЛ У ОКНА  "
          }
        ]
      }],
      "memory-contextual-test-v3"
    );
    expect(duplicate.fallbackDiagnostics).toContainEqual({
      reason: "DUPLICATE_STATEMENT",
      roundId: rounds[1]!.id
    });
    expect(duplicate.rounds[1]?.contextualKeyState).toBe("RAW_FALLBACK");
  });

  it("preserves arbitrary BCP-47 languages and buckets only qualification metrics", () => {
    expect(normalizeMemoryLanguageCode("es")).toBe("es");
    expect(normalizeMemoryLanguageCode("sr-cyrl")).toBe("sr-Cyrl");
    expect(normalizeMemoryLanguageCode("mul")).toBe("mixed");
    expect(normalizeMemoryLanguageCode("not_a_language")).toBeNull();
    expect(memoryQualificationLanguageBucket("es")).toBe("declared");
    expect(memoryQualificationLanguageBucket("sr-Cyrl")).toBe("declared");
    expect(memoryQualificationLanguageBucket("en-GB")).toBe("declared");
  });

  it("batches opaque contextual requests and rejects reordered provider handles", () => {
    const { chunks, snapshot } = fixture();
    const base = projectMemoryRecallRounds(snapshot, chunks).map((round) => ({
      ...round,
      publicationState: "ACTIVE" as const
    }));
    const rounds = Array.from({ length: 9 }, (_, ordinal) => ({
      ...base[ordinal % base.length]!,
      id: memorySha256({ ordinal, type: "contextual-round-test" }),
      rawSafeText: `User: contextual memory ${ordinal}`
    }));
    const targetIds = rounds.map(({ id }) => id);
    const partitioned = partitionMemoryContextualKeyInputs(rounds, targetIds);

    expect(partitioned.batches.map((batch) => batch.length)).toEqual([8, 1]);
    expect(partitioned.fallbackRoundIds).toEqual([]);
    const firstBatch = partitioned.batches[0]!;
    const built = buildMemoryContextualKeyRequest(firstBatch);
    expect(built.handles).toEqual(Array.from({ length: 8 }, (_, index) => `r${index}`));
    expect(built.request.systemPrompt).toContain("untrusted quoted data");
    expect(built.request.userPrompt).not.toContain(rounds[0]!.id);

    const output = {
      rounds: built.handles.map((handle, ordinal) => ({
        handle,
        language_code: ordinal === 0 ? "sr-Cyrl" : "en",
        statements: [{
          source_refs: [`${handle}c`],
          text: `User contextual memory ${ordinal}`
        }]
      }))
    };
    expect(decodeMemoryContextualKeyOutputs(output, firstBatch, built.handles))
      .toHaveLength(8);
    expect(decodeMemoryContextualKeyOutputs(output, firstBatch, built.handles)[0])
      .toMatchObject({
        languageCode: "sr-Cyrl",
        roundId: firstBatch[0]!.roundId,
        statements: [{
          sourceRoundIds: [firstBatch[0]!.input.current.id],
          text: "User contextual memory 0"
        }]
      });
    expect(() => decodeMemoryContextualKeyOutputs({
      rounds: [...output.rounds].reverse()
    }, firstBatch, built.handles)).toThrow("memory_contextual_key_output_invalid");
  });

  it("uses the same eligible prior-round window for generation and grounding", () => {
    const { chunks, snapshot } = fixture();
    const [prior, current] = projectMemoryRecallRounds(snapshot, chunks);
    const rounds = [
      {
        ...prior!,
        id: "eligible-prior",
        publicationState: "ACTIVE" as const,
        rawSafeText: "User: Мария выбрала стол"
      },
      {
        ...prior!,
        id: "suppressed-one",
        publicationState: "SUPPRESSED" as const,
        rawSafeText: "User: excluded one",
        redactionState: "EXCLUDED" as const,
        safetyClass: "SECRET_TAINTED" as const
      },
      {
        ...prior!,
        id: "suppressed-two",
        publicationState: "SUPPRESSED" as const,
        rawSafeText: "User: excluded two",
        redactionState: "EXCLUDED" as const,
        safetyClass: "SECRET_TAINTED" as const
      },
      {
        ...current!,
        id: "eligible-current",
        publicationState: "ACTIVE" as const,
        rawSafeText: "User: Она выбрала окно"
      }
    ];
    const partitioned = partitionMemoryContextualKeyInputs(rounds, ["eligible-current"]);

    expect(partitioned.batches[0]?.[0]?.input.prior.map(({ id }) => id))
      .toEqual(["eligible-prior"]);
    const projected = applyMemoryRecallRoundContextualKeys(rounds, [{
      languageCode: "ru",
      roundId: "eligible-current",
      statements: [{
        sourceRoundIds: ["eligible-prior", "eligible-current"],
        text: "Мария выбрала окно"
      }]
    }], "memory-contextual-test-v1");
    expect(projected[3]?.contextualKeyState).toBe("GENERATED");
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

  it("bounds two-sided search keys without splitting non-BMP text", () => {
    const contextualFraming = "Contextual narrative:\nx\n\nRaw round:\n";
    const continuationMarker = " memory round continuation ";
    const leftBoundary = Math.ceil((4_000 - continuationMarker.length) / 2);
    // Put the emoji's high surrogate at the final code unit of the left slice.
    const fillerLength = leftBoundary - contextualFraming.length - 1;
    const rawSafeText = `${"x".repeat(fillerLength)}😀${"y".repeat(2_100)}`;
    const [round] = applyMemoryRecallRoundContextualKeys([{
      contextualKeyPolicyVersion: "memory-contextual-test-v1",
      contextualKeyState: "RAW_FALLBACK" as const,
      contextualNarrativeText: rawSafeText,
      contextualSearchHash: memorySha256(rawSafeText),
      contextualSearchText: rawSafeText,
      id: "round-utf16",
      languageCode: "en",
      publicationState: "ACTIVE" as const,
      rawSafeText,
      redactionState: "NOT_NEEDED" as const,
      safetyClass: "NORMAL" as const,
      supportingRoundIds: []
    }], [{
      languageCode: "en",
      roundId: "round-utf16",
      statements: [{ sourceRoundIds: ["round-utf16"], text: "x" }]
    }],
    "memory-contextual-test-v1");

    expect(round?.contextualSearchText.length).toBeLessThanOrEqual(4_000);
    expect(round?.contextualSearchText).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("keeps the reserved tool-event kind out of visible-message projections", () => {
    const { chunks, snapshot } = fixture();
    const rounds = projectMemoryRecallRounds(snapshot, chunks);
    expect(rounds.some((round) => round.groupKind === "TOOL_EVENT")).toBe(false);
    expect(JSON.stringify(rounds)).not.toContain("tool result");
  });
});
