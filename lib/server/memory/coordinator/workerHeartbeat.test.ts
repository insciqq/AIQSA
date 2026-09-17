import type { PrismaClient } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { createPrismaMemoryWorkerHeartbeat } from "./workerHeartbeat";

describe("Memory worker heartbeat", () => {
  it("marks startup unready and fences shutdown against another instance", async () => {
    const upsert = vi.fn().mockResolvedValue({});
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const startedAt = new Date("2026-09-17T08:00:00.000Z");
    const heartbeat = createPrismaMemoryWorkerHeartbeat({
      memoryWorkerHeartbeat: { upsert, updateMany }
    } as unknown as PrismaClient, { instanceId: "starting-worker", startedAt });
    await heartbeat.begin(startedAt);
    expect(upsert.mock.calls[0]![0]).toMatchObject({ create: { ready: false }, update: { ready: false } });
    await heartbeat.beat(new Date(startedAt.getTime() + 1));
    expect(upsert.mock.calls[1]![0]).toMatchObject({ create: { ready: true }, update: { ready: true } });
    await heartbeat.stop();
    expect(updateMany).toHaveBeenCalledWith({
      data: { ready: false }, where: { id: "installation", instanceId: "starting-worker" }
    });
  });

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
        ready: true,
        startedAt
      },
      update: {
        instanceId: "opaque-worker-instance",
        lastSeenAt: seenAt,
        ready: true,
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
