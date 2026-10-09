// @vitest-environment node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { inspect } from "node:util";
import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";
import { MemoryCoordinatorError } from "../memory/coordinator/errors";
import { McpSafeFetchError } from "../mcp/safeFetch";
import { ProviderSafeFetchError } from "../providers/providerSafeFetch";
import { WorkspaceHandoffFailure } from "../runs/settlementFailure";
import { WorkspaceRuntimeError } from "../workspace/runtime";
import { databaseFailureCode, databaseFailureKind } from "./databaseFailure";
import { describeFailureFacts, retainFailureCause } from "./failureFacts.cjs";
import { serializeEvent } from "./runtime.cjs";

const CANARY = "PRIVATE_FAILURE_CANARY";
const TEST_SITE = /^lib\/server\/observability\/failureFacts\.test\.ts:\d+$/u;

function record(event: Parameters<typeof serializeEvent>[0], fields: Record<string, unknown>): Record<string, unknown> {
  const line = serializeEvent(event, fields as never);
  expect(line).toBeDefined();
  return JSON.parse(line!) as Record<string, unknown>;
}

function expiredTransaction(meta: Record<string, unknown> = {
  error: `Transaction already closed: A query cannot be executed on an expired transaction. ${CANARY} ` +
    "The timeout for this transaction was 5000 ms, however 5012 ms passed since the start of the transaction."
}) {
  return new Prisma.PrismaClientKnownRequestError(`${CANARY} SELECT`, { clientVersion: "test", code: "P2028", meta });
}

function unreachable(code = "ENETUNREACH") {
  return Object.assign(new Error(`connect ${code} 10.20.30.40:65123 ${CANARY}`), {
    errno: -101, code, syscall: "connect", address: "10.20.30.40", port: 65123, hostname: "private.example.test"
  });
}

function expectContentFree(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [CANARY, "10.20.30.40", "65123", "private.example.test", "SELECT"]) expect(text).not.toContain(secret);
}

describe("failure facts of a cause chain", () => {
  it("names an expired transaction behind a Workspace handoff failure", () => {
    const expired = expiredTransaction();
    const step = new WorkspaceRuntimeError("workspace_runtime_unavailable", { factsOf: expired });
    const handoff = new WorkspaceHandoffFailure(step);
    // The chain stops at the facts-retaining wrapper: no raw database error is reachable.
    expect(handoff.cause).toBe(step);
    expect(step.cause).toBeUndefined();
    expect(inspect(handoff, { depth: 8 })).not.toContain(CANARY);
    expect([databaseFailureCode(handoff), databaseFailureKind(handoff)]).toEqual(["P2028", "transaction_expired"]);
    const event = record("run_execution", {
      error: handoff, run_id: "run_1", stage: "completion", outcome: "failed", code: "workspace_runtime_unavailable",
      prisma_code: "unknown"
    });
    expect(event).toMatchObject({
      level: "error", error_class: "WorkspaceHandoffFailure", prisma_code: "P2028", db_failure: "transaction_expired",
      tx_timeout_ms: 5000, tx_elapsed_ms: 5012, cause_class: "PrismaClientKnownRequestError"
    });
    expect(event.cause_site).toMatch(TEST_SITE);
    expect(event).not.toHaveProperty("sqlstate");
    expectContentFree(event);
  });

  it("reads the client engine's budget numbers and a raw query's SQLSTATE", () => {
    expect(describeFailureFacts(new Error("wrapper", { cause: expiredTransaction({ operation: "commit", timeout: 2000, timeTaken: 2300 }) })))
      .toMatchObject({ prisma_code: "P2028", tx_timeout_ms: 2000, tx_elapsed_ms: 2300, cause_class: "PrismaClientKnownRequestError" });
    const lock = new Prisma.PrismaClientKnownRequestError(CANARY, { clientVersion: "test", code: "P2010", meta: { code: "55P03", message: CANARY } });
    const facts = describeFailureFacts(lock);
    expect(facts).toEqual({ prisma_code: "P2010", db_failure: "lock_timeout", sqlstate: "55P03" });
    const connector = new Prisma.PrismaClientUnknownRequestError(
      `QueryError(PostgresError { code: "23505", message: "${CANARY}", severity: "ERROR" })`, { clientVersion: "test" });
    expect(describeFailureFacts(connector)).toEqual({ sqlstate: "23505" });
  });

  it("names the system code and syscall behind the MCP and provider transport wrappers without the address", () => {
    const system = unreachable();
    const mcp = new McpSafeFetchError("mcp_http_request_failed", { requestNotSent: true, factsOf: system });
    expect(mcp).toMatchObject({ code: "mcp_http_request_failed", message: "mcp_http_request_failed", requestNotSent: true });
    const provider = new ProviderSafeFetchError("provider_http_request_failed", { factsOf: mcp });
    for (const error of [mcp, provider]) {
      expect(error.cause).toBeUndefined();
      expectContentFree(inspect(error, { depth: 8 }));
      const event = record("service_operation", { error, subsystem: "memory", stage: "process", outcome: "failed", code: "unknown" });
      expect(event).toMatchObject({ sys_code: "ENETUNREACH", syscall: "connect", cause_class: "Error" });
      expect(event.cause_site).toMatch(TEST_SITE);
      expect(event).not.toHaveProperty("prisma_code");
      expectContentFree(event);
    }
  });

  it("follows an AggregateError to its first error and keeps only the call of a spawn", () => {
    const aggregate = Object.assign(new AggregateError([unreachable("ECONNREFUSED"), unreachable("EHOSTUNREACH")], CANARY),
      { code: "ECONNREFUSED" });
    expect(describeFailureFacts(new Error("fetch failed", { cause: aggregate })))
      .toMatchObject({ sys_code: "ECONNREFUSED", syscall: "connect", cause_class: "Error" });
    const spawn = Object.assign(new Error(CANARY), { code: "ENOENT", syscall: "spawn /opt/private/tool", path: "/opt/private/tool" });
    const facts = describeFailureFacts(spawn);
    expect(facts).toEqual({ sys_code: "ENOENT", syscall: "spawn" });
    expect(JSON.stringify(facts)).not.toContain("private");
  });

  it("keeps a coordinator failure free of its cause yet retains the cause's facts", () => {
    const expired = expiredTransaction();
    const failure = new MemoryCoordinatorError("memory_fact_apply_retryable", true, { factsOf: expired });
    expect(failure).not.toHaveProperty("cause");
    expect(failure.message).toBe("memory_fact_apply_retryable");
    expect([databaseFailureCode(failure), databaseFailureKind(failure)]).toEqual(["P2028", "transaction_expired"]);
    const event = record("job_attempt", { error: failure, subsystem: "memory", stage: "process", outcome: "failed", code: failure.code });
    expect(event).toMatchObject({ error_class: "MemoryCoordinatorError", prisma_code: "P2028", db_failure: "transaction_expired",
      tx_timeout_ms: 5000, tx_elapsed_ms: 5012, cause_class: "PrismaClientKnownRequestError" });
    expect(event.cause_site).toMatch(TEST_SITE);
    expectContentFree(event);
  });

  it("drops values outside the closed vocabulary and never states facts for ordinary progress", () => {
    const forged = Object.assign(new Error(CANARY), { code: "enetunreach", syscall: `${CANARY} connect` });
    const event = record("runtime_lifecycle", { error: new Error("wrapper", { cause: forged }), subsystem: "mcp", stage: "process",
      outcome: "failed", code: "unknown" });
    expect(event).not.toHaveProperty("sys_code");
    expect(event.syscall).toBe("other");
    expectContentFree(event);
    const named = Object.assign(new Error(CANARY), { name: "PrismaClientKnownRequestError", code: "P2028", meta: { timeout: 1, timeTaken: 2 } });
    expect(describeFailureFacts(named)).toEqual({});
    const huge = expiredTransaction({ error: "The timeout for this transaction was 99999999999 ms, however 1 ms passed since the start of the transaction" });
    expect(describeFailureFacts(huge)).toEqual({ prisma_code: "P2028" });
    const sqlstate = new Prisma.PrismaClientKnownRequestError(CANARY, { clientVersion: "test", code: "P2010", meta: { code: "abc; DROP" } });
    expect(describeFailureFacts(sqlstate)).toEqual({ prisma_code: "P2010" });
    const progress = record("runtime_lifecycle", { error: unreachable(), subsystem: "mcp", stage: "process", outcome: "completed" });
    expect(progress).not.toHaveProperty("sys_code");
    expect(progress).not.toHaveProperty("cause_class");
  });

  it("keeps a database code the event states itself and survives cycles and unreadable causes", () => {
    const explicit = record("runtime_lifecycle", { error: expiredTransaction(), subsystem: "workspace", stage: "export", outcome: "failed",
      prisma_code: "P2034" });
    expect(explicit).toMatchObject({ prisma_code: "P2034", tx_timeout_ms: 5000 });
    const cyclic = new Error("a") as Error & { cause?: unknown };
    cyclic.cause = new Error("b", { cause: cyclic });
    expect(describeFailureFacts(cyclic)).toEqual({ cause_class: "Error", cause_site: expect.stringMatching(TEST_SITE) });
    const hostile = new Error("hostile");
    Object.defineProperty(hostile, "cause", { get() { throw new Error(CANARY); } });
    expect(describeFailureFacts(hostile)).toEqual({});
    retainFailureCause(new Error("wrapper"), "not an error");
    expect(describeFailureFacts(null)).toEqual({});
  });

  it("carries the facts on an uncaught process failure", () => {
    const runtimeModule = path.resolve("lib/server/observability/runtime.cjs");
    const processModule = path.resolve("lib/server/observability/process.cjs");
    const result = spawnSync(process.execPath, ["-e", `
      const { installProcessFailureHooks } = require(${JSON.stringify(processModule)});
      require(${JSON.stringify(runtimeModule)});
      installProcessFailureHooks();
      setInterval(() => {}, 1000);
      setImmediate(() => {
        const system = Object.assign(new Error("connect ENETUNREACH 10.20.30.40:65123 ${CANARY}"),
          { code: "ENETUNREACH", syscall: "connect", address: "10.20.30.40", port: 65123 });
        throw new Error("mcp_http_request_failed", { cause: system });
      });
    `], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: 10_000 });
    expect(result.status).toBe(1);
    const events = result.stderr.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events).toEqual([expect.objectContaining({
      event: "process.failure", level: "fatal", stage: "uncaught_exception", sys_code: "ENETUNREACH", syscall: "connect", cause_class: "Error"
    })]);
    expectContentFree(result.stdout + result.stderr);
  });
});
