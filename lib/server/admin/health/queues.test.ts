import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { captureRunObservation } from "@/tests/support/runObservation";
import { adminHealthQueueIds, decodeAdminHealthQueuesResponse, type AdminHealthQueueId } from "../../../contracts/adminHealthQueues";
import { ADMIN_HEALTH_QUEUE_POLICIES } from "./queueThresholds";
import { adminHealthQueueState, createAdminHealthQueuesService, projectAdminHealthQueues } from "./queues";
import { readAdminHealthQueueCounts, type AdminHealthQueueClient, type AdminHealthQueueReading } from "./queuesRepository";

const now = new Date("2026-10-07T12:00:00.000Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1_000);

function reading(queue: AdminHealthQueueId, oldestSeconds: number | null, overrides: Partial<NonNullable<AdminHealthQueueReading["counts"]>> = {}): AdminHealthQueueReading {
  return { queue, counts: { waiting: 3, running: 1, failed24h: 0, oldestDueAt: oldestSeconds === null ? null : ago(oldestSeconds), ...overrides } };
}

describe("background queue projection", () => {
  it("turns the oldest due age into ok, slow and stalled at each queue's own thresholds", () => {
    const policy = ADMIN_HEALTH_QUEUE_POLICIES.attachment_processing;
    expect(adminHealthQueueState(null, policy)).toBe("ok");
    expect(adminHealthQueueState(policy.slowAfterSeconds - 1, policy)).toBe("ok");
    expect(adminHealthQueueState(policy.slowAfterSeconds, policy)).toBe("slow");
    expect(adminHealthQueueState(policy.stalledAfterSeconds, policy)).toBe("stalled");

    const rows = projectAdminHealthQueues([
      reading("attachment_processing", 2 * 3_600),
      reading("file_deletion", 2 * 3_600, { failed24h: 4 }),
      { queue: "memory", counts: null },
      // A due time in the future (clock skew between writers) is not late.
      reading("chat_titles", -30)
    ], now);
    expect(rows).toEqual([
      { queue: "attachment_processing", state: "stalled", waiting: 3, running: 1, oldestSeconds: 7_200, failed24h: 0,
        slowAfterSeconds: 600, stalledAfterSeconds: 1_800 },
      { queue: "file_deletion", state: "slow", waiting: 3, running: 1, oldestSeconds: 7_200, failed24h: 4,
        slowAfterSeconds: 3_600, stalledAfterSeconds: 86_400 },
      { queue: "memory", state: "unavailable", waiting: null, running: null, oldestSeconds: null, failed24h: null,
        slowAfterSeconds: 900, stalledAfterSeconds: 3_600 },
      expect.objectContaining({ queue: "chat_titles", state: "ok", oldestSeconds: 0 })
    ]);
    // The projection is exactly what the browser decoder accepts.
    expect(decodeAdminHealthQueuesResponse({ queues: { checkedAt: now.toISOString(), queues: rows } })?.queues.queues).toEqual(rows);
  });

  it("reads every queue for the card and only the unwatched queues for attention", async () => {
    const read = vi.fn(async (queues: readonly AdminHealthQueueId[]) => queues.map((queue) =>
      reading(queue, queue === "scheduled_tasks" || queue === "file_deletion" ? 10 * 86_400 : 60)));
    const service = createAdminHealthQueuesService({ now: () => now, read });

    const snapshot = await service.read();
    expect(snapshot.checkedAt).toBe(now.toISOString());
    expect(snapshot.queues.map((row) => row.queue)).toEqual([...adminHealthQueueIds]);
    expect(snapshot.queues.filter((row) => row.state === "stalled").map((row) => row.queue)).toEqual(["scheduled_tasks", "file_deletion"]);

    // Stored file deletion is stalled too, but Knowledge operations already alert on it.
    await expect(service.stalled()).resolves.toEqual([{ queue: "scheduled_tasks", waiting: 3, running: 1, oldestSeconds: 864_000 }]);
    expect(read).toHaveBeenLastCalledWith(["attachment_processing", "chat_titles", "scheduled_tasks", "workspace_cleanup"], now);
  });

  it("names the attention source unavailable when a watched queue cannot be read", async () => {
    const service = createAdminHealthQueuesService({
      now: () => now,
      read: async (queues) => queues.map((queue) => queue === "chat_titles" ? { queue, counts: null } : reading(queue, 60))
    });
    await expect(service.stalled()).rejects.toThrow("admin_health_queues_unavailable");
  });
});

type Statement = Readonly<{ kind: "execute" | "query"; sql: Prisma.Sql }>;

function fakeClient(rowFor: (sql: string) => unknown[] | Error) {
  const statements: Statement[] = [];
  const client = {
    $executeRaw: vi.fn((sql: Prisma.Sql) => {
      statements.push({ kind: "execute", sql });
      return Promise.resolve(1);
    }),
    $queryRaw: vi.fn((sql: Prisma.Sql) => {
      statements.push({ kind: "query", sql });
      const rows = rowFor(sql.sql);
      return rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows);
    }),
    $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations))
  };
  return { client: client as unknown as AdminHealthQueueClient, statements, transaction: client.$transaction };
}

describe("background queue repository", () => {
  it("bounds each queue by its own statement timeout and marks only a failing queue unavailable", async () => {
    const failure = new Prisma.PrismaClientKnownRequestError("canceling statement due to statement timeout", {
      clientVersion: "test", code: "P2010", meta: { code: "57014" }
    });
    const { client, statements, transaction } = fakeClient((sql) => sql.includes("\"ChatTitleGeneration\"")
      ? failure
      : [{ waiting: 2n, running: 1, failed: null, oldestDueAt: ago(90) }]);
    const observation = await captureRunObservation();
    const readings = await readAdminHealthQueueCounts(client, { now, queues: ["attachment_processing", "chat_titles", "workspace_cleanup"], statementTimeoutMs: 1_500 });
    expect(readings).toEqual([
      { queue: "attachment_processing", counts: { waiting: 2, running: 1, failed24h: null, oldestDueAt: ago(90) } },
      { queue: "chat_titles", counts: null },
      { queue: "workspace_cleanup", counts: { waiting: 2, running: 1, failed24h: null, oldestDueAt: ago(90) } }
    ]);
    expect(observation.records()).toContainEqual(expect.objectContaining({ event: "service_operation", subsystem: "admin",
      stage: "read", outcome: "failed", code: "admin_health_failed" }));
    observation.restore();
    // One short transaction per queue: the timeout is set locally before its single aggregate.
    expect(transaction).toHaveBeenCalledTimes(3);
    const timeouts = statements.filter((statement) => statement.kind === "execute");
    expect(timeouts).toHaveLength(3);
    expect(timeouts[0]!.sql.sql).toContain("set_config('statement_timeout'");
    expect(timeouts[0]!.sql.values).toEqual(["1500"]);
  });

  it("reads every queue with one aggregate and counts failures only inside the 24-hour window", async () => {
    const { client, statements } = fakeClient(() => [{ waiting: 0, running: 0, failed: 0, oldestDueAt: null }]);
    await readAdminHealthQueueCounts(client, { now, queues: [...adminHealthQueueIds] });
    const queries = statements.filter((statement) => statement.kind === "query");
    expect(queries).toHaveLength(adminHealthQueueIds.length);
    const since = new Date(now.getTime() - 24 * 3_600_000);
    const chatTitles = queries.find(({ sql }) => sql.sql.includes("\"ChatTitleGeneration\""))!;
    expect(chatTitles.sql.values).toContainEqual(since);
  });

  it("rejects a malformed aggregate as unavailable instead of guessing", async () => {
    await captureRunObservation();
    const { client } = fakeClient(() => [{ waiting: -1, running: 0, failed: 0, oldestDueAt: null }]);
    await expect(readAdminHealthQueueCounts(client, { now, queues: ["memory"] })).resolves.toEqual([{ queue: "memory", counts: null }]);
    const empty = fakeClient(() => []);
    await expect(readAdminHealthQueueCounts(empty.client, { now, queues: ["memory"] })).resolves.toEqual([{ queue: "memory", counts: null }]);
  });
});
