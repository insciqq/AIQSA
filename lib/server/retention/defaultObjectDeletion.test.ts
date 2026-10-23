import { afterEach, describe, expect, it, vi } from "vitest";

type SchedulerInput = Readonly<{
  intervalMs?: number;
  reconcile(signal: AbortSignal): Promise<void>;
  subsystem?: string;
}>;

const mocks = vi.hoisted(() => ({
  log: vi.fn(),
  logProjects: vi.fn(),
  pass: vi.fn(),
  projects: vi.fn(async (): Promise<unknown> => ({ completed: 0, failed: 0, pending: 0 })),
  pruneRefusals: vi.fn(async () => 0),
  pruneReports: vi.fn(async () => 0),
  pruneTelegram: vi.fn(async () => 0),
  retire: vi.fn(async (): Promise<unknown> => null),
  schedulers: [] as SchedulerInput[],
  start: vi.fn(),
  storage: { kind: "storage" }
}));

vi.mock("../observability", () => ({ logEvent: mocks.log }));
vi.mock("../prisma", () => ({ prisma: { kind: "prisma" } }));
vi.mock("../uploads/storage", () => ({ createS3StorageAdapter: () => mocks.storage }));
vi.mock("../answerProblemReports/repository", () => ({ deleteExpiredAnswerProblemReports: mocks.pruneReports }));
vi.mock("../auth/signInRefusals", () => ({ deleteExpiredSignInRefusals: mocks.pruneRefusals }));
vi.mock("../telegram/store/retention", () => ({ deleteExpiredTelegramRecords: mocks.pruneTelegram }));
vi.mock("../knowledge/retirement", () => ({ createKnowledgeRetirement: () => mocks.retire }));
vi.mock("../projects/deletion", () => ({
  logProjectDeletionPass: mocks.logProjects,
  runProjectDeletionMaintenance: mocks.projects
}));
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
  mocks.retire.mockImplementation(async () => null);
  mocks.projects.mockImplementation(async () => ({ completed: 0, failed: 0, pending: 0 }));
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

  it("prunes refused sign-ins on the same hourly pass, and one prune's failure never skips the other", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-18T12:00:00.000Z"));
    getDefaultObjectDeletionWorker();
    const scheduler = mocks.schedulers[0]!;
    mocks.pass.mockResolvedValue({ batches: 1, claimed: 0, completed: 0, failed: 0, knowledgeJobsFinalized: 0 });
    mocks.pruneReports.mockRejectedValueOnce(new Error("database busy"));
    mocks.pruneRefusals.mockResolvedValueOnce(3).mockRejectedValueOnce(new Error("database busy"));

    await scheduler.reconcile(new AbortController().signal);
    expect(mocks.pruneRefusals).toHaveBeenCalledExactlyOnceWith({ kind: "prisma" }, new Date("2026-10-18T12:00:00.000Z"));
    vi.setSystemTime(new Date("2026-10-18T12:30:00.000Z"));
    await scheduler.reconcile(new AbortController().signal);
    expect(mocks.pruneRefusals).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-10-18T13:00:00.000Z"));
    await scheduler.reconcile(new AbortController().signal);

    expect(mocks.pruneRefusals).toHaveBeenCalledTimes(2);
    expect(mocks.pruneReports).toHaveBeenCalledTimes(2);
    expect(mocks.log.mock.calls).toEqual([
      ["runtime_lifecycle", expect.objectContaining({ code: "answer_problem_report_prune_failed", outcome: "failed" })],
      ["runtime_lifecycle", { count: 3, outcome: "completed", stage: "cleanup", subsystem: "database" }],
      ["runtime_lifecycle", expect.objectContaining({
        action: "retry", code: "sign_in_refusal_prune_failed", outcome: "failed", stage: "cleanup", subsystem: "database"
      })]
    ]);
  });

  it("deletes what is left of the removed Knowledge after object deletion and reports only work as content-free counts", async () => {
    getDefaultObjectDeletionWorker();
    const scheduler = mocks.schedulers[0]!;
    mocks.pass.mockResolvedValue({ batches: 1, claimed: 0, completed: 0, failed: 0, knowledgeJobsFinalized: 0 });
    mocks.retire
      .mockResolvedValueOnce({ done: false, drain: { blocked: 0, claimed: 2, completed: 1, failed: 0, waitingForObjects: 1 },
        failedOwners: 0, owners: 2 })
      .mockResolvedValueOnce({ done: false, drain: { blocked: 0, claimed: 1, completed: 0, failed: 1, waitingForObjects: 0 },
        failedOwners: 1, owners: 1 })
      .mockResolvedValueOnce({ done: true, drain: null, failedOwners: 0, owners: 0 })
      .mockRejectedValueOnce(new Error("PRIVATE_SEARCH_CANARY"));

    for (let pass = 0; pass < 5; pass += 1) await scheduler.reconcile(new AbortController().signal);

    expect(mocks.retire).toHaveBeenCalledTimes(5);
    expect(mocks.retire.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.pass.mock.invocationCallOrder[0]!);
    expect(mocks.log.mock.calls).toEqual([
      ["runtime_lifecycle", { claimed_count: 2, completed_count: 1, count: 2, failed_count: 0, outcome: "completed",
        pending_count: 1, stage: "cleanup", subsystem: "knowledge" }],
      ["runtime_lifecycle", { action: "retry", claimed_count: 1, code: "knowledge_retirement_failed", completed_count: 0,
        count: 1, failed_count: 2, outcome: "failed", pending_count: 0, stage: "cleanup", subsystem: "knowledge" }],
      ["runtime_lifecycle", expect.objectContaining({ action: "retry", code: "knowledge_retirement_failed", outcome: "failed",
        stage: "cleanup", subsystem: "knowledge" })]
    ]);
    expect(JSON.stringify(mocks.log.mock.calls.map(([, fields]) => ({ ...fields, error: undefined })))).not.toContain("CANARY");
  });

  it("does not start Knowledge or Project retirement on a pass that was cancelled", async () => {
    getDefaultObjectDeletionWorker();
    const scheduler = mocks.schedulers[0]!;
    mocks.pass.mockResolvedValue({ batches: 1, claimed: 0, completed: 0, failed: 0, knowledgeJobsFinalized: 0 });
    const controller = new AbortController();
    controller.abort();
    await scheduler.reconcile(controller.signal);
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.projects).not.toHaveBeenCalled();
  });

  it("deletes fenced Projects that need no Workspace runner after Knowledge, and a failure only asks for a retry", async () => {
    getDefaultObjectDeletionWorker();
    const scheduler = mocks.schedulers[0]!;
    mocks.pass.mockResolvedValue({ batches: 1, claimed: 0, completed: 0, failed: 0, knowledgeJobsFinalized: 0 });
    const done = { completed: 1, failed: 0, pending: 0 };
    mocks.projects.mockResolvedValueOnce(done).mockRejectedValueOnce(new Error("PRIVATE_PROJECT_CANARY"));

    await scheduler.reconcile(new AbortController().signal);
    await scheduler.reconcile(new AbortController().signal);

    // No runtime: Workspace maintenance takes the Projects whose chats still hold a VM.
    expect(mocks.projects).toHaveBeenNthCalledWith(1, { prisma: { kind: "prisma" } });
    expect(mocks.projects.mock.invocationCallOrder[0]).toBeGreaterThan(mocks.retire.mock.invocationCallOrder[0]!);
    expect(mocks.logProjects).toHaveBeenCalledExactlyOnceWith(done);
    expect(mocks.log.mock.calls).toEqual([
      ["runtime_lifecycle", expect.objectContaining({ action: "retry", code: "project_deletion_failed", outcome: "failed",
        stage: "delete", subsystem: "projects" })]
    ]);
    expect(JSON.stringify(mocks.log.mock.calls.map(([, fields]) => ({ ...fields, error: undefined })))).not.toContain("CANARY");
  });

  it("prunes the content-free Telegram records on the same hourly pass under their own failure code", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-19T12:00:00.000Z"));
    getDefaultObjectDeletionWorker();
    const scheduler = mocks.schedulers[0]!;
    mocks.pass.mockResolvedValue({ batches: 1, claimed: 0, completed: 0, failed: 0, knowledgeJobsFinalized: 0 });
    mocks.pruneTelegram.mockResolvedValueOnce(12).mockRejectedValueOnce(new Error("database busy"));

    await scheduler.reconcile(new AbortController().signal);
    expect(mocks.pruneTelegram).toHaveBeenCalledExactlyOnceWith({ kind: "prisma" }, new Date("2026-10-19T12:00:00.000Z"));
    vi.setSystemTime(new Date("2026-10-19T12:59:00.000Z"));
    await scheduler.reconcile(new AbortController().signal);
    expect(mocks.pruneTelegram).toHaveBeenCalledOnce();
    vi.setSystemTime(new Date("2026-10-19T13:00:00.000Z"));
    await scheduler.reconcile(new AbortController().signal);

    expect(mocks.pruneTelegram).toHaveBeenCalledTimes(2);
    expect(mocks.pruneReports).toHaveBeenCalledTimes(2);
    expect(mocks.pruneRefusals).toHaveBeenCalledTimes(2);
    expect(mocks.log.mock.calls).toEqual([
      ["runtime_lifecycle", { count: 12, outcome: "completed", stage: "cleanup", subsystem: "database" }],
      ["runtime_lifecycle", expect.objectContaining({
        action: "retry", code: "telegram_record_prune_failed", outcome: "failed", stage: "cleanup", subsystem: "database"
      })]
    ]);
  });
});
