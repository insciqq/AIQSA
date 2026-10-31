import { describe, expect, it, vi } from "vitest";
import type { TelemetryCounterGroup } from "../../telemetry/store";
import type { AdminHealthQueueClient } from "./queuesRepository";
import { healthReachStatement, healthToolRates, readHealthReach } from "./reach";

const from = new Date("2026-10-20T00:00:00Z"), to = new Date("2026-10-21T00:00:00Z");
const row = (kind: string | null, outcome: string, count: number, tool?: string): TelemetryCounterGroup => ({
  group: { tool_kind: kind, outcome, ...(tool ? { tool_identity: tool } : {}) }, count
} as unknown as TelemetryCounterGroup);

describe("content-free product reach", () => {
  it("includes hosted Search accounting and bounds weeks, output and statement time", async () => {
    const rows = [
      { section: "summary", users: 2n, runs: 6n, searches: 11n },
      { section: "week", users: 3n, runs: 10n, from: new Date("2026-10-14T00:00:00Z"), to },
      { section: "tool", key: "search", users: 2n },
      { section: "detail", key: "fetch_url", users: 1n },
      { section: "feature", key: "search", users: 2n },
      { section: "detail", key: "PRIVATE_TOOL_NAME", users: 1n }
    ];
    const db = { $queryRaw: vi.fn(async () => rows), $executeRaw: vi.fn<(query: unknown) => Promise<number>>(async () => 0),
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)) };
    const report = await readHealthReach(db as unknown as AdminHealthQueueClient, { from, to }, [
      row("fetch_url", "completed", 8, "fetch_url"), row("fetch_url", "failed", 2, "fetch_url"),
      row("fetch_url", "cancelled", 1, "fetch_url"), row("mcp", "awaiting_approval", 2), row(null, "failed", 4)
    ]);
    expect(report).toMatchObject({ activeUsers: 2, runs: 6, runsPerActiveUser: 3, reportedWebSearches: 11, unclassifiedToolCalls: 4,
      tools: expect.arrayContaining([{ kind: "fetch_url", users: 0, calls: 11, failed: 2, cancelled: 1, awaitingApproval: 0, failureRate: 0.2 }]),
      perTool: [{ tool: "fetch_url", users: 1, calls: 11, failed: 2, failureRate: 0.2 }] });
    expect(JSON.stringify(report)).not.toContain("PRIVATE_");
    const sql = healthReachStatement({ from, to });
    expect(sql.text).toContain('"webSearchCount" > 0');
    expect(sql.text).toContain('FROM "SearchRun"');
    expect(sql.text).toContain('"subagentThreadId" IS NULL');
    expect(sql.values).toContainEqual(new Date("2026-10-14T00:00:00Z"));
    expect(db.$executeRaw.mock.calls[0]?.[0]).toBeDefined();
    expect(sql.text).not.toMatch(/"arguments"|"result"|"content"|"normalizedRequest"/u);
  });

  it("counts each terminal call once; stops and approval waits do not worsen failure rates", () => {
    const folded = healthToolRates([row("mcp", "completed", 8), row("mcp", "failed", 1), row("mcp", "timeout", 1),
      row("mcp", "cancelled", 3), row("mcp", "awaiting_approval", 4)]);
    expect(folded.byKind.get("mcp")).toEqual({ calls: 13, failed: 2, cancelled: 3, awaitingApproval: 4 });
  });

  it("rejects unbounded or reversed windows before database I/O", () => {
    for (const span of [{ from: to, to: from }, { from, to: new Date("2027-01-01") }, { from: new Date(NaN), to }]) {
      expect(() => healthReachStatement(span)).toThrow("health_reach_window_invalid");
    }
  });
});
