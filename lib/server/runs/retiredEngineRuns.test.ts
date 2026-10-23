import { afterEach, describe, expect, it, vi } from "vitest";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import {
  createRetiredEngineRunFinder, createRetiredEngineRunSweep, endRetiredEngineRuns, endRetiredEngineRunsFor, RETIRED_AGENT_FAILURE,
  RETIRED_RUN_RETRY_MS, type RetiredEngineRunDeps
} from "./retiredEngineRuns";

type Row = Readonly<{ assistantMessageId: string | null; chatId: string; id: string; normalizedRequest: unknown; userId: string }>;
type Query = Readonly<{ chatId?: string; limit: number; skip: readonly string[]; userId?: string }>;

/** The old core's active runs in memory: a run leaves the active set once `failRun` ends it. */
function fixture(rows: Row[], options: Readonly<{ unendable?: ReadonlySet<string> }> = {}) {
  const active = new Map(rows.map((row) => [row.id, row]));
  const queries: Query[] = [];
  const failRun = vi.fn(async (runId: string, _assistantMessageId: string, _error: Readonly<{ code: string; message: string }>,
    _options?: Readonly<{ recoveryTerminal?: boolean }>) => {
    if (options.unendable?.has(runId)) return false;
    return active.delete(runId);
  });
  const settle = vi.fn(async () => ({ status: "settled" }));
  const findRuns = vi.fn(async (query: Query) => {
    queries.push(query);
    return [...active.values()].filter((row) => !query.skip.includes(row.id) && (!query.chatId || row.chatId === query.chatId) &&
      (!query.userId || row.userId === query.userId)).slice(0, query.limit);
  });
  const deps = { findRuns, repository: { failRun }, workspace: { settle } } as unknown as RetiredEngineRunDeps;
  return { active, deps, failRun, findRuns, queries, settle };
}

const run = (id: string, normalizedRequest: unknown = {}, userId = "user-1"): Row => ({ assistantMessageId: `answer-${id}`,
  chatId: `chat-${id}`, id, normalizedRequest, userId });

afterEach(() => {
  vi.useRealTimers();
});

describe("the old core's runs left active at upgrade", () => {
  it("end interrupted with Continue, and a Codex Agent turn as removed, settling the Workspace first and resending nothing", async () => {
    const f = fixture([run("run-1"), run("agent-1", { agent: { mode: "codex" } })]);
    await expect(endRetiredEngineRuns(f.deps)).resolves.toEqual({ found: 2, unended: [] });
    expect(f.failRun).toHaveBeenCalledWith("run-1", "answer-run-1", RUN_INTERRUPTED_FAILURE, { recoveryTerminal: true });
    expect(f.failRun).toHaveBeenCalledWith("agent-1", "answer-agent-1", RETIRED_AGENT_FAILURE, { recoveryTerminal: true });
    expect(f.settle).toHaveBeenCalledWith({ outcome: "failed", runId: "run-1", userId: "user-1" });
    expect(f.settle.mock.invocationCallOrder[0]).toBeLessThan(f.failRun.mock.invocationCallOrder[0]!);
  });

  it("are read as the old core's active runs, by chat or user when scoped", async () => {
    const findMany = vi.fn(async () => []);
    const find = createRetiredEngineRunFinder({ modelRun: { findMany } } as never);
    await find({ limit: 100, skip: [] });
    await find({ chatId: "chat-1", limit: 100, skip: ["stuck"], userId: "user-1" });
    expect(findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({ take: 100,
      where: { engine: "v1", status: { in: ["preparing", "streaming", "queued", "in_progress"] } } }));
    expect(findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ where: { chatId: "chat-1", engine: "v1", id: { notIn: ["stuck"] },
      status: { in: ["preparing", "streaming", "queued", "in_progress"] }, userId: "user-1" } }));
  });

  it("are swept batch by batch once, then never asked for again", async () => {
    const f = fixture(Array.from({ length: 230 }, (_value, index) => run(`run-${index}`)));
    const sweep = createRetiredEngineRunSweep(f.deps);
    await sweep();
    expect(f.active.size).toBe(0);
    const reads = f.queries.length;
    await sweep();
    expect(f.queries).toHaveLength(reads);
  });

  it("keep going past a run whose write failed", async () => {
    const f = fixture([run("broken"), run("run-1")]);
    f.failRun.mockRejectedValueOnce(new Error("synthetic_write_failure"));
    await expect(endRetiredEngineRuns(f.deps)).resolves.toEqual({ found: 2, unended: ["broken"] });
    expect(f.active.has("run-1")).toBe(false);
  });

  // Regression (codex review): after three failed passes the sweep stopped for good, and the run kept its chat busy.
  it("retry a run whose settlement keeps failing with a doubling wait, until it ends", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-23T00:00:00Z"));
    const f = fixture([run("stuck"), run("run-1")]);
    let databaseDown = true;
    f.failRun.mockImplementation(async (runId) => {
      if (runId === "stuck" && databaseDown) throw new Error("synthetic_contention");
      return f.active.delete(runId);
    });
    const attempts = () => f.failRun.mock.calls.filter(([runId]) => runId === "stuck").length;
    const sweep = createRetiredEngineRunSweep(f.deps);
    await sweep();
    expect(f.active.has("run-1")).toBe(false);
    expect(f.queries.at(-1)).toMatchObject({ skip: ["stuck"] });
    expect(attempts()).toBe(1);
    // Within the wait nothing is read; after it the run is tried again, and each failure doubles the wait.
    for (const [index, wait] of [RETIRED_RUN_RETRY_MS.first, RETIRED_RUN_RETRY_MS.first * 2, RETIRED_RUN_RETRY_MS.first * 4]
      .entries()) {
      const reads = f.queries.length;
      vi.advanceTimersByTime(wait - 1);
      await sweep();
      expect(f.queries).toHaveLength(reads);
      vi.advanceTimersByTime(1);
      await sweep();
      expect(attempts()).toBe(index + 2);
    }
    // The wait never grows past its bound, and the sweep keeps trying past any number of failures.
    for (let pass = 0; pass < 8; pass += 1) {
      vi.advanceTimersByTime(RETIRED_RUN_RETRY_MS.max);
      await sweep();
    }
    expect(attempts()).toBe(12);
    // The database recovers: the run ends, and only then does the sweep stop asking.
    databaseDown = false;
    vi.advanceTimersByTime(RETIRED_RUN_RETRY_MS.max);
    await sweep();
    expect(f.active.size).toBe(0);
    const reads = f.queries.length;
    vi.advanceTimersByTime(RETIRED_RUN_RETRY_MS.max);
    await sweep();
    expect(f.queries).toHaveLength(reads);
  });

  it("end when their chat opens or their user sends, whatever the sweep's wait, and a failure never escapes", async () => {
    const f = fixture([run("mine"), run("other", {}, "user-2")]);
    await endRetiredEngineRunsFor(f.deps, { chatId: "chat-mine", userId: "user-1" });
    expect(f.active.has("mine")).toBe(false);
    expect(f.active.has("other")).toBe(true);
    await endRetiredEngineRunsFor(f.deps, { userId: "user-2" });
    expect(f.active.size).toBe(0);
    // Ended already: a second pass finds nothing to end.
    await endRetiredEngineRunsFor(f.deps, { userId: "user-1" });
    expect(f.failRun).toHaveBeenCalledTimes(2);
    f.findRuns.mockRejectedValueOnce(new Error("synthetic_read_failure"));
    await expect(endRetiredEngineRunsFor(f.deps, { userId: "user-1" })).resolves.toBeUndefined();
  });
});
