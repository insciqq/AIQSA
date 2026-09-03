import { describe, expect, it, vi } from "vitest";
import {
  KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS,
  createPrismaKnowledgeSearchWorkerHeartbeat,
  runWithKnowledgeSearchWorkerHeartbeat
} from
  "./searchWorkerHeartbeat";

const STARTED_AT = new Date("2026-09-03T18:00:00.000Z");
const NOW = new Date("2026-09-03T18:01:00.000Z");

function heartbeatClient() {
  return {
    knowledgeSearchWorkerHeartbeat: {
      upsert: vi.fn().mockResolvedValue({})
    }
  };
}

describe("Knowledge search worker heartbeat", () => {
  it("upserts one installation heartbeat with stable process identity", async () => {
    const client = heartbeatClient();
    const heartbeat = createPrismaKnowledgeSearchWorkerHeartbeat(client as never, {
      instanceId: "worker-a",
      startedAt: STARTED_AT
    });

    await heartbeat.beat(NOW);

    expect(client.knowledgeSearchWorkerHeartbeat.upsert).toHaveBeenCalledOnce();
    expect(client.knowledgeSearchWorkerHeartbeat.upsert).toHaveBeenCalledWith({
      create: {
        id: "installation",
        instanceId: "worker-a",
        lastSeenAt: NOW,
        startedAt: STARTED_AT
      },
      update: {
        instanceId: "worker-a",
        lastSeenAt: NOW,
        startedAt: STARTED_AT
      },
      where: { id: "installation" }
    });
  });

  it("rejects invalid worker identity before persistence", () => {
    const client = heartbeatClient();

    expect(() => createPrismaKnowledgeSearchWorkerHeartbeat(client as never, {
      instanceId: "",
      startedAt: STARTED_AT
    })).toThrow("knowledge_search_worker_heartbeat_identity_invalid");
    expect(() => createPrismaKnowledgeSearchWorkerHeartbeat(client as never, {
      instanceId: "x".repeat(129),
      startedAt: STARTED_AT
    })).toThrow("knowledge_search_worker_heartbeat_identity_invalid");
    expect(() => createPrismaKnowledgeSearchWorkerHeartbeat(client as never, {
      instanceId: "worker-a",
      startedAt: new Date(Number.NaN)
    })).toThrow("knowledge_search_worker_heartbeat_identity_invalid");
    expect(client.knowledgeSearchWorkerHeartbeat.upsert).not.toHaveBeenCalled();
  });

  it("rejects an invalid or pre-start heartbeat clock", async () => {
    const client = heartbeatClient();
    const heartbeat = createPrismaKnowledgeSearchWorkerHeartbeat(client as never, {
      instanceId: "worker-a",
      startedAt: STARTED_AT
    });

    await expect(heartbeat.beat(new Date(STARTED_AT.getTime() - 1)))
      .rejects.toThrow("knowledge_search_worker_heartbeat_clock_invalid");
    await expect(heartbeat.beat(new Date(Number.NaN)))
      .rejects.toThrow("knowledge_search_worker_heartbeat_clock_invalid");
    expect(client.knowledgeSearchWorkerHeartbeat.upsert).not.toHaveBeenCalled();
  });

  it("keeps an established heartbeat fresh while a projection pass is running", async () => {
    vi.useFakeTimers();
    try {
      let finish!: (value: string) => void;
      const operation = new Promise<string>((resolve) => {
        finish = resolve;
      });
      const beat = vi.fn(async () => undefined);
      const running = runWithKnowledgeSearchWorkerHeartbeat(
        { beat },
        () => operation,
        100
      );

      expect(beat).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(300);
      expect(beat).toHaveBeenCalledTimes(3);
      finish("projected");

      await expect(running).resolves.toBe("projected");
    } finally {
      vi.useRealTimers();
    }
  });

  it("surfaces a heartbeat write failure after the active pass settles", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const operation = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const beat = vi.fn(async () => {
        throw new Error("heartbeat_write_failed");
      });
      const running = runWithKnowledgeSearchWorkerHeartbeat(
        { beat },
        () => operation,
        100
      );

      await vi.advanceTimersByTimeAsync(100);
      finish();

      await expect(running).rejects.toThrow("heartbeat_write_failed");
      expect(beat).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an interval that can outlive the freshness window", async () => {
    const beat = vi.fn(async () => undefined);

    await expect(runWithKnowledgeSearchWorkerHeartbeat(
      { beat },
      async () => undefined,
      KNOWLEDGE_SEARCH_WORKER_HEARTBEAT_FRESHNESS_MS
    )).rejects.toThrow("knowledge_search_worker_heartbeat_interval_invalid");
    expect(beat).not.toHaveBeenCalled();
  });
});
