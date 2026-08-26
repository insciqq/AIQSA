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

  it("loads bounded coordinator controls without accepting unknown values", () => {
    expect(loadMemoryCoordinatorPolicy({
      AIQSA_MEMORY_COORDINATOR_INTERVAL_MS: "30000",
      AIQSA_MEMORY_COORDINATOR_LEASE_MS: "660000",
      AIQSA_MEMORY_DELETION_CLAIMS_PER_PASS: "20",
      AIQSA_MEMORY_DELETION_PARALLELISM: "2",
      AIQSA_MEMORY_JOB_CLAIMS_PER_PASS: "10",
      AIQSA_MEMORY_JOB_PARALLELISM: "4",
      AIQSA_MEMORY_JOB_PER_USER_PARALLELISM: "2"
    })).toMatchObject({
      intervalMs: 30_000,
      leaseMs: 660_000,
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
    { AIQSA_MEMORY_COORDINATOR_INTERVAL_MS: "999" },
    { AIQSA_MEMORY_COORDINATOR_LEASE_MS: "900001" },
    {
      AIQSA_MEMORY_JOB_PARALLELISM: "2",
      AIQSA_MEMORY_JOB_PER_USER_PARALLELISM: "3"
    }
  ])("fails closed for an invalid environment policy", (env) => {
    expect(() => loadMemoryCoordinatorPolicy(env)).toThrow(
      "memory_coordinator_policy_environment_invalid"
    );
  });
});
