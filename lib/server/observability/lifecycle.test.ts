// @vitest-environment node
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createContext, runInContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { bindContext, getContext, runInBackground, runWithContext, serializeEvent } from "./runtime.cjs";

function isolatedRuntime() {
  const url = new URL("./runtime.cjs", import.meta.url);
  const source = readFileSync(url, "utf8");
  const lines: string[] = [];
  const sink = Object.assign(new EventEmitter(), {
    writable: true, destroyed: false, writableNeedDrain: false, writableLength: 0,
    write(line: string) { lines.push(line); return true; }
  });
  let now = 1_000;
  class Clock extends Date { static now() { return now; } }
  const realm = createContext({ require: createRequire(url), process: { stdout: sink, version: "v22.22.0" }, Buffer, Date: Clock });
  const reload = () => runInContext(
    `(() => { const module = { exports: {} }; ${source}; return module.exports; })()`, realm
  ) as typeof import("./runtime.cjs");
  return { reload, advance(ms: number) { now += ms; }, records: () => lines.map((line) => JSON.parse(line)) };
}

describe("process and job diagnostics", () => {
  it("keeps idle polls silent and reports bounded repeated failures and one recovery across HMR", () => {
    const fixture = isolatedRuntime();
    let runtime = fixture.reload();
    for (let index = 0; index < 100; index++) runtime.reportSubsystemHealthy("memory", "claim");
    expect(fixture.records()).toHaveLength(0);
    const failure = { subsystem: "memory", stage: "claim", code: "provider_http_dns_failed", action: "retry" } as const;
    runtime.runWithContext({ run_id: "unrelated-run" }, () => {
      for (let index = 0; index < 100; index++) runtime.reportSubsystemFailure(failure);
    });
    expect(fixture.records()).toHaveLength(1);
    expect(fixture.records()[0]).toMatchObject({ event: "runtime_lifecycle", outcome: "failed", level: "warn", repeat_count: 0 });
    fixture.advance(30_000);
    runtime = fixture.reload();
    runtime.reportSubsystemFailure(failure);
    expect(fixture.records()[1]).toMatchObject({ repeat_count: 99 });
    runtime.runWithContext({ run_id: "another-run" }, () => runtime.reportSubsystemHealthy("memory", "claim"));
    runtime.reportSubsystemHealthy("memory", "claim");
    expect(fixture.records()).toHaveLength(3);
    expect(fixture.records()[2]).toMatchObject({ event: "subsystem.recovered", level: "info", repeat_count: 100, duration_ms: 30_000 });
    for (const item of fixture.records()) {
      expect(item).not.toHaveProperty("trace_id");
      expect(item).not.toHaveProperty("run_id");
    }
    runtime.reportSubsystemFailure(failure);
    expect(fixture.records()[3]).toMatchObject({ event: "runtime_lifecycle", repeat_count: 0 });
  });

  it("keeps failures of neighboring generations separate across HMR", () => {
    const fixture = isolatedRuntime();
    let runtime = fixture.reload();
    runtime.reportSubsystemFailure({ subsystem: "mcp", stage: "initialize", code: "mcp_connect_failed", scope_id: "generation-a" });
    runtime.reportSubsystemFailure({ subsystem: "mcp", stage: "initialize", code: "mcp_connect_failed", scope_id: "generation-b" });
    runtime = fixture.reload();
    runtime.reportSubsystemHealthy("mcp", "initialize");
    runtime.reportSubsystemHealthy("mcp", "initialize", "generation-c");
    expect(fixture.records()).toHaveLength(2);
    fixture.advance(100);
    runtime.reportSubsystemHealthy("mcp", "initialize", "generation-a");
    runtime.reportSubsystemHealthy("mcp", "initialize", "generation-a");
    expect(fixture.records()).toHaveLength(3);
    fixture.advance(100);
    runtime.reportSubsystemHealthy("mcp", "initialize", "generation-b");
    expect(fixture.records().slice(2)).toMatchObject([
      { event: "subsystem.recovered", duration_ms: 100 },
      { event: "subsystem.recovered", duration_ms: 200 }
    ]);
    expect(JSON.stringify(fixture.records())).not.toContain("generation-");
  });

  it("never merges failures of separate claimed jobs", () => {
    const fixture = isolatedRuntime();
    const runtime = fixture.reload();
    for (let index = 0; index < 100; index++) runtime.runInBackground(() => runtime.runWithContext({ job_id: `job-${index}` }, () => {
      runtime.logEvent("job_attempt", { subsystem: "attachments", stage: "process", outcome: "failed", code: "unknown", action: "retry", attempt: 2 });
    }));
    const records = fixture.records();
    expect(records).toHaveLength(100);
    expect(new Set(records.map((record) => record.job_id)).size).toBe(100);
    expect(new Set(records.map((record) => record.trace_id)).size).toBe(100);
    expect(records.every((record) => record.level === "warn")).toBe(true);
  });

  it("validates keys before repeat tracking and never reads untrusted getters", () => {
    const fixture = isolatedRuntime();
    const runtime = fixture.reload();
    for (let index = 0; index < 10_000; index++) runtime.reportSubsystemFailure({
      subsystem: "memory", stage: "claim", code: `PRIVATE_CANARY_${index}`, action: "retry"
    });
    runtime.reportSubsystemFailure({ subsystem: "PRIVATE_CANARY", stage: "claim" } as never);
    runtime.reportSubsystemFailure({ subsystem: "memory", get stage(): "claim" { throw new Error("PRIVATE_CANARY"); } });
    runtime.reportSubsystemFailure(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("PRIVATE_CANARY"); } }) as never);
    expect(fixture.records()).toHaveLength(1);
    expect(fixture.records()[0]).toMatchObject({ code: "unknown" });
    expect(JSON.stringify(fixture.records())).not.toContain("PRIVATE_CANARY");
  });

  it("reports startup once and readiness transitions independently of request and HMR context", () => {
    const fixture = isolatedRuntime();
    let runtime = fixture.reload();
    runtime.setProcessRole("memory_coordinator");
    runtime.runWithContext({ job_id: "unrelated-job" }, () => runtime.announceProcess({ memory: "starting", get email(): "unknown" { throw new Error("PRIVATE_CANARY"); } }));
    runtime = fixture.reload();
    runtime.announceProcess({ memory: "ready" });
    const startup = fixture.records()[0];
    expect(startup).toMatchObject({ event: "process.started", role: "memory_coordinator", node_version: "v22.22.0", memory: "starting" });
    expect(startup).not.toHaveProperty("email");
    expect(startup).not.toHaveProperty("job_id");
    for (let index = 0; index < 100; index++) runtime.reportReadiness("ready", undefined, 0);
    runtime.reportReadiness("not_ready", "PRIVATE_CANARY", 1);
    runtime = fixture.reload();
    runtime.reportReadiness("not_ready", "PRIVATE_CANARY", 1);
    runtime.reportReadiness("ready", undefined, 0);
    expect(fixture.records().map((item) => item.event)).toEqual([
      "process.started", "readiness.changed", "readiness.changed", "readiness.changed"
    ]);
    expect(fixture.records()[2]).toMatchObject({ state: "not_ready", code: "unknown", level: "warn" });
    expect(JSON.stringify(fixture.records())).not.toContain("PRIVATE_CANARY");
  });

  it("does not report a retry timestamp as persisted for a lost or rejected write", () => {
    const retryAt = "2026-09-13T15:00:00.000Z";
    for (const outcome of ["confirmed", "not_applied", "unconfirmed"] as const) {
      const line = serializeEvent("job_persistence", { subsystem: "knowledge", stage: "retry", outcome, retry_at: retryAt, prisma_code: outcome === "unconfirmed" ? "P1001" : undefined })!;
      const record = JSON.parse(line);
      if (outcome === "confirmed") expect(record.retry_at).toBe(retryAt);
      else expect(record).not.toHaveProperty("retry_at");
      expect(record.level).toBe(outcome === "unconfirmed" ? "error" : "info");
    }
  });
});

describe("nested operation context", () => {
  it("binds parallel call callbacks to their server-owned call and clears them in background work", async () => {
    await runInBackground(() => runWithContext({ run_id: "run-1" }, async () => {
      const callbacks = await Promise.all([0, 1].map((execution_index) => runWithContext({ tool_call_id: `server-call-${execution_index}`, execution_index }, async () => {
        await Promise.resolve();
        return bindContext(() => getContext());
      })));
      runWithContext({ trace_id: "a".repeat(32), run_id: "stop-request-run" }, () => {
        for (const [index, callback] of callbacks.entries()) expect(callback()).toMatchObject({ run_id: "run-1", tool_call_id: `server-call-${index}`, execution_index: index });
      });
      runInBackground(() => {
        expect(getContext()).not.toHaveProperty("tool_call_id");
        expect(getContext()).not.toHaveProperty("execution_index");
      });
    }));
  });

  it("keeps absent transport progress unknown and excludes content and unapproved upstream identifiers", () => {
    const record = JSON.parse(serializeEvent("transport_stage", {
      transport: "provider", stage: "headers", outcome: "completed", httpStatus: 200,
      endpoint: "PRIVATE_CANARY", payload: "PRIVATE_CANARY", upstream_request_id: "PRIVATE_CANARY", chunks: -1
    } as never)!);
    expect(record).toMatchObject({ stage: "headers", httpStatus: 200 });
    for (const key of ["bytes", "chunks", "last_progress_ms", "endpoint", "payload", "upstream_request_id"]) expect(record).not.toHaveProperty(key);
    const abort = JSON.parse(serializeEvent("nested_abort", { layer: "search", stage: "before_start", abort_source: "unknown" })!);
    expect(abort).not.toHaveProperty("duration_ms");
    expect(abort).not.toHaveProperty("timeout_ms");
  });
});
