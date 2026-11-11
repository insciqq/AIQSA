import { describe, expect, it, vi } from "vitest";
import { CONNECTOR_RECOVERY_MAX_AGE_MS, recoverConnectorDeliveries, type ConnectorRecoveryDeps, type ConnectorRecoveryLink } from "./recovery";

const STARTED = Date.parse("2026-11-12T10:00:00.000Z");
type Row = ConnectorRecoveryLink & Readonly<{ state: "pending" | "claimed" }>;

function sweep(rows: readonly Row[], overrides: Partial<ConnectorRecoveryDeps<Row>> = {}) {
  const settled: Array<Readonly<{ runId: string; state: string }>> = [];
  const delivered: string[] = [];
  const deps: ConnectorRecoveryDeps<Row> = {
    available: async () => true,
    deliver: vi.fn(async (row: Row) => { delivered.push(row.runId); return "delivered" as const; }),
    isLive: () => false,
    links: {
      claimDelivery: async () => true,
      listByState: async ({ state }) => rows.filter((row) => row.state === state),
      settle: async ({ runId, state }) => { settled.push({ runId, state }); }
    },
    log: { deliveryFailed: "test_delivery_failed", recoveryFailed: "test_recovery_failed", subsystem: "telegram", unknown: "test_delivery_unknown" },
    now: () => STARTED + 1_000,
    waitForRun: async () => "complete",
    ...overrides
  };
  return { delivered, deps, run: () => recoverConnectorDeliveries(deps, { startedAt: new Date(STARTED) }), settled };
}

const row = (runId: string, state: Row["state"], createdAt: number): Row => ({ createdAt: new Date(createdAt), runId, state, userId: "user-1" });

describe("the connectors' recovery sweep", () => {
  it("settles an interrupted claim unknown, never resending it, and delivers a settled pending run once", async () => {
    const s = sweep([row("claimed-1", "claimed", STARTED - 5_000), row("pending-1", "pending", STARTED - 5_000)]);
    await s.run();
    expect(s.settled).toEqual([{ runId: "claimed-1", state: "unknown" }]);
    expect(s.delivered).toEqual(["pending-1"]);
  });

  it("leaves a run this process follows, or just recorded, to its observer, and waits while the connector is off", async () => {
    const live = sweep([row("live", "pending", STARTED - 5_000), row("fresh", "pending", STARTED + 500)], { isLive: (runId) => runId === "live" });
    await live.run();
    expect(live.delivered).toEqual([]);
    const off = sweep([row("pending-1", "pending", STARTED - 5_000)], { available: async () => false });
    await off.run();
    expect(off.delivered).toEqual([]);
  });

  it("drops an answer too old to deliver and leaves a run still going for the next sweep", async () => {
    const s = sweep([row("old", "pending", STARTED - CONNECTOR_RECOVERY_MAX_AGE_MS - 5_000), row("going", "pending", STARTED - 5_000)],
      { waitForRun: async () => null });
    await s.run();
    expect(s.settled).toEqual([{ runId: "old", state: "failed" }]);
    expect(s.delivered).toEqual([]);
  });
});
