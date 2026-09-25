import { describe, expect, it } from "vitest";
import type { ContextCompactionCheckpoint, ContextSummary, ContextSummaryAttempt } from "../../contracts/contextCompaction";
import {
  checkpointAdoptingSummaryReceipts,
  checkpointWithContextSummaryReceipt,
  INITIAL_PROVIDER_CONTINUATION,
  mergeContextCompactionReceipts,
  mergeAnswerRoundUsage,
  parseToolLoopCheckpoint,
  snapshotToolLoopJson,
  toolLoopCheckpoint,
  toolLoopPersistenceLimits,
  type ToolLoopCheckpoint
} from "./toolLoopPersistence";

describe("tool-loop persistence values", () => {
  it("round-trips the bounded masking checkpoint without archiving the transcript", () => {
    const contextCompaction = {
      branchId: "message-1",
      followupDigest: "b".repeat(64),
      followupRevision: 2,
      measurement: {
        afterTokens: 40,
        beforeTokens: 120,
        budgetTokens: 200,
        legacyFallback: false,
        maskedBatches: 1,
        maskedObservations: 2,
        outcome: "masking_applied" as const,
        version: 1 as const
      },
      observationRefs: [`tor1_${"a".repeat(32)}`],
      ownerId: "user-1",
      pinDigest: "c".repeat(64),
      policyRevision: "legacy-compatible-v1" as const,
      providerProjectionRevision: 1,
      recentTailCallIds: ["call-2"],
      runId: "run-1",
      sourceDigest: "d".repeat(64),
      version: 1 as const
    };
    const checkpoint = toolLoopCheckpoint({
      contextCompaction,
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 1
    });
    expect(checkpoint?.contextCompaction).toEqual(contextCompaction);
    expect(parseToolLoopCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("round-trips bounded hybrid summary notes and attempt receipts", () => {
    const summary = {
      formatVersion: 1 as const,
      id: "cs1_" + "a".repeat(32),
      notes: "A bounded derived note.",
      sourceDigest: "b".repeat(64),
      sourceRefs: ["message-old"]
    };
    const summaryAttempts = [{
      attempt: 1,
      bindingDigest: "c".repeat(64),
      id: "csa1_" + "d".repeat(32),
      sourceDigest: "b".repeat(64),
      state: "committed" as const,
      usage: { inputTokens: 12, outputTokens: 4, totalTokens: 16 }
    }];
    const contextCompaction = {
      branchId: "message-current",
      followupDigest: "e".repeat(64),
      followupRevision: 0,
      measurement: {
        afterTokens: 100,
        beforeTokens: 300,
        budgetTokens: 200,
        legacyFallback: false,
        maskedBatches: 1,
        maskedObservations: 2,
        outcome: "needs_summary" as const,
        version: 1 as const
      },
      observationRefs: [],
      ownerId: "user-1",
      pinDigest: "f".repeat(64),
      policyRevision: "hybrid-v1" as const,
      providerProjectionRevision: 1,
      recentTailCallIds: [],
      runId: "run-1",
      sourceDigest: "1".repeat(64),
      summary,
      summaryAttempts,
      version: 1 as const
    };
    const checkpoint = toolLoopCheckpoint({
      contextCompaction,
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 1
    });
    expect(parseToolLoopCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("creates a detached bounded v2 checkpoint", () => {
    const continuation = { responseId: "response-1", toolCalls: [{ id: "call-1" }] };
    const checkpoint = toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: continuation,
      providerCursor: 2,
      roundIndex: 1
    });
    continuation.responseId = "mutated";

    expect(checkpoint).toEqual({
      answerRoundUsage: [],
      phase: "provider_running",
      providerContinuation: { responseId: "response-1", toolCalls: [{ id: "call-1" }] },
      providerCursor: 2,
      roundIndex: 1,
      version: 2
    });
    expect(parseToolLoopCheckpoint(checkpoint)).toEqual(checkpoint);
  });

  it("replaces partial round usage with terminal evidence and keeps terminal repeats idempotent", () => {
    const partial = {
      completeness: "partial" as const,
      roundIndex: 2,
      usage: { completeness: "complete" as const,
        cachedInputTokens: 1,
        cacheWriteInputTokens: 0,
        inputTokens: 7,
        outputTokens: 2,
        reasoningTokens: 1,
        totalTokens: 9
      }
    };
    const terminal = {
      completeness: "terminal" as const,
      roundIndex: 2,
      usage: { ...partial.usage, outputTokens: 4, totalTokens: 11 }
    };

    expect(mergeAnswerRoundUsage([], partial, 2)).toEqual([partial]);
    expect(mergeAnswerRoundUsage([partial], terminal, 2)).toEqual([terminal]);
    expect(mergeAnswerRoundUsage([terminal], terminal, 2)).toEqual([terminal]);
    expect(mergeAnswerRoundUsage([terminal], partial, 2)).toBeNull();
    expect(mergeAnswerRoundUsage([terminal], {
      ...terminal,
      usage: { ...terminal.usage, totalTokens: 12 }
    }, 2)).toBeNull();
  });

  it("rejects malformed, duplicate, and out-of-bound round usage evidence", () => {
    const usage = { completeness: "complete" as const,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2
    };
    const checkpoint = (answerRoundUsage: unknown, roundIndex = 2) => ({
      answerRoundUsage,
      phase: "provider_running",
      providerContinuation: null,
      providerCursor: null,
      roundIndex,
      version: 2
    });

    expect(parseToolLoopCheckpoint(checkpoint([
      { completeness: "terminal", roundIndex: 1, usage },
      { completeness: "partial", roundIndex: 1, usage }
    ]))).toBeNull();
    expect(parseToolLoopCheckpoint(checkpoint([
      { completeness: "terminal", extra: true, roundIndex: 1, usage }
    ]))).toBeNull();
    expect(parseToolLoopCheckpoint(checkpoint([
      { completeness: "terminal", roundIndex: 3, usage }
    ]))).toBeNull();
    expect(parseToolLoopCheckpoint(checkpoint([
      { completeness: "terminal", roundIndex: 5, usage }
    ], 5))).toEqual(checkpoint([
      { completeness: "terminal", roundIndex: 5, usage }
    ], 5));
    expect(parseToolLoopCheckpoint(checkpoint([
      {
        completeness: "terminal",
        roundIndex: 1,
        usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }
      },
      { completeness: "terminal", roundIndex: 2, usage }
    ]))).toBeNull();
    expect(mergeAnswerRoundUsage([{
      completeness: "terminal",
      roundIndex: 1,
      usage: { ...usage, inputTokens: Number.MAX_SAFE_INTEGER }
    }], {
      completeness: "terminal",
      roundIndex: 2,
      usage
    }, 2)).toBeNull();
  });

  it("keeps usage evidence for 200 tool rounds plus final synthesis", () => {
    const usage = { completeness: "complete" as const,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      inputTokens: 1,
      outputTokens: 1,
      reasoningTokens: 0,
      totalTokens: 2
    };
    const answerRoundUsage = Array.from({ length: 201 }, (_, index) => ({
      completeness: "terminal" as const,
      roundIndex: index + 1,
      usage
    }));

    const checkpoint = toolLoopCheckpoint({
      answerRoundUsage,
      phase: "provider_running",
      providerContinuation: null,
      roundIndex: 201
    });

    expect(checkpoint?.answerRoundUsage).toHaveLength(201);
    expect(checkpoint?.answerRoundUsage.at(-1)?.roundIndex).toBe(201);
  });

  it("rejects invalid and oversized continuation data", () => {
    expect(parseToolLoopCheckpoint({
      answerRoundUsage: [],
      phase: "provider_running",
      providerContinuation: { value: Number.NaN },
      providerCursor: null,
      roundIndex: 0,
      version: 2
    })).toBeNull();
    expect(parseToolLoopCheckpoint({
      answerRoundUsage: [],
      extra: "not compact",
      phase: "provider_running",
      providerContinuation: null,
      providerCursor: null,
      roundIndex: 0,
      version: 2
    })).toBeNull();
    expect(toolLoopCheckpoint({
      phase: "provider_running",
      providerContinuation: { value: "x".repeat(toolLoopPersistenceLimits.checkpointBytes) },
      roundIndex: 0
    })).toBeNull();
    expect(snapshotToolLoopJson(undefined, 100)).toBeNull();
  });
});

describe("context summary receipts", () => {
  const compaction: ContextCompactionCheckpoint = {
    branchId: "message-current", followupDigest: "e".repeat(64), followupRevision: 0,
    measurement: { afterTokens: 300, beforeTokens: 300, budgetTokens: 200, legacyFallback: false,
      maskedBatches: 0, maskedObservations: 0, outcome: "needs_summary", version: 1 },
    observationRefs: [], ownerId: "user-1", pinDigest: "f".repeat(64), policyRevision: "hybrid-v1",
    providerProjectionRevision: 1, recentTailCallIds: [], runId: "run-1", sourceDigest: "1".repeat(64), version: 1
  };
  const attempt = (number: number, state: ContextSummaryAttempt["state"], sourceDigest = "b".repeat(64)): ContextSummaryAttempt => ({
    attempt: number, bindingDigest: "c".repeat(64), id: `csa1_${String(number).repeat(32)}`, sourceDigest, state,
    ...(state === "claim" ? {} : { usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
  });
  const summary: ContextSummary = { formatVersion: 1, id: `cs1_${"a".repeat(32)}`, notes: "Derived notes.",
    sourceDigest: "b".repeat(64), sourceRefs: ["message-old"] };
  const round = (roundIndex: number, phase: ToolLoopCheckpoint["phase"] = "provider_running", contextCompaction?: ContextCompactionCheckpoint) =>
    toolLoopCheckpoint({ ...(contextCompaction ? { contextCompaction } : {}), phase,
      providerContinuation: { providerResponseId: null, providerToolMessages: [] }, roundIndex })!;
  const write = (current: ToolLoopCheckpoint | null, entry: ContextSummaryAttempt, roundIndex = 2, committed?: ContextSummary) =>
    checkpointWithContextSummaryReceipt(current, { attempt: entry, compaction, roundIndex, ...(committed ? { summary: committed } : {}) });

  it("claims before dispatch in the round being prepared and settles that claim once", () => {
    const claimed = write(round(2), attempt(1, "claim"))!;
    expect(claimed.contextCompaction?.summaryAttempts).toEqual([attempt(1, "claim")]);
    // A second call cannot start beside an unsettled claim, nor outside the round.
    expect(write(claimed, attempt(2, "claim"))).toBeNull();
    expect(write(round(3), attempt(1, "claim"))).toBeNull();
    expect(write(round(2, "tools_pending"), attempt(1, "claim"))).toBeNull();
    const committed = write(claimed, attempt(1, "committed"), 2, summary)!;
    expect(committed.contextCompaction).toMatchObject({ summary, summaryAttempts: [attempt(1, "committed")] });
    expect(parseToolLoopCheckpoint(committed)).toEqual(committed);
    // Idempotent for the same outcome; a different outcome or an unknown id conflicts.
    expect(write(committed, attempt(1, "committed"), 2, summary)).toBe(committed);
    expect(write(committed, attempt(1, "invalid"))).toBeNull();
    expect(write(committed, attempt(3, "settled"))).toBeNull();
    // A summary commits only with its own committed receipt.
    expect(write(write(committed, attempt(2, "claim"))!, attempt(2, "settled"), 2, summary)).toBeNull();
    // Settlement stays possible after the round moved on (usage after Stop).
    expect(write(round(2, "tools_running", claimed.contextCompaction), attempt(1, "unknown"))?.contextCompaction?.summaryAttempts)
      .toEqual([attempt(1, "unknown")]);
  });

  it("seeds the first round's checkpoint with a claim that precedes its begin, and the begin keeps it", () => {
    const seeded = write(null, attempt(1, "claim"), 1)!;
    expect(seeded).toMatchObject({ phase: "provider_running", providerContinuation: INITIAL_PROVIDER_CONTINUATION, roundIndex: 1 });
    expect(write(null, attempt(1, "claim"), 2)).toBeNull();
    expect(write(null, attempt(1, "settled"), 1)).toBeNull();
    const committed = write(seeded, attempt(1, "committed"), 1, summary)!;
    const begin = round(1, "provider_running", { ...compaction, summary, summaryAttempts: [attempt(1, "committed")],
      measurement: { ...compaction.measurement, afterTokens: 100, outcome: "already_fits" } });
    const adopted = checkpointAdoptingSummaryReceipts(committed, begin)!;
    expect(adopted.contextCompaction).toMatchObject({ measurement: { outcome: "already_fits" }, summary,
      summaryAttempts: [attempt(1, "committed")] });
    // A begin that lost the receipts still cannot drop them.
    expect(checkpointAdoptingSummaryReceipts(committed, round(1, "provider_running", compaction))?.contextCompaction)
      .toMatchObject({ summary, summaryAttempts: [attempt(1, "committed")] });
    // Never adopted across rounds or after the round reported usage.
    expect(checkpointAdoptingSummaryReceipts(committed, round(2))).toBeNull();
    expect(checkpointAdoptingSummaryReceipts({ ...committed, answerRoundUsage: [{ completeness: "partial", roundIndex: 1,
      usage: { cachedInputTokens: 0, cacheWriteInputTokens: 0, completeness: "complete", inputTokens: 1, outputTokens: 1,
        reasoningTokens: 0, totalTokens: 2 } }] }, begin)).toBeNull();
  });

  it("keeps a dispatch outside the tool loop out of checkpoint state", () => {
    const current = round(2);
    expect(checkpointWithContextSummaryReceipt(current, { attempt: attempt(1, "claim"), compaction, roundIndex: null })).toBe(current);
  });

  it("merges receipts forward only and never lets an older projection replace the committed summary", () => {
    const durable = { ...compaction, summary, summaryAttempts: [attempt(1, "settled"), attempt(2, "committed")] };
    expect(mergeContextCompactionReceipts(durable, { ...compaction, summaryAttempts: [attempt(1, "claim")] })).toMatchObject({
      summary, summaryAttempts: [attempt(1, "settled"), attempt(2, "committed")]
    });
    expect(mergeContextCompactionReceipts(durable, compaction)).toMatchObject({ summary, summaryAttempts: durable.summaryAttempts });
    expect(mergeContextCompactionReceipts(durable, { ...compaction, summaryAttempts: [attempt(2, "invalid")] })).toBeNull();
    const stale: ContextSummary = { ...summary, id: `cs1_${"9".repeat(32)}`, sourceDigest: "9".repeat(64) };
    expect(mergeContextCompactionReceipts(durable, { ...compaction, summary: stale })).toBeNull();
    const newer = { ...compaction, summary: stale, summaryAttempts: [attempt(3, "committed", "9".repeat(64))] };
    expect(mergeContextCompactionReceipts(durable, newer)).toMatchObject({ summary: stale });
  });

  it("bounds retained receipts and rejects duplicate receipt ids", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ ...attempt(1, "invalid"), attempt: (index % 16) + 1,
      id: `csa1_${String(index).padStart(32, "0")}` }));
    const merged = mergeContextCompactionReceipts(compaction, { ...compaction, summaryAttempts: many })!;
    expect(merged.summaryAttempts).toHaveLength(24);
    expect(toolLoopCheckpoint({ contextCompaction: { ...compaction, summaryAttempts: [attempt(1, "settled"), attempt(1, "settled")] },
      phase: "provider_running", providerContinuation: null, roundIndex: 1 })).toBeNull();
  });
});
