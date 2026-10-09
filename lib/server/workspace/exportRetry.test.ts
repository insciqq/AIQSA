import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_EXPORT_RETRY_MAX_DELAY_MS,
  retryWorkspaceExportStep,
  rollbackSafeExportFailure,
  workspaceExportRetryDelayMs
} from "./exportRetry";
import { WorkspaceRuntimeError } from "./runtime";

function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError("PRIVATE_SQL_CANARY", { clientVersion: "test", code, meta });
}

function connector(state: string) {
  return new Prisma.PrismaClientUnknownRequestError("Error occurred during query execution: ConnectorError(ConnectorError { " +
    `user_facing_error: None, kind: QueryError(PostgresError { code: "${state}", message: "PRIVATE_CANARY", severity: "ERROR" }) })`,
  { clientVersion: "test" });
}

const lockTimeout = known("P2010", { code: "55P03", message: "canceling statement due to lock timeout" });

describe("Workspace export retry classification", () => {
  it.each([
    ["a raw lock timeout", lockTimeout, "lock_timeout"],
    ["a typed lock timeout", connector("55P03"), "lock_timeout"],
    ["an expired transaction", known("P2028", { error: "Transaction already closed: A query cannot be executed on an expired transaction." }),
      "transaction_expired"],
    ["an unstartable transaction", known("P2028", { error: "Unable to start a transaction in the given time." }), "transaction_start_timeout"],
    ["a write conflict", known("P2034"), "serialization_conflict"],
    ["a raw serialization failure", known("P2010", { code: "40001" }), "serialization_conflict"],
    ["a raw deadlock", known("P2010", { code: "40P01" }), "deadlock"],
    ["a typed deadlock", connector("40P01"), "deadlock"]
  ])("retries %s, which rolled the whole step back", (_case, error, kind) => {
    expect(rollbackSafeExportFailure(error)).toBe(kind);
  });

  it.each([
    ["a statement timeout", known("P2010", { code: "57014" })],
    ["another transaction API failure", known("P2028", { error: "Transaction not found." })],
    ["a unique violation", known("P2002")],
    ["a missing row", known("P2025")],
    ["an unavailable database", new Prisma.PrismaClientInitializationError("PRIVATE_CANARY", "test", "P1001")],
    ["another connector failure", connector("23505")],
    ["an application refusal", new WorkspaceRuntimeError("workspace_operation_stale")],
    ["an application refusal keeping a database cause", new WorkspaceRuntimeError("workspace_output_export_failed", { cause: lockTimeout })],
    ["a plain error", new Error("canceling statement due to lock timeout")],
    ["an imposter", Object.assign(new Error("x"), { code: "P2034", name: "PrismaClientKnownRequestError" })],
    ["no value", undefined]
  ])("never retries %s", (_case, error) => {
    expect(rollbackSafeExportFailure(error)).toBeNull();
  });
});

describe("Workspace export retry backoff", () => {
  it("draws full jitter under an exponential ceiling capped at the maximum", () => {
    const bounds = (retry: number) => {
      const random = vi.fn((minimum: number, maximumExclusive: number) => minimum + maximumExclusive);
      workspaceExportRetryDelayMs(retry, random);
      return random.mock.calls[0];
    };
    expect([1, 2, 3, 4, 5, 6, 40].map(bounds)).toEqual([
      [1, 101], [1, 201], [1, 401], [1, 801], [1, 1_601], [1, WORKSPACE_EXPORT_RETRY_MAX_DELAY_MS + 1],
      [1, WORKSPACE_EXPORT_RETRY_MAX_DELAY_MS + 1]
    ]);
    for (let retry = 1; retry <= 12; retry += 1) {
      const delay = workspaceExportRetryDelayMs(retry);
      expect(delay).toBeGreaterThanOrEqual(1);
      expect(delay).toBeLessThanOrEqual(WORKSPACE_EXPORT_RETRY_MAX_DELAY_MS);
    }
  });
});

describe("Workspace export step retry", () => {
  /** A virtual clock: waiting advances it instead of sleeping. */
  function clock(start = 1_000) {
    let now = start;
    const waits: number[] = [];
    return {
      now: () => now,
      advance: (milliseconds: number) => { now += milliseconds; },
      waits,
      wait: vi.fn(async (milliseconds: number) => { waits.push(milliseconds); now += milliseconds; })
    };
  }

  it("repeats a rollback-safe failure until the step succeeds, reporting each retry", async () => {
    const time = clock();
    const failures = [lockTimeout, known("P2034"), known("P2028", { error: "Unable to start a transaction in the given time." })];
    const step = vi.fn(async () => {
      const failure = failures.shift();
      if (failure) throw failure;
      return "sealed";
    });
    const onRetry = vi.fn();
    await expect(retryWorkspaceExportStep(step, { leaseValidUntil: () => 60_000, now: time.now, wait: time.wait,
      delayMs: (retry) => retry * 10, onRetry })).resolves.toBe("sealed");
    expect(step).toHaveBeenCalledTimes(4);
    expect(time.waits).toEqual([10, 20, 30]);
    expect(onRetry.mock.calls.map(([retry]) => [retry.retry, retry.kind, retry.delayMs])).toEqual([
      [1, "lock_timeout", 10], [2, "serialization_conflict", 20], [3, "transaction_start_timeout", 30]
    ]);
    expect(onRetry.mock.calls[0]?.[0].error).toBe(lockTimeout);
  });

  it("throws any other failure at once and unchanged", async () => {
    const time = clock();
    const unique = known("P2002");
    const step = vi.fn(async () => { throw unique; });
    await expect(retryWorkspaceExportStep(step, { leaseValidUntil: () => 60_000, now: time.now, wait: time.wait }))
      .rejects.toBe(unique);
    expect(step).toHaveBeenCalledOnce();
    expect(time.wait).not.toHaveBeenCalled();
  });

  it("stops before an attempt that would start once the lease has run out, with the last database failure", async () => {
    const time = clock(0);
    // Every attempt waits out its lock bound.
    const step = vi.fn(async () => { time.advance(2_000); throw lockTimeout; });
    const onRetry = vi.fn();
    await expect(retryWorkspaceExportStep(step, { leaseValidUntil: () => 7_000, now: time.now, wait: time.wait,
      delayMs: () => 500, onRetry })).rejects.toBe(lockTimeout);
    // Attempts start at 0, 2 500 and 5 000 ms; a fourth would start at 7 500.
    expect(step).toHaveBeenCalledTimes(3);
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it("keeps retrying while a concurrent renewal extends the lease", async () => {
    const time = clock(0);
    let validUntil = 3_000;
    const step = vi.fn(async () => {
      time.advance(2_000);
      if (step.mock.calls.length < 4) throw lockTimeout;
      return true;
    });
    await expect(retryWorkspaceExportStep(step, {
      leaseValidUntil: () => validUntil, now: time.now, delayMs: () => 100,
      wait: async (milliseconds) => { time.advance(milliseconds); validUntil = time.now() + 3_000; }
    })).resolves.toBe(true);
    expect(step).toHaveBeenCalledTimes(4);
  });

  it("never retries once the lease is no longer valid", async () => {
    const time = clock(10_000);
    const step = vi.fn(async () => { throw lockTimeout; });
    await expect(retryWorkspaceExportStep(step, { leaseValidUntil: () => 9_000, now: time.now, wait: time.wait }))
      .rejects.toBe(lockTimeout);
    expect(step).toHaveBeenCalledOnce();
    expect(time.wait).not.toHaveBeenCalled();
  });

  it("never retries after Stop or a lost lease aborted the export, also during its pause", async () => {
    const time = clock();
    const stopped = new AbortController();
    stopped.abort();
    const before = vi.fn(async () => { throw lockTimeout; });
    await expect(retryWorkspaceExportStep(before, { leaseValidUntil: () => 60_000, now: time.now, wait: time.wait,
      signal: stopped.signal })).rejects.toBe(lockTimeout);
    expect(before).toHaveBeenCalledOnce();

    const lost = new AbortController();
    const during = vi.fn(async () => { throw lockTimeout; });
    await expect(retryWorkspaceExportStep(during, { leaseValidUntil: () => 60_000, now: time.now, signal: lost.signal,
      delayMs: () => 60_000_000, wait: async (_milliseconds, signal) => {
        lost.abort(new WorkspaceRuntimeError("workspace_output_export_failed"));
        signal?.throwIfAborted();
      } })).rejects.toBe(lockTimeout);
    expect(during).toHaveBeenCalledOnce();
  });

  it("ends a real pause early when the export is aborted", async () => {
    const lost = new AbortController();
    const step = vi.fn(async () => { throw lockTimeout; });
    const started = Date.now();
    const pending = retryWorkspaceExportStep(step, { leaseValidUntil: () => Date.now() + 600_000, signal: lost.signal,
      delayMs: () => 60_000 });
    setTimeout(() => lost.abort(), 20);
    await expect(pending).rejects.toBe(lockTimeout);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(step).toHaveBeenCalledOnce();
  });
});
