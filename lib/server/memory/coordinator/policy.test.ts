import { describe, expect, it } from "vitest";
import {
  DEFAULT_MEMORY_COORDINATOR_POLICY,
  loadMemoryCoordinatorPolicy,
  resolveMemoryCoordinatorPolicy
} from "./policy";

describe("Memory coordinator policy", () => {
  it("keeps the contracted two-worker default and stricter owner-local bound", () => {
    expect(DEFAULT_MEMORY_COORDINATOR_POLICY).toMatchObject({
      maxDeletionParallel: 1,
      maxJobParallel: 2,
      maxJobParallelPerUser: 1
    });
    expect(resolveMemoryCoordinatorPolicy()).toEqual(
      DEFAULT_MEMORY_COORDINATOR_POLICY
    );
  });

  it("loads bounded scheduler controls without accepting unknown values", () => {
    expect(loadMemoryCoordinatorPolicy({
      AIQSA_MEMORY_BACKGROUND_BUDGET_REFRESH_MS: "120000",
      AIQSA_MEMORY_BACKGROUND_INSTALL_DAILY_CALLS: "200",
      AIQSA_MEMORY_BACKGROUND_INSTALL_DAILY_COST_MICROS: "900000",
      AIQSA_MEMORY_BACKGROUND_USER_DAILY_CALLS: "20",
      AIQSA_MEMORY_BACKGROUND_USER_DAILY_COST_MICROS: "90000",
      AIQSA_MEMORY_DELETION_CLAIMS_PER_PASS: "20",
      AIQSA_MEMORY_DELETION_PARALLELISM: "2",
      AIQSA_MEMORY_JOB_CLAIMS_PER_PASS: "10",
      AIQSA_MEMORY_JOB_PARALLELISM: "4",
      AIQSA_MEMORY_JOB_PER_USER_PARALLELISM: "2"
    })).toMatchObject({
      backgroundBudgetRefreshMs: 120_000,
      backgroundInstallDailyCallLimit: 200,
      backgroundInstallDailyCostMicrosLimit: 900_000,
      backgroundUserDailyCallLimit: 20,
      backgroundUserDailyCostMicrosLimit: 90_000,
      maxDeletionClaimsPerWorkerPass: 20,
      maxDeletionParallel: 2,
      maxJobClaimsPerWorkerPass: 10,
      maxJobParallel: 4,
      maxJobParallelPerUser: 2
    });
  });

  it.each([
    { AIQSA_MEMORY_JOB_PARALLELISM: "0" },
    { AIQSA_MEMORY_JOB_PARALLELISM: "1.5" },
    { AIQSA_MEMORY_JOB_PARALLELISM: " 2" },
    {
      AIQSA_MEMORY_JOB_PARALLELISM: "2",
      AIQSA_MEMORY_JOB_PER_USER_PARALLELISM: "3"
    },
    {
      AIQSA_MEMORY_BACKGROUND_INSTALL_DAILY_CALLS: "10",
      AIQSA_MEMORY_BACKGROUND_USER_DAILY_CALLS: "11"
    }
  ])("fails closed for an invalid environment policy", (env) => {
    expect(() => loadMemoryCoordinatorPolicy(env)).toThrow(
      "memory_coordinator_policy_environment_invalid"
    );
  });

  it("rejects a user budget wider than the installation budget", () => {
    expect(() => resolveMemoryCoordinatorPolicy({
      backgroundInstallDailyCostMicrosLimit: 10,
      backgroundUserDailyCostMicrosLimit: 11
    })).toThrow("memory_coordinator_policy_invalid");
  });
});
