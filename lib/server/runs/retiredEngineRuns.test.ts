import { describe, expect, it, vi } from "vitest";
import { RUN_INTERRUPTED_FAILURE } from "../../contracts/runs";
import { createRetiredEngineRunSweep, endRetiredEngineRuns, RETIRED_AGENT_FAILURE, type RetiredEngineRunDeps } from "./retiredEngineRuns";

type Row = Readonly<{ assistantMessageId: string | null; id: string; normalizedRequest: unknown; userId: string }>;

/** The old core's active runs in memory: a run leaves the active set once `failRun` ends it. */
function fixture(rows: Row[], options: Readonly<{ unendable?: ReadonlySet<string> }> = {}) {
  const active = new Map(rows.map((row) => [row.id, row]));
  const queries: unknown[] = [];
  const failRun = vi.fn(async (runId: string, _assistantMessageId: string, _error: Readonly<{ code: string; message: string }>,
    _options?: Readonly<{ recoveryTerminal?: boolean }>) => {
    if (options.unendable?.has(runId)) return false;
    return active.delete(runId);
  });
  const settle = vi.fn(async () => ({ status: "settled" }));
  const deps = {
    client: { modelRun: { findMany: vi.fn(async (query: { take: number; where: { id?: { notIn: string[] } } }) => {
      queries.push(query.where);
      const skip = new Set(query.where.id?.notIn ?? []);
      return [...active.values()].filter((row) => !skip.has(row.id)).slice(0, query.take);
    }) } },
    repository: { failRun },
    workspace: { settle }
  } as unknown as RetiredEngineRunDeps;
  return { active, deps, failRun, queries, settle };
}

const run = (id: string, normalizedRequest: unknown = {}): Row => ({ assistantMessageId: `answer-${id}`, id, normalizedRequest,
  userId: "user-1" });

describe("the old core's runs left active at upgrade", () => {
  it("end interrupted with Continue, and a Codex Agent turn as removed, settling the Workspace first and resending nothing", async () => {
    const f = fixture([run("run-1"), run("agent-1", { agent: { mode: "codex" } })]);
    await expect(endRetiredEngineRuns(f.deps)).resolves.toEqual({ found: 2, unended: [] });
    expect(f.failRun).toHaveBeenCalledWith("run-1", "answer-run-1", RUN_INTERRUPTED_FAILURE, { recoveryTerminal: true });
    expect(f.failRun).toHaveBeenCalledWith("agent-1", "answer-agent-1", RETIRED_AGENT_FAILURE, { recoveryTerminal: true });
    expect(f.settle).toHaveBeenCalledWith({ outcome: "failed", runId: "run-1", userId: "user-1" });
    expect(f.settle.mock.invocationCallOrder[0]).toBeLessThan(f.failRun.mock.invocationCallOrder[0]!);
    expect(f.queries[0]).toMatchObject({ engine: "v1" });
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

  it("leave a run that could not be ended for a later pass, and stop asking after three", async () => {
    const f = fixture([run("stuck"), run("run-1")], { unendable: new Set(["stuck"]) });
    const sweep = createRetiredEngineRunSweep(f.deps);
    await sweep();
    expect(f.active.has("run-1")).toBe(false);
    expect(f.queries.at(-1)).toMatchObject({ id: { notIn: ["stuck"] } });
    await sweep();
    await sweep();
    const reads = f.queries.length;
    await sweep();
    expect(f.queries).toHaveLength(reads);
    expect(f.failRun.mock.calls.filter(([runId]) => runId === "stuck")).toHaveLength(3);
  });

  it("keep going past a run whose write failed", async () => {
    const f = fixture([run("broken"), run("run-1")]);
    f.failRun.mockRejectedValueOnce(new Error("synthetic_write_failure"));
    await expect(endRetiredEngineRuns(f.deps)).resolves.toEqual({ found: 2, unended: ["broken"] });
    expect(f.active.has("run-1")).toBe(false);
  });
});
