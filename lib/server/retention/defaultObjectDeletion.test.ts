import { afterEach, describe, expect, it, vi } from "vitest";

type SchedulerInput = Readonly<{
  intervalMs?: number;
  reconcile(signal: AbortSignal): Promise<void>;
  subsystem?: string;
}>;

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  pass: vi.fn(),
  pruneReports: vi.fn(async () => 0),
  schedulers: [] as SchedulerInput[],
  start: vi.fn(),
  storage: { kind: "storage" }
}));

vi.mock("../observability", () => ({ logEvent: mocks.log }));
vi.mock("../prisma", () => ({ prisma: { kind: "prisma" } }));
vi.mock("../uploads/storage", () => ({ createS3StorageAdapter: () => mocks.storage }));
vi.mock("../answerProblemReports/repository", () => ({ deleteExpiredAnswerProblemReports: mocks.pruneReports }));
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
  vi.useRealTimers();
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

  it("prunes expired answer problem reports at most hourly, and a failure never stops object deletion", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-09T12:00:00.000Z"));
    getDefaultObjectDeletionWorker();
    const scheduler = mocks.schedulers[0]!;
    mocks.pass.mockResolvedValue({ batches: 1, claimed: 0, completed: 0, failed: 0, knowledgeJobsFinalized: 0 });
    mocks.pruneReports.mockResolvedValueOnce(7).mockRejectedValueOnce(new Error("database busy"));

    await scheduler.reconcile(new AbortController().signal);
    expect(mocks.pruneReports).toHaveBeenCalledExactlyOnceWith({ kind: "prisma" }, new Date("2026-10-09T12:00:00.000Z"));
    vi.setSystemTime(new Date("2026-10-09T12:59:00.000Z"));
    await scheduler.reconcile(new AbortController().signal);
    expect(mocks.pruneReports).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-10-09T13:00:00.000Z"));
    await scheduler.reconcile(new AbortController().signal);

    expect(mocks.pruneReports).toHaveBeenCalledTimes(2);
    expect(mocks.pass).toHaveBeenCalledTimes(3);
    expect(mocks.log.mock.calls).toEqual([
      ["runtime_lifecycle", { count: 7, outcome: "completed", stage: "cleanup", subsystem: "database" }],
      ["runtime_lifecycle", expect.objectContaining({
        action: "retry", code: "answer_problem_report_prune_failed", outcome: "failed", stage: "cleanup", subsystem: "database"
      })]
    ]);
  });
});
