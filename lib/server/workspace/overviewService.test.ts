import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeWorkspaceOverviewResponse } from "@/lib/contracts/workspaceOverview";
import { createPrismaWorkspaceOverviewRepository, createWorkspaceOverviewService, type WorkspaceOverviewRecord } from "./overviewService";
import type { WorkspaceRuntimeInventoryPage } from "./runtime";

const timestamp = new Date("2026-09-09T12:00:00.000Z");
function record(id: string, state: WorkspaceOverviewRecord["state"] = "READY"): WorkspaceOverviewRecord {
  return { context: "personal", id, lastActiveAt: timestamp, runtimeSandboxId: `runtime_${id}`,
    sandboxName: `private_sandbox_${id}`, state, user: "Fixture user" };
}
function observed(id: string, state: WorkspaceRuntimeInventoryPage["entries"][number]["state"] = "running") {
  return { runtimeSandboxId: `runtime_${id}`, sandboxName: `private_sandbox_${id}`, state };
}
const options = { filter: "active" as const, page: 1 };

afterEach(() => vi.useRealTimers());

describe("administrator Workspace overview", () => {
  it("counts separate chats, idle VMs, work, transitions and stopped disks from a complete runner observation", async () => {
    const records = [record("idle"), record("work", "RUNNING"), record("export", "CREATING"),
      record("stop", "CREATING"), record("disk", "STOPPED"), record("lost", "RUNNING")];
    const listSessions = vi.fn().mockResolvedValue({ entries: [observed("idle"), observed("work"), observed("export"),
      observed("stop", "draining"), observed("disk", "stopped"), observed("orphan")], nextCursor: null });
    const service = createWorkspaceOverviewService({ now: () => +timestamp,
      repository: { read: vi.fn().mockResolvedValue(records) }, runtime: { listSessions } });
    const value = await service.read(options);
    expect(value).toMatchObject({ activeCount: 5, state: "fresh", stoppedCount: 1, totalCount: 6,
      transitioningCount: 2, unknownCount: 1 });
    expect(value.rows.map((row) => row.state).sort()).toEqual(["changing", "ready", "ready", "running", "stopping", "unknown"]);
    expect(value.rows.filter((row) => row.user === "Fixture user")).toHaveLength(5);
    expect(new Set(value.rows.map((row) => row.id)).size).toBe(6);
    expect(value.rows.every((row) => /^ws-[a-f0-9]{16}$/u.test(row.id))).toBe(true);
    expect(JSON.stringify(value)).not.toMatch(/runtime_|private_sandbox_|sandboxName|runtimeSandboxId|operationOwner|chatId/u);
    expect(decodeWorkspaceOverviewResponse({ overview: value })).toEqual(value);
    const all = await service.read({ filter: "all", page: 1 });
    expect(all.totalCount).toBe(7);
    expect(all.rows.some((row) => row.state === "stopped")).toBe(true);
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("filters the full inventory before pagination and keeps a full count independent of page size", async () => {
    const records = Array.from({ length: 47 }, (_, index) => record(String(index)));
    const entries = records.map((_, index) => observed(String(index), index < 5 ? "stopped" : "running"));
    const listSessions = vi.fn()
      .mockResolvedValueOnce({ entries: entries.slice(0, 15), nextCursor: "next" })
      .mockResolvedValueOnce({ entries: entries.slice(15), nextCursor: null });
    const service = createWorkspaceOverviewService({ repository: { async read() { return records; } }, runtime: { listSessions } });
    const first = await service.read(options);
    const second = await service.read({ ...options, page: 2 });
    const last = await service.read({ ...options, page: 99 });
    expect(first).toMatchObject({ activeCount: 42, page: 1, totalCount: 42 });
    expect(first.rows).toHaveLength(20);
    expect(second.rows).toHaveLength(20);
    expect(last).toMatchObject({ activeCount: 42, page: 3, totalCount: 42 });
    expect(last.rows).toHaveLength(2);
    expect(new Set([...first.rows, ...second.rows, ...last.rows].map((row) => row.id)).size).toBe(42);
    expect(listSessions).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: "next" }));
  });

  it("never treats a same-name replacement or a failed runner read as confirmed DB activity", async () => {
    let now = +timestamp;
    const listSessions = vi.fn().mockResolvedValueOnce({ entries: [{ ...observed("old"), runtimeSandboxId: "replacement" }], nextCursor: null })
      .mockRejectedValue(new Error("private diagnostic"));
    const service = createWorkspaceOverviewService({ now: () => now,
      repository: { async read() { return [record("old", "RUNNING")]; } }, runtime: { listSessions } });
    const fresh = await service.read(options);
    expect(fresh).toMatchObject({ activeCount: 1, totalCount: 2, unknownCount: 1 });
    expect(fresh.rows.find((row) => row.user)?.state).toBe("unknown");
    now += 6_000;
    const stale = await service.read(options);
    expect(stale).toMatchObject({ activeCount: 1, observedAt: fresh.observedAt, rows: fresh.rows, state: "stale" });
    expect(stale.updatedAt).not.toBe(fresh.updatedAt);

    const unavailable = createWorkspaceOverviewService({ repository: { async read() { return [record("lost", "STOPPED")]; } }, runtime: { listSessions } });
    expect(await unavailable.read(options)).toMatchObject({ activeCount: null, observedAt: null, state: "unavailable", unknownCount: 1 });
  });

  it("returns an honest empty observation and does not count a never-started DB session as live", async () => {
    const service = createWorkspaceOverviewService({ repository: { async read() {
      return [{ ...record("pending", "PENDING"), runtimeSandboxId: null }];
    } }, runtime: { async listSessions() { return { entries: [], nextCursor: null }; } } });
    expect(await service.read(options)).toMatchObject({ activeCount: 0, rows: [], state: "fresh", totalCount: 0 });
  });

  it("bounds a stuck request and shares it rather than launching overlapping runtime reads", async () => {
    vi.useFakeTimers();
    const listSessions = vi.fn(() => new Promise<WorkspaceRuntimeInventoryPage>(() => undefined));
    const service = createWorkspaceOverviewService({ repository: { async read() { return []; } }, runtime: { listSessions }, timeoutMs: 100 });
    const first = service.read(options);
    const second = service.read(options);
    await vi.advanceTimersByTimeAsync(101);
    expect(await first).toMatchObject({ activeCount: null, state: "unavailable" });
    expect(await second).toMatchObject({ activeCount: null, state: "unavailable" });
    const third = service.read(options);
    await vi.advanceTimersByTimeAsync(101);
    await third;
    expect(listSessions).toHaveBeenCalledTimes(1);
  });

  it("fails closed on repeated cursors or duplicate observations instead of returning a partial count", async () => {
    for (const duplicate of [false, true]) {
      const listSessions = vi.fn().mockResolvedValueOnce({ entries: [observed("one")], nextCursor: "again" })
        .mockResolvedValue({ entries: [observed(duplicate ? "one" : "two")], nextCursor: "again" });
      const service = createWorkspaceOverviewService({ repository: { async read() { return []; } }, runtime: { listSessions } });
      expect(await service.read(options)).toMatchObject({ activeCount: null, state: "unavailable" });
      expect(listSessions).toHaveBeenCalledTimes(2);
    }
  });

  it("projects personal and Project user metadata without touching session activity or selecting chat contents", async () => {
    const findMany = vi.fn().mockResolvedValue([
      { ...record("personal"), chat: { createdBy: null, createdByDisplayName: "", projectId: null, user: { displayName: "Personal user" } } },
      { ...record("project"), chat: { createdBy: null, createdByDisplayName: "Former member", projectId: "private-project", user: null } }
    ]);
    const update = vi.fn();
    const repository = createPrismaWorkspaceOverviewRepository({ workspaceSession: { findMany, update } } as never);
    const values = await repository.read();
    expect(values.map(({ context, user }) => ({ context, user }))).toEqual([
      { context: "personal", user: "Personal user" }, { context: "project", user: "Former member" }
    ]);
    expect(update).not.toHaveBeenCalled();
    expect(findMany.mock.calls[0]![0].select.chat.select).not.toHaveProperty("title");
    expect(values[0]!.lastActiveAt).toBe(timestamp);
  });
});
