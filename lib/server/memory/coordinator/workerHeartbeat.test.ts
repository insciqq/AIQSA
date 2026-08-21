import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaMemoryWorkerHeartbeat } from "./workerHeartbeat";

describe("Memory worker heartbeat", () => {
  it("upserts one content-free installation liveness row", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const client = {
      memoryWorkerHeartbeat: { upsert }
    } as unknown as PrismaClient;
    const startedAt = new Date("2026-08-21T08:00:00.000Z");
    const seenAt = new Date("2026-08-21T08:00:05.000Z");
    const heartbeat = createPrismaMemoryWorkerHeartbeat(client, {
      instanceId: "opaque-worker-instance",
      startedAt
    });

    await heartbeat.beat(seenAt);
    expect(upsert).toHaveBeenCalledWith({
      create: {
        id: "installation",
        instanceId: "opaque-worker-instance",
        lastSeenAt: seenAt,
        startedAt
      },
      update: {
        instanceId: "opaque-worker-instance",
        lastSeenAt: seenAt,
        startedAt
      },
      where: { id: "installation" }
    });
    expect(JSON.stringify(upsert.mock.calls)).not.toMatch(/memory|fact|chat|user/iu);
  });

  it("rejects a clock that moves before process start", async () => {
    const client = {
      memoryWorkerHeartbeat: { upsert: vi.fn() }
    } as unknown as PrismaClient;
    const heartbeat = createPrismaMemoryWorkerHeartbeat(client, {
      instanceId: "worker",
      startedAt: new Date("2026-08-21T08:00:00.000Z")
    });
    await expect(heartbeat.beat(new Date("2026-08-21T07:59:59.000Z")))
      .rejects.toThrow("memory_worker_heartbeat_clock_invalid");
  });
});
