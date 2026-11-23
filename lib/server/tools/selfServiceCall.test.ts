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
  const allowed = { scheduledTaskId: null, status: "streaming", userMessageId: "message_1", userStatus: "active" };
  const own = { scheduledTaskPrompt: false, systemTurnKind: null };
  const allow = { scheduledTaskPrompt: false, systemTurnKind: "mcp_approval_continuation" };
  /** The run row, then the stored chain of its message (`storedUserRequest`), the message first. */
  const database = (runs: readonly object[], chain: readonly object[] = [own]) => ({ $queryRaw: vi.fn(async (query: TemplateStringsArray) =>
    query.join("?").includes("WITH RECURSIVE") ? chain : runs) });

  it("admits the active user's own interactive personal run and locks it", async () => {
    const tx = database([allowed]);
    expect(await selfServiceRunAllowedInTransaction(tx as never, scope)).toBe(true);
    // The continuation after an MCP Allow of the user's own turn goes on with it, a continuation of one included.
    expect(await selfServiceRunAllowedInTransaction(database([allowed], [allow, own]) as never, scope)).toBe(true);
    expect(await selfServiceRunAllowedInTransaction(database([allowed], [allow, allow, own]) as never, scope)).toBe(true);
    const [run, turn] = tx.$queryRaw.mock.calls as unknown as Array<[TemplateStringsArray, ...unknown[]]>;
    expect(run![0].join("?")).toContain("FOR UPDATE OF r");
    expect(run!.slice(1)).toEqual(["run_1", "user_1", "user_1"]);
    // The stored turn is the run's own message, read as the run's user.
    expect(turn!.slice(1, 4)).toEqual(["message_1", "user_1", "user_1"]);
  });

  it.each([
    [[], [own]],
    [[{ ...allowed, status: "complete" }], [own]],
    [[{ ...allowed, status: "cancelled" }], [own]],
    [[{ ...allowed, userStatus: "disabled" }], [own]],
    [[{ ...allowed, scheduledTaskId: "task_1" }], [own]],
    // The message is gone, or a scheduled task's prompt, which the model may have written.
    [[allowed], []],
    [[allowed], [{ ...own, scheduledTaskPrompt: true }]],
    [[allowed], [{ ...own, scheduledTaskPrompt: null }]],
    // A turn the server wrote authorizes nothing, as the memory note's service reads it (`storedUserRequest`).
    [[allowed], [{ ...own, systemTurnKind: "subagent_callback" }]],
    [[allowed], [{ ...own, systemTurnKind: "browser_sign_in_request" }]],
    // A continued chat's summary prompt is the server's too, in its chat and a branch copy alike.
    [[allowed], [{ ...own, systemTurnKind: "conversation_summary" }]],
    // Nor does an Allow of a call such a turn made, however far back, nor a continuation that names no Allow.
    [[allowed], [allow, { ...own, systemTurnKind: "subagent_callback" }]],
    [[allowed], [allow, { ...own, systemTurnKind: "browser_sign_in_request" }]],
    [[allowed], [allow, allow, { ...own, systemTurnKind: "subagent_callback" }]],
    [[allowed], [allow]]
  ])("refuses %j with the stored chain %j: another user's run or chat, a finished run, an inactive user, scheduled work or a turn the server wrote",
    async (rows, chain) => {
      expect(await selfServiceRunAllowedInTransaction(database(rows, chain) as never, scope)).toBe(false);
    });
});
