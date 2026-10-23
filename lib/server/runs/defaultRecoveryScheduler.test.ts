import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const order: string[] = [];
  return {
    chatPdfKick: vi.fn(() => { order.push("pdf"); }),
    order,
    reconcileNative: vi.fn(async (_deps: Record<string, unknown>) => { order.push("native"); return 0; }),
    retiredSweep: vi.fn(async () => { order.push("retired"); }),
    retiredSweepInput: [] as Record<string, unknown>[],
    schedulerInput: [] as Array<{ reconcile(signal: AbortSignal): Promise<void> }>,
    started: vi.fn(),
    storage: { kind: "storage" },
    workspaceFollowupKick: vi.fn(() => { order.push("workspace"); })
  };
});

vi.mock("../uploads/storage", () => ({ createS3StorageAdapter: () => mocks.storage }));
vi.mock("../workspace/defaultServices", () => ({ workspaceCoordinatorForStorage: (storage: unknown) => ({ kind: "workspace", storage }) }));
vi.mock("../workspace/checkpoints", () => ({ defaultWorkspaceCheckpoints: vi.fn() }));
vi.mock("../uploads/defaultChatPdf", () => ({ getDefaultChatPdf: () => ({ kick: mocks.chatPdfKick }) }));
vi.mock("./defaultWorkspaceFollowup", () => ({ getDefaultWorkspaceFollowup: () => ({ kick: mocks.workspaceFollowupKick }) }));
vi.mock("../chats/titleGenerationWorker", () => ({ createPrismaChatTitleWorker: () => ({ reconcile: vi.fn() }) }));
vi.mock("./prismaRepository", () => ({ createPrismaRunRepository: () => ({ kind: "repository" }) }));
vi.mock("../prisma", () => ({ prisma: { kind: "prisma" } }));
vi.mock("./retiredEngineRuns", () => ({
  createRetiredEngineRunSweep: (input: Record<string, unknown>) => { mocks.retiredSweepInput.push(input); return mocks.retiredSweep; }
}));
vi.mock("../engine/defaultEngine", () => ({ defaultNativeRecoveryDeps: (input: Record<string, unknown>) => ({ kind: "nativeRecovery", ...input }) }));
vi.mock("../engine/recovery", () => ({ reconcileNativeRuns: mocks.reconcileNative }));
vi.mock("./recoveryScheduler", () => ({
  RunRecoveryScheduler: class {
    constructor(input: { reconcile(signal: AbortSignal): Promise<void> }) { mocks.schedulerInput.push(input); }
    start() { mocks.started(); }
  }
}));

import { getDefaultRunRecoveryScheduler, startDefaultRunRecoveryScheduler } from "./defaultRecoveryScheduler";

afterEach(() => {
  delete (globalThis as { __aiqsaRunRecoveryScheduler?: unknown }).__aiqsaRunRecoveryScheduler;
  mocks.order.splice(0);
  mocks.schedulerInput.splice(0);
  mocks.retiredSweepInput.splice(0);
});

describe("default run recovery scheduler", () => {
  it("ends the old core's runs first, then wakes the document and Workspace jobs and settles the engine's orphans", async () => {
    getDefaultRunRecoveryScheduler();
    await mocks.schedulerInput[0]!.reconcile(new AbortController().signal);
    expect(mocks.order).toEqual(["retired", "pdf", "workspace", "native"]);
    expect(mocks.retiredSweepInput[0]).toMatchObject({ client: { kind: "prisma" }, repository: { kind: "repository" },
      workspace: { kind: "workspace", storage: mocks.storage } });
    expect(mocks.reconcileNative.mock.calls[0]![0]).toMatchObject({ kind: "nativeRecovery", repository: { kind: "repository" },
      workspace: { kind: "workspace" } });
  });

  it("still settles the engine's orphans when the old core's sweep fails, and reports the failure", async () => {
    getDefaultRunRecoveryScheduler();
    mocks.retiredSweep.mockRejectedValueOnce(new Error("synthetic_database_failure"));
    await expect(mocks.schedulerInput[0]!.reconcile(new AbortController().signal)).rejects.toThrow("synthetic_database_failure");
    expect(mocks.order).toEqual(["pdf", "workspace", "native"]);
  });

  it("starts the scheduler once", () => {
    startDefaultRunRecoveryScheduler();
    startDefaultRunRecoveryScheduler();
    expect(mocks.schedulerInput).toHaveLength(1);
    expect(mocks.started).toHaveBeenCalledTimes(2);
  });
});
