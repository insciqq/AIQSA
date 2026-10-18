import { describe, expect, it, vi } from "vitest";
import { adminHealthFailureStreaksStatement, readFailureStreakLoad } from "./failureStreaks";
import type { AdminHealthQueueClient } from "./queuesRepository";

const RUN_A = "1a2b3c4d-1111-4111-8111-111111111111";
const RUN_B = "5e6f7a8b-2222-4222-8222-222222222222";
const from = new Date("2026-10-08T12:00:00.000Z");
const to = new Date("2026-10-09T12:00:00.000Z");

function client(rows: unknown[]) {
  const executeRaw = vi.fn(async () => 0);
  const db = {
    $queryRaw: vi.fn(async () => rows),
    $executeRaw: executeRaw,
    $transaction: vi.fn(async (operations: Promise<unknown>[]) => Promise.all(operations))
  };
  return { db: db as unknown as AdminHealthQueueClient, executeRaw };
}

describe("failure streaks read", () => {
  it("finds candidate chats through failed and cancelled runs, then orders their settled runs, without content", () => {
    const statement = adminHealthFailureStreaksStatement({ from, to, limit: 10, runsPerStreak: 3 });
    const sql = statement.text.replace(/\s+/gu, " ");
    expect(sql).toContain(`run."status" IN ('error'::"ModelRunStatus", 'cancelled'::"ModelRunStatus")`);
    expect(sql).toContain(`run."status" IN ('complete'::"ModelRunStatus", 'error'::"ModelRunStatus", 'cancelled'::"ModelRunStatus")`);
    expect(sql).toContain("ROWS UNBOUNDED PRECEDING");
    expect(sql).toContain(`left(run."errorPayload" ->> 'code', 128)`);
    expect(sql).not.toContain(`run."userId" = $`);
    expect(sql).not.toMatch(/message|"content"|"text"|"title"|normalizedRequest/iu);
    expect(statement.values).toEqual([from, to, 3, from, to, 3, 3, 11]);
    const own = adminHealthFailureStreaksStatement({ from, to, limit: 10, runsPerStreak: 3, userId: "user_a" });
    expect(own.text).toContain(`run."userId" = $3`);
    expect(own.values).toContain("user_a");
  });

  it.each([
    [{ from: to, to: from, limit: 10, runsPerStreak: 3 }],
    [{ from, to, limit: 0, runsPerStreak: 3 }],
    [{ from, to, limit: 10, runsPerStreak: 51 }],
    [{ from, to, limit: 10, runsPerStreak: 3, userId: "a b" }],
    [{ from: new Date(Number.NaN), to, limit: 10, runsPerStreak: 3 }]
  ])("refuses a malformed query %#", (query) => {
    expect(() => adminHealthFailureStreaksStatement(query)).toThrow("admin_health_failure_streaks_invalid");
  });

  it("reads totals beyond the listed rows and keeps only well-formed run ids and codes", async () => {
    const row = (fields: Record<string, unknown>) => ({ userId: "user_a", runs: 6n, failed: 5n, cancelled: 1n, firstAt: from, lastAt: to,
      ongoing: true, codes: [{ code: "agent_provider_failed", runs: 5 }, { code: "bad code", runs: 1 }],
      newestRunIds: [RUN_A, "not-a-run", RUN_B], totalStreaks: 4n, totalUsers: 3n, longest: 6n, ...fields });
    const { db, executeRaw } = client([row({}), row({ userId: "user_b", runs: 3, failed: 3, cancelled: 0, ongoing: false, codes: null,
      newestRunIds: null }), row({ userId: "user_c" })]);
    const load = await readFailureStreakLoad(db, { from, to, limit: 2, runsPerStreak: 2 });
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(load).toEqual({ streaks: 4, users: 3, longest: 6, truncated: true, rows: [
      { userId: "user_a", runs: 6, failed: 5, cancelled: 1, firstAt: from, lastAt: to, ongoing: true,
        codes: [{ code: "agent_provider_failed", runs: 5 }, { code: null, runs: 1 }], newestRunIds: [RUN_A] },
      { userId: "user_b", runs: 3, failed: 3, cancelled: 0, firstAt: from, lastAt: to, ongoing: false, codes: [], newestRunIds: [] }
    ] });
    await expect(readFailureStreakLoad(client([]).db, { from, to, limit: 2, runsPerStreak: 2 }))
      .resolves.toEqual({ streaks: 0, users: 0, longest: 0, rows: [], truncated: false });
  });
});
