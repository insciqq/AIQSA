import { describe, expect, it, vi } from "vitest";
import { adminHealthFailedRunsStatement, readFailedRunLoad } from "./failedRuns";
import type { AdminHealthQueueClient } from "./queuesRepository";

const RUN_A = "1a2b3c4d-1111-4111-8111-111111111111";
const RUN_B = "5e6f7a8b-2222-4222-8222-222222222222";
const from = new Date("2026-10-08T12:00:00.000Z");
const to = new Date("2026-10-09T12:00:00.000Z");

function client(rows: unknown[]) {
  const queryRaw = vi.fn(async () => rows);
  const executeRaw = vi.fn(async () => 0);
  const db = {
    $queryRaw: queryRaw,
    $executeRaw: executeRaw,
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations))
  };
  return { db: db as unknown as AdminHealthQueueClient, queryRaw, executeRaw };
}

describe("failed runs read", () => {
  it("selects failed runs of the window only, leaves refused user input out and returns only codes and ids", () => {
    const statement = adminHealthFailedRunsStatement({ from, to, perCode: 2, groupLimit: 10 });
    const sql = statement.text.replace(/\s+/gu, " ");
    expect(sql).toContain(`run."status" = 'error'::"ModelRunStatus"`);
    expect(sql).toContain(`run."createdAt" >= ($1::timestamptz AT TIME ZONE 'UTC') AND run."createdAt" < ($2::timestamptz AT TIME ZONE 'UTC')`);
    expect(sql).toContain(`left(run."errorPayload" ->> 'code', 128)`);
    expect(sql).not.toMatch(/message|"content"|"text"/iu);
    expect(statement.values).toEqual([from, to, expect.arrayContaining(["context_too_large", "provider_refused"]), 2, 11]);
  });

  it.each([
    [{ from: to, to: from, perCode: 2, groupLimit: 10 }],
    [{ from, to, perCode: 0, groupLimit: 10 }],
    [{ from, to, perCode: 101, groupLimit: 10 }],
    [{ from, to, perCode: 2, groupLimit: 0 }],
    [{ from: new Date(Number.NaN), to, perCode: 2, groupLimit: 10 }]
  ])("refuses a malformed query %#", (query) => {
    expect(() => adminHealthFailedRunsStatement(query)).toThrow("admin_health_failed_runs_invalid");
  });

  it("reads under a statement timeout, keeps well-formed codes and runs and says when codes were cut", async () => {
    const { db, executeRaw } = client([
      { code: "provider_server_error", runs: 3n, users: 2n, firstAt: from, lastAt: to, totalRuns: 5n, totalUsers: 3n, newest: [
        { runId: RUN_B, userId: "user-b", startedAt: "2026-10-09T11:00:00.000Z" },
        { runId: "not-a-run", userId: "user-x", startedAt: "2026-10-09T10:00:00.000Z" },
        { runId: RUN_A, userId: "user-a", startedAt: "2026-10-09T09:00:00.000Z" }
      ] },
      { code: "bad code with spaces", runs: 1, users: 1, firstAt: from, lastAt: from, totalRuns: 5, totalUsers: 3, newest: [] },
      { code: null, runs: 1, users: 1, firstAt: from, lastAt: from, totalRuns: 5, totalUsers: 3, newest: null }
    ]);
    const load = await readFailedRunLoad(db, { from, to, perCode: 3, groupLimit: 2 });
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(load).toEqual({ runs: 5, users: 3, groupsTruncated: true, groups: [
      { code: "provider_server_error", runs: 3, users: 2, firstAt: from, lastAt: to, newest: [
        { runId: RUN_B, userId: "user-b", startedAt: new Date("2026-10-09T11:00:00.000Z") },
        { runId: RUN_A, userId: "user-a", startedAt: new Date("2026-10-09T09:00:00.000Z") }
      ] },
      { code: null, runs: 1, users: 1, firstAt: from, lastAt: from, newest: [] }
    ] });
  });

  it("returns nothing for a window without failed runs", async () => {
    const { db } = client([]);
    expect(await readFailedRunLoad(db, { from, to, perCode: 2, groupLimit: 10 }))
      .toEqual({ runs: 0, users: 0, groups: [], groupsTruncated: false });
  });
});
