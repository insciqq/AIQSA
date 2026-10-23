// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { commitSelfServiceChange, selfServiceRunAllowedInTransaction } from "./selfServiceCall";
import type { ToolExecutionResult } from "./types";

const result: ToolExecutionResult = { callId: "call", content: [{ text: "done", type: "text" }], name: "manage_secret", status: "complete" };

function database() {
  const tx = { marker: "tx" };
  return { db: { $transaction: vi.fn(async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx)) }, tx };
}

describe("committing a self-service change with its call", () => {
  it("claims the call, changes and settles it in one transaction", async () => {
    const { db, tx } = database();
    const store = { claim: vi.fn(async () => ({ kind: "open" as const })), settle: vi.fn(async () => undefined) };
    const change = vi.fn(async () => ({ kind: "changed" as const, result, value: "done" }));
    expect(await commitSelfServiceChange(db as never, store, change)).toEqual({ kind: "changed", result, value: "done" });
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(store.claim).toHaveBeenCalledWith(tx);
    expect(change).toHaveBeenCalledWith(tx);
    expect(store.settle).toHaveBeenCalledWith(tx, result);
  });

  it("leaves a refused change unsettled", async () => {
    const { db } = database();
    const store = { claim: vi.fn(async () => ({ kind: "open" as const })), settle: vi.fn(async () => undefined) };
    expect(await commitSelfServiceChange(db as never, store, async () => ({ kind: "refused" as const, value: "why" })))
      .toEqual({ kind: "refused", value: "why" });
    expect(store.settle).not.toHaveBeenCalled();
  });

  it.each([
    [{ kind: "settled" as const, result }],
    [{ kind: "unavailable" as const }]
  ])("never changes anything for a call that is %j", async (claim) => {
    const { db } = database();
    const store = { claim: vi.fn(async () => claim), settle: vi.fn(async () => undefined) };
    const change = vi.fn();
    expect(await commitSelfServiceChange(db as never, store, change)).toEqual(claim);
    expect(change).not.toHaveBeenCalled();
    expect(store.settle).not.toHaveBeenCalled();
  });
});

describe("the run fence of a self-service change", () => {
  const scope = { runId: "run_1", userId: "user_1" };
  const allowed = { projectId: null, scheduledTaskId: null, scheduledTaskPrompt: false, status: "streaming", userStatus: "active" };

  it("admits the active user's own interactive personal run and locks it", async () => {
    const tx = { $queryRaw: vi.fn(async () => [allowed]) };
    expect(await selfServiceRunAllowedInTransaction(tx as never, scope)).toBe(true);
    const sql = (tx.$queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]]);
    expect(sql[0].join("?")).toContain("FOR UPDATE OF r");
    expect(sql.slice(1)).toEqual(["run_1", "user_1", "user_1"]);
  });

  it.each([
    [[]],
    [[{ ...allowed, status: "complete" }]],
    [[{ ...allowed, status: "cancelled" }]],
    [[{ ...allowed, userStatus: "disabled" }]],
    [[{ ...allowed, projectId: "project_1" }]],
    [[{ ...allowed, scheduledTaskId: "task_1" }]],
    [[{ ...allowed, scheduledTaskPrompt: true }]],
    [[{ ...allowed, scheduledTaskPrompt: null }]]
  ])("refuses %j: another user's or a finished run, an inactive user, a Project chat or scheduled work", async (rows) => {
    const tx = { $queryRaw: vi.fn(async () => rows) };
    expect(await selfServiceRunAllowedInTransaction(tx as never, scope)).toBe(false);
  });
});
