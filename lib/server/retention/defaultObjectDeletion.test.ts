import { afterEach, describe, expect, it, vi } from "vitest";

type SchedulerInput = Readonly<{
  intervalMs?: number;
  reconcile(signal: AbortSignal): Promise<void>;
  subsystem?: string;
}>;

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  pass: vi.fn(),
  schedulers: [] as SchedulerInput[],
  start: vi.fn(),
  storage: { kind: "storage" }
}));

vi.mock("../observability", () => ({ logEvent: mocks.log }));
vi.mock("../prisma", () => ({ prisma: { kind: "prisma" } }));
vi.mock("../uploads/storage", () => ({ createS3StorageAdapter: () => mocks.storage }));
vi.mock("./prune", () => ({
  createPrismaRetentionRepository: (client: unknown) => ({ client, kind: "repository" }),
  runObjectDeletionPass: mocks.pass
}));
vi.mock("../runs/recoveryScheduler", () => ({
  RunRecoveryScheduler: class {
    constructor(input: SchedulerInput) { mocks.schedulers.push(input); }
    start() { mocks.start(); }
  }
}));

import { getDefaultObjectDeletionWorker, startDefaultObjectDeletionWorker } from "./defaultObjectDeletion";

afterEach(() => {
  delete (globalThis as { __aiqsaObjectDeletionWorker?: unknown }).__aiqsaObjectDeletionWorker;
  mocks.schedulers.length = 0;
  vi.clearAllMocks();
});

describe("default object deletion worker", () => {
  it("runs one process-wide pass a minute against the installation store and stays quiet when idle", async () => {
    startDefaultObjectDeletionWorker();
    expect(getDefaultObjectDeletionWorker()).toBe(getDefaultObjectDeletionWorker());
    expect(mocks.schedulers).toHaveLength(1);
    expect(mocks.start).toHaveBeenCalledOnce();
    const scheduler = mocks.schedulers[0]!;
    expect(scheduler).toMatchObject({ intervalMs: 60_000, subsystem: "object_storage" });

    mocks.pass.mockResolvedValueOnce({ batches: 1, claimed: 0, completed: 0, failed: 0, knowledgeJobsFinalized: 0 });
    const signal = new AbortController().signal;
    await scheduler.reconcile(signal);

    expect(mocks.pass).toHaveBeenCalledExactlyOnceWith({
      repository: { client: { kind: "prisma" }, kind: "repository" },
      signal,
      storage: mocks.storage
    });
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("reports drained and failed deletions as content-free counts", async () => {
    getDefaultObjectDeletionWorker();
    const scheduler = mocks.schedulers[0]!;
    mocks.pass
      .mockResolvedValueOnce({ batches: 2, claimed: 40, completed: 40, failed: 0, knowledgeJobsFinalized: 1 })
      .mockResolvedValueOnce({ batches: 1, claimed: 3, completed: 2, failed: 1, knowledgeJobsFinalized: 0 });

    await scheduler.reconcile(new AbortController().signal);
    await scheduler.reconcile(new AbortController().signal);

    expect(mocks.log.mock.calls).toEqual([
      ["runtime_lifecycle", {
        claimed_count: 40, completed_count: 40, failed_count: 0,
        outcome: "completed", stage: "cleanup", subsystem: "object_storage"
      }],
      ["runtime_lifecycle", {
        action: "retry", claimed_count: 3, code: "object_delete_failed", completed_count: 2,
        failed_count: 1, outcome: "failed", stage: "cleanup", subsystem: "object_storage"
      }]
    ]);
  });
});
