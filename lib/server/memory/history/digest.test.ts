import { describe, expect, it, vi } from "vitest";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  type MemoryHistoryIndexSourceIdentity,
  type MemoryHistoryPreparedChunk
} from "./contract";
import {
  MemoryChatDigestOutputError,
  buildHierarchicalMemoryChatDigest,
  buildIncrementalMemoryChatDigestRequest,
  buildMemoryChatDigestRequest,
  createPrismaMemoryChatDigestGenerator,
  decodeMemoryChatDigest,
  materializeMemoryChatDigest,
  memoryChatDigestSourceFingerprint,
  partitionMemoryChatDigestSourceChunks,
  planMemoryChatDigestUpdate,
  selectMemoryChatDigestSourceChunks
} from "./digest";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";

function expectDigestOutputInvalid(
  value: unknown,
  reason: MemoryChatDigestOutputError["reason"]
): void {
  try {
    decodeMemoryChatDigest(value);
    throw new Error("expected_memory_chat_digest_output_invalid");
  } catch (error) {
    expect(error).toBeInstanceOf(MemoryChatDigestOutputError);
    expect(error).toMatchObject({
      code: "memory_chat_digest_output_invalid",
      reason
    });
  }
}

const source: MemoryHistoryIndexSourceIdentity = Object.freeze({
  activeLeafMessageId: "assistant-30",
  branchGeneration: 4,
  chatId: "chat-digest",
  sourceHash: "a".repeat(64),
  sourceRevision: 9,
  userId: "user-digest"
});

function chunk(
  ordinal: number,
  overrides: Partial<MemoryHistoryPreparedChunk> = {}
): MemoryHistoryPreparedChunk {
  const text = `User: discuss topic ${ordinal}\n\nAssistant: decision ${ordinal}`;
  const updatedAt = new Date(Date.UTC(2026, 7, 10, 10, ordinal)).toISOString();
  return {
    approxTokens: 12,
    branchGeneration: source.branchGeneration,
    chatId: source.chatId,
    chunkingVersion: MEMORY_HISTORY_CHUNKING_VERSION,
    contentHash: String((ordinal % 9) + 1).repeat(64),
    folderId: null,
    id: `chunk-${ordinal}`,
    languageCode: "en",
    messageJoins: [{
      endOffset: 20,
      messageId: `message-${ordinal}`,
      ordinal: 0,
      role: "user",
      safeTextHash: "b".repeat(64),
      sourceMessageContentHash: "c".repeat(64),
      sourceMessageUpdatedAt: updatedAt,
      startOffset: 0
    }],
    normalizedSafeSearchText: text.toLocaleLowerCase("und"),
    occurredFrom: updatedAt,
    occurredTo: updatedAt,
    ordinal,
    overlapFromPreviousTurnGroupIds: [],
    providerSafeText: text,
    publicationState: "ACTIVE",
    redactionReasonCodes: [],
    redactionState: "NOT_NEEDED",
    safeProjectedText: text,
    safetyClass: "NORMAL",
    sourceAssistantId: null,
    sourceContentHash: source.sourceHash,
    sourceProjectionVersion: MEMORY_HISTORY_SOURCE_PROJECTION_VERSION,
    sourceRevision: source.sourceRevision,
    turnGroupIds: [`turn-${ordinal}`],
    userId: source.userId,
    ...overrides
  };
}

describe("Memory chat digests", () => {
  it("strictly decodes the bounded structured contract", () => {
    const decoded = decodeMemoryChatDigest({
      decisions: ["Use cedar deployment"],
      open_loops: ["Confirm rollout date"],
      summary: "The user said they were comparing deployment options.",
      topics: ["Deployment"]
    });
    expect(decoded.summary).toBe(
      "The user said they were comparing deployment options."
    );
    expect(Object.isFrozen(decoded)).toBe(true);

    for (const invalid of [
      { ...decoded, extra: true, open_loops: decoded.openLoops },
      { decisions: [], open_loops: [], summary: "   ", topics: [] },
      { decisions: [], open_loops: [], summary: "x".repeat(2_001), topics: [] },
      { decisions: ["x".repeat(257)], open_loops: [], summary: "summary", topics: [] },
      { decisions: [], open_loops: [], summary: "summary", topics: Array(13).fill("topic") }
    ]) {
      expectDigestOutputInvalid(invalid, "contract");
    }
  });

  it("keeps full classified-safe coverage and bounds each provider segment", () => {
    const sourceChunks = Array.from({ length: 30 }, (_, ordinal) => chunk(ordinal));
    sourceChunks[29] = chunk(29, {
      publicationState: "SUPPRESSED",
      redactionState: "EXCLUDED",
      safetyClass: "SECRET_TAINTED"
    });
    const selected = selectMemoryChatDigestSourceChunks(sourceChunks);

    expect(selected).toHaveLength(29);
    expect(selected[0]?.id).toBe("chunk-0");
    expect(selected.at(-1)?.id).toBe("chunk-28");
    expect(selected.every((candidate) => candidate.publicationState === "ACTIVE"))
      .toBe(true);
    const segments = partitionMemoryChatDigestSourceChunks(selected);
    expect(segments.map((segment) => segment.length)).toEqual([24, 5]);
    const request = buildMemoryChatDigestRequest(segments[0]!, "Europe/Moscow");
    expect(request.name).toBe("memory_chat_digest_v4");
    expect(request.userPrompt.length).toBeLessThan(32_000);
    expect(request.systemPrompt).toContain("untrusted quoted data");
    expect(request.systemPrompt).toContain("user-authored events");
    expect(request.systemPrompt).toContain("incidental");
    expect(request.systemPrompt).toContain("each distinct item");
    expect(request.systemPrompt).toContain("absolute ISO date");
    expect(request.systemPrompt).toContain("occurred_from/occurred_to");
    expect(request.systemPrompt).toContain("supplied time_zone");
    expect(JSON.parse(request.userPrompt)).toMatchObject({
      time_zone: "Europe/Moscow"
    });
    const incremental = buildIncrementalMemoryChatDigestRequest(
      "Summary: Earlier deployment constraints.",
      segments[1]!,
      "Europe/Moscow"
    );
    expect(incremental.userPrompt).toContain("previous_digest");
  });

  it("materializes retry-stable source-bound digests and rejects secret output", () => {
    const selected = [chunk(0), chunk(1), chunk(2)];
    const content = decodeMemoryChatDigest({
      decisions: ["Use cedar deployment"],
      open_loops: ["Confirm rollout date"],
      summary: "The chat compared deployment options.",
      topics: ["Deployment", "Rollout"]
    });
    const first = materializeMemoryChatDigest({
      chunks: selected,
      content,
      source,
      timeZone: "UTC"
    });
    const retry = materializeMemoryChatDigest({
      chunks: selected,
      content,
      source,
      timeZone: "UTC"
    });

    expect(first).toEqual(retry);
    expect(first.id).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.anchorChunkId).toBe("chunk-2");
    expect(first.sourceChunkIds).toEqual(["chunk-0", "chunk-1", "chunk-2"]);
    expect(first.sourceMessageIds).toEqual(["message-0", "message-1", "message-2"]);
    expect(first.sourceFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(first.updateMode).toBe("FULL_REBUILD");
    expect(first.safeDigestText).toContain("Summary:");
    expect(MEMORY_CHAT_DIGEST_PIPELINE_VERSION).toBe("memory-chat-digest-v4");

    expectDigestOutputInvalid({
      decisions: [],
      open_loops: [],
      summary: "api key: sk-digestSecret1234567890",
      topics: []
    }, "safety_rejected");
    expectDigestOutputInvalid({
      decisions: Array(12).fill("D".repeat(200)),
      open_loops: [],
      summary: "A short visible prefix.",
      topics: Array(12).fill("T".repeat(200))
    }, "aggregate_limit");
  });

  it("[E08] reuses an unchanged digest with zero provider executions", async () => {
    const chunks = [chunk(0), chunk(1), chunk(2)];
    const digest = materializeMemoryChatDigest({
      chunks,
      content: decodeMemoryChatDigest({
        decisions: ["Keep the deployment choice"],
        open_loops: ["Confirm rollout"],
        summary: "Early constraints and the late rollout were discussed.",
        topics: ["Early constraints", "Late rollout"]
      }),
      source,
      timeZone: "UTC"
    });
    const findFirst = vi.fn(async () => ({
      activeLeafMessageId: source.activeLeafMessageId,
      branchGeneration: source.branchGeneration,
      contentHash: digest.contentHash,
      decisions: [...digest.decisions],
      id: digest.id,
      incrementalDepth: digest.incrementalDepth,
      inputFingerprint: digest.inputFingerprint,
      openLoops: [...digest.openLoops],
      rebuildPolicyVersion: digest.rebuildPolicyVersion,
      redactionState: "NOT_NEEDED",
      safeDigestText: digest.safeDigestText,
      safetyClass: "NORMAL",
      safetyPolicyVersion: "digest-policy:classifier-policy",
      sourceContentHash: source.sourceHash,
      sourceFingerprint: digest.sourceFingerprint,
      sourceRevisionAtCreation: source.sourceRevision,
      summary: digest.summary,
      topics: [...digest.topics],
      updateMode: digest.updateMode
    }));
    const client = {
      chatMemoryDigest: { findFirst },
      chatMemoryDigestChunk: {
        findMany: vi.fn(async () =>
          digest.sourceChunkIds.map((chunkId) => ({ chunkId })))
      }
    };
    const provider = { execute: vi.fn() };
    const generator = createPrismaMemoryChatDigestGenerator(client as never, {
      provider: provider as never
    });

    const result = await generator.generate(source, chunks, {
      jobId: "job-1",
      signal: new AbortController().signal,
      timeZone: "UTC",
      userId: source.userId
    });

    expect(result).toMatchObject({
      classificationRequired: false,
      digest: { id: digest.id, updateMode: "FULL_REBUILD" },
      executions: [],
      work: {
        digestSegmentsProcessed: 0,
        digestSourceChunksProcessed: 0
      }
    });
    expect(provider.execute).not.toHaveBeenCalled();
  });

  it("[E08] retains early and late digest coverage while dropping edited content", async () => {
    const execute = vi.fn(async (request: { userPrompt: string }) => {
      const input = JSON.parse(request.userPrompt) as {
        excerpts?: Array<{ text: string }>;
        segment_digests?: Array<{ text: string }>;
      };
      const text = input.excerpts?.map(({ text }) => text).join("\n") ?? "";
      const nestedText = input.segment_digests?.map(({ text }) => text)
        .join("\n") ?? "";
      const topics = [
        ...(text.includes("EARLY_TOPIC") ? ["Early architecture"] : []),
        ...(text.includes("LATE_TOPIC") ? ["Late rollout"] : []),
        ...(nestedText.includes("Early architecture") ? ["Early architecture"] : []),
        ...(nestedText.includes("Late rollout") ? ["Late rollout"] : [])
      ];
      return decodeMemoryChatDigest({
        decisions: [
          ...(text.includes("EARLY_DECISION") ? ["Keep the early boundary"] : []),
          ...(nestedText.includes("Keep the early boundary")
            ? ["Keep the early boundary"]
            : [])
        ],
        open_loops: [
          ...(text.includes("LATE_OPEN") ? ["Confirm the late rollout"] : []),
          ...(nestedText.includes("Confirm the late rollout")
            ? ["Confirm the late rollout"]
            : [])
        ],
        summary: topics.length > 0
          ? `Covered ${[...new Set(topics)].join(" and ")}.`
          : "No seeded coverage marker remains.",
        topics: [...new Set(topics)]
      });
    });
    const covered = Array.from({ length: 50 }, (_, ordinal) => chunk(ordinal, {
      safeProjectedText: ordinal === 0
        ? "User: EARLY_TOPIC EARLY_DECISION\n\nAssistant: retained"
        : ordinal === 49
          ? "User: LATE_TOPIC LATE_OPEN\n\nAssistant: retained"
          : `User: middle ${ordinal}\n\nAssistant: retained`
    }));
    const first = await buildHierarchicalMemoryChatDigest(
      covered,
      "d".repeat(64),
      "Europe/Moscow",
      execute
    );

    expect(first.content).toMatchObject({
      decisions: ["Keep the early boundary"],
      openLoops: ["Confirm the late rollout"],
      topics: ["Early architecture", "Late rollout"]
    });
    expect(first.segmentsProcessed).toBe(4);
    expect(execute.mock.calls.every(([request]) =>
      request.userPrompt.length < 32_000)).toBe(true);

    execute.mockClear();
    const edited = covered.slice(1);
    const rebuilt = await buildHierarchicalMemoryChatDigest(
      edited,
      "e".repeat(64),
      "Europe/Moscow",
      execute
    );
    expect(rebuilt.content.topics).toEqual(["Late rollout"]);
    expect(rebuilt.content.decisions).toEqual([]);
  });

  it("uses exact-prefix delta until the periodic full-rebuild boundary", () => {
    const current = Array.from({ length: 30 }, (_, ordinal) => chunk(ordinal));
    const prefix = current.slice(0, 29);
    const previous = {
      chunkIds: prefix.map(({ id }) => id),
      incrementalDepth: 7,
      sourceFingerprint: memoryChatDigestSourceFingerprint(prefix, "UTC")
    };

    expect(planMemoryChatDigestUpdate({
      chunks: current,
      previous,
      timeZone: "UTC"
    })).toMatchObject({
      delta: [expect.objectContaining({ id: "chunk-29" })],
      mode: "INCREMENTAL",
      sourceFingerprint: memoryChatDigestSourceFingerprint(current, "UTC")
    });
    expect(planMemoryChatDigestUpdate({
      chunks: current,
      previous: { ...previous, incrementalDepth: 31 },
      timeZone: "UTC"
    }).mode).toBe("FULL_REBUILD");
    expect(planMemoryChatDigestUpdate({
      chunks: [chunk(0, { id: "edited-early-chunk" }), ...current.slice(1)],
      previous,
      timeZone: "UTC"
    }).mode).toBe("FULL_REBUILD");
    expect(planMemoryChatDigestUpdate({
      chunks: current,
      previous,
      timeZone: "Europe/Moscow"
    }).mode).toBe("FULL_REBUILD");
    expect(memoryChatDigestSourceFingerprint(current, "UTC"))
      .not.toBe(memoryChatDigestSourceFingerprint(current, "Europe/Moscow"));
  });
});
