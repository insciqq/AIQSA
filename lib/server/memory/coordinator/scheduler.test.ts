import type { MemoryJobKind } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import { resolveMemoryCoordinatorPolicy } from "./policy";
import {
  MemoryScheduler,
  type MemorySchedulerDailyUsage,
  type MemorySchedulerUsageSource
} from "./scheduler";
import type { MemoryJobClaim } from "./types";

const NOW = new Date("2026-08-12T12:00:00.000Z");

function claim(kind: MemoryJobKind, userId = "owner-a"): MemoryJobClaim {
  return {
    activeLeafMessageId: null,
    attemptCount: 1,
    branchGeneration: null,
    chatId: null,
    claimToken: "claim-token",
    id: `job-${kind}-${userId}`,
    idempotencyFingerprint: `fingerprint-${kind}-${userId}`,
    kind,
    leaseExpiresAt: new Date(NOW.getTime() + 30_000),
    memoryGenerationSnapshot: 0,
    memoryRevisionSnapshot: 0,
    pipelineVersion: "memory-scheduler-test-v1",
    recoveredLease: false,
    sourceHash: null,
    sourceRevision: null,
    stage: null,
    userId
  };
}

function source(
  usage: MemorySchedulerDailyUsage | Error
): MemorySchedulerUsageSource {
  return {
    readDailyBackgroundUsage: vi.fn(async () => {
      if (usage instanceof Error) throw usage;
      return usage;
    })
  };
}

function dailyUsage(input: Readonly<{
  installationCalls?: number;
  installationCostMicros?: number;
  users?: ReadonlyArray<readonly [string, number, number]>;
}> = {}): MemorySchedulerDailyUsage {
  return {
    installation: {
      calls: input.installationCalls ?? 0,
      costMicros: input.installationCostMicros ?? 0
    },
    users: new Map((input.users ?? []).map(([userId, calls, costMicros]) => [
      userId,
      { calls, costMicros }
    ]))
  };
}

function scheduler(
  usage: MemorySchedulerDailyUsage | Error = dailyUsage(),
  overrides: Parameters<typeof resolveMemoryCoordinatorPolicy>[0] = {}
): MemoryScheduler {
  return new MemoryScheduler({
    policy: resolveMemoryCoordinatorPolicy(overrides),
    usageSource: source(usage)
  });
}

describe("Memory scheduler", () => {
  it("gives every tier a bounded turn while weighting safety work", () => {
    const service = scheduler();
    const kinds = [
      "GLOBAL_DREAM",
      "RECONCILE_BRANCH",
      "INDEX_HISTORY"
    ] as const;

    expect(service.claimWaves(kinds).map((wave) => wave[0])).toEqual([
      "RECONCILE_BRANCH",
      "INDEX_HISTORY",
      "GLOBAL_DREAM"
    ]);
    expect(service.claimWaves(kinds)[0]).toEqual(["RECONCILE_BRANCH"]);
    expect(service.claimWaves(kinds)[0]).toEqual(["INDEX_HISTORY"]);
    expect(service.claimWaves(kinds)[0]).toEqual(["GLOBAL_DREAM"]);
    expect(service.claimWaves(kinds)[0]).toEqual(["RECONCILE_BRANCH"]);
  });

  it("defers only budgeted background kinds until the UTC reset", async () => {
    const service = scheduler(dailyUsage({
      installationCalls: 1,
      users: [["owner-a", 1, 0]]
    }), {
      backgroundInstallDailyCallLimit: 3,
      backgroundInstallDailyCostMicrosLimit: 100,
      backgroundUserDailyCallLimit: 2,
      backgroundUserDailyCostMicrosLimit: 50
    });

    await expect(service.decide(claim("GLOBAL_DREAM"), NOW)).resolves.toEqual({
      status: "RUN"
    });
    await expect(service.decide(claim("RECALCULATE_WORKING_SET"), NOW))
      .resolves.toEqual({
        errorCode: "memory_scheduler_budget_deferred",
        nextAttemptAt: new Date("2026-08-13T00:00:00.000Z"),
        status: "DEFER"
      });
    await expect(service.decide(claim("RECONCILE_SOURCE"), NOW)).resolves.toEqual({
      status: "RUN"
    });
    await expect(service.decide(claim("INDEX_HISTORY"), NOW)).resolves.toEqual({
      status: "RUN"
    });
  });

  it("enforces the installation ceiling across different owners", async () => {
    const service = scheduler(dailyUsage({
      installationCalls: 1,
      users: [["existing-owner", 1, 0]]
    }), {
      backgroundInstallDailyCallLimit: 2,
      backgroundUserDailyCallLimit: 2
    });

    await expect(service.decide(claim("GLOBAL_DREAM", "owner-a"), NOW))
      .resolves.toEqual({ status: "RUN" });
    await expect(service.decide(claim("GLOBAL_DREAM", "owner-b"), NOW))
      .resolves.toMatchObject({
        errorCode: "memory_scheduler_budget_deferred",
        status: "DEFER"
      });
  });

  it("defers when the stored user cost estimate reaches its ceiling", async () => {
    const service = scheduler(dailyUsage({
      installationCostMicros: 50,
      users: [["owner-a", 0, 50]]
    }), {
      backgroundInstallDailyCostMicrosLimit: 100,
      backgroundUserDailyCostMicrosLimit: 50
    });

    await expect(service.decide(claim("GLOBAL_DREAM"), NOW)).resolves.toMatchObject({
      errorCode: "memory_scheduler_budget_deferred",
      status: "DEFER"
    });
  });

  it("fails closed for background usage outages without blocking safety work", async () => {
    const service = scheduler(new Error("private provider detail"), {
      backgroundBudgetRefreshMs: 60_000
    });

    await expect(service.decide(claim("GLOBAL_DREAM"), NOW)).resolves.toEqual({
      errorCode: "memory_scheduler_budget_unavailable",
      nextAttemptAt: new Date("2026-08-12T12:01:00.000Z"),
      status: "DEFER"
    });
    await expect(service.decide(claim("RECONCILE_BRANCH"), NOW)).resolves.toEqual({
      status: "RUN"
    });
    await expect(service.status(NOW, "owner-a")).resolves.toMatchObject({
      installation: { deferred: true },
      status: "unavailable",
      user: { deferred: true }
    });
  });

  it("serializes one owner's work while allowing another owner to proceed", async () => {
    const service = scheduler();
    const firstController = new AbortController();
    const secondController = new AbortController();
    const otherController = new AbortController();
    const releaseFirst = await service.acquireOwner(
      "owner-a",
      firstController.signal
    );
    const granted = vi.fn();
    const second = service.acquireOwner("owner-a", secondController.signal)
      .then((release) => {
        granted();
        return release;
      });

    await Promise.resolve();
    expect(granted).not.toHaveBeenCalled();
    const releaseOther = await service.acquireOwner(
      "owner-b",
      otherController.signal
    );
    releaseOther();
    releaseFirst();
    const releaseSecond = await second;
    expect(granted).toHaveBeenCalledOnce();
    releaseSecond();
  });

  it("removes an aborted owner waiter without consuming a later slot", async () => {
    const service = scheduler();
    const active = new AbortController();
    const waiting = new AbortController();
    const release = await service.acquireOwner("owner-a", active.signal);
    const rejected = service.acquireOwner("owner-a", waiting.signal);

    waiting.abort(new Error("test_abort"));
    await expect(rejected).rejects.toThrow("test_abort");
    release();
    const next = await service.acquireOwner(
      "owner-a",
      new AbortController().signal
    );
    next();
  });

  it("reports aggregate counters without returning the private owner key", async () => {
    const usageSource = source(dailyUsage({
      installationCalls: 3,
      installationCostMicros: 20,
      users: [
        ["private-owner-id", 2, 10],
        ["other-owner", 1, 10]
      ]
    }));
    const service = new MemoryScheduler({
      policy: resolveMemoryCoordinatorPolicy(),
      usageSource
    });

    const status = await service.status(NOW, "private-owner-id");
    expect(status.user).toEqual({ calls: 2, costMicros: 10, deferred: false });
    expect(JSON.stringify(status)).not.toContain("private-owner-id");
    await service.status(new Date(NOW.getTime() + 1_000), "private-owner-id");
    expect(usageSource.readDailyBackgroundUsage).toHaveBeenCalledOnce();
  });

  it("refreshes a still-fresh cache at the UTC day boundary", async () => {
    const usageSource: MemorySchedulerUsageSource = {
      readDailyBackgroundUsage: vi.fn(async () => dailyUsage())
    };
    const service = new MemoryScheduler({
      policy: resolveMemoryCoordinatorPolicy({
        backgroundBudgetRefreshMs: 60 * 60_000
      }),
      usageSource
    });

    await service.status(new Date("2026-08-12T23:59:59.000Z"));
    await service.status(new Date("2026-08-13T00:00:00.000Z"));

    expect(usageSource.readDailyBackgroundUsage).toHaveBeenCalledTimes(2);
    expect(usageSource.readDailyBackgroundUsage).toHaveBeenLastCalledWith({
      windowEnd: new Date("2026-08-14T00:00:00.000Z"),
      windowStart: new Date("2026-08-13T00:00:00.000Z")
    });
  });
});
