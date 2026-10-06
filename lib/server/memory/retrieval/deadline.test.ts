import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MEMORY_CONTROL_READ_RESERVE_MS,
  MEMORY_CONTROL_SCREEN_OPTIONAL_MAXIMUM_MS,
  MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS,
  MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS,
  MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS,
  MEMORY_RERANK_OPTIONAL_MAXIMUM_MS,
  MEMORY_STANDALONE_READ_DEADLINE_MS,
  MemoryOptionalDeadlineError,
  createMemoryRetrievalDeadline,
  isMemoryDeadlineExhaustion,
  memoryOptionalWindowMs,
  runBoundedMemoryRead,
  runOptionalMemoryUtility
} from "./deadline";

function hangUntilAborted(signal: AbortSignal): Promise<unknown> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("Memory retrieval deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-27T10:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    [0, 0],
    [1_000, 750],
    [15_000, 11_250],
    [24_000, 18_000],
    [26_000, 20_000],
    [30_000, 24_000],
    [60_000, 54_000],
    [120_000, 114_000],
    [Number.NaN, 0]
  ])("derives the optional window of a %i ms budget as %i ms", (budgetMs, windowMs) => {
    expect(memoryOptionalWindowMs(budgetMs)).toBe(windowMs);
  });

  it.each([30_000, 60_000, 120_000])("uses a configured %i ms budget as the hard deadline", async (configuredMs) => {
    const deadline = createMemoryRetrievalDeadline(undefined, { admissionDeadlineMs: configuredMs });
    expect(deadline).toMatchObject({
      budgetMs: configuredMs,
      optionalWindowMs: memoryOptionalWindowMs(configuredMs),
      outerDeadlineAtMs: Date.now() + configuredMs
    });

    await vi.advanceTimersByTimeAsync(memoryOptionalWindowMs(configuredMs) - 1);
    expect(deadline.canStartOptional()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.canStartOptional()).toBe(false);
    expect(deadline.expired()).toBe(false);

    await vi.advanceTimersByTimeAsync(configuredMs - memoryOptionalWindowMs(configuredMs) - 1);
    expect(deadline.signal.aborted).toBe(false);
    expect(deadline.remainingMs()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deadline.signal.aborted).toBe(true);
    expect(deadline.signal.reason).toEqual({ code: "memory_admission_deadline_exceeded" });
    expect(isMemoryDeadlineExhaustion(deadline.signal.reason)).toBe(true);
    deadline.dispose();
  });

  it("keeps the standalone read deadline when no admission budget is configured", () => {
    const deadline = createMemoryRetrievalDeadline(undefined);
    expect(deadline.budgetMs).toBe(MEMORY_STANDALONE_READ_DEADLINE_MS);
    expect(deadline.optionalWindowMs).toBe(20_000);
    deadline.dispose();
  });

  it("lets a smaller running outer deadline win and bounds the configured value", () => {
    const outer = createMemoryRetrievalDeadline(undefined, {
      admissionDeadlineMs: 120_000,
      existingDeadlineAtMs: Date.now() + 40_000
    });
    expect(outer.budgetMs).toBe(40_000);
    outer.dispose();
    const bounded = createMemoryRetrievalDeadline(undefined, { admissionDeadlineMs: 500_000 });
    expect(bounded.budgetMs).toBe(120_000);
    bounded.dispose();
    const running = createMemoryRetrievalDeadline(undefined, {
      existingDeadlineAtMs: Date.now() + 90_000
    });
    expect(running.budgetMs).toBe(90_000);
    running.dispose();
  });

  it.each([
    ["CONTROL", 30_000, 24_000],
    ["CONTROL", 120_000, 114_000],
    ["CONTROL_SCREEN", 120_000, MEMORY_CONTROL_SCREEN_OPTIONAL_MAXIMUM_MS],
    ["QUERY_RESOLVE", 120_000, 114_000],
    ["QUERY_RESOLVE", 6_000, 6_000 - MEMORY_QUERY_RESOLVER_SETTLEMENT_RESERVE_MS],
    ["CONTROL", 10_000, 10_000 - MEMORY_CONTROL_READ_RESERVE_MS],
    ["QUERY_EMBED", 120_000, MEMORY_QUERY_EMBEDDING_OPTIONAL_MAXIMUM_MS],
    ["RERANK", 120_000, MEMORY_RERANK_OPTIONAL_MAXIMUM_MS]
  ] as const)("times %s out after its derived budget inside %i ms", async (role, admissionDeadlineMs, expectedMs) => {
    const startedAt = Date.now();
    const deadline = createMemoryRetrievalDeadline(undefined, { admissionDeadlineMs });
    const abortedAt: number[] = [];
    const pending = runOptionalMemoryUtility(deadline, role, (signal) => {
      signal.addEventListener("abort", () => abortedAt.push(Date.now()), { once: true });
      return hangUntilAborted(signal);
    }).then(() => null, (error: unknown) => error);

    await vi.advanceTimersByTimeAsync(admissionDeadlineMs);
    const error = await pending;

    expect(abortedAt).toEqual([startedAt + expectedMs]);
    expect(error).toEqual({ code: `memory_${role.toLowerCase()}_timeout` });
    expect(isMemoryDeadlineExhaustion(error)).toBe(true);
    deadline.dispose();
  });

  it("returns a utility answer that arrives after 26 seconds inside a longer budget", async () => {
    const deadline = createMemoryRetrievalDeadline(undefined, { admissionDeadlineMs: 60_000 });
    const pending = runOptionalMemoryUtility(deadline, "CONTROL", (signal) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => resolve("ready"), 27_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(signal.reason);
        }, { once: true });
      }));
    await vi.advanceTimersByTimeAsync(27_000);
    await expect(pending).resolves.toBe("ready");
    deadline.dispose();
  });

  it("reports a utility that cannot start as budget exhaustion, not provider failure", async () => {
    const deadline = createMemoryRetrievalDeadline(undefined, { admissionDeadlineMs: 30_000 });
    const operation = vi.fn(async () => "never");
    await vi.advanceTimersByTimeAsync(memoryOptionalWindowMs(30_000));

    const soft = await runOptionalMemoryUtility(deadline, "RERANK", operation)
      .catch((error: unknown) => error);
    expect(soft).toBeInstanceOf(MemoryOptionalDeadlineError);
    expect(soft).toMatchObject({ code: "memory_optional_soft_deadline_exceeded" });
    expect(isMemoryDeadlineExhaustion(soft)).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    deadline.dispose();

    const tight = createMemoryRetrievalDeadline(undefined, { admissionDeadlineMs: 3_000 });
    const reserved = await runOptionalMemoryUtility(tight, "CONTROL", operation)
      .catch((error: unknown) => error);
    expect(reserved).toMatchObject({ code: "memory_optional_hard_deadline_reserved" });
    expect(isMemoryDeadlineExhaustion(reserved)).toBe(true);
    expect(operation).not.toHaveBeenCalled();
    tight.dispose();

    expect(isMemoryDeadlineExhaustion(new Error("provider failed"))).toBe(false);
    expect(isMemoryDeadlineExhaustion({ code: "run_cancelled" })).toBe(false);
  });

  it("propagates Stop to every running child at once and leaves no timer behind", async () => {
    const stop = new AbortController();
    const deadline = createMemoryRetrievalDeadline(stop.signal, { admissionDeadlineMs: 120_000 });
    const childSignals: AbortSignal[] = [];
    const child = (signal: AbortSignal) => {
      childSignals.push(signal);
      return hangUntilAborted(signal);
    };
    const settled = Promise.allSettled([
      runOptionalMemoryUtility(deadline, "CONTROL", child),
      runOptionalMemoryUtility(deadline, "QUERY_RESOLVE", child),
      runOptionalMemoryUtility(deadline, "QUERY_EMBED", child),
      runBoundedMemoryRead(deadline, MEMORY_LOCAL_RETRIEVAL_OPTIONAL_MAXIMUM_MS, child)
    ]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(childSignals).toHaveLength(4);
    expect(childSignals.some(({ aborted }) => aborted)).toBe(false);

    stop.abort({ code: "run_cancelled" });
    expect(childSignals.every(({ aborted }) => aborted)).toBe(true);
    const results = await settled;
    expect(results.every((result) => result.status === "rejected" &&
      !isMemoryDeadlineExhaustion(result.reason))).toBe(true);

    const late = await runOptionalMemoryUtility(deadline, "RERANK", child)
      .catch((error: unknown) => error);
    expect(late).toEqual({ code: "run_cancelled" });
    expect(childSignals).toHaveLength(4);
    deadline.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
