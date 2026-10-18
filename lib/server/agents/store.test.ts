import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import type { NormalizedRunAgent } from "./config";
import { AGENT_LEASE_CANCELLED } from "./lease";
import { createAgentRunStore } from "./store";

function store(cancelled: number) {
  const database = {
    agentRunBinding: { findFirst: vi.fn().mockResolvedValue(null) },
    modelRun: { count: vi.fn().mockResolvedValue(cancelled) }
  };
  return { database, store: createAgentRunStore(database as unknown as PrismaClient, {
    runId: "run_1", userId: "user_1", configuration: {} as NormalizedRunAgent, tokenHash: "a".repeat(64)
  }) };
}

describe("Agent lease checks", () => {
  it("report a run the user stopped as cancelled", async () => {
    const value = store(1);
    await expect(value.store.assertLeaseActive()).rejects.toThrow(AGENT_LEASE_CANCELLED);
    expect(value.database.modelRun.count).toHaveBeenCalledWith({ where: { id: "run_1", userId: "user_1", status: "cancelled" } });
  });

  it("keep any other end of authority an expiry", async () => {
    await expect(store(0).store.assertLeaseActive()).rejects.toThrow("agent_authority_expired");
  });
});
