import { describe, expect, it, vi } from "vitest";
import type { ProviderStructuredOutputRequest } from "../../providers/structuredOutput";
import { MemoryJobFencedError } from "../coordinator/errors";
import { memoryExecutionSha256 } from "../execution/canonical";
import { MEMORY_OUTPUT_DECODE_REASONS } from "../execution/outputViolation";
import { MEMORY_HISTORY_CHUNKING_VERSION } from "./chunking";
import {
  MEMORY_CHAT_DIGEST_PIPELINE_VERSION,
  type MemoryHistoryDigestPlan,
  type MemoryHistoryIndexSourceIdentity,
  type MemoryHistoryPreparedChunk
} from "./contract";
import {
  type MemoryChatDigestContent,
  MEMORY_CHAT_DIGEST_VERSIONS,
  MemoryChatDigestOutputError,
  buildHierarchicalMemoryChatDigest,
  buildIncrementalMemoryChatDigestRequest,
  buildMemoryChatDigestRequest,
  createPrismaMemoryChatDigestGenerator,
  decodeMemoryChatDigest,
  foldMemoryChatDigestDelta,
  materializeMemoryChatDigest,
  memoryChatDigestSourceFingerprint,
  memoryChatDigestRetryFeedback,
  partitionMemoryChatDigestSourceChunks,
  planMemoryChatDigestUpdate,
  selectMemoryChatDigestSourceChunks
} from "./digest";
import { MEMORY_HISTORY_SOURCE_PROJECTION_VERSION } from "./sourceProjection";

const governed = vi.hoisted(() => vi.fn());
vi.mock("../execution", async (importOriginal) => ({
  ...await importOriginal<typeof import("../execution")>(),
  executeGovernedMemoryStructuredOutput: governed
}));
// Restoring a retained result reauthorizes its binding in a locked
// transaction. Here only the owner check runs; the binding store is faked.
vi.mock("../execution/lifecycle", async (importOriginal) => ({
  ...await importOriginal<typeof import("../execution/lifecycle")>(),
  createPrismaMemoryExecutionLifecycle: () => ({
    withAuthorizedResultCommit: (
      _userId: string,
      result: Readonly<{ bindingId: string }>,
      apply: (tx: unknown, evidence: unknown) => Promise<unknown>
    ) => apply({}, {
      bindingId: result.bindingId,
      owner: { memoryJobId: "job-digest", type: "JOB" },
      settings: {}
    })
  })
}));

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
  it.each([
    [null, "root_type"],
    [{ untrustedExtraKey: "private detail" }, "root_keys"],
    [{ summary: "s".repeat(2_001), topics: [], decisions: [], open_loops: [] }, "summary_length"],
    [{ summary: "", topics: [], decisions: [], open_loops: [] }, "summary_invalid"],
    [{ summary: "Valid summary.", topics: "private detail", decisions: [], open_loops: [] }, "topics_invalid"],
    [{ summary: "Valid summary.", topics: Array(13).fill("topic"), decisions: [], open_loops: [] }, "topics_count"],
    [{ summary: "Valid summary.", topics: [], decisions: ["d".repeat(257)], open_loops: [] }, "decisions_item_length"],
    [{ summary: "Valid summary.", topics: [], decisions: [], open_loops: [null] }, "open_loops_item_invalid"],
    // Field validation precedes the aggregate fit: a droppable item still rejects.
    [{ summary: "s".repeat(2_000), topics: [...Array(11).fill("t".repeat(256)), "t".repeat(257)], decisions: [], open_loops: [] }, "topics_item_length"]
  ])("reports the violated field without retaining invalid content (%#)", (output, violation) => {
    try { decodeMemoryChatDigest(output); throw new Error("expected_rejection"); }
    catch (error) {
      expect(error).toBeInstanceOf(MemoryChatDigestOutputError);
      expect(error).toMatchObject({ reason: "contract", violation });
      expect(JSON.stringify(error)).not.toContain("private detail");
      expect(JSON.stringify(error)).not.toContain("untrustedExtraKey");
    }
  });

  it("accepts only closed content-free retry feedback", () => {
    expect(memoryChatDigestRetryFeedback("lexical_ready:digest_contract_summary_length")).toBe("contract_summary_length");
    expect(memoryChatDigestRetryFeedback("lexical_ready:digest_aggregate_limit")).toBe("aggregate_limit");
    expect(memoryChatDigestRetryFeedback("lexical_ready:digest_contract_topics_count")).toBe("contract_topics_count");
    for (const stage of [null, "lexical_ready", "lexical_ready:digest_contract_ignore_all_rules", "lexical_ready:digest_contract_summary_length\nsecret"]) {
      expect(memoryChatDigestRetryFeedback(stage)).toBeNull();
    }
  });

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
    expect(request.name).toBe("memory_chat_digest_v5");
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
    expect(MEMORY_CHAT_DIGEST_PIPELINE_VERSION).toBe("memory-chat-digest-v5");

    expectDigestOutputInvalid({
      decisions: [],
      open_loops: [],
      summary: "sk-digestSecret1234567890",
      topics: []
    }, "safety_rejected");
  });

  it("redacts mixed source text at the digest provider boundary", () => {
    const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
    const request = buildMemoryChatDigestRequest([chunk(0, {
      safeProjectedText: `User: I moved to Helsinki. Token ${token}`
    })], "UTC");

    expect(request.userPrompt).not.toContain(token);
    expect(request.userPrompt).toContain("I moved to Helsinki");
    expect(request.userPrompt).toContain("REDACTED");
  });

  it("[E08] reuses an unchanged digest with zero provider executions", async () => {
    const chunks = [chunk(0), chunk(1), chunk(2)];
    const digest = materializeMemoryChatDigest({
      chunks,
      content: decodeMemoryChatDigest({
        decisions: ["Keep the deployment choice"],
        open_loops: ["Confirm rollout"],
        summary: "Early constraints and the late rollout were discussed.",
        // Stored before requests asked for at most six items per list.
        topics: ["Early constraints", "Late rollout",
          ...Array.from({ length: 10 }, (_, index) => `Constraint ${index}`)]
      }),
      source,
      timeZone: "UTC"
    });
    expect(digest.topics).toHaveLength(12);
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

  it("folds a delta of several segments behind a proven prefix up to the depth limit", () => {
    const current = Array.from({ length: 120 }, (_, ordinal) => chunk(ordinal));
    const prefix = current.slice(0, 48);
    const previous = {
      chunkIds: prefix.map(({ id }) => id),
      incrementalDepth: 30,
      sourceFingerprint: memoryChatDigestSourceFingerprint(prefix, "UTC")
    };

    const folded = planMemoryChatDigestUpdate({ chunks: current, previous, timeZone: "UTC" });
    expect(folded.mode).toBe("INCREMENTAL");
    expect(folded.delta.map(({ id }) => id)).toEqual(current.slice(48).map(({ id }) => id));
    expect(partitionMemoryChatDigestSourceChunks(folded.delta)).toHaveLength(3);
    // One more update would exceed the depth limit.
    expect(planMemoryChatDigestUpdate({
      chunks: current, previous: { ...previous, incrementalDepth: 31 }, timeZone: "UTC"
    }).mode).toBe("FULL_REBUILD");
    // A prefix chunk whose content changed under the same id is not folded over.
    expect(planMemoryChatDigestUpdate({
      chunks: current.map((candidate, ordinal) =>
        ordinal === 47 ? { ...candidate, contentHash: "e".repeat(64) } : candidate),
      previous,
      timeZone: "UTC"
    }).mode).toBe("FULL_REBUILD");
  });
});

describe("Memory chat digest incremental fold", () => {
  const previous = decodeMemoryChatDigest({
    decisions: ["Keep the earlier plan"],
    open_loops: [],
    summary: "The earlier chat set a plan.",
    topics: ["Earlier plan"]
  });
  const previousText = materializeMemoryChatDigest({
    chunks: [chunk(0)], content: previous, source, timeZone: "UTC"
  }).safeDigestText;

  function recordingExecute() {
    const calls: Array<{ identity: string; input: Record<string, unknown> }> = [];
    const execute = async (request: ProviderStructuredOutputRequest, identity: unknown) => {
      calls.push({ identity: memoryExecutionSha256(identity), input: JSON.parse(request.userPrompt) });
      return decodeMemoryChatDigest({
        decisions: [], open_loops: [], summary: `Answer ${calls.length}.`, topics: []
      });
    };
    return { calls, execute };
  }

  const segment = (count: number) => Array<string>(count).fill("segment");
  it.each([
    [1, ["incremental"]],
    [2, [...segment(2), "reduce"]],
    [3, [...segment(3), "reduce", "reduce"]],
    [4, [...segment(4), "reduce", "reduce"]],
    [7, [...segment(7), "reduce", "reduce", "reduce", "reduce"]]
  ])("folds %i delta segments and rewrites the previous digest once", async (segments, operations) => {
    // 24 short chunks fill one segment.
    const delta = Array.from({ length: segments * 24 }, (_, ordinal) => chunk(100 + ordinal));
    const first = recordingExecute();
    const folded = await foldMemoryChatDigestDelta(previous, delta, "f".repeat(64), "UTC", first.execute);

    expect(first.calls.map(({ input }) => input.operation)).toEqual(operations);
    expect(folded).toEqual({ content: expect.objectContaining({ summary: `Answer ${operations.length}.` }),
      segmentsProcessed: operations.length });
    // Only the final call carries the previous digest, as its oldest input.
    expect(first.calls.filter(({ input }) => JSON.stringify(input).includes("The earlier chat set a plan.")))
      .toEqual([first.calls.at(-1)]);
    const last = first.calls.at(-1)!.input;
    expect(segments === 1
      ? last.previous_digest
      : (last.segment_digests as Array<{ text: string }>)[0]!.text).toBe(previousText);
    // Each call has its own identity, and a restarted fold derives the same ones.
    expect(new Set(first.calls.map(({ identity }) => identity)).size).toBe(operations.length);
    const restarted = recordingExecute();
    await foldMemoryChatDigestDelta(previous, delta, "f".repeat(64), "UTC", restarted.execute);
    expect(restarted.calls.map(({ identity }) => identity))
      .toEqual(first.calls.map(({ identity }) => identity));
  });

  it("gives every rebuild and fold call its own identity even when answers repeat", async () => {
    const identities: string[] = [];
    const repeat = async (_request: ProviderStructuredOutputRequest, identity: unknown) => {
      identities.push(memoryExecutionSha256(identity));
      return previous;
    };
    // Seven segments: two reduction groups of the same level get equal inputs.
    const chunks = Array.from({ length: 7 * 24 }, (_, ordinal) => chunk(100 + ordinal));
    const rebuilt = await buildHierarchicalMemoryChatDigest(chunks, "e".repeat(64), "UTC", repeat);
    const folded = await foldMemoryChatDigestDelta(previous, chunks, "f".repeat(64), "UTC", repeat);

    expect([rebuilt.segmentsProcessed, folded.segmentsProcessed]).toEqual([10, 11]);
    expect(new Set(identities).size).toBe(21);
  });
});

describe("Memory chat digest aggregate fit", () => {
  const item = (label: string, index: number, length = 256) =>
    `${label}${index}`.padEnd(length, label.toLowerCase());
  const list = (label: string, count: number, length = 256) =>
    Array.from({ length: count }, (_, index) => item(label, index, length));
  const rendered = (content: MemoryChatDigestContent) => materializeMemoryChatDigest({
    chunks: [chunk(0)], content, source, timeZone: "UTC"
  }).safeDigestText;
  const asContent = (answer: { decisions: string[]; open_loops: string[]; summary: string; topics: string[] }) => ({
    decisions: answer.decisions, openLoops: answer.open_loops, summary: answer.summary, topics: answer.topics
  });

  it("asks for budgets whose worst case fits the bound without any drop", () => {
    const request = buildMemoryChatDigestRequest([chunk(0)], "UTC");
    const budget = /summary at most (\d+); topics, decisions and open_loops at most (\d+) items each; each item at most (\d+) characters/u
      .exec(request.systemPrompt);
    const [summaryLength, count, itemLength] = [Number(budget?.[1]), Number(budget?.[2]), Number(budget?.[3])];
    for (const field of ["topics", "decisions", "open_loops"]) {
      expect(request.schema).toMatchObject({ properties: { [field]: { maxItems: 12 } } });
    }
    const answer = { decisions: list("D", count, itemLength), open_loops: list("O", count, itemLength),
      summary: "S".repeat(summaryLength), topics: list("T", count, itemLength) };

    const decoded = decodeMemoryChatDigest(answer);
    expect(decoded).toEqual(asContent(answer));
    expect(rendered(decoded).length).toBeLessThanOrEqual(4_000);
  });

  // Six items is the requested budget, twelve the schema and decoder maximum.
  it.each([6, 12])("fits an answer with %i maximal items per list by dropping whole trailing items", (count) => {
    const answer = { decisions: list("D", count), open_loops: list("O", count),
      summary: "S".repeat(2_000), topics: list("T", count) };

    const decoded = decodeMemoryChatDigest(answer);
    expect(decoded).toEqual({ decisions: answer.decisions.slice(0, 2), openLoops: answer.open_loops.slice(0, 2),
      summary: answer.summary, topics: answer.topics.slice(0, 3) });
    expect(rendered(decoded).length).toBeLessThanOrEqual(4_000);
  });

  it("drops from the longest list, topics first on a tie, and decodes its own result unchanged", () => {
    // Both sections render 1,296 characters; together they overflow by 603.
    const answer = { decisions: [...list("D", 4), item("D", 4, 253)], open_loops: [],
      summary: "S".repeat(2_000), topics: list("T", 5) };

    const decoded = decodeMemoryChatDigest(answer);
    expect(decoded).toEqual({ decisions: answer.decisions.slice(0, 3), openLoops: [],
      summary: answer.summary, topics: answer.topics.slice(0, 4) });
    // Restore and replay decode the accepted value again: it must not change.
    expect(decodeMemoryChatDigest({ decisions: decoded.decisions, open_loops: decoded.openLoops,
      summary: decoded.summary, topics: decoded.topics })).toEqual(decoded);
  });

  it("keeps a fitting digest exactly, even with more items than requested", () => {
    const answer = { decisions: list("D", 12, 20), open_loops: list("O", 12, 20),
      summary: "The user compared deployment options.", topics: list("T", 12, 20) };

    const decoded = decodeMemoryChatDigest(answer);
    expect(decoded).toEqual(asContent(answer));
    expect(rendered(decoded)).toBe([`Summary: ${answer.summary}`, `Topics: ${answer.topics.join("; ")}`,
      `Decisions: ${answer.decisions.join("; ")}`, `Open loops: ${answer.open_loops.join("; ")}`].join("\n"));
  });
});

describe("Memory chat digest dispatch", () => {
  type GovernedCall = {
    decode(value: unknown): unknown;
    ordinal: number;
    request: ProviderStructuredOutputRequest;
    validationRetry?: {
      allocateOrdinal(attempt: number): Promise<number>;
      beforeRetry?(attempt: number): Promise<void>;
      maxAttempts: number;
    };
  };

  function durableJob(highestOrdinal: number | null) {
    let max = highestOrdinal;
    const currency = vi.fn(async () => [{ id: "job-digest" }]);
    const aggregate = vi.fn(async () => ({ _max: { ordinal: max } }));
    const client = {
      $queryRaw: currency,
      chatMemoryDigest: { findFirst: vi.fn(async () => null) },
      memoryExecutionBinding: { aggregate, findMany: vi.fn(async () => []) },
      memoryJob: { findFirst: vi.fn(async () => null) }
    };
    return { aggregate, client, currency, record: (ordinal: number) => { max = Math.max(max ?? -1, ordinal); } };
  }

  const options = { jobId: "job-digest", signal: new AbortController().signal, timeZone: "UTC", userId: source.userId };

  it("binds every segment, reduction and validation retry on the next durable ordinal", async () => {
    // Contextual keys already used ordinals 0-5 of this job and role.
    const job = durableJob(5);
    const calls: Array<{ ordinal: number; retryOrdinal?: number }> = [];
    governed.mockReset();
    governed.mockImplementation(async (call: GovernedCall) => {
      expect(call.validationRetry?.maxAttempts).toBe(3);
      job.record(call.ordinal);
      const entry: { ordinal: number; retryOrdinal?: number } = { ordinal: call.ordinal };
      if (calls.length === 0) {
        // The first segment's answer was rejected once and repaired: like the
        // executor, revalidate the job before binding the retry.
        await call.validationRetry!.beforeRetry?.(1);
        entry.retryOrdinal = await call.validationRetry!.allocateOrdinal(1);
        job.record(entry.retryOrdinal);
      }
      calls.push(entry);
      const value = call.decode({ decisions: [], open_loops: [], summary: "The user discussed several topics.", topics: ["Topics"] });
      return { acceptedOutputHash: "a".repeat(64), bindingId: `binding-${entry.retryOrdinal ?? entry.ordinal}`, value };
    });
    const chunks = Array.from({ length: 30 }, (_, ordinal) => chunk(ordinal));
    const generated = await createPrismaMemoryChatDigestGenerator(job.client as never, {
      provider: { run: vi.fn() } as never
    }).generate(source, chunks, options);

    expect(calls).toEqual([{ ordinal: 6, retryOrdinal: 7 }, { ordinal: 8 }, { ordinal: 9 }]);
    expect(generated.executions.map(({ bindingId }) => bindingId)).toEqual(["binding-7", "binding-8", "binding-9"]);
    expect(generated.digest).not.toBeNull();
    expect(job.currency).toHaveBeenCalledTimes(4);
  });

  it("accepts over-long segment and reduction answers on their first call under one budget", async () => {
    const job = durableJob(null);
    const requests: ProviderStructuredOutputRequest[] = [];
    const overlong = Object.fromEntries(["decisions", "open_loops", "topics"].map((field) => [field,
      Array.from({ length: 12 }, (_, index) => `${field} ${index}`.padEnd(256, "x"))]));
    governed.mockReset();
    governed.mockImplementation(async (call: GovernedCall) => {
      job.record(call.ordinal);
      requests.push(call.request);
      const value = call.decode({ ...overlong, summary: "S".repeat(2_000) });
      return { acceptedOutputHash: "a".repeat(64), bindingId: `binding-${call.ordinal}`, value };
    });
    const generated = await createPrismaMemoryChatDigestGenerator(job.client as never, {
      provider: { run: vi.fn() } as never
    }).generate(source, Array.from({ length: 30 }, (_, ordinal) => chunk(ordinal)), options);

    // Two segments and their reduction, each settled by its first answer.
    expect(requests.map((request) => JSON.parse(request.userPrompt).operation))
      .toEqual(["segment", "segment", "reduce"]);
    expect(generated.digest?.safeDigestText.length).toBeLessThanOrEqual(4_000);
    const incremental = buildIncrementalMemoryChatDigestRequest(
      generated.digest!.safeDigestText, [chunk(30)], "UTC");
    for (const request of [...requests, incremental]) {
      expect(request.schema).toEqual(requests[0]!.schema);
      expect(request.systemPrompt).toBe(requests[0]!.systemPrompt);
    }
  });

  it("never dispatches or retries from recovery", async () => {
    const job = durableJob(null);
    governed.mockReset();
    await expect(createPrismaMemoryChatDigestGenerator(job.client as never, {
      provider: { run: vi.fn() } as never
    }).generate(source, [chunk(0)], { ...options, recoveryOnly: true })).rejects.toMatchObject({
      code: "memory_chat_digest_unavailable"
    });
    expect(governed).not.toHaveBeenCalled();
    expect(job.aggregate).not.toHaveBeenCalled();
  });

  it("reports each rejected digest field as a closed decode reason", () => {
    for (const [output, decodeReason] of [
      [null, "digest_contract_root_type"],
      [{ summary: "s".repeat(2_001), topics: [], decisions: [], open_loops: [] }, "digest_contract_summary_length"],
      [{ summary: "Valid summary.", topics: [], decisions: [], open_loops: [null] }, "digest_contract_open_loops_item_invalid"]
    ] as const) {
      try { decodeMemoryChatDigest(output); throw new Error("expected_rejection"); }
      catch (error) {
        expect(error).toMatchObject({ code: "memory_chat_digest_output_invalid", decodeReason });
        expect(MEMORY_OUTPUT_DECODE_REASONS).toContain(decodeReason);
      }
    }
    expect(new MemoryChatDigestOutputError("aggregate_limit").decodeReason).toBe("digest_aggregate_limit");
    expect(new MemoryChatDigestOutputError("safety_rejected").decodeReason).toBe("digest_safety_rejected");
    expect(new MemoryChatDigestOutputError("contract").decodeReason).toBe("digest_contract");
  });
});

describe("Memory chat digest fold dispatch", () => {
  type Dispatch = Readonly<{
    decode(value: unknown): MemoryChatDigestContent;
    inputHash: string;
    ordinal: number;
    request: ProviderStructuredOutputRequest;
  }>;
  type Stored = Readonly<{ digest: MemoryHistoryDigestPlan; source: MemoryHistoryIndexSourceIdentity }>;

  const sourceAt = (turn: number): MemoryHistoryIndexSourceIdentity =>
    ({ ...source, activeLeafMessageId: `assistant-${turn}`, sourceRevision: 100 + turn });
  const earlier = decodeMemoryChatDigest({
    decisions: ["Keep the earlier plan"], open_loops: [], summary: "The earlier chat set a plan.", topics: []
  });

  /** Fakes the chat's stored digest, the job's currency check and its binding
   * store: each settled call keeps its answer under its input hash. */
  function digestJob(current: (check: number) => boolean = () => true) {
    let stored: Stored | null = null;
    let checks = 0;
    let highestOrdinal: number | null = null;
    const bindings = new Map<string, Readonly<Record<string, unknown>>>();
    const retained = new Map<string, unknown>();
    const dispatched: Array<Readonly<{ input: Record<string, unknown>; inputHash: string }>> = [];
    const client = {
      $queryRaw: vi.fn(async () => current(++checks) ? [{ id: "job-digest" }] : []),
      chatMemoryDigest: {
        findFirst: vi.fn(async () => stored && {
          activeLeafMessageId: stored.source.activeLeafMessageId,
          branchGeneration: stored.source.branchGeneration,
          contentHash: stored.digest.contentHash,
          decisions: [...stored.digest.decisions],
          id: stored.digest.id,
          incrementalDepth: stored.digest.incrementalDepth,
          inputFingerprint: stored.digest.inputFingerprint,
          openLoops: [...stored.digest.openLoops],
          rebuildPolicyVersion: stored.digest.rebuildPolicyVersion,
          redactionState: stored.digest.redactionState,
          safeDigestText: stored.digest.safeDigestText,
          safetyClass: "NORMAL",
          safetyPolicyVersion: "digest-policy:classifier-policy",
          sourceContentHash: stored.source.sourceHash,
          sourceFingerprint: stored.digest.sourceFingerprint,
          sourceRevisionAtCreation: stored.source.sourceRevision,
          summary: stored.digest.summary,
          topics: [...stored.digest.topics],
          updateMode: stored.digest.updateMode
        })
      },
      chatMemoryDigestChunk: {
        findMany: vi.fn(async () => (stored?.digest.sourceChunkIds ?? []).map((chunkId) => ({ chunkId })))
      },
      memoryExecutionBinding: {
        aggregate: vi.fn(async () => ({ _max: { ordinal: highestOrdinal } })),
        findMany: vi.fn(async (query: { where: { inputHash: string } }) => {
          const binding = bindings.get(query.where.inputHash);
          return binding ? [binding] : [];
        })
      },
      memoryHistoryExecution: {
        findFirst: vi.fn(async (query: { where: { executionBindingId: string } }) =>
          retained.has(query.where.executionBindingId)
            ? { acceptedOutput: retained.get(query.where.executionBindingId) }
            : null)
      },
      memoryJob: { findFirst: vi.fn(async () => null) }
    };
    governed.mockReset();
    governed.mockImplementation(async (call: Dispatch) => {
      dispatched.push({ input: JSON.parse(call.request.userPrompt), inputHash: call.inputHash });
      const value = call.decode({
        decisions: [], open_loops: [], summary: `Answer ${dispatched.length}.`, topics: []
      });
      const acceptedOutputHash = memoryExecutionSha256({
        inputHash: call.inputHash, output: value, role: "MEMORY_HISTORY_CLASSIFY", version: 1
      });
      const bindingId = `binding-${call.ordinal}`;
      highestOrdinal = call.ordinal;
      bindings.set(call.inputHash, {
        ...MEMORY_CHAT_DIGEST_VERSIONS, acceptedOutputHash, completedAt: new Date(),
        errorCode: null, id: bindingId, state: "SUCCEEDED"
      });
      retained.set(bindingId, JSON.parse(JSON.stringify(value)));
      return { acceptedOutputHash, bindingId, value };
    });
    const generator = createPrismaMemoryChatDigestGenerator(client as never, {
      provider: { run: vi.fn() } as never
    });
    return {
      client,
      dispatched,
      generate: (turn: number, chunks: readonly MemoryHistoryPreparedChunk[], recoveryOnly = false) =>
        generator.generate(sourceAt(turn), chunks, {
          jobId: "job-digest", recoveryOnly, signal: new AbortController().signal,
          timeZone: "UTC", userId: source.userId
        }),
      operations: () => dispatched.map(({ input }) => input.operation),
      seed: (digest: MemoryHistoryDigestPlan, turn: number) => {
        stored = { digest, source: sourceAt(turn) };
      }
    };
  }

  /** A stored digest over 24 short chunks, and the chat grown by three segments. */
  function grownChat(job: ReturnType<typeof digestJob>): MemoryHistoryPreparedChunk[] {
    const prefix = Array.from({ length: 24 }, (_, ordinal) => chunk(ordinal));
    job.seed(materializeMemoryChatDigest({
      chunks: prefix, content: earlier, source: sourceAt(0), timeZone: "UTC"
    }), 0);
    return [...prefix, ...Array.from({ length: 72 }, (_, ordinal) => chunk(24 + ordinal))];
  }

  // Two of these fill one 9,000-character segment: three are two segments.
  function turnChunks(turn: number): MemoryHistoryPreparedChunk[] {
    return [0, 1, 2].map((part) => {
      const text = `User: Turn ${turn} part ${part}. ${"detail ".repeat(490)}\n\nAssistant: noted.`;
      return chunk(turn * 3 + part, {
        normalizedSafeSearchText: text.toLocaleLowerCase("und"),
        providerSafeText: text,
        safeProjectedText: text
      });
    });
  }

  it("folds every turn of a growing chat at a cost set by its delta until the depth limit", async () => {
    const job = digestJob();
    let chunks = turnChunks(0);
    let previous = (await job.generate(0, chunks)).digest!;
    expect(previous).toMatchObject({ incrementalDepth: 0, updateMode: "FULL_REBUILD" });
    job.seed(previous, 0);

    for (let turn = 1; turn <= 31; turn += 1) {
      job.dispatched.length = 0;
      chunks = [...chunks, ...turnChunks(turn)];
      const generated = await job.generate(turn, chunks);
      expect(generated.digest).toMatchObject({ incrementalDepth: turn, updateMode: "INCREMENTAL" });
      // However long the chat: its two new segments, then one merge that
      // carries the previous digest. Earlier turns are never sent again.
      expect(job.operations()).toEqual(["segment", "segment", "reduce"]);
      expect(generated.work).toEqual({ digestSegmentsProcessed: 3, digestSourceChunksProcessed: 3 });
      const excerpts = job.dispatched.flatMap(({ input }) =>
        (input.excerpts as Array<{ text: string }> | undefined) ?? []);
      expect(excerpts.map(({ text }) => text.startsWith(`User: Turn ${turn} `))).toEqual([true, true, true]);
      expect((job.dispatched[2]!.input.segment_digests as Array<{ text: string }>)[0]!.text)
        .toBe(previous.safeDigestText);
      previous = generated.digest!;
      job.seed(previous, turn);
    }

    job.dispatched.length = 0;
    chunks = [...chunks, ...turnChunks(32)];
    const rebuilt = await job.generate(32, chunks);
    expect(rebuilt.digest).toMatchObject({ incrementalDepth: 0, updateMode: "FULL_REBUILD" });
    expect(job.operations().filter((operation) => operation === "segment"))
      .toHaveLength(partitionMemoryChatDigestSourceChunks(chunks).length);
    expect(rebuilt.work.digestSegmentsProcessed).toBe(job.dispatched.length);
  });

  it("dispatches nothing more once the job is superseded between fold calls", async () => {
    const job = digestJob((check) => check <= 2);
    const failure = await job.generate(1, grownChat(job)).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MemoryJobFencedError);
    expect(failure).toMatchObject({ code: "memory_history_job_invalid", decision: { status: "STALE" } });
    // Two of five fold calls ran; the third found the job no longer current.
    expect(job.dispatched).toHaveLength(2);
    expect(job.client.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it("restores every fold call of a restarted job from its retained result", async () => {
    const job = digestJob();
    const chunks = grownChat(job);
    const first = await job.generate(1, chunks);
    const inputHashes = job.dispatched.map(({ inputHash }) => inputHash);
    expect(job.operations()).toEqual(["segment", "segment", "segment", "reduce", "reduce"]);
    expect(new Set(inputHashes).size).toBe(5);

    governed.mockClear();
    job.client.memoryExecutionBinding.findMany.mockClear();
    const restarted = await job.generate(1, chunks, true);

    expect(governed).not.toHaveBeenCalled();
    expect(job.client.memoryExecutionBinding.findMany.mock.calls.map(([query]) => query.where.inputHash))
      .toEqual(inputHashes);
    expect(restarted).toEqual(first);
    expect(first.digest).toMatchObject({ incrementalDepth: 1, updateMode: "INCREMENTAL" });
  });
});
