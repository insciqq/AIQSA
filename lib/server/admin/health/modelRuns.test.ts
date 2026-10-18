import { describe, expect, it, vi } from "vitest";
import { adminHealthModelRunsStatement, readModelRunLoad } from "./modelRuns";
import type { AdminHealthQueueClient } from "./queuesRepository";

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

describe("runs by model read", () => {
  it("counts the window's runs per answer binding and returns only codes and configuration ids", () => {
    const statement = adminHealthModelRunsStatement({ from, to, limit: 10, codesPerModel: 3 });
    const sql = statement.text.replace(/\s+/gu, " ");
    expect(sql).toContain(`LEFT JOIN "ProviderRunBinding" AS binding ON binding."modelRunId" = run."id" AND binding."bindingKey" = 'answer'`);
    expect(sql).toContain(`run."createdAt" >= ($1::timestamptz AT TIME ZONE 'UTC') AND run."createdAt" < ($2::timestamptz AT TIME ZONE 'UTC')`);
    expect(sql).toContain(`left(run."errorPayload" ->> 'code', 128)`);
    expect(sql).not.toMatch(/message|"content"|"text"|normalizedRequest/iu);
    expect(statement.values).toEqual([from, to, expect.arrayContaining(["context_too_large", "provider_refused"]), 3, 11]);
  });

  it.each([
    [{ from: to, to: from, limit: 10, codesPerModel: 3 }],
    [{ from, to, limit: 0, codesPerModel: 3 }],
    [{ from, to, limit: 1_001, codesPerModel: 3 }],
    [{ from, to, limit: 10, codesPerModel: 0 }],
    [{ from: new Date(Number.NaN), to, limit: 10, codesPerModel: 3 }]
  ])("refuses a malformed query %#", (query) => {
    expect(() => adminHealthModelRunsStatement(query)).toThrow("admin_health_model_runs_invalid");
  });

  it("reads under a statement timeout, derives the open runs and keeps well-formed codes", async () => {
    const { db, executeRaw } = client([
      { connectionId: "conn-a", providerModelId: "model-a", accepted: 198n, completed: 170n, failed: 25n, refusedInput: 1n, cancelled: 2n,
        users: 9n, lastFailedAt: to, codes: [{ code: "provider_server_error", runs: 20 }, { code: "bad code", runs: 4 }, { code: null, runs: 1 },
          { code: "x", runs: 0 }] },
      { connectionId: null, providerModelId: null, accepted: 3, completed: 0, failed: 0, refusedInput: 0, cancelled: 0, users: 1,
        lastFailedAt: null, codes: null },
      { connectionId: "conn-b", providerModelId: "model-b", accepted: 1, completed: 1, failed: 0, refusedInput: 0, cancelled: 0, users: 1,
        lastFailedAt: null, codes: [] }
    ]);
    const load = await readModelRunLoad(db, { from, to, limit: 2, codesPerModel: 5 });
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(load).toEqual({ truncated: true, rows: [
      { connectionId: "conn-a", providerModelId: "model-a", accepted: 198, completed: 170, failed: 25, refusedInput: 1, cancelled: 2,
        open: 0, users: 9, lastFailedAt: to,
        codes: [{ code: "provider_server_error", runs: 20 }, { code: null, runs: 4 }, { code: null, runs: 1 }] },
      { connectionId: null, providerModelId: null, accepted: 3, completed: 0, failed: 0, refusedInput: 0, cancelled: 0, open: 3, users: 1,
        lastFailedAt: null, codes: [] }
    ] });
  });
});
